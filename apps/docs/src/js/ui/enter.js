// Entrance choreography for a freshly shown page. Roles, not one generic fade:
//   title  — rises out of its own line (mask), the brand curve, the longest move on the page
//   lede   — follows a beat later, shorter travel
//   blocks — the first screenful of content settles in a tight stagger; the rest is simply there
//   toc    — items arrive top to bottom, quietly
import { DUR, EASE, STAGGER, gsap, reducedMotion } from "../lib/motion.js";

/** Delay between the hero's lines, in seconds. */
const HERO_STAGGER = 0.09;

/**
 * The eyebrow's letters close in to the spacing the stylesheet gives it at this width (narrower on
 * phones). They start only as far apart as still fits on one line: a line that wrapped during the
 * entrance pushed the whole hero down, and it jumped back up when the spacing was cleared.
 */
function eyebrowSpacing(el) {
  const style = getComputedStyle(el);
  const em = parseFloat(style.fontSize) || 12;
  const rest = parseFloat(style.letterSpacing) || 0;
  const range = document.createRange();
  range.selectNodeContents(el);
  const text = range.getBoundingClientRect();
  const oneLine = text.height < (parseFloat(style.lineHeight) || em * 1.4) * 1.5;
  const room = Math.max(0, el.clientWidth - text.width) * 0.9;
  const extra = oneLine ? Math.min(0.12 * em, room / Math.max(1, el.textContent.length)) : 0;
  return { from: `${rest + extra}px`, to: `${rest}px` };
}

export function enter(shell) {
  if (reducedMotion()) {
    shell.querySelectorAll("[data-reveal], [data-hero]").forEach((el) => (el.style.opacity = ""));
    document.documentElement.classList.add("is-entered");
    return null;
  }
  const tl = gsap.timeline({
    defaults: { ease: EASE.out },
    onComplete: () => document.documentElement.classList.add("is-entered"),
  });
  const layout = shell.dataset.layout;

  if (layout === "landing") {
    // The staircase: each line rises 90 ms after the previous one.
    const lines = shell.querySelectorAll('[data-hero="line"]');
    // The pre-entrance CSS hides lines with translateY(108%); start from an explicit y: 0 so the
    // offset GSAP reads from it does not survive the entrance.
    tl.fromTo(
      lines,
      { yPercent: 108, y: 0 },
      { yPercent: 0, y: 0, duration: 1.15, stagger: HERO_STAGGER },
      0.15,
    );
    const eyebrow = shell.querySelector('[data-hero="eyebrow"]');
    if (eyebrow) {
      const spacing = eyebrowSpacing(eyebrow);
      tl.fromTo(
        eyebrow,
        { opacity: 0, y: 8, letterSpacing: spacing.from },
        { opacity: 1, y: 0, letterSpacing: spacing.to, duration: 1.1, clearProps: "letterSpacing" },
        0.02,
      );
    }
    tl.fromTo(
      shell.querySelectorAll('[data-hero="lede"], [data-hero="actions"], [data-hero="install"]'),
      { opacity: 0, y: 14 },
      { opacity: 1, y: 0, duration: DUR.story, stagger: 0.07 },
      0.55,
    );
    // The horizon draws its own intro (the circles separate); here it only comes up out of the
    // dark, slower than everything else.
    tl.fromTo(
      shell.querySelector('[data-hero="horizon"]'),
      { opacity: 0, y: 24 },
      { opacity: 1, y: 0, duration: DUR.intro, ease: EASE.out },
      0.25,
    );
    tl.fromTo(
      shell.querySelector('[data-hero="index"]'),
      { opacity: 0 },
      { opacity: 1, duration: DUR.slow },
      0.9,
    );
    return tl;
  }

  const title = shell.querySelector('[data-reveal="title"] .h1-inner');
  const lede = shell.querySelector('[data-reveal="lede"]');
  if (title) tl.fromTo(title, { yPercent: 104, y: 0 }, { yPercent: 0, y: 0, duration: 0.7 }, 0);
  if (lede) tl.fromTo(lede, { opacity: 0, y: 10 }, { opacity: 1, y: 0, duration: DUR.slow }, 0.08);
  const article = shell.querySelector("[data-docs-article]") ?? shell.querySelector(".app-page");
  if (article) {
    const fold = innerHeight * 1.1;
    const blocks = [...article.children].filter(
      (el) =>
        !el.matches("h1, [data-reveal], .app-page__head") && el.getBoundingClientRect().top < fold,
    );
    if (blocks.length)
      tl.fromTo(
        blocks.slice(0, 8),
        { opacity: 0, y: 12 },
        {
          opacity: 1,
          y: 0,
          duration: DUR.slow,
          stagger: STAGGER.base,
          clearProps: "transform,opacity",
        },
        0.14,
      );
  }
  const toc = shell.querySelectorAll(".toc li");
  if (toc.length)
    tl.fromTo(
      toc,
      { opacity: 0, x: -6 },
      {
        opacity: 1,
        x: 0,
        duration: DUR.base,
        stagger: STAGGER.tight,
        clearProps: "transform,opacity",
      },
      0.2,
    );
  const head = shell.querySelector(".app-page__head");
  if (head)
    tl.fromTo(
      head.querySelectorAll(".label, .app-page__lede"),
      { opacity: 0, y: 10 },
      { opacity: 1, y: 0, duration: DUR.slow, stagger: 0.06 },
      0.1,
    );
  return tl;
}
