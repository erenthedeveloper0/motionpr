---
title: Anime.js integration
description: Capture Anime.js v4 animations, timelines and staggers with @erenthedeveloper0/motionpr/animejs.
---

# Anime.js integration

Anime.js renders JavaScript animations from its own engine loop, so browsers cannot see them
through `document.getAnimations()`, and the per-target timing of a staggered animation lives in
private objects. MotionPR therefore instruments Anime.js **explicitly, when animations are
created**, using public APIs only.

**Status:** supported. Tested against Anime.js **4.5.0**; versions outside `>=4.0.0 <5.0.0` are
reported as _untested_. Anime.js v3 (`anime({ targets, … })`) is **not** supported. The
adapter's browser tests (timelines, staggers, custom eases, WAAPI animations recorded once) pass in
Chromium, Firefox and WebKit.

|         |                                                                                                                                                                                                        |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Install | `npm install -D @erenthedeveloper0/motionpr` and `npm install animejs` (optional peer dependency)                                                                                                      |
| Import  | `import { createAnimeInstrumentation } from "@erenthedeveloper0/motionpr/animejs"` (browser code, no dependencies, does not bundle Anime.js)                                                           |
| Config  | `adapters: [{ name: "animejs", required: true }]`                                                                                                                                                      |
| Records | JavaScript animations: `type: "animejs"`, `source: "animejs"`, `driver: "javascript"`. `waapi.animate()`: `type: "web-animation"`, `source: "animejs"`, `driver: "waapi"`. Timelines: `TimelineRecord` |

<!-- motionpr:engine-demo engine="animejs" -->

## Setup

Create the instrumentation once, before any animation, and use the wrapped functions in place
of the originals. A small module that re-exports them keeps the rest of the app unchanged:

```ts
// src/motion.ts
import { animate, createTimeline, waapi, eases, engine, stagger } from "animejs";
import { createAnimeInstrumentation } from "@erenthedeveloper0/motionpr/animejs";

const motion = createAnimeInstrumentation({ eases, engine });

export const track = motion.wrapAnimate(animate);
export const timeline = motion.wrapTimeline(createTimeline);
export const waapiAnimate = motion.wrapWaapi(waapi.animate);
export { motion, stagger };
```

```ts
// anywhere in the app
import { stagger, timeline, track } from "./motion";

track(".card", {
  translateY: [30, 0],
  opacity: [0, 1],
  duration: 700,
  delay: stagger(60),
  ease: "out(3)",
});

const intro = timeline({ defaults: { duration: 400, ease: "outQuad" } });
intro
  .label("title")
  .add(".title", { opacity: [0, 1] })
  .label("cards")
  .add(".card", { scale: [0.9, 1] }, "-=200");
motion.track(intro, "intro"); // a stable name for reports
```

Then capture as usual (`npx motionpr run`). `motionpr doctor` checks that Anime.js is installed,
that its version is in the tested range and that the adapter actually registers in your page.

### Options

| Option   | Effect                                                                                                                                                                                                                                                         |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `eases`  | Anime.js's `eases` export. Named eases (`"out(3)"`, `"inOutQuad"`, `"outElastic(1, .5)"`) are evaluated with Anime.js's own functions. Without it MotionPR uses a port of the v4 ease parser that the test suite checks sample-for-sample against Anime.js 4.5 |
| `engine` | Anime.js's `engine` export: exact defaults (`engine.defaults`) and the global `engine.speed`. Without it MotionPR uses Anime.js's built-in defaults and marks values taken from them as `inferred`                                                             |
| `force`  | Instrument even without a MotionPR agent (tests, debugging)                                                                                                                                                                                                    |

### Is it safe in production?

Yes. Without a capturing MotionPR agent in the page, `createAnimeInstrumentation()` returns an
inactive handle whose `wrap*` methods return **the original functions** (same identity) and
nothing is patched. The module adds about 13 kB gzipped to a bundle; import it only in builds you
capture if that matters.

## API

