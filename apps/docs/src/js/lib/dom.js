export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v === null || v === undefined) continue;
    if (k === "class") el.className = v;
    else if (k === "text") el.textContent = v;
    else if (k === "html") el.innerHTML = v;
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children.flat())
    if (c !== null && c !== undefined && c !== false)
      el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}
const SVGNS = "http://www.w3.org/2000/svg";
export function s(tag, attrs = {}, ...children) {
  const el = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs))
    if (v !== null && v !== undefined && v !== false) el.setAttribute(k, String(v));
  for (const c of children.flat()) if (c) el.append(c);
  return el;
}
export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const lerp = (a, b, t) => a + (b - a) * t;
export const fmtMs = (n) => `${Math.round(n)} ms`;
export const pct = (n) => `${Math.round(n * 100)}%`;
/** Linear interpolation into evenly spaced samples (an easing curve's 65 values). */
export function sampleAt(samples, x) {
  if (!samples?.length) return x;
  const pos = clamp(x, 0, 1) * (samples.length - 1);
  const i = Math.floor(pos);
  const j = Math.min(samples.length - 1, i + 1);
  return samples[i] + (samples[j] - samples[i]) * (pos - i);
}
/** Progress (0..1) of an animation side at window time t, from delay, duration and its curve. */
export function easedAt(side, t) {
  if (!side) return null;
  const start = (side.start ?? 0) + (side.delay ?? 0);
  const dur = side.duration ?? 0;
  if (t <= start) return 0;
  if (dur <= 0 || t >= start + dur) return 1;
  return sampleAt(side.easing.samples, (t - start) / dur);
}
export function pathFrom(points) {
  return points.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(2)},${y.toFixed(2)}`).join("");
}
/** Calls fn(visible) when el enters/leaves the viewport; returns a disconnect function. */
export function watchVisibility(el, fn, rootMargin = "120px") {
  if (typeof IntersectionObserver === "undefined") {
    fn(true);
    return () => {};
  }
  const io = new IntersectionObserver((entries) => fn(entries[0].isIntersecting), { rootMargin });
  io.observe(el);
  return () => io.disconnect();
}

/**
 * Marks which edges of a sideways-scrolling element have more content past them (`fade-start`,
 * `fade-end`), so the stylesheet fades only those: an edge that ends the content stays sharp.
 * Returns a function that stops watching.
 */
export function edgeFades(el) {
  const update = () => {
    const max = el.scrollWidth - el.clientWidth;
    el.classList.toggle("fade-start", el.scrollLeft > 2);
    el.classList.toggle("fade-end", max > 2 && el.scrollLeft < max - 2);
  };
  el.addEventListener("scroll", update, { passive: true });
  const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
  ro?.observe(el);
  update();
  return () => {
    el.removeEventListener("scroll", update);
    ro?.disconnect();
  };
}
