---
title: Animation identification
description: How MotionPR recognises the same element and the same animation in two versions of your app.
---

# Animation identification

A comparison is only as good as its pairing. Before MotionPR can say "this transition got
slower", it has to decide that two records, one per capture, are the same animation.

## Element identity

Every animated element gets an identity key, chosen in this order:

| Priority | Method        | Key example                            | Confidence |
| -------- | ------------- | -------------------------------------- | ---------- |
| 1        | `motionpr-id` | `motionpr-id:menu`                     | high       |
| 2        | `test-id`     | `test-id:nav-panel`                    | high       |
| 3        | `dom-id`      | `id:pricing` (unique, not generated)   | medium     |
| 4        | `aria`        | `aria:button[Open menu]`               | medium     |
| 5        | `dom-path`    | `path:test-id:work>div:nth-of-type(2)` | low        |

- `identity.attribute` (default `data-motionpr-id`) and `identity.testIdAttribute` (default
  `data-testid`) are configurable.
- An `id` counts only when it is unique in the page and does not look generated: React's
  `:r1:`, `«r1»`, prefixes such as `radix-`, `headlessui-`, `mui-`, `ember`, `ng-`, long hex
  runs and digit-heavy ids are skipped.
- An accessible label counts for `aria-label`, and for the text of leaf buttons, links, tabs and
  menu items when it is unique among elements of the same kind.
- A DOM path is anchored at the nearest ancestor with a stronger identity, so
  `path:test-id:work>div:nth-of-type(2)` survives changes elsewhere in the page.

The record id combines the element key, the animation type and its name:
`motionpr-id:menu::css-transition::transform`. Duplicates get `#2`, `#3`.

### Inside shadow roots

Since `0.5.0-alpha`. An element inside a shadow root is identified within that root by
the same rules (an `id` or a label only has to be unique there), and its key starts with its
host's key: `test-id:plan-pro >> motionpr-id:glow`, or
`test-id:plan-pro >> path:#shadow-root>div:nth-of-type(2)` for a path from the top of the root.
Each instance of a component therefore has its own keys, and an element is only as reliable as
its host. The selector chains the host's selector and the element's with Playwright's `>>`
operator, and `element.shadowHost` holds the host's key. See
[Shadow DOM](../integrations/shadow-dom.md#identity).

## Matching

Records are matched per checkpoint in three deterministic passes:

| Pass        | Rule                                                                                                     | Confidence                 |
| ----------- | -------------------------------------------------------------------------------------------------------- | -------------------------- |
| **exact**   | Identical record id                                                                                      | the lower of the two sides |
| **element** | Same element and type, different name, and exactly one such record on each side (a renamed `@keyframes`) | medium, or low             |
| **fuzzy**   | Same type, name and tag, the same accessible label or selector, and at least 50% property overlap        | always low                 |

Anything left over is **added** (only in the candidate) or **removed** (only in the baseline).
Against a capture made before MotionPR looked inside shadow roots (`0.4.0-alpha` or earlier),
records inside shadow roots are first paired by their key within the root, and what stays
unpaired there is `uncertain` ([Shadow DOM](../integrations/shadow-dom.md#upgrading-from-040-alpha)).
An element pass records a note such as _Same element, renamed from "process@discover" to
"process@design"_; the demo app's Anime.js timeline produces exactly that.

Every difference in the demo app's real comparison (changed, added and removed records),
filterable by severity, engine and text:

<!-- motionpr:diff-viewer -->

## Low confidence means uncertain

With `comparison.uncertainOnLowConfidence` (default `true`), every change on a pair where either
side was identified by DOM position only is reported as **uncertain**, and an uncertain
difference never fails a run unless `failOnUncertain` is set. A wrong pairing therefore cannot
produce a false regression; it produces a question. The capture also carries a
`LOW_CONFIDENCE_IDENTITY` note with the number of such animations.

The demo app has one on purpose: a decorative glow without an id inside the work grid. Its
duration change is reported as `uncertain` with the detail _(element matched by DOM position
only)_.

## Give important elements an id

```html
<nav data-motionpr-id="menu">…</nav>
<dialog data-motionpr-id="booking-dialog">…</dialog>
<li data-motionpr-id="card-1">…</li>
```

Numbered ids such as `card-1`, `card-2` are also what stagger detection groups by: siblings whose
keys differ only by a trailing number form one stagger family. See
[Motion comparison](motion-comparison.md#stagger).

GSAP and Anime.js records are additionally named by the adapter (`hero-intro@lines`), so name
timelines you care about with `track(timeline, "name")`.
