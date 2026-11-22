/**
 * MotionPR adapter for GSAP 3 (`@erenthedeveloper0/motionpr/gsap`).
 *
 * GSAP animates by writing inline styles from its own ticker, so `document.getAnimations()`
 * cannot see it. This adapter observes GSAP from inside the page:
 *
 * - `register(gsap)` wraps `gsap.to/from/fromTo/timeline` to learn about root animations, and
 *   picks up roots that already exist on the global timeline.
 * - On each MotionPR checkpoint it reports every leaf tween × target that ran in the window,
 *   with GSAP's own timing (duration, delay, repeat, yoyo, timeScale, reversed) and its ease
 *   sampled from GSAP's ease function.
 * - For deterministic replay it pauses the root animations and renders them at exact times with
 *   `totalTime(t, true)` (events suppressed), then restores their state.
 * - ScrollTrigger animations follow scroll, so they have no time origin. Their progress is
 *   observed live on GSAP's ticker; for sampling they are rendered at the progress the scroll
 *   reached (`seekProgress`), and time-based seeks show the progress observed at that time.
 *   Where they run in the scroll is read from ScrollTrigger itself (`scrollLink`: the `start`
 *   and `end` it resolved, `scrub`, `toggleActions`), which does not depend on scroll timing.
 *
 * Outside a MotionPR capture (no agent in the page) `register()` does nothing and costs nothing.
 */
import {
  AGENT_GLOBAL,
  PROTOCOL_VERSION,
  SUPPORTED_ENGINE_RANGES,
  type AdapterAnimation,
  type AdapterCapability,
  type AdapterDiagnostic,
  type AdapterScrollLink,
  type AdapterTimeline,
  type MotionprAdapter,
  type PlayStateValue,
} from "@motionpr/core/protocol";

/** GSAP versions this adapter is tested against. */
export const SUPPORTED_GSAP_RANGE: string = SUPPORTED_ENGINE_RANGES.gsap;
const CAPABILITIES: readonly AdapterCapability[] = [
  "animations",
  "timelines",
  "staggers",
  "replay",
];

/** Minimal structural view of the GSAP API used by the adapter (GSAP 3.12+). */
export interface GsapAnimationLike {
  vars: Record<string, unknown>;
  parent: GsapTimelineLike | null;
  startTime(): number;
  delay(): number;
  duration(): number;
  totalDuration(): number;
  totalTime(): number;
  totalTime(value: number, suppressEvents?: boolean): unknown;
  timeScale(): number;
  repeat(): number;
  repeatDelay(): number;
  yoyo(): boolean;
  reversed(): boolean;
  paused(): boolean;
  paused(value: boolean): unknown;
  isActive(): boolean;
  progress(): number;
  targets?(): unknown[];
  getChildren?(nested?: boolean, tweens?: boolean, timelines?: boolean): GsapAnimationLike[];
  labels?: Record<string, number>;
  /** Present on staggered/keyframed tweens (nested per-target timeline). */
  timeline?: GsapTimelineLike | 0;
  _ease?: (p: number) => number;
  /** The ScrollTrigger instance driving this animation (set by the ScrollTrigger plugin). */
  scrollTrigger?: GsapScrollTriggerLike | null;
}

/** The public, read-only part of a ScrollTrigger instance the adapter reads. */
export interface GsapScrollTriggerLike {
  /** Resolved scroll position (px) where progress is 0, recalculated on every refresh. */
  start: number;
  /** Resolved scroll position (px) where progress is 1. */
  end: number;
  scroller: Element | Window;
  vars: {
    scrub?: boolean | number;
    toggleActions?: string;
    horizontal?: boolean;
    containerAnimation?: unknown;
  };
}

export type GsapTimelineLike = GsapAnimationLike & {
  getChildren(nested?: boolean, tweens?: boolean, timelines?: boolean): GsapAnimationLike[];
};

export interface GsapLike {
  version?: string;
  to: (...args: never[]) => GsapAnimationLike;
  from: (...args: never[]) => GsapAnimationLike;
  fromTo: (...args: never[]) => GsapAnimationLike;
  timeline: (...args: never[]) => GsapTimelineLike;
  globalTimeline: GsapTimelineLike;
  ticker: {
    time: number;
    add(cb: (time: number) => void): unknown;
    remove?(cb: (time: number) => void): unknown;
  };
  parseEase(): Record<string, (p: number) => number>;
  parseEase(ease: string | ((p: number) => number)): (p: number) => number;
}

