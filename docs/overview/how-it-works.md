---
title: How it works
description: Capture, analyze, compare, inspect, report — the five stages of a MotionPR run.
---

# How it works

`npx motionpr run` does five things in order. Each stage has its own page; this one shows how
they connect.

<!-- motionpr:workflow -->

## 1. Capture

MotionPR starts your web server (or reuses one), opens each scenario in a fresh browser context
(Chromium by default, or Firefox or WebKit) and injects its **agent** before any of your scripts
run. The agent discovers native animations
(`document.getAnimations()` every frame, plus a patched `Element.prototype.animate`), also inside
the shadow roots of web components, and receives records from engine **adapters** for GSAP,
Anime.js and Lenis.

Your scenario drives the page with real input: clicks, hovers, key presses, wheel events,
smooth scrolls. Each `capture` step closes a **checkpoint window** that opened at the previous
checkpoint. See [Animation capture](../features/animation-capture.md) and
[Interaction scenarios](../features/interaction-scenarios.md).

## 2. Analyze

When motion has settled, MotionPR **replays** the window deterministically: native animations
are cloned and the paused clones are seeked; adapters render their engines at exact times with
callbacks muted. At those times it samples computed styles and geometry and renders a filmstrip.
Then it restores everything, so your app never sees a re-fired `transitionend` or `onComplete`.

Scroll is never replayed. It is recorded live, as positions over time. Normalization assigns
stable ids to every record so the same animation can be found again in another capture. See
[Capture data model](../features/capture-data-model.md).

## 3. Compare

The candidate capture is matched against the approved baseline: scenario by scenario, checkpoint
by label, animation by element identity, type and name. Matched pairs are compared field by
field; unmatched records become _added_ or _removed_. Easing curves are compared numerically
from 65 samples, scrolls by their own metrics, and settled screenshots by pixels. Every
difference gets a severity from a named rule. See [Motion comparison](../features/motion-comparison.md).

## 4. Inspect

The comparison and both captures are written into an offline HTML report. Baseline (blue) and
candidate (peach) play side by side; the timeline shows every animation as a pair of bars with
its delay, duration and easing curve; the inspector shows what changed, by how much and how it
was measured. See [HTML reports](../features/html-reports.md).

## 5. Report

The CLI prints a summary, appends Markdown to `$GITHUB_STEP_SUMMARY` in GitHub Actions, and exits
with a code your CI understands: `0` within thresholds, `1` when a difference reaches
`comparison.failOn`, `2` on errors. See [CI exit codes](../ci/exit-codes.md).

```text
.motionpr/
├── baseline/          approved capture (commit this)
├── captures/<id>/     the run's capture: capture.json + assets/
├── comparison/        comparison.json + diff images
└── report/            index.html + assets/  (open it, or upload it from CI)
```
