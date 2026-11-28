import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProtectedGuard, proposalForeignPrefixes, runsStartedAfter } from "../src/guard.js";
import { proposalsDir, recordsDir } from "../src/policy.js";
import { bindRunProject } from "../src/run-store.js";
import { soloProject } from "../src/solo.js";
import { makeEnv, registerReviewer, write, type TestEnv } from "./helpers.js";

let env: TestEnv;
afterEach(() => env?.cleanup());

const RUN = "20261123T010203456Z-ab12cd34ef56ab12cd34ef56ab12cd34";
const MINE = "ab12cd34";
const prop = (status = "proposed", extra = "") => `---\nstatus: ${status}\ndate: 2026-11-23\ntitle: T\nproposed_by: fe-member\nrun: ${RUN}\nevidence:\n  - commit: abc1234\n${extra}---\nfacts\n`;

/** A solo project bound to a run whose id yields the short id `ab12cd34`. */
function solo() {
  const base = env.project();
  const p = bindRunProject(soloProject(base, "fe-member"), path.join(env.root, RUN), "run");
  return { p, agent: p.agents["fe-member"]!, prop: (kind: string, name: string) => path.join(proposalsDir(p), kind, name) };
}

describe("guard: records are not authorized for a solo agent", () => {
  it("reverts a solo agent's write to the records and keeps the rejected version", () => {
    env = makeEnv();
    const { p, agent } = solo();
    const g = new ProtectedGuard(p);
    const f = path.join(recordsDir(p), "lessons", "x.md");
    write(f, "sneaky\n");
    const v = g.check([agent]);
    expect(v).toMatchObject([{ file: f, action: "removed", suspects: ["fe-member"] }]);
    expect(fs.existsSync(f)).toBe(false);
  });

  it("still lets an ordinary run's lead write the records", () => {
    env = makeEnv();
    const p = bindRunProject(env.project(), path.join(env.root, "run-1"), "run");
    const g = new ProtectedGuard(p);
    const f = path.join(recordsDir(p), "lessons", "x.md");
    write(f, "ok\n");
    expect(g.check([p.agents[p.lead]!])).toEqual([]);
    expect(fs.existsSync(f)).toBe(true);
  });
});

