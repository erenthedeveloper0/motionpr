---
title: First capture
description: Describe one interaction, run it, and see what MotionPR recorded.
---

# First capture

A scenario opens a page, drives it with real input and records **checkpoints**. Start with the
interaction you would hate to see regress: here, a navigation menu that slides in.

```html title="index.html (the app)"
<button data-testid="menu-toggle">Menu</button>
<nav class="menu" data-motionpr-id="menu">…</nav>

<style>
  .menu {
    transform: translateX(-100%);
    transition: transform 300ms cubic-bezier(0.16, 1, 0.3, 1);
  }
  .menu.open {
    transform: translateX(0);
  }
</style>
```

```ts title="motionpr.config.ts" {12-19}
import { defineConfig } from "@erenthedeveloper0/motionpr";

export default defineConfig({
  baseURL: "http://localhost:4173",
  webServer: {
    command: "npm run dev",
    url: "http://localhost:4173",
    reuseExistingServer: !process.env.CI,
  },
  scenarios: [
    {
      id: "menu-open",
      name: "Navigation menu opens",
      path: "/",
      steps: [
        { type: "click", selector: "[data-testid='menu-toggle']" },
        { type: "waitForAnimations" },
        { type: "capture", label: "menu-open" },
      ],
    },
  ],
});
```

The `click` is the **trigger**: the first animation that starts after it becomes `t = 0` of the
checkpoint. `waitForAnimations` waits until motion settles, and `capture` records everything
that moved in between.

`data-motionpr-id="menu"` gives the element a stable identity, so MotionPR finds the same menu in
the next version even if the markup around it changes. Without it, MotionPR falls back to the
DOM path and marks the match as low confidence. See
[Animation identification](../features/animation-identification.md).

## Run it

```bash
npx motionpr run
```

This is the real output of the example above:

```text
◐ motionpr 0.5.0-alpha  ·  run

  → 1 scenario from motionpr.config.mjs
  → Starting web server: npm run dev
  → Web server ready at http://localhost:4173 (266 ms)
  → [1/1] menu-open@default
  ✔ menu-open@default  1 checkpoint · 1 animation · 1.5s

  Captured  1/1 scenarios · 1 checkpoints · 1 animations · 9 unique frames
  Capture   .motionpr/captures/chromium/20261113-215354-f7d6 (20261113-215354-f7d6)
  Browser   Chromium 158.0.8127.18 · Playwright 1.65.0 · darwin-arm64

  ▲ No approved Chromium baseline yet, so there is nothing to compare against.
    Baselines are per browser. Review the report, then approve this capture and commit .motionpr/baseline/chromium.
  Report  .motionpr/report/chromium/index.html

  Next
  $ npx motionpr report --open
  $ npx motionpr baseline accept
```

`@default` is the viewport: without `browser.viewports`, every scenario runs once at 1440 × 900.
On the first run there is nothing to compare against, so `run` exits `0` locally. In CI it exits
`2` instead, unless you pass `--allow-missing-baseline` (see [CI exit codes](../ci/exit-codes.md)).
The capture was taken with Chromium, the default engine; `npx motionpr run --browser firefox`
(or `webkit`, or `all`) captures with another engine, which keeps its own baseline
([Cross-browser testing](../browsers/cross-browser-testing.md)).

## What was recorded

```text
.motionpr/captures/chromium/20261113-215354-f7d6/
├── capture.json     scenarios → checkpoints → animations (timing, easing, samples)
└── assets/          9 PNG frames, named by content hash
```

The capture contains one `AnimationRecord` for the menu: `type: "css-transition"`, the property
`transform`, its duration (300 ms), its easing with 65 curve samples, and 24 sampled computed
values of `transform` and the element's box across the transition. The format is described in
[Capture data model](../features/capture-data-model.md).

Open the report to check that it recorded what you expected:

```bash
npx motionpr report --open
```

Next: [First comparison](first-comparison.md).
