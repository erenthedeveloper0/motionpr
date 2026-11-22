import { keyInShadowRoot, type AnimationRecord } from "@motionpr/core";

export interface AnimationMatch {
  baseline: AnimationRecord;
  candidate: AnimationRecord;
  method: "exact" | "element" | "fuzzy";
  confidence: "high" | "medium" | "low";
  notes: string[];
  /** Why every change of this pair is uncertain (appended to its messages), if it is. */
  uncertain?: string;
}

export interface MatchOptions {
  /**
   * The capture that predates MotionPR's look inside shadow roots (`settings.shadowRoots` is
   * false), when only one does. It identified elements in shadow roots without their host, so
   * the other capture's shadow-root records are paired with its records by their key within the
   * root (`test-id:thumb` for `test-id:card-2 >> test-id:thumb`).
   */
  shadowLegacy?: "baseline" | "candidate" | null;
}

export interface MatchResult {
  matches: AnimationMatch[];
  removed: AnimationRecord[];
  added: AnimationRecord[];
}

const CONFIDENCE_RANK = { high: 2, medium: 1, low: 0 } as const;

function minConfidence(a: AnimationRecord, b: AnimationRecord): "high" | "medium" | "low" {
  const ca = a.element.confidence;
  const cb = b.element.confidence;
  return CONFIDENCE_RANK[ca] <= CONFIDENCE_RANK[cb] ? ca : cb;
}

function propertySignature(r: AnimationRecord): Set<string> {
  return new Set(r.properties.map((p) => p.property));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size && !b.size) return 1;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/**
 * Deterministic three-pass matching of animations between two checkpoints:
 * 1. exact: identical animation id (element key + type + name);
 * 2. element: same element and type, different name, unambiguous on both sides
 *    (e.g. renamed @keyframes or a different transition property);
 * 3. fuzzy: same type and name on an element with the same tag and the same label or
 *    selector, with at least 50% property overlap — always reported as low confidence.
 *
 * Against a capture made before MotionPR looked inside shadow roots, shadow-root records are
 * first paired by their key within the root (`options.shadowLegacy`), as fuzzy matches whose
 * changes are uncertain: that capture also replayed them without freezing their shadow tree.
 */
export function matchAnimations(
  baseline: readonly AnimationRecord[],
  candidate: readonly AnimationRecord[],
  options: MatchOptions = {},
): MatchResult {
  const matches: AnimationMatch[] = [];
  const restB = new Map(baseline.map((r) => [r.id, r]));
  const restC = new Map(candidate.map((r) => [r.id, r]));

  for (const [id, b] of [...restB]) {
    const c = restC.get(id);
    if (!c) continue;
    matches.push({
      baseline: b,
      candidate: c,
      method: "exact",
      confidence: minConfidence(b, c),
      notes: [],
    });
    restB.delete(id);
    restC.delete(id);
  }

  const groupKey = (r: AnimationRecord) => `${r.element.key}|${r.type}`;
  const groupB = new Map<string, AnimationRecord[]>();
  const groupC = new Map<string, AnimationRecord[]>();
  for (const r of restB.values()) groupB.set(groupKey(r), [...(groupB.get(groupKey(r)) ?? []), r]);
  for (const r of restC.values()) groupC.set(groupKey(r), [...(groupC.get(groupKey(r)) ?? []), r]);
  for (const [key, bs] of [...groupB].sort(([a], [b]) => a.localeCompare(b))) {
    const cs = groupC.get(key);
    if (bs.length !== 1 || cs?.length !== 1) continue;
    const b = bs[0]!;
    const c = cs[0]!;
    matches.push({
      baseline: b,
      candidate: c,
      method: "element",
      confidence: CONFIDENCE_RANK[minConfidence(b, c)] >= 1 ? "medium" : "low",
      notes: [
        `Same element, renamed from "${b.name ?? "anonymous"}" to "${c.name ?? "anonymous"}".`,
      ],
    });
    restB.delete(b.id);
    restC.delete(c.id);
  }

  if (options.shadowLegacy) {
    const old = options.shadowLegacy;
    const [newRest, oldRest] = old === "baseline" ? [restC, restB] : [restB, restC];
    for (const n of [...newRest.values()]) {
      if (!n.element.shadowHost) continue;
      const inner = keyInShadowRoot(n.element);
      let o: AnimationRecord | undefined;
      for (const r of oldRest.values()) {
        if (r.element.key === inner && r.type === n.type && r.name === n.name) {
          o = r;
          break;
        }
      }
      if (!o) continue;
      const [b, c] = old === "baseline" ? [o, n] : [n, o];
      matches.push({
        baseline: b,
        candidate: c,
        method: "fuzzy",
        confidence: "low",
        notes: [
          `Element identity changed from ${b.element.key} to ${c.element.key}: the ${old} was captured before MotionPR identified elements inside shadow roots through their host.`,
        ],
        uncertain: `the ${old} was captured before MotionPR looked inside shadow roots`,
      });
      restB.delete(b.id);
      restC.delete(c.id);
    }
  }

  const candidates: { b: AnimationRecord; c: AnimationRecord; score: number }[] = [];
  for (const b of restB.values()) {
    for (const c of restC.values()) {
      if (b.type !== c.type || b.name !== c.name || b.element.tag !== c.element.tag) continue;
      // Property overlap alone is not evidence of identity (many elements animate `transform`):
      // require the same accessible label or the same selector as well.
      const sameLabel = Boolean(b.element.label) && b.element.label === c.element.label;
      const sameSelector = b.element.selector !== "" && b.element.selector === c.element.selector;
      const overlap = jaccard(propertySignature(b), propertySignature(c));
      if (!(sameLabel || sameSelector) || overlap < 0.5) continue;
      candidates.push({ b, c, score: overlap + (sameLabel ? 1 : 0) + (sameSelector ? 0.5 : 0) });
    }
  }
  candidates.sort(
    (x, y) => y.score - x.score || x.b.id.localeCompare(y.b.id) || x.c.id.localeCompare(y.c.id),
  );
  for (const { b, c } of candidates) {
    if (!restB.has(b.id) || !restC.has(c.id)) continue;
    matches.push({
      baseline: b,
      candidate: c,
      method: "fuzzy",
      confidence: "low",
      notes: [
        `Element identity changed from ${b.element.key} to ${c.element.key}; matched by name, tag and label.`,
      ],
    });
    restB.delete(b.id);
    restC.delete(c.id);
  }

  const order = new Map(baseline.map((r, i) => [r.id, i]));
  matches.sort((x, y) => (order.get(x.baseline.id) ?? 0) - (order.get(y.baseline.id) ?? 0));
  return { matches, removed: [...restB.values()], added: [...restC.values()] };
}
