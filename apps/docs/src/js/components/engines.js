// Live engine demos: the demo app's real baseline/candidate parameters, run by the real engine
// (the browser's CSS and Web Animations, GSAP, Anime.js, Lenis), next to what MotionPR measured
// when it captured the demo app. "engines" enhances the landing page's tabs; "engine-demo" is a
// single demo inside a documentation page.
import { DUR, EASE, gsap, reducedMotion } from "../lib/motion.js";
import { loadSiteData } from "../lib/data.js";
import { edgeFades, h, watchVisibility } from "../lib/dom.js";

export const ENGINE_SCENARIOS = {
  css: {
    label: "Native CSS",
    dataset: "navigation/open",
    note: "transition: transform 320ms cubic-bezier(0.16, 1, 0.3, 1) → 560ms ease-in-out",
  },
  waapi: {
    label: "WAAPI",
    dataset: "work-grid/revealed",
    note: "element.animate(), delay: i × 70 ms → i × 120 ms",
  },
  gsap: {
    label: "GSAP",
    dataset: "gsap-intro/played",
    note: "timeline defaults: power3.out, 0.6 s → back.out(1.7), 0.9 s",
  },
  animejs: {
    label: "Anime.js",
    dataset: "anime-services/revealed",
    note: "animate(…, { delay: stagger(60) }) → stagger(110), ease out(3)",
  },
  lenis: {
    label: "Lenis",
    dataset: "lenis-journal/scrolled",
    note: "new Lenis({ lerp: 0.1 }) → lerp: 0.06",
  },
};

const frame = (variant, body) =>
  h(
    "div",
    { class: `ed-frame ed-frame--${variant}` },
    h(
      "span",
      { class: "label ed-frame__label" },
      variant === "baseline" ? "Baseline" : "Candidate",
    ),
    h("div", { class: "ed-frame__view" }, body),
  );

