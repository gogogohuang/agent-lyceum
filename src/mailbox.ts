import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import type { ResolvedProject } from "./config.js";
import { formatWarning, missingSections, parseSteps, type Step } from "./format.js";
import { atomicWrite, readRegularFileNoFollow } from "./fs-util.js";
import { countFormatRejection, formatRejectionKey, formatRejections, MAX_FORMAT_REJECTIONS } from "./format-rejections.js";
import { type InstanceCap, parallelFlag, roleOfName } from "./instances.js";
import { deterministicId, fault, RouteJournal, sourceIdOf } from "./message-store.js";
import { inboxDir, outboxDir, sharedDir } from "./policy.js";
import { activeRecordsBytes, RECORD_KINDS, RECORDS_BUDGET } from "./records.js";
import { must } from "./assert.js";

export { atomicWrite };

export const MESSAGE_TYPES = ["task", "reply", "failure", "done", "ask"] as const;
export type MessageType = (typeof MESSAGE_TYPES)[number];

export interface MessageMeta {
  id: string;
  from: string;
  to: string;
  thread: string;
  reply_to?: string;
  type: MessageType;
  subject: string;
  created: string;
  /** The run this mail belongs to. Stamped by the dispatcher; absent on mail of legacy runs. */
  run_id?: string;
}

export interface Message {
  meta: MessageMeta;
  body: string;
  file: string;
}

export function newId(): string {
  return crypto.randomBytes(3).toString("hex");
}

let lastStampMs = 0;
/** UTC timestamp for filenames; strictly increasing so inbox order always equals delivery order. */
function stamp(): string {
  lastStampMs = Math.max(Date.now(), lastStampMs + 1);
  return new Date(lastStampMs).toISOString().replace(/[-:.]/g, "");
}

export function serialize(meta: MessageMeta, body: string): string {
  const fm = YAML.stringify(meta).trimEnd();
  return `---\n${fm}\n---\n\n${body.trim()}\n`;
}

export function parseRaw(text: string): { data: Record<string, unknown>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) throw new Error("missing frontmatter (--- ... ---)");
  const data = YAML.parse(m[1] ?? "");
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("frontmatter is not a mapping");
  return { data: data as Record<string, unknown>, body: (m[2] ?? "").trim() };
}

export function ensureProjectDirs(project: ResolvedProject): void {
  fs.mkdirSync(path.join(project.paths.shared, "common"), { recursive: true });
  const handoff = sharedDir(project);
  if (handoff) fs.mkdirSync(handoff, { recursive: true });
  for (const name of Object.keys(project.agents)) ensureAgentDirs(project, name);
}

/** The mailbox and memory directories of one agent (a newly opened instance gets just its own). */
export function ensureAgentDirs(project: ResolvedProject, name: string): void {
  fs.mkdirSync(path.join(inboxDir(project, name), "read"), { recursive: true });
  fs.mkdirSync(path.join(outboxDir(project, name), "rejected"), { recursive: true });
  const a = must(project.agents[name], `agent ${name}`);
  for (const m of [a.memory.global, a.memory.project, a.memory.task]) if (m) fs.mkdirSync(m, { recursive: true });
}

export interface DeliverInput {
  from: string;
  to: string;
  type: MessageType;
  subject: string;
  body: string;
  thread?: string;
  reply_to?: string;
}

/** Deliver a message into `to`'s inbox (dispatcher-side; senders other than agents allowed). */
export function deliver(project: ResolvedProject, input: DeliverInput & { id?: string; created?: string; fileName?: string }): Message {
  const id = input.id ?? newId();
  const meta: MessageMeta = {
    id,
    from: input.from,
    to: input.to,
    thread: input.thread ?? input.reply_to ?? id,
    ...(input.reply_to ? { reply_to: input.reply_to } : {}),
    type: input.type,
    subject: input.subject,
    created: input.created ?? new Date().toISOString(),
    ...(project.run?.layout === "run" ? { run_id: project.run.id } : {}),
  };
  const file = path.join(inboxDir(project, input.to), input.fileName ?? `${stamp()}-${input.from}-${id}.md`);
  atomicWrite(file, serialize(meta, input.body));
  return { meta, body: input.body, file };
}

/**
 * Deliver the mail identified by `(sourceKey, input.to)` at most once, even across crashes and restarts:
 * the plan (id, file name, timestamp) is journaled before anything is written, a retry writes the identical file,
 * and mail the recipient already read is never written again. Without a run (no journal) it just delivers.
 */
