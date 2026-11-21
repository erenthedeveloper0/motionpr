import { copyFile, cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import type { Browser } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  resolveConfig,
  type AnimationRecord,
  type CaptureBundle,
  type Checkpoint,
  type Difference,
} from "@motionpr/core";
import { AGENT_SOURCE, launchBrowser, runCapture } from "@motionpr/capture";
import { compareCaptures } from "@motionpr/comparison";
import { serveDirectory, type StaticServer } from "../../../capture/tests/helpers/static-server.ts";
import { TEST_BROWSER } from "../../../capture/tests/helpers/browser.ts";

const require = createRequire(import.meta.url);
let root: string;
let server: StaticServer;
let browser: Browser;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "motionpr-gsap-"));
  await cp(fileURLToPath(new URL("./fixtures", import.meta.url)), root, { recursive: true });
  const gsapDist = join(dirname(require.resolve("gsap/package.json")), "dist");
  await copyFile(join(gsapDist, "gsap.min.js"), join(root, "gsap.min.js"));
  await copyFile(join(gsapDist, "ScrollTrigger.min.js"), join(root, "ScrollTrigger.min.js"));
  const adapter = await build({
    entryPoints: [fileURLToPath(new URL("../src/index.ts", import.meta.url))],
    bundle: true,
    format: "iife",
    globalName: "MotionprGsap",
    write: false,
    platform: "browser",
  });
  await writeFile(join(root, "adapter.js"), adapter.outputFiles[0]!.text);
  server = await serveDirectory(root);
  browser = await launchBrowser(resolveConfig({ baseURL: server.url, scenarios: [{ id: "x" }] }), {
    browserName: TEST_BROWSER,
  });
});

afterAll(async () => {
  await browser?.close();
  await server?.close();
  await rm(root, { recursive: true, force: true });
});

let n = 0;
async function capture(steps: unknown[], path = "/gsap.html"): Promise<CaptureBundle> {
  const config = resolveConfig({
    baseURL: server.url,
    browser: { viewport: { width: 800, height: 500 } },
    capture: { samples: 11, waitForNetworkIdle: false },
    adapters: [{ name: "gsap", required: true }],
    scenarios: [{ id: "gsap", path, steps }],
  });
  const { bundle } = await runCapture({
    config,
    rootDir: root,
    outputDir: join(root, `out-${++n}`),
    browser,
  });
  return bundle;
}

const find = (records: AnimationRecord[], key: string) => {
  const r = records.find((a) => a.element.key === key);
  if (!r) throw new Error(`no record for ${key}: ${records.map((a) => a.id).join(", ")}`);
  return r;
};

