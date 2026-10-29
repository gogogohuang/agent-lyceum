import fs from "node:fs";
import { cutUtf8, readFileCapped } from "./fs-util.js";
import path from "node:path";
import { REQUIRED_SECTIONS } from "./format.js";
import type { ResolvedAgent, ResolvedProject } from "./config.js";
import { senderLabel, slotName } from "./instances.js";
import type { Message } from "./mailbox.js";
import type { Layer, MemoryFile, MissingPath, ProjectChanges } from "./memory-tidy.js";
import { modelForTier } from "./tiers.js";
import { buildRecordsView, RECORDS_BUDGET } from "./records.js";
import { commonFile, memoryDirs, outboxDir, recordsKindDir, repoDirFor, sharedDir, sharedIndex } from "./policy.js";

function memoryLabel(agent: ResolvedAgent, dir: string): string {
  if (dir === agent.memory.task) return "task (this task only, isolated)";
  const shared = agent.sharedMemory && Object.values(agent.sharedMemory).includes(dir);
  const instance1 = agent.instance ? slotName(agent.instance.role, 1) : "";
  const kind = dir === (agent.memory.global ?? agent.sharedMemory?.global) ? "global (all projects" : "project (all tasks of this project";
  return shared ? `${kind}, read-only for you: ${instance1} maintains it)` : `${kind})`;
}

/** Lead-only rules that keep the number of wake-ups down; placed after the progress-tracking block. */
export const WAKE_ECONOMY_SECTION = [
  "## Keeping wake-ups few",
  "Every wake-up re-reads your whole context (prompt, memory, mail), so the number of wake-ups, yours and your teammates', is the main cost of a run.",
  "- Send all work that is independent of each other in the same wake-up (for example the implementation and the matching docs), each task naming its reviewer, instead of one task per wake-up.",
  "- When a reply arrives while other work you sent is still out and the reply needs nothing from you yet, send no mail: note it in your task memory and end the wake-up. Decide the next step once, when the rest is back; replies waiting together are handed to you in one wake-up.",
  "- Skip the QA layer (the verification role and its reviewer) for a small fix: a change of a few lines that has a reproduction test which failed before and passes after, and an approving code review. Send QA for large changes, changes across modules, and changes to user-visible behaviour.",
  "- Use the most capable (most expensive) model only at three moments: before the plan is final, when the same error shows up a second time, and before you send `done`. In other rounds prefer teammates on cheaper models; read-only search work suits the cheapest one.",
];

/** The lead's system prompt gets this at its very end when same-role instances are possible in the run (spec 23.12). No trailing newline. */
export const PARALLEL_SECTION = (n: number): string =>
  [
    "## Parallel tasks",
    `A member can work on up to ${n} tasks at the same time, each in its own instance with its own worktree. To use this, send each independent task as its own new \`task\` (not a reply, no \`reply_to\`) with the frontmatter line \`parallel: true\`. Only your own mail can do this. Instance 1 keeps the member's name; the others are named \`<member>--2\`, \`<member>--3\`, and their mail reaches you from those names.`,
    "- Mark tasks parallel only when they are independent of each other and change different files. Before you send them, list in each task's `## Scope` the files it will touch; if two lists overlap, do not mark them parallel.",
    "- Never run in parallel work that changes shared components, types, routes, configuration or design tokens: send that first, without the flag, and send the dependent tasks after it is integrated. Changes to the same file are not merged: the later one is blocked and comes back to you as a failure.",
    "- Revisions go back to the instance that did the work: reply to its mail (`reply_to`). An instance whose work is blocked takes no new task, also not one addressed to it by name, until that work is in the repo; to redo it, reply to the failure about it.",
    "- Without `parallel: true`, mail goes to the member itself, one task at a time.",
    "- When rate limits hit, fewer instances may start; waiting tasks run when an instance is free.",
    "- After parallel work is back, have one member type-check and test the combined result before you report `done`.",
  ].join("\n");

