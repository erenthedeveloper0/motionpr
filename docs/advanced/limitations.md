---
title: Limitations
description: What this alpha does not do, and where each limitation is documented.
---

# Limitations

MotionPR is in alpha (`0.4.0-alpha`). Everything below is a known limitation of this release, not
a hidden one.

## Browsers and platforms

- **Playwright's builds only.** Chromium, Firefox and WebKit are tested in the builds that match
  the bundled Playwright (1.65). Installed browsers (`browser.channel`, `executablePath`) work
  but are not covered by tests. WebKit is Playwright's WebKit, not Safari.
- **Engines run one after another** in a multi-browser run (`--browser all`), not in parallel;
  use a CI matrix for parallel engines.
- **Cross-browser comparisons are investigative.** Pixel, geometry, start-offset and scroll
  differences between two engines are always `uncertain`; each engine is compared with its own
  baseline to find regressions.
- **Live observations are as precise as the engine allows.** Firefox and WebKit report time in
  1 ms steps, and headless WebKit renders at 30 fps on macOS, so start offsets and scroll samples
  are coarser there. See [Browser support](../browsers/support.md#how-the-engines-differ).
- **Timer-driven interruptions are environmental.** When an app cancels or reverses motion from a
  `setTimeout`, where the animation stood at that moment depends on scheduling. Sampled path and
  end-value differences of cancelled animations are `uncertain`.
- **Windows is verified with Chromium only.** The repository's CI runs the unit tests, the
  Chromium browser suites, the demo app's expectations and the packaged CLI on Windows. Firefox
  and WebKit are verified on macOS and Linux.
- **Pixels depend on the platform.** Visual comparison is a warning by default for this reason;
  capture baselines where CI runs ([Baseline management](../ci/baseline-management.md)).

## What can be observed

- Motion drawn by your own `requestAnimationFrame` loop with inline styles, on `<canvas>` or in
  WebGL, is not visible without a [custom adapter](custom-adapters.md).
- **Scroll is never replayed.** Scroll motion is recorded live; filmstrip frames of scroll windows
  show the final scroll position, and the scroll graph is the source of truth.
- **Scroll-linked tween values** (GSAP ScrollTrigger) are sampled only where the scroll went
  ([GSAP](../integrations/gsap.md#scrolltrigger)): a part of the range the scenario never scrolled
  through has no values to compare. Repeating ScrollTrigger animations are timing and live
  progress only.
- **Scroll-linked progress under native smooth scrolling** in Firefox and WebKit is noisy.
  Progress at the same scroll position relates two live recordings (progress and scroll
  position); in MotionPR's tests with native smooth scrolling, two runs of the same build
  differed by up to 11% in Firefox and 28% in WebKit (none in Chromium), which is reported as an
  `info` or `warning`. Since `0.4.0-alpha`, MotionPR compares the `start`/`end` positions
  ScrollTrigger resolved instead, which were stable in all three engines; progress at the same
  scroll position remains the fallback for captures without them (taken with `0.3.0-alpha` or
  earlier) and for ScrollTriggers with `containerAnimation`
  ([GSAP](../integrations/gsap.md#scrolltrigger)). The values a ScrollTrigger animation writes
  are compared by progress and were stable in all three engines.
- **CSS scroll-driven animations** are recorded as metadata only.
- **Scroll containers** (since `0.4.0-alpha`): native overflow containers are
  recorded, but not inside iframes (their scroll events do not reach the page's document), and
  inside shadow roots only since the unreleased version after `0.4.0-alpha`
  ([Shadow DOM](../integrations/shadow-dom.md#scroll-containers)). A container added, or
  starting to overflow, after its window opened is `partial`.
  `scrollTo` steps drive the first attached Lenis instance or a native container, not a Lenis
  instance on a container; `wheel` over its `wrapper` does.
- **Smooth scrolling depends on the platform.** Chromium on Windows jumps instead of animating
  `behavior: "smooth"` scrolls when the system's animation effects are off, as on GitHub's
  Windows runners ([Chromium](../browsers/chromium.md#known-limitations)).
- **Native smooth scrolling in Firefox** runs off the main thread, and its positions reach the
  page up to a frame late. Two runs of one build differed by up to 19% in easing curve and 73% in
  peak velocity in MotionPR's tests; those differences are `uncertain`. Positions, duration and
  settling are stable. Headless engines also move a native scroller once per `wheel` event, so
  the curve of a native `wheel` scroll follows the step's `interval`.
- **Shadow DOM** (unreleased, after `0.4.0-alpha`): open and closed roots attached by script,
  declarative open roots and nested roots are observed; declarative closed roots, the browser's
  own shadow trees (form controls, media) and iframes are not. Steps and screenshot masks do not
  reach into closed roots, so an input inside one is not masked
  ([Shadow DOM](../integrations/shadow-dom.md#limitations)). Up to `0.4.0-alpha`, CSS motion
  inside shadow roots was not recorded at all (`document.getAnimations()` leaves shadow trees
  out), and Web Animations there were identified without their host.

## Engines

- **GSAP:** Draggable, Observer and Flip are not observed; `new gsap.core.Timeline()` needs
  `track()`; repeating ScrollTrigger animations are timing and live progress only. See
  [GSAP](../integrations/gsap.md).
- **Anime.js:** v3 is not supported; `composition: "blend"` is metadata only; per-keyframe timing
  of `keyframes` is not reconstructed; `createTimer()`, `createAnimatable()`, `createDraggable()`
  and `onScroll()` are not instrumented. See [Anime.js](../integrations/animejs.md).
- **Lenis:** `infinite: true` positions wrap and distance metrics assume no wrap; touch scrolling
  is recorded but not generated by steps. See [Lenis](../integrations/lenis.md).

## Format and API

- The capture format may still change between minor versions; older captures are migrated when
  they are read. Files written by a newer MotionPR are rejected with an actionable error.
- The adapter protocol (`PROTOCOL_VERSION = 1`) may change before 1.0.

The [roadmap](https://github.com/erenthedeveloper0/motionpr/blob/main/ROADMAP.md) lists what is
planned.
