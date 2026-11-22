---
title: Architecture
description: How the agent, adapters, replay, normalization, comparison and report fit together, and where each lives in the repository.
---

# Architecture

## Packages

```text
packages/core          schemas (capture/comparison v2), config, easing math, adapter protocol, storage
packages/capture       Playwright runner + the in-page agent (src/agent, bundled into the runner)
packages/comparison    matching, animation/scroll/timeline comparison, severity, visual diff
packages/report        offline report viewer (React, one HTML file) + generator
packages/adapters/*    gsap, animejs, lenis: browser code, published as @erenthedeveloper0/motionpr/<name>
packages/cli           the motionpr CLI and the public entry points; the only published package
fixtures/demo-app      the demo site with baseline and candidate variants (every engine)
apps/docs              this website
```

Only `packages/cli` is published. It bundles the private workspace packages (`@motionpr/*`) and
keeps third-party dependencies external.

## Browsers

One capture pipeline serves all three engines. `launchBrowser()` (`packages/capture/src/browser.ts`)
picks Playwright's `chromium`, `firefox` or `webkit` browser type and the launch settings that
belong to that engine; there is no per-engine runner and no engine-specific agent. The agent
relies only on the Web Animations API and DOM features all three engines implement
(`document.getAnimations()`, `Element.animate()`, `KeyframeEffect`, `CSSTransition`,
`CSSAnimation`, `transitionrun`), and measures what the engine offers
(`environment.capabilities`) in the first captured page. Where engines differ (timer
resolution, frame rate, fractional scroll positions, float precision of keyframe offsets), the
agent normalizes or records the difference instead of branching on the engine; see
[Browser support](../browsers/support.md#how-the-engines-differ).

Storage is per engine (`browserPaths()` in `@motionpr/core`): baselines, captures, comparisons
and reports live in `<dir>/<browser>/`, and `compareCaptures()` refuses captures of two engines
unless `allowCrossBrowser` is set, in which case `ENGINE_DEPENDENT_CHANGES` are graded
`uncertain`.

## The capture pipeline

1. **Agent.** Before any page script runs, Playwright injects MotionPR's agent
   (`window.__MOTIONPR_AGENT__`). It discovers native animations (CSS transitions, CSS
   animations, Web Animations) by polling `document.getAnimations()` every frame and patching
   `Element.prototype.animate`, and records interaction triggers. Shadow roots keep their
   animations and non-composed events (`scroll`, `transitionrun`, `animationstart`) to
   themselves, so the agent wraps `attachShadow`, finds declarative open roots when it scans the
   page, and polls and listens to each root directly (`packages/capture/src/agent/shadow.ts`,
   unreleased, after `0.4.0-alpha`). Elements in a root are identified through its host.
2. **Adapters** for JavaScript engines (GSAP, Anime.js, Lenis, custom) register with the agent
   from inside the app. They implement one contract (`MotionprAdapter` in
   `@motionpr/core/protocol`): `collect()` animations, and optionally `collectTimelines()`,
   `collectScroll()`, `claims()` for native animations their engine created, deterministic
   `beginReplay()` / `seek()` / `endReplay()`, `scrollStates()` for settle detection,
   `scrollTo()` for scroll steps and `diagnostics()`. Their public handles add `dispose()`. The
   contract is adapter protocol 2 (unreleased, after `0.4.0-alpha`); the agent checks what
   adapters report against it (below).
3. **Windows.** Each checkpoint closes a window that opened at the previous checkpoint. The
   window origin is the first motion after the first interaction: the earliest animation start
   or the first frame of scroll movement. Motion that began before the interaction belongs to
   the previous state and is excluded (with a diagnostic). An animation created after the
   interaction but finished at once (`animate(…).finish()`) keeps its timing without a start.
4. **Settling.** A checkpoint waits until no finite animation runs, no smooth scroll is
   advancing, and nothing new started for `capture.settleTime`. Scroll counts as still when its
   drift over the still period stays below the threshold, not each frame's step (Firefox scrolls
   by fractions of a pixel).
