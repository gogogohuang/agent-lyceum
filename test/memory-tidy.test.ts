import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findMissingPaths, fingerprint, listMemoryFiles, memoryStats, projectChanges, readTidyState, restoreDirs, snapshotDirs, STAMP_RE, targetsFor, tidyStamp, verifyConservation, tidyAdvice, tidyMemory, restoreMemory, writeTidyState } from "../src/memory-tidy.js";
import { recordsDir, writePolicy } from "../src/policy.js";
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

describe("tidyAdvice for records", () => {
  const big = (id: string, status = "active", extra = "") => `---\nstatus: ${status}\ndate: 2026-01-02\ntitle: ${id}\n${extra}---\n${"x".repeat(4000)}\n`;

  it("hints at the lead only when a kind's effective-active size is over the budget; superseded entries do not count", () => {
    env = makeEnv();
    const rd = recordsDir(env.project());
    write(path.join(rd, "decisions", "d-a.md"), big("d-a"));
    expect(tidyAdvice(env.project())).toEqual([]);
    write(path.join(rd, "decisions", "d-b.md"), big("d-b"));
    const a = tidyAdvice(env.project());
    expect(a).toHaveLength(1);
    expect(a[0]?.agent).toBe(env.project().lead);
    expect(a[0]?.reason).toMatch(/decisions.*6144/);
    write(path.join(rd, "decisions", "d-b.md"), big("d-b", "superseded"));
    expect(tidyAdvice(env.project())).toEqual([]);
    write(path.join(rd, "decisions", "d-b.md"), big("d-b", "active", "supersedes: [d-a]\n"));
    expect(tidyAdvice(env.project())).toEqual([]);
  });
});

describe("tidy --dry-run and the records", () => {
  const rec = (status = "active") => `---\nstatus: ${status}\ndate: 2026-01-02\ntitle: t\n---\nbody\n`;
  const seedRec = (e: TestEnv) => {
    const rd = recordsDir(e.project());
    write(path.join(rd, "decisions", "d-a.md"), rec());
    write(path.join(rd, "decisions", "d-b.md"), rec("superseded"));
    write(path.join(rd, "lessons", "l-a.md"), rec());
    return rd;
  };
  const dry = async (e: TestEnv, o: { layer: "project" | "global"; agent?: string }) => {
    const lines: string[] = [];
    const res = await tidyMemory({ project: e.project(), ...o, dryRun: true, say: (l) => lines.push(l) });
    return { lines, res };
  };

  it("prints one records line for the default project layer and for --agent <lead>, once", async () => {
    env = makeMemoryEnv();
    const rd = seedRec(env);
    for (const agent of [undefined, "lead"]) {
      const { lines } = await dry(env, { layer: "project", agent });
      const r = lines.filter((l) => l.startsWith("records "));
      expect(r).toHaveLength(1);
      expect(r[0]).toContain(rd);
      expect(r[0]).toMatch(/3 file\(s\).*active: decisions 1, lessons 1/);
    }
  });

  it("prints no records line for another agent or the global layer", async () => {
    env = makeMemoryEnv();
    seedRec(env);
    expect((await dry(env, { layer: "project", agent: "qa-member" })).lines.join("\n")).not.toContain("records ");
    expect((await dry(env, { layer: "global" })).lines.join("\n")).not.toContain("records ");
  });

  it("works for a lead with records but no memory dir", async () => {
    env = makeMemoryEnv();
    seedRec(env);
    fs.rmSync(mem(env), { recursive: true, force: true });
    const { lines, res } = await dry(env, { layer: "project", agent: "lead" });
    expect(lines.filter((l) => l.startsWith("records "))).toHaveLength(1);
    expect(res).toHaveLength(1);
    expect(res[0]).toMatchObject({ agent: "lead", status: "dry-run" });
  });

  it("prints no records line when there are no records", async () => {
    env = makeMemoryEnv();
    expect((await dry(env, { layer: "project" })).lines.join("\n")).not.toContain("records ");
  });
});

