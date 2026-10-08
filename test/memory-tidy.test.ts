import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findMissingPaths, fingerprint, listMemoryFiles, memoryStats, projectChanges, readTidyState, restoreDirs, snapshotDirs, STAMP_RE, targetsFor, tidyStamp, verifyConservation, tidyMemory, restoreMemory, writeTidyState } from "../src/memory-tidy.js";
import { writePolicy } from "../src/policy.js";
import type { Invoker, WakeResult } from "../src/adapters/index.js";
import { buildTidyPrompts, type TidyContext } from "../src/prompt.js";
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

describe("buildTidyPrompts", () => {
  const ctx = (over: Partial<TidyContext> = {}): TidyContext => ({
    layer: "project",
    dir: "/m/lead",
    archiveDir: "/m/lead/.archive/20261008T031500Z",
    files: [{ rel: "MEMORY.md", bytes: 20, mtime: "2026-09-01T00:00:00.000Z" }, { rel: "a.md", bytes: 5, mtime: "2026-08-01T00:00:00.000Z" }],
    index: "- [a](a.md)\n",
    changes: { head: "h2", since: "h1", log: ["abc123 add feature"], stat: [" src/x.ts | 2 +-"] },
    missing: [{ file: "a.md", path: "src/gone.ts" }],
    ...over,
  });

  it("is a maintenance prompt: no mail protocol, the rules, the archive line, and the facts", () => {
    env = makeMemoryEnv();
    const lead = env.project().agents.lead!;
    const { systemPrompt, userPrompt } = buildTidyPrompts(lead, ctx());
    expect(systemPrompt).toContain("Memory tidy");
    expect(systemPrompt).toContain("tidy-report.md");
    expect(systemPrompt).toMatch(/never delete/i);
    expect(systemPrompt).not.toContain("Sending mail");
    expect(userPrompt).toContain("Archive directory: /m/lead/.archive/20261008T031500Z");
    expect(userPrompt).toContain("- [a](a.md)");
    expect(userPrompt).toContain("abc123 add feature");
    expect(userPrompt).toContain("src/gone.ts");
    expect(userPrompt).toMatch(/a\.md\s+5 B/);
  });

  it("says when there is no baseline or no repo, and omits project changes for the global layer", () => {
    env = makeMemoryEnv();
    const lead = env.project().agents.lead!;
    const first = buildTidyPrompts(lead, ctx({ changes: { head: "h", log: [], stat: [], note: "first tidy: no baseline" } })).userPrompt;
    expect(first).toContain("first tidy: no baseline");
    const global = buildTidyPrompts(lead, ctx({ layer: "global", changes: undefined, missing: [] })).userPrompt;
    expect(global).toMatch(/global/i);
    expect(global).not.toContain("Changes in the project");
  });
});

const OK: WakeResult = { ok: true, text: "", exitCode: 0, timedOut: false };
const archiveOf = (prompt: string) => /^Archive directory: (.+)$/m.exec(prompt)![1]!;

/** An invoker whose "agent" does what `act` says, given the archive folder it was told to use. */
const agent = (act: (archive: string, memoryDir: string) => WakeResult | undefined): { invoker: Invoker; calls: string[] } => {
  const calls: string[] = [];
  const invoker: Invoker = async (input) => {
    const archive = archiveOf(input.userPrompt);
    calls.push(input.agent.name);
    const memoryDir = /^Memory directory: (.+)$/m.exec(input.userPrompt)![1]!;
    return act(archive, memoryDir) ?? OK;
  };
  return { invoker, calls };
};
const report = (archive: string) => write(path.join(archive, "tidy-report.md"), "## Merged\nNone\n\n## Archived\nNone\n\n## Unsure\nNone\n");

function seed(e: TestEnv) {
  const d = mem(e);
  write(path.join(d, "MEMORY.md"), "- [a](a.md)\n- [b](b.md)\n");
  write(path.join(d, "a.md"), "alpha `src/web/a.txt`");
  write(path.join(d, "b.md"), "beta");
  return d;
}
const only = (e: TestEnv, name = "lead") => ({ project: e.project(), layer: "project" as const, agent: name, say: () => {} });

