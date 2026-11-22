// Page bodies. Copy on these pages makes only claims the documentation (and its tests) back.
import { ICONS, SITE, footer } from "./layout.mjs";
import { escapeHtml } from "./markdown.mjs";

export function sidebarHtml({ nav, currentSlug, urlFor }) {
  return nav
    .map(
      (section) =>
        `<div class="nav-group"><p class="nav-group__title">${escapeHtml(section.title)}</p><ul>${section.pages
          .map(([file, label]) => {
            const slug = file.replace(/\.md$/, "");
            return `<li><a href="${urlFor(slug)}"${slug === currentSlug ? ' aria-current="page"' : ""}>${escapeHtml(label)}</a></li>`;
          })
          .join("")}</ul></div>`,
    )
    .join("");
}

export function docsPageBody({
  up,
  page,
  html,
  toc,
  prev,
  next,
  sidebar,
  description,
  version,
  editUrl,
  urlFor,
}) {
  const tocItems = toc
    .filter((t) => t.depth <= 3)
    .map((t) => `<li class="depth-${t.depth}"><a href="#${t.id}">${escapeHtml(t.text)}</a></li>`)
    .join("");
  // The H1 comes first in the Markdown; put the breadcrumb above it and the lede under it.
  const [, h1 = "", rest = html] = /^(<h1[\s\S]*?<\/h1>\n?)([\s\S]*)$/.exec(html) ?? [];
  const pager = `<nav class="pager" aria-label="Previous and next page">${
    prev
      ? `<a class="prev" href="${urlFor(prev.slug)}" rel="prev"><span class="label">← Previous</span>${escapeHtml(prev.label)}</a>`
      : ""
  }${next ? `<a class="next" href="${urlFor(next.slug)}" rel="next"><span class="label">Next →</span>${escapeHtml(next.label)}</a>` : ""}</nav>`;
  return `<div class="reading-progress" aria-hidden="true"></div>
<div class="docs">
  <button type="button" class="sidebar-toggle" data-sidebar-toggle aria-expanded="false" aria-controls="docs-sidebar">${ICONS.sidebar}<span>${escapeHtml(page.section)} / <b>${escapeHtml(page.label)}</b></span></button>
  <aside class="sidebar" id="docs-sidebar" aria-label="Documentation">
    <nav class="sidebar__inner" aria-label="Documentation pages"><span class="sidebar__indicator" aria-hidden="true"></span>${sidebar}</nav>
  </aside>
  <main class="article" id="main" tabindex="-1">
    <ol class="breadcrumb label" aria-label="Breadcrumb"><li><a href="${up}docs/">Docs</a></li><li>${escapeHtml(page.section)}</li></ol>
    <article class="prose" data-docs-article>
      ${h1}
      ${description ? `<p class="page-lede" data-reveal="lede">${escapeHtml(description)}</p>` : ""}
      ${tocItems ? `<details class="toc-inline"><summary>On this page</summary><ol>${tocItems}</ol></details>` : ""}
      ${rest}
    </article>
    <div class="article-foot">
      ${pager}
      <div class="article-meta"><span>MotionPR v${escapeHtml(version)}</span><a href="${editUrl}" rel="noopener">Edit this page on GitHub</a></div>
    </div>
  </main>
  <nav class="toc" aria-label="On this page">${tocItems ? `<p class="label toc__title">On this page</p><ol><span class="toc__marker" aria-hidden="true"></span>${tocItems}</ol>` : ""}</nav>
</div>
${footer({ up, version })}`;
}

export function docsIndexBody({ up, nav, urlFor, descriptions, version, sidebar }) {
  const sections = nav
    .map(
      (s) =>
        `<section><h2>${escapeHtml(s.title)}</h2><ul>${s.pages
          .map(([file, label]) => {
            const slug = file.replace(/\.md$/, "");
            return `<li><a href="${urlFor(slug)}" title="${escapeHtml(descriptions[slug] ?? "")}">${escapeHtml(label)}</a></li>`;
          })
          .join("")}</ul></section>`,
    )
    .join("");
  return `<div class="reading-progress" aria-hidden="true"></div>
<div class="docs docs--index">
  <button type="button" class="sidebar-toggle" data-sidebar-toggle aria-expanded="false" aria-controls="docs-sidebar">${ICONS.sidebar}<span>Documentation</span></button>
  <aside class="sidebar" id="docs-sidebar" aria-label="Documentation"><nav class="sidebar__inner" aria-label="Documentation pages"><span class="sidebar__indicator" aria-hidden="true"></span>${sidebar}</nav></aside>
  <main class="article" id="main" tabindex="-1">
    <article class="prose" data-docs-article>
      <h1 id="documentation" tabindex="-1" data-reveal="title"><span class="h1-inner">Documentation</span></h1>
      <p class="page-lede" data-reveal="lede">Everything MotionPR does, from the first capture to custom adapters. Every option and default here is checked against the implementation.</p>
      <p><a href="${urlFor("getting-started/requirements")}">Start with the requirements</a>, try the <a href="${up}demo/">interactive demo</a>, or press <kbd>⌘K</kbd> to search.</p>
      <div class="docs-index">${sections}</div>
    </article>
  </main>
</div>
${footer({ up, version })}`;
}

