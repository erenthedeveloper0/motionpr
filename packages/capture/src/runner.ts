import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { arch, platform, release } from "node:os";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { Browser, BrowserContext, ElementHandle, Locator, Page } from "playwright-core";
import {
  AssetStore,
  CAPTURE_SCHEMA_VERSION,
  animationInterval,
  MOTIONPR_VERSION,
  MotionprError,
  configHash,
  generateCaptureId,
  joinUrl,
  redactUrl,
  scenarioUrl,
  scenarioViewports,
  writeCaptureBundle,
  effectiveBaseURL,
  type CaptureBundle,
  type Checkpoint,
  type Diagnostic,
  type FilmstripFrame,
  type ResolvedConfig,
  type ResolvedScenario,
  type ResolvedStep,
  type ScenarioResult,
  type StepResult,
  type AdapterStatus,
  type AgentMethod,
  type AnimationRecord,
  type TriggerKind,
  type Viewport,
  versionSatisfies,
  MOTIONPR_PACKAGE,
  BROWSER_LABELS,
  type BrowserCapabilities,
  type BrowserName,
} from "@motionpr/core";
import { AGENT_SOURCE } from "./agent/agent-bundle.generated.ts";
import { browserNameOf, launchBrowser, launchOptionsFor, playwrightVersion } from "./browser.ts";
import {
  correlateMotion,
  normalizeAnimations,
  normalizeScroll,
  normalizeTimelines,
  timelineIds,
} from "./normalize.ts";

const execFileAsync = promisify(execFile);

const ADAPTER_HINTS: Record<string, string> = {
  gsap: "Call motionprGsap.register(gsap) in your app (see docs/integrations/gsap.md).",
  animejs: `Wrap Anime.js with createAnimeInstrumentation() from ${MOTIONPR_PACKAGE}/animejs (see docs/integrations/animejs.md).`,
  lenis: "Call motionprLenis.attach(lenis) after creating Lenis (see docs/integrations/lenis.md).",
};

const RECORD_HINT =
  "The adapter broke the adapter protocol. `npx motionpr adapter check <page>` checks an adapter against every rule (docs/cli/adapter.md).";
const PROTOCOL_HINT = `Update ${MOTIONPR_PACKAGE}, or use a version of the adapter written for adapter protocol 2 (docs/advanced/custom-adapters.md).`;

