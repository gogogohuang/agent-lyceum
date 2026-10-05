import fs from "node:fs";
import path from "node:path";
import { assertName, homePaths, projectPaths } from "./paths.js";

const PERSONAS: Record<string, string> = {
  lead: `# Lead

You coordinate the team. You receive the user's task, break it into concrete pieces, and delegate each piece to the right teammate by mail.

- Keep \`COMMON.md\` (shared team context: goal, architecture decisions, conventions) accurate and short.
- When a teammate reports back, decide the next step: assign follow-up work, ask another teammate to verify, or accept the result.
- Teammates cannot message each other by default; route everything through yourself.
- When the whole job is verified and finished, send a \`done\` message summarising what was delivered.
`,
  "fe-member": `# Frontend member

You implement frontend work assigned by the lead: components, pages, styling, client-side logic.

- Read the lead's message carefully and restate the acceptance criteria to yourself before editing.
- Keep changes small and focused; run the project's own checks (lint, type-check, tests) when they exist.
- Reply to the lead with what you changed (files), how you verified it, and anything left open.
`,
  "qa-member": `# QA member

You verify work: run and write tests, reproduce bugs, and review changes against the acceptance criteria.

- Do not fix product code yourself unless the lead asks; report findings to the lead with clear reproduction steps.
- Prefer concrete evidence (commands run, output, failing test names) over opinions.
- Reply to the lead with a pass/fail verdict and a prioritised list of issues.
`,
};

const GLOBAL_TEAM_YAML = `# Global agent library. Projects pick agents from here by name and may override any field.
# Relative paths here are resolved against this folder. "~" is allowed.
agents:
  lead:
    runtime: claude-code        # claude-code | codex
    agent_md: agents/lead/AGENT.md
    memory: { global: agents/lead/memory }
  fe-member:
    runtime: claude-code
    agent_md: agents/fe-member/AGENT.md
    memory: { global: agents/fe-member/memory }
  qa-member:
    runtime: claude-code
    agent_md: agents/qa-member/AGENT.md
    memory: { global: agents/qa-member/memory }
`;

export interface InitResult {
  home: string;
  created: string[];
  skipped: string[];
}

export function initHome(home: string): InitResult {
  const hp = homePaths(home);
  const created: string[] = [];
  const skipped: string[] = [];
  const writeOnce = (file: string, content: string) => {
    if (fs.existsSync(file)) {
      skipped.push(file);
      return;
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    created.push(file);
  };
  fs.mkdirSync(hp.projectsDir, { recursive: true });
  writeOnce(hp.globalConfig, GLOBAL_TEAM_YAML);
  for (const [name, text] of Object.entries(PERSONAS)) {
    writeOnce(path.join(hp.globalAgentsDir, name, "AGENT.md"), text);
    fs.mkdirSync(path.join(hp.globalAgentsDir, name, "memory"), { recursive: true });
  }
  return { home, created, skipped };
}

export function addProject(home: string, name: string, dir: string): { root: string; config: string } {
  assertName("project", name);
  const hp = homePaths(home);
  if (!fs.existsSync(hp.globalConfig)) {
    throw new Error(`Not initialised: ${hp.globalConfig} is missing. Run \`agent-team init\` first.`);
  }
  const repo = path.resolve(dir);
  if (!fs.existsSync(repo) || !fs.statSync(repo).isDirectory()) throw new Error(`--dir is not a directory: ${repo}`);
  const pp = projectPaths(home, name);
  if (fs.existsSync(pp.config)) throw new Error(`Project "${name}" already exists (${pp.config}).`);

  fs.mkdirSync(path.join(pp.shared, "common"), { recursive: true });
  fs.mkdirSync(pp.runs, { recursive: true });
  const yaml = `# Project "${name}". Paths here are relative to this folder; "~" is allowed.
dir: ${repo}            # the repo the agents work in (the tool never writes config into it)
team:
  lead: lead
dispatcher:
  max_rounds: 30        # stop after this many agent wake-ups
  max_parallel: 1       # >1 needs non-overlapping "owns" for every non-lead agent
  wake_timeout_sec: 600
  retry: 1
  strict: false         # true = refuse to start unless context protection is OS-enforced
agents:
  # Fields not set here are inherited from the global team.yaml.
  lead:
    resume: true        # keep the lead's session between wake-ups
    can_message: all
    can_edit_agent_md: true
  fe-member:
    can_message: [lead]
    # owns: ["src/web/**"]
    # memory: { project: agents/fe-member/memory }
  qa-member:
    can_message: [lead]
    # owns: ["tests/**"]
`;
  fs.writeFileSync(pp.config, yaml);
  const common = path.join(pp.shared, "common", "COMMON.md");
  if (!fs.existsSync(common)) {
    fs.writeFileSync(
      common,
      `# ${name} — shared team context\n\n(The lead maintains this file. Goal, architecture decisions, conventions. Keep it under 8 KB.)\n`,
    );
  }
  return { root: pp.root, config: pp.config };
}

export function removeProject(home: string, name: string, purge: boolean): string {
  const pp = projectPaths(home, name);
  if (!fs.existsSync(pp.config)) throw new Error(`Project "${name}" is not registered.`);
  if (purge) {
    fs.rmSync(pp.root, { recursive: true, force: true });
    return `Removed ${pp.root} (registration and all context).`;
  }
  const dest = `${pp.config}.removed-${Date.now()}`;
  fs.renameSync(pp.config, dest);
  return `Unregistered "${name}". Context kept in ${pp.root} (config renamed to ${path.basename(dest)}). Use --purge to delete it.`;
}
