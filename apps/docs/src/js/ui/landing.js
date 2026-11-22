// Landing page: Lenis smooth scrolling (pointer devices, full motion only) synchronized with GSAP
// ScrollTrigger, plus each section's own entrance. Lenis is created here and destroyed when the
// visitor leaves the page, so documentation pages keep native scrolling.
import Lenis from "lenis";
import { edgeFades } from "../lib/dom.js";
import { DUR, EASE, ScrollTrigger, gsap, reducedMotion } from "../lib/motion.js";

let lenis = null;
export const getLenis = () => lenis;

export function mountLanding(shell) {
  const cleanups = [];
  const fine = matchMedia("(pointer: fine)").matches;
  if (!reducedMotion() && fine) {
    // In-page anchors go through the router (main.js scrollToTarget), not Lenis's own handler.
    lenis = new Lenis({ lerp: 0.1, autoRaf: false });
    const raf = (time) => lenis?.raf(time * 1000);
    lenis.on("scroll", ScrollTrigger.update);
    gsap.ticker.add(raf);
    cleanups.push(() => {
      gsap.ticker.remove(raf);
      lenis?.destroy();
      lenis = null;
      document.documentElement.classList.remove(
        "lenis",
        "lenis-smooth",
        "lenis-scrolling",
        "lenis-stopped",
      );
    });
  }

  // Install commands scroll inside their pill on phones: fade only the edge with more to read.
  for (const code of shell.querySelectorAll(".install code")) cleanups.push(edgeFades(code));

  // Section titles: the muted second line slides in from the side the timeline runs to.
  const ctx = gsap.context(() => {
    if (reducedMotion()) return;
    for (const head of shell.querySelectorAll(".section__head")) {
      const index = head.querySelector(".section__index");
      const title = head.querySelector(".section__title");
      const muted = title?.querySelector(".muted");
      const tl = gsap.timeline({ scrollTrigger: { trigger: head, start: "top 82%", once: true } });
      if (index)
        tl.fromTo(
          index,
          { opacity: 0, x: -12 },
          { opacity: 1, x: 0, duration: DUR.slow, ease: EASE.out },
          0,
        );
      if (title)
        tl.fromTo(
          title,
          { opacity: 0, y: 26 },
          { opacity: 1, y: 0, duration: DUR.story, ease: EASE.out },
          0.05,
        );
      if (muted)
        tl.fromTo(
          muted,
          { opacity: 0, x: 40 },
          { opacity: 1, x: 0, duration: 1.1, ease: EASE.out },
          0.2,
        );
      const aside = head.querySelector(".section__aside");
      if (aside)
        tl.fromTo(
          aside,
          { opacity: 0, y: 14 },
          { opacity: 1, y: 0, duration: DUR.story, ease: EASE.out },
          0.25,
        );
    }
    // The index under the horizon: each leader draws itself towards its section's name.
    const index = shell.querySelector(".hero__index");
    if (index) {
      gsap
        .timeline({ scrollTrigger: { trigger: index, start: "top 92%", once: true } })
        .fromTo(
          index.querySelectorAll(".hero__index-leader"),
          { scaleX: 0 },
          { scaleX: 1, duration: 1, ease: EASE.out, stagger: 0.06 },
          0,
        )
        .fromTo(
          index.querySelectorAll(".hero__index-n"),
          { opacity: 0 },
          { opacity: 1, duration: DUR.slow, stagger: 0.06 },
          0,
        )
        .fromTo(
          index.querySelectorAll(".hero__index-label"),
          { opacity: 0, x: 14 },
          {
            opacity: 1,
            x: 0,
            duration: DUR.story,
            ease: EASE.out,
            stagger: 0.06,
            clearProps: "transform",
          },
          0.25,
        );
    }
    // As the hero leaves, its words lift away a little faster than the horizon: depth, briefly.
    const copy = shell.querySelector(".hero__copy");
    if (copy)
      gsap.to(copy, {
        y: -70,
        opacity: 0.35,
        ease: "none",
        scrollTrigger: {
          trigger: shell.querySelector(".hero"),
          start: "top top",
          end: "60% top",
          scrub: true,
        },
      });
    // CTA: the title tracks scroll a little.
    const cta = shell.querySelector(".cta__title");
    if (cta)
      gsap.fromTo(
        cta,
        { y: 40 },
        {
          y: -10,
          ease: "none",
          scrollTrigger: { trigger: cta, start: "top bottom", end: "bottom top", scrub: true },
        },
      );
  }, shell);
  cleanups.push(() => ctx.revert());
  return () => cleanups.forEach((c) => c());
}
