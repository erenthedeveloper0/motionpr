import { existsSync, readFileSync } from "node:fs";
import { access, mkdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import {
  AGENT_GLOBAL,
  BROWSER_LABELS,
  BROWSER_NAMES,
  SUPPORTED_ENGINE_RANGES,
  MOTIONPR_VERSION,
  baselineBrowsers,
  isMotionprError,
  legacyBaseline,
  resolveConfig,
  scenarioUrl,
  versionSatisfies,
  webServers,
  MOTIONPR_PACKAGE,
  type BrowserCapabilities,
  type BrowserName,
  type ResolvedConfig,
} from "@motionpr/core";
import {
  AGENT_SOURCE,
  expectedBrowserPath,
  isBrowserInstalled,
  isMissingDependencies,
  isUrlReady,
  launchBrowser,
  launchOptionsFor,
  playwrightVersion,
} from "@motionpr/capture";
import { loadConfig, type LoadedConfig } from "../config/load.ts";
import { isCI } from "../output/terminal.ts";
import {
  banner,
  cwdOf,
  makeTerminal,
  printJson,
  selectBrowsers,
  type GlobalOptions,
} from "./shared.ts";

export interface DoctorOptions extends GlobalOptions {
  launch?: boolean;
  /** `--browser`: engines to launch-check (default: the config's `browser.name`). */
  browser?: string[];
}

interface Check {
  name: string;
  status: "ok" | "warn" | "fail" | "info";
  detail: string;
  fix?: string;
}

const MIN_NODE = [22, 12] as const;

function nodeCheck(): Check {
  const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
  const ok = major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1]);
  const lts = major % 2 === 0;
  return {
    name: "Node.js",
    status: ok ? (lts ? "ok" : "warn") : "fail",
    detail: `v${process.versions.node}${lts ? "" : " (not an LTS line)"}`,
    ...(ok
      ? lts
        ? {}
        : { fix: "Use an LTS release (22 or 24) for CI stability." }
      : {
          fix: `MotionPR needs Node.js ${MIN_NODE.join(".")} or newer. Install an LTS release from nodejs.org.`,
        }),
  };
}