const INSTALL = `npm install -D ${SITE.package}@alpha`;

function installBox(id) {
  return `<div class="install" data-component="install"><span class="install__prompt" aria-hidden="true">$</span><code id="${id}">${escapeHtml(INSTALL)}</code><button type="button" class="copy" data-copy="${id}" aria-label="Copy install command"><span class="copy-label">Copy</span></button></div>`;
}

function enginesHtml(up, engines) {
  const tabs = engines
    .map(
      (e, i) =>
        `<button type="button" role="tab" id="eng-t-${e.id}" aria-controls="eng-p-${e.id}" aria-selected="${i === 0}" tabindex="${i === 0 ? 0 : -1}" data-engine="${e.id}">${escapeHtml(e.label)}</button>`,
    )
    .join("");
  const panels = engines
    .map(
      (
        e,
        i,
      ) => `<div class="engines__panel" role="tabpanel" id="eng-p-${e.id}" aria-labelledby="eng-t-${e.id}"${i ? " hidden" : ""}>
  <div class="engines__demo panel" data-engine-stage></div>
  <div class="engines__info">
    <p class="label engines__status">${escapeHtml(e.status)}</p>
    <div class="engines__code">${e.code}</div>
    <ul class="engines__findings">${e.findings.map((f) => `<li><span class="sev sev--${f.severity}">${f.severity}</span><span>${escapeHtml(f.message)}</span></li>`).join("")}</ul>
    <a class="engines__more" href="${up}${e.docs}">${escapeHtml(e.label)} integration ${ICONS.arrow}</a>
  </div>
</div>`,
    )
    .join("");
  return `<div class="engines" data-component="engines"><div class="engines__tabs" role="tablist" aria-label="Animation engines"><span class="engines__indicator" aria-hidden="true"></span>${tabs}</div>${panels}</div>`;
}

// The tagline as a staircase: each line enters 90 ms after the previous one (ui/enter.js).
const HERO_LINES = ["Your code changed.", "See how your", "interface moves."];
// The landing page's sections, in order: the hero's index links to them.
const LANDING_SECTIONS = [
  ["change", "The change review cannot see"],
  ["how-it-works", "How it works"],
  ["measured", "Measured, not guessed"],
  ["engines", "Engines"],
  ["easing", "Easing analysis"],
  ["scroll", "Scroll motion"],
  ["ci", "Continuous integration"],
];

