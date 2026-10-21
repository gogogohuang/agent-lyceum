import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { countFormatRejection, formatRejectionKey, formatRejections } from "../src/format-rejections.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "fr-"));

describe("format rejections", () => {
  it("counts per key and survives a reload", () => {
    const dir = tmp();
    const a = formatRejectionKey("qa", "reply", " Subject ");
    expect(a).toBe("qa|reply|subject");
    expect(formatRejections(dir, a)).toBe(0);
    expect(countFormatRejection(dir, a)).toBe(1);
    expect(countFormatRejection(dir, a)).toBe(2);
    expect(formatRejections(dir, a)).toBe(2);
    expect(formatRejections(dir, formatRejectionKey("qa", "reply", "other"))).toBe(0);
  });
  it("reads a corrupt file as 0", () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, "format-rejections.json"), "{not json");
    expect(formatRejections(dir, "k")).toBe(0);
  });
});