/** The lead's system prompt ends with this when a member can run a task on a cheaper model (spec 24.10); `members` = [name, model of low, mid, high]. No trailing newline. */
export const TIER_SECTION = (members: { name: string; low: string; mid: string; high: string }[]): string =>
  [
    "## Task tiers",
    "Some members can run a task on a cheaper model than their own. Add the frontmatter line `tier: low`, `tier: mid` or `tier: high` to a `task` you send them; without it they use their own model. Pick by difficulty: `low` for mechanical work with an exact spec (renames, a one-line fix, running a given command), `mid` for routine changes in one module, `high` (or no tier) for design, debugging, reviews and anything unclear. A tier lasts for that one task: replies and later mail on the thread run on the member's own model, so put `tier` again on each follow-up task. Each model keeps its own session, so a member that resumes sessions does not see what it did on another model; say in the task what it needs. If a tiered task comes back poor, send it again with a higher tier.",
    "Members and the models each tier uses:",
    ...members.map((m) => `- ${m.name}: low ${m.low}, mid ${m.mid}, high ${m.high}`),
  ].join("\n");

export const COMMON_LIMIT = 8 * 1024;
export const MEMORY_INDEX_LIMIT = 4 * 1024;
export const HANDOFF_LIMIT = COMMON_LIMIT;
/** Cap of each kind of project record (decisions, lessons) in a prompt. */
export const CONTEXT_LIMIT = RECORDS_BUDGET;
/** Largest mail body put in a prompt (the inline task limit), and the total for the mails handled in one wake-up. */
export const MAIL_BODY_LIMIT = 16 * 1024;
export const MAIL_BATCH_LIMIT = 64 * 1024;
/** Same-thread `reply`/`failure` messages a non-lead agent takes in one wake-up. The lead uses `MAIL_BATCH_LIMIT` and `LEAD_REPLY_CAP` instead. */
export const LEAD_BATCH_LIMIT = 5;
/** Most waiting `reply`/`failure` messages the lead takes in one wake-up; headers are not counted in `MAIL_BATCH_LIMIT`, so tiny replies need a count cap too. */
export const LEAD_REPLY_CAP = 20;
const BATCHABLE = new Set<string | undefined>(["reply", "failure"]);

const readCapped = readFileCapped;

/** A PR only needs to say agent-lyceum opened it; no agent or role names. */
const PR_ATTRIBUTION_RULE =
  "- If you open a pull request, end its description with a line saying it was opened by agent-lyceum (e.g. `🤖 Opened by agent-lyceum`). Do not name any agent or role in it.";

/** A tool call that never returns (a server or daemon started in the foreground) burns the whole wake-up timeout and the finished work is thrown away with it. */
const NO_DAEMONS_RULE =
  "- Never start a server, daemon or watcher (pm2, `serve`, `dev`, `--watch`) in the foreground of a command, and never leave one running. Run it in the background, bound every such command with `timeout 60`, stop what you started before you finish, and if it cannot start (e.g. a sandbox denies binding a port) report that as unverified instead of retrying.";

/** Only the lead (or a solo agent, the lead of a team of one) can send `done`, so only it can ask for a pull request. */
const OPEN_PR_RULE =
  "Add the frontmatter line `open_pr: true` to `done` only when the user's task explicitly asks for a pull request; otherwise leave it out. It only has an effect when the run ends `completed` with changes on its own branch, and agent-lyceum (not you) then pushes the branch and opens the pull request. Keep agent and role names out of the report, because it becomes the pull request description.";

export function readPersona(agent: ResolvedAgent): string {
  return fs.readFileSync(agent.agentMd, "utf8").trim();
}

