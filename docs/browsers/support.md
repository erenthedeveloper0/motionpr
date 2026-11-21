---
title: Browser support
description: Chromium, Firefox and WebKit — the versions MotionPR is tested with, what works in each engine, how engines differ, and why every engine has its own baseline.
---

# Browser support

MotionPR captures with Playwright's builds of the three browser engines. Each engine is a
first-class target: it has its own baseline, captures, comparison and report.

| Engine   | Build tested                                 | Install                         | Config / CLI         |
| -------- | -------------------------------------------- | ------------------------------- | -------------------- |
| Chromium | Chrome for Testing 158.0.8127.18 (Blink)     | `npx motionpr install chromium` | `--browser chromium` |
| Firefox  | Firefox 159.0 (Gecko), Playwright build 1572 | `npx motionpr install firefox`  | `--browser firefox`  |
| WebKit   | WebKit 27.2, Playwright build 2388           | `npx motionpr install webkit`   | `--browser webkit`   |

These are the builds that match MotionPR's bundled Playwright (1.65). `npx motionpr install`
downloads exactly these versions; other versions of an engine are not covered by MotionPR's
tests. Captures record the version the browser reports at runtime, never one taken from the
configuration.

Chromium is the default (`browser.name`). Pick another engine in the config, per run with
`--browser`, or for every command with `MOTIONPR_BROWSER`:

```bash
npx motionpr install firefox webkit
npx motionpr run --browser firefox
npx motionpr run --browser all          # Chromium, Firefox, then WebKit
```

## What works in each engine

Everything below is covered by automated tests that run in each engine against a real browser
(CI runs the browser suites once per engine).

| Area                                                         | Chromium | Firefox  | WebKit   |
| ------------------------------------------------------------ | -------- | -------- | -------- |
| CSS transitions (multiple properties, interrupted, reversed) | Verified | Verified | Verified |
| CSS animations (iterations, direction, fill, keyframes)      | Verified | Verified | Verified |
| Web Animations (reversed, cancelled, finished, delayed)      | Verified | Verified | Verified |
| Deterministic replay (identical frames on repeated runs)     | Verified | Verified | Verified |
| GSAP adapter (tweens, timelines, labels, staggers, reverse)  | Verified | Verified | Verified |
| GSAP ScrollTrigger (metadata and live progress)              | Verified | Verified | Verified |
| GSAP ScrollTrigger values                                    | Verified | Verified | Verified |
| GSAP ScrollTrigger positions                                 | Verified | Verified | Verified |
| Anime.js v4 adapter (timelines, staggers, WAAPI, eases)      | Verified | Verified | Verified |
| Lenis adapter (scroll motion, velocity, reduced motion)      | Verified | Verified | Verified |
| Native scroll containers                                     | Verified | Verified | Verified |
| Motion inside shadow roots (unreleased)                      | Verified | Verified | Verified |
| GSAP with Lenis in one page                                  | Verified | Verified | Verified |
| The demo app's 11 intended changes found, nothing else       | Verified | Verified | Verified |
| CLI: capture, compare, run, baseline, report, doctor         | Verified | Verified | Verified |
| CSS scroll-driven animations                                 | Metadata | Metadata | Metadata |

The test counts per engine are in the [support matrix](../advanced/support-matrix.md).

## Every engine has its own baseline

Engines lay out text, round geometry, rasterize pixels and schedule frames differently. A
Firefox capture compared with a Chromium baseline would report those differences as if your
code had changed. So MotionPR keeps everything per engine:

```text
.motionpr/
├── baseline/
│   ├── chromium/        capture.json + assets/  (commit these)
│   ├── firefox/
│   └── webkit/
├── captures/<browser>/  recent captures and LATEST
├── comparison/<browser>/
└── report/
    ├── index.html       one row per engine
    └── <browser>/       that engine's report
```

- A run compares each engine with **its own** baseline. A Firefox run never reads the Chromium
  baseline; when Firefox has none yet, the run says so and writes a capture-only report.
- `baseline accept --browser firefox` writes `baseline/firefox/` only. A capture can only become
  the baseline of the engine it was taken with.
- Comparing two engines is possible, but only when you ask for it:
  [cross-browser comparisons](cross-browser-testing.md#comparing-two-engines).

Baselines from MotionPR 0.1 (`baseline/capture.json`) are read as the Chromium baseline;
`npx motionpr baseline migrate` moves them into `baseline/chromium/`.

## How the engines differ

These differences were measured while adding Firefox and WebKit. MotionPR handles each one; they
are listed so that you can read captures from each engine correctly.

| Difference                          | Chromium        | Firefox          | WebKit          | How MotionPR handles it                                                                           |
| ----------------------------------- | --------------- | ---------------- | --------------- | ------------------------------------------------------------------------------------------------- |
| `performance.now()` resolution      | 0.1 ms          | 1 ms             | 1 ms            | Recorded as `timerResolutionMs`; a `COARSE_TIMERS` note explains quantized start offsets          |
| Frame rate, headless (macOS)        | 60 fps          | 60 fps           | 30 fps          | Recorded as `frameIntervalMs`; `LOW_FRAME_RATE` (info below 50 fps, warning below 20 fps)         |
| `scrollY` precision                 | whole pixels    | fractional       | whole pixels    | Scroll settles when the drift over the still period is below the threshold, not each frame's step |
| Keyframe offsets                    | as written      | single precision | as written      | Offsets rounded to 6 decimals (`0.4000000059604645` → `0.4`)                                      |
| Start time vs. input event          | ~25–45 ms later | at or before     | ~2–4 ms later   | Trigger latency is compared within one engine only                                                |
| Interrupted transition timing       | frame-quantized | frame-quantized  | frame-quantized | The reversal's shortened duration depends on when the frame lands: compare within one engine      |
| `cubic-bezier()` near the endpoints | reference       | same as Chromium | ~0.02 px apart  | Below `positionTolerancePx` (2 px)                                                                |
| Native smooth-scroll positions      | every frame     | ≤ 1 frame late   | every frame     | Curve and peak-velocity differences of unevenly delivered native scrolls are `uncertain`          |

Two problems these differences exposed were fixed for every engine: replay now seeks clones
in window-relative time rounded to 1 µs (Firefox resolved times that landed a hair below a
`steps()` boundary to the previous step), and scroll velocities are derived between samples
observed while moving, over at least 12 ms (two Lenis samples 1 ms apart on a 1 ms timer once
read as "78 px/ms", and the first frame of a 30 fps WebKit scroll was timed from a re-stamped
rest sample). The demo app's slower Lenis `lerp` now reads as a 30–36% lower peak in every
engine. Trigger latency is measured from the interaction that caused the motion, and a scroll
whose last still and first moved samples share a millisecond still starts from its rest position.

## Unsupported and untested

- **Safari, Chrome and Firefox as installed apps.** WebKit is Playwright's WebKit build, close to
  Safari but not Safari. Installed browsers can be used through `browser.channel` (Chrome, Edge,
  and Playwright's `moz-firefox` channels) or `browser.executablePath`; MotionPR's tests cover
  only Playwright's builds.
- **Other versions** of an engine than the ones above are not tested.
- **Firefox and WebKit on Windows** are not covered by CI; Chromium is. Playwright's WebKit on
  Windows is the least mature build.
- **Engines run one after another** in a multi-browser run, not in parallel.
- **Cross-browser pixel comparison** is never definite: pixel, geometry, start-offset and scroll
  differences between engines are `uncertain` by design.

Engine setup and troubleshooting: [Chromium](chromium.md), [Firefox](firefox.md),
[WebKit](webkit.md).
