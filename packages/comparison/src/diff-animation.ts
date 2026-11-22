import {
  EASING_SAMPLE_COUNT,
  colorDistance,
  compareEasingSamples,
  cssEasingsEquivalent,
  parseCssColor,
  parseCssNumeric,
  resampleEasing,
  type AnimationComparison,
  type AnimationRecord,
  type ComparisonConfig,
  type FrameSample,
  type NumericSnapshot,
} from "@motionpr/core";
import type { AnimationMatch } from "./match.ts";
import {
  capSeverity,
  finalizeChanges,
  magnitudeSeverity,
  timingSeverity,
  type ChangeDraft,
} from "./severity.ts";

/** Properties whose animation changes an element's layout box. */
const LAYOUT_PROPERTIES =
  /^(width|height|min-|max-|inset|top|left|right|bottom|margin|padding|border(-.*)?-width|grid-template|flex|font-size|line-height|letter-spacing|gap|row-gap|column-gap|aspect-ratio)/;

const fmtMs = (n: number) => `${Math.round(n * 10) / 10}ms`;
const signed = (n: number, unit = "") => `${n > 0 ? "+" : ""}${Math.round(n * 100) / 100}${unit}`;
const NUMERIC_CHANNELS: {
  key: keyof NumericSnapshot;
  label: string;
  unit: string;
  kind: "trajectory" | "opacity" | "size";
}[] = [
  { key: "translateX", label: "translateX", unit: "px", kind: "trajectory" },
  { key: "translateY", label: "translateY", unit: "px", kind: "trajectory" },
  { key: "translateZ", label: "translateZ", unit: "px", kind: "trajectory" },
  { key: "rotate", label: "rotate", unit: "deg", kind: "trajectory" },
  { key: "scaleX", label: "scaleX", unit: "", kind: "size" },
  { key: "scaleY", label: "scaleY", unit: "", kind: "size" },
  { key: "opacity", label: "opacity", unit: "", kind: "opacity" },
];

function isComplete(r: AnimationRecord): boolean {
  return r.completeness.status === "complete";
}

