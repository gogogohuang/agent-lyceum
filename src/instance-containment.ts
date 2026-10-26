import type { ResolvedProject } from "./config.js";
import { containmentConflict, slotName, slotWritableRoots } from "./instances.js";
import { canonicalPath } from "./paths.js";
import { writePolicy } from "./policy.js";
import { type MailLayout, bindRunProject } from "./run-store.js";
import { type AgentWorkspace, recordedGitDir, workspaceRoot } from "./worktree.js";

export interface InstanceContainment {
  /** Why instance `k` of `role` must not exist (it could write the role's shared memory), judged on the paths it will get; undefined when fine. */
  check: (role: string, k: number) => string | undefined;
  /** The same judgment with the worktree it actually got (root and git dir). */
  checkWorkspace: (role: string, k: number, ws: Pick<AgentWorkspace, "root" | "gitDir">) => string | undefined;
}

/**
 * D-17 as one object per run: reads the file system only through `canonicalPath` (lstat/realpath), writes nothing. The shared memory of a role
 * is its `memory.global`/`memory.project`; an instance k >= 2 may write its task memory, outbox, worktree and git dir, none of which may
 * contain or lie inside the shared memory (the OS sandbox and the Codex writable roots are built from the same paths).
 */
export function instanceContainment(base: ResolvedProject, runDir: string, layout: MailLayout, platform: NodeJS.Platform = process.platform): InstanceContainment {
  const runId = runDir.split(/[\\/]/).filter(Boolean).pop() ?? "";
  const judge = (role: string, k: number, work: string[]): string | undefined => {
    const agent = base.agents[role];
    const shared = [agent?.memory.global, agent?.memory.project].filter((x): x is string => !!x);
    if (!shared.length || k < 2) return undefined;
    const slots = Array.from({ length: k }, (_, i) => slotName(role, i + 1));
    const bound = bindRunProject(base, runDir, layout, { roles: { [role]: slots } });
    const inst = bound.agents[slotName(role, k)];
    if (!inst) return undefined;
    const roots = slotWritableRoots(writePolicy(bound, inst), work);
    const c = containmentConflict(shared, roots, canonicalPath, platform === "darwin");
    return c ? `could write the shared memory ${c.shared} of "${role}": its writable path ${c.root} contains it or lies inside it` : undefined;
  };
  return {
    check: (role, k) => {
      // An instance that already has a worktree is judged on the git dir recorded for it (read-only), not only on the predicted root.
      const slot = slotName(role, k);
      const gitDir = recordedGitDir(base, runId, slot);
      return judge(role, k, [workspaceRoot(base, runId, slot), ...(gitDir ? [gitDir] : [])]);
    },
    checkWorkspace: (role, k, ws) => judge(role, k, [ws.root, ws.gitDir]),
  };
}
