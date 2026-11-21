import { describe, expect, it } from "vitest";
import {
  SHADOW_SEPARATOR,
  resolveConfig,
  type AnimationRecord,
  type ScrollLink,
  type ScrollMotionRecord,
} from "@motionpr/core";
import { elementName } from "../src/compare.ts";
import { compareCaptures, matchAnimations, staggerIntervals } from "../src/index.ts";
import { scrollLinkChanges } from "../src/scroll-linked.ts";
import { anim, bundle, checkpoint, element, scenario, type AnimOptions } from "./helpers.ts";

/** A record of an element inside the shadow root of `host`, identified through it. */
function inShadow(host: string, inner: string, o: AnimOptions = {}): AnimationRecord {
  const r = anim({ ...o, key: `${host}${SHADOW_SEPARATOR}${inner}` });
  r.element = {
    ...r.element,
    shadowHost: host,
    method: inner.startsWith("path:") ? "dom-path" : "motionpr-id",
  };
  if (inner.startsWith("path:")) r.element.confidence = "low";
  return r;
}

const comparisonConfig = (severity: Record<string, string> = {}) => {
  const c = resolveConfig({ baseURL: "http://x", scenarios: [{ id: "x" }] }).comparison;
  return { ...c, visual: { ...c.visual, enabled: false }, severity } as never;
};

async function differences(
  b: { animations?: AnimationRecord[]; scroll?: ScrollMotionRecord[]; shadowRoots: boolean },
  c: { animations?: AnimationRecord[]; scroll?: ScrollMotionRecord[]; shadowRoots: boolean },
  severity: Record<string, string> = {},
) {
  const side = (s: typeof b) => {
    const made = bundle([
      scenario("s", [checkpoint("open", s.animations ?? [], { scrollMotion: s.scroll ?? [] })]),
    ]);
    return { ...made, settings: { ...made.settings, shadowRoots: s.shadowRoots } };
  };
  const result = await compareCaptures({
    baseline: { bundle: side(b), dir: "." },
    candidate: { bundle: side(c), dir: "." },
    config: comparisonConfig(severity),
  });
  return result.differences;
}

describe("elements inside shadow roots", () => {
  it("names them by their hosts and their identity within the root", () => {
    expect(elementName(inShadow("test-id:plan-2", "motionpr-id:glow"))).toBe("plan-2 >> glow");
    expect(elementName(inShadow("test-id:outer >> test-id:inner", "motionpr-id:spark"))).toBe(
      "outer >> inner >> spark",
    );
    const bar = inShadow("test-id:plan-1", "path:#shadow-root>div:nth-of-type(2)");
    expect(elementName(bar)).toBe("plan-1 >> path:#shadow-root>div:nth-of-type(2)");
    bar.element.label = "Buy";
    expect(elementName(bar)).toBe("plan-1 >> “Buy”");
    // Outside shadow roots nothing changes.
    expect(elementName(anim({ key: "test-id:menu" }))).toBe("menu");
  });

  it("groups the same element of numbered components into one stagger family", () => {
    const cards = (interval: number, inner: string) =>
      [1, 2, 3, 4].map((i) =>
        inShadow(`test-id:card-${i}`, inner, {
          type: "web-animation",
          name: "in",
          delay: i * interval,
        }),
      );
    // An index in the inner key is the element's place in the template, not an instance.
    const intervals = staggerIntervals([
      ...cards(60, "motionpr-id:glow"),
      ...cards(40, "path:#shadow-root>div:nth-of-type(2)"),
    ]);
    expect([...intervals.values()]).toEqual([
      { interval: 60, members: 4 },
      { interval: 40, members: 4 },
    ]);
    // Items inside one component (the host has no index) form a family by their own index.
    const items = [1, 2, 3].map((i) =>
      inShadow("test-id:list", `test-id:item-${i}`, {
        type: "web-animation",
        name: "in",
        delay: i * 30,
      }),
    );
    expect([...staggerIntervals(items).values()]).toEqual([{ interval: 30, members: 3 }]);
  });
});