/** Builds the adapter health table from what registered in the page and what was configured. */
export function adapterStatuses(
  registered: Awaited<ReturnType<NonNullable<Window["__MOTIONPR_AGENT__"]>["adapterStatus"]>>,
  configured: ResolvedConfig["adapters"],
): AdapterStatus[] {
  const out: AdapterStatus[] = registered.map((a) => ({
    id: a.id,
    // Agents before 0.5.0-alpha did not report it.
    ...(a.protocol !== undefined ? { protocol: a.protocol } : {}),
    engineVersion: a.engineVersion,
    supportedRange: a.supportedRange,
    versionStatus:
      a.engineVersion && a.supportedRange
        ? versionSatisfies(a.engineVersion, a.supportedRange)
          ? "supported"
          : "untested"
        : "unknown",
    status: a.failed ? "failed" : "active",
    capabilities: a.capabilities,
    diagnostics: a.diagnostics.map((d) => ({ ...d })),
  }));
  for (const adapter of configured) {
    if (out.some((a) => a.id === adapter.name)) continue;
    out.push({
      id: adapter.name,
      engineVersion: null,
      supportedRange: null,
      versionStatus: "unknown",
      status: "missing",
      capabilities: [],
      diagnostics: [
        {
          level: adapter.required ? "error" : "warning",
          code: "ADAPTER_MISSING",
          message: `Adapter "${adapter.name}" did not register in the page.`,
          ...(ADAPTER_HINTS[adapter.name] ? { hint: ADAPTER_HINTS[adapter.name] } : {}),
        },
      ],
    });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

export const INPUT_MASK_SELECTOR = [
  'input:not([type="button"]):not([type="submit"]):not([type="reset"]):not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="color"]):not([type="hidden"]):not([type="image"])',
  "textarea",
  "select",
  '[contenteditable=""]',
  '[contenteditable="true"]',
].join(", ");

export type CaptureEvent =
  | { type: "browser"; name: BrowserName; version: string }
  | { type: "scenario:start"; key: string; name: string; index: number; total: number }
  | { type: "step"; key: string; index: number; description: string }
  | { type: "checkpoint"; key: string; label: string; animations: number; frames: number }
  | {
      type: "scenario:end";
      key: string;
      status: ScenarioResult["status"];
      durationMs: number;
      error?: string;
    }
  | { type: "diagnostic"; diagnostic: Diagnostic }
  | { type: "debug"; message: string };

export interface CaptureOptions {
  config: ResolvedConfig;
  /** Directory containing the config file; relative paths resolve from here. */
  rootDir: string;
  /** Absolute directory to write the capture into (default: `<captures>/<id>`). */
  outputDir: string;
  /** Scenario ids or `*` globs to run (default: all). */
  scenarios?: string[];
  /** Viewport names to run (default: all). */
  viewports?: string[];
  headless?: boolean;
  debug?: boolean;
  signal?: AbortSignal;
  onEvent?: (event: CaptureEvent) => void;
  /** Override the capture id (default: generated). */
  id?: string;
  /**
   * Engine to capture with (default: `config.browser.name`). Never substituted: a missing or
   * broken engine is an error.
   */
  browserName?: BrowserName;
  /** Reuse an existing browser instead of launching one (its engine is used). */
  browser?: Browser;
}

export interface CaptureOutcome {
  bundle: CaptureBundle;
  dir: string;
}

interface Job {
  scenario: ResolvedScenario;
  viewport: Viewport;
  index: number;
}

function globToRegExp(glob: string): RegExp {
  return new RegExp(
    `^${glob
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*")
      .replace(/\?/g, ".")}$`,
  );
}

export function selectScenarios(
  config: ResolvedConfig,
  filters: string[] | undefined,
): ResolvedScenario[] {
  if (!filters?.length) return config.scenarios;
  const patterns = filters
    .flatMap((f) => f.split(","))
    .map((f) => f.trim())
    .filter(Boolean)
    .map(globToRegExp);
  const selected = config.scenarios.filter((s) => patterns.some((p) => p.test(s.id)));
  if (!selected.length) {
    throw new MotionprError("SCENARIO_NOT_FOUND", `No scenario matches ${filters.join(", ")}.`, {
      hint: `Available scenarios: ${config.scenarios.map((s) => s.id).join(", ")}`,
    });
  }
  return selected;
}

export function describeStep(step: ResolvedStep): string {
  switch (step.type) {
    case "goto":
      return `goto ${step.url ?? step.path}`;
    case "click":
      return `click ${step.selector}`;
    case "hover":
      return `hover ${step.selector}`;
    case "move":
      return `move mouse to (${step.x}, ${step.y})`;
    case "scroll":
      return `scroll${step.selector ? ` ${step.selector}` : ""} to ${[step.x !== undefined ? `x=${step.x}` : "", step.y !== undefined ? `y=${step.y}` : ""].filter(Boolean).join(", ")}`;
    case "scrollIntoView":
      return `scroll ${step.selector} into view`;
    case "scrollTo":
      return `scrollTo ${typeof step.target === "number" ? `${step.target}px` : step.target} (${step.behavior}, via ${step.via})`;
    case "wheel":
      return `wheel${step.selector ? ` over ${step.selector}` : ""} Δx=${step.deltaX} Δy=${step.deltaY}${step.steps > 1 ? ` in ${step.steps} steps` : ""}`;
    case "waitForScrollSettled":
      return "wait for scroll to settle";
    case "fill":
      return `fill ${step.selector} (value hidden)`;
    case "press":
      return `press ${step.key}${step.selector ? ` in ${step.selector}` : ""}`;
    case "waitFor":
      return `wait for ${step.selector} (${step.state ?? "visible"})`;
    case "waitForAnimations":
      return "wait for animations";
    case "wait":
      return `wait ${step.duration} ms`;
    case "capture":
      return `capture "${step.label}"`;
    case "screenshot":
      return `screenshot "${step.label}"`;
  }
}

function triggerKind(step: ResolvedStep): TriggerKind | null {
  switch (step.type) {
    case "click":
      return "click";
    case "hover":
      return "hover";
    case "move":
      return "move";
    case "scroll":
    case "scrollIntoView":
      return "scroll";
    case "scrollTo":
    case "wheel":
      return "scroll-motion";
    case "fill":
      return "fill";
    case "press":
      return "press";
    default:
      return null;
  }
}

/**
 * Cleans an error for storage. Playwright call logs echo action arguments (e.g. `fill("…")`),
 * so every fill value of the scenario is redacted.
 */
export function errorMessage(error: unknown, secrets: readonly string[] = []): string {
  let raw = error instanceof Error ? error.message : String(error);
  for (const secret of secrets) {
    if (!secret) continue;
    for (const form of new Set([secret, JSON.stringify(secret).slice(1, -1)]))
      raw = raw.split(form).join("<redacted>");
  }
  // Playwright messages include ANSI-colored call logs; keep the first meaningful lines.
  return (
    raw
      // eslint-disable-next-line no-control-regex
      .replace(/\u001b\[[0-9;]*m/g, "")
      .split("\n")
      .slice(0, 6)
      .join("\n")
      .trim()
  );
}

async function gitInfo(cwd: string): Promise<{ commit?: string; branch?: string } | undefined> {
  const env = process.env;
  if (env.GITHUB_SHA) {
    return {
      commit: env.GITHUB_SHA,
      ...(env.GITHUB_HEAD_REF || env.GITHUB_REF_NAME
        ? { branch: env.GITHUB_HEAD_REF || env.GITHUB_REF_NAME }
        : {}),
    };
  }
  try {
    const [{ stdout: commit }, { stdout: branch }] = await Promise.all([
      execFileAsync("git", ["rev-parse", "HEAD"], { cwd, timeout: 2000 }),
      execFileAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd, timeout: 2000 }),
    ]);
    return { commit: commit.trim(), branch: branch.trim() };
  } catch {
    return undefined;
  }
}

export async function projectName(config: ResolvedConfig, rootDir: string): Promise<string> {
  if (config.project.name) return config.project.name;
  try {
    const pkg = JSON.parse(await readFile(join(rootDir, "package.json"), "utf8")) as {
      name?: string;
    };
    if (pkg.name) return pkg.name;
  } catch {
    // no package.json
  }
  return basename(rootDir);
}

/** Runs every selected scenario × viewport and writes a capture bundle to `outputDir`. */
export async function runCapture(options: CaptureOptions): Promise<CaptureOutcome> {
  const { config, rootDir, outputDir, onEvent = () => undefined, signal } = options;
  const id = options.id ?? generateCaptureId();
  const assets = new AssetStore(outputDir);
  const scenarios = selectScenarios(config, options.scenarios);
  const jobs: Job[] = [];
  for (const scenario of scenarios) {
    if (scenario.skip) continue;
    for (const viewport of scenarioViewports(config, scenario)) {
      if (options.viewports?.length && !options.viewports.includes(viewport.name)) continue;
      jobs.push({ scenario, viewport, index: jobs.length });
    }
  }
  const bundleDiagnostics: Diagnostic[] = [];
  for (const scenario of scenarios) {
    if (scenario.skip) {
      bundleDiagnostics.push({
        level: "info",
        code: "SCENARIO_SKIPPED",
        message: `Scenario "${scenario.id}" skipped${typeof scenario.skip === "string" ? `: ${scenario.skip}` : ""}.`,
        scenario: scenario.id,
      });
    }
  }

  const requested = options.browserName ?? config.browser.name;
  if (options.browser && browserNameOf(options.browser) !== requested && options.browserName) {
    throw new MotionprError(
      "BROWSER_MISMATCH",
      `Asked to capture with ${BROWSER_LABELS[requested]}, but the browser passed in is ${BROWSER_LABELS[browserNameOf(options.browser)]}.`,
    );
  }
  const browser =
    options.browser ??
    (await launchBrowser(config, {
      browserName: requested,
      ...(options.headless === undefined ? {} : { headless: options.headless }),
    }));
  const browserName = browserNameOf(browser);
  const headless = options.headless ?? config.browser.headless;
  const channel = options.browser
    ? null
    : (launchOptionsFor(config, browserName, { headless }).channel ?? null);
  onEvent({ type: "browser", name: browserName, version: browser.version() });
  const results: ScenarioResult[] = new Array(jobs.length);
  const runtime: RuntimeInfo = { capabilities: null, userAgent: null };
  try {
    let next = 0;
    const worker = async () => {
      while (next < jobs.length) {
        if (signal?.aborted) throw new MotionprError("ABORTED", "Capture aborted.");
        const job = jobs[next++]!;
        results[job.index] = await runScenario(browser, job, jobs.length, {
          ...options,
          assets,
          onEvent,
          runtime,
          browserName,
        });
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(config.capture.concurrency, jobs.length) || 1 }, worker),
    );
  } finally {
    if (!options.browser) await browser.close().catch(() => undefined);
  }
  bundleDiagnostics.push(...runtimeDiagnostics(browserName, runtime.capabilities));

  const bundle: CaptureBundle = {
    schemaVersion: CAPTURE_SCHEMA_VERSION,
    kind: "motionpr-capture",
    motionprVersion: MOTIONPR_VERSION,
    id,
    createdAt: new Date().toISOString(),
    project: {
      name: await projectName(config, rootDir),
      ...(await gitInfo(rootDir).then((git) => (git ? { git } : {}))),
    },
    environment: {
      browser: {
        name: browserName,
        version: browser.version(),
        headless,
        channel,
        userAgent: runtime.userAgent,
      },
      platform: platform(),
      arch: arch(),
      osRelease: release(),
      node: process.version,
      playwright: playwrightVersion(),
      ci: Boolean(process.env.CI),
      capabilities: runtime.capabilities,
    },
    settings: {
      colorScheme: config.browser.colorScheme,
      locale: config.browser.locale,
      timezoneId: config.browser.timezoneId,
      reducedMotion: config.browser.reducedMotion,
      samples: config.capture.samples,
      frames: {
        enabled: config.capture.frames.enabled,
        fps: config.capture.frames.fps,
        maxFrames: config.capture.frames.maxFrames,
        format: config.capture.frames.format,
      },
      maxWindow: config.capture.maxWindow,
      maskInputs: config.privacy.maskInputs,
      scrollContainers: config.capture.scrollContainers,
      shadowRoots: true,
    },
    configHash: configHash(config),
    scenarios: results.filter(Boolean),
    assets: assets.toRecord(),
    diagnostics: bundleDiagnostics,
  };
  await writeCaptureBundle(outputDir, bundle);
  return { bundle, dir: outputDir };
}

