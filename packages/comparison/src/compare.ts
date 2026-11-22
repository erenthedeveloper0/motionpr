import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  COMPARISON_SCHEMA_VERSION,
  MOTIONPR_VERSION,
  MotionprError,
  SHADOW_SEPARATOR,
  browserLabel,
  captureBrowser,
  contentId,
  maxSeverity,
  severityRank,
  writeComparisonResult,
  type AnimationComparison,
  type AnimationRecord,
  type CaptureBundle,
  type Change,
  type ChangeKind,
  type Checkpoint,
  type CheckpointComparison,
  type ComparisonConfig,
  type ComparisonResult,
  type Diagnostic,
  type Difference,
  type DifferenceCategory,
  type ScenarioComparison,
  type ScenarioResult,
  type Severity,
} from "@motionpr/core";
import { compareMatchedAnimation } from "./diff-animation.ts";
import { matchAnimations } from "./match.ts";
import { applyOverride, capSeverity, finalizeChanges, timingSeverity } from "./severity.ts";
import { compareScrollRecords } from "./scroll.ts";
import { scrollLinkChanges, scrollLinkedChange } from "./scroll-linked.ts";
import { compareStagger } from "./stagger.ts";
import { compareTimelineRecords } from "./timelines.ts";
import { PngCache, compareScreenshots, frameDivergence, type ImageSource } from "./visual.ts";

export interface CompareOptions {
  baseline: ImageSource;
  candidate: ImageSource;
  config: ComparisonConfig;
  /** Directory for comparison output (comparison.json + assets/ with diff images). */
  outputDir?: string;
  /**
   * Compare captures from different engines (e.g. a Chromium baseline with a Firefox candidate).
   * Off by default: such a comparison throws `BROWSER_MISMATCH`. When on, differences that come
   * from how engines lay out, render and schedule motion are reported as `uncertain`.
   */
  allowCrossBrowser?: boolean;
}

/**
 * Change kinds whose values depend on the engine as much as on the app: geometry (layout and
 * fonts), observed start offsets and scroll motion (frame scheduling), and keyframe value
 * serialization. In a cross-browser comparison they are `uncertain`; declared timing, easing,
 * iterations, direction, fill and added or removed motion stay definite.
 */
export const ENGINE_DEPENDENT_CHANGES: ReadonlySet<ChangeKind> = new Set<ChangeKind>([
  "start",
  "trajectory",
  "size",
  "keyframes",
  "scroll-start",
  "scroll-end",
  "scroll-target",
  "scroll-duration",
  "scroll-settle",
  "scroll-curve",
  "scroll-velocity",
  "scroll-overshoot",
  "scroll-lag",
  "scroll-progress",
]);

const CROSS_BROWSER_NOTE = "captured with different browser engines";

/** Downgrades engine-dependent changes to `uncertain`, unless the user set the rule's severity. */
function crossEngineChanges(changes: Change[], config: ComparisonConfig): Severity | null {
  for (const ch of changes) {
    if (!ENGINE_DEPENDENT_CHANGES.has(ch.kind) || ch.severity === "uncertain") continue;
    if (config.severity[ch.rule as keyof ComparisonConfig["severity"]]) continue;
    ch.severity = "uncertain";
    ch.message = `${ch.message} (${CROSS_BROWSER_NOTE})`;
  }
  return maxSeverity(changes.map((c) => c.severity));
}

const CATEGORY: Record<Change["kind"], DifferenceCategory> = {
  duration: "timing",
  delay: "timing",
  "end-delay": "timing",
  start: "timing",
  iterations: "timing",
  direction: "timing",
  "playback-rate": "timing",
  fill: "timing",
  easing: "easing",
  "property-added": "property",
  "property-removed": "property",
  keyframes: "property",
  trajectory: "property",
  opacity: "property",
  size: "property",
  type: "structure",
  "element-match": "uncertain",
  completeness: "uncertain",
  "scroll-start": "scroll",
  "scroll-end": "scroll",
  "scroll-target": "scroll",
  "scroll-duration": "scroll",
  "scroll-settle": "scroll",
  "scroll-curve": "scroll",
  "scroll-velocity": "scroll",
  "scroll-overshoot": "scroll",
  "scroll-direction": "scroll",
  "scroll-lag": "scroll",
  "scroll-config": "scroll",
  "scroll-progress": "scroll",
  "timeline-duration": "timing",
  "timeline-iterations": "timing",
  "timeline-labels": "timing",
  "timeline-children": "structure",
  "timeline-playback-rate": "timing",
};