export async function doctorCommand(options: DoctorOptions): Promise<number> {
  const t = makeTerminal(options);
  banner(t, "doctor");
  selectBrowsers(options.browser, "chromium"); // usage errors before anything else
  const checks: Check[] = [];
  checks.push(nodeCheck());
  checks.push({ name: "MotionPR", status: "ok", detail: MOTIONPR_VERSION });
  checks.push({
    name: "Playwright",
    status: "ok",
    detail: `playwright-core ${playwrightVersion()}`,
  });

  let loaded: LoadedConfig | null = null;
  try {
    loaded = await loadConfig({
      cwd: cwdOf(options),
      ...(options.config ? { config: options.config } : {}),
      ...(options.env ? { env: options.env } : {}),
    });
    const n = loaded.config.scenarios.length;
    checks.push({
      name: "Config",
      status: "ok",
      detail: `${loaded.file} (${n} scenario${n === 1 ? "" : "s"})`,
    });
  } catch (error) {
    const issues =
      isMotionprError(error) && "issues" in error
        ? (error as { issues: { path: string; message: string }[] }).issues
        : [];
    checks.push({
      name: "Config",
      status: "fail",
      detail: error instanceof Error ? error.message.split("\n")[0]! : String(error),
      fix:
        [
          ...issues.slice(0, 5).map((i) => `${i.path}: ${i.message}`),
          isMotionprError(error) ? error.hint : undefined,
        ]
          .filter(Boolean)
          .join("\n") || "npx motionpr init",
    });
  }

  const config =
    loaded?.config ?? resolveConfig({ baseURL: "http://localhost", scenarios: [{ id: "doctor" }] });
  const selected = selectBrowsers(options.browser, config.browser.name);
  // Every engine's build: required when selected, optional otherwise.
  for (const name of BROWSER_NAMES) {
    const custom = launchOptionsFor(config, name);
    const path = custom.executablePath ?? expectedBrowserPath(name);
    const installed = custom.executablePath
      ? existsSync(custom.executablePath)
      : custom.channel
        ? true
        : isBrowserInstalled(name, { headless: config.browser.headless });
    const wanted = selected.includes(name);
    checks.push({
      name: `${BROWSER_LABELS[name]} binary`,
      status: installed ? "ok" : wanted ? "fail" : "info",
      detail: custom.channel
        ? `channel "${custom.channel}" (checked when launched)`
        : installed
          ? path
          : `not installed${wanted ? ` (expected at ${path})` : " (optional)"}`,
      ...(installed ? {} : { fix: `npx motionpr install ${name}` }),
    });
  }
  const launchable: BrowserName[] = [];
  if (options.launch !== false) {
    for (const name of selected) {
      const check = await launchCheck(config, name);
      checks.push(check);
      if (check.status !== "fail") launchable.push(name);
    }
  }
  const installed = launchable.length > 0;

  if (loaded) {
    const { paths, config } = loaded;
    try {
      await mkdir(paths.data, { recursive: true });
      const probe = join(paths.data, `.doctor-${process.pid}`);
      await writeFile(probe, "ok");
      await rm(probe);
      await access(paths.data);
      checks.push({ name: "Output directory", status: "ok", detail: `${paths.data} (writable)` });
    } catch (error) {
      checks.push({
        name: "Output directory",
        status: "fail",
        detail: `${paths.data}: ${(error as Error).message}`,
        fix: "Fix permissions or set output.directory in the config.",
      });
    }
    const withBaseline = await baselineBrowsers(paths);
    const legacy = await legacyBaseline(paths);
    const missingFor = selected.filter((b) => !withBaseline.includes(b));
    checks.push({
      name: "Baselines",
      status: missingFor.length ? "info" : "ok",
      detail: withBaseline.length
        ? `${withBaseline.map((b) => BROWSER_LABELS[b]).join(", ")} in ${paths.baseline}${legacy ? " (0.1 layout: npx motionpr baseline migrate)" : ""}${missingFor.length ? `; none yet for ${missingFor.map((b) => BROWSER_LABELS[b]).join(", ")}` : ""}`
        : "none yet",
      ...(missingFor.length
        ? {
            fix: `npx motionpr run${missingFor.length === 1 && missingFor[0] === config.browser.name ? "" : ` --browser ${missingFor.join(",")}`}, then npx motionpr baseline accept${missingFor.length === 1 && missingFor[0] === config.browser.name ? "" : ` --browser ${missingFor.join(",")}`}`,
          }
        : {}),
    });
    for (const server of webServers(config)) {
      const up = await isUrlReady(server.url);
      checks.push({
        name: "Web server",
        status: up ? "ok" : "info",
        detail: up
          ? `${server.url} is responding${server.reuseExistingServer ? " (will be reused)" : " (MotionPR will refuse to start a second server; set reuseExistingServer)"}`
          : `${server.url} not running; MotionPR starts \`${server.command}\``,
      });
    }
    if (!webServers(config).length && config.baseURL) {
      const up = await isUrlReady(config.baseURL);
      checks.push({
        name: "Base URL",
        status: up ? "ok" : "warn",
        detail: `${config.baseURL} ${up ? "is responding" : "is not responding"}`,
        ...(up ? {} : { fix: "Start your app, or configure webServer so MotionPR starts it." }),
      });
    }
    checks.push(
      ...(await adapterChecks(loaded, options.launch !== false && installed, launchable[0])),
    );
  }
  checks.push({
    name: "Environment",
    status: "info",
    detail: `${process.platform}-${process.arch}${isCI() ? ", CI detected (non-interactive)" : ""}${process.env.GITHUB_ACTIONS ? ", GitHub Actions" : ""}`,
  });

  const failures = checks.filter((c) => c.status === "fail").length;
  if (options.json) {
    printJson({ ok: failures === 0, checks });
    return failures ? 2 : 0;
  }
  const icon = (s: Check["status"]) =>
    s === "ok"
      ? t.c.green(t.symbols.ok)
      : s === "warn"
        ? t.c.yellow(t.symbols.warn)
        : s === "fail"
          ? t.c.red(t.symbols.fail)
          : t.tech(t.symbols.info);
  for (const c of checks) {
    t.write(
      `  ${icon(c.status)} ${c.name.padEnd(17)} ${c.status === "fail" ? c.detail : t.c.dim(c.detail)}`,
    );
    if (c.fix && c.status !== "ok") t.hint(`${c.status === "info" ? "" : "fix: "}${c.fix}`);
  }
  t.write();
  if (failures) t.fail(`${failures} problem${failures === 1 ? "" : "s"} found.`);
  else t.success("Everything MotionPR needs is in place.");
  return failures ? 2 : 0;
}

