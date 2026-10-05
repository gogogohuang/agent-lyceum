import fs from "node:fs";
import path from "node:path";
import { REQUIRED_SECTIONS } from "./format.js";
import type { ResolvedAgent, ResolvedProject } from "./config.js";
import type { Message } from "./mailbox.js";
import { commonFile, memoryDirs, outboxDir } from "./policy.js";

export const COMMON_LIMIT = 8 * 1024;
export const MEMORY_INDEX_LIMIT = 4 * 1024;

function readCapped(file: string, limit: number): { text: string; truncated: boolean } | undefined {
  if (!fs.existsSync(file)) return undefined;
  const buf = fs.readFileSync(file);
  if (buf.length <= limit) return { text: buf.toString("utf8"), truncated: false };
  return { text: buf.subarray(0, limit).toString("utf8"), truncated: true };
}

export function readPersona(agent: ResolvedAgent): string {
  return fs.readFileSync(agent.agentMd, "utf8").trim();
}

/** Everything that goes to the runtime's system prompt: the persona plus the team protocol. */
export function buildSystemPrompt(project: ResolvedProject, agent: ResolvedAgent): string {
  const outbox = outboxDir(project, agent.name);
  const mates = Object.keys(project.agents).filter((n) => n !== agent.name);
  const recipients =
    agent.canMessage === "all" ? mates : agent.canMessage.filter((n) => project.agents[n] && n !== agent.name);
  const isLead = agent.name === project.lead;
  const lines: string[] = [];
  lines.push(readPersona(agent), "", "---", "", "# Team protocol (injected by agent-team)", "");
  lines.push(
    `You are **${agent.name}**, a member of the team "${project.name}". You work in the repository \`${project.dir}\`.`,
    `The team lead is **${project.lead}**${isLead ? " (that is you)" : ""}. Teammates: ${mates.join(", ") || "(none)"}.`,
    "",
    "## Sending mail",
    "You cannot talk to teammates directly. Mail you receive is shown in your prompt. To send mail, create a Markdown file",
    `(any name ending in \`.md\`) directly inside \`${outbox}\` with this exact shape:`,
    "",
    "```",
    "---",
    "to: <agent-name>",
    "type: reply        # task | reply" + (isLead ? " | done" : ""),
    "subject: <short subject>",
    "reply_to: <message id>   # optional",
    "---",
    "",
    "<body>",
    "```",
    "",
    `You may send to: ${recipients.join(", ") || "(nobody)"}.`,
    isLead
      ? `When the whole job is finished, send a message with \`type: done\` (no \`to\` needed). That ends the run.`
      : `Report results to the lead by mail; the lead decides what happens next.`,
    "Each wake-up handles one message. Do the work it asks, then send the replies that are needed, then stop.",
    "",
    "## Message format",
    "The body of every `task` and `reply` must contain these `##` headings, exactly as written (write `None` under a heading if there is nothing to say).",
    "Mail missing a heading is still delivered, but is flagged to the recipient.",
    "",
    `- \`task\`: ${REQUIRED_SECTIONS.task!.map((h) => `\`## ${h}\``).join(", ")} (Upstream = id of the mail this task derives from, or \`None\`).`,
    `- \`reply\`: ${REQUIRED_SECTIONS.reply!.map((h) => `\`## ${h}\``).join(", ")}.`,
    "- `done` has no required headings.",
    ...(isLead
      ? [
          "",
          "## Progress tracking (optional, shown in `agent-team status`)",
          "Put a `## Steps` heading with a checklist (`- [ ] step`, `- [x] finished step`) in the mail you send. Each time you send mail, re-list the full",
          "checklist with finished steps ticked; the latest one you send is what `status` reports as task progress.",
          "Your final `done` mail must also include the full `## Steps` checklist. Tick only steps that were actually done and verified; leave undone ones",
          "(e.g. build, app start, commit) unticked and say so in the mail instead of reporting them as finished.",
        ]
      : []),
    "",
    "## Memory",
  );
  const mems = memoryDirs(agent);
  if (mems.length === 0) lines.push("You have no long-term memory directory.");
  for (const m of mems) {
    const label = m === agent.memory.global ? "global (all projects)" : "this project";
    lines.push(`- ${label}: \`${m}\``);
  }
  if (mems.length) {
    lines.push(
      "Keep a `MEMORY.md` index in each memory directory (one line per entry, pointing at a file). Its contents are shown in your prompt",
      "on every wake-up; read other memory files on demand. Save durable facts, decisions and lessons there; you can write only inside these directories.",
    );
  }
  lines.push("", "## Rules");
  lines.push(
    "- Never edit any `AGENT.md`, `COMMON.md`, or the repository's own `CLAUDE.md`/`AGENTS.md`" +
      (isLead || agent.canEditAgentMd ? " unless you need to as lead (changes are logged)." : "."),
    "- Never touch another agent's memory, inbox or outbox, or the team's config files.",
    `- The shared team context is in \`${commonFile(project)}\`${isLead ? " (you maintain it; keep it short)" : " (read-only)"}.`,
  );
  if (project.dispatcher.max_parallel > 1 && agent.owns.length > 0 && !isLead) {
    lines.push(`- You own these repo paths and must only change files there: ${agent.owns.join(", ")}.`);
  }
  return lines.join("\n");
}

export function buildUserPrompt(project: ResolvedProject, agent: ResolvedAgent, unread: Message[]): string {
  const parts: string[] = [];

  const common = readCapped(commonFile(project), COMMON_LIMIT);
  parts.push("# Shared team context (COMMON.md)");
  if (!common) parts.push("(empty)");
  else {
    parts.push(common.text.trim());
    if (common.truncated) {
      parts.push(`\n[COMMON.md was truncated at ${COMMON_LIMIT} bytes — the lead should condense it.]`);
    }
  }

  for (const dir of memoryDirs(agent)) {
    const idx = readCapped(path.join(dir, "MEMORY.md"), MEMORY_INDEX_LIMIT);
    const label = dir === agent.memory.global ? "global" : "project";
    parts.push("", `# Your ${label} memory index (${dir}/MEMORY.md)`);
    if (!idx) parts.push("(no MEMORY.md yet — create one when you have something worth keeping)");
    else {
      parts.push(idx.text.trim());
      if (idx.truncated) parts.push(`\n[index truncated at ${MEMORY_INDEX_LIMIT} bytes — trim it]`);
    }
  }

  const sorted = [...unread].sort((a, b) => path.basename(a.file).localeCompare(path.basename(b.file)));
  const [current, ...queued] = sorted;
  parts.push("", "# Message to handle now");
  if (!current) parts.push("(no message)");
  else {
    parts.push(
      `id: ${current.meta.id}`,
      `from: ${current.meta.from}`,
      `type: ${current.meta.type}`,
      `thread: ${current.meta.thread}`,
      `subject: ${current.meta.subject}`,
      "",
      current.body,
    );
  }
  if (queued.length) {
    parts.push("", "# Queued messages (not handled in this wake-up; each gets its own wake-up later, titles only)");
    for (const m of queued) parts.push(`- from ${m.meta.from} [${m.meta.type}] "${m.meta.subject}" -> ${m.file}`);
  }
  return parts.join("\n");
}
