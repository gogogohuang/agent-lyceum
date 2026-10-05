import fs from "node:fs";
import type { ResolvedProject } from "./config.js";
import { enforcementFor, memoryDirs, ownsDirs, type AgentEnforcement } from "./policy.js";
import { isInside } from "./paths.js";
import { RUNTIME_EFFORTS } from "./schema.js";

export interface Issue {
  level: "error" | "warn";
  message: string;
}

export interface ValidationResult {
  issues: Issue[];
  enforcement: AgentEnforcement[];
  ok: boolean;
}

export function validateProject(project: ResolvedProject): ValidationResult {
  const issues: Issue[] = [];
  const err = (message: string) => issues.push({ level: "error", message });
  const warn = (message: string) => issues.push({ level: "warn", message });
  const names = Object.keys(project.agents);

  if (names.length < 3) err(`A team needs at least 3 agents (found ${names.length}).`);
  if (!project.agents[project.lead]) err(`Lead "${project.lead}" is not listed under agents.`);
  if (!fs.existsSync(project.dir) || !fs.statSync(project.dir).isDirectory()) {
    err(`Project dir does not exist: ${project.dir}`);
  }

  for (const a of Object.values(project.agents)) {
    if (!a.runtime) err(`Agent "${a.name}" has no runtime (set it in team.yaml or project.yaml).`);
    if (a.effort && a.runtime && !RUNTIME_EFFORTS[a.runtime].includes(a.effort)) {
      err(`Agent "${a.name}": effort "${a.effort}" is not supported by ${a.runtime} (use ${RUNTIME_EFFORTS[a.runtime].join(", ")}).`);
    }
    if (!fs.existsSync(a.agentMd)) err(`Agent "${a.name}": AGENT.md not found at ${a.agentMd}`);
    if (!a.memory.global && !a.memory.project) warn(`Agent "${a.name}" has no long-term memory configured.`);
    if (a.canMessage !== "all") {
      for (const t of a.canMessage) {
        if (!project.agents[t]) err(`Agent "${a.name}": can_message target "${t}" is not in the team.`);
        if (t === a.name) warn(`Agent "${a.name}" lists itself in can_message.`);
      }
    }
    if (a.resume && a.runtime === "codex") {
      warn(`Agent "${a.name}": resume with Codex is untested; each wake-up may start fresh.`);
    }
  }

  // Memory directories must not overlap between agents (or equal each other).
  const mem: { agent: string; dir: string }[] = [];
  for (const a of Object.values(project.agents)) for (const d of memoryDirs(a)) mem.push({ agent: a.name, dir: d });
  for (let i = 0; i < mem.length; i++) {
    for (let j = i + 1; j < mem.length; j++) {
      const x = mem[i];
      const y = mem[j];
      if (x.agent === y.agent && x.dir !== y.dir) continue;
      if (isInside(x.dir, y.dir) || isInside(y.dir, x.dir)) {
        err(`Memory dirs overlap: "${x.agent}" ${x.dir} vs "${y.agent}" ${y.dir}`);
      }
    }
  }

  // Parallelism requires disjoint `owns`.
  if (project.dispatcher.max_parallel > 1) {
    const withOwns = Object.values(project.agents).filter((a) => a.name !== project.lead);
    for (const a of withOwns) {
      if (a.owns.length === 0) err(`max_parallel > 1 requires "owns" for agent "${a.name}".`);
    }
    for (let i = 0; i < withOwns.length; i++) {
      for (let j = i + 1; j < withOwns.length; j++) {
        for (const x of ownsDirs(project, withOwns[i])) {
          for (const y of ownsDirs(project, withOwns[j])) {
            if (isInside(x, y) || isInside(y, x)) {
              err(`"owns" overlap: ${withOwns[i].name} (${x}) vs ${withOwns[j].name} (${y})`);
            }
          }
        }
      }
    }
  }

  // Context paths should live outside the repo (the tool never writes into it).
  for (const a of Object.values(project.agents)) {
    for (const d of memoryDirs(a)) {
      if (isInside(project.dir, d)) warn(`Agent "${a.name}": memory dir ${d} is inside the repo.`);
    }
  }

  const enforcement = Object.values(project.agents).map((a) => enforcementFor(project, a));
  if (project.dispatcher.strict) {
    for (const e of enforcement) {
      for (const k of ["memory", "agentMd", "otherContext"] as const) {
        if (e[k] !== "os") err(`strict: agent "${e.agent}" ${k} protection is "${e[k]}", not OS-enforced.`);
      }
    }
  }

  return { issues, enforcement, ok: !issues.some((i) => i.level === "error") };
}

export function formatEnforcement(list: AgentEnforcement[]): string {
  const rows = [["agent", "runtime", "memory", "AGENT.md", "others' ctx", "repo CLAUDE/AGENTS", "owns"]];
  for (const e of list) rows.push([e.agent, e.runtime, e.memory, e.agentMd, e.otherContext, e.repoInstructions, e.owns]);
  const w = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
  const lines = rows.map((r) => r.map((c, i) => c.padEnd(w[i])).join("  ").trimEnd());
  lines.splice(1, 0, w.map((n) => "-".repeat(n)).join("  "));
  const extra: string[] = [];
  for (const e of list) {
    for (const n of e.notes) extra.push(`  [${e.agent}] ${n}`);
    if (e.writablePaths.length) extra.push(`  [${e.agent}] writes outside repo: ${e.writablePaths.map((p) => p.replace(process.env.HOME ?? "", "~")).join(", ")}`);
  }
  return [...lines, ...(extra.length ? ["", ...extra] : [])].join("\n");
}

