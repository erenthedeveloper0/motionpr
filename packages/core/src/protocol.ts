/**
 * The contract between the Node capture runner, the in-page MotionPR agent and animation-engine
 * adapters (such as `@erenthedeveloper0/motionpr/gsap`). Types only, plus a few constants: this module is imported
 * by browser code that ships inside user applications, so it must stay dependency-free.
 */
import type { IdentityConfidence, IdentityMethod } from "./identity.ts";

/** Global under which the in-page agent is installed (via Playwright's addInitScript). */
export const AGENT_GLOBAL = "__MOTIONPR_AGENT__";

/**
 * Engine versions each first-party adapter is tested against. The single source for the
 * adapters' `supportedRange` and for `motionpr doctor`.
 */
export const SUPPORTED_ENGINE_RANGES = {
  gsap: ">=3.12.0 <4.0.0",
  animejs: ">=4.0.0 <5.0.0",
  lenis: ">=1.1.0 <2.0.0",
} as const;

/**
 * Version of the agent/adapter protocol. Protocol 2 (since `0.5.0-alpha`) is frozen: until 1.0,
 * members are only added as optional ones whose absence keeps today's behaviour, and a change
 * that would break a protocol 2 adapter gets a new number while the agent keeps accepting 2.
 */
export const PROTOCOL_VERSION = 2;

/**
 * Protocols the agent accepts from adapters. Protocol 1 adapters (no `protocol` member) have the
 * same members as protocol 2 and keep working.
 */
export const SUPPORTED_PROTOCOLS: readonly number[] = [1, 2];

export type AnimationType =
  "css-animation" | "css-transition" | "web-animation" | "gsap" | "animejs" | "custom";
export type AnimationDriver = "css" | "waapi" | "javascript";
export type ProvenanceValue = "declared" | "observed" | "inferred" | "unavailable";
export type TimelineKind = "document" | "scroll" | "view" | "adapter" | "unknown";
export type PlaybackDirection = "normal" | "reverse" | "alternate" | "alternate-reverse";
export type FillModeValue = "none" | "forwards" | "backwards" | "both" | "auto";
export type PlayStateValue = "idle" | "running" | "paused" | "finished" | "pending";
export type MetaValue = string | number | boolean | null;

export interface RawElementIdentity {
  key: string;
  method: IdentityMethod;
  confidence: IdentityConfidence;
  selector: string;
  tag: string;
  label?: string;
  pseudoElement?: string;
  anchor?: string;
  /**
   * Key of the shadow host when the element is inside a shadow root: the key then starts with
   * it (`test-id:plan-pro >> motionpr-id:glow`), and so does the selector.
   */
  shadowHost?: string;
  warnings: string[];
}

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Animation reported by an adapter. One entry per animated target element.
 * All times are milliseconds on the `performance.now()` clock.
 */
export interface AdapterAnimation {
  /** Unique within the adapter for the current window. */
  id: string;
  /** Human-facing name, e.g. an explicit `track()` id or a timeline label path. */
  name: string | null;
  target: Element | null;
  /** performance.now() time of local time zero (before delay). Null if unknown. */
  startTime: number | null;
  /** Duration of one iteration in ms. Null if unknown (e.g. scroll-linked). */
  duration: number | null;
  delay: number;
  endDelay?: number;
  /** Number of iterations; `Infinity` for endless repeats. */
  iterations: number;
  /** Total active time in ms when it differs from duration × iterations (e.g. GSAP repeatDelay). */
  activeDuration?: number | null;
  direction: PlaybackDirection;
  playbackRate: number;
  easing: { value: string; samples?: number[] };
  /** Animated CSS properties in kebab-case (engine-specific aliases are normalized by the adapter). */
  properties: string[];
  playState: PlayStateValue;
  /** Animations sharing a group (e.g. one staggered tween) are analysed together. */
  group?: string | null;
  meta?: Record<string, MetaValue>;
  /** Limitations encountered while observing this animation; non-empty means partial data. */
  notes?: string[];
  /** True when the adapter can render this animation at an arbitrary time via `seek()`. */
  samplable: boolean;
  timeline?: TimelineKind;
  /** Live progress observations (performance clock) for animations that follow scroll. */
  progressTrace?: { t: number; progress: number }[];
  /**
   * For a scroll-linked animation: the part of the scroll-driven progress (the values in
   * `progressTrace`, 0..1) during which this animation is active, e.g. `{ from: 0.5, to: 1 }`
   * for the second of two tweens in a scrubbed timeline. With `samplable` and the adapter's
   * `seekProgress()`, the agent samples the values it writes at the progress the scroll reached.
   */
  scrollRange?: { from: number; to: number };
  /**
   * For a scroll-linked animation: where in the scroll its scroll-driven progress runs and how
   * that progress follows the scroll, as the engine resolved it (GSAP ScrollTrigger's `start`,
   * `end`, `scrub` and `toggleActions`). Read from the engine, so two runs of one build at one
   * viewport report the same values; the comparison then relies on these instead of relating
   * the live `progressTrace` to the recorded scroll.
   */
  scrollLink?: AdapterScrollLink;
  /**
   * Stable identity for a non-DOM target (e.g. `object:value`), used as the element key when
   * `target` is null. Must not depend on creation order.
   */
  objectKey?: string;
  /** Record type; defaults to the adapter id when it is a known type, otherwise `custom`. */
  type?: AnimationType;
  /** Defaults to `javascript` for adapter records. */
  driver?: AnimationDriver;
  /** How each timing field was obtained (see the capture schema's `provenance`). */
  provenance?: Record<string, ProvenanceValue>;
  /** Adapter timeline id (see {@link AdapterTimeline}) this animation belongs to. */
  parent?: string | null;
  /** Easing details beyond `easing.value`. */
  easingKind?: "css" | "gsap" | "animejs" | "custom" | "unknown";
  /** `exact` when samples come from a known easing definition, `sampled` for opaque functions. */
  easingSamplesSource?: "exact" | "sampled";
}

