---
title: Introduction
description: MotionPR records how your interface moves, compares it with an approved baseline, and shows the difference frame by frame.
---

# Introduction

**Your code changed. See how your interface moves.**

MotionPR is an animation regression testing tool. It drives your app in Chromium, Firefox or
WebKit, records every
animation and scroll as data, compares that recording with an approved baseline, and writes an
offline report in which both versions play side by side on one clock.

<!-- motionpr:compare dataset="navigation/open" -->

The example above is real MotionPR data. It is the navigation panel of the demo app that ships
with the CLI: in the candidate version its `transform` transition went from 320 ms on
`cubic-bezier(0.16, 1, 0.3, 1)` to 560 ms on `ease-in-out`. MotionPR reported both changes as
warnings and measured the curves 70% of progress apart at 27% of the time.

## What it records

| Motion                                                 | Recorded as          | How                                                   |
| ------------------------------------------------------ | -------------------- | ----------------------------------------------------- |
| CSS transitions, CSS animations, Web Animations        | `AnimationRecord`    | Read from the browser, replayed through paused clones |
| GSAP tweens, Anime.js animations                       | `AnimationRecord`    | Adapters that use the engines' public APIs            |
| GSAP and Anime.js timelines                            | `TimelineRecord`     | Duration, repeat, speed, labels and children          |
| Lenis and native scrolling, page and scroll containers | `ScrollMotionRecord` | Observed live, frame by frame, never replayed         |
| Settled states and filmstrips                          | PNG assets           | Rendered at deterministic times during replay         |

## What it compares

Durations, delays, start offsets after an input, easing curves (as curves, not strings),
iterations, direction, playback rate, stagger intervals, keyframe values, sampled trajectories,
opacity and size, added and removed animations, timeline labels and their order, scroll
distance, settle time, the shape of a scroll, peak velocity, overshoot, and the pixels of the
settled state. Every difference has a severity, a rule, and a label that says how it was
measured. See [Motion comparison](../features/motion-comparison.md).

## What it is not

- **Not a screenshot diff with animation bolted on.** Pixels are one input of many, and they are
  never critical by default because fonts render differently across platforms.
- **Not a screen recorder.** Frames are rendered deterministically during replay, so the same time
  shows the same state on every run.
- **Not a service.** MotionPR runs on your machine or your CI runner. It has no account, no backend
  and no telemetry.

## Status

MotionPR is in **alpha** (`0.5.0-alpha`). It is published on npm's `alpha` dist-tag for
feedback. The capture format can still change between minor versions, and older captures are
migrated when they are read. It captures with Chromium, Firefox and WebKit, each against its own
baseline ([Browser support](../browsers/support.md)). The full list of limitations is in
[Limitations](../advanced/limitations.md).

## Where to go next

- [Why MotionPR](why-motionpr.md): the problem it solves, and where it fits next to visual tests.
- [How it works](how-it-works.md): capture, analyze, compare, inspect, report.
- [Getting started](../getting-started/requirements.md): a reviewed motion change in about ten
  minutes.
- [Interactive demo](https://erenthedeveloper0.github.io/motionpr/demo/): the demo app's real baseline and candidate.
