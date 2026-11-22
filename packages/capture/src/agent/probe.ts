/**
 * The in-page half of the adapter conformance suite (`motionpr adapter check`). Injected after
 * the agent and before page scripts, it sees every adapter passed to `registerAdapter` and runs
 * the protocol's checks against the adapter object itself: what it reports, how it settles, how
 * it replays and restores. The Node half (`conformance.ts`) adds the checks that need a fresh
 * page: without MotionPR, and a real capture.
 *
 * Only used by the conformance suite; captures never load it.
 */
import {
  ADAPTER_CHECKS,
  CHECK_HOOK_GLOBAL,
  adapterProblems,
  animationProblems,
  declaredProtocol,
  describeValue,
  diagnosticProblems,
  isElement,
  scrollStateProblems,
  scrollTrackProblems,
  timelineProblems,
  type AdapterCheckId,
  type AdapterCheckResult,
  type AdapterCheckStatus,
  type AdapterCheckSubject,
  type ContractProblem,
} from "@motionpr/core/adapter-contract";
import type { AdapterAnimation, MotionprAdapter } from "@motionpr/core/protocol";
import { isVersionRange, versionSatisfies } from "@motionpr/core/semver";

export const PROBE_GLOBAL = "__MOTIONPR_PROBE__";

/** What the Node half calls in the page. */
export interface ProbeApi {
  /** Adapters passed to `registerAdapter` so far, and whether the agent registered them. */
  adapters(): { name: string; registered: boolean }[];
  run(name: string, options: { timeout: number }): Promise<ProbeRun>;
}

export interface ProbeRun {
  subject: AdapterCheckSubject;
  checks: AdapterCheckResult[];
}

const TITLES = new Map<string, string>(ADAPTER_CHECKS.map((c) => [c.id, c.title]));
/** Problems listed per check before the rest are counted. */
const MAX_DETAILS = 12;
/** Animations sampled by the replay checks. */
const MAX_REPLAYED = 20;

type Attempt<T> = { ok: true; value: T } | { ok: false; error: string };