describe("GSAP adapter (real GSAP 3.15 timelines)", () => {
  let hero: CaptureBundle;
  beforeAll(async () => {
    hero = await capture([
      { type: "click", selector: "[data-testid=play]" },
      { type: "capture", label: "played" },
    ]);
  });

  it("reports timeline tweens with labels, GSAP timing and sampled eases", () => {
    const scenario = hero.scenarios[0]!;
    expect(scenario.status).toBe("passed");
    expect(scenario.diagnostics.some((d) => d.code === "ADAPTER_MISSING")).toBe(false);
    const records = scenario.checkpoints[0]!.animations;
    const title = find(records, "test-id:title");
    expect(title).toMatchObject({ type: "gsap", source: "gsap", name: "hero@intro" });
    expect(title.timing).toMatchObject({ duration: 600, delay: 0, iterations: 1, playbackRate: 1 });
    expect(title.timing.easing).toMatchObject({ value: "power3.out", kind: "gsap" });
    expect(title.timing.easing.samples).toHaveLength(65);
    expect(title.properties.map((p) => p.property)).toEqual(["opacity", "transform"]);
    expect(title.startTime).toBe(0);
    expect(title.completeness.status).toBe("complete");
  });

  it("expands staggers into per-target records with real offsets and a shared group", () => {
    const records = hero.scenarios[0]!.checkpoints[0]!.animations;
    const cards = [1, 2, 3].map((i) => find(records, `test-id:card-${i}`));
    const visibleStarts = cards.map((c) => Math.round(c.startTime! + c.timing.delay));
    expect(visibleStarts).toEqual([600, 700, 800]);
    expect(new Set(cards.map((c) => c.group)).size).toBe(1);
    expect(cards[0]!.group).toMatch(/^gsap:/);
    expect(cards[0]!.name).toBe("hero@cards");
    expect(cards[0]!.timing.easing.value).toBe("back.out(1.7)");
    expect(Math.max(...cards[0]!.timing.easing.samples!)).toBeGreaterThan(1.05);
  });

  it("samples GSAP-driven inline styles by seeking the timeline", () => {
    const records = hero.scenarios[0]!.checkpoints[0]!.animations;
    const title = find(records, "test-id:title");
    expect(title.samples[0]!.numeric).toMatchObject({ translateY: 40, opacity: 0 });
    expect(title.samples.at(-1)!.numeric.translateY!).toBeLessThan(0.5);
    expect(title.samples.at(-1)!.numeric.opacity!).toBeGreaterThan(0.99);
    const card = find(records, "test-id:card-2");
    expect(card.samples[0]!.numeric.translateX).toBe(0);
    expect(card.samples.at(-1)!.numeric.translateX!).toBeGreaterThan(99);
    const cp = hero.scenarios[0]!.checkpoints[0]!;
    expect(cp.window.end).toBeGreaterThanOrEqual(1199);
    expect(cp.frames.length).toBeGreaterThan(30);
  });

  it("replays deterministically", async () => {
    const again = await capture([
      { type: "click", selector: "[data-testid=play]" },
      { type: "capture", label: "played" },
    ]);
    const a = hero.scenarios[0]!.checkpoints[0]!;
    const b = again.scenarios[0]!.checkpoints[0]!;
    expect(b.frames.map((f) => f.asset)).toEqual(a.frames.map((f) => f.asset));
    expect(b.animations.map((r) => r.startTime)).toEqual(a.animations.map((r) => r.startTime));
  });

  it("handles reversed timelines (menu close) with a negative playback rate", async () => {
    const bundle = await capture([
      { type: "click", selector: "[data-testid=open]" },
      { type: "capture", label: "open" },
      { type: "click", selector: "[data-testid=close]" },
      { type: "capture", label: "closed" },
    ]);
    const [open, closed] = bundle.scenarios[0]!.checkpoints;
    const opened = find(open!.animations, "test-id:menu");
    expect(opened.timing).toMatchObject({ duration: 500, playbackRate: 1 });
    expect(opened.samples.at(-1)!.numeric.translateX!).toBeGreaterThan(199);
    const reversed = find(closed!.animations, "test-id:menu");
    expect(reversed.timing.playbackRate).toBe(-1);
    expect(reversed.meta.reversed).toBe(true);
    // Samples are ordered by local time; in reverse, local 0 (x = 0) is reached last.
    expect(reversed.samples[0]!.numeric.translateX).toBe(0);
    expect(reversed.samples[0]!.windowTime).toBeGreaterThan(reversed.samples.at(-1)!.windowTime);
    expect(closed!.window.end).toBeGreaterThanOrEqual(499);
  });

  it("reports repeat, yoyo and repeatDelay", async () => {
    const bundle = await capture([
      { type: "click", selector: "[data-testid=pulse-btn]" },
      { type: "capture", label: "pulsed" },
    ]);
    const pulse = find(bundle.scenarios[0]!.checkpoints[0]!.animations, "test-id:pulse");
    expect(pulse.name).toBe("pulse");
    expect(pulse.timing).toMatchObject({
      duration: 200,
      iterations: 2,
      direction: "alternate",
      activeDuration: 500,
    });
    expect(pulse.meta.repeatDelay).toBe(100);
    expect(pulse.timing.easing.value).toBe("sine.inOut");
  });
});

