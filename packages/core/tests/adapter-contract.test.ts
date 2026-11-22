import { describe, expect, it } from "vitest";
import {
  ADAPTER_ANIMATION_TYPES,
  ADAPTER_CAPABILITIES,
  ADAPTER_CHECKS,
  ANIMATION_TYPES,
  CAPABILITY_METHODS,
  PROTOCOL_VERSION,
  SUPPORTED_PROTOCOLS,
  adapterProblems,
  animationProblems,
  declaredProtocol,
  diagnosticProblems,
  formatProblems,
  isVersionRange,
  scrollTrackProblems,
  timelineProblems,
  type ContractProblem,
} from "../src/index.ts";

/** A stand-in element: what `isElement` recognises (node type 1 with getAttribute). */
const element = { nodeType: 1, getAttribute: () => null } as unknown as Element;

const animation = (over: Record<string, unknown> = {}) => ({
  id: "a1",
  name: "slide",
  target: element,
  startTime: 1000,
  duration: 500,
  delay: 0,
  iterations: 1,
  direction: "normal",
  playbackRate: 1,
  easing: { value: "linear", samples: Array.from({ length: 65 }, (_, i) => i / 64) },
  properties: ["transform", "opacity", "--accent", "attr:cx", "prop:value"],
  playState: "running",
  samplable: true,
  ...over,
});

const levels = (problems: ContractProblem[]) => problems.map((p) => `${p.level} ${p.field}`);

describe("adapter protocol 2: animation entries", () => {
  it("accepts a complete entry", () => {
    expect(animationProblems(animation(), { now: 1200 })).toEqual([]);
  });

  it("marks entries that would make a capture unreadable as invalid", () => {
    expect(levels(animationProblems(animation({ duration: "500" })))).toEqual(["invalid duration"]);
    expect(levels(animationProblems(animation({ direction: "sideways" })))).toEqual([
      "invalid direction",
    ]);
    expect(levels(animationProblems(animation({ delay: Number.NaN })))).toEqual(["invalid delay"]);
    expect(levels(animationProblems(animation({ easing: "linear" })))).toEqual(["invalid easing"]);
    expect(levels(animationProblems(animation({ properties: "transform" })))).toEqual([
      "invalid properties",
    ]);
    expect(levels(animationProblems(animation({ meta: { nested: { a: 1 } } })))).toEqual([
      "invalid meta.nested",
    ]);
    expect(levels(animationProblems(animation({ target: { x: 1 } })))).toEqual(["invalid target"]);
    expect(levels(animationProblems(animation({ type: "lottie" })))).toEqual(["invalid type"]);
    expect(levels(animationProblems(animation({ provenance: { duration: "guessed" } })))).toEqual([
      "invalid provenance.duration",
    ]);
    expect(levels(animationProblems(animation({ id: "" })))).toEqual(["invalid id"]);
    expect(levels(animationProblems(null))).toEqual(["invalid "]);
  });

  it("reads missing nullable fields as null, as violations", () => {
    const { name: _n, target: _t, startTime: _s, ...rest } = animation();
    expect(levels(animationProblems(rest))).toEqual([
      "violation name",
      "violation target",
      "violation startTime",
      // Without a target or name the entry needs an objectKey to be matched.
      "advice objectKey",
    ]);
  });

  it("reports rule breaks that are recorded anyway as violations", () => {
    expect(levels(animationProblems(animation({ playState: "playing" })))).toEqual([
      "violation playState",
    ]);
    expect(levels(animationProblems(animation({ duration: -5 })))).toEqual(["violation duration"]);
    expect(levels(animationProblems(animation({ properties: ["translateX"] })))).toEqual([
      "violation properties",
    ]);
    expect(levels(animationProblems(animation({ id: 7 })))).toEqual(["violation id"]);
    expect(levels(animationProblems(animation({ scrollRange: { from: 0.8, to: 0.2 } })))).toEqual([
      "violation scrollRange",
    ]);
    expect(
      levels(
        animationProblems(animation({ scrollLink: { start: 0, end: "x", axis: "vertical" } })),
      ),
    ).toContain("violation scrollLink.end");
  });

  it("rejects start times on another clock than performance.now()", () => {
    const problems = animationProblems(animation({ startTime: Date.now() }), { now: 1200 });
    expect(levels(problems)).toEqual(["violation startTime"]);
    expect(problems[0]!.message).toContain("performance.now()");
  });

  it("advises on easing samples and empty property lists", () => {
    expect(
      levels(
        animationProblems(animation({ easing: { value: "x", samples: [0, 1] }, properties: [] })),
      ),
    ).toEqual(["advice easing.samples", "advice properties"]);
  });

  it("knows the capture schema's animation types", () => {
    expect([...ADAPTER_ANIMATION_TYPES]).toEqual([...ANIMATION_TYPES]);
  });
});

