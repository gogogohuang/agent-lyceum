import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { proposalsDir, proposalsKindDir, recordsKindDir } from "../src/policy.js";
import { checkDecisions, checkEvidence, listProposals, oldestPending, parseProposal, pendingProposals, PROPOSAL_MAX_BYTES, shortIdOf } from "../src/proposals.js";
import { git, initGitRepo, makeEnv, write, type TestEnv } from "./helpers.js";

let env: TestEnv;
afterEach(() => env?.cleanup());

const RUN = "20261123T010203456Z-ab12cd34ef56ab12cd34ef56ab12cd34";
const base = (extra: Record<string, string> = {}, evidence = "  - commit: abc1234") =>
  `---\n${Object.entries({ status: "proposed", date: "2026-11-23", title: "T", proposed_by: "reviewer", run: RUN, ...extra })
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n")}\nevidence:\n${evidence}\n---\nfacts\n`;

function put(p: ReturnType<TestEnv["project"]>, kind: "decisions" | "lessons", id: string, text: string): string {
  const f = path.join(proposalsKindDir(p, kind), `${id}.md`);
  write(f, text);
  return f;
}

describe("shortIdOf", () => {
  it("takes the first 8 lowercase letters or digits after the timestamp", () => {
    expect(shortIdOf(RUN)).toBe("ab12cd34");
    expect(shortIdOf("20261123T010203456Z-ABCDEF0123456789")).toBe("abcdef01");
  });
});

describe("proposal paths", () => {
  it("lives beside shared/, not under records/", () => {
    env = makeEnv();
    const p = env.project();
    expect(proposalsDir(p)).toBe(path.join(p.paths.root, "proposals"));
    expect(proposalsKindDir(p, "lessons").startsWith(path.join(p.paths.shared, "common", "records"))).toBe(false);
  });
});

describe("parseProposal", () => {
  it("reads a well-formed proposal", () => {
    env = makeEnv();
    const p = env.project();
    const f = put(p, "lessons", "ab12cd34-use-x", base({ scope: "web", supersedes: "[old]" }, "  - path: src/a.ts:12 @ abc1234\n  - mail: m1\n  - output: \"npm test => 3 failed\""));
    const r = parseProposal("lessons", f);
    expect(r.problems).toEqual([]);
    expect(r).toMatchObject({ status: "proposed", date: "2026-11-23", title: "T", proposedBy: "reviewer", scope: "web", supersedes: ["old"], body: "facts" });
    expect(r.evidence).toEqual([
      { type: "path", file: "src/a.ts", line: 12, commit: "abc1234" },
      { type: "mail", value: "m1" },
      { type: "output", value: "npm test => 3 failed" },
    ]);
  });

  it("accepts an unquoted date (YAML Date) for date and decided", () => {
    env = makeEnv();
    const p = env.project();
    const r = parseProposal("lessons", put(p, "lessons", "ab12cd34-x", base({ status: "rejected", reject_reason: "no", decided: "2026-11-24" })));
    expect(r.problems).toEqual([]);
    expect(r.decided).toBe("2026-11-24");
  });

  it("reports every format problem without throwing", () => {
    env = makeEnv();
    const p = env.project();
    const bad = parseProposal("lessons", put(p, "lessons", "ab12cd34-bad", "---\nstatus: maybe\ntitle: T\n---\nx\n"));
    expect(bad.status).toBeUndefined();
    expect(bad.problems.join("\n")).toMatch(/status must be[\s\S]*date[\s\S]*proposed_by[\s\S]*run[\s\S]*evidence is required/);
    expect(parseProposal("lessons", put(p, "lessons", "ab12cd34-plain", "just text\n")).problems).toContain("missing frontmatter");
    expect(parseProposal("lessons", put(p, "lessons", "ab12cd34-yaml", "---\n: : [\n---\nx\n")).problems[0]).toMatch(/not valid YAML/);
  });

  it("requires evidence, a relative in-repo path and a hex commit", () => {
    env = makeEnv();
    const p = env.project();
    const r1 = parseProposal("lessons", put(p, "lessons", "ab12cd34-e1", base({}, "  - path: ../etc/passwd")));
    expect(r1.problems.join()).toMatch(/stay inside/);
    const r2 = parseProposal("lessons", put(p, "lessons", "ab12cd34-e2", base({}, "  - commit: zzz")));
    expect(r2.problems.join()).toMatch(/hex sha/);
    const r3 = parseProposal("lessons", put(p, "lessons", "ab12cd34-e3", base({}, "  - path: a\n    commit: abc1234")));
    expect(r3.problems.join()).toMatch(/exactly one/);
  });

  it("treats a file over 8 KB or a bad name as not in the right format", () => {
    env = makeEnv();
    const p = env.project();
    const big = parseProposal("lessons", put(p, "lessons", "ab12cd34-big", `${base()}${"x".repeat(PROPOSAL_MAX_BYTES)}`));
    expect(big.problems.join()).toMatch(/larger than/);
    const name = parseProposal("lessons", put(p, "lessons", "Bad_Name", base()));
    expect(name.problems.join()).toMatch(/file name/);
  });

  it("never reads a symlink", () => {
    env = makeEnv();
    const p = env.project();
    const target = path.join(env.root, "outside.md");
    write(target, base());
    fs.mkdirSync(proposalsKindDir(p, "lessons"), { recursive: true });
    const link = path.join(proposalsKindDir(p, "lessons"), "ab12cd34-link.md");
    fs.symlinkSync(target, link);
    expect(parseProposal("lessons", link).problems[0]).toMatch(/not a readable regular file/);
  });
});