interface RuntimeInfo {
  capabilities: BrowserCapabilities | null;
  userAgent: string | null;
}

interface ScenarioContext extends CaptureOptions {
  assets: AssetStore;
  onEvent: (event: CaptureEvent) => void;
  /** Filled by the first scenario that reaches its page. */
  runtime: RuntimeInfo;
  browserName: BrowserName;
}

/**
 * Notes on how precisely this engine could be observed. They describe the environment, not the
 * app: they explain noise in live observations (start offsets, scroll samples) so that it is not
 * mistaken for a regression.
 */
export function runtimeDiagnostics(
  browser: BrowserName,
  capabilities: BrowserCapabilities | null,
): Diagnostic[] {
  const out: Diagnostic[] = [];
  if (!capabilities) return out;
  const label = BROWSER_LABELS[browser];
  if (capabilities.timerResolutionMs !== null && capabilities.timerResolutionMs >= 0.5) {
    out.push({
      level: "info",
      code: "COARSE_TIMERS",
      message: `${label} reports time in ${capabilities.timerResolutionMs} ms steps; observed start offsets and scroll timings are quantized to that resolution.`,
    });
  }
  // Headless WebKit renders at 30 fps by design; below 20 fps the machine is likely throttled.
  const interval = capabilities.frameIntervalMs;
  if (interval !== null && interval > 20) {
    out.push({
      level: interval > 50 ? "warning" : "info",
      code: "LOW_FRAME_RATE",
      message: `${label} rendered a frame every ${interval} ms (${Math.round(1000 / interval)} fps) while capturing.`,
      hint: "Live observations (start times, scroll samples) are as coarse as the frame interval; replayed samples and frames are unaffected.",
    });
  }
  const missing = (
    [
      ["documentGetAnimations", "document.getAnimations()"],
      ["elementAnimate", "Element.animate()"],
      ["cssTransitionInterface", "CSSTransition"],
      ["cssAnimationInterface", "CSSAnimation"],
    ] as const
  )
    .filter(([key]) => !capabilities[key])
    .map(([, name]) => name);
  if (missing.length) {
    out.push({
      level: "error",
      code: "BROWSER_API_MISSING",
      message: `${label} lacks ${missing.join(", ")}; native animations cannot be captured completely.`,
    });
  }
  return out;
}

type Agent = NonNullable<Window["__MOTIONPR_AGENT__"]>;

