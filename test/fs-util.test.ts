import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cutUtf8, findOnPath, readRegularFileCappedNoFollow, trimPartialUtf8 } from "../src/fs-util.js";

let dir: string;
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("findOnPath", () => {
  it("finds an executable file in a PATH entry", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "lyceum-path-"));
    fs.writeFileSync(path.join(dir, "bwrap"), "#!/bin/sh\n", { mode: 0o755 });
    expect(findOnPath("bwrap", `/nonexistent${path.delimiter}${dir}`)).toBe(true);
  });

  it("ignores a file that is not executable, a missing file and empty PATH entries", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "lyceum-path-"));
    fs.writeFileSync(path.join(dir, "bwrap"), "x", { mode: 0o644 });
    expect(findOnPath("bwrap", dir)).toBe(false);
    expect(findOnPath("nope", `${path.delimiter}${dir}`)).toBe(false);
    expect(findOnPath("bwrap", "")).toBe(false);
  });
});

describe("cutUtf8", () => {
  it("leaves a short buffer alone", () => {
    expect(cutUtf8(Buffer.from("héllo"), 10).toString()).toBe("héllo");
  });

  it("never splits a multi-byte character", () => {
    const b = Buffer.from("a中文b"); // a, 3 bytes, 3 bytes, b
    expect(cutUtf8(b, 2).toString()).toBe("a");
    expect(cutUtf8(b, 3).toString()).toBe("a");
    expect(cutUtf8(b, 4).toString()).toBe("a中");
    expect(cutUtf8(b, 6).toString()).toBe("a中");
    expect(cutUtf8(b, 7).toString()).toBe("a中文");
    expect(cutUtf8(Buffer.from("😀😀"), 5).toString()).toBe("😀");
    for (let i = 0; i <= b.length; i++) expect(cutUtf8(b, i).toString()).not.toContain("\uFFFD");
  });
});

describe("readRegularFileCappedNoFollow", () => {
  it("reads up to the limit and says whether there was more", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "lyceum-cap-"));
    const f = path.join(dir, "f");
    fs.writeFileSync(f, "0123456789");
    const r = readRegularFileCappedNoFollow(f, 4);
    expect(r).toMatchObject({ ok: true, truncated: true, size: 10 });
    if (r.ok) expect(r.buf.toString()).toBe("0123");
    const whole = readRegularFileCappedNoFollow(f, 10);
    expect(whole).toMatchObject({ ok: true, truncated: false, size: 10 });
  });

  it("reports why it refused, from the one open: symlink, not a regular file, missing", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "lyceum-cap-"));
    fs.writeFileSync(path.join(dir, "real"), "x");
    fs.symlinkSync(path.join(dir, "real"), path.join(dir, "link"));
    fs.mkdirSync(path.join(dir, "d"));
    expect(readRegularFileCappedNoFollow(path.join(dir, "link"), 10)).toEqual({ ok: false, reason: "symlink" });
    expect(readRegularFileCappedNoFollow(path.join(dir, "d"), 10)).toEqual({ ok: false, reason: "not_regular" });
    expect(readRegularFileCappedNoFollow(path.join(dir, "nope"), 10)).toEqual({ ok: false, reason: "open_error:ENOENT" });
  });

  it("reads no more than limit + 1 bytes of a huge sparse file", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "lyceum-cap-"));
    const f = path.join(dir, "sparse");
    fs.closeSync(fs.openSync(f, "w"));
    fs.truncateSync(f, 64 * 1024 * 1024);
    const t = Date.now();
    const r = readRegularFileCappedNoFollow(f, 100);
    expect(r).toMatchObject({ ok: true, truncated: true, size: 64 * 1024 * 1024 });
    if (r.ok) expect(r.buf.length).toBe(100);
    expect(Date.now() - t).toBeLessThan(2000);
  });
});

describe("trimPartialUtf8", () => {
  it("drops only an incomplete trailing character", () => {
    for (const ch of ["é", "中", "😀"]) {
      const b = Buffer.from(`a${ch}`);
      for (let n = 1; n <= b.length; n++) {
        const out = trimPartialUtf8(b.subarray(0, n)).toString();
        expect(out).not.toContain("�");
        expect(out).toBe(n === b.length ? `a${ch}` : "a");
      }
    }
    expect(trimPartialUtf8(Buffer.alloc(0)).length).toBe(0);
  });
});
