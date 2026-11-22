# Changelog

All notable changes to MotionPR. The public package is `@erenthedeveloper0/motionpr`; the
workspace packages it bundles are versioned with it. Format:
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). MotionPR is an alpha: until `1.0`, any
prerelease may change the capture format or the API, and every such change is listed here.

## [Unreleased]

Motion inside shadow roots is recorded, identified through each component's host and compared
like the rest of the page, in open, closed, nested and declarative roots (roadmap: Shadow DOM).
`scroll` and `scrollTo` steps now find their elements with Playwright, like every other step, so
their selectors reach into shadow roots too. The adapter contract is frozen as adapter protocol 2,
with a conformance suite that custom adapters can run (`motionpr adapter check`), and what
adapters report is checked before it is written, so one malformed entry no longer makes a capture
unreadable (roadmap: adapter protocol 2). Capture schema and comparison schema stay at version 2:
the new fields are optional or have defaults, so 0.4 captures read unchanged, and custom adapters
written for 0.4 or earlier keep working as protocol 1 adapters.

### Added

- **Shadow roots.** The agent wraps `attachShadow` before page scripts run (open and closed
  roots), finds declarative open roots (`<template shadowrootmode="open">`) once the document is
  parsed, when a window opens and before each interaction, and asks each root directly for what
  does not leave it: its animations (`document.getAnimations()` leaves shadow trees out) and its
  `scroll`, `transitionrun`, `transitionstart` and `animationstart` events. CSS transitions, CSS
  animations and Web Animations inside components are recorded, waited for before checkpoints,
  frozen and replayed deterministically, and their non-lazy images are waited for after
  navigation.
- **Identity through the host.** An element inside a shadow root is identified within that root
  (an `id` or a label only has to be unique there; a path starts at the nearest identified
  ancestor in the root or at its top, `#shadow-root`) and prefixed with its host's identity:
  `test-id:plan-pro >> motionpr-id:glow`, selector
  `[data-testid="plan-pro"] >> [data-motionpr-id="glow"]` (Playwright's chaining operator;
  `:scope` stands for the host). It is as reliable as the less reliable of the two. Records carry
  the host's key as `element.shadowHost`. An element that a component re-renders while it
  animates is found again through its selector and replayed.
- **Scroll containers inside shadow roots** are recorded like any other
  (`native:test-id:inbox >> test-id:list:vertical`), whether a `scrollTo` or `wheel` step or the
  page scrolls them.
- **Staggers across components.** The same element of numbered components
  (`test-id:plan-1 >> …`, `test-id:plan-2 >> …`) is one stagger family:
  _Stagger interval 60ms → 120ms across 3 elements_.
- Findings name the hosts, then the element:
  _css-transition “opacity” on plan-pro >> glow: Duration 300ms → 450ms (+150ms, +50%)_.
- `settings.shadowRoots` in captures (`false` when read from older ones) and the optional
  `ElementIdentity.shadowHost`.
- A documentation page, [Shadow DOM and Web Components](docs/integrations/shadow-dom.md).
- Browser tests in Chromium, Firefox and WebKit (open, closed, nested and declarative roots,
  selectors Playwright resolves, a replaced element, an image added after load,
  `ignore.selectors` on a host, containers
  under `scrollTo`, `wheel` and the page, step selectors, two runs of one build, a changed
  duration and stagger, an old baseline), a GSAP and an Anime.js test with targets inside shadow
  roots, and unit tests for the comparison, the schema and selector parsing.
- **Adapter protocol 2.** `PROTOCOL_VERSION` is `2` and frozen until `1.0`: it changes only by
  optional additions whose absence keeps today's behaviour, and a change that would break a
  protocol 2 adapter gets a new number while the agent keeps accepting 2. Adapters declare it with
  `protocol: 2` (the GSAP, Anime.js and Lenis adapters do). The agent accepts protocols 1 and 2
  (`SUPPORTED_PROTOCOLS`); an adapter that declares another is not registered, and the scenario
  gets an `ADAPTER_PROTOCOL_UNSUPPORTED` error (instead of `ADAPTER_MISSING`) with a `failed` row
  in the adapter table.