async function runScenario(
  browser: Browser,
  job: Job,
  total: number,
  ctx: ScenarioContext,
): Promise<ScenarioResult> {
  const { config, assets, onEvent } = ctx;
  const { scenario, viewport } = job;
  const key = `${scenario.id}@${viewport.name}`;
  const name = scenario.name ?? scenario.id;
  const diagnostics: Diagnostic[] = [];
  const steps: StepResult[] = [];
  const checkpoints: Checkpoint[] = [];
  const started = Date.now();
  const privacy = config.privacy;
  const diag = (d: Omit<Diagnostic, "scenario">) => {
    const full: Diagnostic = { ...d, scenario: key };
    diagnostics.push(full);
    onEvent({ type: "diagnostic", diagnostic: full });
  };

  onEvent({ type: "scenario:start", key, name, index: job.index, total });

  let context: BrowserContext | undefined;
  let page: Page | undefined;
  let failure: ScenarioResult["error"];
  let failureScreenshot: string | null = null;
  let adapters: AdapterStatus[] = [];
  let timedOut = false;
  const timeoutMs = scenario.timeout ?? config.capture.scenarioTimeout;
  const secrets = scenario.steps.flatMap((s) => (s.type === "fill" ? [s.value] : []));
  const timer = setTimeout(() => {
    timedOut = true;
    void context?.close().catch(() => undefined);
  }, timeoutMs);

  // Ordered list of steps: an implicit final capture when the scenario has no checkpoint.
  const planned: ResolvedStep[] = [...scenario.steps];
  if (!planned.some((s) => s.type === "capture" || s.type === "screenshot")) {
    planned.push({ type: "capture", label: "final" });
    diag({
      level: "info",
      code: "IMPLICIT_CAPTURE",
      message: 'Scenario has no capture step; added a final capture labelled "final".',
    });
  }

  try {
    context = await browser.newContext({
      viewport: { width: viewport.width, height: viewport.height },
      deviceScaleFactor: viewport.deviceScaleFactor,
      colorScheme: config.browser.colorScheme,
      locale: config.browser.locale,
      timezoneId: config.browser.timezoneId,
      reducedMotion: config.browser.reducedMotion,
      serviceWorkers: "block",
      ...(config.browser.userAgent ? { userAgent: config.browser.userAgent } : {}),
    });
    await context.addInitScript({ content: AGENT_SOURCE });
    const agentConfig = {
      motionprIdAttribute: config.identity.attribute,
      testIdAttribute: config.identity.testIdAttribute,
      ignoreSelectors: config.ignore.selectors,
      ignoreAnimationNames: config.ignore.animations,
      ignoreProperties: config.ignore.properties,
      maxWindowMs: config.capture.maxWindow,
      scrollContainers: config.capture.scrollContainers,
    };
    await context.addInitScript({
      content: `window.__MOTIONPR_AGENT__ && window.__MOTIONPR_AGENT__.configure(${JSON.stringify(agentConfig)});`,
    });
    for (const adapter of config.adapters) {
      if (adapter.script)
        await context.addInitScript({ path: resolve(ctx.rootDir, adapter.script) });
    }

    page = await context.newPage();
    page.setDefaultTimeout(config.capture.actionTimeout);
    page.setDefaultNavigationTimeout(config.capture.navigationTimeout);
    let consoleErrors = 0;
    page.on("console", (msg) => {
      if (msg.type() !== "error" || ++consoleErrors > 5) return;
      diag({
        level: "info",
        code: "CONSOLE_ERROR",
        message: `Console error: ${msg.text().slice(0, 300)}`,
      });
    });
    page.on("pageerror", (error) => {
      diag({
        level: "warning",
        code: "PAGE_ERROR",
        message: `Uncaught page error: ${error.message.slice(0, 300)}`,
      });
    });
    page.on("requestfailed", (request) => {
      const url = redactUrl(request.url(), privacy);
      diag({
        level: "warning",
        code: "REQUEST_FAILED",
        message: `Request failed: ${url} (${request.failure()?.errorText ?? "unknown"})`,
      });
    });

    const p = page;
    // Calls an agent method by name. The callback is deliberately trivial: transpilers such as
    // tsx (esbuild keepNames) inject helpers into named inner functions, which would break when
    // Playwright serializes the callback into the page. All real in-page logic lives in the agent.
    const agent = <M extends AgentMethod>(
      method: M,
      ...args: Parameters<Agent[M]>
    ): Promise<Awaited<ReturnType<Agent[M]>>> =>
      p.evaluate(
        ([m, a]) => {
          const api = window.__MOTIONPR_AGENT__ as unknown as
            Record<string, (...x: unknown[]) => unknown> | undefined;
          if (!api) throw new Error("MotionPR agent is not installed in this page.");
          return api[m]!(...a);
        },
        [method, args] as [string, unknown[]],
      ) as Promise<Awaited<ReturnType<Agent[M]>>>;

    const navigate = async (
      url: string,
      waitUntil: "load" | "domcontentloaded" | "networkidle" | "commit" = "load",
    ) => {
      await p.goto(url, { waitUntil });
      await p.waitForFunction(() => Boolean(window.__MOTIONPR_AGENT__), undefined, {
        timeout: 5000,
      });
      await waitForReady(p, agent, config, diag);
      const registered = await agent("adapterStatus");
      for (const status of registered) {
        const rejected = status.diagnostics.find((d) => d.code === "ADAPTER_PROTOCOL_UNSUPPORTED");
        if (rejected) diag({ ...rejected, hint: PROTOCOL_HINT });
      }
      for (const adapter of config.adapters) {
        if (!registered.some((r) => r.id === adapter.name)) {
          diag({
            level: adapter.required ? "error" : "warning",
            code: "ADAPTER_MISSING",
            message: `Adapter "${adapter.name}" did not register in the page.`,
            hint: ADAPTER_HINTS[adapter.name] ?? "Check the adapter script path.",
          });
        }
      }
    };

    const settle = async (timeout: number, label: string) => {
      const result = await agent("waitForSettle", timeout, config.capture.settleTime);
      if (!result.settled) {
        diag({
          level: "warning",
          code: "ANIMATIONS_NOT_SETTLED",
          message: `${label}: animations still running after ${Math.round(result.waited)} ms: ${result.pending.running.join("; ") || "unknown"}.`,
          hint: "Increase capture.waitForAnimationsTimeout or the step timeout.",
        });
      }
      return result;
    };

    const scenarioStartUrl = scenarioUrl(config, scenario);
    await navigate(scenarioStartUrl);
    if (!ctx.runtime.capabilities) {
      try {
        const { userAgent, ...caps } = await agent("capabilities");
        ctx.runtime.capabilities ??= caps;
        ctx.runtime.userAgent ??= userAgent;
      } catch {
        // a page that navigates away immediately; the next scenario measures it
      }
    }

    const refreshAdapters = async () => {
      try {
        adapters = adapterStatuses(await agent("adapterStatus"), config.adapters);
      } catch {
        // page gone; keep the last known table
      }
    };
    await refreshAdapters();

    for (let i = 0; i < planned.length; i++) {
      const step = planned[i]!;
      const description = describeStep(step);
      const stepStart = Date.now();
      onEvent({ type: "step", key, index: i, description });
      try {
        if (ctx.signal?.aborted) throw new MotionprError("ABORTED", "Capture aborted.");
        const kind = triggerKind(step);
        // Found before the trigger time, so looking them up is not part of the latency.
        const elements = await stepElements(p, step, config);
        try {
          if (kind) await agent("beginStep", i, kind);
          await executeStep(p, step, agent, elements, {
            config,
            navigate: async (s) => {
              const base = effectiveBaseURL(config) ?? scenarioStartUrl;
              await navigate(s.url ?? joinUrl(base, s.path ?? "/"), s.waitUntil ?? "load");
            },
            settle,
            diag,
            capture: async (s) => {
              const checkpoint = await captureCheckpoint(p, s, checkpoints.length, {
                config,
                assets,
                agent,
                settle,
                diag,
                privacy,
                viewport,
                debug: ctx.debug === true,
                onEvent,
                key,
              });
              checkpoints.push(checkpoint);
              onEvent({
                type: "checkpoint",
                key,
                label: checkpoint.label,
                animations: checkpoint.animations.length,
                frames: checkpoint.frames.length,
              });
            },
          });
        } finally {
          await disposeStepElements(elements);
        }
        steps.push({
          index: i,
          type: step.type,
          description,
          status: "passed",
          durationMs: Date.now() - stepStart,
        });
        if (step.type === "goto" || step.type === "capture") await refreshAdapters();
      } catch (error) {
        const message = timedOut
          ? `Scenario timed out after ${timeoutMs} ms.`
          : errorMessage(error, secrets);
        steps.push({
          index: i,
          type: step.type,
          description,
          status: "failed",
          durationMs: Date.now() - stepStart,
          error: message,
        });
        failure = {
          message: `Step ${i + 1} (${description}) failed: ${message}`,
          step: i,
          ...(error instanceof MotionprError ? { code: error.code } : {}),
        };
        for (let j = i + 1; j < planned.length; j++) {
          steps.push({
            index: j,
            type: planned[j]!.type,
            description: describeStep(planned[j]!),
            status: "skipped",
            durationMs: 0,
          });
        }
        if (!timedOut) {
          try {
            const shot = await p.screenshot({
              type: "png",
              mask: maskLocators(p, config),
              animations: "allow",
            });
            failureScreenshot = await assets.put(shot, "png", {
              width: viewport.width * viewport.deviceScaleFactor,
              height: viewport.height * viewport.deviceScaleFactor,
            });
          } catch {
            // page may be gone
          }
        }
        break;
      }
    }
  } catch (error) {
    failure ??= {
      message: timedOut
        ? `Scenario timed out after ${timeoutMs} ms.`
        : errorMessage(error, secrets),
      ...(error instanceof MotionprError ? { code: error.code } : {}),
    };
  } finally {
    clearTimeout(timer);
    await context?.close().catch(() => undefined);
  }

  const status: ScenarioResult["status"] = failure ? "failed" : "passed";
  const durationMs = Date.now() - started;
  onEvent({
    type: "scenario:end",
    key,
    status,
    durationMs,
    ...(failure ? { error: failure.message } : {}),
  });
  return {
    key,
    id: scenario.id,
    name,
    path: scenario.url ? redactUrl(scenario.url, privacy) : (scenario.path ?? "/"),
    viewport,
    status,
    durationMs,
    steps,
    checkpoints,
    ...(failure ? { error: failure } : {}),
    failureScreenshot,
    adapters,
    diagnostics,
  };
}