function timingChanges(
  b: AnimationRecord,
  c: AnimationRecord,
  config: ComparisonConfig,
): ChangeDraft[] {
  const out: ChangeDraft[] = [];
  // Delays and start offsets are judged relative to how long the animation runs.
  const span = Math.max(b.timing.activeDuration ?? b.timing.duration ?? 0, 1);
  const pairs: {
    kind: "duration" | "delay" | "end-delay";
    label: string;
    before: number | null;
    after: number | null;
    reference: number | undefined;
  }[] = [
    {
      kind: "duration",
      label: "Duration",
      before: b.timing.duration,
      after: c.timing.duration,
      reference: undefined,
    },
    {
      kind: "delay",
      label: "Delay",
      before: b.timing.delay,
      after: c.timing.delay,
      reference: span,
    },
    {
      kind: "end-delay",
      label: "End delay",
      before: b.timing.endDelay,
      after: c.timing.endDelay,
      reference: span,
    },
  ];
  for (const p of pairs) {
    if (p.before === null || p.after === null) {
      if (p.before !== p.after) {
        out.push({
          kind: p.kind,
          rule: p.kind,
          before: p.before,
          after: p.after,
          measurement: "unsupported",
          severity: "uncertain",
          message: `${p.label} is not time-based on one side (${p.before ?? "n/a"} → ${p.after ?? "n/a"}).`,
        });
      }
      continue;
    }
    const severity = timingSeverity(
      p.before,
      p.after,
      config,
      config.timing.toleranceMs,
      p.reference ?? p.before,
    );
    if (!severity) continue;
    const delta = p.after - p.before;
    out.push({
      kind: p.kind,
      rule: p.kind,
      before: p.before,
      after: p.after,
      delta,
      unit: "ms",
      measurement: "measured",
      severity,
      message: `${p.label} ${fmtMs(p.before)} → ${fmtMs(p.after)} (${signed(delta, "ms")}${p.before > 0 ? `, ${signed((delta / p.before) * 100, "%")}` : ""})`,
    });
  }

  if (b.startTime !== null && c.startTime !== null) {
    const severity = timingSeverity(
      b.startTime,
      c.startTime,
      config,
      config.timing.startToleranceMs,
      span,
    );
    if (severity) {
      const delta = c.startTime - b.startTime;
      out.push({
        kind: "start",
        rule: "start",
        before: Math.round(b.startTime * 10) / 10,
        after: Math.round(c.startTime * 10) / 10,
        delta,
        unit: "ms",
        measurement: "estimated",
        severity: capSeverity(severity, "warning"),
        message: `Starts ${signed(delta, "ms")} ${delta > 0 ? "later" : "earlier"} (${fmtMs(b.startTime)} → ${fmtMs(c.startTime)} after the window origin; frame-quantized)`,
      });
    }
  }

  if (b.timing.iterations !== c.timing.iterations) {
    const infiniteFlip =
      (b.timing.iterations === "infinite") !== (c.timing.iterations === "infinite");
    out.push({
      kind: "iterations",
      rule: "iterations",
      before: b.timing.iterations,
      after: c.timing.iterations,
      measurement: "measured",
      severity: infiniteFlip ? "critical" : "warning",
      message: `Iterations ${b.timing.iterations} → ${c.timing.iterations}`,
    });
  }
  if (b.timing.direction !== c.timing.direction) {
    out.push({
      kind: "direction",
      rule: "direction",
      before: b.timing.direction,
      after: c.timing.direction,
      measurement: "measured",
      severity: "warning",
      message: `Direction ${b.timing.direction} → ${c.timing.direction}`,
    });
  }
  if (Math.abs(b.timing.playbackRate - c.timing.playbackRate) > 1e-6) {
    out.push({
      kind: "playback-rate",
      rule: "playback-rate",
      before: b.timing.playbackRate,
      after: c.timing.playbackRate,
      delta: c.timing.playbackRate - b.timing.playbackRate,
      measurement: "measured",
      severity: "warning",
      message: `Playback rate ${b.timing.playbackRate}× → ${c.timing.playbackRate}×`,
    });
  }
  if (b.timing.fill !== c.timing.fill) {
    out.push({
      kind: "fill",
      rule: "fill",
      before: b.timing.fill,
      after: c.timing.fill,
      measurement: "measured",
      severity: "info",
      message: `Fill mode ${b.timing.fill} → ${c.timing.fill}`,
    });
  }
  return out;
}

export function easingChange(
  b: AnimationRecord,
  c: AnimationRecord,
  config: ComparisonConfig,
): { change: ChangeDraft | null; analysis: AnimationComparison["easing"] } {
  const eb = b.timing.effectiveEasing;
  const ec = c.timing.effectiveEasing;
  if (eb.samples && ec.samples) {
    const sb = resampleEasing(eb.samples, EASING_SAMPLE_COUNT);
    const sc = resampleEasing(ec.samples, EASING_SAMPLE_COUNT);
    const cmp = compareEasingSamples(sb, sc);
    const analysis = {
      baseline: eb.value,
      candidate: ec.value,
      maxDeviation: cmp.maxDeviation,
      maxDeviationAt: cmp.maxDeviationAt,
      meanDeviation: cmp.meanDeviation,
    };
    const scopeChanged = eb.scope !== ec.scope;
    if (cmp.maxDeviation <= config.easing.tolerance && !scopeChanged)
      return { change: null, analysis };
    const overshoot =
      cmp.candidateOvershoot && !cmp.baselineOvershoot
        ? "; now overshoots"
        : cmp.baselineOvershoot && !cmp.candidateOvershoot
          ? "; no longer overshoots"
          : "";
    return {
      analysis,
      change: {
        kind: "easing",
        rule: "easing",
        before: eb.value,
        after: ec.value,
        delta: cmp.maxDeviation,
        measurement: "measured",
        severity:
          cmp.maxDeviation >= config.easing.warnDeviation || overshoot || scopeChanged
            ? "warning"
            : "info",
        message: `Easing ${eb.value} → ${ec.value} (max deviation ${Math.round(cmp.maxDeviation * 100)}% of progress at ${Math.round(cmp.maxDeviationAt * 100)}% time${overshoot})`,
      },
    };
  }
  if (eb.kind === "per-keyframe" && ec.kind === "per-keyframe") {
    const kb = b.timing.keyframeEasings ?? [];
    const kc = c.timing.keyframeEasings ?? [];
    const same = kb.length === kc.length && kb.every((e, i) => cssEasingsEquivalent(e, kc[i]!));
    if (same) return { change: null, analysis: null };
    return {
      analysis: null,
      change: {
        kind: "easing",
        rule: "easing",
        before: kb.join(" | "),
        after: kc.join(" | "),
        measurement: "measured",
        severity: "warning",
        message: `Per-keyframe easings changed: ${kb.join(", ")} → ${kc.join(", ")}`,
      },
    };
  }
  if (eb.value === ec.value) return { change: null, analysis: null };
  return {
    analysis: null,
    change: {
      kind: "easing",
      rule: "easing",
      before: eb.value,
      after: ec.value,
      measurement: "unsupported",
      severity: "uncertain",
      message: `Easing ${eb.value} → ${ec.value}; curves cannot be compared numerically`,
    },
  };
}

