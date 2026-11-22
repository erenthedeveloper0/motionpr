---
title: First comparison
description: Approve a baseline, change an animation, and let MotionPR find the difference.
---

# First comparison

## 1. Approve the baseline

When the capture looks right, approve it and commit it:

```bash
npx motionpr baseline accept
git add .motionpr/baseline
git commit -m "Add MotionPR baseline"
```

```text
◐ motionpr 0.5.0-alpha  ·  baseline accept

  Browser        Chromium
  New baseline   20261113-215354-f7d6 · 1 scenarios · 1 checkpoints · 1 animations · darwin · Chromium 158.0.8127.18
  Replaces       (no baseline yet)
  Location       .motionpr/baseline/chromium

  ✔ Chromium baseline set to 20261113-215354-f7d6
```

MotionPR never replaces a baseline silently. When one exists, `baseline accept` shows both and asks
for confirmation; in a non-interactive shell it refuses (exit `2`) unless you pass `--yes`. See
[Baselines](../features/baselines.md).

## 2. Change the motion

Make the kind of change that slips through review: a longer duration and a "simpler" easing.

```css
.menu {
  /* before: transition: transform 300ms cubic-bezier(0.16, 1, 0.3, 1); */
  transition: transform 600ms ease-in-out;
}
```

<!-- motionpr:easing-lab baseline="cubic-bezier(0.16, 1, 0.3, 1)" candidate="ease-in-out" compact -->

## 3. Run again

```bash
npx motionpr run
```

```text
◐ motionpr 0.5.0-alpha  ·  run

  → 1 scenario from motionpr.config.mjs
  → Starting web server: npm run dev
  → Web server ready at http://localhost:4173 (263 ms)
  → [1/1] menu-open@default
  ✔ menu-open@default  1 checkpoint · 1 animation · 2.0s

  Baseline 20261113-215354-f7d6 (Chromium 158.0.8127.18)  →  Current 20261113-215403-2778 (Chromium 158.0.8127.18)

  ✖ menu-open@default  1 critical · 1 warning · 1 info
      ✖ menu-open: css-transition “transform” on menu: Duration 300ms → 600ms (+300ms, +100%)
      ▲ menu-open: css-transition “transform” on menu: Easing cubic-bezier(0.16, 1, 0.3, 1) → ease-in-out (max deviation 70% of …
      ● menu-open: css-transition “transform” on menu: translateX path deviates up to 195.3px at 26% progress

  1 matched · 1 changed · 0 added · 0 removed · 0 unchanged

  Result  FAILED  fail on: critical  1 critical · 1 warning · 1 info
  Report  .motionpr/report/chromium/index.html
```

The command exits with code **1**. Three things were measured:

| Difference               | Severity | Why                                                                               |
| ------------------------ | -------- | --------------------------------------------------------------------------------- |
| Duration 300 ms → 600 ms | critical | The duration doubled: the relative change reached `timing.criticalRelative` (1.0) |
| Easing curve             | warning  | The curves are up to 70% of progress apart, above `easing.warnDeviation` (5%)     |
| `translateX` path        | info     | Sampled positions differ by up to 195 px mid-way; the start and end are the same  |

The rules and thresholds are in [Severity](../features/severity.md). Revert the change and run again,
and the result is `✔ menu-open@default unchanged` with exit code `0`.

## 4. Decide

- **The change is a regression:** fix the code. The next run compares against the same baseline.
- **The change is intended:** review the report, then approve the new capture in the same pull
  request as the code change:

  ```bash
  npx motionpr baseline accept --yes
  git add .motionpr/baseline && git commit -m "Update motion baseline: slower menu"
  ```

Next: [Your first report](first-report.md).