describe("GSAP adapter: timeline records", () => {
  it("reports timelines as TimelineRecords linked to their tweens", async () => {
    const bundle = await capture([
      { type: "click", selector: "[data-testid=play]" },
      { type: "capture", label: "played" },
    ]);
    const cp = bundle.scenarios[0]!.checkpoints[0]!;
    expect(cp.timelines.length).toBeGreaterThan(0);
    const tl = cp.timelines[0]!;
    expect(tl.source).toBe("gsap");
    expect(tl.labels.length).toBeGreaterThan(0);
    expect(tl.labels.map((l) => l.time)).toEqual(
      [...tl.labels.map((l) => l.time)].sort((a, b) => a - b),
    );
    expect(tl.children.length).toBeGreaterThan(0);
    for (const id of tl.children) {
      const child = cp.animations.find((a) => a.id === id)!;
      expect(child.parent).toBe(tl.id);
      expect(child).toMatchObject({ driver: "javascript", source: "gsap" });
      expect(child.provenance.startTime).toBe("observed");
    }
    expect(bundle.scenarios[0]!.adapters[0]).toMatchObject({
      id: "gsap",
      engineVersion: "3.15.1",
      versionStatus: "supported",
    });
  });
});

describe("GSAP adapter safety", () => {
  it("dispose() restores gsap's methods and unregisters", async () => {
    const context = await browser.newContext();
    await context.addInitScript({ content: AGENT_SOURCE });
    const page = await context.newPage();
    await page.goto(`${server.url}/gsap.html`);
    const result = await page.evaluate(() => {
      const w = window as unknown as {
        gsap: { to: () => unknown };
        MotionprGsap: { motionprGsap: { dispose(): void; isActive(): boolean } };
      };
      const isWrapped = () => String(w.gsap.to).includes("trackRoot");
      const wrappedBefore = isWrapped();
      w.MotionprGsap.motionprGsap.dispose();
      return {
        wrappedBefore,
        wrappedAfter: isWrapped(),
        active: w.MotionprGsap.motionprGsap.isActive(),
        registered: window.__MOTIONPR_AGENT__!.adapters().some((a) => a.name === "gsap"),
      };
    });
    expect(result).toEqual({
      wrappedBefore: true,
      wrappedAfter: false,
      active: false,
      registered: false,
    });
    await context.close();
  });

  it("is inert without a MotionPR agent", async () => {
    const page = await browser.newPage();
    await page.goto(`${server.url}/no-agent.html`);
    expect(
      await page.evaluate(() => [
        (window as unknown as { registered: boolean }).registered,
        (window as unknown as { untouched: boolean }).untouched,
      ]),
    ).toEqual([false, true]);
    await page.close();
  });

  it("does not re-fire callbacks or leave timelines paused after replay", async () => {
    const context = await browser.newContext();
    await context.addInitScript({ content: AGENT_SOURCE });
    const page = await context.newPage();
    await page.goto(`${server.url}/gsap.html`);
    await page.click("[data-testid=play]");
    await page.evaluate(() => window.__MOTIONPR_AGENT__!.waitForSettle(5000, 120));
    const state = await page.evaluate(() => {
      const agent = window.__MOTIONPR_AGENT__!;
      const before = (window as unknown as { completeCount: number }).completeCount;
      agent.collect();
      agent.beginReplay();
      for (const t of [0, 300, 900, 1200, 50]) agent.seek(t);
      agent.sample(8);
      agent.endReplay();
      return { before };
    });
    await page.waitForTimeout(200);
    const after = await page.evaluate(
      () => (window as unknown as { completeCount: number }).completeCount,
    );
    expect(state.before).toBe(1);
    expect(after).toBe(1);
    // The menu timeline must still respond to the application after a replay.
    await page.click("[data-testid=open]");
    await page.waitForTimeout(700);
    const x = await page.evaluate(
      () => getComputedStyle(document.querySelector("[data-testid=menu]")!).transform,
    );
    expect(x).toContain("200");
    await context.close();
  });
});

