/**
 * The MotionPR in-page agent. Injected with Playwright's addInitScript so it runs before any page
 * script. It discovers native animations (CSS animations, CSS transitions, Web Animations) as they
 * are created, tracks interaction triggers, and later replays everything deterministically by
 * cloning each animation and seeking the clones while they are paused.
 *
 * The original animations are never seeked: re-entering their active phase would re-dispatch
 * `transitionend` / `animationend` / `finish` to application code.
 */
import type {
  AdapterAnimation,
  AdapterClaim,
  AgentConfig,
  AnimationType,
  RawAdapterStatus,
  RawScrollTrack,
  RawTimeline,
  ScrollSettleOptions,
  ScrollSettleResult,
  ScrollState,
  SmoothScrollRequest,
  CollectResult,
  MotionprAdapter,
  MotionprAgentApi,
  PendingState,
  PlayStateValue,
  RawAnimation,
  RawCapabilities,
  RawDiagnostic,
  RawKeyframe,
  RawSample,
  RawScrollLink,
  RawTiming,
  SettleResult,
  TimelineKind,
  TriggerKind,
  WindowOrigin,
} from "@motionpr/core/protocol";
import { PROTOCOL_VERSION, SUPPORTED_PROTOCOLS } from "@motionpr/core/protocol";
import {
  animationProblems,
  declaredProtocol,
  describeValue,
  diagnosticProblems,
  formatProblems,
  scrollTrackProblems,
  timelineProblems,
  type ContractProblem,
} from "@motionpr/core/adapter-contract";
import { identifyElement } from "./identity.ts";
import { closestComposed, createShadowRegistry, shadowRootOf } from "./shadow.ts";

declare const __MOTIONPR_VERSION__: string;

interface Tracked {
  uid: string;
  anim: Animation;
  window: number;
  discoveredAt: number;
  /** Already finished when first seen (e.g. `animate(...).finish()`): it never moved on screen. */
  finishedOnDiscovery: boolean;
  /** First known (resolved) start time on the document timeline. */
  start: number | null;
  canceledAt: number | null;
  /** Set once the animation finished; a later cancel (e.g. class removed) is not a truncation. */
  finished: boolean;
  /**
   * The shadow root its target was in when it was discovered: a target replaced in the DOM is
   * still identified through that root's host (and re-found there for replay).
   */
  shadowRoot: ShadowRoot | null;
}

/** A native scroll container (an overflow element) known in the current window. */
interface ContainerTrack {
  el: Element;
  /** Positions in time order (performance clock). The first is the rest position when known. */
  samples: { t: number; x: number; y: number }[];
  /** False when the container was first seen while scrolling, so where it rested is unknown. */
  restObserved: boolean;
  /** Scroll events seen in the window. Containers without any did not move. */
  events: number;
  /** A step is scrolling it: settling waits for it before its first scroll event. */
  watched: boolean;
  /** Element key, computed once. */
  key: string | null;
}

interface Trigger {
  step: number;
  type: TriggerKind;
  time: number;
  event?: string;
}

interface ReplayEntry {
  record: RawAnimation;
  /** True for browser animations (replayed through clones), including adapter-claimed ones. */
  native: boolean;
  /** Absolute start (performance clock) of local time zero. */
  startAbs: number | null;
  /** Window-relative start of local time zero (what seeking is computed from). */
  startWindow: number | null;
  rate: number;
  clone: Animation | null;
  target: Element | null;
  pseudo: string | null;
  canceledAt: number | null;
}

interface SavedState {
  anim: Animation;
  currentTime: number | null;
  wasRunning: boolean;
  fill?: FillMode;
}

const TRIGGER_EVENTS: Record<TriggerKind, string[]> = {
  click: ["click"],
  hover: ["pointerover", "mouseover"],
  move: ["pointermove", "mousemove"],
  scroll: ["scroll"],
  "scroll-motion": ["wheel", "scroll"],
  fill: ["input"],
  press: ["keydown"],
  navigation: [],
  none: [],
};

const META_KEYS = new Set(["offset", "computedOffset", "easing", "composite"]);
const KNOWN_ADAPTER_TYPES = new Set<AnimationType>(["gsap", "animejs"]);
/** One frame at 60 Hz, used to bound when observed movement actually began. */
const FRAME_MS = 1000 / 60;
/** Native scrolling counts as finished after this long without movement. */
const NATIVE_QUIET_MS = 100;
/** Upper bound of native scroll samples kept per window (≈ 33 s at 60 fps). */
const MAX_NATIVE_SCROLL_SAMPLES = 2000;

