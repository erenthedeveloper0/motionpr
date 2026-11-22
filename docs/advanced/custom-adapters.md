---
title: Custom adapters
description: Teach MotionPR about another animation engine with adapter protocol 2, and check the adapter with the conformance suite.
---

# Custom adapters

MotionPR sees CSS animations, CSS transitions and Web Animations natively, and GSAP, Anime.js and
Lenis through its first-party adapters. For any other engine (a custom tween library, a canvas
renderer) you can write an adapter. The first-party adapters in `packages/adapters/` are the
reference implementations: `gsap` for replayable tweens and timelines, `animejs` for
instrumenting an engine at creation time, `lenis` for scroll motion.

## Protocol 2

Adapters implement **adapter protocol 2** (`PROTOCOL_VERSION = 2`, since `0.5.0-alpha`). Declare
it with `protocol: 2`.

- **Frozen until 1.0.** Protocol 2 changes only by optional additions whose absence keeps today's
  behaviour. A change that would break a protocol 2 adapter gets a new protocol number, and the
  agent keeps accepting protocol 2.
- **Protocol 1 keeps working.** Adapters written for `0.1.0-alpha` to `0.4.0-alpha` declare no
  protocol; they have the same members and are treated as protocol 1 (`SUPPORTED_PROTOCOLS` is
  `[1, 2]`). Declare `protocol: 2` once [`motionpr adapter check`](../cli/adapter.md) passes.
- **Unknown protocols are refused.** An adapter that declares a protocol this MotionPR does not
  support (a newer one) is not registered: the capture's adapter table marks it `failed` and the
  scenario gets an `ADAPTER_PROTOCOL_UNSUPPORTED` error instead of `ADAPTER_MISSING`.
