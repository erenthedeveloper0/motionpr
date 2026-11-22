import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  resolveConfig,
  type CaptureBundle,
  type Checkpoint,
  type ScrollMotionRecord,
} from "@motionpr/core";
import { AGENT_SOURCE, checkAdapter } from "@motionpr/capture";
import { compareCaptures, scrollMetrics } from "@motionpr/comparison";
import { startHarness, type Harness } from "./harness.ts";

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h?.close();
});

const comparisonConfig = () => {
  const c = resolveConfig({ baseURL: "http://x", scenarios: [{ id: "x" }] }).comparison;
  return { ...c, visual: { ...c.visual, enabled: false } };
};

const scrollTo = (target: number, extra: Record<string, unknown> = {}) => [
  { type: "scrollTo", target, ...extra },
  { type: "waitForScrollSettled" },
  { type: "capture", label: "scrolled" },
];

function checkpoint(bundle: CaptureBundle): Checkpoint {
  const scenario = bundle.scenarios[0]!;
  expect(scenario.status, scenario.error?.message).toBe("passed");
  return scenario.checkpoints[0]!;
}

function lenisTrack(cp: Checkpoint): ScrollMotionRecord {
  const r = cp.scrollMotion.find((s) => s.source === "lenis");
  if (!r) throw new Error(`no lenis record: ${cp.scrollMotion.map((s) => s.id).join(", ")}`);
  return r;
}

