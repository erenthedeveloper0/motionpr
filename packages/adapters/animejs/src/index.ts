/**
 * MotionPR adapter for Anime.js v4 (`@erenthedeveloper0/motionpr/animejs`).
 *
 * Anime.js renders JavaScript animations from its own engine loop, so `document.getAnimations()`
 * cannot see them, and per-target timing (staggers) lives in private tween objects. MotionPR
 * therefore instruments Anime.js explicitly, at creation time, through public APIs only:
 *
 * - `wrapAnimate(animate)` / `wrapTimeline(createTimeline)` return drop-in functions that pass
 *   every argument through unchanged, except that function-valued `delay`, `duration` and `ease`
 *   (e.g. `stagger(80)`) are wrapped with transparent recorders: Anime.js calls them exactly as
 *   before and receives exactly the same values, and MotionPR learns each target's timing.
 * - `onUpdate` is composed, never replaced: MotionPR observes `(performance.now(), currentTime)`
 *   and then calls the developer's callback with the same `this` and arguments. Reassigning
 *   `animation.onUpdate` later keeps working. Observation errors never reach the animation.
 * - Deterministic replay renders root animations and timelines with `seek(time, true)` (callbacks
 *   muted) and restores time, pause and completion state afterwards.
 * - `wrapWaapi(waapi.animate)` marks the native Web Animations Anime.js creates, so MotionPR's
 *   native collector records them once, labelled `source: animejs`, `driver: waapi`.
 *
 * Outside a MotionPR capture (no agent in the page) every wrapper returns the original function
 * and nothing is patched.
 */
import {
  AGENT_GLOBAL,
  PROTOCOL_VERSION,
  SUPPORTED_ENGINE_RANGES,
  type AdapterAnimation,
  type AdapterCapability,
  type AdapterClaim,
  type AdapterDiagnostic,
  type AdapterTimeline,
  type MetaValue,
  type MotionprAdapter,
  type PlaybackDirection,
  type PlayStateValue,
  type ProvenanceValue,
} from "@motionpr/core/protocol";
import { resolveEaseName, sampleEase, type EasesLike, type EasingFunction } from "./eases.ts";

export { resolveEaseName, sampleEase, type EasesLike, type EasingFunction } from "./eases.ts";

/** Anime.js versions this adapter is tested against. */
export const SUPPORTED_ANIMEJS_RANGE: string = SUPPORTED_ENGINE_RANGES.animejs;
const ADAPTER_ID = "animejs";
const CAPABILITIES: readonly AdapterCapability[] = [
  "animations",
  "timelines",
  "staggers",
  "replay",
  "waapi-claims",
];
/** Upper bound on tracked root animations/timelines (long-lived pages create many). */
const MAX_ROOTS = 2000;
/** Observations kept per instance; the mapping needs only a handful. */
const MAX_OBSERVATIONS = 12;
/** Shift (ms) in the observed time origin that counts as a seek, restart or reverse. */
const DISCONTINUITY_MS = 34;

// ---------------------------------------------------------------------------------------------
// Structural view of the public Anime.js v4 API (no runtime dependency on animejs)
// ---------------------------------------------------------------------------------------------

/** Public members shared by Anime.js `Timer`, `JSAnimation` and `Timeline`. */
export interface AnimeTickableLike {
  id: string | number;
  parent: AnimeTimelineLike | null;
  duration: number;
  iterationDuration: number;
  iterationCount: number;
  currentTime: number;
  iterationCurrentTime: number;
  progress: number;
  currentIteration: number;
  speed: number;
  paused: boolean;
  began: boolean;
  completed: boolean;
  readonly reversed: boolean;
  readonly cancelled: boolean;
  onUpdate: (self: never) => unknown;
  seek(time: number, muteCallbacks?: boolean | number): unknown;
  resume(): unknown;
  cancel(): unknown;
}

export interface AnimeAnimationLike extends AnimeTickableLike {
  targets: unknown[];
}

export interface AnimeTimelineLike extends AnimeTickableLike {
  labels: Record<string, number>;
  defaults: Record<string, unknown>;
  add(...args: unknown[]): unknown;
}

export interface AnimeWaapiAnimationLike {
  targets: unknown[];
  animations: Animation[];
  duration: number;
}

/** Public `engine` export (optional; improves defaults and speed accuracy). */
export interface AnimeEngineLike {
  speed: number;
  defaults: Record<string, unknown>;
}

/** Signature of `animate(targets, parameters)`. */
export type AnimateLike = (targets: never, parameters: never) => object;
/** Signature of `createTimeline(parameters?)`. */
export type CreateTimelineLike = (parameters?: never) => object;
/** Signature of `waapi.animate(targets, parameters)`. */
export type WaapiAnimateLike = (targets: never, parameters: never) => object;

export interface AnimeInstrumentationOptions {
  /**
   * Anime.js's `eases` export. Named eases are then evaluated with Anime.js's own functions;
   * without it MotionPR uses a port of the v4 ease parser that is tested against Anime.js.
   */
  eases?: EasesLike;
  /** Anime.js's `engine` export: exact defaults and global speed. */
  engine?: AnimeEngineLike;
  /** Instrument even without a MotionPR agent in the page (tests, debugging). */
  force?: boolean;
}

export interface AnimeInstrumentation {
  /** True when MotionPR is capturing this page and Anime.js is instrumented. */
  readonly active: boolean;
  /** Returns a drop-in replacement for `animate` that MotionPR can observe. */
  wrapAnimate<F extends AnimateLike>(animate: F): F;
  /** Returns a drop-in replacement for `createTimeline` that MotionPR can observe. */
  wrapTimeline<F extends CreateTimelineLike>(createTimeline: F): F;
  /** Returns a drop-in replacement for `waapi.animate`. */
  wrapWaapi<F extends WaapiAnimateLike>(waapiAnimate: F): F;
  /**
   * Observes an animation or timeline created without a wrapper and optionally names it. Per-
   * target timing and properties of such instances are unavailable (Anime.js keeps them private).
   */
  track<T extends object>(instance: T, name?: string): T;
  /** Adapter health: unsupported features, version, errors swallowed during observation. */
  getDiagnostics(): AdapterDiagnostic[];
  /**
   * Restores every patched callback, stops observing and unregisters from MotionPR. Wrapped
   * functions keep working and simply pass through afterwards. Never stops or reverts animations.
   */
  dispose(): void;
}

