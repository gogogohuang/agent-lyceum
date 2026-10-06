import os from "node:os";
import path from "node:path";

export const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

/** Resolve a path from a config file: expand `~`, then resolve relative to `base`. */
export function absPath(p: string, base: string): string {
  return path.resolve(base, expandHome(p));
}

export function resolveHome(opt?: string): string {
  const raw = opt ?? process.env.AGENT_TEAM_HOME ?? path.join(os.homedir(), "agent-team-config");
  return path.resolve(expandHome(raw));
}

export function assertName(kind: string, name: string): void {
  if (!NAME_RE.test(name)) {
    throw new Error(`Invalid ${kind} name "${name}": use letters, digits, "-" or "_" (must not start with "-" or "_").`);
  }
}

export interface HomePaths {
  home: string;
  globalConfig: string;
  globalAgentsDir: string;
  projectsDir: string;
}

export function homePaths(home: string): HomePaths {
  return {
    home,
    globalConfig: path.join(home, "team.yaml"),
    globalAgentsDir: path.join(home, "agents"),
    projectsDir: path.join(home, "projects"),
  };
}

export interface ProjectPaths {
  root: string;
  config: string;
  agentsDir: string;
  shared: string;
  common: string;
  inboxRoot: string;
  outboxRoot: string;
  runs: string;
  /** Per-task memory: <taskMemory>/<run-id>/<agent>. Never shared between runs. */
  taskMemory: string;
}

export function projectPaths(home: string, project: string): ProjectPaths {
  const root = path.join(home, "projects", project);
  const shared = path.join(root, "shared");
  return {
    root,
    config: path.join(root, "project.yaml"),
    agentsDir: path.join(root, "agents"),
    shared,
    common: path.join(shared, "COMMON.md"),
    inboxRoot: path.join(shared, "inbox"),
    outboxRoot: path.join(shared, "outbox"),
    runs: path.join(root, "runs"),
    taskMemory: path.join(root, "task-memory"),
  };
}

/** True when `child` is `parent` or inside it. */
export function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** Directory part of a glob that precedes the first wildcard segment. */
export function globStaticPrefix(glob: string): string {
  const segs = glob.split("/");
  const out: string[] = [];
  for (const s of segs) {
    if (/[*?[\]{}]/.test(s)) break;
    out.push(s);
  }
  return out.join("/");
}
