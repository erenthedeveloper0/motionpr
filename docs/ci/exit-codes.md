---
title: CI exit codes
description: When motionpr exits 0, 1, 2, 130 or 143, and how to change it.
---

# CI exit codes

| Code  | Meaning                                                              |
| ----- | -------------------------------------------------------------------- |
| `0`   | Success; the comparison is within the configured thresholds          |
| `1`   | A difference reached `comparison.failOn` (or `--threshold`)          |
| `2`   | Configuration, execution or comparison error, including usage errors |
| `130` | Interrupted by Ctrl+C, after servers and the browser were stopped    |
| `143` | Interrupted by SIGTERM, after servers and the browser were stopped   |

## How `run` decides

| Situation                                             | Exit code                                                        |
| ----------------------------------------------------- | ---------------------------------------------------------------- |
| No difference at or above `failOn`                    | `0`                                                              |
| A difference at or above `failOn`                     | `1`                                                              |
| `failOnUncertain: true` and an uncertain difference   | `1`                                                              |
| A scenario failed in the candidate                    | `1` (`scenario-failed` is critical)                              |
| No baseline, locally                                  | `0`, with a capture-only report                                  |
| No baseline, in CI                                    | `2`, unless `--allow-missing-baseline`                           |
| Invalid config, browser missing, server did not start | `2`                                                              |
| Unknown `--browser` name                              | `2`                                                              |
| Baseline and candidate from different engines         | `2` (`BROWSER_MISMATCH`), unless `--against` / `--cross-browser` |

With several engines (`--browser all`), the run's exit code combines theirs: `2` if any engine
could not run (or, in CI, had no baseline), otherwise `1` if any engine exceeded `failOn`,
otherwise `0`. An engine that fails to launch does not stop the others.

`motionpr capture` exits `2` when any scenario failed. `motionpr baseline accept` exits `2` when
it refuses to replace a baseline without `--yes`.
`motionpr adapter check` exits `1` when a conformance check failed and `2` when the page could not
be checked (see [`motionpr adapter`](../cli/adapter.md#output-and-exit-codes)).

## Changing the threshold

```ts
comparison: {
  failOn: "warning";
} // critical | warning | info | never
```

```bash
npx motionpr run --threshold never   # report, never fail (exit 0 or 2)
```

`never` turns MotionPR into a reporting-only step: differences are listed and the report is
written, but only errors fail the job.
