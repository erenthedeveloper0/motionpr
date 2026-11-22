// The workflow story (landing page, section 02). A sticky stage shows one real checkpoint — the
// demo app's navigation menu opening — going through the five stages while the steps scroll
// past. Nothing is pinned: the page scrolls normally and each step changes the stage's state as
// it reaches the reading line. Step 4 also scrubs a playhead with scroll.
import { DUR, EASE, ScrollTrigger, gsap, reducedMotion } from "../lib/motion.js";
import { dataset, loadSiteData, shortKey } from "../lib/data.js";
import { h, pathFrom, s, watchVisibility } from "../lib/dom.js";

const BLUE = "#839CF6";
const PEACH = "#ECA67A";
const W = 560;
const H = 420;

export async function mount(el, ctx) {
  const { set } = await dataset("navigation/open");
  const data = await loadSiteData();
  if (!ctx.isMounted()) return;
  // On the landing page the stage and the steps are server-rendered and scroll drives the
  // states. Anywhere else (a docs page) the component builds a compact version: the same stage,
  // with step tabs that advance on their own while it is on screen.
  const compact = !el.querySelector("[data-workflow-stage]");
  if (compact) buildCompact(el);
  const stageEl = el.querySelector("[data-workflow-stage]");
  const steps = [...el.querySelectorAll(".workflow__step")];
  const tracks = [...set.tracks].sort(
    (a, b) => a.baseline.start + a.baseline.delay - (b.baseline.start + b.baseline.delay),
  );
  const main = tracks.find((t) => t.key.includes("nav-panel"));
  const end = 600;

  const svg = s("svg", {
    viewBox: `0 0 ${W} ${H}`,
    class: "workflow__svg",
    role: "img",
    "aria-label": "MotionPR capturing, comparing and reporting the demo app's navigation menu",
  });
  stageEl.append(svg);
  const layer = (name) => svg.appendChild(s("g", { class: `wf-${name}` }));

  // 1. Capture: a browser window, a click, records appearing as they are discovered.
  const browser = layer("browser");
  browser.append(s("rect", { x: 40, y: 30, width: 480, height: 170, rx: 10, class: "wf-window" }));
  browser.append(s("line", { x1: 40, x2: 520, y1: 54, y2: 54, class: "wf-rule" }));
  for (let i = 0; i < 3; i++)
    browser.append(s("circle", { cx: 58 + i * 12, cy: 42, r: 3.5, class: "wf-dot-ui" }));
  const panel = s("rect", { x: 520, y: 55, width: 150, height: 144, class: "wf-panel" });
  const clip = s(
    "clipPath",
    { id: "wf-clip" },
    s("rect", { x: 40, y: 54, width: 480, height: 146, rx: 0 }),
  );
  svg.prepend(s("defs", {}, clip));
  const panelG = s("g", { "clip-path": "url(#wf-clip)" }, panel);
  for (let i = 0; i < 4; i++)
    panelG.append(
      s("rect", { x: 540, y: 84 + i * 22, width: 80 - i * 8, height: 6, rx: 3, class: "wf-link" }),
    );
  browser.append(panelG);
  browser.append(s("rect", { x: 70, y: 76, width: 96, height: 26, rx: 13, class: "wf-button" }));
  const cursor = s("path", {
    d: "M0 0 L0 16 L4.5 12 L8 19 L10.5 18 L7.2 11 L13 11 Z",
    class: "wf-cursor",
    transform: "translate(250 160)",
  });
  browser.append(cursor);

  const axisY = 262;
  const x = (t) => 112 + (t / end) * 400;
  const axis = layer("axis");
  axis.append(s("line", { x1: 112, x2: 512, y1: axisY, y2: axisY, class: "wf-rule" }));
  for (let t = 0; t <= end; t += 100)
    axis.append(
      s(
        "text",
        { x: x(t), y: axisY + 16, class: "wf-tick", "text-anchor": "middle" },
        document.createTextNode(`${t}`),
      ),
    );
  axis.append(
    s(
      "text",
      { x: 112, y: axisY - 10, class: "wf-caption" },
      document.createTextNode(
        `${tracks.length} animations discovered · window ${set.window.baseline} ms`,
      ),
    ),
  );

  const dots = layer("dots");
  tracks.forEach((t) =>
    dots.append(
      s("circle", {
        cx: x(t.baseline.start + t.baseline.delay),
        cy: axisY,
        r: 4,
        class: "wf-record",
      }),
    ),
  );

  // 2. Analyze: bars with their easing curves; a filmstrip of frames.
  const rowH = 13;
  const bars = layer("bars");
  const rows = tracks.map((t, i) => {
    const y = 236 - (tracks.length - i) * (rowH + 3) + 0;
    const b = t.baseline;
    const x0 = x(b.start + b.delay);
    const x1 = x(b.start + b.delay + b.duration);
    const g = s("g", { class: `wf-row${t === main ? " is-main" : ""}` });
    const rect = s("rect", {
      x: x0,
      y,
      width: x1 - x0,
      height: rowH,
      rx: 3,
      class: "wf-bar wf-bar--b",
    });
    const pts = b.easing.samples.map((v, k, a) => [
      x0 + ((x1 - x0) * k) / (a.length - 1),
      y + rowH - 2 - v * (rowH - 4),
    ]);
    const curve = s("path", { d: pathFrom(pts), class: "wf-curve wf-curve--b" });
    g.append(rect, curve);
    let cand = null;
    if (t.candidate) {
      const c = t.candidate;
      const cx0 = x(c.start + c.delay);
      const cx1 = x(c.start + c.delay + c.duration);
      const crect = s("rect", {
        x: cx0,
        y: y + rowH + 1,
        width: cx1 - cx0,
        height: 4,
        rx: 2,
        class: `wf-bar wf-bar--c${t.status === "changed" ? " is-changed" : ""}`,
      });
      g.append(crect);
      cand = crect;
    }
    const prop = t.baseline.properties[0]?.property ?? "";
    g.append(
      s(
        "text",
        { x: 104, y: y + rowH - 3, class: "wf-rowlabel", "text-anchor": "end" },
        document.createTextNode(`${shortKey(t.element).replace("nav-", "")} ${prop}`),
      ),
    );
    bars.append(g);
    return { g, rect, curve, cand, t };
  });
  const film = layer("film");
  for (let i = 0; i < 15; i++)
    film.append(
      s("rect", { x: 112 + i * 26.8, y: 300, width: 23, height: 16, rx: 2, class: "wf-frame" }),
    );
  film.append(
    s(
      "text",
      { x: 112, y: 336, class: "wf-caption" },
      document.createTextNode("15 frames, rendered at exact times · 24 samples per animation"),
    ),
  );

  // 3. Compare: candidate bars; the change is labelled.
  const delta = layer("delta");
  const mainRow = rows.find((r) => r.t === main);
  const mc = main.candidate;
  const dx = x(mc.start + mc.delay + mc.duration);
  const mainY = Number(mainRow.rect.getAttribute("y"));
  delta.append(
    s("line", {
      x1: x(main.baseline.duration),
      x2: dx,
      y1: mainY + rowH + 3,
      y2: mainY + rowH + 3,
      class: "wf-delta-line",
    }),
  );
  delta.append(
    s(
      "text",
      { x: dx + 6, y: mainY + rowH + 6, class: "wf-delta" },
      document.createTextNode(`+${mc.duration - main.baseline.duration} ms`),
    ),
  );
  delta.append(
    s(
      "text",
      { x: 112, y: 300, class: "wf-caption" },
      document.createTextNode(
        `${tracks.filter((t) => t.status === "changed").length} changed · ${tracks.filter((t) => t.status === "unchanged").length} unchanged · matched by data-motionpr-id`,
      ),
    ),
  );

  // 4. Inspect: the two curves of the changed animation, a playhead scrubbed by scroll.
  const chart = layer("chart");
  const cx = (p) => 110 + p * 360;
  const cy = (v) => 330 - v * 250;
  chart.append(s("rect", { x: 110, y: 80, width: 360, height: 250, class: "wf-chartbox" }));
  for (let k = 1; k < 4; k++)
    chart.append(s("line", { x1: cx(k / 4), x2: cx(k / 4), y1: 80, y2: 330, class: "wf-grid" }));
  const curvePts = (side) => side.easing.samples.map((v, k, a) => [cx(k / (a.length - 1)), cy(v)]);
  const cb = s("path", { d: pathFrom(curvePts(main.baseline)), class: "wf-big wf-big--b" });
  const cc = s("path", { d: pathFrom(curvePts(main.candidate)), class: "wf-big wf-big--c" });
  chart.append(cb, cc);
  const ev = main.easing;
  if (ev) {
    const at = ev.maxDeviationAt;
    const vb = sampleCurve(main.baseline.easing.samples, at);
    const vc = sampleCurve(main.candidate.easing.samples, at);
    chart.append(s("line", { x1: cx(at), x2: cx(at), y1: cy(vb), y2: cy(vc), class: "wf-dev" }));
    chart.append(
      s(
        "text",
        { x: cx(at) + 8, y: (cy(vb) + cy(vc)) / 2, class: "wf-devlabel" },
        document.createTextNode(
          `max deviation ${Math.round(ev.maxDeviation * 100)}% at ${Math.round(at * 100)}%`,
        ),
      ),
    );
  }
  chart.append(
    s(
      "text",
      { x: 110, y: 70, class: "wf-caption" },
      document.createTextNode("Easing curves · normalized time → progress"),
    ),
  );
  const ph = s("line", { x1: cx(0), x2: cx(0), y1: 80, y2: 330, class: "wf-playhead" });
  const phB = s("circle", { r: 4.5, cx: cx(0), cy: cy(0), fill: BLUE });
  const phC = s("circle", { r: 4.5, cx: cx(0), cy: cy(0), fill: PEACH });
  chart.append(ph, phB, phC);
  const scrubTo = (p) => {
    ph.setAttribute("x1", cx(p));
    ph.setAttribute("x2", cx(p));
    phB.setAttribute("cx", cx(p));
    phB.setAttribute("cy", cy(sampleCurve(main.baseline.easing.samples, p)));
    phC.setAttribute("cx", cx(p));
    phC.setAttribute("cy", cy(sampleCurve(main.candidate.easing.samples, p)));
  };

  // 5. Report: the real summary of the whole demo comparison, and the exit code.
  const report = layer("report");
  const sum = data.summary;
  const counts = [
    ["critical", sum.counts.critical, "#f2667a"],
    ["warning", sum.counts.warning, "#f3c96b"],
    ["info", sum.counts.info, "#68d6e8"],
    ["uncertain", sum.counts.uncertain, "#d59ce8"],
  ];
  report.append(s("rect", { x: 70, y: 60, width: 420, height: 300, rx: 12, class: "wf-window" }));
  report.append(
    s(
      "text",
      { x: 96, y: 98, class: "wf-title" },
      document.createTextNode("MotionPR · motion regression detected"),
    ),
  );
  // Two lines: in one, the counts ran past the card's edge.
  report.append(
    s(
      "text",
      { x: 96, y: 118, class: "wf-caption" },
      document.createTextNode(
        `${sum.scenarios.total} scenarios · ${sum.animations.matched} matched · ${sum.animations.changed} changed`,
      ),
    ),
    s(
      "text",
      { x: 96, y: 133, class: "wf-caption" },
      document.createTextNode(`${sum.animations.added} added · ${sum.animations.removed} removed`),
    ),
  );
  const maxCount = Math.max(...counts.map((c) => c[1]));
  const countBars = counts.map(([label, n, color], i) => {
    const y = 150 + i * 36;
    report.append(
      s("text", { x: 96, y: y + 13, class: "wf-sev", fill: color }, document.createTextNode(label)),
    );
    const r = s("rect", {
      x: 186,
      y,
      width: Math.max(4, (n / maxCount) * 220),
      height: 16,
      rx: 3,
      fill: color,
      "fill-opacity": 0.85,
      class: "wf-count",
    });
    report.append(r);
    report.append(
      s(
        "text",
        { x: 186 + Math.max(4, (n / maxCount) * 220) + 8, y: y + 13, class: "wf-num" },
        document.createTextNode(String(n)),
      ),
    );
    return r;
  });
  report.append(
    s(
      "text",
      { x: 96, y: 326, class: "wf-exit" },
      document.createTextNode(`exit code ${sum.status === "failed" ? 1 : 0}  ·  fail on: critical`),
    ),
  );

  // ---- states ----------------------------------------------------------------------------
  const layers = { browser, axis, dots, bars, film, delta, chart, report };
  const show = {
    capture: ["browser", "axis", "dots"],
    analyze: ["axis", "bars", "film"],
    compare: ["axis", "bars", "delta"],
    inspect: ["chart"],
    report: ["report"],
  };
  const order = ["capture", "analyze", "compare", "inspect", "report"];
  let current = -1;
  const reduced = reducedMotion();

  function setStep(i) {
    if (i === current) return;
    const prev = current;
    current = i;
    steps.forEach((st, j) => st.classList.toggle("is-active", j === i));
    const name = order[i];
    const d = reduced ? 0 : 1;
    ctx.gsap(() => {
      for (const [key, node] of Object.entries(layers)) {
        const on = show[name].includes(key);
        gsap.to(node, {
          autoAlpha: on ? 1 : 0,
          duration: (on ? DUR.slow : DUR.base) * d,
          ease: on ? EASE.out : EASE.in,
          overwrite: "auto",
        });
      }
      if (name === "capture") {
        gsap.set(
          rows.map((r) => r.g),
          { autoAlpha: 1 },
        );
        const tl = gsap.timeline();
        tl.fromTo(
          cursor,
          { attr: { transform: "translate(250 160)" } },
          { attr: { transform: "translate(110 92)" }, duration: 0.7 * d, ease: EASE.inOut },
        )
          .to(cursor, {
            scale: 0.85,
            transformOrigin: "0 0",
            duration: 0.08 * d,
            yoyo: true,
            repeat: 1,
          })
          .fromTo(
            panel,
            { attr: { x: 520 } },
            { attr: { x: 370 }, duration: 0.5 * d, ease: EASE.out },
            ">-0.02",
          )
          .fromTo(
            panelG.querySelectorAll(".wf-link"),
            { attr: { x: 560 } },
            { attr: { x: 390 }, duration: 0.5 * d, ease: EASE.out, stagger: 0.04 * d },
            "<0.05",
          )
          .fromTo(
            dots.children,
            { scale: 0, transformOrigin: "50% 50%" },
            { scale: 1, duration: 0.4 * d, ease: "back.out(2.5)", stagger: 0.05 * d },
            "<",
          );
      }
      if (name === "analyze") {
        rows.forEach((r) => r.cand && gsap.set(r.cand, { autoAlpha: 0 }));
        gsap.fromTo(
          rows.map((r) => r.rect),
          { scaleX: 0, transformOrigin: "0% 50%" },
          { scaleX: 1, duration: 0.6 * d, ease: EASE.out, stagger: 0.04 * d },
        );
        for (const r of rows) {
          const len = r.curve.getTotalLength();
          gsap.fromTo(
            r.curve,
            { strokeDasharray: len, strokeDashoffset: len },
            { strokeDashoffset: 0, duration: 0.8 * d, delay: 0.25 * d, ease: EASE.out },
          );
        }
        gsap.fromTo(
          film.querySelectorAll(".wf-frame"),
          { opacity: 0, y: 6 },
          { opacity: 1, y: 0, duration: 0.3 * d, stagger: 0.03 * d },
        );
        gsap.to(
          rows.map((r) => r.g),
          { autoAlpha: 1, duration: DUR.base * d },
        );
      }
      if (name === "compare") {
        gsap.to(
          rows.map((r) => r.g),
          { autoAlpha: 1, duration: DUR.base * d },
        );
        gsap.fromTo(
          rows.filter((r) => r.cand).map((r) => r.cand),
          { scaleX: 0, transformOrigin: "0% 50%", autoAlpha: 1 },
          { scaleX: 1, duration: 0.7 * d, ease: EASE.out, stagger: 0.03 * d },
        );
        gsap.fromTo(
          delta.children,
          { opacity: 0, x: -6 },
          { opacity: 1, x: 0, duration: DUR.slow * d, delay: 0.45 * d },
        );
      }
      if (name === "inspect") {
        for (const c of [cb, cc]) {
          const len = c.getTotalLength();
          gsap.fromTo(
            c,
            { strokeDasharray: len, strokeDashoffset: len },
            { strokeDashoffset: 0, duration: 1 * d, ease: EASE.out },
          );
        }
      }
      if (name === "report") {
        gsap.fromTo(
          countBars,
          { scaleX: 0, transformOrigin: "0% 50%" },
          { scaleX: 1, duration: 0.8 * d, ease: EASE.out, stagger: 0.08 * d },
        );
      }
    });
    void prev;
  }

  if (compact) {
    ctx.gsap(() => {
      for (const node of Object.values(layers)) gsap.set(node, { autoAlpha: 0 });
    });
    const tabs = [...el.querySelectorAll('[role="tab"]')];
    const select = (i, focus = false) => {
      tabs.forEach((t, j) => {
        t.setAttribute("aria-selected", String(i === j));
        t.tabIndex = i === j ? 0 : -1;
      });
      if (focus) tabs[i].focus();
      setStep(i);
      if (order[i] === "inspect") scrubTo(0.27);
    };
    let timer = 0;
    let auto = !reduced;
    const advance = () => {
      clearTimeout(timer);
      if (!auto) return;
      timer = setTimeout(() => {
        select((current + 1) % order.length);
        advance();
      }, 3200);
    };
    tabs.forEach((t, i) =>
      t.addEventListener(
        "click",
        () => {
          auto = false; // a choice stops the tour
          clearTimeout(timer);
          select(i);
        },
        { signal: ctx.signal },
      ),
    );
    el.querySelector('[role="tablist"]').addEventListener(
      "keydown",
      (e) => {
        const i = tabs.indexOf(document.activeElement);
        const n = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 }[e.key];
        if (i < 0 || n === undefined) return;
        e.preventDefault();
        auto = false;
        clearTimeout(timer);
        select((n + tabs.length) % tabs.length, true);
      },
      { signal: ctx.signal },
    );
    ctx.track(() => clearTimeout(timer));
    ctx.track(
      watchVisibility(el, (visible) => {
        if (visible) advance();
        else clearTimeout(timer);
      }),
    );
    select(0);
    return;
  }

  ctx.gsap(() => {
    for (const node of Object.values(layers)) gsap.set(node, { autoAlpha: 0 });
    steps.forEach((step, i) => {
      ScrollTrigger.create({
        trigger: step,
        start: "top 62%",
        end: "bottom 62%",
        onToggle: (self) => self.isActive && setStep(i),
      });
    });
    const inspect = steps[order.indexOf("inspect")];
    ScrollTrigger.create({
      trigger: inspect,
      start: "top 62%",
      end: "bottom 38%",
      onUpdate: (self) => scrubTo(self.progress),
    });
  });
  setStep(0);
  scrubTo(0.27);
}

