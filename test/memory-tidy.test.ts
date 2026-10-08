import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fingerprint, listMemoryFiles, memoryStats, restoreDirs, snapshotDirs, STAMP_RE, targetsFor, tidyStamp, verifyConservation } from "../src/memory-tidy.js";
import { makeEnv, makeMemoryEnv, write, type TestEnv } from "./helpers.js";

let env: TestEnv;
afterEach(() => env?.cleanup());

const mem = (e: TestEnv, agent = "lead") => e.project().agents[agent]!.memory.project!;

describe("tidyStamp", () => {
  it("is a sortable UTC stamp that restore can validate", () => {
    const s = tidyStamp(new Date("2026-10-08T03:15:00.123Z"));
    expect(s).toBe("20261008T031500Z");
    expect(STAMP_RE.test(s)).toBe(true);
    expect(STAMP_RE.test("../x")).toBe(false);
  });
});

describe("targetsFor", () => {
  it("defaults to the project memory of every agent and never includes global", () => {
    env = makeMemoryEnv();
    const t = targetsFor(env.project(), { layer: "project" });
    expect(t.map((x) => x.agent)).toEqual(["lead", "fe-member", "qa-member"]);
    expect(t.every((x) => x.layer === "project")).toBe(true);
    expect(t[0]?.dir).toBe(mem(env));
  });

  it("selects one agent, and rejects an unknown one", () => {
    env = makeMemoryEnv();
    expect(targetsFor(env.project(), { layer: "project", agent: "qa-member" }).map((x) => x.agent)).toEqual(["qa-member"]);
    expect(() => targetsFor(env.project(), { layer: "project", agent: "nobody" })).toThrow(/nobody/);
  });

  it("the template alone has global memory only: nothing to tidy in the project layer, and a named agent is an error", () => {
    env = makeEnv();
    expect(targetsFor(env.project(), { layer: "project" })).toEqual([]);
    expect(() => targetsFor(env.project(), { layer: "project", agent: "lead" })).toThrow(/project memory/);
    expect(targetsFor(env.project(), { layer: "global" }).map((x) => x.agent)).toEqual(["lead", "fe-member", "qa-member"]);
  });
});

describe("listMemoryFiles and memoryStats", () => {
  it("lists files recursively with / paths, includes .archive, ignores the state file", () => {
    env = makeMemoryEnv();
    const d = mem(env);
    write(path.join(d, "MEMORY.md"), "- [a](a.md)\n");
    write(path.join(d, "a.md"), "alpha");
    write(path.join(d, "sub/b.md"), "beta");
    write(path.join(d, ".archive/20260101T000000Z/old.md"), "old");
    write(path.join(d, ".tidy-state.json"), "{}");
    expect(listMemoryFiles(d).map((f) => f.rel)).toEqual([".archive/20260101T000000Z/old.md", "MEMORY.md", "a.md", "sub/b.md"]);
    expect(listMemoryFiles(path.join(d, "missing"))).toEqual([]);
  });

  it("counts only live files in the stats", () => {
    env = makeMemoryEnv();
    const d = mem(env);
    write(path.join(d, "MEMORY.md"), "12345");
    write(path.join(d, "a.md"), "123");
    write(path.join(d, ".archive/x/old.md"), "123456789");
    const s = memoryStats(d);
    expect(s).toMatchObject({ files: 2, bytes: 8, indexBytes: 5 });
    expect(s.newest).toBeDefined();
  });
});

describe("snapshot and restore", () => {
  it("puts a directory back exactly as it was, including files added or removed since", () => {
    env = makeMemoryEnv();
    const d = mem(env);
    write(path.join(d, "MEMORY.md"), "index");
    write(path.join(d, "a.md"), "alpha");
    const snap = path.join(env.root, "snap");
    const before = fingerprint(d);
    snapshotDirs([d], snap);
    fs.rmSync(path.join(d, "a.md"));
    write(path.join(d, "new.md"), "x");
    write(path.join(d, "MEMORY.md"), "changed");
    restoreDirs([d], snap);
    expect(fingerprint(d)).toEqual(before);
  });

  it("copes with a directory that did not exist", () => {
    env = makeMemoryEnv();
    const d = path.join(env.root, "ghost");
    const snap = path.join(env.root, "snap");
    snapshotDirs([d], snap);
    write(path.join(d, "created.md"), "x");
    restoreDirs([d], snap);
    expect(fs.existsSync(d)).toBe(false);
  });
});

describe("verifyConservation", () => {
  const setup = () => {
    env = makeMemoryEnv();
    const d = mem(env);
    write(path.join(d, "MEMORY.md"), "idx");
    write(path.join(d, "a.md"), "a");
    write(path.join(d, "b.md"), "b");
    write(path.join(d, ".archive/20250101T000000Z/old.md"), "old");
    return { d, before: listMemoryFiles(d).map((f) => f.rel), stamp: "20261008T031500Z" };
  };

  it("passes when everything is where it was or archived under the same relative path", () => {
    const { d, before, stamp } = setup();
    fs.mkdirSync(path.join(d, ".archive", stamp), { recursive: true });
    fs.renameSync(path.join(d, "b.md"), path.join(d, ".archive", stamp, "b.md"));
    write(path.join(d, "a.md"), "a rewritten");
    expect(verifyConservation(before, d, stamp)).toEqual([]);
  });

  it("fails for a file that vanished", () => {
    const { d, before, stamp } = setup();
    fs.rmSync(path.join(d, "b.md"));
    expect(verifyConservation(before, d, stamp).join("\n")).toMatch(/b\.md/);
  });

  it("fails for a file archived under another path or into another stamp", () => {
    const { d, before, stamp } = setup();
    fs.mkdirSync(path.join(d, ".archive/other"), { recursive: true });
    fs.renameSync(path.join(d, "b.md"), path.join(d, ".archive/other/b.md"));
    expect(verifyConservation(before, d, stamp).join("\n")).toMatch(/b\.md/);
  });

  it("fails when an earlier archive was touched, or MEMORY.md was archived", () => {
    const { d, before, stamp } = setup();
    fs.rmSync(path.join(d, ".archive/20250101T000000Z/old.md"));
    fs.mkdirSync(path.join(d, ".archive", stamp), { recursive: true });
    fs.renameSync(path.join(d, "MEMORY.md"), path.join(d, ".archive", stamp, "MEMORY.md"));
    const problems = verifyConservation(before, d, stamp).join("\n");
    expect(problems).toMatch(/old\.md/);
    expect(problems).toMatch(/MEMORY\.md/);
  });
});
