---
title: motionpr adapter
description: Check a custom animation-engine adapter against adapter protocol 2 with the conformance suite.
---

# `motionpr adapter`

Tools for writing [custom adapters](../advanced/custom-adapters.md). Since `0.5.0-alpha`.

## `motionpr adapter check`

```bash
npx motionpr adapter check <page> [--adapter <name>] [--script <file>] [--browser <name>]
```

Runs the adapter conformance suite: it checks an adapter against
[adapter protocol 2](../advanced/custom-adapters.md#protocol-2) in a real browser, the way a
capture uses it. `<page>` is an `http(s)` URL, or the path of a local HTML file, which is served
from its folder on `127.0.0.1` (so module scripts and relative imports load as they do from a dev
server; a `?query` after the path is kept). The command does not read `motionpr.config.ts`.

The page must use the adapter and **start at least one animation of the engine when it loads**:
the suite has no steps to click. A test page with a few tweens is enough; the first-party adapters
are checked with such pages in MotionPR's own test suites.

| Option             | Description                                                                                                       |
| ------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `--adapter <name>` | The adapter to check (default: the only one the page registers)                                                   |
| `--script <file>`  | A script that registers the adapter, injected before page scripts (like `adapters`)                               |
| `--browser <name>` | `chromium`, `firefox`, `webkit`, `all`, or a comma list (repeatable; default `MOTIONPR_BROWSER`, else `chromium`) |
| `--timeout <ms>`   | How long to wait for registration, for motion and for settling (default `10000`)                                  |
| `--headed`         | Show the browser window                                                                                           |

The page is loaded three times: with MotionPR's agent and the suite's probe, which call the
adapter directly; without MotionPR, where the adapter must do nothing; and as a real capture with
the adapter `required`, which must validate and record no adapter diagnostics.

### Checks

Every check ends `pass`, `warn`, `fail` or `skip`. Warnings and skipped checks do not fail the run;
a check is skipped when the adapter does not implement what it tests (for example `claims()`), or
the page has nothing for it (for example no scroll-linked animation).

| Check                  | Fails when                                                                                                                |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `registration`         | Nothing registers within the timeout, or the agent refuses the adapter                                                    |
| `protocol`             | The adapter declares a protocol this MotionPR does not support (warns when none is declared: it is treated as protocol 1) |
| `metadata`             | `version` or `supportedRange` is not a string, or the range does not parse (warns when they are missing)                  |
| `capabilities`         | A declared capability lacks its methods, or is unknown (warns when implemented methods are not declared)                  |
| `motion`               | `collect()` reports no valid animation within the timeout (skipped for adapters without the `animations` capability)      |
| `animations`           | An entry of `collect()` breaks the protocol; `invalid` entries are the ones captures leave out                            |
| `collect-stable`       | Two `collect()` calls in a row report different animations                                                                |
| `timelines`            | A timeline entry breaks the protocol, or an animation's `parent` names a timeline that is never reported                  |
| `settling`             | `isAnimating()` is false while a finite animation runs, or stays true after they end (warns when not implemented)         |
| `replay-renders`       | `seek()` changes no sampled value at 0 %, 50 % and 100 % of the animations' active phases                                 |
| `replay-deterministic` | Seeking one time twice renders different values                                                                           |
| `replay-holds`         | Values change during the frames between seeks (the engine kept playing during replay)                                     |
| `replay-restores`      | After `endReplay()`, animations at rest show other values than before `beginReplay()`                                     |
| `replay-callbacks`     | The page's engine callbacks fire during replay (skipped unless the page reports its callbacks, below)                     |
| `seek-progress`        | `seekProgress()` does not render scroll-linked animations by progress                                                     |
| `window`               | After `beginWindow()`, `collect()` still reports animations that ended before the window opened                           |
| `scroll`               | Scroll tracks or states break the protocol, or `scrollTo()` scrolls but `collectScroll()` records nothing                 |
| `claims`               | `claims()` claims a Web Animation the engine did not create                                                               |
| `diagnostics`          | `diagnostics()` returns malformed entries (captures leave them out)                                                       |
| `without-agent`        | The page throws, or `window.__MOTIONPR_AGENT__` exists, when MotionPR is not capturing                                    |
| `capture`              | A real capture does not validate, or records adapter diagnostics (`ADAPTER_*`) or uncaught page errors                    |

To check that replay fires no callbacks, have the test page report its engine callbacks to the
suite. The hook exists only while the suite runs, so the page works unchanged elsewhere:

```js
tween(el, {
  x: 120,
  onUpdate: () => window.__MOTIONPR_CHECK__?.callback(),
  onComplete: () => window.__MOTIONPR_CHECK__?.callback(),
});
```

### Output and exit codes

```text
◐ motionpr 0.5.0-alpha  ·  adapter check

  my-engine  protocol 2 · engine 2.3.0 (tested >=2.0.0 <3.0.0)
  Chromium 158.0.8127.18 · test/motion.html

  ✔ registration          Registered as "my-engine".
  ✔ protocol              Declares adapter protocol 2.
  …
  ✖ replay-restores       endReplay() left the page as replay rendered it.
        "t1": {"transform":"matrix(1, 0, 0, 1, 120, 0)"} before replay, {"transform":"matrix(1, 0, 0, 1, 60, 0)"} after endReplay().
  …
  ✖ 1 check failed in Chromium (16 passed, 0 warnings, 4 skipped).
```

| Exit | Meaning                                                                                       |
| ---- | --------------------------------------------------------------------------------------------- |
| `0`  | No check failed in any engine                                                                 |
| `1`  | A check failed                                                                                |
| `2`  | The page could not be loaded, several adapters registered without `--adapter`, or bad options |

With `--json`, stdout holds the report: `{ page, url, browser, browserVersion, adapter, checks,
passed, counts }`, where each check is `{ id, title, status, summary, details }`; with several
engines, `{ passed, reports: [ … ] }`. The same report comes from
[`checkAdapter()`](../advanced/public-api.md#checkadapteroptions) in scripts and test suites.

```bash
npx motionpr adapter check ./test/motion.html --browser all
npx motionpr adapter check http://localhost:5173/motion-test --adapter my-engine --json > check.json
npx motionpr adapter check ./fixture.html --script ./dist/my-engine-adapter.js
```
