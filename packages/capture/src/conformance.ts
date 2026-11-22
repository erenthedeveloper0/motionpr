/**
 * The adapter conformance suite (`motionpr adapter check`): checks an adapter against adapter
 * protocol 2 in a real browser. It loads a page that uses the adapter three times:
 *
 * 1. with the agent and the in-page probe (`agent/probe.ts`), which runs the protocol's checks
 *    against the adapter object: registration, entries, settling, replay, windows, scroll,
 *    claims, diagnostics;
 * 2. without MotionPR, where the adapter must do nothing;
 * 3. as a real capture, which must record the adapter without adapter diagnostics and validate.
 */
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser, Page } from "playwright-core";
import {
  ADAPTER_CHECKS,
  MotionprError,
  SchemaError,
  readCaptureBundle,
  resolveConfig,
  type AdapterCheckId,
  type AdapterCheckResult,
  type AdapterCheckStatus,
  type AdapterCheckSubject,
  type BrowserName,
  type CaptureBundle,
} from "@motionpr/core";
import { ADAPTER_PROBE_SOURCE, AGENT_SOURCE } from "./agent/agent-bundle.generated.ts";
import type { ProbeRun } from "./agent/probe.ts";
import { browserNameOf, launchBrowser } from "./browser.ts";
import { runCapture } from "./runner.ts";
import { serveDirectory, type StaticServer } from "./static-server.ts";

export interface AdapterCheckOptions {
  /** The page to check: an http(s) URL, or a local HTML file (served from its folder). */
  page: string;
  /** The adapter to check (default: the only adapter the page registers). */
  adapter?: string;
  /** A script that registers the adapter, injected before page scripts (like `adapters[].script`). */
  script?: string;
  /** Engine to check in (default `chromium`). */
  browserName?: BrowserName;
  /** Reuse a Playwright browser (its engine is used). */
  browser?: Browser;
  headless?: boolean;
  /** How long to wait for registration, for motion and for settling, in ms (default 10 000). */
  timeout?: number;
  /** Directory relative paths resolve from (default: the working directory). */
  cwd?: string;
}

export interface AdapterCheckReport {
  /** The page as given (URL or file path). */
  page: string;
  /** The URL that was loaded (a local file is served from 127.0.0.1). */
  url: string;
  browser: BrowserName;
  browserVersion: string;
  /** The adapter as it describes itself; null when none registered. */
  adapter: AdapterCheckSubject | null;
  /** Every check of {@link ADAPTER_CHECKS}, in that order. */
  checks: AdapterCheckResult[];
  /** True when no check failed (warnings and skipped checks do not fail). */
  passed: boolean;
  counts: Record<AdapterCheckStatus, number>;
}

const TITLES = new Map<string, string>(ADAPTER_CHECKS.map((c) => [c.id, c.title]));
const VIEWPORT = { width: 1280, height: 720 };

