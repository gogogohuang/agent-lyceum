import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Invoker, WakeInput, WakeResult } from "../src/adapters/index.js";
import { acquireProjectLock } from "../src/project-lock.js";
import { commonFile, proposalsDir, recordsKindDir } from "../src/policy.js";
import { describeProposals, listProposals } from "../src/proposals.js";
import { reviewProposals, reviewReportFile } from "../src/proposals-review.js";
import { fingerprint } from "../src/memory-tidy.js";
import { makeEnv, write, type TestEnv } from "./helpers.js";

let env: TestEnv;
afterEach(() => env?.cleanup());

const RUN = "20261123T010203456Z-ab12cd34ef56ab12cd34ef56ab12cd34";
const ok: WakeResult = { ok: true, text: "", exitCode: 0, timedOut: false };
const prop = (fm: string, title = "T") => `---\n${fm}\ndate: 2026-11-20\ntitle: ${title}\nproposed_by: fe-member\nrun: ${RUN}\nevidence:\n  - mail: m1\n---\nfacts\n`;
const put = (p: ReturnType<TestEnv["project"]>, name: string, text: string, kind = "lessons") => write(path.join(proposalsDir(p), kind, `${name}.md`), text);
const rec = (p: ReturnType<TestEnv["project"]>, id: string) => write(path.join(recordsKindDir(p, "lessons"), `${id}.md`), `---\nstatus: active\ndate: 2026-11-21\ntitle: R ${id}\n---\nbody\n`);
const now = () => new Date("2026-11-23T10:00:00Z");
const REPORT = "decided: ab12cd34-a accepted, ab12cd34-b rejected\n";

/** The lead of the review, played by a script: gets the real WakeInput (prompt and write policy) and may write files. */
const lead = (act: (i: WakeInput) => void): Invoker => async (i) => (act(i), ok);

