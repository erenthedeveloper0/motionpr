/**
 * The rules of adapter protocol 2 as code: what an adapter and the entries it reports must look
 * like. Used twice: the in-page agent leaves out entries with `invalid` problems (they would make
 * the capture unreadable) and reads missing nullable fields as null; the conformance suite
 * (`motionpr adapter check`) reports every problem. Dependency-free, because it runs in the page.
 */
import {
  SUPPORTED_PROTOCOLS,
  type AdapterCapability,
  type AnimationType,
  type MotionprAdapter,
} from "./protocol.ts";

/**
 * `invalid`: the entry cannot be recorded (the agent leaves it out). `violation`: it breaks a
 * protocol rule but is recorded. `advice`: allowed, but captures are weaker for it.
 */
export type ContractLevel = "invalid" | "violation" | "advice";

export interface ContractProblem {
  level: ContractLevel;
  /** Field path within the entry, e.g. `easing.samples` or `labels[2].time`. */
  field: string;
  message: string;
}

export const ADAPTER_CAPABILITIES: readonly AdapterCapability[] = [
  "animations",
  "timelines",
  "staggers",
  "replay",
  "scroll",
  "scroll-control",
  "waapi-claims",
];

/** The methods an adapter implements for each capability it declares. */
export const CAPABILITY_METHODS: Readonly<
  Record<AdapterCapability, readonly (keyof MotionprAdapter)[]>
> = {
  animations: ["collect"],
  timelines: ["collectTimelines"],
  staggers: [],
  replay: ["beginReplay", "seek", "endReplay"],
  scroll: ["collectScroll", "scrollStates"],
  "scroll-control": ["scrollTo"],
  "waapi-claims": ["claims"],
};

/** Optional adapter members that must be functions when present. */
export const ADAPTER_METHODS: readonly (keyof MotionprAdapter)[] = [
  "beginWindow",
  "collect",
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
];

/** Kept in step with the capture schema's `ANIMATION_TYPES` (checked by a unit test). */
export const ADAPTER_ANIMATION_TYPES: readonly AnimationType[] = [
  "css-animation",
  "css-transition",
  "web-animation",
  "gsap",
  "animejs",
  "custom",
];

const DIRECTIONS = ["normal", "reverse", "alternate", "alternate-reverse"];
const PLAY_STATES = ["idle", "running", "paused", "finished", "pending"];
const TIMELINE_KINDS = ["document", "scroll", "view", "adapter", "unknown"];
const DRIVERS = ["css", "waapi", "javascript"];
const PROVENANCE = ["declared", "observed", "inferred", "unavailable"];
const EASING_KINDS = ["css", "gsap", "animejs", "custom", "unknown"];
const SAMPLE_SOURCES = ["exact", "sampled"];
const AXES = ["vertical", "horizontal"];
const LEVELS = ["info", "warning", "error"];
/** A start time further than this from `performance.now()` is on another clock (`Date.now()`). */
const CLOCK_TOLERANCE_MS = 3_600_000;
/** CSS properties in kebab-case, custom properties, and the `attr:` / `prop:` forms. */
const PROPERTY = /^(?:--[\w-]+|-?[a-z]+(?:-[a-z0-9]+)*|attr:.+|prop:.+)$/;

/** A short, safe description of a value for problem messages. */
export function describeValue(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (typeof value === "string")
    return JSON.stringify(value.length > 40 ? `${value.slice(0, 40)}…` : value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "function") return "a function";
  if (Array.isArray(value)) return "an array";
  if (isElement(value)) return "an element";
  return "an object";
}

/** An element of this page or another realm (an iframe's elements fail `instanceof Element`). */
export function isElement(value: unknown): value is Element {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { nodeType?: unknown }).nodeType === 1 &&
    typeof (value as { getAttribute?: unknown }).getAttribute === "function"
  );
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isFinite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