/** What the lead (or a solo agent) is told about the handoff notes: they are what a reopened task starts from. */
function handoffRule(dir: string): string[] {
  return [
    "",
    "## Handoff for follow-ups",
    `This task may be reopened later with a follow-up request, and the agents woken then start with fresh sessions. Before you send \`done\`, write what they need to carry on into \`${dir}\`: keep a \`MEMORY.md\` index there (one line per entry, pointing at a file) and record the decisions made and why, the interfaces agreed, the current state, what is left and what to do next, and the pitfalls met. Your teammates can read this folder but cannot write it; if a report from a teammate holds something worth keeping, add it yourself. Only the index is shown in prompts, and only the first ${HANDOFF_LIMIT / 1024} KB of it, so keep it short. These notes are about this task only; lessons that outlive it belong in your project or global memory.`,
  ];
}

/** The protocol of an agent working alone: no teammates, no ask. `run --agent` still ends with a `done` mail; `call` just answers. */
export function buildSoloSystemPrompt(project: ResolvedProject, agent: ResolvedAgent): string {
  const isCall = project.solo === "call";
  const lines: string[] = [readPersona(agent), "", "---", "", "# Solo protocol (injected by agent-lyceum)", ""];
  lines.push(
    `You are **${agent.name}**, working alone: there is no team, no lead and nobody to mail, and you cannot ask the user questions. You work in \`${repoDirFor(project, agent.name)}\`.`,
    isCall
      ? "Do the task you are given. Your final reply text is printed to the user as your answer, so end with the answer or a short report of what you did; nothing else is delivered."
      : "",
  );
  if (!isCall) {
    lines.push(
      "## Finishing",
      `When the job is finished, create a Markdown file (any name ending in \`.md\`) directly inside \`${outboxDir(project, agent.name)}\` with this exact shape:`,
      "",
      "```",
      "---",
      "type: done",
      "subject: <short subject>",
      "outcome: completed|partial|blocked|failed",
      "---",
      "",
      "## Result",
      "## Files",
      "## Verification",
      "## Not done",
      "```",
      "",
      "That ends the run. `## Result` is the actual deliverable or conclusion (not just \"done\"), `## Files` the paths you created or changed, `## Verification` what you ran or checked and what it showed, `## Not done` anything skipped or unverified (or `None`). Only `completed` means success and it needs all four headings; if work remains or is blocked say `partial`/`blocked`/`failed` (those need only `## Result` and `## Not done`). A summary in your reply text is never delivered: without a `done` mail the run ends as idle with no report. " + OPEN_PR_RULE,
    );
  }
  const shared = sharedDir(project);
  if (!isCall && shared) lines.push(...handoffRule(shared));
  lines.push("", "## Memory");
  const mems = memoryDirs(agent);
  if (mems.length === 0) lines.push("You have no long-term memory directory.");
  for (const m of mems) lines.push(`- ${memoryLabel(agent, m)}: \`${m}\``);
  if (mems.length) {
    lines.push(
      "Keep a `MEMORY.md` index in each memory directory (one line per entry, pointing at a file). Its contents are shown in your prompt on every wake-up; you can write only inside these directories.",
      "Use memory only for durable lessons that stay true across tasks; never record task-specific details there.",
    );
  }
  lines.push(
    "",
    "## Rules",
    "- Never edit any `AGENT.md`, `COMMON.md`, or the repository's own `CLAUDE.md`/`AGENTS.md`.",
    "- Never touch another agent's memory, inbox or outbox, or the configuration files of agent-lyceum.",
    PR_ATTRIBUTION_RULE,
    NO_DAEMONS_RULE,
  );
  return lines.join("\n");
}

/** The prompt of a `call`: the memory indexes the agent is used to, then the task. */
export function buildCallUserPrompt(agent: ResolvedAgent, task: string): string {
  const parts: string[] = [];
  for (const dir of memoryDirs(agent)) {
    const idx = readCapped(path.join(dir, "MEMORY.md"), MEMORY_INDEX_LIMIT);
    parts.push(`# Your ${memoryLabel(agent, dir).split(" ")[0]} memory index (${dir}/MEMORY.md)`);
    if (!idx) parts.push("(no MEMORY.md yet — create one when you have something worth keeping)", "");
    else parts.push(idx.text.trim(), ...(idx.truncated ? [`[index truncated at ${MEMORY_INDEX_LIMIT} bytes — trim it]`] : []), "");
  }
  parts.push("# Task", task.trim());
  return parts.join("\n");
}

