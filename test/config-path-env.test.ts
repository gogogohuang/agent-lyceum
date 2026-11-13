import path from "node:path";
import os from "node:os";
import { describe, expect, it } from "vitest";
import { configPath, expandEnv } from "../src/paths.js";

describe("config path env expansion", () => {
  const env = { WORK: "/mnt/work", EMPTY: "" } as NodeJS.ProcessEnv;
  it("expands $VAR and ${VAR}", () => {
    expect(expandEnv("$WORK/a", env)).toBe("/mnt/work/a");
    expect(expandEnv("${WORK}/a", env)).toBe("/mnt/work/a");
  });
  it("throws on unset or empty variables", () => {
    expect(() => expandEnv("$NOPE/a", env)).toThrow(/NOPE is not set/);
    expect(() => expandEnv("${EMPTY}/a", env)).toThrow(/EMPTY is not set/);
  });
  it("leaves plain paths alone and still supports ~ and relative", () => {
    expect(expandEnv("/a/b", env)).toBe("/a/b");
    expect(configPath("~/x", "/base", env)).toBe(path.join(os.homedir(), "x"));
    expect(configPath("rel", "/base", env)).toBe("/base/rel");
    expect(configPath("${WORK}/repo", "/base", env)).toBe("/mnt/work/repo");
  });
});
