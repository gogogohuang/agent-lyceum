import fs from "node:fs";
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
  const raw = opt ?? process.env.AGENT_LYCEUM_HOME ?? path.join(os.homedir(), "agent-lyceum-config");
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
    inboxRoot: path.join(shared, "inbox"),
    outboxRoot: path.join(shared, "outbox"),
    runs: path.join(root, "runs"),
    taskMemory: path.join(root, "task-memory"),
  };
}

/** True when a relative path leaves its base: it is `..`, starts with a `..` segment, or is absolute. A name like `..x` is not an escape. */
export function escapesParent(rel: string, sep: string = path.sep): boolean {
  return rel === ".." || rel.startsWith(`..${sep}`) || path.isAbsolute(rel);
}

/** True when `child` is `parent` or inside it. */
export function isInside(parent: string, child: string): boolean {
  return !escapesParent(path.relative(parent, child));
}

/**
 * `p` with symlinks resolved as far as it exists: the real path of its deepest existing ancestor plus the rest. A path that does not exist
 * yet (a directory about to be made) still compares equal to the same place reached through a symlink.
 */
export function canonicalPath(p: string): string {
  const abs = path.resolve(p);
  const rest: string[] = [];
  let head = abs;
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(head), ...rest);
    } catch {
      const up = path.dirname(head);
      if (up === head) return abs;
      rest.unshift(path.basename(head));
      head = up;
    }
  }
}