/** Everything that goes to the runtime's system prompt: the persona plus the team protocol. */
export function buildSystemPrompt(project: ResolvedProject, agent: ResolvedAgent): string {
  if (project.solo) return buildSoloSystemPrompt(project, agent);
  const outbox = outboxDir(project, agent.name);
  // Instances 2 and up are not listed (the lead is told their names separately), and an instance does not list its own role's other instances.
  const mates = Object.keys(project.agents).filter((n) => n !== agent.name && (project.agents[n]?.instance?.k ?? 1) < 2 && (!agent.instance || project.agents[n]?.instance?.role !== agent.instance.role));
  const recipients =
    agent.canMessage === "all" ? mates : agent.canMessage.filter((n) => project.agents[n] && n !== agent.name);
  const isLead = agent.name === project.lead;
  const lines: string[] = [];
  lines.push(readPersona(agent), "", "---", "", "# Team protocol (injected by agent-lyceum)", "");
  lines.push(
    agent.instance && agent.instance.k >= 2
      ? `You are **${agent.name}**, instance ${agent.instance.k} of **${agent.instance.role}** in the team "${project.name}". Other instances of ${agent.instance.role} may be working on other tasks at the same time, each in its own worktree. You work in the repository \`${repoDirFor(project, agent.name)}\`.`
      : `You are **${agent.name}**, a member of the team "${project.name}". You work in the repository \`${repoDirFor(project, agent.name)}\`.`,
    ...(agent.instance?.k === 1
      ? [
          `Other instances of you${(() => {
            const names = Object.values(project.agents).filter((a) => a.instance?.role === agent.name && a.instance.k >= 2).map((a) => a.name);
            return names.length ? ` (${names.join(", ")})` : "";
          })()} may work in parallel; only you write your global/project memory.`,
        ]
      : []),
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
      : "Each wake-up handles one message, except that consecutive `reply`/`failure` messages on the same thread may be handed to you together: handle them together. Do the work it asks, then send the replies that are needed, then stop.",
    "Mail that repeats an earlier mail of yours to the same agent (same type, same text) is not sent again; you are told, and should wait for the answer or ask for something different instead of resending.",
    "",
    "## Message format",
    "The body of every `task` and `reply` must contain these `##` headings, exactly as written (write `None` under a heading if there is nothing to say).",
    "A `task` or `reply` missing a heading is sent back to you (at most twice per sender + type + subject); after that it is delivered with a warning flagged to the recipient.",
    "",
    `- \`task\`: ${REQUIRED_SECTIONS.task!.map((h) => `\`## ${h}\``).join(", ")} (Upstream = id of the mail this task derives from, or \`None\`).`,
    `- \`reply\`: ${REQUIRED_SECTIONS.reply!.map((h) => `\`## ${h}\``).join(", ")}.`,
    isLead
      ? "- `done`: your final report to the user (shown when the run ends, saved as `result.md`). Its frontmatter must contain `outcome: completed|partial|blocked|failed`, and the body the headings `## Result` (the actual deliverable or conclusion, not just \"done\"), `## Files` (paths created or changed), `## Verification` (what you ran or checked, and what it showed) and `## Not done` (anything skipped or unverified, or `None`). Only `completed` means success, and it needs all four headings and every checklist step ticked; if work remains or is blocked, say `partial`/`blocked`/`failed` (those need only `## Result` and `## Not done`). A `done` that breaks this is sent back to you and does not end the run. " + OPEN_PR_RULE
      : "- `done` has no required headings.",
    ...(agent.canAskUser
      ? [
          "",
          "## Asking the user",
          "You may ask the human user with `type: ask` (no `to` needed). The run then pauses until they answer, so ask only when the answer changes what you do next and you cannot work it out from the code, the memory or the task. Ask everything you need in ONE batch (at most 10 questions); prefer questions with `<options>` and a `<suggested>` value (with a `reason`) so the user can answer quickly. Write each option as its full content (what it does and what follows from it), never a bare letter or short code like A or b); the user must be able to choose without re-reading the question. The `<suggested>` value must repeat one option's text exactly. The body is exactly this:",
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
          "The answers come back to you as a `reply` mail containing an `<answers>` block. A user answer may be one of your options or any free text of their own (it may start with `other:`). Do not ask what you could decide yourself, and do not ask again for something already answered.",
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
    ...(isLead ? ["", ...WAKE_ECONOMY_SECTION] : []),
    ...(isLead && sharedDir(project) ? handoffRule(sharedDir(project) as string) : []),
    "",
    "## Memory",
  );
  const mems = memoryDirs(agent);
  const sharedMems = Object.values(agent.sharedMemory ?? {});
  if (mems.length === 0) lines.push("You have no long-term memory directory.");
  for (const m of [...sharedMems, ...mems]) {
    const label = memoryLabel(agent, m);
    lines.push(`- ${label}: \`${m}\``);
  }
  if (mems.length) {
    lines.push(
      "Keep a `MEMORY.md` index in each memory directory (one line per entry, pointing at a file). Its contents are shown in your prompt",
      "on every wake-up; read other memory files on demand; you can write only inside these directories.",
      "Put anything specific to the current task (decisions, progress, findings, branch names) in the **task** memory: it is private to this task and starts empty for every new task.",
      "Also record approaches you considered but rejected, with the reason, so they can be revisited or reversed later.",
      ...(sharedMems.length
        ? ["You cannot write the shared memory: put lessons worth keeping in your reply to the lead."]
        : ["Use the global/project memory only for durable lessons that stay true across tasks; never record task-specific details there."]),
    );
  }
  lines.push("", "## Rules");
  lines.push(
    "- Never edit any `AGENT.md`, `COMMON.md`, or the repository's own `CLAUDE.md`/`AGENTS.md`" +
      (isLead || agent.canEditAgentMd ? " unless you need to as lead (changes are logged)." : "."),
    "- Never touch another agent's memory, inbox or outbox, or the team's config files.",
    `- The shared team context is in \`${commonFile(project)}\`${isLead ? " (you maintain it; keep it short)" : " (read-only)"}.`,
    ...(isLead
      ? [
          `- You also keep two kinds of durable records for every future run of this project, one Markdown file per entry: decisions in \`${recordsKindDir(project, "decisions")}/\` (what was decided and why) and lessons in \`${recordsKindDir(project, "lessons")}/\` (heuristics and pitfalls that stay true). The file name without \`.md\` is the entry id (lowercase letters, digits, \`-\`). Each file starts with YAML frontmatter between \`---\` lines: \`status: active|superseded\`, \`date: YYYY-MM-DD\`, \`title: <one line>\`, optionally \`run: <run id>\` and \`supersedes: [<ids of entries of the same kind>]\`; the body is the decision or lesson and its reason. Prompts show only effective-active entries (\`status: active\` and not named in another entry's \`supersedes\`), newest first, up to ${CONTEXT_LIMIT / 1024} KB per kind, and list what does not fit as one line each. When an entry becomes outdated, mark it \`status: superseded\` or name it in a new entry's \`supersedes\`. Add or update entries before you send \`done\`.`,
        ]
      : []),
    PR_ATTRIBUTION_RULE,
    NO_DAEMONS_RULE,
  );
  let text = lines.join("\n");
  if (isLead && project.run?.instances) text = `${text}\n\n${PARALLEL_SECTION(project.run.instances.max)}`;
  if (isLead) {
    const members = Object.values(project.agents)
      .filter((a) => a.name !== project.lead && (!a.instance || a.instance.k === 1) && (a.tiers?.length ?? 0) >= 2)
      .sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0))
      .map((a) => ({ name: a.name, low: modelForTier(a.tiers!, "low"), mid: modelForTier(a.tiers!, "mid"), high: modelForTier(a.tiers!, "high") }));
    if (members.length) text = `${text}\n\n${TIER_SECTION(members)}`;
  }
  return text;
}