describe("GSAP adapter: ScrollTrigger values", () => {
  // fixtures/scrolltrigger.html: parallax active from scroll 400 to 1300, the "story" timeline
  // from 1000 to 2000 (story-a in its first half, story-b in its second), reveal plays at 1600.
  const scrolled = (target: number) => [
    { type: "scrollTo", target, behavior: "smooth" },
    { type: "waitForScrollSettled" },
    { type: "capture", label: "scrolled" },
  ];
  const checkpointOf = (bundle: CaptureBundle): Checkpoint => {
    const scenario = bundle.scenarios[0]!;
    expect(scenario.status, scenario.error?.message).toBe("passed");
    return scenario.checkpoints[0]!;
  };
  const progressOf = (r: AnimationRecord) => r.samples.map((s) => s.scrollProgress!);
  const compare = async (a: CaptureBundle, b: CaptureBundle): Promise<Difference[]> => {
    const c = resolveConfig({ baseURL: "http://x", scenarios: [{ id: "x" }] }).comparison;
    const result = await compareCaptures({
      baseline: { bundle: a, dir: root },
      candidate: { bundle: b, dir: root },
      config: { ...c, visual: { ...c.visual, enabled: false } },
    });
    return result.differences;
  };
  const gsapFindings = (diffs: Difference[]) => diffs.filter((d) => d.source === "gsap");
  // Findings about the values scroll-linked animations write (not where they sit in the scroll).
  const valueFindings = (diffs: Difference[]) =>
    gsapFindings(diffs).filter((d) => d.category !== "scroll");

  let full: CaptureBundle;
  beforeAll(async () => {
    full = await capture(scrolled(1800), "/scrolltrigger.html");
  });

  it("samples a scrubbed tween over the scroll progress the page showed", () => {
    const cp = checkpointOf(full);
    const parallax = find(cp.animations, "test-id:parallax");
    expect(parallax).toMatchObject({ timeline: "scroll", startTime: null });
    expect(parallax.provenance.startTime).toBe("unavailable");
    expect(parallax.completeness).toEqual({ status: "complete", reasons: [] });
    expect(parallax.samples).toHaveLength(11);
    expect(progressOf(parallax)).toEqual([0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1]);
    // y: 0 → -120px, linear (ease: none) in scroll progress.
    for (const s of parallax.samples)
      expect(s.numeric.translateY!).toBeCloseTo(-120 * s.scrollProgress!, 1);
    // When the page first showed each progress, in order, inside the window.
    const times = parallax.samples.map((s) => s.windowTime);
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(times[0]).toBeGreaterThanOrEqual(0);
    expect(times.at(-1)!).toBeLessThanOrEqual(cp.window.end);
    expect(parallax.properties.find((p) => p.property === "transform")?.to).toContain("-120");
  });

  it("samples each tween of a scrubbed timeline in its own part of the scroll range", () => {
    const cp = checkpointOf(full);
    const a = find(cp.animations, "test-id:story-a");
    const b = find(cp.animations, "test-id:story-b");
    expect(a.name).toBe("story");
    expect(progressOf(a)[0]).toBe(0);
    expect(progressOf(a).at(-1)).toBe(0.5);
    expect(a.samples.at(-1)!.numeric.translateX!).toBeCloseTo(200, 1);
    expect(a.completeness.status).toBe("complete");
    // The scroll stopped at 1800 (80% of the timeline): story-b is sampled from 50% to 80%.
    expect(progressOf(b)[0]).toBe(0.5);
    expect(progressOf(b).at(-1)).toBeCloseTo(0.8, 3);
    expect(b.samples[0]!.numeric.opacity).toBeCloseTo(1, 3);
    expect(b.samples.at(-1)!.numeric.opacity!).toBeCloseTo(1 - 0.8 * 0.6, 2);
    expect(b.completeness.status).toBe("partial");
    expect(b.completeness.reasons.join(" ")).toMatch(
      /Sampled only where the scroll went: 50%–80% scroll progress \(the animation runs from 50% to 100%\)/,
    );
  });

  it("samples a ScrollTrigger with toggleActions over its playback", () => {
    const reveal = find(checkpointOf(full).animations, "test-id:reveal");
    expect(reveal.completeness.status).toBe("complete");
    expect(reveal.samples[0]!.numeric).toMatchObject({ opacity: 0, translateX: -40 });
    expect(reveal.samples.at(-1)!.numeric).toMatchObject({ opacity: 1, translateX: 0 });
  });

  it("leaves a tween the scroll never reached metadata-only, saying why", async () => {
    const cp = checkpointOf(await capture(scrolled(1300), "/scrolltrigger.html"));
    const b = find(cp.animations, "test-id:story-b");
    expect(b.samples).toEqual([]);
    expect(b.completeness.status).toBe("metadata-only");
    expect(b.completeness.reasons.join(" ")).toMatch(/did not reach the part of the scroll range/);
    expect(find(cp.animations, "test-id:story-a").samples.length).toBe(11);
  });

  it("finds no differences between two runs of the same build", async () => {
    const again = await capture(scrolled(1800), "/scrolltrigger.html");
    // Where the animations run comes from ScrollTrigger's resolved positions, not from relating
    // live progress to the recorded scroll, so native smooth scrolling (whose timing differs
    // between runs in Firefox and WebKit) adds no finding.
    expect(gsapFindings(await compare(full, again)).map((d) => d.title)).toEqual([]);
  });

  it("records where each animation runs in the scroll, as ScrollTrigger resolved it", () => {
    const cp = checkpointOf(full);
    const link = (key: string) => find(cp.animations, key).scrollLink;
    const scrubbed = { axis: "vertical", scroller: null, scrub: 0, toggleActions: null };
    expect(link("test-id:parallax")).toEqual({ start: 400, end: 1300, ...scrubbed });
    // Both tweens of the scrubbed timeline carry the timeline's ScrollTrigger positions.
    expect(link("test-id:story-a")).toEqual({ start: 1000, end: 2000, ...scrubbed });
    expect(link("test-id:story-b")).toEqual(link("test-id:story-a"));
    // Played once triggered: no scrub, ScrollTrigger's default toggleActions ("play").
    expect(link("test-id:reveal")).toEqual({
      start: 1600,
      end: 2200,
      axis: "vertical",
      scroller: null,
      scrub: null,
      toggleActions: "play none none none",
    });
  });

  it("reports a changed parallax distance at the same scroll progress", async () => {
    const farther = await capture(scrolled(1800), "/scrolltrigger.html?distance=-240");
    const found = valueFindings(await compare(full, farther));
    expect(found.map((d) => d.title)).toEqual([
      "gsap on parallax: Scroll-linked translateY differs by up to 120px at the same scroll progress (at 100%: -120px → -240px)",
    ]);
    expect(found[0]).toMatchObject({ severity: "warning", category: "property", delta: -120 });
  });

  it("reports a changed fade of a timeline tween where both scrolls reached", async () => {
    const lighter = await capture(scrolled(1800), "/scrolltrigger.html?fade=0.5");
    const found = valueFindings(await compare(full, lighter));
    expect(found).toHaveLength(1);
    expect(found[0]!.title).toMatch(
      /^gsap “story” on story-b: Scroll-linked opacity differs by up to 0\.18 at the same scroll progress \(at 80%: 0\.52 → 0\.7\)$/,
    );
  });

  it("samples a smoothed scrub (scrub: 0.5): same values, a changed scroll setting", async () => {
    const smoothed = await capture(scrolled(1800), "/scrolltrigger.html?scrub=0.5");
    const parallax = find(checkpointOf(smoothed).animations, "test-id:parallax");
    expect(parallax.completeness.status).toBe("complete");
    expect(parallax.samples.at(-1)!.numeric.translateY).toBeCloseTo(-120, 1);
    expect(parallax.scrollLink).toMatchObject({ start: 400, end: 1300, scrub: 500 });
    const found = gsapFindings(await compare(full, smoothed));
    expect(found.map((d) => d.title)).toEqual([
      "gsap on parallax: Scroll setting scrub: on → 500ms",
    ]);
    expect(found[0]).toMatchObject({ severity: "info", category: "scroll" });
  });

  it("reports a moved start once, as the position ScrollTrigger resolved", async () => {
    // "top 70%": the band's top (900px) meets 70% of the 500px viewport at scroll 550.
    const later = await capture(scrolled(1800), "/scrolltrigger.html?start=top%2070%25");
    const found = gsapFindings(await compare(full, later));
    expect(found.map((d) => d.title)).toEqual([
      "gsap on parallax: Starts at scroll position 400px → 550px (+150px)",
    ]);
    expect(found[0]).toMatchObject({
      severity: "warning",
      category: "scroll",
      delta: 150,
      unit: "px",
    });
  });

  it("reports changed toggleActions as a scroll setting", async () => {
    const reversing = await capture(
      scrolled(1800),
      "/scrolltrigger.html?actions=play%20none%20none%20reverse",
    );
    const found = gsapFindings(await compare(full, reversing));
    expect(found.map((d) => d.title)).toEqual([
      "gsap on reveal: Scroll setting toggleActions: play none none none → play none none reverse",
    ]);
    expect(found[0]!.severity).toBe("info");
  });

  it("records and compares positions in a scroll container", async () => {
    // fixtures/scrolltrigger-container.html: the tween runs from panel scroll 100 to 800.
    const steps = [
      { type: "scroll", y: 800, selector: "[data-testid=panel]" },
      { type: "wait", duration: 250 },
      { type: "capture", label: "scrolled" },
    ];
    const before = await capture(steps, "/scrolltrigger-container.html");
    const drift = find(checkpointOf(before).animations, "test-id:drift");
    expect(drift.scrollLink).toEqual({
      start: 100,
      end: 800,
      axis: "vertical",
      scroller: "test-id:panel",
      scrub: 0,
      toggleActions: null,
    });
    expect(drift.completeness.status).toBe("complete");
    // "top 75%": the band's top (500px into the panel) meets 75% of the 400px panel at 200.
    const after = await capture(steps, "/scrolltrigger-container.html?start=top%2075%25");
    expect(gsapFindings(await compare(before, after)).map((d) => d.title)).toEqual([
      "gsap on drift: Starts at scroll position 100px → 200px (+100px)",
    ]);
  });

  it("restores ScrollTrigger animations after replay without firing their callbacks", async () => {
    const context = await browser.newContext({ viewport: { width: 800, height: 500 } });
    await context.addInitScript({ content: AGENT_SOURCE });
    const page = await context.newPage();
    await page.goto(`${server.url}/scrolltrigger.html`);
    await page.evaluate(() => window.__MOTIONPR_AGENT__!.openWindow());
    await page.evaluate(() => window.scrollTo({ top: 850, behavior: "instant" }));
    await page.waitForTimeout(300);
    const read = () =>
      page.evaluate(() => ({
        transform: getComputedStyle(document.querySelector("[data-testid=parallax]")!).transform,
        callbacks: (window as unknown as { callbacks: number }).callbacks,
      }));
    const before = await read();
    const samples = await page.evaluate(() => {
      const agent = window.__MOTIONPR_AGENT__!;
      const collected = agent.collect();
      agent.beginReplay();
      for (const t of [0, 100, collected.end]) agent.seek(t);
      const series = agent.sample(8);
      agent.endReplay();
      const i = collected.animations.findIndex((a) => a.element.key === "test-id:parallax");
      return series[i]!.map((s) => s.scrollProgress);
    });
    expect(samples).toHaveLength(8);
    expect(samples.at(-1)!).toBeCloseTo(0.5, 2);
    expect(await read()).toEqual(before);
    // ScrollTrigger still drives the tween afterwards.
    await page.evaluate(() => window.scrollTo({ top: 1300, behavior: "instant" }));
    await page.waitForTimeout(300);
    expect((await read()).transform).toMatch(/-120\)$/);
    await context.close();
  });
});

