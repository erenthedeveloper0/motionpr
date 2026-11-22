// Builds the MotionPR website (landing page, documentation, interactive demo, playground) into
// apps/docs/dist as static files.
//
//   node build.mjs            build
//   node build.mjs --serve    build, then serve dist at http://localhost:4321/motionpr/
//
// Inputs: /docs/**/*.md (the documentation, also readable on GitHub), site/nav.mjs (order),
// data/site-data.json (real demo captures, see scripts/extract-site-data.ts), src/ (JS + CSS),
// /brand (logos, icons, social images), the built demo app (fixtures/demo-app/dist) and, when one
// was generated, a real report of the demo app (apps/docs/public/report or .tmp/demo-report).
import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { dirname, extname, join, posix, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build as esbuild } from "esbuild";
import { NAV, PAGES } from "./site/nav.mjs";
import { frontmatter, plainText, renderMarkdown, slugify } from "./site/markdown.mjs";
import { ASSETS, SITE, document, head } from "./site/layout.mjs";
import {
  demoBody,
  docsIndexBody,
  docsPageBody,
  landingBody,
  notFoundBody,
  playgroundBody,
  sidebarHtml,
} from "./site/pages.mjs";

const require = createRequire(import.meta.url);
const here = fileURLToPath(new URL(".", import.meta.url));
const root = resolve(here, "../..");
const dist = join(here, "dist");
const docsDir = join(root, "docs");
const VERSION = JSON.parse(readFileSync(join(root, "packages/cli/package.json"), "utf8")).version;
const BASE_PATH = "/motionpr/";
const PRODUCTION = !process.argv.includes("--dev");

const docUrl = (slug) => `docs/${slug}/`; // site-relative
const relUrl = (fromDir, to) => {
  // fromDir and `to` are site-relative directory URLs ("" for the root)
  const r = posix.relative(fromDir || ".", to || ".");
  return r ? `${r.replace(/\/?$/, "/")}` : "./";
};

function pngSize(file) {
  const b = readFileSync(file);
  return b.toString("ascii", 1, 4) === "PNG"
    ? { width: b.readUInt32BE(16), height: b.readUInt32BE(20) }
    : {};
}

