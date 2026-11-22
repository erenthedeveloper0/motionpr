/**
 * MotionPR adapter for Lenis smooth scrolling (`@erenthedeveloper0/motionpr/lenis`).
 *
 * Lenis is a scroll engine, not an animation timeline, so MotionPR records what it actually
 * does: the rendered (`animatedScroll`), native (`actualScroll`) and target positions, velocity,
 * direction and state, on MotionPR's monotonic clock (`performance.now()`), for every Lenis
 * `scroll` event during a checkpoint window. These become `ScrollMotionRecord`s, compared with
 * scroll-specific metrics (distance, settle time, normalized progress curve, peak velocity,
 * overshoot) rather than animation rules.
 *
 * What the adapter never does: start a RAF loop, call `lenis.raf()`, change options (easing,
 * lerp, duration), intercept input, or call `destroy()`. It adds one `scroll` listener per Lenis
 * instance through the public `on()` API and removes it with the unsubscribe function `on()`
 * returns (Lenis ≥ 1.1), falling back to `off()`. The `scrollTo` scenario step calls the
 * instance's public `scrollTo()` exactly as application code would.
 *
 * Outside a MotionPR capture (no agent in the page) `attach()` does nothing.
 */
import {
  AGENT_GLOBAL,
  PROTOCOL_VERSION,
  SUPPORTED_ENGINE_RANGES,
  type AdapterCapability,
  type AdapterDiagnostic,
  type AdapterScrollTrack,
  type MetaValue,
  type MotionprAdapter,
  type ScrollState,
} from "@motionpr/core/protocol";

/** Lenis versions this adapter is tested against. */
export const SUPPORTED_LENIS_RANGE: string = SUPPORTED_ENGINE_RANGES.lenis;
const ADAPTER_ID = "lenis";
const CAPABILITIES: readonly AdapterCapability[] = ["scroll", "scroll-control"];
/** Samples kept per instance and window (~50 s of scrolling at 60 fps). */
const MAX_SAMPLES = 3000;
/** Option names recorded as configuration (scalars only; functions become "custom"). */
const CONFIG_KEYS = [
  "lerp",
  "duration",
  "easing",
  "smoothWheel",
  "syncTouch",
  "syncTouchLerp",
  "touchInertiaExponent",
  "infinite",
  "orientation",
  "gestureOrientation",
  "wheelMultiplier",
  "touchMultiplier",
  "overscroll",
  "autoRaf",
  "autoResize",
  "respectReducedMotion",
  "allowNestedScroll",
] as const;

/** Structural view of the public Lenis API used by the adapter (Lenis 1.x). */
export interface LenisLike {
  on(event: "scroll", callback: (lenis: LenisLike) => void): (() => void) | void;
  off?(event: "scroll", callback: (lenis: LenisLike) => void): void;
  scrollTo(target: number | string | Element, options?: Record<string, unknown>): void;
  readonly actualScroll?: number;
  readonly animatedScroll: number;
  readonly targetScroll: number;
  readonly scroll?: number;
  readonly progress: number;
  readonly velocity: number;
  readonly lastVelocity?: number;
  readonly direction: number;
  readonly isScrolling: boolean | string;
  readonly isStopped?: boolean;
  readonly isHorizontal?: boolean;
  readonly limit: number;
  readonly time?: number;
  readonly prefersReducedMotion?: boolean;
  readonly options?: Record<string, unknown>;
}

export interface AttachOptions {
  /** Stable name for this scroller (default `lenis#<n>` in attach order). */
  name?: string;
  /** Attach even without a MotionPR agent in the page (tests, debugging). */
  force?: boolean;
}

export interface LenisHandle {
  /** True while MotionPR is observing this Lenis instance. */
  readonly active: boolean;
  getDiagnostics(): AdapterDiagnostic[];
  /** Removes MotionPR's scroll listener. Never destroys, stops or reconfigures Lenis. */
  dispose(): void;
}

interface Session {
  lenis: LenisLike;
  id: string;
  listener: (lenis: LenisLike) => void;
  unsubscribe: (() => void) | null;
  samples: (ScrollState & { t: number })[];
  events: number;
  window: number;
  thinned: boolean;
  disposed: boolean;
}

function lenisVersion(): string | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { lenisVersion?: unknown; lenis?: { version?: unknown } };
  const v = w.lenisVersion ?? w.lenis?.version;
  return typeof v === "string" ? v : null;
}

const num = (v: unknown, fallback = 0) =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback;