// ---------------------------------------------------------------------------------------------
// Parameters → per-target tracks
// ---------------------------------------------------------------------------------------------

/** Anime.js parameter names that are options, not animated properties (`globals.defaults`). */
const RESERVED = new Set([
  "id",
  "keyframes",
  "playbackEase",
  "playbackRate",
  "frameRate",
  "loop",
  "reversed",
  "alternate",
  "autoplay",
  "persist",
  "duration",
  "delay",
  "loopDelay",
  "ease",
  "composition",
  "modifier",
  "onBegin",
  "onBeforeUpdate",
  "onUpdate",
  "onLoop",
  "onPause",
  "onComplete",
  "onRender",
  "priority",
  "defaults",
]);
const TRANSFORMS = new Set([
  "x",
  "y",
  "z",
  "perspective",
  "translateX",
  "translateY",
  "translateZ",
  "rotate",
  "rotateX",
  "rotateY",
  "rotateZ",
  "scale",
  "scaleX",
  "scaleY",
  "scaleZ",
  "skew",
  "skewX",
  "skewY",
  "matrix",
  "matrix3d",
]);
const TIMING_FIELDS = ["delay", "duration", "ease"] as const;
type TimingField = (typeof TIMING_FIELDS)[number];
/** Anime.js's built-in defaults (`globals.defaults`), used when `engine` is not provided. */
const BUILTIN_DEFAULTS = { delay: 0, duration: 1000, ease: "out(2)" } as const;

const kebab = (p: string) =>
  p.startsWith("--") ? p : p.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && Object.getPrototypeOf(v) === Object.prototype;
}

/** Resolves targets the way Anime.js does for DOM selectors, arrays and NodeLists. */
function resolveTargets(targets: unknown): unknown[] {
  if (typeof targets === "string")
    return typeof document === "undefined" ? [] : Array.from(document.querySelectorAll(targets));
  if (Array.isArray(targets)) return targets.flatMap(resolveTargets);
  if (typeof NodeList !== "undefined" && targets instanceof NodeList) return Array.from(targets);
  return targets === null || targets === undefined ? [] : [targets];
}

function isElement(v: unknown): v is Element {
  return typeof Element !== "undefined" && v instanceof Element;
}

/** Property name as MotionPR samples it: CSS (kebab-case), `attr:` for SVG attributes, `prop:`. */
function sampledProperty(target: unknown, prop: string): string {
  if (!isElement(target)) return `prop:${prop}`;
  if (TRANSFORMS.has(prop)) return "transform";
  if (prop.startsWith("--")) return prop;
  const svg = typeof SVGElement !== "undefined" && target instanceof SVGElement;
  const style = (target as HTMLElement).style as unknown as Record<string, unknown>;
  if (svg && (target.getAttribute(prop) !== null || prop in target) && !(prop in style))
    return `attr:${prop}`;
  if (prop in style) return kebab(prop);
  if (prop in target) return `prop:${prop}`;
  return `attr:${prop}`;
}

interface EaseInfo {
  value: string;
  kind: "animejs" | "custom" | "unknown";
  samples: number[] | null;
  source: "exact" | "sampled" | null;
  /** Springs set their own duration (`settlingDuration`). */
  duration?: number;
}

interface Track {
  targetIndex: number;
  target: Element | null;
  properties: string[];
  /** ms from the animation's local zero to this target's first visible change. */
  delay: number;
  duration: number;
  ease: EaseInfo;
  provenance: Record<string, ProvenanceValue>;
  notes: string[];
}

/** Records the values Anime.js obtains from function-based parameters, per target index. */
class Recorder {
  readonly values = new Map<string, Map<number, unknown>>();
  /** Fields whose function returned different values for one target (e.g. unseeded random). */
  readonly unstable = new Set<string>();

  wrap(key: string, fn: (...args: unknown[]) => unknown): (...args: unknown[]) => unknown {
    const values = this.values;
    const unstable = this.unstable;
    return function recorded(this: unknown, ...args: unknown[]) {
      const result = fn.apply(this, args);
      // Anime.js evaluates function values as fn(target, index, targets, …). An easing function
      // is later called with a number each frame; those calls are passed through untouched.
      const index = args[1];
      if (typeof args[0] !== "number" && typeof index === "number") {
        let byIndex = values.get(key);
        if (!byIndex) values.set(key, (byIndex = new Map()));
        if (byIndex.has(index) && byIndex.get(index) !== result) unstable.add(key);
        else byIndex.set(index, result);
      }
      return result;
    };
  }

  get(key: string, index: number): unknown {
    return this.values.get(key)?.get(index);
  }
}

/** Copies parameters, wrapping function-based timing values with recorders. Nothing else changes. */
function instrumentParams(
  params: Record<string, unknown>,
  recorder: Recorder,
  defaults: Record<string, unknown> | null,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...params };
  for (const field of TIMING_FIELDS) {
    const value = out[field] ?? (defaults ? defaults[field] : undefined);
    if (typeof value === "function")
      out[field] = recorder.wrap(field, value as (...a: unknown[]) => unknown);
  }
  for (const key of Object.keys(params)) {
    if (RESERVED.has(key)) continue;
    const value = params[key];
    if (!isPlainObject(value)) continue;
    let copy: Record<string, unknown> | null = null;
    for (const field of TIMING_FIELDS) {
      if (typeof value[field] === "function") {
        copy ??= { ...value };
        copy[field] = recorder.wrap(
          `${key}.${field}`,
          value[field] as (...a: unknown[]) => unknown,
        );
      }
    }
    if (copy) out[key] = copy;
  }
  return out;
}

interface Context {
  eases: EasesLike | undefined;
  defaults: Record<string, unknown>;
  defaultsKnown: boolean;
}

function easeInfo(value: unknown, ctx: Context): EaseInfo {
  if (typeof value === "string") {
    const fn = resolveEaseName(value, ctx.eases);
    const samples = fn ? sampleEase(fn) : null;
    return samples
      ? { value: value.trim(), kind: "animejs", samples, source: "exact" }
      : { value: value.trim(), kind: "unknown", samples: null, source: null };
  }
  if (typeof value === "function") {
    // A custom easing function: its behavior is sampled; no name is invented for it.
    const samples = sampleEase(value as EasingFunction);
    return { value: "custom", kind: "custom", samples, source: samples ? "sampled" : null };
  }
  if (isPlainObject(value) || (typeof value === "object" && value !== null)) {
    const spring = value as { ease?: unknown; settlingDuration?: unknown };
    if (typeof spring.ease === "function") {
      const samples = sampleEase(spring.ease as EasingFunction);
      return {
        value: "spring",
        kind: "animejs",
        samples,
        source: samples ? "exact" : null,
        ...(typeof spring.settlingDuration === "number"
          ? { duration: spring.settlingDuration }
          : {}),
      };
    }
  }
  return { value: "unknown", kind: "unknown", samples: null, source: null };
}

