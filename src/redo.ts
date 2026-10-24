import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { cutUtf8, readRegularFileCappedNoFollow, trimPartialUtf8 } from "./fs-util.js";
import type { AttemptRecord, ClaimRecord } from "./message-store.js";

/** An earlier attempt of the same agent at the same message that failed: what a redo starts from. */
export interface PriorAttempt {
  /** `<claim id>-a<n>` */
  id: string;
  claimId: string;
  n: number;
  /** The attempt's error; "unknown (attempt record unreadable)" when its record cannot be read. */
  error: string;
  /** For sorting: finished_at ?? started_at ?? the folder's mtime (epoch ms). */
  at: number;
  /** Files the record says were set aside; absent when the record is unreadable. */
  parked?: string[];
}

/** Something left out; `path` is relative to the run folder. */
export interface Skip {
  path: string;
  reason: string;
}

export interface PriorResult {
  /** Valid candidates, newest first. */
  prior: PriorAttempt[];
  /** Records or folders that were passed over; they never affect the other candidates. */
  skipped: Skip[];
}

export interface DraftsResult {
  /** The whole drafts block; "" when there is nothing usable. */
  text: string;
  injected: { path: string; bytes: number; truncated: boolean }[];
  skipped: Skip[];
  /** Attempts whose folder and record disagree on what was set aside. */
  reconciled: { attempt: string; onlyOnDisk: string[]; onlyInRecord: string[] }[];
}

const METADATA_LIMIT = 64 * 1024;
const DRAFT_BUDGET = 4096;
const DRAFT_FILES = 5;
const OUTBOX_SCAN = 64;
const UNREADABLE = "unknown (attempt record unreadable)";

const hasControl = (s: string): boolean => [...s].some((ch) => ch.charCodeAt(0) < 0x20);

/** Can `s` be one path segment (a claim or attempt id taken from a file)? */
function isSegment(s: unknown): s is string {
  return typeof s === "string" && s.length >= 1 && s.length <= 200 && !/[/\\]/.test(s) && !s.includes("\0") && s !== "." && s !== ".." && !s.startsWith(".");
}

