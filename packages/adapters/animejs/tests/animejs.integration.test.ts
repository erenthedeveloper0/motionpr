import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  resolveConfig,
  type AnimationRecord,
  type CaptureBundle,
  type Checkpoint,
} from "@motionpr/core";
import { AGENT_SOURCE } from "@motionpr/capture";
import { compareCaptures } from "@motionpr/comparison";
import { startHarness, type Harness } from "./harness.ts";

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h?.close();
});

const click = (id: string, label = id, variant = "") => [
  ...(variant ? [{ type: "goto", path: `/anime.html?variant=${variant}` }] : []),
  { type: "click", selector: `[data-testid=${id}]` },
  { type: "capture", label },
];

function checkpoint(bundle: CaptureBundle): Checkpoint {
  const scenario = bundle.scenarios[0]!;
  expect(scenario.status, scenario.error?.message).toBe("passed");
  return scenario.checkpoints[0]!;
}

const find = (records: AnimationRecord[], key: string) => {
  const r = records.find((a) => a.element.key === key);
  if (!r) throw new Error(`no record for ${key}: ${records.map((a) => a.id).join(", ")}`);
  return r;
};

const tx = (r: AnimationRecord, i: number) => r.samples[i]!.numeric.translateX;

async function compare(id: string) {
  const baseline = await h.capture("/anime.html", click(id));
  const candidate = await h.capture("/anime.html", click(id, id, "candidate"));
  const dir = (_bundle: CaptureBundle) => join(h.root, "unused");
  const config = resolveConfig({ baseURL: h.server.url, scenarios: [{ id: "x" }] }).comparison;
  return compareCaptures({
    baseline: { bundle: baseline, dir: dir(baseline) },
    candidate: { bundle: candidate, dir: dir(candidate) },
    config: { ...config, visual: { ...config.visual, enabled: false } },
  });
}

