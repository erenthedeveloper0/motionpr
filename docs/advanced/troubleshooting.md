---
title: Troubleshooting
description: Fixes for the problems people hit most often.
---

# Troubleshooting

Start with:

```bash
npx motionpr doctor
```

It checks Node.js, every browser engine, the config, output-directory permissions, the
baselines, your web server and every configured adapter, and prints a fix next to every problem.
`npx motionpr doctor --browser all` launches all three engines.

## "Chromium (or Firefox, or WebKit) for MotionPR is not installed"

```bash
npx motionpr install                 # the configured engine
npx motionpr install firefox webkit  # the engines the message names
```

MotionPR never runs another engine instead: nothing is captured until the requested engine is
installed.

Behind a proxy, set `HTTPS_PROXY`. To download from a mirror, set `PLAYWRIGHT_DOWNLOAD_HOST`. To
install into a custom location (for example a CI cache), set `PLAYWRIGHT_BROWSERS_PATH`, both when
installing and when running. To use an installed Chrome instead, set `browser.channel: "chrome"`
or `browser.executablePath` (or the `MOTIONPR_BROWSER_PATH` environment variable).

## Browser launch fails on Linux ("the system libraries it needs are missing")

```bash
npx motionpr install --with-deps            # the configured engine
npx motionpr install webkit --with-deps     # name the engine from the message
```

This installs the system packages the engine needs and requires root. WebKit needs the most
(GStreamer, libsoup, WOFF2 and others) and only Playwright's supported Ubuntu and Debian releases
are covered. In Docker, the official Playwright images (`mcr.microsoft.com/playwright`) already
include them for every engine.

## "No approved firefox baseline" although a baseline exists

Baselines are per engine. A Chromium baseline is never used for a Firefox run: approve the first
Firefox capture with `npx motionpr baseline accept --browser firefox`. `npx motionpr baseline
status` shows which engines have one.

## "The baseline … was captured with Chromium, the candidate with Firefox"

`compare` refuses captures from two engines (`BROWSER_MISMATCH`). Compare each engine with its own
baseline, or add `--cross-browser` (or `--against <browser>`) to compare engines on purpose.

## Firefox or WebKit start times look coarse

