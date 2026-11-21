---
title: Capture serialization
description: The capture.json and comparison.json formats, schema versions, migrations and validation of untrusted files.
---

# Capture serialization

A capture is a directory with `capture.json` and `assets/` (content-addressed PNG/JPEG frames
and screenshots, `assets/<sha256 prefix>.png`). The JSON is validated with the schemas in
`@motionpr/core` (`captureBundleSchema`, `comparisonResultSchema`) whenever it is read.

**Current versions:** capture schema **2**, comparison schema **2**, report schema 1.

```text
CaptureBundle
├─ environment                browser { name, version, headless, channel, userAgent }, platform,
│                              arch, osRelease, node, playwright, ci, capabilities
├─ settings, configHash
├─ assets: { "<id>.png": { file: "assets/<id>.png", width, height, bytes } }
└─ scenarios[]: ScenarioResult
   ├─ adapters[]: AdapterStatus        (id, engineVersion, supportedRange, versionStatus, status, capabilities, diagnostics)
   ├─ steps[], diagnostics[]
   └─ checkpoints[]: Checkpoint
      ├─ window (origin, trigger, latency, end, capped)
      ├─ animations[]: AnimationRecord (type, source, driver, provenance, parent, timing,
      │                                  properties, samples[]: FrameSample, progressTrace, …)
      ├─ timelines[]: TimelineRecord   (duration, iterations, labels, children, …)
      ├─ scrollMotion[]: ScrollMotionRecord (axis, wrapper, config, samples[]: ScrollSample, …)
      ├─ correlations[]: { scroll, animation, kind: "scroll-linked" | "overlap", overlapMs }
      └─ frames[], screenshot
```

Field-level documentation lives in the schema source (`packages/core/src/schema/*.ts`), where
every field has a comment.

## Comparison result

`comparison.json` (`kind: "motionpr-comparison"`, schema version 2):

```text
ComparisonResult
├─ baseline, candidate        capture refs: id, createdAt, motionprVersion, browser, browserName,
│                              platform, configHash
├─ crossBrowser               true when baseline and candidate come from different engines
├─ failOn, failOnUncertain
├─ summary                    status (passed | failed), highestSeverity, counts per severity,
│                             scenario and animation counts
├─ scenarios[]: ScenarioComparison
│  └─ checkpoints[]: CheckpointComparison
│     ├─ animations[]         AnimationComparison: status, match, changes[], easing analysis
│     ├─ stagger[], timelines[], scroll[]
│     ├─ visual               pixelmatch result of the settled screenshots
│     ├─ frameDivergence[]    per-frame pixel ratio
│     └─ latency
├─ differences[]              flat, report-friendly list: severity, category, title, detail, source
└─ assets, diagnostics
```

Each `Change` carries `kind`, `before`, `after`, `delta`, `unit`, `measurement`, `severity`,
`message` and the `rule` that graded it. `differences` is the same information flattened for
lists, filters and the Markdown summary; it is what `--json` consumers usually read.

## Provenance

Records carry `provenance`, a map from field name to how the value was obtained: `declared`
(public API or parameters), `observed` (measured while the page ran), `inferred` (derived from
other values) or `unavailable` (not public; MotionPR did not guess).

## Versioning and migrations

Readers accept older versions and migrate them in memory (`CAPTURE_MIGRATIONS`,
`COMPARISON_MIGRATIONS`). Version 1 → 2 adds `driver`, `provenance`, `parent` and
`progressTrace` to animations, `timelines`, `scrollMotion` and `correlations` to checkpoints and
`adapters` to scenarios; v1 files contain no such data, so the new collections start empty.
Files newer than the installed MotionPR are rejected with an actionable error.

MotionPR 0.2 added fields without changing the schema version, each with a default when it is
missing: `environment.browser.channel` and `userAgent` (`null`), `environment.osRelease` and
`environment.capabilities` (`null`), and in comparisons `browserName` (`"chromium"`, the only
engine before 0.2) and `crossBrowser` (`false`). Captures and comparisons from 0.1 read
unchanged; 0.1 ignores the new fields when it reads 0.2 files.

MotionPR 0.3 added optional `samples[].scrollProgress`. MotionPR 0.4 adds optional `scrollLink`
to animation records (where a scroll-linked animation runs in the scroll, see
[Capture data model](../features/capture-data-model.md#animationrecord)). Both are absent from
older captures, which read unchanged; `0.3.0-alpha` ignores `scrollLink`. MotionPR 0.4 also adds
`settings.scrollContainers`, which reads as `false` when it is missing, because older captures
recorded no scroll containers; `0.3.0-alpha` ignores it. Scroll container records use
the existing `ScrollMotionRecord` shape (`wrapper` set, `sessionId: "container"`).

The unreleased version after `0.4.0-alpha` adds optional `element.shadowHost` (the host's key, for
elements inside shadow roots) and `settings.shadowRoots`, which reads as `false` when it is
missing: older captures did not look inside shadow roots, and a comparison treats what they
could not see as `uncertain` ([Shadow DOM](../integrations/shadow-dom.md#upgrading-from-040-alpha)).
`0.4.0-alpha` ignores both. The capture schema stays at version 2.

## Untrusted input

Captures may come from CI artifacts of pull requests. Asset ids and paths are validated
(`^[A-Za-z0-9_-]+\.(png|jpe?g)$`, `assets/<id>`), so a capture cannot make MotionPR read or write
outside its directory. Reports embed data as inert JSON (`<` escaped), never as code.
