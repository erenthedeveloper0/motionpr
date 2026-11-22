---
title: Ignore rules
description: Exclude elements, animations, properties and screen regions from recording and comparison, and choose the identity attributes.
---

# Ignore rules

Some motion is not yours to test: a live clock, a third-party widget, an ad slot, an infinite
loader in a corner. Exclude it as narrowly as you can.

## `ignore`

| Option              | Default | Description                                                               |
| ------------------- | ------- | ------------------------------------------------------------------------- |
| `ignore.selectors`  | `[]`    | Animations on matching elements (or their descendants) are not recorded   |
| `ignore.animations` | `[]`    | Animation names to skip (CSS `animation-name`, WAAPI `id`, adapter names) |
| `ignore.properties` | `[]`    | CSS properties excluded from recording and comparison                     |

```ts
ignore: {
  selectors: [".live-clock", "[data-third-party]"],
  animations: ["spinner"],
  properties: ["background-position"],
},
```

`ignore.selectors` are CSS selectors, matched against the animated element and its ancestors. For
an element inside a shadow root, the hosts of the roots it is in and their ancestors count too
(since `0.5.0-alpha`): `"chat-widget"` ignores everything inside that component
([Shadow DOM](../integrations/shadow-dom.md#ignoring-a-component)).

Ignored motion is not recorded, so it cannot produce differences. Animations on elements matched
by `ignore.selectors` are also left out when MotionPR waits for motion to settle, and so is the
scroll motion of a matched scroll container (since `0.4.0-alpha`); ignored names
and properties are only dropped from the records, so a long animation ignored by name still has to
finish (or be infinite) before a checkpoint settles.

## Visual regions

`ignore` removes animation records. To keep recording an element's motion but exclude its pixels
from the settled-screenshot and frame comparison, use rectangles in viewport CSS pixels:

```ts
comparison: {
  visual: { ignoreRegions: [{ x: 1180, y: 16, width: 240, height: 48 }] },
},
```

Masking content in screenshots for privacy is separate: [Privacy](privacy.md).

## Per rule

To keep recording something but stop grading it, turn its rule off:

```ts
comparison: { severity: { "end-delay": "off", visual: "off" } },
```

## `identity`

| Option                     | Default              | Description                         |
| -------------------------- | -------------------- | ----------------------------------- |
| `identity.attribute`       | `"data-motionpr-id"` | Preferred stable identity attribute |
| `identity.testIdAttribute` | `"data-testid"`      | Second choice                       |

Elements are identified by, in order: `identity.attribute`, `identity.testIdAttribute`, a unique
non-generated `id`, a unique accessible label, and finally a DOM path anchored at the nearest
identified ancestor (low confidence). See
[Animation identification](../features/animation-identification.md).
