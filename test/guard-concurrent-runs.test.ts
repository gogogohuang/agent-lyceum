import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProtectedGuard } from "../src/guard.js";
import { commonFile, recordsDir, sharedIndex } from "../src/policy.js";
import { bindRunProject } from "../src/run-store.js";
import { makeEnv, write, type TestEnv } from "./helpers.js";

let env: TestEnv;
afterEach(() => env?.cleanup());
const bound = () => bindRunProject(env.project(), path.join(env.root, "run-1"), "run");

describe("guard: shared-file changes while another run is live", () => {
  it("keeps a member's COMMON.md and records, and reports another run's global AGENT.md edit as unattributed", () => {
    env = makeEnv();
    const p = bound();
    const common = commonFile(p);
    const rec = path.join(recordsDir(p), "decisions", "new.md");
    const agentMd = p.agents["fe-member"].agentMd;
    write(common, "v1\n");
    const g = new ProtectedGuard(p, () => ["run-2"]);
    write(common, "v2 by other lead\n");
    write(rec, "other run record\n");
    write(agentMd, "other run edit\n");
    expect(g.check([p.agents["fe-member"]])).toEqual([]);
    expect(fs.readFileSync(common, "utf8")).toBe("v2 by other lead\n");
    expect(fs.existsSync(rec)).toBe(true);
    expect(fs.readFileSync(agentMd, "utf8")).toBe("other run edit\n");
    expect(g.takeUnattributed().map((u) => u.file)).toEqual([agentMd]);
    expect(g.takeUnattributed()).toEqual([]);
    expect(g.check([p.agents["fe-member"]])).toEqual([]); // not re-flagged
    expect(g.takeUnattributed()).toEqual([]);
  });

  it("keeps a member's COMMON.md and records when no other run is live, and restores another agent's AGENT.md", () => {
    env = makeEnv();
    const p = bound();
    const common = commonFile(p);
    const rec = path.join(recordsDir(p), "decisions", "new.md");
    const leadMd = p.agents.lead.agentMd;
    const original = fs.readFileSync(leadMd, "utf8");
    write(common, "v1\n");
    const g = new ProtectedGuard(p, () => []);
    write(common, "kept\n");
    write(rec, "x\n");
    write(leadMd, "stolen\n");
    const v = g.check([p.agents["fe-member"]]);
    expect(v.map((x) => [x.file, x.action])).toEqual([[leadMd, "restored"]]);
    expect(fs.readFileSync(common, "utf8")).toBe("kept\n");
    expect(fs.readFileSync(rec, "utf8")).toBe("x\n");
    expect(fs.readFileSync(leadMd, "utf8")).toBe(original);
    expect(g.takeUnattributed()).toEqual([]);
  });

  it("still reverts the per-run handoff index even when another run is live", () => {
    env = makeEnv();
    const p = bound();
    const idx = sharedIndex(p) as string;
    const g = new ProtectedGuard(p, () => ["run-2"]);
    write(idx, "member was here\n");
    expect(g.check([p.agents["fe-member"]])).toMatchObject([{ file: idx, action: "removed" }]);
    expect(g.takeUnattributed()).toEqual([]);
  });

  it("an authorized batch (the lead) is unaffected", () => {
    env = makeEnv();
    const p = bound();
    const common = commonFile(p);
    write(common, "v1\n");
    const g = new ProtectedGuard(p, () => ["run-2"]);
    write(common, "lead edit\n");
    expect(g.check([p.agents.lead])).toEqual([]);
    expect(g.takeUnattributed()).toEqual([]);
  });

  it("counts a run that was live when the batch started even if it is gone at check time", () => {
    env = makeEnv();
    const p = bound();
    const leadMd = p.agents.lead.agentMd;
    let live = ["run-2"];
    const g = new ProtectedGuard(p, () => live);
    live = [];
    write(leadMd, "other run edit\n");
    expect(g.check([p.agents["fe-member"]])).toEqual([]);
    expect(fs.readFileSync(leadMd, "utf8")).toBe("other run edit\n");
    expect(g.takeUnattributed().map((u) => u.file)).toEqual([leadMd]);
  });
});