describe("Anime.js adapter: records (real Anime.js 4.5)", () => {
  it("reports animate() with Anime.js identity, declared timing and an exact named ease", async () => {
    const cp = checkpoint(await h.capture("/anime.html", click("basic")));
    const box = find(cp.animations, "test-id:box");
    expect(box).toMatchObject({ type: "animejs", source: "animejs", driver: "javascript" });
    expect(box.timing).toMatchObject({ duration: 600, delay: 0, iterations: 1, playbackRate: 1 });
    expect(box.timing.easing).toMatchObject({
      value: "out(3)",
      kind: "animejs",
      samplesSource: "exact",
    });
    expect(box.provenance).toMatchObject({ duration: "declared", startTime: "observed" });
    expect(box.completeness.status).toBe("complete");
    expect(tx(box, 0)).toBeCloseTo(0, 0);
    expect(tx(box, box.samples.length - 1)).toBeCloseTo(200, 0);
    // out(3) is ahead of linear at mid-time.
    expect(tx(box, 5)!).toBeGreaterThan(150);
    const combo = find(cp.animations, "test-id:combo");
    expect(combo.properties.map((p) => p.property)).toEqual(["opacity", "transform"]);
    expect(cp.diagnostics.filter((d) => d.code === "POSSIBLE_DUPLICATE_RECORDS")).toEqual([]);
  });

  it("records each staggered target with the delay Anime.js actually used", async () => {
    const cp = checkpoint(await h.capture("/anime.html", click("stagger")));
    const items = [1, 2, 3, 4].map((i) => find(cp.animations, `test-id:item-${i}`));
    expect(items.map((r) => r.timing.delay)).toEqual([0, 80, 160, 240]);
    expect(items.every((r) => r.timing.duration === 400)).toBe(true);
    expect(new Set(items.map((r) => r.group)).size).toBe(1);
    expect(items[0]!.group).not.toBeNull();
    expect(items[0]!.provenance.delay).toBe("observed");
    // Each target reaches its end state; staggered starts are reflected in the samples.
    for (const r of items) expect(r.samples.at(-1)!.numeric.translateY).toBeCloseTo(0, 0);
  });

  it("links timeline children to a TimelineRecord with labels and positions", async () => {
    const cp = checkpoint(await h.capture("/anime.html", click("timeline")));
    const tl = cp.timelines.find((t) => t.id === "animejs:intro-tl");
    expect(tl).toBeDefined();
    expect(tl!.duration).toBe(1000);
    expect(tl!.labels).toEqual([
      { name: "intro", time: 0 },
      { name: "middle", time: 400 },
      { name: "outro", time: 600 },
    ]);
    const [a, b, c] = ["tl-a", "tl-b", "tl-c"].map((k) => find(cp.animations, `test-id:${k}`));
    expect(tl!.children).toEqual([a!.id, b!.id, c!.id]);
    expect(a!.parent).toBe(tl!.id);
    // "-=200" places b 200 ms after a; c follows b's end at 600 ms.
    expect(b!.startTime! - a!.startTime!).toBeCloseTo(200, -1);
    expect(c!.startTime! - a!.startTime!).toBeCloseTo(600, -1);
    expect(c!.name).toBe("intro-tl@outro");
    expect(a!.timing.easing.value).toBe("outQuad");
  });

  it("creates one child per target for a stagger position", async () => {
    const cp = checkpoint(await h.capture("/anime.html", click("tl-stagger")));
    const starts = [1, 2, 3].map((i) => find(cp.animations, `test-id:tls-${i}`).startTime!);
    expect(starts[1]! - starts[0]!).toBeCloseTo(100, -1);
    expect(starts[2]! - starts[0]!).toBeCloseTo(200, -1);
    expect(cp.timelines[0]!.children).toHaveLength(3);
  });

  it("samples custom easing functions without inventing a name", async () => {
    const cp = checkpoint(await h.capture("/anime.html", click("custom")));
    const r = find(cp.animations, "test-id:custom-box");
    expect(r.timing.easing).toMatchObject({
      value: "custom",
      kind: "custom",
      samplesSource: "sampled",
    });
    expect(r.timing.easing.samples![32]).toBeCloseTo(0.125, 3); // t³ at 0.5
  });

  it("records reversed playback and replays it in reverse", async () => {
    const cp = checkpoint(await h.capture("/anime.html", click("reverse")));
    const r = find(cp.animations, "test-id:rev-box");
    expect(r.timing.direction).toBe("reverse");
    expect(tx(r, 0)).toBeCloseTo(160, 0);
    expect(tx(r, r.samples.length - 1)).toBeCloseTo(0, 0);
  });

  it("records playback speed", async () => {
    const cp = checkpoint(await h.capture("/anime.html", click("speed")));
    const r = find(cp.animations, "test-id:speed-box");
    expect(r.timing.playbackRate).toBeCloseTo(2, 1);
    expect(r.timing.duration).toBe(800);
    expect(tx(r, r.samples.length - 1)).toBeCloseTo(120, 0);
  });

  it("records JavaScript object targets as timing-only with a stable adapter identity", async () => {
    const cp = checkpoint(await h.capture("/anime.html", click("object")));
    const r = cp.animations.find((a) => a.element.method === "adapter");
    expect(r).toBeDefined();
    expect(r!.element.key).toBe("adapter:animejs:object:value#0");
    expect(r!.completeness.status).toBe("metadata-only");
    expect(cp.diagnostics.some((d) => d.code === "LOW_CONFIDENCE_IDENTITY")).toBe(false);
  });

  it("samples SVG geometry animated by Anime.js", async () => {
    const cp = checkpoint(await h.capture("/anime.html", click("svg")));
    const r = find(cp.animations, "test-id:dot");
    const cx = r.properties.find((p) => p.property === "cx" || p.property === "attr:cx")!;
    expect(parseFloat(cx.from!)).toBeCloseTo(20, 0);
    expect(parseFloat(cx.to!)).toBeCloseTo(180, 0);
  });

  it("records Anime.js WAAPI animations once, as animejs + waapi", async () => {
    const cp = checkpoint(await h.capture("/anime.html", click("waapi")));
    const records = cp.animations.filter((a) => a.element.key.startsWith("test-id:w-"));
    expect(records.length).toBe(4); // 2 elements × (translateX, opacity)
    expect(records.every((r) => r.source === "animejs" && r.driver === "waapi")).toBe(true);
    expect(cp.animations.some((a) => a.source === "native")).toBe(false);
    expect(records.every((r) => r.completeness.status === "complete")).toBe(true);
  });

  it("captures an animation that was paused and resumed", async () => {
    const cp = checkpoint(
      await h.capture("/anime.html", [
        { type: "click", selector: "[data-testid=pause]" },
        { type: "capture", label: "paused" },
      ]),
    );
    const r = find(cp.animations, "test-id:pause-box");
    expect(r.timing.duration).toBe(600);
    expect(tx(r, r.samples.length - 1)).toBeCloseTo(100, 0);
  });

  it("reports adapter health with the detected Anime.js version", async () => {
    const bundle = await h.capture("/anime.html", click("basic"));
    expect(bundle.scenarios[0]!.adapters).toEqual([
      expect.objectContaining({
        id: "animejs",
        engineVersion: "4.5.0",
        versionStatus: "supported",
        status: "active",
      }),
    ]);
  });
});

