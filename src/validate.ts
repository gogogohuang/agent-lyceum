import fs from "node:fs";
import type { ResolvedAgent, ResolvedProject } from "./config.js";
import { enforcementFor, memoryDirs, type AgentEnforcement, type Level } from "./policy.js";
import { describeConflict, fallbackCapExcess, sandboxConflictsOf } from "./sandbox-invocation.js";
import { isInside } from "./paths.js";
import { inferRuntime, RUNTIME_EFFORTS, RUNTIMES } from "./schema.js";
import { ladderIndex } from "./tiers.js";
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

  for (const rt of RUNTIMES) {
    const ladder = project.modelTiers[rt];
    if (!ladder) continue;
    const seen = new Set<string>();
    ladder.forEach((m, i) => {
      const other = inferRuntime(m);
      if (other !== rt) err(`model_tiers.${rt}[${i}]: "${m}" is not a ${rt} model (recognised as ${other ?? "nothing"}). List only ${rt} models, lowest first.`);
      const k = m.trim().toLowerCase();
      if (seen.has(k)) err(`model_tiers.${rt}: "${m}" is listed twice.`);
      seen.add(k);
    });
  }

  for (const a of Object.values(project.agents)) {
    const ladder = a.runtime ? project.modelTiers[a.runtime] : undefined;
    if (a.runtime && ladder) {
      if (!a.model) warn(`Agent "${a.name}" has no model, so model_tiers.${a.runtime} does not apply to it: it always runs on its runtime's default model.`);
      else if (ladderIndex(ladder, a.model) < 0) {
        err(`Agent "${a.name}": model "${a.model}" is not on model_tiers.${a.runtime} (${ladder.join(", ")}). Add it to the ladder, or set model_tiers.${a.runtime}: [] in project.yaml to turn the ladder off for this project.`);
      }
    }
    if (!a.runtime) err(`Agent "${a.name}" has no runtime (set runtime, or a recognizable model such as opus/sonnet/haiku/claude-* or gpt-*/codex-*).`);
    const modelRuntime = inferRuntime(a.model);
    if (a.runtime && modelRuntime && modelRuntime !== a.runtime) {
      warn(`Agent "${a.name}": model "${a.model}" looks like a ${modelRuntime} model but runtime is ${a.runtime}.`);
    }
    if (a.effort && a.runtime && !RUNTIME_EFFORTS[a.runtime].includes(a.effort)) {
      err(`Agent "${a.name}": effort "${a.effort}" is not supported by ${a.runtime} (use ${RUNTIME_EFFORTS[a.runtime].join(", ")}).`);
    }
    validateFallback(project, a, err);
    for (const c of sandboxConflictsOf(project, a, false)) err(describeConflict(a.name, c, "load"));
    for (const f of fallbackCapExcess(a)) err(`agent ${a.name}: fallback ${f.label} would apply more sandbox allowance than the primary (${f.excess.join("; ")}).`);
    if (!fs.existsSync(a.agentMd)) err(`Agent "${a.name}": AGENT.md not found at ${a.agentMd}`);
    if (!a.memory.global && !a.memory.project) warn(`Agent "${a.name}" has no long-term memory configured.`);
    if (a.canMessage !== "all") {
      for (const t of a.canMessage) {
        if (!project.agents[t]) err(`Agent "${a.name}": can_message target "${t}" is not in the team.`);
        if (t === a.name) warn(`Agent "${a.name}" lists itself in can_message.`);
      }
    }
  }

  if (Object.keys(project.modelTiers).length > 0 && !Object.values(project.agents).some((a) => a.name !== project.lead && a.tiers)) {
    warn("model_tiers is set, but no member can run below its model (each member's model is the lowest entry of its ladder): tiers have no effect.");
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

const PARITY_FIELDS = ["memory", "agentMd", "otherContext", "shared", "repoInstructions"] as const;
const norm = (m: string | undefined) => (m ?? "").trim().toLowerCase();

/** Load-time (fail closed) checks of one agent's fallback chain: well-formed, not a no-op, and no weaker at write-scope than the primary. */
function validateFallback(project: ResolvedProject, a: ResolvedAgent, err: (message: string) => void): void {
  for (const bad of a.fallbackInvalid) {
    err(
      bad.reason === "empty"
        ? `agent ${a.name}: fallback #${bad.index + 1} needs a model or a runtime.`
        : `agent ${a.name}: fallback #${bad.index + 1} has no recognizable runtime (set runtime, or use a recognizable model).`,
    );
  }
  const primary = a.runtime ? enforcementFor(project, a) : undefined;
  for (const f of a.fallback) {
    const label = `${f.runtime}/${f.model || "(default model)"}`;
    if (f.runtime === a.runtime && norm(f.model) === norm(a.model)) {
      // A chain shared through dispatcher.fallback may already contain this agent's primary: just skip it then.
      if (!a.fallbackShared) err(`agent ${a.name}: fallback ${label} is the same as the primary runtime and model.`);
      continue;
    }
    if (f.effort && !RUNTIME_EFFORTS[f.runtime].includes(f.effort)) {
      err(`agent ${a.name}: fallback ${label}: effort "${f.effort}" is not supported by ${f.runtime} (use ${RUNTIME_EFFORTS[f.runtime].join(", ")}).`);
    }
    if (!primary) continue;
    // `prompt-only` is the one level that is no enforcement at all; everything else (os, tool-rules, post-hoc) still holds the line.
    const swapped = enforcementFor(project, { ...a, runtime: f.runtime, model: f.model || undefined, effort: f.effort });
    for (const k of PARITY_FIELDS) {
      const from: Level = primary[k];
      const to: Level = swapped[k];
      if (from === "n/a" || to === "n/a") continue;
      if (to === "prompt-only" && from !== "prompt-only") err(`agent ${a.name}: fallback ${label} cannot enforce ${k} (${from} -> ${to})`);
    }
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

