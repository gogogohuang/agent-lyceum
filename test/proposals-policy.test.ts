import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureReviewerProposalDir, mayPropose, proposalsDir, readOnlyPolicy, recordsDir, writePolicy } from "../src/policy.js";
import { soloProject } from "../src/solo.js";
import { makeEnv, registerReviewer, type TestEnv } from "./helpers.js";

let env: TestEnv;
afterEach(() => env?.cleanup());

describe("write policy for the proposals tree (spec 30)", () => {
  it("lets the agent of `run --agent` write proposals but not the records", () => {
    env = makeEnv();
    const p = soloProject(env.project(), "fe-member");
    const w = writePolicy(p, p.agents["fe-member"]!);
    expect(w.allowDirs).toContain(proposalsDir(p));
    expect(w.allowDirs).not.toContain(recordsDir(p));
    expect(w.deny).toContain(recordsDir(p));
    expect(w.deny).not.toContain(proposalsDir(p));
  });

  it("lets an ordinary run's lead write proposals (it decides them), and gives other members no write access to them", () => {
    env = makeEnv();
    const p = env.project();
    expect(writePolicy(p, p.agents[p.lead]!).allowDirs).toContain(proposalsDir(p));
    const member = writePolicy(p, p.agents["fe-member"]!);
    expect(member.allowDirs).not.toContain(proposalsDir(p));
    expect(member.readDirs).toEqual([recordsDir(p)]); // unchanged: an ordinary member's policy does not mention the proposals
    expect(member.deny).not.toContain(proposalsDir(p));
  });

  it("gives a plain `call` no proposals, and `call -p` the real project's proposals", () => {
    env = makeEnv();
    const base = { ...soloProject(env.project(), "fe-member"), solo: "call" as const };
    expect(mayPropose(base)).toBe(false);
    expect(writePolicy(base, base.agents["fe-member"]!).allowDirs).not.toContain(proposalsDir(base));

    const real = path.join(env.root, "real-project");
    const withRef = { ...base, proposalsRef: { projectRoot: real, recordsRoot: path.join(real, "shared/common/records"), proposalsRoot: path.join(real, "proposals"), dir: env.repo, shortId: "ab12cd34" } };
    expect(mayPropose(withRef)).toBe(true);
    expect(proposalsDir(withRef)).toBe(path.join(real, "proposals"));
    expect(writePolicy(withRef, withRef.agents["fe-member"]!).allowDirs).toContain(path.join(real, "proposals"));
  });

  it("keeps the proposals beside shared/, so no deny of the records covers them", () => {
    env = makeEnv();
    const p = soloProject(env.project(), "fe-member");
    const w = writePolicy(p, p.agents["fe-member"]!);
    expect(w.deny.some((d) => proposalsDir(p) === d || proposalsDir(p).startsWith(d + path.sep))).toBe(false);
  });

  it("lets a reviewer write proposals on a normal run, including a read-only wake, and still denies the records", () => {
    env = makeEnv();
    registerReviewer(env, "cli-reviewer");
    const p = env.project();
    const reviewer = p.agents["cli-reviewer"]!;
    for (const pol of [writePolicy(p, reviewer), readOnlyPolicy(p, reviewer)]) {
      expect(pol.allowDirs).toContain(proposalsDir(p));
      expect(pol.allowDirs).not.toContain(recordsDir(p));
      expect(pol.deny).toContain(recordsDir(p));
    }
    const member = p.agents["fe-member"]!;
    expect(writePolicy(p, member).allowDirs).not.toContain(proposalsDir(p));
    expect(readOnlyPolicy(p, member).allowDirs).not.toContain(proposalsDir(p));
    expect(mayPropose(p)).toBe(false);
  });
});

describe("ensureReviewerProposalDir", () => {
  it("creates the proposals directory only for a normal run that has a reviewer", () => {
    env = makeEnv();
    const plain = env.project();
    ensureReviewerProposalDir(plain);
    expect(fs.existsSync(proposalsDir(plain))).toBe(false);
    registerReviewer(env, "cli-reviewer");
    const withReviewer = env.project();
    ensureReviewerProposalDir(withReviewer);
    expect(fs.statSync(proposalsDir(withReviewer)).isDirectory()).toBe(true);
    fs.rmSync(proposalsDir(withReviewer), { recursive: true, force: true });
    ensureReviewerProposalDir(soloProject(withReviewer, "cli-reviewer"));
    expect(fs.existsSync(proposalsDir(withReviewer))).toBe(false);
  });
});
