import { describe, expect, it } from "vitest";
import { must } from "../src/assert.js";

describe("must", () => {
  it("returns the value, including falsy ones that are not null or undefined", () => {
    expect(must(0, "n")).toBe(0);
    expect(must("", "s")).toBe("");
    expect(must(false, "b")).toBe(false);
  });

  it("throws an internal error naming what is missing", () => {
    expect(() => must(undefined, "lead result")).toThrow("internal: lead result is missing");
    expect(() => must(null, "x")).toThrow("internal: x is missing");
  });
});