/**
 * Per-target tracks of one animation, grouping properties that share delay, duration and ease.
 * Function values are read from the recorder (what Anime.js actually received).
 */
function buildTracks(
  instance: AnimeAnimationLike,
  params: Record<string, unknown>,
  recorder: Recorder,
  ctx: Context,
  /** Index of this instance's first target in the call that created it (stagger positions). */
  indexBase = 0,
): { tracks: Track[]; notes: string[] } {
  const notes: string[] = [];
  const targets = Array.isArray(instance.targets) ? instance.targets : [];
  const props = Object.keys(params).filter((k) => !RESERVED.has(k));
  if (params.keyframes)
    notes.push(
      "Uses `keyframes`: properties are recorded with the animation's overall timing; per-keyframe timing is not reconstructed.",
    );
  if (params.composition === "blend")
    notes.push(
      "composition: 'blend' is rendered by Anime.js's engine loop and cannot be replayed.",
    );
  for (const key of recorder.unstable)
    notes.push(
      `\`${key}\` returned different values for the same target (e.g. an unseeded random stagger); the first value is recorded.`,
    );
  const playbackEase = params.playbackEase;
  const tracks: Track[] = [];
  targets.forEach((target, targetIndex) => {
    const groups = new Map<string, Track>();
    for (const prop of props.length ? props : ["(keyframes)"]) {
      const value = params[prop];
      const local = isPlainObject(value) ? value : null;
      if (Array.isArray(value) && value.some(isPlainObject))
        notes.push(`Property \`${prop}\` uses keyframes; its timing is summarized.`);
      const provenance: Record<string, ProvenanceValue> = {};
      const resolve = (field: TimingField): unknown => {
        const own = local && field in local;
        const raw = own ? local![field] : params[field];
        const recordKey = own ? `${prop}.${field}` : field;
        if (raw === undefined) {
          if (field === "ease" && playbackEase !== undefined) {
            provenance[field] = "declared";
            return "linear";
          }
          const fallback = ctx.defaults[field];
          provenance[field] = ctx.defaultsKnown ? "declared" : "inferred";
          if (typeof fallback === "function") {
            const recorded = recorder.get(recordKey, indexBase + targetIndex);
            provenance[field] = recorded === undefined ? "unavailable" : "observed";
            return recorded;
          }
          return fallback;
        }
        if (typeof raw === "function") {
          const recorded = recorder.get(recordKey, indexBase + targetIndex);
          if (field === "ease" && recorded === undefined) {
            provenance[field] = "declared";
            return raw; // a plain easing function
          }
          provenance[field] = recorded === undefined ? "unavailable" : "observed";
          // An ease FunctionValue may return a non-ease (then Anime.js uses the function itself).
          if (field === "ease" && typeof recorded !== "string" && typeof recorded !== "function")
            return raw;
          return recorded;
        }
        provenance[field] = "declared";
        return raw;
      };
      const ease = easeInfo(resolve("ease"), ctx);
      const delayValue = Number(resolve("delay"));
      const durationValue = ease.duration ?? Number(resolve("duration"));
      if (ease.duration !== undefined) provenance.duration = "declared";
      const delay = Number.isFinite(delayValue) ? delayValue : 0;
      const duration = Number.isFinite(durationValue) ? durationValue : instance.iterationDuration;
      if (!Number.isFinite(delayValue)) provenance.delay = "unavailable";
      if (!Number.isFinite(durationValue)) provenance.duration = "inferred";
      const sampled = prop === "(keyframes)" ? null : sampledProperty(target, prop);
      const key = `${delay}|${duration}|${ease.value}|${ease.samples?.join(",") ?? ""}`;
      let track = groups.get(key);
      if (!track) {
        track = {
          targetIndex,
          target: isElement(target) ? target : null,
          properties: [],
          delay,
          duration,
          ease,
          provenance: { ...provenance },
          notes: [],
        };
        groups.set(key, track);
      }
      if (sampled && !track.properties.includes(sampled)) track.properties.push(sampled);
    }
    tracks.push(...groups.values());
  });
  // Non-staggered animations: the engine's own iteration duration is exact for single tracks.
  if (tracks.length === 1 && !params.keyframes) {
    const only = tracks[0]!;
    if (
      Math.abs(only.duration - instance.iterationDuration) > 0.5 &&
      only.provenance.duration !== "declared"
    ) {
      only.duration = instance.iterationDuration;
      only.provenance.duration = "declared";
    }
  }
  return { tracks, notes: [...new Set(notes)] };
}

// ---------------------------------------------------------------------------------------------
// Observation: page clock ↔ Anime.js time
// ---------------------------------------------------------------------------------------------

interface Observation {
  perf: number;
  time: number;
}

interface Mapping {
  /** performance.now() at which `currentTime` was 0 (end of the instance's own delay). */
  activeZero: number;
  /** Instance ms advanced per page ms (negative inside a timeline playing backwards). */
  rate: number;
  estimated: boolean;
}

/** Effective speed of an instance: its own speed times every ancestor's. */
function chainSpeed(instance: AnimeTickableLike, engineSpeed: number): number {
  let rate = engineSpeed;
  let current: AnimeTickableLike | null = instance;
  while (current) {
    rate *= current.speed || 1;
    current = current.parent;
  }
  return rate;
}