function check(
  id: AdapterCheckId,
  status: AdapterCheckStatus,
  summary: string,
  details: string[] = [],
): AdapterCheckResult {
  return { id, title: TITLES.get(id) ?? id, status, summary, details };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A URL as is; a path (or file: URL) to an HTML file, served from its folder. */
async function resolvePage(
  page: string,
  cwd: string,
): Promise<{ url: string; server: StaticServer | null }> {
  if (/^https?:\/\//i.test(page)) return { url: page, server: null };
  // A query or hash after a file path is kept for the page (`page.html?variant=b`).
  const suffix = /[?#].*$/.exec(page)?.[0] ?? "";
  const bare = page.slice(0, page.length - suffix.length);
  const file = resolve(cwd, bare.startsWith("file:") ? fileURLToPath(bare) : bare);
  const info = await stat(file).catch(() => null);
  if (!info?.isFile())
    throw new MotionprError("ADAPTER_CHECK_FAILED", `No page at ${file}.`, {
      hint: "Pass an http(s) URL, or the path of an HTML file that uses the adapter.",
    });
  const server = await serveDirectory(dirname(file));
  return { url: `${server.url}/${encodeURIComponent(basename(file))}${suffix}`, server };
}

/** Calls a probe method in the page (the callback stays trivial; see the runner's `agent`). */
function probe<T>(page: Page, method: string, ...args: unknown[]): Promise<T> {
  return page.evaluate(
    ([m, a]) => {
      const api = (window as unknown as Record<string, unknown>)["__MOTIONPR_PROBE__"] as
        Record<string, (...x: unknown[]) => unknown> | undefined;
      if (!api) throw new Error("The MotionPR conformance probe is not installed in this page.");
      return api[m]!(...a);
    },
    [method, args] as [string, unknown[]],
  ) as Promise<T>;
}

async function load(page: Page, url: string): Promise<void> {
  try {
    await page.goto(url, { waitUntil: "load", timeout: 30_000 });
  } catch (error) {
    throw new MotionprError(
      "ADAPTER_CHECK_FAILED",
      `Could not load ${url}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`,
      { hint: "Start the page's server first, or pass the path of a local HTML file." },
    );
  }
}

interface Probed {
  subject: AdapterCheckSubject | null;
  registered: boolean;
  checks: AdapterCheckResult[];
}

/** Phase 1: the probe's checks, with the agent installed. */
async function probePage(
  browser: Browser,
  url: string,
  script: string | null,
  wanted: string | null,
  timeout: number,
): Promise<Probed> {
  const context = await browser.newContext({ viewport: VIEWPORT, serviceWorkers: "block" });
  try {
    await context.addInitScript({ content: AGENT_SOURCE });
    await context.addInitScript({ content: ADAPTER_PROBE_SOURCE });
    if (script) await context.addInitScript({ path: script });
    const page = await context.newPage();
    await load(page, url);
    const deadline = Date.now() + timeout;
    let seen: { name: string; registered: boolean }[] = [];
    for (;;) {
      seen = await probe(page, "adapters");
      if (wanted ? seen.some((s) => s.name === wanted) : seen.length > 0) break;
      if (Date.now() > deadline) break;
      await sleep(100);
    }
    if (!wanted && seen.length) {
      await sleep(300); // others registering in the same load
      seen = await probe(page, "adapters");
    }
    const names = [...new Set(seen.map((s) => s.name))];
    if (!wanted && names.length > 1)
      throw new MotionprError(
        "ADAPTER_CHECK_FAILED",
        `The page registers ${names.length} adapters: ${names.join(", ")}.`,
        { hint: "Name the one to check with --adapter <name> (API: `adapter`)." },
      );
    const name = wanted ?? names[0] ?? null;
    if (!name || !seen.some((s) => s.name === name)) {
      const registration = check(
        "registration",
        "fail",
        name
          ? `No adapter named "${name}" registered within ${timeout} ms.`
          : `No adapter registered within ${timeout} ms.`,
        [
          ...(names.length ? [`Registered: ${names.join(", ")}.`] : []),
          "The page (or --script) must call window.__MOTIONPR_AGENT__.registerAdapter(adapter) while MotionPR captures.",
        ],
      );
      return { subject: null, registered: false, checks: [registration] };
    }
    const run = await probe<ProbeRun>(page, "run", name, { timeout });
    return {
      subject: run.subject,
      registered: seen.some((s) => s.name === name && s.registered),
      checks: run.checks,
    };
  } finally {
    await context.close().catch(() => undefined);
  }
}

/** Phase 2: the page without MotionPR: no errors, and nothing installed. */
async function withoutAgent(
  browser: Browser,
  url: string,
  script: string | null,
): Promise<AdapterCheckResult> {
  const context = await browser.newContext({ viewport: VIEWPORT, serviceWorkers: "block" });
  try {
    if (script) await context.addInitScript({ path: script });
    const page = await context.newPage();
    const errors: string[] = [];
    const consoleErrors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message.split("\n")[0]!));
    page.on("console", (m) => {
      if (m.type() === "error") consoleErrors.push(m.text().slice(0, 200));
    });
    await load(page, url);
    await sleep(1000);
    const installed = await page.evaluate("typeof window.__MOTIONPR_AGENT__ !== 'undefined'");
    if (errors.length || installed)
      return check("without-agent", "fail", "The page breaks without MotionPR.", [
        ...errors.map((e) => `Uncaught error: ${e}`),
        ...(installed
          ? ["window.__MOTIONPR_AGENT__ exists although MotionPR is not capturing."]
          : []),
      ]);
    if (consoleErrors.length)
      return check(
        "without-agent",
        "warn",
        "Console errors without MotionPR.",
        consoleErrors.slice(0, 5),
      );
    return check("without-agent", "pass", "Loads without errors when MotionPR is not capturing.");
  } finally {
    await context.close().catch(() => undefined);
  }
}

/** Phase 3: a real capture of the page with the adapter required. */
async function captureCheck(
  browser: Browser,
  url: string,
  name: string,
  script: string | null,
  cwd: string,
): Promise<AdapterCheckResult> {
  const dir = await mkdtemp(join(tmpdir(), "motionpr-adapter-check-"));
  try {
    const config = resolveConfig({
      browser: { viewport: VIEWPORT },
      capture: { waitForNetworkIdle: false, samples: 17 },
      adapters: [{ name, required: true, ...(script ? { script } : {}) }],
      scenarios: [{ id: "adapter-check", url }],
    });
    const out = join(dir, "capture");
    await runCapture({ config, rootDir: cwd, outputDir: out, browser });
    let bundle: CaptureBundle;
    try {
      bundle = await readCaptureBundle(out);
    } catch (error) {
      const issues = error instanceof SchemaError ? error.issues : [];
      return check(
        "capture",
        "fail",
        "The capture does not validate: compare and baseline accept would refuse it.",
        issues.length ? issues.slice(0, 10).map((i) => `${i.path}: ${i.message}`) : [String(error)],
      );
    }
    const problems: string[] = [];
    const partial = new Set<string>();
    let animations = 0;
    let timelines = 0;
    for (const scenario of bundle.scenarios) {
      if (scenario.error) problems.push(`The scenario failed: ${scenario.error.message}`);
      const status = scenario.adapters.find((a) => a.id === name);
      if (status && status.status !== "active")
        problems.push(`Adapter status "${status.status}" in the capture.`);
      const diagnostics = [
        ...scenario.diagnostics,
        ...scenario.checkpoints.flatMap((c) => c.diagnostics),
        ...(status?.diagnostics ?? []).filter((d) => d.level !== "info"),
      ];
      for (const d of diagnostics)
        if (/^ADAPTER_/.test(d.code) || d.code === "PAGE_ERROR")
          problems.push(`${d.level} ${d.code}: ${d.message}`);
      for (const checkpoint of scenario.checkpoints) {
        for (const a of checkpoint.animations) {
          if (a.source !== name) continue;
          animations++;
          if (a.completeness.status !== "complete")
            for (const reason of a.completeness.reasons)
              partial.add(`${a.completeness.status}: ${reason}`);
        }
        timelines += checkpoint.timelines.filter((t) => t.source === name).length;
      }
    }
    const unique = [...new Set(problems)];
    if (unique.length)
      return check("capture", "fail", "The capture recorded adapter problems.", unique);
    const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
    const what = [
      ...(animations ? [plural(animations, "animation")] : []),
      ...(timelines ? [plural(timelines, "timeline")] : []),
    ].join(" and ");
    if (partial.size)
      return check(
        "capture",
        "warn",
        `Captured ${what}; some records are incomplete.`,
        [...partial].slice(0, 10),
      );
    return check(
      "capture",
      "pass",
      what
        ? `Captured ${what}; the capture validates.`
        : "The capture validates; it holds no animation or timeline of this adapter.",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Runs the adapter conformance suite against a page that uses the adapter. Throws
 * `ADAPTER_CHECK_FAILED` when the page cannot be loaded or several adapters register and none
 * is named; every other problem is a failed check in the report.
 */
export async function checkAdapter(options: AdapterCheckOptions): Promise<AdapterCheckReport> {
  const cwd = options.cwd ?? process.cwd();
  const timeout = options.timeout ?? 10_000;
  const script = options.script ? resolve(cwd, options.script) : null;
  if (script && !(await stat(script).catch(() => null))?.isFile())
    throw new MotionprError("ADAPTER_CHECK_FAILED", `No adapter script at ${script}.`);
  const target = await resolvePage(options.page, cwd);
  let browser: Browser | null = options.browser ?? null;
  try {
    browser ??= await launchBrowser(
      resolveConfig({ scenarios: [{ id: "adapter-check", url: target.url }] }),
      {
        browserName: options.browserName ?? "chromium",
        ...(options.headless === undefined ? {} : { headless: options.headless }),
      },
    );
    const probed = await probePage(browser, target.url, script, options.adapter ?? null, timeout);
    const found = new Map(probed.checks.map((c) => [c.id, c]));
    found.set("without-agent", await withoutAgent(browser, target.url, script));
    found.set(
      "capture",
      probed.subject && probed.registered
        ? await captureCheck(browser, target.url, probed.subject.name, script, cwd)
        : check("capture", "skip", "Not registered."),
    );
    const checks = ADAPTER_CHECKS.map(
      (c) => found.get(c.id) ?? check(c.id, "skip", "Not registered."),
    );
    const counts: Record<AdapterCheckStatus, number> = { pass: 0, warn: 0, fail: 0, skip: 0 };
    for (const c of checks) counts[c.status]++;
    return {
      page: options.page,
      url: target.url,
      browser: browserNameOf(browser),
      browserVersion: browser.version(),
      adapter: probed.subject,
      checks,
      passed: counts.fail === 0,
      counts,
    };
  } finally {
    if (browser && !options.browser) await browser.close().catch(() => undefined);
    await target.server?.close();
  }
}
