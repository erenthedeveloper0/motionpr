---
title: GSAP integration
description: Capture GSAP tweens and timelines with the @erenthedeveloper0/motionpr/gsap adapter.
---

# GSAP integration

GSAP animates by writing inline styles from its own ticker. Browsers do not expose those
animations through `document.getAnimations()`, so MotionPR ships an adapter that observes GSAP
from inside your page.

**Status:** supported for the patterns listed below. Tested against GSAP **3.15.1**; the adapter
reports versions outside `>=3.12.0 <4.0.0` as _untested_ (it still runs). ScrollTrigger-driven
animations have no start time (their progress follows scroll); MotionPR records their timing,
observes their progress live, compares it against recorded scroll motion and samples the values
they write over the progress the scroll reached (see [ScrollTrigger](#scrolltrigger)). The
adapter's browser tests and the demo app's GSAP and ScrollTrigger scenarios pass in Chromium,
Firefox and WebKit.

|         |                                                                                                           |
| ------- | --------------------------------------------------------------------------------------------------------- |
| Install | `npm install -D @erenthedeveloper0/motionpr` and `npm install gsap` (GSAP is an optional peer dependency) |
| Import  | `import { motionprGsap } from "@erenthedeveloper0/motionpr/gsap"` (browser code, no dependencies)         |
| Config  | `adapters: [{ name: "gsap", required: true }]`                                                            |
| Records | `type: "gsap"`, `source: "gsap"`, `driver: "javascript"`, plus a `TimelineRecord` per timeline            |

<!-- motionpr:engine-demo engine="gsap" -->

## Setup

```bash
npm install gsap        # GSAP 3.12 or newer
```

Register once, right after importing GSAP and **before creating animations**:

```ts
import gsap from "gsap";
import { motionprGsap } from "@erenthedeveloper0/motionpr/gsap";

motionprGsap.register(gsap);
```

Then make the adapter required in `motionpr.config.ts`, so a missing registration is reported as an
error instead of silently capturing nothing:

```ts
adapters: [{ name: "gsap", required: true }],
```

### Is it safe in production?

Yes. `@erenthedeveloper0/motionpr/gsap` is a small, dependency-free browser module (about 27 kB unminified, 8 kB gzipped). When
MotionPR is not capturing the page (no agent present), `register()` returns `false` and changes
nothing: GSAP is not wrapped and no ticker listener is added. You can also load it only in
development:

```ts
if (import.meta.env.DEV) {
  const { motionprGsap } = await import("@erenthedeveloper0/motionpr/gsap");
  motionprGsap.register(gsap);
}
```

With React, register in your app entry (not inside components). `useGSAP()` and `gsap.context()`
work unchanged because they call `gsap.to()`/`gsap.timeline()` underneath.

## API

| Export                                              | Description                                                                                                                                             |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `motionprGsap.register(gsap, options?)`             | Connects GSAP to a capturing MotionPR agent. Returns `true` when active. `RegisterOptions`: `{ force?: boolean }` (install without an agent, for tests) |
| `motionprGsap.track(animation, name?)`              | Tracks an animation explicitly and gives it a stable name. Returns the animation                                                                        |
| `motionprGsap.isActive()`                           | `true` when registered with a capturing agent                                                                                                           |
| `motionprGsap.getDiagnostics()`                     | Adapter health messages (e.g. how many animations follow ScrollTrigger)                                                                                 |
| `motionprGsap.dispose()`                            | Restores `gsap.to/from/fromTo/timeline`, removes the ticker listener and unregisters. Animations keep running                                           |
| `SUPPORTED_GSAP_RANGE`                              | The tested version range (`>=3.12.0 <4.0.0`)                                                                                                            |
| `gsapProperties(vars)`                              | Maps tween vars to the CSS properties they animate (`x`, `rotation`, `scale` → `transform`; `autoAlpha` → `opacity`, `visibility`)                      |
| `GsapLike`, `GsapAnimationLike`, `GsapTimelineLike` | Structural types for the parts of GSAP the adapter uses                                                                                                 |

`motionprGsap` is also the default export.

### Naming animations

Animation names are part of how MotionPR matches animations across versions. Name important
timelines explicitly:

```ts
const intro = gsap.timeline();
intro.addLabel("lines").from(".line", { yPercent: 100, stagger: 0.08 });
motionprGsap.track(intro, "hero-intro");
```

Tweens inside a tracked timeline are named `timeline@label` (here `hero-intro@lines`), using the
nearest label at or before the tween. Without a tracked name, `vars.id` is used.

## What is captured

For every tween **per target element**:

| Field                 | Source                                                                                                                                                                                   |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| duration, delay       | `tween.duration()`, `tween.delay()`                                                                                                                                                      |
| start time            | Position on the root timeline, mapped to the page clock                                                                                                                                  |
| iterations, direction | `repeat()` (−1 = infinite), `yoyo()` → alternate                                                                                                                                         |
| repeat delay          | `repeatDelay()` (in metadata; included in the active duration)                                                                                                                           |
| playback rate         | Product of time scales up to the root; negative while reversed                                                                                                                           |
| easing                | The ease name (`power3.out`, `back.out(1.7)`, `steps(5)`, custom names) **and** 65 samples of GSAP's own ease function, so any ease, including CustomEase, is drawn and compared exactly |
| properties            | Tween vars mapped to CSS properties                                                                                                                                                      |
| samples               | Computed styles and geometry, by rendering the timeline at exact times (ScrollTrigger: at exact progress values, see [ScrollTrigger](#scrolltrigger))                                    |
| group                 | Staggered tweens share a group, which drives stagger-interval comparison                                                                                                                 |

## Supported patterns

| Pattern                                                               | Status                                                                |
| --------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `gsap.to / from / fromTo`                                             | ✅                                                                    |
| `gsap.timeline()` with nested tweens and nested timelines             | ✅                                                                    |
| Timeline labels and position parameters                               | ✅                                                                    |
| `stagger` (number, object, function)                                  | ✅ per-target records with real offsets                               |
| Keyframes (`keyframes: [...]`)                                        | ✅ expanded like staggers                                             |
| `repeat`, `yoyo`, `repeatDelay`, infinite repeats                     | ✅ (one iteration sampled for infinite)                               |
| Timelines created paused and played later (`tl.play()` on click)      | ✅ recorded in the window where they run                              |
| `tl.reverse()` (e.g. menu close)                                      | ✅ negative playback rate                                             |
| `timeScale()`                                                         | ✅                                                                    |
| `gsap.context()`, `useGSAP()`                                         | ✅                                                                    |
| `gsap.set()` / zero-duration tweens                                   | ignored (not motion)                                                  |
| Non-DOM targets (plain objects, canvas)                               | timing only, no samples                                               |
| Targets inside shadow roots (passed as elements; since `0.5.0-alpha`) | ✅ identified through their host ([Shadow DOM](shadow-dom.md))        |
| ScrollTrigger (`scrollTrigger:` vars), `scrub` or `toggleActions`     | ✅ values sampled where the scroll went ([below](#scrolltrigger))     |
| ScrollTrigger on a repeating tween or timeline                        | ⚠️ timing and live progress only                                      |
| Animations created before `register()`                                | ⚠️ picked up if still on the global timeline; otherwise use `track()` |
| `new gsap.core.Timeline()` / `new gsap.core.Tween()`                  | use `track()`                                                         |
| Draggable, Observer, Flip                                             | not observed                                                          |

## How replay works

During a capture MotionPR pauses the root timelines and renders them at exact times with
`totalTime(t, true)`. The `true` suppresses events, so `onComplete`, `onUpdate` and the other
callbacks do **not** fire again. Afterwards each timeline's time and paused state are restored, so
your app keeps working (a menu timeline still opens and closes). Other running GSAP animations are
frozen during replay so frames are deterministic. Infinite ones are set to their start.

## ScrollTrigger

_New in `0.3.0-alpha`: `0.2.0-alpha` recorded ScrollTrigger animations as timing and live
progress only._

A ScrollTrigger animation has no start time: with `scrub` its progress follows the scroll, with
`toggleActions` it plays once its trigger enters. Scroll is never replayed, so the adapter records
the animation's progress live on GSAP's ticker (`progressTrace`). For sampling, MotionPR renders it
at `capture.samples` evenly spaced progress values between the lowest and highest progress the
page showed in the checkpoint, with `totalTime(t, true)` like any other replay. Each sample has a
`scrollProgress` and, as its `windowTime`, the moment the page first showed that progress.

```ts
gsap.to(".hero-image", {
  yPercent: -12,
  ease: "none",
  scrollTrigger: {
    trigger: ".hero",
    start: "top bottom",
    end: "bottom top",
    scrub: true,
  },
});
```

- **Scroll progress** is the progress of the scroll-driven tween or timeline, 0 to 1. A tween
  inside a scrubbed timeline is sampled in its own part of it: the second of two equal tweens
  between 50% and 100%.
- **Coverage.** When the scenario's scroll stops before the end of a tween's part, the record is
  `partial` (_Sampled only where the scroll went: 50%–80% scroll progress (the animation runs
  from 50% to 100%)_). When the scroll never reaches it, the record is `metadata-only`, with the
  reason.
- **Positions** (since `0.4.0-alpha`). Every record of a ScrollTrigger animation
  carries `scrollLink`, read from the ScrollTrigger instance: the `start` and `end` scroll
  positions it resolved (px), its scroller (`null` for the document, otherwise the container's
  element key) and axis, `scrub` (`0` for `scrub: true`, the smoothing in ms for
  `scrub: <seconds>`, `null` without scrub) and, without scrub, its four `toggleActions`. These
  come from ScrollTrigger's layout, not from the scroll's timing, so two runs of one build agree
  in every engine.
- **Comparison** answers two questions separately:
  - _Where in the scroll does it run?_ The positions ScrollTrigger resolved (since
    `0.4.0-alpha`). A moved `start` or `end`: _Starts at scroll position 400px → 550px
    (+150px)_ (`scroll-position` rule: ignored up to `comparison.scroll.positionTolerancePx`, a
    warning from `warnPositionPx`). A changed `scrub` or `toggleActions` is a scroll setting:
    _Scroll setting scrub: on → 500ms_ (`info`), or a `warning` when scrubbing is turned on or
    off. Positions on a different scroller or axis are not compared: _Scroll-linked to document →
    test-id:panel_. Captures taken with `0.3.0-alpha` or earlier have no positions; when either
    side lacks them, MotionPR compares progress at the same scroll position instead, as
    `0.3.0-alpha` does: _Scroll-linked progress at the same scroll position differs by up to 14%
    (at 656px: 28% → 14%)_.
  - _What does it write?_ Values at the same scroll progress, over the progress both captures
    reached. A changed parallax distance: _Scroll-linked translateY differs by up to 120px at the
    same scroll progress (at 100%: -120px → -240px)_. Transforms and opacity use the `trajectory`,
    `size` and `opacity` thresholds, other properties (colors, lengths) the `keyframes` rule. A
    moved `start` alone does not change these values, so it is reported once.
- **Replay.** While MotionPR renders other animations at a time (filmstrip frames, the settled
  screenshot, samples), ScrollTrigger animations show the progress the page showed at that time.
- **`scrub: <seconds>`** smooths progress with an internal GSAP tween. Its effect is the recorded
  progress, so it is not reported as an animation of its own; settling waits for it.
- **Not sampled:** ScrollTrigger animations whose tween or timeline repeats (one progress value
  would stand for several states), and non-element targets. They keep timing and live progress.
- **No positions** for ScrollTriggers with `containerAnimation` (their `start`/`end` lie along
  another animation, not the scroll): they are compared by progress at the same scroll position.

## Troubleshooting

- **`ADAPTER_MISSING` diagnostic**: `register(gsap)` did not run in the captured page, or ran
  with a different GSAP instance than the one your animations use (check for duplicate GSAP
  copies in the bundle).
- **An animation is missing**: it was created before `register()` and already finished. Move
  `register()` earlier or `track()` the timeline.
- **Names changed between versions**: give timelines explicit names with `track()`.

## Cleanup

`motionprGsap.dispose()` restores the four wrapped GSAP methods (only if nothing else replaced
them since), removes MotionPR's ticker listener and unregisters the adapter. It never pauses,
kills or reverts animations. Outside a capture, `register()` never wraps anything, so there is
nothing to clean up.

## Timeline records

<!-- motionpr:timeline dataset="gsap-intro/played" -->

Every timeline that ran in a checkpoint becomes a `TimelineRecord` (`checkpoint.timelines`):
duration, repeat count, direction, speed, progress and its labels in milliseconds. Each tween
record links to it through `parent`. The comparison reports timeline duration and repeat
changes, labels that moved, appeared or disappeared, and label sequences that were reordered.
