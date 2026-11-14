import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ApprovalError } from './approval-error.js';
import { type ApprovalIo, defaultApprovalIo, readApprovalFile } from './approval-io.js';
import type { Sequence } from './approval-types.js';

/**
 * Slot high-water helpers (`<slot root>/collected.seq`, decimal + LF) and sequence selection.
 *
 * CONCURRENCY CONTRACT: every helper here must be called while the caller holds the COMMON
 * per-slot exclusive coordination, identified by the canonical slot root (run:
 * requests/projects/<project>/<run-id>/<slot>; call: requests/calls/<call-id>). Rotation, manual
 * requests gc and orphan-slot cleanup must share that one identity/protocol, from reading the
 * high-water and scanning collected/ (or choosing the gc target) until the whole operation
 * finishes: rotate = proposals check, directory rename, recreate empty proposals, advance;
 * gc = re-confirm target, advance high-water first, rename/delete collected dir, remove `.done`.
 * An existing run/call lease is NOT evidence that this holds. Nothing here locks, allocates or
 * guarantees safety under concurrent callers; two unsynchronized read-max/rename sequences can
 * go backwards. Stage 3/6 must serialize or refuse overlap before wiring these in.
 *
 * Callers must pass `root` = the canonical approval home; every component below it is lstat-checked.
 */

export type HighWaterFault = 'temp_written' | 'temp_synced' | 'renamed';
export interface HighWaterDeps {
  readonly root: string;
  readonly io?: ApprovalIo;
  readonly token?: () => string;
  /** Called after each step of advance; a throw simulates a process crash there. */
  readonly fault?: (point: HighWaterFault) => void;
}

const HIGH_WATER_LIMIT = 32;

function codeOf(e: unknown): string | undefined {
  return (e as NodeJS.ErrnoException | null)?.code;
}
function corrupt(file: string, why: string, cause?: unknown): ApprovalError {
  return new ApprovalError('CORRUPT_HIGH_WATER', `Slot high-water is invalid (${why}): ${file}`, file,
    cause === undefined ? undefined : { cause });
}
/** Canonical positive safe integer from a name, or fail-closed. */
function seqFromName(digits: string, file: string): number {
  const n = Number(digits);
  if (!/^[1-9][0-9]*$/.test(digits) || !Number.isSafeInteger(n)) throw corrupt(file, 'alias or overflow sequence name');
  return n;
}
function components(root: string, dir: string): string[] {
  const rel = path.relative(root, dir);
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new ApprovalError('UNSAFE_PATH', 'Slot path is outside the approval home', dir);
  }
  const out: string[] = [];
  let cur = root;
  for (const part of rel === '' ? [] : rel.split(path.sep)) {
    cur = path.join(cur, part);
    out.push(cur);
  }
  return out;
}
function realDirOrNull(io: ApprovalIo, dir: string): boolean {
  try {
    if (!io.lstatSync(dir).isDirectory()) throw new ApprovalError('UNSAFE_PATH', 'Not a real directory (symlink?)', dir);
    return true;
  } catch (e) {
    if (e instanceof ApprovalError) throw e;
    if (codeOf(e) === 'ENOENT') return false;
    throw new ApprovalError('IO_ERROR', `lstat failed (${codeOf(e) ?? 'unknown'}): ${dir}`, dir, { cause: e });
  }
}
/** True if `dir` and all its ancestors below root are real directories; false if one is missing. */
function dirChainExists(io: ApprovalIo, root: string, dir: string): boolean {
  for (const d of components(root, dir)) if (!realDirOrNull(io, d)) return false;
  return true;
}

/** Persisted high-water of a slot; missing file or slot = 0; anything else invalid fails closed. */
export function readHighWater(slotRoot: string, root: string, io: ApprovalIo = defaultApprovalIo): number {
  const file = path.join(slotRoot, 'collected.seq');
  let buf: Buffer | null;
  try {
    buf = readApprovalFile(file, HIGH_WATER_LIMIT, root, io);
  } catch (e) {
    throw corrupt(file, e instanceof ApprovalError ? e.code : 'unreadable', e);
  }
  if (buf === null) return 0;
  const text = buf.toString('utf8');
  const m = /^(0|[1-9][0-9]*)\n$/.exec(text);
  const n = m ? Number(m[1]) : Number.NaN;
  if (!m || !Number.isSafeInteger(n)) throw corrupt(file, 'format');
  return n;
}

