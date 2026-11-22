import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";

/**
 * The website (apps/docs), tested as a product: the production build served under /motionpr/
 * exactly like GitHub Pages serves it, in a real browser.
 */
const DIST = resolve("apps/docs/dist");
const PORT = 4399;
const BASE = `http://localhost:${PORT}/motionpr/`;
let server: ChildProcess;

test.describe.configure({ mode: "serial" });
test.beforeAll(async () => {
  // Builds the site (production mode), then serves dist with GitHub Pages' 404 behaviour.
  server = spawn(process.execPath, ["apps/docs/build.mjs", "--serve"], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ["ignore", "pipe", "inherit"],
  });
  await new Promise<void>((ok, fail) => {
    const timer = setTimeout(() => fail(new Error("docs server did not start")), 90_000);
    server.stdout!.on("data", (d: Buffer) => {
      if (d.toString().includes("serving")) {
        clearTimeout(timer);
        ok();
      }
    });
    server.on("exit", (code) => fail(new Error(`docs server exited ${code}`)));
  });
});
test.afterAll(() => {
  server?.kill();
});

function htmlFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return name === "report" || name === "app" ? [] : htmlFiles(p);
    return p.endsWith(".html") ? [p] : [];
  });
}
const docPages = () =>
  htmlFiles(join(DIST, "docs"))
    .map((f) => f.slice(DIST.length + 1).replace(/index\.html$/, ""))
    .sort();

/** Collects console errors, page errors and failed requests for one page. */
function watch(page: Page) {
  const problems: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") problems.push(`console: ${m.text()}`);
  });
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  page.on("response", (r) => {
    if (r.status() >= 400 && !r.url().endsWith("/does-not-exist/"))
      problems.push(`HTTP ${r.status()} ${r.url()}`);
  });
  return problems;
}
/**
 * Text cut off at the side of the screen. `scrollWidth` alone misses it, because the page clips
 * horizontal overflow: an element can be wider than its column and simply not show. Reports any
 * readable element that extends past the viewport or a clipping ancestor, unless it sits in a
 * scroll container (code blocks, tables), where the reader can reach it.
 */
const clippedText = (page: Page) =>
  page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const out: string[] = [];
    const selector = ["h1", "h2", "h3", "p", "li", "td", "a", "button", "code", "label", "dd"]
      .map((t) => `main ${t}`)
      .join(", ");
    for (const el of document.querySelectorAll<HTMLElement>(selector)) {
      if (el.closest("[aria-hidden='true'], [hidden], svg")) continue;
      const style = getComputedStyle(el);
      if (style.visibility === "hidden" || style.display === "none") continue;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      let left = 0;
      let right = vw;
      let reachable = false;
      for (let p = el.parentElement; p && p !== document.documentElement; p = p.parentElement) {
        const ox = getComputedStyle(p).overflowX;
        if (ox === "auto" || ox === "scroll") {
          reachable = true;
          break;
        }
        if (ox === "hidden" || ox === "clip") {
          const pr = p.getBoundingClientRect();
          left = Math.max(left, pr.left);
          right = Math.min(right, pr.right);
        }
      }
      if (!reachable && (r.right > right + 1.5 || r.left < left - 1.5))
        out.push(`${el.tagName.toLowerCase()} "${(el.textContent ?? "").trim().slice(0, 40)}"`);
    }
    return out;
  });

const stats = (page: Page) =>
  page.evaluate(() =>
    (
      window as unknown as { __motionprSite: { stats(): Record<string, number | boolean> } }
    ).__motionprSite.stats(),
  );