function estimateMapping(
  observations: readonly Observation[],
  declaredRate: number,
): Mapping | null {
  if (!observations.length) return null;
  // Use the latest continuous segment (seek/restart/reverse shift the origin).
  let segment: Observation[] = [observations[0]!];
  for (let i = 1; i < observations.length; i++) {
    const prev = segment[segment.length - 1]!;
    const o = observations[i]!;
    const dt = o.perf - prev.perf;
    const expected = prev.time + dt * declaredRate;
    if (Math.abs(o.time - expected) > DISCONTINUITY_MS * Math.abs(declaredRate)) segment = [o];
    else segment.push(o);
  }
  let rate = declaredRate;
  let estimated = segment.length < 2;
  if (segment.length >= 2) {
    const a = segment[0]!;
    const b = segment[segment.length - 1]!;
    if (b.perf - a.perf >= 8) {
      const empirical = (b.time - a.time) / (b.perf - a.perf);
      if (Math.sign(empirical) !== Math.sign(declaredRate)) rate = -declaredRate;
      // Engine speed or playbackEase we cannot see: trust the measurement and say so.
      if (Math.abs(Math.abs(empirical) - Math.abs(declaredRate)) > 0.05 * Math.abs(declaredRate)) {
        rate = Math.round(empirical * 1e4) / 1e4;
        estimated = true;
      }
    }
  }
  // performance.now() is read slightly after Anime.js's frame time: the earliest origin is best.
  let activeZero = Number.POSITIVE_INFINITY;
  for (const o of segment) activeZero = Math.min(activeZero, o.perf - o.time / rate);
  return { activeZero, rate, estimated };
}

// ---------------------------------------------------------------------------------------------
// Tracked instances
// ---------------------------------------------------------------------------------------------

interface Entry {
  uid: string;
  kind: "animation" | "timeline";
  instance: AnimeTickableLike | null;
  name: string | null;
  params: Record<string, unknown> | null;
  recorder: Recorder;
  /** Defaults that applied when the instance was created. */
  defaults: Record<string, unknown>;
  defaultsKnown: boolean;
  tracks: Track[] | null;
  trackNotes: string[];
  observations: Observation[];
  observedWindow: number;
  parent: Entry | null;
  /** Timeline-local position (ms) of a child's local zero, when observed. */
  offset: number | null;
  /** Children added through a wrapped timeline (in add order). */
  children: Entry[];
  /** Group id shared by children created by one `add()` with a stagger position. */
  group: string | null;
  /** Target index of this instance within the `add()` call (stagger positions), else 0. */
  indexBase: number;
  createdWindow: number;
  createdAt: number;
  snapshot: { time: number; reversed: boolean; completed: boolean } | null;
  restore: (() => void) | null;
  notes: string[];
  /** The instrumentation handle that created this entry; `dispose()` releases its entries. */
  owner: symbol | null;
}

interface Saved {
  entry: Entry;
  time: number;
  paused: boolean;
  completed: boolean;
  began: boolean;
  cancelled: boolean;
}

function animeVersion(): string | null {
  const list = (globalThis as { AnimeJS?: { version?: string }[] }).AnimeJS;
  if (!Array.isArray(list) || !list.length) return null;
  const versions = [...new Set(list.map((v) => v?.version).filter(Boolean))] as string[];
  return versions.length ? versions.join(", ") : null;
}

class AnimeAdapter implements MotionprAdapter {
  readonly name = ADAPTER_ID;
  readonly protocol = PROTOCOL_VERSION;
  readonly supportedRange = SUPPORTED_ANIMEJS_RANGE;
  readonly capabilities = CAPABILITIES;
  readonly #options: AnimeInstrumentationOptions;
  readonly #roots = new Map<AnimeTickableLike | Entry, Entry>();
  readonly #byInstance = new WeakMap<object, Entry>();
  readonly #claims = new WeakMap<Animation, AdapterClaim>();
  readonly #diagnostics = new Map<string, AdapterDiagnostic>();
  #counter = 0;
  #window = 0;
  #windowOpenedAt = 0;
  #replay: Saved[] = [];
  #mappings = new Map<Entry, Mapping>();
  disposed = false;

  constructor(options: AnimeInstrumentationOptions) {
    this.#options = options;
  }

  get version(): string | undefined {
    return animeVersion() ?? undefined;
  }

