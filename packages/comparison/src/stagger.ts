import type { AnimationRecord, ComparisonConfig, StaggerChange } from "@motionpr/core";
import { applyOverride, capSeverity, timingSeverity } from "./severity.ts";

function withoutIndex(key: string): string {
  return key.replace(/:nth-of-type\(\d+\)(::[a-z-]+)?$/, "$1").replace(/([-_]?)\d+$/, "$1#");
}

/**
 * Family key for stagger detection: siblings that animate the same way. Uses an explicit
 * adapter group when present (e.g. one staggered GSAP tween), otherwise the element key with
 * its trailing index stripped (`test-id:card-3` → `test-id:card-`, `…>li:nth-of-type(3)` → `…>li`).
 * Inside the shadow root of a numbered host, the host's index is stripped instead: the same
 * element of repeated components is one family (`test-id:card-3 >> motionpr-id:glow`, and
 * `test-id:card-3 >> path:#shadow-root>div:nth-of-type(2)`, where the index is the element's
 * place in the component's template, not an instance).
 */
export function staggerGroupKey(r: AnimationRecord): string {
  if (r.group) return `group:${r.group}`;
  const key = r.element.key;
  const host = r.element.shadowHost;
  const hostFamily = host && key.startsWith(host) ? withoutIndex(host) : null;
  const family =
    host && hostFamily !== null && hostFamily !== host
      ? hostFamily + key.slice(host.length)
      : withoutIndex(key);
  const props = r.properties
    .map((p) => p.property)
    .sort()
    .join(",");
  return `${r.type}|${r.name ?? ""}|${props}|${family}`;
}

function visibleStart(r: AnimationRecord): number | null {
  if (r.startTime === null) return null;
  return r.startTime + r.timing.delay / (r.timing.playbackRate || 1);
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** Median interval between consecutive member starts, per group (groups of 3+ members). */
export function staggerIntervals(
  records: readonly AnimationRecord[],
): Map<string, { interval: number; members: number }> {
  const groups = new Map<string, number[]>();
  for (const r of records) {
    const start = visibleStart(r);
    if (start === null) continue;
    const key = staggerGroupKey(r);
    groups.set(key, [...(groups.get(key) ?? []), start]);
  }
  const out = new Map<string, { interval: number; members: number }>();
  for (const [key, starts] of groups) {
    if (starts.length < 3) continue;
    const sorted = [...starts].sort((a, b) => a - b);
    const deltas = sorted.slice(1).map((s, i) => s - sorted[i]!);
    out.set(key, { interval: Math.round(median(deltas) * 10) / 10, members: starts.length });
  }
  return out;
}

export function compareStagger(
  baseline: readonly AnimationRecord[],
  candidate: readonly AnimationRecord[],
  config: ComparisonConfig,
): StaggerChange[] {
  const b = staggerIntervals(baseline);
  const c = staggerIntervals(candidate);
  const out: StaggerChange[] = [];
  for (const [key, vb] of [...b].sort(([x], [y]) => x.localeCompare(y))) {
    const vc = c.get(key);
    if (!vc) continue;
    const computed = timingSeverity(
      vb.interval,
      vc.interval,
      config,
      Math.max(config.timing.toleranceMs, 4),
    );
    if (!computed) continue;
    const severity = applyOverride("stagger", capSeverity(computed, "warning"), config);
    if (!severity) continue;
    out.push({
      group: key,
      members: vc.members,
      baselineInterval: vb.interval,
      candidateInterval: vc.interval,
      delta: Math.round((vc.interval - vb.interval) * 10) / 10,
      severity,
    });
  }
  return out;
}