const SOURCE_LABEL: Record<string, string> = {
  native: "native",
  gsap: "GSAP",
  animejs: "Anime.js",
  lenis: "Lenis",
};

/** `motionpr-id:menu` → `menu`; other kinds of keys stay as they are. */
function withoutMethod(key: string): string {
  return key.replace(/^(motionpr-id|test-id|id):/, "");
}

/** Prefers explicit ids (what developers search for) over visible text. */
export function elementName(r: AnimationRecord): string {
  const e = r.element;
  const strong = e.method === "motionpr-id" || e.method === "test-id" || e.method === "dom-id";
  if (!e.shadowHost) return strong ? withoutMethod(e.key) : e.label ? `“${e.label}”` : e.key;
  // Inside a shadow root: the hosts, then the element (`plan-pro >> glow`).
  const host = e.shadowHost.split(SHADOW_SEPARATOR).map(withoutMethod).join(SHADOW_SEPARATOR);
  const inner = e.key.slice(e.shadowHost.length + SHADOW_SEPARATOR.length);
  const name = strong ? withoutMethod(inner) : e.label ? `“${e.label}”` : inner;
  return `${host}${SHADOW_SEPARATOR}${name}`;
}

function describeElement(r: AnimationRecord): string {
  return `${r.type} ${r.name ? `“${r.name}” ` : ""}on ${elementName(r)}`;
}

function animationSummary(r: AnimationRecord): string {
  const t = r.timing;
  return `${t.duration ?? "?"}ms, delay ${t.delay}ms, ${t.effectiveEasing.value}, ${r.properties.map((p) => p.property).join(", ")}`;
}

type DifferenceInput = Omit<Difference, "id" | "scrollKey" | "source"> &
  Partial<Pick<Difference, "scrollKey" | "source">>;

class DifferenceList {
  readonly items: Difference[] = [];
  readonly #ids = new Map<string, number>();