  /** Closures over private members, for callbacks that must keep their own `this`. */
  #self() {
    return {
      observe: (entry: Entry, self: AnimeTickableLike) => this.#observe(entry, self),
      newEntry: (
        kind: Entry["kind"],
        params: Record<string, unknown> | null,
        defaults: Record<string, unknown> | null,
        parent: Entry | null,
      ) => this.#newEntry(kind, params, defaults, parent),
      childParams: (entry: Entry, params: Record<string, unknown>, tl: AnimeTimelineLike) =>
        this.#childParams(entry, params, tl),
      diagnose: (code: string, message: string) => this.#diagnose(code, message),
      isDisposed: () => this.disposed,
    };
  }

  #diagnose(code: string, message: string, level: AdapterDiagnostic["level"] = "warning"): void {
    if (!this.#diagnostics.has(code)) this.#diagnostics.set(code, { level, code, message });
  }

  diagnostics(): AdapterDiagnostic[] {
    const out = [...this.#diagnostics.values()];
    if (!this.version)
      out.push({
        level: "info",
        code: "ANIMEJS_VERSION_UNKNOWN",
        message:
          "Anime.js did not publish its version on window.AnimeJS; support status is unknown.",
      });
    return out;
  }

  #context(defaults: Record<string, unknown> | null): Context {
    const engineDefaults = this.#options.engine?.defaults;
    return {
      eases: this.#options.eases,
      defaults: defaults ?? engineDefaults ?? { ...BUILTIN_DEFAULTS },
      defaultsKnown: Boolean(defaults ?? engineDefaults),
    };
  }

  #newEntry(
    kind: Entry["kind"],
    params: Record<string, unknown> | null,
    defaults: Record<string, unknown> | null,
    parent: Entry | null,
  ): Entry {
    const ctx = this.#context(defaults);
    return {
      uid: `${kind === "timeline" ? "t" : "a"}${++this.#counter}`,
      kind,
      instance: null,
      name: params && typeof params.id === "string" ? params.id : null,
      params,
      recorder: new Recorder(),
      defaults: ctx.defaults,
      defaultsKnown: ctx.defaultsKnown,
      tracks: null,
      trackNotes: [],
      observations: [],
      observedWindow: -1,
      parent,
      offset: null,
      children: [],
      group: null,
      indexBase: 0,
      createdWindow: this.#window,
      createdAt: performance.now(),
      snapshot: null,
      restore: null,
      notes: [],
      owner: null,
    };
  }

  #addRoot(entry: Entry): void {
    this.#roots.set(entry, entry);
    if (this.#roots.size > MAX_ROOTS) {
      for (const [key, state] of this.#roots) {
        if (state.createdWindow < this.#window) {
          state.restore?.();
          this.#roots.delete(key);
        }
        if (this.#roots.size <= MAX_ROOTS * 0.75) break;
      }
    }
  }

  /** Records one observation; called from composed callbacks (never throws). */
  #observe(entry: Entry, self: AnimeTickableLike): void {
    try {
      if (this.disposed) return;
      if (!entry.instance) {
        entry.instance = self;
        this.#byInstance.set(self, entry);
      }
      const time = self.currentTime;
      const duration = self.duration;
      if (!(time > 0) || !(time < duration)) return;
      if (entry.observedWindow !== this.#window) {
        entry.observations = [];
        entry.observedWindow = this.#window;
      }
      if (entry.observations.length >= MAX_OBSERVATIONS) entry.observations.splice(1, 1);
      entry.observations.push({ perf: performance.now(), time });
      if (entry.parent?.instance && entry.offset === null) {
        // Child local zero in the timeline's (eased) iteration time.
        const tl = entry.parent.instance;
        const delay = this.#minDelay(entry);
        entry.offset = tl.iterationCurrentTime - (time + delay) / (self.speed || 1);
      }
    } catch (error) {
      this.#diagnose(
        "ANIMEJS_OBSERVE_FAILED",
        `Observing an Anime.js instance failed: ${String(error)}`,
      );
    }
  }

  /**
   * Composes MotionPR's observer with the instance's `onUpdate`. The developer's callback runs
   * with the same `this`, arguments and return value; assigning `onUpdate` later replaces only
   * the developer's part. Restored by `dispose()`.
   */
  #patch(entry: Entry, instance: AnimeTickableLike): void {
    if (entry.restore) return;
    const adapter = this.#self();
    let user = instance.onUpdate as unknown as ((self: unknown) => unknown) | undefined;
    const composed = function (this: unknown, self: AnimeTickableLike) {
      adapter.observe(entry, self);
      return typeof user === "function" ? user.call(this, self) : undefined;
    };
    try {
      Object.defineProperty(instance, "onUpdate", {
        configurable: true,
        enumerable: true,
        get: () => composed,
        set: (fn: (self: unknown) => unknown) => {
          user = fn;
        },
      });
      entry.restore = () => {
        Object.defineProperty(instance, "onUpdate", {
          configurable: true,
          enumerable: true,
          writable: true,
          value: user,
        });
      };
    } catch (error) {
      this.#diagnose(
        "ANIMEJS_PATCH_FAILED",
        `Could not observe an Anime.js instance (onUpdate is not configurable): ${String(error)}`,
      );
    }
  }

  /** Parameters for a timeline child: composed onUpdate (with the timeline defaults' fallback). */
  #childParams(
    entry: Entry,
    params: Record<string, unknown>,
    tl: AnimeTimelineLike,
  ): Record<string, unknown> {
    const out = instrumentParams(params, entry.recorder, tl.defaults ?? null);
    const adapter = this.#self();
    const user = params.onUpdate ?? tl.defaults?.onUpdate;
    out.onUpdate = function (this: unknown, self: AnimeTickableLike) {
      adapter.observe(entry, self);
      return typeof user === "function"
        ? (user as (s: unknown) => unknown).call(this, self)
        : undefined;
    };
    return out;
  }

  trackAnimation(
    instance: AnimeAnimationLike,
    params: Record<string, unknown> | null,
    name?: string,
    recorder?: Recorder,
    owner: symbol | null = null,
  ): void {
    if (this.disposed || !instance || typeof instance.seek !== "function") return;
    const known = this.#byInstance.get(instance);
    if (known) {
      if (name) known.name = name;
      return;
    }
    const entry = this.#newEntry("animation", params, null, null);
    entry.owner = owner;
    if (recorder) entry.recorder = recorder;
    if (name) entry.name = name;
    entry.instance = instance;
    this.#byInstance.set(instance, entry);
    if (params) {
      const built = buildTracks(instance, params, entry.recorder, this.#context(null));
      entry.tracks = built.tracks;
      entry.trackNotes = built.notes;
    } else {
      entry.notes.push(
        "Tracked without a wrapper: properties and per-target timing are not public in Anime.js.",
      );
    }
    this.#patch(entry, instance);
    this.#addRoot(entry);
  }

  trackTimeline(
    instance: AnimeTimelineLike,
    params: Record<string, unknown> | null,
    name?: string,
    owner: symbol | null = null,
  ): void {
    if (this.disposed || !instance || typeof instance.add !== "function") return;
    const known = this.#byInstance.get(instance);
    if (known) {
      if (name) known.name = name;
      return;
    }
    const entry = this.#newEntry("timeline", params, null, null);
    entry.owner = owner;
    if (name) entry.name = name;
    entry.instance = instance;
    this.#byInstance.set(instance, entry);
    this.#patch(entry, instance);
    this.#wrapAdd(entry, instance);
    this.#addRoot(entry);
  }

  #wrapAdd(entry: Entry, tl: AnimeTimelineLike): void {
    const adapter = this.#self();
    const original = tl.add;
    const previousRestore = entry.restore;
    const wrappedAdd = function (this: AnimeTimelineLike, ...args: unknown[]) {
      if (adapter.isDisposed() || args.length < 2 || !isPlainObject(args[1]))
        return original.apply(this, args);
      // add(targets, parameters, position): an animation child.
      const params = args[1] as Record<string, unknown>;
      const child = adapter.newEntry("animation", params, tl.defaults ?? null, entry);
      const staggeredPosition = typeof args[2] === "function";
      if (staggeredPosition) child.group = `animejs:${child.uid}`;
      let patched: Record<string, unknown>;
      try {
        patched = adapter.childParams(child, params, tl);
      } catch (error) {
        adapter.diagnose(
          "ANIMEJS_PARAMS_FAILED",
          `Could not instrument timeline parameters: ${String(error)}`,
        );
        return original.apply(this, args);
      }
      entry.children.push(child);
      if (staggeredPosition) {
        // A stagger position creates one child per target. Each child is matched to its target
        // index (Anime.js evaluates function values with that index) on its first frame.
        const targets = resolveTargets(args[0]);
        const perTarget = new Map<unknown, Entry>();
        const user = params.onUpdate ?? tl.defaults?.onUpdate;
        patched.onUpdate = function (this: unknown, self: AnimeAnimationLike) {
          let own = perTarget.get(self);
          if (!own) {
            own =
              perTarget.size === 0
                ? child
                : adapter.newEntry("animation", params, tl.defaults ?? null, entry);
            own.group = child.group;
            own.recorder = child.recorder;
            const index = targets.indexOf(
              Array.isArray(self.targets) ? self.targets[0] : undefined,
            );
            own.indexBase = index === -1 ? perTarget.size : index;
            perTarget.set(self, own);
            if (own !== child) entry.children.push(own);
          }
          adapter.observe(own, self);
          return typeof user === "function"
            ? (user as (s: unknown) => unknown).call(this, self)
            : undefined;
        };
      }
      return original.call(this, args[0], patched, ...args.slice(2));
    };
    tl.add = wrappedAdd;
    entry.restore = () => {
      if (tl.add === wrappedAdd) tl.add = original;
      previousRestore?.();
    };
  }

  claimWaapi(result: AnimeWaapiAnimationLike, params: Record<string, unknown> | null): void {
    if (this.disposed || !result || !Array.isArray(result.animations)) return;
    const uid = `w${++this.#counter}`;
    const id = params && typeof params.id === "string" ? params.id : null;
    const multi = result.animations.length > 1;
    for (const animation of result.animations) {
      this.#claims.set(animation, {
        name: id,
        group: multi ? `animejs-waapi:${uid}` : null,
        meta: { engine: "animejs", api: "waapi" },
        provenance: {
          duration: "declared",
          delay: "declared",
          easing: "declared",
          startTime: "observed",
        },
      });
    }
  }

  claims(animation: Animation): AdapterClaim | null {
    return this.#claims.get(animation) ?? null;
  }

  #minDelay(entry: Entry): number {
    if (!entry.tracks || !entry.tracks.length) return 0;
    return Math.min(...entry.tracks.map((t) => t.delay));
  }

  #ensureTracks(entry: Entry): void {
    if (entry.tracks || !entry.params || !entry.instance) return;
    try {
      const ctx: Context = {
        eases: this.#options.eases,
        defaults: entry.defaults,
        defaultsKnown: entry.defaultsKnown,
      };
      const built = buildTracks(
        entry.instance as AnimeAnimationLike,
        entry.params,
        entry.recorder,
        ctx,
        entry.indexBase,
      );
      entry.tracks = built.tracks;
      entry.trackNotes = built.notes;
    } catch (error) {
      entry.tracks = [];
      this.#diagnose(
        "ANIMEJS_TRACKS_FAILED",
        `Could not read animation parameters: ${String(error)}`,
      );
    }
  }

  beginWindow(): void {
    this.#window++;
    this.#windowOpenedAt = performance.now();
    for (const entry of this.#roots.values()) {
      const i = entry.instance;
      entry.snapshot = i
        ? { time: i.currentTime, reversed: i.reversed, completed: i.completed }
        : null;
    }
  }

  #ranThisWindow(entry: Entry): boolean {
    const i = entry.instance;
    if (!i) return false;
    if (entry.observedWindow === this.#window) return true;
    if (!i.paused && i.began && !i.completed) return true;
    if (entry.snapshot)
      return (
        Math.abs(i.currentTime - entry.snapshot.time) > 1e-6 ||
        i.reversed !== entry.snapshot.reversed
      );
    return entry.createdAt >= this.#windowOpenedAt && i.began;
  }

  #mapping(entry: Entry): Mapping | null {
    const i = entry.instance;
    if (!i) return null;
    return estimateMapping(entry.observations, chainSpeed(i, this.#options.engine?.speed ?? 1));
  }

  #direction(i: AnimeTickableLike, params: Record<string, unknown> | null): PlaybackDirection {
    const alternate = params?.alternate === true;
    const reversed = i.reversed;
    return alternate
      ? reversed
        ? "alternate-reverse"
        : "alternate"
      : reversed
        ? "reverse"
        : "normal";
  }

  #playState(i: AnimeTickableLike): PlayStateValue {
    return i.completed ? "finished" : i.paused ? (i.began ? "paused" : "idle") : "running";
  }

  collect(): AdapterAnimation[] {
    const out: AdapterAnimation[] = [];
    const mappings = new Map<Entry, Mapping>();
    for (const root of this.#roots.values()) {
      if (!this.#ranThisWindow(root)) continue;
      const rootMapping = this.#mapping(root);
      if (rootMapping) mappings.set(root, rootMapping);
      const animations = root.kind === "timeline" ? root.children : [root];
      for (const entry of animations) {
        if (root.kind === "timeline" && entry.observedWindow !== this.#window) continue;
        try {
          out.push(
            ...this.#records(
              entry,
              root,
              root.kind === "timeline" ? this.#mapping(entry) : rootMapping,
            ),
          );
        } catch (error) {
          this.#diagnose(
            "ANIMEJS_COLLECT_FAILED",
            `Could not record an Anime.js animation: ${String(error)}`,
          );
        }
      }
    }
    this.#mappings = mappings;
    return out;
  }

  #records(entry: Entry, root: Entry, mapping: Mapping | null): AdapterAnimation[] {
    const i = entry.instance as AnimeAnimationLike | null;
    if (!i) return [];
    this.#ensureTracks(entry);
    const tracks: Track[] = entry.tracks?.length
      ? entry.tracks
      : (Array.isArray(i.targets) ? i.targets : [null]).map((target, targetIndex) => ({
          targetIndex,
          target: isElement(target) ? target : null,
          properties: [],
          delay: 0,
          duration: i.iterationDuration,
          ease: { value: "unknown", kind: "unknown", samples: null, source: null },
          provenance: {
            duration: "declared",
            delay: "unavailable",
            easing: "unavailable",
            properties: "unavailable",
          },
          notes: [],
        }));
    const minDelay = Math.min(...tracks.map((t) => t.delay));
    const rate = mapping?.rate ?? chainSpeed(i, this.#options.engine?.speed ?? 1);
    const localZero = mapping ? mapping.activeZero - minDelay / rate : null;
    const iterations = i.iterationCount;
    const infinite = !Number.isFinite(iterations);
    const loopDelay = Number(entry.params?.loopDelay ?? 0) || 0;
    const period = i.iterationDuration + loopDelay;
    const staggered =
      new Set(tracks.map((t) => `${t.delay}|${t.duration}`)).size > 1 || tracks.length > 1;
    const group = entry.group ?? (staggered && tracks.length > 1 ? `animejs:${entry.uid}` : null);
    const tlName = root.kind === "timeline" ? root.name : null;
    const label = root.kind === "timeline" ? this.#labelAt(root, entry.offset) : null;
    const name = entry.name ?? ([tlName, label].filter(Boolean).join("@") || tlName || null);
    const blend = entry.params?.composition === "blend";
    const notes = [...entry.notes, ...entry.trackNotes];
    if (!mapping)
      notes.push("Start time unknown: no frame of this animation was observed in the window.");
    else if (mapping.estimated)
      notes.push("Start time and speed estimated from too few, or eased, frame observations.");
    if (root.kind === "timeline" && root.params?.playbackEase)
      notes.push("The timeline uses playbackEase: child start times assume linear timeline time.");
    return tracks.map((t): AdapterAnimation => {
      const elementNotes = t.target ? [] : ["Target is not a DOM element; timing only."];
      const props = t.properties.join(",") || "timing";
      return {
        id: `${entry.uid}:${t.targetIndex}:${props}`,
        ...(t.target
          ? {}
          : {
              objectKey: `${name ?? "object"}:${props.replace(/prop:/g, "")}#${t.targetIndex + entry.indexBase}`,
            }),
        name,
        target: t.target,
        startTime: localZero,
        duration: t.duration,
        delay: t.delay,
        iterations: infinite ? Number.POSITIVE_INFINITY : iterations,
        activeDuration: infinite
          ? null
          : (iterations - 1) * period + (t.delay - minDelay) + t.duration - (t.delay - minDelay),
        direction: this.#direction(i, entry.params),
        playbackRate: Math.round(rate * 1e6) / 1e6,
        easing: { value: t.ease.value, ...(t.ease.samples ? { samples: t.ease.samples } : {}) },
        easingKind: t.ease.kind,
        ...(t.ease.source ? { easingSamplesSource: t.ease.source } : {}),
        properties: t.properties.filter((p) => !p.startsWith("prop:") || !t.target).sort(),
        playState: this.#playState(i),
        group,
        parent: root.kind === "timeline" ? root.uid : null,
        type: "animejs",
        driver: "javascript",
        provenance: {
          ...t.provenance,
          startTime: mapping ? (mapping.estimated ? "inferred" : "observed") : "unavailable",
          playbackRate: mapping && !mapping.estimated ? "observed" : "declared",
          iterations: "declared",
        },
        timeline: "adapter",
        meta: {
          root: root.name ?? root.uid,
          ...(label ? { label } : {}),
          ...(loopDelay ? { loopDelay } : {}),
          ...(group ? { staggered: true } : {}),
          ...(i.reversed ? { reversed: true } : {}),
          ...(entry.params?.playbackEase !== undefined
            ? {
                playbackEase:
                  typeof entry.params.playbackEase === "string"
                    ? entry.params.playbackEase
                    : "custom",
              }
            : {}),
          ...(typeof i.id === "string" ? { animeId: i.id } : {}),
        } satisfies Record<string, MetaValue>,
        notes: [...notes, ...t.notes, ...elementNotes],
        samplable: t.target !== null && mapping !== null && !blend,
      };
    });
  }

  #labelAt(root: Entry, offset: number | null): string | null {
    const labels = (root.instance as AnimeTimelineLike | null)?.labels;
    if (!labels || offset === null) return null;
    let best: string | null = null;
    let bestTime = Number.NEGATIVE_INFINITY;
    for (const [name, time] of Object.entries(labels)) {
      if (time <= offset + 0.5 && time > bestTime) {
        best = name;
        bestTime = time;
      }
    }
    return best;
  }

  collectTimelines(): AdapterTimeline[] {
    const out: AdapterTimeline[] = [];
    for (const root of this.#roots.values()) {
      if (root.kind !== "timeline" || !this.#ranThisWindow(root)) continue;
      const tl = root.instance as AnimeTimelineLike | null;
      if (!tl) continue;
      const mapping = this.#mappings.get(root) ?? this.#mapping(root);
      const delay = Number(root.params?.delay ?? 0) || 0;
      out.push({
        id: root.uid,
        name: root.name,
        startTime: mapping ? mapping.activeZero - delay / mapping.rate : null,
        duration: tl.iterationDuration,
        iterations: tl.iterationCount,
        direction: this.#direction(tl, root.params),
        playbackRate: tl.speed,
        playState: this.#playState(tl),
        progress: Math.round(tl.progress * 1e4) / 1e4,
        labels: Object.entries(tl.labels ?? {}).map(([name, time]) => ({ name, time })),
        provenance: {
          duration: "declared",
          labels: "declared",
          startTime: mapping ? "observed" : "unavailable",
          children: "observed",
        },
        notes: [
          ...root.notes,
          ...(root.params?.playbackEase
            ? ["Timeline playbackEase is applied to child timing."]
            : []),
        ],
        meta: {
          children: root.children.length,
          ...(tl.reversed ? { reversed: true } : {}),
        },
      });
    }
    return out;
  }

  isAnimating(): boolean {
    for (const entry of this.#roots.values()) {
      const i = entry.instance;
      if (i && !i.paused && !i.completed && Number.isFinite(i.iterationCount)) return true;
    }
    return false;
  }

  beginReplay(): void {
    this.#replay = [];
    const save = (entry: Entry) => {
      const i = entry.instance!;
      this.#replay.push({
        entry,
        time: i.currentTime,
        paused: i.paused,
        completed: i.completed,
        began: i.began,
        cancelled: i.cancelled,
      });
      // Assigning `paused` (not calling pause()) keeps onPause from firing.
      i.paused = true;
    };
    for (const entry of this.#mappings.keys()) if (entry.instance) save(entry);
    // Freeze other running roots so frames stay deterministic.
    for (const entry of this.#roots.values()) {
      const i = entry.instance;
      if (!i || this.#mappings.has(entry) || i.paused || i.completed) continue;
      save(entry);
    }
  }

  seek(timeMs: number): void {
    for (const [entry, mapping] of this.#mappings) {
      const i = entry.instance;
      if (!i) continue;
      const delay =
        entry.kind === "timeline" ? Number(entry.params?.delay ?? 0) || 0 : this.#minDelay(entry);
      const local = (timeMs - mapping.activeZero) * mapping.rate;
      i.seek(Math.min(Math.max(local, -delay), i.duration), true);
    }
  }

  endReplay(): void {
    for (const s of this.#replay.reverse()) {
      const i = s.entry.instance!;
      try {
        i.seek(s.time, true);
        i.completed = s.completed;
        i.began = s.began;
        if (s.cancelled && !i.cancelled) i.cancel();
        if (!s.paused) i.resume();
      } catch (error) {
        this.#diagnose(
          "ANIMEJS_RESTORE_FAILED",
          `Could not restore an Anime.js instance after replay: ${String(error)}`,
          "error",
        );
      }
    }
    this.#replay = [];
  }

  /** Restores and forgets the entries created through one instrumentation handle. */
  release(owner: symbol): void {
    for (const [key, entry] of this.#roots) {
      if (entry.owner !== owner) continue;
      entry.restore?.();
      entry.restore = null;
      this.#roots.delete(key);
      this.#mappings.delete(entry);
      if (entry.instance) this.#byInstance.delete(entry.instance);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const entry of this.#roots.values()) entry.restore?.();
    this.#roots.clear();
    this.#mappings.clear();
    this.#replay = [];
  }
}