describe("tidyMemory", () => {
  it("archives a file, writes the report and the baseline, and checks conservation", async () => {
    env = makeMemoryEnv();
    initGitRepo(env.repo);
    const d = seed(env);
    const { invoker, calls } = agent((archive) => {
      fs.mkdirSync(archive, { recursive: true });
      fs.renameSync(path.join(d, "b.md"), path.join(archive, "b.md"));
      write(path.join(d, "MEMORY.md"), "- [a](a.md)\n");
      report(archive);
    });
    const res = await tidyMemory({ ...only(env), invoker });
    expect(calls).toEqual(["lead"]);
    expect(res).toHaveLength(1);
    expect(res[0]).toMatchObject({ agent: "lead", layer: "project", status: "tidied", problems: [] });
    expect(fs.existsSync(path.join(d, ".archive", res[0]!.archive!, "b.md"))).toBe(true);
    expect(readTidyState(d)).toMatchObject({ head: git(env.repo, "rev-parse", "HEAD"), archive: res[0]!.archive });
  });

  it("rolls everything back and keeps the old baseline when a file vanished", async () => {
    env = makeMemoryEnv();
    initGitRepo(env.repo);
    const d = seed(env);
    writeTidyState(d, { head: "oldhead", at: "2026-01-01T00:00:00Z" });
    const before = fingerprint(d);
    const { invoker } = agent((archive) => {
      fs.rmSync(path.join(d, "b.md"));
      write(path.join(d, "junk.md"), "new");
      report(archive);
    });
    const res = await tidyMemory({ ...only(env), invoker });
    expect(res[0]?.status).toBe("failed");
    expect(res[0]?.problems.join("\n")).toMatch(/b\.md/);
    expect(fingerprint(d)).toEqual(before);
    expect(readTidyState(d)?.head).toBe("oldhead");
  });

  it("fails and rolls back without a tidy-report.md", async () => {
    env = makeMemoryEnv();
    const d = seed(env);
    const before = fingerprint(d);
    const { invoker } = agent((archive) => {
      fs.mkdirSync(archive, { recursive: true });
      fs.renameSync(path.join(d, "b.md"), path.join(archive, "b.md"));
    });
    const res = await tidyMemory({ ...only(env), invoker });
    expect(res[0]?.status).toBe("failed");
    expect(res[0]?.problems.join("\n")).toMatch(/tidy-report/);
    expect(fingerprint(d)).toEqual(before);
  });

  it("fails and rolls back when the agent changes another memory layer", async () => {
    env = makeMemoryEnv();
    const d = seed(env);
    const globalDir = path.join(env.root, "global-mem");
    env.editProjectYaml((t) => t.replace("memory: { project: agents/lead/memory }", `memory: { project: agents/lead/memory, global: ${globalDir} }`));
    write(path.join(globalDir, "MEMORY.md"), "g");
    const before = { g: fingerprint(globalDir), p: fingerprint(d) };
    const { invoker } = agent((archive) => {
      write(path.join(globalDir, "sneaky.md"), "x");
      report(archive);
    });
    const res = await tidyMemory({ ...only(env), invoker });
    expect(res[0]?.status).toBe("failed");
    expect(res[0]?.problems.join("\n")).toMatch(/global/);
    expect({ g: fingerprint(globalDir), p: fingerprint(d) }).toEqual(before);
  });

  it("rolls back when the wake-up fails or times out", async () => {
    env = makeMemoryEnv();
    const d = seed(env);
    const before = fingerprint(d);
    const { invoker } = agent((archive) => {
      write(path.join(d, "a.md"), "half done");
      report(archive);
      return { ok: false, text: "", exitCode: null, timedOut: true, error: "timed out" };
    });
    const res = await tidyMemory({ ...only(env), invoker });
    expect(res[0]?.status).toBe("failed");
    expect(res[0]?.problems.join("\n")).toMatch(/timed out/);
    expect(fingerprint(d)).toEqual(before);
  });

  it("--dry-run wakes nobody and changes nothing", async () => {
    env = makeMemoryEnv();
    initGitRepo(env.repo);
    const d = seed(env);
    const before = fingerprint(d);
    const lines: string[] = [];
    const { invoker, calls } = agent(() => {
      throw new Error("must not be woken");
    });
    const res = await tidyMemory({ ...only(env), invoker, dryRun: true, say: (l) => lines.push(l) });
    expect(calls).toEqual([]);
    expect(res[0]?.status).toBe("dry-run");
    expect(fingerprint(d)).toEqual(before);
    expect(fs.existsSync(path.join(d, ".tidy-state.json"))).toBe(false);
    expect(lines.join("\n")).toMatch(/lead/);
    expect(lines.join("\n")).toMatch(/3 file/);
  });

  it("skips an agent with no memory without waking it", async () => {
    env = makeMemoryEnv();
    const { invoker, calls } = agent(() => {});
    const res = await tidyMemory({ project: env.project(), layer: "project", invoker, say: () => {} });
    expect(calls).toEqual([]);
    expect(res.every((r) => r.status === "skipped")).toBe(true);
  });

  it("tidies project memory by default and global only when asked", async () => {
    env = makeMemoryEnv();
    const d = seed(env);
    const globalDir = path.join(env.root, "global-mem");
    env.editProjectYaml((t) => t.replace("memory: { project: agents/lead/memory }", `memory: { project: agents/lead/memory, global: ${globalDir} }`));
    write(path.join(globalDir, "MEMORY.md"), "g");
    const seen: string[] = [];
    const { invoker } = agent((archive, memoryDir) => {
      seen.push(memoryDir);
      report(archive);
    });
    await tidyMemory({ project: env.project(), layer: "project", agent: "lead", invoker, say: () => {} });
    expect(seen).toEqual([d]);
    await tidyMemory({ project: env.project(), layer: "global", agent: "lead", invoker, say: () => {} });
    expect(seen).toEqual([d, globalDir]);
    expect(readTidyState(globalDir)?.head).toBeUndefined();
  });

  it("is never started by a run: a normal run wakes only for tasks", async () => {
    env = makeMemoryEnv();
    const d = seed(env);
    write(path.join(d, "big.md"), "x".repeat(50_000));
    const woken: string[] = [];
    const invoker: Invoker = async (input) => {
      woken.push(input.userPrompt.includes("Archive directory:") ? "tidy" : "task");
      return OK;
    };
    const { runTeam } = await import("../src/dispatcher.js");
    const { prepareTask } = await import("../src/task.js");
    const runDir = path.join(env.project().paths.runs, "run-x");
    await runTeam({ project: env.project(), task: prepareTask({ text: "t", cwd: env.root, runDir }), runDir, invoker, log: () => {} });
    expect(woken).not.toContain("tidy");
  });
});