export function landingBody({ up, version, summary, engines }) {
  const c = summary.counts;
  return `<main id="main" class="landing" tabindex="-1">
<section class="hero" aria-labelledby="hero-title">
  <div class="hero__grain" aria-hidden="true"></div>
  <div class="hero__copy">
    <p class="label hero__eyebrow" data-hero="eyebrow"><span>Animation regression testing</span> <span aria-hidden="true">·</span> <span class="nowrap">v${escapeHtml(version)}</span></p>
    <h1 id="hero-title" class="hero__title" tabindex="-1">${HERO_LINES.map(
      (text, i) =>
        `<span class="hero__line hero__line--${i + 1}"><span class="hero__words" data-hero="line">${escapeHtml(text)}</span></span>`,
    ).join("")}</h1>
    <p class="hero__lede" data-hero="lede">MotionPR drives your app in Chromium, Firefox and WebKit, records every animation and scroll as data, compares it with an approved baseline, and opens a report where both versions play on one clock.</p>
    <div class="hero__actions" data-hero="actions">
      <a class="button" href="${up}docs/getting-started/installation/">Get started ${ICONS.arrow}</a>
      <a class="button button--ghost" href="${up}demo/">Open the interactive demo</a>
    </div>
    <div class="hero__install" data-hero="install">${installBox("hero-install")}</div>
  </div>
  <figure class="horizon" data-component="horizon" data-eager data-dataset="navigation/open" data-track="motionpr-id:nav-panel::css-transition::transform" data-hero="horizon">
    <canvas class="horizon__canvas" aria-hidden="true"></canvas>
    <figcaption class="horizon__caption">
      <p class="horizon__legend label"><span class="horizon__key horizon__key--b">Baseline 320 ms<span class="horizon__ease"> · cubic-bezier(0.16, 1, 0.3, 1)</span></span><span class="horizon__key horizon__key--c">Candidate 560 ms<span class="horizon__ease"> · ease-in-out</span></span></p>
      <p class="horizon__note">The demo app's navigation panel as MotionPR captured it, 5× slower: one light per version rides the horizon with its real timing, and the arc opens as far as they differ.</p>
    </figcaption>
  </figure>
  <nav class="hero__index" aria-label="On this page" data-hero="index">
    <ol>${LANDING_SECTIONS.map(
      ([id, label], i) =>
        `<li><a href="#${id}"><span class="hero__index-n">[${String(i + 1).padStart(2, "0")}]</span><span class="hero__index-leader" aria-hidden="true"></span><span class="hero__index-label">${escapeHtml(label)}</span></a></li>`,
    ).join("")}</ol>
  </nav>
</section>

<section id="change" class="statement section" aria-labelledby="statement-title">
  <div class="section__head">
    <p class="label section__index"><span>01</span> The change review cannot see</p>
    <h2 id="statement-title" class="section__title">One line in a pull request.<br /><span class="muted">A different interface in your hands.</span></h2>
  </div>
  <div class="statement__grid">
    <figure class="diff-card panel panel--ticks" data-component="code-diff">
      <figcaption class="label">styles.css · nav-panel</figcaption>
      <pre class="diff-card__code"><code><span class="d-ctx">.nav-panel {</span>
<span class="d-ctx">  transform: translateX(100%);</span>
<span class="d-del" data-diff="del">-  transition: transform 320ms var(--expo-out);</span>
<span class="d-add" data-diff="add">+  transition: transform 560ms ease-in-out;</span>
<span class="d-ctx">}</span></code></pre>
    </figure>
    <div class="statement__findings">
      <p class="statement__intro">The diff reads like a tidy-up. MotionPR replays both versions on one clock and measures what changed:</p>
      <div class="statement__stage" data-component="hero" data-dataset="navigation/open" data-track="motionpr-id:nav-panel::css-transition::transform">
        <p class="mp-component__fallback">The navigation panel of the demo app: baseline 320 ms on cubic-bezier(0.16, 1, 0.3, 1), candidate 560 ms on ease-in-out. MotionPR reported a duration and an easing change (warnings).</p>
      </div>
      <p class="statement__note label">Real output · demo app · scenario <b>navigation</b> · checkpoint <b>open</b></p>
    </div>
  </div>
</section>

<section id="how-it-works" class="workflow section" aria-labelledby="workflow-title" data-component="workflow">
  <div class="section__head">
    <p class="label section__index"><span>02</span> How it works</p>
    <h2 id="workflow-title" class="section__title">Capture. Analyze. Compare.<br /><span class="muted">Inspect. Report.</span></h2>
  </div>
  <div class="workflow__body">
    <div class="workflow__stage" aria-hidden="true"><div class="workflow__frame panel" data-workflow-stage></div></div>
    <ol class="workflow__steps">
      <li class="workflow__step" data-step="capture"><p class="label">Step 1 · Capture</p><h3>Real input, in a real browser.</h3><p>MotionPR opens each scenario in Chromium, Firefox or WebKit, injects its agent before your scripts run, and drives the page with clicks, hovers, key presses and wheel events. Every CSS transition, CSS animation and Web Animation is discovered as it starts; GSAP, Anime.js and Lenis report through adapters.</p></li>
      <li class="workflow__step" data-step="analyze"><p class="label">Step 2 · Analyze</p><h3>Replayed at exact times, not recorded.</h3><p>When motion settles, the window is replayed deterministically: native animations through paused clones, engines with callbacks muted. Computed styles, geometry and frames are sampled at chosen times, so the same build gives the same data on every run.</p></li>
      <li class="workflow__step" data-step="compare"><p class="label">Step 3 · Compare</p><h3>Matched by identity. Compared as curves.</h3><p>Records are paired across versions by element identity, type and name. Durations, delays, easing curves (65 samples each), staggers, trajectories, timelines, scroll metrics and settled pixels are compared, and every difference is graded by a named rule.</p></li>
      <li class="workflow__step" data-step="inspect"><p class="label">Step 4 · Inspect</p><h3>Both versions, one clock.</h3><p>The offline report plays baseline (blue) and candidate (peach) side by side, with each animation's delay, duration and easing on a shared timeline, and the largest deviation marked on the curve.</p></li>
      <li class="workflow__step" data-step="report"><p class="label">Step 5 · Report</p><h3>An answer your CI understands.</h3><p>A Markdown summary in the pull request's run, the report as an artifact, and an exit code: <code>0</code> within thresholds, <code>1</code> for a regression, <code>2</code> for an error. Uncertainty is reported as uncertain, never as a failure.</p></li>
    </ol>
  </div>
</section>

<section id="measured" class="findings-section section" aria-labelledby="findings-title">
  <div class="section__head section__head--split">
    <div>
      <p class="label section__index"><span>03</span> Measured, not guessed</p>
      <h2 id="findings-title" class="section__title">${c.critical + c.warning + c.info + c.uncertain} differences.<br /><span class="muted">Every one intended. Nothing else.</span></h2>
    </div>
    <p class="section__aside">The demo app ships in two variants with eleven deliberate motion changes across every engine. This is MotionPR's real comparison of the two: filter it the way you would a pull request. The repository's end-to-end suite checks that every change is found and nothing else is reported.</p>
  </div>
  <div data-component="diff-viewer"><p class="mp-component__fallback">${c.critical} critical, ${c.warning} warnings, ${c.info} info, ${c.uncertain} uncertain.</p></div>
</section>

<section id="engines" class="engines-section section" aria-labelledby="engines-title">
  <div class="section__head">
    <p class="label section__index"><span>04</span> Engines</p>
    <h2 id="engines-title" class="section__title">The browser's animations, natively.<br /><span class="muted">Your engine's, through one line.</span></h2>
  </div>
  ${enginesHtml(up, engines)}
</section>

<section id="easing" class="curves-section section" aria-labelledby="curves-title">
  <div class="section__head section__head--split">
    <div>
      <p class="label section__index"><span>05</span> Easing analysis</p>
      <h2 id="curves-title" class="section__title">Curves, not strings.</h2>
    </div>
    <p class="section__aside"><code>ease</code> and <code>cubic-bezier(0.25, 0.1, 0.25, 1)</code> are the same curve; <code>ease-out</code> and a tuned bezier can feel nothing alike. MotionPR compares 65 samples of each curve. This lab runs MotionPR's own easing code in your browser.</p>
  </div>
  <div data-component="easing-lab" data-baseline="cubic-bezier(0.16, 1, 0.3, 1)" data-candidate="ease-in-out"></div>
</section>

<section id="scroll" class="scroll-section section" aria-labelledby="scroll-title">
  <div class="section__head section__head--split">
    <div>
      <p class="label section__index"><span>06</span> Scroll motion</p>
      <h2 id="scroll-title" class="section__title">A scroll is not an animation.<br /><span class="muted">It is measured like one should be.</span></h2>
    </div>
    <p class="section__aside">Smooth scrolling maps time to position. MotionPR records it live, never replays it, and compares distance, settle time, the shape of the movement, peak velocity and overshoot. Below: the demo's Lenis scroll at <code>lerp 0.1</code> and <code>0.06</code>, as recorded.</p>
  </div>
  <div data-component="scroll" data-dataset="lenis-journal/scrolled"></div>
</section>

<section id="ci" class="ci-section section" aria-labelledby="ci-title">
  <div class="section__head">
    <p class="label section__index"><span>07</span> Continuous integration</p>
    <h2 id="ci-title" class="section__title">Least privilege.<br /><span class="muted">Most signal.</span></h2>
  </div>
  <div class="ci__grid">
    <div class="ci__copy">
      <p><code>npx motionpr init --github</code> writes a workflow that needs only <code>contents: read</code>, pins every action to a commit SHA, and uploads the report even when the job fails.</p>
      <dl class="exit-codes">
        <div><dt><span class="exit exit--0">0</span></dt><dd>Within thresholds</dd></div>
        <div><dt><span class="exit exit--1">1</span></dt><dd>A difference reached <code>comparison.failOn</code></dd></div>
        <div><dt><span class="exit exit--2">2</span></dt><dd>Configuration or execution error</dd></div>
      </dl>
      <a class="button button--ghost" href="${up}docs/ci/github-actions/">Set up GitHub Actions ${ICONS.arrow}</a>
    </div>
    <figure class="terminal panel" data-component="terminal" aria-label="motionpr run output">
      <figcaption class="terminal__bar"><span class="label">npx motionpr run · real output, shortened</span></figcaption>
<pre class="terminal__body"><code><span class="t-dim">◐ motionpr 0.5.0-alpha  ·  run</span>

  <span class="t-dim">→</span> 1 scenario from motionpr.config.mjs
  <span class="t-dim">→</span> Web server ready at http://localhost:4173 (263 ms)
  <span class="t-ok">✔</span> menu-open@default  1 checkpoint · 1 animation · 2.0s

  <span class="t-dim">Baseline 20261113-215354-f7d6  →  Current 20261113-215403-2778</span>

  <span class="t-crit">✖</span> menu-open@default  1 critical · 1 warning · 1 info
      <span class="t-crit">✖</span> Duration 300ms → 600ms (+300ms, +100%)
      <span class="t-warn">▲</span> Easing cubic-bezier(0.16, 1, 0.3, 1) → ease-in-out
      <span class="t-info">●</span> translateX path deviates up to 195.3px at 26% progress

  Result  <span class="t-crit">FAILED</span>  fail on: critical
  <span class="t-dim">exit code 1</span></code></pre>
    </figure>
  </div>
</section>

<section class="cta section" aria-labelledby="cta-title">
  <div class="cta__mark" data-component="mark" aria-hidden="true"></div>
  <h2 id="cta-title" class="cta__title">Review motion like code.</h2>
  <p class="cta__lede">Open source, MIT licensed, runs on your machine. No account, no backend, no telemetry.</p>
  <div class="cta__actions">
    <a class="button" href="${up}docs/getting-started/installation/">Get started ${ICONS.arrow}</a>
    <a class="button button--ghost" href="${up}docs/">Explore the documentation</a>
    <a class="button button--ghost" href="${up}demo/">Interactive demo</a>
    <a class="button button--ghost" href="${SITE.repo}" rel="noopener">${ICONS.github} GitHub</a>
  </div>
  ${installBox("cta-install")}
</section>
</main>
${footer({ up, version })}`;
}