test("every internal link, anchor and asset in the build resolves", () => {
  const broken: string[] = [];
  const files = htmlFiles(DIST);
  expect(files.length).toBeGreaterThan(60);
  const ids = new Map<string, Set<string>>();
  const idsOf = (file: string) => {
    if (!ids.has(file))
      ids.set(
        file,
        new Set([...readFileSync(file, "utf8").matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]!)),
      );
    return ids.get(file)!;
  };
  for (const file of files) {
    const html = readFileSync(file, "utf8");
    const base = file.endsWith("404.html") ? DIST : dirname(file);
    for (const m of html.matchAll(
      /(?:href|src)="(?!https?:|mailto:|data:)([^"?#]*)(?:\?[^"#]*)?(#[^"]*)?"/g,
    )) {
      const [, path = "", hash] = m;
      if (!path && !hash) continue;
      // The site is served under /motionpr/ (404.html uses that absolute base).
      let target = path.startsWith("/motionpr/")
        ? join(DIST, path.slice("/motionpr/".length))
        : path
          ? resolve(base, path)
          : file;
      if (path.endsWith("/") || (existsSync(target) && statSync(target).isDirectory()))
        target = join(target, "index.html");
      if (!existsSync(target)) {
        broken.push(`${file.slice(DIST.length)} → ${path}`);
        continue;
      }
      if (
        hash &&
        hash.length > 1 &&
        target.endsWith(".html") &&
        !idsOf(target).has(decodeURIComponent(hash.slice(1)))
      )
        broken.push(`${file.slice(DIST.length)} → ${path}${hash} (no such anchor)`);
    }
  }
  expect(broken).toEqual([]);
});

test("search index and sitemap cover every documentation page", () => {
  const index = JSON.parse(readFileSync(join(DIST, "assets/search-index.json"), "utf8")) as {
    u: string;
  }[];
  const sitemap = readFileSync(join(DIST, "sitemap.xml"), "utf8");
  for (const page of docPages()) {
    if (page === "docs/") continue;
    expect(
      index.some((e) => e.u === page),
      page,
    ).toBe(true);
    expect(sitemap, page).toContain(`https://erenthedeveloper0.github.io/motionpr/${page}`);
  }
});

test("every route loads directly without errors or horizontal overflow", async ({ page }) => {
  test.setTimeout(240_000);
  const problems = watch(page);
  const routes = ["", "docs/", "demo/", "playground/", ...docPages().filter((p) => p !== "docs/")];
  for (const route of routes) {
    await page.goto(BASE + route);
    await expect(page.locator("h1").first(), route).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    expect(overflow, `${route} overflows`).toBeLessThanOrEqual(0);
  }
  expect(problems).toEqual([]);
});

test("pages stay within the viewport on a phone", async ({ browser }) => {
  test.setTimeout(120_000);
  const page = await browser.newPage({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  // Layout is measured with reduced motion: entrance animations offset elements (rows slide in
  // from the side) until they are revealed, which is a moment, not the layout.
  const still = await browser.newPage({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    reducedMotion: "reduce",
  });
  const problems = watch(page);
  const stillProblems = watch(still);
  const routes = [
    "",
    "docs/",
    "docs/configuration/comparison/",
    "docs/features/easing-analysis/",
    "docs/browsers/support/",
    "docs/browsers/cross-browser-testing/",
    "demo/",
    "playground/",
  ];
  for (const route of routes) {
    await page.goto(BASE + route);
    await page.waitForTimeout(400);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    expect(overflow, `${route} overflows on a phone`).toBeLessThanOrEqual(0);

    // Mount every lazy component, then look for text cut off at the edge.
    await still.goto(BASE + route);
    await still.evaluate(async () => {
      for (let y = 0; y < document.documentElement.scrollHeight; y += 400) {
        scrollTo(0, y);
        await new Promise((r) => setTimeout(r, 120));
      }
      scrollTo(0, 0);
    });
    await still.waitForTimeout(300);
    expect(await clippedText(still), `${route}: text cut off on a phone`).toEqual([]);
  }
  expect([...problems, ...stillProblems]).toEqual([]);
  await page.close();
  await still.close();
});

test("soft navigation: transitions, history, scroll restoration and cleanup", async ({ page }) => {
  const problems = watch(page);
  await page.goto(BASE);
  await expect(page.locator("#hero-title")).toBeVisible();
  await expect.poll(() => stats(page).then((s) => s.lenis)).toBe(true);
  await page.locator(".primary-nav").getByRole("link", { name: "Docs" }).click();
  await expect(page).toHaveURL(`${BASE}docs/`);
  await expect(page.getByRole("heading", { level: 1, name: "Documentation" })).toBeVisible();
  // The landing page's Lenis, ScrollTriggers, components and frame loops are gone.
  await expect
    .poll(() => stats(page))
    .toMatchObject({ lenis: false, scrollTriggers: 0, frameLoops: 0 });
  await page.locator(".docs-index").getByRole("link", { name: "Lenis", exact: true }).click();
  await expect(page).toHaveURL(`${BASE}docs/integrations/lenis/`);
  await expect(page.getByRole("heading", { level: 1, name: "Lenis integration" })).toBeVisible();
  await expect(page).toHaveTitle(/Lenis integration · MotionPR docs/);
  await expect(page.locator('.sidebar a[aria-current="page"]')).toHaveText("Lenis");
  // Scroll, go to another page, come back: the position is restored.
  await page.evaluate(() => window.scrollTo(0, 1400));
  await page.waitForTimeout(250);
  await page.locator(".pager .next").click();
  await expect(page.getByRole("heading", { level: 1, name: "Combining adapters" })).toBeVisible();
  expect(await page.evaluate(() => scrollY)).toBeLessThan(5);
  await page.goBack();
  await expect(page.getByRole("heading", { level: 1, name: "Lenis integration" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => Math.round(scrollY))).toBeGreaterThan(1300);
  await page.goForward();
  await expect(page.getByRole("heading", { level: 1, name: "Combining adapters" })).toBeVisible();
  await page.goBack();
  await page.goBack();
  await expect(page).toHaveURL(`${BASE}docs/`);
  // Refresh keeps the page; focus and announcements happened on the way.
  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: "Documentation" })).toBeVisible();
  expect(problems).toEqual([]);
});

