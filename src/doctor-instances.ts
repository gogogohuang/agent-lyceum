import path from "node:path";
import type { DoctorCheck } from "./doctor.js";
import type { ResolvedProject } from "./config.js";
import { DEFAULT_MAX_INSTANCES, instanceCap } from "./instances.js";
import { NAME_RE, canonicalPath, isInside } from "./paths.js";
import { osSandboxAvailable } from "./policy.js";
import { git } from "./worktree.js";

/** Same-role instances (spec 23.13): what doctor says about them. Reads configuration and paths only. */
export function diagnoseInstances(project: ResolvedProject, blocker: string | undefined, platform: NodeJS.Platform = process.platform): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  const written = project.dispatcher.max_instances;
  const max = written ?? DEFAULT_MAX_INSTANCES;
  const add = (level: DoctorCheck["level"], message: string) => checks.push({ level, subject: "instances", message });
  if (written !== undefined && written > 1 && blocker) {
    add("warn", `dispatcher.max_instances is ${written}, but runs here take turns in the checkout (${blocker}): parallel tasks run one at a time.`);
  }
  if (blocker || max <= 1 || project.solo) return checks;

  const asRun = { ...project, run: { id: "doctor", dir: "", layout: "run" as const } };
  const members = Object.keys(project.agents).filter((n) => n !== project.lead);
  const usable: string[] = [];
  for (const role of members) {
    if (!NAME_RE.test(role)) {
      add("info", `"${role}" cannot run as several instances (name is not a valid branch name).`);
      continue;
    }
    const cap = instanceCap(asRun, "worktree", role);
    if (cap.n < max && cap.reason) add("warn", cap.reason);
    if (cap.n > 1) usable.push(role);
  }

  if (!osSandboxAvailable()) {
    for (const role of usable) {
      if (project.agents[role]?.runtime !== "codex") continue;
      add(written !== undefined ? "warn" : "info", `only "${role}" writes its memory; its other instances are only told not to (Codex without an OS sandbox).`);
    }
  }

  // The shared memory must not contain, or lie inside, a folder an extra instance writes: that is under the run data roots.
  const roots = [project.paths.taskMemory, project.paths.runs, path.join(project.paths.root, "worktrees")];
  try {
    roots.push(git(project.dir, ["rev-parse", "--path-format=absolute", "--git-common-dir"]));
  } catch {
    /* not readable: the other roots still count */
  }
  const ci = platform === "darwin";
  const norm = (p: string): string => (ci ? canonicalPath(p).toLowerCase() : canonicalPath(p));
  for (const role of usable) {
    const a = project.agents[role];
    for (const s of [a?.memory.global, a?.memory.project]) {
      if (!s) continue;
      const cs = norm(s);
      const contains = roots.find((r) => isInside(cs, norm(r)));
      const inside = roots.find((r) => isInside(norm(r), cs));
      if (contains) add("warn", `"${role}" runs one task at a time: its memory ${s} contains ${contains}, where its other instances would write. Move the memory elsewhere to allow parallel tasks.`);
      else if (inside) add("warn", `the memory of "${role}" (${s}) is inside ${inside}, where instances write; this may prevent extra instances for some runs. Move the memory elsewhere to be sure parallel tasks are possible.`);
    }
  }
  return checks;
}