describe("tidyAdvice", () => {
  it("is silent for small memory", () => {
    env = makeMemoryEnv();
    seed(env);
    expect(tidyAdvice(env.project())).toEqual([]);
  });

  it("suggests a tidy when MEMORY.md is bigger than what the agent is shown", () => {
    env = makeMemoryEnv();
    const d = seed(env);
    write(path.join(d, "MEMORY.md"), "- entry\n".repeat(800));
    const a = tidyAdvice(env.project());
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ agent: "lead" });
    expect(a[0]?.reason).toMatch(/MEMORY\.md/);
  });

  it("suggests a tidy when the project moved far past the last baseline", { timeout: 30_000 }, () => {
    env = makeMemoryEnv();
    initGitRepo(env.repo);
    const d = seed(env);
    writeTidyState(d, { head: git(env.repo, "rev-parse", "HEAD"), at: "2026-01-01T00:00:00Z" });
    for (let i = 0; i < 51; i++) {
      write(path.join(env.repo, `f${i}.txt`), String(i));
      git(env.repo, "add", "-A");
      git(env.repo, "commit", "-q", "-m", `c${i}`);
    }
    expect(tidyAdvice(env.project()).map((x) => x.agent)).toEqual(["lead"]);
    expect(tidyAdvice(env.project())[0]?.reason).toMatch(/51 commits/);
  });
});

