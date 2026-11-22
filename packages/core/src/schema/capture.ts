import { z } from "zod";

/**
 * MotionPR capture format, version 1.
 *
 * A capture is a directory containing `capture.json` (a {@link CaptureBundle}) and an `assets/`
 * folder of content-addressed screenshots. Screenshots are referenced by asset id; they are
 * never embedded in the JSON.
 *
 * Version 2 separates the kinds of motion MotionPR records, because they mean different things:
 * - {@link AnimationRecord}: one animated element over time (CSS, WAAPI, GSAP, Anime.js).
 * - {@link TimelineRecord}: a container that sequences animations (GSAP / Anime.js timelines).
 * - {@link ScrollMotionRecord}: how a scroller moved (Lenis or native scrolling). Scroll positions
 *   are observed live, never replayed, and are not treated as animation durations.
 * - {@link FrameSample}: computed values of one animation at one instant (deterministic replay).
 */
export const CAPTURE_SCHEMA_VERSION = 2;

export const diagnosticSchema = z.object({
  level: z.enum(["info", "warning", "error"]),
  code: z.string(),
  message: z.string(),
  scenario: z.string().optional(),
  step: z.number().int().optional(),
  checkpoint: z.string().optional(),
  hint: z.string().optional(),
});
export type Diagnostic = z.infer<typeof diagnosticSchema>;

export const boxSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
});
export type BoxValue = z.infer<typeof boxSchema>;

export const elementIdentitySchema = z.object({
  /** Stable matching key, e.g. `test-id:menu-panel` or `path:[data-testid="cards"]>div:nth-of-type(3)`. */
  key: z.string(),
  /** `adapter`: a non-DOM target (e.g. a JavaScript object animated by Anime.js), keyed by the adapter. */
  method: z.enum(["motionpr-id", "test-id", "dom-id", "aria", "dom-path", "adapter"]),
  confidence: z.enum(["high", "medium", "low"]),
  /** CSS selector that locates the element in the captured page. */
  selector: z.string(),
  tag: z.string(),
  label: z.string().optional(),
  pseudoElement: z.string().optional(),
  anchor: z.string().optional(),
  /**
   * Key of the shadow host, for an element inside a shadow root. Its key and selector start with
   * the host's (`test-id:plan-pro >> motionpr-id:glow`): it is identified within that root.
   * Captures made before `0.5.0-alpha` identified such elements without their host.
   */
  shadowHost: z.string().optional(),
  warnings: z.array(z.string()),
});
export type ElementIdentity = z.infer<typeof elementIdentitySchema>;

export const easingDescriptorSchema = z.object({
  /** Canonical easing string: CSS easing, GSAP/Anime.js ease name, `per-keyframe`, or `custom`. */
  value: z.string(),
  kind: z.enum(["css", "gsap", "animejs", "per-keyframe", "custom", "unknown"]),
  /** Where the easing applies: the whole iteration (`effect`) or each keyframe segment. */
  scope: z.enum(["effect", "segment"]),
  /** Eased output at evenly spaced inputs 0..1 (65 samples). Absent when not derivable. */
  samples: z.array(z.number()).optional(),
  /**
   * How `samples` were obtained: `exact` (evaluated from a known easing definition) or `sampled`
   * (by calling an opaque easing function, e.g. a custom Anime.js function). Absent with no samples.
   */
  samplesSource: z.enum(["exact", "sampled"]).optional(),
});
export type EasingDescriptor = z.infer<typeof easingDescriptorSchema>;

export const timingSchema = z.object({
  /** Duration of one iteration in ms; null when not time-based (e.g. scroll-driven). */
  duration: z.number().nullable(),
  delay: z.number(),
  endDelay: z.number(),
  iterations: z.union([z.number(), z.literal("infinite")]),
  iterationStart: z.number(),
  direction: z.enum(["normal", "reverse", "alternate", "alternate-reverse"]),
  fill: z.enum(["none", "forwards", "backwards", "both", "auto"]),
  playbackRate: z.number(),
  /** Effect-level easing (CSS transitions, WAAPI, GSAP). */
  easing: easingDescriptorSchema,
  /** Per-keyframe easing strings (CSS animations put animation-timing-function here). */
  keyframeEasings: z.array(z.string()).optional(),
  /** Effective easing used for curve comparison (effect easing, or the uniform keyframe easing). */
  effectiveEasing: easingDescriptorSchema,
  activeDuration: z.number().nullable(),
  endTime: z.number().nullable(),
});
export type Timing = z.infer<typeof timingSchema>;