class Problems {
  readonly list: ContractProblem[] = [];
  add(level: ContractLevel, field: string, message: string): void {
    this.list.push({ level, field, message });
  }
  /** `field` must be one of `values` (or absent, when `optional`). */
  oneOf(
    entry: Record<string, unknown>,
    field: string,
    values: readonly string[],
    optional: boolean,
    level: ContractLevel = "invalid",
  ): void {
    const v = entry[field];
    if (optional && v === undefined) return;
    if (typeof v !== "string" || !values.includes(v))
      this.add(
        level,
        field,
        `${field} must be one of ${values.join(", ")}; got ${describeValue(v)}.`,
      );
  }
  finite(entry: Record<string, unknown>, field: string, how: "required" | "optional"): void {
    const v = entry[field];
    if (how === "optional" && v === undefined) return;
    if (!isFinite(v))
      this.add("invalid", field, `${field} must be a finite number; got ${describeValue(v)}.`);
  }
  /** A nullable field: a finite number or null; a missing value reads as null (a violation). */
  nullableNumber(entry: Record<string, unknown>, field: string, nonNegative = false): void {
    const v = entry[field];
    if (v === undefined)
      this.add("violation", field, `${field} is required (null when unknown); read as null.`);
    else if (v !== null && !isFinite(v))
      this.add(
        "invalid",
        field,
        `${field} must be a finite number or null; got ${describeValue(v)}.`,
      );
    else if (nonNegative && isFinite(v) && v < 0)
      this.add("violation", field, `${field} must not be negative; got ${v}.`);
  }
  nullableString(entry: Record<string, unknown>, field: string, required: boolean): void {
    const v = entry[field];
    if (v === undefined) {
      if (required)
        this.add("violation", field, `${field} is required (null when absent); read as null.`);
    } else if (v !== null && typeof v !== "string")
      this.add("invalid", field, `${field} must be a string or null; got ${describeValue(v)}.`);
  }
  strings(entry: Record<string, unknown>, field: string): void {
    const v = entry[field];
    if (v === undefined) return;
    if (!Array.isArray(v) || v.some((s) => typeof s !== "string"))
      this.add("invalid", field, `${field} must be an array of strings.`);
  }
  /** `meta` / `config`: scalar values only (strings, numbers, booleans, null). */
  scalars(entry: Record<string, unknown>, field: string, required = false): void {
    const v = entry[field];
    if (v === undefined) {
      if (required) this.add("invalid", field, `${field} is required (an object of scalars).`);
      return;
    }
    if (!isObject(v)) {
      this.add("invalid", field, `${field} must be an object; got ${describeValue(v)}.`);
      return;
    }
    for (const [key, value] of Object.entries(v)) {
      if (value === null || ["string", "number", "boolean"].includes(typeof value)) continue;
      this.add(
        "invalid",
        `${field}.${key}`,
        `${field} values must be strings, numbers, booleans or null; ${key} is ${describeValue(value)}.`,
      );
    }
  }
  provenance(entry: Record<string, unknown>): void {
    const v = entry["provenance"];
    if (v === undefined) return;
    if (!isObject(v)) {
      this.add("invalid", "provenance", `provenance must be an object; got ${describeValue(v)}.`);
      return;
    }
    for (const [key, value] of Object.entries(v))
      if (typeof value !== "string" || !PROVENANCE.includes(value))
        this.add(
          "invalid",
          `provenance.${key}`,
          `provenance values must be one of ${PROVENANCE.join(", ")}; ${key} is ${describeValue(value)}.`,
        );
  }
  id(entry: Record<string, unknown>, field = "id"): void {
    const v = entry[field];
    if (typeof v === "string" && v !== "") return;
    if (isFinite(v))
      this.add("violation", field, `${field} must be a string; got the number ${v}.`);
    else
      this.add("invalid", field, `${field} must be a non-empty string; got ${describeValue(v)}.`);
  }
}

export interface AnimationContext {
  /** `performance.now()` when the entry was collected: start times far from it are rejected. */
  now?: number;
}

