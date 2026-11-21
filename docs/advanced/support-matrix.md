---
title: Support matrix
description: Browsers, runtimes, engines and platforms MotionPR is tested with, and how many real-browser tests cover each.
---

# Support matrix

| Area                                | Supported                                          | How it is verified                                                                                                |
| ----------------------------------- | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Node.js                             | 22.12 or newer                                     | `engines`; `doctor` checks it. Tests run on Node.js 24 (and the package on 22)                                    |
| Chromium                            | Chrome for Testing 158.0.8127.18 (Playwright 1.65) | Every browser test                                                                                                |
| Firefox                             | Firefox 159.0, Playwright build 1572               | Every browser test except the multi-engine CLI runs                                                               |
| WebKit                              | WebKit 27.2, Playwright build 2388                 | Every browser test except the multi-engine CLI runs                                                               |
| Several engines in one project      | Verified                                           | CLI runs with `--browser all`, per-engine baselines, cross-browser comparison, 0.1 migration                      |
| Native CSS transitions / animations | Verified in all three engines                      | Capture engine and engine edge-case tests, demo app                                                               |
| Web Animations API                  | Verified in all three engines                      | Reversed, cancelled, finished, delayed, keyframed, reused                                                         |
| CSS scroll-driven animations        | Metadata only                                      | Progress follows scroll                                                                                           |
| GSAP                                | Verified with 3.15.1 (range `>=3.12 <4`)           | 24 browser tests per engine; ScrollTrigger: live progress, values sampled where the scroll went, positions        |
| Anime.js                            | Verified with 4.5.0 (range `>=4 <5`)               | 23 browser tests per engine, unit tests; v3 is not supported                                                      |
| Lenis                               | Verified with 1.3.27 (range `>=1.1 <2`)            | 16 browser tests per engine; scroll motion, never replayed                                                        |
| Native scroll containers            | Verified in all three engines                      | 12 browser tests per engine: steps, page-driven scrolls, settling, comparison                                     |
| Shadow DOM (unreleased)             | Verified in all three engines                      | 12 browser tests per engine: open, closed, nested and declarative roots, containers, steps, ignore, comparison    |
| macOS                               | Verified (arm64), all three engines                | Development machine                                                                                               |
| Linux                               | Covered by the repository's CI, all three engines  | `ubuntu-latest`, one job per engine                                                                               |
| Windows                             | Covered by the repository's CI, Chromium           | `windows-latest`: unit tests, Chromium browser suites, demo app, packaged CLI. Firefox and WebKit are not covered |

## Browser tests per engine

The browser suites run once per engine (`MOTIONPR_TEST_BROWSER=firefox pnpm test:integration`);
CI runs Chromium in the main job, Firefox and WebKit in a matrix, and Chromium again on Windows.

| Suite                                                                                  | Chromium | Firefox | WebKit |
| -------------------------------------------------------------------------------------- | -------: | ------: | -----: |
| Capture engine                                                                         |       14 |      14 |     14 |
| Engine edge cases (transitions, animations, WAAPI, latency, scroll start, determinism) |       15 |      15 |     15 |
| GSAP adapter (incl. ScrollTrigger values and positions)                                |       24 |      24 |     24 |
| Anime.js adapter                                                                       |       23 |      23 |     23 |
| Lenis adapter                                                                          |       16 |      16 |     16 |
| Native scroll containers                                                               |       12 |      12 |     12 |
| Shadow DOM (unreleased, after `0.4.0-alpha`)                                           |       12 |      12 |     12 |
| CLI end to end                                                                         |       15 |      12 |     12 |
| Demo app: every intended change, nothing else (e2e)                                    |       15 |      15 |     15 |

The three CLI tests that only Chromium's run lists start all three engines in one project; they
run once, in the main CI job, where every engine is installed. The Windows job runs the other 12.

"Verified" means covered by automated tests against a real browser in this repository. Outside a
tested range, an adapter reports the engine as _untested_ and keeps running. How the engines
differ, and what is not supported, is in [Browser support](../browsers/support.md).