export const keyframeValueSchema = z.object({
  offset: z.number(),
  value: z.string(),
  easing: z.string().optional(),
});

export const propertyTrackSchema = z.object({
  /** CSS property in kebab-case. */
  property: z.string(),
  /** Declared keyframe values (native animations only). */
  keyframes: z.array(keyframeValueSchema),
  /** First and last observed values (from keyframes or samples). */
  from: z.string().nullable(),
  to: z.string().nullable(),
});
export type PropertyTrack = z.infer<typeof propertyTrackSchema>;

export const numericSnapshotSchema = z.object({
  opacity: z.number().optional(),
  translateX: z.number().optional(),
  translateY: z.number().optional(),
  translateZ: z.number().optional(),
  scaleX: z.number().optional(),
  scaleY: z.number().optional(),
  rotate: z.number().optional(),
  skewX: z.number().optional(),
});
export type NumericSnapshot = z.infer<typeof numericSnapshotSchema>;

export const frameSampleSchema = z.object({
  index: z.number().int(),
  /** Local animation time in ms (0 = local time zero, before delay). */
  time: z.number(),
  /** Time relative to the checkpoint window origin, in ms. */
  windowTime: z.number(),
  /** Linear progress through the sampled active interval, 0..1. */
  progress: z.number(),
  /** Engine-reported iteration progress (after effect easing), null outside the active phase. */
  iterationProgress: z.number().nullable(),
  /** Computed values of the animated properties. */
  values: z.record(z.string(), z.string()),
  numeric: numericSnapshotSchema,
  /** Border box in viewport coordinates (includes transforms). Null if not measurable. */
  box: boxSchema.nullable(),
  /** Asset id of the nearest filmstrip frame, if frames were captured. */
  frame: z.string().nullable(),
  /**
   * Scroll-linked animations only: the progress of the scroll-driven animation (0..1, the scale
   * of `progressTrace`) at which the values were rendered. `windowTime` is then when the page
   * first showed that progress.
   */
  scrollProgress: z.number().optional(),
});
export type FrameSample = z.infer<typeof frameSampleSchema>;

export const completenessSchema = z.object({
  status: z.enum(["complete", "partial", "metadata-only"]),
  reasons: z.array(z.string()),
});
export type Completeness = z.infer<typeof completenessSchema>;

/**
 * How a recorded value was obtained:
 * - `declared`: read from the engine's public API or the parameters the developer passed.
 * - `observed`: measured while the page ran (e.g. start times from frame callbacks).
 * - `inferred`: derived from other values (e.g. per-target duration of a staggered tween).
 * - `unavailable`: the engine does not expose it publicly; MotionPR did not guess.
 */
export const provenanceSchema = z.enum(["declared", "observed", "inferred", "unavailable"]);
export type Provenance = z.infer<typeof provenanceSchema>;

/**
 * Where a scroll-linked animation runs in the scroll, as its engine resolved it. Positions are
 * scroll offsets (CSS px) of the scroller, so two runs of one build at one viewport agree.
 */
export const scrollLinkSchema = z.object({
  /** Scroll position at which the scroll-driven progress is 0 (ScrollTrigger's `start`). */
  start: z.number(),
  /** Scroll position at which the scroll-driven progress is 1 (ScrollTrigger's `end`). */
  end: z.number(),
  axis: z.enum(["vertical", "horizontal"]),
  /** Element key of the scroll container; null for the document scroller. */
  scroller: z.string().nullable(),
  /**
   * `0` when progress follows the scroll directly (`scrub: true`), the catch-up time in ms when
   * smoothed (`scrub: 0.5` → 500), null when the animation plays in time once triggered.
   */
  scrub: z.number().min(0).nullable(),
  /** Enter, leave, enter-back and leave-back actions of a triggered animation; null if scrubbed. */
  toggleActions: z.string().nullable(),
});
export type ScrollLink = z.infer<typeof scrollLinkSchema>;

