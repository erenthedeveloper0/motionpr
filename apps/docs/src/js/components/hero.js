// The hero instrument: one real animation, baseline and candidate, on one clock.
//
// Data: the demo app's navigation panel as MotionPR captured it (site-data.json, dataset
// navigation/open): baseline 320 ms on cubic-bezier(0.16, 1, 0.3, 1), candidate 560 ms on
// ease-in-out, with their recorded translateX samples and 65-sample easing curves.
//
// The "difference" view is the brand's own construction (brand/README.md): two circles, one per
// version, travel the 45° axis by each version's eased progress; drawn with XOR compositing, only
// the pixels where they differ remain. When both versions agree the mark disappears.
import { DUR, EASE, gsap, reducedMotion } from "../lib/motion.js";
import { createClock } from "../lib/clock.js";
import { dataset, shortKey } from "../lib/data.js";
import { $, easedAt, h, pathFrom, s, watchVisibility } from "../lib/dom.js";

const BLUE = "#839CF6";
const PEACH = "#ECA67A";
const STOPS = [
  [0, "#839CF6"],
  [0.38, "#7E4AE6"],
  [0.72, "#E5A9C7"],
  [1, "#ECA67A"],
];
const SPEEDS = [0.25, 0.5, 1];

/** Value of a recorded channel at window time t (linear between samples, held outside). */
function channelAt(side, ci, t) {
  const rows = side?.samples;
  if (!rows?.length) return null;
  if (t <= rows[0][0]) return rows[0][2 + ci];
  for (let i = 1; i < rows.length; i++) {
    if (rows[i][0] >= t) {
      const [t0, , ...a] = rows[i - 1];
      const [t1, , ...b] = rows[i];
      const k = t1 > t0 ? (t - t0) / (t1 - t0) : 1;
      return a[ci] + (b[ci] - a[ci]) * k;
    }
  }
  return rows.at(-1)[2 + ci];
}