describe("Lenis adapter: recording (real Lenis 1.3)", () => {
  it("records smooth wheel scrolling as a ScrollMotionRecord", async () => {
    const cp = checkpoint(
      await h.capture("/lenis.html", [
        { type: "wheel", deltaY: 800 },
        { type: "waitForScrollSettled" },
        { type: "capture", label: "wheel" },
      ]),
    );
    const r = lenisTrack(cp);
    expect(r).toMatchObject({
      id: "lenis:window:vertical",
      source: "lenis",
      sessionId: "main",
      axis: "vertical",
      wrapper: null,
    });
    expect(r.config).toMatchObject({ lerp: 0.1, smoothWheel: true, autoRaf: true });
    expect(r.samples.length).toBeGreaterThan(20);
    expect(r.samples[0]).toMatchObject({ time: 0, animatedScroll: 0 });
    // Lenis lerps towards its target: the rendered position trails the target mid-scroll.
    const mid = r.samples[Math.floor(r.samples.length / 3)]!;
    expect(mid.targetScroll).toBe(800);
    expect(mid.animatedScroll).toBeLessThan(800);
    expect(mid.isScrolling).toBe("smooth");
    const m = scrollMetrics(r, comparisonConfig());
    expect(m.end).toBeCloseTo(800, 0);
    expect(m.unsettled).toBe(false);
    expect(m.duration!).toBeGreaterThan(300);
    // Native scrolling of the same document is not recorded twice.
    expect(cp.scrollMotion.filter((s) => s.wrapper === null)).toHaveLength(1);
    expect(cp.window.trigger?.event).toBe("wheel");
  });

  it("scrolls programmatically through Lenis and correlates scroll-triggered transitions", async () => {
    const bundle = await h.capture("/lenis.html", scrollTo(1200));
    const cp = checkpoint(bundle);
    const r = lenisTrack(cp);
    expect(r.samples.at(-1)).toMatchObject({ animatedScroll: 1200, targetScroll: 1200 });
    expect(bundle.scenarios[0]!.diagnostics.some((d) => d.code === "SCROLL_NATIVE")).toBe(false);
    // The section reveal (an IntersectionObserver-driven CSS transition) ran during the scroll.
    const reveal = cp.animations.find((a) => a.element.key === "test-id:reveal-2");
    expect(reveal).toBeDefined();
    expect(reveal!.startTime!).toBeGreaterThan(0);
    expect(cp.correlations).toContainEqual(
      expect.objectContaining({ scroll: r.id, animation: reveal!.id, kind: "overlap" }),
    );
    expect(bundle.scenarios[0]!.adapters[0]).toMatchObject({
      id: "lenis",
      engineVersion: "1.3.27",
      versionStatus: "supported",
      status: "active",
    });
  });

  it("falls back to native smooth scrolling when no Lenis is attached", async () => {
    const bundle = await h.capture("/native.html", scrollTo(1200), { adapters: [] });
    const cp = checkpoint(bundle);
    expect(cp.scrollMotion).toHaveLength(1);
    expect(cp.scrollMotion[0]).toMatchObject({ id: "native:window:vertical", source: "native" });
    expect(cp.scrollMotion[0]!.samples.at(-1)!.animatedScroll).toBe(1200);
    // Regression: native positions are recorded only when they change, so the record ended on
    // its last moving sample and read as unsettled (Chromium, WebKit) despite the settle step.
    expect(scrollMetrics(cp.scrollMotion[0]!, comparisonConfig()).unsettled).toBe(false);
    expect(bundle.scenarios[0]!.diagnostics.some((d) => d.code === "SCROLL_NATIVE")).toBe(true);
  });

  it("records a Lenis scroll container once, through Lenis, when a wheel step scrolls it", async () => {
    const cp = checkpoint(
      await h.capture("/lenis-wrapper.html", [
        { type: "wheel", deltaY: 600, selector: "[data-testid=panel]" },
        { type: "waitForScrollSettled" },
        { type: "capture", label: "wheel" },
      ]),
    );
    // The panel scrolls natively under Lenis: one record, Lenis's, with the panel as wrapper.
    expect(cp.scrollMotion.map((r) => r.id)).toEqual(["lenis:test-id:panel:vertical"]);
    const r = cp.scrollMotion[0]!;
    expect(r).toMatchObject({ source: "lenis", sessionId: "panel" });
    expect(r.wrapper).toMatchObject({ key: "test-id:panel" });
    expect(r.samples.at(-1)!.animatedScroll).toBeCloseTo(600, 0);
  });

  it("records horizontal Lenis scrolling on the horizontal axis", async () => {
    const cp = checkpoint(await h.capture("/lenis.html?orientation=horizontal", scrollTo(1200)));
    const r = lenisTrack(cp);
    expect(r).toMatchObject({ id: "lenis:window:horizontal", axis: "horizontal" });
    expect(r.samples.at(-1)!.animatedScroll).toBe(1200);
  });

  it("honours reduced motion: Lenis jumps and MotionPR records the jump", async () => {
    const bundle = await h.capture("/lenis.html", scrollTo(1200), {
      browser: { reducedMotion: "reduce", viewport: { width: 900, height: 600 } },
    });
    const r = lenisTrack(checkpoint(bundle));
    expect(r.prefersReducedMotion).toBe(true);
    const m = scrollMetrics(r, comparisonConfig());
    expect(m.end).toBe(1200);
    expect(m.duration ?? 0).toBeLessThan(40);
  });

  it("works with an externally managed RAF loop (autoRaf: false)", async () => {
    const r = lenisTrack(checkpoint(await h.capture("/lenis.html?raf=external", scrollTo(900))));
    expect(r.config.autoRaf).toBe(false);
    expect(r.samples.at(-1)!.animatedScroll).toBe(900);
  });

  it("never drives Lenis itself: without the app's RAF loop nothing moves (reported as stalled)", async () => {
    const started = Date.now();
    const bundle = await h.capture("/lenis.html?raf=none", [
      { type: "scrollTo", target: 900 },
      { type: "waitForScrollSettled", timeout: 800 },
      { type: "capture", label: "stuck" },
    ]);
    const scenario = bundle.scenarios[0]!;
    expect(scenario.diagnostics.map((d) => d.code)).toContain("SCROLL_STALLED");
    expect(scenario.diagnostics.map((d) => d.code)).not.toContain("ANIMATIONS_NOT_SETTLED");
    expect(Date.now() - started).toBeLessThan(5000);
    const lenis = scenario.checkpoints[0]!.scrollMotion.find((s) => s.source === "lenis");
    expect(lenis?.samples.at(-1)?.animatedScroll ?? 0).toBe(0);
  });

  it("treats a stopped Lenis as settled without forcing it to scroll", async () => {
    const started = Date.now();
    const bundle = await h.capture("/lenis.html?stop=1", scrollTo(900));
    const scenario = bundle.scenarios[0]!;
    expect(scenario.status).toBe("passed");
    expect(scenario.diagnostics.some((d) => d.code === "SCROLL_NOT_SETTLED")).toBe(false);
    expect(scenario.checkpoints[0]!.scroll.y).toBe(0);
    expect(Date.now() - started).toBeLessThan(5000);
  });
});