/** Problems with one entry of `collect()` ({@link AdapterAnimation}). */
export function animationProblems(
  entry: unknown,
  context: AnimationContext = {},
): ContractProblem[] {
  const p = new Problems();
  if (!isObject(entry)) {
    p.add("invalid", "", `An animation must be an object; got ${describeValue(entry)}.`);
    return p.list;
  }
  const a = entry;
  p.id(a);
  p.nullableString(a, "name", true);
  if (a["target"] === undefined)
    p.add("violation", "target", "target is required (null for a non-DOM target); read as null.");
  else if (a["target"] !== null && !isElement(a["target"]))
    p.add(
      "invalid",
      "target",
      `target must be an element or null; got ${describeValue(a["target"])}.`,
    );
  p.nullableNumber(a, "startTime");
  if (isFinite(a["startTime"]) && context.now !== undefined) {
    if (Math.abs(a["startTime"] - context.now) > CLOCK_TOLERANCE_MS)
      p.add(
        "violation",
        "startTime",
        `startTime must be on the performance.now() clock (now ${Math.round(context.now)}); got ${a["startTime"]}.`,
      );
  }
  p.nullableNumber(a, "duration", true);
  p.finite(a, "delay", "required");
  p.finite(a, "endDelay", "optional");
  const iterations = a["iterations"];
  if (typeof iterations !== "number" || Number.isNaN(iterations))
    p.add(
      "invalid",
      "iterations",
      `iterations must be a number (Infinity for endless); got ${describeValue(iterations)}.`,
    );
  else if (iterations < 0)
    p.add("violation", "iterations", `iterations must not be negative; got ${iterations}.`);
  if (a["activeDuration"] !== undefined) p.nullableNumber(a, "activeDuration", true);
  p.oneOf(a, "direction", DIRECTIONS, false);
  p.finite(a, "playbackRate", "required");

  const easing = a["easing"];
  if (!isObject(easing) || typeof easing["value"] !== "string") {
    p.add("invalid", "easing", "easing must be an object with a string value.");
  } else if (easing["samples"] !== undefined) {
    const samples = easing["samples"];
    if (!Array.isArray(samples) || samples.some((s) => !isFinite(s)))
      p.add("invalid", "easing.samples", "easing.samples must be an array of finite numbers.");
    else if (samples.length !== 65)
      p.add(
        "advice",
        "easing.samples",
        `easing.samples should hold 65 evenly spaced samples (0..1), like MotionPR's own; got ${samples.length}.`,
      );
  }

  const properties = a["properties"];
  if (!Array.isArray(properties) || properties.some((s) => typeof s !== "string")) {
    p.add("invalid", "properties", "properties must be an array of strings.");
  } else {
    if (properties.length === 0)
      p.add("advice", "properties", "properties is empty: no values can be sampled or compared.");
    for (const prop of properties as string[])
      if (!PROPERTY.test(prop))
        p.add(
          "violation",
          "properties",
          `properties must be CSS properties in kebab-case (or attr:<name>, prop:<name>); got ${describeValue(prop)}.`,
        );
  }

  if (typeof a["playState"] !== "string")
    p.add(
      "invalid",
      "playState",
      `playState must be a string; got ${describeValue(a["playState"])}.`,
    );
  else p.oneOf(a, "playState", PLAY_STATES, false, "violation");
  if (typeof a["samplable"] !== "boolean")
    p.add(
      "violation",
      "samplable",
      `samplable must be a boolean; got ${describeValue(a["samplable"])}.`,
    );
  if (a["group"] !== undefined) p.nullableString(a, "group", false);
  p.scalars(a, "meta");
  p.strings(a, "notes");
  p.oneOf(a, "timeline", TIMELINE_KINDS, true);
  p.oneOf(a, "type", ADAPTER_ANIMATION_TYPES, true);
  p.oneOf(a, "driver", DRIVERS, true);
  p.provenance(a);
  p.oneOf(a, "easingKind", EASING_KINDS, true);
  p.oneOf(a, "easingSamplesSource", SAMPLE_SOURCES, true);
  if (a["parent"] !== undefined && a["parent"] !== null && typeof a["parent"] !== "string")
    p.add(
      "violation",
      "parent",
      `parent must be a timeline id (a string) or null; got ${describeValue(a["parent"])}.`,
    );
  if (a["objectKey"] !== undefined && typeof a["objectKey"] !== "string")
    p.add(
      "violation",
      "objectKey",
      `objectKey must be a string; got ${describeValue(a["objectKey"])}.`,
    );

  const trace = a["progressTrace"];
  if (trace !== undefined) {
    if (
      !Array.isArray(trace) ||
      trace.some((o) => !isObject(o) || !isFinite(o["t"]) || !isFinite(o["progress"]))
    ) {
      p.add(
        "invalid",
        "progressTrace",
        "progressTrace must be an array of { t, progress } with finite numbers.",
      );
    } else {
      const points = trace as { t: number; progress: number }[];
      if (points.some((o) => o.progress < 0 || o.progress > 1))
        p.add("violation", "progressTrace", "progressTrace progress values must lie in 0..1.");
      if (points.some((o, i) => i > 0 && o.t < points[i - 1]!.t))
        p.add("violation", "progressTrace", "progressTrace must be in time order.");
    }
  }
  const range = a["scrollRange"];
  if (range !== undefined) {
    if (!isObject(range) || !isFinite(range["from"]) || !isFinite(range["to"]))
      p.add("invalid", "scrollRange", "scrollRange must be { from, to } with finite numbers.");
    else if (range["from"] > range["to"] || range["from"] < 0 || range["to"] > 1)
      p.add(
        "violation",
        "scrollRange",
        `scrollRange must satisfy 0 ≤ from ≤ to ≤ 1; got ${range["from"]}..${range["to"]}.`,
      );
  }
  const link = a["scrollLink"];
  if (link !== undefined && link !== null) {
    // The agent ignores a malformed scrollLink, so these are violations, not invalid.
    if (!isObject(link))
      p.add("violation", "scrollLink", "scrollLink must be an object or null; it was ignored.");
    else {
      for (const f of ["start", "end"])
        if (!isFinite(link[f]))
          p.add(
            "violation",
            `scrollLink.${f}`,
            `scrollLink.${f} must be a finite number; scrollLink was ignored.`,
          );
      if (!AXES.includes(link["axis"] as string))
        p.add(
          "violation",
          "scrollLink.axis",
          "scrollLink.axis must be vertical or horizontal; scrollLink was ignored.",
        );
      if (link["scroller"] !== null && !isElement(link["scroller"]))
        p.add(
          "violation",
          "scrollLink.scroller",
          "scrollLink.scroller must be an element or null; scrollLink was ignored.",
        );
      const scrub = link["scrub"];
      if (scrub !== null && !(isFinite(scrub) && scrub >= 0))
        p.add(
          "violation",
          "scrollLink.scrub",
          "scrollLink.scrub must be null or a number ≥ 0; scrollLink was ignored.",
        );
      const actions = link["toggleActions"];
      if (actions !== undefined && actions !== null && typeof actions !== "string")
        p.add(
          "violation",
          "scrollLink.toggleActions",
          "scrollLink.toggleActions must be a string or null.",
        );
    }
  }

  if (a["target"] == null && typeof a["objectKey"] !== "string" && typeof a["name"] !== "string")
    p.add(
      "advice",
      "objectKey",
      "An animation without a DOM target needs an objectKey (or a name) to be matched across captures; it is matched by its id, with low confidence.",
    );
  return p.list;
}