- **What an adapter reports is checked.** An animation, timeline or scroll track whose fields do
  not have the documented types is left out of the capture with an `ADAPTER_RECORD_INVALID`
  warning that names the field; the rest of the adapter's entries are kept. Before `0.5.0-alpha`,
  one such entry made the whole capture fail validation. Missing nullable fields (`name`,
  `target`, `startTime`, `duration`; a timeline's `name`, `startTime`, `progress`; a scroll
  track's `wrapper`) read as `null`. Malformed `diagnostics()` entries are left out with
  `ADAPTER_DIAGNOSTICS_INVALID`.

## Interface

An adapter is an object that implements `MotionprAdapter` and registers itself with the in-page
agent:

```ts
import type { MotionprAdapter, AdapterAnimation } from "@erenthedeveloper0/motionpr";

const adapter: MotionprAdapter = {
  name: "my-engine",
  protocol: 2,
  version: myEngine.version, // the engine version in this page
  supportedRange: ">=2.0.0 <3.0.0", // the versions you test against
  capabilities: ["animations", "replay"],
  beginWindow() {
    /* a checkpoint just finished: forget animations that already ended */
  },
  collect(): AdapterAnimation[] {
    return runningAnimations.map((a) => ({
      id: a.id,
      name: a.label ?? null,
      target: a.element, // one entry per animated element
      startTime: a.startedAt, // performance.now() of local time zero (before delay)
      duration: a.duration, // ms per iteration
      delay: a.delay,
      iterations: a.repeat ?? 1, // Infinity for endless
      direction: "normal",
      playbackRate: 1,
      easing: { value: a.easeName, samples: sampleEase(a.ease) }, // 65 samples of 0..1
      properties: ["transform", "opacity"],
      playState: a.done ? "finished" : "running",
      samplable: true, // true if seek() can render it
    }));
  },
  isAnimating: () => runningAnimations.some((a) => !a.done && Number.isFinite(a.repeat ?? 1)),
  beginReplay() {
    /* pause everything and remember state */
  },
  seek(timeMs) {
    /* synchronously render every collected animation at performance-clock time timeMs */
  },
  endReplay() {
    /* restore the state saved in beginReplay */
  },
};

window.__MOTIONPR_AGENT__?.registerAdapter(adapter);
```

### Members

| Member                                            | Purpose                                                                                          |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `name`, `collect()`                               | Required. `name` is part of record keys (`adapter:<name>:…`); not `native`                       |
| `protocol`                                        | The protocol the adapter implements: `2` (since `0.5.0-alpha`; absent means 1)                   |
| `version`, `supportedRange`                       | Engine version and the range you test against (shown in captures and `doctor`)                   |
| `capabilities`                                    | What the adapter implements, below                                                               |
| `beginWindow()`                                   | A checkpoint finished: forget animations that already ended                                      |
| `isAnimating()`                                   | `true` while a tracked **finite** animation plays (used for settling); endless ones do not count |
| `beginReplay()`, `seek(t)`, `endReplay()`         | Deterministic replay; without them records are metadata only                                     |
| `seekProgress(id, progress)`                      | Scroll-linked animations (since `0.3.0-alpha`), see below                                        |
| `collectTimelines()`                              | `TimelineRecord`s: duration, labels, children                                                    |
| `collectScroll()`, `scrollStates()`, `scrollTo()` | Scroll motion, settle detection, and the `scrollTo` step                                         |
| `claims(animation)`                               | Mark native `Animation` objects your engine created, so they are recorded once (`AdapterClaim`)  |
| `diagnostics()`                                   | Health messages shown in captures and reports (`AdapterDiagnostic`)                              |

The agent also has `unregisterAdapter(adapter)`; call it from your own `dispose()`. Its
`protocol` property is the newest protocol it supports.

### Capabilities

| Capability       | Methods                                  |
| ---------------- | ---------------------------------------- |
| `animations`     | `collect()` (required of every adapter)  |
| `timelines`      | `collectTimelines()`                     |
| `staggers`       | none: entries share a `group`            |
| `replay`         | `beginReplay()`, `seek()`, `endReplay()` |
| `scroll`         | `collectScroll()`, `scrollStates()`      |
| `scroll-control` | `scrollTo()`                             |
| `waapi-claims`   | `claims()`                               |

### Animation entries

| Field                                                                           | Type and rule                                                                                 |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `id`                                                                            | Non-empty string, unique within one `collect()` (a repeated id is left out)                   |
| `name`                                                                          | String or `null`                                                                              |
| `target`                                                                        | The animated element, or `null` for a non-DOM target (then give an `objectKey`)               |
| `startTime`                                                                     | Local time zero on the `performance.now()` clock, or `null` (scroll-linked)                   |
| `duration`, `delay`, `endDelay`                                                 | Milliseconds; `duration` ≥ 0 or `null`; `delay` finite                                        |
| `iterations`                                                                    | Number ≥ 0; `Infinity` for endless                                                            |
| `activeDuration`                                                                | When it differs from `duration × iterations` (e.g. a repeat delay)                            |
| `direction`                                                                     | `normal`, `reverse`, `alternate` or `alternate-reverse`                                       |
| `playbackRate`                                                                  | Finite number                                                                                 |
| `easing`                                                                        | `{ value, samples? }`: `samples` are 65 evenly spaced outputs of the easing, finite numbers   |
| `properties`                                                                    | CSS properties in kebab-case, `--custom` properties, `attr:<name>` (SVG) or `prop:<name>`     |
| `playState`                                                                     | `idle`, `running`, `paused`, `finished` or `pending`                                          |
| `samplable`                                                                     | `true` when `seek()` (or `seekProgress()`) can render it                                      |
| `group`, `parent`, `objectKey`                                                  | Strings: shared by one stagger; a timeline id from `collectTimelines()`; a stable non-DOM key |
| `meta`                                                                          | Strings, numbers, booleans or `null`                                                          |
| `notes`                                                                         | Strings: what could not be observed (the record is then _partial_)                            |
| `timeline`, `type`, `driver`, `provenance`, `easingKind`, `easingSamplesSource` | The values the `AdapterAnimation` type lists                                                  |
| `progressTrace`, `scrollRange`, `scrollLink`                                    | Scroll-linked animations, below                                                               |

### Scroll-linked animations

An animation whose progress follows scroll has no start time: report `startTime: null`,
`timeline: "scroll"` and its live progress as `progressTrace` (`{ t, progress }` on the
`performance.now()` clock, one entry per change). To have its values sampled (since
`0.3.0-alpha`), also report `scrollRange: { from, to }`, the part of that progress (0..1) during
which this animation is active, keep `samplable: true`, and implement
`seekProgress(id, progress)`: render animation `id` at that progress, synchronously and without
callbacks. The agent calls it between `beginReplay()` and `endReplay()`, after `seek()`, at evenly
spaced progress values between the lowest and highest progress in the trace. In `seek(t)`, render
it at the progress it showed at time `t`.

If your engine resolves where in the scroll the animation runs, report it as `scrollLink`
(since `0.4.0-alpha`; type `AdapterScrollLink`):

```ts
scrollLink: {
  start: 400, // scroll position (CSS px) where progress is 0
  end: 1300, // … where progress is 1
  axis: "vertical",
  scroller: null, // the scroll container element; null for the document
  scrub: 0, // 0: follows the scroll; ms of smoothing; null: plays once triggered
  toggleActions: null, // with scrub: null, e.g. "play none none reverse"
},
```

Comparisons then report a moved start or end, and changed `scrub` or `toggleActions`, from these
values instead of relating `progressTrace` to the recorded scroll, which depends on how each
run's scroll was scheduled. Without it, progress at the same scroll position is compared. A
malformed `scrollLink` is ignored (the record is kept).

## Rules that keep captures trustworthy

- Report times on the `performance.now()` clock.
- `collect()` reports what was observed since the window opened, without consuming it: two calls
  in a row return the same entries.
- `isAnimating()` counts finite animations only; captures wait for it before every checkpoint.
- `seek()` must render **synchronously**, must not fire your engine's callbacks, and what it
  rendered must hold until the next `seek()`: captures take screenshots between seeks, so frames
  pass during replay.
- `endReplay()` must restore exactly what `beginReplay()` changed.
- If something cannot be observed precisely, add a sentence to `notes`; the record is then marked
  _partial_ in reports instead of looking complete.
- Do nothing when `window.__MOTIONPR_AGENT__` is absent (production), and never throw into
  application code.

## Checking an adapter

The conformance suite checks every rule above in a real browser:

```bash
npx motionpr adapter check ./test/motion.html --browser all
```

It needs a page that uses the adapter and starts some of the engine's animations when it loads.
See [`motionpr adapter check`](../cli/adapter.md) for the checks and options. In a test suite, call
the API and assert on the report:

```ts
import { checkAdapter } from "@erenthedeveloper0/motionpr";

const report = await checkAdapter({ page: "./test/motion.html", browserName: "firefox" });
if (!report.passed) {
  for (const check of report.checks.filter((c) => c.status === "fail"))
    console.error(check.id, check.summary, check.details);
}
```

## Loading the adapter

Either import it in your app (like `@erenthedeveloper0/motionpr/gsap`), or let MotionPR inject it before your page
scripts:

```ts
adapters: [{ name: "my-engine", script: "./motion/my-engine-adapter.js", required: true }],
```

`required: true` emits an error diagnostic if the adapter did not register in a captured page.