describe("Lenis adapter: comparison", () => {
  it("reports no scroll differences between two runs of the same version", async () => {
    const a = await h.capture("/lenis.html", scrollTo(1200));
    const b = await h.capture("/lenis.html", scrollTo(1200));
    const result = await compareCaptures({
      baseline: { bundle: a, dir: h.root },
      candidate: { bundle: b, dir: h.root },
      config: comparisonConfig(),
    });
    expect(result.differences.filter((d) => d.category === "scroll")).toEqual([]);
  });

  it("detects a slower lerp as a longer, differently shaped scroll", async () => {
    const a = await h.capture("/lenis.html", scrollTo(1200));
    const b = await h.capture("/lenis.html?lerp=0.05", scrollTo(1200));
    const result = await compareCaptures({
      baseline: { bundle: a, dir: h.root },
      candidate: { bundle: b, dir: h.root },
      config: comparisonConfig(),
    });
    const scroll = result.differences.filter((d) => d.category === "scroll");
    expect(
      scroll.every((d) => d.source === "lenis" && d.scrollKey === "lenis:window:vertical"),
    ).toBe(true);
    expect(scroll.some((d) => /Scroll setting lerp: 0\.1 → 0\.05/.test(d.title))).toBe(true);
    expect(
      scroll.some(
        (d) => /Scroll takes \d+ms → \d+ms to settle/.test(d.title) && d.severity === "warning",
      ),
    ).toBe(true);
    expect(scroll.some((d) => /Peak scroll velocity/.test(d.title))).toBe(true);
  });

  it("detects a different scroll destination", async () => {
    const a = await h.capture("/lenis.html", scrollTo(1200));
    const b = await h.capture("/lenis.html", scrollTo(1500));
    const result = await compareCaptures({
      baseline: { bundle: a, dir: h.root },
      candidate: { bundle: b, dir: h.root },
      config: comparisonConfig(),
    });
    expect(result.differences.some((d) => /Scroll target 1200px → 1500px/.test(d.title))).toBe(
      true,
    );
  });
});

