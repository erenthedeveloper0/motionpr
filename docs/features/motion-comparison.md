---
title: Motion comparison
description: What MotionPR compares between baseline and candidate, record by record, and how each difference is measured.
---

# Motion comparison

`motionpr compare` (and the comparison step of `motionpr run`) pairs scenarios by id and
viewport, checkpoints by label, and records by identity, then compares each pair. Every
difference it finds is a **change** with `before`, `after`, a `delta` and `unit` where both sides
are numbers, a **measurement** label, a **severity** and the **rule** that produced it.

<!-- motionpr:diff-viewer -->

The list above is the real result of comparing the demo app's two variants: 55 differences
across 11 scenarios (1 critical, 35 warnings, 18 info, 1 uncertain).

## Animations

| Change                               | Compared from                                               | Rule                                       |
| ------------------------------------ | ----------------------------------------------------------- | ------------------------------------------ |
| Duration, delay, end delay           | Declared timing                                             | `duration`, `delay`, `end-delay`           |
| Start offset after the trigger       | `startTime`, frame-quantized                                | `start` (at most a warning)                |
| Easing                               | 65-sample curves ([Easing analysis](easing-analysis.md))    | `easing`                                   |
| Iterations, direction, playback rate | Declared timing                                             | `iterations`, `direction`, `playback-rate` |
| Fill mode                            | Declared timing                                             | `fill`                                     |
| Properties added or removed          | The animated property set                                   | `property-added`, `property-removed`       |
| Keyframe values                      | Declared start and end values of non-transform properties   | `keyframes`                                |
| Trajectory                           | Sampled translate and rotate: start, end and path deviation | `trajectory`                               |
| Opacity, scale, size                 | Sampled opacity, scale and layout box                       | `opacity`, `size`                          |
| Animation added or removed           | Records without a partner                                   | `animation-added`, `animation-removed`     |

Relative timing changes are measured against the baseline duration for durations, and against
the animation's duration for delays and start offsets. Path comparisons use the sampled values at
the same progress; when the two captures used different `capture.samples`, only the endpoints are
compared and the comparison says so (`SAMPLE_COUNT_DIFFERS`).

## Stagger

Siblings that animate the same way form a **stagger family**: the same type, name and properties,
and element keys that differ only by a trailing number (`test-id:work-card-1`, `-2`, …), or one
GSAP/Anime.js tween with several targets. Inside shadow roots, the same element of numbered
components (`test-id:plan-1 >> motionpr-id:glow`, `plan-2`, …) is one family (since
`0.5.0-alpha`; [Shadow DOM](../integrations/shadow-dom.md#staggers)). MotionPR measures the
median interval between their start times and compares it.

<!-- motionpr:stagger dataset="work-grid/revealed" -->

The demo's work grid goes from 70 ms to 120 ms between cards. MotionPR reports one stagger
difference (_Stagger interval 70ms → 120ms across 6 elements_, a warning) next to the per-card
delay changes it explains.

## Timelines, scroll and pixels

- **Timelines** ([GSAP](../integrations/gsap.md), [Anime.js](../integrations/animejs.md)):
  duration, repeat, speed, labels that moved, appeared or disappeared, reordered labels.
- **Scroll** ([Lenis](../integrations/lenis.md)): start, end and target position, settle
  duration, the normalized progress curve, peak velocity, overshoot, direction changes,
  smooth-scroll lag and engine options, for the document, each Lenis instance and (since
  `0.4.0-alpha`) each scroll container. When a native scroll's positions reached the page
  unevenly (Firefox animates smooth scrolling off the main thread), its curve and peak velocity
  are only known to about a frame, and their differences are `uncertain`. Scroll-linked GSAP
  animations are compared by where they run in the scroll and by the values they write at the
  same scroll progress ([GSAP: ScrollTrigger](../integrations/gsap.md#scrolltrigger)). Where they
  run is the `start`/`end` ScrollTrigger resolved (since `0.4.0-alpha`), or their
  progress at the same scroll position for captures without those positions.
- **Pixels** ([Visual comparison](visual-comparison.md)): the settled screenshot of each
  checkpoint, and per-frame divergence of the filmstrips.

## Structure

Scenarios and checkpoints that appear or disappear are differences too (`scenario-added`,
`scenario-removed`, `checkpoint-added`, `checkpoint-removed`), and a scenario that failed in the
candidate is critical (`scenario-failed`). The latency between the trigger and the first motion is
compared within `timing.startToleranceMs`, when both captures name the same trigger (step and
kind).

## Measurement labels

| Label         | Meaning                                                                     |
| ------------- | --------------------------------------------------------------------------- |
| `measured`    | Read directly from both captures (declared timing, sampled computed styles) |
| `estimated`   | Derived with a tolerance; start times and latency are frame-quantized       |
| `incomplete`  | At least one side has partial capture data                                  |
| `unsupported` | The comparison cannot be made for this animation type                       |

## Environment checks

The comparison warns when the two captures are not like for like: `BROWSER_VERSION_DIFFERS`,
`PLATFORM_DIFFERS` (fonts render differently across operating systems) and `CONFIG_DIFFERS`.
These never change a severity; they explain one.

Severities and how to change them: [Severity](severity.md). The JSON format of the result:
[Capture serialization](../advanced/capture-serialization.md#comparison-result).