/** Bytes of `body` this wake-up would actually show, using the same caps as the prompt. */
function shownBodyBytes(body: string, remaining: number): number {
  if (remaining <= 0) return 0;
  return cutUtf8(Buffer.from(body, "utf8"), Math.min(MAIL_BODY_LIMIT, remaining)).length;
}

/**
 * Messages one wake-up handles: the oldest one, or a run of `reply`/`failure` so the agent decides once.
 * The lead takes every such message that is already waiting and whose body still fits in `MAIL_BATCH_LIMIT`
 * (a later one that would show none of its body stays unread), at most `LEAD_REPLY_CAP`. Other agents take
 * at most `LEAD_BATCH_LIMIT` on the same thread.
 */
export function pickMessages(project: ResolvedProject, agent: ResolvedAgent, queue: Message[]): Message[] {
  const sorted = [...queue].sort((a, b) => path.basename(a.file).localeCompare(path.basename(b.file)));
  const first = sorted[0];
  if (!first || !BATCHABLE.has(first.meta.type)) return sorted.slice(0, 1);
  const isLead = agent.name === project.lead;
  const run: Message[] = [];
  let remaining = MAIL_BATCH_LIMIT;
  for (const m of sorted) {
    if (!BATCHABLE.has(m.meta.type)) break;
    if (run.length >= (isLead ? LEAD_REPLY_CAP : LEAD_BATCH_LIMIT)) break;
    if (!isLead && m.meta.thread !== first.meta.thread) break;
    const shown = isLead ? shownBodyBytes(m.body, remaining) : 0;
    if (isLead && Buffer.byteLength(m.body, "utf8") > 0 && shown === 0) break;
    run.push(m);
    if (isLead) remaining -= shown;
  }
  return run;
}