// ---------------------------------------------------------------------------------------------
// Public instrumentation
// ---------------------------------------------------------------------------------------------

function agent(): {
  registerAdapter(a: MotionprAdapter): void;
  unregisterAdapter?(a: MotionprAdapter): void;
} | null {
  if (typeof window === "undefined") return null;
  return (
    (
      window as unknown as Record<string, { registerAdapter(a: MotionprAdapter): void } | undefined>
    )[AGENT_GLOBAL] ?? null
  );
}

const INACTIVE: AnimeInstrumentation = Object.freeze({
  active: false,
  wrapAnimate: <F>(fn: F) => fn,
  wrapTimeline: <F>(fn: F) => fn,
  wrapWaapi: <F>(fn: F) => fn,
  track: <T>(instance: T) => instance,
  getDiagnostics: () => [],
  dispose: () => undefined,
}) as AnimeInstrumentation;

let shared: AnimeAdapter | null = null;
let refs = 0;

/**
 * Creates the Anime.js instrumentation. Call it once, before creating animations, and use the
 * wrapped functions in place of the originals:
 *
 * @example
 * import { animate, createTimeline, waapi, eases, stagger } from "animejs";
 * import { createAnimeInstrumentation } from "@erenthedeveloper0/motionpr/animejs";
 *
 * const motion = createAnimeInstrumentation({ eases });
 * const track = motion.wrapAnimate(animate);
 * track(".card", { y: [24, 0], opacity: [0, 1], delay: stagger(60), ease: "out(3)" });
 */