type AgentCall = <M extends AgentMethod>(
  method: M,
  ...args: Parameters<Agent[M]>
) => Promise<Awaited<ReturnType<Agent[M]>>>;

async function waitForReady(
  page: Page,
  agent: AgentCall,
  config: ResolvedConfig,
  diag: (d: Omit<Diagnostic, "scenario">) => void,
): Promise<void> {
  const cap = config.capture;
  if (cap.waitForNetworkIdle) {
    try {
      await page.waitForLoadState("networkidle", { timeout: cap.networkIdleTimeout });
    } catch {
      diag({
        level: "warning",
        code: "NETWORK_NOT_IDLE",
        message: `Network did not go idle within ${cap.networkIdleTimeout} ms.`,
        hint: "Long-polling or analytics requests keep the network busy; set capture.waitForNetworkIdle to false if expected.",
      });
    }
  }
  if (cap.waitForFonts) {
    const fonts = await agent("fontStatus", cap.networkIdleTimeout);
    if (fonts.state === "timeout" || fonts.loading.length) {
      diag({
        level: "warning",
        code: "FONTS_NOT_READY",
        message: `Fonts still loading: ${fonts.loading.join(", ") || "unknown"}.`,
      });
    }
    if (fonts.failed.length) {
      diag({
        level: "warning",
        code: "FONT_LOAD_FAILED",
        message: `Fonts failed to load: ${fonts.failed.join(", ")}.`,
        hint: "Text renders with fallback fonts; screenshots will differ from production.",
      });
    }
  }
  if (cap.waitForImages) {
    const pendingImages = await agent("pendingImages", cap.networkIdleTimeout);
    if (pendingImages > 0)
      diag({
        level: "warning",
        code: "IMAGES_NOT_LOADED",
        message: `${pendingImages} image(s) had not finished loading.`,
      });
  }
}

function maskLocators(page: Page, config: ResolvedConfig): Locator[] {
  const selectors = [
    ...(config.privacy.maskInputs ? [INPUT_MASK_SELECTOR] : []),
    ...config.privacy.maskSelectors,
  ];
  return selectors.map((s) => page.locator(s));
}

/**
 * Elements a step hands to the agent (`scroll` and `scrollTo` act in the page). They are found by
 * Playwright, like the targets of `click` and `hover`: the same selectors work for every step,
 * including inside open shadow roots, and a step waits for its element to be attached.
 */