async function buildDocs() {
  const descriptions = {};
  const search = [];
  const pages = [];
  for (const page of PAGES) {
    const file = join(docsDir, page.file);
    if (!existsSync(file)) throw new Error(`nav lists ${page.file}, which does not exist`);
    const { meta, body } = frontmatter(await readFile(file, "utf8"));
    descriptions[page.slug] = meta.description ?? "";
    pages.push({ ...page, meta, body });
  }
  const bySlug = new Map(pages.map((p) => [p.slug, p]));
  const imagesUsed = new Set();
  const broken = [];

  for (const [i, page] of pages.entries()) {
    const here = docUrl(page.slug);
    const up = "../".repeat(here.split("/").filter(Boolean).length);
    const urlFor = (slug) => relUrl(here, docUrl(slug));
    const resolveLink = (href) => {
      if (href.startsWith(SITE.url)) {
        const rest = href.slice(SITE.url.length);
        return (
          relUrl(here, rest.split("#")[0]) + (href.includes("#") ? `#${href.split("#")[1]}` : "")
        );
      }
      if (/^(https?:|mailto:|#)/.test(href)) return null;
      const [path, hash = ""] = href.split("#");
      const target = posix.normalize(posix.join(posix.dirname(page.file), path));
      if (target.startsWith("..")) {
        // Outside /docs: the repository file on GitHub.
        return `${SITE.repo}/blob/main/${target.replace(/^(\.\.\/)+/, "")}${hash ? `#${hash}` : ""}`;
      }
      const slug = target.replace(/\.md$/, "");
      if (!bySlug.has(slug)) {
        broken.push(`${page.file} → ${href}`);
        return href;
      }
      return urlFor(slug) + (hash ? `#${hash}` : "");
    };
    const resolveImage = (src) => {
      const target = posix.normalize(posix.join(posix.dirname(page.file), src));
      const abs = join(docsDir, target);
      if (!existsSync(abs)) {
        broken.push(`${page.file} → image ${src}`);
        return { src };
      }
      imagesUsed.add(target);
      return { src: `${up}assets/docs/${target}`, ...pngSize(abs) };
    };
    const { html, toc } = await renderMarkdown(page.body, { resolveLink, resolveImage });
    const title = page.meta.title ?? page.label;
    const prev = pages[i - 1] ?? null;
    const next = pages[i + 1] ?? null;
    const sidebar = sidebarHtml({ nav: NAV, currentSlug: page.slug, urlFor });
    const body = docsPageBody({
      up,
      page,
      html,
      toc,
      prev,
      next,
      sidebar,
      description: page.meta.description,
      version: VERSION,
      editUrl: `${SITE.repo}/edit/main/docs/${page.file}`,
      urlFor,
    });
    const jsonLd = [
      {
        "@context": "https://schema.org",
        "@type": "TechArticle",
        headline: title,
        description: page.meta.description,
        url: SITE.url + here,
        isPartOf: { "@type": "WebSite", name: "MotionPR", url: SITE.url },
        about: { "@type": "SoftwareApplication", name: "MotionPR" },
      },
      {
        "@context": "https://schema.org",
        "@type": "BreadcrumbList",
        itemListElement: [
          { "@type": "ListItem", position: 1, name: "Docs", item: `${SITE.url}docs/` },
          { "@type": "ListItem", position: 2, name: page.section },
          { "@type": "ListItem", position: 3, name: title, item: SITE.url + here },
        ],
      },
    ];
    const out = join(dist, here, "index.html");
    await mkdir(dirname(out), { recursive: true });
    await writeFile(
      out,
      document({
        headHtml: head({
          title: `${title} · MotionPR docs`,
          description: page.meta.description ?? SITE.tagline,
          path: here,
          up,
          type: "article",
          jsonLd,
          version: VERSION,
        }),
        body,
        layout: "docs",
        page: page.slug,
        up,
        version: VERSION,
        active: "docs",
      }),
    );

    // Search: one entry per page and per h2/h3 section, with a plain-text excerpt.
    const sections = page.body.split(/^(?=#{2,3} )/m);
    search.push({
      u: here,
      t: title,
      s: page.section,
      h: "",
      x: plainText(sections[0].replace(/^# .*$/m, "")).slice(0, 220),
      d: page.meta.description ?? "",
    });
    for (const sec of sections.slice(1)) {
      const heading = /^#{2,3} (.+)$/m.exec(sec)?.[1] ?? "";
      const id = slugify(heading.replace(/`/g, ""));
      search.push({
        u: `${here}#${id}`,
        t: title,
        s: page.section,
        h: heading.replace(/`/g, ""),
        x: plainText(sec.replace(/^#{2,3} .*$/m, "")).slice(0, 220),
      });
    }
  }
  if (broken.length) throw new Error(`Broken documentation links:\n  ${broken.join("\n  ")}`);

  // /docs/ hub
  {
    const here = "docs/";
    const up = "../";
    const urlFor = (slug) => relUrl(here, docUrl(slug));
    await writeFile(
      join(dist, "docs/index.html"),
      document({
        headHtml: head({
          title: "Documentation · MotionPR",
          description:
            "MotionPR documentation: installation, scenarios, animation capture, motion comparison, easing analysis, CLI, configuration, CI/CD and adapters.",
          path: here,
          up,
          version: VERSION,
        }),
        body: docsIndexBody({
          up,
          nav: NAV,
          urlFor,
          descriptions,
          version: VERSION,
          sidebar: sidebarHtml({ nav: NAV, currentSlug: null, urlFor }),
        }),
        layout: "docs",
        page: "docs",
        up,
        version: VERSION,
        active: "docs",
      }),
    );
  }

  for (const img of imagesUsed) {
    await mkdir(dirname(join(dist, "assets/docs", img)), { recursive: true });
    await cp(join(docsDir, img), join(dist, "assets/docs", img));
  }
  await writeFile(join(dist, "assets/search-index.json"), JSON.stringify(search));
  return { count: pages.length, search: search.length };
}

const ENGINES = [
  {
    id: "css",
    label: "Native CSS",
    dataset: "navigation/open",
    status: "No setup · recorded automatically · verified in Chromium, Firefox and WebKit",
    docs: "docs/integrations/native-css/",
    code: '```css title="styles.css"\n.nav-panel {\n  transform: translateX(100%);\n  transition: transform 320ms cubic-bezier(0.16, 1, 0.3, 1);\n}\n.nav-open .nav-panel {\n  transform: translateX(0);\n}\n```',
  },
  {
    id: "waapi",
    label: "WAAPI",
    dataset: "work-grid/revealed",
    status: "No setup · element.animate() is recorded automatically",
    docs: "docs/integrations/web-animations/",
    code: '```js title="app.js"\ncards.forEach((card, i) =>\n  card.animate(\n    [{ opacity: 0, transform: "translateY(28px)" }, { opacity: 1, transform: "none" }],\n    { id: "work-reveal", duration: 520, delay: i * 70, fill: "both" },\n  ),\n);\n```',
  },
  {
    id: "gsap",
    label: "GSAP",
    dataset: "gsap-intro/played",
    status: "One line · verified with GSAP 3.15.1 (range >=3.12 <4)",
    docs: "docs/integrations/gsap/",
    code: '```ts title="main.ts" {2,4}\nimport gsap from "gsap";\nimport { motionprGsap } from "@erenthedeveloper0/motionpr/gsap";\n\nmotionprGsap.register(gsap); // a no-op unless MotionPR is capturing\n```',
  },
  {
    id: "animejs",
    label: "Anime.js",
    dataset: "anime-services/revealed",
    status: "Wrap at creation · verified with Anime.js 4.5.0 (v4)",
    docs: "docs/integrations/animejs/",
    code: '```ts title="motion.ts" {2,4,5}\nimport { animate, createTimeline, eases } from "animejs";\nimport { createAnimeInstrumentation } from "@erenthedeveloper0/motionpr/animejs";\n\nconst motion = createAnimeInstrumentation({ eases });\nexport const track = motion.wrapAnimate(animate);\nexport const timeline = motion.wrapTimeline(createTimeline);\n```',
  },
  {
    id: "lenis",
    label: "Lenis",
    dataset: "lenis-journal/scrolled",
    status: "One line · scroll motion, recorded live · verified with Lenis 1.3.27",
    docs: "docs/integrations/lenis/",
    code: '```ts title="main.ts" {2,5}\nimport Lenis from "lenis";\nimport { motionprLenis } from "@erenthedeveloper0/motionpr/lenis";\n\nconst lenis = new Lenis({ autoRaf: true });\nmotionprLenis.attach(lenis);\n```',
  },
];

async function engineData(siteData) {
  const out = [];
  for (const e of ENGINES) {
    const set = siteData.datasets[e.dataset];
    const { html } = await renderMarkdown(e.code, {
      resolveLink: () => null,
      resolveImage: (src) => ({ src }),
    });
    const findings = [
      ...set.stagger.map((sg) => ({
        severity: sg.severity,
        message: `Stagger interval ${sg.baselineInterval}ms → ${sg.candidateInterval}ms across ${sg.members} elements`,
      })),
      ...set.timelines.changes,
      ...set.scroll.comparisons.flatMap((c) => c.changes),
      ...set.tracks.flatMap((t) => t.changes),
    ];
    // Most severe first, at most three, without repeating a message.
    const rank = { critical: 0, warning: 1, uncertain: 2, info: 3 };
    const seen = new Set();
    const top = findings
      .sort((a, b) => rank[a.severity] - rank[b.severity])
      .filter((f) => (seen.has(f.message) ? false : seen.add(f.message)))
      .slice(0, 3);
    out.push({ ...e, code: html, findings: top });
  }
  return out;
}

async function buildPages(siteData) {
  const engines = await engineData(siteData);
  const pages = [
    {
      path: "",
      file: "index.html",
      layout: "landing",
      page: "home",
      active: null,
      title: "MotionPR · Animation regression testing for CSS, WAAPI, GSAP, Anime.js and Lenis",
      description:
        "Your code changed. See how your interface moves. MotionPR records CSS transitions, Web Animations, GSAP, Anime.js and Lenis scroll in Chromium, compares them with an approved baseline in CI, and opens a frame-by-frame report.",
      body: (up) => landingBody({ up, version: VERSION, summary: siteData.summary, engines }),
      jsonLd: [
        {
          "@context": "https://schema.org",
          "@type": "SoftwareApplication",
          name: "MotionPR",
          applicationCategory: "DeveloperApplication",
          operatingSystem: "macOS, Linux, Windows",
          softwareVersion: VERSION,
          description:
            "Animation regression testing and motion inspection for the web: capture, compare and inspect UI motion in CI.",
          url: SITE.url,
          downloadUrl: SITE.npm,
          license: "https://opensource.org/licenses/MIT",
          offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
          author: {
            "@type": "Person",
            name: "Eren Sümer",
            url: "https://github.com/erenthedeveloper0",
          },
        },
        {
          "@context": "https://schema.org",
          "@type": "SoftwareSourceCode",
          name: "MotionPR",
          codeRepository: SITE.repo,
          programmingLanguage: "TypeScript",
          runtimePlatform: "Node.js",
          license: "https://opensource.org/licenses/MIT",
        },
      ],
    },
    {
      path: "demo/",
      file: "demo/index.html",
      layout: "app",
      page: "demo",
      active: "demo",
      title: "Interactive demo · MotionPR",
      description:
        "The MotionPR demo app in its baseline and candidate versions, side by side, with what MotionPR measured for each of its eleven motion changes.",
      body: (up) => demoBody({ up, version: VERSION }),
    },
    {
      path: "playground/",
      file: "playground/index.html",
      layout: "app",
      page: "playground",
      active: "playground",
      title: "Playground · MotionPR",
      description:
        "Change an animation's duration, easing, delay and stagger and see what MotionPR's comparison engine reports. Easing and Lenis scroll laboratories included.",
      body: (up) => playgroundBody({ up, version: VERSION }),
    },
  ];
  for (const p of pages) {
    const up = "../".repeat(p.path.split("/").filter(Boolean).length);
    await mkdir(dirname(join(dist, p.file)), { recursive: true });
    await writeFile(
      join(dist, p.file),
      document({
        headHtml: head({
          title: p.title,
          description: p.description,
          path: p.path,
          up,
          jsonLd: p.jsonLd ?? [],
          version: VERSION,
        }),
        body: p.body(up),
        layout: p.layout,
        page: p.page,
        up,
        version: VERSION,
        active: p.active,
      }),
    );
  }
  // GitHub Pages serves 404.html for every missing path, at that path: anchor it to the site root.
  const notFound = document({
    headHtml: `<base href="${BASE_PATH}" />\n${head({ title: "Not found · MotionPR", description: "This page does not exist.", path: "404.html", up: "", noindex: true, version: VERSION })}`,
    body: notFoundBody({ up: "", version: VERSION }),
    layout: "app",
    page: "404",
    up: "",
    version: VERSION,
    active: null,
  });
  await writeFile(join(dist, "404.html"), notFound);
}

async function bundle() {
  const coreDir = join(root, "packages/core/src");
  const result = await esbuild({
    entryPoints: { app: join(here, "src/js/main.js"), site: join(here, "src/css/index.css") },
    outdir: join(dist, "assets"),
    bundle: true,
    splitting: true,
    format: "esm",
    target: ["es2020", "chrome100", "firefox100", "safari15.4"],
    minify: PRODUCTION,
    sourcemap: PRODUCTION ? false : "linked",
    entryNames: "[name]-[hash]",
    chunkNames: "chunks/[name]-[hash]",
    external: ["*.woff2"],
    alias: { "@motionpr/core": join(here, "src/js/lib/core-browser.js") },
    define: { __MP_VERSION__: JSON.stringify(VERSION) },
    legalComments: "linked",
    logLevel: "warning",
    metafile: true,
    // The comparison engine's TypeScript sources import from @motionpr/core; resolve its own
    // relative imports normally.
    nodePaths: [coreDir],
  });
  // Hand the hashed entry names to the page template.
  for (const [file, out] of Object.entries(result.metafile.outputs)) {
    const name = file.split("/").pop();
    if (out.entryPoint?.endsWith("src/js/main.js")) ASSETS.js = name;
    else if (out.entryPoint?.endsWith("src/css/index.css") && name.endsWith(".css"))
      ASSETS.css = name;
  }
  if (ASSETS.js === "app.js" || ASSETS.css === "site.css")
    throw new Error("could not find the hashed bundle names in the build output");
  const bytes = Object.entries(result.metafile.outputs)
    .filter(([f]) => /\.(js|css)$/.test(f))
    .reduce((a, [, o]) => a + o.bytes, 0);
  return { bytes, outputs: Object.keys(result.metafile.outputs).length };
}

async function copyAssets() {
  const brand = (p) => join(root, "brand", p);
  await mkdir(join(dist, "assets/brand"), { recursive: true });
  for (const f of [
    "social/motionpr-social-preview.jpg",
    "logo/motionpr-mark.svg",
    "logo/motionpr-logo-on-dark.svg",
    "logo/png/motionpr-logo-on-dark.png",
  ])
    await cp(brand(f), join(dist, "assets/brand", f.split("/").pop()));
  await cp(brand("icon/favicon.svg"), join(dist, "favicon.svg"));
  await cp(brand("icon/favicon.ico"), join(dist, "favicon.ico"));
  await cp(brand("icon/apple-touch-icon.png"), join(dist, "apple-touch-icon.png"));
  for (const f of ["icon-192.png", "icon-512.png", "icon-maskable-512.png"])
    await cp(brand(`icon/${f}`), join(dist, "assets/brand", f));
  await writeFile(
    join(dist, "site.webmanifest"),
    JSON.stringify(
      {
        name: "MotionPR",
        short_name: "MotionPR",
        description: SITE.tagline,
        start_url: "./",
        display: "standalone",
        background_color: "#070709",
        theme_color: "#070709",
        icons: [
          { src: "assets/brand/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "assets/brand/icon-512.png", sizes: "512x512", type: "image/png" },
          {
            src: "assets/brand/icon-maskable-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
      },
      null,
      2,
    ),
  );
  const font = (pkg, file) => join(dirname(require.resolve(`${pkg}/package.json`)), "files", file);
  await mkdir(join(dist, "assets/fonts"), { recursive: true });
  await cp(
    font("@fontsource-variable/geist", "geist-latin-wght-normal.woff2"),
    join(dist, "assets/fonts/geist.woff2"),
  );
  await cp(
    font("@fontsource-variable/geist-mono", "geist-mono-latin-wght-normal.woff2"),
    join(dist, "assets/fonts/geist-mono.woff2"),
  );
  await mkdir(join(dist, "assets/data"), { recursive: true });
  await cp(join(here, "data/site-data.json"), join(dist, "assets/data/site-data.json"));

  // The demo app, for the interactive demo page (both variants: ?variant=baseline|candidate).
  const demoApp = join(root, "fixtures/demo-app/dist");
  const hasDemoApp = existsSync(join(demoApp, "index.html"));
  if (hasDemoApp) await cp(demoApp, join(dist, "demo/app"), { recursive: true });

  // A real report of the demo app, when one was generated (CI: pnpm demo:capture --html apps/docs/public/report).
  const reports = [
    join(here, "public/report"),
    join(root, ".tmp/demo-report"),
    join(root, ".tmp/e2e/report"),
  ];
  const report = reports.find((d) => existsSync(join(d, "index.html")));
  await mkdir(join(dist, "report"), { recursive: true });
  if (report) await cp(report, join(dist, "report"), { recursive: true });
  else
    await writeFile(
      join(dist, "report/index.html"),
      `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Demo report · MotionPR</title><body style="font:16px/1.6 system-ui;background:#070709;color:#f3f1fa;padding:40px"><h1>Demo report not generated</h1><p>This build has no report of the demo app. Generate one with <code>pnpm build &amp;&amp; pnpm demo:capture --html apps/docs/public/report</code> and rebuild the site, or run <code>npx @erenthedeveloper0/motionpr@alpha demo</code> locally.</p><p><a style="color:#839cf6" href="../">Back to MotionPR</a></p></body>`,
    );
  return { hasDemoApp, report: report ? relative(root, report) : null };
}

async function seo() {
  const urls = ["", "docs/", "demo/", "playground/", ...PAGES.map((p) => docUrl(p.slug))];
  await writeFile(
    join(dist, "sitemap.xml"),
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((u) => `  <url><loc>${SITE.url}${u}</loc></url>`).join("\n")}\n</urlset>\n`,
  );
  await writeFile(
    join(dist, "robots.txt"),
    `User-agent: *\nAllow: /\n\nSitemap: ${SITE.url}sitemap.xml\n`,
  );
  await writeFile(join(dist, ".nojekyll"), "");
  return urls.length;
}

async function build() {
  const started = Date.now();
  await rm(dist, { recursive: true, force: true });
  await mkdir(dist, { recursive: true });
  const siteData = JSON.parse(await readFile(join(here, "data/site-data.json"), "utf8"));
  // The bundle first: the pages reference its hashed file names.
  const js = await bundle();
  const docs = await buildDocs();
  await buildPages(siteData);
  const assets = await copyAssets();
  const urls = await seo();
  console.log(
    `docs site: ${docs.count} doc pages, ${docs.search} search entries, ${urls} sitemap URLs, ${(js.bytes / 1024).toFixed(0)} kB JS+CSS (${js.outputs} files)` +
      `${assets.hasDemoApp ? " + demo app" : " (no demo app: run pnpm build)"}${assets.report ? ` + report from ${assets.report}` : " (no demo report)"} in ${Date.now() - started} ms → ${relative(root, dist)}`,
  );
}

await build();

if (process.argv.includes("--serve")) {
  const TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".svg": "image/svg+xml",
    ".jpg": "image/jpeg",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".woff2": "font/woff2",
    ".json": "application/json",
    ".xml": "application/xml",
    ".txt": "text/plain; charset=utf-8",
    ".webmanifest": "application/manifest+json",
  };
  const port = Number(process.env.PORT ?? 4321);
  createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    let path = decodeURIComponent(url.pathname);
    if (!path.startsWith(BASE_PATH)) {
      res.writeHead(302, { location: BASE_PATH }).end();
      return;
    }
    path = path.slice(BASE_PATH.length - 1);
    let file = resolve(dist, `.${path}`);
    if (!file.startsWith(dist)) return res.writeHead(403).end();
    try {
      if ((await stat(file)).isDirectory()) {
        if (!path.endsWith("/")) {
          res.writeHead(301, { location: `${url.pathname}/${url.search}` }).end();
          return;
        }
        file = join(file, "index.html");
      }
      const data = await readFile(file);
      res
        .writeHead(200, {
          "content-type": TYPES[extname(file)] ?? "application/octet-stream",
          "cache-control": "no-store",
        })
        .end(data);
    } catch {
      // Like GitHub Pages: the 404 page, with a 404 status.
      res
        .writeHead(404, { "content-type": TYPES[".html"] })
        .end(await readFile(join(dist, "404.html")));
    }
  }).listen(port, () => console.log(`serving http://localhost:${port}${BASE_PATH}`));
}