describe("GSAP adapter: targets inside shadow roots", () => {
  it("identifies each target through its component's host and samples it", async () => {
    const bundle = await capture(
      [
        { type: "click", selector: "[data-testid=play]" },
        { type: "capture", label: "played" },
      ],
      "/shadow.html",
    );
    const scenario = bundle.scenarios[0]!;
    expect(scenario.status, scenario.error?.message).toBe("passed");
    const records = scenario.checkpoints[0]!.animations;
    expect(records.map((r) => r.element.key)).toEqual([
      "test-id:tile-1 >> motionpr-id:dot",
      "test-id:tile-2 >> motionpr-id:dot",
      "test-id:tile-3 >> motionpr-id:dot",
    ]);
    // One staggered tween: per-target records in one group, 100 ms apart.
    expect(new Set(records.map((r) => r.group)).size).toBe(1);
    for (const [i, r] of records.entries()) {
      expect(r).toMatchObject({ type: "gsap", element: { shadowHost: `test-id:tile-${i + 1}` } });
      expect(Math.round(r.startTime! + r.timing.delay)).toBe(i * 100);
      expect(r.samples.at(0)!.numeric.translateX).toBeCloseTo(0, 1);
      expect(r.samples.at(-1)!.numeric.translateX).toBeCloseTo(120, 0);
    }
  });
});
