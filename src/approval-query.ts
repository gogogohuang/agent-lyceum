import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { computeDisplay } from './approval-display.js';
import type { Display } from './approval-display.js';
import { ApprovalError } from './approval-error.js';
import type { ApprovalErrorCode } from './approval-error.js';
import { loadExecutors } from './approval-executors.js';
import { assertRealDir, defaultApprovalIo, readApprovalFile } from './approval-io.js';
import type { ApprovalIo } from './approval-io.js';
import type { ApprovalListProblem } from './approval-json.js';
import { creatorLiveness } from './approval-liveness.js';
import type { CreatorProbe } from './approval-liveness.js';
import { recordPaths, storePaths } from './approval-paths.js';
import { parseApprovalState } from './approval-schema.js';
import { readCurrent } from './approval-state.js';
import { readRecord } from './approval-store.js';
import type { ApprovalId, ApprovalRecord, ApprovalState, Current, DeniedReason } from './approval-types.js';

const STATE_LIMIT = 1024 * 1024;
const PAYLOAD_LIMIT = 65536;
const HASH_CHUNK = 64 * 1024;
const READ_FLAGS = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;
const ID_RE = /^[0-9a-f]{24}$/;
const PREFIX_RE = /^[0-9a-f]{8,24}$/;
const NUMERIC = /^\d+\.json$/;
const CANONICAL = /^[1-9][0-9]*\.json$/;
const RECORD_HINT = 'Committed approval could not be read';
const STATE_HINT = 'State is corrupted; every transition is refused';
const READ_HINT = 'State could not be read';

type FileFs = Pick<typeof fs, 'realpathSync' | 'openSync' | 'fstatSync' | 'readSync' | 'closeSync'>;

export type PrefixResult = { readonly kind: 'ok'; readonly id: ApprovalId } | { readonly kind: 'invalid' }
  | { readonly kind: 'not_found' } | { readonly kind: 'ambiguous'; readonly count: number };

export interface QueryClock { readonly now: () => number }

export interface Entry { readonly id: ApprovalId; readonly current: Current; readonly display: Display | null }
export interface Listing { readonly entries: readonly Entry[]; readonly problems: readonly ApprovalListProblem[] }

export type PayloadRead = { readonly kind: 'bytes'; readonly bytes: Buffer; readonly observed_sha256: string }
  | { readonly kind: 'unreadable'; readonly code: ApprovalErrorCode; readonly path: string }
  | { readonly kind: 'none' };

export interface RequestView {
  readonly id: ApprovalId;
  readonly record: ApprovalRecord;
  readonly current: { readonly kind: 'ok'; readonly display: Display }
    | { readonly kind: 'corrupt'; readonly code: ApprovalErrorCode; readonly path: string };
  readonly payload: PayloadRead;
  readonly same: readonly {
    readonly id: ApprovalId; readonly display: Display | null; readonly reason: DeniedReason | null;
    readonly code: ApprovalErrorCode | null;
  }[];
}

/** Same shape as the screen module's event; this slice does not import it. */
export type AuditEvent = { readonly n: number; readonly state: ApprovalState }
  | { readonly n: number; readonly code: ApprovalErrorCode; readonly path: string };

export interface AuditData {
  readonly record: ApprovalRecord;
  readonly events: readonly AuditEvent[];
  readonly current: { readonly kind: 'ok'; readonly display: Display }
    | { readonly kind: 'corrupt'; readonly code: ApprovalErrorCode; readonly path: string };
}

export type ExecutorFacts = { readonly kind: 'ok'; readonly name: string; readonly real: string; readonly sha256: string }
  | { readonly kind: 'unregistered'; readonly name: string }
  | { readonly kind: 'config_error'; readonly name: string; readonly code: string }
  | { readonly kind: 'uninspectable'; readonly name: string; readonly configured: string; readonly code: string }
  | { readonly kind: 'none' };

function errno(e: unknown): string {
  const code = (e as NodeJS.ErrnoException | null)?.code;
  return typeof code === 'string' && code !== '' ? code : 'unknown';
}