/** Problems with one entry of `collectTimelines()` ({@link AdapterTimeline}). */
export function timelineProblems(entry: unknown): ContractProblem[] {
  const p = new Problems();
  if (!isObject(entry)) {
    p.add("invalid", "", `A timeline must be an object; got ${describeValue(entry)}.`);
    return p.list;
  }
  const t = entry;
  p.id(t);
  p.nullableString(t, "name", true);
  p.nullableNumber(t, "startTime");
  const duration = t["duration"];
  if (duration !== null && !(isFinite(duration) && duration >= 0))
    p.add(
      "violation",
      "duration",
      `duration must be a number ≥ 0 or null; got ${describeValue(duration)} (read as null).`,
    );
  const iterations = t["iterations"];
  if (typeof iterations !== "number" || Number.isNaN(iterations))
    p.add(
      "invalid",
      "iterations",
      `iterations must be a number (Infinity for endless); got ${describeValue(iterations)}.`,
    );
  p.oneOf(t, "direction", DIRECTIONS, false);
  p.finite(t, "playbackRate", "required");
  if (typeof t["playState"] !== "string")
    p.add(
      "invalid",
      "playState",
      `playState must be a string; got ${describeValue(t["playState"])}.`,
    );
  else p.oneOf(t, "playState", PLAY_STATES, false, "violation");
  p.nullableNumber(t, "progress");
  const labels = t["labels"];
  if (!Array.isArray(labels))
    p.add("invalid", "labels", "labels must be an array (empty when there are none).");
  else
    labels.forEach((label, i) => {
      if (!isObject(label) || typeof label["name"] !== "string" || !isFinite(label["time"]))
        p.add(
          "invalid",
          `labels[${i}]`,
          "each label must be { name: string, time: finite number }.",
        );
    });
  p.provenance(t);
  p.strings(t, "notes");
  p.scalars(t, "meta");
  return p.list;
}

