import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { atomicWrite } from "./fs-util.js";

/** Test seam: called after every durable step of routing and claim commits, so a test can "kill the process" there. */
let faultHook: ((step: string) => void) | undefined;
export function setFaultHook(fn: ((step: string) => void) | undefined): void {
  faultHook = fn;
}
export function fault(step: string): void {
  faultHook?.(step);
}

export const mailDir = (runDir: string): string => path.join(runDir, "mail");

// ---- route journal: which (source, recipient) deliveries were planned and completed ----

export interface JournalEntry {
  source: string;
  to: string;
  msg_id: string;
  /** Inbox file name chosen when the delivery was planned, so a retry writes the same file. */
  file: string;
  created: string;
  delivered: boolean;
  /** Same-role instances (spec 23): the mail waits in `inbox/<role>/pending/` for the assigner. Only written for an activated role. */
  held?: true;
  /** The lead marked it `parallel: true` (read only from here, never from the mail file). */
  parallel?: true;
  /** The instance of an activated role that sent it. */
  from?: string;
  /** The instance a dispatcher notice is about. */
  about?: string;
  /** Position of the intent among the journal's records (a line cut short by a crash does not count). */
  seq?: number;
}

/** What the journal knows about one message id: where the assigner put it, who sent it or what it is about, and its delivery line. */
export interface Ownership {
  assign?: string;
  from?: string;
  about?: string;
  intent?: { seq: number; to: string; file: string; source: string; msg_id: string };
}

/** Append-only log of deliveries. A delivery is identified by `(source, recipient)`, never by a random id. */
export class RouteJournal {
  private readonly file: string;
  private readonly entries = new Map<string, JournalEntry>();
  private readonly byMsg = new Map<string, JournalEntry>();
  private readonly byFileName = new Map<string, JournalEntry>();
  private readonly assigns = new Map<string, { slot: string; file: string; role: string }>();
  private readonly firstHeldSeq = new Map<string, number>();
  private seqNext = 0;

  constructor(runDir: string) {
    this.file = path.join(mailDir(runDir), "journal.jsonl");
    let text = "";
    try {
      text = fs.readFileSync(this.file, "utf8");
    } catch {
      return;
    }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const j = JSON.parse(line);
        const key = `${j.source}\u0000${j.to}`;
        if (j.t === "intent") {
          this.index({
            source: j.source,
            to: j.to,
            msg_id: j.msg_id,
            file: j.file,
            created: j.created,
            delivered: false,
            ...(j.held === true ? { held: true as const } : {}),
            ...(j.parallel === true ? { parallel: true as const } : {}),
            ...(typeof j.from === "string" ? { from: j.from } : {}),
            ...(typeof j.about === "string" ? { about: j.about } : {}),
          });
        } else if (j.t === "delivered") {
          const e = this.entries.get(key);
          if (e) e.delivered = true;
        } else if (j.t === "assign" && typeof j.msg_id === "string" && typeof j.slot === "string") {
          this.assigns.set(j.msg_id, { slot: j.slot, file: String(j.file), role: String(j.role) });
        }
      } catch {
        /* a line cut short by a crash: ignore it */
      }
    }
  }

  /** Enter an intent in every index; `seq` is its position among the records read or appended. */
  private index(e: JournalEntry): JournalEntry {
    e.seq = this.seqNext++;
    this.entries.set(`${e.source}\u0000${e.to}`, e);
    this.byMsg.set(e.msg_id, e);
    this.byFileName.set(e.file, e);
    if (e.held && !this.firstHeldSeq.has(e.to)) this.firstHeldSeq.set(e.to, e.seq);
    return e;
  }

  get(source: string, to: string): JournalEntry | undefined {
    return this.entries.get(`${source}\u0000${to}`);
  }

  private append(obj: Record<string, unknown>): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const fd = fs.openSync(this.file, "a+");
    try {
      let text = `${JSON.stringify(obj)}\n`;
      // A crash or a short write can leave the last line without its newline; appending straight after it would glue the two into one
      // unreadable line. The real tail is read on every append (one byte), so no cached check can go stale, even with another writer.
      const size = fs.fstatSync(fd).size;
      if (size > 0) {
        const last = Buffer.alloc(1);
        fs.readSync(fd, last, 0, 1, size - 1);
        if (last[0] !== 0x0a) text = `\n${text}`;
      }
      const bytes = Buffer.from(text);
      const written = fs.writeSync(fd, bytes);
      if (written < bytes.length) throw new Error(`Short write to ${this.file}: ${written} of ${bytes.length} bytes (disk full?). Resume the run after freeing space.`);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }

  intent(e: Omit<JournalEntry, "delivered" | "seq">): JournalEntry {
    this.append({ t: "intent", ...e });
    return this.index({ ...e, delivered: false });
  }

  /** The assigner's decision for a held mail, made durable before the file moves (spec 23.7.2). */
  assign(a: { msg_id: string; file: string; role: string; slot: string }): void {
    this.append({ t: "assign", ...a });
    this.assigns.set(a.msg_id, { slot: a.slot, file: a.file, role: a.role });
  }

  assigned(msgId: string): { slot: string; file: string; role: string } | undefined {
    return this.assigns.get(msgId);
  }

  byFile(file: string): JournalEntry | undefined {
    return this.byFileName.get(file);
  }

  /** Position of the first held intent addressed to `name`; undefined when there is none. */
  firstHeld(name: string): number | undefined {
    return this.firstHeldSeq.get(name);
  }

  ownership(msgId: string): Ownership | undefined {
    const intent = this.byMsg.get(msgId);
    const assign = this.assigns.get(msgId)?.slot;
    if (!intent && assign === undefined) return undefined;
    return {
      ...(assign !== undefined ? { assign } : {}),
      ...(intent?.from ? { from: intent.from } : {}),
      ...(intent?.about ? { about: intent.about } : {}),
      ...(intent ? { intent: { seq: intent.seq as number, to: intent.to, file: intent.file, source: intent.source, msg_id: intent.msg_id } } : {}),
    };
  }

  delivered(source: string, to: string): void {
    this.append({ t: "delivered", source, to });
    const e = this.entries.get(`${source}\u0000${to}`);
    if (e) e.delivered = true;
  }
}

