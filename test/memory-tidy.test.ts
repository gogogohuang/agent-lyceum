import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findMissingPaths, fingerprint, listMemoryFiles, memoryStats, projectChanges, readTidyState, restoreDirs, snapshotDirs, STAMP_RE, targetsFor, tidyStamp, verifyConservation, writeTidyState } from "../src/memory-tidy.js";
import { git, initGitRepo, makeEnv, makeMemoryEnv, write, type TestEnv } from "./helpers.js";

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

describe("tidy state", () => {
  it("round-trips and tolerates a missing or broken file", () => {
    env = makeMemoryEnv();
    const d = mem(env);
    expect(readTidyState(d)).toBeUndefined();
    writeTidyState(d, { head: "abc", at: "2026-10-08T00:00:00Z", archive: "20261008T000000Z" });
    expect(readTidyState(d)).toEqual({ head: "abc", at: "2026-10-08T00:00:00Z", archive: "20261008T000000Z" });
    write(path.join(d, ".tidy-state.json"), "not json");
    expect(readTidyState(d)).toBeUndefined();
  });
});

describe("projectChanges", () => {
  it("says so when the project is not a git repository", () => {
    env = makeMemoryEnv();
    expect(projectChanges(env.repo, undefined)).toMatchObject({ log: [], stat: [], note: expect.stringMatching(/not a git repository/) });
  });

  it("first tidy: only the head, no log", () => {
    env = makeMemoryEnv();
    initGitRepo(env.repo);
    const c = projectChanges(env.repo, undefined);
    expect(c.head).toBe(git(env.repo, "rev-parse", "HEAD"));
    expect(c.log).toEqual([]);
    expect(c.note).toMatch(/first tidy/);
  });

  it("with a baseline: commits and a diff stat since then", () => {
    env = makeMemoryEnv();
    initGitRepo(env.repo);
    const since = git(env.repo, "rev-parse", "HEAD");
    write(path.join(env.repo, "src/new.ts"), "x\n");
    git(env.repo, "add", "-A");
    git(env.repo, "commit", "-q", "-m", "add new");
    const c = projectChanges(env.repo, since);
    expect(c.since).toBe(since);
    expect(c.log.join("\n")).toMatch(/add new/);
    expect(c.stat.join("\n")).toMatch(/src\/new\.ts/);
  });

  it("no commits since the baseline, and a baseline that no longer exists", () => {
    env = makeMemoryEnv();
    initGitRepo(env.repo);
    const head = git(env.repo, "rev-parse", "HEAD");
    expect(projectChanges(env.repo, head).note).toMatch(/no commits/);
    expect(projectChanges(env.repo, "0".repeat(40)).note).toMatch(/no longer|unknown/);
  });
});

describe("findMissingPaths", () => {
  it("flags backticked paths that no longer exist and ignores the ones that do, URLs and bare words", () => {
    env = makeMemoryEnv();
    initGitRepo(env.repo);
    const d = mem(env);
    write(path.join(d, "a.md"), "Entry is `src/web/a.txt` and the old `src/web/gone.ts`; see `https://x.dev/a/b`, `npm test`, `--flag/x`, `*.ts/x`.\nAbsolute: `/definitely/not/here.md`.\n");
    write(path.join(d, ".archive/x/old.md"), "`src/archived-gone.ts`");
    const missing = findMissingPaths(d, env.repo).map((m) => `${m.file}:${m.path}`).sort();
    expect(missing).toEqual(["a.md:/definitely/not/here.md", "a.md:src/web/gone.ts"]);
  });

  it("without a repo (global layer) checks absolute paths only", () => {
    env = makeMemoryEnv();
    const d = mem(env);
    write(path.join(d, "a.md"), "`src/relative.ts` and `/nope/abs.ts`");
    expect(findMissingPaths(d, undefined).map((m) => m.path)).toEqual(["/nope/abs.ts"]);
  });
});
