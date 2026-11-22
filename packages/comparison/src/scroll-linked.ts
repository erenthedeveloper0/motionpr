import {
  SHADOW_SEPARATOR,
  type AnimationRecord,
  type ChangeKind,
  type ComparisonConfig,
  type ScrollLink,
  type ScrollMotionRecord,
} from "@motionpr/core";
import { magnitudeSeverity, type ChangeDraft } from "./severity.ts";

const POINTS = 33;
/** Minimum shared scroll range (px) for a meaningful comparison. */
const MIN_RANGE = 40;

function positionAt(scroll: ScrollMotionRecord, t: number): number {
  const s = scroll.samples;
  if (t <= s[0]!.time) return s[0]!.animatedScroll;
  for (let i = 1; i < s.length; i++) {
    if (t <= s[i]!.time) {
      const a = s[i - 1]!;
      const b = s[i]!;
      return b.time === a.time
        ? b.animatedScroll
        : a.animatedScroll +
            ((b.animatedScroll - a.animatedScroll) * (t - a.time)) / (b.time - a.time);
    }
  }
  return s[s.length - 1]!.animatedScroll;
}

/** (scroll position, progress) pairs, sorted by position. */
export function progressByPosition(
  r: AnimationRecord,
  scroll: ScrollMotionRecord,
): { pos: number; progress: number }[] {
  return r.progressTrace
    .map((p) => ({ pos: positionAt(scroll, p.time), progress: p.progress }))
    .sort((a, b) => a.pos - b.pos);
}

function progressAtPosition(
  points: readonly { pos: number; progress: number }[],
  pos: number,
): number {
  if (pos <= points[0]!.pos) return points[0]!.progress;
  for (let i = 1; i < points.length; i++) {
    if (pos <= points[i]!.pos) {
      const a = points[i - 1]!;
      const b = points[i]!;
      return b.pos === a.pos
        ? b.progress
        : a.progress + ((b.progress - a.progress) * (pos - a.pos)) / (b.pos - a.pos);
    }
  }
  return points[points.length - 1]!.progress;
}

