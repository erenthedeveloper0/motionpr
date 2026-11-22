import { describe, expect, it } from "vitest";
import { parseCaptureBundle, parseComparisonResult, versionSatisfies } from "../src/index.ts";

const v1Capture = {
  schemaVersion: 1,
  kind: "motionpr-capture",
  motionprVersion: "0.1.0-alpha.0",
  id: "c1",
  createdAt: "2026-11-13T00:00:00.000Z",
  project: { name: "p" },
  environment: {
    browser: { name: "chromium", version: "158", headless: true },
    platform: "darwin",
    arch: "arm64",
    node: "v24",
    playwright: "1.65.0",
    ci: false,
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
  },
  configHash: "h",
  scenarios: [
    {
      key: "s@default",
      id: "s",
      name: "s",
      path: "/",
      viewport: { name: "default", width: 800, height: 600, deviceScaleFactor: 1 },
      status: "passed",
      durationMs: 1,
      steps: [],
      failureScreenshot: null,
      diagnostics: [],
      checkpoints: [
        {
          label: "x",
          index: 0,
          kind: "capture",
          url: "http://x/",
          scroll: { x: 0, y: 0 },
          window: { origin: "navigation", latency: null, end: 0, capped: false },
          frames: [],
          frameInterval: 0,
          screenshot: null,
          diagnostics: [],
          animations: [
            {
              id: "a::css-transition::opacity",
              type: "css-transition",
              source: "native",
              name: "opacity",
              element: {
                key: "a",
                method: "test-id",
                confidence: "high",
                selector: "#a",
                tag: "div",
                warnings: [],
              },
              startTime: 0,
              timing: {
                duration: 300,
                delay: 0,
                endDelay: 0,
                iterations: 1,
                iterationStart: 0,
                direction: "normal",
                fill: "auto",
                playbackRate: 1,
                easing: { value: "ease", kind: "css", scope: "effect" },
                effectiveEasing: { value: "ease", kind: "css", scope: "effect" },
                activeDuration: 300,
                endTime: 300,
              },
              properties: [],
              samples: [],
              completeness: { status: "metadata-only", reasons: [] },
              timeline: "document",
              playState: "finished",
              group: null,
              meta: {},
            },
            {
              id: "b::gsap::hero",
              type: "gsap",
              source: "gsap",
              name: "hero",
              element: {
                key: "b",
                method: "test-id",
                confidence: "high",
                selector: "#b",
                tag: "div",
                warnings: [],
              },
              startTime: 0,
              timing: {
                duration: 300,
                delay: 0,
                endDelay: 0,
                iterations: 1,
                iterationStart: 0,
                direction: "normal",
                fill: "both",
                playbackRate: 1,
                easing: { value: "power1.out", kind: "gsap", scope: "effect" },
                effectiveEasing: { value: "power1.out", kind: "gsap", scope: "effect" },
                activeDuration: 300,
                endTime: 300,
              },
              properties: [],
              samples: [],
              completeness: { status: "metadata-only", reasons: [] },
              timeline: "adapter",
              playState: "finished",
              group: null,
              meta: {},
            },
          ],
        },
      ],
    },
  ],
  assets: {},
  diagnostics: [],
};