- **`motionpr adapter check <page>`**, the adapter conformance suite. It loads a page that uses
  the adapter in Chromium, Firefox or WebKit (`--browser all`) and runs 21 checks: registration,
  protocol, metadata and capabilities; every entry `collect()` and `collectTimelines()` return;
  `collect()` without side effects; `isAnimating()` against the entries' own timing; `seek()` at
  0 %, 50 % and 100 % of each animation, twice; values held across frames during replay;
  `endReplay()` against a snapshot; no engine callbacks during replay (pages report them to
  `window.__MOTIONPR_CHECK__`); `seekProgress()`; `beginWindow()`; `scrollTo()` and
  `collectScroll()`; `claims()` against a foreign Web Animation; `diagnostics()`; the page without
  MotionPR; and a real capture, which must validate without adapter diagnostics. A local HTML file
  is served from its folder. Exit `1` when a check fails, `--json` for the report. The same suite
  is `checkAdapter()` in the API, with `ADAPTER_CHECKS` (stable check ids) and the
  `AdapterCheckOptions`, `AdapterCheckReport`, `AdapterCheckResult`, `AdapterCheckStatus`,
  `AdapterCheckSubject` and `AdapterCheckId` types.
- `adapters[].protocol` in captures (the protocol each adapter declared), and `motionpr doctor`
  shows it for every registered adapter and fails an adapter the agent refused.
- `PROTOCOL_VERSION`, `SUPPORTED_PROTOCOLS`, `AdapterClaim` and `ScrollState` are exported for
  typed custom adapters.
- [Custom adapters](docs/advanced/custom-adapters.md) is now the protocol 2 reference (members,
  capabilities, entry fields, rules, checking an adapter), with a new page for
  [`motionpr adapter`](docs/cli/adapter.md).
- Browser tests in Chromium, Firefox and WebKit: the agent with protocol 1, 2 and 3 adapters and
  invalid entries; the suite against a small engine whose `?bug=` switches each break one rule
  (every one fails the check that names it, and nothing else); the GSAP, Anime.js and Lenis
  adapters pass it; the CLI command's exit codes and JSON. Unit tests for every contract rule.

### Changed

- **`scroll` and `scrollTo` steps find their elements with Playwright**, like `click` and `hover`:
  their selectors reach into open shadow roots and may use Playwright's engines (`text=…`,
  `role=…`, `>>`). They take the first match, as before, and wait up to `capture.actionTimeout`
  for it to be attached instead of failing at once:
  _No element matches [data-testid=missing] (waited 10000 ms)._ The elements are found before
  the step's trigger time, so latency is measured as before.
- `ignore.selectors` also match the hosts of the shadow roots an element is in, and their
  ancestors: ignoring a component's host ignores everything inside it, also while MotionPR waits
  for motion to settle.
- Against a capture made before MotionPR looked inside shadow roots (`settings.shadowRoots`
  `false`), records inside shadow roots are first paired with its records by their key within
  the root, as fuzzy matches whose changes are all `uncertain` (that capture also replayed them
  without freezing the rest of the component). Animations and scroll containers it could not
  see, and its records that may be those under their old key, are `uncertain` instead of a
  `warning` (`animation-added`, `scroll-added`) or `critical` (`animation-removed`,
  `scroll-removed`): _… The baseline was captured before MotionPR looked inside shadow roots
  (MotionPR 0.4.0-alpha or earlier), so this is uncertain; capture it again to compare this
  animation._ A severity set for the rule still applies. A ScrollTrigger scroller inside a shadow
  root counts as the same scroller when only its host is missing from the old key.
