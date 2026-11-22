---
title: motionpr doctor
description: Check Node.js, every browser engine, the config, output permissions, the baselines, web servers and adapters.
---

# `motionpr doctor`

```bash
npx motionpr doctor [options]
```

Checks, in order: the Node.js version (22.12 or newer), the MotionPR and Playwright versions, the
config, the binary of each engine, an actual launch of the selected engines, output-directory
permissions, which engines have a baseline, the configured web servers or `baseURL`, and each
configured adapter. Every problem is printed with a fix. Exits `2` when a check fails.

| Option             | Description                                                            |
| ------------------ | ---------------------------------------------------------------------- |
| `--browser <name>` | Engines to launch: one, a list, or `all` (default: the configured one) |
| `--no-launch`      | Skip the browser launch checks                                         |

A selected engine that is not installed fails; the others are listed as optional. Each launch
opens a page with MotionPR's agent and reports the Web Animations support, timer resolution and
frame rate MotionPR will see. Real output on macOS:

```text
  ✔ Chromium binary   ~/Library/Caches/ms-playwright/chromium-1254/…/Google Chrome for Testing
  ✔ Firefox binary    ~/Library/Caches/ms-playwright/firefox-1572/firefox/Nightly.app/Contents/MacOS/firefox
  ✔ WebKit binary     ~/Library/Caches/ms-playwright/webkit-2388/pw_run.sh
  ✔ Chromium launch   Chromium 158.0.8127.18, Web Animations API available; timers 0.1 ms, 60 fps
  ✔ Firefox launch    Firefox 159.0, Web Animations API available; timers 1 ms, 60 fps
  ✔ WebKit launch     WebKit 27.2, Web Animations API available; timers 1 ms, 30 fps
  ✔ Output directory  .motionpr (writable)
  ● Baselines         Chromium in .motionpr/baseline; none yet for Firefox, WebKit
    npx motionpr run --browser firefox,webkit, then npx motionpr baseline accept --browser firefox,webkit
```

On Linux, a launch that fails for missing system libraries suggests
`npx motionpr install <browser> --with-deps`.

## Adapters

For each configured adapter (`gsap`, `animejs`, `lenis`), `doctor` reports the installed package
version and whether it is inside the tested range. When the app is reachable, it opens the first
scenario with MotionPR's agent installed and checks that the adapter actually **registered in
the page**, with the [adapter protocol](../advanced/custom-adapters.md#protocol-2) it declares. An
installed package alone is never reported as working, and an adapter that declares a protocol this
MotionPR does not support fails the check. To check a custom adapter in depth, use
[`motionpr adapter check`](adapter.md).

## JSON

```bash
npx motionpr doctor --json
```

Each check has a `status` of `ok`, `info`, `warn` or `fail`, a `detail`, and a `fix` when there
is something to do. `ok` is `false` when any check failed. Shortened real output:

```json
{
  "ok": true,
  "checks": [
    { "name": "Node.js", "status": "ok", "detail": "v24.21.0" },
    { "name": "MotionPR", "status": "ok", "detail": "0.5.0-alpha" },
    { "name": "Playwright", "status": "ok", "detail": "playwright-core 1.65.0" },
    { "name": "Config", "status": "ok", "detail": "motionpr.config.mjs (1 scenario)" },
    {
      "name": "Chromium launch",
      "status": "ok",
      "detail": "Chromium 158.0.8127.18, Web Animations API available; timers 0.1 ms, 60 fps"
    },
    {
      "name": "Web server",
      "status": "info",
      "detail": "http://localhost:4173 not running; MotionPR starts `npm run dev`"
    }
  ]
}
```

Use it as the first step of [Troubleshooting](../advanced/troubleshooting.md).
