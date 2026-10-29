import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { codexWritableRoots } from "../src/adapters/codex.js";
import { ProtectedGuard } from "../src/guard.js";
import { PERSONA_LIMIT, buildSystemPrompt, readPersona } from "../src/prompt.js";
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
  it("a member may write agents/<self>/, and may not write shared/common, records, or another agent's persona", () => {
    env = makeEnv();
    const p = env.project();
    const member = p.agents["fe-member"]!;
    const pol = writePolicy(p, member);
    const own = projectAgentDir(p, "fe-member");
    const common = projectCommonDir(p);
    expect(pol.allowDirs).toContain(own);
    expect(pol.allowDirs).not.toContain(common);
    expect(pol.allowDirs).not.toContain(recordsDir(p));
    expect(pol.deny).toContain(commonFile(p));
    expect(pol.deny).toContain(recordsDir(p));
    expect(pol.readDirs).toContain(recordsDir(p));
    expect(pol.deny).toContain(member.agentMd);
    expect(pol.deny).toContain(p.agents["qa-member"]!.agentMd);
    expect(pol.deny).toContain(p.paths.config);
    expect(pol.deny).toContain(p.paths.runs);
    for (const f of repoInstructionFiles(p)) expect(pol.deny).toContain(f);
    expect(enforcementFor(p, member).writablePaths).toEqual(expect.arrayContaining([own]));
    expect(enforcementFor(p, member).writablePaths).not.toContain(common);
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
    expect(pol.allowDirs).not.toContain(projectCommonDir(p));
  });

  it("does not grant agents/<self>/ when that directory sits inside another agent's memory", () => {
    env = makeEnv();
    const p = env.project();
    const dir = projectAgentDir(p, "fe-member");
    const qa = p.agents["qa-member"]!;
    const poisoned = {
      ...p,
      agents: { ...p.agents, "qa-member": { ...qa, memory: { ...qa.memory, project: path.dirname(dir) } } },
    };
    const member = poisoned.agents["fe-member"]!;
    expect(ownAgentDirAllowed(poisoned, member)).toBe(false);
    expect(writePolicy(poisoned, member).allowDirs).not.toContain(dir);
  });

  it("does not grant agents/<self>/ when it is a symlink to the config home", () => {
    env = makeEnv();
    const p = env.project();
    const dir = projectAgentDir(p, "fe-member");
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    fs.symlinkSync(p.home, dir);
    const member = p.agents["fe-member"]!;
    expect(ownAgentDirAllowed(p, member)).toBe(false);
    expect(writePolicy(p, member).allowDirs).not.toContain(dir);
  });

  it("does not grant shared/common when it contains another agent's persona, and reverts an edit of that file", () => {
    env = makeEnv();
    const p = bound();
    const common = projectCommonDir(p);
    const foreign = path.join(common, "qa-persona.md");
    const qa = { ...p.agents["qa-member"]!, agentMd: foreign };
    const member = p.agents["fe-member"]!;
    const project = { ...p, agents: { ...p.agents, "qa-member": qa } };
    const pol = writePolicy(project, member);
    expect(pol.allowDirs).not.toContain(common);
    expect(pol.deny).toContain(foreign);
    expect(mayEditProtected(project, member, foreign)).toBe(false);
    expect(mayEditProtected(project, member, commonFile(project))).toBe(false);
    const sys = buildSystemPrompt(project, member);
    expect(sys).not.toContain("You may edit the shared team context");
    expect(sys).toContain("(read-only)");
    write(foreign, "qa persona\n");
    const g = new ProtectedGuard(project);
    write(foreign, "taken\n");
    expect(g.check([member]).map((x) => x.file)).toEqual([foreign]);
    expect(fs.readFileSync(foreign, "utf8")).toBe("qa persona\n");
  });

  it("does not give a Codex lead shared/common back through the COMMON.md parent when that directory holds another agent's persona", () => {
    env = makeEnv();
    const p = env.project();
    const common = projectCommonDir(p);
    const foreign = path.join(common, "qa-persona.md");
    const project = { ...p, agents: { ...p.agents, "qa-member": { ...p.agents["qa-member"]!, agentMd: foreign } } };
    const wake = { workDir: env.root, systemPrompt: "s", userPrompt: "u", timeoutSec: 60 };
    const poisoned = codexWritableRoots({ ...wake, project, agent: project.agents.lead });
    expect(poisoned).not.toContain(common);
    expect(poisoned).toContain(recordsDir(project));
    const normal = codexWritableRoots({ ...wake, project: p, agent: p.agents.lead });
    expect(normal).toContain(common);
  });

  it("instance 2 gets agents/<slot>/, not the role directory or shared/common", () => {
    env = makeEnv();
    const p = env.project();
    const agents = synthesizeSlots(p.agents, { roles: { "fe-member": ["fe-member--2"] } }, (slot) => path.join(p.paths.taskMemory, "run-1", slot));
    const slot = agents["fe-member--2"]!;
    const bound = { ...p, agents };
    const pol = writePolicy(bound, slot);
    expect(pol.allowDirs).toContain(projectAgentDir(p, "fe-member--2"));
    expect(pol.allowDirs).not.toContain(projectAgentDir(p, "fe-member"));
    expect(pol.allowDirs).not.toContain(projectCommonDir(p));
    expect(pol.deny).toContain(p.agents["fe-member"]!.agentMd);
  });

  it("instance 1 keeps agents/<role>/ when the slot shares its project persona", () => {
    env = makeEnv();
    const p = env.project();
    const projectMd = path.join(projectAgentDir(p, "fe-member"), "AGENT.md");
    const role = { ...p.agents["fe-member"]!, agentMd: projectMd };
    const agents = synthesizeSlots({ ...p.agents, "fe-member": role }, { roles: { "fe-member": ["fe-member--2"] } }, (slot) => path.join(p.paths.taskMemory, "run-1", slot));
    const project = { ...p, agents };
    const pol = writePolicy(project, agents["fe-member"]!);
    expect(pol.allowDirs).toContain(projectAgentDir(p, "fe-member"));
    expect(pol.deny).not.toContain(projectMd);
    const sys = buildSystemPrompt(project, agents["fe-member"]!);
    expect(sys).toContain(`You may edit your project persona \`${projectMd}\``);
    const slotPol = writePolicy(project, agents["fe-member--2"]!);
    expect(slotPol.allowDirs).toContain(projectAgentDir(p, "fe-member--2"));
    expect(slotPol.allowDirs).not.toContain(projectAgentDir(p, "fe-member"));
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
    expect(mayEditProtected(project, member, commonFile(project))).toBe(false);
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
    expect(v.map((x) => x.file).sort()).toEqual([commonFile(project), dec, project.agents.lead.agentMd].sort());
    expect(fs.readFileSync(commonFile(project), "utf8")).toBe("v1\n");
    expect(fs.readFileSync(dec, "utf8")).toBe("original\n");
    expect(fs.readFileSync(projectMd, "utf8")).toBe("rewritten\n");
    expect(fs.readFileSync(project.agents.lead.agentMd, "utf8")).not.toBe("stolen\n");
  });

  it("tells a member that COMMON.md is read-only and does not offer a global persona", () => {
    env = makeEnv();
    const p = env.project();
    const sys = buildSystemPrompt(p, p.agents["fe-member"]!);
    expect(sys).toContain(`${commonFile(p)}\` (read-only)`);
    expect(sys).toContain(projectAgentDir(p, "fe-member"));
    expect(sys).not.toContain("Add or update entries before you send `done`");
    expect(sys).not.toContain(`You may edit your project persona \`${p.agents["fe-member"]!.agentMd}\``);
    expect(sys).toContain("Never edit another agent's AGENT.md");
    const lead = buildSystemPrompt(p, p.agents.lead);
    expect(lead).toContain("Add or update entries before you send `done`");
    expect(lead).toContain("you maintain it");
  });

  it("does not tell instance 2 to edit the role persona", () => {
    env = makeEnv();
    const p = env.project();
    const agents = synthesizeSlots(p.agents, { roles: { "fe-member": ["fe-member--2"] } }, (slot) => path.join(p.paths.taskMemory, "run-1", slot));
    const slot = agents["fe-member--2"]!;
    const sys = buildSystemPrompt({ ...p, agents }, slot);
    expect(sys).toContain(projectCommonDir(p));
    expect(sys).not.toContain(`You may edit your project persona \`${slot.agentMd}\``);
    expect(sys).toContain("cannot write the shared memory");
  });

  it("offers the project persona only when agentMd lives in agents/<name>/", () => {
    env = makeEnv();
    const p = env.project();
    const projectMd = path.join(projectAgentDir(p, "fe-member"), "AGENT.md");
    fs.mkdirSync(path.dirname(projectMd), { recursive: true });
    fs.writeFileSync(projectMd, "# fe\n");
    const member = { ...p.agents["fe-member"]!, agentMd: projectMd };
    const sys = buildSystemPrompt({ ...p, agents: { ...p.agents, "fe-member": member } }, member);
    expect(sys).toContain(`You may edit your project persona \`${projectMd}\``);
  });

  it("does not block on a fifo persona and caps a huge one", () => {
    env = makeEnv();
    const p = env.project();
    const member = p.agents["fe-member"]!;
    const fifo = path.join(env.root, "persona.fifo");
    expect(spawnSync("mkfifo", [fifo]).status).toBe(0);
    const started = Date.now();
    expect(readPersona({ ...member, agentMd: fifo })).toBe("");
    expect(Date.now() - started).toBeLessThan(1000);
    const huge = path.join(env.root, "persona.md");
    fs.writeFileSync(huge, "x".repeat(PERSONA_LIMIT + 50));
    const text = readPersona({ ...member, agentMd: huge });
    expect(text).toContain(`[persona truncated at ${PERSONA_LIMIT} bytes]`);
    expect(text.length).toBeLessThan(PERSONA_LIMIT + 80);
  });
});
