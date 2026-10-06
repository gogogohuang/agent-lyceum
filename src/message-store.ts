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
}

/** Append-only log of deliveries. A delivery is identified by `(source, recipient)`, never by a random id. */
export class RouteJournal {
  private readonly file: string;
  private readonly entries = new Map<string, JournalEntry>();

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
        if (j.t === "intent") this.entries.set(key, { source: j.source, to: j.to, msg_id: j.msg_id, file: j.file, created: j.created, delivered: false });
        else if (j.t === "delivered") {
          const e = this.entries.get(key);
          if (e) e.delivered = true;
        }
      } catch {
        /* a line cut short by a crash: ignore it */
      }
    }
  }

  get(source: string, to: string): JournalEntry | undefined {
    return this.entries.get(`${source}\u0000${to}`);
  }

  private append(obj: Record<string, unknown>): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const fd = fs.openSync(this.file, "a");
    try {
      fs.writeSync(fd, JSON.stringify(obj) + "\n");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }

  intent(e: Omit<JournalEntry, "delivered">): JournalEntry {
    this.append({ t: "intent", ...e });
    const entry = { ...e, delivered: false };
    this.entries.set(`${e.source}\u0000${e.to}`, entry);
    return entry;
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

export interface RecoveryReport {
  /** Committed claims whose input had not been moved to `read/` yet; now it has. */
  finalized: string[];
  /** Claims that never produced output; their input stays unread and will be handled again. */
  abandoned: ClaimRecord[];
  /** Claims whose wake-up finished but whose output was not fully routed yet; the caller routes, then commits them. */
  ready: ClaimRecord[];
}

/** Bring a run's claims back to a consistent state. Call before waking anyone on resume. */
export function recoverRunMail(runDir: string): RecoveryReport {
  const report: RecoveryReport = { finalized: [], abandoned: [], ready: [] };
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