/** Read a claim or attempt JSON without following a symlink or blocking on a FIFO, at most 64 KiB. Never throws. */
function readMetadataJson(file: string): { value: unknown } | { skip: string } {
  const r = readRegularFileCappedNoFollow(file, METADATA_LIMIT);
  if (!r.ok) return { skip: r.reason };
  if (r.truncated) return { skip: "metadata_too_large" };
  try {
    return { value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(r.buf)) };
  } catch {
    return { skip: "metadata_unreadable" };
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/** The attempt record, or the reason it is not usable. The id that builds paths must equal the file name. */
function validAttempt(v: unknown, fileBase: string): AttemptRecord | string {
  if (!isObject(v)) return "bad_record";
  const { id, claim_id: claimId, agent, status, n } = v;
  if (typeof id !== "string" || typeof agent !== "string" || typeof status !== "string") return "bad_record";
  if (!isSegment(claimId) || !Number.isSafeInteger(n) || (n as number) < 1) return "bad_record";
  if (id !== fileBase || id !== `${claimId}-a${n}`) return "bad_record";
  return { ...v, id, claim_id: claimId, agent, status, n, error: str(v.error), started_at: str(v.started_at) ?? "", finished_at: str(v.finished_at) } as AttemptRecord;
}

function validClaim(v: unknown, claimId: string): ClaimRecord | string {
  if (!isObject(v) || v.id !== claimId || typeof v.agent !== "string" || typeof v.status !== "string") return "bad_record";
  if (!Array.isArray(v.message_ids) || !v.message_ids.every((x) => typeof x === "string")) return "bad_record";
  return v as unknown as ClaimRecord;
}

const rel = (...p: string[]) => path.join(...p);

/** lstat each level: a real folder, or the reason it is not one ("missing" when it does not exist). */
function realDir(file: string): "ok" | "missing" | "ancestor_symlink" | "not_dir" {
  try {
    const st = fs.lstatSync(file);
    if (st.isSymbolicLink()) return "ancestor_symlink";
    return st.isDirectory() ? "ok" : "not_dir";
  } catch {
    return "missing";
  }
}

/** The attempt folder's mtime in ms, 0 when it cannot be read. */
function dirMtime(dir: string): number {
  try {
    return fs.lstatSync(dir).mtimeMs;
  } catch {
    return 0;
  }
}

/** Attempts of `agent` that failed before this invoke, on a claim for one of `messageIds`. Never throws. */
export function priorFailedAttempts(runDir: string, agent: string, messageIds: string[], exclude: string): PriorResult {
  const skipped: Skip[] = [];
  const empty = (): PriorResult => ({ prior: [], skipped });
  const levels = [".", "mail", rel("mail", "attempts"), rel("mail", "claims")];
  for (const l of levels) {
    const st = realDir(path.join(runDir, l));
    if (st === "ancestor_symlink" || st === "not_dir") {
      skipped.push({ path: l, reason: st });
      return empty();
    }
    if (st === "missing") {
      if (l === rel("mail", "claims") && realDir(path.join(runDir, "mail", "attempts")) === "ok") skipped.push({ path: l, reason: "metadata_missing" });
      return empty();
    }
  }
  const dir = path.join(runDir, "mail", "attempts");
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch (e) {
    skipped.push({ path: rel("mail", "attempts"), reason: `open_error:${(e as NodeJS.ErrnoException).code ?? "unknown"}` });
    return empty();
  }
  // Candidates by claim id; an attempt without a usable record is kept as "unreadable".
  const found: PriorAttempt[] = [];
  const recorded = new Set<string>();
  for (const name of names.filter((x) => x.endsWith(".json")).sort()) {
    const base = name.slice(0, -5);
    const file = rel("mail", "attempts", name);
    const r = readMetadataJson(path.join(dir, name));
    if ("skip" in r) {
      skipped.push({ path: file, reason: r.skip });
      continue;
    }
    const rec = validAttempt(r.value, base);
    if (typeof rec === "string") {
      skipped.push({ path: file, reason: rec });
      continue;
    }
    recorded.add(base);
    if (rec.status !== "failed" || rec.agent !== agent || rec.id === exclude) continue;
    const t = [rec.finished_at, rec.started_at].map((s) => (s ? Date.parse(s) : NaN)).find((x) => Number.isFinite(x));
    found.push({ id: rec.id, claimId: rec.claim_id, n: rec.n, error: rec.error ?? "unknown error", at: t ?? dirMtime(path.join(dir, rec.id)), parked: Array.isArray(rec.parked) ? rec.parked.filter((x) => typeof x === "string") : undefined });
  }
  for (const name of names.filter((x) => !x.endsWith(".json") && !recorded.has(x))) {
    const m = /^(.+)-a([1-9]\d*)$/.exec(name);
    if (!m || !isSegment(m[1]) || name === exclude || realDir(path.join(dir, name)) !== "ok") continue;
    found.push({ id: name, claimId: m[1], n: Number(m[2]), error: UNREADABLE, at: dirMtime(path.join(dir, name)) });
  }
  const accepted = new Map<string, boolean>();
  const usable = (claimId: string): boolean => {
    const known = accepted.get(claimId);
    if (known !== undefined) return known;
    const file = rel("mail", "claims", `${claimId}.json`);
    let ok = false;
    const r = readMetadataJson(path.join(runDir, file));
    if ("skip" in r) skipped.push({ path: file, reason: r.skip });
    else {
      const claim = validClaim(r.value, claimId);
      if (typeof claim === "string") skipped.push({ path: file, reason: claim });
      else ok = claim.agent === agent && (claim.status === "claimed" || claim.status === "abandoned") && claim.message_ids.some((id) => messageIds.includes(id));
    }
    accepted.set(claimId, ok);
    return ok;
  };
  const prior = found.filter((a) => usable(a.claimId)).sort((a, b) => b.at - a.at || b.n - a.n);
  return { prior, skipped };
}

interface Candidate {
  attempt: PriorAttempt;
  rel: string;
  name: string;
}

/** The drafts block for the attempts in `prior` (newest first), read from their folders, at most `budget` bytes and `maxFiles` files. */
export function collectDrafts(runDir: string, prior: PriorAttempt[], budget = DRAFT_BUDGET, maxFiles = DRAFT_FILES): DraftsResult {
  const result: DraftsResult = { text: "", injected: [], skipped: [], reconciled: [] };
  const candidates: Candidate[] = [];
  for (const a of prior) {
    const outboxRel = rel("mail", "attempts", a.id, "outbox");
    const parts = [rel("mail", "attempts", a.id), outboxRel];
    const bad = parts.map((p) => ({ p, st: realDir(path.join(runDir, p)) })).find((x) => x.st !== "ok");
    if (bad) {
      // A missing outbox just means nothing was set aside.
      if (bad.st !== "missing") result.skipped.push({ path: bad.p, reason: bad.st });
      continue;
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(path.join(runDir, outboxRel), { withFileTypes: true }).sort((x, y) => (x.name < y.name ? -1 : 1));
    } catch (e) {
      result.skipped.push({ path: outboxRel, reason: `open_error:${(e as NodeJS.ErrnoException).code ?? "unknown"}` });
      continue;
    }
    if (entries.length > OUTBOX_SCAN) result.skipped.push({ path: outboxRel, reason: "over_entry_cap" });
    const onDisk: string[] = [];
    for (const e of entries.slice(0, OUTBOX_SCAN)) {
      const file = rel(outboxRel, e.name);
      if (e.name.startsWith(".")) continue;
      if (!e.isFile()) {
        result.skipped.push({ path: file, reason: e.isSymbolicLink() ? "symlink" : "not_regular" });
        continue;
      }
      if (hasControl(e.name) || e.name.length > 200) {
        result.skipped.push({ path: file, reason: "bad_name" });
        continue;
      }
      onDisk.push(e.name);
      candidates.push({ attempt: a, rel: file, name: e.name });
    }
    if (a.parked) {
      const onlyOnDisk = onDisk.filter((x) => !a.parked?.includes(x));
      const onlyInRecord = a.parked.filter((x) => !onDisk.includes(x));
      if (onlyOnDisk.length || onlyInRecord.length) result.reconciled.push({ attempt: a.id, onlyOnDisk, onlyInRecord });
    }
  }
  if (candidates.length === 0) return result;

  const header = "# Drafts from your failed attempt (unverified, not delivered)\nThese files were in your outbox when an earlier attempt at this message failed. They were set aside and never delivered; they may be incomplete or wrong. Check them against the repository before reusing any of them.\n";
  const more = (n: number, c: Candidate) => `(${n} more draft file(s) not shown: ${rel("mail", "attempts", c.attempt.id, "outbox")}/)`;
  const render = (c: Candidate, content: string, truncated: boolean, size: number): string => {
    const longest = Math.max(0, ...(content.match(/`+/g) ?? []).map((x) => x.length));
    const fence = "`".repeat(Math.max(3, longest + 1));
    return `\n## ${c.rel} (attempt ${c.attempt.n}, ${c.attempt.error})\n${fence}\n${content}\n${fence}\n${truncated ? `[truncated: ${c.rel}, ${size} B]\n` : ""}`;
  };
  const bytes = (s: string) => Buffer.byteLength(s);
  const reserve = Math.max(...candidates.map((c) => bytes(`\n${more(999, c)}\n`)));
  let used = bytes(header);
  let text = header;
  const seen = new Set<string>();
  let shown = 0;
  let left = candidates.length;
  for (const c of candidates) {
    if (shown >= maxFiles) break;
    const room = budget - used - reserve;
    const overhead = bytes(render(c, "", true, Number.MAX_SAFE_INTEGER));
    if (room - overhead < 1) break;
    left--;
    const r = readRegularFileCappedNoFollow(path.join(runDir, c.rel), room - overhead);
    if (!r.ok) {
      result.skipped.push({ path: c.rel, reason: r.reason });
      continue;
    }
    // The capped read can end inside a character: drop the incomplete tail before decoding.
    if (r.truncated) r.buf = trimPartialUtf8(r.buf);
    if (r.buf.includes(0)) {
      result.skipped.push({ path: c.rel, reason: "binary" });
      continue;
    }
    if (!r.truncated) {
      const h = crypto.createHash("sha256").update(r.buf).digest("hex");
      if (seen.has(h)) continue;
      seen.add(h);
    }
    // Backtick-heavy content lengthens the fence; trim until the block fits.
    let lim = r.buf.length;
    let block = render(c, "", r.truncated, r.size);
    for (;;) {
      const cut = cutUtf8(r.buf, lim);
      block = render(c, cut.toString("utf8"), r.truncated || cut.length < r.buf.length, r.size);
      if (bytes(block) <= room || lim <= 0) break;
      lim = cut.length - (bytes(block) - room);
    }
    if (bytes(block) > room) {
      left++;
      break;
    }
    text += block;
    used += bytes(block);
    shown++;
    result.injected.push({ path: c.rel, bytes: r.size, truncated: block.includes(`[truncated: ${c.rel},`) });
  }
  if (shown === 0) return result;
  const rest = candidates.filter((c) => !result.injected.some((i) => i.path === c.rel) && !result.skipped.some((s) => s.path === c.rel));
  if (left > 0 && rest[0]) text += `${more(rest.length, rest[0])}\n`;
  result.text = text.trimEnd();
  return result;
}

const TASK_MEMORY = (dir?: string) => (dir ? ` Read your task memory (\`${dir}\`) first: progress you recorded there survives a failed attempt.` : "");

/** Prompt for a repeat attempt in the same wake-up: the earlier one failed and may have changed things already. */
export function retryPrompt(prompt: string, error: string | undefined, o: { drafts: boolean; taskMemory?: string }): string {
  const mail = o.drafts ? "Its mail was set aside, not delivered: see the drafts below." : "Its mail was discarded.";
  return `${prompt}\n\n# Retry notice\nYour previous attempt at this wake-up failed${error ? ` (${error})` : ""} after possibly changing files already. ${mail} Check the current state of the repository before redoing the work, and send the mail again.${TASK_MEMORY(o.taskMemory)}`;
}

/** The user prompt for this invoke: `base`, a Retry or Redo notice when there is something to redo, then the drafts. No IO. */
export function redoUserPrompt(base: string, o: { attempt: number; error?: string; prior: PriorAttempt[]; drafts: string; taskMemory?: string }): string {
  const tail = o.drafts ? `\n\n${o.drafts}` : "";
  if (o.attempt > 0) return `${retryPrompt(base, o.error, { drafts: !!o.drafts, taskMemory: o.taskMemory })}${tail}`;
  const last = o.prior[0];
  if (!last) return base;
  return `${base}\n\n# Redo notice\nAn earlier attempt at this message did not finish (${last.error}; attempt ${last.id}). It may have changed files already, and its mail was set aside, not delivered${o.drafts ? ": see the drafts below" : ""}. Check the current state of the repository before redoing the work, and send the mail again.${TASK_MEMORY(o.taskMemory)}${tail}`;
}
