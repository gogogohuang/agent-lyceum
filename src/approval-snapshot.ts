import path from "node:path";
import { type CandidateSnapshot, type GrantInput, type SnapshotInput, staticWritable } from "./approval-origin.js";
import { type ExecutorsConfig, qualificationOf } from "./approval-executors.js";
import type { WritableSet } from "./approval-types.js";
import type { ResolvedAgent, ResolvedProject } from "./config.js";
import { agentForCandidate, candidatesFor } from "./fallback.js";
import { roleOfName } from "./instances.js";
import { canonicalPath } from "./paths.js";
import { type GrantEntry, type GrantSource, grantEntries } from "./policy.js";
import { type InstanceTable, bindRunProject } from "./run-store.js";
import { soloProject } from "./solo.js";

/**
 * The qualification snapshot of an approval slot (plan D7). One definition of "what the slot may write", shared by the wake gate
 * (session project), the collector (the project the wake actually ran with) and a future approve (an unbound, virtual binding).
 * All three must reach the same hash: run-only entries are removed from it, and the lead's repo instruction files are judged by
 * their logical place in the project directory, so a worktree copy does not change it.
 */

/** Grants that exist only inside one run, so they never take part in the run-independent hash. */
export const RUN_ONLY_SOURCES: ReadonlySet<GrantSource> = new Set<GrantSource>(["memory-task", "outbox", "git-dir", "shared", "shared-index", "approval-request"]);

const split = (entries: readonly GrantEntry[], pick: (e: GrantEntry) => string): WritableSet => ({
  dirs: entries.filter((e) => e.kind === "dir").map(pick),
  files: entries.filter((e) => e.kind === "file").map(pick),
});

const inSet = (e: GrantEntry, set: WritableSet, pick: (e: GrantEntry) => string): boolean => (e.kind === "dir" ? set.dirs : set.files).includes(pick(e));

/**
 * `full` is what an adapter really receives (canonical, sorted, unique). `grant` is the input of `staticWritable`: the same entries, except that a
 * `repo-instruction` path is the logical one (`<project dir>/<name>`), `run_only` holds the run-only paths, and `static_duplicates` the paths that also
 * have a static (non run-only) source, so a path is dropped from the hash only when every source of it is run-only.
 */
export function slotGrants(project: ResolvedProject, agent: ResolvedAgent, requestDir?: string): { full: WritableSet; grant: GrantInput } {
  const entries = grantEntries(project, agent, requestDir);
  const real = (e: GrantEntry): string => canonicalPath(e.path);
  const logical = (e: GrantEntry): string => (e.source === "repo-instruction" ? canonicalPath(path.join(project.dir, path.basename(e.path))) : canonicalPath(e.path));
  const none: WritableSet = { dirs: [], files: [] };
  const full = staticWritable({ effective: split(entries, real), run_only: none, static_duplicates: none });
  const runOnlyEntries = entries.filter((e) => RUN_ONLY_SOURCES.has(e.source));
  const run_only = split(runOnlyEntries, logical);
  const static_duplicates = split(
    entries.filter((e) => !RUN_ONLY_SOURCES.has(e.source) && inSet(e, run_only, logical)),
    logical,
  );
  return { full, grant: { effective: split(entries, logical), run_only, static_duplicates } };
}

/**
 * What `qualificationHash` is computed from, for each executor `slot`'s role may use, plus `full`. `bound` is a run-bound project.
 * `enrolled` and `approval` are dropped before the policy is built, so no approval deny scan runs (the allow lists do not depend on them).
 */
export function snapshotInputs(project: ResolvedProject, slot: string, config: ExecutorsConfig, requestDir?: string): { full: WritableSet; inputs: Map<string, SnapshotInput> } {
  const inputs = new Map<string, SnapshotInput>();
  const agent = project.agents[slot];
  if (!agent) return { full: { dirs: [], files: [] }, inputs };
  const role = roleOfName(project.agents, slot);
  const { executors } = qualificationOf(config, { project: project.solo === "call" ? null : project.name, role });
  const { enrolled: _e, approval: _a, ...plain } = agent;
  if (executors.length === 0) return { full: { dirs: [], files: [] }, inputs };
  const { full, grant } = slotGrants(project, plain as ResolvedAgent, requestDir);
  const writable = staticWritable(grant);
  const candidates: CandidateSnapshot[] = candidatesFor(agent).map((c) => {
    const eff = agentForCandidate(agent, c);
    return {
      runtime: c.runtime,
      sandbox: eff.sandbox ? { write: [...eff.sandbox.write], network: [...eff.sandbox.network], local_binding: eff.sandbox.localBinding, unix_sockets: [...eff.sandbox.unixSockets] } : null,
      allow_web: eff.allowWeb ?? null,
    };
  });
  for (const name of executors) {
    const executor = config.executors[name];
    if (executor) inputs.set(name, { runtime_candidates: candidates, writable, project_dir: canonicalPath(project.dir), executor });
  }
  return { full, inputs };
}

/**
 * The same inputs from a project that is not bound to any run (a future approve): bound to a virtual run folder that is never created or read.
 * `mode: "solo"` rebuilds the project as a solo run of `slot` (that changes the lead and `canEditAgentMd`); instances come from a synthesized table.
 */
export function unboundSnapshotInputs(unbound: ResolvedProject, slot: string, config: ExecutorsConfig, instances: InstanceTable | undefined, mode: "normal" | "solo"): Map<string, SnapshotInput> {
  const base = mode === "solo" ? soloProject(unbound, slot) : unbound;
  const bound = bindRunProject(base, path.join(unbound.paths.runs, ".approval-virtual-run"), "run", instances);
  return snapshotInputs(bound, slot, config).inputs;
}
