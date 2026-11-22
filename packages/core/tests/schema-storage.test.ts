import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AssetStore,
  CAPTURE_SCHEMA_VERSION,
  SchemaError,
  copyCaptureDir,
  generateCaptureId,
  latestCaptureDir,
  listCaptures,
  maxSeverity,
  parseCaptureBundle,
  pruneCaptures,
  readCaptureBundle,
  resolveCaptureRef,
  resolvePaths,
  setLatestCapture,
  severityRank,
  writeCaptureBundle,
  type CaptureBundle,
} from "../src/index.ts";

export function emptyBundle(id = "20261113-120000-abcd"): CaptureBundle {
  return {
    schemaVersion: CAPTURE_SCHEMA_VERSION,
    kind: "motionpr-capture",
    motionprVersion: "0.1.0-alpha.0",
    id,
    createdAt: "2026-11-13T12:00:00.000Z",
    project: { name: "test" },
    environment: {
      browser: {
        name: "chromium",
        version: "158.0",
        headless: true,
        channel: null,
        userAgent: null,
      },
      platform: "darwin",
      arch: "arm64",
      node: "v24.0.0",
      playwright: "1.65.0",
      ci: false,
      osRelease: null,
      capabilities: null,
    },
    settings: {
      colorScheme: "light",
      locale: "en-US",
      timezoneId: "UTC",
      reducedMotion: "no-preference",
      samples: 24,
      frames: { enabled: true, fps: 30, maxFrames: 90, format: "png" },
      maxWindow: 5000,
      maskInputs: true,
      scrollContainers: true,
      shadowRoots: true,
    },
    configHash: "abc",
    scenarios: [],
    assets: {},
    diagnostics: [],
  };
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "motionpr-core-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("parseCaptureBundle", () => {
  it("accepts a valid bundle", () => {
    expect(parseCaptureBundle(emptyBundle()).id).toBe("20261113-120000-abcd");
  });

  it("rejects documents of another kind", () => {
    expect(() => parseCaptureBundle({ kind: "something-else", schemaVersion: 1 })).toThrow(
      SchemaError,
    );
  });

  it("rejects newer schema versions with an upgrade hint", () => {
    try {
      parseCaptureBundle({ ...emptyBundle(), schemaVersion: 99 });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(SchemaError);
      expect((error as SchemaError).code).toBe("SCHEMA_UNSUPPORTED_VERSION");
      expect((error as SchemaError).hint).toMatch(/Upgrade MotionPR/);
    }
  });

  it("lists validation issues with paths", () => {
    try {
      parseCaptureBundle({ ...emptyBundle(), scenarios: [{ key: 1 }] }, "capture.json");
      expect.unreachable();
    } catch (error) {
      expect((error as SchemaError).issues.some((i) => i.path.startsWith("scenarios[0]"))).toBe(
        true,
      );
      expect((error as SchemaError).message).toContain("capture.json failed validation");
    }
  });
});

describe("storage", () => {
  it("writes, lists and reads capture bundles", async () => {
    const captures = join(dir, "captures");
    await writeCaptureBundle(
      join(captures, "20261113-120000-aaaa"),
      emptyBundle("20261113-120000-aaaa"),
    );
    await writeCaptureBundle(
      join(captures, "20261113-130000-bbbb"),
      emptyBundle("20261113-130000-bbbb"),
    );
    expect((await listCaptures(captures)).map((c) => c.id)).toEqual([
      "20261113-130000-bbbb",
      "20261113-120000-aaaa",
    ]);
    expect((await readCaptureBundle(join(captures, "20261113-120000-aaaa"))).id).toBe(
      "20261113-120000-aaaa",
    );

    expect(await latestCaptureDir(captures)).toBe(join(captures, "20261113-130000-bbbb"));
    await setLatestCapture(captures, "20261113-120000-aaaa");
    expect(await latestCaptureDir(captures)).toBe(join(captures, "20261113-120000-aaaa"));
  });

  it("deduplicates identical assets by content", async () => {
    const store = new AssetStore(dir);
    const a = await store.put(new Uint8Array([1, 2, 3]), "png", { width: 1, height: 1 });
    const b = await store.put(new Uint8Array([1, 2, 3]), "png", { width: 1, height: 1 });
    const c = await store.put(new Uint8Array([4, 5, 6]), "jpeg", { width: 1, height: 1 });
    expect(a).toBe(b);
    expect(c.endsWith(".jpg")).toBe(true);
    expect(await readdir(join(dir, "assets"))).toHaveLength(2);
    expect(store.toRecord()[a]).toEqual({
      file: `assets/${a}`,
      format: "png",
      width: 1,
      height: 1,
      bytes: 3,
    });
  });

  it("resolves capture references", async () => {
    const paths = resolvePaths(
      {
        output: {
          directory: ".motionpr",
          baseline: "baseline",
          captures: "captures",
          report: "report",
          keep: 5,
        },
      },
      dir,
    );
    const id = generateCaptureId(new Date("2026-11-13T10:20:30Z"));
    expect(id).toMatch(/^20261113-102030-[0-9a-f]{4}$/);
    await writeCaptureBundle(join(paths.captures, id), emptyBundle(id));
    expect(await resolveCaptureRef("latest", paths)).toBe(join(paths.captures, id));
    expect(await resolveCaptureRef(id, paths)).toBe(join(paths.captures, id));
    expect(await resolveCaptureRef(join(paths.captures, id), paths)).toBe(join(paths.captures, id));
    expect(await resolveCaptureRef("baseline", paths)).toBe(paths.baseline);
    await expect(resolveCaptureRef("nope", paths)).rejects.toThrow(/Cannot find a capture/);
  });

  it("prunes old captures but keeps the newest", async () => {
    const captures = join(dir, "captures");
    for (const id of ["20261110-000000-0001", "20261111-000000-0002", "20261112-000000-0003"]) {
      await writeCaptureBundle(join(captures, id), emptyBundle(id));
    }
    expect(await pruneCaptures(captures, 2)).toEqual(["20261110-000000-0001"]);
    expect((await listCaptures(captures)).map((c) => c.id)).toEqual([
      "20261112-000000-0003",
      "20261111-000000-0002",
    ]);
  });

  it("copies a capture directory over an existing destination", async () => {
    const src = join(dir, "src");
    const dest = join(dir, "dest");
    await writeCaptureBundle(src, emptyBundle("20261113-000000-new0"));
    await mkdir(join(src, "assets"), { recursive: true });
    await writeFile(join(src, "assets", "x.png"), "x");
    await writeCaptureBundle(dest, emptyBundle("20261101-000000-old0"));
    await copyCaptureDir(src, dest);
    expect(JSON.parse(await readFile(join(dest, "capture.json"), "utf8")).id).toBe(
      "20261113-000000-new0",
    );
    expect(await readdir(join(dest, "assets"))).toEqual(["x.png"]);
    expect((await readdir(dir)).sort()).toEqual(["dest", "src"]);
  });
});

describe("severity helpers", () => {
  it("ranks severities and prefers definite levels over uncertain", () => {
    expect(severityRank("critical")).toBeGreaterThan(severityRank("warning"));
    expect(maxSeverity(["info", "uncertain", "warning"])).toBe("warning");
    expect(maxSeverity(["uncertain"])).toBe("uncertain");
    expect(maxSeverity([])).toBeNull();
  });
});
