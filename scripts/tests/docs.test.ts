/**
 * Documentation checks: every public export is documented, relative links resolve, the site's
 * navigation lists every page exactly once, config examples validate against the real schema,
 * code examples run against the real implementation, and release metadata is consistent.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../..", import.meta.url));
const read = (p: string) => readFileSync(join(root, p), "utf8");

function exportedNames(source: string): string[] {
  const names: string[] = [];
  for (const block of source.matchAll(/export (?:type )?\{([^}]+)\}/g)) {
    for (const part of block[1]!.split(",")) {
      const name = part
        .trim()
        .replace(/^type\s+/, "")
        .split(/\s+as\s+/)
        .pop()!
        .trim();
      if (name) names.push(name);
    }
  }
  return names;
}

/** Markdown files under `dir`, as `/`-separated paths (the site's page list uses `/` on Windows too). */
function markdownFiles(dir: string): string[] {
  return readdirSync(join(root, dir)).flatMap((name) => {
    const rel = `${dir}/${name}`;
    return statSync(join(root, rel)).isDirectory()
      ? markdownFiles(rel)
      : rel.endsWith(".md")
        ? [rel]
        : [];
  });
}

const ROOT_DOCS = [
  "README.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "SUPPORT.md",
  "CODE_OF_CONDUCT.md",
  "CHANGELOG.md",
  "ROADMAP.md",
  "ARCHITECTURE.md",
  "CONTRIBUTORS.md",
];

describe("docs", () => {
  it("documents every export of the public package", () => {
    const names = exportedNames(read("packages/cli/src/index.ts"));
    expect(names.length).toBeGreaterThan(40);
    const api = read("docs/advanced/public-api.md");
    expect(names.filter((n) => !api.includes(n))).toEqual([]);
  });

  it.each([
    ["gsap", "docs/integrations/gsap.md"],
    ["animejs", "docs/integrations/animejs.md"],
    ["lenis", "docs/integrations/lenis.md"],
  ])("documents every export of @erenthedeveloper0/motionpr/%s", (entry, doc) => {
    const names = exportedNames(read(`packages/cli/src/${entry}.ts`)).filter(
      (n) => n !== "default",
    );
    expect(names.length).toBeGreaterThan(3);
    const text = read(doc);
    expect(names.filter((n) => !text.includes(n))).toEqual([]);
  });

  it("documents every scenario step type", () => {
    const schema = read("packages/core/src/config/schema.ts");
    const steps = [...schema.matchAll(/type: z\.literal\("([a-zA-Z]+)"\)/g)].map((m) => m[1]!);
    expect(steps.length).toBeGreaterThan(12);
    const doc = read("docs/configuration/scenarios.md");
    expect(steps.filter((s) => !doc.includes(`\`${s}\``))).toEqual([]);
  });

  it("has no broken relative links", () => {
    const files = [...markdownFiles("docs"), ...ROOT_DOCS].filter((f) => existsSync(join(root, f)));
    const broken: string[] = [];
    for (const file of files) {
      for (const m of read(file).matchAll(/\]\((?!https?:|mailto:|#)([^)\s]+?)(#[^)]*)?\)/g)) {
        const target = resolve(dirname(join(root, file)), m[1]!);
        if (!existsSync(target)) broken.push(`${file} → ${m[1]}`);
      }
    }
    expect(broken).toEqual([]);
  });

  it("lists every documentation page in the site navigation exactly once", async () => {
    const { PAGES } = (await import("../../apps/docs/site/nav.mjs")) as {
      PAGES: { file: string }[];
    };
    const files = markdownFiles("docs").map((f) => f.slice("docs/".length));
    const listed = PAGES.map((p) => p.file);
    expect(new Set(listed).size).toBe(listed.length);
    expect([...files].sort()).toEqual([...listed].sort());
    for (const file of files) {
      const text = read(`docs/${file}`);
      expect(text, file).toMatch(/^---\ntitle: .+\ndescription: .+\n---\n/);
    }
  });

  it("every interactive component in the docs exists and points at real data", () => {
    const registry = read("apps/docs/src/js/registry.js");
    const known = new Set(
      [...registry.matchAll(/^\s+"?([a-z-]+)"?: \(\) => import/gm)].map((m) => m[1]!),
    );
    const data = JSON.parse(read("apps/docs/data/site-data.json")) as {
      datasets: Record<string, unknown>;
    };
    const problems: string[] = [];
    let count = 0;
    for (const file of markdownFiles("docs")) {
      for (const m of read(file).matchAll(/<!-- motionpr:([a-z-]+)(.*?)-->/g)) {
        count++;
        const [, name, attrs = ""] = m;
        if (!known.has(name!)) problems.push(`${file}: unknown component ${name}`);
        const ds = /dataset="([^"]+)"/.exec(attrs)?.[1];
        if (ds && !data.datasets[ds]) problems.push(`${file}: no dataset ${ds}`);
        const engine = /engine="([^"]+)"/.exec(attrs)?.[1];
        if (engine && !["css", "waapi", "gsap", "animejs", "lenis"].includes(engine))
          problems.push(`${file}: unknown engine ${engine}`);
      }
    }
    expect(count).toBeGreaterThan(8);
    expect(problems).toEqual([]);
  });

  it("documents every CLI command and config section", () => {
    for (const cmd of [
      "init",
      "install",
      "capture",
      "compare",
      "run",
      "report",
      "doctor",
      "demo",
    ]) {
      expect(read(`docs/cli/${cmd}.md`), cmd).toContain(`# \`motionpr ${cmd}\``);
    }
    const baseline = read("docs/cli/baseline.md");
    expect(baseline).toContain("## `motionpr baseline accept`");
    expect(baseline).toContain("## `motionpr baseline status`");
    const adapter = read("docs/cli/adapter.md");
    expect(adapter).toContain("# `motionpr adapter`");
    expect(adapter).toContain("## `motionpr adapter check`");
    const config = markdownFiles("docs/configuration").map(read).join("\n");
    for (const key of [
      "output.keep",
      "browser.viewports",
      "capture.settleTime",
      "comparison.failOn",
      "comparison.scroll",
      "privacy.maskInputs",
      "identity.attribute",
      "ignore.selectors",
      "MOTIONPR_BASE_URL",
      "MOTIONPR_BROWSER_PATH",
    ]) {
      expect(config, key).toContain(key);
    }
  });

  it("documents every check of the adapter conformance suite", async () => {
    const { ADAPTER_CHECKS } = await import("../../packages/core/src/adapter-contract.ts");
    const doc = read("docs/cli/adapter.md");
    expect(ADAPTER_CHECKS.map((c) => c.id).filter((id) => !doc.includes(`| \`${id}\` `))).toEqual(
      [],
    );
    const program = read("packages/cli/src/program.ts");
    for (const option of ["--adapter <name>", "--script <file>", "--timeout <ms>", "--headed"]) {
      expect(program, option).toContain(`"${option}"`);
      expect(doc, option).toContain(`\`${option}\``);
    }
  });

  it("every complete config example validates against the real schema", async () => {
    const { resolveConfig } = await import("../../packages/core/src/index.ts");
    const checked: string[] = [];
    for (const file of markdownFiles("docs")) {
      for (const m of read(file).matchAll(/```ts[^\n]*\n([\s\S]*?)```/g)) {
        const code = m[1]!;
        const at = code.indexOf("export default defineConfig({");
        // Skip fragments (placeholders) and examples that import the user's own modules.
        if (at < 0 || /\/\* … \*\/|…/.test(code) || /from "\.\.?\//.test(code)) continue;
        const body = code
          .slice(at + "export default defineConfig(".length)
          .trim()
          .replace(/\);\s*$/, "");
        const value = new Function("process", `return (${body});`)({ env: {} }) as unknown;
        expect(() => resolveConfig(value), file).not.toThrow();
        checked.push(file);
      }
    }
    expect(checked.length).toBeGreaterThanOrEqual(3);
  });

  it("the easing example in the docs gives the numbers the docs state", async () => {
    const { compareEasingSamples, sampleEasing } =
      await import("../../packages/core/src/easing/index.ts");
    expect(
      compareEasingSamples(sampleEasing("ease"), sampleEasing("cubic-bezier(0.25, 0.1, 0.25, 1)"))
        .equivalent,
    ).toBe(true);
    const change = compareEasingSamples(
      sampleEasing("cubic-bezier(0.16, 1, 0.3, 1)"),
      sampleEasing("ease-in-out"),
    );
    expect(change.maxDeviation).toBe(0.6975);
    expect(change.maxDeviationAt).toBe(0.2656);
    expect(read("docs/features/easing-analysis.md")).toContain("0.6975, at maxDeviationAt 0.2656");
  });
});