describe("guard: the proposals tree of a solo agent", () => {
  it("lets the agent create, change and delete its own proposed file", () => {
    env = makeEnv();
    const { p, agent, prop: at } = solo();
    const g = new ProtectedGuard(p);
    const f = at("lessons", `${MINE}-first.md`);
    write(f, prop());
    expect(g.check([agent])).toEqual([]);
    write(f, prop("proposed", "scope: web\n"));
    expect(g.check([agent])).toEqual([]);
    fs.rmSync(f);
    expect(g.check([agent])).toEqual([]);
  });

  it("removes a new file with someone else's prefix, in .archive/, or in an unknown folder", () => {
    env = makeEnv();
    const { p, agent, prop: at } = solo();
    const g = new ProtectedGuard(p);
    const bad = [at("lessons", "ffffffff-x.md"), at("lessons", ".archive/t1/ab12cd34-y.md"), at("other", `${MINE}-z.md`)];
    for (const f of bad) write(f, prop());
    const v = g.check([agent]);
    expect(v.map((x) => x.file).sort()).toEqual(bad.sort());
    for (const f of bad) expect(fs.existsSync(f)).toBe(false);
  });

  it("restores another run's proposal that was changed or deleted", () => {
    env = makeEnv();
    const { p, agent, prop: at } = solo();
    const theirs = at("lessons", "ffffffff-theirs.md");
    const gone = at("decisions", "ffffffff-gone.md");
    write(theirs, prop());
    write(gone, prop());
    const g = new ProtectedGuard(p);
    write(theirs, prop("proposed", "scope: hijack\n"));
    fs.rmSync(gone);
    const v = g.check([agent]);
    expect(v.map((x) => x.action).sort()).toEqual(["restored", "restored"]);
    expect(fs.readFileSync(theirs, "utf8")).toBe(prop());
    expect(fs.readFileSync(gone, "utf8")).toBe(prop());
  });

  it("restores a write of accepted or rejected, even in its own file", () => {
    env = makeEnv();
    const { p, agent, prop: at } = solo();
    const f = at("lessons", `${MINE}-mine.md`);
    write(f, prop());
    const g = new ProtectedGuard(p);
    write(f, prop("accepted"));
    expect(g.check([agent])).toMatchObject([{ file: f, action: "restored" }]);
    expect(fs.readFileSync(f, "utf8")).toBe(prop());
    const n = at("lessons", `${MINE}-new.md`);
    write(n, prop("rejected"));
    expect(g.check([agent])).toMatchObject([{ file: n, action: "removed" }]);
  });

  it("restores an already decided proposal that a resumed run (same run id, same prefix) tries to change back", () => {
    env = makeEnv();
    const { p, agent, prop: at } = solo();
    const f = at("lessons", `${MINE}-decided.md`);
    write(f, prop("accepted", "accepted_as: lessons/x\ndecided: 2026-11-24\n"));
    const g = new ProtectedGuard(p);
    write(f, prop("proposed"));
    expect(g.check([agent])).toMatchObject([{ file: f, action: "restored" }]);
    expect(fs.readFileSync(f, "utf8")).toContain("status: accepted");
    fs.rmSync(f);
    expect(g.check([agent])).toMatchObject([{ file: f, action: "restored" }]);
  });

  it("lets a badly formed file of its own through: the format check flags it, the guard does not delete it", () => {
    env = makeEnv();
    const { p, agent, prop: at } = solo();
    const g = new ProtectedGuard(p);
    write(at("lessons", `${MINE}-broken.md`), "no frontmatter at all\n");
    write(at("lessons", `${MINE}-yaml.md`), "---\n: : [\n---\nx\n");
    expect(g.check([agent])).toEqual([]);
  });

  it("does not follow a symlinked kind folder, and repairs it without writing outside the tree", () => {
    env = makeEnv();
    const { p, agent, prop: at } = solo();
    const theirs = at("lessons", "ffffffff-theirs.md");
    write(theirs, prop());
    const g = new ProtectedGuard(p);
    const outside = path.join(env.root, "outside");
    fs.mkdirSync(outside);
    fs.rmSync(path.dirname(theirs), { recursive: true });
    fs.symlinkSync(outside, path.dirname(theirs));
    const v = g.check([agent]);
    expect(v.length).toBeGreaterThan(0);
    expect(fs.lstatSync(path.dirname(theirs)).isDirectory()).toBe(true);
    expect(fs.readdirSync(outside)).toEqual([]);
    expect(fs.readFileSync(theirs, "utf8")).toBe(prop());
  });

  it("puts back a proposal an ordinary member writes (issue 177; spec 30 left this to the write policy)", () => {
    env = makeEnv();
    const p = bindRunProject(env.project(), path.join(env.root, RUN), "run");
    const g = new ProtectedGuard(p);
    const f = path.join(proposalsDir(p), "lessons", "ffffffff-x.md");
    write(f, prop());
    expect(g.check([p.agents["fe-member"]!])).toMatchObject([{ file: f, action: "removed", suspects: ["fe-member"] }]);
    expect(fs.existsSync(f)).toBe(false);
  });

  it("keeps changes while another run is live (unattributed) instead of reverting them", () => {
    env = makeEnv();
    const { p, agent, prop: at } = solo();
    const g = new ProtectedGuard(p, () => ["other-run"]);
    const f = at("lessons", "ffffffff-x.md");
    write(f, prop());
    expect(g.check([agent])).toEqual([]);
    expect(fs.existsSync(f)).toBe(true);
    expect(g.takeUnattributed().map((u) => u.file)).toEqual([f]);
  });
});

describe("guard: a run that started and ended inside the watched window", () => {
  it("is another run for the solo guard even though it holds no lock any more", () => {
    env = makeEnv();
    const { p, agent } = solo();
    const runs = p.paths.runs;
    let started: string[] = [];
    const g = new ProtectedGuard(p, () => [], { startedAfter: (stamp) => runsStartedAfter(runs, stamp, RUN) });
    // another run starts after the guard's baseline and writes a record as its lead, then finishes
    fs.mkdirSync(path.join(runs, "29990101T000000000Z-aaaa"), { recursive: true });
    started = runsStartedAfter(runs, "20260101T000000000Z", RUN);
    expect(started).toEqual(["29990101T000000000Z-aaaa"]);
    const f = path.join(recordsDir(p), "lessons", "from-other-lead.md");
    write(f, "legit\n");
    expect(g.check([agent])).toEqual([]);
    expect(fs.existsSync(f)).toBe(true);
    expect(g.takeUnattributed().map((u) => u.file)).toEqual([f]);
  });

  it("does not count runs that started before the baseline, or itself", () => {
    env = makeEnv();
    const { p } = solo();
    fs.mkdirSync(path.join(p.paths.runs, "20200101T000000000Z-old"), { recursive: true });
    fs.mkdirSync(path.join(p.paths.runs, RUN), { recursive: true });
    expect(runsStartedAfter(p.paths.runs, "20261123T010203456Z", RUN)).toEqual([]);
  });

  it("asks for the live runs again on every check", () => {
    env = makeEnv();
    const { p, agent } = solo();
    let live: string[] = [];
    const g = new ProtectedGuard(p, () => live);
    const f = path.join(recordsDir(p), "lessons", "x.md");
    write(f, "a\n");
    live = ["late-run"];
    expect(g.check([agent])).toEqual([]);
    expect(g.takeUnattributed().map((u) => u.otherRuns)).toEqual([["late-run"]]);
  });
});