- **What adapters report is checked.** An animation, timeline or scroll track whose fields do not
  have the documented types is left out of the capture with an `ADAPTER_RECORD_INVALID` warning
  that names the field (and points to `motionpr adapter check`); the adapter's other entries are
  kept. An entry whose id was already reported in the same `collect()` is left out too. Missing
  nullable fields (`name`, `target`, `startTime`, `duration`, a timeline's `name`, `startTime`
  and `progress`, a scroll track's `wrapper`) read as `null`. Malformed `diagnostics()` entries
  are left out with `ADAPTER_DIAGNOSTICS_INVALID`, and a `version`, `supportedRange` or
  capability that is not a string is ignored.
- The agent's `protocol` is `2`.

### Fixed

- CSS transitions and CSS animations inside shadow roots were not recorded, and checkpoints did
  not wait for them: `document.getAnimations()` leaves shadow trees out, and `transitionrun` and
  `animationstart` do not leave the root. The documentation said they were discovered.
- Web Animations inside shadow roots were recorded without their host: the instances of a
  component shared one key (told apart by `#2`, `#3` in start order), a path from the top of a
  root read as `path:body>…`, and their selectors did not find the element, so one that was
  re-rendered was not replayed. While MotionPR replayed a window, other animations inside shadow
  roots kept running.
- `scroll` and `scrollTo` steps could not reach elements inside shadow roots, and failed on the
  Playwright selector syntax that the documentation allowed for every step (`text=…`).
- One malformed entry from a custom adapter (a `duration` given as a string, an unknown
  `direction`, a missing `name`, a `meta` value that is an object) was written into the capture,
  and the whole capture then failed validation: `compare`, `run` and `baseline accept` refused
  it. A malformed diagnostic or a non-string engine version did the same.

### Upgrading

Baselines accepted with `0.4.0-alpha` or earlier did not look inside shadow roots. In checkpoints
with motion inside web components, comparisons against them report `uncertain` added and removed
records, and `uncertain` changes on the records paired by key, until a new baseline is accepted
(`npx motionpr baseline accept`). Keys of elements outside shadow roots are unchanged, and
nothing changes for pages without shadow roots. A `scroll` or `scrollTo` step whose selector
matches nothing now fails after `capture.actionTimeout` (10 s by default) instead of at once.

Custom adapters need no change: without `protocol` they are protocol 1 adapters, which have the
same members. Run `npx motionpr adapter check <page>` and declare `protocol: 2` once it passes.
Entries that used to make a capture unreadable are now left out with an `ADAPTER_RECORD_INVALID`
warning instead.

### Known limitations

- Declarative closed shadow roots, the browser's own shadow trees (form controls, media) and
  iframes are not observed.
- Steps and screenshot masks do not reach into closed shadow roots (Playwright does not pierce
  them): an input inside a closed root is not masked; mask its host instead.
- Elements slotted into a component are identified in the page's DOM, not through the host.
- While capturing, the agent polls every shadow root once per frame: 1,000 roots took 0.3 ms per
  frame in Firefox, 0.6 ms in Chromium and 1 ms in WebKit.
- Scroll tracks from custom adapters are recorded as `native` scroll motion (the capture format
  knows Lenis and native scrolling).
- The conformance suite has no steps: the page must start the engine's animations when it loads.
  Replay callbacks are checked only when the page reports them, and one adapter is checked per run.

## [0.4.0-alpha] — 2026-11-20

Where a GSAP ScrollTrigger animation runs in the scroll is compared from the `start` and `end`
positions ScrollTrigger resolved, so two runs of one build agree in every engine, also under
native smooth scrolling (roadmap: stable ScrollTrigger positions under native smooth scrolling).
The scroll motion of native scroll containers is recorded, compared and waited for like the
document's, and `wheel` steps can point at an element (roadmap: nested native scroll
containers). Capture schema and comparison schema stay at version 2, and the adapter protocol at
1: the new fields are optional or have defaults, so 0.3 captures and custom adapters work
unchanged.

### Added

