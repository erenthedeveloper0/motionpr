---
title: Privacy
description: What MotionPR records, what it masks and redacts, and where data goes — with every privacy option.
---

# Privacy

MotionPR runs locally or in your CI. It sends nothing anywhere: no telemetry, no uploads.

- **Inputs:** text inputs, textareas, selects and contenteditable regions are masked in every
  screenshot and frame (`privacy.maskInputs`, default on). Add selectors with
  `privacy.maskSelectors`.
- **Filled values** (`fill` steps) are never written to captures or reports; Playwright error
  messages that echo them are redacted.
- **URLs:** query-string values are replaced with `REDACTED` unless listed in
  `privacy.allowQueryParams`.
- **Scroll input:** Lenis wheel/touch payloads are not recorded, only positions and state.
- **Reports** are static files. Share them like any screenshot of your product.

## Options

| Option                      | Default | Description                                                                          |
| --------------------------- | ------- | ------------------------------------------------------------------------------------ |
| `privacy.maskInputs`        | `true`  | Mask text inputs, textareas, selects and contenteditable regions in every screenshot |
| `privacy.maskSelectors`     | `[]`    | Extra selectors to mask                                                              |
| `privacy.redactQueryParams` | `true`  | Replace query values in recorded URLs with `REDACTED`                                |
| `privacy.allowQueryParams`  | `[]`    | Query parameters safe to record verbatim                                             |

```ts
privacy: {
  maskSelectors: [".account-email", "[data-private]"],
  allowQueryParams: ["page", "tab"],
},
```

Masks are Playwright locators, so they reach into open shadow roots but not into closed ones: an
input inside a closed shadow root is not masked. Add a selector for its host to
`privacy.maskSelectors` to mask the whole component
([Shadow DOM](../integrations/shadow-dom.md#limitations)).

Captures and reports contain screenshots of your app. Treat them like any screenshot of your
product: CI artifacts of a private repository are visible to everyone with read access to it.