function attempt<T>(fn: () => T): Attempt<T> {
  try {
    return { ok: true, value: fn() };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const idOf = (entry: unknown): string =>
  typeof entry === "object" && entry !== null && "id" in entry
    ? String((entry as { id: unknown }).id)
    : "?";
const ms = (t: number) => `${Math.round(t)} ms`;

/** Problems gathered over many calls, each message once, with the ids it applies to. */
class ProblemSet {
  readonly #byMessage = new Map<string, { level: ContractProblem["level"]; ids: Set<string> }>();
  add(problem: ContractProblem, id: string): void {
    const entry = this.#byMessage.get(problem.message) ?? { level: problem.level, ids: new Set() };
    entry.ids.add(id);
    this.#byMessage.set(problem.message, entry);
  }
  get size(): number {
    return this.#byMessage.size;
  }
  has(level: ContractProblem["level"]): boolean {
    return [...this.#byMessage.values()].some((e) => e.level === level);
  }
  lines(): string[] {
    const order = { invalid: 0, violation: 1, advice: 2 } as const;
    return [...this.#byMessage.entries()]
      .sort((a, b) => order[a[1].level] - order[b[1].level])
      .map(([message, { level, ids }]) => {
        const which = [...ids].filter((id) => id !== "?");
        const prefix =
          level === "invalid" ? "left out of captures: " : level === "advice" ? "advice: " : "";
        const where = which.length
          ? ` (${which
              .slice(0, 3)
              .map((id) => `"${id}"`)
              .join(", ")}${which.length > 3 ? `, ${which.length - 3} more` : ""})`
          : "";
        return `${prefix}${message}${where}`;
      });
  }
}

function result(
  id: AdapterCheckId,
  status: AdapterCheckStatus,
  summary: string,
  details: readonly string[] = [],
): AdapterCheckResult {
  const lines = details.slice(0, MAX_DETAILS);
  if (details.length > MAX_DETAILS) lines.push(`…and ${details.length - MAX_DETAILS} more.`);
  return { id, title: TITLES.get(id) ?? id, status, summary, details: lines };
}

/** Status for a list of contract problems: invalid or violation fail, advice warns. */
function statusOf(problems: readonly ContractProblem[]): AdapterCheckStatus {
  if (problems.some((p) => p.level !== "advice")) return "fail";
  return problems.length ? "warn" : "pass";
}

function lines(problems: readonly ContractProblem[]): string[] {
  return problems.map((p) => (p.level === "advice" ? `advice: ${p.message}` : p.message));
}

/** Absolute performance-clock span of a finite animation's active phase. */
function activeSpan(a: AdapterAnimation): { start: number; end: number } | null {
  if (!isNum(a.startTime) || !isNum(a.duration) || !Number.isFinite(a.iterations)) return null;
  const rate = a.playbackRate || 1;
  const active = isNum(a.activeDuration) ? a.activeDuration : a.duration * a.iterations;
  const x = a.startTime + a.delay / rate;
  const y = a.startTime + (a.delay + active) / rate;
  return { start: Math.min(x, y), end: Math.max(x, y) };
}

/** Performance-clock times at 0 %, 50 % and 100 % of the active phase (one iteration if endless). */
function seekTimes(a: AdapterAnimation): [number, number, number] | null {
  if (!isNum(a.startTime) || !isNum(a.duration) || a.duration <= 0) return null;
  const rate = a.playbackRate || 1;
  const active = isNum(a.activeDuration)
    ? a.activeDuration
    : Number.isFinite(a.iterations)
      ? a.duration * a.iterations
      : a.duration;
  if (!(active > 0)) return null;
  const at = (k: number) => a.startTime! + (a.delay + Math.min(active * k, active - 0.01)) / rate;
  return [at(0), at(0.5), at(1)];
}

export function installProbe(win: Window): void {
  const agent = win.__MOTIONPR_AGENT__;
  if (!agent) return;
  const perf = win.performance;
  const now = () => perf.now();
  const seen: MotionprAdapter[] = [];
  const register = agent.registerAdapter;
  agent.registerAdapter = (adapter: MotionprAdapter) => {
    if (adapter && !seen.includes(adapter)) seen.push(adapter);
    return register.call(agent, adapter);
  };
  let callbacks = 0;
  Object.defineProperty(win, CHECK_HOOK_GLOBAL, {
    value: Object.freeze({
      /** Call from the engine's callbacks (onComplete, onUpdate, …) in the page under test. */
      callback: () => {
        callbacks++;
      },
    }),
    configurable: false,
    enumerable: false,
    writable: false,
  });

  const frame = () =>
    new Promise<number>((resolve) => {
      const timer = win.setTimeout(() => resolve(now()), 100);
      win.requestAnimationFrame(() => {
        win.clearTimeout(timer);
        resolve(now());
      });
    });
  const frames = async (n: number) => {
    for (let i = 0; i < n; i++) await frame();
  };

  function read(target: Element, properties: readonly string[]): string {
    if (!target.isConnected) return "{}";
    const style = win.getComputedStyle(target);
    const out: Record<string, string> = {};
    for (const p of properties) {
      if (p.startsWith("attr:")) out[p] = target.getAttribute(p.slice(5)) ?? "";
      else if (p.startsWith("prop:")) {
        const v = (target as unknown as Record<string, unknown>)[p.slice(5)];
        out[p] = typeof v === "number" || typeof v === "string" ? String(v) : "";
      } else out[p] = style.getPropertyValue(p);
    }
    return JSON.stringify(out);
  }

  function subjectOf(adapter: MotionprAdapter): AdapterCheckSubject {
    const caps: unknown = adapter.capabilities;
    return {
      name: adapter.name,
      protocol: declaredProtocol(adapter),
      version: typeof adapter.version === "string" ? adapter.version : null,
      supportedRange: typeof adapter.supportedRange === "string" ? adapter.supportedRange : null,
      capabilities: Array.isArray(caps)
        ? caps.filter((c): c is string => typeof c === "string")
        : [],
    };
  }

  /** Registration, protocol, metadata and capabilities: the adapter object itself. */
  function staticChecks(adapter: MotionprAdapter, registered: boolean): AdapterCheckResult[] {
    const problems = adapterProblems(adapter);
    const of = (fields: readonly string[]) => problems.filter((p) => fields.includes(p.field));
    const out: AdapterCheckResult[] = [];

    const status = agent!.adapterStatus().find((s) => s.id === adapter.name);
    const rejected = status?.diagnostics.find((d) => d.code === "ADAPTER_PROTOCOL_UNSUPPORTED");
    const duplicate = seen.filter((a) => a.name === adapter.name).length > 1;
    const reg = of(["", "name", "collect"]);
    if (!registered) {
      out.push(
        result(
          "registration",
          "fail",
          rejected
            ? "The agent did not register it: it declares an unsupported protocol."
            : "The agent did not register it.",
          [...(rejected ? [rejected.message] : []), ...lines(reg)],
        ),
      );
    } else {
      out.push(
        result(
          "registration",
          statusOf(reg) === "pass" && duplicate ? "warn" : statusOf(reg),
          `Registered as "${adapter.name}".`,
          [
            ...lines(reg),
            ...(duplicate
              ? [
                  `Another adapter object named "${adapter.name}" was passed to registerAdapter(); the agent keeps the first and ignores the rest.`,
                ]
              : []),
          ],
        ),
      );
    }

    const protocol = of(["protocol"]);
    const declared = (adapter as { protocol?: unknown }).protocol;
    out.push(
      result(
        "protocol",
        declared === 1 ? "warn" : statusOf(protocol),
        declared === undefined
          ? "No protocol declared: treated as protocol 1."
          : `Declares adapter protocol ${describeValue(declared)}.`,
        declared === 1
          ? [
              "Protocol 1 adapters keep working (same members); declare protocol: 2 once this suite passes.",
            ]
          : lines(protocol),
      ),
    );

    const meta = [...of(["version", "supportedRange"])];
    const { version, supportedRange } = adapter;
    if (typeof supportedRange === "string" && supportedRange.trim()) {
      if (!isVersionRange(supportedRange))
        meta.push({
          level: "violation",
          field: "supportedRange",
          message: `supportedRange ${describeValue(supportedRange)} is not a version range MotionPR reads (e.g. ">=2.0.0 <3.0.0", "^2.1.0").`,
        });
      else if (typeof version === "string" && version && !versionSatisfies(version, supportedRange))
        meta.push({
          level: "advice",
          field: "version",
          message: `The engine in this page (${version}) is outside the tested range ${supportedRange}: captures mark it "untested".`,
        });
    }
    out.push(
      result(
        "metadata",
        statusOf(meta),
        typeof version === "string" && version
          ? `Engine ${version}${typeof supportedRange === "string" && supportedRange ? `, tested range ${supportedRange}` : ""}.`
          : "No engine version reported.",
        lines(meta),
      ),
    );

    const caps = problems.filter(
      (p) => p.field === "capabilities" || ADAPTER_METHOD_FIELDS.has(p.field),
    );
    const declaredCaps = subjectOf(adapter).capabilities;
    out.push(
      result(
        "capabilities",
        statusOf(caps),
        declaredCaps.length ? `Declares ${declaredCaps.join(", ")}.` : "Declares no capabilities.",
        lines(caps),
      ),
    );
    return out;
  }

  const ADAPTER_METHOD_FIELDS = new Set([
    "beginWindow",
    "isAnimating",
    "beginReplay",
    "seek",
    "seekProgress",
    "endReplay",
    "collectTimelines",
    "collectScroll",
    "scrollStates",
    "scrollTo",
    "claims",
    "diagnostics",
  ]);

  interface Observation {
    checks: AdapterCheckResult[];
    /** The last collect's valid animations. */
    animations: AdapterAnimation[];
  }

  /** Watches the page's motion through collect(), timelines and isAnimating() until it settles. */
  async function observe(adapter: MotionprAdapter, timeout: number): Promise<Observation> {
    const caps = subjectOf(adapter).capabilities;
    const declaresAnimations = caps.length === 0 || caps.includes("animations");
    const started = now();
    const deadline = started + timeout;
    const problems = new ProblemSet();
    const timelineSet = new ProblemSet();
    const timelineIds = new Set<string>();
    const parents = new Map<string, string>();
    const reported = new Set<string>();
    let collects = 0;
    let firstSeen: number | null = null;
    let entries = 0;
    let last: AdapterAnimation[] = [];
    let collectError: string | null = null;
    let timelinesError: string | null = null;
    let unstable: string | null = null;
    const hasIsAnimating = typeof adapter.isAnimating === "function";
    const hasTimelines = typeof adapter.collectTimelines === "function";
    const misses: string[] = [];
    let trueWhileRunning = 0;
    let isAnimatingError: string | null = null;
    let nonBoolean: unknown;
    let lastFiniteEnd = -Infinity;
    let settledAt: number | null = null;

    for (;;) {
      await frame();
      const t = now();
      const r = attempt(() => adapter.collect());
      if (!r.ok || !Array.isArray(r.value)) {
        collectError = r.ok
          ? `collect() returned ${describeValue(r.value)}, not an array.`
          : `collect() threw: ${r.error}`;
        break;
      }
      collects++;
      const batch: unknown[] = r.value;
      entries = Math.max(entries, batch.length);
      if (batch.length) firstSeen ??= t;
      if (!unstable) {
        const again = attempt(() => adapter.collect());
        const a = batch.map(idOf).sort().join("\n");
        const b =
          again.ok && Array.isArray(again.value) ? again.value.map(idOf).sort().join("\n") : null;
        if (a !== b)
          unstable = `Two calls in a row reported different animations (${batch.length} then ${again.ok && Array.isArray(again.value) ? again.value.length : "an error"}).`;
      }
      const ids = new Set<string>();
      const valid: AdapterAnimation[] = [];
      for (const entry of batch) {
        const found = animationProblems(entry, { now: t });
        const id = idOf(entry);
        for (const p of found) problems.add(p, id);
        if (ids.has(id)) {
          problems.add(
            {
              level: "invalid",
              field: "id",
              message:
                "An id is reported twice in one collect(); ids must be unique (the agent keeps the first).",
            },
            id,
          );
          continue;
        }
        ids.add(id);
        if (found.some((p) => p.level === "invalid")) continue;
        const a = entry as AdapterAnimation;
        valid.push(a);
        reported.add(id);
        if (typeof a.parent === "string" && a.parent) parents.set(id, a.parent);
      }
      if (hasTimelines && !timelinesError) {
        const tl = attempt(() => adapter.collectTimelines!());
        if (!tl.ok || !Array.isArray(tl.value))
          timelinesError = tl.ok
            ? `collectTimelines() returned ${describeValue(tl.value)}, not an array.`
            : `collectTimelines() threw: ${tl.error}`;
        else
          for (const entry of tl.value as unknown[]) {
            for (const p of timelineProblems(entry)) timelineSet.add(p, idOf(entry));
            timelineIds.add(idOf(entry));
          }
      }
      if (valid.length) last = valid;
      const running = valid.filter((a) => a.playState === "running" && activeSpan(a));
      for (const a of running) lastFiniteEnd = Math.max(lastFiniteEnd, activeSpan(a)!.end);
      if (hasIsAnimating && !isAnimatingError && nonBoolean === undefined) {
        const v = attempt(() => adapter.isAnimating!());
        if (!v.ok) isAnimatingError = v.error;
        else if (typeof v.value !== "boolean") nonBoolean = v.value;
        else {
          const mid = running.find((a) => {
            const span = activeSpan(a)!;
            return t > span.start + 50 && t < span.end - 50;
          });
          if (mid && v.value) trueWhileRunning++;
          if (mid && !v.value && misses.length < 3) {
            const span = activeSpan(mid)!;
            misses.push(
              `At ${ms(t)}, "${mid.id}" was running (${ms(span.start)}–${ms(span.end)}) but isAnimating() returned false.`,
            );
          }
          if (firstSeen !== null && t > lastFiniteEnd + 100 && !v.value) settledAt ??= t;
          if (v.value) settledAt = null;
        }
      }
      if (t > deadline) break;
      if (firstSeen !== null) {
        const finiteDone = t > lastFiniteEnd + 100;
        const animatingDone =
          !hasIsAnimating ||
          settledAt !== null ||
          isAnimatingError !== null ||
          nonBoolean !== undefined;
        if (finiteDone && animatingDone && t - firstSeen > 300) break;
      } else if (!declaresAnimations && t - started > 500) break;
    }

    const checks: AdapterCheckResult[] = [];
    if (!declaresAnimations && reported.size === 0)
      checks.push(
        result("motion", "skip", "The adapter does not declare the animations capability."),
      );
    else if (collectError) checks.push(result("motion", "fail", collectError));
    else if (firstSeen !== null && reported.size === 0)
      checks.push(
        result(
          "motion",
          "fail",
          `collect() reported ${entries} entr${entries === 1 ? "y" : "ies"}, none of them valid: captures leave them out.`,
          ["See the animations check for what is wrong with them."],
        ),
      );
    else if (firstSeen === null)
      checks.push(
        result("motion", "fail", `collect() reported no animation within ${ms(timeout)}.`, [
          "The page must start at least one animation of the engine after it loads (see docs/cli/adapter.md).",
        ]),
      );
    else
      checks.push(
        result(
          "motion",
          "pass",
          `Reported ${reported.size} animation${reported.size === 1 ? "" : "s"} over ${collects} collect() calls.`,
        ),
      );

    if (reported.size === 0 && problems.size === 0)
      checks.push(result("animations", "skip", "No animation entries to check."));
    else
      checks.push(
        result(
          "animations",
          problems.has("invalid") || problems.has("violation")
            ? "fail"
            : problems.size
              ? "warn"
              : "pass",
          problems.size
            ? `${problems.size} problem${problems.size === 1 ? "" : "s"} in the entries collect() returned.`
            : `Every entry follows the protocol (${reported.size} animations).`,
          problems.lines(),
        ),
      );

    checks.push(
      collectError
        ? result("collect-stable", "skip", "collect() failed.")
        : unstable
          ? result("collect-stable", "fail", unstable, [
              "collect() must report what was observed since the window opened, without consuming or changing it.",
            ])
          : result("collect-stable", "pass", "Two calls in a row report the same animations."),
    );

    const dangling = [...parents.entries()].filter(([, parent]) => !timelineIds.has(parent));
    if (!hasTimelines)
      checks.push(
        dangling.length
          ? result(
              "timelines",
              "fail",
              "Animations name a parent timeline, but collectTimelines() is not implemented.",
              dangling.map(([id, parent]) => `"${id}" → parent "${parent}"`),
            )
          : result("timelines", "skip", "collectTimelines() is not implemented."),
      );
    else if (timelinesError) checks.push(result("timelines", "fail", timelinesError));
    else {
      const details = [
        ...timelineSet.lines(),
        ...dangling.map(
          ([id, parent]) =>
            `"${id}" names parent "${parent}", which collectTimelines() never reported (the record loses its timeline).`,
        ),
      ];
      const failed =
        timelineSet.has("invalid") || timelineSet.has("violation") || dangling.length > 0;
      checks.push(
        result(
          "timelines",
          failed ? "fail" : details.length ? "warn" : "pass",
          timelineIds.size
            ? `${timelineIds.size} timeline${timelineIds.size === 1 ? "" : "s"} reported${details.length ? "" : ", all following the protocol"}.`
            : "No timelines in this page.",
          details,
        ),
      );
    }

    const finiteSeen = lastFiniteEnd > -Infinity;
    if (!hasIsAnimating)
      checks.push(
        finiteSeen || reported.size
          ? result("settling", "warn", "isAnimating() is not implemented.", [
              "Captures then cannot wait for this engine's animations to finish before a checkpoint.",
            ])
          : result("settling", "skip", "isAnimating() is not implemented."),
      );
    else if (isAnimatingError)
      checks.push(result("settling", "fail", `isAnimating() threw: ${isAnimatingError}`));
    else if (nonBoolean !== undefined)
      checks.push(
        result(
          "settling",
          "fail",
          `isAnimating() returned ${describeValue(nonBoolean)}, not a boolean.`,
        ),
      );
    else {
      const finalValue = attempt(() => adapter.isAnimating!());
      const stuck =
        finalValue.ok &&
        finalValue.value === true &&
        !last.some((a) => {
          const span = activeSpan(a);
          return a.playState === "running" && span !== null && now() < span.end;
        });
      if (misses.length)
        checks.push(
          result(
            "settling",
            "fail",
            "isAnimating() was false while a finite animation ran.",
            misses,
          ),
        );
      else if (stuck)
        checks.push(
          result(
            "settling",
            "fail",
            "isAnimating() stays true although no finite animation is running.",
            [
              "Endless animations must not count: captures would wait for them until they time out.",
            ],
          ),
        );
      else
        checks.push(
          result(
            "settling",
            "pass",
            trueWhileRunning
              ? `True while finite animations ran (${trueWhileRunning} frames), false once they ended.`
              : "False: no finite animation was running while observed.",
          ),
        );
    }
    return { checks, animations: last };
  }

  /** seek(), determinism, holding still, restoring and callbacks during replay. */
  async function replayChecks(
    adapter: MotionprAdapter,
    animations: AdapterAnimation[],
  ): Promise<AdapterCheckResult[]> {
    const ids: AdapterCheckId[] = [
      "replay-renders",
      "replay-deterministic",
      "replay-holds",
      "replay-restores",
      "replay-callbacks",
    ];
    const skipAll = (summary: string, first?: AdapterCheckResult) =>
      ids.map((id, i) => (i === 0 && first ? first : result(id, "skip", summary)));
    const samplable = animations
      .filter(
        (a) =>
          a.samplable === true && isElement(a.target) && seekTimes(a) && a.properties.length > 0,
      )
      .slice(0, MAX_REPLAYED);
    if (!samplable.length)
      return skipAll("No samplable animation with a DOM target and a start time was reported.");
    if (typeof adapter.seek !== "function")
      return skipAll(
        "seek() is not implemented.",
        result("replay-renders", "warn", "seek() is not implemented.", [
          "Records are metadata only: no sampled values, no filmstrip, no value comparison.",
        ]),
      );

    // What endReplay() must restore: everything that is not still playing (finished or paused).
    const resting = animations.filter((a) => isElement(a.target) && a.playState !== "running");
    const snapshot = (list: AdapterAnimation[]) => list.map((a) => read(a.target!, a.properties));
    const before = snapshot(resting);
    const callbacksBefore = callbacks;
    const errors: string[] = [];
    const call = (label: string, fn: () => void) => {
      const r = attempt(fn);
      if (!r.ok && errors.length < 5) errors.push(`${label} threw: ${r.error}`);
      return r.ok;
    };

    call("beginReplay()", () => adapter.beginReplay?.());
    const unchanged: string[] = [];
    const differs: string[] = [];
    for (const a of samplable) {
      const [t0, tMid, tEnd] = seekTimes(a)!;
      const at = (t: number) => (
        call(`seek(${ms(t)})`, () => adapter.seek!(t)),
        read(a.target!, a.properties)
      );
      const v0 = at(t0);
      const vMid = at(tMid);
      const vEnd = at(tEnd);
      at(t0);
      const vMidAgain = at(tMid);
      if (v0 === vMid && vMid === vEnd)
        unchanged.push(`"${a.id}" showed ${v0} at 0 %, 50 % and 100 % of its active phase.`);
      if (vMid !== vMidAgain) differs.push(`"${a.id}" at ${ms(tMid)}: ${vMid}, then ${vMidAgain}.`);
    }
    // Hold still: the runner takes screenshots between seeks, so frames pass during replay.
    const first = samplable[0]!;
    call("seek()", () => adapter.seek!(seekTimes(first)![1]));
    const held = snapshot(samplable);
    await frames(3);
    const heldAfter = snapshot(samplable);
    const moved = samplable.flatMap((a, i) =>
      held[i] !== heldAfter[i]
        ? [`"${a.id}" changed while replay was paused: ${held[i]} → ${heldAfter[i]}.`]
        : [],
    );
    call("endReplay()", () => adapter.endReplay?.());
    const callbacksDuring = callbacks - callbacksBefore;
    await frames(2);
    const after = snapshot(resting);
    const notRestored = resting
      .map((a, i) =>
        before[i] !== after[i]
          ? `"${a.id}": ${before[i]} before replay, ${after[i]} after endReplay().`
          : null,
      )
      .filter((s): s is string => s !== null);

    const n = samplable.length;
    const out: AdapterCheckResult[] = [];
    out.push(
      errors.length
        ? result("replay-renders", "fail", "Replay methods threw.", errors)
        : unchanged.length === n
          ? result("replay-renders", "fail", "seek() did not change any sampled value.", unchanged)
          : result(
              "replay-renders",
              unchanged.length ? "warn" : "pass",
              `seek() rendered ${n - unchanged.length} of ${n} animation${n === 1 ? "" : "s"} at the requested times.`,
              unchanged,
            ),
    );
    out.push(
      differs.length
        ? result("replay-deterministic", "fail", "The same time rendered differently.", differs)
        : result(
            "replay-deterministic",
            "pass",
            `Seeking ${n} animation${n === 1 ? "" : "s"} twice to one time gave the same values.`,
          ),
    );
    out.push(
      moved.length
        ? result("replay-holds", "fail", "Animations kept playing during replay.", [
            ...moved,
            "beginReplay() must pause what seek() renders: captures take screenshots between seeks.",
          ])
        : result("replay-holds", "pass", "Values held for 3 frames after seek()."),
    );
    out.push(
      !resting.length
        ? result(
            "replay-restores",
            "skip",
            "Every reported animation was still playing; nothing at rest to compare.",
          )
        : notRestored.length
          ? result(
              "replay-restores",
              "fail",
              "endReplay() left the page as replay rendered it.",
              notRestored,
            )
          : result(
              "replay-restores",
              "pass",
              `${resting.length} animation${resting.length === 1 ? "" : "s"} at rest showed the same values after endReplay().`,
            ),
    );
    out.push(
      callbacksDuring > 0
        ? result(
            "replay-callbacks",
            "fail",
            `${callbacksDuring} application callback${callbacksDuring === 1 ? "" : "s"} fired during replay.`,
            ["seek() must render without firing the engine's callbacks (onUpdate, onComplete, …)."],
          )
        : callbacksBefore === 0
          ? result(
              "replay-callbacks",
              "skip",
              `The page does not call ${CHECK_HOOK_GLOBAL}.callback().`,
              [
                `Call window.${CHECK_HOOK_GLOBAL}?.callback() from the engine's callbacks in the test page to check this.`,
              ],
            )
          : result(
              "replay-callbacks",
              "pass",
              `No callback fired during replay (${callbacksBefore} before it).`,
            ),
    );
    return out;
  }

  function seekProgressCheck(
    adapter: MotionprAdapter,
    animations: AdapterAnimation[],
  ): AdapterCheckResult {
    const linked = animations
      .filter(
        (a) => a.startTime === null && a.scrollRange && a.samplable === true && isElement(a.target),
      )
      .slice(0, MAX_REPLAYED);
    if (!linked.length)
      return result("seek-progress", "skip", "No samplable scroll-linked animation in this page.");
    if (typeof adapter.seekProgress !== "function")
      return result("seek-progress", "warn", "seekProgress() is not implemented.", [
        "Scroll-linked animations are recorded without sampled values.",
      ]);
    const problems: string[] = [];
    const errors: string[] = [];
    const call = (fn: () => void) => {
      const r = attempt(fn);
      if (!r.ok && errors.length < 5) errors.push(`threw: ${r.error}`);
    };
    call(() => adapter.beginReplay?.());
    for (const a of linked) {
      const { from, to } = a.scrollRange!;
      const at = (p: number) => (
        call(() => adapter.seekProgress!(a.id, p)),
        read(a.target!, a.properties)
      );
      const v0 = at(from);
      const v1 = at(to);
      const v0Again = at(from);
      if (v0 === v1) problems.push(`"${a.id}" showed ${v0} at progress ${from} and ${to}.`);
      if (v0 !== v0Again) problems.push(`"${a.id}" rendered progress ${from} differently twice.`);
    }
    call(() => adapter.endReplay?.());
    if (errors.length) return result("seek-progress", "fail", "seekProgress() threw.", errors);
    return problems.length
      ? result(
          "seek-progress",
          "fail",
          "seekProgress() did not render the requested progress.",
          problems,
        )
      : result(
          "seek-progress",
          "pass",
          `Rendered ${linked.length} scroll-linked animation${linked.length === 1 ? "" : "s"} by progress.`,
        );
  }

  function windowCheck(
    adapter: MotionprAdapter,
    animations: AdapterAnimation[],
  ): AdapterCheckResult {
    const opened = now();
    const finished = animations.filter((a) => {
      const span = activeSpan(a);
      return span !== null && span.end < opened - 50 && a.playState !== "running";
    });
    if (!finished.length) return result("window", "skip", "No finished animation to check.");
    if (typeof adapter.beginWindow !== "function")
      return result("window", "fail", "beginWindow() is not implemented.", [
        "Animations that ended in one checkpoint would be reported again in the next.",
      ]);
    const opening = attempt(() => adapter.beginWindow!());
    if (!opening.ok) return result("window", "fail", `beginWindow() threw: ${opening.error}`);
    const next = attempt(() => adapter.collect());
    if (!next.ok || !Array.isArray(next.value))
      return result("window", "fail", "collect() failed after beginWindow().");
    const ids = new Set((next.value as unknown[]).map(idOf));
    const again = finished.filter((a) => ids.has(String(a.id)));
    return again.length
      ? result(
          "window",
          "fail",
          `${again.length} animation${again.length === 1 ? "" : "s"} that ended before the window opened ${again.length === 1 ? "was" : "were"} reported again.`,
          again.map(
            (a) =>
              `"${a.id}" ended at ${ms(activeSpan(a)!.end)}; the window opened at ${ms(opened)}.`,
          ),
        )
      : result(
          "window",
          "pass",
          `${finished.length} finished animation${finished.length === 1 ? " was" : "s were"} not reported again.`,
        );
  }

  async function scrollCheck(
    adapter: MotionprAdapter,
    timeout: number,
  ): Promise<AdapterCheckResult> {
    const hasTracks = typeof adapter.collectScroll === "function";
    const hasStates = typeof adapter.scrollStates === "function";
    if (!hasTracks && !hasStates)
      return result("scroll", "skip", "The adapter observes no scroll motion.");
    const details: string[] = [];
    let failed = false;
    const doc = win.document;
    const scroller = doc.scrollingElement ?? doc.documentElement;
    const limit = scroller.scrollHeight - win.innerHeight;
    let drove = false;
    if (typeof adapter.scrollTo === "function" && hasTracks && limit > 20) {
      const target = Math.min(300, Math.round(limit));
      const handled = attempt(() => adapter.scrollTo!(target, { immediate: false }));
      if (!handled.ok) {
        failed = true;
        details.push(`scrollTo(${target}) threw: ${handled.error}`);
      } else if (handled.value === true) {
        drove = true;
        const until = now() + Math.min(timeout, 4000);
        let quiet = 0;
        let lastY = win.scrollY;
        while (now() < until && quiet < 10) {
          await frame();
          quiet = Math.abs(win.scrollY - lastY) < 0.5 ? quiet + 1 : 0;
          lastY = win.scrollY;
        }
      }
    }
    let moved = false;
    if (hasTracks) {
      const r = attempt(() => adapter.collectScroll!());
      if (!r.ok || !Array.isArray(r.value)) {
        failed = true;
        details.push(
          r.ok
            ? `collectScroll() returned ${describeValue(r.value)}, not an array.`
            : `collectScroll() threw: ${r.error}`,
        );
      } else {
        for (const track of r.value as unknown[]) {
          const problems = scrollTrackProblems(track);
          if (problems.some((p) => p.level !== "advice")) failed = true;
          const session =
            typeof track === "object" && track !== null
              ? String((track as { sessionId?: unknown }).sessionId)
              : "?";
          details.push(...lines(problems).map((l) => `track "${session}": ${l}`));
          const samples = (track as { samples?: unknown }).samples;
          if (Array.isArray(samples) && samples.length > 1) {
            const pos = samples.map((s) => (s as { animatedScroll?: unknown }).animatedScroll);
            if (pos.some((p) => p !== pos[0])) moved = true;
          }
        }
      }
    }
    if (hasStates) {
      const r = attempt(() => adapter.scrollStates!());
      if (!r.ok || !Array.isArray(r.value)) {
        failed = true;
        details.push(
          r.ok
            ? `scrollStates() returned ${describeValue(r.value)}, not an array.`
            : `scrollStates() threw: ${r.error}`,
        );
      } else
        for (const entry of r.value as unknown[]) {
          const e = entry as { sessionId?: unknown; axis?: unknown; state?: unknown };
          const problems: ContractProblem[] = [];
          if (typeof e?.sessionId !== "string" || !e.sessionId)
            problems.push({
              level: "invalid",
              field: "sessionId",
              message: "sessionId must be a non-empty string.",
            });
          if (e?.axis !== "vertical" && e?.axis !== "horizontal")
            problems.push({
              level: "invalid",
              field: "axis",
              message: "axis must be vertical or horizontal.",
            });
          problems.push(...scrollStateProblems(e?.state));
          if (problems.length) failed = true;
          details.push(...lines(problems).map((l) => `scrollStates(): ${l}`));
        }
    }
    if (drove) {
      attempt(() => adapter.scrollTo!(0, { immediate: true }));
      if (!moved) {
        failed = true;
        details.push(
          "scrollTo() reported that it scrolled, but collectScroll() recorded no movement.",
        );
      }
    }
    return result(
      "scroll",
      failed ? "fail" : "pass",
      failed
        ? "Scroll entries break the protocol."
        : drove
          ? "scrollTo() scrolled the page and collectScroll() recorded it."
          : "Scroll entries follow the protocol.",
      details,
    );
  }

  function claimsCheck(adapter: MotionprAdapter): AdapterCheckResult {
    if (typeof adapter.claims !== "function")
      return result("claims", "skip", "claims() is not implemented.");
    const doc = win.document;
    const el = doc.createElement("div");
    el.setAttribute("aria-hidden", "true");
    el.style.cssText =
      "position:fixed;left:-10px;top:-10px;width:1px;height:1px;pointer-events:none";
    doc.body?.appendChild(el);
    let outcome: AdapterCheckResult;
    try {
      const foreign = el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 1000 });
      const r = attempt(() => adapter.claims!(foreign));
      foreign.cancel();
      outcome = !r.ok
        ? result("claims", "fail", `claims() threw: ${r.error}`)
        : r.value
          ? result(
              "claims",
              "fail",
              "claims() claimed a Web Animation the engine did not create.",
              ["A claimed animation is recorded as the engine's; the browser's own would be lost."],
            )
          : result("claims", "pass", "A Web Animation the engine did not create was not claimed.");
    } finally {
      el.remove();
    }
    return outcome;
  }

  function diagnosticsCheck(adapter: MotionprAdapter): AdapterCheckResult {
    if (typeof adapter.diagnostics !== "function")
      return result("diagnostics", "skip", "diagnostics() is not implemented.");
    const r = attempt(() => adapter.diagnostics!());
    if (!r.ok) return result("diagnostics", "fail", `diagnostics() threw: ${r.error}`);
    if (!Array.isArray(r.value))
      return result(
        "diagnostics",
        "fail",
        `diagnostics() returned ${describeValue(r.value)}, not an array.`,
      );
    const entries = r.value as unknown[];
    const bad = entries.flatMap((d, i) =>
      lines(diagnosticProblems(d)).map((l) => `diagnostics()[${i}]: ${l}`),
    );
    if (bad.length)
      return result("diagnostics", "fail", "Malformed diagnostics are left out of captures.", bad);
    return result(
      "diagnostics",
      "pass",
      entries.length
        ? `${entries.length} diagnostic${entries.length === 1 ? "" : "s"}, all well formed.`
        : "No diagnostics.",
      entries.map((d) => {
        const { level, code, message } = d as { level: string; code: string; message: string };
        return `${level} ${code}: ${message}`;
      }),
    );
  }

  const api: ProbeApi = {
    adapters() {
      const registered = new Set(agent.adapters().map((a) => a.name));
      return seen.map((a) => ({ name: String(a?.name), registered: registered.has(a?.name) }));
    },
    async run(name, { timeout }) {
      const adapter = seen.find((a) => a?.name === name)!;
      const registered = agent.adapters().some((a) => a.name === name);
      const checks = staticChecks(adapter, registered);
      const subject = subjectOf(adapter);
      if (!registered) {
        for (const c of ADAPTER_CHECKS)
          if (!checks.some((x) => x.id === c.id) && c.id !== "without-agent" && c.id !== "capture")
            checks.push(result(c.id, "skip", "Not registered."));
        return { subject, checks };
      }
      const observed = await observe(adapter, timeout);
      checks.push(...observed.checks);
      const latest = attempt(() => adapter.collect());
      const animations =
        latest.ok && Array.isArray(latest.value)
          ? ((latest.value as unknown[]).filter(
              (e) => !animationProblems(e).some((p) => p.level === "invalid"),
            ) as AdapterAnimation[])
          : observed.animations;
      checks.push(...(await replayChecks(adapter, animations)));
      checks.push(seekProgressCheck(adapter, animations));
      checks.push(windowCheck(adapter, animations));
      checks.push(await scrollCheck(adapter, timeout));
      checks.push(claimsCheck(adapter));
      checks.push(diagnosticsCheck(adapter));
      return { subject, checks };
    },
  };
  Object.defineProperty(win, PROBE_GLOBAL, {
    value: api,
    configurable: false,
    enumerable: false,
    writable: false,
  });
}