function movingScroll(records: readonly ScrollMotionRecord[]): ScrollMotionRecord | null {
  return (
    records.find((r) =>
      r.samples.some(
        (s, i) => i > 0 && Math.abs(s.animatedScroll - r.samples[i - 1]!.animatedScroll) > 0.01,
      ),
    ) ?? null
  );
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const px = (n: number) => `${Math.round(n * 10) / 10}px`;
const scroller = (l: ScrollLink) =>
  `${l.scroller ?? "document"}${l.axis === "horizontal" ? " (horizontal)" : ""}`;
const scrubText = (s: number | null) =>
  s === null ? "off (plays once triggered)" : s === 0 ? "on" : `${round2(s)}ms`;

/**
 * Compares where two scroll-linked animations run in the scroll, from the positions their engine
 * resolved (ScrollTrigger's `start` and `end`), and how their progress follows the scroll
 * (`scrub`, `toggleActions`). These are read from the engine, so two runs of one build agree in
 * every browser engine, also under native smooth scrolling.
 *
 * Returns null when either record has no resolved positions (captures from before MotionPR
 * recorded them, `containerAnimation` triggers, adapters that do not report them): the caller
 * then compares progress at the same scroll position instead ({@link scrollLinkedChange}).
 *
 * `shadowLegacy` names the capture made before MotionPR identified elements inside shadow roots
 * through their host: a scroller there is the same as the other's when only the host is missing.
 */
export function scrollLinkChanges(
  b: AnimationRecord,
  c: AnimationRecord,
  config: ComparisonConfig,
  shadowLegacy: "baseline" | "candidate" | null = null,
): ChangeDraft[] | null {
  const lb = b.scrollLink;
  const lc = c.scrollLink;
  if (!lb || !lc) return null;
  const sc = config.scroll;
  const drafts: ChangeDraft[] = [];
  const [older, newer] = shadowLegacy === "candidate" ? [lc, lb] : [lb, lc];
  const sameScroller =
    lb.scroller === lc.scroller ||
    (shadowLegacy !== null &&
      older.scroller !== null &&
      newer.scroller !== null &&
      newer.scroller.endsWith(SHADOW_SEPARATOR + older.scroller));

  if (!sameScroller || lb.axis !== lc.axis) {
    // Positions on different scrollers or axes are not comparable.
    drafts.push({
      kind: "scroll-config",
      rule: "scroll-curve",
      property: "scroller",
      before: scroller(lb),
      after: scroller(lc),
      measurement: "measured",
      severity: "warning",
      message: `Scroll-linked to ${scroller(lb)} → ${scroller(lc)}`,
    });
  } else {
    for (const [kind, label, before, after] of [
      ["scroll-start", "Starts at scroll position", lb.start, lc.start],
      ["scroll-end", "Ends at scroll position", lb.end, lc.end],
    ] as const) {
      const delta = round2(after - before);
      const severity = magnitudeSeverity(
        Math.abs(delta),
        sc.positionTolerancePx,
        sc.warnPositionPx,
      );
      if (!severity) continue;
      drafts.push({
        kind,
        rule: "scroll-position",
        before,
        after,
        delta,
        unit: "px",
        measurement: "measured",
        severity,
        message: `${label} ${px(before)} → ${px(after)} (${delta > 0 ? "+" : ""}${px(delta)})`,
      });
    }
  }

  if (lb.scrub !== lc.scrub) {
    // Scrubbed ↔ played once triggered changes what drives the animation; a different
    // smoothing time only changes how closely it follows the scroll.
    const modeChanged = (lb.scrub === null) !== (lc.scrub === null);
    drafts.push({
      kind: "scroll-config",
      rule: "scroll-curve",
      property: "scrub",
      before: lb.scrub,
      after: lc.scrub,
      ...(modeChanged ? {} : { delta: round2(lc.scrub! - lb.scrub!), unit: "ms" }),
      measurement: "measured",
      severity: modeChanged ? "warning" : "info",
      message: `Scroll setting scrub: ${scrubText(lb.scrub)} → ${scrubText(lc.scrub)}`,
    });
  } else if (lb.toggleActions !== lc.toggleActions) {
    drafts.push({
      kind: "scroll-config",
      rule: "scroll-curve",
      property: "toggleActions",
      before: lb.toggleActions,
      after: lc.toggleActions,
      measurement: "measured",
      severity: "info",
      message: `Scroll setting toggleActions: ${lb.toggleActions ?? "none"} → ${lc.toggleActions ?? "none"}`,
    });
  }
  return drafts;
}

/**
 * Compares a scroll-linked animation (e.g. GSAP ScrollTrigger with scrub) by its progress at the
 * same scroll positions: a moved trigger point or a changed scrub range shows up here even
 * though the animation itself cannot be replayed. Returns null when there is not enough data.
 *
 * This relates two live recordings, so it depends on how each run's scroll was scheduled (noisy
 * under native smooth scrolling in Firefox and WebKit). It is used only for records without
 * resolved positions; see {@link scrollLinkChanges}.
 */
export function scrollLinkedChange(
  b: AnimationRecord,
  c: AnimationRecord,
  scrollB: readonly ScrollMotionRecord[],
  scrollC: readonly ScrollMotionRecord[],
  config: ComparisonConfig,
): ChangeDraft | null {
  if (b.progressTrace.length < 2 || c.progressTrace.length < 2) return null;
  const sb = movingScroll(scrollB);
  const sc = movingScroll(scrollC);
  if (!sb || !sc) return null;
  const pb = progressByPosition(b, sb);
  const pc = progressByPosition(c, sc);
  const lo = Math.max(pb[0]!.pos, pc[0]!.pos);
  const hi = Math.min(pb.at(-1)!.pos, pc.at(-1)!.pos);
  if (hi - lo < MIN_RANGE) return null;
  let max = 0;
  let at = lo;
  let before = 0;
  let after = 0;
  for (let k = 0; k < POINTS; k++) {
    const pos = lo + ((hi - lo) * k) / (POINTS - 1);
    const vb = progressAtPosition(pb, pos);
    const vc = progressAtPosition(pc, pos);
    if (Math.abs(vc - vb) > max) {
      max = Math.abs(vc - vb);
      at = pos;
      before = vb;
      after = vc;
    }
  }
  if (max <= config.scroll.curveTolerance) return null;
  const kind: ChangeKind = "scroll-progress";
  return {
    kind,
    rule: "scroll-curve",
    before: Math.round(before * 1000) / 1000,
    after: Math.round(after * 1000) / 1000,
    delta: Math.round(max * 1000) / 1000,
    measurement: "measured",
    severity: max >= config.scroll.warnCurveDeviation ? "warning" : "info",
    message: `Scroll-linked progress at the same scroll position differs by up to ${Math.round(max * 100)}% (at ${Math.round(at)}px: ${Math.round(before * 100)}% → ${Math.round(after * 100)}%)`,
  };
}