export interface RegisterOptions {
  /** Install even when no MotionPR agent is present (testing). */
  force?: boolean;
}

const RESERVED = new Set(
  "parent,duration,ease,delay,overwrite,runBackwards,startAt,yoyo,immediateRender,repeat,repeatDelay,data,paused,reversed,lazy,callbackScope,stringFilter,id,yoyoEase,stagger,inherit,repeatRefresh,keyframes,autoRevert,scrollTrigger,easeReverse,defaults,smoothChildTiming,autoRemoveChildren,onComplete,onCompleteParams,onStart,onStartParams,onUpdate,onUpdateParams,onRepeat,onRepeatParams,onReverseComplete,onReverseCompleteParams,onInterrupt,onInterruptParams,callbackScope,modifiers,snap,attr,motionPath,transformOrigin,svgOrigin,force3D,smoothOrigin".split(
    ",",
  ),
);
const TRANSFORM_KEYS = new Set(
  "x,y,z,xPercent,yPercent,rotation,rotate,rotationX,rotationY,rotationZ,rotateX,rotateY,rotateZ,scale,scaleX,scaleY,scaleZ,skewX,skewY,transform,transformPerspective".split(
    ",",
  ),
);
const PREFERRED_EASES = [
  "none",
  "power1",
  "power2",
  "power3",
  "power4",
  "sine",
  "expo",
  "circ",
  "back",
  "elastic",
  "bounce",
  "steps",
];
const SAMPLE_COUNT = 65;

const TOGGLE_ACTIONS = new Set([
  "play",
  "pause",
  "resume",
  "reset",
  "restart",
  "complete",
  "reverse",
  "none",
]);

/**
 * ScrollTrigger's `toggleActions` as four actions (enter, leave, enter back, leave back).
 * ScrollTrigger's default is `"play"`, the missing ones are `none`.
 */
function toggleActions(value: unknown): string {
  const actions = (typeof value === "string" ? value : "play").trim().split(/\s+/).slice(0, 4);
  while (actions.length < 4) actions.push("none");
  return actions.map((a) => (TOGGLE_ACTIONS.has(a) ? a : "none")).join(" ");
}

function kebab(prop: string): string {
  return prop.startsWith("--") ? prop : prop.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}

/** Maps GSAP vars to the CSS properties they ultimately animate. */
export function gsapProperties(vars: Record<string, unknown>): string[] {
  const out = new Set<string>();
  const visit = (obj: Record<string, unknown>) => {
    for (const key of Object.keys(obj)) {
      if (key === "css" && obj.css && typeof obj.css === "object") {
        visit(obj.css as Record<string, unknown>);
        continue;
      }
      if (key === "motionPath") {
        out.add("transform");
        continue;
      }
      if (key === "transformOrigin") {
        out.add("transform-origin");
        continue;
      }
      if (RESERVED.has(key) || key.startsWith("on")) continue;
      if (TRANSFORM_KEYS.has(key)) out.add("transform");
      else if (key === "autoAlpha") {
        out.add("opacity");
        out.add("visibility");
      } else out.add(kebab(key));
    }
  };
  visit(vars);
  return [...out].sort();
}

interface RootState {
  root: GsapAnimationLike;
  createdAt: number;
  createdWindow: number;
  snapshot: { totalTime: number; reversed: boolean } | null;
}

interface RootMapping {
  /** performance.now() of root local time zero (before delay). */
  zeroAbs: number;
  /** Root local seconds advanced per real millisecond, signed (negative when reversed). */
  ratePerMs: number;
  totalDuration: number;
  saved?: { paused: boolean; totalTime: number };
}