/**
 * Where a scroll-linked animation runs in the scroll (see {@link AdapterAnimation.scrollLink}).
 * Positions are scroll offsets of `scroller` in CSS px.
 */
export interface AdapterScrollLink {
  /** Scroll position at which the scroll-driven progress is 0 (ScrollTrigger's `start`). */
  start: number;
  /** Scroll position at which the scroll-driven progress is 1 (ScrollTrigger's `end`). */
  end: number;
  axis: "vertical" | "horizontal";
  /** Scroll container whose offset the positions are; null for the document scroller. */
  scroller: Element | null;
  /**
   * How progress follows the scroll: `0` directly (GSAP `scrub: true`), the catch-up time in ms
   * when smoothed (`scrub: 0.5` → `500`), or `null` when the animation plays in time once the
   * scroll crosses `start` (no `scrub`).
   */
  scrub: number | null;
  /**
   * For an animation that plays once triggered (`scrub: null`): what it does on enter, leave,
   * enter back and leave back, e.g. `"play none none reverse"`. Null otherwise.
   */
  toggleActions?: string | null;
}

/** A timeline reported by an adapter (GSAP / Anime.js). Times on the performance clock (ms). */
export interface AdapterTimeline {
  /** Unique within the adapter; animations reference it through `parent`. */
  id: string;
  name: string | null;
  startTime: number | null;
  duration: number | null;
  iterations: number;
  direction: PlaybackDirection;
  playbackRate: number;
  playState: PlayStateValue;
  progress: number | null;
  /** Label positions in ms from the timeline's local zero. */
  labels: { name: string; time: number }[];
  provenance?: Record<string, ProvenanceValue>;
  notes?: string[];
  meta?: Record<string, MetaValue>;
}

/** Live state of a scroller, read by the agent each frame. Positions in CSS px. */
export interface ScrollState {
  actualScroll: number;
  animatedScroll: number;
  targetScroll: number;
  progress: number;
  velocity: number;
  direction: number;
  isScrolling: boolean | string;
  isStopped: boolean;
  limit: number;
}

/** A scroller observed by an adapter (e.g. one Lenis instance). Times on the performance clock. */
export interface AdapterScrollTrack {
  /** Unique within the adapter for the page session. */
  sessionId: string;
  axis: "vertical" | "horizontal";
  /** Scroll container element; null for the document scroller. */
  wrapper: Element | null;
  config: Record<string, MetaValue>;
  prefersReducedMotion: boolean;
  /** Samples observed since the window opened, oldest first. `t` is performance.now(). */
  samples: (ScrollState & { t: number })[];
  /** Engine events observed in the window (samples may be capped). */
  events: number;
  notes?: string[];
  meta?: Record<string, MetaValue>;
}

/** Native animations an adapter created itself (e.g. Anime.js `waapi.animate()`). */
export interface AdapterClaim {
  name?: string | null;
  group?: string | null;
  meta?: Record<string, MetaValue>;
  provenance?: Record<string, ProvenanceValue>;
}

export interface AdapterDiagnostic {
  level: "info" | "warning" | "error";
  code: string;
  message: string;
}