describe("tidy of the project records (the lead's wake-up)", () => {
  const rec = (id: string, extra = "") => `---\nstatus: active\ndate: 2026-01-0${id.length % 9 + 1}\ntitle: ${id} title\n${extra}---\nbody of ${id}\n`;
  const seedRecords = (e: TestEnv) => {
    const dir = recordsDir(e.project());
    write(path.join(dir, "decisions", "d-one.md"), rec("d-one"));
    write(path.join(dir, "decisions", "d-two.md"), rec("d-two"));
    write(path.join(dir, "lessons", "l-one.md"), rec("l-one"));
    return dir;
  };
  const promptsOf = () => {
    const prompts: Record<string, string> = {};
    const invoker: Invoker = async (input) => {
      prompts[input.agent.name] = input.userPrompt;
      return OK;
    };
    return { prompts, invoker };
  };
  const merge = (rd: string, stamp: string) => {
    write(path.join(rd, "decisions", "d-merged.md"), rec("d-merged", "supersedes: [d-one, d-two]\n"));
    for (const id of ["d-one", "d-two"]) {
      fs.mkdirSync(path.join(rd, ".archive", stamp, "decisions"), { recursive: true });
      fs.renameSync(path.join(rd, "decisions", `${id}.md`), path.join(rd, ".archive", stamp, "decisions", `${id}.md`));
    }
    write(path.join(rd, ".archive", stamp, "tidy-report.md"), "## Merged\nx\n\n## Archived\nx\n\n## Unsure\nNone\n");
  };
  const recStamp = (prompt: string) => /^Records archive directory: .*\/\.archive\/(.+)$/m.exec(prompt)![1]!;

  it("puts a records section in the lead's prompt only; memory prompt is unchanged for the lead's memory", async () => {
    env = makeMemoryEnv();
    seed(env);
    seedRecords(env);
    const { prompts, invoker } = promptsOf();
    // The fake does nothing, so the tidy fails on the missing reports; the prompts are what is checked.
    await tidyMemory({ project: env.project(), layer: "project", invoker, say: () => {} });
    expect(prompts.lead).toContain("# Project records");
    expect(prompts.lead).toMatch(/decisions\/d-one\.md\s+active\s+2026-01-\d\d\s+\d+ B\s+d-one title/);
    expect(prompts.lead).toContain("Memory directory:");
    for (const [name, p] of Object.entries(prompts)) if (name !== "lead") expect(p).not.toContain("# Project records");
  });

  it("does not include records with --agent <other> or --layer global", async () => {
    env = makeMemoryEnv();
    seed(env);
    seedRecords(env);
    const names = Object.keys(env.project().agents).filter((n) => n !== "lead");
    const other = names.find((n) => env.project().agents[n]!.memory.project);
    const { prompts, invoker } = promptsOf();
    if (other) {
      write(path.join(mem(env, other), "MEMORY.md"), "- [a](a.md)\n");
      write(path.join(mem(env, other), "a.md"), "x");
      await tidyMemory({ project: env.project(), layer: "project", agent: other, invoker, say: () => {} });
      expect(prompts[other]).not.toContain("# Project records");
    }
    const g = promptsOf();
    await tidyMemory({ project: env.project(), layer: "global", agent: "lead", invoker: g.invoker, say: () => {} });
    expect(g.prompts.lead ?? "").not.toContain("# Project records");
  });

  it("tidies the lead with only records (no memory dir), and not at all when neither exists", async () => {
    env = makeMemoryEnv();
    const { prompts, invoker } = promptsOf();
    await tidyMemory({ project: env.project(), layer: "project", agent: "lead", invoker, say: () => {} }).catch(() => undefined);
    expect(prompts.lead).toBeUndefined();
    seedRecords(env);
    fs.rmSync(mem(env), { recursive: true, force: true });
    const res = await tidyMemory({ project: env.project(), layer: "project", invoker, say: () => {} });
    expect(prompts.lead).toContain("# Project records");
    expect(prompts.lead).not.toContain("Memory directory:");
    expect(res.find((r) => r.agent === "lead")?.status).toBe("failed"); // fake wrote no report
  });

  it("merges two entries: one stamp for both archives, conservation holds", async () => {
    env = makeMemoryEnv();
    const d = seed(env);
    const rd = seedRecords(env);
    const invoker: Invoker = async (input) => {
      const stamp = recStamp(input.userPrompt);
      expect(archiveOf(input.userPrompt)).toMatch(new RegExp(`\\.archive/${stamp}$`));
      if (input.agent.name === "lead") {
        merge(rd, stamp);
        report(archiveOf(input.userPrompt));
      }
      return OK;
    };
    const res = await tidyMemory({ project: env.project(), layer: "project", agent: "lead", invoker, say: () => {} });
    expect(res[0]).toMatchObject({ status: "tidied", problems: [], recordsDir: rd });
    const stamp = res[0]!.archive!;
    expect(fs.existsSync(path.join(rd, ".archive", stamp, "decisions", "d-one.md"))).toBe(true);
    expect(fs.existsSync(path.join(rd, "decisions", "d-merged.md"))).toBe(true);
    expect(fs.existsSync(path.join(d, ".archive", stamp, "tidy-report.md"))).toBe(true);
  });

  it("rolls both dirs back when a record is deleted", async () => {
    env = makeMemoryEnv();
    const d = seed(env);
    const rd = seedRecords(env);
    const before = { d: fingerprint(d), r: fingerprint(rd) };
    const invoker: Invoker = async (input) => {
      fs.rmSync(path.join(rd, "decisions", "d-one.md"));
      write(path.join(d, "junk.md"), "x");
      report(archiveOf(input.userPrompt));
      write(path.join(rd, ".archive", recStamp(input.userPrompt), "tidy-report.md"), "## Merged\nNone\n");
      return OK;
    };
    const res = await tidyMemory({ project: env.project(), layer: "project", agent: "lead", invoker, say: () => {} });
    expect(res[0]?.status).toBe("failed");
    expect(res[0]?.problems.join("\n")).toMatch(/d-one\.md/);
    expect({ d: fingerprint(d), r: fingerprint(rd) }).toEqual(before);
  });

  it("rolls both dirs back when the agent writes outside the two dirs", async () => {
    env = makeMemoryEnv();
    const d = seed(env);
    const rd = seedRecords(env);
    const common = path.join(rd, "..", "COMMON.md");
    write(common, "orig");
    const before = { d: fingerprint(d), r: fingerprint(rd) };
    const invoker: Invoker = async (input) => {
      merge(rd, recStamp(input.userPrompt));
      report(archiveOf(input.userPrompt));
      write(common, "changed");
      return OK;
    };
    const res = await tidyMemory({ project: env.project(), layer: "project", agent: "lead", invoker, say: () => {} });
    expect(res[0]?.status).toBe("failed");
    expect(res[0]?.problems.join("\n")).toMatch(/COMMON\.md/);
    expect({ d: fingerprint(d), r: fingerprint(rd) }).toEqual(before);
    expect(fs.readFileSync(common, "utf8")).toBe("orig");
  });

  describe("undo", () => {
    const stamp = "20261008T031500Z";
    it("restores both archives without overwriting", () => {
      env = makeMemoryEnv();
      const d = seed(env);
      const rd = seedRecords(env);
      write(path.join(d, ".archive", stamp, "c.md"), "gamma");
      write(path.join(rd, ".archive", stamp, "decisions", "d-old.md"), rec("d-old"));
      write(path.join(rd, ".archive", stamp, "decisions", "d-one.md"), "older");
      const r = restoreMemory({ project: env.project(), agent: "lead", layer: "project", stamp });
      expect(r.restored).toEqual(["c.md"]);
      expect(r.records?.restored).toEqual(["decisions/d-old.md"]);
      expect(r.records?.skipped.map((s) => s.rel)).toEqual(["decisions/d-one.md"]);
      expect(fs.readFileSync(path.join(rd, "decisions", "d-one.md"), "utf8")).toContain("d-one title");
    });
    it("works with only a records archive, or only a memory archive", () => {
      env = makeMemoryEnv();
      const d = seed(env);
      const rd = seedRecords(env);
      write(path.join(rd, ".archive", stamp, "lessons", "l-old.md"), rec("l-old"));
      const onlyRec = restoreMemory({ project: env.project(), agent: "lead", layer: "project", stamp });
      expect(onlyRec.restored).toEqual([]);
      expect(onlyRec.records?.restored).toEqual(["lessons/l-old.md"]);
      const stamp2 = "20261009T031500Z";
      write(path.join(d, ".archive", stamp2, "c.md"), "gamma");
      const onlyMem = restoreMemory({ project: env.project(), agent: "lead", layer: "project", stamp: stamp2 });
      expect(onlyMem.restored).toEqual(["c.md"]);
      expect(onlyMem.records).toBeUndefined();
      expect(() => restoreMemory({ project: env.project(), agent: "lead", layer: "project", stamp: "20200101T000000Z" })).toThrow(/no archive/i);
    });
  });
});