/** Stable id of one outbox file instance: who wrote it, its name, when, and what it said. */
export function sourceIdOf(sender: string, file: string): string {
  const st = fs.statSync(file);
  return crypto
    .createHash("sha256")
    .update(`${sender}\0${path.basename(file)}\0${Math.round(st.mtimeMs)}\0`)
    .update(fs.readFileSync(file))
    .digest("hex")
    .slice(0, 16);
}

export function deterministicId(sourceKey: string, to: string): string {
  return crypto.createHash("sha256").update(`${sourceKey}\0${to}`).digest("hex").slice(0, 8);
}

// ---- input claims: the inbox mail a wake-up is working on ----

export type ClaimStatus = "claimed" | "output_ready" | "committed" | "abandoned";

export interface ClaimRecord {
  id: string;
  agent: string;
  message_ids: string[];
  files: string[];
  status: ClaimStatus;
  created: string;
}

const claimFile = (runDir: string, id: string) => path.join(mailDir(runDir), "claims", `${id}.json`);

function saveClaim(runDir: string, c: ClaimRecord): void {
  atomicWrite(claimFile(runDir, c.id), JSON.stringify(c, null, 2));
}

export function loadClaim(runDir: string, id: string): ClaimRecord {
  return JSON.parse(fs.readFileSync(claimFile(runDir, id), "utf8")) as ClaimRecord;
}

/** Record that `agent` is about to handle these messages. They stay unread until `commitClaim`. */
export function claimMessages(runDir: string, agent: string, messages: { file: string; meta: { id: string } }[]): ClaimRecord {
  const rec: ClaimRecord = {
    id: `${Date.now().toString(36)}-${agent}-${crypto.randomBytes(3).toString("hex")}`,
    agent,
    message_ids: messages.map((m) => m.meta.id),
    files: messages.map((m) => m.file),
    status: "claimed",
    created: new Date().toISOString(),
  };
  saveClaim(runDir, rec);
  return rec;
}

/** The wake-up was stopped before it finished: its input stays unread and will be handled again. */
export function abandonClaim(runDir: string, claimId: string): void {
  const c = loadClaim(runDir, claimId);
  if (c.status === "claimed" || c.status === "output_ready") saveClaim(runDir, { ...c, status: "abandoned" });
}

/** The wake-up finished and left its output in the outbox; from here on the output is routed, not redone. */
export function markOutputReady(runDir: string, claimId: string): void {
  const c = loadClaim(runDir, claimId);
  if (c.status === "claimed") saveClaim(runDir, { ...c, status: "output_ready" });
}

function moveToRead(file: string): boolean {
  if (!fs.existsSync(file)) return false;
  const dest = path.join(path.dirname(file), "read", path.basename(file));
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.renameSync(file, dest);
  return true;
}

/** Mark the claim committed, then move its input to `read/`. Safe to repeat after a crash. */
export function commitClaim(runDir: string, claimId: string): void {
  const c = loadClaim(runDir, claimId);
  if (c.status !== "committed") saveClaim(runDir, { ...c, status: "committed" });
  fault("claim:marked");
  for (const f of c.files) {
    moveToRead(f);
    fault("claim:moved");
  }
}

// ---- attempts: one invocation of an agent for a claim ----

export type AttemptStatus = "started" | "output_ready" | "committed" | "failed";

export interface AttemptRecord {
  /** `<claim id>-a<n>` */
  id: string;
  claim_id: string;
  agent: string;
  n: number;
  status: AttemptStatus;
  started_at: string;
  finished_at?: string;
  error?: string;
  /** Outbox files set aside because this attempt did not succeed. */
  parked?: string[];
}

const attemptFile = (runDir: string, id: string) => path.join(mailDir(runDir), "attempts", `${id}.json`);
export const attemptLogDir = (runDir: string, id: string): string => path.join(mailDir(runDir), "attempts", id, "log");
export const attemptOutboxDir = (runDir: string, id: string): string => path.join(mailDir(runDir), "attempts", id, "outbox");

