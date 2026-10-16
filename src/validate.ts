import fs from "node:fs";
import type { ResolvedAgent, ResolvedProject } from "./config.js";
import { enforcementFor, memoryDirs, type AgentEnforcement } from "./policy.js";
import { isInside } from "./paths.js";
import { inferRuntime, RUNTIME_CAPS, RUNTIME_EFFORTS } from "./schema.js";
import { must } from "./assert.js";

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

  if (names.length < 2) err(`A team needs at least 2 agents: the lead and one member (found ${names.length}).`);
  if (!project.agents[project.lead]) err(`Lead "${project.lead}" is not listed under agents.`);
  if (!fs.existsSync(project.dir) || !fs.statSync(project.dir).isDirectory()) {
    err(`Project dir does not exist: ${project.dir}`);
  }

  for (const a of Object.values(project.agents)) {
    if (!a.runtime) err(`Agent "${a.name}" has no runtime (set runtime, or a recognizable model such as opus/sonnet/haiku/claude-* or gpt-*/codex-*).`);
    const modelRuntime = inferRuntime(a.model);
    if (a.runtime && modelRuntime && modelRuntime !== a.runtime) {
      warn(`Agent "${a.name}": model "${a.model}" looks like a ${modelRuntime} model but runtime is ${a.runtime}.`);
    }
    if (a.effort && a.runtime && !RUNTIME_EFFORTS[a.runtime].includes(a.effort)) {
      err(`Agent "${a.name}": effort "${a.effort}" is not supported by ${a.runtime} (use ${RUNTIME_EFFORTS[a.runtime].join(", ")}).`);
    }
    validateFallback(a, err);
    if (!fs.existsSync(a.agentMd)) err(`Agent "${a.name}": AGENT.md not found at ${a.agentMd}`);
    if (!a.memory.global && !a.memory.project) warn(`Agent "${a.name}" has no long-term memory configured.`);
    if (a.canMessage !== "all") {
      for (const t of a.canMessage) {
        if (!project.agents[t]) err(`Agent "${a.name}": can_message target "${t}" is not in the team.`);
        if (t === a.name) warn(`Agent "${a.name}" lists itself in can_message.`);
      }
    }
  }

  // Memory directories must not overlap between agents (or equal each other).
  const mem: { agent: string; dir: string }[] = [];
  for (const a of Object.values(project.agents)) for (const d of memoryDirs(a)) mem.push({ agent: a.name, dir: d });
  for (let i = 0; i < mem.length; i++) {
    for (let j = i + 1; j < mem.length; j++) {
      const x = must(mem[i], "memory dir");
      const y = must(mem[j], "memory dir");
      if (x.agent === y.agent && x.dir !== y.dir) continue;
      if (isInside(x.dir, y.dir) || isInside(y.dir, x.dir)) {
        err(`Memory dirs overlap: "${x.agent}" ${x.dir} vs "${y.agent}" ${y.dir}`);
      }
    }
  }

  for (const ig of project.ignoredSettings ?? []) {
    warn(`${ig.file}: ignoring removed setting(s) ${ig.keys.join(", ")}. Concurrency needs no configuration now: in a git repo with a commit every run and every agent gets its own worktree. Delete these lines.`);
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
      for (const k of ["memory", "agentMd", "otherContext", "shared"] as const) {
        if (e[k] !== "os" && !(k === "shared" && e[k] === "n/a")) err(`strict: agent "${e.agent}" ${k} protection is "${e[k]}", not OS-enforced.`);
      }
    }
  }

  return { issues, enforcement, ok: !issues.some((i) => i.level === "error") };
}

/** Load-time (fail closed) checks of one agent's fallback chain: well-formed, not a no-op, and able to keep the agent's restrictions. */
function validateFallback(a: ResolvedAgent, err: (message: string) => void): void {
  for (const bad of a.fallbackInvalid) {
    err(
      bad.reason === "empty"
        ? `agent ${a.name}: fallback #${bad.index + 1} needs a model or a runtime.`
        : `agent ${a.name}: fallback #${bad.index + 1} has no recognizable runtime (set runtime, or use a recognizable model).`,
    );
  }
  for (const f of a.fallback) {
    const label = `${f.runtime}/${f.model || "(default model)"}`;
    if (f.effort && !RUNTIME_EFFORTS[f.runtime].includes(f.effort)) {
      err(`agent ${a.name}: fallback ${label}: effort "${f.effort}" is not supported by ${f.runtime} (use ${RUNTIME_EFFORTS[f.runtime].join(", ")}).`);
    }
    if (f.runtime === a.runtime && f.model === (a.model ?? "")) err(`agent ${a.name}: fallback ${label} is the same as the primary runtime and model.`);
    const caps = RUNTIME_CAPS[f.runtime];
    if (a.allowWeb && !caps.webLevels.includes(a.allowWeb)) err(`agent ${a.name}: fallback ${label} cannot enforce allow_web: ${a.allowWeb}`);
    if (!a.canAskUser && !caps.canAskUser) err(`agent ${a.name}: fallback ${label} cannot enforce can_ask_user: false`);
    if (!caps.worktree) err(`agent ${a.name}: fallback ${label} cannot enforce worktree isolation`);
  }
}

export function formatEnforcement(list: AgentEnforcement[]): string {
  const header = ["agent", "runtime", "memory", "AGENT.md", "others' ctx", "handoff", "repo CLAUDE/AGENTS"];
  const rows = [header];
  for (const e of list) rows.push([e.agent, e.runtime, e.memory, e.agentMd, e.otherContext, e.shared, e.repoInstructions]);
  const w = header.map((_, i) => Math.max(...rows.map((r) => (r[i] ?? "").length)));
  const lines = rows.map((r) => r.map((c, i) => c.padEnd(w[i] ?? 0)).join("  ").trimEnd());
  lines.splice(1, 0, w.map((n) => "-".repeat(n)).join("  "));
  const extra: string[] = [];
  for (const e of list) {
    for (const n of e.notes) extra.push(`  [${e.agent}] ${n}`);
    if (e.writablePaths.length) extra.push(`  [${e.agent}] writes outside repo: ${e.writablePaths.map((p) => p.replace(process.env.HOME ?? "", "~")).join(", ")}`);
  }
  return [...lines, ...(extra.length ? ["", ...extra] : [])].join("\n");
}

