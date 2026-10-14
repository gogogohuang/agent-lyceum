import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildClaudeInvocation, buildClaudeSettings } from "../src/adapters/claude.js";
import { codexWritableRoots } from "../src/adapters/codex.js";
import { ProtectedGuard } from "../src/guard.js";
import { enforcementFor, sharedDir, sharedIndex, writePolicy } from "../src/policy.js";
import { bindRunProject } from "../src/run-store.js";
import { makeEnv, write, type ClaudeSettingsView, type TestEnv } from "./helpers.js";

let env: TestEnv;
afterEach(() => env?.cleanup());

const bound = () => bindRunProject(env.project(), path.join(env.root, "run-1"), "run");

describe("the handoff folder: where it is and who may write it", () => {
  it("sits in the run's task memory under a name no agent can have, and only for a run", () => {
    env = makeEnv();
    const p = bound();
    expect(sharedDir(p)).toBe(path.join(p.paths.taskMemory, "run-1", "_shared"));
    expect(sharedIndex(p)).toBe(path.join(sharedDir(p) as string, "MEMORY.md"));
    expect(sharedDir(env.project())).toBeUndefined(); // not bound to a run
    expect(sharedDir({ ...p, solo: "call" })).toBeUndefined();
  });

  it("only the lead may write it; everyone else may read it but is denied", () => {
    env = makeEnv();
    const p = bound();
    const dir = sharedDir(p) as string;
    const lead = writePolicy(p, p.agents.lead);
    expect(lead.allowDirs).toContain(dir);
    expect(lead.allowFiles).toContain(sharedIndex(p));
    expect(lead.deny).not.toContain(dir);
    expect(lead.readDirs).not.toContain(dir);
    const member = writePolicy(p, p.agents["fe-member"]);
    expect(member.allowDirs).not.toContain(dir);
    expect(member.allowFiles).not.toContain(sharedIndex(p));
    expect(member.deny).toContain(dir);
    expect(member.readDirs).toEqual([dir]);
  });

  it("policies outside a run are exactly what they were", () => {
    env = makeEnv();
    const p = env.project();
    expect(writePolicy(p, p.agents["fe-member"]).readDirs).toEqual([]);
    expect(writePolicy(p, p.agents.lead).allowDirs.some((d) => d.endsWith("_shared"))).toBe(false);
  });

  it("Claude: a member can read the folder (--add-dir) but the sandbox does not let it write there; the lead can write", () => {
    env = makeEnv();
    const p = bound();
    const dir = sharedDir(p) as string;
    const member = buildClaudeSettings(p, p.agents["fe-member"]) as unknown as ClaudeSettingsView;
    expect(member.sandbox.filesystem.allowWrite).not.toContain(dir);
    expect(member.sandbox.filesystem.denyWrite).toContain(dir);
    const lead = buildClaudeSettings(p, p.agents.lead) as unknown as ClaudeSettingsView;
    expect(lead.sandbox.filesystem.allowWrite).toContain(dir);

    const dirsOf = (agent: string) => {
      const inv = buildClaudeInvocation({ project: p, agent: p.agents[agent], workDir: path.join(env.root, `work-${agent}`), systemPrompt: "s", userPrompt: "u", timeoutSec: 60 });
      return inv.args.flatMap((x, i) => (x === "--add-dir" ? [inv.args[i + 1]] : []));
    };
    expect(dirsOf("fe-member")).toContain(dir);
    expect(dirsOf("lead")).toContain(dir);
  });

  it("Codex: the folder is a writable root for the lead only", () => {
    env = makeEnv();
    const p = bound();
    const dir = sharedDir(p) as string;
    const roots = (agent: string) => codexWritableRoots({ project: p, agent: p.agents[agent], workDir: env.root, systemPrompt: "s", userPrompt: "u", timeoutSec: 60 });
    expect(roots("lead")).toContain(dir);
    expect(roots("fe-member")).not.toContain(dir);
  });

  it("the guard puts back a member's edit of the handoff index and lets the lead write it", () => {
    env = makeEnv();
    const p = bound();
    const idx = sharedIndex(p) as string;
    const g = new ProtectedGuard(p);
    write(idx, "a member was here\n");
    expect(g.check([p.agents["fe-member"]])).toMatchObject([{ file: idx, action: "removed", suspects: ["fe-member"] }]);
    expect(fs.existsSync(idx)).toBe(false);
    g.rebase();
    write(idx, "- decisions: see decisions.md\n");
    expect(g.check([p.agents.lead])).toEqual([]);
    expect(fs.readFileSync(idx, "utf8")).toContain("decisions");
  });

  it("reports a shared level: n/a for the lead, a real level for members", () => {
    env = makeEnv();
    const p = bound();
    expect(enforcementFor(p, p.agents.lead).shared).toBe("n/a");
    const m = enforcementFor(p, p.agents["fe-member"]);
    expect(["os", "tool-rules", "post-hoc"]).toContain(m.shared);
  });
});