export function deliverOnce(project: ResolvedProject, journal: RouteJournal | undefined, sourceKey: string, input: DeliverInput, extra: DeliverExtra = {}): { msg: Message; fresh: boolean } {
  if (!journal) return { msg: deliver(project, input), fresh: true };
  const prior = journal.get(sourceKey, input.to);
  const planned =
    prior ??
    journal.intent({
      source: sourceKey,
      to: input.to,
      msg_id: deterministicId(sourceKey, input.to),
      file: `${stamp()}-${input.from}-${deterministicId(sourceKey, input.to)}.md`,
      created: new Date().toISOString(),
      ...(extra.held ? { held: true as const } : {}),
      ...(extra.parallel ? { parallel: true as const } : {}),
      ...(extra.from ? { from: extra.from } : {}),
      ...(extra.about ? { about: extra.about } : {}),
    });
  fault("route:intent");
  // A replay goes where the first attempt was planned to go: the journal's `held`, not the current state of the run.
  const held = planned.held === true;
  const inbox = inboxDir(project, held ? roleOfName(project.agents, input.to) : input.to);
  const dest = path.join(held ? path.join(inbox, PENDING_DIR) : inbox, planned.file);
  const meta = deliveredMeta(project, input, planned);
  const want = serialize(meta, input.body);
  const alreadyRead = fs.existsSync(path.join(path.dirname(dest), "read", planned.file));
  // A held mail that was delivered (or assigned) may have been moved out of `pending/` already: it is never written again.
  const settled = held && (planned.delivered || journal.assigned(planned.msg_id) !== undefined);
  // Write the planned file; if one is already there, verify it instead of trusting it. Mail already read is never written again.
  if (!settled && !alreadyRead && (!fs.existsSync(dest) || fs.readFileSync(dest, "utf8") !== want)) atomicWrite(dest, want);
  fault("route:written");
  const fresh = !planned.delivered;
  if (fresh) journal.delivered(sourceKey, input.to);
  fault("route:delivered");
  return { msg: { meta, body: input.body, file: dest }, fresh };
}

/** What a delivery records in the journal beyond the plain intent (spec 23.7.1); all of it only for roles with several instances. */
export interface DeliverExtra {
  held?: boolean;
  parallel?: boolean;
  from?: string;
  about?: string;
}

/** Mail for a role that has instances waits here, in the role's inbox, until the assigner places it. */
export const PENDING_DIR = "pending";

function deliveredMeta(project: ResolvedProject, input: DeliverInput, planned: { msg_id: string; created: string }): MessageMeta {
  return {
    id: planned.msg_id,
    from: input.from,
    to: input.to,
    thread: input.thread ?? input.reply_to ?? planned.msg_id,
    ...(input.reply_to ? { reply_to: input.reply_to } : {}),
    type: input.type,
    subject: input.subject,
    created: planned.created,
    ...(project.run?.layout === "run" ? { run_id: project.run.id } : {}),
  };
}

export function readMessage(file: string): Message {
  const { data, body } = parseRaw(fs.readFileSync(file, "utf8"));
  const meta = data as unknown as MessageMeta;
  return { meta, body, file };
}

/** `readMessage` for files that may be anything (held mail): a symlink, FIFO or other non-regular entry throws instead of being followed or blocking. */
export function readMessageNoFollow(file: string): Message {
  const buf = readRegularFileNoFollow(file);
  if (!buf) throw new Error(`${file} is not a readable regular file`);
  const { data, body } = parseRaw(buf.toString("utf8"));
  return { meta: data as unknown as MessageMeta, body, file };
}

/** Paths of the unread messages in an agent's inbox, oldest name first. Does not open them. */
export function unreadFiles(project: ResolvedProject, agent: string): string[] {
  const dir = inboxDir(project, agent);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".md") && !e.name.startsWith("."))
    .map((e) => path.join(dir, e.name))
    .sort();
}

export function listUnread(project: ResolvedProject, agent: string): Message[] {
  const files = unreadFiles(project, agent);
  const out: Message[] = [];
  for (const f of files) {
    try {
      out.push(readMessage(f));
    } catch {
      out.push({
        meta: { id: path.basename(f), from: "?", to: agent, thread: "?", type: "reply", subject: "(unreadable message)", created: "" },
        body: fs.readFileSync(f, "utf8"),
        file: f,
      });
    }
  }
  return out;
}