| Export                                                                                                                                                                                                                                                      | Description                                                                              |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `createAnimeInstrumentation(options?)`                                                                                                                                                                                                                      | Returns an `AnimeInstrumentation` handle (also the default export)                       |
| `handle.wrapAnimate(animate)`                                                                                                                                                                                                                               | Drop-in `animate` replacement that MotionPR observes                                     |
| `handle.wrapTimeline(createTimeline)`                                                                                                                                                                                                                       | Drop-in `createTimeline` replacement; also observes `timeline.add()` children            |
| `handle.wrapWaapi(waapi.animate)`                                                                                                                                                                                                                           | Drop-in `waapi.animate` replacement; marks the native animations it creates              |
| `handle.track(instance, name?)`                                                                                                                                                                                                                             | Observes an instance created without a wrapper and/or gives it a stable name             |
| `handle.getDiagnostics()`                                                                                                                                                                                                                                   | Health messages (observation errors, unknown version, unsupported features)              |
| `handle.dispose()`                                                                                                                                                                                                                                          | Restores everything this handle patched and unregisters when the last handle is disposed |
| `handle.active`                                                                                                                                                                                                                                             | `true` while instrumenting a capturing page                                              |
| `resolveEaseName(name, eases?)`                                                                                                                                                                                                                             | Resolves an Anime.js ease name to a function (null for unknown names)                    |
| `sampleEase(fn)`                                                                                                                                                                                                                                            | Samples an easing function at 65 points (null if it throws or returns non-numbers)       |
| `SUPPORTED_ANIMEJS_RANGE`                                                                                                                                                                                                                                   | The tested version range                                                                 |
| `AnimeInstrumentation`, `AnimeInstrumentationOptions`, `AnimeAnimationLike`, `AnimeTimelineLike`, `AnimeTickableLike`, `AnimeWaapiAnimationLike`, `AnimeEngineLike`, `AnimateLike`, `CreateTimelineLike`, `WaapiAnimateLike`, `EasesLike`, `EasingFunction` | Structural types of the parts of Anime.js the adapter uses                               |

<!-- motionpr:timeline dataset="anime-process/played" -->

The demo app's process timeline above is recorded through `wrapTimeline`: in the candidate the
"design" step moves from `-=120` to `+=120` and the bar grows from 700 to 900 ms. MotionPR reports
the moved label, the later starts and the longer timeline.

## How it observes Anime.js

- **Parameters pass through unchanged**, except that function-valued `delay`, `duration` and
  `ease` (such as `stagger(60)`) are wrapped with transparent recorders. Anime.js calls them
  exactly as before, with the same arguments, and receives exactly the same values; MotionPR
  learns what each target received. This is how staggered targets get their own records.
- **`onUpdate` is composed, never replaced.** MotionPR's observer runs, then your callback runs
  with the same `this`, arguments and return value. Assigning `animation.onUpdate = fn` later
  still works. Errors in MotionPR's observer are caught and reported as diagnostics; they never
  reach your animation. For timeline children, a missing `onUpdate` falls back to the timeline's
  `defaults.onUpdate`, as Anime.js does.
- **Start times are observed**: each frame callback pairs `performance.now()` with the
  instance's public `currentTime`. Speed is taken from the public `speed` of the instance and
  its parents (times `engine.speed` when provided) and checked against the observations.
- **Replay** renders root animations and timelines with `seek(time, true)` (callbacks muted),
  pausing them by assigning `paused = true` (so `onPause` does not fire), and afterwards restores
  `currentTime`, `paused`, `began`, `completed` and the cancelled state. `onBegin`, `onUpdate`,
  `onComplete` and `then()` do not fire during replay.
- **WAAPI animations** created with `waapi.animate()` are real Web Animations. MotionPR's native
  collector records them (with exact keyframes and timing, replayed through clones) and labels
  them `source: animejs`, `driver: waapi`. They are recorded once: never both as native and as
  Anime.js.

## What is captured

Per target (and per group of properties sharing delay, duration and ease):

