export const DEFAULT_MAX_AWAKE = 8;

/** How many of `pending` may wake together. The lead wakes alone. Shared mode wakes one. */
export function capBatch<T extends { name: string }>(pending: readonly T[], leadName: string, mode: "worktree" | "shared", maxAwake: number): T[] {
  const lead = pending.find((a) => a.name === leadName);
  if (lead) return [lead];
  if (mode !== "worktree") return pending[0] ? [pending[0]] : [];
  const n = Math.max(maxAwake, 1);
  return pending.slice(0, n);
}