describe("proposals review (spec 30, D-14)", () => {
  it("does nothing, and wakes nobody, when no proposal is pending", async () => {
    env = makeEnv();
    const p = env.project();
    let woken = false;
    put(p, "ab12cd34-a", prop("status: rejected\nreject_reason: no\ndecided: 2026-11-21"));
    const r = await reviewProposals({ project: p, invoker: lead(() => (woken = true)), say: () => {} });
    expect(r.status).toBe("nothing");
    expect(woken).toBe(false);
  });

  it("wakes the lead with a policy that allows only the records and the proposals, and shows it the pending proposals", async () => {
    env = makeEnv();
    const p = env.project();
    put(p, "ab12cd34-a", prop("status: proposed", "First lesson"));
    let seen: WakeInput | undefined;
    await reviewProposals({
      project: p,
      now,
      say: () => {},
      invoker: lead((i) => {
        seen = i;
        write(path.join(i.project.paths.root, "proposals", ".reviews", "20261123T100000Z.md"), REPORT);
      }),
    });
    expect(seen!.agent.name).toBe(p.lead);
    expect(seen!.policy!.allowDirs.sort()).toEqual([path.join(p.paths.shared, "common", "records"), proposalsDir(p)].sort());
    expect(seen!.policy!.allowFiles).toEqual([]);
    expect(seen!.userPrompt).toContain("1 proposals await a decision");
    expect(seen!.userPrompt).toContain("First lesson");
    expect(seen!.userPrompt).toContain(reviewReportFile(p, "20261123T100000Z"));
  });

  it("keeps a complete review: the new record, the decided proposals and the report", async () => {
    env = makeEnv();
    const p = env.project();
    put(p, "ab12cd34-a", prop("status: proposed"));
    put(p, "ab12cd34-b", prop("status: proposed"));
    const r = await reviewProposals({
      project: p,
      now,
      say: () => {},
      invoker: lead(() => {
        rec(p, "good-lesson");
        put(p, "ab12cd34-a", prop("status: accepted\naccepted_as: lessons/good-lesson\ndecided: 2026-11-23"));
        put(p, "ab12cd34-b", prop("status: rejected\nreject_reason: duplicate\ndecided: 2026-11-23"));
        write(reviewReportFile(p, "20261123T100000Z"), REPORT);
      }),
    });
    expect(r).toMatchObject({ status: "reviewed", accepted: 1, rejected: 1, problems: [] });
    expect(fs.existsSync(path.join(recordsKindDir(p, "lessons"), "good-lesson.md"))).toBe(true);
    expect(listProposals(p).map((x) => x.status).sort()).toEqual(["accepted", "rejected"]);
  });

  it("undoes everything when a decision is incomplete, and says why", async () => {
    env = makeEnv();
    const p = env.project();
    put(p, "ab12cd34-a", prop("status: proposed"));
    const before = fingerprint(path.join(p.paths.root, "proposals"));
    const r = await reviewProposals({
      project: p,
      now,
      say: () => {},
      invoker: lead(() => {
        rec(p, "orphan-record");
        put(p, "ab12cd34-a", prop("status: accepted")); // no accepted_as, no decided
        write(reviewReportFile(p, "20261123T100000Z"), REPORT);
      }),
    });
    expect(r.status).toBe("failed");
    expect(r.problems.join("\n")).toMatch(/accepted without accepted_as/);
    expect(fingerprint(path.join(p.paths.root, "proposals"))).toEqual(before);
    expect(fs.existsSync(path.join(recordsKindDir(p, "lessons"), "orphan-record.md"))).toBe(false);
  });

  it("undoes the review when the report is missing, a proposal or record is deleted, COMMON.md is touched, or a records kind goes over budget", async () => {
    env = makeEnv();
    const p = env.project();
    rec(p, "keep-me");
    put(p, "ab12cd34-a", prop("status: proposed"));
    const decide = () => put(p, "ab12cd34-a", prop("status: rejected\nreject_reason: no\ndecided: 2026-11-23"));
    const report = () => write(reviewReportFile(p, "20261123T100000Z"), REPORT);
    const cases: [string, () => void, RegExp][] = [
      ["no report", decide, /report .* is missing or empty/],
      ["deleted proposal", () => (fs.rmSync(path.join(proposalsDir(p), "lessons", "ab12cd34-a.md")), report()), /was deleted/],
      ["deleted record", () => (decide(), fs.rmSync(path.join(recordsKindDir(p, "lessons"), "keep-me.md")), report()), /records\/.*keep-me.md was deleted/],
      ["COMMON.md", () => (decide(), report(), write(commonFile(p), "changed\n")), /COMMON\.md|which a tidy may not touch/],
      ["over budget", () => (decide(), report(), write(path.join(recordsKindDir(p, "lessons"), "huge.md"), `---\nstatus: active\ndate: 2026-11-22\ntitle: H\n---\n${"x".repeat(13000)}\n`)), /over the budget/],
    ];
    for (const [name, act, re] of cases) {
      const before = fingerprint(p.paths.root + "/proposals");
      const r = await reviewProposals({ project: p, now, say: () => {}, invoker: lead(act) });
      expect(r.status, name).toBe("failed");
      expect(r.problems.join("\n"), name).toMatch(re);
      expect(fingerprint(p.paths.root + "/proposals"), name).toEqual(before);
      expect(fs.existsSync(path.join(recordsKindDir(p, "lessons"), "keep-me.md")), name).toBe(true);
      expect(fs.existsSync(path.join(recordsKindDir(p, "lessons"), "huge.md")), name).toBe(false);
    }
  });

  it("does not let the lead change a proposal that was already decided", async () => {
    env = makeEnv();
    const p = env.project();
    put(p, "ab12cd34-old", prop("status: rejected\nreject_reason: no\ndecided: 2026-11-01"));
    put(p, "ab12cd34-new", prop("status: proposed"));
    const r = await reviewProposals({
      project: p,
      now,
      say: () => {},
      invoker: lead(() => {
        put(p, "ab12cd34-old", prop("status: rejected\nreject_reason: changed my mind\ndecided: 2026-11-23"));
        put(p, "ab12cd34-new", prop("status: rejected\nreject_reason: no\ndecided: 2026-11-23"));
        write(reviewReportFile(p, "20261123T100000Z"), REPORT);
      }),
    });
    expect(r.status).toBe("failed");
    expect(r.problems.join("\n")).toMatch(/already decided or archived/);
  });

  it("is refused by the project's exclusive lock while a run or a `call -p` holds the project", () => {
    env = makeEnv();
    const p = env.project();
    const held = acquireProjectLock(p.paths.root, "call-1", { call: true });
    expect(() => acquireProjectLock(p.paths.root, "review-1", { exclusive: true })).toThrow(/needs the project to itself/);
    held.release();
    acquireProjectLock(p.paths.root, "review-2", { exclusive: true }).release();
  });
});

describe("proposals list", () => {
  it("shows counts, the oldest pending date, evidence and incomplete decisions, and writes nothing", () => {
    env = makeEnv();
    const p = env.project();
    expect(describeProposals(p)).toEqual(["No proposals."]);
    put(p, "ab12cd34-a", prop("status: proposed", "Waiting"));
    put(p, "ab12cd34-b", prop("status: accepted", "Half decided"));
    put(p, "ab12cd34-c", prop("status: rejected\nreject_reason: no\ndecided: 2026-11-21"));
    const before = fingerprint(env.root);
    const lines = describeProposals(p);
    expect(lines[0]).toBe("3 proposal(s): 1 pending, 1 accepted, 1 rejected; oldest pending 2026-11-20.");
    expect(lines.join("\n")).toMatch(/pending .*ab12cd34-a.md — Waiting/);
    expect(lines.join("\n")).toMatch(/problem .*ab12cd34-b.md: accepted without accepted_as/);
    expect(fingerprint(env.root)).toEqual(before);
  });
});