function propertySetChanges(b: AnimationRecord, c: AnimationRecord): ChangeDraft[] {
  const pb = new Set(b.properties.map((p) => p.property));
  const pc = new Set(c.properties.map((p) => p.property));
  const out: ChangeDraft[] = [];
  for (const p of [...pb].sort()) {
    if (!pc.has(p))
      out.push({
        kind: "property-removed",
        rule: "property-removed",
        property: p,
        before: p,
        after: null,
        measurement: "measured",
        severity: "warning",
        message: `No longer animates ${p}`,
      });
  }
  for (const p of [...pc].sort()) {
    if (!pb.has(p))
      out.push({
        kind: "property-added",
        rule: "property-added",
        property: p,
        before: null,
        after: p,
        measurement: "measured",
        severity: "warning",
        message: `Now also animates ${p}`,
      });
  }
  return out;
}

/** Declared keyframe values for properties without numeric sample channels (colors, clip-path, …). */
function keyframeValueChanges(
  b: AnimationRecord,
  c: AnimationRecord,
  config: ComparisonConfig,
): ChangeDraft[] {
  const out: ChangeDraft[] = [];
  const numericCovered = new Set(["transform", "opacity", "translate", "scale", "rotate"]);
  for (const pb of b.properties) {
    const pc = c.properties.find((p) => p.property === pb.property);
    if (!pc || numericCovered.has(pb.property)) continue;
    for (const [edge, vb, vc] of [
      ["start", pb.from, pc.from],
      ["end", pb.to, pc.to],
    ] as const) {
      if (vb === null || vc === null || vb === vc) continue;
      const cb = parseCssColor(vb);
      const cc = parseCssColor(vc);
      if (cb && cc) {
        const d = colorDistance(cb, cc);
        if (d < 0.01) continue;
        out.push({
          kind: "keyframes",
          rule: "keyframes",
          property: pb.property,
          before: vb,
          after: vc,
          delta: d,
          measurement: "measured",
          severity: d >= 0.08 ? "warning" : "info",
          message: `${pb.property} ${edge} ${vb} → ${vc}`,
        });
        continue;
      }
      const nb = parseCssNumeric(vb);
      const nc = parseCssNumeric(vc);
      if (nb && nc && nb.unit === nc.unit) {
        const sev = magnitudeSeverity(
          Math.abs(nc.value - nb.value),
          nb.unit === "px" ? config.properties.sizeTolerancePx : 1e-3,
          nb.unit === "px" ? config.properties.warnPositionPx : 0.1,
        );
        if (!sev) continue;
        out.push({
          kind: "keyframes",
          rule: "keyframes",
          property: pb.property,
          before: vb,
          after: vc,
          delta: nc.value - nb.value,
          unit: nb.unit,
          measurement: "measured",
          severity: sev,
          message: `${pb.property} ${edge} ${vb} → ${vc}`,
        });
        continue;
      }
      out.push({
        kind: "keyframes",
        rule: "keyframes",
        property: pb.property,
        before: vb,
        after: vc,
        measurement: "measured",
        severity: "warning",
        message: `${pb.property} ${edge} value ${vb} → ${vc}`,
      });
    }
  }
  return out;
}