describe("adapter protocol 2: timelines, scroll tracks, diagnostics", () => {
  const timeline = {
    id: "tl",
    name: null,
    startTime: 0,
    duration: 1000,
    iterations: 1,
    direction: "normal",
    playbackRate: 1,
    playState: "finished",
    progress: 1,
    labels: [{ name: "intro", time: 0 }],
  };

  it("checks timelines", () => {
    expect(timelineProblems(timeline)).toEqual([]);
    expect(levels(timelineProblems({ ...timeline, labels: [{ name: "x" }] }))).toEqual([
      "invalid labels[0]",
    ]);
    expect(levels(timelineProblems({ ...timeline, progress: undefined }))).toEqual([
      "violation progress",
    ]);
  });

  it("checks scroll tracks and their samples", () => {
    const sample = {
      t: 10,
      actualScroll: 0,
      animatedScroll: 0,
      targetScroll: 100,
      progress: 0,
      velocity: 0,
      direction: 0,
      isScrolling: "smooth",
      isStopped: false,
      limit: 1000,
    };
    const track = {
      sessionId: "main",
      axis: "vertical",
      wrapper: null,
      config: { lerp: 0.1 },
      prefersReducedMotion: false,
      samples: [sample, { ...sample, t: 26 }],
      events: 2,
    };
    expect(scrollTrackProblems(track)).toEqual([]);
    expect(levels(scrollTrackProblems({ ...track, events: 2.5 }))).toEqual(["invalid events"]);
    expect(
      levels(scrollTrackProblems({ ...track, samples: [{ ...sample, velocity: Number.NaN }] })),
    ).toEqual(["invalid samples[0].velocity"]);
    expect(
      levels(scrollTrackProblems({ ...track, samples: [{ ...sample, t: 30 }, sample] })),
    ).toEqual(["violation samples"]);
  });

  it("checks diagnostics", () => {
    expect(diagnosticProblems({ level: "info", code: "X", message: "m" })).toEqual([]);
    expect(levels(diagnosticProblems({ level: "fatal", code: "", message: 1 }))).toEqual([
      "invalid level",
      "invalid code",
      "invalid message",
    ]);
  });

  it("formats problems as one line of messages", () => {
    expect(formatProblems(animationProblems(animation({ duration: "500", delay: null })))).toBe(
      'duration must be a finite number or null; got "500". delay must be a finite number; got null.',
    );
  });
});

describe("adapter protocol 2: the adapter object", () => {
  const adapter = {
    name: "toy",
    protocol: 2,
    version: "1.0.0",
    supportedRange: ">=1.0.0 <2.0.0",
    capabilities: ["animations", "replay"],
    collect: () => [],
    beginReplay() {},
    seek() {},
    endReplay() {},
  };

  it("is at protocol 2 and still accepts protocol 1", () => {
    expect(PROTOCOL_VERSION).toBe(2);
    expect([...SUPPORTED_PROTOCOLS]).toEqual([1, 2]);
    expect(declaredProtocol({})).toBe(1);
    expect(declaredProtocol({ protocol: 2 })).toBe(2);
    expect(declaredProtocol({ protocol: 3 })).toBeNull();
    expect(declaredProtocol({ protocol: "2" })).toBeNull();
  });

  it("accepts a complete adapter", () => {
    expect(adapterProblems(adapter)).toEqual([]);
  });

  it("refuses adapters it cannot register", () => {
    expect(levels(adapterProblems({ ...adapter, protocol: 3 }))).toEqual(["invalid protocol"]);
    expect(levels(adapterProblems({ ...adapter, name: "" }))).toEqual(["invalid name"]);
    expect(levels(adapterProblems({ ...adapter, collect: undefined }))).toEqual([
      "invalid collect",
    ]);
  });

  it("checks capabilities against the methods that implement them", () => {
    expect(levels(adapterProblems({ ...adapter, seek: undefined }))).toEqual([
      "violation capabilities",
    ]);
    expect(levels(adapterProblems({ ...adapter, isAnimating: true }))).toEqual([
      "violation isAnimating",
    ]);
    expect(
      levels(adapterProblems({ ...adapter, collectTimelines: () => [], claims: () => null })),
    ).toEqual(["advice capabilities", "advice capabilities"]);
    expect(
      levels(adapterProblems({ ...adapter, capabilities: ["animations", "physics"] })),
    ).toEqual(["violation capabilities", "advice capabilities"]);
  });

  it("advises declaring the protocol and metadata", () => {
    const { protocol: _p, version: _v, supportedRange: _r, capabilities: _c, ...bare } = adapter;
    expect(levels(adapterProblems(bare))).toEqual([
      "advice protocol",
      "advice version",
      "advice supportedRange",
      "advice capabilities",
    ]);
    expect(levels(adapterProblems({ ...adapter, name: "native" }))).toEqual(["violation name"]);
  });

  it("names a method for every capability", () => {
    expect(Object.keys(CAPABILITY_METHODS).sort()).toEqual([...ADAPTER_CAPABILITIES].sort());
  });
});

describe("conformance suite", () => {
  it("has a stable, unique list of checks", () => {
    const ids = ADAPTER_CHECKS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids[0]).toBe("registration");
    expect(ids.at(-1)).toBe("capture");
  });

  it("reads the version ranges adapters report", () => {
    for (const range of [
      ">=3.12.0 <4.0.0",
      "^4.5.0",
      "~1.3.0",
      "1.2.3",
      ">=1 <2 || >=3.0.0-beta.1",
    ])
      expect(isVersionRange(range), range).toBe(true);
    for (const range of ["", "latest", "1.x", ">= 1.0.0", "^v"])
      expect(isVersionRange(range), range).toBe(false);
  });
});
