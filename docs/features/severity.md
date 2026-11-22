---
title: Severity & thresholds
description: How MotionPR grades differences, the default rules and their rationale, and how to change them.
---

# Severity & thresholds

Every difference has one severity:

| Severity      | Meaning                                                      |
| ------------- | ------------------------------------------------------------ |
| **critical**  | Motion the design relied on is gone or broken                |
| **warning**   | The interface moves noticeably differently; review it        |
| **info**      | A small, measurable adjustment                               |
| **uncertain** | The finding rests on a weak element match or incomplete data |

`comparison.failOn` decides the exit code: with the default `"critical"`, `motionpr run` exits `1`
only for critical differences. `uncertain` never fails a run unless `failOnUncertain: true`.

## Default rules and rationale

| Rule                                 | Default                                                                 | Why                                                                              |
| ------------------------------------ | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `scenario-failed`                    | critical                                                                | The interaction no longer works, so its motion cannot happen                     |
| `scenario-removed`                   | critical                                                                | A tracked scenario vanished                                                      |
| `scenario-added`                     | info                                                                    | New coverage, nothing to compare yet                                             |
| `checkpoint-removed`                 | critical                                                                | The flow no longer reaches a recorded state                                      |
| `checkpoint-added`                   | warning                                                                 | The flow changed shape                                                           |
| `animation-removed`                  | critical                                                                | Feedback users saw is gone (e.g. a reveal that now pops)                         |
| `animation-added`                    | warning                                                                 | New motion deserves a look                                                       |
| `duration`, `delay`                  | graded                                                                  | See timing thresholds below                                                      |
| `end-delay`                          | info                                                                    | Rarely visible                                                                   |
| `start`                              | graded, at most warning                                                 | Start offsets are frame-quantized estimates                                      |
| `easing`                             | warning ≥ 5% max deviation (or overshoot appears/disappears), else info | The feel of motion                                                               |
| `iterations`                         | warning; critical when finite ↔ infinite                                | A loop that starts or stops looping is a different behaviour                     |
| `direction`, `playback-rate`         | warning                                                                 |                                                                                  |
| `fill`                               | info                                                                    | Affects end state, which visual comparison also covers                           |
| `property-added`, `property-removed` | warning                                                                 | The animation now moves something else                                           |
| `keyframes`                          | graded                                                                  | Declared start/end values of non-transform properties (colour, clip-path, sizes) |
| `trajectory`                         | graded by px                                                            | Translate/rotate start and end values from sampled computed styles               |
| `opacity`, `size`                    | graded                                                                  | Sampled opacity, scale and layout size                                           |
| `stagger`                            | graded, at most warning                                                 | Interval between consecutive siblings changed                                    |
| `visual`                             | warning                                                                 | Pixels depend on fonts and platforms; never critical by default                  |

### Timing thresholds

For a duration (relative to the baseline duration) or a delay/start (relative to the animation's
duration):

- below `timing.toleranceMs` (1 ms; 34 ms for start times): no difference;
- **critical** when the relative change reaches `criticalRelative` (1.0, i.e. doubled or halved)
  and the absolute change reaches `warnAbsoluteMs` (50 ms);
- **warning** when the relative change reaches `warnRelative` (15%) and the absolute change reaches
  `warnAbsoluteMs`;
- **info** otherwise.

Examples: 450 → 700 ms is a warning (+56%); 400 → 800 ms is critical; a delay from 0 to 120 ms on a
380 ms animation is a warning (32%); 1000 → 1100 ms is info.

Try it: the controls below build two animation records and grade them with MotionPR's comparison
engine (`compareMatchedAnimation` from `@motionpr/comparison`, with the default thresholds) in
your browser.

<!-- motionpr:playground compact -->

### Low-confidence matches

When either side's element is identified only by DOM position, every change on that animation
becomes **uncertain** (and removal/addition too, since the element may simply have moved). Add a
`data-motionpr-id` to fix this, or set `comparison.uncertainOnLowConfidence: false`.

### Captures that did not look inside shadow roots

Since `0.5.0-alpha`. Captures made with `0.4.0-alpha` or earlier did not record CSS
motion or scroll containers inside shadow roots, and identified the rest there without its host.
Against such a capture, unless the rule's severity is set:

- `animation-added` and `scroll-added` for a record inside a shadow root are `uncertain`
  (_… The baseline was captured before MotionPR looked inside shadow roots (MotionPR 0.4.0-alpha
  or earlier), so this is uncertain; capture it again to compare this animation._);
- `animation-removed` and `scroll-removed` for an old record that may be one of those, under its
  old key, are `uncertain`;
- records paired by their key within the root are fuzzy matches, and all their changes are
  `uncertain`.

See [Shadow DOM](../integrations/shadow-dom.md#upgrading-from-040-alpha).

## Overrides

```ts
comparison: {
  failOn: "warning",
  severity: {
    easing: "critical",   // treat any easing change beyond tolerance as critical
    visual: "off",        // ignore pixel differences entirely
    "animation-added": "info",
  },
}
```

An override replaces the computed severity for every difference produced by that rule; `"off"`
drops them. Overrides also bypass the low-confidence rule. Each difference records its `rule`, so
you can see which override applies.

## Scroll and timeline rules

| Rule               | Default                                                   | Applies to                                                                                        |
| ------------------ | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `scroll-removed`   | critical (info if the scroller did not move)              | A scroller recorded in the baseline is missing                                                    |
| `scroll-added`     | warning (info if it did not move)                         | A new scroller moved                                                                              |
| `scroll-position`  | warning ≥ `warnPositionPx`, else info                     | Start, end or target position                                                                     |
| `scroll-duration`  | warning above both duration thresholds, else info         | Time from first movement to settling                                                              |
| `scroll-curve`     | warning ≥ `warnCurveDeviation`, else info                 | Normalized progress curve, scroll-linked progress at the same position, engine and option changes |
| `scroll-velocity`  | warning above 2 × `velocityTolerance`, else info          | Peak velocity, smooth-scroll lag                                                                  |
| `scroll-overshoot` | warning when overshoot appears or disappears              | Travel past the final position                                                                    |
| `timeline`         | warning; info for added labels/timelines and child counts | Timeline duration, repeat, speed, labels and their order                                          |

Scroll comparisons whose data is incomplete (a scroller still moving at capture) are reported as
`uncertain`.

Since `0.4.0-alpha`, two more cases are `uncertain` unless the rule's severity is
set:

- `scroll-added` and `scroll-removed` for a scroll container that the other capture could not
  record: it was made before scroll containers were recorded, or with
  `capture.scrollContainers: false` (_… The baseline was captured without scroll-container
  recording …_).
- `scroll-curve` and `scroll-velocity` for a native scroll whose positions reached the page
  unevenly: some frames brought no new position and others two, as in Firefox, which animates
  smooth scrolling off the main thread, or a `wheel` step whose events landed unevenly
  (_… (uncertain: this native scroll's positions reached the page unevenly, up to a frame
  late)_). Positions, duration and settling stay definite.

Since `0.4.0-alpha`: `scroll-position` also grades where a ScrollTrigger animation
starts and ends (the positions ScrollTrigger resolved), and `scroll-curve` changes of its `scrub`
(a warning when scrubbing is turned on or off, otherwise info), `toggleActions` (info) and
scroller (warning). See [GSAP: ScrollTrigger](../integrations/gsap.md#scrolltrigger).