function channelTolerance(
  kind: "trajectory" | "opacity" | "size",
  unit: string,
  config: ComparisonConfig,
): [number, number] {
  if (kind === "opacity")
    return [config.properties.opacityTolerance, config.properties.warnOpacity];
  if (kind === "size") return [0.01, 0.05];
  if (unit === "deg") return [0.5, 5];
  return [config.properties.positionTolerancePx, config.properties.warnPositionPx];
}

/** End-state and path differences derived from sampled computed styles and geometry. */
function sampledChanges(
  b: AnimationRecord,
  c: AnimationRecord,
  config: ComparisonConfig,
): ChangeDraft[] {
  const out: ChangeDraft[] = [];
  if (!b.samples.length || !c.samples.length) return out;
  const measurement = isComplete(b) && isComplete(c) ? "measured" : "incomplete";
  const firstB = b.samples[0]!;
  const lastB = b.samples.at(-1)!;
  const firstC = c.samples[0]!;
  const lastC = c.samples.at(-1)!;
  const animated = new Set([...b.properties, ...c.properties].map((p) => p.property));

  for (const ch of NUMERIC_CHANNELS) {
    if (
      ch.kind === "opacity"
        ? !animated.has("opacity")
        : !(
            animated.has("transform") ||
            animated.has("translate") ||
            animated.has("scale") ||
            animated.has("rotate")
          )
    )
      continue;
    const [tol, warn] = channelTolerance(ch.kind, ch.unit, config);
    let reported = false;
    for (const [edge, sb, sc] of [
      ["start", firstB, firstC],
      ["end", lastB, lastC],
    ] as const) {
      const vb = sb.numeric[ch.key];
      const vc = sc.numeric[ch.key];
      if (typeof vb !== "number" || typeof vc !== "number") continue;
      const sev = magnitudeSeverity(Math.abs(vc - vb), tol, warn);
      if (!sev) continue;
      reported = true;
      out.push({
        kind: ch.kind,
        rule: ch.kind,
        property: `${ch.label} (${edge})`,
        before: round(vb),
        after: round(vc),
        delta: round(vc - vb),
        unit: ch.unit,
        measurement,
        severity: sev,
        message: `${ch.label} at ${edge}: ${round(vb)}${ch.unit} → ${round(vc)}${ch.unit} (${signed(vc - vb, ch.unit)})`,
      });
    }
    if (reported || b.samples.length !== c.samples.length) continue;
    // Same endpoints, different path (e.g. easing-induced or keyframe midpoints).
    let max = 0;
    let at = 0;
    for (let i = 0; i < b.samples.length; i++) {
      const vb = b.samples[i]!.numeric[ch.key];
      const vc = c.samples[i]!.numeric[ch.key];
      if (typeof vb !== "number" || typeof vc !== "number") continue;
      const d = Math.abs(vc - vb);
      if (d > max) {
        max = d;
        at = b.samples[i]!.progress;
      }
    }
    const sev = magnitudeSeverity(max, tol, warn);
    if (sev && max > tol * 2) {
      out.push({
        kind: ch.kind,
        rule: ch.kind,
        property: `${ch.label} (path)`,
        before: null,
        after: null,
        delta: round(max),
        unit: ch.unit,
        measurement,
        severity: "info",
        message: `${ch.label} path deviates up to ${round(max)}${ch.unit} at ${Math.round(at * 100)}% progress`,
      });
    }
  }

  // Geometry: where the element ends up on screen. Only meaningful for animations of layout
  // properties; for transform/opacity the own computed values above are the precise signal,
  // and the box would also move with animated ancestors (misattributing their change).
  const box = (s: FrameSample) => s.box;
  const bb = box(lastB);
  const bc = box(lastC);
  const animatesLayout = [...animated].some((p) => LAYOUT_PROPERTIES.test(p));
  if (bb && bc && animatesLayout) {
    const dx = bc.x - bb.x;
    const dy = bc.y - bb.y;
    const dist = Math.hypot(dx, dy);
    const alreadyReported = out.some(
      (ch) => ch.kind === "trajectory" && String(ch.property).includes("end"),
    );
    const sev = magnitudeSeverity(
      dist,
      config.properties.positionTolerancePx,
      config.properties.warnPositionPx,
    );
    if (sev && !alreadyReported) {
      out.push({
        kind: "trajectory",
        rule: "trajectory",
        property: "position (end)",
        before: `${round(bb.x)}, ${round(bb.y)}`,
        after: `${round(bc.x)}, ${round(bc.y)}`,
        delta: round(dist),
        unit: "px",
        measurement,
        severity: sev,
        message: `Ends ${round(dist)}px away (${signed(dx, "px")} x, ${signed(dy, "px")} y)`,
      });
    }
    const dw = bc.width - bb.width;
    const dh = bc.height - bb.height;
    const sizeSev = magnitudeSeverity(
      Math.max(Math.abs(dw), Math.abs(dh)),
      config.properties.sizeTolerancePx,
      config.properties.warnPositionPx,
    );
    if (sizeSev && !out.some((ch) => ch.kind === "size")) {
      out.push({
        kind: "size",
        rule: "size",
        property: "size (end)",
        before: `${round(bb.width)}×${round(bb.height)}`,
        after: `${round(bc.width)}×${round(bc.height)}`,
        measurement,
        severity: sizeSev,
        message: `Final size ${round(bb.width)}×${round(bb.height)} → ${round(bc.width)}×${round(bc.height)}`,
      });
    }
  }
  return out;
}

