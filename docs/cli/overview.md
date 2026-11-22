---
title: CLI overview
description: The motionpr command, its global options, output modes and exit codes.
---

# CLI overview

```bash
npx motionpr <command> [options]
```

| Command                   | What it does                                                                                                 |
| ------------------------- | ------------------------------------------------------------------------------------------------------------ |
| [`init`](init.md)         | Create `motionpr.config.ts` with a guided setup                                                              |
| [`install`](install.md)   | Download Chromium, Firefox or WebKit for MotionPR                                                            |
| [`capture`](capture.md)   | Capture the configured scenarios                                                                             |
| [`compare`](compare.md)   | Compare two captures and generate the report                                                                 |
| [`run`](run.md)           | Capture, compare with the baseline, report: the everyday command                                             |
| [`baseline`](baseline.md) | Approve a capture as its engine's baseline (`accept`), show them (`status`), move a 0.1 baseline (`migrate`) |
| [`report`](report.md)     | Open the most recent report, regenerating it if needed                                                       |
| [`doctor`](doctor.md)     | Check Node.js, the browsers, the config, permissions and adapters                                            |
| [`demo`](demo.md)         | Capture the bundled demo app in two versions and open a real report                                          |
| [`adapter`](adapter.md)   | Check a custom adapter against adapter protocol 2 (`check`)                                                  |

## Global options

| Option                | Description                                                                                   |
| --------------------- | --------------------------------------------------------------------------------------------- |
| `-c, --config <path>` | Config file (default: `motionpr.config.{ts,mts,cts,js,mjs,cjs}` in the working directory)     |
| `--cwd <dir>`         | Run as if started in `<dir>`                                                                  |
| `--env <name>`        | Apply `environments[name]` from the config (also `MOTIONPR_ENV`)                              |
| `--json`              | Machine-readable result on stdout; human output goes to stderr                                |
| `-q, --quiet`         | Only print errors                                                                             |
| `--verbose`           | Print diagnostics and debug details (and error causes)                                        |
| `--no-color`          | Disable colours (also `NO_COLOR=1`; `FORCE_COLOR=1` forces them)                              |
| `--ci`                | Non-interactive CI mode (also detected from `CI`, `GITHUB_ACTIONS`, `GITLAB_CI`, `BUILDKITE`) |

`capture`, `compare`, `run`, `baseline accept`, `report`, `doctor`, `demo` and `adapter check`
also take `--browser <name>`: `chromium`, `firefox`, `webkit`, `all`, or a comma list
(repeatable). Without it, the engine is `MOTIONPR_BROWSER` or the config's `browser.name`
(Chromium for `adapter check`, which reads no config). See
[Cross-browser testing](../browsers/cross-browser-testing.md).
| `-v, --version` | Print the version |
| `-h, --help` | Help for any command |

MotionPR never prompts in CI or when stdin or stderr is not a terminal. Where it would ask, it
takes the safe answer and says which flag confirms the action: `baseline accept` refuses to
replace a baseline without `--yes` (exit `2`), and `init` leaves an existing config untouched
without `--force`.

## Exit codes

| Code          | Meaning                                                                             |
| ------------- | ----------------------------------------------------------------------------------- |
| `0`           | Success; the comparison is within the configured thresholds                         |
| `1`           | A configured regression threshold was exceeded (`comparison.failOn`, `--threshold`) |
| `2`           | Configuration, execution or comparison error, including usage errors                |
| `130` / `143` | Interrupted by Ctrl+C / SIGTERM, after servers and the browser were shut down       |

See [CI exit codes](../ci/exit-codes.md) for how `run` decides between them.

## JSON output

With `--json`, a command prints exactly one JSON document to stdout:

| Command                        | Shape                                                                                                                                      |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `run`, `compare`               | The [`ComparisonResult`](../advanced/capture-serialization.md#comparison-result) plus `report` (and `browser`, `capture` for `run`)        |
| `run` without baseline         | `{ status: "no-baseline", browser, capture, report }`                                                                                      |
| `run` with several engines     | `{ kind: "motionpr-run", exitCode, reportIndex, browsers: [{ browser, status, exitCode, capture, report, summary, differences, error }] }` |
| `compare` with several engines | `{ kind: "motionpr-comparisons", comparisons: [ComparisonResult + report] }`                                                               |
| `capture`                      | `{ id, dir, browser, scenarios: [{ key, status, checkpoints, error }] }`; several engines: `{ captures: [ … ] }`                           |
| `baseline status`              | `{ baseline, baselines: { chromium, firefox, webkit } }`                                                                                   |
| `doctor`                       | `{ ok, checks: [{ name, status, detail, fix }] }`                                                                                          |
| `adapter check`                | `{ page, url, browser, browserVersion, adapter, checks, passed, counts }`; several engines: `{ passed, reports: [ … ] }`                   |
| errors                         | `{ error: { code, message, hint, issues } }`                                                                                               |

```bash
npx motionpr run --json > motionpr.json; echo "exit $?"
jq '.summary.counts' motionpr.json
```