/** What an adapter can observe. Used for diagnostics and `motionpr doctor`. */
export type AdapterCapability =
  "animations" | "timelines" | "staggers" | "replay" | "scroll" | "scroll-control" | "waapi-claims";

/**
 * Contract implemented by every adapter running inside the page (GSAP, Anime.js, Lenis, custom):
 * adapter protocol 2. Every member except `name` and `collect` is optional; the agent checks
 * capabilities before calling. Adapters must never throw out of these methods into application
 * code, must not re-fire application callbacks, and must leave engine state as they found it
 * after replay. Entries whose fields do not have the documented types are left out of the
 * capture with an `ADAPTER_RECORD_INVALID` diagnostic; `motionpr adapter check` checks all rules.
 */
export interface MotionprAdapter {
  /** Adapter id: `gsap`, `animejs`, `lenis`, or a custom name. */
  readonly name: string;
  /**
   * The protocol this adapter implements: `2`. Without it the adapter is treated as protocol 1
   * (same members). The agent does not register an adapter that declares a protocol it does not
   * support, and records why in the capture's adapter table.
   */
  readonly protocol?: number;
  /** Version of the engine library the adapter observed (e.g. GSAP's `gsap.version`). */
  readonly version?: string;
  /** Engine version range the adapter is tested against, e.g. `>=4.0.0 <5`. */
  readonly supportedRange?: string;
  readonly capabilities?: readonly AdapterCapability[];
  /** Called whenever the agent opens a new observation window (after each checkpoint). */
  beginWindow?(): void;
  /** Animations observed since the current window opened. */
  collect(): AdapterAnimation[];
  /** True while any tracked, finite animation is still playing. */
  isAnimating?(): boolean;
  /** Prepare deterministic replay: pause tracked animations, remember their state. */
  beginReplay?(): void;
  /**
   * Synchronously render every tracked animation at absolute performance-clock time `timeMs`.
   * Scroll-linked animations show the progress the page showed at that time.
   */
  seek?(timeMs: number): void;
  /**
   * Synchronously render the scroll-linked animation `id` (an id from `collect()`) at `progress`
   * (0..1, the scale of its `progressTrace`) without firing callbacks. Called between
   * `beginReplay` and `endReplay`, after `seek`.
   */
  seekProgress?(id: string, progress: number): void;
  /** Restore the state captured in `beginReplay`. */
  endReplay?(): void;
  /** Timelines that ran in the current window. */
  collectTimelines?(): AdapterTimeline[];
  /** Scrollers observed in the current window. */
  collectScroll?(): AdapterScrollTrack[];
  /** Current state of each scroller, for settle detection (keyed by `sessionId`). */
  scrollStates?(): { sessionId: string; axis: "vertical" | "horizontal"; state: ScrollState }[];
  /** Programmatic scroll through the engine (used by the `scrollTo` step). */
  scrollTo?(target: number | Element, options: { immediate: boolean; offset?: number }): boolean;
  /** Returns claim metadata when `animation` was created by this adapter's engine. */
  claims?(animation: Animation): AdapterClaim | null;
  /** Health messages (version mismatches, unsupported features, cleanup problems). */
  diagnostics?(): AdapterDiagnostic[];
}

export interface RawKeyframe {
  offset: number;
  easing: string;
  composite: string;
  values: Record<string, string>;
}

export interface RawTiming {
  duration: number | null;
  delay: number;
  endDelay: number;
  iterations: number | "infinite";
  iterationStart: number;
  direction: PlaybackDirection;
  fill: FillModeValue;
  easing: string;
  playbackRate: number;
  activeDuration: number | null;
  endTime: number | null;
}

/** Animation as collected by the agent, before Node-side normalization and validation. */
export interface RawAnimation {
  uid: string;
  type: AnimationType;
  source: string;
  driver: AnimationDriver;
  provenance: Record<string, ProvenanceValue>;
  /** Raw adapter timeline id (`<adapter>:<id>`), resolved to a TimelineRecord id in Node. */
  parent: string | null;
  easingKind: "css" | "gsap" | "animejs" | "custom" | "unknown" | null;
  easingSamplesSource: "exact" | "sampled" | null;
  /** Window-relative live progress observations (scroll-linked animations). */
  progressTrace: { time: number; progress: number }[];
  /** Scroll-driven progress interval in which a scroll-linked animation is active. */
  scrollRange: { from: number; to: number } | null;
  /** Resolved scroll positions of a scroll-linked animation (scroller as an element key). */
  scrollLink: RawScrollLink | null;
  name: string | null;
  element: RawElementIdentity;
  /** Start (local time zero, before delay) relative to the window origin, in ms. */
  startTime: number | null;
  timing: RawTiming;
  keyframes: RawKeyframe[];
  properties: string[];
  easingSamples: number[] | null;
  timeline: TimelineKind;
  playState: PlayStateValue;
  group: string | null;
  meta: Record<string, MetaValue>;
  notes: string[];
  samplable: boolean;
}