const STATE_NUMBERS = [
  "actualScroll",
  "animatedScroll",
  "targetScroll",
  "progress",
  "velocity",
  "direction",
  "limit",
] as const;

/** Problems with a {@link ScrollState} (a scroll track's sample, or a `scrollStates()` state). */
export function scrollStateProblems(state: unknown, field = "state"): ContractProblem[] {
  const p = new Problems();
  if (!isObject(state)) {
    p.add("invalid", field, `${field} must be an object; got ${describeValue(state)}.`);
    return p.list;
  }
  for (const key of STATE_NUMBERS)
    if (!isFinite(state[key]))
      p.add(
        "invalid",
        `${field}.${key}`,
        `${key} must be a finite number; got ${describeValue(state[key])}.`,
      );
  const scrolling = state["isScrolling"];
  if (typeof scrolling !== "boolean" && typeof scrolling !== "string")
    p.add("invalid", `${field}.isScrolling`, "isScrolling must be a boolean or a string.");
  if (typeof state["isStopped"] !== "boolean")
    p.add("invalid", `${field}.isStopped`, "isStopped must be a boolean.");
  return p.list;
}

/** Problems with one entry of `collectScroll()` ({@link AdapterScrollTrack}). */
export function scrollTrackProblems(entry: unknown): ContractProblem[] {
  const p = new Problems();
  if (!isObject(entry)) {
    p.add("invalid", "", `A scroll track must be an object; got ${describeValue(entry)}.`);
    return p.list;
  }
  const t = entry;
  p.id(t, "sessionId");
  p.oneOf(t, "axis", AXES, false);
  if (t["wrapper"] === undefined)
    p.add(
      "violation",
      "wrapper",
      "wrapper is required (null for the document scroller); read as null.",
    );
  else if (t["wrapper"] !== null && !isElement(t["wrapper"]))
    p.add(
      "invalid",
      "wrapper",
      `wrapper must be an element or null; got ${describeValue(t["wrapper"])}.`,
    );
  p.scalars(t, "config", true);
  if (typeof t["prefersReducedMotion"] !== "boolean")
    p.add("invalid", "prefersReducedMotion", "prefersReducedMotion must be a boolean.");
  const samples = t["samples"];
  if (!Array.isArray(samples)) p.add("invalid", "samples", "samples must be an array.");
  else {
    let bad = 0;
    samples.forEach((s, i) => {
      const problems = [
        ...scrollStateProblems(s, `samples[${i}]`),
        ...(isObject(s) && !isFinite(s["t"])
          ? [
              {
                level: "invalid" as const,
                field: `samples[${i}].t`,
                message: "t must be a finite number (performance.now()).",
              },
            ]
          : []),
      ];
      if (problems.length && bad++ < 3) p.list.push(...problems);
    });
    if (bad > 3) p.add("invalid", "samples", `${bad - 3} more samples are malformed.`);
    const times = samples.map((s) => (isObject(s) ? s["t"] : NaN));
    if (times.every(isFinite) && times.some((v, i) => i > 0 && v < times[i - 1]!))
      p.add("violation", "samples", "samples must be in time order (oldest first).");
  }
  const events = t["events"];
  if (!(typeof events === "number" && Number.isInteger(events) && events >= 0))
    p.add("invalid", "events", `events must be a whole number ≥ 0; got ${describeValue(events)}.`);
  p.strings(t, "notes");
  p.scalars(t, "meta");
  return p.list;
}