class GsapAdapter implements MotionprAdapter {
  readonly name = "gsap";
  readonly protocol = PROTOCOL_VERSION;
  readonly version: string;
  readonly supportedRange = SUPPORTED_GSAP_RANGE;
  readonly capabilities = CAPABILITIES;
  readonly #tick: (time: number) => void;
  readonly #scrollLinked = new Set<GsapAnimationLike>();
  /** Live progress of scroll-linked roots this window (performance clock), bounded. */
  #traces = new Map<GsapAnimationLike, { t: number; progress: number }[]>();
  /** Collected record id → its scroll-linked root, for `seekProgress`. */
  #scrollRoots = new Map<string, GsapAnimationLike>();
  readonly #gsap: GsapLike;
  readonly #roots = new Map<GsapAnimationLike, RootState>();
  readonly #names = new WeakMap<GsapAnimationLike, string>();
  readonly #ids = new WeakMap<GsapAnimationLike, string>();
  #idCounter = 0;
  #window = 0;
  #windowOpenedAt = 0;
  /** performance.now() − ticker.time × 1000, refreshed on every GSAP tick. */
  #clockOffset: number;
  #mappings = new Map<GsapAnimationLike, RootMapping>();
  #frozen: { root: GsapAnimationLike; paused: boolean; totalTime: number }[] = [];
  #easeNames: Map<(p: number) => number, string> | null = null;

  constructor(gsap: GsapLike) {
    this.#gsap = gsap;
    this.version = gsap.version ?? "unknown";
    this.#clockOffset = performance.now() - gsap.ticker.time * 1000;
    this.#tick = (time: number) => {
      const now = performance.now();
      this.#clockOffset = now - time * 1000;
      // ScrollTrigger animations cannot be replayed (their progress follows scroll), so their
      // progress is observed live on GSAP's own ticker. Only changes are stored.
      for (const root of this.#scrollLinked) {
        const progress = Math.round(root.progress() * 1e5) / 1e5;
        let trace = this.#traces.get(root);
        if (!trace) this.#traces.set(root, (trace = []));
        const last = trace[trace.length - 1];
        if (last && last.progress === progress) continue;
        if (trace.length >= 1200) trace.splice(1, 1);
        trace.push({ t: now, progress });
      }
    };
    gsap.ticker.add(this.#tick);
  }