const DEMOS = {
  css(stage) {
    const make = (v) => {
      const panel = h("div", { class: "ed-panel" }, h("i"), h("i"), h("i"), h("i"));
      return {
        node: frame(
          v,
          h(
            "div",
            { class: `ed-css ed-css--${v}` },
            h("div", { class: "ed-page" }, h("i"), h("i")),
            panel,
          ),
        ),
        panel,
      };
    };
    const a = make("baseline");
    const b = make("candidate");
    stage.append(a.node, b.node);
    return {
      play() {
        for (const p of [a.panel, b.panel]) p.classList.remove("is-open");
        void stage.offsetWidth; // restart the transition from the closed state
        requestAnimationFrame(() => [a.panel, b.panel].forEach((p) => p.classList.add("is-open")));
      },
    };
  },
  waapi(stage) {
    const grid = () => h("div", { class: "ed-grid" }, ...Array.from({ length: 6 }, () => h("i")));
    const a = grid();
    const b = grid();
    stage.append(frame("baseline", a), frame("candidate", b));
    const run = (g, interval) =>
      [...g.children].map((tile, i) =>
        tile.animate(
          [
            { opacity: 0, transform: "translateY(28px) scale(0.98)" },
            { opacity: 1, transform: "none" },
          ],
          {
            duration: 520,
            delay: i * interval,
            easing: "cubic-bezier(0.2, 0.8, 0.2, 1)",
            fill: "both",
            id: "work-reveal",
          },
        ),
      );
    let anims = [];
    return {
      play() {
        anims.forEach((x) => x.cancel());
        anims = [...run(a, 70), ...run(b, 120)];
      },
      destroy() {
        anims.forEach((x) => x.cancel());
      },
    };
  },
  gsap(stage, ctx) {
    const hero = () =>
      h(
        "div",
        { class: "ed-hero" },
        h("p", { class: "ed-line" }, "Motion"),
        h("p", { class: "ed-line" }, "made"),
        h("p", { class: "ed-line" }, "visible"),
        h("span", { class: "ed-underline" }),
        h("span", { class: "ed-actions" }, h("i"), h("i")),
      );
    const a = hero();
    const b = hero();
    stage.append(frame("baseline", a), frame("candidate", b));
    let tls = [];
    const build = (root, candidate) => {
      const tl = gsap.timeline({
        defaults: {
          ease: candidate ? "back.out(1.7)" : "power3.out",
          duration: candidate ? 0.9 : 0.6,
        },
      });
      tl.addLabel("lines")
        .fromTo(
          root.querySelectorAll(".ed-line"),
          { yPercent: 110, opacity: 0 },
          { yPercent: 0, opacity: 1, stagger: 0.08 },
        )
        .addLabel("underline", "-=0.25")
        .fromTo(
          root.querySelector(".ed-underline"),
          { scaleX: 0 },
          { scaleX: 1, duration: 0.8, ease: "expo.out" },
          "underline",
        )
        .addLabel("actions", "<0.15")
        .fromTo(
          root.querySelector(".ed-actions"),
          { y: 18, autoAlpha: 0 },
          { y: 0, autoAlpha: 1 },
          "actions",
        );
      return tl;
    };
    return {
      play() {
        tls.forEach((t) => t.kill());
        ctx.gsap(() => {
          tls = [build(a, false), build(b, true)];
        });
      },
      destroy() {
        tls.forEach((t) => t.kill());
      },
    };
  },
  async animejs(stage) {
    const { animate, stagger } = await import("animejs");
    const list = () =>
      h("div", { class: "ed-services" }, ...Array.from({ length: 4 }, () => h("i")));
    const a = list();
    const b = list();
    stage.append(frame("baseline", a), frame("candidate", b));
    let anims = [];
    return {
      play() {
        anims.forEach((x) => x.revert?.());
        anims = [
          animate(a.children, {
            opacity: [0, 1],
            translateY: [24, 0],
            duration: 600,
            delay: stagger(60),
            ease: "out(3)",
          }),
          animate(b.children, {
            opacity: [0, 1],
            translateY: [24, 0],
            duration: 600,
            delay: stagger(110),
            ease: "out(3)",
          }),
        ];
      },
      destroy() {
        anims.forEach((x) => x.revert?.());
      },
    };
  },
  async lenis(stage) {
    const { default: Lenis } = await import("lenis");
    const make = (v, lerp) => {
      const content = h(
        "div",
        { class: "ed-scroll__content" },
        ...Array.from({ length: 12 }, (_, i) => h("i", { class: i === 8 ? "is-target" : "" })),
      );
      const wrapper = h("div", { class: "ed-scroll" }, content);
      const pos = h("span", { class: "ed-scroll__pos mono" }, "0 px");
      stage.append(frame(v, h("div", { class: "ed-scroll__wrap" }, wrapper, pos)));
      const lenis = new Lenis({
        wrapper,
        content,
        lerp: reducedMotion() ? 1 : lerp,
        autoRaf: true,
      });
      lenis.on("scroll", (l) => (pos.textContent = `${Math.round(l.animatedScroll)} px`));
      return { lenis, content };
    };
    const a = make("baseline", 0.1);
    const b = make("candidate", 0.06);
    return {
      play() {
        for (const x of [a, b]) {
          x.lenis.scrollTo(0, { immediate: true, force: true });
        }
        requestAnimationFrame(() => {
          for (const x of [a, b])
            x.lenis.scrollTo(x.content.querySelector(".is-target"), { force: true });
        });
      },
      destroy() {
        a.lenis.destroy();
        b.lenis.destroy();
      },
    };
  },
};

async function mountDemo(container, engine, ctx) {
  const stage = h("div", { class: "ed-stage" });
  const replay = h(
    "button",
    { type: "button", class: "button button--ghost button--small" },
    "Replay both",
  );
  container.append(
    stage,
    h(
      "div",
      { class: "ed-controls" },
      replay,
      h("span", { class: "label" }, ENGINE_SCENARIOS[engine].note),
    ),
  );
  const demo = await DEMOS[engine](stage, ctx);
  if (demo.destroy) ctx.track(() => demo.destroy());
  replay.addEventListener("click", () => demo.play(), { signal: ctx.signal });
  return demo;
}

