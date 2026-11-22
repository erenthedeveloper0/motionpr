# Architecture

MotionPR turns motion into data, compares the data, and shows the difference. This page is the
map; the details are in [docs/advanced/architecture.md](docs/advanced/architecture.md) and the
schema sources.

```text
   your app in Chromium, Firefox or WebKit              Node.js
 ┌─────────────────────────────────────────┐   ┌──────────────────────────────────────┐
 │  agent (injected before page scripts)    │   │  runner (@motionpr/capture)           │
 │   ├ native: getAnimations, animate()     │◀──│   scenarios → steps → checkpoints     │
 │   └ adapters: GSAP · Anime.js · Lenis    │   │   settle → replay → sample → frames   │
 │      (public APIs; no-ops outside        │──▶│  normalize → capture.json + assets/   │
 │       a capture)                         │   └──────────────────────────────────────┘
 └─────────────────────────────────────────┘                    │
                                                                 ▼
                                    ┌──────────────────────────────────────┐
                                    │  comparison (@motionpr/comparison)    │
                                    │   match → compare → grade (rules)     │
                                    │   → comparison.json + diff images     │
                                    └──────────────────────────────────────┘
                                                                 │
                                                                 ▼
                                    ┌──────────────────────────────────────┐
                                    │  report (@motionpr/report)            │
                                    │   one offline HTML file + assets/     │
                                    └──────────────────────────────────────┘
```

## Packages

| Package                                  | Role                                                                                                                                 | Published                               |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------- |
| `packages/core`                          | Schemas (capture and comparison v2) and migrations, config schema and resolution, easing math, the adapter protocol, storage, errors | bundled                                 |
| `packages/capture`                       | The Playwright runner (one runner for Chromium, Firefox and WebKit) and the in-page agent                                            | bundled                                 |
| `packages/comparison`                    | Matching, animation/stagger/timeline/scroll comparison, severity rules, pixel diff                                                   | bundled                                 |
| `packages/report`                        | The report viewer (React, one HTML file) and its generator                                                                           | bundled                                 |
| `packages/adapters/{gsap,animejs,lenis}` | Browser-side engine adapters                                                                                                         | bundled as entry points                 |
| `packages/cli`                           | The `motionpr` CLI and the public entry points                                                                                       | **`@erenthedeveloper0/motionpr`**       |
| `apps/docs`                              | The website: landing page, documentation, interactive demo, playground                                                               | no                                      |
| `fixtures/demo-app`                      | The demo app with baseline and candidate variants                                                                                    | inside the package, for `motionpr demo` |

## Invariants

1. **Motion is data.** Every finding comes from recorded numbers: declared timing, 65-sample
   easing curves, sampled computed styles, recorded scroll positions, pixels.
2. **Replay is deterministic.** Captures sample at chosen times with callbacks muted and restore
   all state afterwards; the same build gives the same data.
3. **Scroll is observed, never replayed.** Replaying would re-run the application's handlers.
4. **Adapters use public APIs only**, record provenance instead of guessing, and do nothing when
   MotionPR is not capturing. What they report is checked against the adapter protocol: an
   entry that would make a capture unreadable is left out with a diagnostic, never written.
5. **Uncertainty is not a regression.** Weak matches and incomplete data are `uncertain`.
6. **Old captures keep reading.** Schema changes come with migrations.
7. **Captures are untrusted input.** They are validated, and reports never execute their data.
8. **One baseline per browser engine.** Captures, baselines, comparisons and reports are stored
   per engine; comparing two engines is explicit, and engine-dependent differences are then
   `uncertain`. A requested engine is never replaced by another.

## Where to start reading

- The agent: `packages/capture/src/agent/main.ts`
- Launching an engine: `packages/capture/src/browser.ts`; per-engine storage:
  `browserPaths()` in `packages/core/src/storage.ts`
- The adapter contract: `packages/core/src/protocol.ts` (adapter protocol 2), its rules as code in
  `packages/core/src/adapter-contract.ts`, and the conformance suite in
  `packages/capture/src/conformance.ts` with its in-page probe `packages/capture/src/agent/probe.ts`
- The data model: `packages/core/src/schema/capture.ts` and `comparison.ts`
- The comparison of one pair of animations: `packages/comparison/src/diff-animation.ts`
- The severity rules: `packages/comparison/src/severity.ts`