describe("tidy hardening (review of T3a)", () => {
  const rec = (id: string) => `---\nstatus: active\ndate: 2026-01-01\ntitle: ${id} title\n---\nbody of ${id}\n`;
  const OLD = "20260101T000000Z";
  const seedAll = (e: TestEnv) => {
    const d = seed(e);
    const rd = recordsDir(e.project());
    write(path.join(rd, "decisions", "d-one.md"), rec("d-one"));
    write(path.join(d, ".archive", OLD, "old.md"), "old memory");
    write(path.join(rd, ".archive", OLD, "decisions", "old.md"), rec("old"));
    return { d, rd };
  };
  const recStampOf = (prompt: string) => /^Records archive directory: .*\/\.archive\/(.+)$/m.exec(prompt)![1]!;
  const finish = (input: { userPrompt: string }, rd?: string) => {
    report(archiveOf(input.userPrompt));
    if (rd) write(path.join(rd, ".archive", recStampOf(input.userPrompt), "tidy-report.md"), "## Merged\nNone\n\n## Archived\nNone\n\n## Unsure\nNone\n");
  };
  const lead = (e: TestEnv) => ({ project: e.project(), layer: "project" as const, agent: "lead", say: () => {} });

  for (const [what, tamper] of [
    ["overwrites a file in", (dir: string, rel: string) => write(path.join(dir, ".archive", OLD, rel), "overwritten")],
    ["adds a file to", (dir: string) => write(path.join(dir, ".archive", OLD, "extra.md"), "new")],
    ["deletes a file from", (dir: string, rel: string) => fs.rmSync(path.join(dir, ".archive", OLD, rel))],
    ["replaces a file by a directory in", (dir: string, rel: string) => { fs.rmSync(path.join(dir, ".archive", OLD, rel)); fs.mkdirSync(path.join(dir, ".archive", OLD, rel)); }],
  ] as const)
    it(`rolls both trees back when the agent ${what} an earlier archive (memory and records)`, async () => {
      for (const target of ["memory", "records"] as const) {
        env = makeMemoryEnv();
        const { d, rd } = seedAll(env);
        const before = { d: fingerprint(d), r: fingerprint(rd) };
        const invoker: Invoker = async (input) => {
          finish(input, rd);
          if (target === "memory") tamper(d, "old.md");
          else tamper(rd, "decisions/old.md");
          return OK;
        };
        const res = await tidyMemory({ ...lead(env), invoker });
        expect(res[0]?.status).toBe("failed");
        expect(res[0]?.problems.join("\n")).toMatch(/earlier archive|\.archive\/20260101/);
        expect({ d: fingerprint(d), r: fingerprint(rd) }).toEqual(before);
        env.cleanup();
      }
    });

  it("leaves earlier archives alone in a good tidy", async () => {
    env = makeMemoryEnv();
    const { d, rd } = seedAll(env);
    const invoker: Invoker = async (input) => {
      finish(input, rd);
      return OK;
    };
    const res = await tidyMemory({ ...lead(env), invoker });
    expect(res[0]?.status).toBe("tidied");
    expect(fs.readFileSync(path.join(d, ".archive", OLD, "old.md"), "utf8")).toBe("old memory");
  });

  it("an exception during validation (tidy-report.md is a directory) rolls back and fails with the message", async () => {
    env = makeMemoryEnv();
    const { d, rd } = seedAll(env);
    const before = { d: fingerprint(d), r: fingerprint(rd) };
    const invoker: Invoker = async (input) => {
      fs.mkdirSync(path.join(archiveOf(input.userPrompt), "tidy-report.md"), { recursive: true });
      write(path.join(d, "junk.md"), "x");
      return OK;
    };
    const res = await tidyMemory({ ...lead(env), invoker });
    expect(res[0]?.status).toBe("failed");
    expect(res[0]?.problems.join("\n")).toMatch(/EISDIR|directory|tidy-report/i);
    expect({ d: fingerprint(d), r: fingerprint(rd) }).toEqual(before);
  });

  it("an exception while finalizing (the state file cannot be written) rolls both trees back", async () => {
    env = makeMemoryEnv();
    const { d, rd } = seedAll(env);
    const before = { d: fingerprint(d), r: fingerprint(rd) };
    const invoker: Invoker = async (input) => {
      finish(input, rd);
      fs.mkdirSync(path.join(d, ".tidy-state.json")); // writeTidyState renames a file over this
      return OK;
    };
    const res = await tidyMemory({ ...lead(env), invoker });
    expect(res[0]?.status).toBe("failed");
    expect(res[0]?.problems.join("\n")).toMatch(/tidy-state|EISDIR|ENOTDIR|rename/i);
    expect({ d: fingerprint(d), r: fingerprint(rd) }).toEqual(before);
    expect(fs.existsSync(path.join(d, ".tidy-state.json"))).toBe(false);
  });

  it("passes the runtime a policy that may write only the dirs being tidied", async () => {
    env = makeMemoryEnv();
    const { d, rd } = seedAll(env);
    const seen: Record<string, import("../src/policy.js").WritePolicy | undefined> = {};
    const invoker: Invoker = async (input) => {
      seen[input.agent.name] = input.policy;
      finish(input, input.agent.name === "lead" ? rd : undefined);
      return OK;
    };
    write(path.join(mem(env, "fe-member"), "MEMORY.md"), "- [a](a.md)\n");
    write(path.join(mem(env, "fe-member"), "a.md"), "x");
    await tidyMemory({ project: env.project(), layer: "project", invoker, say: () => {} });
    expect(seen.lead?.allowDirs.sort()).toEqual([d, rd].sort());
    expect(seen.lead?.allowFiles).toEqual([]);
    expect(seen["fe-member"]?.allowDirs).toEqual([mem(env, "fe-member")]);
    expect(seen["fe-member"]?.allowFiles).toEqual([]);
    // reading stays as before: the repo is readable, the outbox and shared dirs are not writable
    expect(seen.lead?.readDirs).toContain(env.project().dir);
    expect(seen.lead?.deny).toEqual(expect.arrayContaining(writePolicy(env.project(), env.project().agents.lead!).deny));
  });

  it("uses one stamp for every agent of a tidy, whatever the clock does", async () => {
    env = makeMemoryEnv();
    seed(env);
    write(path.join(mem(env, "fe-member"), "MEMORY.md"), "- [a](a.md)\n");
    write(path.join(mem(env, "fe-member"), "a.md"), "x");
    let t = Date.parse("2026-10-08T03:15:00Z");
    const now = () => {
      t += 5000;
      return new Date(t);
    };
    const invoker: Invoker = async (input) => {
      report(archiveOf(input.userPrompt));
      return OK;
    };
    const res = await tidyMemory({ project: env.project(), layer: "project", invoker, now, say: () => {} });
    const stamps = res.filter((r) => r.status === "tidied").map((r) => r.archive);
    expect(stamps.length).toBeGreaterThanOrEqual(2);
    expect(new Set(stamps).size).toBe(1);
  });

  it("a failed result of the lead names the records dir when records took part", async () => {
    env = makeMemoryEnv();
    const { rd } = seedAll(env);
    const res = await tidyMemory({ ...lead(env), invoker: async () => OK });
    expect(res[0]).toMatchObject({ status: "failed", recordsDir: rd });
    fs.rmSync(path.join(rd, "decisions"), { recursive: true });
    fs.rmSync(path.join(rd, ".archive"), { recursive: true });
    const noRec = await tidyMemory({ ...lead(env), invoker: async () => OK });
    expect(noRec[0]?.recordsDir).toBeUndefined();
  });

  it("the memory-only tidy prompt of the lead is unchanged from before records existed (901ec87)", () => {
    env = makeMemoryEnv();
    const fx = JSON.parse(fs.readFileSync(new URL("./fixtures/tidy-prompt-memory-only.json", import.meta.url), "utf8")) as { system: string; user: string };
    const agentMd = path.join(env.root, "persona.md");
    fs.writeFileSync(agentMd, "PERSONA");
    const a = { ...env.project().agents.lead!, name: "lead", agentMd };
    const p = buildTidyPrompts(a, {
      layer: "project",
      dir: "/m/lead",
      archiveDir: "/m/lead/.archive/20261008T031500Z",
      files: [{ rel: "MEMORY.md", bytes: 20, mtime: "2026-09-01T00:00:00.000Z" }, { rel: "a.md", bytes: 5, mtime: "2026-08-01T00:00:00.000Z" }],
      index: "- [a](a.md)\n",
      changes: { head: "h2", since: "h1", log: ["abc123 add feature"], stat: [" src/x.ts | 2 +-"] },
      missing: [{ file: "a.md", path: "src/gone.ts" }],
    });
    expect(p.systemPrompt.slice(p.systemPrompt.indexOf("# Memory tidy"))).toBe(fx.system);
    expect(p.userPrompt).toBe(fx.user);
  });
});