/** Reads the public state of a Lenis instance. Missing fields fall back to neutral values. */
export function readState(lenis: LenisLike): ScrollState {
  const animated = num(lenis.animatedScroll);
  return {
    actualScroll: num(lenis.actualScroll, animated),
    animatedScroll: animated,
    targetScroll: num(lenis.targetScroll, animated),
    progress: num(lenis.progress),
    velocity: num(lenis.velocity),
    direction: num(lenis.direction),
    isScrolling:
      typeof lenis.isScrolling === "string" || typeof lenis.isScrolling === "boolean"
        ? lenis.isScrolling
        : false,
    isStopped: Boolean(lenis.isStopped),
    limit: num(lenis.limit),
  };
}

function wrapperOf(lenis: LenisLike): Element | null {
  const wrapper = lenis.options?.wrapper;
  if (typeof Element !== "undefined" && wrapper instanceof Element) {
    const doc = wrapper.ownerDocument;
    return wrapper === doc.documentElement || wrapper === doc.body ? null : wrapper;
  }
  return null;
}

function configOf(lenis: LenisLike): Record<string, MetaValue> {
  const options = lenis.options ?? {};
  const out: Record<string, MetaValue> = {};
  for (const key of CONFIG_KEYS) {
    const v = options[key];
    if (v === undefined) continue;
    out[key] =
      typeof v === "function"
        ? "custom"
        : typeof v === "number" || typeof v === "string" || typeof v === "boolean" || v === null
          ? v
          : String(v);
  }
  return out;
}

class LenisAdapter implements MotionprAdapter {
  readonly name = ADAPTER_ID;
  readonly protocol = PROTOCOL_VERSION;
  readonly supportedRange = SUPPORTED_LENIS_RANGE;
  readonly capabilities = CAPABILITIES;
  readonly sessions: Session[] = [];
  readonly #byInstance = new WeakMap<LenisLike, Session>();
  readonly #diagnostics = new Map<string, AdapterDiagnostic>();
  #window = 0;
  #counter = 0;
  disposed = false;

  get version(): string | undefined {
    return lenisVersion() ?? undefined;
  }

  #diagnose(code: string, message: string, level: AdapterDiagnostic["level"] = "warning"): void {
    if (!this.#diagnostics.has(code)) this.#diagnostics.set(code, { level, code, message });
  }

  diagnostics(): AdapterDiagnostic[] {
    const out = [...this.#diagnostics.values()];
    if (!this.version)
      out.push({
        level: "info",
        code: "LENIS_VERSION_UNKNOWN",
        message: "Lenis did not publish window.lenisVersion; support status is unknown.",
      });
    for (const s of this.sessions) {
      if (s.thinned)
        out.push({
          level: "info",
          code: "LENIS_SAMPLES_THINNED",
          message: `${s.id}: more than ${MAX_SAMPLES} scroll events in one window; the middle was thinned.`,
        });
    }
    return out;
  }

  existing(lenis: LenisLike): Session | null {
    const s = this.#byInstance.get(lenis);
    return s && !s.disposed ? s : null;
  }

  attach(lenis: LenisLike, name?: string): Session {
    const known = this.existing(lenis);
    if (known) return known;
    const session: Session = {
      lenis,
      id: name ?? `lenis#${++this.#counter}`,
      listener: () => undefined,
      unsubscribe: null,
      samples: [],
      events: 0,
      window: this.#window,
      thinned: false,
      disposed: false,
    };
    session.listener = (instance: LenisLike) => {
      try {
        this.#record(session, instance ?? lenis);
      } catch (error) {
        this.#diagnose("LENIS_OBSERVE_FAILED", `Reading Lenis state failed: ${String(error)}`);
      }
    };
    const result = lenis.on("scroll", session.listener);
    session.unsubscribe =
      typeof result === "function"
        ? result
        : typeof lenis.off === "function"
          ? () => lenis.off!("scroll", session.listener)
          : null;
    if (!session.unsubscribe)
      this.#diagnose(
        "LENIS_NO_UNSUBSCRIBE",
        "This Lenis version offers no way to remove a scroll listener; MotionPR's listener stays attached (it records nothing after dispose).",
      );
    this.#byInstance.set(lenis, session);
    this.sessions.push(session);
    this.#reset(session);
    return session;
  }

  detach(session: Session): void {
    if (session.disposed) return;
    session.disposed = true;
    try {
      session.unsubscribe?.();
    } catch (error) {
      this.#diagnose("LENIS_DETACH_FAILED", `Removing the Lenis listener failed: ${String(error)}`);
    }
    this.#byInstance.delete(session.lenis);
    const index = this.sessions.indexOf(session);
    if (index !== -1) this.sessions.splice(index, 1);
    session.samples = [];
  }

