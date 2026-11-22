/**
 * Adapter protocol 2 in real browsers: the agent leaves out entries that would make a capture
 * unreadable and refuses adapters of an unsupported protocol, and the conformance suite
 * (`checkAdapter`, `motionpr adapter check`) passes a correct adapter and fails each broken rule
 * with the check that names it. The page is a small tween engine with an adapter; `?bug=<name>`
 * breaks one rule (fixtures/toy-adapter.html).
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ADAPTER_CHECKS,
  readCaptureBundle,
  resolveConfig,
  type AdapterCheckId,
  type CaptureBundle,
} from "@motionpr/core";
import { checkAdapter, launchBrowser, runCapture } from "@motionpr/capture";
import { serveDirectory, type StaticServer } from "./helpers/static-server.ts";
import { TEST_BROWSER } from "./helpers/browser.ts";

const FIXTURES = fileURLToPath(new URL("./fixtures", import.meta.url));
let server: StaticServer;
let browser: Browser;
let out: string;

beforeAll(async () => {
  server = await serveDirectory(FIXTURES);
  browser = await launchBrowser(resolveConfig({ baseURL: server.url, scenarios: [{ id: "x" }] }), {
    browserName: TEST_BROWSER,
  });
  out = await mkdtemp(join(tmpdir(), "motionpr-protocol-"));
});

afterAll(async () => {
  await browser?.close();
  await server?.close();
  await rm(out, { recursive: true, force: true });
});

const toy = (...bugs: string[]) =>
  `${server.url}/toy-adapter.html${bugs.length ? `?${bugs.map((b) => `bug=${b}`).join("&")}` : ""}`;

let n = 0;
async function capture(url: string): Promise<{ bundle: CaptureBundle; dir: string }> {
  const config = resolveConfig({
    capture: { samples: 9, waitForNetworkIdle: false },
    adapters: [{ name: "toy", required: true }],
    scenarios: [{ id: "toy", url }],
  });
  const dir = join(out, `capture-${++n}`);
  const { bundle } = await runCapture({ config, rootDir: out, outputDir: dir, browser });
  return { bundle, dir };
}

const toyRecords = (bundle: CaptureBundle) =>
  bundle.scenarios[0]!.checkpoints.flatMap((c) => c.animations).filter((a) => a.source === "toy");
/** Checkpoint diagnostics (the runner also copies them into the scenario's list). */
const checkpointDiagnostics = (bundle: CaptureBundle) =>
  bundle.scenarios[0]!.checkpoints.flatMap((c) => c.diagnostics);

describe(`adapter protocol 2 in the agent (${TEST_BROWSER})`, () => {
  it("records a protocol 2 adapter and its protocol", async () => {
    const { bundle } = await capture(toy());
    const status = bundle.scenarios[0]!.adapters.find((a) => a.id === "toy")!;
    expect(status).toMatchObject({
      status: "active",
      protocol: 2,
      capabilities: ["animations", "replay"],
    });
    expect(
      toyRecords(bundle)
        .map((r) => r.element.key)
        .sort(),
    ).toEqual(["test-id:card", "test-id:spinner", "test-id:title"]);
    expect(toyRecords(bundle).every((r) => r.completeness.status === "complete")).toBe(true);
  });

  it("keeps recording protocol 1 adapters (no protocol declared)", async () => {
    const { bundle } = await capture(toy("protocol-1"));
    expect(bundle.scenarios[0]!.adapters.find((a) => a.id === "toy")).toMatchObject({
      status: "active",
      protocol: 1,
    });
    expect(toyRecords(bundle)).toHaveLength(3);
  });

  it("leaves out an invalid entry, keeps the rest, and the capture stays readable", async () => {
    const { bundle, dir } = await capture(toy("bad-one"));
    // Before protocol 2, one such entry made the whole capture fail validation.
    await expect(readCaptureBundle(dir)).resolves.toBeTruthy();
    expect(
      toyRecords(bundle)
        .map((r) => r.element.key)
        .sort(),
    ).toEqual(["test-id:card", "test-id:spinner"]);
    const invalid = checkpointDiagnostics(bundle).filter(
      (d) => d.code === "ADAPTER_RECORD_INVALID",
    );
    expect(invalid).toHaveLength(1);
    expect(invalid[0]!.message).toContain('invalid animation "t1"');
    expect(invalid[0]!.message).toContain(
      'direction must be one of normal, reverse, alternate, alternate-reverse; got "sideways"',
    );
    expect(invalid[0]!.hint).toContain("motionpr adapter check");
  });

  it("reads a missing name as null", async () => {
    const { bundle, dir } = await capture(toy("no-name"));
    await expect(readCaptureBundle(dir)).resolves.toBeTruthy();
    expect(toyRecords(bundle)).toHaveLength(3);
    expect(toyRecords(bundle).every((r) => r.name === null)).toBe(true);
  });

  it("does not register an adapter of an unsupported protocol, and says why", async () => {
    const { bundle } = await capture(toy("protocol-3"));
    const scenario = bundle.scenarios[0]!;
    expect(toyRecords(bundle)).toEqual([]);
    expect(scenario.adapters.find((a) => a.id === "toy")).toMatchObject({
      status: "failed",
      protocol: null,
    });
    const codes = scenario.diagnostics.map((d) => d.code);
    expect(codes).toContain("ADAPTER_PROTOCOL_UNSUPPORTED");
    expect(codes).not.toContain("ADAPTER_MISSING");
    const d = scenario.diagnostics.find((x) => x.code === "ADAPTER_PROTOCOL_UNSUPPORTED")!;
    expect(d.level).toBe("error");
    expect(d.message).toContain("implements adapter protocol 3");
    expect(d.message).toContain("supports protocols 1 and 2");
  });

  it("leaves out malformed diagnostics instead of breaking the capture", async () => {
    const { bundle, dir } = await capture(toy("bad-diagnostics"));
    await expect(readCaptureBundle(dir)).resolves.toBeTruthy();
    const status = bundle.scenarios[0]!.adapters.find((a) => a.id === "toy")!;
    expect(status.diagnostics.map((d) => d.code)).toEqual(["ADAPTER_DIAGNOSTICS_INVALID"]);
  });
});

