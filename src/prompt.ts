import fs from "node:fs";
import path from "node:path";
import { REQUIRED_SECTIONS } from "./format.js";
import type { ResolvedAgent, ResolvedProject } from "./config.js";
import type { Message } from "./mailbox.js";
import type { Layer, MemoryFile, MissingPath, ProjectChanges } from "./memory-tidy.js";
import { commonFile, memoryDirs, outboxDir, repoDirFor } from "./policy.js";

function memoryLabel(agent: ResolvedAgent, dir: string): string {
  if (dir === agent.memory.task) return "task (this task only, isolated)";
  return dir === agent.memory.global ? "global (all projects)" : "project (all tasks of this project)";
}

export const COMMON_LIMIT = 8 * 1024;
export const MEMORY_INDEX_LIMIT = 4 * 1024;
export const LEAD_BATCH_LIMIT = 5;
const BATCHABLE = new Set<string | undefined>(["reply", "failure"]);

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
  lines.push(readPersona(agent), "", "---", "", "# Team protocol (injected by agent-lyceum)", "");
  lines.push(
    `You are **${agent.name}**, a member of the team "${project.name}". You work in the repository \`${repoDirFor(project, agent.name)}\`.`,
    ...(project.workspaces?.[agent.name]
      ? [
          `That directory is your own isolated git worktree (branch \`${project.workspaces?.[agent.name]?.branch}\`): teammates cannot see your changes while you work, and you cannot see theirs. Do not commit, push, switch branches or touch any other checkout; the dispatcher collects your changes from this directory after you finish.`,
        ]
      : []),
    `The team lead is **${project.lead}**${isLead ? " (that is you)" : ""}. Teammates: ${mates.join(", ") || "(none)"}.`,
    "",
    "## Sending mail",
    "You cannot talk to teammates directly. Mail you receive is shown in your prompt. To send mail, create a Markdown file",
    `(any name ending in \`.md\`) directly inside \`${outbox}\` with this exact shape:`,
    "",
    "```",
    "---",
    "to: <agent-name>",
    `type: reply        # task | reply${agent.canAskUser ? " | ask" : ""}${isLead ? " | done" : ""}`,
    "subject: <short subject>",
    "reply_to: <message id>   # optional",
    "---",
    "",
    "<body>",
    "```",
    "",
    `You may send to: ${recipients.join(", ") || "(nobody)"}.`,
    isLead
      ? `When the whole job is finished, send a message with \`type: done\` (no \`to\` needed). That ends the run. A summary in your reply text is never delivered and does not end the run: after the last teammate reply is verified you MUST send \`done\` (or a \`task\` for the remaining work), or the run stops as "idle" with no final report.`
      : `Report results to the lead by mail; the lead decides what happens next.`,
    isLead
      ? "Each wake-up handles one message, except that several `reply`/`failure` messages waiting together are handed to you in one wake-up: weigh them together, then decide the next step once."
      : "Each wake-up handles one message. Do the work it asks, then send the replies that are needed, then stop.",
    "",
    "## Message format",
    "The body of every `task` and `reply` must contain these `##` headings, exactly as written (write `None` under a heading if there is nothing to say).",
    "Mail missing a heading is still delivered, but is flagged to the recipient.",
    "",
    `- \`task\`: ${REQUIRED_SECTIONS.task!.map((h) => `\`## ${h}\``).join(", ")} (Upstream = id of the mail this task derives from, or \`None\`).`,
    `- \`reply\`: ${REQUIRED_SECTIONS.reply!.map((h) => `\`## ${h}\``).join(", ")}.`,
    isLead
      ? "- `done`: your final report to the user (shown when the run ends, saved as `result.md`). Its frontmatter must contain `outcome: completed|partial|blocked|failed`, and the body the headings `## Result` (the actual deliverable or conclusion, not just \"done\"), `## Files` (paths created or changed), `## Verification` (what you ran or checked, and what it showed) and `## Not done` (anything skipped or unverified, or `None`). Only `completed` means success, and it needs all four headings and every checklist step ticked; if work remains or is blocked, say `partial`/`blocked`/`failed` (those need only `## Result` and `## Not done`). A `done` that breaks this is sent back to you and does not end the run."
      : "- `done` has no required headings.",
    ...(agent.canAskUser
      ? [
          "",
          "## Asking the user",
          "You may ask the human user with `type: ask` (no `to` needed). The run then pauses until they answer, so ask only when the answer changes what you do next and you cannot work it out from the code, the memory or the task. Ask everything you need in ONE batch (at most 10 questions); prefer questions with `<options>` and a `<suggested>` value (with a `reason`) so the user can answer quickly. The body is exactly this:",
          "",
          "```",
          "<ask>",
          '  <question id="q1">',
          "    <text>Session or JWT for login?</text>",
          "    <options><option>session</option><option>jwt</option></options>",
          '    <suggested reason="existing code already uses cookies">session</suggested>',
          "  </question>",
          "</ask>",
          "```",
          "",
          "The answers come back to you as a `reply` mail containing an `<answers>` block. A user answer that starts with `other:` is free text. Do not ask what you could decide yourself, and do not ask again for something already answered.",
        ]
      : []),
    ...(isLead
      ? [
          "",
          "## Progress tracking (optional, shown in `agent-lyceum status`)",
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
    const label = memoryLabel(agent, m);
    lines.push(`- ${label}: \`${m}\``);
  }
  if (mems.length) {
    lines.push(
      "Keep a `MEMORY.md` index in each memory directory (one line per entry, pointing at a file). Its contents are shown in your prompt",
      "on every wake-up; read other memory files on demand; you can write only inside these directories.",
      "Put anything specific to the current task (decisions, progress, findings, branch names) in the **task** memory: it is private to this task and starts empty for every new task.",
      "Use the global/project memory only for durable lessons that stay true across tasks; never record task-specific details there.",
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

/** Messages one wake-up handles: the oldest one, or for the lead a run of `reply`/`failure` mail (up to LEAD_BATCH_LIMIT) so it decides once on all of it. */
export function pickMessages(project: ResolvedProject, agent: ResolvedAgent, queue: Message[]): Message[] {
  const sorted = [...queue].sort((a, b) => path.basename(a.file).localeCompare(path.basename(b.file)));
  if (agent.name !== project.lead || !BATCHABLE.has(sorted[0]?.meta.type)) return sorted.slice(0, 1);
  const run: Message[] = [];
  for (const m of sorted) {
    if (!BATCHABLE.has(m.meta.type) || run.length >= LEAD_BATCH_LIMIT) break;
    run.push(m);
  }
  return run;
}

export function buildUserPrompt(project: ResolvedProject, agent: ResolvedAgent, unread: Message[], handleCount = 1): string {
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
    const label = memoryLabel(agent, dir).split(" ")[0];
    parts.push("", `# Your ${label} memory index (${dir}/MEMORY.md)`);
    if (!idx) parts.push("(no MEMORY.md yet — create one when you have something worth keeping)");
    else {
      parts.push(idx.text.trim());
      if (idx.truncated) parts.push(`\n[index truncated at ${MEMORY_INDEX_LIMIT} bytes — trim it]`);
    }
  }

  const sorted = [...unread].sort((a, b) => path.basename(a.file).localeCompare(path.basename(b.file)));
  const current = sorted.slice(0, handleCount);
  const queued = sorted.slice(handleCount);
  parts.push("", current.length > 1 ? `# Messages to handle now (${current.length}, oldest first — decide on them together)` : "# Message to handle now");
  if (current.length === 0) parts.push("(no message)");
  current.forEach((m, i) => {
    if (current.length > 1) parts.push("", `## Message ${i + 1} of ${current.length}`);
    parts.push(
      `id: ${m.meta.id}`,
      `from: ${m.meta.from}`,
      `type: ${m.meta.type}`,
      `thread: ${m.meta.thread}`,
      `subject: ${m.meta.subject}`,
      "",
      m.body,
    );
  });
  if (queued.length) {
    parts.push("", "# Queued messages (not handled in this wake-up; each gets its own wake-up later, titles only)");
    for (const m of queued) parts.push(`- from ${m.meta.from} [${m.meta.type}] "${m.meta.subject}" -> ${m.file}`);
  }
  return parts.join("\n");
}

export interface TidyContext {
  layer: Layer;
  /** The memory directory being tidied. */
  dir: string;
  /** Absolute path of this tidy's archive folder (the agent creates it). */
  archiveDir: string;
  /** Live files only (the archive is not listed). */
  files: MemoryFile[];
  /** MEMORY.md text ("" when there is none). */
  index: string;
  /** What changed in the project since the last tidy (project layer only). */
  changes?: ProjectChanges;
  missing: MissingPath[];
}

/** The prompts of a memory-tidy wake-up: a maintenance job, not a task, so it has none of the mail protocol. */
export function buildTidyPrompts(agent: ResolvedAgent, ctx: TidyContext): { systemPrompt: string; userPrompt: string } {
  const systemPrompt = [
    readPersona(agent),
    "",
    "---",
    "",
    "# Memory tidy (injected by agent-lyceum)",
    "",
    `You are **${agent.name}**. This wake-up is a maintenance job, not a task: there is no mail to send or read, and nothing to do in the repository. Your only job is to tidy your own ${ctx.layer} memory so it stays small, accurate and useful.`,
    "",
    "## What you may touch",
    `Only files inside \`${ctx.dir}\`. Everything else is read-only. Do not touch your other memory directories, \`${ctx.dir}/.tidy-state.json\` or the archive folders of earlier tidies.`,
    "",
    "## What to do",
    "- Merge entries that say the same thing; keep one file with the combined, current content.",
    "- Rewrite entries that are stale (see the project changes and the missing paths below); correct them if you can tell what is true now, otherwise keep them and say so in the report.",
    "- Keep `MEMORY.md` as the index: one line per entry, each pointing at an existing file, and nothing for files that were archived.",
    "- **When unsure, keep it.** Prefer leaving an entry alone over losing information.",
    "",
    "## Never delete",
    `To retire a file, move it into the archive folder, keeping its relative path (\`${ctx.dir}/x/y.md\` goes to \`${ctx.archiveDir}/x/y.md\`). Never delete a file. \`MEMORY.md\` itself is never archived. A file whose content you merged into another one is archived too.`,
    "",
    "## Before you finish",
    `Write \`${ctx.archiveDir}/tidy-report.md\` — even when you changed nothing — with these headings: \`## Merged\` (what was combined into what), \`## Archived\` (each archived file and why), \`## Unsure\` (things you kept but doubt). Write \`None\` under a heading with nothing to say. The tidy is rolled back if the report is missing or any file went missing.`,
  ].join("\n");

  const parts: string[] = [
    `Archive directory: ${ctx.archiveDir}`,
    `Layer: ${ctx.layer}${ctx.layer === "global" ? " (shared by every project; do not judge entries by one project's code)" : ""}`,
    `Memory directory: ${ctx.dir}`,
    "",
    "# Files",
    ...(ctx.files.length ? ctx.files.map((f) => `${f.rel}  ${f.bytes} B  modified ${f.mtime.slice(0, 10)}`) : ["(none)"]),
    "",
    `# MEMORY.md (${ctx.dir}/MEMORY.md)`,
    ctx.index.trim() ? ctx.index.trim() : "(no MEMORY.md)",
  ];
  if (ctx.layer === "project") {
    const c = ctx.changes;
    parts.push("", "# Changes in the project since the last tidy");
    if (!c) parts.push("(not available)");
    else {
      if (c.note) parts.push(c.note);
      if (c.log.length) parts.push("", "Commits:", ...c.log);
      if (c.stat.length) parts.push("", "Files changed:", ...c.stat);
    }
  }
  parts.push("", "# Paths named in the memory that no longer exist");
  parts.push(...(ctx.missing.length ? ctx.missing.map((m) => `- \`${m.path}\` (mentioned in ${m.file})`) : ["(none found)"]));
  return { systemPrompt, userPrompt: parts.join("\n") };
}