describe("Anime.js adapter: comparison", () => {
  it("detects duration and easing changes", async () => {
    const result = await compare("basic");
    const titles = result.differences.map((d) => d.title);
    expect(titles.some((t) => /box.*Duration 600ms → 900ms/.test(t))).toBe(true);
    expect(titles.some((t) => /box.*Easing out\(3\) → inOutQuad/.test(t))).toBe(true);
    expect(result.differences.every((d) => d.source === "animejs")).toBe(true);
  });

  it("detects a stagger interval change", async () => {
    const result = await compare("stagger");
    expect(result.differences.some((d) => /Stagger interval 80ms → 120ms/.test(d.title))).toBe(
      true,
    );
  });

  it("detects a timeline sequence change", async () => {
    const result = await compare("timeline");
    const timing = result.differences.filter((d) => d.source === "animejs").map((d) => d.title);
    expect(timing).toContain("Anime.js timeline “intro-tl”: Timeline duration 1000ms → 1100ms");
    expect(timing).toContain("Anime.js timeline “intro-tl”: Label “outro” moved 600ms → 700ms");
    // Child start offsets are observed from frames, so allow frame-quantization noise.
    const shift = result.differences.find(
      (d) => d.animationKey?.startsWith("test-id:tl-b") && /Starts/.test(d.title),
    );
    expect(shift?.delta).toBeCloseTo(100, -1);
  });

  it("detects custom easing and playback speed changes", async () => {
    const custom = await compare("custom");
    expect(custom.differences.some((d) => d.category === "easing")).toBe(true);
    const speed = await compare("speed");
    expect(speed.differences.some((d) => /Playback rate 2× → 1×/.test(d.title))).toBe(true);
  });

  it("detects WAAPI duration changes on Anime.js-driven Web Animations", async () => {
    const result = await compare("waapi");
    expect(result.differences.some((d) => /Duration 500ms → 700ms/.test(d.title))).toBe(true);
  });

  it("finds no differences between two runs of the same version", async () => {
    const a = await h.capture("/anime.html", click("stagger"));
    const b = await h.capture("/anime.html", click("stagger"));
    const config = resolveConfig({ baseURL: h.server.url, scenarios: [{ id: "x" }] }).comparison;
    const result = await compareCaptures({
      baseline: { bundle: a, dir: h.root },
      candidate: { bundle: b, dir: h.root },
      config: { ...config, visual: { ...config.visual, enabled: false } },
    });
    expect(result.differences.map((d) => d.title)).toEqual([]);
  });
});