test("between documentation pages the sidebar stays still and keeps its scroll position", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 700 });
  await page.goto(`${BASE}docs/cli/overview/`);
  const sidebar = page.locator(".sidebar");
  const target = sidebar.getByRole("link", { name: "doctor", exact: true });
  // Scroll the sidebar (not the page) down to the link, as a reader would.
  await target.evaluate((el) => el.scrollIntoView({ block: "center" }));
  const before = await sidebar.evaluate((el) => el.scrollTop);
  expect(before).toBeGreaterThan(300);
  // Sample the sidebar's opacity on every frame while the next page loads and enters.
  await page.evaluate(() => {
    const w = window as unknown as { __sidebarMin: number };
    w.__sidebarMin = 1;
    const t0 = performance.now();
    const tick = () => {
      // Effective opacity: the sidebar's own, times every ancestor's.
      let o = 1;
      for (let el = document.querySelector(".sidebar"); el; el = el.parentElement)
        o *= Number(getComputedStyle(el).opacity);
      w.__sidebarMin = Math.min(w.__sidebarMin, o);
      if (performance.now() - t0 < 1500) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await target.click();
  await expect(page.getByRole("heading", { level: 1, name: /doctor/ })).toBeVisible();
  await page.waitForTimeout(1600);
  expect(
    await page.evaluate(() => (window as unknown as { __sidebarMin: number }).__sidebarMin),
  ).toBe(1);
  const after = await page.locator(".sidebar").evaluate((el) => el.scrollTop);
  expect(Math.abs(after - before)).toBeLessThan(40);
});

test("unmounting a page leaves no animation running", async ({ page }) => {
  await page.goto(`${BASE}playground/`);
  await expect(page.locator(".playground .pg__report")).toContainText("exit");
  await page.locator(".lab").scrollIntoViewIfNeeded();
  await expect.poll(() => stats(page).then((s) => s.mounted as number)).toBeGreaterThan(1);
  await page.locator(".primary-nav").getByRole("link", { name: "Docs" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Documentation" })).toBeVisible();
  await expect
    .poll(() => stats(page))
    .toMatchObject({ scrollTriggers: 0, frameLoops: 0, frameLoopRunning: false, lenis: false });
  const s = await stats(page);
  expect(s.mounted).toBeLessThanOrEqual(1);
});

test("search finds a section and opens it", async ({ page }) => {
  await page.goto(`${BASE}docs/`);
  await page.keyboard.press("ControlOrMeta+k");
  // By name: the page it opens has other comboboxes (a timeline's playback speed).
  const input = page.getByRole("combobox", { name: "Search" });
  await expect(input).toBeFocused();
  await input.fill("waitForScrollSettled");
  const first = page.locator(".search-results a").first();
  await expect(first).toBeVisible();
  await expect(first).toContainText(/waitForScrollSettled|Scroll motion|Scenarios/);
  await page.keyboard.press("Enter");
  await expect(page.locator(".search-dialog")).toBeHidden();
  await expect(page).toHaveURL(
    /docs\/(configuration\/scenarios|features\/interaction-scenarios|integrations\/lenis)\//,
  );
  // Escape closes and returns focus.
  await page.getByRole("button", { name: "Search the documentation" }).click();
  await expect(input).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.locator(".search-dialog")).toBeHidden();
});

test("code blocks copy their text; command tabs switch", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto(`${BASE}docs/getting-started/installation/`);
  const tabs = page.locator(".code-tabs").first();
  await tabs.getByRole("tab", { name: "pnpm" }).click();
  await expect(tabs.getByRole("tab", { name: "pnpm" })).toHaveAttribute("aria-selected", "true");
  await expect(tabs.locator('[role="tabpanel"]:not([hidden])')).toContainText(
    "pnpm add -D @erenthedeveloper0/motionpr@alpha",
  );
  await tabs.getByRole("tab", { name: "pnpm" }).press("ArrowRight");
  await expect(tabs.getByRole("tab", { name: "yarn" })).toBeFocused();
  await tabs.locator(".code-tabs__copy").click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    "yarn add -D @erenthedeveloper0/motionpr@alpha",
  );
  const block = page.locator("figure.code").filter({ hasText: "npx motionpr --version" }).first();
  await block.getByRole("button", { name: /Copy code/ }).click();
  await expect(block.locator(".copy")).toHaveText("Copied");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("npx motionpr --version");
});

