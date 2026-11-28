import type { ResolvedProject } from "./config.js";
import { roleOfName } from "./instances.js";

export function crossRuntimeBlock(
  project: ResolvedProject,
  state: {
    reviews?: readonly { reviewer: string; verdict: string; at: string }[];
    /** `at` is when the files were integrated. A record with no `at` counts only when this segment has no reopen. */
    implementers?: readonly { agent: string; at?: string }[];
    reopened?: readonly { at: string }[];
    wakes?: readonly { agent: string; at: string; runtime?: string; read_only?: boolean; handling: readonly { type: string }[] }[];
  },
  _mode: "worktree" | "shared",
): string | undefined {
  if (project.verify?.cross_runtime === false) return undefined;
  const configured = Object.values(project.agents).map((a) => a.runtime);
  if (configured.length > 0 && configured.every((r) => r === configured[0])) return undefined;

  const since = state.reopened?.length ? state.reopened[state.reopened.length - 1]!.at : "";
  const role = (name: string) => roleOfName(project.agents, name);
  const runtimeOf = (name: string): string | undefined => {
    const key = role(name);
    const last = [...(state.wakes ?? [])].reverse().find((w) => w.at >= since && w.runtime && role(w.agent) === key);
    return last?.runtime ?? project.agents[key]?.runtime ?? project.agents[name]?.runtime;
  };

  // Authors are people whose files were integrated in this segment. Handling a task, even without `read_only: true`, is not authorship.
  const authors = new Set<string>();
  for (const i of state.implementers ?? []) {
    if (since && (i.at === undefined || i.at < since)) continue;
    authors.add(role(i.agent));
  }
  const authorRuntimes = new Set<string>();
  for (const name of authors) {
    const rt = runtimeOf(name);
    if (rt) authorRuntimes.add(rt);
  }
  if (authorRuntimes.size === 0) {
    const leadRt = runtimeOf(project.lead);
    if (leadRt) authorRuntimes.add(leadRt);
  }

  const names = Object.keys(project.agents)
    .filter((name) => name !== project.lead && !authorRuntimes.has(runtimeOf(name) ?? ""))
    .sort();
  // Nobody can give the pass (only the lead is on the other runtime, or every other-runtime teammate wrote code). Do not block.
  if (names.length === 0) return undefined;
  const passed = (state.reviews ?? []).some((r) => r.verdict === "pass" && r.at >= since && names.includes(role(r.reviewer)));
  if (passed) return undefined;
  return `A completed report needs \`verdict: pass\` from a teammate whose runtime is not the implementer's. Teammates who can give it: ${names.join(", ")}.`;
}

/**
 * What `doctor` can see before a run. A team lead does not edit the repository; a one-line fix is `run --agent`.
 * When nobody but the lead is on another runtime, a completed done does not wait for a pass. Solo runs are out of this.
 */
export function teamRunFindings(project: ResolvedProject): { level: "info" | "warn"; message: string }[] {
  if (project.solo) return [];
  const lead = project.agents[project.lead];
  if (!lead) return [];
  const others = Object.values(project.agents).filter((a) => a.name !== project.lead);
  const findings: { level: "info" | "warn"; message: string }[] = [
    {
      level: "info",
      message: `On a team run, ${project.lead} does not edit the repository, including CLAUDE.md and AGENTS.md. A one-line fix is \`run --agent <name>\` of the agent who writes it.`,
    },
  ];
  const reachable = lead.canMessage === "all" ? others.map((a) => a.name) : others.filter((a) => lead.canMessage.includes(a.name)).map((a) => a.name);
  if (reachable.length === 0) {
    findings.push({
      level: "warn",
      message: `${project.lead} cannot send work to a teammate, so a team run cannot land a code change. Use \`run --agent <name>\` of the agent who writes it.`,
    });
  }
  const memberRuntimes = others.map((a) => a.runtime).filter((r): r is NonNullable<typeof r> => !!r);
  const configured = Object.values(project.agents).map((a) => a.runtime).filter((r): r is NonNullable<typeof r> => !!r);
  const mixed = configured.length > 1 && configured.some((r) => r !== configured[0]);
  if (mixed && memberRuntimes.length > 0 && memberRuntimes.every((r) => r === memberRuntimes[0]) && memberRuntimes[0] !== lead.runtime) {
    findings.push({
      level: "info",
      message: `Every teammate except ${project.lead} uses ${memberRuntimes[0]}. A completed done does not wait for a cross-runtime pass then, because nobody else can give one. Set \`verify.cross_runtime: false\` to turn the gate off.`,
    });
  }
  return findings;
}