export function markRead(files: string[]): void {
  for (const f of files) {
    if (!fs.existsSync(f)) continue;
    const dest = path.join(path.dirname(f), "read", path.basename(f));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.renameSync(f, dest);
  }
}

export interface RouteResult {
  /** Mail delivered by this pass (mail a previous pass already delivered is not repeated). */
  delivered: { from: string; to: string; id: string; file: string; type: MessageType; subject: string }[];
  rejected: { from: string; file: string; reason: string }[];
  /** Mail that was delivered but lacks required sections (see format.ts). */
  warnings: { from: string; id: string; subject: string; missing: string[] }[];
  /** The lead's `done`. Its file stays in the outbox until the caller has stored the result and calls `finishDone`. */
  done?: { from: string; subject: string; body: string; file: string; meta: Record<string, unknown> };
  /** Questions for the user. Like `done`, the file stays in the outbox until the caller has stored the questions. */
  asks: { from: string; subject: string; body: string; file: string; source: string }[];
  /** Latest `## Steps` checklist the lead sent, if any. */
  steps?: Step[];
}

/** Move a handled `done` file out of the outbox (to `read/`). */
export function finishDone(file: string): void {
  if (!fs.existsSync(file)) return;
  const dest = path.join(path.dirname(file), "read", path.basename(file));
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.renameSync(file, dest);
}

/** Set a `done` that broke the completion contract aside (in the outbox's `rejected/`). */
export function rejectDone(file: string): void {
  if (!fs.existsSync(file)) return;
  const dest = path.join(path.dirname(file), "rejected", path.basename(file));
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.renameSync(file, dest);
}

/** A body with whitespace collapsed and the dispatcher's own format warning removed, so the same text compares equal. */
function sameText(body: string): string {
  return body.replace(/^\[agent-lyceum\][^\n]*(\n|$)\s*/, "").replace(/\s+/g, " ").trim();
}

/**
 * An earlier mail from `from` to `to` with the same type, the same reply target and the same text (unread or already read):
 * sending it again changes nothing and is how two agents end up in a loop. Texts too short to mean anything are never duplicates.
 */
function earlierDuplicate(project: ResolvedProject, from: string, to: string, type: string, replyTo: string | undefined, body: string, held = false): Message | undefined {
  const text = sameText(body);
  if (text.length < 20) return undefined;
  const dir = inboxDir(project, to);
  const role = roleOfName(project.agents, to);
  const slots = held ? Object.values(project.agents).filter((a) => roleOfName(project.agents, a.name) === role).map((a) => inboxDir(project, a.name)) : [dir];
  const dirs = held ? [...slots.flatMap((d) => [d, path.join(d, "read")]), path.join(inboxDir(project, role), PENDING_DIR)] : [dir, path.join(dir, "read")];
  for (const d of dirs) {
    if (!fs.existsSync(d)) continue;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (!e.isFile() || !e.name.endsWith(".md") || e.name.startsWith(".")) continue;
      try {
        const m = readMessage(path.join(d, e.name));
        if (m.meta.from === from && m.meta.type === type && (m.meta.reply_to ?? "") === (replyTo ?? "") && sameText(m.body) === text) return m;
      } catch {
        /* an unreadable file is not a duplicate of anything */
      }
    }
  }
  return undefined;
}

/** What the router needs from the run to handle same-role instances (spec 23.7.1); a call without it routes as before. */
export interface InstanceRouting {
  /** The most instances `role` may have, and why it is lower than configured. */
  cap(role: string): InstanceCap;
  /** The role already has instances: its mail waits in `pending/`. */
  held(role: string): boolean;
  /** Make the role's instances durable (slot table, schema_version 3) before any file of the mail that opens them is written. */
  enable(role: string): void;
  /** A `parallel` field that was delivered as an ordinary mail, and why. */
  ignored(reason: string, meta: { from: string; id: string; to: string; subject: string }): void;
}