test("mobile: menu and documentation drawer work with keyboard and touch", async ({ browser }) => {
  const page = await browser.newPage({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  await page.goto(`${BASE}docs/cli/run/`);
  const menu = page.getByRole("button", { name: "Open menu" });
  await menu.tap();
  await expect(page.locator("#mobile-nav")).toBeVisible();
  await expect(page.locator("#mobile-nav").getByRole("link", { name: "Playground" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("#mobile-nav")).toBeHidden();
  await page.locator("[data-sidebar-toggle]").tap();
  await expect(page.locator(".sidebar")).toHaveClass(/is-open/);
  await page.locator(".sidebar").getByRole("link", { name: "doctor" }).tap();
  await expect(page.getByRole("heading", { level: 1, name: "motionpr doctor" })).toBeVisible();
  await expect(page.locator(".sidebar")).not.toHaveClass(/is-open/);
  await page.close();
});

test("reduced motion: no smooth scrolling, no autoplay, content fully visible", async ({
  browser,
}) => {
  const page = await browser.newPage({ reducedMotion: "reduce" });
  const problems = watch(page);
  await page.goto(BASE);
  await expect(page.locator("#hero-title")).toBeVisible();
  const transform = await page
    .locator('[data-hero="line"]')
    .first()
    .evaluate((el) => getComputedStyle(el).transform);
  expect(transform === "none" || transform === "matrix(1, 0, 0, 1, 0, 0)").toBe(true);
  // The horizon is a still frame: both versions arrived, nothing playing until asked.
  await expect(page.locator(".horizon__readout")).toContainText("baseline 100%");
  await expect(page.getByRole("button", { name: "Play the horizon" })).toBeVisible();
  await page.waitForTimeout(800);
  expect(await stats(page)).toMatchObject({ lenis: false, frameLoops: 0, reducedMotion: true });
  await page.locator(".primary-nav").getByRole("link", { name: "Playground" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Change the motion");
  expect(problems).toEqual([]);
  await page.close();
});

test("keyboard: skip link, focus after navigation, visible focus", async ({ page }) => {
  await page.goto(`${BASE}docs/overview/introduction/`);
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Skip to content" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/#main$/);
  await page.locator(".pager .next").focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { level: 1, name: "Why MotionPR" })).toBeFocused();
  await expect(page.locator("[data-route-announcer]")).toHaveText(/Navigated to Why MotionPR/);
});

test("the 404 page is styled and links home at any depth", async ({ page }) => {
  const res = await page.goto(`${BASE}docs/does-not-exist/`);
  expect(res?.status()).toBe(404);
  await expect(
    page.getByRole("heading", { level: 1, name: "This page does not exist." }),
  ).toBeVisible();
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(bg).toBe("rgb(7, 7, 9)");
  await page.getByRole("link", { name: "documentation" }).click();
  await expect(page).toHaveURL(`${BASE}docs/`);
});

test("header and mobile menu links work after moving to a page at another depth", async ({
  page,
  browser,
}) => {
  // The header stays on screen across soft navigations while its links are relative to the page
  // it was rendered for; each move must hand it the new page's links.
  const problems = watch(page);
  const failed: string[] = [];
  page.on("console", (m) => {
    if (m.text().includes("soft navigation failed")) failed.push(m.text());
  });
  const nav = (name: string) =>
    page.locator(".primary-nav").getByRole("link", { name, exact: true });
  const logo = page.locator(".site-header .brand-link");
  await page.goto(BASE);
  await page.getByRole("link", { name: "Get started" }).first().click();
  await expect(page).toHaveURL(`${BASE}docs/getting-started/installation/`);
  await logo.click();
  await expect(page).toHaveURL(BASE);
  await expect(page.locator("#hero-title")).toBeVisible();
  await page.getByRole("link", { name: "Get started" }).first().click();
  await expect(page).toHaveURL(`${BASE}docs/getting-started/installation/`);
  await nav("Playground").click();
  await expect(page).toHaveURL(`${BASE}playground/`);
  await nav("Docs").click();
  await expect(page).toHaveURL(`${BASE}docs/`);
  await page.locator(".docs-index").getByRole("link", { name: "GSAP", exact: true }).click();
  await expect(page).toHaveURL(`${BASE}docs/integrations/gsap/`);
  await nav("Demo").click();
  await expect(page).toHaveURL(`${BASE}demo/`);
  await expect(page.getByRole("heading", { level: 1, name: /demo app/ })).toBeVisible();
  await logo.click();
  await expect(page).toHaveURL(BASE);
  expect(await page.locator("h1").first().textContent()).not.toContain("does not exist");
  expect([...problems, ...failed]).toEqual([]);

  const phone = await browser.newPage({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  await phone.goto(`${BASE}docs/configuration/comparison/`);
  const menu = async (name: string) => {
    await phone.locator("[data-menu-toggle]").click();
    await phone.locator("#mobile-nav").getByRole("link", { name, exact: true }).click();
  };
  await menu("Home");
  await expect(phone).toHaveURL(BASE);
  await menu("Playground");
  await expect(phone).toHaveURL(`${BASE}playground/`);
  await menu("Docs");
  await expect(phone).toHaveURL(`${BASE}docs/`);
  await expect(phone.getByRole("heading", { level: 1, name: "Documentation" })).toBeVisible();
  await phone.close();
});

test("back to a scrolled landing page returns to the same place, without a reload", async ({
  page,
}) => {
  const failed: string[] = [];
  page.on("console", (m) => {
    if (m.text().includes("soft navigation failed")) failed.push(m.text());
  });
  await page.goto(BASE);
  await expect.poll(() => stats(page).then((s) => s.lenis)).toBe(true);
  // Scroll the way a reader does, so the sections on the way mount and grow.
  for (let i = 0; i < 12; i++) {
    await page.mouse.wheel(0, 700);
    await page.waitForTimeout(120);
  }
  await page.waitForTimeout(1500);
  const place = () =>
    page.evaluate(() => {
      const heads = [...document.querySelectorAll("main .section__title")];
      const h = heads.filter((el) => el.getBoundingClientRect().top < innerHeight).at(-1);
      return {
        y: Math.round(scrollY),
        title: h?.textContent?.trim(),
        top: h?.getBoundingClientRect().top,
      };
    });
  const before = await place();
  expect(before.y).toBeGreaterThan(5000);
  const marker = await page.evaluate(() => ((window as unknown as { __mark: number }).__mark = 1));
  for (let round = 0; round < 2; round++) {
    await page.locator(".primary-nav").getByRole("link", { name: "Docs", exact: true }).click();
    await expect(page).toHaveURL(`${BASE}docs/`);
    await page.goBack();
    await expect(page.locator("#hero-title")).toBeAttached();
    await expect.poll(place).toMatchObject({ y: before.y, title: before.title });
    // Same document: the page was swapped, not reloaded.
    expect(await page.evaluate(() => (window as unknown as { __mark?: number }).__mark)).toBe(
      marker,
    );
  }
  expect(failed).toEqual([]);
});

test("a missing page loads as the real 404 page, whose links work", async ({ page }) => {
  await page.goto(`${BASE}docs/`);
  await page.evaluate(() => {
    const a = document.createElement("a");
    a.href = "getting-started/no-such-page/";
    a.textContent = "broken";
    a.id = "broken-link";
    document.querySelector("main")!.append(a);
  });
  await page.locator("#broken-link").click();
  await expect(page).toHaveURL(`${BASE}docs/getting-started/no-such-page/`);
  await expect(
    page.getByRole("heading", { level: 1, name: "This page does not exist." }),
  ).toBeVisible();
  await page.locator(".primary-nav").getByRole("link", { name: "Playground", exact: true }).click();
  await expect(page).toHaveURL(`${BASE}playground/`);
  await page.locator(".primary-nav").getByRole("link", { name: "Docs", exact: true }).click();
  await expect(page).toHaveURL(`${BASE}docs/`);
});

test("hero horizon plays the real timing, pauses, and its index reaches every section", async ({
  page,
}) => {
  const problems = watch(page);
  await page.goto(BASE);
  const horizon = page.locator(".horizon");
  await expect(horizon.locator(".horizon__legend")).toContainText("Baseline 320 ms");
  await expect(horizon.locator(".horizon__legend")).toContainText("Candidate 560 ms");
  // It plays on its own: the readout moves through the run.
  const readout = horizon.locator(".horizon__readout");
  await expect(readout).toContainText(/t \d+ ms/);
  const t1 = await readout.textContent();
  await expect.poll(() => readout.textContent()).not.toBe(t1);
  await horizon.getByRole("button", { name: "Pause the horizon" }).click();
  await expect(horizon.getByRole("button", { name: "Play the horizon" })).toBeVisible();
  const frozen = await readout.textContent();
  await page.waitForTimeout(500);
  expect(await readout.textContent()).toBe(frozen);
  // Each entry of the index lands its section just below the header, with focus moved there.
  const header = await page.locator(".site-header").evaluate((el) => el.offsetHeight);
  for (const [id, label] of [
    ["engines", "Engines"],
    ["ci", "Continuous integration"],
    ["change", "The change review cannot see"],
  ]) {
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.locator(".hero__index a", { hasText: label }).click();
    await expect(page).toHaveURL(`${BASE}#${id}`);
    await expect
      .poll(() =>
        page.evaluate(
          (i) => Math.round(document.getElementById(i)!.getBoundingClientRect().top),
          id,
        ),
      )
      .toBeGreaterThanOrEqual(header);
    await expect
      .poll(() =>
        page.evaluate(
          (i) => Math.round(document.getElementById(i)!.getBoundingClientRect().top),
          id,
        ),
      )
      .toBeLessThanOrEqual(header + 12);
    expect(await page.evaluate(() => document.activeElement?.id)).toBe(id);
  }
  expect(problems).toEqual([]);
});

test("the instrument in section 01 plays, pauses and scrubs real data", async ({ page }) => {
  await page.goto(BASE);
  await page.locator("#change .statement__stage").scrollIntoViewIfNeeded();
  const hero = page.locator(".instrument");
  await expect(hero.locator(".instrument__findings")).toContainText(
    "Duration 320ms → 560ms (+240ms, +75%)",
  );
  const scrub = hero.getByRole("slider", { name: "Time in milliseconds" });
  await scrub.fill("200");
  await expect(hero.locator(".instrument__readout")).toContainText("200 ms");
  await expect(hero.locator(".instrument__readout")).toContainText("Δ progress");
  await expect(hero.getByRole("button", { name: "Play" })).toBeVisible();
  await hero.getByRole("button", { name: "Play" }).click();
  await expect(hero.getByRole("button", { name: "Pause" })).toBeVisible();
});

test("easing lab: equivalent spellings match, a real change is graded, invalid input is flagged", async ({
  page,
}) => {
  await page.goto(`${BASE}docs/features/easing-analysis/`);
  const lab = page.locator(".lab").first();
  await expect(lab.locator(".lab__verdict")).toContainText(
    "Easing cubic-bezier(0.16, 1, 0.3, 1) → ease-in-out (max deviation 70% of progress at 27% time)",
  );
  await lab.getByRole("textbox", { name: "baseline easing" }).fill("ease");
  await lab
    .getByRole("textbox", { name: "candidate easing" })
    .fill("cubic-bezier(0.25, 0.1, 0.25, 1)");
  await expect(lab.locator(".lab__verdict")).toContainText("The curves are equivalent.");
  await lab.getByRole("textbox", { name: "candidate easing" }).fill("bounce");
  await expect(lab.getByRole("textbox", { name: "candidate easing" })).toHaveAttribute(
    "aria-invalid",
    "true",
  );
});

test("playground grades changes with MotionPR's comparison engine", async ({ page }) => {
  await page.goto(`${BASE}playground/`);
  const pg = page.locator(".playground");
  await pg.getByRole("slider", { name: "Candidate Duration" }).fill("640");
  await pg
    .getByRole("combobox", { name: "Candidate easing preset" })
    .selectOption("cubic-bezier(0.16, 1, 0.3, 1)");
  await pg.getByRole("slider", { name: "Candidate Stagger" }).fill("60");
  const report = pg.locator(".pg__report");
  await expect(report).toContainText("Duration 320ms → 640ms (+320ms, +100%)");
  await expect(report.locator(".pg__exit")).toHaveText("exit 1");
  await pg.getByRole("combobox", { name: "Fail on" }).selectOption("never");
  await expect(report.locator(".pg__exit")).toHaveText("exit 0");
  await pg.getByRole("slider", { name: "Candidate Duration" }).fill("320");
  await expect(report).toContainText("No differences.");
});

test("differences explorer filters the real comparison", async ({ page }) => {
  await page.goto(BASE);
  // Components mount when they near the viewport: bring the placeholder there first.
  await page.locator('[data-component="diff-viewer"]').scrollIntoViewIfNeeded();
  const viewer = page.locator(".diffs");
  await expect(viewer.locator(".diffs__status")).toHaveText("55 of 55 differences");
  await viewer.locator('[data-sev="warning"]').click();
  await expect(viewer.locator(".diffs__status")).toHaveText("20 of 55 differences");
  await viewer.getByRole("combobox", { name: "Engine" }).selectOption("Lenis");
  await expect(viewer.locator(".diffs__status")).toHaveText("2 of 55 differences");
});

test("interactive demo drives both variants of the real demo app", async ({ page }) => {
  test.setTimeout(90_000);
  const problems = watch(page);
  await page.goto(`${BASE}demo/`);
  await page.getByRole("option", { name: /Navigation menu opens and closes/ }).click();
  await expect(page.locator(".demo__diffs")).toContainText("Duration 320ms → 560ms");
  await page.getByRole("button", { name: "Play scenario" }).click();
  await expect(page.locator(".demo__step")).toHaveText(/Done/, { timeout: 45_000 });
  const frame = page.frameLocator(".demo__frame--candidate iframe");
  await expect(frame.locator("[data-testid=menu-toggle]")).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  expect(problems).toEqual([]);
});

test("after a new deploy, soft navigation loads the new build instead of mixing builds", async ({
  page,
}) => {
  await page.goto(BASE);
  const app = await page.evaluate(
    () => document.querySelector<HTMLScriptElement>('script[type="module"][src]')!.src,
  );
  expect(app).toMatch(/\/assets\/app-[A-Z0-9]+\.js$/);
  // The next page comes from a "newer deploy": its script has another name.
  await page.route(`${BASE}docs/`, async (route) => {
    const res = await route.fetch();
    const body = (await res.text()).replace(/assets\/app-[A-Z0-9]+\.js/, "assets/app-NEWDEPLOY.js");
    await route.fulfill({ response: res, body });
  });
  await page.evaluate(() => ((window as unknown as { __mark: number }).__mark = 1));
  await page.locator(".primary-nav").getByRole("link", { name: "Docs", exact: true }).click();
  await expect(page).toHaveURL(`${BASE}docs/`);
  await expect(page.getByRole("heading", { level: 1, name: "Documentation" })).toBeVisible();
  // A real page load, not a swap: the old document (and its marker) is gone.
  expect(
    await page.evaluate(() => (window as unknown as { __mark?: number }).__mark),
  ).toBeUndefined();
});

test("a component whose chunk is gone (a tab older than the deploy) reloads the page once", async ({
  page,
}) => {
  let failures = 0;
  await page.route(/\/assets\/chunks\/easing-lab-[A-Z0-9]+\.js$/, async (route) => {
    if (failures++ === 0) return route.fulfill({ status: 404, body: "gone" });
    return route.continue();
  });
  await page.goto(`${BASE}docs/features/easing-analysis/`);
  // The first load fails to import the lab, reloads, and the second load mounts it.
  await expect(page.locator(".lab").first()).toBeVisible({ timeout: 15_000 });
  expect(failures).toBe(2);
  await expect(page.locator(".mp-component.is-failed")).toHaveCount(0);
});
