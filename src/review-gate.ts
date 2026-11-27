import type { ResolvedProject } from "./config.js";
import { roleOfName } from "./instances.js";

export function crossRuntimeBlock(
  project: ResolvedProject,
  state: {
    reviews?: readonly { reviewer: string; verdict: string; at: string }[];
    implementers?: readonly { agent: string }[];
    reopened?: readonly { at: string }[];
    wakes?: readonly { agent: string; at: string; runtime?: string; read_only?: boolean; handling: readonly { type: string }[] }[];
  },
  mode: "worktree" | "shared",
): string | undefined {
  const configured = Object.values(project.agents).map((a) => a.runtime);
  if (configured.length > 0 && configured.every((r) => r === configured[0])) return undefined;

  const since = state.reopened?.length ? state.reopened[state.reopened.length - 1]!.at : "";
  const role = (name: string) => roleOfName(project.agents, name);
  const runtimeOf = (name: string): string | undefined => {
    const key = role(name);
    const last = [...(state.wakes ?? [])].reverse().find((w) => w.at >= since && w.runtime && role(w.agent) === key);
    return last?.runtime ?? project.agents[key]?.runtime ?? project.agents[name]?.runtime;
  };

  const authors = new Set<string>();
  for (const i of state.implementers ?? []) authors.add(role(i.agent));
  if (mode === "shared") {
    for (const w of state.wakes ?? []) {
      if (w.at < since || w.agent === project.lead || w.read_only === true) continue;
      if (!w.handling.some((h) => h.type === "task")) continue;
      authors.add(role(w.agent));
    }
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
  const passed = (state.reviews ?? []).some((r) => r.verdict === "pass" && r.at >= since && names.includes(role(r.reviewer)));
  if (passed) return undefined;
  const who = names.length ? names.join(", ") : "(none)";
  return `A completed report needs \`verdict: pass\` from a teammate whose runtime is not the implementer's. Teammates who can give it: ${who}.`;
}