function isCorrupt(code: ApprovalErrorCode): boolean {
  return code === 'CORRUPT_STATE' || code === 'CORRUPT_RECORD' || code === 'UNSUPPORTED_VERSION';
}

/** Directory names that have a `record.json` inode. Content is not read. ENOENT is an empty store. */
export function committedIdNames(home: string, io: ApprovalIo = defaultApprovalIo): ApprovalId[] {
  const dir = storePaths(home).approvals;
  let names: string[];
  try {
    assertRealDir(io, dir);
    names = io.readdirSync(dir) as string[];
  } catch (e) {
    if (e instanceof ApprovalError) throw e;
    if (errno(e) === 'ENOENT') return [];
    throw new ApprovalError('IO_ERROR', `readdir failed: ${dir}`, dir, { cause: e });
  }
  const ids: ApprovalId[] = [];
  for (const id of names) {
    if (!ID_RE.test(id)) continue;
    const record = recordPaths(home, id).record;
    try {
      io.lstatSync(record);
    } catch (e) {
      const code = errno(e);
      if (code === 'ENOENT' || code === 'ENOTDIR') continue;
      throw new ApprovalError('IO_ERROR', `lstat failed: ${record}`, record, { cause: e });
    }
    ids.push(id);
  }
  ids.sort();
  return ids;
}

/** Lowercase hex prefix of 8 to 24 characters. Syntax is judged before any IO. */
export function resolveIdPrefix(home: string, arg: string, io: ApprovalIo = defaultApprovalIo): PrefixResult {
  if (typeof arg !== 'string' || !PREFIX_RE.test(arg)) return { kind: 'invalid' };
  const ids = committedIdNames(home, io).filter((id) => id.startsWith(arg));
  if (ids.length === 0) return { kind: 'not_found' };
  const only = ids[0];
  if (ids.length === 1 && only !== undefined) return { kind: 'ok', id: only };
  return { kind: 'ambiguous', count: ids.length };
}

function displayOf(current: Current, nowMs: number, probe: CreatorProbe, probeExecuting: boolean): Display | null {
  const status = current.state?.status ?? current.record.disposition;
  if (status !== 'executing') return computeDisplay(current, nowMs, null);
  if (!probeExecuting) return null;
  const state = current.state;
  if (state === null || state.status !== 'executing') {
    throw new ApprovalError('CORRUPT_STATE', 'executing request is missing its state', null);
  }
  return computeDisplay(current, nowMs, creatorLiveness(state.owner, state.updated_at, state.timeout_sec, nowMs, probe));
}

function listedProblem(id: string, e: ApprovalError, hint: string, fallback: string): ApprovalListProblem {
  return { id, path: e.path ?? fallback, code: e.code, hint };
}

/** Every committed id, plus problems. Executing is probed only when `probeExecuting` is set. Writes nothing. */
export function readEntries(home: string, o: { readonly nowMs: number; readonly probe: CreatorProbe; readonly probeExecuting: boolean },
  io: ApprovalIo = defaultApprovalIo): Listing {
  const entries: Entry[] = [];
  const problems: ApprovalListProblem[] = [];
  for (const id of committedIdNames(home, io)) {
    const paths = recordPaths(home, id);
    let record: ApprovalRecord | null;
    try {
      record = readRecord(home, id, io);
    } catch (e) {
      if (!(e instanceof ApprovalError)) throw e;
      problems.push(listedProblem(id, e, RECORD_HINT, paths.record));
      continue;
    }
    if (record === null) {
      problems.push({ id, path: paths.record, code: 'CORRUPT_RECORD', hint: RECORD_HINT });
      continue;
    }
    try {
      const current = readCurrent(home, id, io);
      entries.push({ id, current, display: displayOf(current, o.nowMs, o.probe, o.probeExecuting) });
    } catch (e) {
      if (!(e instanceof ApprovalError)) throw e;
      problems.push(listedProblem(id, e, isCorrupt(e.code) ? STATE_HINT : READ_HINT, paths.state));
    }
  }
  return { entries, problems };
}