describe("Anime.js adapter: safety and lifecycle", () => {
  it("is inert without a MotionPR agent: wrappers return the original functions", async () => {
    const page = await h.browser.newPage();
    await page.goto(`${h.server.url}/anime.html`);
    const state = await page.evaluate(() => {
      const w = window as unknown as {
        anime: { animate: unknown };
        motion: { active: boolean; wrapAnimate(f: unknown): unknown };
      };
      return {
        active: w.motion.active,
        same: w.motion.wrapAnimate(w.anime.animate) === w.anime.animate,
      };
    });
    expect(state).toEqual({ active: false, same: true });
    await page.close();
  });

  it("composes onUpdate, never re-fires callbacks during replay, and restores state", async () => {
    const context = await h.browser.newContext();
    await context.addInitScript({ content: AGENT_SOURCE });
    const page = await context.newPage();
    await page.goto(`${h.server.url}/anime.html`);
    await page.click("[data-testid=basic]");
    await page.evaluate(() => window.__MOTIONPR_AGENT__!.waitForSettle(5000, 120));
    type Counts = { update: number; complete: number; begin: number; pause: number };
    const read = () =>
      page.evaluate(() => {
        const w = window as unknown as { counts: Counts; updateThis: boolean[] };
        return { ...w.counts, thisOk: w.updateThis.every(Boolean) };
      });
    const before = await read();
    expect(before.update).toBeGreaterThan(3);
    expect(before).toMatchObject({ complete: 1, begin: 1, pause: 0, thisOk: true });
    await page.evaluate(() => {
      const agent = window.__MOTIONPR_AGENT__!;
      agent.collect();
      agent.beginReplay();
      for (const t of [0, 300, 600, 50, 450]) agent.seek(t);
      agent.sample(8);
      agent.endReplay();
    });
    await page.waitForTimeout(150);
    expect(await read()).toEqual(before);
    const transform = await page.evaluate(
      () => getComputedStyle(document.querySelector("[data-testid=box]")!).transform,
    );
    expect(transform).toBe("matrix(1, 0, 0, 1, 200, 0)");
    // The application can still drive Anime.js normally afterwards.
    await page.click("[data-testid=basic]");
    await page.waitForTimeout(800);
    expect((await read()).complete).toBe(2);
    await context.close();
  });

  it("keeps a reassigned onUpdate working and restores plain properties on dispose", async () => {
    const context = await h.browser.newContext();
    await context.addInitScript({ content: AGENT_SOURCE });
    const page = await context.newPage();
    await page.goto(`${h.server.url}/anime.html`);
    const result = await page.evaluate(async () => {
      const w = window as unknown as {
        anime: { animate: (t: unknown, p: unknown) => { onUpdate: unknown } };
        MotionprAnime: {
          createAnimeInstrumentation(o?: unknown): { wrapAnimate<F>(f: F): F; dispose(): void };
        };
      };
      const motion = w.MotionprAnime.createAnimeInstrumentation();
      const animate = motion.wrapAnimate(w.anime.animate);
      const el = document.createElement("div");
      document.body.append(el);
      let calls = 0;
      const anim = animate(el, { opacity: [0, 1], duration: 200 });
      anim.onUpdate = () => calls++;
      await new Promise((r) => setTimeout(r, 300));
      const registered = window.__MOTIONPR_AGENT__!.adapters().length;
      motion.dispose();
      const descriptor = Object.getOwnPropertyDescriptor(anim, "onUpdate")!;
      return {
        calls,
        registered,
        afterDispose: window.__MOTIONPR_AGENT__!.adapters().filter((a) => a.name === "animejs")
          .length,
        plain: "value" in descriptor && descriptor.writable === true,
      };
    });
    expect(result.calls).toBeGreaterThan(2);
    expect(result.plain).toBe(true);
    // The page's own instrumentation shares the adapter; it stays registered until both dispose.
    expect(result.registered).toBe(1);
    expect(result.afterDispose).toBe(1);
    await context.close();
  });

  it("validates its input with actionable errors", async () => {
    const context = await h.browser.newContext();
    await context.addInitScript({ content: AGENT_SOURCE });
    const page = await context.newPage();
    await page.goto(`${h.server.url}/anime.html`);
    const message = await page.evaluate(() => {
      try {
        (window as unknown as { motion: { wrapAnimate(f: unknown): unknown } }).motion.wrapAnimate(
          undefined,
        );
        return "no error";
      } catch (error) {
        return String(error);
      }
    });
    expect(message).toMatch(/wrapAnimate\(\) expects Anime\.js's animate function/);
    await context.close();
  });
});

describe("Anime.js adapter: targets inside shadow roots", () => {
  it("identifies each target through its component's host and samples it", async () => {
    const bundle = await h.capture("/shadow.html", [
      { type: "click", selector: "[data-testid=play]" },
      { type: "capture", label: "played" },
    ]);
    const scenario = bundle.scenarios[0]!;
    expect(scenario.status, scenario.error?.message).toBe("passed");
    const records = scenario.checkpoints[0]!.animations;
    expect(records.map((r) => r.element.key)).toEqual([
      "test-id:tile-1 >> motionpr-id:dot",
      "test-id:tile-2 >> motionpr-id:dot",
      "test-id:tile-3 >> motionpr-id:dot",
    ]);
    for (const [i, r] of records.entries()) {
      expect(r).toMatchObject({
        type: "animejs",
        element: { shadowHost: `test-id:tile-${i + 1}` },
      });
      expect(r.timing.delay).toBeCloseTo(i * 100, 0);
      expect(r.samples.at(0)!.numeric.translateX).toBeCloseTo(0, 1);
      expect(r.samples.at(-1)!.numeric.translateX).toBeCloseTo(120, 0);
    }
  });
});

void resolveConfig;