  diagnostics(): AdapterDiagnostic[] {
    const out: AdapterDiagnostic[] = [];
    if (this.#scrollLinked.size)
      out.push({
        level: "info",
        code: "GSAP_SCROLLTRIGGER_OBSERVED",
        message: `${this.#scrollLinked.size} ScrollTrigger-driven animation(s): progress follows scroll, so MotionPR records it live, samples their values at the progress the scroll reached, and records the start and end positions ScrollTrigger resolved.`,
      });
    return out;
  }

  /** Stops observing: removes the ticker listener. GSAP itself is left untouched. */
  dispose(): void {
    this.#gsap.ticker.remove?.(this.#tick);
    this.#roots.clear();
    this.#mappings.clear();
    this.#scrollRoots.clear();
  }

  idOf(anim: GsapAnimationLike): string {
    let id = this.#ids.get(anim);
    if (!id) {
      id = `g${++this.#idCounter}`;
      this.#ids.set(anim, id);
    }
    return id;
  }

  name_(anim: GsapAnimationLike, name: string): void {
    this.#names.set(anim, name);
  }

  /** Records a root animation (or the top-most ancestor below the global timeline). */
  trackRoot(anim: GsapAnimationLike | null | undefined): void {
    if (!anim || typeof anim.totalTime !== "function") return;
    if (this.#roots.has(anim)) return;
    if (anim.vars?.scrollTrigger) this.#scrollLinked.add(anim);
    this.#roots.set(anim, {
      root: anim,
      createdAt: performance.now(),
      createdWindow: this.#window,
      snapshot: null,
    });
    if (this.#roots.size > 2000) {
      // Bound memory on long-lived pages: forget the oldest roots from past windows.
      for (const [key, state] of this.#roots) {
        if (state.createdWindow < this.#window) this.#roots.delete(key);
        if (this.#roots.size <= 1500) break;
      }
    }
  }

  #topRoot(anim: GsapAnimationLike): GsapAnimationLike {
    let current = anim;
    while (current.parent && current.parent !== this.#gsap.globalTimeline) current = current.parent;
    return current;
  }

  beginWindow(): void {
    this.#window++;
    this.#windowOpenedAt = performance.now();
    // Each trace starts from the progress at the window's start.
    this.#traces = new Map(
      [...this.#scrollLinked].map((root) => [
        root,
        [{ t: this.#windowOpenedAt, progress: Math.round(root.progress() * 1e5) / 1e5 }],
      ]),
    );
    for (const state of this.#roots.values()) {
      state.snapshot = { totalTime: state.root.totalTime(), reversed: state.root.reversed() };
    }
  }

  #ranThisWindow(state: RootState): boolean {
    const root = state.root;
    if (root.isActive()) return true;
    if (state.snapshot) {
      return (
        Math.abs(root.totalTime() - state.snapshot.totalTime) > 1e-6 ||
        root.reversed() !== state.snapshot.reversed
      );
    }
    return state.createdAt >= this.#windowOpenedAt && root.totalTime() > 0;
  }

  #windowRoots(): GsapAnimationLike[] {
    const roots = new Set<GsapAnimationLike>();
    for (const state of this.#roots.values()) {
      if (this.#smoothsScrollLinked(state.root)) continue;
      if (this.#ranThisWindow(state)) roots.add(this.#topRoot(state.root));
    }
    return [...roots];
  }

  /**
   * ScrollTrigger's `scrub: <seconds>` smoothing is a tween of the scroll-linked animation's
   * `totalProgress`. Its effect is that animation's recorded progress, not motion of its own, so
   * it is not reported (it is still tracked: settling waits for it and replay freezes it).
   */
  #smoothsScrollLinked(anim: GsapAnimationLike): boolean {
    const targets = typeof anim.targets === "function" ? anim.targets() : [];
    return (
      targets.length > 0 &&
      targets.every((t) => {
        const target = t as Partial<GsapAnimationLike> | null;
        return typeof target?.totalTime === "function" && Boolean(target.vars?.scrollTrigger);
      })
    );
  }

  #mapping(root: GsapAnimationLike): RootMapping {
    const ts = root.timeScale() || 1;
    const abs = Math.abs(ts);
    const tDur = root.totalDuration();
    const startSec = root.startTime();
    // Local zero sits at the root's start time (forward) or at the end of the reversed run.
    const zeroGlobalSec = root.reversed() ? startSec + tDur / abs : startSec;
    // startTime() already includes the root delay; local zero "before delay" is delay earlier.
    return {
      zeroAbs: this.#clockOffset + zeroGlobalSec * 1000,
      ratePerMs: (root.reversed() ? -abs : abs) / 1000,
      totalDuration: tDur,
    };
  }

  #easeName(fn: ((p: number) => number) | undefined, declared: unknown): string {
    if (typeof declared === "string") return declared;
    if (!fn) return "unknown";
    if (!this.#easeNames) {
      this.#easeNames = new Map();
      const map = this.#gsap.parseEase();
      const keys = Object.keys(map).sort((a, b) => {
        const rank = (k: string) => {
          const i = PREFERRED_EASES.indexOf(k.split(".")[0]!.toLowerCase());
          return i === -1 ? 99 : i;
        };
        return rank(a) - rank(b) || a.length - b.length || a.localeCompare(b);
      });
      for (const key of keys) {
        const f = map[key];
        if (f && !this.#easeNames.has(f)) this.#easeNames.set(f, key);
      }
    }
    return this.#easeNames.get(fn) ?? "custom";
  }