export async function mount(el, ctx, name) {
  if (name === "engine-demo") {
    const engine = el.dataset.engine;
    if (!DEMOS[engine]) return;
    const data = await loadSiteData();
    if (!ctx.isMounted()) return;
    el.textContent = "";
    el.classList.add("engine-demo", "panel");
    const demo = await mountDemo(el, engine, ctx);
    const set = data.datasets[ENGINE_SCENARIOS[engine].dataset];
    // The same change on several elements (a timeline's lines) is one finding, with a count.
    const grouped = new Map();
    for (const c of set.tracks.flatMap((t) => t.changes)) {
      if (c.severity === "info") continue;
      const g = grouped.get(c.message);
      if (g) g.count++;
      else grouped.set(c.message, { ...c, count: 1 });
    }
    const changes = [...grouped.values()]
      .map((c) => (c.count > 1 ? { ...c, message: `${c.message} · ${c.count} elements` } : c))
      .slice(0, 3);
    const stagger = set.stagger.map((sg) => ({
      severity: sg.severity,
      message: `Stagger interval ${sg.baselineInterval}ms → ${sg.candidateInterval}ms across ${sg.members} elements`,
    }));
    const scroll = set.scroll.comparisons.flatMap((c) => c.changes);
    const list = [...stagger, ...scroll, ...changes].slice(0, 4);
    el.append(
      h(
        "ul",
        { class: "timeline__changes" },
        ...list.map((c) =>
          h(
            "li",
            {},
            h("span", { class: `sev sev--${c.severity}` }, c.severity),
            h("span", {}, c.message),
          ),
        ),
      ),
      h(
        "p",
        { class: "label ed-source" },
        `MotionPR's findings for the demo app's ${set.scenario} scenario`,
      ),
    );
    let played = false;
    ctx.track(
      watchVisibility(
        el,
        (v) => {
          if (v && !played) {
            played = true;
            demo.play();
          }
        },
        "-20% 0px",
      ),
    );
    return;
  }

  // Landing tabs: server-rendered panels with code and findings; demos mount on first view.
  const tabs = [...el.querySelectorAll('[role="tab"]')];
  const panels = tabs.map((t) => document.getElementById(t.getAttribute("aria-controls")));
  const indicator = el.querySelector(".engines__indicator");
  const list = indicator.parentElement;
  // The tab list scrolls sideways on phones and the indicator scrolls with it: place it by the
  // tab's offset in the list, not by where the tab is on screen.
  const under = (tab) => ({ x: tab.offsetLeft, width: tab.offsetWidth });
  const reveal = (tab, smooth) => {
    const pad = 24;
    const left = tab.offsetLeft - pad;
    const right = tab.offsetLeft + tab.offsetWidth + pad - list.clientWidth;
    const to = list.scrollLeft > left ? left : list.scrollLeft < right ? right : null;
    if (to !== null) list.scrollTo({ left: to, behavior: smooth ? "smooth" : "auto" });
  };
  const demos = new Map();
  const ensure = async (i) => {
    const engine = tabs[i].dataset.engine;
    if (demos.has(engine)) return demos.get(engine);
    const container = panels[i].querySelector("[data-engine-stage]");
    const p = mountDemo(container, engine, ctx);
    demos.set(engine, p);
    return p;
  };
  const select = async (i, { focus = false, animate = true } = {}) => {
    tabs.forEach((t, j) => {
      t.setAttribute("aria-selected", String(i === j));
      t.tabIndex = i === j ? 0 : -1;
      panels[j].hidden = i !== j;
    });
    if (focus) tabs[i].focus({ preventScroll: true });
    reveal(tabs[i], animate && !reducedMotion());
    const to = under(tabs[i]);
    if (animate && !reducedMotion()) {
      gsap.to(indicator, { ...to, duration: DUR.slow, ease: EASE.out });
      gsap.fromTo(
        panels[i].querySelectorAll(".engines__code, .engines__findings, [data-engine-stage]"),
        { opacity: 0, y: 12 },
        { opacity: 1, y: 0, duration: DUR.slow, ease: EASE.out, stagger: 0.05 },
      );
    } else gsap.set(indicator, to);
    const demo = await ensure(i);
    if (ctx.isMounted()) demo.play();
  };
  tabs.forEach((t, i) => t.addEventListener("click", () => select(i), { signal: ctx.signal }));
  tabs[0].parentElement.addEventListener(
    "keydown",
    (e) => {
      const i = tabs.indexOf(document.activeElement);
      if (i < 0) return;
      const n = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 }[e.key];
      if (n === undefined) return;
      e.preventDefault();
      select((n + tabs.length) % tabs.length, { focus: true });
    },
    { signal: ctx.signal },
  );
  // Build the first tab's demo now, while the section is still off screen: it is most of the
  // panel's height, and building it on arrival pushed the next section down in view. It plays
  // when the section is seen.
  void ensure(0);
  let first = true;
  ctx.track(
    watchVisibility(
      el,
      (v) => {
        if (v && first) {
          first = false;
          select(0, { animate: false });
        }
      },
      "-15% 0px",
    ),
  );
  ctx.track(edgeFades(list));
  const ro = new ResizeObserver(() => {
    const i = tabs.findIndex((t) => t.getAttribute("aria-selected") === "true");
    if (i < 0) return;
    gsap.set(indicator, under(tabs[i]));
  });
  ro.observe(el);
  ctx.track(ro);
}
