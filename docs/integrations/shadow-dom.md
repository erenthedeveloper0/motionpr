---
title: Shadow DOM and Web Components
description: Motion inside shadow roots is recorded, identified through each component's host, and compared like the rest of the page, with no setup.
---

# Shadow DOM and Web Components

Unreleased, after `0.4.0-alpha`. Web components keep their markup in shadow roots, and the
browser keeps those apart from the page: `document.getAnimations()` leaves their animations out,
and `scroll`, `transitionrun` and `animationstart` events stop at the root. MotionPR's agent asks
every shadow root directly, so motion inside components is recorded, waited for, replayed and
compared like the rest of the page.

|         |                                                                                                                            |
| ------- | -------------------------------------------------------------------------------------------------------------------------- |
| Install | nothing                                                                                                                    |
| Config  | nothing                                                                                                                    |
| Records | the same records as outside (CSS transitions and animations, Web Animations, GSAP and Anime.js targets, scroll containers) |
| Status  | Verified in Chromium, Firefox and WebKit (capture engine, GSAP and Anime.js browser tests)                                 |

## Which shadow roots

- **Open roots attached by script**: `attachShadow({ mode: "open" })`, as Lit, Stencil and most
  component libraries do.
- **Closed roots attached by script**: the agent runs before any page script and keeps the root
  `attachShadow` returns.
- **Declarative open roots**: `<template shadowrootmode="open">`, as server-rendered components
  arrive. They are found once the document has been parsed (`DOMContentLoaded`), when a
  checkpoint's window opens and before each interaction.
- **Nested roots**, at any depth.

Declarative closed roots are invisible to scripts, and so to MotionPR. The built-in shadow trees
of form controls and media elements, and iframes, are not observed either.

## Identity

An element inside a shadow root is identified within that root, by the same rules as everywhere
else ([Animation identification](../features/animation-identification.md#element-identity)), and
its key and selector start with its host's:

<!-- prettier-ignore -->
```html
<plan-card data-testid="plan-pro">
  #shadow-root
    <div data-motionpr-id="glow"></div>
    <div class="bar"></div>
</plan-card>
```

| Element            | Key                                                        | Confidence |
| ------------------ | ---------------------------------------------------------- | ---------- |
| the glow           | `test-id:plan-pro >> motionpr-id:glow`                     | high       |
| the bar            | `test-id:plan-pro >> path:#shadow-root>div:nth-of-type(2)` | low        |
| a nested component | `test-id:outer >> test-id:inner >> motionpr-id:spark`      | high       |

- A component's template repeats in every instance, so ids, labels and paths only need to be
  unique within the root; the host tells the instances apart. Without the host, three cards'
  glows would share one key.
- An element is only as reliable as its host: give hosts a `data-motionpr-id` or `data-testid`.
  Inside a host matched by DOM position, every element is matched by DOM position too.
- A DOM path inside a root starts at the nearest identified ancestor in the root, or at the top
  of the root (`#shadow-root`).
- Records carry the host's key as `element.shadowHost` ([Capture data model](../features/capture-data-model.md#animationrecord)).
- Findings name the hosts, then the element:
  _css-transition “opacity” on plan-pro >> glow: Duration 300ms → 450ms (+150ms, +50%)_.

The selectors use Playwright's chaining operator: `[data-testid="plan-pro"] >> [data-motionpr-id="glow"]`
and `[data-testid="plan-pro"] >> :scope > div:nth-of-type(2)` (`:scope` is the host). They work
as step selectors, and MotionPR uses them to find an element that a component re-rendered while it
animated, so the new element is replayed and sampled. Playwright does not reach into closed
roots, so selectors there only work for MotionPR.

## Steps

Every step selector is a Playwright selector, and Playwright's CSS reaches into open shadow
roots: `{ type: "click", selector: "[data-testid=jump]" }` clicks a button inside a component.
`scroll` and `scrollTo` steps find their elements the same way (before, they used
`document.querySelector`, which stops at shadow roots, and did not understand `text=` or
`role=`):

```ts
steps: [
  // A scroll container inside a component, by its own test id or through its host.
  { type: "scrollTo", target: 600, selector: "[data-testid=inbox] >> [data-testid=list]" },
  { type: "waitForScrollSettled" },
  { type: "capture", label: "inbox-scrolled" },
  // A target inside a component, with Playwright's text engine.
  { type: "scrollTo", target: "text=Footer note", behavior: "instant" },
  { type: "capture", label: "footer" },
],
```

They take the first element that matches, wait up to `capture.actionTimeout` for it to be
attached, and fail with _No element matches [data-testid=missing] (waited 10000 ms)._ when none
appears. Steps cannot reach into closed roots.

## Scroll containers

Overflow elements inside shadow roots are recorded like any other
[scroll container](../configuration/scenarios.md#scroll-motion): when a `scrollTo` step with
`selector` scrolls them, a `wheel` step points at them, or the component scrolls them itself (a
carousel's "next" button). Their records are named after the element:
`native:test-id:inbox >> test-id:list:vertical`.

## Staggers

The same element of numbered components (`plan-1`, `plan-2`, `plan-3`) forms one stagger family,
so a changed stagger across component instances is found:
_Stagger interval 60ms → 120ms across 3 elements_. Numbered elements inside one component
(`item-1`, `item-2` in one root) form a family as they do outside shadow roots.

## Ignoring a component

`ignore.selectors` matches the animated element, its ancestors and the hosts of the shadow roots
it is in. `ignore: { selectors: ["chat-widget"] }` leaves out everything inside that component,
also when MotionPR waits for motion to settle ([Ignore rules](../configuration/ignore-rules.md)).

## Cost

While capturing, the agent asks every shadow root for its animations once per frame, as it asks
the document. In MotionPR's measurements, 1,000 shadow roots took 0.3 ms per frame in Firefox,
0.6 ms in Chromium and 1 ms in WebKit. Outside a capture the agent is not in the page.

## Upgrading from 0.4.0-alpha

Captures made with `0.4.0-alpha` or earlier did not look inside shadow roots: CSS transitions and
animations there were not recorded, Web Animations there were recorded without their host in
their key, and scroll containers there were not recorded. Their `settings.shadowRoots` reads as
`false`. Against such a baseline:

- records are paired by their key within the root (`motionpr-id:glow` with
  `test-id:plan-pro >> motionpr-id:glow`), and their changes are `uncertain`: the old capture
  also replayed them without freezing the rest of the component;
- animations and scroll containers the baseline could not see are `uncertain`, not `warning`:
  _… The baseline was captured before MotionPR looked inside shadow roots (MotionPR 0.4.0-alpha
  or earlier), so this is uncertain; capture it again to compare this animation._
- an old record that may be one of those, under its old key, is `uncertain`, not `critical`.

A severity set for `animation-added`, `animation-removed`, `scroll-added` or `scroll-removed`
still applies. Accept a new baseline once (`npx motionpr baseline accept`) to compare everything
again.

## Limitations

- Declarative closed roots, the browser's own shadow trees (form controls, media) and iframes
  are not observed.
- Steps, Playwright selectors and screenshot masks (`privacy.maskInputs`,
  `privacy.maskSelectors`) do not reach into closed roots: an input inside a closed root is not
  masked.
- Elements slotted into a component belong to the page's own DOM and are identified there, not
  through the host.
