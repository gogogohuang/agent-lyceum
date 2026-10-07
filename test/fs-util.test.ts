import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findOnPath } from "../src/fs-util.js";

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
