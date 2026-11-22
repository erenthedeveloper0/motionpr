/**
 * End-to-end CLI tests: spawn the built binary (packages/cli/dist/bin.js) in temporary
 * projects and check behaviour and the exit-code contract. Requires `pnpm build` first.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_ENGINE_RUN, TEST_BROWSER } from "../../capture/tests/helpers/browser.ts";

const BIN = fileURLToPath(new URL("../dist/bin.js", import.meta.url));
const ROOT = fileURLToPath(new URL("../../..", import.meta.url));

interface Result {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Runs the CLI with the engine under test (MOTIONPR_TEST_BROWSER) as its default browser. */
function cli(args: string[], cwd: string, env: Record<string, string> = {}): Promise<Result> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      cwd,
      env: {
        ...process.env,
        NO_COLOR: "1",
        CI: "",
        GITHUB_ACTIONS: "",
        GITHUB_STEP_SUMMARY: "",
        MOTIONPR_BROWSER: TEST_BROWSER,
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

const PAGE = (duration: number) => `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;background:#fff}
.panel{position:absolute;left:0;top:0;width:200px;height:200px;background:#222;transform:translateX(-100%);transition:transform ${duration}ms cubic-bezier(.16,1,.3,1)}
.open .panel{transform:none}
button{position:absolute;right:20px;top:20px}
</style></head><body>
<button data-testid="toggle" onclick="document.body.classList.toggle('open')">Toggle</button>
<div class="panel" data-testid="panel"></div>
</body></html>`;

const SERVER = `import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
createServer(async (_req, res) => {
  res.writeHead(200, { "content-type": "text/html" }).end(await readFile(new URL("./index.html", import.meta.url)));
}).listen(Number(process.env.PORT));
`;

let dir: string;
let port: number;

beforeAll(async () => {
  if (!existsSync(BIN)) throw new Error("Build the CLI first: pnpm build");
  dir = await mkdtemp(join(tmpdir(), "motionpr-cli-"));
  port = 43000 + Math.floor(Math.random() * 2000);
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({ name: "cli-fixture", type: "module", scripts: { dev: "node server.mjs" } }),
  );
  await writeFile(join(dir, "server.mjs"), SERVER);
  await writeFile(join(dir, "index.html"), PAGE(300));
  // The config imports the package like a user's would; link the workspace package (a junction:
  // on Windows it needs no symlink privilege; other systems ignore the type).
  await mkdir(join(dir, "node_modules/@erenthedeveloper0"), { recursive: true });
  const { symlink } = await import("node:fs/promises");
  await symlink(
    join(ROOT, "packages/cli"),
    join(dir, "node_modules/@erenthedeveloper0/motionpr"),
    "junction",
  );
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe(`motionpr CLI (${TEST_BROWSER})`, () => {
  it("prints its version and rejects unknown commands with exit 2", async () => {
    const v = await cli(["--version"], dir);
    expect(v.code).toBe(0);
    expect(v.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
    expect((await cli(["frobnicate"], dir)).code).toBe(2);
    // Regression: usage errors on subcommands exited 1 ("regression found").
    expect((await cli(["capture", "--frobnicate"], dir)).code).toBe(2);
    expect((await cli(["baseline", "accept", "--nope"], dir)).code).toBe(2);
    expect((await cli(["compare", "--help"], dir)).code).toBe(0);
  });

  it("init --yes writes a valid commented config without overwriting", async () => {
    const r = await cli(
      ["init", "--yes", "--base-url", `http://127.0.0.1:${port}`, "--command", "npm run dev"],
      dir,
    );
    expect(r.code).toBe(0);
    const config = await readFile(join(dir, "motionpr.config.mjs"), "utf8");
    expect(config).toContain('import { defineConfig } from "@erenthedeveloper0/motionpr"');
    expect(config).toContain(`url: "http://127.0.0.1:${port}"`);
    expect(await readFile(join(dir, ".motionpr/.gitignore"), "utf8")).toContain("captures/");
    const again = await cli(["init", "--yes"], dir);
    expect(again.code).toBe(0);
    expect(again.stderr).toContain("already exists");
  });

  it("doctor --json reports a healthy environment", async () => {
    const r = await cli(["doctor", "--json"], dir);
    const report = JSON.parse(r.stdout) as {
      ok: boolean;
      checks: { name: string; status: string }[];
    };
    expect(r.code).toBe(0);
    expect(report.ok).toBe(true);
    expect(report.checks.find((c) => c.name === "Config")!.status).toBe("ok");
    const label = { chromium: "Chromium", firefox: "Firefox", webkit: "WebKit" }[TEST_BROWSER];
    expect(report.checks.find((c) => c.name === `${label} launch`)!.status).toBe("ok");
    expect(report.checks.find((c) => c.name === `${label} binary`)!.status).toBe("ok");
  });

  it("runs the full journey: no baseline → accept → unchanged → regression", async () => {
    const config = (await readFile(join(dir, "motionpr.config.mjs"), "utf8")).replace(
      /scenarios: \[[\s\S]*?\n {2}\],/,
      `scenarios: [{ id: "panel", path: "/", steps: [{ type: "click", selector: "[data-testid=toggle]" }, { type: "capture", label: "open" }] }],`,
    );
    await writeFile(join(dir, "motionpr.config.mjs"), config);
    const env = { PORT: String(port) };

    const first = await cli(["run"], dir, env);
    expect(first.code, first.stderr).toBe(0);
    expect(first.stderr).toMatch(/No approved (Chromium|Firefox|WebKit) baseline yet/);
    expect(existsSync(join(dir, `.motionpr/report/${TEST_BROWSER}/index.html`))).toBe(true);
    expect(existsSync(join(dir, ".motionpr/report/index.html"))).toBe(true);
    expect(existsSync(join(dir, `.motionpr/captures/${TEST_BROWSER}/LATEST`))).toBe(true);

    const ci = await cli(["run", "--ci"], dir, env);
    expect(ci.code).toBe(2);

    expect((await cli(["baseline", "accept"], dir)).code).toBe(0);
    expect(existsSync(join(dir, `.motionpr/baseline/${TEST_BROWSER}/capture.json`))).toBe(true);
    const baseline = JSON.parse(
      await readFile(join(dir, `.motionpr/baseline/${TEST_BROWSER}/capture.json`), "utf8"),
    ) as { environment: { browser: { name: string; version: string } } };
    expect(baseline.environment.browser.name).toBe(TEST_BROWSER);

    const same = await cli(["run", "--json"], dir, env);
    expect(same.code, same.stderr).toBe(0);
    const sameResult = JSON.parse(same.stdout) as {
      browser: string;
      summary: { status: string; counts: { critical: number; warning: number } };
    };
    expect(sameResult.browser).toBe(TEST_BROWSER);
    expect(sameResult.summary.status).toBe("passed");
    expect(sameResult.summary.counts.critical + sameResult.summary.counts.warning).toBe(0);

    await writeFile(join(dir, "index.html"), PAGE(650));
    const summaryFile = join(dir, "summary.md");
    const changed = await cli(["run"], dir, { ...env, GITHUB_STEP_SUMMARY: summaryFile });
    expect(changed.code).toBe(1);
    expect(changed.stderr).toContain("Duration 300ms → 650ms");
    expect(await readFile(summaryFile, "utf8")).toContain("motion regression detected");

    const lenient = await cli(["compare", "--threshold", "never", "--no-report"], dir);
    expect(lenient.code).toBe(0);

    const json = await cli(["compare", "--format", "json", "--no-report"], dir);
    expect(json.code).toBe(1);
    const result = JSON.parse(json.stdout) as { kind: string; differences: { title: string }[] };
    expect(result.kind).toBe("motionpr-comparison");
    expect(result.differences[0]!.title).toContain("Duration 300ms → 650ms");

    const md = await cli(["compare", "--format", "markdown", "--no-report"], dir);
    expect(md.stdout).toContain("| Result | Critical |");
  }, 180_000);

  it("never replaces a baseline non-interactively without --yes", async () => {
    const r = await cli(["baseline", "accept"], dir);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain(`Refusing to replace the approved ${TEST_BROWSER} baseline`);
    const yes = await cli(["baseline", "accept", "--yes"], dir);
    expect(yes.code).toBe(0);
  });

  it("reports invalid configs with issue paths and exit 2", async () => {
    const bad = join(dir, "bad");
    await mkdir(bad, { recursive: true });
    await writeFile(
      join(bad, "motionpr.config.mjs"),
      `export default { baseURL: "ftp://x", scenarios: [{ id: "a b", steps: [{ type: "click" }] }] };`,
    );
    const r = await cli(["capture", "--json"], bad);
    expect(r.code).toBe(2);
    const error = JSON.parse(r.stdout) as { error: { code: string; issues: { path: string }[] } };
    expect(error.error.code).toBe("CONFIG_INVALID");
    expect(error.error.issues.map((i) => i.path)).toEqual(
      expect.arrayContaining(["baseURL", "scenarios[0].id", "scenarios[0].steps[0].selector"]),
    );
  });

  it("explains a missing config", async () => {
    const empty = await mkdtemp(join(tmpdir(), "motionpr-empty-"));
    const r = await cli(["run"], empty);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("npx motionpr init");
    await rm(empty, { recursive: true, force: true });
  });
});

describe(`motionpr adapter check (${TEST_BROWSER})`, () => {
  // A small tween engine with a protocol 2 adapter; ?bug=<name> breaks one rule.
  const TOY = join(ROOT, "packages/capture/tests/fixtures/toy-adapter.html");

  it("passes a conforming adapter with exit 0, without a config", async () => {
    const r = await cli(["adapter", "check", TOY, "--timeout", "5000"], dir);
    expect(r.code, r.stderr).toBe(0);
    // Human output goes to stderr; stdout is kept for --json.
    expect(r.stderr).toContain("toy  protocol 2 · engine 1.0.0 (tested >=1.0.0 <2.0.0)");
    expect(r.stderr).toMatch(/replay-restores\s+2 animations at rest/);
    expect(r.stderr).toContain("Conforms to adapter protocol 2");
  });

  it("exits 1 when a check fails, with the report as JSON", async () => {
    const r = await cli(
      ["adapter", "check", `${TOY}?bug=no-restore`, "--json", "--timeout", "4000"],
      dir,
    );
    expect(r.code, r.stderr).toBe(1);
    const report = JSON.parse(r.stdout) as {
      passed: boolean;
      browser: string;
      checks: { id: string; status: string; details: string[] }[];
    };
    expect(report.passed).toBe(false);
    expect(report.browser).toBe(TEST_BROWSER);
    expect(report.checks.filter((c) => c.status === "fail").map((c) => c.id)).toEqual([
      "replay-restores",
    ]);
  });

  it("exits 2 when the page does not exist", async () => {
    const r = await cli(["adapter", "check", join(dir, "nope.html")], dir);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("No page at");
  });
});

describe("motionpr run with GSAP, Anime.js and Lenis in one app", () => {
  it("captures, compares and reports records from all three engines", async () => {
    const { serveDemo } = await import("../src/demo/server.ts");
    const server = await serveDemo(join(ROOT, "fixtures/demo-app/dist"));
    const project = await mkdtemp(join(tmpdir(), "motionpr-engines-"));
    try {
      await writeFile(
        join(project, "package.json"),
        JSON.stringify({ name: "engines", type: "module" }),
      );
      await mkdir(join(project, "node_modules/@erenthedeveloper0"), { recursive: true });
      const { symlink } = await import("node:fs/promises");
      await symlink(
        join(ROOT, "packages/cli"),
        join(project, "node_modules/@erenthedeveloper0/motionpr"),
        "junction",
      );
      await writeFile(
        join(project, "motionpr.config.mjs"),
        `import { defineConfig } from "@erenthedeveloper0/motionpr";
export default defineConfig({
  baseURL: process.env.APP_URL,
  browser: { viewport: { width: 1280, height: 800 } },
  capture: { waitForNetworkIdle: false, frames: { enabled: true, fps: 12, maxFrames: 16 } },
  adapters: [
    { name: "gsap", required: true },
    { name: "animejs", required: true },
    { name: "lenis", required: true },
  ],
  scenarios: [
    { id: "gsap-intro", steps: [{ type: "click", selector: "[data-testid=play-intro]" }, { type: "capture", label: "played" }] },
    { id: "anime-services", steps: [
      { type: "scrollIntoView", selector: "[data-testid=services]", block: "start" },
      { type: "waitForAnimations" },
      { type: "click", selector: "[data-testid=reveal-services]" },
      { type: "capture", label: "revealed" },
    ] },
    { id: "lenis-journal", steps: [
      { type: "scrollTo", target: "[data-testid=journal]" },
      { type: "waitForScrollSettled" },
      { type: "capture", label: "scrolled" },
    ] },
  ],
});
`,
      );
      const first = await cli(["run"], project, { APP_URL: `${server.url}/baseline/` });
      expect(first.code, first.stderr).toBe(0);
      const accepted = await cli(["baseline", "accept", "--yes"], project, {
        APP_URL: `${server.url}/baseline/`,
      });
      expect(accepted.code, accepted.stderr + accepted.stdout).toBe(0);
      const same = await cli(["run", "--json"], project, { APP_URL: `${server.url}/baseline/` });
      expect(same.code, same.stderr + same.stdout.slice(0, 2000)).toBe(0);
      const unchanged = JSON.parse(same.stdout) as {
        differences: { severity: string; title: string }[];
      };
      expect(
        unchanged.differences.filter((d) => d.severity !== "info").map((d) => d.title),
      ).toEqual([]);

      const changed = await cli(["run", "--json", "--threshold", "warning"], project, {
        APP_URL: `${server.url}/candidate/`,
      });
      expect(changed.code, changed.stderr).toBe(1);
      const result = JSON.parse(changed.stdout) as {
        differences: { source: string | null; category: string; title: string }[];
        report: string;
      };
      const sources = new Set(result.differences.map((d) => d.source));
      expect([...sources]).toEqual(expect.arrayContaining(["gsap", "animejs", "lenis"]));
      expect(result.differences.some((d) => d.category === "scroll")).toBe(true);

      // The report embeds the real records of every engine.
      const html = await readFile(result.report, "utf8");
      for (const marker of [
        '"source":"animejs"',
        '"source":"gsap"',
        '"source":"lenis"',
        '"scrollMotion":[{',
      ]) {
        expect(html, marker).toContain(marker);
      }
      const capture = JSON.parse(
        await readFile(join(project, `.motionpr/baseline/${TEST_BROWSER}/capture.json`), "utf8"),
      ) as { scenarios: { adapters: { id: string; status: string }[] }[] };
      for (const scenario of capture.scenarios)
        expect(scenario.adapters.map((a) => `${a.id}:${a.status}`).sort()).toEqual([
          "animejs:active",
          "gsap:active",
          "lenis:active",
        ]);
    } finally {
      await server.close();
      await rm(project, { recursive: true, force: true });
    }
  }, 180_000);
});

/** A project whose page and server live in a temporary directory (see PAGE and SERVER). */
async function pageProject(prefix: string, steps: unknown[] = DEFAULT_STEPS) {
  const project = await mkdtemp(join(tmpdir(), prefix));
  const projectPort = 45000 + Math.floor(Math.random() * 3000);
  await writeFile(join(project, "package.json"), JSON.stringify({ name: prefix, type: "module" }));
  await writeFile(join(project, "server.mjs"), SERVER);
  await writeFile(join(project, "index.html"), PAGE(300));
  await mkdir(join(project, "node_modules/@erenthedeveloper0"), { recursive: true });
  const { symlink } = await import("node:fs/promises");
  await symlink(
    join(ROOT, "packages/cli"),
    join(project, "node_modules/@erenthedeveloper0/motionpr"),
    "junction",
  );
  const url = `http://127.0.0.1:${projectPort}`;
  await writeFile(
    join(project, "motionpr.config.mjs"),
    `import { defineConfig } from "@erenthedeveloper0/motionpr";
export default defineConfig({
  baseURL: ${JSON.stringify(url)},
  webServer: { command: "node server.mjs", url: ${JSON.stringify(url)}, env: { PORT: "${projectPort}" } },
  browser: { viewport: { width: 800, height: 500 } },
  capture: { waitForNetworkIdle: false },
  scenarios: [{ id: "panel", steps: ${JSON.stringify(steps)} }],
});
`,
  );
  return project;
}
const DEFAULT_STEPS: unknown[] = [
  { type: "click", selector: "[data-testid=toggle]" },
  { type: "capture", label: "open" },
];

describe(`browser selection, installation and failures (${TEST_BROWSER})`, () => {
  let project: string;
  beforeAll(async () => {
    project = await pageProject("motionpr-select-");
  });
  afterAll(async () => {
    await rm(project, { recursive: true, force: true });
  });

  it("rejects unknown browser names with exit 2 before doing anything", async () => {
    for (const args of [
      ["run", "--browser", "safari"],
      ["capture", "--browser", "chromium,edge"],
      ["compare", "--browser", "ie"],
      ["baseline", "accept", "--browser", "netscape"],
      ["install", "opera"],
      ["compare", "--against", "opera"],
    ]) {
      const r = await cli(args, project);
      expect(r.code, args.join(" ")).toBe(2);
      expect(r.stderr, args.join(" ")).toMatch(/Unknown browser "(safari|edge|ie|netscape|opera)"/);
    }
    const env = await cli(["run"], project, { MOTIONPR_BROWSER: "lynx" });
    expect(env.code).toBe(2);
    expect(env.stderr).toContain('Unknown browser "lynx"');
    expect(existsSync(join(project, ".motionpr/captures"))).toBe(false);
  });

  it("fails with an install hint when the browser is missing, and never substitutes another", async () => {
    const empty = await mkdtemp(join(tmpdir(), "motionpr-no-browsers-"));
    try {
      const r = await cli(["run", "--browser", TEST_BROWSER], project, {
        PLAYWRIGHT_BROWSERS_PATH: empty,
      });
      expect(r.code).toBe(2);
      expect(r.stderr).toContain(`npx motionpr install ${TEST_BROWSER}`);
      expect(r.stderr).toContain("never substitutes another browser");
      const json = await cli(
        ["capture", "--json", "--browser", "chromium,firefox,webkit"],
        project,
        {
          PLAYWRIGHT_BROWSERS_PATH: empty,
        },
      );
      expect(json.code).toBe(2);
      const error = JSON.parse(json.stdout) as { error: { code: string; hint: string } };
      expect(error.error.code).toBe("BROWSER_NOT_INSTALLED");
      expect(error.error.hint).toContain("npx motionpr install chromium firefox webkit");
      expect(existsSync(join(project, ".motionpr/captures"))).toBe(false);
      const doctor = await cli(["doctor", "--json"], project, { PLAYWRIGHT_BROWSERS_PATH: empty });
      expect(doctor.code).toBe(2);
      const checks = (JSON.parse(doctor.stdout) as { checks: { name: string; status: string }[] })
        .checks;
      const label = { chromium: "Chromium", firefox: "Firefox", webkit: "WebKit" }[TEST_BROWSER];
      expect(checks.find((c) => c.name === `${label} binary`)!.status).toBe("fail");
      expect(checks.find((c) => c.name === `${label} launch`)!.status).toBe("fail");
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });

  it("install takes engine names or --all and checks options against them", async () => {
    const named = await cli(["install", "firefox", "webkit", "--dry-run"], project);
    expect(named.code, named.stderr).toBe(0);
    expect(named.stdout).toMatch(/Firefox [\d.]+ \(playwright firefox/);
    expect(named.stdout).toMatch(/WebKit [\d.]+ \(playwright webkit/);
    expect(named.stdout).not.toContain("playwright chromium");
    const all = await cli(["install", "--all", "--dry-run"], project);
    expect(all.code).toBe(0);
    for (const engine of ["chromium", "firefox", "webkit"])
      expect(all.stdout).toContain(`playwright ${engine}`);
    // Without names: the engine the run would use (MOTIONPR_BROWSER here).
    const fallback = await cli(["install", "--dry-run"], project);
    expect(fallback.stdout).toContain(`playwright ${TEST_BROWSER}`);
    const shell = await cli(["install", "firefox", "--only-shell", "--dry-run"], project);
    expect(shell.code).toBe(2);
    expect(shell.stderr).toContain("--only-shell only applies to Chromium");
  });

  it("exits 2 when a scenario fails during capture", async () => {
    const broken = await pageProject("motionpr-broken-", [
      { type: "click", selector: "[data-testid=missing]", timeout: 300 },
      { type: "capture", label: "never" },
    ]);
    try {
      const r = await cli(["capture"], broken);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("1 scenario failed during capture");
    } finally {
      await rm(broken, { recursive: true, force: true });
    }
  });
});

describe.runIf(DEFAULT_ENGINE_RUN)(
  "several browsers in one project (Chromium, Firefox, WebKit)",
  () => {
    let project: string;
    beforeAll(async () => {
      project = await pageProject("motionpr-multi-");
    });
    afterAll(async () => {
      await rm(project, { recursive: true, force: true });
    });

    interface MultiRun {
      kind: string;
      exitCode: number;
      reportIndex: string;
      browsers: {
        browser: string;
        status: string;
        exitCode: number;
        capture: { version: string } | null;
        differences: { severity: string; title: string }[];
      }[];
    }

    it("keeps baselines, captures and reports apart per engine", async () => {
      const first = await cli(["run", "--browser", "all", "--json"], project);
      expect(first.code, first.stderr).toBe(0);
      const initial = JSON.parse(first.stdout) as MultiRun;
      expect(initial.kind).toBe("motionpr-run");
      expect(initial.browsers.map((b) => `${b.browser}:${b.status}`)).toEqual([
        "chromium:no-baseline",
        "firefox:no-baseline",
        "webkit:no-baseline",
      ]);
      expect(await readFile(initial.reportIndex, "utf8")).toMatch(
        /Chromium[\s\S]*Firefox[\s\S]*WebKit/,
      );
      for (const engine of ["chromium", "firefox", "webkit"]) {
        expect(existsSync(join(project, `.motionpr/report/${engine}/index.html`))).toBe(true);
        expect(existsSync(join(project, `.motionpr/captures/${engine}/LATEST`))).toBe(true);
      }

      const accepted = await cli(["baseline", "accept", "--browser", "all"], project);
      expect(accepted.code, accepted.stderr).toBe(0);
      for (const engine of ["chromium", "firefox", "webkit"]) {
        const bundle = JSON.parse(
          await readFile(join(project, `.motionpr/baseline/${engine}/capture.json`), "utf8"),
        ) as { environment: { browser: { name: string } } };
        expect(bundle.environment.browser.name).toBe(engine);
      }

      const same = await cli(["run", "--browser", "all", "--json"], project);
      expect(same.code, same.stderr).toBe(0);
      const unchanged = JSON.parse(same.stdout) as MultiRun;
      expect(unchanged.browsers.map((b) => `${b.browser}:${b.status}`)).toEqual([
        "chromium:passed",
        "firefox:passed",
        "webkit:passed",
      ]);
      for (const b of unchanged.browsers)
        expect(
          b.differences.filter((d) => d.severity !== "info").map((d) => d.title),
          b.browser,
        ).toEqual([]);

      // A regression, approved for Firefox only: the other engines still compare against theirs.
      await writeFile(join(project, "index.html"), PAGE(650));
      const firefox = await cli(["run", "--browser", "firefox"], project);
      expect(firefox.code).toBe(1);
      expect(firefox.stderr).toContain("Duration 300ms → 650ms");
      const chromiumBefore = await readFile(
        join(project, ".motionpr/baseline/chromium/capture.json"),
        "utf8",
      );
      expect(
        (await cli(["baseline", "accept", "--browser", "firefox", "--yes"], project)).code,
      ).toBe(0);
      expect(
        await readFile(join(project, ".motionpr/baseline/chromium/capture.json"), "utf8"),
      ).toBe(chromiumBefore);
      const mixed = await cli(["run", "--browser", "chromium,firefox,webkit", "--json"], project);
      expect(mixed.code).toBe(1);
      const result = JSON.parse(mixed.stdout) as MultiRun;
      expect(result.exitCode).toBe(1);
      expect(result.browsers.map((b) => `${b.browser}:${b.status}`)).toEqual([
        "chromium:failed",
        "firefox:passed",
        "webkit:failed",
      ]);
    }, 300_000);

    it("refuses to compare different engines unless asked, and marks cross-browser results", async () => {
      const refused = await cli(
        [
          "compare",
          "--json",
          "--browser",
          "webkit",
          "--baseline",
          ".motionpr/baseline/chromium",
          "--no-report",
        ],
        project,
      );
      expect(refused.code).toBe(2);
      expect((JSON.parse(refused.stdout) as { error: { code: string } }).error.code).toBe(
        "BROWSER_MISMATCH",
      );

      const cross = await cli(
        ["compare", "--json", "--browser", "webkit", "--against", "chromium"],
        project,
      );
      expect([0, 1]).toContain(cross.code);
      const result = JSON.parse(cross.stdout) as {
        crossBrowser: boolean;
        baseline: { browserName: string };
        candidate: { browserName: string };
        diagnostics: { code: string }[];
        differences: { category: string; severity: string }[];
        report: string;
      };
      expect(result.crossBrowser).toBe(true);
      expect(result.baseline.browserName).toBe("chromium");
      expect(result.candidate.browserName).toBe("webkit");
      expect(result.diagnostics.map((d) => d.code)).toContain("CROSS_BROWSER_COMPARISON");
      expect(
        result.differences
          .filter((d) => d.category === "visual")
          .every((d) => d.severity === "uncertain"),
      ).toBe(true);
      expect(result.report).toContain("chromium-vs-webkit");
    }, 120_000);

    it("reads a 0.1 single-browser baseline and migrates it on request", async () => {
      const base = join(project, ".motionpr/baseline");
      const { rename } = await import("node:fs/promises");
      await rename(join(base, "chromium/capture.json"), join(base, "capture.json"));
      await rename(join(base, "chromium/assets"), join(base, "assets"));
      await rm(join(base, "chromium"), { recursive: true });
      const status = await cli(["baseline", "status", "--json"], project);
      const statusJson = JSON.parse(status.stdout) as {
        baselines: Record<string, { legacyLayout: boolean } | null>;
      };
      expect(statusJson.baselines.chromium!.legacyLayout).toBe(true);
      expect(statusJson.baselines.firefox!.legacyLayout).toBe(false);
      const run = await cli(["run", "--browser", "chromium"], project);
      expect(run.code).toBe(1); // the 650 ms change, against the migrated-to-be baseline
      expect(run.stderr).toContain("baseline migrate");
      const migrated = await cli(["baseline", "migrate"], project);
      expect(migrated.code).toBe(0);
      expect(existsSync(join(base, "chromium/capture.json"))).toBe(true);
      expect(existsSync(join(base, "capture.json"))).toBe(false);
      expect((await cli(["baseline", "migrate"], project)).stderr).toContain("Nothing to migrate");
    }, 120_000);
  },
);