/** {@link AdapterScrollLink} as the agent hands it to Node: the scroller as its element key. */
export interface RawScrollLink {
  start: number;
  end: number;
  axis: "vertical" | "horizontal";
  /** Element key of the scroll container; null for the document scroller. */
  scroller: string | null;
  scrub: number | null;
  toggleActions: string | null;
}

export interface RawSample {
  /** Window time (ms from origin). */
  t: number;
  /** Local animation time (ms since local zero, includes delay). */
  local: number;
  values: Record<string, string>;
  box: Box | null;
  /** Effect iteration progress reported by the engine (after effect-level easing). */
  iterationProgress: number | null;
  /** Scroll-driven progress (0..1) at which a scroll-linked animation was rendered. */
  scrollProgress?: number;
}

/**
 * `scroll` is instant positioning (the `scroll` / `scrollIntoView` steps); `scroll-motion` is an
 * interaction whose scrolling itself is under test (`scrollTo`, `wheel`).
 */
export type TriggerKind =
  | "click"
  | "hover"
  | "move"
  | "scroll"
  | "scroll-motion"
  | "fill"
  | "press"
  | "navigation"
  | "none";

export interface WindowOrigin {
  kind: "trigger" | "motion-start" | "navigation";
  /**
   * performance.now() time of the origin. For triggered windows this is the start of the first
   * animation (all animations started by one style change share a frame), so frames from
   * repeated captures align exactly regardless of input-to-frame jitter.
   */
  time: number;
  trigger?: { step: number; type: TriggerKind; event?: string };
  /** Time from the trigger event to the first animation start, in ms (null if not applicable). */
  latency: number | null;
}

export interface RawTimeline {
  /** `<adapter>:<id>` */
  uid: string;
  source: string;
  name: string | null;
  /** Window-relative local zero. */
  startTime: number | null;
  duration: number | null;
  iterations: number | "infinite";
  direction: PlaybackDirection;
  playbackRate: number;
  playState: PlayStateValue;
  progress: number | null;
  labels: { name: string; time: number }[];
  provenance: Record<string, ProvenanceValue>;
  notes: string[];
  meta: Record<string, MetaValue>;
}

export interface RawScrollTrack {
  source: "lenis" | "native";
  sessionId: string;
  axis: "vertical" | "horizontal";
  wrapper: RawElementIdentity | null;
  config: Record<string, MetaValue>;
  prefersReducedMotion: boolean;
  /** Window-relative samples. */
  samples: (ScrollState & { time: number })[];
  events: number;
  notes: string[];
  meta: Record<string, MetaValue>;
}

export interface RawAdapterStatus {
  id: string;
  /** The protocol the adapter declared (1 when it declared none). */
  protocol: number | null;
  engineVersion: string | null;
  supportedRange: string | null;
  capabilities: string[];
  failed: boolean;
  diagnostics: RawDiagnostic[];
}

export interface CollectResult {
  origin: WindowOrigin;
  animations: RawAnimation[];
  timelines: RawTimeline[];
  /** Scrollers that moved (or were observed) in the window. */
  scrollTracks: RawScrollTrack[];
  /** End of the motion window in ms from origin (latest finite end, capped). */
  end: number;
  capped: boolean;
  scroll: { x: number; y: number };
  diagnostics: RawDiagnostic[];
}

export interface RawDiagnostic {
  level: "info" | "warning" | "error";
  code: string;
  message: string;
}

export interface PendingState {
  finite: number;
  infinite: number;
  /** Short descriptions of what is still running, for timeout diagnostics. */
  running: string[];
}

export interface SettleResult {
  settled: boolean;
  /** Time spent waiting, in ms. */
  waited: number;
  pending: PendingState;
}

export interface AgentConfig {
  motionprIdAttribute: string;
  testIdAttribute: string;
  ignoreSelectors: string[];
  ignoreAnimationNames: string[];
  ignoreProperties: string[];
  maxWindowMs: number;
  /** Record native scroll containers, not only the document scroller (`capture.scrollContainers`). */
  scrollContainers: boolean;
}