describe("comparing with a capture made before MotionPR looked inside shadow roots", () => {
  it("pairs records by their key within the shadow root, as uncertain", () => {
    const old = [anim({ key: "motionpr-id:flash", duration: 300 })];
    const current = [inShadow("test-id:plan-1", "motionpr-id:flash", { duration: 300 })];
    expect(matchAnimations(old, current).matches).toEqual([]);
    const { matches, added, removed } = matchAnimations(old, current, { shadowLegacy: "baseline" });
    expect([added, removed]).toEqual([[], []]);
    expect(matches).toEqual([
      expect.objectContaining({
        method: "fuzzy",
        confidence: "low",
        uncertain: "the baseline was captured before MotionPR looked inside shadow roots",
      }),
    ]);
    expect(matches[0]!.notes[0]).toBe(
      "Element identity changed from motionpr-id:flash to test-id:plan-1 >> motionpr-id:flash: the baseline was captured before MotionPR identified elements inside shadow roots through their host.",
    );
    // Either capture may be the older one.
    expect(matchAnimations(current, old, { shadowLegacy: "candidate" }).matches).toHaveLength(1);
  });

  it("grades what changed, appeared or disappeared there as uncertain", async () => {
    const found = await differences(
      {
        shadowRoots: false,
        animations: [
          anim({ key: "motionpr-id:flash", type: "web-animation", name: "flash", duration: 300 }),
          // Identified by a path from the top of the root, which read as <body> then.
          anim({ key: "path:body>div", type: "web-animation", name: null }),
          // Light DOM: compared as always.
          anim({ key: "test-id:menu", duration: 200 }),
          anim({ key: "test-id:gone" }),
        ],
      },
      {
        shadowRoots: true,
        animations: [
          inShadow("test-id:plan-1", "motionpr-id:flash", {
            type: "web-animation",
            name: "flash",
            duration: 400,
          }),
          inShadow("test-id:plan-1", "path:#shadow-root>div:nth-of-type(2)", {
            type: "web-animation",
            name: null,
          }),
          // CSS motion inside shadow roots was not recorded before.
          inShadow("test-id:plan-1", "motionpr-id:glow"),
          anim({ key: "test-id:menu", duration: 350 }),
        ],
      },
    );
    const by = (key: string) => found.filter((d) => d.animationKey === key);
    // Changes of a pair are reported under the baseline's record id.
    expect(
      by("motionpr-id:flash::web-animation::flash").map((d) => [d.severity, d.detail]),
    ).toEqual([
      ["uncertain", expect.stringMatching(/^Element identity changed from motionpr-id:flash/)],
      [
        "uncertain",
        "Duration 300ms → 400ms (+100ms, +33.33%) (the baseline was captured before MotionPR looked inside shadow roots)",
      ],
    ]);
    expect(by("test-id:plan-1 >> motionpr-id:glow::css-transition::transform")).toEqual([
      expect.objectContaining({
        severity: "uncertain",
        category: "added",
        detail: expect.stringContaining(
          "The baseline was captured before MotionPR looked inside shadow roots (MotionPR 0.4.0-alpha or earlier), so this is uncertain; capture it again to compare this animation.",
        ),
      }),
    ]);
    // The old record of the bar may be the new one: the same type of animation inside a root
    // was not paired.
    expect(by("path:body>div::web-animation::anonymous")).toEqual([
      expect.objectContaining({
        severity: "uncertain",
        category: "removed",
        detail: expect.stringContaining(
          "the candidate may record this animation inside a shadow root under a new identity, so this is uncertain; capture the baseline again to compare it.",
        ),
      }),
    ]);
    // Any record of the older capture may be one the candidate now finds inside a root, when
    // that one has no counterpart and is of the same type (the glow is a transition too).
    expect(by("test-id:gone::css-transition::transform")[0]!.severity).toBe("uncertain");
    expect(by("test-id:menu::css-transition::transform")[0]!.severity).toBe("warning");
  });

  it("keeps regressions of other types and capture pairs that both looked inside", async () => {
    const removedLight = await differences(
      { shadowRoots: false, animations: [anim({ key: "test-id:gone", type: "web-animation" })] },
      {
        shadowRoots: true,
        animations: [inShadow("test-id:plan-1", "motionpr-id:glow", { type: "css-transition" })],
      },
    );
    expect(removedLight.find((d) => d.category === "removed")!.severity).toBe("critical");
    const both = await differences(
      { shadowRoots: true, animations: [] },
      { shadowRoots: true, animations: [inShadow("test-id:plan-1", "motionpr-id:glow")] },
    );
    expect(both.map((d) => d.severity)).toEqual(["warning"]);
    // A severity set for the rule still applies.
    const configured = await differences(
      { shadowRoots: false, animations: [] },
      { shadowRoots: true, animations: [inShadow("test-id:plan-1", "motionpr-id:glow")] },
      { "animation-added": "critical" },
    );
    expect(configured.map((d) => [d.severity, d.detail])).toEqual([
      ["critical", "New animation (400ms, delay 0ms, ease-out, transform)."],
    ]);
  });

  it("is uncertain about scroll containers inside shadow roots", async () => {
    const list: ScrollMotionRecord = {
      id: "native:test-id:inbox >> test-id:list:vertical",
      source: "native",
      sessionId: "container",
      axis: "vertical",
      wrapper: {
        ...element("test-id:inbox >> test-id:list"),
        shadowHost: "test-id:inbox",
      },
      config: { scrollBehavior: "auto", scrollSnapType: "none" },
      samples: [0, 300, 600].map((pos, i) => ({
        time: i * 100,
        actualScroll: pos,
        animatedScroll: pos,
        targetScroll: 600,
        progress: pos / 1300,
        velocity: i ? 3 : 0,
        direction: i ? 1 : 0,
        isScrolling: i < 2,
        isStopped: false,
        limit: 1300,
      })),
      events: 3,
      prefersReducedMotion: false,
      completeness: { status: "complete", reasons: [] },
      meta: {},
    };
    const added = await differences({ shadowRoots: false }, { shadowRoots: true, scroll: [list] });
    expect(added).toEqual([
      expect.objectContaining({
        severity: "uncertain",
        title: "New native scroll motion (native:test-id:inbox >> test-id:list:vertical)",
        detail:
          "The candidate recorded this scroller moving 600px; the baseline did not. The baseline was captured before MotionPR looked inside shadow roots (MotionPR 0.4.0-alpha or earlier), so this is uncertain; capture it again to compare this scroller.",
      }),
    ]);
    const both = await differences({ shadowRoots: true }, { shadowRoots: true, scroll: [list] });
    expect(both.map((d) => d.severity)).toEqual(["warning"]);
  });

  it("treats a ScrollTrigger scroller inside a shadow root as the same scroller", () => {
    const linked = (scroller: string): AnimationRecord => {
      const link: ScrollLink = {
        start: 400,
        end: 1300,
        axis: "vertical",
        scroller,
        scrub: 0,
        toggleActions: null,
      };
      return { ...anim({ type: "gsap" }), startTime: null, timeline: "scroll", scrollLink: link };
    };
    const old = linked("test-id:panel");
    const current = linked("test-id:app >> test-id:panel");
    const config = comparisonConfig();
    expect(scrollLinkChanges(old, current, config, "baseline")).toEqual([]);
    expect(scrollLinkChanges(current, old, config, "candidate")).toEqual([]);
    expect(scrollLinkChanges(old, current, config)![0]!.message).toBe(
      "Scroll-linked to test-id:panel → test-id:app >> test-id:panel",
    );
  });
});