const STEPS = [
  ["Capture", "Real input, in a real browser. The agent discovers every animation as it starts."],
  ["Analyze", "Replayed at exact times with callbacks muted: values and frames are sampled."],
  ["Compare", "Matched by identity, compared field by field and curve by curve, graded by rules."],
  ["Inspect", "Both versions on one clock, with the largest deviation marked on the curve."],
  ["Report", "A summary, an offline report and an exit code your CI understands."],
];

function buildCompact(el) {
  el.textContent = "";
  el.classList.add("workflow--compact", "panel");
  const tabs = h(
    "div",
    { class: "workflow__tabs", role: "tablist", "aria-label": "Stages of a MotionPR run" },
    ...STEPS.map(([name], i) =>
      h(
        "button",
        { type: "button", role: "tab", "aria-selected": String(i === 0), tabindex: i ? -1 : 0 },
        `${i + 1} · ${name}`,
      ),
    ),
  );
  const list = h(
    "ol",
    { class: "workflow__captions" },
    ...STEPS.map(([name, text]) =>
      h("li", { class: "workflow__step" }, h("strong", {}, name), " ", text),
    ),
  );
  el.append(tabs, h("div", { class: "workflow__frame", "data-workflow-stage": "" }), list);
}

function sampleCurve(samples, p) {
  const pos = Math.min(1, Math.max(0, p)) * (samples.length - 1);
  const i = Math.floor(pos);
  const j = Math.min(samples.length - 1, i + 1);
  return samples[i] + (samples[j] - samples[i]) * (pos - i);
}