describe("capture schema migration v1 → v2", () => {
  it("upgrades v1 captures without inventing data", () => {
    const bundle = parseCaptureBundle(structuredClone(v1Capture));
    expect(bundle.schemaVersion).toBe(2);
    const cp = bundle.scenarios[0]!.checkpoints[0]!;
    expect(cp).toMatchObject({ timelines: [], scrollMotion: [], correlations: [] });
    expect(cp.animations.map((a) => a.driver)).toEqual(["css", "javascript"]);
    expect(
      cp.animations.every((a) => a.parent === null && Object.keys(a.provenance).length === 0),
    ).toBe(true);
    expect(bundle.scenarios[0]!.adapters).toEqual([]);
  });

  it("reads resolved scroll positions, which older captures do not have", () => {
    const upgraded = parseCaptureBundle(structuredClone(v1Capture));
    const records = () => upgraded.scenarios[0]!.checkpoints[0]!.animations;
    expect(records().every((a) => a.scrollLink === undefined)).toBe(true);
    const scrollLink = {
      start: 400,
      end: 1300,
      axis: "vertical",
      scroller: "test-id:panel",
      scrub: 500,
      toggleActions: null,
    };
    records()[1]!.scrollLink = scrollLink as never;
    const reread = parseCaptureBundle(structuredClone(upgraded));
    expect(reread.scenarios[0]!.checkpoints[0]!.animations[1]!.scrollLink).toEqual(scrollLink);
    records()[1]!.scrollLink = { ...scrollLink, scrub: -1 } as never;
    expect(() => parseCaptureBundle(structuredClone(upgraded))).toThrow(/scrollLink\.scrub/);
  });

  it("reads captures made before scroll-container recording as not recording containers", () => {
    const upgraded = parseCaptureBundle(structuredClone(v1Capture));
    expect(upgraded.settings.scrollContainers).toBe(false);
    upgraded.settings.scrollContainers = true;
    expect(parseCaptureBundle(structuredClone(upgraded)).settings.scrollContainers).toBe(true);
  });

  it("reads captures made before MotionPR looked inside shadow roots as not looking there", () => {
    const upgraded = parseCaptureBundle(structuredClone(v1Capture));
    expect(upgraded.settings.shadowRoots).toBe(false);
    const record = upgraded.scenarios[0]!.checkpoints[0]!.animations[0]!;
    expect(record.element.shadowHost).toBeUndefined();
    upgraded.settings.shadowRoots = true;
    record.element = {
      ...record.element,
      key: `test-id:plan-1 >> ${record.element.key}`,
      shadowHost: "test-id:plan-1",
    };
    const reread = parseCaptureBundle(structuredClone(upgraded));
    expect(reread.settings.shadowRoots).toBe(true);
    expect(reread.scenarios[0]!.checkpoints[0]!.animations[0]!.element.shadowHost).toBe(
      "test-id:plan-1",
    );
  });

  it("rejects captures newer than this version", () => {
    expect(() => parseCaptureBundle({ ...v1Capture, schemaVersion: 3 })).toThrow(
      /understands up to v2/,
    );
  });

  it("upgrades v1 comparison results with empty scroll and timeline comparisons", () => {
    const result = parseComparisonResult({
      schemaVersion: 1,
      kind: "motionpr-comparison",
      motionprVersion: "0",
      createdAt: "",
      baseline: {
        id: "a",
        createdAt: "",
        motionprVersion: "0",
        browser: "",
        platform: "",
        configHash: "",
      },
      candidate: {
        id: "b",
        createdAt: "",
        motionprVersion: "0",
        browser: "",
        platform: "",
        configHash: "",
      },
      failOn: "critical",
      failOnUncertain: false,
      summary: {
        status: "passed",
        highestSeverity: null,
        counts: { critical: 0, warning: 0, info: 0, uncertain: 0 },
        scenarios: { total: 1, changed: 0, added: 0, removed: 0, failed: 0 },
        animations: { matched: 0, changed: 0, added: 0, removed: 0, unchanged: 0 },
      },
      scenarios: [
        {
          key: "s",
          id: "s",
          name: "s",
          viewport: "default",
          status: "unchanged",
          baselineStatus: "passed",
          candidateStatus: "passed",
          severity: null,
          checkpoints: [
            {
              label: "x",
              status: "unchanged",
              baselineIndex: 0,
              candidateIndex: 0,
              animations: [],
              visual: null,
              frameDivergence: [],
              stagger: [],
              latency: null,
              severity: null,
            },
          ],
        },
      ],
      differences: [
        {
          id: "d",
          severity: "info",
          category: "timing",
          scenarioKey: "s",
          checkpoint: "x",
          animationKey: null,
          title: "t",
          detail: "",
          measurement: "measured",
        },
      ],
      assets: {},
      diagnostics: [],
    });
    expect(result.scenarios[0]!.checkpoints[0]).toMatchObject({ scroll: [], timelines: [] });
    expect(result.differences[0]).toMatchObject({ scrollKey: null, source: null });
  });
});

describe("versionSatisfies", () => {
  it.each([
    ["4.5.0", ">=4.0.0 <5.0.0", true],
    ["5.0.0-beta.3", ">=4.0.0 <5.0.0", true],
    ["5.0.0", ">=4.0.0 <5.0.0", false],
    ["3.15.1", "^3.12.0", true],
    ["3.11.9", "^3.12.0", false],
    ["1.3.27", "~1.3.0", true],
    ["1.4.0", "~1.3.0", false],
    ["2.0.0", ">=1.1.0 <2.0.0 || >=3", false],
    ["3.1.0", ">=1.1.0 <2.0.0 || >=3", true],
    ["not-a-version", ">=1", false],
  ])("%s satisfies %s: %s", (v, range, expected) => {
    expect(versionSatisfies(v, range)).toBe(expected);
  });
});

describe("untrusted capture data (security regression)", () => {
  const withAsset = (id: string, file: string) => ({
    ...structuredClone(v1Capture),
    schemaVersion: 2,
    scenarios: [],
    assets: { [id]: { file, format: "png", width: 1, height: 1, bytes: 1 } },
  });

  it.each([
    ["abc.png", "../../../etc/passwd"],
    ["abc.png", "assets/../../secret.png"],
    ["abc.png", "/etc/passwd"],
    ["../escape.png", "assets/abc.png"],
    ["abc.png", "assets/abc.svg"],
  ])("rejects asset %s → %s", (id, file) => {
    expect(() => parseCaptureBundle(withAsset(id, file))).toThrow(/asset/);
  });

  it("accepts content-addressed assets", () => {
    const id = "0123456789abcdef0123.png";
    expect(parseCaptureBundle(withAsset(id, `assets/${id}`)).assets[id]).toBeDefined();
  });
});