Both report time in 1 ms steps, and headless WebKit on macOS renders at 30 fps. Captures note it
(`COARSE_TIMERS`, `LOW_FRAME_RATE`); start offsets are compared with a two-frame tolerance. See
[Browser support](../browsers/support.md#how-the-engines-differ).

## "Something is already serving http://localhost:3000"

MotionPR will not start a second server on a busy port. Stop the running server, or let MotionPR
use it:

```ts
webServer: { command: "npm run dev", url: "http://localhost:3000", reuseExistingServer: true }
```

The generated config uses `reuseExistingServer: !process.env.CI`: reuse locally, always start fresh
in CI.

## "Web server command exited" or "Timed out waiting for …"

The error includes the last lines of the server's output. Check that `webServer.url` is the URL
the server actually listens on (host and port), and raise `webServer.timeout` for slow first
builds. Readiness means a status code of 2xx, 3xx or 400–403.

## A step fails with "strict mode violation"

The selector matches several elements. Make it unique, for example with a `data-testid`:
`[data-testid='menu-toggle']`.

## "No animations detected in this checkpoint"

- The step did not trigger the animation: check the selector and that the interaction really
  causes motion (hover states need `hover`, not `click`).
- The animation ran _before_ the window opened: put a `capture` before the interaction, or check
  the `PRE_TRIGGER_ANIMATIONS` diagnostic.
- GSAP animations need `motionprGsap.register(gsap)` in your app; see
  [GSAP integration](../integrations/gsap.md). Add `adapters: [{ name: "gsap", required: true }]`
  to get an error diagnostic when the adapter is missing.
- Animations driven by `requestAnimationFrame` and inline styles (without WAAPI, CSS or a supported
  engine) are not visible to MotionPR; see [Limitations](limitations.md).

## "Animations still running after … ms"

Something is still animating when the timeout expires. Often it's a long or JavaScript-chained
sequence. Raise `capture.waitForAnimationsTimeout`, or the `timeout` of the `waitForAnimations`
step. Infinite animations never block waiting; they are recorded with one iteration sampled.

## Many changes reported as "uncertain"

The elements are matched by DOM position only. Add `data-motionpr-id="…"` (or `data-testid`) to
animated elements. To trust DOM-path matches anyway, set
`comparison.uncertainOnLowConfidence: false`.

## Visual differences on CI but not locally

Fonts and anti-aliasing differ between operating systems. Capture the baseline on the same
platform as CI (see [Baseline management](../ci/baseline-management.md)), raise
`comparison.visual.maxDiffRatio`, add `comparison.visual.ignoreRegions`, or turn the rule off with
`comparison.severity: { visual: "off" }`. Animation timing and easing comparisons are unaffected
by rendering differences.

## Start times differ by a frame

Start times and latency are frame-quantized (about 16.7 ms at 60 Hz) and compared with
`comparison.timing.startToleranceMs` (34 ms by default). Declared durations, delays and easings
are compared exactly.

## Config errors

Validation errors show the file and the exact path, for example `scenarios[0].steps[2].selector`.
TypeScript configs get completion and type errors in your editor through `defineConfig`.

## The report shows "Report unavailable"

The HTML file has no data embedded (for example the bare template was copied). Regenerate:

```bash
npx motionpr report --regenerate
```

## Exit codes

| Code      | Meaning                                                                                        |
| --------- | ---------------------------------------------------------------------------------------------- |
| 0         | Success; comparison within thresholds                                                          |
| 1         | A configured regression threshold was exceeded (`comparison.failOn`)                           |
| 2         | Configuration, execution or comparison error (including failed captures in `motionpr capture`) |
| 130 / 143 | Interrupted (Ctrl+C / SIGTERM); servers and the browser are shut down first                    |

## Known capture limitations

- **Motion inside a web component is missing** (unreleased, after `0.4.0-alpha`): shadow roots
  attached by script (open or closed), declarative open roots and nested roots are observed. A
  declarative closed root (`<template shadowrootmode="closed">`) is invisible to scripts, and so
  to MotionPR ([Shadow DOM](../integrations/shadow-dom.md#which-shadow-roots)). With
  `0.4.0-alpha` or earlier, CSS motion inside any shadow root was not recorded.
- **Every element inside a component is matched by DOM position**: its host has no identity.
  Elements in a shadow root are identified through their host
  (`test-id:plan-pro >> motionpr-id:glow`), so give the host a `data-testid` or
  `data-motionpr-id`.
- **`No element matches … (waited … ms)`** in a `scroll` or `scrollTo` step: no element matched
  the Playwright selector within `capture.actionTimeout`. Steps reach into open shadow roots, not
  closed ones.
- **Uncertain added and removed animations inside components after upgrading** from
  `0.4.0-alpha`: the baseline was captured before MotionPR looked inside shadow roots. Accept a
  new baseline once ([Shadow DOM](../integrations/shadow-dom.md#upgrading-from-040-alpha)).
- **Scroll containers** (since `0.4.0-alpha`): containers inside iframes are not recorded as
  scroll motion. Inside shadow roots they are since the unreleased version after `0.4.0-alpha`.
- **`wheel: … is outside the viewport`**: a `wheel` step with `selector` points at an element that
  is not on screen. Add a `scrollIntoView` step for it first; MotionPR does not scroll on its own.
- **`wheel: … is covered by …`**: another element (an overlay, a sticky header) sits over the
  point, and the wheel would scroll that. Pass a `position` inside the element that is free.
- **Checkpoints wait for a container that scrolls by itself** (a ticker moved with
  `scrollLeft`): every scroll container is waited for. Add it to `ignore.selectors`, or set
  `capture.scrollContainers: false`.
- **Scroll is not replayed:** filmstrips of scroll windows show the final scroll position.
- **Engines created before MotionPR's adapters** (GSAP tweens before `register()`, Anime.js
  instances created with the unwrapped functions) need `track()` and may be recorded with less
  detail; see each integration guide.

## Diagnostic codes

Captures and comparisons carry diagnostics; the report lists them per checkpoint, warnings first.

| Code                                                       | Level                             | Meaning                                                                                                                         |
| ---------------------------------------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `ADAPTER_MISSING`                                          | error if `required`, else warning | A configured adapter did not register in the page                                                                               |
| `ANIMATIONS_NOT_SETTLED`                                   | warning                           | Motion was still running when the wait timed out                                                                                |
| `PRE_TRIGGER_ANIMATIONS`                                   | info                              | Animations that started before the interaction were excluded                                                                    |
| `INFINITE_ANIMATIONS`                                      | info                              | Infinite animations were recorded with one iteration sampled                                                                    |
| `WINDOW_CAPPED`                                            | warning                           | The motion window exceeded `capture.maxWindow`                                                                                  |
| `IMPLICIT_CAPTURE`                                         | info                              | A scenario without checkpoints got a final capture labelled `final`                                                             |
| `LOW_CONFIDENCE_IDENTITY`                                  | info                              | Some animations are identified by DOM position only                                                                             |
| `POSSIBLE_DUPLICATE_RECORDS`                               | warning                           | Two engines animate the same property of the same element at once                                                               |
| `NETWORK_NOT_IDLE`, `FONTS_NOT_READY`, `IMAGES_NOT_LOADED` | warning                           | The page was not fully ready after navigation                                                                                   |
| `FONT_LOAD_FAILED`                                         | warning                           | A web font face failed to load                                                                                                  |
| `PAGE_ERROR`, `REQUEST_FAILED`                             | warning                           | The page threw an uncaught error, or a request failed                                                                           |
| `CONSOLE_ERROR`                                            | info                              | The page logged an error to the console                                                                                         |
| `SCROLL_NOT_SETTLED`, `SCROLL_STALLED`                     | warning                           | A scroller did not come to rest, or Lenis reports scrolling but never moves ([Lenis](../integrations/lenis.md#troubleshooting)) |
| `SCROLL_NATIVE`, `SCROLL_LOW_FRAME_RATE`                   | info                              | `scrollTo` used native scrolling; few frames were sampled while waiting for scroll                                              |
| `BROWSER_VERSION_DIFFERS`, `PLATFORM_DIFFERS`              | warning                           | Baseline and candidate come from different browsers or platforms                                                                |
| `CONFIG_DIFFERS`                                           | info                              | The capture configuration changed between baseline and candidate                                                                |
| `SAMPLE_COUNT_DIFFERS`                                     | info                              | Different `capture.samples`; path comparisons use endpoints only                                                                |