export function installAgent(win: Window & typeof globalThis): void {
  if (win.__MOTIONPR_AGENT__) return;
  const doc = win.document;
  const perf = win.performance;

  const config: AgentConfig = {
    motionprIdAttribute: "data-motionpr-id",
    testIdAttribute: "data-testid",
    ignoreSelectors: [],
    ignoreAnimationNames: [],
    ignoreProperties: [],
    maxWindowMs: 5000,
    scrollContainers: true,
  };

  const tracked = new Map<Animation, Tracked>();
  const clones = new WeakSet<Animation>();
  const adapters: MotionprAdapter[] = [];
  const diagnostics: RawDiagnostic[] = [];
  let uidCounter = 0;
  let windowIndex = 0;
  let windowOpenedAt = 0;
  let lastDiscoveryAt = 0;
  let triggers: Trigger[] = [];
  let pendingTrigger: Trigger | null = null;
  let replaying = false;
  let lastCollect: CollectResult | null = null;
  let replay: { entries: ReplayEntry[]; saved: SavedState[]; origin: number } | null = null;
  const failedAdapters = new Set<string>();
  /** Adapters that declared a protocol this agent does not support: not registered, reported. */
  const rejectedAdapters: RawAdapterStatus[] = [];
  /** Document scroll positions observed this window (native scrolling, recorded live). */
  let nativeScroll: { t: number; x: number; y: number }[] = [];
  /** Last scroller positions seen by pending(), to tell advancing from stalled smooth scrolls. */
  const lastPendingScroll = new Map<string, number>();
  let lastNativeMove = 0;
  /** Native scroll containers of the current window: rest positions and observed movement. */
  let containers = new Map<Element, ContainerTrack>();
  /** When a scan last saw each element without overflow (its scroll offset was 0 then). */
  let scannedAt = new WeakMap<Element, number>();
  /**
   * Shadow roots: `document.getAnimations()` and non-composed events (`scroll`, `transitionrun`,
   * `animationstart`) do not leave them, so each one is polled and listened to directly.
   */
  const shadow = createShadowRegistry(win, watchShadowRoot);

  const now = () => perf.now();

  function scrollingElement(): Element {
    return doc.scrollingElement ?? doc.documentElement;
  }

  function recordNativeScroll(): void {
    const x = win.scrollX;
    const y = win.scrollY;
    const last = nativeScroll[nativeScroll.length - 1];
    if (last && last.x === x && last.y === y) return;
    const t = now();
    if (last) lastNativeMove = t;
    if (nativeScroll.length >= MAX_NATIVE_SCROLL_SAMPLES) nativeScroll.splice(1, 1);
    nativeScroll.push({ t, x, y });
  }

  /** The document scroller is recorded by `recordNativeScroll`, not as a container. */
  function isDocumentScroller(el: Element): boolean {
    return el === doc.documentElement || el === scrollingElement();
  }

  function newContainer(el: Element, samples: ContainerTrack["samples"], restObserved: boolean) {
    const track: ContainerTrack = {
      el,
      samples,
      restObserved,
      events: 0,
      watched: false,
      key: null,
    };
    containers.set(el, track);
    return track;
  }

  function containerKey(track: ContainerTrack): string {
    track.key ??= identifyElement(track.el, null, config).key;
    return track.key;
  }

  /**
   * Notes where every element that can scroll (its content overflows) rests, so a container that
   * starts scrolling later in the window has its rest position; scroll events only arrive after
   * the first movement. An element without overflow has a scroll offset of 0 until it overflows,
   * which is noted too. Runs when a window opens and before each interaction (before its trigger
   * time, so latency does not include it), never per frame: about 1 ms per 1,000 elements.
   */
  function scanContainers(): void {
    if (replaying) return;
    // The same walk finds declarative shadow roots (they are not created through attachShadow).
    if (!config.scrollContainers) return shadow.discover();
    const t = now();
    const root = doc.documentElement;
    const main = scrollingElement();
    // The document's elements and those of every shadow root (containers inside components).
    shadow.forEachElement((el) => {
      if (el === root || el === main || containers.has(el)) return;
      // No overflow, no scroll range: the offset is 0 (within the sub-pixel the sizes round off).
      if (el.scrollHeight <= el.clientHeight && el.scrollWidth <= el.clientWidth) {
        scannedAt.set(el, t);
        return;
      }
      if (isIgnoredTarget(el)) return;
      newContainer(el, [{ t, x: el.scrollLeft, y: el.scrollTop }], true);
    });
  }

  /** Records a container's position at one of its scroll events (once per frame while it moves). */
  function recordContainerScroll(el: Element): void {
    let track = containers.get(el);
    if (!track) {
      if (isIgnoredTarget(el)) return;
      const at = scannedAt.get(el);
      track = newContainer(el, at === undefined ? [] : [{ t: at, x: 0, y: 0 }], at !== undefined);
    }
    track.events++;
    const x = el.scrollLeft;
    const y = el.scrollTop;
    const last = track.samples[track.samples.length - 1];
    if (last && last.x === x && last.y === y) return;
    const t = now();
    lastNativeMove = t;
    if (track.samples.length >= MAX_NATIVE_SCROLL_SAMPLES) track.samples.splice(1, 1);
    track.samples.push({ t, x, y });
  }

  /** A container a step is about to scroll: note where it rests and wait for it to settle. */
  function watchContainer(el: Element): void {
    if (!config.scrollContainers || isDocumentScroller(el) || isIgnoredTarget(el)) return;
    const track =
      containers.get(el) ??
      newContainer(el, [{ t: now(), x: el.scrollLeft, y: el.scrollTop }], true);
    track.watched = true;
  }

  // ------------------------------------------------------------------------------------------
  // Discovery
  // ------------------------------------------------------------------------------------------

  /** `created`: the animation was just made with `animate()` (not re-discovered by a poll). */
  function track(anim: Animation, created = false): void {
    if (replaying || clones.has(anim)) return;
    const existing = tracked.get(anim);
    if (existing) {
      if (existing.start === null && typeof anim.startTime === "number")
        existing.start = anim.startTime;
      return;
    }
    const entry: Tracked = {
      uid: `n${++uidCounter}`,
      anim,
      window: windowIndex,
      discoveredAt: now(),
      finishedOnDiscovery: false,
      start: typeof anim.startTime === "number" ? anim.startTime : null,
      canceledAt: null,
      finished: false,
      shadowRoot: null,
    };
    const target = anim.effect instanceof win.KeyframeEffect ? anim.effect.target : null;
    if (target) entry.shadowRoot = shadowRootOf(target);
    tracked.set(anim, entry);
    lastDiscoveryAt = entry.discoveredAt;
    // `finish()` called in the same task as `animate()` (a common reduced-motion fallback) jumps
    // to the end before any frame shows it; its back-dated start time must not be mistaken for
    // an animation that ran before the interaction. Checked once the creating task is done.
    // (Polls re-discover finished fill-forwards animations of earlier windows; those are not
    // creations and keep their real start.)
    if (created)
      queueMicrotask(() => {
        if (anim.playState === "finished" && !entry.finished) {
          entry.finishedOnDiscovery = true;
          entry.finished = true;
        }
      });
    anim.addEventListener("finish", () => {
      entry.finished = true;
    });
    anim.addEventListener("cancel", () => {
      if (entry.canceledAt === null && !entry.finished) entry.canceledAt = now();
    });
  }

  /** Running and filling animations of the document and of every shadow root MotionPR knows. */
  function allAnimations(): Animation[] {
    const all = doc.getAnimations();
    for (const root of shadow.roots()) {
      const inRoot = root.getAnimations();
      for (let i = 0; i < inRoot.length; i++) all.push(inRoot[i]!);
    }
    return all;
  }

  function poll(): void {
    if (replaying) return;
    for (const anim of allAnimations()) track(anim);
    for (const entry of tracked.values()) {
      if (entry.start === null && typeof entry.anim.startTime === "number")
        entry.start = entry.anim.startTime;
    }
  }

  const nativeAnimate = win.Element.prototype.animate;
  win.Element.prototype.animate = function patchedAnimate(
    this: Element,
    ...args: Parameters<Element["animate"]>
  ) {
    const anim = nativeAnimate.apply(this, args);
    track(anim, true);
    return anim;
  };
  const nativePlay = win.Animation.prototype.play;
  win.Animation.prototype.play = function patchedPlay(this: Animation) {
    nativePlay.call(this);
    if (replaying || clones.has(this)) return;
    const entry = tracked.get(this);
    if (entry && entry.window !== windowIndex) {
      // A reused animation restarted in a later window belongs to that window now.
      entry.window = windowIndex;
      entry.start = typeof this.startTime === "number" ? this.startTime : null;
      entry.canceledAt = null;
      entry.finished = false;
      entry.finishedOnDiscovery = false;
      entry.discoveredAt = now();
      lastDiscoveryAt = entry.discoveredAt;
    } else {
      track(this);
    }
  };

  for (const type of ["transitionrun", "transitionstart", "animationstart"]) {
    win.addEventListener(type, poll, true);
  }
  const frame = () => {
    poll();
    if (!replaying) recordNativeScroll();
    win.requestAnimationFrame(frame);
  };
  win.requestAnimationFrame(frame);
  // Scroll containers: element scroll events do not bubble, but they pass the window while
  // capturing (inside a shadow root they stop at the root: see watchShadowRoot). Document
  // scrolling (target: the document) is polled per frame above.
  function onScroll(event: Event): void {
    if (replaying || !config.scrollContainers) return;
    const target = event.target;
    if (target instanceof win.Element && !isDocumentScroller(target)) recordContainerScroll(target);
  }
  win.addEventListener("scroll", onScroll, { capture: true, passive: true });
  // Declarative shadow roots of the initial HTML, before the first interaction scans the page.
  doc.addEventListener("DOMContentLoaded", () => shadow.discover(), { once: true });

  /** Listens inside a shadow root for what does not leave it. */
  function watchShadowRoot(root: ShadowRoot): void {
    for (const type of ["transitionrun", "transitionstart", "animationstart"]) {
      root.addEventListener(type, poll, true);
    }
    root.addEventListener("scroll", onScroll, { capture: true, passive: true });
    root.addEventListener("scroll", onTriggerEvent, { capture: true, passive: true });
  }

  // ------------------------------------------------------------------------------------------
  // Triggers
  // ------------------------------------------------------------------------------------------

  function onTriggerEvent(event: Event): void {
    const type = event.type;
    if (!pendingTrigger || pendingTrigger.event || !event.isTrusted) return;
    if (!TRIGGER_EVENTS[pendingTrigger.type].includes(type)) return;
    // `scroll` events fire after the position changed, so they would place the trigger
    // after the motion it caused; keep the step start for them.
    if (type !== "scroll") pendingTrigger.time = event.timeStamp;
    pendingTrigger.event = type;
  }
  // Input events are composed and reach the window from inside shadow roots; `scroll` is not
  // (watchShadowRoot listens for it in each root).
  const allTriggerEvents = new Set(Object.values(TRIGGER_EVENTS).flat());
  for (const type of allTriggerEvents) {
    win.addEventListener(type, onTriggerEvent, { capture: true, passive: true });
  }

  // ------------------------------------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------------------------------------

  function isIgnoredTarget(el: Element | null): boolean {
    if (!el) return false;
    for (const selector of config.ignoreSelectors) {
      try {
        // The element, its ancestors, and the hosts of the shadow roots it is in.
        if (closestComposed(el, selector)) return true;
      } catch {
        // invalid selector: reported by the runner when configuring
      }
    }
    return false;
  }

  function finite(n: number | null | undefined): number | null {
    return typeof n === "number" && Number.isFinite(n) ? n : null;
  }

  function timelineKind(anim: Animation): TimelineKind {
    const tl = anim.timeline as AnimationTimeline | null;
    if (!tl) return "unknown";
    const w = win as unknown as {
      ViewTimeline?: new () => object;
      ScrollTimeline?: new () => object;
    };
    if (w.ViewTimeline && tl instanceof w.ViewTimeline) return "view";
    if (w.ScrollTimeline && tl instanceof w.ScrollTimeline) return "scroll";
    if (tl instanceof win.DocumentTimeline) return "document";
    return "unknown";
  }

  function nativeType(anim: Animation): RawAnimation["type"] {
    const w = win as unknown as {
      CSSTransition?: new () => object;
      CSSAnimation?: new () => object;
    };
    if (w.CSSTransition && anim instanceof w.CSSTransition) return "css-transition";
    if (w.CSSAnimation && anim instanceof w.CSSAnimation) return "css-animation";
    return "web-animation";
  }

  function nativeName(anim: Animation, type: RawAnimation["type"]): string | null {
    const a = anim as Animation & { animationName?: string; transitionProperty?: string };
    if (type === "css-animation") return a.animationName ?? null;
    if (type === "css-transition") return a.transitionProperty ?? null;
    return anim.id || null;
  }

  function kebab(prop: string): string {
    if (prop.startsWith("--")) return prop;
    if (prop === "cssFloat") return "float";
    if (prop === "cssOffset") return "offset";
    return prop.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
  }

  function readKeyframes(effect: KeyframeEffect): RawKeyframe[] {
    return effect.getKeyframes().map((kf) => {
      const values: Record<string, string> = {};
      for (const [key, value] of Object.entries(kf)) {
        if (META_KEYS.has(key) || value === undefined || value === null) continue;
        values[kebab(key)] = String(value);
      }
      // Firefox stores offsets in single precision (0.4 reads back as 0.4000000059604645).
      return {
        offset: round6(
          typeof kf.computedOffset === "number" ? kf.computedOffset : (kf.offset ?? 0),
        ),
        easing: String(kf.easing ?? "linear"),
        composite: String(kf.composite ?? "auto"),
        values,
      };
    });
  }

  function playState(anim: Animation): PlayStateValue {
    if (anim.pending) return "pending";
    return anim.playState as PlayStateValue;
  }

  function startOf(entry: Tracked): { start: number | null; note?: string } {
    const st = entry.anim.startTime;
    if (typeof st === "number") return { start: st };
    if (entry.start !== null) return { start: entry.start };
    const ct = entry.anim.currentTime;
    if (typeof ct === "number" && entry.anim.playbackRate !== 0) {
      return {
        start: now() - ct / entry.anim.playbackRate,
        note: "Start time estimated from current time (animation paused or pending).",
      };
    }
    return { start: null, note: "Start time unknown (animation never resolved a start time)." };
  }

  // ------------------------------------------------------------------------------------------
  // Collection
  // ------------------------------------------------------------------------------------------

  function nativeRecord(entry: Tracked): RawAnimation | null {
    const anim = entry.anim;
    const effect = anim.effect;
    if (!(effect instanceof win.KeyframeEffect)) return null;
    const target = effect.target;
    if (!target || isIgnoredTarget(target)) return null;
    const type = nativeType(anim);
    const claim = claimOf(anim);
    const name = claim?.name ?? nativeName(anim, type);
    if (name && config.ignoreAnimationNames.includes(name)) return null;

    const timing = effect.getTiming();
    const computed = effect.getComputedTiming();
    const keyframes = readKeyframes(effect);
    const props = new Set<string>();
    for (const kf of keyframes) for (const p of Object.keys(kf.values)) props.add(p);
    for (const p of config.ignoreProperties) props.delete(p);
    if (props.size === 0) return null;

    const notes: string[] = [];
    const tl = timelineKind(anim);
    const duration =
      typeof timing.duration === "number" ? timing.duration : finite(computed.duration as number);
    const rawTiming: RawTiming = {
      duration,
      delay: timing.delay ?? 0,
      endDelay: timing.endDelay ?? 0,
      iterations: timing.iterations === Infinity ? "infinite" : (timing.iterations ?? 1),
      iterationStart: timing.iterationStart ?? 0,
      direction: (timing.direction ?? "normal") as RawTiming["direction"],
      fill: (timing.fill ?? "auto") as RawTiming["fill"],
      easing: timing.easing ?? "linear",
      playbackRate: anim.playbackRate,
      activeDuration: finite(computed.activeDuration as number),
      endTime: finite(computed.endTime as number),
    };

    let samplable = true;
    if (tl === "scroll" || tl === "view") {
      samplable = false;
      notes.push(
        "Scroll-driven animation: progress follows scroll position, so only metadata is recorded.",
      );
    } else if (tl !== "document") {
      samplable = false;
      notes.push("Animation uses a custom timeline; only metadata is recorded.");
    }
    const { start, note } = startOf(entry);
    if (note) notes.push(note);
    if (start === null) samplable = false;
    if (entry.canceledAt !== null)
      notes.push("Canceled before completion; replay stops at the cancel time.");
    if (entry.finishedOnDiscovery) {
      samplable = false;
      notes.push(
        "Finished as soon as it was created (finish() or a seek to its end): no motion was shown, so only its timing is recorded.",
      );
    }
    if (!target.isConnected) {
      notes.push("Element left the document before capture; frames and samples cannot show it.");
    }
    if (duration === null || duration === 0) samplable = false;

    return {
      uid: entry.uid,
      type,
      source: claim ? claim.source : "native",
      driver: type === "web-animation" ? "waapi" : "css",
      provenance: claim?.provenance ?? {},
      parent: null,
      easingKind: null,
      easingSamplesSource: null,
      progressTrace: [],
      scrollRange: null,
      scrollLink: null,
      name,
      element: identifyElement(target, effect.pseudoElement, config, entry.shadowRoot),
      startTime: entry.finishedOnDiscovery ? null : start,
      timing: rawTiming,
      keyframes,
      properties: [...props].sort(),
      easingSamples: null,
      timeline: tl,
      playState: playState(anim),
      group: claim?.group ?? null,
      meta: {
        ...(effect.pseudoElement ? { pseudoElement: effect.pseudoElement } : {}),
        composite: effect.composite,
        ...(entry.canceledAt !== null ? { canceled: true } : {}),
        ...(entry.finishedOnDiscovery ? { finishedOnCreation: true } : {}),
        ...(claim?.meta ?? {}),
      },
      notes,
      samplable,
    };
  }

  /** Native animations created by an adapter's engine are recorded once, labelled with it. */
  function claimOf(anim: Animation): (AdapterClaim & { source: string }) | null {
    for (const adapter of adapters) {
      if (typeof adapter.claims !== "function") continue;
      try {
        const claim = adapter.claims(anim);
        if (claim) return { ...claim, source: adapter.name };
      } catch {
        // a failing claim check must not hide the animation
      }
    }
    return null;
  }

  /**
   * An adapter's resolved scroll positions, checked (adapters are third-party code) and with
   * the scroll container as its element key. Null when absent or malformed.
   */
  function rawScrollLink(link: AdapterAnimation["scrollLink"]): RawScrollLink | null {
    if (!link || typeof link !== "object") return null;
    const { start, end, axis, scroller, scrub } = link;
    const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
    if (!finite(start) || !finite(end) || (axis !== "vertical" && axis !== "horizontal"))
      return null;
    if (scrub !== null && !(finite(scrub) && scrub >= 0)) return null;
    const actions = scrub === null ? link.toggleActions : null;
    const round = (n: number) => Math.round(n * 100) / 100;
    const container =
      scroller instanceof Element &&
      scroller.isConnected &&
      scroller !== document.documentElement &&
      scroller !== document.body &&
      scroller !== document.scrollingElement;
    return {
      start: round(start),
      end: round(end),
      axis,
      scroller: container ? identifyElement(scroller, null, config).key : null,
      scrub: scrub === null ? null : round(scrub),
      toggleActions: typeof actions === "string" ? actions.slice(0, 80) : null,
    };
  }

  /** An adapter method's result as an array; anything else is a contract error. */
  function list<T>(value: readonly T[] | undefined, method: string): readonly T[] {
    if (value === undefined) return [];
    if (!Array.isArray(value))
      throw new TypeError(`${method}() must return an array; got ${describeValue(value)}.`);
    return value;
  }

  /**
   * Leaves out entries with `invalid` problems (they would make the capture unreadable) and
   * reports them: one diagnostic each for the first five of an adapter's collect, then a count.
   */
  function invalidEntries(adapter: MotionprAdapter, out: RawDiagnostic[]) {
    let count = 0;
    const check = (kind: string, entry: unknown, problems: ContractProblem[]): boolean => {
      const bad = problems.filter((p) => p.level === "invalid");
      if (!bad.length) return false;
      if (++count <= 5) {
        const id =
          typeof entry === "object" && entry !== null
            ? ((entry as { id?: unknown }).id ?? (entry as { sessionId?: unknown }).sessionId)
            : undefined;
        out.push({
          level: "warning",
          code: "ADAPTER_RECORD_INVALID",
          message: `Adapter "${adapter.name}" reported an invalid ${kind}${id !== undefined ? ` ${describeValue(id)}` : ""}, left out of the capture: ${formatProblems(bad)}`,
        });
      }
      return true;
    };
    const finish = () => {
      if (count > 5)
        out.push({
          level: "warning",
          code: "ADAPTER_RECORD_INVALID",
          message: `Adapter "${adapter.name}" reported ${count - 5} more invalid entries, also left out.`,
        });
    };
    return { check, finish };
  }

  function adapterRecord(adapter: MotionprAdapter, a: AdapterAnimation): RawAnimation | null {
    // Missing nullable fields read as null (`animationProblems` reports them as violations).
    a = {
      ...a,
      id: String(a.id),
      name: a.name ?? null,
      target: a.target ?? null,
      startTime: a.startTime ?? null,
      duration: a.duration ?? null,
    };
    if (a.target && isIgnoredTarget(a.target)) return null;
    adapterSources.set(`${adapter.name}:${a.id}`, { adapter, id: a.id });
    if (a.name && config.ignoreAnimationNames.includes(a.name)) return null;
    const properties = a.properties.filter((p) => !config.ignoreProperties.includes(p));
    const infinite = !Number.isFinite(a.iterations);
    const active =
      a.activeDuration !== undefined
        ? a.activeDuration
        : a.duration === null || infinite
          ? null
          : a.duration * a.iterations;
    const endDelay = a.endDelay ?? 0;
    const element = a.target
      ? identifyElement(a.target, null, config)
      : {
          key: `adapter:${adapter.name}:${a.objectKey ?? a.name ?? a.id}`,
          method: "adapter" as const,
          confidence: a.objectKey || a.name ? ("medium" as const) : ("low" as const),
          selector: "",
          tag: "object",
          warnings: ["Animation has no DOM target; matched by the adapter's key."],
        };
    const type: AnimationType =
      a.type ??
      (KNOWN_ADAPTER_TYPES.has(adapter.name as AnimationType)
        ? (adapter.name as AnimationType)
        : "custom");
    return {
      uid: `${adapter.name}:${a.id}`,
      type,
      source: adapter.name,
      driver: a.driver ?? "javascript",
      provenance: { ...(a.provenance ?? {}) },
      parent: typeof a.parent === "string" && a.parent ? `${adapter.name}:${a.parent}` : null,
      easingKind: a.easingKind ?? null,
      easingSamplesSource: a.easingSamplesSource ?? null,
      progressTrace: (a.progressTrace ?? []).map((p) => ({ time: p.t, progress: p.progress })),
      scrollRange: a.scrollRange ? { from: a.scrollRange.from, to: a.scrollRange.to } : null,
      scrollLink: rawScrollLink(a.scrollLink),
      name: a.name,
      element,
      startTime: a.startTime,
      timing: {
        duration: a.duration,
        delay: a.delay,
        endDelay,
        iterations: infinite ? "infinite" : a.iterations,
        iterationStart: 0,
        direction: a.direction,
        fill: "both",
        easing: a.easing.value,
        playbackRate: a.playbackRate,
        activeDuration: active,
        endTime: active === null ? null : a.delay + active + endDelay,
      },
      keyframes: [],
      properties,
      easingSamples: a.easing.samples ?? null,
      timeline: a.timeline ?? "adapter",
      playState: a.playState,
      group: a.group ?? null,
      meta: a.meta ?? {},
      notes: [...(a.notes ?? [])],
      samplable:
        a.samplable &&
        a.target !== null &&
        (a.startTime !== null
          ? typeof adapter.seek === "function"
          : // Scroll-linked: rendered at the progress the scroll reached.
            a.scrollRange !== undefined &&
            (a.progressTrace?.length ?? 0) > 1 &&
            typeof adapter.seekProgress === "function"),
    };
  }

  /** Window-relative end of a record's visible activity (handles negative playback rates). */
  function recordExtent(r: RawAnimation): { start: number; end: number } | null {
    if (r.startTime === null) return null;
    const rate = r.timing.playbackRate || 1;
    const iterationDuration = r.timing.duration ?? 0;
    const active =
      r.timing.activeDuration ?? (r.timing.iterations === "infinite" ? iterationDuration : 0);
    const a = r.startTime + r.timing.delay / rate;
    const b = r.startTime + (r.timing.delay + active) / rate;
    // Includes the delay phase: forward playback spans local zero → active end; reversed
    // playback spans the active end (reached first) → local zero.
    return { start: Math.min(r.startTime, a, b), end: Math.max(r.startTime, a, b) };
  }

  /**
   * Samples of a natively scrolled box on the axis it moved along most, with velocity derived
   * from consecutive positions. Null when it never moved.
   *
   * Positions are only recorded when they change, so the last one is where the box stopped,
   * not evidence that it stopped. `current` is its position now: when it still equals the last
   * one and nothing moved for NATIVE_QUIET_MS, that observation is kept as a final still sample
   * (without it, a scroll that ended on a fast frame read as unsettled).
   */
  function nativeSamples(
    recorded: readonly { t: number; x: number; y: number }[],
    current: { x: number; y: number } | null,
    limitFor: (horizontal: boolean) => number,
  ): { axis: "vertical" | "horizontal"; samples: RawScrollTrack["samples"] } | null {
    const moved = recorded.some(
      (s, i) => i > 0 && (s.x !== recorded[i - 1]!.x || s.y !== recorded[i - 1]!.y),
    );
    if (!moved) return null;
    const first = recorded[0]!;
    const last = recorded[recorded.length - 1]!;
    const t = now();
    const points =
      current && current.x === last.x && current.y === last.y && t - last.t >= NATIVE_QUIET_MS
        ? [...recorded, { t, x: last.x, y: last.y }]
        : recorded;
    const horizontal = Math.abs(last.x - first.x) > Math.abs(last.y - first.y);
    const limit = Math.max(0, limitFor(horizontal));
    const samples = points.map((s, i) => {
      const pos = horizontal ? s.x : s.y;
      const prev = i > 0 ? points[i - 1]! : null;
      const prevPos = prev ? (horizontal ? prev.x : prev.y) : pos;
      const dt = prev ? s.t - prev.t : 0;
      const velocity = dt > 0 ? (pos - prevPos) / dt : 0;
      return {
        time: s.t,
        actualScroll: pos,
        animatedScroll: pos,
        targetScroll: horizontal ? last.x : last.y,
        progress: limit > 0 ? round6(pos / limit) : 0,
        velocity: round6(velocity),
        direction: Math.sign(pos - prevPos),
        isScrolling: velocity !== 0,
        isStopped: false,
        limit,
      };
    });
    return { axis: horizontal ? "horizontal" : "vertical", samples };
  }

  /** Native document scroll track, unless a scroll adapter already drives the document. */
  function nativeScrollTrack(adapterTracks: RawScrollTrack[]): RawScrollTrack | null {
    if (adapterTracks.some((t) => t.wrapper === null)) return null;
    recordNativeScroll();
    const el = scrollingElement();
    const motion = nativeSamples(nativeScroll, { x: win.scrollX, y: win.scrollY }, (horizontal) =>
      horizontal ? el.scrollWidth - win.innerWidth : el.scrollHeight - win.innerHeight,
    );
    if (!motion) return null;
    return {
      source: "native",
      sessionId: "document",
      axis: motion.axis,
      wrapper: null,
      config: {
        scrollBehavior: win.getComputedStyle(doc.documentElement).scrollBehavior || "auto",
      },
      prefersReducedMotion: win.matchMedia("(prefers-reduced-motion: reduce)").matches,
      samples: motion.samples,
      events: nativeScroll.length,
      notes: [
        "Native scrolling: positions sampled once per animation frame; velocity is derived (px/ms).",
        ...(nativeScroll.length >= MAX_NATIVE_SCROLL_SAMPLES
          ? ["Sample buffer was full; the middle of the movement was thinned."]
          : []),
      ],
      meta: {},
    };
  }

  /**
   * Tracks of the native scroll containers that moved in this window, except containers a
   * scroll adapter already records (a Lenis `wrapper`).
   */
  function containerScrollTracks(adapterWrappers: ReadonlySet<Element>): RawScrollTrack[] {
    const out: RawScrollTrack[] = [];
    const firstTrigger = triggers[0];
    for (const track of containers.values()) {
      if (track.events === 0 || adapterWrappers.has(track.el)) continue;
      const el = track.el;
      const motion = nativeSamples(
        track.samples,
        el.isConnected ? { x: el.scrollLeft, y: el.scrollTop } : null,
        (horizontal) =>
          horizontal ? el.scrollWidth - el.clientWidth : el.scrollHeight - el.clientHeight,
      );
      if (!motion) continue;
      // Seen first while scrolling, but before the interaction: the position it rested at when
      // the interaction began is known (movement before it is not part of the checkpoint).
      const restKnown =
        track.restObserved ||
        (firstTrigger !== undefined && track.samples[0]!.t < firstTrigger.time - 17);
      const style = el.isConnected ? win.getComputedStyle(el) : null;
      out.push({
        source: "native",
        sessionId: "container",
        axis: motion.axis,
        wrapper: identifyElement(el, null, config),
        config: {
          scrollBehavior: style?.scrollBehavior || "auto",
          scrollSnapType: style?.scrollSnapType || "none",
        },
        prefersReducedMotion: win.matchMedia("(prefers-reduced-motion: reduce)").matches,
        samples: motion.samples,
        events: track.events,
        notes: [
          "Native scroll container: positions recorded at each of its scroll events (once per frame while it moves); velocity is derived (px/ms).",
          ...(restKnown
            ? []
            : [
                "Its position before the first scroll event was not observed: the element was added to the page, or started to overflow, after the window opened.",
              ]),
          ...(track.samples.length >= MAX_NATIVE_SCROLL_SAMPLES
            ? ["Sample buffer was full; the middle of the movement was thinned."]
            : []),
        ],
        meta: {},
      });
    }
    return out;
  }

  function moved(a: ScrollState, b: ScrollState, threshold = 0.01): boolean {
    return Math.abs(a.animatedScroll - b.animatedScroll) > threshold;
  }

  /** Longest run of consecutive samples that moved. */
  function longestMovingRun(samples: readonly ScrollState[]): number {
    let best = 0;
    let run = 0;
    for (let i = 1; i < samples.length; i++) {
      if (moved(samples[i]!, samples[i - 1]!)) best = Math.max(best, ++run);
      else run = 0;
    }
    return best;
  }

  /** Performance-clock time of the first sample that moved, across all tracks. */
  function scrollMovementStart(tracks: RawScrollTrack[]): number | null {
    let first: number | null = null;
    for (const track of tracks) {
      for (let i = 1; i < track.samples.length; i++) {
        if (moved(track.samples[i]!, track.samples[i - 1]!)) {
          // Movement began within the frame before the first moving sample (the previous still
          // sample can be much older, e.g. the one taken when the window opened).
          const t = Math.max(track.samples[i - 1]!.time, track.samples[i]!.time - FRAME_MS);
          if (first === null || t < first) first = t;
          break;
        }
      }
    }
    return first;
  }

  function lastMovementTime(track: RawScrollTrack): number | null {
    for (let i = track.samples.length - 1; i > 0; i--) {
      if (moved(track.samples[i]!, track.samples[i - 1]!)) return track.samples[i]!.time;
    }
    return null;
  }

  function collect(): CollectResult {
    poll();
    const records: RawAnimation[] = [];
    const notes: RawDiagnostic[] = diagnostics.splice(0);
    for (const entry of tracked.values()) {
      if (entry.window !== windowIndex) continue;
      try {
        const r = nativeRecord(entry);
        if (r) records.push(r);
      } catch (error) {
        notes.push({
          level: "warning",
          code: "AGENT_RECORD_FAILED",
          message: `Could not read animation ${entry.uid}: ${String(error)}`,
        });
      }
    }
    const timelines: RawTimeline[] = [];
    const scrollTracks: RawScrollTrack[] = [];
    const adapterWrappers = new Set<Element>();
    adapterSources.clear();
    for (const adapter of adapters) {
      try {
        const { check: invalid, finish } = invalidEntries(adapter, notes);
        const collectedAt = now();
        const seen = new Set<string>();
        for (const a of list(adapter.collect(), "collect")) {
          if (invalid("animation", a, animationProblems(a, { now: collectedAt }))) continue;
          const id = String(a.id);
          if (seen.has(id)) {
            invalid("animation", a, [
              {
                level: "invalid",
                field: "id",
                message: `id ${describeValue(id)} is reported twice; ids must be unique.`,
              },
            ]);
            continue;
          }
          seen.add(id);
          const r = adapterRecord(adapter, a);
          if (r) records.push(r);
        }
        for (const tl of list(adapter.collectTimelines?.(), "collectTimelines")) {
          if (invalid("timeline", tl, timelineProblems(tl))) continue;
          timelines.push({
            uid: `${adapter.name}:${tl.id}`,
            source: adapter.name,
            name: tl.name ?? null,
            startTime: tl.startTime ?? null,
            duration: finite(tl.duration),
            iterations: Number.isFinite(tl.iterations) ? tl.iterations : "infinite",
            direction: tl.direction,
            playbackRate: tl.playbackRate,
            playState: tl.playState,
            progress: tl.progress ?? null,
            labels: [...tl.labels].sort((x, y) => x.time - y.time),
            provenance: { ...(tl.provenance ?? {}) },
            notes: [...(tl.notes ?? [])],
            meta: { ...(tl.meta ?? {}) },
          });
        }
        for (const track of list(adapter.collectScroll?.(), "collectScroll")) {
          if (invalid("scroll track", track, scrollTrackProblems(track))) continue;
          if (track.wrapper) adapterWrappers.add(track.wrapper);
          scrollTracks.push({
            source: adapter.name === "lenis" ? "lenis" : "native",
            sessionId: String(track.sessionId),
            axis: track.axis,
            wrapper: track.wrapper ? identifyElement(track.wrapper, null, config) : null,
            config: { ...track.config },
            prefersReducedMotion: track.prefersReducedMotion,
            samples: track.samples.map(({ t, ...state }) => ({ ...state, time: t })),
            events: track.events,
            notes: [...(track.notes ?? [])],
            meta: { ...(track.meta ?? {}) },
          });
        }
        finish();
      } catch (error) {
        failedAdapters.add(adapter.name);
        notes.push({
          level: "warning",
          code: "ADAPTER_COLLECT_FAILED",
          message: `Adapter "${adapter.name}" failed to collect: ${String(error)}`,
        });
      }
    }
    const native = nativeScrollTrack(scrollTracks);
    if (native) scrollTracks.push(native);
    scrollTracks.push(...containerScrollTracks(adapterWrappers));
    const firstTrigger = triggers[0];
    const motionRequested = triggers.some((t) => t.type === "scroll-motion");
    for (let i = scrollTracks.length - 1; i >= 0; i--) {
      const track = scrollTracks[i]!;
      // Movement before the first interaction belongs to the previous state (like animations).
      if (firstTrigger) {
        let firstKept = 0;
        for (let k = 0; k < track.samples.length; k++)
          if (track.samples[k]!.time < firstTrigger.time - 17) firstKept = k;
        track.samples = track.samples.slice(firstKept);
      }
      // Instant positioning (a one-frame jump) is a state change, not scroll motion, unless the
      // step was a scroll-motion step whose scrolling is under test.
      const run = longestMovingRun(track.samples);
      if (run === 0 || (run < 2 && !motionRequested)) scrollTracks.splice(i, 1);
    }

    // Origin: the first animation start in this window. When an interaction triggered the window,
    // the trigger-to-motion latency is reported separately (it carries input/frame jitter).
    const trigger = triggers[0];
    if (trigger) {
      // Animations that began before the first interaction belong to the previous state
      // (e.g. a page-load spinner); keep the checkpoint focused on what the interaction caused.
      const before = records.filter((r) => {
        const ext = recordExtent(r);
        return ext !== null && ext.start < trigger.time - 17;
      });
      if (before.length) {
        notes.push({
          level: "info",
          code: "PRE_TRIGGER_ANIMATIONS",
          message: `${before.length} animation(s) started before the first interaction and are not part of this checkpoint. Add a capture step before the interaction to record them.`,
        });
        for (const r of before) records.splice(records.indexOf(r), 1);
      }
    }
    // Earliest start of any record's interval (for reversed playback that is not its local zero).
    const starts = records
      .map((r) => recordExtent(r)?.start ?? null)
      .filter((s): s is number => s !== null);
    const animationStart = starts.length ? Math.min(...starts) : null;
    // Scroll movement is motion too: a scroll that triggers a reveal half-way starts the window.
    const firstScrollMove = scrollMovementStart(scrollTracks);
    const motionStart =
      animationStart === null
        ? firstScrollMove
        : firstScrollMove === null
          ? animationStart
          : Math.min(animationStart, firstScrollMove);
    let origin: WindowOrigin;
    if (trigger) {
      // The interaction that caused the motion is the last one at or before it, not the window's
      // first: in "scrollIntoView, waitForAnimations, click" the click reveals the content, and
      // measuring from the scroll would add the settle wait (and its jitter) to the latency.
      // Engines may backdate a start slightly (Anime.js advances new animations by 12 ms), so the
      // same one-frame tolerance as the pre-trigger filter applies.
      const cause =
        motionStart === null
          ? trigger
          : (triggers.findLast((t) => t.time <= motionStart + 17) ?? trigger);
      origin = {
        kind: "trigger",
        time: motionStart ?? trigger.time,
        trigger: {
          step: cause.step,
          type: cause.type,
          ...(cause.event ? { event: cause.event } : {}),
        },
        latency:
          motionStart !== null && motionStart >= cause.time - 17
            ? round3(Math.max(0, motionStart - cause.time))
            : null,
      };
    } else {
      origin =
        motionStart !== null
          ? { kind: "motion-start", time: motionStart, latency: null }
          : { kind: "navigation", time: windowOpenedAt, latency: null };
    }
    for (const r of records) {
      if (r.startTime !== null) r.startTime = round3(r.startTime - origin.time);
      for (const p of r.progressTrace) p.time = round3(p.time - origin.time);
    }
    for (const tl of timelines)
      if (tl.startTime !== null) tl.startTime = round3(tl.startTime - origin.time);
    let scrollEnd = 0;
    for (const track of scrollTracks) {
      // Keep the last still sample before the window origin so curves start from rest, and never
      // one after the movement began: with 1 ms timers (Firefox, WebKit) the last still sample
      // and the first moved one can share a timestamp, and keeping the moved one dropped the
      // rest position (the scroll then seemed to start a frame's distance later).
      let firstMoved = track.samples.length;
      for (let i = 1; i < track.samples.length; i++) {
        if (moved(track.samples[i]!, track.samples[i - 1]!)) {
          firstMoved = i;
          break;
        }
      }
      let firstKept = 0;
      for (let i = 0; i < firstMoved; i++) if (track.samples[i]!.time <= origin.time) firstKept = i;
      // The kept rest sample is re-stamped to the origin: the scroller sat still until then.
      track.samples = track.samples.slice(firstKept).map((sample) => ({
        ...sample,
        time: round3(Math.max(sample.time, origin.time) - origin.time),
      }));
      const lastMove = lastMovementTime(track);
      if (lastMove !== null) scrollEnd = Math.max(scrollEnd, lastMove);
    }

    let end = scrollEnd;
    for (const r of records) {
      const ext = recordExtent(r);
      if (ext) end = Math.max(end, ext.end);
      // A scroll-linked animation moves until its observed progress last changed (a
      // ScrollTrigger with toggleActions plays on after the scroll stopped).
      else if (r.progressTrace.length > 1) end = Math.max(end, r.progressTrace.at(-1)!.time);
    }
    const capped = end > config.maxWindowMs;
    end = Math.max(0, Math.min(end, config.maxWindowMs));

    records.sort((a, b) => {
      const sa = a.startTime ?? Number.POSITIVE_INFINITY;
      const sb = b.startTime ?? Number.POSITIVE_INFINITY;
      if (Math.abs(sa - sb) > 0.5) return sa - sb;
      return (
        a.element.key.localeCompare(b.element.key) ||
        a.type.localeCompare(b.type) ||
        String(a.name).localeCompare(String(b.name))
      );
    });

    lastCollect = {
      origin,
      animations: records,
      timelines,
      scrollTracks,
      end: round3(end),
      capped,
      scroll: { x: win.scrollX, y: win.scrollY },
      diagnostics: notes,
    };
    return lastCollect;
  }

  // ------------------------------------------------------------------------------------------
  // Replay
  // ------------------------------------------------------------------------------------------

  function retarget(record: RawAnimation, original: Element | null): Element | null {
    if (original?.isConnected) return original;
    if (!record.element.selector) return null;
    // Selectors of elements in shadow roots chain through their hosts (`host >> inner`).
    const replacement = shadow.query(record.element.selector);
    if (replacement) {
      record.notes.push(
        "Original element was replaced in the DOM; replayed on the element now matching its selector.",
      );
      return replacement;
    }
    return null;
  }

  function beginReplay(): void {
    if (!lastCollect) collect();
    const collected = lastCollect!;
    if (replay) endReplay();
    replaying = true;
    const entries: ReplayEntry[] = [];
    const saved: SavedState[] = [];
    const byUid = new Map<string, Tracked>();
    for (const t of tracked.values()) byUid.set(t.uid, t);
    const windowAnims = new Set<Animation>();

    for (const record of collected.animations) {
      const entry = byUid.get(record.uid);
      if (!entry) continue;
      windowAnims.add(entry.anim);
      const effect = entry.anim.effect as KeyframeEffect;
      const target = retarget(record, effect.target);
      let clone: Animation | null = null;
      if (record.samplable && target) {
        const frames = effect.getKeyframes().map((kf) => {
          const copy: Record<string, unknown> = { ...kf };
          delete copy.computedOffset;
          if (copy.composite === "auto") delete copy.composite;
          return copy as Keyframe;
        });
        const timing = effect.getTiming();
        clone = nativeAnimate.call(target, frames, {
          ...timing,
          composite: effect.composite,
          ...(effect.pseudoElement ? { pseudoElement: effect.pseudoElement } : {}),
        } as KeyframeAnimationOptions);
        clones.add(clone);
        clone.pause();
      }
      entries.push({
        record,
        native: true,
        startAbs: record.startTime === null ? null : record.startTime + collected.origin.time,
        startWindow: record.startTime,
        rate: entry.anim.playbackRate || 1,
        clone,
        target,
        pseudo: effect.pseudoElement,
        canceledAt: entry.canceledAt,
      });
    }
    for (const record of collected.animations) {
      if (byUid.has(record.uid)) continue;
      entries.push({
        record,
        native: false,
        startAbs: record.startTime === null ? null : record.startTime + collected.origin.time,
        startWindow: record.startTime,
        rate: record.timing.playbackRate || 1,
        clone: null,
        target: null,
        pseudo: null,
        canceledAt: null,
      });
    }

    // Freeze everything else so frames are deterministic, and neutralize window originals.
    for (const anim of allAnimations()) {
      if (clones.has(anim)) continue;
      const state = anim.playState;
      const isWindow = windowAnims.has(anim);
      const effect = anim.effect instanceof win.KeyframeEffect ? anim.effect : null;
      const fill = effect?.getTiming().fill;
      if (state === "running" || anim.pending) {
        const record: SavedState = {
          anim,
          currentTime: typeof anim.currentTime === "number" ? anim.currentTime : null,
          wasRunning: true,
        };
        anim.pause();
        const iterations = effect?.getTiming().iterations;
        if (!isWindow && iterations === Infinity) anim.currentTime = 0;
        saved.push(record);
      } else if (
        isWindow &&
        state === "finished" &&
        effect &&
        (fill === "forwards" || fill === "both")
      ) {
        // A finished fill-forwards original would leak its end value into the clone's delay phase.
        saved.push({ anim, currentTime: null, wasRunning: false, fill });
        effect.updateTiming({ fill: "none" });
      }
    }

    for (const adapter of adapters) adapter.beginReplay?.();
    replay = { entries, saved, origin: collected.origin.time };
  }

  function seek(windowTime: number): void {
    if (!replay) beginReplay();
    const r = replay!;
    const abs = r.origin + windowTime;
    for (const e of r.entries) {
      if (!e.clone || e.startWindow === null) continue;
      const effect = e.clone.effect as KeyframeEffect;
      if (e.canceledAt !== null && abs >= e.canceledAt) {
        effect.target = null;
        continue;
      }
      if (effect.target === null && e.target) effect.target = e.target;
      // Computed from window-relative times and rounded to 1 µs: subtracting two absolute clock
      // readings leaves float error that lands just below step() boundaries, and Firefox
      // resolves such times to the previous step (so the same build could sample differently).
      e.clone.currentTime = round3((windowTime - e.startWindow) * e.rate);
    }
    for (const adapter of adapters) {
      try {
        adapter.seek?.(abs);
      } catch (error) {
        diagnostics.push({
          level: "warning",
          code: "ADAPTER_SEEK_FAILED",
          message: `Adapter "${adapter.name}" failed to seek: ${String(error)}`,
        });
      }
    }
  }

  function readSample(e: ReplayEntry, t: number, local: number): RawSample {
    const target = e.target ?? null;
    const values: Record<string, string> = {};
    let box: RawSample["box"] = null;
    if (target?.isConnected) {
      const style = win.getComputedStyle(target, e.pseudo ?? undefined);
      for (const p of new Set([...e.record.properties, "transform", "opacity"])) {
        // Adapters report SVG attributes as `attr:<name>` and DOM properties as `prop:<name>`.
        if (p.startsWith("attr:")) {
          const v = target.getAttribute(p.slice(5));
          if (v !== null) values[p] = v;
          continue;
        }
        if (p.startsWith("prop:")) {
          const v = (target as unknown as Record<string, unknown>)[p.slice(5)];
          if (typeof v === "number" || typeof v === "string") values[p] = String(v);
          continue;
        }
        const v = style.getPropertyValue(p);
        if (v !== "") values[p] = v;
      }
      const rect = target.getBoundingClientRect();
      box = {
        x: round3(rect.x),
        y: round3(rect.y),
        width: round3(rect.width),
        height: round3(rect.height),
      };
    }
    const progress = e.clone
      ? (e.clone.effect as KeyframeEffect).getComputedTiming().progress
      : null;
    return {
      t: round3(t),
      local: round3(local),
      values,
      box,
      iterationProgress: typeof progress === "number" ? round6(progress) : null,
    };
  }

  function sample(count: number): RawSample[][] {
    if (!replay) beginReplay();
    const r = replay!;
    const out: RawSample[][] = [];
    for (const e of r.entries) {
      const rec = e.record;
      const series: RawSample[] = [];
      if (!e.native && rec.samplable && !e.target) {
        e.target = adapterTarget(rec);
      }
      const iteration = rec.timing.duration ?? 0;
      const active =
        rec.timing.activeDuration ?? (rec.timing.iterations === "infinite" ? iteration : 0);
      if (rec.samplable && rec.startTime !== null && active > 0 && (e.clone || !e.native)) {
        for (let k = 0; k < count; k++) {
          // The last sample sits just inside the active phase so it shows the final keyframe.
          const local = rec.timing.delay + Math.min(active * (k / (count - 1)), active - 0.01);
          const t = rec.startTime + local / e.rate;
          seek(t);
          series.push(readSample(e, t, local));
        }
      } else if (rec.samplable && rec.startTime === null && rec.scrollRange && !e.native) {
        series.push(...sampleScrollLinked(e, rec.scrollRange, active, count));
      }
      out.push(series);
    }
    return out;
  }

  /**
   * Samples a scroll-linked animation over the part of its scroll range the page showed in this
   * window: evenly spaced progress values between the lowest and highest observed progress
   * (within the animation's own range), each rendered through the adapter. Scroll is not
   * replayed; the progress values are the recorded ones.
   */
  function sampleScrollLinked(
    e: ReplayEntry,
    range: { from: number; to: number },
    active: number,
    count: number,
  ): RawSample[] {
    const rec = e.record;
    const source = adapterSources.get(rec.uid);
    const trace = rec.progressTrace;
    if (!source?.adapter.seekProgress || trace.length < 2 || count < 2) return [];
    let lo = Number.POSITIVE_INFINITY;
    let hi = Number.NEGATIVE_INFINITY;
    for (const p of trace) {
      lo = Math.min(lo, p.progress);
      hi = Math.max(hi, p.progress);
    }
    lo = Math.max(lo, range.from);
    hi = Math.min(hi, range.to);
    if (!(hi - lo > 1e-4)) return [];
    const span = range.to - range.from;
    const series: RawSample[] = [];
    for (let k = 0; k < count; k++) {
      const progress = round6(lo + ((hi - lo) * k) / (count - 1));
      // When the page first showed this progress (never before the window origin: nothing
      // moved before it), so the other animations are rendered as they were at that moment.
      const t = Math.max(0, firstReached(trace, progress));
      seek(t);
      try {
        source.adapter.seekProgress(source.id, progress);
      } catch (error) {
        diagnostics.push({
          level: "warning",
          code: "ADAPTER_SEEK_FAILED",
          message: `Adapter "${source.adapter.name}" failed to seek ${rec.uid} by progress: ${String(error)}`,
        });
        return [];
      }
      const local = rec.timing.delay + (active * (progress - range.from)) / span;
      series.push({ ...readSample(e, t, local), scrollProgress: progress });
    }
    return series;
  }

  /** Window time at which a progress trace first reached `progress` (it changes in steps). */
  function firstReached(
    trace: readonly { time: number; progress: number }[],
    progress: number,
  ): number {
    const eps = 1e-6;
    if (Math.abs(trace[0]!.progress - progress) <= eps) return trace[0]!.time;
    for (let i = 1; i < trace.length; i++) {
      const a = trace[i - 1]!.progress;
      const b = trace[i]!.progress;
      if ((a < progress && b >= progress - eps) || (a > progress && b <= progress + eps))
        return trace[i]!.time;
    }
    return trace[trace.length - 1]!.time;
  }

  const adapterTargets = new Map<string, Element>();
  /** Raw record uid → the adapter that reported it and the adapter's own id. */
  const adapterSources = new Map<string, { adapter: MotionprAdapter; id: string }>();
  function adapterTarget(rec: RawAnimation): Element | null {
    const el = adapterTargets.get(rec.uid);
    if (el) return el;
    if (!rec.element.selector) return null;
    return shadow.query(rec.element.selector);
  }

  function endReplay(): void {
    if (!replay) return;
    for (const e of replay.entries) e.clone?.cancel();
    for (const s of replay.saved) {
      if (s.fill) {
        (s.anim.effect as KeyframeEffect).updateTiming({ fill: s.fill });
        continue;
      }
      if (s.currentTime !== null) s.anim.currentTime = s.currentTime;
      if (s.wasRunning) s.anim.play();
    }
    for (const adapter of adapters) {
      try {
        adapter.endReplay?.();
      } catch (error) {
        diagnostics.push({
          level: "warning",
          code: "ADAPTER_RESTORE_FAILED",
          message: `Adapter "${adapter.name}" failed to restore: ${String(error)}`,
        });
      }
    }
    replay = null;
    replaying = false;
  }

  // ------------------------------------------------------------------------------------------
  // Pending state & windows
  // ------------------------------------------------------------------------------------------

  function pending(): PendingState {
    poll();
    let finiteCount = 0;
    let infinite = 0;
    const running: string[] = [];
    for (const anim of allAnimations()) {
      if (clones.has(anim)) continue;
      if (anim.playState !== "running" && !anim.pending) continue;
      const effect = anim.effect;
      const target = effect instanceof win.KeyframeEffect ? effect.target : null;
      if (isIgnoredTarget(target)) continue;
      if (timelineKind(anim) !== "document") continue;
      if (effect?.getTiming().iterations === Infinity) {
        infinite++;
        continue;
      }
      finiteCount++;
      if (running.length < 8) {
        const type = nativeType(anim);
        running.push(
          `${type} "${nativeName(anim, type) ?? "anonymous"}" on ${target ? identifyElement(target, null, config).key : "unknown"}`,
        );
      }
    }
    for (const adapter of adapters) {
      try {
        if (adapter.isAnimating?.()) {
          finiteCount++;
          running.push(`${adapter.name} animation(s)`);
        }
        for (const s of adapter.scrollStates?.() ?? []) {
          const key = `${adapter.name} ${s.sessionId}`;
          const prev = lastPendingScroll.get(key);
          lastPendingScroll.set(key, s.state.animatedScroll);
          const gap = Math.abs(s.state.targetScroll - s.state.animatedScroll);
          // A smooth scroll in progress keeps moving; one that claims to scroll without moving
          // is stalled (e.g. nobody calls lenis.raf()) and must not block the capture.
          const advancing =
            s.state.isScrolling === "smooth" &&
            prev !== undefined &&
            Math.abs(s.state.animatedScroll - prev) > 0.001;
          if (!s.state.isStopped && (advancing || gap > 0.5)) {
            finiteCount++;
            running.push(`${key} scrolling (${round3(gap)}px to go)`);
          }
        }
      } catch {
        // adapter errors surface through collect()
      }
    }
    if (!replaying && now() - lastNativeMove < NATIVE_QUIET_MS && lastNativeMove > windowOpenedAt) {
      finiteCount++;
      running.push("native scrolling");
    }
    return { finite: finiteCount, infinite, running };
  }

  function waitForSettle(timeoutMs: number, quietMs: number): Promise<SettleResult> {
    const started = now();
    return new Promise((resolve) => {
      let frames = 0;
      const check = () => {
        frames++;
        const state = pending();
        const elapsed = now() - started;
        const quiet = now() - Math.max(lastDiscoveryAt, started) >= quietMs;
        if (frames >= 2 && state.finite === 0 && quiet) {
          resolve({ settled: true, waited: round3(elapsed), pending: state });
        } else if (elapsed >= timeoutMs) {
          resolve({ settled: false, waited: round3(elapsed), pending: state });
        } else {
          win.requestAnimationFrame(check);
        }
      };
      win.requestAnimationFrame(check);
    });
  }

  /**
   * Forgets animations of past windows that are no longer running, so long scenarios do not
   * retain every Animation (and its target element) ever created. A pruned animation that is
   * played again is simply tracked anew.
   */
  function pruneTracked(): void {
    for (const [anim, entry] of tracked) {
      if (entry.window >= windowIndex) continue;
      if (anim.playState === "running" || anim.pending) continue;
      tracked.delete(anim);
    }
  }

  function openWindow(): void {
    windowIndex++;
    pruneTracked();
    windowOpenedAt = now();
    triggers = [];
    pendingTrigger = null;
    lastCollect = null;
    nativeScroll = [{ t: windowOpenedAt, x: win.scrollX, y: win.scrollY }];
    containers = new Map();
    scannedAt = new WeakMap();
    scanContainers();
    for (const adapter of adapters) {
      try {
        adapter.beginWindow?.();
      } catch (error) {
        failedAdapters.add(adapter.name);
        diagnostics.push({
          level: "warning",
          code: "ADAPTER_WINDOW_FAILED",
          message: `Adapter "${adapter.name}" failed to open a window: ${String(error)}`,
        });
      }
    }
  }

  function scrollAdapters(): MotionprAdapter[] {
    return adapters.filter((a) => typeof a.scrollTo === "function");
  }

  /**
   * The element a step names: passed in (the runner resolves step selectors with Playwright, as
   * for clicks) or a MotionPR selector, which chains into shadow roots with `>>`.
   */
  function stepElement(target: Element | string): Element {
    if (typeof target !== "string") return target;
    const el = shadow.query(target);
    if (!el) throw new Error(`No element matches ${target}`);
    return el;
  }

  function smoothScrollTo(request: SmoothScrollRequest): { via: "lenis" | "native" } {
    const targetEl = typeof request.target === "number" ? null : stepElement(request.target);
    if (request.via !== "native" && !request.selector) {
      for (const adapter of scrollAdapters()) {
        const handled = adapter.scrollTo!(targetEl ?? (request.target as number), {
          immediate: request.behavior === "instant",
          ...(request.offset !== null ? { offset: request.offset } : {}),
        });
        if (handled) return { via: "lenis" };
      }
      if (request.via === "lenis")
        throw new Error(
          "scrollTo via lenis: no Lenis instance is attached (call motionprLenis.attach(lenis)).",
        );
    }
    const container = request.selector ? stepElement(request.selector) : null;
    if (container) watchContainer(container);
    const el = container ?? scrollingElement();
    const horizontal = request.axis === "horizontal";
    let position: number;
    if (targetEl) {
      const rect = targetEl.getBoundingClientRect();
      const base = container ? container.getBoundingClientRect() : { top: 0, left: 0 };
      position = horizontal
        ? rect.left - base.left + el.scrollLeft
        : rect.top - base.top + el.scrollTop;
    } else {
      position = request.target as number;
    }
    position += request.offset ?? 0;
    el.scrollTo({
      ...(horizontal ? { left: position } : { top: position }),
      behavior: (request.behavior === "instant" ? "instant" : "smooth") as ScrollBehavior,
    });
    return { via: "native" };
  }

  function waitForScrollSettled(options: ScrollSettleOptions): Promise<ScrollSettleResult> {
    const started = now();
    return new Promise((resolve) => {
      const last = new Map<string, ScrollState>();
      /** Scrollers whose engine reports scrolling while they have not moved at all. */
      const claimsScrolling = new Map<string, boolean>();
      let stableSince: number | null = null;
      let stableCount = 0;
      let samples = 0;
      const read = (): Map<string, ScrollState> => {
        const states = new Map<string, ScrollState>();
        const el = scrollingElement();
        for (const axis of ["vertical", "horizontal"] as const) {
          const pos = axis === "vertical" ? win.scrollY : win.scrollX;
          states.set(`native document (${axis})`, {
            actualScroll: pos,
            animatedScroll: pos,
            targetScroll: pos,
            progress: 0,
            velocity: 0,
            direction: 0,
            isScrolling: false,
            isStopped: false,
            limit:
              axis === "vertical"
                ? el.scrollHeight - win.innerHeight
                : el.scrollWidth - win.innerWidth,
          });
        }
        // Containers that scrolled in this window or that a step is scrolling.
        for (const track of containers.values()) {
          if (track.events === 0 && !track.watched) continue;
          const box = track.el;
          for (const axis of ["vertical", "horizontal"] as const) {
            const pos = axis === "vertical" ? box.scrollTop : box.scrollLeft;
            states.set(`native ${containerKey(track)} (${axis})`, {
              actualScroll: pos,
              animatedScroll: pos,
              targetScroll: pos,
              progress: 0,
              velocity: 0,
              direction: 0,
              isScrolling: false,
              isStopped: false,
              limit:
                axis === "vertical"
                  ? box.scrollHeight - box.clientHeight
                  : box.scrollWidth - box.clientWidth,
            });
          }
        }
        for (const adapter of adapters) {
          try {
            for (const s of adapter.scrollStates?.() ?? [])
              states.set(`${adapter.name} ${s.sessionId} (${s.axis})`, s.state);
          } catch {
            // surfaced by collect()
          }
        }
        return states;
      };
      /**
       * Position of each scroller when the current still streak began. Stillness is judged by
       * the drift since then, not by per-frame steps: Firefox and WebKit report fractional
       * scroll positions, so the tail of an ease-out moves well under `threshold` per frame for
       * many frames (Chromium rounds `scrollY` to whole pixels, which hid this).
       */
      const anchors = new Map<string, number>();
      const check = () => {
        samples++;
        const t = now();
        const states = read();
        const moving: string[] = [];
        for (const [key, state] of states) {
          const prev = last.get(key);
          const delta = prev ? Math.abs(state.animatedScroll - prev.animatedScroll) : 0;
          if (!anchors.has(key)) anchors.set(key, state.animatedScroll);
          const drift = Math.abs(state.animatedScroll - anchors.get(key)!);
          const gap = Math.abs(state.targetScroll - state.animatedScroll);
          // A smooth-scroll engine still easing out moves less than `threshold` per frame but is
          // not done; it counts as moving while it reports scrolling *and* actually moves.
          const easing = state.isScrolling === "smooth" && delta > 0.001;
          // A stopped engine (lenis.stop()) does not move, whatever its target says.
          if (
            !state.isStopped &&
            (delta > options.threshold ||
              drift > options.threshold ||
              gap > options.threshold ||
              easing)
          )
            moving.push(
              `${key} Δ${round3(delta)}px (${round3(drift)}px drift), ${round3(gap)}px from target`,
            );
          if (prev)
            claimsScrolling.set(
              key,
              // Only a *smooth* scroll can stall; Lenis reports "native" for a while after
              // native scrolling (e.g. scrollIntoView) without anything being wrong.
              (claimsScrolling.get(key) ?? true) &&
                state.isScrolling === "smooth" &&
                !state.isStopped &&
                delta === 0,
            );
          last.set(key, state);
        }
        if (samples > 1 && moving.length === 0) {
          stableCount++;
          stableSince ??= t;
        } else {
          stableCount = 0;
          stableSince = null;
          for (const [key, state] of states) anchors.set(key, state.animatedScroll);
        }
        const elapsed = t - started;
        if (
          stableCount >= options.stableFrames &&
          stableSince !== null &&
          t - stableSince >= options.minStableMs
        ) {
          const stalled = [...claimsScrolling].filter(([, v]) => v).map(([k]) => k);
          resolve({ settled: true, waited: round3(elapsed), samples, moving: [], stalled });
        } else if (elapsed >= options.timeout) {
          resolve({ settled: false, waited: round3(elapsed), samples, moving, stalled: [] });
        } else {
          win.requestAnimationFrame(check);
        }
      };
      win.requestAnimationFrame(check);
    });
  }

  const text = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

  /** Capabilities an adapter declared, as strings (anything else is the conformance suite's). */
  function capabilityList(adapter: MotionprAdapter): string[] {
    const declared: unknown = adapter.capabilities;
    return Array.isArray(declared)
      ? declared.filter((c): c is string => typeof c === "string")
      : [];
  }

  function adapterStatus(): RawAdapterStatus[] {
    const registered = adapters.map((adapter): RawAdapterStatus => {
      const messages: RawDiagnostic[] = [];
      try {
        const reported: unknown = adapter.diagnostics?.() ?? [];
        if (!Array.isArray(reported))
          throw new TypeError(
            `diagnostics() must return an array; got ${describeValue(reported)}.`,
          );
        let invalid = 0;
        for (const d of reported) {
          if (diagnosticProblems(d).length) invalid++;
          else {
            const { level, code, message } = d as RawDiagnostic;
            messages.push({ level, code, message });
          }
        }
        if (invalid)
          messages.push({
            level: "warning",
            code: "ADAPTER_DIAGNOSTICS_INVALID",
            message: `Adapter "${adapter.name}" reported ${invalid} malformed diagnostic${invalid === 1 ? "" : "s"} (each needs a level of info, warning or error, a code and a message); left out.`,
          });
      } catch (error) {
        messages.push({
          level: "warning",
          code: "ADAPTER_DIAGNOSTICS_FAILED",
          message: `Adapter "${adapter.name}" failed to report diagnostics: ${String(error)}`,
        });
      }
      return {
        id: adapter.name,
        protocol: declaredProtocol(adapter),
        engineVersion: text(adapter.version),
        supportedRange: text(adapter.supportedRange),
        capabilities: capabilityList(adapter),
        failed: failedAdapters.has(adapter.name),
        diagnostics: messages,
      };
    });
    return [
      ...registered,
      ...rejectedAdapters.map((r) => ({ ...r, diagnostics: [...r.diagnostics] })),
    ];
  }

  const api: MotionprAgentApi = {
    version: typeof __MOTIONPR_VERSION__ === "string" ? __MOTIONPR_VERSION__ : "dev",
    protocol: PROTOCOL_VERSION,
    registerAdapter(adapter) {
      if (!adapter || typeof adapter.name !== "string" || typeof adapter.collect !== "function") {
        throw new TypeError("MotionPR: an adapter needs a name and a collect() function.");
      }
      if (adapters.some((a) => a.name === adapter.name)) return;
      if (rejectedAdapters.some((a) => a.id === adapter.name)) return;
      const protocol = declaredProtocol(adapter);
      if (protocol === null) {
        // A newer adapter may rely on agent behaviour this version lacks: not registered.
        rejectedAdapters.push({
          id: adapter.name,
          protocol: null,
          engineVersion: text(adapter.version),
          supportedRange: text(adapter.supportedRange),
          capabilities: capabilityList(adapter),
          failed: true,
          diagnostics: [
            {
              level: "error",
              code: "ADAPTER_PROTOCOL_UNSUPPORTED",
              message: `Adapter "${adapter.name}" implements adapter protocol ${describeValue(adapter.protocol)}; this MotionPR (agent ${api.version}) supports protocols ${SUPPORTED_PROTOCOLS.join(" and ")}. The adapter was not registered.`,
            },
          ],
        });
        return;
      }
      adapters.push(adapter);
      try {
        adapter.beginWindow?.();
      } catch {
        failedAdapters.add(adapter.name);
      }
    },
    unregisterAdapter(adapter) {
      const index = adapters.indexOf(adapter);
      if (index !== -1) adapters.splice(index, 1);
    },
    adapters: () =>
      adapters.map((a) => ({ name: a.name, ...(text(a.version) ? { version: a.version } : {}) })),
    configure(partial) {
      Object.assign(config, partial);
    },
    beginStep(index, type) {
      // Before the trigger time: the scan's own duration is not part of the latency.
      if (type !== "none" && type !== "navigation") scanContainers();
      const trigger: Trigger = { step: index, type, time: now() };
      pendingTrigger = trigger;
      if (type !== "none" && type !== "navigation") triggers.push(trigger);
    },
    openWindow,
    pending,
    collect,
    beginReplay,
    seek,
    sample,
    endReplay,
    identify: (el) => identifyElement(el, null, config),
    async fontStatus(timeoutMs) {
      const timer = new Promise<"timeout">((r) => setTimeout(() => r("timeout"), timeoutMs));
      const state = await Promise.race([doc.fonts.ready.then(() => "ready" as const), timer]);
      const faces = Array.from(doc.fonts as unknown as Iterable<FontFace>);
      return {
        state,
        failed: [...new Set(faces.filter((f) => f.status === "error").map((f) => f.family))],
        loading: [...new Set(faces.filter((f) => f.status === "loading").map((f) => f.family))],
      };
    },
    async pendingImages(timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      const incomplete = () => {
        const images: HTMLImageElement[] = Array.from(doc.images);
        for (const root of shadow.roots()) images.push(...root.querySelectorAll("img"));
        return images.filter((img) => img.loading !== "lazy" && !img.complete).length;
      };
      while (incomplete() > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
      return incomplete();
    },
    scrollTo(container, x, y) {
      const target = container ? stepElement(container) : null;
      const el = target ?? doc.scrollingElement ?? doc.documentElement;
      el.scrollTo({
        left: x ?? el.scrollLeft,
        top: y ?? el.scrollTop,
        behavior: "instant" as ScrollBehavior,
      });
    },
    scrollPosition: () => ({ x: win.scrollX, y: win.scrollY }),
    smoothScrollTo,
    waitForScrollSettled,
    adapterStatus,
    stats: () => ({
      tracked: tracked.size,
      nativeScrollSamples: nativeScroll.length,
      scrollContainers: containers.size,
      shadowRoots: shadow.roots().length,
      adapters: adapters.length,
      window: windowIndex,
    }),
    waitForSettle,
    windowIndex: () => windowIndex,
    capabilities,
  };

  /**
   * Measures what this engine offers MotionPR. Firefox and WebKit coarsen `performance.now()`
   * (privacy protections), and headless engines may render below 60 Hz; both shape how precise
   * live observations (start times, scroll samples) can be, so captures record them.
   */
  async function capabilities(): Promise<RawCapabilities> {
    const w = win as unknown as Record<string, unknown>;
    let resolution = Number.POSITIVE_INFINITY;
    let last = perf.now();
    const until = last + 4;
    for (let i = 0; i < 200_000; i++) {
      const t = perf.now();
      if (t !== last) {
        resolution = Math.min(resolution, t - last);
        last = t;
      }
      if (t > until) break;
    }
    const intervals: number[] = [];
    await new Promise<void>((resolve) => {
      let prev: number | null = null;
      let frames = 0;
      const timeout = setTimeout(resolve, 1500);
      const tick = (t: number) => {
        if (prev !== null) intervals.push(t - prev);
        prev = t;
        if (++frames >= 13) {
          clearTimeout(timeout);
          resolve();
        } else win.requestAnimationFrame(tick);
      };
      win.requestAnimationFrame(tick);
    });
    intervals.sort((a, b) => a - b);
    const median = intervals.length ? intervals[Math.floor(intervals.length / 2)]! : null;
    const keyframeProto = win.KeyframeEffect?.prototype as object | undefined;
    return {
      documentGetAnimations: typeof doc.getAnimations === "function",
      elementAnimate: typeof nativeAnimate === "function",
      cssTransitionInterface: typeof w.CSSTransition === "function",
      cssAnimationInterface: typeof w.CSSAnimation === "function",
      transitionRunEvent: "ontransitionrun" in win || "ontransitionrun" in doc.documentElement,
      pseudoElementEffects: Boolean(keyframeProto && "pseudoElement" in keyframeProto),
      scrollTimeline: typeof w.ScrollTimeline === "function",
      viewTimeline: typeof w.ViewTimeline === "function",
      timerResolutionMs: Number.isFinite(resolution) ? round6(resolution) : null,
      frameIntervalMs: median === null ? null : round3(median),
      devicePixelRatio: typeof win.devicePixelRatio === "number" ? win.devicePixelRatio : null,
      prefersReducedMotion: win.matchMedia
        ? win.matchMedia("(prefers-reduced-motion: reduce)").matches
        : null,
      userAgent: win.navigator.userAgent,
    };
  }

  Object.defineProperty(win, "__MOTIONPR_AGENT__", {
    value: api,
    configurable: false,
    enumerable: false,
    writable: false,
  });
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}