- **ScrollTrigger positions.** Records of ScrollTrigger animations carry `scrollLink`, read from
  the ScrollTrigger instance's public, read-only state: the `start` and `end` scroll positions it
  resolved (px), its scroller (`null` for the document, otherwise the container's element key)
  and axis, `scrub` (`0` for `scrub: true`, the smoothing in ms for `scrub: <seconds>`, `null`
  without scrub) and, without scrub, its four `toggleActions`. Nothing is refreshed or replayed.
- **Comparison by resolved positions.** A moved `start` or `end` is reported once per animation:
  _Starts at scroll position 400px → 550px (+150px)_ (`scroll-start`/`scroll-end`, graded by the
  `scroll-position` rule with `comparison.scroll.positionTolerancePx` and `warnPositionPx`). A
  changed `scrub` or `toggleActions` is a scroll setting (`scroll-config`, `scroll-curve` rule):
  _Scroll setting scrub: on → 500ms_ (`info`; a `warning` when scrubbing is turned on or off).
  Positions on another scroller or axis are not compared: _Scroll-linked to document →
  test-id:panel_ (`warning`).
- Adapter protocol: optional `AdapterAnimation.scrollLink` for custom adapters with
  scroll-linked animations; `AnimationRecord.scrollLink` in captures. Public types
  `AdapterScrollLink` and `ScrollLink`.
- Browser tests in Chromium, Firefox and WebKit (recorded positions, two runs of one build with no
  finding at all, a moved start, `scrub` and `toggleActions` changes, a ScrollTrigger in a scroll
  container) and unit tests for the comparison and the schema.
- **Scroll containers.** Overflow elements that scroll get a `ScrollMotionRecord` each
  (`native:test-id:feed:vertical`, `sessionId: "container"`, the container as `wrapper`, its
  `scrollBehavior` and `scrollSnapType` as options), whether a step scrolls them (`scrollTo` with
  `selector`, `wheel`) or the page does (a carousel's "next" button, a chat log scrolling to its
  newest message). Before each interaction and when a window opens, the agent notes where every
  container rests (about 1 ms per 1,000 elements), so records start from rest; movement comes
  from the containers' scroll events, with no per-frame layout reads. A container that a scroll
  engine already records (a Lenis `wrapper`) is not recorded twice, and containers matched by
  `ignore.selectors` are skipped. Instant `scroll` steps stay state changes.
- **Settling waits for containers.** `waitForScrollSettled` and the settle before a checkpoint
  wait for every container that moved in the window or that a `scrollTo` step is scrolling.
- **`wheel` over an element.** `selector` puts the pointer at the centre of the element's visible
  part first (`position` is then relative to its top-left corner), so the wheel scrolls that
  container, or the Lenis instance whose `wrapper` it is. The step fails with a message when the
  element is outside the viewport (_wheel: … is outside the viewport at (116, 1000). Bring it
  into view first, e.g. with a scrollIntoView step._) or covered by another element.
- `capture.scrollContainers` (default `true`; `false` records the document scroller only) and
  `settings.scrollContainers` in captures, which reads as `false` for older captures.
- Browser tests in Chromium, Firefox and WebKit (a `scrollTo` and a `wheel` step in a container,
  page-driven motion, a container that begins to overflow during the window, two containers in
  one scenario, instant positioning, `ignore.selectors`, the opt-out, refused `wheel` points, two
  runs of one build, a changed destination and snapping, a baseline without containers), a Lenis
  test with a `wrapper`, and unit tests for the comparison and the schema.

### Changed

- When both captures have resolved positions, a ScrollTrigger animation's progress at the same
  scroll position is no longer compared. That comparison relates two live recordings (progress
  and scroll position), and under native smooth scrolling two runs of one build differed by up to
  11% in Firefox and 28% in WebKit. It stays the fallback when either capture has no positions.
- The demo app's moved journal parallax is reported as _Starts at scroll position 4028px →
  4268px (+240px)_, the same in all three engines, instead of as a progress difference.
- The GSAP adapter's info diagnostic `GSAP_SCROLLTRIGGER_OBSERVED` mentions the recorded
  positions.
- A scroll container recorded in only one capture is `uncertain` instead of a `warning`
  (`scroll-added`) or `critical` (`scroll-removed`) when the other capture could not record it:
  _… The baseline was captured without scroll-container recording (MotionPR 0.3.0-alpha or
  earlier, or capture.scrollContainers: false), so this is uncertain; capture it again to compare
  this scroller._ A severity set for the rule still applies.
- Easing-curve and peak-velocity differences of a native scroll whose positions reached the page
  unevenly (some frames without a new position, others with two) are `uncertain`, with the reason
  in the message. Firefox animates native smooth scrolling off the main thread and its positions
  arrive up to a frame late: two runs of one build differed by up to 19% in curve and 73% in peak
  velocity, which was reported as `info` or `warning`. Positions, duration and settling are
  compared as before, and Lenis is not affected.

### Fixed

- Native smooth scrolling read as unsettled in Chromium and WebKit (_Scroller had not settled
  when the checkpoint was captured; add a waitForScrollSettled step_, `uncertain`) even after
  `waitForScrollSettled`. Native positions are recorded when they change, so a scroll whose last
  frame still moved fast ended on a moving sample. When the scroller was still at the end of the
  window (unchanged for 100 ms), a final sample now records that.

### Upgrading

Baselines accepted with `0.3.0-alpha` or earlier have no `scrollLink`. Comparisons against them
keep comparing progress at the same scroll position, with its noise in Firefox and WebKit, until
a new baseline is accepted; nothing else changes for them.

They also have no scroll containers (`settings.scrollContainers` reads as `false`): scenarios
that scroll a container get an `uncertain` _New native scroll motion (native:…)_ until a new
baseline is accepted, and the new `capture.scrollContainers` key adds an `info`
`CONFIG_DIFFERS` note. Checkpoints now wait for containers to stop moving; a container that
scrolls by itself all the time (a ticker moved with `scrollLeft`) belongs in `ignore.selectors`.
`capture.scrollContainers: false` keeps the `0.3.0-alpha` behavior.

### Known limitations

- ScrollTriggers with `containerAnimation` have no positions (theirs lie along another animation,
  not the scroll) and keep the progress comparison.
- Scroll containers inside shadow roots or iframes are not recorded (their scroll events do not
  reach the page's document). A container added, or starting to overflow, after its window opened
  is `partial`: its position before the first scroll event was not observed.
- `scrollTo` steps do not drive a Lenis instance on a container; `wheel` over its `wrapper` does.
- Chromium on Windows jumps instead of animating `behavior: "smooth"` scrolls when the system's
  animation effects are off, as on GitHub's Windows runners. A `scrollTo` step records the jump;
  a smooth scroll the page starts after a click is then a state change, not scroll motion.

## [0.3.0-alpha] — 2026-11-20

The values GSAP ScrollTrigger animations write are sampled and compared (roadmap: scroll-linked
tween values), and the repository's CI runs on Windows (roadmap: Windows in CI). Capture schema
and comparison schema stay at version 2, and the adapter protocol at 1: every new field and
method is optional, so 0.2 captures and custom adapters work unchanged.

### Added

- **ScrollTrigger values.** Scroll-linked GSAP animations (`scrub` and `toggleActions`) are
  sampled at `capture.samples` evenly spaced progress values between the lowest and highest
  progress the page showed in the checkpoint, rendered with `totalTime(t, true)`. Scroll is still
  never replayed. A tween inside a scrubbed timeline is sampled in its own part of the timeline's
  progress. Each sample carries `scrollProgress`; its `windowTime` is when the page first showed
  that progress.
- **Comparison at the same scroll progress**, over the progress both captures reached, so a
  changed parallax distance, fade or color is found, not only a moved `start`/`end`: _Scroll-linked
  translateY differs by up to 120px at the same scroll progress (at 100%: -120px → -240px)_.
  Transforms and opacity use the `trajectory`, `size` and `opacity` thresholds, other properties
  the `keyframes` rule. A moved `start` alone changes progress, not these values, so it is reported
  once. Captures that reached no common progress get one `uncertain` finding.
- Completeness reasons for scroll-linked records: `partial` with _Sampled only where the scroll
  went: 50%–80% scroll progress (the animation runs from 50% to 100%)_, `metadata-only` when the
  scroll never reached the animation's part of the range.
- Adapter protocol: `AdapterAnimation.scrollRange` and `MotionprAdapter.seekProgress(id, progress)`
  for custom adapters with scroll-linked animations; `FrameSample.scrollProgress` in captures.
- Browser tests for ScrollTrigger (scrubbed tween and timeline, `toggleActions`, `scrub: 0.5`,
  partial and missed ranges, two runs of one build, changed distance and fade, moved start, replay
  safety) in Chromium, Firefox and WebKit, and unit tests for the comparison.
- **Windows in CI.** A `chromium on Windows` job runs the unit tests, the browser suites and the
  demo app's expected differences in Chromium on `windows-latest`, and installs and runs the packed
  package in a clean project.

### Changed

- While MotionPR renders a checkpoint at a time (filmstrip frames, the settled screenshot, other
  animations' samples), ScrollTrigger animations show the progress the page showed at that time.
- A checkpoint's motion window extends to the last progress change of a scroll-linked animation,
  such as a `toggleActions` tween still playing after the scroll stopped.
- ScrollTrigger records no longer carry the _metadata only (experimental)_ note: they are
  `complete` when the scroll covered their range. The GSAP adapter's info diagnostic
  `GSAP_SCROLLTRIGGER_METADATA_ONLY` is now `GSAP_SCROLLTRIGGER_OBSERVED`.
- Repeating ScrollTrigger animations (a `repeat` on the scroll-driven tween or timeline) keep
  timing and live progress only, with a note saying so.

### Fixed

- With `scrub: <seconds>`, ScrollTrigger smooths progress with an internal tween of the animation's
  `totalProgress`. It could be recorded as a GSAP animation without an element (seen in WebKit as
  an `uncertain` _Added: gsap on adapter:gsap:…_). It is no longer reported; settling still waits
  for it and replay still freezes it.
- The repository's packaging check and tests could not run on Windows: `scripts/pack-check.mjs`
  now runs npm, npx, pnpm and the installed bin through `cmd.exe` and no longer needs `cp`, the
  documentation checks compare `/`-separated page paths, and the CLI tests link the package with
  a junction instead of a directory symlink.

### Upgrading

Baselines accepted with `0.2.0-alpha` have no samples for ScrollTrigger animations. Comparisons
against them report the completeness change (`metadata-only → complete`) as `uncertain` and
compare no values; accept a new baseline to compare values. Code that looks for the GSAP
diagnostic `GSAP_SCROLLTRIGGER_METADATA_ONLY` should look for `GSAP_SCROLLTRIGGER_OBSERVED`.

### Known limitations

- Progress at the same scroll position under native smooth scrolling is noisy in Firefox and
  WebKit: two runs of one build differed by up to 11% (Firefox) and 28% (WebKit) in MotionPR's
  tests. This is unchanged from `0.2.0-alpha`; the new value comparison is stable in all three
  engines.
- Firefox and WebKit are not tested on Windows; Chromium is.

## [0.2.0-alpha] — 2026-11-15

Firefox and WebKit become supported browser engines next to Chromium, each with its own
baseline. Capture schema and comparison schema stay at version 2: the new fields have defaults,
so 0.1 captures and comparisons read unchanged.

### Added

- **Firefox and WebKit.** `browser.name` accepts `"chromium"`, `"firefox"` and `"webkit"`
  (Playwright 1.65's builds: Chromium 158.0.8127.18, Firefox 159.0, WebKit 27.2). One capture
  pipeline serves all three; the in-page agent uses only Web Animations and DOM features all
  three implement. Native CSS transitions and animations, Web Animations, the GSAP, Anime.js and
  Lenis adapters, and the CLI are tested in each engine, as is the demo app (every intended
  change found, nothing else).
- **Per-browser baselines, captures, comparisons and reports**: `.motionpr/baseline/<browser>/`,
  `captures/<browser>/`, `comparison/<browser>/`, `report/<browser>/`. A run compares each engine
  with its own baseline only; accepting one engine's baseline never touches another's; a capture
  can only become the baseline of the engine it was taken with.
- **Multi-browser runs**: `--browser all` (or `chromium,webkit`, repeatable) on `capture`,
  `compare`, `run` and `baseline accept`. Engines run one after another against one web server;
  the exit code combines them (`2` before `1` before `0`); an engine that fails to launch does not
  stop the others. `report/index.html` lists every engine's report with its result, and the step
  summary has a section per engine. JSON: `{ kind: "motionpr-run", browsers: [...] }`.
- **Cross-browser comparison on request**: `compare --against <browser>` and `--cross-browser`.
  Declared timing and easing are compared as usual; pixel, geometry, keyframe serialization,
  start-offset and scroll differences are `uncertain`; `crossBrowser: true` and a
  `CROSS_BROWSER_COMPARISON` diagnostic mark the result.
- **CLI**: `install [browsers...]` and `install --all`; `--browser` on `capture`, `compare`, `run`,
  `baseline accept`, `report`, `doctor` and `demo`; `MOTIONPR_BROWSER`; `baseline migrate`;
  `baseline status` lists every engine; `doctor` checks every engine's binary and launches the
  selected ones, reporting Web Animations support, timer resolution and frame rate.
- **Launch settings per engine**: Chromium channels (`chrome`, `msedge`) apply to Chromium,
  Firefox channels (`moz-firefox*`) to Firefox, `executablePath` and `args` to the engine in
  `browser.name`, and the new `browser.firefoxUserPrefs` to Firefox.
- **Runtime metadata in every capture**: `environment.browser.channel` and `userAgent`,
  `environment.osRelease`, and `environment.capabilities` (Web Animations features, timer
  resolution, frame interval, device pixel ratio, emulated reduced motion), all read from the
  browser at runtime. `COARSE_TIMERS`, `LOW_FRAME_RATE` and `BROWSER_API_MISSING` diagnostics
  explain how precisely an engine could be observed.
- Comparison diagnostics `CROSS_BROWSER_COMPARISON` and `DEVICE_SCALE_FACTOR_DIFFERS`; error codes
  `BROWSER_MISMATCH` and `BROWSER_DEPENDENCIES_MISSING` (actionable Linux hint).
- Public API: `BROWSER_NAMES`, `parseBrowserSelection`, `browserPaths`, `resolveBaselineDir`,
  `launchBrowser`, `isBrowserInstalled`, `startProjectServers`, `ENGINE_DEPENDENT_CHANGES`,
  `CaptureOptions.browserName`, `CaptureProjectOptions.browserName`, `allowCrossBrowser`, and the
  `BrowserName`, `BrowserPaths` and `BrowserCapabilities` types.
- Documentation: a Browsers section (browser support, cross-browser testing, Chromium, Firefox,
  WebKit) and updated CLI, configuration, CI and reference pages.
- CI runs the browser suites and the demo expectations in Firefox and WebKit, in a matrix next to
  the Chromium job.

### Changed

- **Storage layout.** Captures, comparisons and reports moved into per-engine directories (see
  above). Baselines in the 0.1 layout (`baseline/capture.json`) are still read as the Chromium
  baseline; `motionpr baseline migrate`, or the next `baseline accept`, moves them to
  `baseline/chromium/`. Commit the move. `report/index.html` is now the index of every engine's
  report; each engine's report is `report/<browser>/index.html`.
- `run --json` with one engine adds a `browser` field; `baseline status --json` adds `baselines`
  (per engine) next to `baseline`.
- Terminal output, Markdown summaries and the report's top bar name the engine of each capture.
- `--browser` has no built-in default any more: it falls back to `MOTIONPR_BROWSER`, then to
  `browser.name`.
- Scroll peak velocity is derived between samples observed while the scroller moves, over
  intervals of at least 12 ms. Comparisons of existing Chromium captures can report slightly
  different velocity figures (captures are unchanged).

### Fixed

- Replay seeked clones with times computed from absolute clock readings; float error could land a
  sample just below a `steps()` boundary, which Firefox resolved to the previous step, so the same
  build could sample differently between runs. Seeking now uses window-relative times rounded to
  1 µs, in every engine.
- An animation finished as soon as it was created (`el.animate(…).finish()`, a common
  reduced-motion fallback) was dropped as "started before the interaction" because `finish()`
  back-dates its start. It is now recorded with its timing (`finishedOnCreation`, no samples).
- Scroll settling with fractional scroll positions (Firefox) ended during the slow tail of a Lenis
  ease-out, a few pixels short of the destination; stillness is now judged by the drift over the
  still period.
- Peak scroll velocities derived from two samples 1 ms apart (1 ms timers in Firefox and WebKit)
  reached implausible values ("78 px/ms"), and timing the first move from the re-stamped rest
  sample made the same build's peak velocity differ by up to 90% between WebKit runs.
- With 1 ms timers, a scroller's last still sample and first moved sample can share a timestamp
  (Lenis in WebKit emits both in one millisecond). The moved one was kept as the rest position, so
  the same build's scroll seemed to start a frame's distance later (a false "Scroll starts at"
  warning, 87 px in the demo). The rest sample is now always one from before the movement.
- Firefox returns keyframe offsets in single precision (`0.4000000059604645`); offsets are rounded
  to 6 decimals.
- Trigger latency was measured from a checkpoint window's first interaction instead of the one
  that caused the motion. In "scrollIntoView, waitForAnimations, click" it included the settle wait,
  so two runs of the same build could differ by over 100 ms on a loaded machine (seen in WebKit on
  CI). It is now measured from the last interaction before the motion, which is also the recorded
  `window.trigger`. Latencies are compared only when both captures name the same trigger, so
  baselines from 0.1 do not report a latency change.
- Sampled path and end-value differences of an animation the app cancelled mid-way were graded
  like any other; where a cancelled animation stopped depends on when the cancel ran (a timer under
  load), so they are now `uncertain`. Declared timing changes stay definite.
- The report artifacts page listed a `comparison.json` in the report directory; it lives in
  `.motionpr/comparison/<browser>/`.

### Known limitations

- Only Playwright's builds are tested; WebKit is Playwright's WebKit, not Safari. Installed
  browsers work through `browser.channel` / `executablePath` but are not covered by tests.
- Engines in a multi-browser run run sequentially. Windows is not covered by CI for any engine.
- Headless WebKit renders at 30 fps on macOS and Firefox and WebKit report time in 1 ms steps, so
  live observations (start offsets, scroll samples) are coarser there.
- Cross-browser comparisons are investigative: engine-dependent differences are always
  `uncertain`.

## [0.1.0-alpha.1] — 2026-11-14

The project moved to [`github.com/erenthedeveloper0/motionpr`](https://github.com/erenthedeveloper0/motionpr)
and its website to [`erenthedeveloper0.github.io/motionpr`](https://erenthedeveloper0.github.io/motionpr/).
No change to the capture format, the API or the CLI's behaviour.

### Fixed

- The package's homepage, repository and issue links, the README's links and images, and the
  documentation links printed by the CLI point to the new addresses. In `0.1.0-alpha` they still
  point to `motion-pr`, and its website links no longer resolve.

## [0.1.0-alpha] — 2026-11-13

The first public release, published on npm's `alpha` dist-tag.

Two development versions came before it, `0.1.0-alpha.0` and `0.2.0-alpha.0`. Neither was
published or tagged, so this release collects their work and the version starts again at
`0.1.0-alpha`. Captures written by those builds (capture schema 1 and 2) are read and migrated.

### Added

- **Capture engine.** An in-page agent, injected before the app's scripts, that discovers CSS
  transitions, CSS animations and Web Animations (`document.getAnimations()` every frame and a
  wrapped `Element.prototype.animate`), waits for motion to settle, and replays each checkpoint
  window deterministically: native animations through paused clones, engines with callbacks
  muted. It samples computed styles, decomposed transforms and boxes, renders content-addressed
  filmstrip frames and a settled screenshot, and restores every animation afterwards.
- **Records** for the three kinds of motion: `AnimationRecord` (time → value),
  `TimelineRecord` (GSAP and Anime.js timelines with labels) and `ScrollMotionRecord` (time →
  position, recorded live, never replayed), with per-field provenance (`declared`, `observed`,
  `inferred`, `unavailable`) and correlations between scroll and animations.
- **GSAP adapter** (`@erenthedeveloper0/motionpr/gsap`): tweens, timelines, labels, staggers,
  keyframes, repeats, reversed playback and time scale; GSAP's own ease functions sampled, so any
  ease (CustomEase included) is compared exactly; ScrollTrigger animations as metadata plus a live
  progress trace; `dispose()` and `getDiagnostics()`.
- **Anime.js v4 adapter** (`@erenthedeveloper0/motionpr/animejs`): `wrapAnimate`, `wrapTimeline`,
  `wrapWaapi`, `track`, `dispose`. Per-target records for staggers (function values recorded
  transparently), timelines with labels, custom eases sampled without invented names, and
  `waapi.animate()` animations recorded once.
- **Lenis adapter** (`@erenthedeveloper0/motionpr/lenis`): `motionprLenis.attach(lenis)` records
  `actualScroll`, `animatedScroll`, `targetScroll`, velocity, direction and state without driving,
  reconfiguring or destroying Lenis.
- **Comparison engine.** Three-pass matching (exact, element, fuzzy); timing, easing curves (65
  samples, `compareEasingSamples`), iterations, direction, playback rate, fill, keyframe values,
  sampled trajectories, opacity and size; stagger intervals; timeline duration, repeat, speed and
  labels; scroll position, settle duration, normalized curve, peak velocity, overshoot and lag;
  scroll-linked progress at the same scroll position; pixelmatch of settled screenshots and
  per-frame divergence. Severities from named, overridable rules; low-confidence matches and
  incomplete data reported as `uncertain`.
- **Report viewer.** One offline HTML file: side by side, overlay, onion skin with motion paths,
  wipe, difference and pixel-diff modes; a shared timeline with delays, durations and easing
  curves, frame divergence, scroll and timeline lanes; an inspector with timing tables, easing
  curves and sampled values; a differences explorer with engine filters; keyboard navigation and
  a command menu; Markdown export.
- **CLI.** `init` (framework, package-manager and engine detection; optional GitHub workflow with
  SHA-pinned actions), `install`, `capture`, `compare`, `run`, `baseline accept|status`, `report`,
  `doctor` (including whether each adapter registers in the page) and `demo`. JSON and Markdown
  output, `$GITHUB_STEP_SUMMARY`, exit codes `0`/`1`/`2`, clean shutdown on Ctrl+C.
- **Scenario steps** for navigation, clicks, hovers, pointer moves, typing, key presses, instant
  and smooth scrolling (`scrollTo`, Lenis-aware), real wheel input, and waiting for animations or
  for scroll to settle.
- **Public API**: `defineConfig`, `loadConfig`, `captureProject`, `compareDirs`,
  `compareCaptures`, `writeReport`, easing and value helpers, schemas and types.
- **Demo app** with eleven deliberate motion changes across native CSS, WAAPI, GSAP, Anime.js and
  Lenis, captured by `motionpr demo`.
- **Website** (static, GitHub Pages) built on a real capture of the demo app: a landing page whose
  hero replays one animation's baseline and candidate on one clock, a scroll-driven walk through
  capture → analyze → compare → inspect → report, and the full differences explorer; 61
  documentation pages with search and live components embedded in them (engine demos, timelines,
  easing and scroll laboratories); an interactive demo of the demo app's two variants and its
  report; and a playground that grades changes with MotionPR's own comparison code in the
  browser. Soft navigation between pages, choreographed transitions, and full support for
  reduced motion and keyboard use.

### Security

- Capture and comparison files are validated when read, including asset ids and paths, so a
  capture downloaded from CI cannot make MotionPR read or write outside its directory.
- Reports embed data as inert JSON and render all text as text; they load nothing remote.
- Filled values are never written to captures or reports; inputs are masked in screenshots; query
  values in recorded URLs are redacted by default. MotionPR sends no telemetry.

[Unreleased]: https://github.com/erenthedeveloper0/motionpr/compare/v0.4.0-alpha...main
[0.4.0-alpha]: https://github.com/erenthedeveloper0/motionpr/releases/tag/v0.4.0-alpha
[0.3.0-alpha]: https://github.com/erenthedeveloper0/motionpr/releases/tag/v0.3.0-alpha
[0.2.0-alpha]: https://github.com/erenthedeveloper0/motionpr/releases/tag/v0.2.0-alpha
[0.1.0-alpha.1]: https://github.com/erenthedeveloper0/motionpr/releases/tag/v0.1.0-alpha.1
[0.1.0-alpha]: https://github.com/erenthedeveloper0/motionpr/releases/tag/v0.1.0-alpha