describe("versions", () => {
  it("keeps every package and MOTIONPR_VERSION on the public package's version", () => {
    const version = (JSON.parse(read("packages/cli/package.json")) as { version: string }).version;
    expect(version).toBe("0.5.0-alpha");
    for (const dir of [
      "core",
      "capture",
      "comparison",
      "report",
      "adapters/gsap",
      "adapters/animejs",
      "adapters/lenis",
    ])
      expect(
        (JSON.parse(read(`packages/${dir}/package.json`)) as { version: string }).version,
        dir,
      ).toBe(version);
    expect(read("packages/core/src/version.ts")).toContain(`MOTIONPR_VERSION = "${version}"`);
    expect(read("CHANGELOG.md")).toMatch(
      new RegExp(`^## \\[${version.replace(/\./g, "\\.")}\\] — \\d{4}-\\d{2}-\\d{2}$`, "m"),
    );
  });

  it("names the current version wherever the docs, the website and the README state it", () => {
    const version = (JSON.parse(read("packages/cli/package.json")) as { version: string }).version;
    const files = [
      ...markdownFiles("docs"),
      "README.md",
      "apps/docs/site/pages.mjs",
      ".github/ISSUE_TEMPLATE/bug_report.yml",
    ];
    // Each pattern captures a version that must be the current one: CLI output, the "is in
    // alpha" status lines, the install docs, the doctor example, the issue template, the README.
    const patterns = [
      /◐ motionpr (\S+) {2}·/g,
      /is in \**alpha\**(?: \(|\s+\()`([^`]+)`\)/g,
      /prereleases \(`([^`]+)`\)/g,
      /"name": "MotionPR", "status": "ok", "detail": "([^"]+)"/g,
      /placeholder: "(\d[^"]*)"/g,
      /\*\*Alpha — `([^`]+)`\.\*\*/g,
    ];
    const stale: string[] = [];
    let found = 0;
    for (const file of files)
      for (const pattern of patterns)
        for (const m of read(file).matchAll(pattern)) {
          found++;
          if (m[1] !== version) stale.push(`${file}: ${m[0]}`);
        }
    expect(found).toBeGreaterThan(10);
    expect(stale).toEqual([]);
  });

  it("publishes prereleases under a matching dist-tag, never latest", async () => {
    const { distTagFor, MOTIONPR_INSTALL_SPEC } =
      await import("../../packages/core/src/version.ts");
    expect(distTagFor("0.1.0-alpha")).toBe("alpha");
    expect(distTagFor("0.1.0-alpha.3")).toBe("alpha");
    expect(distTagFor("0.4.0-beta.1")).toBe("beta");
    expect(distTagFor("1.0.0-rc.1")).toBe("next");
    expect(distTagFor("1.0.0")).toBe("latest");
    expect(MOTIONPR_INSTALL_SPEC).toBe("@erenthedeveloper0/motionpr@alpha");
    // The docs show the same install command.
    expect(read("docs/getting-started/installation.md")).toContain(
      "npm install -D @erenthedeveloper0/motionpr@alpha",
    );
    expect(read("README.md")).toContain("npm install -D @erenthedeveloper0/motionpr@alpha");
  });
});

describe("package identity", () => {
  it("uses one package name, repository and docs URL everywhere", async () => {
    const { MOTIONPR_DOCS_URL, MOTIONPR_PACKAGE, MOTIONPR_REPOSITORY } =
      await import("../../packages/core/src/version.ts");
    const pkg = JSON.parse(read("packages/cli/package.json")) as {
      name: string;
      homepage: string;
      repository: { url: string };
      bugs: { url: string };
      bin: Record<string, string>;
      publishConfig: Record<string, unknown>;
    };
    expect(pkg.name).toBe("@erenthedeveloper0/motionpr");
    expect(pkg.name).toBe(MOTIONPR_PACKAGE);
    expect(pkg.homepage).toBe(MOTIONPR_DOCS_URL);
    expect(pkg.repository.url).toBe(`git+${MOTIONPR_REPOSITORY}.git`);
    expect(MOTIONPR_REPOSITORY).toBe("https://github.com/erenthedeveloper0/motionpr");
    expect(pkg.bugs.url).toBe(`${MOTIONPR_REPOSITORY}/issues`);
    expect(Object.keys(pkg.bin)).toEqual(["motionpr"]);
    // Manual publishing: provenance can only be generated in CI, so it must not be requested.
    expect(pkg.publishConfig).toEqual({ access: "public" });
    const files = [...markdownFiles("docs"), ...ROOT_DOCS].filter((f) => existsSync(join(root, f)));
    for (const file of files) {
      const text = read(file);
      expect(text, file).not.toMatch(
        /\bOWNER\b|from ["']motionpr["']|(?<![@\w/.-])motionpr\/(gsap|animejs|lenis)/,
      );
      expect(text, file).not.toMatch(/(npm install|pnpm add|yarn add)( -D)? motionpr\b/);
      expect(text, file).not.toMatch(/motionpr@next|`next` (dist-)?tag/);
    }
  });
});

describe("GitHub workflows (supply chain, permissions, no automated publishing)", () => {
  const dir = ".github/workflows";
  const workflows = readdirSync(join(root, dir)).filter((f) => f.endsWith(".yml"));

  it.each(workflows)("%s pins actions to commit SHAs and defaults to a read-only token", (file) => {
    const yaml = read(`${dir}/${file}`);
    const uses = [...yaml.matchAll(/uses: (\S+)/g)].map((m) => m[1]!);
    expect(uses.length).toBeGreaterThan(0);
    for (const u of uses) expect(u, u).toMatch(/@[0-9a-f]{40}$/);
    expect(yaml).toMatch(/^permissions:\n {2}contents: read$/m);
    expect(yaml).not.toContain("pull_request_target");
    expect(yaml).not.toMatch(/permissions:\s*write-all/);
  });

  it("no workflow can publish to npm", () => {
    for (const file of workflows) {
      const yaml = read(`${dir}/${file}`);
      expect(yaml, file).not.toMatch(
        /npm publish|pnpm publish|NPM_TOKEN|NODE_AUTH_TOKEN|registry-url|changesets\/action/,
      );
    }
    expect(existsSync(join(root, "scripts/publish.mjs"))).toBe(false);
  });

  it("only the Pages deployment gets an OIDC token or write access", () => {
    for (const file of workflows) {
      const yaml = read(`${dir}/${file}`);
      if (/id-token: write|pages: write/.test(yaml)) expect(file).toBe("pages.yml");
      expect(yaml).not.toMatch(/contents: write/);
    }
  });
});