describe("listProposals", () => {
  it("lists both kinds, skips .archive and a missing folder, and does not follow a symlinked kind folder", () => {
    env = makeEnv();
    const p = env.project();
    expect(listProposals(p)).toEqual([]);
    put(p, "lessons", "ab12cd34-a", base());
    put(p, "decisions", "ab12cd34-b", base({ status: "accepted" }));
    write(path.join(proposalsDir(p), ".archive", "t1", "lessons", "ab12cd34-old.md"), base());
    expect(listProposals(p).map((x) => x.id)).toEqual(["ab12cd34-b", "ab12cd34-a"]);
    expect(pendingProposals(p).map((x) => x.id)).toEqual(["ab12cd34-a"]);

    const outside = path.join(env.root, "out");
    write(path.join(outside, "ab12cd34-z.md"), base());
    fs.rmSync(proposalsKindDir(p, "lessons"), { recursive: true });
    fs.symlinkSync(outside, proposalsKindDir(p, "lessons"));
    expect(listProposals(p).map((x) => x.id)).toEqual(["ab12cd34-b"]);
  });

  it("counts a file with no readable status as pending, and reports the oldest date", () => {
    env = makeEnv();
    const p = env.project();
    put(p, "lessons", "ab12cd34-a", base({ date: "2026-11-20" }));
    put(p, "lessons", "ab12cd34-b", "no frontmatter\n");
    put(p, "lessons", "ab12cd34-c", base({ date: "2026-11-10" }));
    const pending = pendingProposals(p);
    expect(pending).toHaveLength(3);
    expect(oldestPending(pending)).toBe("2026-11-10");
  });
});

