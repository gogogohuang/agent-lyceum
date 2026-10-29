import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProtectedGuard } from "../src/guard.js";
import { synthesizeSlots } from "../src/instances.js";
import {
  commonFile,
  enforcementFor,
  mayEditProtected,
  ownAgentDirAllowed,
  projectAgentDir,
  projectCommonDir,
  recordsDir,
  repoInstructionFiles,
  writePolicy,
} from "../src/policy.js";
import { bindRunProject } from "../src/run-store.js";
import { makeEnv, write, type TestEnv } from "./helpers.js";

let env: TestEnv;
afterEach(() => env?.cleanup());

function bound() {
  return bindRunProject(env.project(), path.join(env.root, "run-1"), "run");
}

describe("project write scope", () => {
  it("a member may write agents/<self>/ and shared/common/, and may not write another agent's persona or the records deny", () => {
    env = makeEnv();
    const p = env.project();
    const member = p.agents["fe-member"]!;
    const pol = writePolicy(p, member);
    const own = projectAgentDir(p, "fe-member");
    const common = projectCommonDir(p);
    expect(pol.allowDirs).toContain(own);
    expect(pol.allowDirs).toContain(common);
    expect(pol.allowDirs).not.toContain(recordsDir(p));
    expect(pol.deny).not.toContain(commonFile(p));
    expect(pol.deny).not.toContain(recordsDir(p));
    expect(pol.readDirs).not.toContain(recordsDir(p));
    expect(pol.deny).toContain(member.agentMd);
    expect(pol.deny).toContain(p.agents["qa-member"]!.agentMd);
    expect(pol.deny).toContain(p.paths.config);
    expect(pol.deny).toContain(p.paths.runs);
    for (const f of repoInstructionFiles(p)) expect(pol.deny).toContain(f);
    expect(enforcementFor(p, member).writablePaths).toEqual(expect.arrayContaining([own, common]));
  });

  it("does not add agents/<self>/ when that directory contains another agent's memory", () => {
    env = makeEnv();
    const p = env.project();
    const dir = projectAgentDir(p, "fe-member");
    const poisoned = {
      ...p,
      agents: {
        ...p.agents,
        "qa-member": {
          ...p.agents["qa-member"]!,
          memory: { ...p.agents["qa-member"]!.memory, project: path.join(dir, "qa-memory") },
        },
      },
    };
    const member = poisoned.agents["fe-member"]!;
    expect(ownAgentDirAllowed(poisoned, member)).toBe(false);
    const pol = writePolicy(poisoned, member);
    expect(pol.allowDirs).not.toContain(dir);
    expect(pol.allowDirs).toContain(projectCommonDir(p));
  });

  it("instance 2 gets agents/<slot>/ and shared/common/, not the role directory", () => {
    env = makeEnv();
    const p = env.project();
    const agents = synthesizeSlots(p.agents, { roles: { "fe-member": ["fe-member--2"] } }, (slot) => path.join(p.paths.taskMemory, "run-1", slot));
    const slot = agents["fe-member--2"]!;
    const bound = { ...p, agents };
    const pol = writePolicy(bound, slot);
    expect(pol.allowDirs).toContain(projectAgentDir(p, "fe-member--2"));
    expect(pol.allowDirs).not.toContain(projectAgentDir(p, "fe-member"));
    expect(pol.allowDirs).toContain(projectCommonDir(p));
    expect(pol.deny).toContain(p.agents["fe-member"]!.agentMd);
  });

  it("a project-level AGENT.md inside agents/<self>/ is not denied", () => {
    env = makeEnv();
    const p = env.project();
    const projectMd = path.join(projectAgentDir(p, "fe-member"), "AGENT.md");
    const member = { ...p.agents["fe-member"]!, agentMd: projectMd };
    const bound = { ...p, agents: { ...p.agents, "fe-member": member } };
    const pol = writePolicy(bound, member);
    expect(pol.deny).not.toContain(projectMd);
    expect(pol.deny).toContain(p.agents.lead.agentMd);
  });

  it("keeps a member's edit of COMMON.md, records, and a project-level AGENT.md", () => {
    env = makeEnv();
    const p = bound();
    const projectMd = path.join(projectAgentDir(p, "fe-member"), "AGENT.md");
    fs.mkdirSync(path.dirname(projectMd), { recursive: true });
    fs.writeFileSync(projectMd, "persona\n");
    const member = { ...p.agents["fe-member"]!, agentMd: projectMd };
    const project = { ...p, agents: { ...p.agents, "fe-member": member } };
    expect(mayEditProtected(project, member, commonFile(project))).toBe(true);
    expect(mayEditProtected(project, member, projectMd)).toBe(true);
    expect(mayEditProtected(project, member, project.agents.lead.agentMd)).toBe(false);
    const dec = path.join(recordsDir(project), "decisions", "keep.md");
    write(commonFile(project), "v1\n");
    write(dec, "original\n");
    const g = new ProtectedGuard(project);
    write(commonFile(project), "v2\n");
    write(dec, "member edit\n");
    write(projectMd, "rewritten\n");
    write(project.agents.lead.agentMd, "stolen\n");
    const v = g.check([member]);
    expect(v.map((x) => x.file)).toEqual([project.agents.lead.agentMd]);
    expect(fs.readFileSync(commonFile(project), "utf8")).toBe("v2\n");
    expect(fs.readFileSync(dec, "utf8")).toBe("member edit\n");
    expect(fs.readFileSync(projectMd, "utf8")).toBe("rewritten\n");
    expect(fs.readFileSync(project.agents.lead.agentMd, "utf8")).not.toBe("stolen\n");
  });
});