export const ANIMATION_TYPES = [
  "css-animation",
  "css-transition",
  "web-animation",
  "gsap",
  "animejs",
  "custom",
] as const;

export const animationRecordSchema = z.object({
  /** Stable key used for matching: `<element key>::<type>::<name>` (+ `#n` for duplicates). */
  id: z.string(),
  type: z.enum(ANIMATION_TYPES),
  /** Adapter that observed the animation: `native` or an adapter id such as `gsap` or `animejs`. */
  source: z.string(),
  /**
   * What renders the motion: the browser's CSS engine, the Web Animations API, or a JavaScript
   * engine writing styles every frame. Anime.js WAAPI animations are `source: animejs`,
   * `driver: waapi`; GSAP is always `javascript`.
   */
  driver: z.enum(["css", "waapi", "javascript"]),
  /** Provenance of individual timing fields (`duration`, `delay`, `easing`, `startTime`, …). */
  provenance: z.record(z.string(), provenanceSchema).default({}),
  /** Id of the {@link TimelineRecord} this animation belongs to, if any. */
  parent: z.string().nullable().default(null),
  /** animation-name, transition-property, WAAPI id, or adapter-provided name. */
  name: z.string().nullable(),
  element: elementIdentitySchema,
  /** Local time zero relative to the window origin (ms). Null when unknown. */
  startTime: z.number().nullable(),
  timing: timingSchema,
  properties: z.array(propertyTrackSchema),
  samples: z.array(frameSampleSchema),
  completeness: completenessSchema,
  timeline: z.enum(["document", "scroll", "view", "adapter", "unknown"]),
  /**
   * Progress (0..1) observed live while the page ran, for animations that cannot be replayed
   * because they follow scroll (GSAP ScrollTrigger). Window-relative ms. Empty otherwise.
   */
  progressTrace: z.array(z.object({ time: z.number(), progress: z.number() })).default([]),
  /**
   * Scroll-linked animations whose engine resolves them (GSAP ScrollTrigger): where in the
   * scroll their scroll-driven progress runs and how it follows the scroll. Absent otherwise,
   * and in captures made before MotionPR recorded it.
   */
  scrollLink: scrollLinkSchema.optional(),
  playState: z.string(),
  group: z.string().nullable(),
  meta: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
});
export type AnimationRecord = z.infer<typeof animationRecordSchema>;

const metaSchema = z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]));

/** A timeline (GSAP timeline, Anime.js timeline) observed in a checkpoint window. */
export const timelineRecordSchema = z.object({
  /** Stable key: `<source>:<name or creation order>`. */
  id: z.string(),
  source: z.string(),
  name: z.string().nullable(),
  /** Local time zero relative to the window origin (ms). Null when unknown. */
  startTime: z.number().nullable(),
  /** Duration of one iteration in ms. */
  duration: z.number().nullable(),
  iterations: z.union([z.number(), z.literal("infinite")]),
  direction: z.enum(["normal", "reverse", "alternate", "alternate-reverse"]),
  playbackRate: z.number(),
  playState: z.string(),
  /** Progress (0..1) when the checkpoint was collected. */
  progress: z.number().nullable(),
  /** Named positions in ms from the timeline's local zero, sorted by time. */
  labels: z.array(z.object({ name: z.string(), time: z.number() })),
  /** Ids of the animation records that belong to this timeline, in start order. */
  children: z.array(z.string()),
  provenance: z.record(z.string(), provenanceSchema).default({}),
  notes: z.array(z.string()),
  meta: metaSchema,
});
export type TimelineRecord = z.infer<typeof timelineRecordSchema>;