/** Largest numeric sequence among collected dirs and `<n>.done` markers, 0 if none. */
function scanCollected(slotRoot: string, root: string, io: ApprovalIo): number {
  const dir = path.join(slotRoot, 'collected');
  if (!dirChainExists(io, root, dir)) return 0;
  let names: string[];
  try {
    names = io.readdirSync(dir) as string[];
  } catch (e) {
    if (codeOf(e) === 'ENOENT') return 0;
    throw new ApprovalError('IO_ERROR', `readdir failed (${codeOf(e) ?? 'unknown'}): ${dir}`, dir, { cause: e });
  }
  let max = 0;
  for (const name of names) {
    const m = /^([0-9]+)(\.done)?$/.exec(name);
    if (!m) continue;
    const file = path.join(dir, name);
    const n = seqFromName(m[1] as string, file);
    let st: fs.Stats;
    try {
      st = io.lstatSync(file);
    } catch (e) {
      throw new ApprovalError('IO_ERROR', `lstat failed (${codeOf(e) ?? 'unknown'}): ${file}`, file, { cause: e });
    }
    if (m[2] ? !st.isFile() : !st.isDirectory()) {
      throw new ApprovalError('UNSAFE_PATH', `Unexpected type for sequence entry: ${file}`, file);
    }
    if (n > max) max = n;
  }
  return max;
}

/** max(persisted high-water, numeric collected dirs, `<n>.done` markers); numeric, not lexical. */
export function maxCollectedSequence(slotRoot: string, root: string, io: ApprovalIo = defaultApprovalIo): number {
  return Math.max(readHighWater(slotRoot, root, io), scanCollected(slotRoot, root, io));
}

/** max + 1; SEQUENCE_OVERFLOW past Number.MAX_SAFE_INTEGER. Does not reserve the number. */
export function nextCollectedSequence(slotRoot: string, root: string, io: ApprovalIo = defaultApprovalIo): Sequence {
  const max = maxCollectedSequence(slotRoot, root, io);
  if (max >= Number.MAX_SAFE_INTEGER) {
    throw new ApprovalError('SEQUENCE_OVERFLOW', 'Slot sequence would exceed the safe integer range', slotRoot);
  }
  return max + 1;
}

/**
 * Raise the persisted high-water to max(atLeast, current max) and return it; never lowers it.
 * Writes a 0600 temp in the slot root, fsyncs, then renames over `collected.seq` (the one place
 * a replace-rename is intended), so a crash leaves the complete old or new value. A corrupt
 * existing value fails closed before anything is written.
 */
export function advanceHighWater(slotRoot: string, atLeast: number, deps: HighWaterDeps): number {
  if (!Number.isSafeInteger(atLeast) || atLeast < 0) {
    throw new ApprovalError('INVALID_INPUT', 'High-water value must be a non-negative safe integer');
  }
  const io = deps.io ?? defaultApprovalIo;
  const value = Math.max(atLeast, readHighWater(slotRoot, deps.root, io), scanCollected(slotRoot, deps.root, io));
  // Ensure the slot root (private, real directories only).
  if (!realDirOrNull(io, deps.root)) throw new ApprovalError('IO_ERROR', 'Approval home does not exist', deps.root);
  for (const d of components(deps.root, slotRoot)) {
    try { io.mkdirSync(d, { mode: 0o700 }); } catch (e) {
      if (codeOf(e) !== 'EEXIST') throw new ApprovalError('IO_ERROR', `mkdir failed (${codeOf(e) ?? 'unknown'}): ${d}`, d, { cause: e });
    }
    if (!realDirOrNull(io, d)) throw new ApprovalError('IO_ERROR', `Directory vanished: ${d}`, d);
  }

  const c = fs.constants;
  const token = deps.token ?? randomUUID;
  const target = path.join(slotRoot, 'collected.seq');
  const tmp = path.join(slotRoot, `.collected.seq-${process.pid}-${token()}.tmp`);
  const bytes = Buffer.from(`${value}\n`, 'utf8');
  const removeTemp = (): void => { try { io.unlinkSync(tmp); } catch { /* best effort, own temp only */ } };
  const fail = (what: string, e: unknown): ApprovalError =>
    new ApprovalError('IO_ERROR', `High-water ${what} failed (${codeOf(e) ?? 'unknown'}): ${tmp}`, tmp, { cause: e });

  let fd: number;
  try {
    fd = io.openSync(tmp, c.O_CREAT | c.O_EXCL | c.O_WRONLY | c.O_NOFOLLOW, 0o600);
  } catch (e) {
    throw fail('create temp', e);
  }
  try {
    let off = 0;
    while (off < bytes.length) {
      const n = io.writeSync(fd, bytes, off, bytes.length - off);
      if (n <= 0) throw new Error('zero-byte write');
      off += n;
    }
  } catch (e) {
    try { io.closeSync(fd); } catch { /* original error wins */ }
    removeTemp();
    throw fail('write', e);
  }
  deps.fault?.('temp_written');
  try {
    io.fsyncSync(fd);
    io.closeSync(fd);
  } catch (e) {
    try { io.closeSync(fd); } catch { /* already closed */ }
    removeTemp();
    throw fail('fsync', e);
  }
  deps.fault?.('temp_synced');
  try {
    io.renameSync(tmp, target);
  } catch (e) {
    removeTemp();
    throw fail('rename', e);
  }
  deps.fault?.('renamed');
  return value;
}