/** Validate each agent's outbox and move accepted mail into recipients' inboxes. Safe to run again after a crash. */
export function routeOutboxes(project: ResolvedProject, routing?: InstanceRouting): RouteResult {
  const res: RouteResult = { delivered: [], rejected: [], warnings: [], asks: [] };
  const journal = project.run ? new RouteJournal(project.run.dir) : undefined;
  for (const sender of Object.values(project.agents)) {
    const dir = outboxDir(project, sender.name);
    if (!fs.existsSync(dir)) continue;
    const files = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith(".md") && !e.name.startsWith("."))
      .map((e) => path.join(dir, e.name))
      .sort((a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs || a.localeCompare(b));

    for (const file of files) {
      const source = sourceIdOf(sender.name, file);
      const reject = (reason: string) => {
        deliverOnce(project, journal, `reject:${source}`, {
          from: "dispatcher",
          to: sender.name,
          type: "failure",
          subject: `Message ${path.basename(file)} was rejected`,
          body: `Your outbox message \`${path.basename(file)}\` was not delivered: ${reason}\n\nIt was moved to \`rejected/\`.`,
        });
        const dest = path.join(dir, "rejected", path.basename(file));
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.renameSync(file, dest);
        fault("route:moved");
        res.rejected.push({ from: sender.name, file: dest, reason });
      };

      let parsed: { data: Record<string, unknown>; body: string };
      try {
        parsed = parseRaw(fs.readFileSync(file, "utf8"));
      } catch (e) {
        reject(`invalid message format (${(e as Error).message}). Expected frontmatter with "to", "type", "subject".`);
        continue;
      }
      const d = parsed.data;
      if (project.run?.layout === "run" && d.run_id !== undefined && String(d.run_id) !== project.run.id) {
        reject(`it is addressed to run "${String(d.run_id)}", but this is run "${project.run.id}"; mail never crosses runs.`);
        continue;
      }
      const type = (d.type ?? "reply") as MessageType;
      if (!MESSAGE_TYPES.includes(type) || type === "failure") {
        reject(`unknown or not allowed message type "${String(d.type)}" (use task, reply, ask or done).`);
        continue;
      }
      const subject = String(d.subject ?? "(no subject)");

      if (type === "ask") {
        if (!sender.canAskUser) {
          reject(`you may not ask the user directly (can_ask_user is off for "${sender.name}"). Put the question in a reply to the lead ("${project.lead}"), who can ask.`);
          continue;
        }
        res.asks.push({ from: sender.name, subject, body: parsed.body, file, source });
        continue;
      }

      if (type === "done") {
        if (sender.name !== project.lead) {
          reject(`only the lead ("${project.lead}") may send a "done" message.`);
          continue;
        }
        const over = RECORD_KINDS.map((k) => ({ k, n: activeRecordsBytes(project, k) })).filter((x) => x.n > RECORDS_BUDGET);
        if (over.length) {
          reject(
            `${over.map((x) => `records/${x.k} hold ${x.n} bytes of active entries`).join(" and ")}; the budget is ${RECORDS_BUDGET} bytes (6 KB) per kind. Merge entries, or mark obsolete ones "status: superseded" (or name them in a newer entry's "supersedes"), then send "done" again.`,
          );
          continue;
        }
        res.done = { from: sender.name, subject, body: parsed.body, file, meta: d };
        const ds = parseSteps(parsed.body);
        if (ds.length) res.steps = ds;
        continue;
      }

      const targets = Array.isArray(d.to) ? d.to.map(String) : d.to ? [String(d.to)] : [];
      if (targets.length === 0) {
        reject(`missing "to".`);
        continue;
      }
      const roleOf = (n: string) => roleOfName(project.agents, n);
      if (sender.instance) {
        const same = targets.find((t) => t !== sender.name && roleOf(t) === roleOf(sender.name));
        if (same !== undefined) {
          reject(`cannot message another instance of your own role ("${same}" is an instance of "${roleOf(sender.name)}"). Put what it needs in your reply to the lead.`);
          continue;
        }
      }
      const bad = targets.find(
        (t) => !project.agents[t] || t === sender.name || (sender.canMessage !== "all" && !sender.canMessage.includes(roleOf(t))),
      );
      if (bad !== undefined) {
        const why = !project.agents[bad]
          ? `no such agent "${bad}"`
          : bad === sender.name
            ? "cannot message yourself"
            : `you may only message: ${(sender.canMessage as string[]).join(", ") || "(nobody)"}`;
        reject(why + ".");
        continue;
      }

      // `parallel` is read here from the outbox file, but only a verdict on it is kept: it goes to the journal (never back into the mail).
      const flags = new Map<string, ReturnType<typeof parallelFlag>>();
      if (routing && d.parallel !== undefined) {
        for (const t of targets) {
          const role = roleOf(t);
          flags.set(t, parallelFlag({ value: d.parallel, senderIsLead: sender.name === project.lead, type, replyTo: d.reply_to, thread: d.thread, cap: routing.cap(role) }));
        }
        if ([...flags.values()].includes("invalid")) {
          reject(`parallel must be true or false (YAML boolean), not ${JSON.stringify(d.parallel)}. Write \`parallel: true\` on a new task to run it in a parallel instance, or leave the line out.`);
          continue;
        }
      }

      const missing = missingSections(type, parsed.body);
      if (missing.length && project.run?.layout === "run") {
        const key = formatRejectionKey(sender.name, type, subject);
        if (formatRejections(project.run.dir, key) < MAX_FORMAT_REJECTIONS) {
          const n = countFormatRejection(project.run.dir, key);
          reject(
            `this ${type} is missing required section(s): ${missing.map((s) => `\`## ${s}\``).join(", ")}. Add them (write \`None\` where a section is empty) and send it again. (Attempt ${n} of ${MAX_FORMAT_REJECTIONS}; after that it is delivered with a warning.)`,
          );
          continue;
        }
      }
      const replyTo = d.reply_to ? String(d.reply_to) : undefined;
      const thread = d.thread ? String(d.thread) : undefined;
      // Mail whose delivery was already planned (a replay after a crash) is not a repeat of itself.
      const repeats = new Map<string, Message>();
      for (const to of targets) {
        if (journal?.get(source, to)) continue;
        const earlier = earlierDuplicate(project, sender.name, to, type, replyTo, parsed.body, !!routing?.held(roleOf(to)));
        if (earlier) repeats.set(to, earlier);
      }
      const repeatNote = (): string =>
        [...repeats]
          .map(([to, m]) => `to "${to}" it repeats mail ${m.meta.id} ("${m.meta.subject}", ${m.meta.created}) with the same content`)
          .join("; ");
      const REPEAT_HELP =
        "Do not send it again: if that mail has not been answered yet, wait for the reply; if you need something different, change what you ask for; if the work is finished, the lead sends `done`.";
      if (repeats.size === targets.length) {
        reject(`it is a duplicate: ${repeatNote()}, so it was not sent again. ${REPEAT_HELP}`);
        continue;
      }
      if (repeats.size) {
        deliverOnce(project, journal, `dup:${source}`, {
          from: "dispatcher",
          to: sender.name,
          type: "failure",
          subject: `Part of ${path.basename(file)} was not sent`,
          body: `Your outbox message \`${path.basename(file)}\` was delivered, except that ${repeatNote()}. ${REPEAT_HELP}`,
        });
        res.rejected.push({ from: sender.name, file, reason: `duplicate: ${repeatNote()}` });
      }
      const body = missing.length ? `${formatWarning(type, missing)}\n\n${parsed.body}` : parsed.body;
      if (sender.name === project.lead) {
        const st = parseSteps(parsed.body);
        if (st.length) res.steps = st;
      }
      for (const to of targets) {
        if (repeats.has(to)) continue;
        const flag = flags.get(to);
        const role = roleOf(to);
        if (typeof flag === "object" && !journal?.get(source, to)) routing?.ignored(flag.ignored, { from: sender.name, id: deterministicId(source, to), to, subject });
        // The first valid parallel task makes the role's instances durable before a single file of this mail exists.
        if (routing && flag === "on" && !routing.held(role)) routing.enable(role);
        const held = !!routing?.held(role);
        const { msg, fresh } = deliverOnce(
          project,
          journal,
          source,
          { from: sender.name, to, type, subject, body, thread, reply_to: replyTo },
          {
            ...(held ? { held: true } : {}),
            ...(held && flag === "on" ? { parallel: true } : {}),
            ...(routing?.held(roleOf(sender.name)) ? { from: sender.name } : {}),
          },
        );
        if (!fresh) continue;
        res.delivered.push({ from: sender.name, to, id: msg.meta.id, file: msg.file, type, subject });
        if (missing.length) res.warnings.push({ from: sender.name, id: msg.meta.id, subject, missing });
      }
      fault("route:source-done");
      fs.mkdirSync(path.join(dir, "sent"), { recursive: true });
      fs.renameSync(file, path.join(dir, "sent", path.basename(file)));
      fault("route:moved");
    }
  }
  return res;
}
