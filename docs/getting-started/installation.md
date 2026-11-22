---
title: Installation
description: Install @erenthedeveloper0/motionpr as a development dependency and run the motionpr command.
---

# Installation

<!-- tabs -->

```bash title="npm"
npm install -D @erenthedeveloper0/motionpr@alpha
```

```bash title="pnpm"
pnpm add -D @erenthedeveloper0/motionpr@alpha
```

```bash title="yarn"
yarn add -D @erenthedeveloper0/motionpr@alpha
```

```bash title="bun"
bun add -d @erenthedeveloper0/motionpr@alpha
```

<!-- /tabs -->

The package is `@erenthedeveloper0/motionpr`. The command it installs is `motionpr`, which every
guide runs through `npx` (or `pnpm exec`, `yarn`, `bunx`):

```bash
npx motionpr --version
```

## Why `@alpha`

MotionPR is in alpha. Its versions are prereleases (`0.5.0-alpha`) and they are published on
npm's `alpha` dist-tag. Naming the tag installs the newest alpha; once MotionPR has a stable
release, `npm install -D @erenthedeveloper0/motionpr` will install that instead. A semver range
such as `^0.5.0` never matches a prerelease, so nobody receives an alpha by accident.

## What gets installed

| Part                                  | Where it runs       | Notes                                                                    |
| ------------------------------------- | ------------------- | ------------------------------------------------------------------------ |
| `motionpr` CLI and the Node API       | Node.js             | Uses `playwright-core`, `zod`, `commander`, `pixelmatch`, `pngjs`, …     |
| `@erenthedeveloper0/motionpr/gsap`    | your app (browser)  | Dependency-free module; does nothing unless MotionPR is capturing        |
| `@erenthedeveloper0/motionpr/animejs` | your app (browser)  | Same                                                                     |
| `@erenthedeveloper0/motionpr/lenis`   | your app (browser)  | Same                                                                     |
| Report viewer template                | copied into reports | One HTML file with the viewer and its fonts; reports load nothing remote |
| Demo app                              | `motionpr demo`     | The bundled Halcyon demo site in two variants                            |
| Browser builds                        | `motionpr install`  | Downloaded separately into Playwright's cache; never part of the package |

GSAP, Anime.js and Lenis are optional peer dependencies. MotionPR never bundles them: the
adapters work with the copy your app already uses.

## Try it without a project

```bash
npx @erenthedeveloper0/motionpr@alpha install   # Chromium, once per machine (or: install firefox)
npx @erenthedeveloper0/motionpr@alpha demo
```

`demo` captures the bundled demo app in two versions, compares them and opens a real report. See
[motionpr demo](../cli/demo.md).

Next: [Browser setup](browser-setup.md).