/** One observation of a scroller. Values are CSS pixels; time is window-relative ms. */
export const scrollSampleSchema = z.object({
  time: z.number(),
  /** Position the browser reports (`scrollTop`/`scrollLeft`). */
  actualScroll: z.number(),
  /** Position the smooth-scroll engine is rendering. Equals `actualScroll` for native scrolling. */
  animatedScroll: z.number(),
  /** Position the engine is heading to. */
  targetScroll: z.number(),
  /** 0..1 of the scroll limit. */
  progress: z.number(),
  /** Engine-reported velocity (Lenis: px per frame; native: px per ms, derived). */
  velocity: z.number(),
  /** -1 backwards, 0 still, 1 forwards. */
  direction: z.number(),
  /** `true`/`false`, or Lenis's `"smooth"` / `"native"` scrolling modes. */
  isScrolling: z.union([z.boolean(), z.string()]),
  isStopped: z.boolean(),
  limit: z.number(),
});
export type ScrollSample = z.infer<typeof scrollSampleSchema>;

/**
 * How one scroller moved during a checkpoint window: a Lenis instance, the document's native
 * scrolling, or a native scroll container (an overflow element; `wrapper` is set).
 */
export const scrollMotionRecordSchema = z.object({
  /** Stable key: `<source>:<wrapper element key or "window">:<axis>`. */
  id: z.string(),
  source: z.enum(["lenis", "native"]),
  /**
   * Identifies the engine instance within the page session: the Lenis instance's name or
   * number, or for native scrolling `document` or `container`.
   */
  sessionId: z.string(),
  axis: z.enum(["vertical", "horizontal"]),
  /** Scroll container; null for the document scroller. */
  wrapper: elementIdentitySchema.nullable(),
  /** Engine configuration that shapes the motion (scalars only, never functions). */
  config: metaSchema,
  /** Samples in time order. Recorded live; scroll motion is never replayed. */
  samples: z.array(scrollSampleSchema),
  /** Number of engine scroll events observed in the window (may exceed `samples` when capped). */
  events: z.number().int(),
  prefersReducedMotion: z.boolean(),
  completeness: z.object({
    status: z.enum(["complete", "partial", "metadata-only"]),
    reasons: z.array(z.string()),
  }),
  meta: metaSchema,
});
export type ScrollMotionRecord = z.infer<typeof scrollMotionRecordSchema>;

/**
 * Animations that ran while a scroller moved. A correlation is an observation (overlapping time),
 * not a claim that the scroll caused the animation; `scroll-linked` is reserved for animations
 * whose engine declares a scroll-driven timeline (CSS scroll timelines, GSAP ScrollTrigger).
 */
export const motionCorrelationSchema = z.object({
  scroll: z.string(),
  animation: z.string(),
  kind: z.enum(["scroll-linked", "overlap"]),
  /** Overlap of the animation's active interval with scroll movement, in ms. */
  overlapMs: z.number(),
});
export type MotionCorrelation = z.infer<typeof motionCorrelationSchema>;

export const filmstripFrameSchema = z.object({
  index: z.number().int(),
  /** Window time in ms. */
  time: z.number(),
  asset: z.string(),
});
export type FilmstripFrame = z.infer<typeof filmstripFrameSchema>;

export const checkpointSchema = z.object({
  label: z.string(),
  index: z.number().int(),
  kind: z.enum(["capture", "screenshot"]),
  /** Page URL at capture time, with query values redacted unless allowed. */
  url: z.string(),
  scroll: z.object({ x: z.number(), y: z.number() }),
  window: z.object({
    origin: z.enum(["trigger", "motion-start", "navigation"]),
    trigger: z
      .object({ step: z.number().int(), type: z.string(), event: z.string().optional() })
      .optional(),
    /** Time from the triggering input event to the first animation start (ms). */
    latency: z.number().nullable(),
    /** End of the motion window in ms from the origin. */
    end: z.number(),
    /** True when the window was cut at `capture.maxWindow`. */
    capped: z.boolean(),
  }),
  animations: z.array(animationRecordSchema),
  timelines: z.array(timelineRecordSchema).default([]),
  /** Scrollers observed during the window (Lenis, native). */
  scrollMotion: z.array(scrollMotionRecordSchema).default([]),
  correlations: z.array(motionCorrelationSchema).default([]),
  frames: z.array(filmstripFrameSchema),
  /** Interval between filmstrip frames in ms (0 when no frames were captured). */
  frameInterval: z.number(),
  /** Settled screenshot (PNG) after the motion window, used for visual comparison. */
  screenshot: z.string().nullable(),
  diagnostics: z.array(diagnosticSchema),
});
export type Checkpoint = z.infer<typeof checkpointSchema>;