  #record(session: Session, lenis: LenisLike): void {
    if (session.disposed || this.disposed) return;
    if (session.window !== this.#window) this.#reset(session);
    session.events++;
    if (session.samples.length >= MAX_SAMPLES) {
      session.samples.splice(1, 1);
      session.thinned = true;
    }
    session.samples.push({ t: performance.now(), ...readState(lenis) });
  }

  /** Starts a window with the scroller's state at rest, so curves begin where it was. */
  #reset(session: Session): void {
    session.window = this.#window;
    session.events = 0;
    session.thinned = false;
    session.samples = [{ t: performance.now(), ...readState(session.lenis) }];
  }

  beginWindow(): void {
    this.#window++;
    for (const session of this.sessions) this.#reset(session);
  }

  collect(): [] {
    return [];
  }

  collectScroll(): AdapterScrollTrack[] {
    const out: AdapterScrollTrack[] = [];
    for (const session of this.sessions) {
      if (session.window !== this.#window) this.#reset(session);
      const lenis = session.lenis;
      // Close the curve with the current (settled) state.
      const samples = [...session.samples, { t: performance.now(), ...readState(lenis) }];
      const moved = samples.some(
        (s, i) => i > 0 && Math.abs(s.animatedScroll - samples[i - 1]!.animatedScroll) > 0.01,
      );
      if (!moved && session.events === 0) continue;
      const notes: string[] = [];
      if (session.thinned)
        notes.push("Sample buffer was full; the middle of the movement was thinned.");
      if (lenis.options?.infinite)
        notes.push("Infinite scrolling: positions wrap around the limit.");
      out.push({
        sessionId: session.id,
        axis: lenis.isHorizontal ? "horizontal" : "vertical",
        wrapper: wrapperOf(lenis),
        config: configOf(lenis),
        prefersReducedMotion:
          typeof lenis.prefersReducedMotion === "boolean"
            ? lenis.prefersReducedMotion
            : typeof matchMedia === "function" &&
              matchMedia("(prefers-reduced-motion: reduce)").matches,
        samples,
        events: session.events,
        notes,
        meta: {
          ...(typeof lenis.time === "number" ? { engineTime: Math.round(lenis.time) } : {}),
          velocityUnit: "px/frame",
        },
      });
    }
    return out;
  }

  scrollStates(): { sessionId: string; axis: "vertical" | "horizontal"; state: ScrollState }[] {
    return this.sessions.map((s) => ({
      sessionId: s.id,
      axis: s.lenis.isHorizontal ? ("horizontal" as const) : ("vertical" as const),
      state: readState(s.lenis),
    }));
  }

  scrollTo(target: number | Element, options: { immediate: boolean; offset?: number }): boolean {
    const session = this.sessions[0];
    if (!session) return false;
    session.lenis.scrollTo(target, {
      immediate: options.immediate,
      ...(options.offset !== undefined ? { offset: options.offset } : {}),
    });
    return true;
  }

  dispose(): void {
    if (this.disposed) return;
    for (const session of [...this.sessions]) this.detach(session);
    this.disposed = true;
  }
}

let shared: LenisAdapter | null = null;

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

const INACTIVE: LenisHandle = Object.freeze({
  active: false,
  getDiagnostics: () => [],
  dispose: () => undefined,
});

export const motionprLenis = {
  /**
   * Starts observing a Lenis instance. Call it right after `new Lenis(...)`. Attaching the same
   * instance twice returns a handle to the existing subscription (no duplicate listeners).
   */
  attach(lenis: LenisLike, options: AttachOptions = {}): LenisHandle {
    const page = agent();
    if (!page && !options.force) return INACTIVE;
    if (!lenis || typeof lenis.on !== "function" || typeof lenis.scrollTo !== "function") {
      throw new TypeError(
        "motionprLenis.attach() expects a Lenis instance (const lenis = new Lenis(); motionprLenis.attach(lenis)).",
      );
    }
    if (!shared || shared.disposed) {
      shared = new LenisAdapter();
      page?.registerAdapter(shared);
    }
    const adapter = shared;
    const session = adapter.attach(lenis, options.name);
    return {
      get active() {
        return !session.disposed;
      },
      getDiagnostics: () => adapter.diagnostics(),
      dispose() {
        adapter.detach(session);
        if (adapter.sessions.length === 0) {
          adapter.dispose();
          agent()?.unregisterAdapter?.(adapter);
          if (shared === adapter) shared = null;
        }
      },
    };
  },

  /** True while at least one Lenis instance is attached to a capturing MotionPR agent. */
  isActive(): boolean {
    return shared !== null && !shared.disposed && shared.sessions.length > 0;
  },
};

export default motionprLenis;
