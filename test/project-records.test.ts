import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { recordsDir, recordsKindDir, writePolicy } from "../src/policy.js";
import { CONTEXT_LIMIT, buildSystemPrompt, buildUserPrompt } from "../src/prompt.js";
import { activeRecordsBytes, buildRecordsView, listRecords } from "../src/records.js";
import { makeEnv, write, type TestEnv } from "./helpers.js";

const hasMkfifo = spawnSync("mkfifo", ["--help"]).error === undefined;
let env: TestEnv;
afterEach(() => env?.cleanup());

function entry(p: ReturnType<TestEnv["project"]>, kind: "decisions" | "lessons", id: string, fm: Record<string, string>, body = "because") {
  const head = Object.entries(fm).map(([k, v]) => `${k}: ${v}`).join("\n");
  write(path.join(recordsKindDir(p, kind), `${id}.md`), `---\n${head}\n---\n${body}\n`);
}
const ok = (title: string, date = "2026-01-02", extra: Record<string, string> = {}) => ({ status: "active", date, title, ...extra });

describe("project records", () => {
  it("lists valid entries with their fields", () => {
    env = makeEnv();
    const p = env.project();
    entry(p, "decisions", "use-sqlite", ok("Use sqlite", "2026-01-02", { run: "r1", supersedes: "[old-db]" }), "no server to run");
    const [r] = listRecords(p, "decisions");
    expect(r).toMatchObject({ id: "use-sqlite", status: "active", date: "2026-01-02", run: "r1", supersedes: ["old-db"], title: "Use sqlite", body: "no server to run" });
    expect(r!.invalid).toBeUndefined();
    expect(listRecords(p, "lessons")).toEqual([]); // missing dir
  });

  it("lists invalid or frontmatter-less entries as active with the file name as title, without throwing", () => {
    env = makeEnv();
    const p = env.project();
    write(path.join(recordsKindDir(p, "lessons"), "plain.md"), "just text\n");
    write(path.join(recordsKindDir(p, "lessons"), "badyaml.md"), "---\n: : [\n---\nx\n");
    entry(p, "lessons", "nodate", { status: "active", title: "T" });
    const rs = listRecords(p, "lessons");
    expect(rs.map((r) => r.id).sort()).toEqual(["badyaml", "nodate", "plain"]);
    for (const r of rs) {
      expect(r.invalid).toBeTruthy();
      expect(r.status).toBe("active");
      expect(r.title).toBe(`${r.id}.md`);
    }
    expect(() => buildUserPrompt(p, p.agents.lead, [])).not.toThrow();
  });

  it("shows only effective-active entries, newest first by date then id", () => {
    env = makeEnv();
    const p = env.project();
    entry(p, "decisions", "a-old", ok("Old", "2026-01-01"));
    entry(p, "decisions", "b-new", ok("New", "2026-03-01"));
    entry(p, "decisions", "c-same", ok("SameDayC", "2026-03-01"));
    entry(p, "decisions", "d-gone", { status: "superseded", date: "2026-04-01", title: "Gone" });
    entry(p, "decisions", "e-repl", ok("Replacer", "2026-02-01", { supersedes: "[a-old]" }));
    const view = buildRecordsView(p, "decisions", 10_000)!;
    expect(view).not.toContain("Gone");
    expect(view).not.toContain("[a-old]");
    expect(view.indexOf("[c-same]")).toBeLessThan(view.indexOf("[b-new]"));
    expect(view.indexOf("[b-new]")).toBeLessThan(view.indexOf("[e-repl]"));
  });

  it("packs whole entries and lists the overflow one line each", () => {
    env = makeEnv();
    const p = env.project();
    entry(p, "lessons", "l1", ok("First", "2026-01-03"), "x".repeat(300));
    entry(p, "lessons", "l2", ok("Second", "2026-01-02"), "y".repeat(300));
    entry(p, "lessons", "l3", ok("Third", "2026-01-01"), "z".repeat(300));
    const view = buildRecordsView(p, "lessons", 400)!;
    expect(view).toContain("x".repeat(300));
    expect(view).not.toContain("y".repeat(300));
    expect(view).not.toContain("z".repeat(300));
    expect(view).toContain(`- [l2] Second (read: ${path.join(recordsKindDir(p, "lessons"), "l2.md")})`);
    expect(view).toContain("- [l3] Third (read:");
    expect(activeRecordsBytes(p, "lessons")).toBeGreaterThan(900);
  });

  it("returns undefined and adds no heading when nothing is recorded", () => {
    env = makeEnv();
    const p = env.project();
    expect(buildRecordsView(p, "decisions", CONTEXT_LIMIT)).toBeUndefined();
    const prompt = buildUserPrompt(p, p.agents["fe-member"], []);
    expect(prompt).not.toContain("# Project decisions");
    expect(prompt).not.toContain("# Project lessons");
  });

  it("injects both kinds into the prompt, but never .archive/", () => {
    env = makeEnv();
    const p = env.project();
    entry(p, "decisions", "d1", ok("Use sqlite"), "no server to run");
    entry(p, "lessons", "l1", ok("Build first"), "run the build before the tests");
    write(path.join(recordsDir(p), ".archive", "decisions", "old.md"), "---\nstatus: active\ndate: 2025-01-01\ntitle: Archived\n---\nARCHIVED-BODY\n");
    const prompt = buildUserPrompt(p, p.agents["fe-member"], []);
    expect(prompt).toContain("# Project decisions");
    expect(prompt).toContain("no server to run");
    expect(prompt).toContain("# Project lessons");
    expect(prompt).toContain("run the build before the tests");
    expect(prompt).not.toContain("ARCHIVED-BODY");
  });

  it("the lead may write the records dir; others may only read it", () => {
    env = makeEnv();
    const p = env.project();
    const lead = writePolicy(p, p.agents.lead);
    const member = writePolicy(p, p.agents["fe-member"]);
    expect(lead.allowDirs).toContain(recordsDir(p));
    expect(lead.deny).not.toContain(recordsDir(p));
    expect(member.allowDirs).not.toContain(recordsDir(p));
    expect(member.deny).toContain(recordsDir(p));
    expect(member.readDirs).toContain(recordsDir(p));
  });

  it("only the lead's system prompt describes the records; nothing is created on disk", () => {
    env = makeEnv();
    const p = env.project();
    expect(buildSystemPrompt(p, p.agents.lead)).toContain(recordsKindDir(p, "decisions"));
    expect(buildSystemPrompt(p, p.agents.lead)).toContain(recordsKindDir(p, "lessons"));
    expect(buildSystemPrompt(p, p.agents["fe-member"])).not.toContain("records");
    expect(fs.existsSync(recordsDir(p))).toBe(false);
  });

  it("never opens symlinks: archived or outside bodies stay out of the view", () => {
    env = makeEnv();
    const p = env.project();
    const dir = recordsKindDir(p, "decisions");
    write(path.join(recordsDir(p), ".archive", "old.md"), "---\nstatus: active\ndate: 2026-01-01\ntitle: Old\n---\nARCHIVED-BODY\n");
    write(path.join(env.root, "outside.md"), "---\nstatus: active\ndate: 2026-01-01\ntitle: Out\n---\nOUTSIDE-BODY\n");
    fs.mkdirSync(dir, { recursive: true });
    fs.symlinkSync(path.join(recordsDir(p), ".archive", "old.md"), path.join(dir, "linked.md"));
    fs.symlinkSync(path.join(env.root, "outside.md"), path.join(dir, "out.md"));
    const rs = listRecords(p, "decisions");
    expect(rs.map((r) => [r.id, !!r.invalid, r.title])).toEqual([["linked", true, "linked.md"], ["out", true, "out.md"]]);
    const view = buildRecordsView(p, "decisions") ?? "";
    expect(view).not.toContain("ARCHIVED-BODY");
    expect(view).not.toContain("OUTSIDE-BODY");
  });

  it.skipIf(!hasMkfifo)("lists a FIFO as invalid without blocking", (ctx) => {
    env = makeEnv();
    const p = env.project();
    const dir = recordsKindDir(p, "decisions");
    fs.mkdirSync(dir, { recursive: true });
    const fifo = path.join(dir, "blocked.md");
    if (!hasMkfifo) return ctx.skip();
    spawnSync("mkfifo", [fifo]);
    const rs = listRecords(p, "decisions"); // a blocking open would hang here until the test timeout
    expect(rs).toHaveLength(1);
    expect(rs[0]).toMatchObject({ id: "blocked", title: "blocked.md" });
    expect(rs[0]!.invalid).toBeTruthy();
  }, 5000);

  it("counts separators only between entries, so a budget-sized entry fits (multibyte too)", () => {
    env = makeEnv();
    const p = env.project();
    const head = "## 決策 [aa]\n";
    const body = "字".repeat(100);
    entry(p, "decisions", "aa", ok("決策", "2026-01-02"), body);
    const one = Buffer.byteLength(head + body);
    expect(activeRecordsBytes(p, "decisions")).toBe(one);
    expect(buildRecordsView(p, "decisions", one)).toBe(head + body);
    expect(buildRecordsView(p, "decisions", one - 1)).toContain("did not fit");
    entry(p, "decisions", "bb", ok("B", "2026-01-01"), "x");
    const two = Buffer.byteLength(`${head}${body}\n\n## B [bb]\nx`);
    expect(activeRecordsBytes(p, "decisions")).toBe(two);
    expect(buildRecordsView(p, "decisions", two)).not.toContain("did not fit");
  });
});

describe("readRegularFileNoFollow", () => {
  it("reads a file; rejects a leaf symlink, a FIFO and a missing path without blocking", async () => {
    const { readRegularFileNoFollow } = await import("../src/fs-util.js");
    env = makeEnv();
    const f = path.join(env.root, "f.txt");
    write(f, "hi");
    expect(readRegularFileNoFollow(f)?.toString()).toBe("hi");
    fs.symlinkSync(f, path.join(env.root, "l.txt"));
    expect(readRegularFileNoFollow(path.join(env.root, "l.txt"))).toBeUndefined();
    expect(readRegularFileNoFollow(path.join(env.root, "nope"))).toBeUndefined();
    if (!hasMkfifo) return;
    spawnSync("mkfifo", [path.join(env.root, "q")]);
    expect(readRegularFileNoFollow(path.join(env.root, "q"))).toBeUndefined();
  }, 5000);
});