  add(input: DifferenceInput): void {
    const d: Omit<Difference, "id"> = { scrollKey: null, source: null, ...input };
    const base = [
      d.scenarioKey,
      d.checkpoint ?? "",
      d.animationKey ?? "",
      d.category,
      d.title,
    ].join("|");
    const n = (this.#ids.get(base) ?? 0) + 1;
    this.#ids.set(base, n);
    this.items.push({
      id: `d${contentId(new TextEncoder().encode(`${base}#${n}`)).slice(0, 12)}`,
      ...d,
    });
  }
}

function lowConfidenceSeverity(
  r: AnimationRecord,
  computed: Severity,
  config: ComparisonConfig,
): Severity {
  return config.uncertainOnLowConfidence && r.element.confidence === "low" ? "uncertain" : computed;
}

async function compareCheckpoint(
  scenarioKey: string,
  b: Checkpoint,
  c: Checkpoint,
  ctx: {
    options: CompareOptions;
    cache: PngCache;
    diffs: DifferenceList;
    assets: ComparisonResult["assets"];
    scale: number;
    crossBrowser: boolean;
    /** Whether each capture recorded native scroll containers (`settings.scrollContainers`). */
    scrollContainers: { baseline: boolean; candidate: boolean };
    /** Whether each capture looked inside shadow roots (`settings.shadowRoots`). */
    shadowRoots: { baseline: boolean; candidate: boolean };
  },
): Promise<CheckpointComparison> {
  const { config } = ctx.options;
  const shadowLegacy =
    ctx.shadowRoots.baseline === ctx.shadowRoots.candidate
      ? null
      : ctx.shadowRoots.baseline
        ? "candidate"
        : "baseline";
  const { matches, removed, added } = matchAnimations(b.animations, c.animations, {
    shadowLegacy,
  });
  // Records inside shadow roots that the newer capture has and the older one did not pair.
  const unpairedShadow = (
    shadowLegacy === "baseline" ? added : shadowLegacy === "candidate" ? removed : []
  ).filter((r) => r.element.shadowHost !== undefined);
  /**
   * Why an animation found in one capture only is uncertain because the other capture is older
   * than MotionPR's look inside shadow roots, or null (also when the rule's severity is set). A
   * record inside a shadow root may have been missed there (CSS motion) or kept under its old
   * identity; a record of the older capture may be one of those, now identified through its host.
   */
  const shadowLegacyNote = (r: AnimationRecord, side: "baseline" | "candidate"): string | null => {
    const rule = side === "baseline" ? "animation-removed" : "animation-added";
    if (!shadowLegacy || config.severity[rule]) return null;
    const older = `The ${shadowLegacy} was captured before MotionPR looked inside shadow roots (MotionPR 0.4.0-alpha or earlier)`;
    if (side !== shadowLegacy)
      return r.element.shadowHost !== undefined
        ? ` ${older}, so this is uncertain; capture it again to compare this animation.`
        : null;
    return unpairedShadow.some((n) => n.type === r.type)
      ? ` ${older}: the ${side === "baseline" ? "candidate" : "baseline"} may record this animation inside a shadow root under a new identity, so this is uncertain; capture the ${shadowLegacy} again to compare it.`
      : null;
  };
  const animations: AnimationComparison[] = [];

  for (const m of matches) {
    const cmp = compareMatchedAnimation(m, config);
    // Where a scroll-linked animation runs in the scroll: from the positions its engine
    // resolved when both captures have them, otherwise from progress at the same position.
    const resolved = scrollLinkChanges(m.baseline, m.candidate, config, shadowLegacy);
    const progress = resolved
      ? null
      : scrollLinkedChange(m.baseline, m.candidate, b.scrollMotion, c.scrollMotion, config);
    const linked = resolved ?? (progress ? [progress] : []);
    for (const change of finalizeChanges(linked, config, null)) {
      cmp.changes.push(change);
      cmp.status = "changed";
      cmp.severity = maxSeverity([cmp.severity, change.severity]);
    }
    if (ctx.crossBrowser && cmp.changes.length)
      cmp.severity = crossEngineChanges(cmp.changes, config);
    animations.push(cmp);
    for (const ch of cmp.changes) {
      ctx.diffs.add({
        severity: ch.severity,
        category: CATEGORY[ch.kind],
        scenarioKey,
        checkpoint: b.label,
        animationKey: cmp.key,
        source: m.candidate.source,
        title: `${describeElement(m.candidate)}: ${ch.message}`,
        detail: ch.message,
        measurement: ch.measurement,
        before: ch.before,
        after: ch.after,
        ...(ch.delta !== undefined ? { delta: ch.delta } : {}),
        ...(ch.unit ? { unit: ch.unit } : {}),
      });
    }
  }
  for (const r of removed) {
    const legacyNote = shadowLegacyNote(r, "baseline");
    const severity = legacyNote
      ? "uncertain"
      : applyOverride("animation-removed", lowConfidenceSeverity(r, "critical", config), config);
    animations.push({
      key: r.id,
      status: "removed",
      baselineId: r.id,
      candidateId: null,
      match: null,
      changes: [],
      severity,
      easing: null,
    });
    if (severity) {
      ctx.diffs.add({
        severity,
        category: "removed",
        scenarioKey,
        checkpoint: b.label,
        animationKey: r.id,
        source: r.source,
        title: `Removed: ${describeElement(r)}`,
        detail: `This animation no longer runs (${animationSummary(r)}).${r.element.confidence === "low" ? " The element is identified by DOM position, so it may have moved rather than disappeared." : ""}${legacyNote ?? ""}`,
        measurement: "measured",
      });
    }
  }
  for (const r of added) {
    const legacyNote = shadowLegacyNote(r, "candidate");
    const severity = legacyNote
      ? "uncertain"
      : applyOverride("animation-added", lowConfidenceSeverity(r, "warning", config), config);
    animations.push({
      key: r.id,
      status: "added",
      baselineId: null,
      candidateId: r.id,
      match: null,
      changes: [],
      severity,
      easing: null,
    });
    if (severity) {
      ctx.diffs.add({
        severity,
        category: "added",
        scenarioKey,
        checkpoint: b.label,
        animationKey: r.id,
        source: r.source,
        title: `Added: ${describeElement(r)}`,
        detail: `New animation (${animationSummary(r)}).${legacyNote ?? ""}`,
        measurement: "measured",
      });
    }
  }

  // Visual comparison of the settled state and per-frame divergence.
  const { visual, diffPng } = await compareScreenshots(
    ctx.cache,
    ctx.options.baseline,
    ctx.options.candidate,
    b.screenshot,
    c.screenshot,
    config,
    ctx.scale,
  );
  if (diffPng && ctx.options.outputDir) {
    const id = `${contentId(diffPng)}.png`;
    const file = `assets/${id}`;
    await mkdir(join(ctx.options.outputDir, "assets"), { recursive: true });
    await writeFile(join(ctx.options.outputDir, file), diffPng);
    const asset = ctx.options.candidate.bundle.assets[c.screenshot!];
    ctx.assets[id] = { file, width: asset?.width ?? 0, height: asset?.height ?? 0 };
    visual.diffAsset = id;
  }
  // Engines rasterize text, borders and anti-aliasing differently: across engines a pixel
  // difference says nothing definite about the app.
  const visualSeverity =
    visual.status !== "changed"
      ? null
      : ctx.crossBrowser && !config.severity.visual
        ? "uncertain"
        : applyOverride("visual", "warning", config);
  if (visual.status === "changed") {
    const severity = visualSeverity;
    if (severity) {
      ctx.diffs.add({
        severity,
        category: "visual",
        scenarioKey,
        checkpoint: b.label,
        animationKey: null,
        title: `Settled frame differs by ${(visual.mismatchRatio * 100).toFixed(2)}% of pixels`,
        detail: ctx.crossBrowser
          ? `${visual.mismatchPixels.toLocaleString("en-US")} of ${visual.totalPixels.toLocaleString("en-US")} pixels differ between two browser engines. Engines render text, borders and anti-aliasing differently, so this is reported as uncertain; compare each engine against its own baseline to find regressions.`
          : `${visual.mismatchPixels.toLocaleString("en-US")} of ${visual.totalPixels.toLocaleString("en-US")} pixels differ (threshold ${(config.visual.maxDiffRatio * 100).toFixed(2)}%). Font rendering, browser versions and OS can contribute to pixel differences.`,
        measurement: "measured",
        before: 0,
        after: visual.mismatchRatio,
      });
    }
  }
  const divergence = await frameDivergence(
    ctx.cache,
    ctx.options.baseline,
    ctx.options.candidate,
    b.frames,
    c.frames,
    config,
  );

  const stagger = compareStagger(b.animations, c.animations, config);
  for (const s of stagger) {
    ctx.diffs.add({
      severity: s.severity,
      category: "timing",
      scenarioKey,
      checkpoint: b.label,
      animationKey: null,
      title: `Stagger interval ${s.baselineInterval}ms → ${s.candidateInterval}ms across ${s.members} elements`,
      detail: `Consecutive elements in this group now start ${Math.abs(s.delta)}ms ${s.delta > 0 ? "further apart" : "closer together"}.`,
      measurement: "measured",
      before: s.baselineInterval,
      after: s.candidateInterval,
      delta: s.delta,
      unit: "ms",
    });
  }

  // Scroll motion: compared by its own metrics, never by animation rules.
  const scroll = compareScrollRecords(b.scrollMotion, c.scrollMotion, config);
  // Scrollers inside shadow roots found in one capture only, when the other is older than
  // MotionPR's look inside shadow roots (it recorded no containers there).
  const unpairedShadowScroll = shadowLegacy
    ? scroll.flatMap((sc) => {
        const newStatus = shadowLegacy === "baseline" ? "added" : "removed";
        if (sc.status !== newStatus) return [];
        const records = (newStatus === "added" ? c : b).scrollMotion;
        const record = records.find((r) => r.id === sc.key);
        return record?.wrapper?.shadowHost !== undefined ? [record] : [];
      })
    : [];
  for (const sc of scroll) {
    const engine = SOURCE_LABEL[sc.source] ?? sc.source;
    if (sc.status === "removed" || sc.status === "added") {
      const metrics = sc.baseline ?? sc.candidate;
      const moved = metrics?.duration !== null && metrics?.duration !== undefined;
      const rule = sc.status === "removed" ? "scroll-removed" : "scroll-added";
      // A native scroll container that the other capture could not have recorded (made before
      // 0.4.0-alpha, or with capture.scrollContainers off): its absence there says nothing.
      const record = (sc.status === "removed" ? b : c).scrollMotion.find((r) => r.id === sc.key);
      const other = sc.status === "removed" ? "candidate" : "baseline";
      const unrecorded =
        record?.source === "native" && record.wrapper !== null && !ctx.scrollContainers[other];
      const side = sc.status === "removed" ? "baseline" : "candidate";
      // Inside a shadow root, and the other capture did not look there; or a scroller of the
      // older capture that the newer one may record inside a shadow root under a new identity.
      // (A severity set for the rule applies as it is.)
      const shadowUnrecorded =
        !unrecorded &&
        !config.severity[rule] &&
        shadowLegacy !== null &&
        record !== undefined &&
        (side !== shadowLegacy
          ? record.wrapper?.shadowHost !== undefined
          : record.wrapper !== null &&
            unpairedShadowScroll.some((n) => n.source === record.source && n.axis === record.axis));
      const severity =
        (unrecorded || shadowUnrecorded) && !config.severity[rule]
          ? "uncertain"
          : applyOverride(
              rule,
              moved ? (sc.status === "removed" ? "critical" : "warning") : "info",
              config,
            );
      sc.severity = severity;
      if (severity)
        ctx.diffs.add({
          severity,
          category: "scroll",
          scenarioKey,
          checkpoint: b.label,
          animationKey: null,
          scrollKey: sc.key,
          source: sc.source,
          title:
            sc.status === "removed"
              ? `${engine} scroll motion no longer recorded (${sc.key})`
              : `New ${engine} scroll motion (${sc.key})`,
          detail:
            (sc.status === "removed"
              ? `The baseline recorded this scroller${moved ? ` moving ${Math.round(Math.abs(metrics!.distance))}px` : ""}; the candidate did not.`
              : `The candidate recorded this scroller${moved ? ` moving ${Math.round(Math.abs(metrics!.distance))}px` : ""}; the baseline did not.`) +
            (unrecorded
              ? ` The ${other} was captured without scroll-container recording (MotionPR 0.3.0-alpha or earlier, or capture.scrollContainers: false), so this is uncertain; capture it again to compare this scroller.`
              : "") +
            (shadowUnrecorded
              ? side !== shadowLegacy
                ? ` The ${other} was captured before MotionPR looked inside shadow roots (MotionPR 0.4.0-alpha or earlier), so this is uncertain; capture it again to compare this scroller.`
                : ` The ${shadowLegacy} was captured before MotionPR looked inside shadow roots (MotionPR 0.4.0-alpha or earlier): the ${other} may record this scroller inside a shadow root under a new identity, so this is uncertain; capture the ${shadowLegacy} again to compare it.`
              : ""),
          measurement: "measured",
        });
      continue;
    }
    if (ctx.crossBrowser && sc.changes.length) sc.severity = crossEngineChanges(sc.changes, config);
    for (const ch of sc.changes) {
      ctx.diffs.add({
        severity: ch.severity,
        category: CATEGORY[ch.kind],
        scenarioKey,
        checkpoint: b.label,
        animationKey: null,
        scrollKey: sc.key,
        source: sc.source,
        title: `${engine} scroll: ${ch.message}`,
        detail: ch.message,
        measurement: ch.measurement,
        before: ch.before,
        after: ch.after,
        ...(ch.delta !== undefined ? { delta: ch.delta } : {}),
        ...(ch.unit ? { unit: ch.unit } : {}),
      });
    }
  }

  const timelines = compareTimelineRecords(b.timelines, c.timelines, config);
  for (const tl of timelines) {
    const engine = SOURCE_LABEL[tl.source] ?? tl.source;
    const shown = `“${tl.key.startsWith(`${tl.source}:`) ? tl.key.slice(tl.source.length + 1) : tl.key}”`;
    if (tl.status === "removed" || tl.status === "added") {
      const severity = applyOverride(
        "timeline",
        tl.status === "removed" ? "warning" : "info",
        config,
      );
      tl.severity = severity;
      if (severity)
        ctx.diffs.add({
          severity,
          category: tl.status,
          scenarioKey,
          checkpoint: b.label,
          animationKey: null,
          source: tl.source,
          title: `${tl.status === "removed" ? "Timeline removed" : "New timeline"}: ${engine} ${shown}`,
          detail:
            tl.status === "removed"
              ? "This timeline ran in the baseline but not in the candidate. Its animations are listed separately."
              : "This timeline ran in the candidate but not in the baseline.",
          measurement: "measured",
        });
      continue;
    }
    for (const ch of tl.changes)
      ctx.diffs.add({
        severity: ch.severity,
        category: CATEGORY[ch.kind],
        scenarioKey,
        checkpoint: b.label,
        animationKey: null,
        source: tl.source,
        title: `${engine} timeline ${shown}: ${ch.message}`,
        detail: ch.message,
        measurement: ch.measurement,
        before: ch.before,
        after: ch.after,
        ...(ch.delta !== undefined ? { delta: ch.delta } : {}),
        ...(ch.unit ? { unit: ch.unit } : {}),
      });
  }

  let latency: CheckpointComparison["latency"] = null;
  // Latency is only comparable when both captures measured it from the same interaction (step
  // and kind). Captures before 0.2 measured it from the window's first interaction, not the one
  // that caused the motion, so a baseline from then may name another step.
  const bt = b.window.trigger;
  const ct = c.window.trigger;
  const sameTrigger = !bt || !ct || (bt.step === ct.step && bt.type === ct.type);
  if (b.window.latency !== null && c.window.latency !== null && sameTrigger) {
    const delta = Math.round((c.window.latency - b.window.latency) * 10) / 10;
    latency = { baseline: b.window.latency, candidate: c.window.latency, delta };
    const computed = timingSeverity(
      b.window.latency,
      c.window.latency,
      config,
      config.timing.startToleranceMs,
    );
    const severity = !computed
      ? null
      : ctx.crossBrowser && !config.severity.start
        ? "uncertain"
        : applyOverride("start", capSeverity(computed, "warning"), config);
    if (severity) {
      ctx.diffs.add({
        severity,
        category: "timing",
        scenarioKey,
        checkpoint: b.label,
        animationKey: null,
        title: `Motion begins ${Math.abs(delta)}ms ${delta > 0 ? "later" : "sooner"} after the interaction`,
        detail: `Trigger-to-motion latency ${Math.round(b.window.latency)}ms → ${Math.round(c.window.latency)}ms (estimated; includes frame scheduling).`,
        measurement: "estimated",
        before: b.window.latency,
        after: c.window.latency,
        delta,
        unit: "ms",
      });
    }
  }

  const severities: (Severity | null)[] = [
    ...animations.map((a) => a.severity),
    ...stagger.map((s) => s.severity),
    ...scroll.map((s) => s.severity),
    ...timelines.map((t) => t.severity),
    visualSeverity,
  ];
  const severity = maxSeverity(severities);
  const changed =
    animations.some((a) => a.status !== "unchanged") ||
    scroll.some((s) => s.status !== "unchanged") ||
    timelines.some((t) => t.status !== "unchanged") ||
    stagger.length > 0 ||
    visual.status === "changed";
  return {
    label: b.label,
    status: changed ? "changed" : "unchanged",
    baselineIndex: b.index,
    candidateIndex: c.index,
    animations,
    visual,
    frameDivergence: divergence,
    stagger,
    latency,
    scroll,
    timelines,
    severity,
  };
}

function environmentDiagnostics(b: CaptureBundle, c: CaptureBundle): Diagnostic[] {
  const out: Diagnostic[] = [];
  const be = b.environment;
  const ce = c.environment;
  const bName = captureBrowser(b);
  const cName = captureBrowser(c);
  if (bName !== cName) {
    out.push({
      level: "warning",
      code: "CROSS_BROWSER_COMPARISON",
      message: `Cross-browser comparison: the baseline was captured with ${browserLabel(bName)} ${be.browser.version}, the candidate with ${browserLabel(cName)} ${ce.browser.version}.`,
      hint: "Engines lay out, render and schedule motion differently: pixel, geometry, start-offset and scroll differences are reported as uncertain. Declared timing and easing are compared as usual.",
    });
  } else if (be.browser.version !== ce.browser.version) {
    out.push({
      level: "warning",
      code: "BROWSER_VERSION_DIFFERS",
      message: `Browser versions differ (${be.browser.version} vs ${ce.browser.version}).`,
      hint: "Pixel comparisons may include rendering differences; animation timing data is unaffected.",
    });
  }
  if (be.platform !== ce.platform) {
    out.push({
      level: "warning",
      code: "PLATFORM_DIFFERS",
      message: `Captures come from different platforms (${be.platform} vs ${ce.platform}).`,
      hint: "Fonts render differently across operating systems. Capture the baseline where CI runs.",
    });
  }
  const scale = (bundle: CaptureBundle) =>
    [...new Set(bundle.scenarios.map((s) => s.viewport.deviceScaleFactor))].sort().join(",");
  if (scale(b) && scale(c) && scale(b) !== scale(c)) {
    out.push({
      level: "warning",
      code: "DEVICE_SCALE_FACTOR_DIFFERS",
      message: `Device scale factors differ (${scale(b)} vs ${scale(c)}); screenshots of different sizes are not compared pixel by pixel.`,
      hint: "Keep browser.deviceScaleFactor (and each viewport's) the same for baseline and candidate.",
    });
  }
  if (b.configHash !== c.configHash) {
    out.push({
      level: "info",
      code: "CONFIG_DIFFERS",
      message: "The capture configuration changed between baseline and candidate.",
    });
  }
  if (b.settings.samples !== c.settings.samples) {
    out.push({
      level: "info",
      code: "SAMPLE_COUNT_DIFFERS",
      message: `Sample counts differ (${b.settings.samples} vs ${c.settings.samples}); path comparisons use endpoints only.`,
    });
  }
  return out;
}

/** Compares two capture bundles. Pure apart from writing diff images when `outputDir` is set. */
export async function compareCaptures(options: CompareOptions): Promise<ComparisonResult> {
  const { config } = options;
  const b = options.baseline.bundle;
  const c = options.candidate.bundle;
  const crossBrowser = captureBrowser(b) !== captureBrowser(c);
  if (crossBrowser && !options.allowCrossBrowser) {
    throw new MotionprError(
      "BROWSER_MISMATCH",
      `The baseline was captured with ${browserLabel(captureBrowser(b))}, the candidate with ${browserLabel(captureBrowser(c))}.`,
      {
        hint: `Each browser has its own baseline: compare against the ${captureBrowser(c)} baseline (motionpr baseline accept --browser ${captureBrowser(c)} creates one). To compare engines on purpose, pass --cross-browser (API: allowCrossBrowser: true).`,
      },
    );
  }
  const diffs = new DifferenceList();
  const cache = new PngCache();
  const assets: ComparisonResult["assets"] = {};
  const scenarios: ScenarioComparison[] = [];
  const cByKey = new Map(c.scenarios.map((s) => [s.key, s]));
  const bKeys = new Set(b.scenarios.map((s) => s.key));

  const structural = (
    scenarioKey: string,
    rule: Parameters<typeof applyOverride>[0],
    computed: Severity,
    title: string,
    detail: string,
    checkpoint: string | null = null,
  ) => {
    const severity = applyOverride(rule, computed, config);
    if (severity)
      diffs.add({
        severity,
        category: rule.endsWith("added")
          ? "added"
          : rule.endsWith("removed")
            ? "removed"
            : "structure",
        scenarioKey,
        checkpoint,
        animationKey: null,
        title,
        detail,
        measurement: "measured",
      });
    return severity;
  };

  for (const sb of b.scenarios) {
    const sc = cByKey.get(sb.key);
    if (!sc) {
      const severity = structural(
        sb.key,
        "scenario-removed",
        "critical",
        `Scenario removed: ${sb.name}`,
        "The scenario is in the baseline but was not captured.",
      );
      scenarios.push({
        key: sb.key,
        id: sb.id,
        name: sb.name,
        viewport: sb.viewport.name,
        status: "removed",
        baselineStatus: sb.status,
        candidateStatus: null,
        checkpoints: [],
        severity,
      });
      continue;
    }
    if (sc.status === "failed") {
      const severity = structural(
        sb.key,
        "scenario-failed",
        "critical",
        `Scenario failed: ${sc.name}`,
        sc.error?.message ?? "The scenario failed during capture.",
      );
      scenarios.push({
        key: sb.key,
        id: sb.id,
        name: sc.name,
        viewport: sc.viewport.name,
        status: "failed",
        baselineStatus: sb.status,
        candidateStatus: sc.status,
        checkpoints: [],
        severity,
      });
      continue;
    }
    const checkpoints = await compareScenarioCheckpoints(sb, sc, {
      options,
      cache,
      diffs,
      assets,
      structural,
      crossBrowser,
      scrollContainers: {
        baseline: b.settings.scrollContainers,
        candidate: c.settings.scrollContainers,
      },
      shadowRoots: { baseline: b.settings.shadowRoots, candidate: c.settings.shadowRoots },
    });
    const severity = maxSeverity(checkpoints.map((cp) => cp.severity));
    const changed = checkpoints.some((cp) => cp.status !== "unchanged");
    scenarios.push({
      key: sb.key,
      id: sb.id,
      name: sc.name,
      viewport: sc.viewport.name,
      status: changed ? "changed" : "unchanged",
      baselineStatus: sb.status,
      candidateStatus: sc.status,
      checkpoints,
      severity,
    });
  }
  for (const sc of c.scenarios) {
    if (bKeys.has(sc.key)) continue;
    const severity = structural(
      sc.key,
      "scenario-added",
      "info",
      `New scenario: ${sc.name}`,
      "Not present in the baseline; accept a new baseline to start tracking it.",
    );
    scenarios.push({
      key: sc.key,
      id: sc.id,
      name: sc.name,
      viewport: sc.viewport.name,
      status: "added",
      baselineStatus: null,
      candidateStatus: sc.status,
      checkpoints: [],
      severity,
    });
  }

  const counts = { critical: 0, warning: 0, info: 0, uncertain: 0 };
  for (const d of diffs.items) counts[d.severity]++;
  const highest = maxSeverity(diffs.items.map((d) => d.severity));
  const failRank =
    config.failOn === "never" ? Number.POSITIVE_INFINITY : severityRank(config.failOn);
  const failed =
    diffs.items.some((d) => severityRank(d.severity) >= failRank && d.severity !== "uncertain") ||
    (config.failOnUncertain && counts.uncertain > 0);
  const allAnimations = scenarios.flatMap((s) => s.checkpoints.flatMap((cp) => cp.animations));
  const ref = (bundle: CaptureBundle) => ({
    id: bundle.id,
    createdAt: bundle.createdAt,
    motionprVersion: bundle.motionprVersion,
    browser: `${bundle.environment.browser.name} ${bundle.environment.browser.version}`,
    browserName: captureBrowser(bundle),
    platform: `${bundle.environment.platform}-${bundle.environment.arch}`,
    configHash: bundle.configHash,
  });

  const order: Record<Severity, number> = { critical: 0, warning: 1, uncertain: 2, info: 3 };
  const differences = [...diffs.items].sort((x, y) => order[x.severity] - order[y.severity]);
  const result: ComparisonResult = {
    schemaVersion: COMPARISON_SCHEMA_VERSION,
    kind: "motionpr-comparison",
    motionprVersion: MOTIONPR_VERSION,
    createdAt: new Date().toISOString(),
    baseline: ref(b),
    candidate: ref(c),
    crossBrowser,
    failOn: config.failOn,
    failOnUncertain: config.failOnUncertain,
    summary: {
      status: failed ? "failed" : "passed",
      highestSeverity: highest,
      counts,
      scenarios: {
        total: scenarios.length,
        changed: scenarios.filter((s) => s.status === "changed").length,
        added: scenarios.filter((s) => s.status === "added").length,
        removed: scenarios.filter((s) => s.status === "removed").length,
        failed: scenarios.filter((s) => s.status === "failed").length,
      },
      animations: {
        matched: allAnimations.filter((a) => a.match !== null).length,
        changed: allAnimations.filter((a) => a.status === "changed").length,
        added: allAnimations.filter((a) => a.status === "added").length,
        removed: allAnimations.filter((a) => a.status === "removed").length,
        unchanged: allAnimations.filter((a) => a.status === "unchanged").length,
      },
    },
    scenarios,
    differences,
    assets,
    diagnostics: environmentDiagnostics(b, c),
  };
  if (options.outputDir) await writeComparisonResult(options.outputDir, result);
  return result;
}

async function compareScenarioCheckpoints(
  sb: ScenarioResult,
  sc: ScenarioResult,
  ctx: {
    options: CompareOptions;
    cache: PngCache;
    diffs: DifferenceList;
    assets: ComparisonResult["assets"];
    crossBrowser: boolean;
    scrollContainers: { baseline: boolean; candidate: boolean };
    shadowRoots: { baseline: boolean; candidate: boolean };
    structural: (
      key: string,
      rule: "checkpoint-added" | "checkpoint-removed",
      computed: Severity,
      title: string,
      detail: string,
      checkpoint: string,
    ) => Severity | null;
  },
): Promise<CheckpointComparison[]> {
  const out: CheckpointComparison[] = [];
  const cByLabel = new Map(sc.checkpoints.map((cp) => [cp.label, cp]));
  const bLabels = new Set(sb.checkpoints.map((cp) => cp.label));
  for (const cb of sb.checkpoints) {
    const cc = cByLabel.get(cb.label);
    if (!cc) {
      const severity = ctx.structural(
        sb.key,
        "checkpoint-removed",
        "critical",
        `Checkpoint “${cb.label}” missing`,
        "The candidate run did not reach this checkpoint.",
        cb.label,
      );
      out.push({
        label: cb.label,
        status: "removed",
        baselineIndex: cb.index,
        candidateIndex: null,
        animations: [],
        visual: null,
        frameDivergence: [],
        stagger: [],
        latency: null,
        scroll: [],
        timelines: [],
        severity,
      });
      continue;
    }
    out.push(
      await compareCheckpoint(sb.key, cb, cc, { ...ctx, scale: sc.viewport.deviceScaleFactor }),
    );
  }
  for (const cc of sc.checkpoints) {
    if (bLabels.has(cc.label)) continue;
    const severity = ctx.structural(
      sb.key,
      "checkpoint-added",
      "warning",
      `New checkpoint “${cc.label}”`,
      "This checkpoint is not in the baseline.",
      cc.label,
    );
    out.push({
      label: cc.label,
      status: "added",
      baselineIndex: null,
      candidateIndex: cc.index,
      animations: [],
      visual: null,
      frameDivergence: [],
      stagger: [],
      latency: null,
      scroll: [],
      timelines: [],
      severity,
    });
  }
  return out;
}

/**
 * CLI exit code for a comparison: 0 within thresholds, 1 when a configured threshold was exceeded.
 * (Exit code 2 is reserved for configuration/execution errors and set by the CLI.)
 */
export function exitCodeFor(result: Pick<ComparisonResult, "summary">): 0 | 1 {
  return result.summary.status === "failed" ? 1 : 0;
}