/** Problems with one entry of `diagnostics()` ({@link AdapterDiagnostic}). */
export function diagnosticProblems(entry: unknown): ContractProblem[] {
  const p = new Problems();
  if (!isObject(entry)) {
    p.add("invalid", "", `A diagnostic must be an object; got ${describeValue(entry)}.`);
    return p.list;
  }
  p.oneOf(entry, "level", LEVELS, false);
  if (typeof entry["code"] !== "string" || entry["code"] === "")
    p.add(
      "invalid",
      "code",
      `code must be a non-empty string; got ${describeValue(entry["code"])}.`,
    );
  if (typeof entry["message"] !== "string")
    p.add(
      "invalid",
      "message",
      `message must be a string; got ${describeValue(entry["message"])}.`,
    );
  return p.list;
}

/** The protocol an adapter declares: its `protocol`, or 1 when absent. Null when unusable. */
export function declaredProtocol(adapter: { protocol?: unknown }): number | null {
  const v = adapter.protocol;
  if (v === undefined) return 1;
  return typeof v === "number" && SUPPORTED_PROTOCOLS.includes(v) ? v : null;
}

/**
 * Problems with the adapter object itself: its name, protocol, metadata, capabilities and
 * methods. `invalid` here means the agent does not register it.
 */
export function adapterProblems(adapter: unknown): ContractProblem[] {
  const p = new Problems();
  if (!isObject(adapter)) {
    p.add("invalid", "", `An adapter must be an object; got ${describeValue(adapter)}.`);
    return p.list;
  }
  const a = adapter;
  const name = a["name"];
  if (typeof name !== "string" || name.trim() === "")
    p.add("invalid", "name", `name must be a non-empty string; got ${describeValue(name)}.`);
  else {
    if (name === "native")
      p.add(
        "violation",
        "name",
        'name must not be "native": that source means browser-native motion.',
      );
    if (/\s/.test(name))
      p.add(
        "advice",
        "name",
        `name should have no spaces (it is part of record keys); got ${describeValue(name)}.`,
      );
  }
  if (typeof a["collect"] !== "function") p.add("invalid", "collect", "collect() is required.");

  const protocol = a["protocol"];
  if (protocol === undefined)
    p.add(
      "advice",
      "protocol",
      "protocol is not declared: the adapter is treated as protocol 1. Declare protocol: 2.",
    );
  else if (declaredProtocol(a) === null)
    p.add(
      "invalid",
      "protocol",
      `protocol ${describeValue(protocol)} is not supported by this MotionPR (supported: ${SUPPORTED_PROTOCOLS.join(", ")}).`,
    );

  for (const field of ["version", "supportedRange"]) {
    const v = a[field];
    if (v === undefined)
      p.add(
        "advice",
        field,
        field === "version"
          ? "version is not reported: captures cannot tell which engine version ran."
          : "supportedRange is not reported: captures cannot tell whether the engine version is tested.",
      );
    else if (typeof v !== "string" || v.trim() === "")
      p.add(
        "violation",
        field,
        `${field} must be a non-empty string; got ${describeValue(v)} (ignored).`,
      );
  }

  for (const method of ADAPTER_METHODS) {
    const v = a[method];
    if (v !== undefined && typeof v !== "function")
      p.add(
        "violation",
        method,
        `${method} must be a function when present; got ${describeValue(v)}.`,
      );
  }

  const capabilities = a["capabilities"];
  if (capabilities === undefined) {
    p.add(
      "advice",
      "capabilities",
      "capabilities are not declared: motionpr doctor and reports cannot show them.",
    );
  } else if (!Array.isArray(capabilities)) {
    p.add(
      "violation",
      "capabilities",
      `capabilities must be an array; got ${describeValue(capabilities)} (ignored).`,
    );
  } else {
    const declared = new Set<string>();
    for (const c of capabilities) {
      if (typeof c !== "string" || !ADAPTER_CAPABILITIES.includes(c as AdapterCapability)) {
        p.add(
          "violation",
          "capabilities",
          `Unknown capability ${describeValue(c)} (known: ${ADAPTER_CAPABILITIES.join(", ")}).`,
        );
        continue;
      }
      declared.add(c);
      // A missing collect() is reported above.
      const missing = CAPABILITY_METHODS[c as AdapterCapability].filter(
        (m) => m !== "collect" && typeof a[m] !== "function",
      );
      if (missing.length)
        p.add(
          "violation",
          "capabilities",
          `Capability "${c}" is declared but ${missing.map((m) => `${m}()`).join(", ")} ${missing.length === 1 ? "is" : "are"} missing.`,
        );
    }
    for (const c of ADAPTER_CAPABILITIES) {
      const methods = CAPABILITY_METHODS[c];
      if (c === "animations" || declared.has(c) || methods.length === 0) continue;
      if (methods.every((m) => typeof a[m] === "function"))
        p.add(
          "advice",
          "capabilities",
          `${methods.map((m) => `${m}()`).join(", ")} ${methods.length === 1 ? "is" : "are"} implemented but capability "${c}" is not declared.`,
        );
    }
  }
  return p.list;
}