export async function mount(el, ctx, name) {
  const compact = name === "compare" || el.hasAttribute("data-compact");
  const { set } = await dataset(el.dataset.dataset || "navigation/open");
  if (!ctx.isMounted()) return;
  const trackKey = el.dataset.track || "motionpr-id:nav-panel::css-transition::transform";
  const track =
    set.tracks.find((t) => t.key === trackKey) ?? set.tracks.find((t) => t.status === "changed");
  const B = track.baseline;
  const C = track.candidate;
  const end = Math.max(B.start + B.delay + B.duration, C.start + C.delay + C.duration);
  const windowEnd = Math.ceil(end / 20) * 20 + 20;
  const links = set.tracks.filter((t) =>
    /nav-link-\d::css-transition::(opacity|transform)/.test(t.key),
  );
  const txIndex = track.channels.indexOf("translateX");

  el.textContent = "";
  el.classList.add("instrument");
  if (compact) el.classList.add("instrument--compact");
  const canvas = h("canvas", { class: "instrument__xor", "aria-hidden": "true" });
  const deltaLabel = h("span", { class: "instrument__delta label" }, "Δ 0.00 r");
  const frame = (variant) => {
    const panel = h(
      "div",
      { class: "lane__panel" },
      ...[1, 2, 3, 4].map((i) => h("span", { class: "lane__link", "data-link": String(i) })),
    );
    const node = h(
      "div",
      { class: `lane lane--${variant}` },
      h("span", { class: "lane__label label" }, variant === "baseline" ? "Baseline" : "Candidate"),
      h(
        "div",
        { class: "lane__frame" },
        h("div", { class: "lane__page" }, h("i"), h("i"), h("i")),
        panel,
      ),
    );
    return { node, panel, links: [...panel.querySelectorAll(".lane__link")] };
  };
  const fb = frame("baseline");
  const fc = frame("candidate");

  // Timeline (SVG): ruler, one bar per version with its easing curve, a shared playhead.
  const W = 640;
  const H = 112;
  const L = 86;
  const R = 58;
  const x = (t) => L + (t / windowEnd) * (W - L - R);
  const svg = s("svg", {
    class: "instrument__timeline",
    viewBox: `0 0 ${W} ${H}`,
    role: "img",
    "aria-label": `Timeline: baseline ${B.duration} ms, candidate ${C.duration} ms`,
  });
  for (let t = 0; t <= windowEnd; t += 100) {
    svg.append(s("line", { x1: x(t), x2: x(t), y1: 18, y2: H - 10, class: "tl-grid" }));
    svg.append(
      s(
        "text",
        { x: x(t), y: 11, class: "tl-tick", "text-anchor": "middle" },
        document.createTextNode(`${t}`),
      ),
    );
  }
  const bar = (side, y, color, label) => {
    const x0 = x(side.start + side.delay);
    const x1 = x(side.start + side.delay + side.duration);
    const g = s("g", { class: "tl-bar" });
    g.append(s("text", { x: 0, y: y + 15, class: "tl-label" }, document.createTextNode(label)));
    g.append(
      s("rect", {
        x: x0,
        y,
        width: x1 - x0,
        height: 26,
        rx: 4,
        fill: color,
        "fill-opacity": 0.12,
        stroke: color,
        "stroke-opacity": 0.55,
      }),
    );
    const pts = side.easing.samples.map((v, i, a) => [
      x0 + ((x1 - x0) * i) / (a.length - 1),
      y + 23 - v * 20,
    ]);
    const curve = s("path", {
      d: pathFrom(pts),
      fill: "none",
      stroke: color,
      "stroke-width": 1.6,
      class: "tl-curve",
    });
    g.append(curve);
    svg.append(g);
    const dur = s(
      "text",
      { x: x1 + 6, y: y + 17, class: "tl-dur" },
      document.createTextNode(`${side.duration} ms`),
    );
    return { curve, x1, dur };
  };
  const bb = bar(B, 24, BLUE, "Baseline");
  const bc = bar(C, 62, PEACH, "Candidate");
  const playhead = s("line", { x1: x(0), x2: x(0), y1: 18, y2: H - 6, class: "tl-playhead" });
  // The durations sit where the playhead ends up (just past the longer bar): drawn after it, with
  // a halo, the line passes behind them instead of striking them through.
  svg.append(playhead, bb.dur, bc.dur);

  const readout = h("dl", { class: "instrument__readout" });
  const field = (label) => {
    const dd = h("dd", {}, "—");
    readout.append(h("div", {}, h("dt", { class: "label" }, label), dd));
    return dd;
  };
  const outT = field("t");
  const outB = field("Baseline");
  const outC = field("Candidate");
  const outD = field("Δ progress");

  const play = h("button", { type: "button", class: "icon-button", "aria-label": "Play" });
  const range = h("input", {
    type: "range",
    class: "range",
    min: 0,
    max: windowEnd,
    step: 1,
    value: 0,
    "aria-label": "Time in milliseconds",
  });
  const speed = h(
    "div",
    { class: "segmented", role: "group", "aria-label": "Playback speed" },
    h("span", { class: "segmented__thumb", "aria-hidden": "true" }),
    ...SPEEDS.map((v) =>
      h(
        "button",
        { type: "button", "data-speed": String(v), "aria-pressed": String(v === 0.25) },
        `${v}×`,
      ),
    ),
  );
  const findings = h("ul", {
    class: "instrument__findings",
    "aria-label": "What MotionPR reported",
  });
  for (const ch of track.changes)
    findings.append(
      h(
        "li",
        { class: "finding" },
        h("span", { class: `sev sev--${ch.severity}` }, ch.severity),
        h("span", { class: "finding__msg" }, ch.message),
      ),
    );

  el.append(
    h(
      "div",
      { class: "instrument__head" },
      h("span", { class: "label" }, h("b", {}, set.scenario), ` · ${set.checkpoint}`),
      h(
        "span",
        { class: "label instrument__track" },
        `${shortKey(track.element)} · transform · css-transition`,
      ),
    ),
    h(
      "div",
      { class: "instrument__stage" },
      h(
        "div",
        { class: "instrument__diff" },
        canvas,
        deltaLabel,
        h(
          "span",
          { class: "instrument__axis label", "aria-hidden": "true" },
          "45° · direction of motion",
        ),
      ),
      h("div", { class: "instrument__lanes" }, fb.node, fc.node),
    ),
    svg,
    h("div", { class: "instrument__bar" }, play, range, speed, readout),
    findings,
    h(
      "p",
      { class: "instrument__source label" },
      "Real capture · demo app · Chromium · slowed down to be readable",
    ),
  );

  // ---- drawing ---------------------------------------------------------------------------
  const c2d = canvas.getContext("2d");
  let cw = 0;
  let ch = 0;
  let dpr = 1;
  const resize = () => {
    const box = canvas.getBoundingClientRect();
    dpr = Math.min(2, window.devicePixelRatio || 1);
    cw = Math.max(1, box.width);
    ch = Math.max(1, box.height);
    canvas.width = Math.round(cw * dpr);
    canvas.height = Math.round(ch * dpr);
    render(clock?.time ?? 0);
  };
  let reveal = { frame: 1 };

  function drawDifference(pb, pc) {
    const ctx2 = c2d;
    ctx2.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx2.clearRect(0, 0, cw, ch);
    const r = Math.min(cw, ch) * 0.28;
    // Travel along 45°, lower-left → upper-right, sized so the largest recorded deviation spreads
    // the circles by about one radius.
    const D = r * 1.45;
    const cx0 = cw / 2 - (D / 2) * Math.SQRT1_2;
    const cy0 = ch / 2 + (D / 2) * Math.SQRT1_2;
    const at = (p) => [cx0 + p * D * Math.SQRT1_2, cy0 - p * D * Math.SQRT1_2];
    const [bx, by] = at(pb);
    const [cx, cy] = at(pc);
    // Guide: the motion axis with start and end ticks.
    ctx2.globalAlpha = 0.5 * reveal.frame;
    ctx2.strokeStyle = "rgba(243,241,250,0.16)";
    ctx2.setLineDash([2, 5]);
    ctx2.beginPath();
    const [sx, sy] = at(-0.25);
    const [ex, ey] = at(1.25);
    ctx2.moveTo(sx, sy);
    ctx2.lineTo(ex, ey);
    ctx2.stroke();
    ctx2.setLineDash([]);
    ctx2.globalAlpha = 1;
    // XOR: keep only what differs, then paint it with the brand gradient along the motion.
    ctx2.globalCompositeOperation = "source-over";
    ctx2.fillStyle = "#fff";
    ctx2.beginPath();
    ctx2.arc(bx, by, r, 0, Math.PI * 2);
    ctx2.fill();
    ctx2.globalCompositeOperation = "xor";
    ctx2.beginPath();
    ctx2.arc(cx, cy, r, 0, Math.PI * 2);
    ctx2.fill();
    ctx2.globalCompositeOperation = "source-in";
    const g = ctx2.createLinearGradient(
      cw / 2 - r * 1.6,
      ch / 2 + r * 1.6,
      cw / 2 + r * 1.6,
      ch / 2 - r * 1.6,
    );
    for (const [o, c] of STOPS) g.addColorStop(o, c);
    ctx2.fillStyle = g;
    ctx2.fillRect(0, 0, cw, ch);
    ctx2.globalCompositeOperation = "source-over";
    // Outlines: where each version is.
    ctx2.lineWidth = 1.25;
    ctx2.globalAlpha = 0.9 * reveal.frame;
    ctx2.strokeStyle = BLUE;
    ctx2.setLineDash([3, 4]);
    ctx2.beginPath();
    ctx2.arc(bx, by, r, 0, Math.PI * 2);
    ctx2.stroke();
    ctx2.setLineDash([]);
    ctx2.strokeStyle = PEACH;
    ctx2.beginPath();
    ctx2.arc(cx, cy, r, 0, Math.PI * 2);
    ctx2.stroke();
    ctx2.globalAlpha = 1;
    deltaLabel.textContent = `Δ ${((Math.abs(pb - pc) * D) / r).toFixed(2)} r`;
  }

  function applyLane(f, which, t) {
    const side = track[which];
    const tx = channelAt(side, txIndex, t);
    // translateX goes from the panel's own width (400 px) to 0: express it in % of the panel.
    if (tx !== null) f.panel.style.transform = `translateX(${((tx / 400) * 100).toFixed(3)}%)`;
    links.forEach((lt) => {
      const n = Number(/nav-link-(\d)/.exec(lt.key)[1]);
      const node = f.links[n - 1];
      const sd = lt[which];
      if (!node || !sd) return;
      const p = easedAt(sd, t);
      if (lt.key.endsWith("opacity")) node.style.opacity = p.toFixed(3);
      else node.style.translate = `${((1 - p) * 24).toFixed(2)}px 0`;
    });
  }

  function render(t) {
    const pb = easedAt(B, t);
    const pc = easedAt(C, t);
    drawDifference(pb, pc);
    applyLane(fb, "baseline", t);
    applyLane(fc, "candidate", t);
    const px = x(t);
    playhead.setAttribute("x1", px);
    playhead.setAttribute("x2", px);
    range.value = String(Math.round(t));
    outT.textContent = `${Math.round(t)} ms`;
    outB.textContent = `${Math.round(pb * 100)}%`;
    outC.textContent = `${Math.round(pc * 100)}%`;
    outD.textContent = `${Math.round(Math.abs(pb - pc) * 100)}%`;
    el.style.setProperty("--diff", Math.abs(pb - pc).toFixed(3));
  }

  // ---- playback --------------------------------------------------------------------------
  const setPlayIcon = (playing) => {
    play.setAttribute("aria-label", playing ? "Pause" : "Play");
    play.innerHTML = playing
      ? '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><rect x="3.5" y="2.5" width="3" height="11" rx="1"/><rect x="9.5" y="2.5" width="3" height="11" rx="1"/></svg>'
      : '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M4 2.8v10.4a.6.6 0 0 0 .9.5l8.4-5.2a.6.6 0 0 0 0-1L4.9 2.3a.6.6 0 0 0-.9.5Z"/></svg>';
  };
  const clock = ctx.track(
    createClock({
      duration: windowEnd,
      loop: true,
      hold: 1400,
      speed: 0.25,
      onTick: render,
      onState: ({ playing }) => setPlayIcon(playing),
    }),
  );
  setPlayIcon(false);
  play.addEventListener("click", () => clock.toggle(), { signal: ctx.signal });
  range.addEventListener(
    "input",
    () => {
      clock.pause();
      clock.seek(Number(range.value));
    },
    { signal: ctx.signal },
  );
  const thumb = $(".segmented__thumb", speed);
  const placeThumb = (btn, animate) => {
    const to = { x: btn.offsetLeft - 3, width: btn.offsetWidth };
    if (animate && !reducedMotion()) gsap.to(thumb, { ...to, duration: DUR.base, ease: EASE.out });
    else gsap.set(thumb, to);
  };
  for (const btn of speed.querySelectorAll("button")) {
    btn.addEventListener(
      "click",
      () => {
        clock.speed = Number(btn.dataset.speed);
        speed
          .querySelectorAll("button")
          .forEach((b) => b.setAttribute("aria-pressed", String(b === btn)));
        placeThumb(btn, true);
      },
      { signal: ctx.signal },
    );
  }
  requestAnimationFrame(() => placeThumb(speed.querySelector('[aria-pressed="true"]'), false));

  const ro = new ResizeObserver(resize);
  ro.observe(canvas);
  ctx.track(ro);
  resize();

  // Entrance: the frame and both bars draw in, then playback starts (full motion only).
  if (reducedMotion()) {
    // A still frame at the moment the versions differ most, and no autoplay.
    let best = 0;
    let bestT = 0;
    for (let t = 0; t <= windowEnd; t += 2) {
      const d = Math.abs(easedAt(B, t) - easedAt(C, t));
      if (d > best) [best, bestT] = [d, t];
    }
    clock.seek(bestT);
    return;
  }
  clock.seek(0);
  ctx.gsap(() => {
    const curves = [bb.curve, bc.curve];
    for (const c of curves) {
      const len = c.getTotalLength();
      gsap.set(c, { strokeDasharray: len, strokeDashoffset: len });
    }
    const tl = gsap.timeline({ delay: compact ? 0 : 0.5 });
    reveal.frame = 0;
    tl.to(
      reveal,
      { frame: 1, duration: DUR.story, ease: EASE.out, onUpdate: () => render(clock.time) },
      0,
    )
      .to(curves, { strokeDashoffset: 0, duration: 1.1, ease: EASE.out, stagger: 0.12 }, 0.1)
      .fromTo(
        el.querySelectorAll(".lane"),
        { opacity: 0, y: 10 },
        { opacity: 1, y: 0, duration: DUR.slow, stagger: 0.08 },
        0.15,
      )
      .fromTo(
        findings.children,
        { opacity: 0, y: 8 },
        { opacity: 1, y: 0, duration: DUR.slow, stagger: 0.08 },
        0.6,
      );
  });
  let started = false;
  ctx.track(
    watchVisibility(el, (visible) => {
      clock.setVisible(visible);
      if (visible && !started) {
        started = true;
        setTimeout(() => ctx.isMounted() && clock.play(), compact ? 200 : 900);
      }
    }),
  );
  return () => el.style.removeProperty("--diff");
}