export function createAnimeInstrumentation(
  options: AnimeInstrumentationOptions = {},
): AnimeInstrumentation {
  const page = agent();
  if (!page && !options.force) return INACTIVE;
  if (!shared || shared.disposed) {
    shared = new AnimeAdapter(options);
    refs = 0;
    page?.registerAdapter(shared);
  }
  const adapter = shared;
  refs++;
  let disposed = false;
  const owner = Symbol("motionpr-animejs-handle");
  const live = () => !disposed && !adapter.disposed;

  const handle: AnimeInstrumentation = {
    get active() {
      return live();
    },
    wrapAnimate<F extends AnimateLike>(animate: F): F {
      if (typeof animate !== "function")
        throw new TypeError("wrapAnimate() expects Anime.js's animate function.");
      const wrapped = function (
        this: unknown,
        targets: unknown,
        params: unknown,
        ...rest: unknown[]
      ) {
        if (!live() || !isPlainObject(params))
          return (animate as unknown as (...a: unknown[]) => unknown).call(
            this,
            targets,
            params,
            ...rest,
          );
        let patched: Record<string, unknown>;
        let recorder: Recorder | null = null;
        try {
          recorder = new Recorder();
          patched = instrumentParams(params, recorder, null);
        } catch {
          patched = params;
        }
        const instance = (animate as unknown as (...a: unknown[]) => AnimeAnimationLike).call(
          this,
          targets,
          patched,
          ...rest,
        );
        try {
          adapter.trackAnimation(instance, params, undefined, recorder ?? undefined, owner);
        } catch {
          // observation must never break the animation
        }
        return instance;
      };
      return wrapped as unknown as F;
    },
    wrapTimeline<F extends CreateTimelineLike>(createTimeline: F): F {
      if (typeof createTimeline !== "function")
        throw new TypeError("wrapTimeline() expects Anime.js's createTimeline function.");
      const wrapped = function (this: unknown, params?: unknown, ...rest: unknown[]) {
        const instance = (createTimeline as unknown as (...a: unknown[]) => AnimeTimelineLike).call(
          this,
          params,
          ...rest,
        );
        if (live()) {
          try {
            adapter.trackTimeline(
              instance,
              isPlainObject(params) ? params : null,
              undefined,
              owner,
            );
          } catch {
            // observation must never break the timeline
          }
        }
        return instance;
      };
      return wrapped as unknown as F;
    },
    wrapWaapi<F extends WaapiAnimateLike>(waapiAnimate: F): F {
      if (typeof waapiAnimate !== "function")
        throw new TypeError("wrapWaapi() expects Anime.js's waapi.animate function.");
      const wrapped = function (this: unknown, ...args: unknown[]) {
        const result = (
          waapiAnimate as unknown as (...a: unknown[]) => AnimeWaapiAnimationLike
        ).apply(this, args);
        if (live()) {
          try {
            adapter.claimWaapi(result, isPlainObject(args[1]) ? args[1] : null);
          } catch {
            // observation must never break the animation
          }
        }
        return result;
      };
      return wrapped as unknown as F;
    },
    track<T extends object>(instance: T, name?: string): T {
      if (!live()) return instance;
      const i = instance as unknown as AnimeTimelineLike;
      if (typeof i.add === "function") adapter.trackTimeline(i, null, name, owner);
      else
        adapter.trackAnimation(
          instance as unknown as AnimeAnimationLike,
          null,
          name,
          undefined,
          owner,
        );
      return instance;
    },
    getDiagnostics: () => (live() ? adapter.diagnostics() : []),
    dispose() {
      if (disposed) return;
      disposed = true;
      adapter.release(owner);
      if (--refs > 0) return;
      adapter.dispose();
      agent()?.unregisterAdapter?.(adapter);
      if (shared === adapter) shared = null;
    },
  };
  return handle;
}

export default createAnimeInstrumentation;