function requireRecord(home: string, id: ApprovalId, io: ApprovalIo): ApprovalRecord {
  const record = readRecord(home, id, io);
  if (record === null) throw new ApprovalError('CORRUPT_RECORD', 'record.json does not exist', recordPaths(home, id).record);
  return record;
}

function currentOf(home: string, id: ApprovalId, nowMs: number, probe: CreatorProbe, io: ApprovalIo): AuditData['current'] {
  try {
    const current = readCurrent(home, id, io);
    const display = displayOf(current, nowMs, probe, true);
    if (display === null) throw new ApprovalError('CORRUPT_STATE', 'executing request is missing its state', recordPaths(home, id).state);
    return { kind: 'ok', display };
  } catch (e) {
    if (e instanceof ApprovalError && isCorrupt(e.code)) {
      return { kind: 'corrupt', code: e.code, path: e.path ?? recordPaths(home, id).state };
    }
    throw e;
  }
}

function readPayload(home: string, id: ApprovalId, record: ApprovalRecord, io: ApprovalIo): PayloadRead {
  if (record.payload_sha256 === null) return { kind: 'none' };
  const file = recordPaths(home, id).payload;
  try {
    const buf = readApprovalFile(file, PAYLOAD_LIMIT, home, io);
    if (buf === null) return { kind: 'unreadable', code: 'CORRUPT_RECORD', path: file };
    return { kind: 'bytes', bytes: buf, observed_sha256: createHash('sha256').update(buf).digest('hex') };
  } catch (e) {
    if (e instanceof ApprovalError) return { kind: 'unreadable', code: e.code, path: e.path ?? file };
    throw e;
  }
}

function samePayload(home: string, id: ApprovalId, record: ApprovalRecord,
  o: { readonly nowMs: number; readonly probe: CreatorProbe }, io: ApprovalIo): RequestView['same'] {
  const hash = record.payload_sha256;
  if (hash === null) return [];
  const out: Array<RequestView['same'][number]> = [];
  for (const other of committedIdNames(home, io)) {
    if (other === id) continue;
    let otherRecord: ApprovalRecord | null;
    try {
      otherRecord = readRecord(home, other, io);
    } catch (e) {
      if (!(e instanceof ApprovalError)) throw e;
      continue;
    }
    if (otherRecord === null || otherRecord.payload_sha256 !== hash) continue;
    const reason = otherRecord.disposition === 'denied' ? otherRecord.reason : null;
    try {
      const current = readCurrent(home, other, io);
      out.push({ id: other, display: displayOf(current, o.nowMs, o.probe, true), reason, code: null });
    } catch (e) {
      if (!(e instanceof ApprovalError)) throw e;
      out.push({ id: other, display: null, reason, code: e.code });
    }
  }
  return out;
}

/** One request for `show`. A missing record throws; a corrupt state is reported and nothing is written. */
export function readRequestView(home: string, id: ApprovalId, o: { readonly nowMs: number; readonly probe: CreatorProbe },
  io: ApprovalIo = defaultApprovalIo): RequestView {
  const record = requireRecord(home, id, io);
  return { id, record, current: currentOf(home, id, o.nowMs, o.probe, io), payload: readPayload(home, id, record, io),
    same: samePayload(home, id, record, o, io) };
}

function stateNames(home: string, id: ApprovalId, io: ApprovalIo): { readonly dir: string; readonly names: readonly string[] } {
  const dir = recordPaths(home, id).state;
  try {
    assertRealDir(io, dir);
    return { dir, names: io.readdirSync(dir) as string[] };
  } catch (e) {
    if (e instanceof ApprovalError) throw e;
    if (errno(e) === 'ENOENT') return { dir, names: [] };
    throw new ApprovalError('IO_ERROR', `readdir failed: ${dir}`, dir, { cause: e });
  }
}

