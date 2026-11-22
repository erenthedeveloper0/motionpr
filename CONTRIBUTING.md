# Contributing to MotionPR

Thank you for considering it. MotionPR rests on one premise, _motion is behaviour, and behaviour
can be measured_, and the conventions below exist because it is easy to erode one
reasonable-looking change at a time: a guess presented as a measurement, a comparison that turns
uncertainty into a failure, an adapter that touches an engine's private state. Please read this
page, then [ARCHITECTURE.md](ARCHITECTURE.md), before opening a non-trivial pull request.

## Getting set up

Requirements: **Node.js ≥ 22.18** (the repository runs TypeScript sources directly; the
published package needs ≥ 22.12) and **pnpm** through Corepack. `.nvmrc` pins Node 24, which CI
uses.

```bash
git clone https://github.com/erenthedeveloper0/motionpr.git
cd motionpr
corepack enable
pnpm install
pnpm exec playwright install chromium firefox webkit   # add --with-deps on Linux
pnpm build                # agent bundle, report viewer, demo app, CLI
```

**The in-page agent is bundled into `packages/capture/src/agent/agent-bundle.generated.ts`.**
`pnpm build`, `pnpm test`, `pnpm test:integration` and `pnpm typecheck` regenerate it; running
`tsc` or a single package's tests directly does not. The CLI integration tests and the end-to-end
tests use `packages/cli/dist` and `packages/report/dist`: run `pnpm build` after changing the CLI
or the viewer, or you will be testing the previous build.

## Before you open a pull request

```bash
pnpm build
pnpm typecheck
pnpm lint && pnpm format:check
pnpm version:check
pnpm test                       # unit tests, no browser
pnpm test:integration           # real Chromium: capture engine, adapters, CLI, multi-engine runs
MOTIONPR_TEST_BROWSER=firefox pnpm test:integration   # the same suites in Firefox (or webkit)
pnpm test:e2e                   # demo app captured for real; report viewer and website driven like a user
MOTIONPR_E2E_BROWSERS=all pnpm exec playwright test e2e/demo-expectations.spec.ts   # the demo in every engine
pnpm pack:check --install       # what ships to npm, installed into a clean project
```

| Command                           | What it runs                                                                                                                                                                   |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm typecheck`                  | `tsc` for every package (regenerates the agent bundle first)                                                                                                                   |
| `pnpm lint` / `pnpm format:check` | ESLint / Prettier                                                                                                                                                              |
| `pnpm test`                       | Unit tests, including the documentation checks                                                                                                                                 |
| `pnpm test:integration`           | Real-browser tests: capture engine, adapters, CLI. `MOTIONPR_TEST_BROWSER` picks the engine (default `chromium`); the default run also starts all three engines in one project |
| `pnpm test:e2e`                   | Captures the demo app; drives the report viewer and the website                                                                                                                |
| `pnpm pack:check`                 | Packs the public package and verifies its contents and entry points                                                                                                            |
| `pnpm bench`                      | Performance measurements of comparison and report building                                                                                                                     |
| `pnpm dev:docs`                   | Builds and serves the website on `http://localhost:4321/motionpr/`                                                                                                             |

## The conventions

These are not style preferences. A pull request that breaks one needs an argument in its
description, not a workaround.

1. **A claim needs a test.** A compatibility claim in the docs needs a real-browser test. A
   documented option, step, command or export must exist, and `scripts/tests/docs.test.ts` fails
   when one is missing from the docs or when a config example stops validating.
2. **Uncertainty is not a regression.** When MotionPR cannot be sure (an element matched by DOM
   position, partial capture data, an easing it cannot evaluate), the difference is `uncertain`
   and never fails a run unless the user asks for it.
3. **Adapters read public APIs only.** They instrument at creation time when an engine keeps
   per-target timing private, record provenance (`declared` / `observed` / `inferred` /
   `unavailable`) instead of guessing, never re-fire application callbacks, never change engine
   options, and leave every engine exactly as they found it after replay. Each adapter change
   comes with a lifecycle test, and the adapter keeps passing the conformance suite
   (`motionpr adapter check`, run by its integration tests in every engine).
4. **Scroll is observed, never replayed.** Replaying scroll would re-run the application's
   scroll handlers. Scroll motion is a `ScrollMotionRecord`, not an animation with a duration.
5. **Every bug fix gets a regression test**, written to fail against the bug first.
6. **Schema changes bump the schema version** and add a migration in
   `packages/core/src/schema/parse.ts`. Old captures must keep reading.
7. **Assert on numbers, not on formatted text**, for anything frame-quantized: start offsets vary
   by about 0.1 ms between runs.
8. **The website shows real data.** Visualizations read `apps/docs/data/site-data.json`, which is
   extracted from real captures (`pnpm --filter @motionpr/docs data`). Anything illustrative is
   labelled as such.

## Code style

- TypeScript with `strict`. Match the comment density of the file you are in; comments explain
  _why_, usually by naming the failure the code prevents.
- Prettier formats everything (`pnpm format`); ESLint checks the rest.

## Commits and sign-off

MotionPR uses the [Developer Certificate of Origin](https://developercertificate.org/) rather than
a CLA. Sign off every commit:

```bash
git commit -s -m "comparison: grade stagger changes against the group's duration"
```

The sign-off certifies that you wrote the change, or otherwise have the right to submit it under
the project's MIT licence.

## Reporting bugs and proposing changes

- **Bugs:** open an issue with a minimal reproduction: a scenario, a small page or the relevant
  animation code, and the output of `npx motionpr doctor`.
- **Security issues:** never in a public issue. See [SECURITY.md](SECURITY.md).
- **Features:** start with an issue that describes the problem and the alternatives you
  considered. Check [ROADMAP.md](ROADMAP.md) first; it may already be planned.
- **Releases** are made by the maintainer, by hand: `pnpm release:prepare` builds and
  verifies the tarball that gets published. No workflow publishes to npm.

When your first pull request is merged, add yourself to [CONTRIBUTORS.md](CONTRIBUTORS.md).

By participating you agree to abide by the [Code of Conduct](CODE_OF_CONDUCT.md).
