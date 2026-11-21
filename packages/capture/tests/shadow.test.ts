import { describe, expect, it } from "vitest";
import { splitSelector } from "../src/agent/shadow.ts";

describe("splitSelector", () => {
  it("splits at Playwright's chaining operator", () => {
    expect(splitSelector('[data-testid="plan-1"] >> [data-motionpr-id="glow"]')).toEqual([
      '[data-testid="plan-1"]',
      '[data-motionpr-id="glow"]',
    ]);
    expect(splitSelector("#app>>:scope > div:nth-of-type(2)")).toEqual([
      "#app",
      ":scope > div:nth-of-type(2)",
    ]);
    expect(splitSelector("css=#app >> css=.item")).toEqual(["#app", ".item"]);
    // A plain CSS selector, child combinators included, is one part.
    expect(splitSelector("body > main > div")).toEqual(["body > main > div"]);
  });

  it("keeps >> inside quotes, brackets and parentheses", () => {
    expect(splitSelector('[aria-label="a >> b"] >> span')).toEqual([
      '[aria-label="a >> b"]',
      "span",
    ]);
    expect(splitSelector("[title='x>>y']")).toEqual(["[title='x>>y']"]);
    expect(splitSelector(":is(a, b) >> c")).toEqual([":is(a, b)", "c"]);
    expect(splitSelector('[data-x="\\" >> "] >> i')).toEqual(['[data-x="\\" >> "]', "i"]);
  });

  it("leaves selectors in other Playwright engines to Playwright", () => {
    expect(splitSelector("text=Footer note")).toBeNull();
    expect(splitSelector("#app >> role=button")).toBeNull();
    expect(splitSelector("#app >> ")).toBeNull();
  });
});