export const stepResultSchema = z.object({
  index: z.number().int(),
  type: z.string(),
  /** Human description of the step; never contains filled values. */
  description: z.string(),
  status: z.enum(["passed", "failed", "skipped"]),
  durationMs: z.number(),
  error: z.string().optional(),
});
export type StepResult = z.infer<typeof stepResultSchema>;

/** Health of an adapter configured or detected for a scenario. */
export const adapterStatusSchema = z.object({
  /** Adapter id (`gsap`, `animejs`, `lenis`, or a custom adapter's name). */
  id: z.string(),
  /** Library version the adapter detected in the page (null when it could not tell). */
  engineVersion: z.string().nullable(),
  /** Version range the adapter is tested against. */
  supportedRange: z.string().nullable(),
  /** `supported` (tested range), `untested` (outside the range), `unknown` (no version). */
  versionStatus: z.enum(["supported", "untested", "unknown"]),
  /**
   * `active`: registered and reporting; `missing`: configured but never registered;
   * `failed`: registered but threw while collecting, or not registered because it declared an
   * adapter protocol this MotionPR does not support (an `ADAPTER_PROTOCOL_UNSUPPORTED` error).
   */
  status: z.enum(["active", "missing", "failed"]),
  /**
   * The adapter protocol the adapter declared (1 when it declared none; null when it declared an
   * unusable value). Absent for missing adapters and in captures made before `0.5.0-alpha`.
   */
  protocol: z.number().nullable().optional(),
  capabilities: z.array(z.string()),
  diagnostics: z.array(diagnosticSchema),
});
export type AdapterStatus = z.infer<typeof adapterStatusSchema>;

export const viewportSchema = z.object({
  name: z.string(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  deviceScaleFactor: z.number().positive(),
});
export type Viewport = z.infer<typeof viewportSchema>;

export const scenarioResultSchema = z.object({
  /** `<scenario id>@<viewport name>`; the matching key across captures. */
  key: z.string(),
  id: z.string(),
  name: z.string(),
  path: z.string(),
  viewport: viewportSchema,
  status: z.enum(["passed", "failed", "skipped"]),
  durationMs: z.number(),
  steps: z.array(stepResultSchema),
  checkpoints: z.array(checkpointSchema),
  error: z
    .object({ message: z.string(), code: z.string().optional(), step: z.number().int().optional() })
    .optional(),
  /** Screenshot taken when the scenario failed, if any. */
  failureScreenshot: z.string().nullable(),
  /** Adapters configured for, or registered in, this scenario's page. */
  adapters: z.array(adapterStatusSchema).default([]),
  diagnostics: z.array(diagnosticSchema),
});
export type ScenarioResult = z.infer<typeof scenarioResultSchema>;

/**
 * Asset ids and paths are validated strictly: captures may come from untrusted sources (CI
 * artifacts of pull requests), and these values become file-system paths when reports are built.
 */
export const ASSET_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}\.(png|jpg|jpeg)$/;
export const ASSET_FILE_PATTERN = /^assets\/[A-Za-z0-9_-]{1,128}\.(png|jpg|jpeg)$/;
const assetId = z.string().regex(ASSET_ID_PATTERN, "invalid asset id");

export const assetSchema = z.object({
  /** Path relative to the capture directory: `assets/<id>`. */
  file: z.string().regex(ASSET_FILE_PATTERN, "asset paths must be assets/<id>.(png|jpg)"),
  format: z.enum(["png", "jpeg"]),
  width: z.number().int(),
  height: z.number().int(),
  bytes: z.number().int(),
});
export type Asset = z.infer<typeof assetSchema>;