export function buildUserPrompt(project: ResolvedProject, agent: ResolvedAgent, unread: Message[], handleCount = 1, handoff = false): string {
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

  for (const [title, kind] of [
    ["Project decisions", "decisions"],
    ["Project lessons", "lessons"],
  ] as const) {
    const view = buildRecordsView(project, kind, CONTEXT_LIMIT);
    if (view) parts.push("", `# ${title}`, view); // nothing recorded yet: no heading, no tokens
  }

  const handoffFile = handoff ? sharedIndex(project) : undefined;
  const notes = handoffFile ? readCapped(handoffFile, HANDOFF_LIMIT) : undefined;
  if (handoffFile && notes?.text.trim()) {
    parts.push("", `# Handoff notes from earlier segments of this task (${handoffFile})`, notes.text.trim());
    if (notes.truncated) parts.push(`\n[handoff index truncated at ${HANDOFF_LIMIT} bytes — the lead should condense it.]`);
    parts.push("The other files in that folder are there to read on demand.");
  }

  for (const dir of [...Object.values(agent.sharedMemory ?? {}), ...memoryDirs(agent)]) {
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
  let remaining = MAIL_BATCH_LIMIT;
  current.forEach((m, i) => {
    if (current.length > 1) parts.push("", `## Message ${i + 1} of ${current.length}`);
    const raw = Buffer.from(m.body, "utf8");
    const shown = cutUtf8(raw, Math.min(MAIL_BODY_LIMIT, remaining));
    remaining -= shown.length;
    const body =
      shown.length === raw.length
        ? m.body
        : `${shown.toString("utf8")}\n[agent-lyceum: this message was cut at ${shown.length} of ${raw.length} bytes; read the whole message in \`${m.file}\` (it moves to \`read/\` in the same folder after this wake-up)]`;
    parts.push(
      `id: ${m.meta.id}`,
      `from: ${senderLabel(m.meta.from, project.agents)}`,
      `type: ${m.meta.type}`,
      `thread: ${m.meta.thread}`,
      `subject: ${m.meta.subject}`,
      "",
      body,
    );
  });
  if (queued.length) {
    parts.push("", "# Queued messages (not handled in this wake-up; each gets its own wake-up later, titles only)");
    for (const m of queued) parts.push(`- from ${senderLabel(m.meta.from, project.agents)} [${m.meta.type}] "${m.meta.subject}" -> ${m.file}`);
  }
  return parts.join("\n");
}

export interface TidyRecordsContext {
  /** The project records folder (`<shared>/common/records`). */
  dir: string;
  /** Absolute path of this tidy's archive folder for the records (the agent creates it). */
  archiveDir: string;
  /** One line per entry: kind, id, status, date, size and title (the archive is not listed). */
  entries: { kind: string; id: string; rel: string; status: string; date: string; bytes: number; title: string; invalid?: string }[];
  /** Live files that are not entries (kept as they are). */
  otherFiles: MemoryFile[];
}

export interface TidyContext {
  layer: Layer;
  /** The memory directory being tidied; absent when only the project records are tidied (the lead has no memory directory). */
  dir?: string;
  /** Absolute path of this tidy's archive folder (the agent creates it). */
  archiveDir?: string;
  /** Live files only (the archive is not listed). */
  files: MemoryFile[];
  /** MEMORY.md text ("" when there is none). */
  index: string;
  /** What changed in the project since the last tidy (project layer only). */
  changes?: ProjectChanges;
  missing: MissingPath[];
  /** Set only for the lead's project-layer tidy: the project records are tidied in the same wake-up. */
  records?: TidyRecordsContext;
}

/** The prompts of a memory-tidy wake-up: a maintenance job, not a task, so it has none of the mail protocol. */
export function buildTidyPrompts(agent: ResolvedAgent, ctx: TidyContext): { systemPrompt: string; userPrompt: string } {
  const { dir, archiveDir, records } = ctx;
  const touch = [dir ? `your ${ctx.layer} memory (\`${dir}\`)` : "", records ? `the project records (\`${records.dir}\`)` : ""].filter(Boolean).join(" and ");
  const systemPrompt = [
    readPersona(agent),
    "",
    "---",
    "",
    "# Memory tidy (injected by agent-lyceum)",
    "",
    `You are **${agent.name}**. This wake-up is a maintenance job, not a task: there is no mail to send or read, and nothing to do in the repository. Your only job is to tidy ${records ? touch : `your own ${ctx.layer} memory`} so it stays small, accurate and useful.`,
    "",
    "## What you may touch",
    `Only files inside ${[dir ? `\`${dir}\`` : "", records ? `\`${records.dir}\`` : ""].filter(Boolean).join(" and ")}. Everything else is read-only. Do not touch your other memory directories, \`${dir ? `${dir}/` : ""}.tidy-state.json\` or the archive folders of earlier tidies.`,
    ...(dir && archiveDir
      ? [
          "",
          records ? "## What to do with your memory" : "## What to do",
          "- Merge entries that say the same thing; keep one file with the combined, current content.",
          "- Rewrite entries that are stale (see the project changes and the missing paths below); correct them if you can tell what is true now, otherwise keep them and say so in the report.",
          "- Keep `MEMORY.md` as the index: one line per entry, each pointing at an existing file, and nothing for files that were archived.",
          "- **When unsure, keep it.** Prefer leaving an entry alone over losing information.",
          "",
          "## Never delete",
          `To retire a file, move it into the archive folder, keeping its relative path (\`${dir}/x/y.md\` goes to \`${archiveDir}/x/y.md\`). Never delete a file. \`MEMORY.md\` itself is never archived. A file whose content you merged into another one is archived too.`,
          "",
          records ? "## Before you finish (memory)" : "## Before you finish",
          `Write \`${archiveDir}/tidy-report.md\` — even when you changed nothing — with these headings: \`## Merged\` (what was combined into what), \`## Archived\` (each archived file and why), \`## Unsure\` (things you kept but doubt). Write \`None\` under a heading with nothing to say. The tidy is rolled back if the report is missing or any file went missing.`,
        ]
      : []),
    ...(records
      ? [
          "",
          "## What to do with the project records",
          `The records are the project's durable decisions and lessons, one file per entry (\`${records.dir}/decisions/<id>.md\`, \`${records.dir}/lessons/<id>.md\`). Every entry has frontmatter with \`status\` (\`active\` or \`superseded\`), \`date\` (YYYY-MM-DD) and \`title\` (one line), optionally \`run\` and \`supersedes\` (a list of ids).`,
          "- Merge entries that say the same thing into one entry (write the merged content, then archive the entries that were merged).",
          "- When a newer entry replaces an older one, list the old id under `supersedes` in the newer entry, or set the old entry to `status: superseded`.",
          "- Archive entries that are obsolete.",
          "- Keep the frontmatter valid: `status`, `date` and `title` are required; the id is the file name without `.md` and uses only lowercase letters, digits and `-`.",
          "- **When unsure, keep it.** Never delete a file.",
          `To archive a record, move it into \`${records.archiveDir}\`, keeping its relative path (\`${records.dir}/lessons/x.md\` goes to \`${records.archiveDir}/lessons/x.md\`).`,
          `Write \`${records.archiveDir}/tidy-report.md\` — even when you changed nothing — with the headings \`## Merged\`, \`## Archived\`, \`## Unsure\` (\`None\` when empty). The tidy of both folders is rolled back if the report is missing or any file went missing.`,
        ]
      : []),
  ].join("\n");

  const parts: string[] = [];
  if (dir && archiveDir) {
    parts.push(
      `Archive directory: ${archiveDir}`,
      `Layer: ${ctx.layer}${ctx.layer === "global" ? " (shared by every project; do not judge entries by one project's code)" : ""}`,
      `Memory directory: ${dir}`,
      "",
      "# Files",
      ...(ctx.files.length ? ctx.files.map((f) => `${f.rel}  ${f.bytes} B  modified ${f.mtime.slice(0, 10)}`) : ["(none)"]),
      "",
      `# MEMORY.md (${dir}/MEMORY.md)`,
      ctx.index.trim() ? ctx.index.trim() : "(no MEMORY.md)",
    );
  }
  if (ctx.layer === "project" && dir) {
    const c = ctx.changes;
    parts.push("", "# Changes in the project since the last tidy");
    if (!c) parts.push("(not available)");
    else {
      if (c.note) parts.push(c.note);
      if (c.log.length) parts.push("", "Commits:", ...c.log);
      if (c.stat.length) parts.push("", "Files changed:", ...c.stat);
    }
  }
  if (dir) {
    parts.push("", "# Paths named in the memory that no longer exist");
    parts.push(...(ctx.missing.length ? ctx.missing.map((m) => `- \`${m.path}\` (mentioned in ${m.file})`) : ["(none found)"]));
  }
  if (records) {
    parts.push(
      ...(parts.length ? [""] : []),
      "# Project records",
      `Records archive directory: ${records.archiveDir}`,
      `Records directory: ${records.dir}`,
      "",
      "Entries (kind/id  status  date  size  title):",
      ...(records.entries.length
        ? records.entries.map((e) => `${e.rel}  ${e.status}  ${e.date || "no date"}  ${e.bytes} B  ${e.title}${e.invalid ? `  [INVALID: ${e.invalid}]` : ""}`)
        : ["(none)"]),
      ...(records.otherFiles.length ? ["", "Other files (leave them alone):", ...records.otherFiles.map((f) => `${f.rel}  ${f.bytes} B`)] : []),
    );
  }
  return { systemPrompt, userPrompt: parts.join("\n") };
}