describe("the write policy covers the tidy files", () => {
  it("lets an agent write .archive and .tidy-state.json inside its memory dir and nowhere else new", () => {
    env = makeMemoryEnv();
    const p = env.project();
    const lead = p.agents.lead!;
    const pol = writePolicy(p, lead);
    expect(pol.allowDirs).toContain(lead.memory.project);
    for (const d of pol.deny) expect(path.join(lead.memory.project!, ".archive").startsWith(d + path.sep) || path.join(lead.memory.project!, ".archive") === d).toBe(false);
    expect(pol.deny).toContain(p.agents["fe-member"]!.memory.project);
  });
});

describe("restoreMemory", () => {
  const archived = (e: TestEnv) => {
    const d = mem(e);
    write(path.join(d, "MEMORY.md"), "- [a](a.md)\n");
    write(path.join(d, "a.md"), "alpha");
    const stamp = "20261008T031500Z";
    write(path.join(d, ".archive", stamp, "b.md"), "---\nname: Beta notes\n---\nbeta");
    write(path.join(d, ".archive", stamp, "sub/c.md"), "# Gamma heading\ngamma");
    write(path.join(d, ".archive", stamp, "tidy-report.md"), "## Archived\nb, c");
    return { d, stamp };
  };

  it("moves the files back to their paths and adds index lines for the ones the index does not mention", () => {
    env = makeMemoryEnv();
    const { d, stamp } = archived(env);
    const r = restoreMemory({ project: env.project(), agent: "lead", layer: "project", stamp });
    expect(r.restored.sort()).toEqual(["b.md", "sub/c.md"]);
    expect(r.skipped).toEqual([]);
    expect(fs.readFileSync(path.join(d, "b.md"), "utf8")).toContain("beta");
    expect(fs.existsSync(path.join(d, "sub/c.md"))).toBe(true);
    const idx = fs.readFileSync(path.join(d, "MEMORY.md"), "utf8");
    expect(idx).toContain("- [a](a.md)");
    expect(idx).toContain("[Beta notes](b.md)");
    expect(idx).toContain("[Gamma heading](sub/c.md)");
    expect(fs.existsSync(path.join(d, ".archive", stamp, "tidy-report.md"))).toBe(true);
    expect(fs.existsSync(path.join(d, ".archive", stamp, "b.md"))).toBe(false);
  });

  it("never overwrites a file that exists now", () => {
    env = makeMemoryEnv();
    const { d, stamp } = archived(env);
    write(path.join(d, "b.md"), "newer content");
    const r = restoreMemory({ project: env.project(), agent: "lead", layer: "project", stamp });
    expect(r.restored).toEqual(["sub/c.md"]);
    expect(r.skipped.map((s) => s.rel)).toEqual(["b.md"]);
    expect(fs.readFileSync(path.join(d, "b.md"), "utf8")).toBe("newer content");
    expect(fs.existsSync(path.join(d, ".archive", stamp, "b.md"))).toBe(true); // still safe in the archive
  });

  it("rejects a malformed stamp and an unknown archive", () => {
    env = makeMemoryEnv();
    archived(env);
    expect(() => restoreMemory({ project: env.project(), agent: "lead", layer: "project", stamp: "../x" })).toThrow(/stamp/i);
    expect(() => restoreMemory({ project: env.project(), agent: "lead", layer: "project", stamp: "20200101T000000Z" })).toThrow(/no archive/i);
  });

  it("recovers what a tidy archived (tidy then restore)", async () => {
    env = makeMemoryEnv();
    const d = seed(env);
    const before = fs.readFileSync(path.join(d, "b.md"), "utf8");
    const { invoker } = agent((archive) => {
      fs.mkdirSync(archive, { recursive: true });
      fs.renameSync(path.join(d, "b.md"), path.join(archive, "b.md"));
      write(path.join(d, "MEMORY.md"), "- [a](a.md)\n");
      report(archive);
    });
    const [res] = await tidyMemory({ ...only(env), invoker });
    expect(fs.existsSync(path.join(d, "b.md"))).toBe(false);
    restoreMemory({ project: env.project(), agent: "lead", layer: "project", stamp: res!.archive! });
    expect(fs.readFileSync(path.join(d, "b.md"), "utf8")).toBe(before);
    expect(fs.readFileSync(path.join(d, "MEMORY.md"), "utf8")).toMatch(/b\.md/);
  });
});
