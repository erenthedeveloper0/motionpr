---
title: motionpr baseline
description: Approve a capture as its engine's baseline, show every engine's baseline, or migrate a 0.1 baseline.
---

# `motionpr baseline`

## `motionpr baseline accept`

```bash
npx motionpr baseline accept [options]
```

Approves a capture as the new baseline of the engine it was taken with, in
`.motionpr/baseline/<browser>/`. It prints the capture being approved and the baseline it
replaces, asks for confirmation when a baseline exists, and replaces the directory atomically
(copied to a staging directory, then renamed). Other engines' baselines are never touched.

| Option             | Description                                                                                   |
| ------------------ | --------------------------------------------------------------------------------------------- |
| `--from <capture>` | `latest` (default), a capture id, or a directory (e.g. a downloaded artifact)                 |
| `--browser <name>` | Whose latest capture to approve: an engine, a list, or `all` (default: the configured engine) |
| `-y, --yes`        | Confirm replacing an existing baseline (required when not interactive)                        |
| `--allow-failed`   | Approve even if some scenarios failed                                                         |

In a non-interactive shell, replacing an existing baseline without `--yes` is refused:

```text
  ✖ Refusing to replace the approved chromium baseline without confirmation.
    Re-run with --yes to confirm (this is deliberate: baselines are never overwritten silently).
```

(exit code `2`). Captures with failed scenarios are refused unless you pass `--allow-failed`. A
capture can only become its own engine's baseline: `--from ./firefox-capture --browser chromium`
is refused (`BROWSER_MISMATCH`).

```bash
npx motionpr baseline accept                         # the configured engine's latest capture
npx motionpr baseline accept --browser firefox
npx motionpr baseline accept --browser all --yes     # the latest capture of every engine
npx motionpr baseline accept --from ./artifact/capture   # its engine decides the target
```

A baseline in the 0.1 layout (`baseline/capture.json`) is moved into `baseline/<browser>/` the
first time `accept` runs; commit the move.

## `motionpr baseline status`

```bash
npx motionpr baseline status
```

```text
◐ motionpr 0.5.0-alpha  ·  baseline status

  Chromium  20261113-215354-f7d6 · 1 scenarios · Chromium 158.0.8127.18 · 2026-11-13T21:53:56.501Z
            .motionpr/baseline/chromium
  Firefox   no baseline
  WebKit    no baseline
```

`--json` prints `{ "baseline": …, "baselines": { "chromium": …, "firefox": …, "webkit": … } }`;
`baseline` is the configured engine's, for scripts written for 0.1.

## `motionpr baseline migrate`

```bash
npx motionpr baseline migrate
```

Moves a baseline from the single-browser layout of MotionPR 0.1 (`.motionpr/baseline/capture.json`
and `assets/`) into `.motionpr/baseline/<browser>/` (Chromium for every 0.1 baseline). Until then
the old baseline is still read as that engine's baseline, and `run` reminds you. Commit the move.
Running it again does nothing.

See [Baselines](../features/baselines.md) and [Baseline management](../ci/baseline-management.md).
