import { describe, expect, it } from "vitest";
import {
  colorDistance,
  decomposeTransform,
  parseCssColor,
  parseCssNumeric,
  parseTransformMatrix,
  toKebabCase,
} from "../src/values.ts";
import {
  isLikelyGeneratedId,
  keyInShadowRoot,
  sanitizeLabel,
  animationKey,
  cssAttrValue,
} from "../src/identity.ts";
import { redactUrl, serializeJsonForHtml } from "../src/redact.ts";

describe("transform decomposition", () => {
  it("treats none as identity", () => {
    expect(decomposeTransform("none")).toMatchObject({
      translateX: 0,
      translateY: 0,
      scaleX: 1,
      scaleY: 1,
      rotate: 0,
    });
  });

  it("extracts translation", () => {
    expect(decomposeTransform("matrix(1, 0, 0, 1, 80, -12.5)")).toMatchObject({
      translateX: 80,
      translateY: -12.5,
    });
  });

  it("extracts scale and rotation", () => {
    const angle = (30 * Math.PI) / 180;
    const s = 2;
    const m = `matrix(${s * Math.cos(angle)}, ${s * Math.sin(angle)}, ${-s * Math.sin(angle)}, ${s * Math.cos(angle)}, 0, 0)`;
    const d = decomposeTransform(m)!;
    expect(d.scaleX).toBeCloseTo(2, 4);
    expect(d.scaleY).toBeCloseTo(2, 4);
    expect(d.rotate).toBeCloseTo(30, 3);
  });

  it("handles matrix3d translateZ and flags real 3D", () => {
    const flat = "matrix3d(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 10, 20, 0, 1)";
    expect(decomposeTransform(flat)).toMatchObject({ translateX: 10, translateY: 20, is3d: false });
    const deep = "matrix3d(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 50, 1)";
    expect(decomposeTransform(deep)).toMatchObject({ translateZ: 50, is3d: true });
  });

  it("returns null for unparseable values", () => {
    expect(parseTransformMatrix("translateX(10px)")).toBeNull();
    expect(decomposeTransform("matrix(1, 0)")).toBeNull();
  });
});

describe("numeric and color parsing", () => {
  it("parses lengths, numbers and percentages", () => {
    expect(parseCssNumeric("12px")).toEqual({ value: 12, unit: "px" });
    expect(parseCssNumeric("0.5")).toEqual({ value: 0.5, unit: "" });
    expect(parseCssNumeric("-3.25%")).toEqual({ value: -3.25, unit: "%" });
    expect(parseCssNumeric("auto")).toBeNull();
  });

  it("parses rgb/rgba in legacy and modern syntax", () => {
    expect(parseCssColor("rgb(255, 0, 10)")).toEqual({ r: 255, g: 0, b: 10, a: 1 });
    expect(parseCssColor("rgba(0, 0, 0, 0.5)")).toEqual({ r: 0, g: 0, b: 0, a: 0.5 });
    expect(parseCssColor("rgb(0 128 255 / 50%)")).toEqual({ r: 0, g: 128, b: 255, a: 0.5 });
    expect(parseCssColor("transparent")).toEqual({ r: 0, g: 0, b: 0, a: 0 });
    expect(parseCssColor("oklch(0.5 0.1 200)")).toBeNull();
  });

  it("measures color distance on a 0..1 scale", () => {
    expect(colorDistance({ r: 0, g: 0, b: 0, a: 1 }, { r: 0, g: 0, b: 0, a: 1 })).toBe(0);
    expect(colorDistance({ r: 0, g: 0, b: 0, a: 0 }, { r: 255, g: 255, b: 255, a: 1 })).toBe(1);
  });

  it("converts getKeyframes property names to kebab-case", () => {
    expect(toKebabCase("backgroundColor")).toBe("background-color");
    expect(toKebabCase("opacity")).toBe("opacity");
    expect(toKebabCase("--brand-x")).toBe("--brand-x");
    expect(toKebabCase("cssFloat")).toBe("float");
  });
});

describe("identity helpers", () => {
  it("detects runtime-generated ids", () => {
    for (const id of [
      ":r1:",
      "«r3»",
      "radix-:r2:",
      "headlessui-menu-button-3",
      "ember1234",
      "el-9f8e7d6c5b",
      "item-123456",
    ]) {
      expect(isLikelyGeneratedId(id), id).toBe(true);
    }
    for (const id of ["main-nav", "hero", "pricing-table", "step-2"]) {
      expect(isLikelyGeneratedId(id), id).toBe(false);
    }
  });

  it("sanitizes and truncates labels", () => {
    expect(sanitizeLabel("  Open\n  menu  ")).toBe("Open menu");
    expect(sanitizeLabel("")).toBeUndefined();
    expect(sanitizeLabel("x".repeat(100), 10)).toHaveLength(10);
  });

  it("builds animation keys and escapes attribute values", () => {
    expect(animationKey("test-id:menu", "css-transition", "transform")).toBe(
      "test-id:menu::css-transition::transform",
    );
    expect(animationKey("id:x", "web-animation", null)).toBe("id:x::web-animation::anonymous");
    expect(cssAttrValue('a"b\\c')).toBe('a\\"b\\\\c');
  });

  it("reads the key of an element within its shadow root", () => {
    expect(keyInShadowRoot({ key: "test-id:menu" })).toBe("test-id:menu");
    expect(
      keyInShadowRoot({
        key: "test-id:outer >> test-id:inner >> motionpr-id:spark",
        shadowHost: "test-id:outer >> test-id:inner",
      }),
    ).toBe("motionpr-id:spark");
  });
});

describe("privacy helpers", () => {
  it("redacts query values and credentials by default", () => {
    const url = redactUrl("https://user:pw@example.com/a?token=abc&page=2#x=1", {
      redactQueryParams: true,
      allowQueryParams: ["page"],
    });
    expect(url).toBe("https://example.com/a?token=REDACTED&page=2#REDACTED");
  });

  it("keeps URLs intact when redaction is disabled (credentials are still removed)", () => {
    expect(
      redactUrl("http://u:p@localhost:3000/?q=1", {
        redactQueryParams: false,
        allowQueryParams: [],
      }),
    ).toBe("http://localhost:3000/?q=1");
  });

  it("serializes JSON safely for inline <script> embedding", () => {
    const out = serializeJsonForHtml({ label: "</script><script>alert(1)</script>", amp: "a&b" });
    expect(out).not.toContain("</script>");
    expect(out).not.toContain("&");
    expect(JSON.parse(out)).toEqual({ label: "</script><script>alert(1)</script>", amp: "a&b" });
  });
});