function saveAttempt(runDir: string, a: AttemptRecord): void {
  atomicWrite(attemptFile(runDir, a.id), JSON.stringify(a, null, 2));
}

export function loadAttempt(runDir: string, id: string): AttemptRecord {
  return JSON.parse(fs.readFileSync(attemptFile(runDir, id), "utf8")) as AttemptRecord;
}

export function listAttempts(runDir: string): AttemptRecord[] {
  const dir = path.join(mailDir(runDir), "attempts");
  if (!fs.existsSync(dir)) return [];
  const out: AttemptRecord[] = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".json")).sort()) {
    try {
      out.push(JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as AttemptRecord);
    } catch {
      /* skip */
    }
  }
  return out;
}

/**
 * One more than the highest number any entry under `attempts/` already uses for this claim. Only names count (a damaged JSON or a
 * bare folder still holds its number), because a new attempt's paths come from the name and a rename would overwrite them.
 */
function nextAttemptNumber(runDir: string, claimId: string): number {
  const dir = path.join(mailDir(runDir), "attempts");
  const re = new RegExp(`^${claimId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-a(\\d+)(\\.json)?$`);
  let max = 0;
  if (fs.existsSync(dir)) {
    for (const name of fs.readdirSync(dir)) {
      const m = re.exec(name);
      const used = m ? Number(m[1]) : 0;
      if (Number.isSafeInteger(used) && used > max) max = used;
    }
  }
  if (!Number.isSafeInteger(max + 1)) throw new Error(`attempt numbers exhausted for claim ${claimId} (highest used: ${max}) in ${dir}`);
  return max + 1;
}

/** Start the next attempt for a claim (a1, a2, ...). */
export function beginAttempt(runDir: string, claimId: string): AttemptRecord {
  const claim = loadClaim(runDir, claimId);
  const n = nextAttemptNumber(runDir, claimId);
  const rec: AttemptRecord = { id: `${claimId}-a${n}`, claim_id: claimId, agent: claim.agent, n, status: "started", started_at: new Date().toISOString() };
  saveAttempt(runDir, rec);
  return rec;
}

export function finishAttempt(runDir: string, attemptId: string, status: Exclude<AttemptStatus, "started">, extra: { error?: string; parked?: string[] } = {}): AttemptRecord {
  const rec = { ...loadAttempt(runDir, attemptId), status, finished_at: new Date().toISOString(), ...extra };
  saveAttempt(runDir, rec);
  return rec;
}

/** Move whatever is in an agent's outbox into the attempt's own folder, so it can never be mistaken for a later attempt's result. */
export function parkOutbox(runDir: string, outbox: string, attemptId: string): string[] {
  if (!fs.existsSync(outbox)) return [];
  const moved: string[] = [];
  const dest = attemptOutboxDir(runDir, attemptId);
  for (const e of fs.readdirSync(outbox, { withFileTypes: true })) {
    if (!e.isFile() || e.name.startsWith(".")) continue;
    fs.mkdirSync(dest, { recursive: true });
    fs.renameSync(path.join(outbox, e.name), path.join(dest, e.name));
    fault("park:moved");
    moved.push(e.name);
  }
  return moved;
}

export interface RecoveryReport {
  /** Committed claims whose input had not been moved to `read/` yet; now it has. */
  finalized: string[];
  /** Claims that never produced output; their input stays unread and will be handled again. */
  abandoned: ClaimRecord[];
  /** Claims whose wake-up finished but whose output was not fully routed yet; the caller routes, then commits them. */
  ready: ClaimRecord[];
  /** Attempts that were running when the process died: failed now, their outbox set aside. External side effects may have happened. */
  interrupted: { attempt: AttemptRecord; parked: string[] }[];
}

/** Bring a run's claims back to a consistent state. Call before waking anyone on resume. */
export function recoverRunMail(runDir: string, opts: { outboxOf?: (agent: string) => string } = {}): RecoveryReport {
  const report: RecoveryReport = { finalized: [], abandoned: [], ready: [], interrupted: [] };
  for (const a of listAttempts(runDir)) {
    if (a.status !== "started") continue;
    const parked = opts.outboxOf ? parkOutbox(runDir, opts.outboxOf(a.agent), a.id) : [];
    const done = finishAttempt(runDir, a.id, "failed", { error: "interrupted", parked });
    report.interrupted.push({ attempt: done, parked });
  }
  const dir = path.join(mailDir(runDir), "claims");
  if (!fs.existsSync(dir)) return report;
  for (const name of fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
    let c: ClaimRecord;
    try {
      c = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")) as ClaimRecord;
    } catch {
      continue;
    }
    if (c.status === "committed") {
      let moved = false;
      for (const f of c.files) moved = moveToRead(f) || moved;
      if (moved) report.finalized.push(c.id);
    } else if (c.status === "claimed") {
      saveClaim(runDir, { ...c, status: "abandoned" });
      report.abandoned.push({ ...c, status: "abandoned" });
    } else if (c.status === "output_ready") report.ready.push(c);
  }
  return report;
}
