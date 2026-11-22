---
title: Performance
description: What a capture costs, how comparison scales, and how big captures and reports get — measured, with the benchmark to reproduce it.
---

# Performance

## Where the time goes

Capture dominates. Each scenario opens a fresh browser context, waits for the page to be ready,
runs its steps in real time, waits for motion to settle, and replays each window to sample values
and render frames. In the demo app, a scenario takes 0.7–3.6 s (11 scenarios in about 24 s per
variant on an M-series MacBook). Comparison and report generation take milliseconds to seconds.

| To capture faster                                      | Trade-off                                               |
| ------------------------------------------------------ | ------------------------------------------------------- |
| `capture.concurrency: 2` or more                       | Noisier frame-quantized start times on a loaded machine |
| `frames: false` on checkpoints that need no filmstrip  | No frames in the report for them                        |
| Fewer, more focused scenarios (`--scenario`)           | Less coverage per run                                   |
| `capture.waitForNetworkIdle: false` for apps that poll | No network-idle wait after navigation                   |

The agent polls the document for animations once per frame, and every shadow root it knows
(since `0.5.0-alpha`): 1,000 shadow roots took 0.3 ms per frame in Firefox, 0.6 ms
in Chromium and 1 ms in WebKit in MotionPR's measurements
([Shadow DOM](../integrations/shadow-dom.md#cost)).

## How comparison scales

`pnpm bench` in the repository measures comparison and report-model building on synthetic
captures. Results on darwin-arm64, Node.js 24:

| Case                                        | `compareCaptures` | report model | `JSON.parse` of the capture |
| ------------------------------------------- | ----------------- | ------------ | --------------------------- |
| 400 animations (3.7 MB capture)             | 6 ms              | 0.7 ms       | 13 ms                       |
| 6 000 animations (55 MB capture)            | 61 ms             | 8 ms         | 209 ms                      |
| 24 000 animations (220 MB capture)          | 227 ms            | 22 ms        | 847 ms                      |
| scroll metrics, 100 records × 3 000 samples | 11 ms             |              |                             |

Comparison is linear in the number of records. The practical limit is size: captures are
pretty-printed JSON so that baseline diffs stay readable in code review, and reports embed both
captures.

## Sizes

A real capture of the demo app (57 animations per variant) is 1.6 MB of JSON, about 10 kB per
animation record; its report is 2.5 MB of HTML plus frames. Frames are content-addressed PNGs, so
idle frames cost nothing extra. See [Sampling](../configuration/sampling.md#frames) to make
captures smaller.

## In your app

The adapters do nothing outside a capture: `motionprGsap.register()` returns `false` and wraps
nothing, `createAnimeInstrumentation()` returns the original functions, and
`motionprLenis.attach()` adds no listener. Their cost in production is their download size
(about 7 kB gzipped for `/gsap`, 13 kB for `/animejs`, 5 kB for `/lenis`). Import them only in builds you
capture if that matters.
