import { ConfigError, type ResolvedProject } from "./config.js";

/**
 * The project as `run --agent <name>` sees it: `name` is the lead of a team of one, so the task goes to it and its `done` ends the run.
 * It cannot mail anyone, ask the user, edit any AGENT.md or share the repo with a parallel agent. The other members stay listed, only
 * so that their files stay protected; nobody mails them, so they are never woken.
 * `globalAgents` (names in team.yaml) only improves the error message.
 */
export function soloProject(project: ResolvedProject, name: string, hints: { globalAgents?: string[] } = {}): ResolvedProject {
  const a = project.agents[name];
  if (!a) {
    const call = hints.globalAgents?.includes(name) ? ` "${name}" is in the global library: use \`agent-lyceum call ${name}\` to run it outside the project.` : "";
    throw new ConfigError(`Agent "${name}" is not a member of project "${project.name}" (members: ${Object.keys(project.agents).join(", ")}).${call}`);
  }
  return {
    ...project,
    solo: "run",
    lead: name,
    dispatcher: { ...project.dispatcher, max_parallel: 1, workspace_mode: "shared" },
    agents: { ...project.agents, [name]: { ...a, canMessage: [], canAskUser: false, canEditAgentMd: false, owns: [] } },
  };
}

/** `project` with only `name` listed: what a preflight of a solo run needs to look at. */
export function onlyAgent(project: ResolvedProject, name: string): ResolvedProject {
  const a = project.agents[name];
  if (!a) throw new ConfigError(`Agent "${name}" is not a member of project "${project.name}" (members: ${Object.keys(project.agents).join(", ")}).`);
  return { ...project, agents: { [name]: a } };
}