describe("checkDecisions (layer 1)", () => {
  const record = (p: ReturnType<TestEnv["project"]>, id: string) => write(path.join(recordsKindDir(p, "lessons"), `${id}.md`), "---\nstatus: active\ndate: 2026-11-23\ntitle: R\n---\nx\n");
  const check = (p: ReturnType<TestEnv["project"]>, f: string) => checkDecisions([parseProposal("lessons", f)], p).map((x) => x.problem);

  it("ignores proposed proposals, whatever their format", () => {
    env = makeEnv();
    const p = env.project();
    expect(check(p, put(p, "lessons", "ab12cd34-a", "---\nstatus: proposed\n---\n"))).toEqual([]);
  });

  it("requires accepted_as, decided and an existing record for accepted", () => {
    env = makeEnv();
    const p = env.project();
    expect(check(p, put(p, "lessons", "ab12cd34-a", base({ status: "accepted" })))).toEqual(expect.arrayContaining([expect.stringMatching(/without accepted_as/), expect.stringMatching(/without decided/)]));
    expect(check(p, put(p, "lessons", "ab12cd34-b", base({ status: "accepted", accepted_as: "lessons/nope", decided: "2026-11-24" })))).toEqual([expect.stringMatching(/not a record/)]);
    record(p, "real");
    expect(check(p, put(p, "lessons", "ab12cd34-c", base({ status: "accepted", accepted_as: "lessons/real", decided: "2026-11-24" })))).toEqual([]);
  });

  it("counts a record that a tidy archived as existing", () => {
    env = makeEnv();
    const p = env.project();
    write(path.join(recordsKindDir(p, "lessons"), "..", ".archive", "t1", "lessons", "gone.md"), "x");
    expect(check(p, put(p, "lessons", "ab12cd34-a", base({ status: "accepted", accepted_as: "lessons/gone", decided: "2026-11-24" })))).toEqual([]);
  });

  it("holds an accepted proposal to the full format and a prefix that matches its run", () => {
    env = makeEnv();
    const p = env.project();
    record(p, "real");
    const fm = { status: "accepted", accepted_as: "lessons/real", decided: "2026-11-24" };
    expect(check(p, put(p, "lessons", "ab12cd34-a", `${base(fm, "  - commit: zzz")}`))).toEqual([expect.stringMatching(/accepted but evidence commit/)]);
    expect(check(p, put(p, "lessons", "ffffffff-b", base(fm)))).toEqual([expect.stringMatching(/prefix does not match/)]);
  });

  it("lets a rejected proposal be badly formed: only reject_reason and decided count", () => {
    env = makeEnv();
    const p = env.project();
    expect(check(p, put(p, "lessons", "ab12cd34-a", "---\nstatus: rejected\n---\nbroken\n"))).toEqual([expect.stringMatching(/reject_reason/), expect.stringMatching(/decided/)]);
    expect(check(p, put(p, "lessons", "ab12cd34-b", `---\nstatus: rejected\nreject_reason: duplicate\ndecided: 2026-11-24\n---\n${"x".repeat(PROPOSAL_MAX_BYTES)}`))).toEqual([]);
  });
});

describe("checkEvidence (layer 2)", () => {
  function repoWith() {
    env = makeEnv();
    const p = env.project();
    initGitRepo(env.repo, { "src/a.ts": "one\ntwo\nthree\n" });
    const sha = git(env.repo, "rev-parse", "HEAD");
    return { p, sha };
  }
  const prop = (p: ReturnType<TestEnv["project"]>, evidence: string, extra: Record<string, string> = {}) => parseProposal("lessons", put(p, "lessons", `ab12cd34-${Math.random().toString(36).slice(2, 8)}`, base(extra, evidence)));

  it("verifies a path at a commit and a commit; checks the line number", () => {
    const { p, sha } = repoWith();
    expect(checkEvidence(prop(p, `  - path: src/a.ts:3 @ ${sha}`), env.repo).strength).toBe("verified");
    expect(checkEvidence(prop(p, `  - commit: ${sha}`), env.repo).strength).toBe("verified");
    const far = checkEvidence(prop(p, `  - path: src/a.ts:99 @ ${sha}`), env.repo);
    expect(far.strength).toBe("none");
    expect(far.notes[0]).toMatch(/fewer than 99 lines/);
    expect(checkEvidence(prop(p, "  - path: src/nope.ts @ " + sha), env.repo).notes[0]).toMatch(/does not exist/);
    expect(checkEvidence(prop(p, "  - commit: deadbeef"), env.repo).notes[0]).toMatch(/does not exist/);
  });

  it("calls a path without a commit weak, and mail or output never verified", () => {
    const { p } = repoWith();
    expect(checkEvidence(prop(p, "  - path: src/a.ts:2"), env.repo).strength).toBe("weak");
    expect(checkEvidence(prop(p, "  - mail: m1\n  - output: \"x => y\""), env.repo).strength).toBe("none");
  });

  it("is not checked when the repo is missing or is not a git repository", () => {
    const { p, sha } = repoWith();
    const gone = prop(p, `  - commit: ${sha}`, { repo: path.join(env.root, "gone") });
    expect(checkEvidence(gone, env.repo)).toMatchObject({ strength: "none", notes: [expect.stringMatching(/not available/)] });
  });

  it("uses the proposal's own repo instead of the project's", () => {
    const { p, sha } = repoWith();
    const other = path.join(env.root, "other");
    initGitRepo(other, { "x.txt": "x\n" });
    expect(checkEvidence(prop(p, `  - commit: ${sha}`, { repo: other }), env.repo).strength).toBe("none");
    expect(checkEvidence(prop(p, `  - commit: ${git(other, "rev-parse", "HEAD")}`, { repo: other }), env.repo).strength).toBe("verified");
  });
});