5. **Replay.** Native animations are replayed by cloning them (`target.animate(keyframes,
timing)`) and seeking the paused clones, so the originals never re-dispatch
   `transitionend`/`animationend`/`finish`. Adapters render their engines at exact times with
   callbacks muted (GSAP `totalTime(t, true)`, Anime.js `seek(t, true)`). Clones are seeked in
   window-relative time rounded to 1 µs, so a sample at a `steps()` boundary is the same in every
   run and every engine. Everything else is frozen. Samples (computed styles, transforms, geometry) and filmstrip frames are taken at
   deterministic times, then all state is restored.
6. **Scroll** is never replayed. Scroll motion is observed live (Lenis events, the document's
   native position each frame, and, since `0.4.0-alpha`, each scroll container's
   position at its scroll events, with its rest position noted before each interaction) and
   stored as `ScrollMotionRecord`s. Scroll-linked animations (CSS scroll
   timelines, GSAP ScrollTrigger) are recorded as metadata plus, for GSAP, a live progress trace.
   An adapter that reports an animation's `scrollRange` and implements `seekProgress()` (GSAP,
   since `0.3.0-alpha`) has it sampled at evenly spaced progress values between the
   lowest and highest observed progress; time-based seeks show the progress observed at that
   time. Where such an animation runs in the scroll is read from its engine (`scrollLink`: the
   `start`/`end` ScrollTrigger resolved, `scrub`, `toggleActions`; since
   `0.4.0-alpha`), so comparing it does not depend on how either run's scroll was scheduled.
7. **Normalization** (Node side) assigns stable ids (`<element key>::<type>::<name>`), links
   animations to `TimelineRecord`s, computes completeness and correlations, and writes the
   capture bundle (see [Capture serialization](capture-serialization.md)).

Limitations of the approach are listed in each integration guide and in
[Troubleshooting](troubleshooting.md) and [Limitations](limitations.md).

## Adapter protocol and conformance

The protocol's rules live as code in `@motionpr/core/adapter-contract` (dependency-free, so it
runs in the page): `animationProblems()`, `timelineProblems()`, `scrollTrackProblems()`,
`diagnosticProblems()` and `adapterProblems()` grade each problem `invalid` (the entry would make
the capture unreadable), `violation` or `advice`. The agent uses them on everything an adapter
reports: `invalid` entries are left out with an `ADAPTER_RECORD_INVALID` diagnostic, the rest is
recorded, and an adapter that declares an unsupported protocol is not registered
(`ADAPTER_PROTOCOL_UNSUPPORTED`). Third-party adapters are untrusted input, like captures.

The conformance suite ([`motionpr adapter check`](../cli/adapter.md),
`packages/capture/src/conformance.ts`) uses the same rules. It injects a probe after the agent
(`packages/capture/src/agent/probe.ts`, bundled with the agent but never loaded by captures),
which wraps `registerAdapter` to reach the adapter object and calls it directly: `collect()`
every frame, `isAnimating()` against the entries' timing, replay at 0 %, 50 % and 100 % of each
animation with values read from computed styles, a held seek across frames, `endReplay()` against
a snapshot, `beginWindow()`, `scrollTo()`, `claims()` with a Web Animation of its own. It then
loads the page without MotionPR and as a real capture (`runCapture()` with the adapter required).
MotionPR's own test suites run it against the GSAP, Anime.js and Lenis adapters in all three
engines, and against a small engine whose `?bug=` switches break one rule each.

## Comparison and report

`@motionpr/comparison` reads two capture bundles, matches records
([Animation identification](../features/animation-identification.md)), compares each pair, grades
each change with a rule ([Severity](../features/severity.md)), diffs screenshots with pixelmatch and
writes `comparison.json`. `@motionpr/report` copies a prebuilt viewer (React, Tailwind, fonts,
inlined into one HTML file) and embeds both captures and the comparison as inert JSON. Frames stay
separate files in `assets/`.