const round = (n: number) => Math.round(n * 100) / 100;

/** True when a record's samples were rendered at scroll-driven progress (scroll-linked). */
export function sampledByScrollProgress(r: AnimationRecord): boolean {
  return r.samples.length > 0 && r.samples.every((s) => s.scrollProgress !== undefined);
}

/** Evenly spaced points compared across the shared scroll progress. */
const SCROLL_POINTS = 33;
const pct = (n: number) => `${Math.round(n * 1000) / 10}%`;

function byScrollProgress(r: AnimationRecord): FrameSample[] {
  return [...r.samples].sort((a, b) => a.scrollProgress! - b.scrollProgress!);
}

/** The two samples around scroll progress `p` and the interpolation weight between them. */
function bracket(samples: readonly FrameSample[], p: number): [FrameSample, FrameSample, number] {
  const first = samples[0]!;
  if (p <= first.scrollProgress!) return [first, first, 0];
  for (let i = 1; i < samples.length; i++) {
    const b = samples[i]!;
    if (p <= b.scrollProgress!) {
      const a = samples[i - 1]!;
      const span = b.scrollProgress! - a.scrollProgress!;
      return [a, b, span > 0 ? (p - a.scrollProgress!) / span : 1];
    }
  }
  const last = samples[samples.length - 1]!;
  return [last, last, 0];
}

function numberAt(
  samples: readonly FrameSample[],
  p: number,
  read: (s: FrameSample) => number | undefined,
): number | undefined {
  const [a, b, w] = bracket(samples, p);
  const va = read(a);
  const vb = read(b);
  if (typeof va !== "number" || typeof vb !== "number") return undefined;
  return va + (vb - va) * w;
}

/** A computed value at scroll progress `p`: colors and lengths interpolated, others nearest. */
function valueAt(samples: readonly FrameSample[], p: number, property: string): string | undefined {
  const [a, b, w] = bracket(samples, p);
  const va = a.values[property];
  const vb = b.values[property];
  if (va === undefined || vb === undefined) return va ?? vb;
  const ca = parseCssColor(va);
  const cb = parseCssColor(vb);
  if (ca && cb) {
    const mix = (x: number, y: number) => x + (y - x) * w;
    return `rgba(${mix(ca.r, cb.r)}, ${mix(ca.g, cb.g)}, ${mix(ca.b, cb.b)}, ${mix(ca.a, cb.a)})`;
  }
  const na = parseCssNumeric(va);
  const nb = parseCssNumeric(vb);
  if (na && nb && na.unit === nb.unit) return `${na.value + (nb.value - na.value) * w}${na.unit}`;
  return w < 0.5 ? va : vb;
}

/**
 * Values of a scroll-linked animation (GSAP ScrollTrigger) compared at the same scroll progress,
 * over the progress both captures reached. Where the animation sits in the scroll (a moved
 * `start`/`end`) is the progress-at-position comparison's job; this finds what the animation
 * writes there: a parallax distance, a fade's end opacity, a color.
 */
