---
title: Scenarios
description: Reference for scenario fields and every step type, with all options and defaults.
---

# Scenarios

The guide to writing scenarios is [Interaction scenarios](../features/interaction-scenarios.md).
This page lists every field.

## Scenario

| Field       | Type                | Default                   | Description                                                              |
| ----------- | ------------------- | ------------------------- | ------------------------------------------------------------------------ |
| `id`        | `string`            | required                  | Stable id used to match captures: letters, digits, `.`, `_`, `-`, max 80 |
| `name`      | `string`            | `id`                      | Shown in reports                                                         |
| `path`      | `string`            | `"/"`                     | Opened relative to `baseURL` before the steps run                        |
| `url`       | `string`            | —                         | Absolute http(s) URL, instead of `baseURL` + `path`                      |
| `viewports` | `string[]`          | all                       | Names of [viewports](viewports.md) to run in                             |
| `steps`     | `Step[]`            | `[]`                      | See below. Checkpoint labels must be unique within the scenario          |
| `timeout`   | `number` (ms)       | `capture.scenarioTimeout` | Overall scenario timeout                                                 |
| `skip`      | `boolean \| string` | —                         | Skip the scenario; a string documents why                                |
| `tags`      | `string[]`          | —                         | Free-form                                                                |

## Checkpoints

| Step         | Fields                                                                                                                                             |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `capture`    | `label` (required), `frames?` (default `capture.frames.enabled`), `maxWindow?` (ms, overrides `capture.maxWindow`), `screenshot?` (default `true`) |
| `screenshot` | `label` (required), `fullPage?`, `selector?` (one element instead of the viewport)                                                                 |

Labels: 1–80 characters, letters, digits, spaces, `.`, `_`, `-`, starting with a letter or digit.

```ts
{ type: "capture", label: "menu-open" }
{ type: "capture", label: "intro", frames: false }        // timing and samples only, no filmstrip
{ type: "capture", label: "hero", maxWindow: 8000 }       // allow a longer motion window
{ type: "screenshot", label: "footer", selector: "footer" }
```

## Interactions

Each interaction is a **trigger**: the first motion after it becomes `t = 0` of the next
checkpoint.

| Step             | Fields                                                                                                             | Notes                                                             |
| ---------------- | ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| `click`          | `selector`, `button?` (`left`, `right`, `middle`), `clickCount?` (1–3), `position?` `{x, y}`, `force?`, `timeout?` | `position` is relative to the element's top-left corner           |
| `hover`          | `selector`, `position?`, `force?`, `timeout?`                                                                      |                                                                   |
| `move`           | `x`, `y` (viewport CSS px), `steps?` (1–100 intermediate `mousemove` events)                                       | Moves the mouse                                                   |
| `fill`           | `selector`, `value`, `timeout?`                                                                                    | The value is never written to captures, reports or error messages |
| `press`          | `key` (Playwright key name: `Enter`, `Escape`, `ArrowDown`, …), `selector?` (focus first), `timeout?`              |                                                                   |
| `scroll`         | `x?`, `y?` (absolute CSS px), `selector?` (a container)                                                            | Instant positioning, not scroll motion                            |
| `scrollIntoView` | `selector`, `block?` (`start`, `center`, `end`, `nearest`), `timeout?`                                             | Instant positioning, not scroll motion                            |

`force: true` skips Playwright's actionability checks. `timeout` defaults to
`capture.actionTimeout`.

## Scroll motion

| Step                   | Fields and defaults                                                                                                                                                                                                |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `scrollTo`             | `target` (px on the scroll axis, or a selector), `behavior` (`smooth` \| `instant`, default `smooth`), `via` (`auto` \| `lenis` \| `native`, default `auto`), `axis?`, `offset?`, `selector?` (a native container) |
| `wheel`                | `deltaX` (0), `deltaY` (0), `steps` (1, max 100), `interval` (16 ms), `selector?` (point at this element), `position?` (default: viewport centre, or the element's centre)                                         |
| `waitForScrollSettled` | `timeout` (5000 ms), `threshold` (0.5 px), `stableFrames` (6), `minStableMs` (100 ms)                                                                                                                              |

- `via: "auto"` scrolls through the first attached Lenis instance when there is one, otherwise
  natively (with a `SCROLL_NATIVE` note); `via: "lenis"` requires Lenis.
- `wheel` sends real wheel events, so smooth-scroll engines react exactly as they do for users.
  The browser scrolls whatever is under the pointer. With `selector`, the pointer goes to the
  centre of the element's visible part first (`position` is then relative to its top-left
  corner), so the wheel scrolls that scroll container, or the Lenis instance whose `wrapper` it
  is. The element must be in the viewport and not covered by another element; otherwise the step
  fails and says which, because MotionPR does not scroll to reach it (bring it into view with a
  `scrollIntoView` step first).
- **Scroll containers** (since `0.4.0-alpha`): the scroll motion of overflow
  elements is recorded like the document's, whether a step scrolls them (`scrollTo` with
  `selector`, `wheel` over them) or the page does (a carousel's "next" button). Instant `scroll`
  steps stay state changes. Turn it off with `capture.scrollContainers: false`
  ([Sampling](sampling.md#scroll-containers)).
- `waitForScrollSettled` resolves when every scroller moved less than `threshold` per sample for
  `stableFrames` consecutive samples and at least `minStableMs`: the document, each attached
  Lenis instance and each scroll container that scrolled in the window or that a `scrollTo` step
  is scrolling. On timeout it adds `SCROLL_NOT_SETTLED` instead of failing.

See [Lenis](../integrations/lenis.md) for what is recorded.

## Navigation and waiting

| Step                | Fields                                                                                                        | Notes                                                                    |
| ------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `goto`              | `path?` (relative to `baseURL`) or `url?`, `waitUntil?` (`load`, `domcontentloaded`, `networkidle`, `commit`) | `url` takes precedence                                                   |
| `waitFor`           | `selector`, `state?` (`attached`, `detached`, `visible`, `hidden`; default `visible`), `timeout?`             |                                                                          |
| `waitForAnimations` | `timeout?` (default `capture.waitForAnimationsTimeout`)                                                       | Waits until motion settles. A timeout is a warning, not a failure        |
| `wait`              | `duration` (ms, max 60000)                                                                                    | Fixed delay. Prefer `waitFor` / `waitForAnimations`; use only for timers |

After every navigation MotionPR waits for the page to be ready: network idle (bounded by
`capture.networkIdleTimeout`), web fonts (`document.fonts.ready`), non-lazy images and settled
page-load animations. Each of these produces a diagnostic instead of silently continuing:
`NETWORK_NOT_IDLE`, `FONTS_NOT_READY`, `IMAGES_NOT_LOADED`.

## Selectors

Selectors are Playwright selectors (CSS, `text=…`, `role=…`, parts chained with `>>`) in every
step, and Playwright's CSS reaches into open shadow roots
([Shadow DOM](../integrations/shadow-dom.md#steps)). Steps that act on an element must match
**exactly one**. `scroll` and `scrollTo` take the first match; since `0.5.0-alpha` Playwright
finds it too (before, `document.querySelector` did, which stops at shadow roots), and they wait
up to `capture.actionTimeout` for it to be attached. An empty selector is a config error.

## Helpers

`defineScenario(scenario)` and `defineSteps(steps)` return their argument unchanged and only add
types, for scenarios kept in separate modules.
