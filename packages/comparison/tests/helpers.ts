import {
  CAPTURE_SCHEMA_VERSION,
  canonicalEasing,
  comparisonConfigSchema,
  cssEasingSamples,
  type AnimationRecord,
  type CaptureBundle,
  type Checkpoint,
  type ComparisonConfig,
  type ElementIdentity,
  type ScenarioResult,
} from "@motionpr/core";

export function config(overrides: Record<string, unknown> = {}): ComparisonConfig {
  return comparisonConfigSchema.parse(overrides);
}

export function element(key: string, over: Partial<ElementIdentity> = {}): ElementIdentity {
  const method = key.startsWith("path:")
    ? "dom-path"
    : key.startsWith("id:")
      ? "dom-id"
      : "test-id";
  return {
    key,
    method,
    confidence: method === "dom-path" ? "low" : method === "dom-id" ? "medium" : "high",
    selector: `[data-testid="${key}"]`,
    tag: "div",
    warnings: [],
    ...over,
  };
}

export interface AnimOptions {
  key?: string;
  type?: AnimationRecord["type"];
  name?: string | null;
  duration?: number;
  delay?: number;
  easing?: string;
  start?: number;
  props?: string[];
  translateX?: [number, number];
  opacity?: [number, number];
  iterations?: number | "infinite";
  group?: string | null;
  confidence?: "high" | "medium" | "low";
  completeness?: AnimationRecord["completeness"]["status"];
  samples?: number;
}

/** Builds a realistic animation record with sampled linear-in-progress trajectories. */
export function anim(o: AnimOptions = {}): AnimationRecord {
  const type = o.type ?? "css-transition";
  const name = o.name === undefined ? "transform" : o.name;
  const key = o.key ?? "test-id:panel";
  const duration = o.duration ?? 400;
  const delay = o.delay ?? 0;
  const easing = canonicalEasing(o.easing ?? "ease-out");
  const samples = cssEasingSamples(easing);
  const props = o.props ?? ["transform"];
  const n = o.samples ?? 6;
  const [x0, x1] = o.translateX ?? [0, 200];
  const [o0, o1] = o.opacity ?? [1, 1];
  const start = o.start ?? 0;
  const el = element(
    key,
    o.confidence
      ? { confidence: o.confidence, method: o.confidence === "low" ? "dom-path" : "test-id" }
      : {},
  );
  return {
    id: `${key}::${type}::${name ?? "anonymous"}`,
    type,
    source: type === "gsap" ? "gsap" : type === "animejs" ? "animejs" : "native",
    driver:
      type === "css-animation" || type === "css-transition"
        ? "css"
        : type === "web-animation"
          ? "waapi"
          : "javascript",
    provenance: {},
    parent: null,
    name,
    element: el,
    startTime: start,
    timing: {
      duration,
      delay,
      endDelay: 0,
      iterations: o.iterations ?? 1,
      iterationStart: 0,
      direction: "normal",
      fill: "auto",
      playbackRate: 1,
      easing: { value: easing, kind: "css", scope: "effect", ...(samples ? { samples } : {}) },
      effectiveEasing: {
        value: easing,
        kind: "css",
        scope: "effect",
        ...(samples ? { samples } : {}),
      },
      activeDuration: o.iterations === "infinite" ? null : duration,
      endTime: o.iterations === "infinite" ? null : delay + duration,
    },
    properties: props.map((p) => ({ property: p, keyframes: [], from: null, to: null })),
    samples: Array.from({ length: n }, (_, i) => {
      const p = i / (n - 1);
      return {
        index: i,
        time: delay + duration * p,
        windowTime: start + delay + duration * p,
        progress: p,
        iterationProgress: p,
        values: {},
        numeric: {
          translateX: x0 + (x1 - x0) * p,
          translateY: 0,
          scaleX: 1,
          scaleY: 1,
          rotate: 0,
          opacity: o0 + (o1 - o0) * p,
        },
        box: { x: x0 + (x1 - x0) * p, y: 0, width: 100, height: 100 },
        frame: null,
      };
    }),
    completeness: {
      status: o.completeness ?? "complete",
      reasons: o.completeness && o.completeness !== "complete" ? ["test"] : [],
    },
    timeline: "document",
    progressTrace: [],
    playState: "finished",
    group: o.group ?? null,
    meta: {},
  };
}

export function checkpoint(
  label: string,
  animations: AnimationRecord[],
  over: Partial<Checkpoint> = {},
): Checkpoint {
  return {
    label,
    index: 0,
    kind: "capture",
    url: "http://localhost/",
    scroll: { x: 0, y: 0 },
    window: {
      origin: "trigger",
      trigger: { step: 0, type: "click", event: "click" },
      latency: 16,
      end: 600,
      capped: false,
    },
    animations,
    timelines: [],
    scrollMotion: [],
    correlations: [],
    frames: [],
    frameInterval: 0,
    screenshot: null,
    diagnostics: [],
    ...over,
  };
}

export function scenario(
  id: string,
  checkpoints: Checkpoint[],
  over: Partial<ScenarioResult> = {},
): ScenarioResult {
  return {
    key: `${id}@default`,
    id,
    name: id,
    path: "/",
    viewport: { name: "default", width: 800, height: 600, deviceScaleFactor: 1 },
    status: "passed",
    durationMs: 100,
    steps: [],
    checkpoints,
    failureScreenshot: null,
    adapters: [],
    diagnostics: [],
    ...over,
  };
}

export function bundle(
  scenarios: ScenarioResult[],
  over: Partial<CaptureBundle> = {},
): CaptureBundle {
  return {
    schemaVersion: CAPTURE_SCHEMA_VERSION,
    kind: "motionpr-capture",
    motionprVersion: "0.1.0-alpha.0",
    id: "20261113-000000-0000",
    createdAt: "2026-11-13T00:00:00.000Z",
    project: { name: "test" },
    environment: {
      browser: { name: "chromium", version: "158", headless: true, channel: null, userAgent: null },
      platform: "linux",
      arch: "x64",
      node: "v24",
      playwright: "1.65.0",
      ci: false,
      osRelease: null,
      capabilities: null,
    },
    settings: {
      colorScheme: "light",
      locale: "en-US",
      timezoneId: "UTC",
      reducedMotion: "no-preference",
      samples: 6,
      frames: { enabled: false, fps: 30, maxFrames: 90, format: "png" },
      maxWindow: 5000,
      maskInputs: true,
      scrollContainers: true,
      shadowRoots: true,
    },
    configHash: "h",
    scenarios,
    assets: {},
    diagnostics: [],
    ...over,
  };
}