export function scrollLinkedValueChanges(
  b: AnimationRecord,
  c: AnimationRecord,
  config: ComparisonConfig,
): ChangeDraft[] {
  const sb = byScrollProgress(b);
  const sc = byScrollProgress(c);
  const lo = Math.max(sb[0]!.scrollProgress!, sc[0]!.scrollProgress!);
  const hi = Math.min(sb.at(-1)!.scrollProgress!, sc.at(-1)!.scrollProgress!);
  const span = (s: FrameSample[]) =>
    `${pct(s[0]!.scrollProgress!)}–${pct(s.at(-1)!.scrollProgress!)}`;
  if (hi < lo - 1e-6) {
    return [
      {
        kind: "completeness",
        rule: "trajectory",
        before: span(sb),
        after: span(sc),
        measurement: "incomplete",
        severity: "uncertain",
        message: `Scroll-linked values cannot be compared: the scroll reached ${span(sb)} scroll progress in the baseline and ${span(sc)} in the candidate`,
      },
    ];
  }
  const points =
    hi - lo < 1e-6
      ? [lo]
      : Array.from({ length: SCROLL_POINTS }, (_, k) => lo + ((hi - lo) * k) / (SCROLL_POINTS - 1));
  const out: ChangeDraft[] = [];
  const animated = new Set([...b.properties, ...c.properties].map((p) => p.property));
  const transforms = ["transform", "translate", "scale", "rotate"].some((p) => animated.has(p));

  for (const ch of NUMERIC_CHANNELS) {
    if (ch.kind === "opacity" ? !animated.has("opacity") : !transforms) continue;
    let max = 0;
    let at = lo;
    let before = 0;
    let after = 0;
    for (const p of points) {
      const vb = numberAt(sb, p, (s) => s.numeric[ch.key]);
      const vc = numberAt(sc, p, (s) => s.numeric[ch.key]);
      if (vb === undefined || vc === undefined) continue;
      if (Math.abs(vc - vb) > max) {
        max = Math.abs(vc - vb);
        at = p;
        before = vb;
        after = vc;
      }
    }
    const [tol, warn] = channelTolerance(ch.kind, ch.unit, config);
    const severity = magnitudeSeverity(max, tol, warn);
    if (!severity) continue;
    out.push({
      kind: ch.kind,
      rule: ch.kind,
      property: `${ch.label} (scroll)`,
      before: round(before),
      after: round(after),
      delta: round(after - before),
      unit: ch.unit,
      measurement: "measured",
      severity,
      message: `Scroll-linked ${ch.label} differs by up to ${round(max)}${ch.unit} at the same scroll progress (at ${pct(at)}: ${round(before)}${ch.unit} → ${round(after)}${ch.unit})`,
    });
  }

  // Other animated properties: colors, lengths, and values that only differ as text.
  const numericCovered = new Set(["transform", "opacity", "translate", "scale", "rotate"]);
  for (const pb of b.properties) {
    const property = pb.property;
    if (numericCovered.has(property) || !c.properties.some((p) => p.property === property))
      continue;
    let worst: { at: number; before: string; after: string; delta: number | null } | null = null;
    let worstSeverity: ChangeDraft["severity"] | null = null;
    let unit: string | undefined;
    for (const p of points) {
      const vb = valueAt(sb, p, property);
      const vc = valueAt(sc, p, property);
      if (vb === undefined || vc === undefined || vb === vc) continue;
      const cb = parseCssColor(vb);
      const cc = parseCssColor(vc);
      const nb = parseCssNumeric(vb);
      const nc = parseCssNumeric(vc);
      let delta: number | null = null;
      let severity: ChangeDraft["severity"] | null;
      if (cb && cc) {
        delta = colorDistance(cb, cc);
        severity = delta < 0.01 ? null : delta >= 0.08 ? "warning" : "info";
      } else if (nb && nc && nb.unit === nc.unit) {
        delta = nc.value - nb.value;
        unit = nb.unit;
        severity = magnitudeSeverity(
          Math.abs(delta),
          nb.unit === "px" ? config.properties.sizeTolerancePx : 1e-3,
          nb.unit === "px" ? config.properties.warnPositionPx : 0.1,
        );
      } else severity = "warning";
      if (!severity) continue;
      if (!worst || Math.abs(delta ?? Number.POSITIVE_INFINITY) > Math.abs(worst.delta ?? 0)) {
        worst = { at: p, before: vb, after: vc, delta };
        worstSeverity = severity;
      }
    }
    if (!worst || !worstSeverity) continue;
    const shown = (v: string) => {
      const n = parseCssNumeric(v);
      return n ? `${round(n.value)}${n.unit}` : v;
    };
    out.push({
      kind: "keyframes",
      rule: "keyframes",
      property: `${property} (scroll)`,
      before: shown(worst.before),
      after: shown(worst.after),
      ...(worst.delta !== null ? { delta: round(worst.delta) } : {}),
      ...(unit ? { unit } : {}),
      measurement: "measured",
      severity: worstSeverity,
      message: `Scroll-linked ${property} differs at the same scroll progress (at ${pct(worst.at)}: ${shown(worst.before)} → ${shown(worst.after)})`,
    });
  }
  return out;
}