/** The problems' messages in one line (each message names its field). */
export function formatProblems(problems: readonly ContractProblem[]): string {
  return problems.map((p) => p.message).join(" ");
}

/** Outcome of one conformance check. `warn` and `skip` do not fail the suite. */
export type AdapterCheckStatus = "pass" | "warn" | "fail" | "skip";

/**
 * The conformance suite's checks (`motionpr adapter check`), in report order. Ids are stable:
 * scripts may rely on them.
 */
export const ADAPTER_CHECKS = [
  { id: "registration", title: "Registers with the agent" },
  { id: "protocol", title: "Declares adapter protocol 2" },
  { id: "metadata", title: "Reports its engine version and tested range" },
  { id: "capabilities", title: "Declares what it implements" },
  { id: "motion", title: "Reports the page's animations" },
  { id: "animations", title: "Animation entries follow the protocol" },
  { id: "collect-stable", title: "collect() has no side effects" },
  { id: "timelines", title: "Timeline entries follow the protocol" },
  { id: "settling", title: "isAnimating() follows finite animations" },
  { id: "replay-renders", title: "seek() renders the requested time" },
  { id: "replay-deterministic", title: "seek() renders one time the same way twice" },
  { id: "replay-holds", title: "Replay holds still between seeks" },
  { id: "replay-restores", title: "endReplay() restores the page" },
  { id: "replay-callbacks", title: "Replay fires no application callbacks" },
  { id: "seek-progress", title: "seekProgress() renders scroll-linked animations" },
  { id: "window", title: "beginWindow() forgets finished animations" },
  { id: "scroll", title: "Scroll tracks and states follow the protocol" },
  { id: "claims", title: "claims() claims only the engine's own animations" },
  { id: "diagnostics", title: "Diagnostics follow the protocol" },
  { id: "without-agent", title: "Inert when MotionPR is not capturing" },
  { id: "capture", title: "A real capture records it cleanly" },
] as const;

export type AdapterCheckId = (typeof ADAPTER_CHECKS)[number]["id"];

export interface AdapterCheckResult {
  id: AdapterCheckId;
  title: string;
  status: AdapterCheckStatus;
  /** One sentence: what was found. */
  summary: string;
  /** Each problem or observation, one per line. */
  details: string[];
}

/** The adapter a conformance run checked, as it describes itself. */
export interface AdapterCheckSubject {
  name: string;
  /** Declared protocol (1 when none is declared; null when unsupported). */
  protocol: number | null;
  version: string | null;
  supportedRange: string | null;
  capabilities: string[];
}

/** Global the page calls from its engine's callbacks during `motionpr adapter check`. */
export const CHECK_HOOK_GLOBAL = "__MOTIONPR_CHECK__";