interface StepElements {
  /** `scrollTo` with a selector as `target`. */
  target?: ElementHandle<Element>;
  /** The container a `scroll` or `scrollTo` step scrolls (`selector`). */
  container?: ElementHandle<Element>;
}

async function stepElements(
  page: Page,
  step: ResolvedStep,
  config: ResolvedConfig,
): Promise<StepElements> {
  const out: StepElements = {};
  try {
    if (step.type === "scroll" && step.selector)
      out.container = await stepElement(page, step.selector, config);
    if (step.type === "scrollTo") {
      if (typeof step.target === "string")
        out.target = await stepElement(page, step.target, config);
      if (step.selector) out.container = await stepElement(page, step.selector, config);
    }
  } catch (error) {
    await disposeStepElements(out);
    throw error;
  }
  return out;
}

/** The first element matching a Playwright selector, once it is attached. */
async function stepElement(
  page: Page,
  selector: string,
  config: ResolvedConfig,
): Promise<ElementHandle<Element>> {
  let handle: ElementHandle<Element> | null = null;
  try {
    handle = await page
      .locator(selector)
      .first()
      .elementHandle({ timeout: config.capture.actionTimeout });
  } catch (error) {
    if (!(error instanceof Error && error.name === "TimeoutError")) throw error;
  }
  if (!handle)
    throw new Error(`No element matches ${selector} (waited ${config.capture.actionTimeout} ms).`);
  return handle;
}

async function disposeStepElements(elements: StepElements): Promise<void> {
  for (const handle of [elements.target, elements.container])
    await handle?.dispose().catch(() => undefined);
}

/**
 * An element handle as the agent receives it: Playwright passes handles inside `evaluate`
 * arguments to the page as the elements themselves.
 */
function inPage(handle: ElementHandle<Element> | undefined): Element | null {
  return (handle ?? null) as unknown as Element | null;
}

interface StepHooks {
  config: ResolvedConfig;
  diag(d: Omit<Diagnostic, "scenario">): void;
  navigate(step: Extract<ResolvedStep, { type: "goto" }>): Promise<void>;
  settle(timeout: number, label: string): Promise<unknown>;
  capture(step: Extract<ResolvedStep, { type: "capture" | "screenshot" }>): Promise<void>;
}

async function executeStep(
  page: Page,
  step: ResolvedStep,
  agent: AgentCall,
  elements: StepElements,
  hooks: StepHooks,
): Promise<void> {
  switch (step.type) {
    case "goto":
      return hooks.navigate(step);
    case "click":
      return page.locator(step.selector).click({
        ...(step.button ? { button: step.button } : {}),
        ...(step.clickCount ? { clickCount: step.clickCount } : {}),
        ...(step.position ? { position: step.position } : {}),
        ...(step.force ? { force: true } : {}),
        ...(step.timeout !== undefined ? { timeout: step.timeout } : {}),
      });
    case "hover":
      return page.locator(step.selector).hover({
        ...(step.position ? { position: step.position } : {}),
        ...(step.force ? { force: true } : {}),
        ...(step.timeout !== undefined ? { timeout: step.timeout } : {}),
      });
    case "move":
      return page.mouse.move(step.x, step.y, { steps: step.steps ?? 1 });
    case "scroll":
      await agent("scrollTo", inPage(elements.container), step.x ?? null, step.y ?? null);
      return;
    case "scrollTo": {
      const result = await agent("smoothScrollTo", {
        target: inPage(elements.target) ?? (step.target as number),
        behavior: step.behavior,
        via: step.via,
        axis: step.axis ?? null,
        offset: step.offset ?? null,
        selector: inPage(elements.container),
      });
      if (step.via === "auto" && result.via === "native" && step.behavior === "smooth") {
        hooks.diag({
          level: "info",
          code: "SCROLL_NATIVE",
          message: `scrollTo used native smooth scrolling (no Lenis instance attached).`,
        });
      }
      return;
    }
    case "wheel": {
      const viewport = page.viewportSize() ?? { width: 800, height: 600 };
      const at = step.selector
        ? await wheelPoint(page, step.selector, step.position, viewport, hooks.config)
        : (step.position ?? {
            x: Math.round(viewport.width / 2),
            y: Math.round(viewport.height / 2),
          });
      await page.mouse.move(at.x, at.y);
      for (let k = 0; k < step.steps; k++) {
        await page.mouse.wheel(step.deltaX / step.steps, step.deltaY / step.steps);
        if (k < step.steps - 1) await page.waitForTimeout(step.interval);
      }
      return;
    }
    case "waitForScrollSettled": {
      const result = await agent("waitForScrollSettled", {
        timeout: step.timeout,
        threshold: step.threshold,
        stableFrames: step.stableFrames,
        minStableMs: step.minStableMs,
      });
      if (!result.settled) {
        hooks.diag({
          level: "warning",
          code: "SCROLL_NOT_SETTLED",
          message: `Scroll still moving after ${Math.round(result.waited)} ms: ${result.moving.join("; ") || "unknown"}.`,
          hint: "Raise the step timeout, or check for infinite scroll loops and scroll-jacking.",
        });
      } else if (result.stalled.length) {
        hooks.diag({
          level: "warning",
          code: "SCROLL_STALLED",
          message: `${result.stalled.join(", ")} reported scrolling but never moved.`,
          hint: "With autoRaf: false, the app must call lenis.raf(time) every frame (e.g. from requestAnimationFrame or gsap.ticker).",
        });
      } else if (result.samples < 8) {
        hooks.diag({
          level: "info",
          code: "SCROLL_LOW_FRAME_RATE",
          message: `Only ${result.samples} frames were sampled while waiting for scroll; the browser may be throttled.`,
        });
      }
      return;
    }
    case "scrollIntoView": {
      const locator = page.locator(step.selector);
      await locator.waitFor({
        state: "attached",
        ...(step.timeout !== undefined ? { timeout: step.timeout } : {}),
      });
      await locator.evaluate(
        (el, block) => el.scrollIntoView({ block, behavior: "instant" }),
        step.block ?? "center",
      );
      return;
    }
    case "fill":
      return page
        .locator(step.selector)
        .fill(step.value, step.timeout !== undefined ? { timeout: step.timeout } : {});
    case "press":
      if (step.selector)
        return page
          .locator(step.selector)
          .press(step.key, step.timeout !== undefined ? { timeout: step.timeout } : {});
      return page.keyboard.press(step.key);
    case "waitFor":
      await page.locator(step.selector).waitFor({
        state: step.state ?? "visible",
        ...(step.timeout !== undefined ? { timeout: step.timeout } : {}),
      });
      return;
    case "waitForAnimations":
      await hooks.settle(
        step.timeout ?? hooks.config.capture.waitForAnimationsTimeout,
        "waitForAnimations",
      );
      return;
    case "wait":
      await page.waitForTimeout(step.duration);
      return;
    case "capture":
    case "screenshot":
      return hooks.capture(step);
  }
}