export function compareMatchedAnimation(
  match: AnimationMatch,
  config: ComparisonConfig,
): AnimationComparison {
  const { baseline: b, candidate: c } = match;
  const drafts: ChangeDraft[] = [];
  if (match.method !== "exact") {
    drafts.push({
      kind: "element-match",
      // A rename means different keyframes/properties, so it shares the keyframes rule.
      rule: "keyframes",
      before: b.id,
      after: c.id,
      measurement: "estimated",
      severity: match.method === "fuzzy" ? "uncertain" : "info",
      message: match.notes.join(" ") || `Matched by ${match.method}`,
    });
  }
  drafts.push(...timingChanges(b, c, config));
  const easing = easingChange(b, c, config);
  if (easing.change) drafts.push(easing.change);
  drafts.push(...propertySetChanges(b, c));
  // Scroll-linked animations are sampled at the progress the scroll reached, which differs
  // between captures: their values are compared at equal progress, not by sample index.
  const scrollSampled = sampledByScrollProgress(b) && sampledByScrollProgress(c);
  if (scrollSampled) drafts.push(...scrollLinkedValueChanges(b, c, config));
  else if (!sampledByScrollProgress(b) && !sampledByScrollProgress(c))
    drafts.push(...keyframeValueChanges(b, c, config));
  // An animation the app cancelled mid-way (on a timer, an event) stops wherever it was when the
  // cancel ran, and that moment depends on scheduling: its sampled path and end values are not
  // definite evidence of a change. Declared timing and easing still are.
  const canceled = b.meta.canceled === true || c.meta.canceled === true;
  for (const draft of scrollSampled ? [] : sampledChanges(b, c, config))
    drafts.push(
      canceled && draft.severity !== "uncertain"
        ? {
            ...draft,
            severity: "uncertain",
            message: `${draft.message} (cancelled mid-way: where it stopped depends on when the cancel ran)`,
          }
        : draft,
    );
  if (b.completeness.status !== c.completeness.status) {
    drafts.push({
      kind: "completeness",
      rule: "trajectory",
      before: b.completeness.status,
      after: c.completeness.status,
      measurement: "incomplete",
      severity: "uncertain",
      message: `Capture completeness ${b.completeness.status} → ${c.completeness.status}: ${[...b.completeness.reasons, ...c.completeness.reasons].join(" ") || "see diagnostics"}`,
    });
  }

  const lowConfidence = b.element.confidence === "low" || c.element.confidence === "low";
  const uncertain =
    match.uncertain ??
    (config.uncertainOnLowConfidence && lowConfidence
      ? "element matched by DOM position only"
      : null);
  const changes = finalizeChanges(drafts, config, uncertain);
  const severities = changes.map((ch) => ch.severity);
  const rank = { critical: 3, warning: 2, info: 1, uncertain: 0 } as const;
  const severity = severities.length
    ? severities.reduce((a, s) => (rank[s] > rank[a] ? s : a))
    : null;
  return {
    key: b.id,
    status: changes.length ? "changed" : "unchanged",
    baselineId: b.id,
    candidateId: c.id,
    match: { method: match.method, confidence: match.confidence, notes: match.notes },
    changes,
    severity,
    easing: easing.analysis,
  };
}
