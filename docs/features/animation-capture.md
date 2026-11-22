---
title: Animation capture
description: How MotionPR finds animations in the page, decides when motion has settled, and replays it deterministically.
---

# Animation capture

A capture turns what moved in the page into data. It happens in the browser, inside the page
under test, in four phases per checkpoint: **discover**, **settle**, **replay**, **restore**.

<!-- motionpr:timeline dataset="work-grid/revealed" -->

## Discover

Before any of your scripts run, MotionPR injects its agent (`window.__MOTIONPR_AGENT__`). It
finds native animations by polling `document.getAnimations()` every frame and by wrapping
`Element.prototype.animate`, so short-lived animations are seen even if they finish between two
frames. `document.getAnimations()` leaves shadow roots out, so the agent also polls every shadow
root it knows: roots attached by script (open or closed; it wraps `attachShadow`) and declarative
open roots (since `0.5.0-alpha`; [Shadow DOM](../integrations/shadow-dom.md)).

| Found natively                     | Record type      | Engine label                                  |
| ---------------------------------- | ---------------- | --------------------------------------------- |
| CSS transitions                    | `css-transition` | Native CSS                                    |
| CSS animations (`@keyframes`)      | `css-animation`  | Native CSS                                    |
| Web Animations (`element.animate`) | `web-animation`  | WAAPI                                         |
| CSS scroll-driven animations       | `css-animation`  | metadata only (their progress follows scroll) |

JavaScript engines that write inline styles every frame are invisible to the browser's animation
list. They report through **adapters** in your page: [GSAP](../integrations/gsap.md),
[Anime.js](../integrations/animejs.md), and [Lenis](../integrations/lenis.md) for scrolling.

## The window

Each `capture` step closes a window that opened at the previous checkpoint (or at page load).
Its origin, `t = 0`, is the first motion after the first interaction in it: the earliest
animation start, or the first frame of scroll movement. The time from the interaction that caused
it (the last one before the motion, e.g. the click after a `scrollIntoView` and a
`waitForAnimations`) to that first motion is recorded as **latency** (the tutorial's menu:
11.2 ms), and that interaction is the checkpoint's `window.trigger`.

- Animations that started **before** the interaction (a page-load spinner) belong to the previous
  state. They are excluded, and the checkpoint gets a `PRE_TRIGGER_ANIMATIONS` note saying how
  many.
- A window longer than `capture.maxWindow` (5000 ms) is cut, with a `WINDOW_CAPPED` warning.
- **Infinite** animations never block settling. One iteration is sampled and an
  `INFINITE_ANIMATIONS` note is added.

## Settle

A checkpoint waits until no finite animation is running, no smooth scroll is advancing, and
nothing new started for `capture.settleTime` (120 ms), up to `capture.waitForAnimationsTimeout`
(10 s). The quiet period catches animations that begin a frame or two after an interaction. If
motion never settles, the capture continues with an `ANIMATIONS_NOT_SETTLED` warning naming what
was still running.

## Replay

Then MotionPR renders the whole window again, at times it chooses:

- **Native animations** are cloned (`target.animate(keyframes, timing)`) and the paused clones
  are seeked. The originals never dispatch `transitionend`, `animationend` or `finish` again.
- **Adapters** render their engines at exact times with callbacks muted: GSAP with
  `totalTime(t, true)`, Anime.js with `seek(t, true)`.
- Everything else is frozen, so each frame shows only the state at that time.

At `capture.samples` (24) evenly spaced times per animation, MotionPR reads computed styles, the
decomposed transform and the element's box. At `capture.frames.fps` (30) it renders a filmstrip
frame, up to `capture.frames.maxFrames` (90) per checkpoint. Identical frames are stored once.
Because nothing is recorded in real time, the same build produces the same frames on every run.

## Restore

Every animation, engine and timeline gets back exactly the state it had, and capture moves on
to the next step. Your app keeps working: a menu timeline that was replayed still opens and
closes on the next click.

## What a capture cannot see

- Motion drawn by your own `requestAnimationFrame` loop with inline styles, on `<canvas>` or in
  WebGL, unless you write an [adapter](../advanced/custom-adapters.md).
- Values written by scroll-linked tweens (GSAP ScrollTrigger) where the scroll did not go: they
  are sampled only within the progress the page showed, and repeating ones not at all
  ([GSAP: ScrollTrigger](../integrations/gsap.md#scrolltrigger)).
- Scroll itself is never replayed; it is recorded live. See [Lenis](../integrations/lenis.md).
- Declarative closed shadow roots, the browser's own shadow trees and iframes
  ([Shadow DOM](../integrations/shadow-dom.md#which-shadow-roots)).

The full list is in [Limitations](../advanced/limitations.md). The internals are described in
[Architecture](../advanced/architecture.md).
