# Roadmap

What comes after `0.5.0-alpha`, roughly in order. Nothing under "Towards a beta" or "Later" is
built yet; what is built is in [the changelog](CHANGELOG.md) and
[Limitations](docs/advanced/limitations.md). Order changes with what users run into; open an
issue to argue for something.

## Done

- **Adapter protocol 2** (`0.5.0-alpha`). The adapter contract for custom
  engines is frozen until `1.0` (only optional additions; a breaking change gets a new number
  while protocol 2 keeps working), adapters declare `protocol: 2`, and protocol 1 adapters keep
  working. The agent checks what adapters report: an entry that would make a capture unreadable
  is left out with a diagnostic. The conformance suite, `motionpr adapter check` (and
  `checkAdapter()`), runs 21 checks against an adapter in a real browser; GSAP, Anime.js and Lenis
  pass it in all three engines. See [Custom adapters](docs/advanced/custom-adapters.md).
- **Shadow DOM** (`0.5.0-alpha`). Motion inside open, closed, nested and
  declarative shadow roots is recorded, waited for and replayed; elements there are identified
  through their host (`test-id:plan-pro >> motionpr-id:glow`) with selectors in Playwright's
  chaining syntax that re-find re-rendered elements; scroll containers inside roots are recorded;
  `scroll` and `scrollTo` steps find their elements with Playwright like every other step.
  Declarative closed roots and iframes are not observed. See
  [Shadow DOM](docs/integrations/shadow-dom.md).
- **Nested native scroll containers** (`0.4.0-alpha`). The scroll motion of overflow
  containers is recorded from where they rested, compared and waited for like the document's,
  whether a step or the page scrolls them; `wheel` steps take a `selector` to scroll the
  container under it (`scrollTo` already had one). Containers in iframes are not recorded yet.
  See [Scenarios](docs/configuration/scenarios.md#scroll-motion).
- **Stable ScrollTrigger positions under native smooth scrolling** (`0.4.0-alpha`). Where a
  ScrollTrigger animation runs in the scroll is compared from the `start`/`end` positions
  ScrollTrigger resolved, and its `scrub` and `toggleActions` as scroll settings, instead of
  relating two live recordings; two runs of one build now agree in Chromium, Firefox and WebKit. Captures without positions keep the progress comparison. See
  [GSAP: ScrollTrigger](docs/integrations/gsap.md#scrolltrigger).
- **Windows in CI** (`0.3.0-alpha`). The unit tests, the Chromium
  browser suites, the demo app's expectations and the packaged CLI run on `windows-latest`.
  Firefox and WebKit on Windows are not covered yet.
- **Scroll-linked tween values** (`0.3.0-alpha`). GSAP ScrollTrigger
  animations are sampled at the progress the scroll reached and compared at the same progress, so
  a changed parallax distance is found, not only a moved `start`/`end`. Repeating ScrollTrigger
  animations stay timing-only. See [GSAP: ScrollTrigger](docs/integrations/gsap.md#scrolltrigger).
- **Firefox and WebKit captures, with per-browser baselines** (`0.2.0-alpha`). Chromium, Firefox
  and WebKit through one capture pipeline; baselines, captures, comparisons and reports per
  engine; `--browser all`; explicit cross-browser comparison; every browser suite and the demo
  app's expectations run in each engine. See [Browser support](docs/browsers/support.md).

## Towards a beta

1. **Example projects.** Small, runnable projects (plain HTML, React with GSAP, Astro with Lenis)
   with their scenarios and committed baselines, tested in CI like the demo app. The baselines
   have to be captured where CI runs (Linux), so this starts with a CI job that captures them.

## Later

- Engines in parallel within one `--browser all` run (today they run one after another; a CI
  matrix runs them in parallel).
- Comparing against the base branch as a first-class `motionpr run` mode, not a workflow recipe.
- Report deep links (open a report at a scenario, checkpoint and time).
- Smaller captures: an optional compact JSON format for large suites.
- More engines through adapters: Motion (Framer Motion), Web Components libraries, canvas renderers.
- Versioned documentation on the website, once more than one release is in use.

## Not planned

- A hosted service, accounts or telemetry. MotionPR runs where your code runs.
- Treating uncertain findings as regressions by default.