/** Known adapters: npm package, tested range, import path and the call the app must make. */
export const KNOWN_ADAPTERS: Record<
  string,
  { label: string; pkg: string; range: string; entry: string; setup: string }
> = {
  gsap: {
    label: "GSAP",
    pkg: "gsap",
    range: SUPPORTED_ENGINE_RANGES.gsap,
    entry: `${MOTIONPR_PACKAGE}/gsap`,
    setup: "motionprGsap.register(gsap)",
  },
  animejs: {
    label: "Anime.js",
    pkg: "animejs",
    range: SUPPORTED_ENGINE_RANGES.animejs,
    entry: `${MOTIONPR_PACKAGE}/animejs`,
    setup: "createAnimeInstrumentation() and its wrapAnimate/wrapTimeline functions",
  },
  lenis: {
    label: "Lenis",
    pkg: "lenis",
    range: SUPPORTED_ENGINE_RANGES.lenis,
    entry: `${MOTIONPR_PACKAGE}/lenis`,
    setup: "motionprLenis.attach(lenis)",
  },
};

/**
 * Version of an installed package, found by resolving it from the project and walking up to its
 * package.json (some packages, e.g. lenis, do not export `./package.json`).
 */
export function installedVersion(rootDir: string, pkg: string): string | null {
  const require = createRequire(join(rootDir, "package.json"));
  let entry: string;
  try {
    entry = require.resolve(pkg);
  } catch {
    try {
      entry = require.resolve(`${pkg}/package.json`);
    } catch {
      return null;
    }
  }
  let dir = dirname(entry);
  for (let i = 0; i < 6; i++) {
    const file = join(dir, "package.json");
    if (existsSync(file)) {
      try {
        const json = JSON.parse(readFileSync(file, "utf8")) as { name?: string; version?: string };
        if (json.name === pkg && json.version) return json.version;
      } catch {
        // keep walking
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

interface PageAdapter {
  id: string;
  /** Declared adapter protocol (agents before 0.5.0-alpha do not report it). */
  protocol?: number | null;
  engineVersion: string | null;
  capabilities: string[];
  diagnostics: { level: string; code: string; message: string }[];
}

/**
 * Launches one engine, opens a blank page with the agent and measures what MotionPR needs: the
 * Web Animations API, transition events, timer resolution and frame rate.
 */
async function launchCheck(config: ResolvedConfig, name: BrowserName): Promise<Check> {
  const label = BROWSER_LABELS[name];
  try {
    const browser = await launchBrowser(config, { browserName: name });
    try {
      const version = browser.version();
      const context = await browser.newContext();
      await context.addInitScript({ content: AGENT_SOURCE });
      const page = await context.newPage();
      await page.goto("about:blank");
      const caps = (await page.evaluate(`(async () => {
        const agent = window.${AGENT_GLOBAL};
        return agent ? agent.capabilities() : null;
      })()`)) as (BrowserCapabilities & { userAgent: string }) | null;
      if (!caps)
        return {
          name: `${label} launch`,
          status: "fail",
          detail: `${label} ${version} started, but the MotionPR agent did not load`,
          fix: "Reinstall MotionPR; if it persists, report it with this output.",
        };
      const missing = [
        caps.documentGetAnimations ? null : "document.getAnimations()",
        caps.elementAnimate ? null : "Element.animate()",
        caps.cssTransitionInterface ? null : "CSSTransition",
        caps.cssAnimationInterface ? null : "CSSAnimation",
      ].filter(Boolean);
      const fps = caps.frameIntervalMs ? Math.round(1000 / caps.frameIntervalMs) : null;
      return {
        name: `${label} launch`,
        status: missing.length ? "fail" : "ok",
        detail: missing.length
          ? `${label} ${version}: missing ${missing.join(", ")}`
          : `${label} ${version}, Web Animations API available; timers ${caps.timerResolutionMs ?? "?"} ms${fps ? `, ${fps} fps` : ""}`,
      };
    } finally {
      await browser.close().catch(() => undefined);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      name: `${label} launch`,
      status: "fail",
      detail: message.split("\n")[0]!,
      fix: isMissingDependencies(error)
        ? `Missing system libraries: npx motionpr install ${name} --with-deps`
        : isMotionprError(error)
          ? (error.hint ?? `npx motionpr install ${name}`)
          : `npx motionpr install ${name}`,
    };
  }
}

/** Opens the first scenario with the agent installed and reports which adapters registered. */
async function probeAdapters(
  loaded: LoadedConfig,
  browserName: BrowserName | undefined,
): Promise<PageAdapter[] | string> {
  const { config } = loaded;
  const scenario = config.scenarios.find((s) => !s.skip);
  if (!scenario) return "no runnable scenario";
  let url: string;
  try {
    url = scenarioUrl(config, scenario);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  if (!(await isUrlReady(url)))
    return `${url} is not responding (start the app to check registration)`;
  const browser = await launchBrowser(config, browserName ? { browserName } : {});
  try {
    const context = await browser.newContext({ serviceWorkers: "block" });
    await context.addInitScript({ content: AGENT_SOURCE });
    const page = await context.newPage();
    await page.goto(url, { waitUntil: "load", timeout: config.capture.navigationTimeout });
    await page.waitForTimeout(250);
    return (await page.evaluate((global) => {
      const agent = (window as unknown as Record<string, { adapterStatus(): unknown } | undefined>)[
        global
      ];
      return agent ? agent.adapterStatus() : [];
    }, AGENT_GLOBAL)) as PageAdapter[];
  } finally {
    await browser.close().catch(() => undefined);
  }
}

/**
 * One check per configured (or registered) adapter: installed version, tested range, and whether
 * the adapter actually registered in the app. An installed package alone is never reported as
 * working: registration is only confirmed by opening the page.
 */
async function adapterChecks(
  loaded: LoadedConfig,
  launch: boolean,
  browserName: BrowserName | undefined,
): Promise<Check[]> {
  const configured = loaded.config.adapters.map((a) => a.name);
  const ids = [...new Set([...configured])];
  if (!ids.length) return [];
  const probe = launch
    ? await probeAdapters(loaded, browserName).catch((e: unknown) => String(e))
    : null;
  const checks: Check[] = [];
  const registered = Array.isArray(probe) ? probe : [];
  for (const extra of registered) if (!ids.includes(extra.id)) ids.push(extra.id);
  for (const id of ids) {
    const known = KNOWN_ADAPTERS[id];
    const name = known ? known.label : `Adapter ${id}`;
    const inPage = registered.find((r) => r.id === id);
    const version = known ? installedVersion(loaded.rootDir, known.pkg) : null;
    const details: string[] = [];
    let status: Check["status"] = "ok";
    const fixes: string[] = [];
    if (known) {
      if (!version) {
        status = "warn";
        details.push(`${known.pkg} is not installed in this project`);
        fixes.push(`npm install ${known.pkg}`);
      } else if (!versionSatisfies(version, known.range)) {
        status = "warn";
        details.push(`${known.pkg} ${version} is outside the tested range ${known.range}`);
      } else details.push(`${known.pkg} ${version} (tested range ${known.range})`);
    }
    const rejected = inPage?.diagnostics.find((d) => d.code === "ADAPTER_PROTOCOL_UNSUPPORTED");
    if (rejected) {
      status = "fail";
      details.push(`not registered: ${rejected.message}`);
      fixes.push(
        `Update ${MOTIONPR_PACKAGE}, or use a version of the adapter written for adapter protocol 2.`,
      );
    } else if (inPage) {
      const about = [
        ...(typeof inPage.protocol === "number" ? [`protocol ${inPage.protocol}`] : []),
        ...(inPage.engineVersion ? [`runtime ${inPage.engineVersion}`] : []),
      ];
      details.push(
        `registered in the page${about.length ? ` (${about.join(", ")})` : ""}; capabilities: ${inPage.capabilities.join(", ") || "none"}`,
      );
      for (const d of inPage.diagnostics) {
        details.push(`${d.code}: ${d.message}`);
        if (d.level !== "info" && status === "ok") status = "warn";
      }
    } else if (Array.isArray(probe)) {
      status = loaded.config.adapters.find((a) => a.name === id)?.required ? "fail" : "warn";
      details.push("did not register in the page");
      if (known) fixes.push(`Import ${known.entry} in your app and call ${known.setup}.`);
    } else {
      if (status === "ok") status = "info";
      details.push(
        probe === null
          ? "page registration not checked (--no-launch)"
          : `page registration not checked: ${probe}`,
      );
    }
    checks.push({
      name,
      status,
      detail: details.join("; "),
      ...(fixes.length ? { fix: fixes.join("\n") } : {}),
    });
  }
  return checks;
}