describe(`adapter conformance suite (${TEST_BROWSER})`, () => {
  it("passes a correct adapter", async () => {
    const report = await checkAdapter({ page: toy(), browser, timeout: 5000 });
    expect(report.checks.map((c) => c.id)).toEqual(ADAPTER_CHECKS.map((c) => c.id));
    expect(report.checks.filter((c) => c.status === "fail" || c.status === "warn")).toEqual([]);
    expect(report.passed).toBe(true);
    expect(report.adapter).toEqual({
      name: "toy",
      protocol: 2,
      version: "1.0.0",
      supportedRange: ">=1.0.0 <2.0.0",
      capabilities: ["animations", "replay"],
    });
    expect(report.browser).toBe(TEST_BROWSER);
    const status = Object.fromEntries(report.checks.map((c) => [c.id, c.status]));
    // What this adapter does not implement is skipped, not failed.
    expect(status).toMatchObject({
      timelines: "skip",
      "seek-progress": "skip",
      scroll: "skip",
      claims: "skip",
      "replay-callbacks": "pass",
      capture: "pass",
    });
  });

  // Each broken rule fails the check that names it, and nothing else fails.
  it.each<[string, AdapterCheckId[], AdapterCheckId[]?]>([
    ["no-pause", ["replay-holds", "replay-callbacks"]],
    ["no-restore", ["replay-restores"]],
    ["callbacks", ["replay-callbacks"]],
    ["stale-window", ["window"]],
    ["consume", ["collect-stable"]],
    ["needs-agent", ["without-agent"]],
    ["bad-diagnostics", ["diagnostics", "capture"]],
    ["claims-all", ["claims"], ["capabilities"]],
    ["bad-record", ["motion", "animations", "capture"]],
    ["bad-one", ["animations", "capture"]],
    ["no-name", ["animations"]],
    ["protocol-3", ["registration", "protocol"]],
    ["protocol-1", [], ["protocol"]],
  ])("?bug=%s fails %j", async (bug, failing, warning = []) => {
    const report = await checkAdapter({ page: toy(bug), browser, timeout: 4000 });
    const by = (status: string) =>
      report.checks.filter((c) => c.status === status).map((c) => c.id);
    expect(by("fail").sort(), JSON.stringify(report.checks, null, 1)).toEqual([...failing].sort());
    expect(by("warn").sort()).toEqual([...warning].sort());
    expect(report.passed).toBe(failing.length === 0);
  });

  it("fails isAnimating() that stays true, with the settling check", async () => {
    const report = await checkAdapter({ page: toy("always-animating"), browser, timeout: 2500 });
    const settling = report.checks.find((c) => c.id === "settling")!;
    expect(settling.status).toBe("fail");
    expect(settling.summary).toContain("stays true");
  });

  it("explains the replay violations it finds", async () => {
    const report = await checkAdapter({ page: toy("no-restore"), browser, timeout: 4000 });
    const restores = report.checks.find((c) => c.id === "replay-restores")!;
    expect(restores.details[0]).toMatch(
      /^"t1": \{"transform":"matrix\(1, 0, 0, 1, 120, 0\)"\} before replay/,
    );
  });

  it("checks a local HTML file, keeping its query", async () => {
    const report = await checkAdapter({
      page: join(FIXTURES, "toy-adapter.html?bug=consume"),
      browser,
      timeout: 4000,
    });
    expect(report.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/toy-adapter\.html\?bug=consume$/);
    expect(report.checks.find((c) => c.id === "collect-stable")!.status).toBe("fail");
  });

  it("asks which adapter to check when the page registers several", async () => {
    await expect(checkAdapter({ page: toy("two"), browser, timeout: 3000 })).rejects.toMatchObject({
      code: "ADAPTER_CHECK_FAILED",
      message: expect.stringContaining("toy, toy-2"),
    });
    const report = await checkAdapter({ page: toy("two"), adapter: "toy", browser, timeout: 3000 });
    expect(report.adapter?.name).toBe("toy");
  });

  it("fails registration when nothing registers, and reports missing pages as errors", async () => {
    const report = await checkAdapter({ page: toy("no-register"), browser, timeout: 1000 });
    expect(report.passed).toBe(false);
    expect(report.adapter).toBeNull();
    expect(report.checks[0]).toMatchObject({ id: "registration", status: "fail" });
    expect(report.checks.filter((c) => c.status === "skip").length).toBeGreaterThan(15);
    await expect(
      checkAdapter({ page: join(FIXTURES, "missing.html"), browser }),
    ).rejects.toMatchObject({
      code: "ADAPTER_CHECK_FAILED",
    });
  });
});