| Field                                                                 | Provenance                                                                                                                                                                                                             |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Duration, delay, ease                                                 | `declared` from parameters; `observed` for function values (stagger); `inferred` from built-in defaults when `engine` is not passed                                                                                    |
| Iterations (`loop`), direction (`reversed`, `alternate`), `loopDelay` | `declared`                                                                                                                                                                                                             |
| Playback rate                                                         | `observed` (checked against `speed`)                                                                                                                                                                                   |
| Start time                                                            | `observed` from frame callbacks                                                                                                                                                                                        |
| Easing curve                                                          | `exact` samples for named eases (and springs, untested), `sampled` for custom functions (`value: "custom"`, no invented name)                                                                                          |
| Timeline, labels                                                      | `TimelineRecord` with labels from the public `labels` property                                                                                                                                                         |
| Targets                                                               | DOM elements (CSS properties, transforms, SVG attributes as `attr:<name>`, DOM properties as `prop:<name>`); JavaScript objects as timing-only records keyed `adapter:animejs:<name or "object">:<properties>#<index>` |

Every record carries `provenance` so reports show which values Anime.js declared, which MotionPR
observed, and which it had to infer.

## Supported patterns

- `animate()` on selectors, elements, NodeLists, arrays and plain objects.
- Function-based values and `stagger()` for `delay`, `duration` and `ease`, at the top level or
  per property (`{ to, delay, duration, ease }`). Tested with linear staggers; other `stagger()`
  options (`from`, `grid`, seeded `jitter`) produce function values that are recorded the same
  way but are not covered by tests yet.
- Timelines with labels, relative positions (`"-=200"`, `"<"`, labels), `defaults`, and stagger
  positions (`tl.add(targets, params, stagger(100))`, one record per target).
- `reversed`, `playbackRate` (tested); `alternate`, `loop`, `loopDelay` and springs
  (`createSpring()`) are read from public values but not yet covered by browser tests.
- Pause/resume, `seek`, `restart`, `reverse()` during the window (the latest continuous segment
  of observations is used).
- `waapi.animate()`.
- Targets inside the shadow roots of web components, passed as elements (a selector string is
  looked up in the document): identified through their host
  ([Shadow DOM](shadow-dom.md#identity); since `0.5.0-alpha`).

## Limitations

- **Instances created without a wrapper** (or before the instrumentation) can be observed with
  `track()`, but their properties and per-target timing are not public in Anime.js: they are
  recorded as timing-only with `provenance: unavailable`.
- **`keyframes` and per-property keyframe arrays** are recorded with the animation's overall
  timing; per-keyframe timing is not reconstructed.
- **`composition: "blend"`** is rendered by Anime.js's engine loop and cannot be replayed:
  such animations are recorded as metadata only.
- **Timeline `playbackEase`**: child start times assume linear timeline time (a note is added).
- **Unseeded random staggers** (`stagger(…, { from: "random" })` without `seed`) can give
  different values per property; the first value is recorded and a diagnostic explains why.
- `createTimer()`, `createAnimatable()`, `createDraggable()`, `onScroll()` and the layout/text
  utilities are not instrumented.
- After replay, Anime.js's `resume()` advances a still-running animation by up to 12 ms (its own
  "at least one frame" behavior). Finished animations are unaffected.

## Cleanup

`dispose()` restores each `onUpdate` property it composed (to a plain writable property holding
your current callback) and each wrapped `timeline.add`, and forgets the instances it observed.
Several handles share one adapter; it unregisters from MotionPR when the last handle is disposed.
Wrapped functions keep working after `dispose()` and simply call the originals.

## Troubleshooting

| Symptom                                                       | Fix                                                                                                                                                                                   |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ADAPTER_MISSING` for `animejs`                               | The page never called `createAnimeInstrumentation()`, or it ran before MotionPR's agent (it cannot: the agent is installed first). Check that the code path runs in the captured page |
| Animations missing from a checkpoint                          | They were created with the original `animate`, not the wrapped one. Import from your `motion` module, or call `motion.track(instance)`                                                |
| `Start time unknown: no frame of this animation was observed` | The animation never rendered a frame inside the window (e.g. created paused). It is recorded as metadata only                                                                         |
| Ease shows `unknown`                                          | The ease name is not an Anime.js v4 name (v3 names such as `easeOutQuad` were renamed to `outQuad`)                                                                                   |
| Doctor: outside the tested range                              | MotionPR still runs; please report problems with the Anime.js version                                                                                                                 |
