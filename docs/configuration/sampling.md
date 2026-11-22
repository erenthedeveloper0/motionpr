---
title: Sampling
description: How many values per animation, how many frames per checkpoint, and how long a window may be.
---

# Sampling

| Option                             | Default  | Description                                                          |
| ---------------------------------- | -------- | -------------------------------------------------------------------- |
| `capture.samples`                  | `24`     | Property samples per animation across its active duration (2–240)    |
| `capture.frames.enabled`           | `true`   | Render a filmstrip per checkpoint                                    |
| `capture.frames.fps`               | `30`     | Filmstrip frame rate (1–120)                                         |
| `capture.frames.maxFrames`         | `90`     | Per checkpoint; the interval grows for long windows                  |
| `capture.frames.format`            | `"png"`  | `png` (lossless, enables frame divergence) or `jpeg`                 |
| `capture.frames.quality`           | `80`     | JPEG quality                                                         |
| `capture.maxWindow`                | `5000`   | Longest motion window replayed per checkpoint (ms)                   |
| `capture.waitForAnimationsTimeout` | `10000`  | Upper bound for waiting until motion settles (ms)                    |
| `capture.settleTime`               | `120`    | Quiet period with no running or newly started animation (ms)         |
| `capture.navigationTimeout`        | `30000`  | Page navigation timeout (ms)                                         |
| `capture.actionTimeout`            | `10000`  | Default timeout for clicks, hovers, fills (ms)                       |
| `capture.scenarioTimeout`          | `120000` | Whole-scenario timeout (ms)                                          |
| `capture.waitForNetworkIdle`       | `true`   | Wait for the network to go quiet after navigation (warns on timeout) |
| `capture.networkIdleTimeout`       | `5000`   | Bound for network idle, fonts and images (ms)                        |
| `capture.waitForFonts`             | `true`   | Wait for `document.fonts.ready`; report failed faces                 |
| `capture.waitForImages`            | `true`   | Wait for non-lazy images                                             |
| `capture.concurrency`              | `1`      | Scenarios captured in parallel (separate contexts, one browser)      |
| `capture.scrollContainers`         | `true`   | Record scroll containers' motion, not only the document's            |

## Samples

Samples are taken at evenly spaced times across each animation's active duration during replay.
Each one holds computed values of the animated properties, the decomposed transform
(`translateX/Y/Z`, `scaleX/Y`, `rotate`, `skewX`), opacity and the border box. They drive the
trajectory, opacity and size comparisons and the inspector's value charts. Raise the count for
long or complex animations whose path matters between the endpoints. Easing curves always use
their own 65 samples, independent of this setting.

Baseline and candidate should use the same count: otherwise path comparisons fall back to
endpoints and the comparison says so (`SAMPLE_COUNT_DIFFERS`).

## Frames

Frames are rendered deterministically during replay, not recorded in real time. A window longer
than `maxFrames / fps` seconds (3 s by default) gets a larger interval between frames, so a
checkpoint never stores more than `maxFrames`. Frames are content-addressed: a frame in which
nothing moved is stored once.

| To make captures smaller                        | Cost                                        |
| ----------------------------------------------- | ------------------------------------------- |
| Lower `frames.fps` or `frames.maxFrames`        | Coarser filmstrips                          |
| `frames.format: "jpeg"`                         | No frame divergence (it needs lossless PNG) |
| `{ type: "capture", label, frames: false }`     | No filmstrip for that checkpoint            |
| `{ type: "capture", label, screenshot: false }` | No visual comparison for that checkpoint    |

## Scroll containers

Since `0.4.0-alpha`. MotionPR records how native scroll containers (elements whose
content overflows and scrolls) move, not only the document, and waits for them to settle before
a checkpoint. Before each interaction it notes where every container rests, a pass over the page
of about 1 ms per 1,000 elements, so a container that starts to move has its rest position.
Containers inside shadow roots are part of that pass and recorded too (since `0.5.0-alpha`;
[Shadow DOM](../integrations/shadow-dom.md#scroll-containers)).

`capture.scrollContainers: false` records the document scroller only, as `0.3.0-alpha` did. To
leave out one container, such as a ticker that scrolls by itself all the time, add it to
`ignore.selectors` instead ([Ignore rules](ignore-rules.md)). Captures record the setting
(`settings.scrollContainers`); a container that only one side could record is `uncertain` in a
comparison ([Severity](../features/severity.md#scroll-and-timeline-rules)).

## Concurrency

`capture.concurrency` runs scenarios in parallel contexts of one browser. Replay is deterministic,
but start times and latency are observed live, and a loaded machine can make them noisier. Keep
`1` for baselines on slow CI runners.
