---
title: Web Animations API
description: element.animate() and Animation objects are recorded automatically, including staggers built from per-element delays.
---

# Web Animations API

Animations created with `element.animate()` are recorded without setup. MotionPR wraps
`Element.prototype.animate` before your scripts run, so it sees each animation the moment it is
created, and it also finds them through `document.getAnimations()` and inside the shadow roots of
web components ([Shadow DOM](shadow-dom.md)).

|         |                                                                                |
| ------- | ------------------------------------------------------------------------------ |
| Install | nothing                                                                        |
| Config  | nothing                                                                        |
| Records | `type: "web-animation"`, `source: "native"`, `driver: "waapi"`                 |
| Status  | Verified in Chromium, Firefox and WebKit, including reused `Animation` objects |

<!-- motionpr:engine-demo engine="waapi" -->

```js
document.querySelectorAll(".work-card").forEach((card, i) => {
  card.animate(
    [
      { opacity: 0, transform: "translateY(28px) scale(0.98)" },
      { opacity: 1, transform: "none" },
    ],
    {
      id: "work-reveal",
      duration: 520,
      delay: i * 70,
      easing: "cubic-bezier(0.2, 0.8, 0.2, 1)",
      fill: "both",
    },
  );
});
```

The `id` option becomes the record's name (`web-animation “work-reveal” on work-card-3`). Name
your animations: names are part of the matching key, and they make reports readable.

## Staggers

The demo app's work grid is the code above, with a 70 ms interval in the baseline and 120 ms in
the candidate. MotionPR groups the six cards into one stagger family (same name, same properties,
element keys `test-id:work-card-1` … `-6`) and reports:

- one stagger difference: _Stagger interval 70ms → 120ms across 6 elements_ (warning);
- each card's own delay change, graded on its own. A delay change is measured against the
  animation's duration (520 ms): card 3's `Delay 140ms → 240ms` is 19% of it, a warning; card 2's
  `+50ms` is under the 15% of `timing.warnRelative`, so it is info. (The `+71.43%` in the message
  is the change relative to the old delay, shown for reading.)

<!-- motionpr:stagger dataset="work-grid/revealed" -->

## Replay

Recorded Web Animations are replayed through clones: MotionPR calls `target.animate()` with the
same keyframes and timing, pauses the clone and seeks it. The original animation is never touched,
so its `finish` event and promise behave exactly as they did.

## Anime.js and WAAPI

Anime.js's `waapi.animate()` creates real Web Animations. With the
[Anime.js adapter](animejs.md) they are recorded once, labelled `source: "animejs"`,
`driver: "waapi"`, never twice.