  #easeSamples(fn: ((p: number) => number) | undefined): number[] | undefined {
    if (!fn) return undefined;
    const out: number[] = [];
    for (let i = 0; i < SAMPLE_COUNT; i++)
      out.push(Math.round(fn(i / (SAMPLE_COUNT - 1)) * 1e6) / 1e6);
    return out;
  }

  /** Leaf tweens below `anim`, expanding the nested timelines GSAP builds for staggers and keyframes. */
  #leaves(
    anim: GsapAnimationLike,
    out: { tween: GsapAnimationLike; owner: GsapAnimationLike }[],
    owner: GsapAnimationLike | null = null,
  ): void {
    if (typeof anim.targets === "function") {
      const nested = anim.timeline;
      if (nested && typeof nested.getChildren === "function") {
        for (const child of nested.getChildren(false, true, true))
          this.#leaves(child, out, owner ?? anim);
        return;
      }
      out.push({ tween: anim, owner: owner ?? anim });
      return;
    }
    if (typeof anim.getChildren === "function") {
      for (const child of anim.getChildren(false, true, true)) this.#leaves(child, out, owner);
    }
  }

  /** Converts a leaf's local time to its root's local time (forward nesting chain). */
  #toRootLocal(
    leaf: GsapAnimationLike,
    root: GsapAnimationLike,
    local: number,
  ): { time: number; scale: number } {
    let time = local;
    let scale = 1;
    let current: GsapAnimationLike | null = leaf;
    while (current && current !== root) {
      const ts = Math.abs(current.timeScale() || 1);
      time = current.startTime() + time / ts;
      scale *= ts;
      current = current.parent;
    }
    return { time, scale };
  }

  #labelFor(leaf: GsapAnimationLike): string | null {
    const parent = leaf.parent;
    const labels = parent?.labels;
    if (!labels) return null;
    let best: string | null = null;
    let bestTime = Number.NEGATIVE_INFINITY;
    for (const [name, time] of Object.entries(labels)) {
      if (time <= leaf.startTime() + 1e-6 && time > bestTime) {
        best = name;
        bestTime = time;
      }
    }
    return best;
  }

  /**
   * Where a leaf is active within its scroll-linked root, as a fraction of the root's progress.
   * Null when the root repeats (one progress value then stands for several states).
   */
  #scrollRange(
    leaf: GsapAnimationLike,
    root: GsapAnimationLike,
  ): { from: number; to: number } | null {
    const total = root.totalDuration();
    if (root.repeat() !== 0 || !(total > 0)) return null;
    const from = this.#toRootLocal(leaf, root, 0).time / total;
    const to = this.#toRootLocal(leaf, root, leaf.totalDuration()).time / total;
    if (!Number.isFinite(from) || !Number.isFinite(to) || to - from <= 1e-9) return null;
    const round = (n: number) => Math.round(Math.min(Math.max(n, 0), 1) * 1e6) / 1e6;
    return { from: round(from), to: round(to) };
  }

  /**
   * Where a scroll-linked root runs in the scroll, from its ScrollTrigger's public read-only
   * state: the `start`/`end` positions it resolved on its last refresh, its scroller and axis,
   * and how its progress follows the scroll (`scrub`, `toggleActions`). Null without a
   * ScrollTrigger instance, before it resolved its positions, and for `containerAnimation`
   * triggers, whose positions lie along another animation rather than the scroll.
   */
  #scrollLink(root: GsapAnimationLike): AdapterScrollLink | null {
    const st = root.scrollTrigger;
    if (!st || typeof st !== "object" || !st.vars || st.vars.containerAnimation) return null;
    const { start, end } = st;
    if (typeof start !== "number" || typeof end !== "number") return null;
    if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
    const scrub = st.vars.scrub;
    // ScrollTrigger scrubs for `scrub: true` and any number (0 = no smoothing).
    const scrubbed = scrub === true || typeof scrub === "number";
    const scroller = st.scroller;
    const isContainer =
      typeof Element !== "undefined" &&
      scroller instanceof Element &&
      scroller !== document.documentElement &&
      scroller !== document.body &&
      scroller !== document.scrollingElement;
    const round = (n: number) => Math.round(n * 100) / 100;
    return {
      start: round(start),
      end: round(end),
      axis: st.vars.horizontal ? "horizontal" : "vertical",
      scroller: isContainer ? scroller : null,
      scrub: !scrubbed ? null : typeof scrub === "number" ? round(Math.max(scrub, 0) * 1000) : 0,
      toggleActions: scrubbed ? null : toggleActions(st.vars.toggleActions),
    };
  }

  /** Progress a scroll-linked root showed at `timeMs` (performance clock), from its trace. */
  #observedProgress(root: GsapAnimationLike, timeMs: number): number | null {
    const trace = this.#traces.get(root);
    if (!trace?.length) return null;
    if (timeMs <= trace[0]!.t) return trace[0]!.progress;
    for (let i = 1; i < trace.length; i++) {
      const b = trace[i]!;
      if (timeMs < b.t) {
        // Progress changes on GSAP's ticker, so it holds its value between observations.
        return trace[i - 1]!.progress;
      }
    }
    return trace[trace.length - 1]!.progress;
  }

  collect(): AdapterAnimation[] {
    const out: AdapterAnimation[] = [];
    const mappings = new Map<GsapAnimationLike, RootMapping>();
    this.#scrollRoots = new Map();
    for (const root of this.#windowRoots()) {
      const mapping = this.#mapping(root);
      mappings.set(root, mapping);
      const rootName =
        this.#names.get(root) ?? (typeof root.vars.id === "string" ? root.vars.id : null);
      const scrollLinked = Boolean(root.vars.scrollTrigger);
      if (scrollLinked) this.#scrollLinked.add(root);
      const trace = scrollLinked ? (this.#traces.get(root) ?? []) : [];
      const scrollLink = scrollLinked ? this.#scrollLink(root) : null;
      const leaves: { tween: GsapAnimationLike; owner: GsapAnimationLike }[] = [];
      this.#leaves(root, leaves);
      for (const { tween, owner } of leaves) {
        const targets = tween.targets?.() ?? [];
        const duration = tween.duration();
        if (duration <= 0) continue; // gsap.set() and zero-duration tweens are not motion
        const delaySec = tween.delay();
        // Leaf local zero (before its delay) expressed in root-local seconds, then on the page clock.
        const { time: zeroRootLocal, scale } = this.#toRootLocal(tween, root, -delaySec);
        const startAbs = mapping.zeroAbs + zeroRootLocal / mapping.ratePerMs;
        // Leaf local ms advanced per page ms (negative while the root plays in reverse).
        const rate = mapping.ratePerMs * 1000 * scale;
        const repeat = tween.repeat();
        const infinite = repeat === -1 || repeat < -1;
        const label = this.#labelFor(owner);
        const ownerName =
          this.#names.get(owner) ?? (typeof owner.vars.id === "string" ? owner.vars.id : null);
        const name =
          [rootName, label].filter(Boolean).join("@") ||
          ownerName ||
          (typeof tween.vars.id === "string" ? tween.vars.id : null);
        const staggered = owner !== tween;
        const notes: string[] = [];
        const scrollRange = scrollLinked ? this.#scrollRange(tween, root) : null;
        if (scrollLinked && !scrollRange)
          notes.push(
            "Repeating ScrollTrigger-driven animation: progress follows scroll; MotionPR records its timing and live progress only.",
          );
        const playState: PlayStateValue = root.paused()
          ? "paused"
          : root.isActive()
            ? "running"
            : "finished";
        const easeFn =
          tween._ease ??
          this.#gsap.parseEase(
            typeof tween.vars.ease === "string" ? tween.vars.ease : "power1.out",
          );
        const base = {
          name,
          // A scroll-linked tween has no time origin: its start is wherever scrolling begins.
          startTime: scrollLinked ? null : startAbs,
          ...(scrollLinked && trace.length > 1
            ? { progressTrace: trace.map((p) => ({ ...p })) }
            : {}),
          ...(scrollRange ? { scrollRange } : {}),
          ...(scrollLink ? { scrollLink } : {}),
          duration: duration * 1000,
          delay: delaySec * 1000,
          iterations: infinite ? Number.POSITIVE_INFINITY : repeat + 1,
          activeDuration: infinite ? null : tween.totalDuration() * 1000,
          direction: tween.yoyo() ? ("alternate" as const) : ("normal" as const),
          playbackRate: Math.round(rate * 1e6) / 1e6,
          easing: {
            value: this.#easeName(tween._ease, tween.vars.ease),
            ...(this.#easeSamples(easeFn) ? { samples: this.#easeSamples(easeFn)! } : {}),
          },
          properties: gsapProperties(tween.vars),
          playState,
          group: staggered ? `gsap:${this.idOf(owner)}` : null,
          timeline: scrollLinked ? ("scroll" as const) : ("adapter" as const),
          parent: root !== tween && typeof root.getChildren === "function" ? this.idOf(root) : null,
          type: "gsap" as const,
          driver: "javascript" as const,
          easingKind: "gsap" as const,
          easingSamplesSource: "exact" as const,
          provenance: {
            duration: "declared" as const,
            delay: "declared" as const,
            easing: "declared" as const,
            iterations: "declared" as const,
            playbackRate: "declared" as const,
            startTime: scrollLinked ? ("unavailable" as const) : ("observed" as const),
          },
          meta: {
            root: rootName ?? this.idOf(root),
            ...(label ? { label } : {}),
            ...(tween.repeatDelay() ? { repeatDelay: tween.repeatDelay() * 1000 } : {}),
            ...(staggered ? { staggered: true } : {}),
            ...(root.reversed() ? { reversed: true } : {}),
            ...(typeof tween.vars.runBackwards === "boolean" && tween.vars.runBackwards
              ? { from: true }
              : {}),
          },
        };
        targets.forEach((target, index) => {
          const isElement = typeof Element !== "undefined" && target instanceof Element;
          const id = `${this.idOf(tween)}:${index}`;
          if (scrollRange) this.#scrollRoots.set(id, root);
          out.push({
            ...base,
            id,
            target: isElement ? target : null,
            notes: isElement ? notes : [...notes, "Target is not a DOM element; timing only."],
            samplable: isElement && (!scrollLinked || scrollRange !== null),
          });
        });
      }
    }
    this.#mappings = mappings;
    return out;
  }

  collectTimelines(): AdapterTimeline[] {
    const out: AdapterTimeline[] = [];
    for (const [root, mapping] of this.#mappings) {
      if (typeof root.getChildren !== "function" || typeof root.targets === "function") continue;
      const repeat = root.repeat();
      const labels = root.labels ?? {};
      out.push({
        id: this.idOf(root),
        name: this.#names.get(root) ?? (typeof root.vars.id === "string" ? root.vars.id : null),
        startTime: mapping.zeroAbs,
        duration: root.duration() * 1000,
        iterations: repeat < 0 ? Number.POSITIVE_INFINITY : repeat + 1,
        direction: root.yoyo()
          ? root.reversed()
            ? "alternate-reverse"
            : "alternate"
          : root.reversed()
            ? "reverse"
            : "normal",
        playbackRate: root.timeScale(),
        playState: root.paused() ? "paused" : root.isActive() ? "running" : "finished",
        progress: Math.round(root.progress() * 1e4) / 1e4,
        labels: Object.entries(labels).map(([name, time]) => ({ name, time: time * 1000 })),
        provenance: { duration: "declared", labels: "declared", startTime: "observed" },
        notes: root.vars.scrollTrigger
          ? ["ScrollTrigger-driven timeline: progress follows scroll."]
          : [],
        meta: {
          ...(root.repeatDelay() ? { repeatDelay: root.repeatDelay() * 1000 } : {}),
          ...(root.vars.scrollTrigger ? { scrollTrigger: true } : {}),
        },
      });
    }
    return out;
  }

  isAnimating(): boolean {
    for (const state of this.#roots.values()) {
      const r = state.root;
      if (r.isActive() && r.repeat() !== -1 && !r.paused()) return true;
    }
    return false;
  }

  beginReplay(): void {
    for (const [root, mapping] of this.#mappings) {
      mapping.saved = { paused: root.paused(), totalTime: root.totalTime() };
      root.paused(true);
    }
    // Freeze other running GSAP roots so frames stay deterministic.
    this.#frozen = [];
    for (const state of this.#roots.values()) {
      const root = this.#topRoot(state.root);
      if (this.#mappings.has(root) || this.#frozen.some((f) => f.root === root)) continue;
      if (!root.isActive() || root.paused()) continue;
      this.#frozen.push({ root, paused: root.paused(), totalTime: root.totalTime() });
      root.paused(true);
      if (root.repeat() === -1) root.totalTime(0, true);
    }
  }

  seek(timeMs: number): void {
    for (const [root, mapping] of this.#mappings) {
      if (this.#scrollLinked.has(root)) {
        // No time origin: show the progress the page showed at that time. The trace holds
        // `progress()`, which equals total progress only without repeats; a repeating root is
        // left as it is.
        const progress = this.#observedProgress(root, timeMs);
        if (progress !== null && root.repeat() === 0)
          root.totalTime(progress * mapping.totalDuration, true);
        continue;
      }
      const local = (timeMs - mapping.zeroAbs) * mapping.ratePerMs;
      root.totalTime(Math.min(Math.max(local, 0), mapping.totalDuration), true);
    }
  }

  seekProgress(id: string, progress: number): void {
    const root = this.#scrollRoots.get(id);
    if (!root || !this.#mappings.has(root)) return;
    const p = Math.min(Math.max(progress, 0), 1);
    root.totalTime(p * root.totalDuration(), true);
  }

  endReplay(): void {
    for (const [root, mapping] of this.#mappings) {
      if (!mapping.saved) continue;
      root.totalTime(mapping.saved.totalTime, true);
      root.paused(mapping.saved.paused);
      delete mapping.saved;
    }
    for (const f of this.#frozen) {
      f.root.totalTime(f.totalTime, true);
      f.root.paused(f.paused);
    }
    this.#frozen = [];
  }
}

let active: GsapAdapter | null = null;
let unwrap: (() => void) | null = null;

function agentApi(): {
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

function agentPresent(): boolean {
  return (
    typeof window !== "undefined" &&
    Boolean((window as unknown as Record<string, unknown>)[AGENT_GLOBAL])
  );
}

export const motionprGsap = {
  /**
   * Connects GSAP to MotionPR. Call once, right after importing GSAP and before creating
   * animations. Returns true when MotionPR is capturing this page; otherwise it is a no-op.
   */
  register(gsap: GsapLike, options: RegisterOptions = {}): boolean {
    if (active) return true;
    if (!options.force && !agentPresent()) return false;
    if (!gsap || typeof gsap.to !== "function" || !gsap.globalTimeline) {
      throw new TypeError(
        'motionprGsap.register() expects the gsap object (import gsap from "gsap").',
      );
    }
    const adapter = new GsapAdapter(gsap);
    const restores: (() => void)[] = [];
    const wrap = <K extends "to" | "from" | "fromTo" | "timeline">(key: K) => {
      const original = gsap[key] as (...args: unknown[]) => GsapAnimationLike;
      const wrapped = function wrapped(this: unknown, ...args: unknown[]) {
        const anim = original.apply(this, args);
        try {
          if (active === adapter) adapter.trackRoot(anim);
        } catch {
          // observation must never break the animation
        }
        return anim;
      };
      (gsap as unknown as Record<K, unknown>)[key] = wrapped;
      restores.push(() => {
        if ((gsap as unknown as Record<K, unknown>)[key] === wrapped)
          (gsap as unknown as Record<K, unknown>)[key] = original;
      });
    };
    wrap("to");
    wrap("from");
    wrap("fromTo");
    wrap("timeline");
    for (const existing of gsap.globalTimeline.getChildren(false, true, true))
      adapter.trackRoot(existing);
    active = adapter;
    unwrap = () => {
      for (const restore of restores) restore();
    };
    agentApi()?.registerAdapter(adapter);
    return true;
  },

  /** Adapter health (empty when not registered). */
  getDiagnostics(): AdapterDiagnostic[] {
    return active?.diagnostics() ?? [];
  },

  /**
   * Restores `gsap.to/from/fromTo/timeline`, removes the ticker listener and unregisters from
   * MotionPR. Animations keep running; nothing is paused, killed or reverted.
   */
  dispose(): void {
    if (!active) return;
    const adapter = active;
    active = null;
    unwrap?.();
    unwrap = null;
    adapter.dispose();
    agentApi()?.unregisterAdapter?.(adapter);
  },

  /**
   * Explicitly tracks an animation under a stable name. Use it for animations created through
   * `new gsap.core.Timeline()`, for animations created before `register()`, or simply to give a
   * timeline a name that survives refactors. Returns the animation for chaining.
   */
  track<T extends GsapAnimationLike>(animation: T, name?: string): T {
    if (active) {
      active.trackRoot(animation);
      if (name) active.name_(animation, name);
    }
    return animation;
  },

  /** True when the adapter is registered with a capturing MotionPR agent. */
  isActive(): boolean {
    return active !== null;
  },
};

export default motionprGsap;
