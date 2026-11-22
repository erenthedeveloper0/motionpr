---
title: Native CSS animations
description: CSS transitions and @keyframes animations are recorded automatically — no setup, no adapter.
---

# Native CSS animations

CSS transitions and CSS animations need **no setup**. The browser exposes them through
`document.getAnimations()` as `CSSTransition` and `CSSAnimation` objects, and MotionPR's agent
reads their timing, keyframes and easing directly. Inside web components it asks each shadow root
for them ([Shadow DOM](shadow-dom.md)).

|         |                                                                                    |
| ------- | ---------------------------------------------------------------------------------- |
| Install | nothing                                                                            |
| Config  | nothing                                                                            |
| Records | `type: "css-transition"` or `"css-animation"`, `source: "native"`, `driver: "css"` |
| Status  | Verified in Chromium, Firefox and WebKit (capture engine browser tests, demo app)  |

<!-- motionpr:engine-demo engine="css" -->

## Transitions

```css
.nav-panel {
  transform: translateX(100%);
  transition: transform 320ms cubic-bezier(0.16, 1, 0.3, 1);
}
.nav-open .nav-panel {
  transform: translateX(0);
}
```

This is the demo app's navigation panel (its stylesheet writes the curve as `var(--expo-out)`).

One record per transitioned property and element, named after the property
(`css-transition “transform” on nav-panel`). `transition-delay`, `transition-duration` and
`transition-timing-function` become `timing.delay`, `timing.duration` and the effect easing.
Shorthands are recorded as the longhands the browser transitions.

## Keyframe animations

```css
@keyframes dialog-in {
  from {
    opacity: 0;
    transform: translateY(18px) scale(0.96);
  }
  to {
    opacity: 1;
    transform: none;
  }
}
.modal-open .dialog {
  animation: dialog-in 420ms cubic-bezier(0.16, 1, 0.3, 1) both;
}
```

One record per animation name and element (`css-animation “dialog-in” on dialog`), with every
keyframe value. `animation-timing-function` applies per keyframe segment in CSS, so it is stored
in `timing.keyframeEasings`; when all segments share one easing it is also the record's effective
easing and is compared as a curve. `animation-iteration-count: infinite` is recorded with one
iteration sampled.

## What is compared

Everything in [Motion comparison](../features/motion-comparison.md#animations): duration, delay,
easing curve, iterations, direction, fill, keyframe values (colours, `clip-path`, sizes),
sampled trajectories, opacity and size, and added or removed animations. The demo app has five
native scenarios; their real results:

| Scenario     | Change in the candidate                     | Reported                                                          |
| ------------ | ------------------------------------------- | ----------------------------------------------------------------- |
| navigation   | duration 320 → 560 ms, easing → ease-in-out | two warnings per checkpoint, plus the sampled path (info)         |
| modal        | entrance easing now overshoots              | warning: easing, max deviation 12%                                |
| faq          | answer reveal gains a 120 ms delay          | warning: `Delay 0ms → 120ms (+120ms)`                             |
| cta-hover    | lift −2 px → −6 px with a scale-up          | info: `translateY at end: -2px → -6px`, `scaleX at end: 1 → 1.04` |
| image-reveal | the `clip-path` reveal is removed           | **critical**: `Removed: css-animation “wipe-in” on case-image`    |
| features     | a new badge animation is added              | warning: `Added: css-animation “pop” on feature-badge`            |

## Scroll-driven animations

CSS scroll-driven animations (`animation-timeline: scroll()` or `view()`) are recorded as
metadata: their progress follows scroll position, not time, so they cannot be replayed at chosen
times. They appear with `timeline: "scroll"` or `"view"` and are correlated with scroll motion as
`scroll-linked`.

## Tips

- Give animated elements a `data-motionpr-id` so they are matched across versions with high
  confidence ([Animation identification](../features/animation-identification.md)).
- Pseudo-elements (`::before`, `::after`) are recorded with `pseudoElement` on the identity.
- `transition: all` records each property that actually transitions.
