---
title: Interaction scenarios
description: Write scenarios that trigger the motion you care about — page loads, clicks, hovers, scrolls, dialogs and forms.
---

# Interaction scenarios

A scenario is a short script of real input. Each step either acts on the page, waits, or records
a checkpoint. This page shows the patterns; every step and option is listed in the
[scenario reference](../configuration/scenarios.md).

```ts
{
  id: "booking",                      // stable id: letters, digits, . _ - (no spaces)
  name: "Booking dialog",             // shown in reports
  path: "/pricing",                   // relative to baseURL, or url: "https://…"
  steps: [
    { type: "click", selector: "[data-testid=book]" },
    { type: "capture", label: "open" },
    { type: "press", key: "Escape" },
    { type: "capture", label: "closed" },
  ],
}
```

## Triggers and checkpoints

Every interaction step (`click`, `hover`, `move`, `press`, `fill`, `scroll`, `scrollIntoView`,
`scrollTo`, `wheel`) is a **trigger**: MotionPR notes the input, and the first motion that starts
afterwards becomes `t = 0` of the next checkpoint. A `capture` step then waits for motion to
settle and records the window. One scenario can hold many checkpoints; they are matched across
captures by **label**, so keep labels stable.

```ts
steps: [
  { type: "click", selector: "[data-testid=menu-toggle]" },
  { type: "capture", label: "open" }, // the opening motion
  { type: "click", selector: "[data-testid=menu-close]" },
  { type: "capture", label: "closed" }, // the closing motion
];
```

A scenario without any `capture` or `screenshot` step gets a final capture labelled `final`, with
an `IMPLICIT_CAPTURE` note.

## Patterns

### Page-load motion

Put a `capture` before any interaction:

```ts
{ id: "home-intro", path: "/", steps: [{ type: "capture", label: "loaded" }] }
```

After every navigation MotionPR waits for the page to be ready (network idle, web fonts,
non-lazy images, settled page-load animations), so the intro is recorded from a stable start.

### Hover states

```ts
steps: [
  { type: "move", x: 4, y: 4 }, // park the pointer first
  { type: "hover", selector: "[data-testid=cta-primary]" },
  { type: "capture", label: "hovered" },
];
```

Moving the pointer to a neutral spot first makes the hover start from the same state in every run.

### Reveal on scroll into view

```ts
steps: [
  { type: "scrollIntoView", selector: "[data-testid=features]", block: "start" },
  { type: "capture", label: "in-view" },
];
```

`scroll` and `scrollIntoView` position the page **instantly**: they are state changes that can
trigger animations (an `IntersectionObserver` reveal), not scroll motion.

### Smooth scrolling

```ts
steps: [
  { type: "scrollTo", target: "#journal", behavior: "smooth" }, // Lenis when attached
  { type: "waitForScrollSettled" },
  { type: "capture", label: "journal" },
  { type: "wheel", deltaY: 800, steps: 4 }, // real wheel input
  { type: "waitForScrollSettled" },
  { type: "capture", label: "after-wheel" },
];
```

`scrollTo` and `wheel` produce **scroll motion**, recorded live as a `ScrollMotionRecord`. See
[Lenis](../integrations/lenis.md).

### Scroll containers

```ts
steps: [
  { type: "scrollTo", target: 1200, selector: "[data-testid=feed]" }, // native, smooth
  { type: "waitForScrollSettled" },
  { type: "capture", label: "feed" },
  { type: "wheel", deltaY: 600, steps: 6, selector: "[data-testid=feed]" }, // pointer over it
  { type: "waitForScrollSettled" },
  { type: "capture", label: "feed-wheel" },
  { type: "click", selector: "[data-testid=next-slide]" }, // the page scrolls a carousel
  { type: "waitForScrollSettled" },
  { type: "capture", label: "carousel" },
];
```

Since `0.4.0-alpha`: overflow elements that scroll are recorded too, one
`ScrollMotionRecord` each (`native:test-id:feed:vertical`), from where they rested before the
interaction, whether a step or the page scrolled them.

### Forms

```ts
steps: [
  { type: "fill", selector: "input[name=email]", value: "ada@example.test" },
  { type: "press", key: "Enter" },
  { type: "waitFor", selector: ".toast", state: "visible" },
  { type: "capture", label: "submitted" },
];
```

Filled values are never written to captures, reports or error messages, and inputs are masked in
every screenshot.

### Several viewports

```ts
browser: {
  viewports: [
    { name: "desktop", width: 1440, height: 900 },
    { name: "mobile", width: 390, height: 844, deviceScaleFactor: 2 },
  ],
},
scenarios: [
  { id: "menu", viewports: ["mobile"], steps: [/* … */] },   // only on mobile
],
```

Every scenario runs once per viewport (`menu@mobile`), each in a fresh browser context.

## Selectors

Selectors are Playwright selectors (CSS, `text=…`, `role=…`), and they reach into open shadow
roots ([Shadow DOM](../integrations/shadow-dom.md#steps)). They must match **exactly one**
element, otherwise the step fails with a _strict mode violation_ (`scroll` and `scrollTo` take
the first match). Prefer `[data-testid=…]` or `[data-motionpr-id=…]`: they make both the step and
the [element identity](animation-identification.md) stable.

## Organising scenarios

`defineScenario` and `defineSteps` only add types, so scenarios can live next to the components
they test:

```ts
// motion/menu.ts
import { defineScenario } from "@erenthedeveloper0/motionpr";

export const menu = defineScenario({
  id: "menu",
  steps: [
    { type: "click", selector: "[data-testid=menu]" },
    { type: "capture", label: "open" },
  ],
});
```

```ts
// motionpr.config.ts
import { defineConfig } from "@erenthedeveloper0/motionpr";
import { menu } from "./motion/menu";

export default defineConfig({ baseURL: "http://localhost:3000", scenarios: [menu] });
```

Run a subset with `npx motionpr run --scenario "menu*"`.

## When a step fails

The scenario stops, the remaining steps are marked `skipped`, a failure screenshot is stored and
the error (with filled values redacted) is shown in the CLI and the report. In `motionpr run`, a
scenario that fails in the candidate is a **critical** difference (rule `scenario-failed`).
