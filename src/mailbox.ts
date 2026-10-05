import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import type { ResolvedProject } from "./config.js";
import { formatWarning, missingSections } from "./format.js";
import { inboxDir, outboxDir } from "./policy.js";

export const MESSAGE_TYPES = ["task", "reply", "failure", "done"] as const;
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
  const data = YAML.parse(m[1]);
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("frontmatter is not a mapping");
  return { data: data as Record<string, unknown>, body: m[2].trim() };
}

/** Atomic write: temp file in the same dir, then rename. */
export function atomicWrite(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

export function ensureProjectDirs(project: ResolvedProject): void {
  fs.mkdirSync(path.join(project.paths.shared, "common"), { recursive: true });
  for (const name of Object.keys(project.agents)) {
    fs.mkdirSync(path.join(inboxDir(project, name), "read"), { recursive: true });
    fs.mkdirSync(path.join(outboxDir(project, name), "rejected"), { recursive: true });
    const a = project.agents[name];
    for (const m of [a.memory.global, a.memory.project]) if (m) fs.mkdirSync(m, { recursive: true });
  }
}

/** Deliver a message into `to`'s inbox (dispatcher-side; senders other than agents allowed). */
export function deliver(
  project: ResolvedProject,
  input: { from: string; to: string; type: MessageType; subject: string; body: string; thread?: string; reply_to?: string },
): Message {
  const id = newId();
  const meta: MessageMeta = {
    id,
    from: input.from,
    to: input.to,
    thread: input.thread ?? input.reply_to ?? id,
    ...(input.reply_to ? { reply_to: input.reply_to } : {}),
    type: input.type,
    subject: input.subject,
    created: new Date().toISOString(),
  };
  const file = path.join(inboxDir(project, input.to), `${stamp()}-${input.from}-${id}.md`);
  atomicWrite(file, serialize(meta, input.body));
  return { meta, body: input.body, file };
}

export function readMessage(file: string): Message {
  const { data, body } = parseRaw(fs.readFileSync(file, "utf8"));
  const meta = data as unknown as MessageMeta;
  return { meta, body, file };
}

export function listUnread(project: ResolvedProject, agent: string): Message[] {
  const dir = inboxDir(project, agent);
  if (!fs.existsSync(dir)) return [];
  const files = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".md") && !e.name.startsWith("."))
    .map((e) => path.join(dir, e.name))
    .sort();
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
  delivered: { from: string; to: string; id: string; file: string }[];
  rejected: { from: string; file: string; reason: string }[];
  /** Mail that was delivered but lacks required sections (see format.ts). */
  warnings: { from: string; id: string; subject: string; missing: string[] }[];
  done?: { from: string; subject: string; body: string };
}

/** Validate each agent's outbox and move accepted mail into recipients' inboxes. */
export function routeOutboxes(project: ResolvedProject): RouteResult {
  const res: RouteResult = { delivered: [], rejected: [], warnings: [] };
  for (const sender of Object.values(project.agents)) {
    const dir = outboxDir(project, sender.name);
    if (!fs.existsSync(dir)) continue;
    const files = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith(".md") && !e.name.startsWith("."))
      .map((e) => path.join(dir, e.name))
      .sort((a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs || a.localeCompare(b));

    for (const file of files) {
      const reject = (reason: string) => {
        const dest = path.join(dir, "rejected", path.basename(file));
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.renameSync(file, dest);
        res.rejected.push({ from: sender.name, file: dest, reason });
        deliver(project, {
          from: "dispatcher",
          to: sender.name,
          type: "failure",
          subject: `Message ${path.basename(file)} was rejected`,
          body: `Your outbox message \`${path.basename(file)}\` was not delivered: ${reason}\n\nIt was moved to \`rejected/\`.`,
        });
      };

      let parsed: { data: Record<string, unknown>; body: string };
      try {
        parsed = parseRaw(fs.readFileSync(file, "utf8"));
      } catch (e) {
        reject(`invalid message format (${(e as Error).message}). Expected frontmatter with "to", "type", "subject".`);
        continue;
      }
      const d = parsed.data;
      const type = (d.type ?? "reply") as MessageType;
      if (!MESSAGE_TYPES.includes(type) || type === "failure") {
        reject(`unknown or not allowed message type "${String(d.type)}" (use task, reply or done).`);
        continue;
      }
      const subject = String(d.subject ?? "(no subject)");

      if (type === "done") {
        if (sender.name !== project.lead) {
          reject(`only the lead ("${project.lead}") may send a "done" message.`);
          continue;
        }
        const dest = path.join(path.dirname(file), "read", path.basename(file));
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.renameSync(file, dest);
        res.done = { from: sender.name, subject, body: parsed.body };
        continue;
      }

      const targets = Array.isArray(d.to) ? d.to.map(String) : d.to ? [String(d.to)] : [];
      if (targets.length === 0) {
        reject(`missing "to".`);
        continue;
      }
      const bad = targets.find(
        (t) => !project.agents[t] || t === sender.name || (sender.canMessage !== "all" && !sender.canMessage.includes(t)),
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

      const replyTo = d.reply_to ? String(d.reply_to) : undefined;
      const thread = d.thread ? String(d.thread) : undefined;
      const missing = missingSections(type, parsed.body);
      const body = missing.length ? `${formatWarning(type, missing)}\n\n${parsed.body}` : parsed.body;
      for (const to of targets) {
        const m = deliver(project, { from: sender.name, to, type, subject, body, thread, reply_to: replyTo });
        res.delivered.push({ from: sender.name, to, id: m.meta.id, file: m.file });
        if (missing.length) res.warnings.push({ from: sender.name, id: m.meta.id, subject, missing });
      }
      fs.mkdirSync(path.join(dir, "sent"), { recursive: true });
      fs.renameSync(file, path.join(dir, "sent", path.basename(file)));
    }
  }
  return res;
}
