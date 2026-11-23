import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { mayPropose, proposalsDir, recordsDir, writePolicy } from "../src/policy.js";
import { soloProject } from "../src/solo.js";
import { makeEnv, type TestEnv } from "./helpers.js";

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

  it("lets an ordinary run's lead write proposals (it decides them), and other members only read them", () => {
    env = makeEnv();
    const p = env.project();
    expect(writePolicy(p, p.agents[p.lead]!).allowDirs).toContain(proposalsDir(p));
    const member = writePolicy(p, p.agents["fe-member"]!);
    expect(member.allowDirs).not.toContain(proposalsDir(p));
    expect(member.readDirs).toContain(proposalsDir(p));
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
});