/** Runtime capabilities of the capturing browser (see `capabilities()` in the agent). */
export const browserCapabilitiesSchema = z.object({
  /** `document.getAnimations()`: discovery of running CSS and Web Animations. */
  documentGetAnimations: z.boolean(),
  /** `Element.prototype.animate()`: Web Animations, and the replay clones MotionPR seeks. */
  elementAnimate: z.boolean(),
  /** `CSSTransition` / `CSSAnimation` interfaces: tells CSS motion apart from WAAPI. */
  cssTransitionInterface: z.boolean(),
  cssAnimationInterface: z.boolean(),
  /** `transitionrun` events: transitions are seen even when they end before the next frame. */
  transitionRunEvent: z.boolean(),
  /** `KeyframeEffect.pseudoElement`: animations of `::before` / `::after` are identified. */
  pseudoElementEffects: z.boolean(),
  /** CSS scroll-driven timelines (recorded as metadata only). */
  scrollTimeline: z.boolean(),
  viewTimeline: z.boolean(),
  /** Smallest observed step of `performance.now()` in ms (Firefox and WebKit coarsen timers). */
  timerResolutionMs: z.number().nullable(),
  /** Median `requestAnimationFrame` interval in ms while capturing (≈16.7 at 60 Hz). */
  frameIntervalMs: z.number().nullable(),
  devicePixelRatio: z.number().nullable(),
  /** What the page sees for `prefers-reduced-motion: reduce` (the emulated setting). */
  prefersReducedMotion: z.boolean().nullable(),
});
export type BrowserCapabilities = z.infer<typeof browserCapabilitiesSchema>;

export const captureSettingsSchema = z.object({
  colorScheme: z.string(),
  locale: z.string(),
  timezoneId: z.string(),
  reducedMotion: z.string(),
  samples: z.number().int(),
  frames: z.object({
    enabled: z.boolean(),
    fps: z.number(),
    maxFrames: z.number().int(),
    format: z.enum(["png", "jpeg"]),
  }),
  maxWindow: z.number(),
  maskInputs: z.boolean(),
  /**
   * Whether the scroll motion of native scroll containers was recorded
   * (`capture.scrollContainers`). Captures made before `0.4.0-alpha` did not record it and read
   * as `false`: a container scroll missing from them is not evidence that it did not move.
   */
  scrollContainers: z.boolean().default(false),
  /**
   * Whether MotionPR looked inside shadow roots: their animations and scroll containers were
   * recorded and their elements identified through their hosts (always, since `0.5.0-alpha`).
   * Older captures read as `false`: they missed CSS motion in shadow roots and identified the
   * rest without its host, so a shadow-root record missing from them is not evidence.
   */
  shadowRoots: z.boolean().default(false),
});

export const captureBundleSchema = z.object({
  schemaVersion: z.literal(CAPTURE_SCHEMA_VERSION),
  kind: z.literal("motionpr-capture"),
  motionprVersion: z.string(),
  id: z.string(),
  createdAt: z.string(),
  project: z.object({
    name: z.string(),
    git: z.object({ commit: z.string().optional(), branch: z.string().optional() }).optional(),
  }),
  environment: z.object({
    browser: z.object({
      /** Engine: `chromium`, `firefox` or `webkit` (as Playwright reports it at runtime). */
      name: z.string(),
      /** Version the launched browser reports (never taken from the configuration). */
      version: z.string(),
      headless: z.boolean(),
      /** Installed channel used instead of Playwright's build (`chrome`, `moz-firefox`, …). */
      channel: z.string().nullable().default(null),
      /** `navigator.userAgent` of the captured pages. */
      userAgent: z.string().nullable().default(null),
    }),
    platform: z.string(),
    arch: z.string(),
    /** Operating system release (`os.release()`), e.g. a Darwin or Linux kernel version. */
    osRelease: z.string().nullable().default(null),
    node: z.string(),
    playwright: z.string(),
    ci: z.boolean(),
    /**
     * What the browser supports and how it schedules work, measured in the first captured page:
     * the Web Animations features MotionPR relies on, timer resolution and frame interval.
     */
    capabilities: browserCapabilitiesSchema.nullable().default(null),
  }),
  settings: captureSettingsSchema,
  /** Hash of the capture-relevant configuration; differing hashes are reported as a diagnostic. */
  configHash: z.string(),
  scenarios: z.array(scenarioResultSchema),
  assets: z.record(assetId, assetSchema),
  diagnostics: z.array(diagnosticSchema),
});
export type CaptureBundle = z.infer<typeof captureBundleSchema>;
