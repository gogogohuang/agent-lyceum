import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ResolvedAgent } from "../src/config.js";
import { canonicalPath } from "../src/paths.js";
import { outboxDir, readOnlyPolicy, recordsDir, repoDirFor, writePolicy } from "../src/policy.js";
import { prepareAgentWorkspace, snapshotBase } from "../src/worktree.js";
import { initGitRepo, makeEnv, type TestEnv } from "./helpers.js";

let env: TestEnv;
afterEach(() => env?.cleanup());

describe("readOnlyPolicy", () => {
  it("keeps the repo readable and withholds git, sandbox writes, records and persona files", () => {
    env = makeEnv();
    initGitRepo(env.repo);
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ro-scratch-"));
    const project = env.project();
    const base = project.agents["fe-member"]!;
    const agent: ResolvedAgent = {
      ...base,
      canEditAgentMd: true,
      sandbox: { write: [scratch], network: [], localBinding: false, unixSockets: [] },
    };
    const ws = prepareAgentWorkspace(project, "run-1", "fe-member", snapshotBase(project, "run-1", 1));
    const bound = { ...project, agents: { ...project.agents, "fe-member": agent }, workspaces: { "fe-member": ws } };
    const pol = readOnlyPolicy(bound, agent);
    const normal = writePolicy(bound, agent);
    expect(pol.allowFiles).toEqual([]);
    expect(pol.allowDirs).toContain(outboxDir(bound, "fe-member"));
    expect(pol.allowDirs).not.toContain(ws.gitDir);
    expect(pol.allowDirs).not.toContain(canonicalPath(scratch));
    expect(pol.allowDirs).not.toContain(recordsDir(bound));
    expect(pol.allowDirs.some((d) => d === agent.agentMd)).toBe(false);
    expect(pol.readDirs).toContain(repoDirFor(bound, "fe-member"));
    expect(pol.deny).toEqual(normal.deny);
    fs.rmSync(scratch, { recursive: true, force: true });
  });
});
