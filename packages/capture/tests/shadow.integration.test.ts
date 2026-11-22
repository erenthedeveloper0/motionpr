/**
 * Motion inside shadow roots, captured for real in the engine named by MOTIONPR_TEST_BROWSER
 * (CI runs this file in Chromium, Firefox and WebKit). Fixture: fixtures/shadow.html, with open,
 * closed, nested and declarative roots, a scroll container inside a root, an ignored widget and
 * an element replaced while it animates.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  animationKey,
  keyInShadowRoot,
  parseCaptureBundle,
  resolveConfig,
  type AnimationRecord,
  type CaptureBundle,
  type Checkpoint,
  type MotionprConfig,
} from "@motionpr/core";
import { compareCaptures, scrollMetrics } from "@motionpr/comparison";
import { launchBrowser, runCapture } from "../src/index.ts";
import { TEST_BROWSER } from "./helpers/browser.ts";
import { serveDirectory, type StaticServer } from "./helpers/static-server.ts";

const fixtures = fileURLToPath(new URL("./fixtures", import.meta.url));
let server: StaticServer;
let browser: Browser;
let workDir: string;

beforeAll(async () => {
  server = await serveDirectory(fixtures);
  workDir = await mkdtemp(join(tmpdir(), "motionpr-shadow-"));
  browser = await launchBrowser(resolveConfig({ baseURL: server.url, scenarios: [{ id: "x" }] }), {
    browserName: TEST_BROWSER,
  });
});

afterAll(async () => {
  await browser?.close();
  await server?.close();
  await rm(workDir, { recursive: true, force: true });
});

const comparisonConfig = () => {
  const c = resolveConfig({ baseURL: "http://x", scenarios: [{ id: "x" }] }).comparison;
  return { ...c, visual: { ...c.visual, enabled: false } };
};

let n = 0;
async function capture(
  steps: unknown[],
  { path = "/shadow.html", ...extra }: Partial<MotionprConfig> & { path?: string } = {},
): Promise<{ bundle: CaptureBundle; dir: string }> {
  const config = resolveConfig({
    baseURL: server.url,
    browser: { viewport: { width: 800, height: 600 } },
    capture: { samples: 5, waitForNetworkIdle: false, frames: { enabled: false } },
    scenarios: [{ id: "shadow", path, steps }],
    ...extra,
  } as MotionprConfig);
  const dir = join(workDir, `run-${++n}`);
  const { bundle } = await runCapture({ config, rootDir: workDir, outputDir: dir, browser });
  parseCaptureBundle(JSON.parse(await readFile(join(dir, "capture.json"), "utf8")));
  return { bundle, dir };
}

function checkpoint(bundle: CaptureBundle, index = 0): Checkpoint {
  const scenario = bundle.scenarios[0]!;
  expect(scenario.status, scenario.error?.message).toBe("passed");
  return scenario.checkpoints[index]!;
}

function record(cp: Checkpoint, id: string): AnimationRecord {
  const found = cp.animations.find((a) => a.id === id);
  if (!found) throw new Error(`no ${id}; have ${cp.animations.map((a) => a.id).join(", ")}`);
  return found;
}

const open = [
  { type: "click", selector: "[data-testid=open]" },
  { type: "capture", label: "open" },
];
const glow = (card: number) => `test-id:plan-${card} >> motionpr-id:glow::css-transition::opacity`;
const bar = (card: number) =>
  `test-id:plan-${card} >> path:#shadow-root>div:nth-of-type(2)::web-animation::anonymous`;
const LIST = "native:test-id:inbox >> test-id:list:vertical";

describe(`shadow roots: recording (${TEST_BROWSER})`, () => {
  it("records CSS and Web Animations in every kind of shadow root, identified through their hosts", async () => {
    const { bundle } = await capture(open);
    expect(bundle.settings.shadowRoots).toBe(true);
    const cp = checkpoint(bundle);
    expect(cp.animations.map((a) => a.id).sort()).toEqual(
      [
        // Declarative open root (parsed from <template shadowrootmode>): a CSS animation.
        "test-id:dsd >> path:#shadow-root>div::css-animation::pulse",
        // Nested open roots: identified through both hosts.
        "test-id:outer >> test-id:inner >> motionpr-id:spark::css-transition::transform",
        // Repeated components: one key per instance, not one key with #2 and #3.
        ...[1, 2, 3].flatMap((card) => [glow(card), bar(card)]),
        // Closed root (attached by script after the agent loaded).
        "test-id:vault >> path:#shadow-root>div::css-animation::pop",
      ].sort(),
    );
    expect(record(cp, glow(2)).element).toMatchObject({
      key: "test-id:plan-2 >> motionpr-id:glow",
      selector: '[data-testid="plan-2"] >> [data-motionpr-id="glow"]',
      method: "motionpr-id",
      confidence: "high",
      shadowHost: "test-id:plan-2",
    });
    const spark = record(
      cp,
      "test-id:outer >> test-id:inner >> motionpr-id:spark::css-transition::transform",
    );
    expect(spark.element).toMatchObject({
      shadowHost: "test-id:outer >> test-id:inner",
      selector: '[data-testid="outer"] >> [data-testid="inner"] >> [data-motionpr-id="spark"]',
      confidence: "high",
    });
    expect(keyInShadowRoot(spark.element)).toBe("motionpr-id:spark");
    // No identity attribute inside the root: a path from the top of the root, low confidence.
    expect(record(cp, bar(1)).element).toMatchObject({
      method: "dom-path",
      confidence: "low",
      selector: '[data-testid="plan-1"] >> :scope > div:nth-of-type(2)',
    });
    // Declared staggers, sampled from rest to the end in the shadow tree.
    expect([1, 2, 3].map((card) => record(cp, glow(card)).timing.delay)).toEqual([0, 60, 120]);
    for (const a of cp.animations) {
      expect(a.completeness.status, a.id).toBe("complete");
      expect(a.samples.length, a.id).toBe(5);
    }
    const opacity = record(cp, glow(3)).samples.map((s) => Number(s.values.opacity));
    expect(opacity[0]).toBeCloseTo(0.2, 3);
    expect(opacity.at(-1)).toBeCloseTo(1, 3);
    expect(opacity).toEqual([...opacity].sort((a, b) => a - b));
    // The checkpoint waited for motion inside the roots: card 3's bar ends at 120 + 400 ms.
    expect(cp.window.end).toBeGreaterThanOrEqual(519);
    expect(cp.diagnostics.map((d) => d.code)).not.toContain("ANIMATIONS_NOT_SETTLED");
  });

  it("records selectors that Playwright resolves to the same elements", async () => {
    const cp = checkpoint((await capture(open)).bundle);
    const page = await browser.newPage();
    try {
      await page.goto(`${server.url}/shadow.html`);
      for (const a of cp.animations) {
        // Playwright does not pierce closed shadow roots.
        if (a.element.shadowHost === "test-id:vault") continue;
        const tag = await page
          .locator(a.element.selector)
          .evaluate((el) => el.tagName.toLowerCase());
        expect(tag, a.element.selector).toBe(a.element.tag);
      }
    } finally {
      await page.close();
    }
  });

  it("re-finds an element replaced inside a shadow root for replay", async () => {
    const cp = checkpoint(
      (
        await capture([
          { type: "click", selector: "[data-testid=swap]" },
          { type: "capture", label: "swap" },
        ])
      ).bundle,
    );
    const flash = record(cp, "test-id:plan-1 >> motionpr-id:flash::web-animation::anonymous");
    expect(flash.element.shadowHost).toBe("test-id:plan-1");
    const values = flash.samples.map((s) => Number(s.values.opacity));
    expect(values[0]).toBeCloseTo(1, 3);
    expect(values.at(-1)).toBeCloseTo(0.3, 2);
    expect(flash.samples.every((s) => s.box !== null)).toBe(true);
  });

  it("waits for images inside shadow roots after navigation", async () => {
    const { bundle } = await capture([{ type: "capture", label: "loaded" }], {
      path: "/shadow.html?img=1500",
      capture: { networkIdleTimeout: 300, waitForNetworkIdle: false, frames: { enabled: false } },
    });
    expect(bundle.scenarios[0]!.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "IMAGES_NOT_LOADED",
        message: "1 image(s) had not finished loading.",
      }),
    );
  });

  it("skips motion inside the shadow root of a host matching ignore.selectors", async () => {
    const tick = [
      { type: "click", selector: "[data-testid=tick]" },
      { type: "capture", label: "tick" },
    ];
    const recorded = checkpoint((await capture(tick)).bundle);
    expect(recorded.animations.map((a) => a.id)).toEqual([
      "test-id:ticker >> path:#shadow-root>div::css-transition::transform",
    ]);
    const ignored = checkpoint(
      (await capture(tick, { ignore: { selectors: ["[data-testid=ticker]"] } })).bundle,
    );
    expect(ignored.animations).toEqual([]);
    // Not waited for either: the 3 s transition did not hold the checkpoint.
    expect(ignored.window.end).toBe(0);
  });
});

describe(`shadow roots: scroll containers and steps (${TEST_BROWSER})`, () => {
  it("records a container inside a shadow root that a scrollTo step scrolls", async () => {
    const cp = checkpoint(
      (
        await capture([
          // Step selectors are Playwright selectors for every step: they pierce open roots.
          { type: "scrollTo", target: 900, selector: "[data-testid=list]" },
          { type: "waitForScrollSettled" },
          { type: "capture", label: "scrolled" },
        ])
      ).bundle,
    );
    expect(cp.scrollMotion.map((r) => r.id)).toEqual([LIST]);
    const list = cp.scrollMotion[0]!;
    expect(list).toMatchObject({
      source: "native",
      sessionId: "container",
      wrapper: { key: "test-id:inbox >> test-id:list", shadowHost: "test-id:inbox" },
      completeness: { status: "complete" },
    });
    expect(scrollMetrics(list, comparisonConfig())).toMatchObject({ start: 0, end: 900 });
  });

  it("records a container inside a shadow root under a wheel step and when the page scrolls it", async () => {
    const { bundle } = await capture([
      { type: "wheel", deltaY: 300, selector: "[data-testid=list]" },
      { type: "waitForScrollSettled" },
      { type: "capture", label: "wheel" },
      // "jump" is a button inside the component's root.
      { type: "click", selector: "[data-testid=jump]" },
      { type: "waitForScrollSettled" },
      { type: "capture", label: "jump" },
    ]);
    const wheel = checkpoint(bundle, 0);
    expect(wheel.scrollMotion.map((r) => r.id)).toEqual([LIST]);
    expect(scrollMetrics(wheel.scrollMotion[0]!, comparisonConfig())).toMatchObject({
      start: 0,
      end: 300,
    });
    const jump = checkpoint(bundle, 1);
    expect(jump.window.trigger).toMatchObject({ type: "click" });
    expect(jump.scrollMotion.map((r) => r.id)).toEqual([LIST]);
    const metrics = scrollMetrics(jump.scrollMotion[0]!, comparisonConfig());
    expect(metrics).toMatchObject({ start: 300, end: 600, unsettled: false });
    expect(metrics.duration!).toBeGreaterThan(150);
  });

  it("finds the elements of scroll and scrollTo steps with Playwright, inside shadow roots too", async () => {
    const { bundle } = await capture([
      // Instant positioning inside a root; the smooth scroll then starts from there.
      { type: "scroll", y: 300, selector: "[data-testid=list]" },
      { type: "capture", label: "positioned" },
      { type: "scrollTo", target: 500, selector: "[data-testid=inbox] >> [data-testid=list]" },
      { type: "waitForScrollSettled" },
      { type: "capture", label: "scrolled" },
      // A target inside a root, in Playwright's text engine.
      { type: "scrollTo", target: "text=Footer note", behavior: "instant" },
      { type: "capture", label: "footer" },
    ]);
    const scrolled = checkpoint(bundle, 1);
    expect(scrollMetrics(scrolled.scrollMotion[0]!, comparisonConfig())).toMatchObject({
      start: 300,
      end: 500,
    });
    const footer = checkpoint(bundle, 2);
    // The note sits 1400px down; the document scrolled to it (as far as it can).
    expect(footer.scroll.y).toBeGreaterThan(1000);
  });

  it("fails a scroll step whose selector matches nothing, after the action timeout", async () => {
    const { bundle } = await capture(
      [{ type: "scrollTo", target: 100, selector: "[data-testid=missing]" }],
      { capture: { actionTimeout: 300, waitForNetworkIdle: false, frames: { enabled: false } } },
    );
    const scenario = bundle.scenarios[0]!;
    expect(scenario.status).toBe("failed");
    expect(scenario.error?.message).toContain(
      "No element matches [data-testid=missing] (waited 300 ms).",
    );
  });
});

describe(`shadow roots: comparison (${TEST_BROWSER})`, () => {
  const scenario = [
    ...open,
    { type: "click", selector: "[data-testid=jump]" },
    { type: "waitForScrollSettled" },
    { type: "capture", label: "jump" },
  ];
  /** Findings two runs of one build must never produce (see containers.integration.test.ts). */
  const regressions = (differences: { severity: string; detail: string }[]) =>
    differences.filter(
      (d) =>
        d.severity === "warning" ||
        d.severity === "critical" ||
        /^Scroll (starts at|ends at|target|takes) /.test(d.detail) ||
        (d.severity === "uncertain" && !/reached the page unevenly/.test(d.detail)),
    );

  it("finds no regression between two runs of one build", async () => {
    const a = await capture(scenario);
    const b = await capture(scenario);
    const result = await compareCaptures({ baseline: a, candidate: b, config: comparisonConfig() });
    expect(regressions(result.differences)).toEqual([]);
    expect(result.differences.filter((d) => d.category !== "scroll")).toEqual([]);
  });

  it("reports a changed duration on each instance and a changed stagger across components", async () => {
    const before = await capture(open);
    const after = await capture(open, { path: "/shadow.html?glow=450&stagger=120" });
    const result = await compareCaptures({
      baseline: before,
      candidate: after,
      config: comparisonConfig(),
    });
    for (const card of [1, 2, 3]) {
      expect(
        result.differences.filter((d) => d.animationKey === glow(card)).map((d) => d.detail),
      ).toContain("Duration 300ms → 450ms (+150ms, +50%)");
    }
    expect(result.differences.find((d) => d.animationKey === glow(2))?.title).toBe(
      "css-transition “opacity” on plan-2 >> glow: Duration 300ms → 450ms (+150ms, +50%)",
    );
    // One stagger family for the glows (motionpr-id) and one for the bars (a path inside each
    // card): the cards are numbered, so the same element of each card is one family.
    expect(
      result.differences.filter(
        (d) => d.title === "Stagger interval 60ms → 120ms across 3 elements",
      ),
    ).toHaveLength(2);
  });

  it("is uncertain, not a regression, against a baseline made before MotionPR looked inside shadow roots", async () => {
    const current = await capture(scenario);
    // What a 0.4.0-alpha baseline of the same build looks like: CSS motion inside shadow roots
    // was not seen, Web Animations there were identified without their host (a path from the
    // top of the root read as `path:body>…`), and containers inside roots were not recorded.
    const old = structuredClone(current.bundle);
    old.settings.shadowRoots = false;
    for (const cp of old.scenarios[0]!.checkpoints) {
      cp.animations = cp.animations
        .filter((a) => !a.element.shadowHost || a.type === "web-animation")
        .map((a, i, all) => {
          if (!a.element.shadowHost) return a;
          const element = { ...a.element, key: "path:body>div", selector: "body > div" };
          delete element.shadowHost;
          const base = animationKey(element.key, a.type, a.name);
          const dup = all.slice(0, i).filter((x) => x.type === a.type && x.element.shadowHost);
          return { ...a, id: dup.length ? `${base}#${dup.length + 1}` : base, element };
        });
      cp.scrollMotion = cp.scrollMotion.filter((r) => !r.wrapper?.shadowHost);
    }
    const result = await compareCaptures({
      baseline: { bundle: old, dir: current.dir },
      candidate: current,
      config: comparisonConfig(),
    });
    expect(
      result.differences.filter((d) => d.severity !== "uncertain").map((d) => d.title),
    ).toEqual([]);
    const added = result.differences.filter((d) => d.category === "added");
    expect(added.length).toBeGreaterThan(0);
    for (const d of added)
      expect(d.detail).toContain(
        "The baseline was captured before MotionPR looked inside shadow roots (MotionPR 0.4.0-alpha or earlier), so this is uncertain",
      );
    const removed = result.differences.filter((d) => d.category === "removed");
    expect(removed.map((d) => d.severity)).toEqual(["uncertain", "uncertain", "uncertain"]);
    expect(
      result.differences.find((d) => d.scrollKey === LIST && d.category === "scroll"),
    ).toMatchObject({ severity: "uncertain", title: `New native scroll motion (${LIST})` });
  });
});