describe("Lenis adapter: lifecycle", () => {
  async function page(query = "") {
    const context = await h.browser.newContext({ viewport: { width: 900, height: 600 } });
    await context.addInitScript({ content: AGENT_SOURCE });
    const p = await context.newPage();
    await p.goto(`${h.server.url}/lenis.html${query}`);
    return { context, page: p };
  }

  it("subscribes once even when attached twice, and leaves options untouched", async () => {
    const { context, page: p } = await page();
    const result = await p.evaluate(async () => {
      const agent = window.__MOTIONPR_AGENT__!;
      const w = window as unknown as {
        appEvents: number;
        lenis: { scrollTo(t: number): void; options: Record<string, unknown> };
        optionsBefore: string;
      };
      agent.openWindow();
      const before = w.appEvents;
      w.lenis.scrollTo(700);
      await agent.waitForScrollSettled({
        timeout: 4000,
        threshold: 0.5,
        stableFrames: 6,
        minStableMs: 100,
      });
      const track = agent.collect().scrollTracks.find((t) => t.source === "lenis")!;
      const o = w.lenis.options;
      return {
        app: w.appEvents - before,
        ours: track.events,
        options:
          JSON.stringify({ lerp: o.lerp, duration: o.duration, smoothWheel: o.smoothWheel }) ===
          w.optionsBefore,
      };
    });
    expect(result.ours).toBe(result.app);
    expect(result.ours).toBeGreaterThan(10);
    expect(result.options).toBe(true);
    await context.close();
  });

  it("dispose removes the listener without destroying or stopping Lenis; re-attach works", async () => {
    const { context, page: p } = await page();
    const result = await p.evaluate(async () => {
      const agent = window.__MOTIONPR_AGENT__!;
      const w = window as unknown as {
        lenis: { scrollTo(t: number): void; isStopped: boolean; animatedScroll: number };
        handle: { dispose(): void; active: boolean };
        handle2: { dispose(): void };
        MotionprLenis: {
          motionprLenis: { attach(l: unknown): { dispose(): void }; isActive(): boolean };
        };
      };
      const settle = () =>
        agent.waitForScrollSettled({
          timeout: 4000,
          threshold: 0.5,
          stableFrames: 6,
          minStableMs: 100,
        });
      w.handle.dispose();
      w.handle2.dispose();
      const registeredAfterDispose = agent.adapters().some((a) => a.name === "lenis");
      agent.openWindow();
      w.lenis.scrollTo(600);
      await settle();
      // Native-only settle detection uses the 0.5 px threshold, so Lenis's last sub-pixel steps
      // may still be running; the scroll itself must be essentially complete.
      const lenisStillScrolls = Math.abs(w.lenis.animatedScroll - 600) < 1 && !w.lenis.isStopped;
      const tracksWhileDetached = agent
        .collect()
        .scrollTracks.filter((t) => t.source === "lenis").length;
      // Repeated attach / dispose cycles must not accumulate listeners.
      for (let i = 0; i < 5; i++) w.MotionprLenis.motionprLenis.attach(w.lenis).dispose();
      const handle = w.MotionprLenis.motionprLenis.attach(w.lenis);
      agent.openWindow();
      const appBefore = (window as unknown as { appEvents: number }).appEvents;
      w.lenis.scrollTo(100);
      await settle();
      const track = agent.collect().scrollTracks.find((t) => t.source === "lenis");
      const appDelta = (window as unknown as { appEvents: number }).appEvents - appBefore;
      handle.dispose();
      return {
        active: w.handle.active,
        registeredAfterDispose,
        lenisStillScrolls,
        tracksWhileDetached,
        reattachedEvents: track?.events ?? -1,
        appDelta,
        isActive: w.MotionprLenis.motionprLenis.isActive(),
      };
    });
    expect(result).toMatchObject({
      active: false,
      registeredAfterDispose: false,
      lenisStillScrolls: true,
      tracksWhileDetached: 0,
      isActive: false,
    });
    expect(result.reattachedEvents).toBe(result.appDelta);
    await context.close();
  });

  it("is inert without a MotionPR agent", async () => {
    const p = await h.browser.newPage();
    await p.goto(`${h.server.url}/lenis.html`);
    const active = await p.evaluate(
      () => (window as unknown as { handle: { active: boolean } }).handle.active,
    );
    expect(active).toBe(false);
    await p.close();
  });

  it("rejects values that are not Lenis instances", async () => {
    const { context, page: p } = await page();
    const message = await p.evaluate(() => {
      try {
        (
          window as unknown as { MotionprLenis: { motionprLenis: { attach(x: unknown): void } } }
        ).MotionprLenis.motionprLenis.attach({});
        return "no error";
      } catch (error) {
        return String(error);
      }
    });
    expect(message).toMatch(/expects a Lenis instance/);
    await context.close();
  });
});

describe("adapter conformance suite (adapter protocol 2)", () => {
  // A scroll adapter: the suite scrolls
  // through its scrollTo() and expects collectScroll() to record it.
  it("passes every check that applies to the lenis adapter", async () => {
    const report = await checkAdapter({ page: `${h.server.url}/lenis.html`, browser: h.browser });
    expect(report.adapter).toMatchObject({ name: "lenis", protocol: 2 });
    expect(
      report.checks.filter((c) => c.status === "fail" || c.status === "warn"),
      JSON.stringify(report.checks, null, 1),
    ).toEqual([]);
    expect(report.passed).toBe(true);
  });
});