/** API installed on `window.__MOTIONPR_AGENT__` while MotionPR is capturing. */
export interface MotionprAgentApi {
  readonly version: string;
  readonly protocol: number;
  registerAdapter(adapter: MotionprAdapter): void;
  /** Removes an adapter (called by an instrumentation's `dispose()`). */
  unregisterAdapter(adapter: MotionprAdapter): void;
  adapters(): { name: string; version?: string }[];
  configure(config: Partial<AgentConfig>): void;
  beginStep(index: number, type: TriggerKind): void;
  openWindow(): void;
  pending(): PendingState;
  /** Resolves once no finite animation runs and none started during `quietMs` (or on timeout). */
  waitForSettle(timeoutMs: number, quietMs: number): Promise<SettleResult>;
  windowIndex(): number;
  collect(): CollectResult;
  beginReplay(): void;
  seek(windowTime: number): void;
  sample(count: number): RawSample[][];
  endReplay(): void;
  identify(element: Element): RawElementIdentity;
  /** Waits for document.fonts (bounded) and reports faces still loading or failed. */
  fontStatus(
    timeoutMs: number,
  ): Promise<{ state: "ready" | "timeout"; failed: string[]; loading: string[] }>;
  /** Waits (bounded) for non-lazy images to finish; returns how many are still incomplete. */
  pendingImages(timeoutMs: number): Promise<number>;
  /**
   * Instantly scrolls the window or a container (an element, or a MotionPR selector: CSS parts
   * chained with `>>` into shadow roots). Throws when the selector matches nothing.
   */
  scrollTo(container: Element | string | null, x: number | null, y: number | null): void;
  scrollPosition(): { x: number; y: number };
  /**
   * Scrolls through the page's scroll engine. `via: auto` uses a registered scroll adapter
   * (Lenis) when present; returns which path was taken.
   */
  smoothScrollTo(request: SmoothScrollRequest): { via: "lenis" | "native" };
  /** Resolves when every scroller has been still for `stableFrames` samples and `minStableMs`. */
  waitForScrollSettled(options: ScrollSettleOptions): Promise<ScrollSettleResult>;
  /** Registered adapters with their health, for the capture's adapter status table. */
  adapterStatus(): RawAdapterStatus[];
  /** Internal bookkeeping sizes (memory-bound checks and debugging). */
  stats(): {
    tracked: number;
    nativeScrollSamples: number;
    /** Scroll containers known in the current window (scanned or seen scrolling). */
    scrollContainers: number;
    /** Shadow roots the agent watches (attached by script, or declarative and open). */
    shadowRoots: number;
    adapters: number;
    window: number;
  };
  /**
   * What this engine supports and how it schedules work: Web Animations features, timer
   * resolution and the frame interval (measured over a dozen frames).
   */
  capabilities(): Promise<RawCapabilities>;
}

/** Runtime capabilities measured in the page (stored as `environment.capabilities`). */
export interface RawCapabilities {
  documentGetAnimations: boolean;
  elementAnimate: boolean;
  cssTransitionInterface: boolean;
  cssAnimationInterface: boolean;
  transitionRunEvent: boolean;
  pseudoElementEffects: boolean;
  scrollTimeline: boolean;
  viewTimeline: boolean;
  timerResolutionMs: number | null;
  frameIntervalMs: number | null;
  devicePixelRatio: number | null;
  prefersReducedMotion: boolean | null;
  userAgent: string;
}

export interface SmoothScrollRequest {
  /** A scroll position, or the element to scroll to (an element, or a MotionPR selector). */
  target: number | string | Element;
  behavior: "smooth" | "instant";
  via: "auto" | "lenis" | "native";
  axis: "vertical" | "horizontal" | null;
  offset: number | null;
  /** The native scroll container to scroll (an element, or a MotionPR selector). */
  selector: string | Element | null;
}

export interface ScrollSettleOptions {
  timeout: number;
  threshold: number;
  stableFrames: number;
  minStableMs: number;
}

export interface ScrollSettleResult {
  settled: boolean;
  waited: number;
  /** Samples taken while waiting; low counts reveal throttled frame rates. */
  samples: number;
  /** Scrollers still moving on timeout, e.g. `lenis#1 (vertical) Δ3.2px`. */
  moving: string[];
  /** Scrollers whose engine reported scrolling the whole time without moving (stalled). */
  stalled: string[];
}

/** Agent methods callable from Node by name (all others are internal). */
export type AgentMethod = Exclude<
  keyof MotionprAgentApi,
  "version" | "protocol" | "registerAdapter" | "unregisterAdapter" | "identify"
>;

declare global {
  interface Window {
    __MOTIONPR_AGENT__?: MotionprAgentApi;
  }
}