/**
 * Where a `wheel` step with a `selector` puts the pointer: the centre of the element's visible
 * part, or `position` relative to its top-left corner. The browser scrolls the scroll container
 * under the pointer, so the point must be in the viewport and the element must be the one hit
 * there; MotionPR never scrolls to reach it (that would be motion of its own).
 */
async function wheelPoint(
  page: Page,
  selector: string,
  position: { x: number; y: number } | undefined,
  viewport: { width: number; height: number },
  config: ResolvedConfig,
): Promise<{ x: number; y: number }> {
  const locator = page.locator(selector);
  await locator.waitFor({ state: "visible", timeout: config.capture.actionTimeout });
  const box = await locator.boundingBox();
  if (!box) throw new Error(`wheel: ${selector} is not rendered.`);
  const left = Math.max(0, box.x);
  const top = Math.max(0, box.y);
  const right = Math.min(viewport.width, box.x + box.width);
  const bottom = Math.min(viewport.height, box.y + box.height);
  const at = position
    ? { x: box.x + position.x, y: box.y + position.y }
    : { x: (left + right) / 2, y: (top + bottom) / 2 };
  if (
    right <= left ||
    bottom <= top ||
    at.x < 0 ||
    at.y < 0 ||
    at.x >= viewport.width ||
    at.y >= viewport.height
  )
    throw new Error(
      `wheel: ${selector} is outside the viewport at (${Math.round(at.x)}, ${Math.round(at.y)}). Bring it into view first, e.g. with a scrollIntoView step.`,
    );
  const point = { x: Math.round(at.x), y: Math.round(at.y) };
  const covering = await locator.evaluate(
    (el, [x, y]) => {
      const root = el.getRootNode() as Document | ShadowRoot;
      const hit = root.elementFromPoint(x!, y!);
      if (!hit || el === hit || el.contains(hit)) return null;
      const id = hit.getAttribute("data-testid") ?? hit.id;
      return `${hit.tagName.toLowerCase()}${id ? ` (${id})` : ""}`;
    },
    [point.x, point.y],
  );
  if (covering)
    throw new Error(
      `wheel: ${selector} is covered by ${covering} at (${point.x}, ${point.y}); the wheel would scroll that instead. Pass a position inside the element that is not covered.`,
    );
  return point;
}

interface CheckpointContext {
  config: ResolvedConfig;
  assets: AssetStore;
  agent: AgentCall;
  settle(timeout: number, label: string): Promise<unknown>;
  diag(d: Omit<Diagnostic, "scenario">): void;
  privacy: ResolvedConfig["privacy"];
  viewport: Viewport;
  debug: boolean;
  onEvent: (event: CaptureEvent) => void;
  key: string;
}

export function frameTimes(
  end: number,
  fps: number,
  maxFrames: number,
): { times: number[]; interval: number } {
  if (end <= 0) return { times: [0], interval: 0 };
  const interval = Math.max(1000 / fps, end / (maxFrames - 1));
  const times: number[] = [];
  for (let t = 0; t < end - interval * 0.25; t += interval) times.push(Math.round(t * 1000) / 1000);
  times.push(Math.round(end * 1000) / 1000);
  return { times, interval: Math.round(interval * 1000) / 1000 };
}