export function demoBody({ up, version }) {
  return `<main id="main" class="app-page demo-page" tabindex="-1">
  <header class="app-page__head">
    <p class="label">Interactive demo · real captures</p>
    <h1 class="app-page__title" tabindex="-1" data-reveal="title"><span class="h1-inner">The demo app, in two versions.</span></h1>
    <p class="app-page__lede" data-reveal="lede">Halcyon is the fictional studio site that ships with MotionPR. Its candidate variant contains eleven deliberate motion changes. Both variants run live below; press <em>Play</em> to drive the same interaction in each, then read what MotionPR measured when it captured them.</p>
  </header>
  <div data-component="demo"><p class="mp-component__fallback">The interactive demo needs JavaScript. The full report is at <a href="${up}report/">report/</a>.</p></div>
</main>
${footer({ up, version })}`;
}

export function playgroundBody({ up, version }) {
  return `<main id="main" class="app-page playground-page" tabindex="-1">
  <header class="app-page__head">
    <p class="label">Playground · MotionPR's comparison engine in your browser</p>
    <h1 class="app-page__title" tabindex="-1" data-reveal="title"><span class="h1-inner">Change the motion. Read the verdict.</span></h1>
    <p class="app-page__lede" data-reveal="lede">Adjust duration, easing, delay and stagger. The playground builds an animation record for each version and grades the pair with <code>compareMatchedAnimation</code> and <code>compareStagger</code> from <code>@motionpr/comparison</code>, using MotionPR's default thresholds. A real capture also samples computed styles from the browser and renders frames.</p>
  </header>
  <div data-component="playground"></div>
  <section class="app-page__section" aria-labelledby="lab-title">
    <h2 id="lab-title" class="app-page__h2">Easing laboratory</h2>
    <div data-component="easing-lab" data-baseline="ease" data-candidate="cubic-bezier(0.34, 1.56, 0.64, 1)"></div>
  </section>
  <section class="app-page__section" aria-labelledby="scroll-lab-title">
    <h2 id="scroll-lab-title" class="app-page__h2">Scroll laboratory</h2>
    <p class="app-page__p">A real Lenis instance inside the frame below. Scroll it with the wheel or trackpad, change <code>lerp</code>, and MotionPR's <code>scrollMetrics</code> measures each movement the way it measures a recorded one.</p>
    <div data-component="scroll-lab"></div>
  </section>
</main>
${footer({ up, version })}`;
}

export function notFoundBody({ up, version }) {
  return `<main id="main" class="app-page not-found" tabindex="-1">
  <div class="not-found__mark" data-component="mark" aria-hidden="true"></div>
  <p class="label">404 · nothing moved here</p>
  <h1 class="app-page__title" tabindex="-1">This page does not exist.</h1>
  <p class="app-page__lede">If nothing moves, the mark disappears. Try the <a href="${up}docs/">documentation</a>, the <a href="${up}demo/">demo</a>, or search with <kbd>⌘K</kbd>.</p>
</main>
${footer({ up, version })}`;
}
