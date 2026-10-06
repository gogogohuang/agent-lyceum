import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import {
  absPath,
  homePaths,
  projectPaths,
  type ProjectPaths,
} from "./paths.js";
import type { AgentWorkspace } from "./worktree.js";
import {
  DISPATCHER_DEFAULTS,
  GlobalConfig,
  ProjectConfig,
  type AgentPartialT,
  type DispatcherSettings,
  type Effort,
  inferRuntime,
  type Runtime,
} from "./schema.js";

export class ConfigError extends Error {}

export type Source = "global" | "project" | "default" | "model";

export interface ResolvedAgent {
  name: string;
  runtime?: Runtime; // undefined => validate() reports an error
  model?: string;
  effort?: Effort;
  agentMd: string;
  memory: { global?: string; project?: string; task?: string };
  resume: boolean;
  canMessage: "all" | string[];
  canEditAgentMd: boolean;
  owns: string[];
  /** Where each field's value came from (for `validate` output). */
  sources: Record<string, Source>;
}

export interface ResolvedProject {
  home: string;
  name: string;
  /** The repo agents work in. */
  dir: string;
  lead: string;
  dispatcher: DispatcherSettings;
  agents: Record<string, ResolvedAgent>;
  paths: ProjectPaths;
  /** Set once the project is bound to one run (see `bindRunProject`): which run, and where its mail lives. */
  run?: { id: string; dir: string; layout: "run" | "legacy" };
  /** Agents working in their own git worktree instead of `dir` (set by the dispatcher for the wake-ups in progress). */
  workspaces?: Record<string, AgentWorkspace>;
}

function readYaml<T extends z.ZodTypeAny>(file: string, schema: T, label: string): z.infer<T> {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    throw new ConfigError(`${label} not found: ${file}`);
  }
  let raw: unknown;
  try {
    raw = YAML.parse(text) ?? {};
  } catch (e) {
    throw new ConfigError(`${label} is not valid YAML (${file}): ${(e as Error).message}`);
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
    throw new ConfigError(`${label} is invalid (${file}):\n${msg}`);
  }
  return parsed.data;
}

export function loadGlobal(home: string) {
  const file = homePaths(home).globalConfig;
  return readYaml(file, GlobalConfig, "Global config");
}

export function loadProjectRaw(home: string, name: string) {
  const file = projectPaths(home, name).config;
  return readYaml(file, ProjectConfig, `Project "${name}" config`);
}

function resolveLayer(p: AgentPartialT | undefined, base: string): AgentPartialT {
  if (!p) return {};
  const out: AgentPartialT = { ...p };
  if (p.agent_md) out.agent_md = absPath(p.agent_md, base);
  if (p.memory) {
    out.memory = {};
    if (p.memory.global) out.memory.global = absPath(p.memory.global, base);
    if (p.memory.project) out.memory.project = absPath(p.memory.project, base);
  }
  return out;
}

export function resolveProject(home: string, name: string): ResolvedProject {
  const g = loadGlobal(home);
  const p = loadProjectRaw(home, name);
  const paths = projectPaths(home, name);
  const hp = homePaths(home);
  const lead = p.team.lead;
  const dispatcher: DispatcherSettings = { ...DISPATCHER_DEFAULTS, ...stripUndef(p.dispatcher) };

  const agents: Record<string, ResolvedAgent> = {};
  for (const agentName of Object.keys(p.agents)) {
    const gl = resolveLayer(g.agents[agentName], home);
    const pl = resolveLayer(p.agents[agentName], paths.root);
    const sources: Record<string, Source> = {};

    const pick = <K extends keyof AgentPartialT>(key: K): AgentPartialT[K] | undefined => {
      if (pl[key] !== undefined) {
        sources[key] = "project";
        return pl[key];
      }
      if (gl[key] !== undefined) {
        sources[key] = "global";
        return gl[key];
      }
      return undefined;
    };

    const projectAgentMd = path.join(paths.agentsDir, agentName, "AGENT.md");
    let agentMd = pick("agent_md");
    if (agentMd === undefined) {
      if (fs.existsSync(projectAgentMd)) {
        agentMd = projectAgentMd;
        sources.agent_md = "project";
      } else {
        agentMd = path.join(hp.globalAgentsDir, agentName, "AGENT.md");
        sources.agent_md = "default";
      }
    }

    const memory: { global?: string; project?: string } = {};
    if (pl.memory?.global) {
      memory.global = pl.memory.global;
      sources["memory.global"] = "project";
    } else if (gl.memory?.global) {
      memory.global = gl.memory.global;
      sources["memory.global"] = "global";
    }
    if (pl.memory?.project) {
      memory.project = pl.memory.project;
      sources["memory.project"] = "project";
    } else if (gl.memory?.project) {
      memory.project = gl.memory.project;
      sources["memory.project"] = "global";
    }
    if (!memory.global && !memory.project) {
      memory.project = path.join(paths.agentsDir, agentName, "memory");
      sources["memory.project"] = "default";
    }

    const model = pick("model");
    // Precedence: project runtime > project model > global runtime > global model.
    // A project-level model must win over an inherited global runtime, or `model: gpt-5` would run on claude.
    let runtime = pl.runtime;
    if (runtime !== undefined) sources.runtime = "project";
    else if ((runtime = inferRuntime(pl.model))) sources.runtime = "model";
    else if ((runtime = gl.runtime)) sources.runtime = "global";
    else if ((runtime = inferRuntime(gl.model))) sources.runtime = "model";

    const isLead = agentName === lead;
    const resume = pick("resume");
    const canMessage = pick("can_message");
    const canEdit = pick("can_edit_agent_md");
    const owns = pick("owns");
    for (const [k, v] of [
      ["resume", resume],
      ["can_message", canMessage],
      ["can_edit_agent_md", canEdit],
      ["owns", owns],
    ] as const) {
      if (v === undefined) sources[k] = "default";
    }

    agents[agentName] = {
      name: agentName,
      runtime,
      model,
      effort: pick("effort"),
      agentMd,
      memory,
      resume: resume ?? isLead,
      canMessage: canMessage ?? (isLead ? "all" : [lead]),
      canEditAgentMd: canEdit ?? isLead,
      owns: owns ?? [],
      sources,
    };
  }

  return {
    home,
    name,
    dir: absPath(p.dir, paths.root),
    lead,
    dispatcher,
    agents,
    paths,
  };
}

function stripUndef<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/** Registered projects: name -> repo dir (best effort; skips broken configs). */
export function listProjects(home: string): { name: string; dir: string }[] {
  const root = homePaths(home).projectsDir;
  if (!fs.existsSync(root)) return [];
  const out: { name: string; dir: string }[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      const raw = loadProjectRaw(home, entry.name);
      out.push({ name: entry.name, dir: absPath(raw.dir, projectPaths(home, entry.name).root) });
    } catch {
      /* ignore broken project */
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Pick the registered project whose dir is the longest prefix of `cwd`. */
export function findProjectForCwd(home: string, cwd: string): string | undefined {
  let best: { name: string; len: number } | undefined;
  for (const pr of listProjects(home)) {
    const rel = path.relative(pr.dir, cwd);
    if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) {
      if (!best || pr.dir.length > best.len) best = { name: pr.name, len: pr.dir.length };
    }
  }
  return best?.name;
}