function byNumericName(a: string, b: string): number {
  const na = Number(a.slice(0, -5));
  const nb = Number(b.slice(0, -5));
  if (na !== nb) return na < nb ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** One numeric state file, using the same cap, parse and `n === filename` rule as `readState`. */
function readAuditEvent(home: string, dir: string, name: string, io: ApprovalIo): AuditEvent {
  const file = path.join(dir, name);
  const parsed = Number(name.slice(0, -5));
  const n = Number.isSafeInteger(parsed) ? parsed : 0;
  if (!CANONICAL.test(name) || !Number.isSafeInteger(parsed)) return { n, code: 'CORRUPT_STATE', path: file };
  let buf: Buffer | null;
  try {
    buf = readApprovalFile(file, STATE_LIMIT, home, io);
  } catch (e) {
    if (e instanceof ApprovalError) return { n, code: e.code, path: e.path ?? file };
    throw e;
  }
  if (buf === null) return { n, code: 'CORRUPT_STATE', path: file };
  let value: unknown;
  try { value = JSON.parse(buf.toString('utf8')); } catch { return { n, code: 'CORRUPT_STATE', path: file }; }
  try {
    const state = parseApprovalState(value, file);
    if (state.n !== n) return { n, code: 'CORRUPT_STATE', path: file };
    return { n, state };
  } catch (e) {
    if (e instanceof ApprovalError) return { n, code: e.code, path: e.path ?? file };
    throw e;
  }
}

/** Record facts and numeric state events in order. Temp names are ignored. Writes nothing. */
export function readAudit(home: string, id: ApprovalId, o: { readonly nowMs: number; readonly probe: CreatorProbe },
  io: ApprovalIo = defaultApprovalIo): AuditData {
  const record = requireRecord(home, id, io);
  const { dir, names } = stateNames(home, id, io);
  const events = names.filter((name) => NUMERIC.test(name)).sort(byNumericName).map((name) => readAuditEvent(home, dir, name, io));
  return { record, events, current: currentOf(home, id, o.nowMs, o.probe, io) };
}

function inspectExecutor(name: string, configured: string, fileFs: FileFs): ExecutorFacts {
  const fail = (code: string): ExecutorFacts => ({ kind: 'uninspectable', name, configured, code });
  let real: string;
  try {
    real = fileFs.realpathSync.native(configured);
  } catch (e) {
    return fail(errno(e));
  }
  let fd: number;
  try {
    fd = fileFs.openSync(real, READ_FLAGS);
  } catch (e) {
    return fail(errno(e));
  }
  let facts: ExecutorFacts;
  try {
    const st = fileFs.fstatSync(fd);
    if (!st.isFile()) facts = fail('NOT_REGULAR');
    else {
      const hash = createHash('sha256');
      const chunk = Buffer.alloc(HASH_CHUNK);
      for (;;) {
        const n = fileFs.readSync(fd, chunk, 0, chunk.length, null);
        if (n <= 0) break;
        hash.update(chunk.subarray(0, n));
      }
      facts = { kind: 'ok', name, real, sha256: hash.digest('hex') };
    }
  } catch (e) {
    facts = fail(errno(e));
  }
  try {
    fileFs.closeSync(fd);
  } catch (e) {
    if (facts.kind === 'ok') return fail(errno(e));
  }
  return facts;
}

/**
 * Registered command identity: real path and sha256 of the regular file. Never executes.
 * `null` (a denied record) is `none` and does not read executors.yaml.
 */
export function executorFacts(home: string, name: string | null, o: { readonly userHome: string; readonly io?: ApprovalIo;
  readonly fs?: FileFs }): ExecutorFacts {
  if (name === null) return { kind: 'none' };
  try {
    const loaded = loadExecutors(home, o.userHome, o.io ?? defaultApprovalIo);
    const configured = loaded.config?.executors[name]?.command[0];
    if (configured === undefined) return { kind: 'unregistered', name };
    return inspectExecutor(name, configured, o.fs ?? fs);
  } catch (e) {
    if (e instanceof ApprovalError) return { kind: 'config_error', name, code: e.code };
    throw e;
  }
}
