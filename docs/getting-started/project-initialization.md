---
title: Project initialization
description: Create motionpr.config.ts with motionpr init, and what it detects and writes.
---

# Project initialization

```bash
npx motionpr init
```

`init` asks where your app runs and how to start it, then writes a commented
`motionpr.config.ts` (`motionpr.config.mjs` in projects without TypeScript). It never overwrites
an existing config unless you confirm, or pass `--force`.

## What it detects

| Detected        | From                                                      | Used for                                                   |
| --------------- | --------------------------------------------------------- | ---------------------------------------------------------- |
| Framework       | `package.json` dependencies                               | The default URL (port)                                     |
| Dev command     | the `dev` script, else `start` (Angular and CRA: `start`) | `webServer.command`                                        |
| Package manager | `pnpm-lock.yaml`, `yarn.lock`, `bun.lock(b)`, else npm    | The dev command and the generated workflow                 |
| TypeScript      | `tsconfig.json` or a `typescript` dependency              | `.ts` or `.mjs` config                                     |
| Engines         | `gsap`, `animejs` or `lenis` dependencies                 | `adapters` entries (with `required: true`) and setup notes |

Frameworks and the port `init` proposes: Next.js (3000), Nuxt (3000), React Router (5173), Remix
(5173), Astro (4321), SvelteKit (5173), Gatsby (8000), Create React App (3000), Angular (4200) and
Vite (5173). Anything else gets `http://localhost:3000`.

## What it writes

```text
motionpr.config.ts               the config, with an example scenario
.motionpr/.gitignore             ignores captures/, comparison/, report/ and tmp/
.github/workflows/motionpr.yml   only with --github (see GitHub Actions)
```

The approved baseline in `.motionpr/baseline/` is not ignored: it is meant to be committed.

This is what `npx motionpr init --yes` printed and wrote in a Vite project:

```text
◐ motionpr 0.5.0-alpha  ·  init

  ✔ Created motionpr.config.ts
  ✔ Created .motionpr/.gitignore
  ● Detected Vite (npm); baseURL http://localhost:5173, starts with `npm run dev`
```

```ts title="motionpr.config.ts (comments shortened)"
import { defineConfig } from "@erenthedeveloper0/motionpr";

export default defineConfig({
  // Detected project type: Vite
  baseURL: "http://localhost:5173",

  // Start your app before capturing (skipped if it is already running locally).
  webServer: {
    command: "npm run dev",
    url: "http://localhost:5173",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },

  browser: {
    viewport: { width: 1440, height: 900 },
    colorScheme: "light",
  },

  scenarios: [
    {
      // Motion that plays when the page loads.
      id: "home-load",
      name: "Home page entrance",
      path: "/",
      steps: [{ type: "capture", label: "loaded" }],
    },
  ],

  capture: {
    samples: 24, // property samples per animation
    frames: { enabled: true, fps: 30 }, // deterministic filmstrip for the report
  },

  comparison: {
    // Exit with code 1 when a difference at this severity (or worse) is found.
    failOn: "critical",
  },
});
```

The generated file also contains commented-out examples: a second viewport, an interaction
scenario, an `ignore` rule and the setup lines for GSAP, Anime.js and Lenis.

## Without prompts

```bash
npx motionpr init --yes                                   # accept the detected defaults
npx motionpr init --base-url http://localhost:8080 --command "npm start"
npx motionpr init --no-command                            # your app is already running elsewhere
npx motionpr init --github                                # also write the GitHub Actions workflow
```

Every option is listed in [motionpr init](../cli/init.md). The config format is described in
[Configuration file](../configuration/config-file.md).

Next: [First capture](first-capture.md).