describe("guard: a reviewer in an ordinary run (issue 177)", () => {
  const RUN = "20261128T010203456Z-ab12cd34ef56ab12cd34ef56ab12cd34";
  const proposed = (by: string) => `---\nstatus: proposed\ndate: 2026-11-28\ntitle: T\nproposed_by: ${by}\nrun: ${RUN}\nevidence:\n  - commit: abc1234\n---\nfacts\n`;
  const accepted = proposed("cli-reviewer").replace("status: proposed", "status: accepted");

  function team() {
    env = makeEnv();
    registerReviewer(env, "cli-reviewer");
    registerReviewer(env, "qa-reviewer");
    const p = bindRunProject(env.project(), path.join(env.project().paths.runs, RUN), "run");
    return {
      p,
      reviewer: p.agents["cli-reviewer"]!,
      other: p.agents["qa-reviewer"]!,
      lead: p.agents[p.lead]!,
      member: p.agents["fe-member"]!,
      file: (name: string, kind = "lessons") => path.join(proposalsDir(p), kind, name),
    };
  }

  it("lets a reviewer instance that is not in the agent table keep its own proposed lesson", () => {
    const { p, reviewer, file } = team();
    const slot = { ...reviewer, name: "cli-reviewer--2", instance: { role: "cli-reviewer", k: 2 } };
    const g = new ProtectedGuard(p);
    const f = file("ab12cd34-cli-reviewer--2-quote-yaml.md");
    write(f, proposed("cli-reviewer--2"));
    expect(g.check([slot])).toEqual([]);
    expect(fs.existsSync(f)).toBe(true);
  });

  it("lets a reviewer create their own proposed lesson", () => {
    const { p, reviewer, file } = team();
    const g = new ProtectedGuard(p);
    const f = file("ab12cd34-cli-reviewer-quote-yaml.md");
    write(f, proposed("cli-reviewer"));
    expect(g.check([reviewer])).toEqual([]);
    expect(fs.existsSync(f)).toBe(true);
  });

  it("reverts a reviewer's write to the records", () => {
    const { p, reviewer } = team();
    const g = new ProtectedGuard(p);
    const f = path.join(recordsDir(p), "lessons", "x.md");
    write(f, "sneaky\n");
    expect(g.check([reviewer])).toMatchObject([{ file: f, action: "removed", suspects: ["cli-reviewer"] }]);
    expect(fs.existsSync(f)).toBe(false);
  });

  it("reverts another prefix, a deletion and a decision proposal", () => {
    const { p, reviewer, file } = team();
    const g = new ProtectedGuard(p);
    const own = file("ab12cd34-cli-reviewer-quote-yaml.md");
    write(own, proposed("cli-reviewer"));
    expect(g.check([reviewer])).toEqual([]);

    const foreign = file("ab12cd34-qa-reviewer-other.md");
    write(foreign, proposed("qa-reviewer"));
    const decision = file("ab12cd34-cli-reviewer-x.md", "decisions");
    write(decision, proposed("cli-reviewer"));
    fs.rmSync(own);
    const v = g.check([reviewer]);
    expect(v.map((x) => x.file).sort()).toEqual([foreign, decision, own].sort());
    expect(v.every((x) => x.suspects.includes("cli-reviewer"))).toBe(true);
    expect(fs.existsSync(foreign)).toBe(false);
    expect(fs.existsSync(decision)).toBe(false);
    expect(fs.readFileSync(own, "utf8")).toContain("status: proposed");
  });

  it("restores a reviewer's own file when they set it to accepted", () => {
    const { p, reviewer, file } = team();
    const g = new ProtectedGuard(p);
    const own = file("ab12cd34-cli-reviewer-quote-yaml.md");
    write(own, proposed("cli-reviewer"));
    expect(g.check([reviewer])).toEqual([]);
    write(own, accepted);
    expect(g.check([reviewer])).toMatchObject([{ file: own, action: "restored" }]);
    expect(fs.readFileSync(own, "utf8")).toContain("status: proposed");
  });

  it("restores a reviewer's own file that was already accepted", () => {
    const { p, reviewer, file } = team();
    const own = file("ab12cd34-cli-reviewer-quote-yaml.md");
    write(own, accepted);
    const g = new ProtectedGuard(p);
    write(own, proposed("cli-reviewer"));
    expect(g.check([reviewer])).toMatchObject([{ file: own, action: "restored" }]);
    expect(fs.readFileSync(own, "utf8")).toContain("status: accepted");
  });

  it("keeps a proposed file that has no finding", () => {
    const { p, reviewer, file } = team();
    const g = new ProtectedGuard(p);
    const f = file("ab12cd34-cli-reviewer-no-finding.md");
    write(f, proposed("cli-reviewer"));
    expect(g.check([reviewer])).toEqual([]);
    expect(fs.existsSync(f)).toBe(true);
  });

  it("lets the lead mark a proposal accepted, and puts a deletion back", () => {
    const { p, reviewer, lead, file } = team();
    const g = new ProtectedGuard(p);
    const f = file("ab12cd34-cli-reviewer-quote-yaml.md");
    write(f, proposed("cli-reviewer"));
    expect(g.check([reviewer])).toEqual([]);
    write(f, accepted);
    expect(g.check([lead])).toEqual([]);
    expect(fs.readFileSync(f, "utf8")).toContain("status: accepted");
    fs.rmSync(f);
    expect(g.check([lead])).toMatchObject([{ file: f, action: "restored" }]);
    expect(fs.readFileSync(f, "utf8")).toContain("status: accepted");
  });

  it("records an unattributed change when the lead and a reviewer are in the same batch", () => {
    const { p, reviewer, lead, file } = team();
    const g = new ProtectedGuard(p);
    const f = file("ab12cd34-cli-reviewer-quote-yaml.md");
    write(f, proposed("cli-reviewer"));
    expect(g.check([reviewer])).toEqual([]);
    write(f, accepted);
    expect(g.check([lead, reviewer])).toEqual([]);
    expect(g.takeUnattributed().map((u) => u.file)).toEqual([f]);
    expect(fs.readFileSync(f, "utf8")).toContain("status: accepted");
  });

  it("records an unattributed change when two reviewers are in the same batch", () => {
    const { p, reviewer, other, file } = team();
    const g = new ProtectedGuard(p);
    const f = file("ab12cd34-cli-reviewer-quote-yaml.md");
    write(f, proposed("cli-reviewer"));
    expect(g.check([reviewer, other]).map((v) => v.file)).not.toContain(f);
    expect(g.takeUnattributed().map((u) => u.file)).toEqual([f]);
    expect(fs.existsSync(f)).toBe(true);
  });

  it("removes a proposal written by an ordinary member", () => {
    const { p, member, file } = team();
    const g = new ProtectedGuard(p);
    const f = file("ab12cd34-fe-member-x.md");
    write(f, proposed("fe-member"));
    expect(g.check([member])).toMatchObject([{ file: f, action: "removed" }]);
    expect(fs.existsSync(f)).toBe(false);
  });

  it("keeps a proposal a call or a run wrote during the window, and still removes the member's own", () => {
    const { p, member, file } = team();
    fs.mkdirSync(path.join(env.home, "calls", "29990101T000000000Z-cdef5678aaaaaaaaaaaaaaaaaaaaaaaa"), { recursive: true });
    fs.mkdirSync(path.join(p.paths.runs, "29990101T000000000Z-9999aaaabbbbbbbbbbbbbbbbbbbbbbbb"), { recursive: true });
    const g = new ProtectedGuard(p, () => [], { otherPrefixes: proposalForeignPrefixes(env.home, p.paths.root, p.paths.runs, RUN) });
    const fromCall = file("cdef5678-from-call.md");
    const fromRun = file("9999aaaa-from-run.md");
    const own = file("ab12cd34-fe-member-x.md");
    write(fromCall, proposed("fe-member"));
    write(fromRun, proposed("fe-member"));
    write(own, proposed("fe-member"));
    expect(g.check([member]).map((v) => v.file)).toEqual([own]);
    expect(fs.existsSync(fromCall)).toBe(true);
    expect(fs.existsSync(fromRun)).toBe(true);
    expect(fs.existsSync(own)).toBe(false);
  });
});