async function captureCheckpoint(
  page: Page,
  step: Extract<ResolvedStep, { type: "capture" | "screenshot" }>,
  index: number,
  ctx: CheckpointContext,
): Promise<Checkpoint> {
  const { config, assets, agent, viewport } = ctx;
  const diagnostics: Diagnostic[] = [];
  const checkpointDiag = (d: Omit<Diagnostic, "scenario">) => {
    const full = { ...d, checkpoint: step.label };
    diagnostics.push({ ...full, scenario: ctx.key });
    ctx.diag(full);
  };
  const mask = maskLocators(page, config);
  const deviceSize = {
    width: Math.round(viewport.width * viewport.deviceScaleFactor),
    height: Math.round(viewport.height * viewport.deviceScaleFactor),
  };
  const url = redactUrl(page.url(), ctx.privacy);

  if (step.type === "screenshot") {
    await ctx.settle(config.capture.waitForAnimationsTimeout, `screenshot "${step.label}"`);
    const shot = step.selector
      ? await page.locator(step.selector).screenshot({ type: "png", mask, animations: "allow" })
      : await page.screenshot({
          type: "png",
          fullPage: step.fullPage ?? false,
          mask,
          animations: "allow",
        });
    const size = pngSize(shot) ?? deviceSize;
    const asset = await assets.put(shot, "png", size);
    const scroll = await agent("scrollPosition");
    await agent("openWindow");
    return {
      label: step.label,
      index,
      kind: "screenshot",
      url,
      scroll,
      window: { origin: "navigation", latency: null, end: 0, capped: false },
      animations: [],
      timelines: [],
      scrollMotion: [],
      correlations: [],
      frames: [],
      frameInterval: 0,
      screenshot: asset,
      diagnostics,
    };
  }

  await ctx.settle(config.capture.waitForAnimationsTimeout, `capture "${step.label}"`);
  const maxWindow = step.maxWindow ?? config.capture.maxWindow;
  if (step.maxWindow !== undefined) await agent("configure", { maxWindowMs: maxWindow });
  const collected = await agent("collect");
  if (step.maxWindow !== undefined)
    await agent("configure", { maxWindowMs: config.capture.maxWindow });
  for (const d of collected.diagnostics)
    checkpointDiag(d.code === "ADAPTER_RECORD_INVALID" ? { ...d, hint: RECORD_HINT } : d);
  if (collected.capped) {
    checkpointDiag({
      level: "warning",
      code: "WINDOW_CAPPED",
      message: `Motion window exceeds ${maxWindow} ms; frames stop at the cap.`,
      hint: "Raise capture.maxWindow or the step's maxWindow.",
    });
  }
  const infinite = collected.animations.filter((a) => a.timing.iterations === "infinite");
  if (infinite.length) {
    checkpointDiag({
      level: "info",
      code: "INFINITE_ANIMATIONS",
      message: `${infinite.length} infinite animation(s) recorded; one iteration is sampled.`,
    });
  }
  if (ctx.debug)
    ctx.onEvent({
      type: "debug",
      message: `[${ctx.key}] "${step.label}": ${collected.animations.length} animation(s), window ${collected.end} ms, origin ${collected.origin.kind}`,
    });

  let frames: FilmstripFrame[] = [];
  let frameInterval = 0;
  let screenshot: string | null = null;
  let samples: Awaited<ReturnType<Agent["sample"]>>;
  await agent("beginReplay");
  try {
    samples = await agent("sample", config.capture.samples);
    // Frames follow time-based animations; scroll-linked ones are shown as the page showed them.
    const wantFrames =
      (step.frames ?? config.capture.frames.enabled) &&
      collected.end > 0 &&
      collected.animations.some((a) => a.samplable && a.startTime !== null);
    if (wantFrames) {
      const fmt = config.capture.frames;
      const grid = frameTimes(collected.end, fmt.fps, fmt.maxFrames);
      frameInterval = grid.interval;
      for (let i = 0; i < grid.times.length; i++) {
        const t = grid.times[i]!;
        await agent("seek", t);
        const shot = await page.screenshot({
          type: fmt.format,
          ...(fmt.format === "jpeg" ? { quality: fmt.quality } : {}),
          scale: "css",
          mask,
          animations: "allow",
          caret: "hide",
        });
        frames.push({
          index: i,
          time: t,
          asset: await assets.put(shot, fmt.format, {
            width: viewport.width,
            height: viewport.height,
          }),
        });
      }
    }
    if (step.screenshot !== false) {
      await agent("seek", collected.end);
      const shot = await page.screenshot({ type: "png", mask, animations: "allow", caret: "hide" });
      screenshot = await assets.put(shot, "png", pngSize(shot) ?? deviceSize);
    }
  } finally {
    await agent("endReplay");
  }
  await agent("openWindow");

  const ids = timelineIds(collected.timelines);
  const animations = normalizeAnimations(
    collected.animations,
    samples,
    frames,
    config.capture.samples,
    ids,
  );
  const timelines = normalizeTimelines(collected.timelines, ids, animations);
  const scrollMotion = normalizeScroll(collected.scrollTracks);
  const correlations = correlateMotion(animations, scrollMotion);
  const duplicates = possibleDuplicates(animations);
  if (duplicates.length) {
    checkpointDiag({
      level: "warning",
      code: "POSSIBLE_DUPLICATE_RECORDS",
      message: `${duplicates.length} element(s) are animated by more than one engine on the same property at the same time: ${duplicates.slice(0, 4).join("; ")}.`,
      hint: "Two engines writing one property usually means a conflict in the app, or one engine's WAAPI output being reported twice. Check the adapter claims in docs/integrations/combining-adapters.md.",
    });
  }
  const lowConfidence = animations.filter(
    (a) => a.element.confidence === "low" && a.element.method !== "adapter",
  ).length;
  if (lowConfidence) {
    checkpointDiag({
      level: "info",
      code: "LOW_CONFIDENCE_IDENTITY",
      message: `${lowConfidence} animation(s) are identified by DOM position only.`,
      hint: `Add ${config.identity.attribute}="..." to animated elements for reliable matching.`,
    });
  }
  if (frames.length === 0 && collected.end > 0 && collected.animations.length) {
    frames = [];
  }
  return {
    label: step.label,
    index,
    kind: "capture",
    url,
    scroll: collected.scroll,
    window: {
      origin: collected.origin.kind,
      ...(collected.origin.trigger ? { trigger: collected.origin.trigger } : {}),
      latency: collected.origin.latency,
      end: collected.end,
      capped: collected.capped,
    },
    animations,
    timelines,
    scrollMotion,
    correlations,
    frames,
    frameInterval,
    screenshot,
    diagnostics,
  };
}

/**
 * Same element and property animated by different sources over overlapping intervals. Native
 * records an adapter already claimed never reach this point, so remaining overlaps are real
 * conflicts or unclaimed engine output.
 */
export function possibleDuplicates(animations: readonly AnimationRecord[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < animations.length; i++) {
    const a = animations[i]!;
    for (let j = i + 1; j < animations.length; j++) {
      const b = animations[j]!;
      if (a.source === b.source || a.element.key !== b.element.key) continue;
      const shared = a.properties
        .map((p) => p.property)
        .filter((p) => b.properties.some((q) => q.property === p));
      if (!shared.length) continue;
      const ia = animationInterval(a);
      const ib = animationInterval(b);
      if (
        !ia ||
        !ib ||
        Math.min(ia.activeEnd, ib.activeEnd) <= Math.max(ia.activeStart, ib.activeStart)
      )
        continue;
      out.push(`${a.element.key} ${shared.join(",")} (${a.source} + ${b.source})`);
    }
  }
  return out;
}

/** Reads width/height from a PNG IHDR chunk. */
export function pngSize(buf: Uint8Array): { width: number; height: number } | null {
  if (buf.length < 24 || buf[0] !== 0x89 || buf[1] !== 0x50) return null;
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}
