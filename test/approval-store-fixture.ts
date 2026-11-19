import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { approvalId } from '../src/approval-id.js';
import type { ApprovalIo } from '../src/approval-io.js';
import { transition } from '../src/approval-state.js';
import { publishRecord, readRecord } from '../src/approval-store.js';
import type { ApprovalProof } from '../src/approval-transition.js';
import type { Actor, ApprovalId, ApprovalRecord, ApprovalState, SourceKey } from '../src/approval-types.js';

const T0 = Date.parse('2026-11-14T00:00:00.000Z');
const WEEK = 7 * 86400_000;
const ORIGIN = { kind: 'run' as const, project: 'proj', run_id: 'run.1', project_dir: '/p', role: 'agent',
  full_writable: { dirs: ['/p/a'], files: ['/p/b'] } };
const SNAP = { schema_version: 1 as const, sha256: 'b'.repeat(64), premises: [] as const };
const ACTOR: Actor = { user: 'u', tty: '/dev/ttys1', pid: 4242, pid_started: 'proc:4242' };

let seq = 0;

export interface SeedPendingOptions {
  readonly payload?: Buffer;
  readonly createdAt?: string;
  readonly expiresAt?: string;
  readonly executor?: string;
  readonly summary?: string | null;
}

export interface SeededPending {
  readonly id: ApprovalId;
  readonly record: Extract<ApprovalRecord, { disposition: 'pending' }>;
  readonly payload: Buffer;
}

export interface SeededDenied {
  readonly id: ApprovalId;
  readonly record: Extract<ApprovalRecord, { disposition: 'denied' }>;
}

export interface TreeSnap {
  readonly path: string;
  readonly type: 'dir' | 'file' | 'symlink' | 'other';
  readonly mode: number;
  readonly mtimeMs: number;
  readonly bytes: string | null;
}

function nextSeq(): number {
  seq += 1;
  return seq;
}

/** Commit a pending record with the real `publishRecord`. `home` must already be canonical. */
export function seedPending(home: string, o: SeedPendingOptions = {}): SeededPending {
  const n = nextSeq();
  const payload = o.payload ?? Buffer.from('{"cmd":"deploy"}\n');
  const digest = createHash('sha256').update(payload).digest('hex');
  const key: SourceKey = { kind: 'run', source_id: 'run.1', slot: 'agent', seq: n, variant: 'payload',
    filename: `f${n}.req`, payload_sha256: digest };
  const record: Extract<ApprovalRecord, { disposition: 'pending' }> = {
    schema_version: 1, id: approvalId(key), source_key: key, origin: ORIGIN, proposer: { role: 'agent', slot: 'agent' },
    created_at: o.createdAt ?? new Date(T0).toISOString(), expires_at: o.expiresAt ?? new Date(T0 + WEEK).toISOString(),
    executor: o.executor ?? 'deploy', summary: o.summary ?? null, payload_sha256: digest, payload_bytes: payload.length,
    qualification: SNAP, disposition: 'pending',
  };
  publishRecord(home, record, payload);
  return { id: record.id, record, payload };
}

/** Commit a denied record with the real `publishRecord` (no payload). */
export function seedDenied(home: string): SeededDenied {
  const n = nextSeq();
  const key: SourceKey = { kind: 'run', source_id: 'run.1', slot: 'agent', seq: n, variant: 'denied_entry',
    filename: `d${n}.req`, reason: 'not_regular' };
  const record: Extract<ApprovalRecord, { disposition: 'denied' }> = {
    schema_version: 1, id: approvalId(key), source_key: key, origin: ORIGIN, proposer: { role: 'agent', slot: 'agent' },
    created_at: new Date(T0).toISOString(), expires_at: new Date(T0 + WEEK).toISOString(), executor: null, summary: null,
    payload_sha256: null, payload_bytes: null, qualification: null, disposition: 'denied', reason: 'not_regular',
    ignored_count: null,
  };
  publishRecord(home, record, null);
  return { id: record.id, record };
}

function proofFor(record: Extract<ApprovalRecord, { disposition: 'pending' }>): ApprovalProof {
  const started = ACTOR.pid_started;
  if (started === null) throw new Error('seed actor is missing pid_started');
  return { origin_ok: true, premises_ok: true, executor_registered: true, allowed: true, interactive_tty: true,
    prefix_confirmed: true, completely_viewed: true, viewed_bytes: record.payload_bytes, viewed_sha256: record.payload_sha256,
    observed_payload_sha256: record.payload_sha256, owner: { pid: ACTOR.pid, pid_started: started }, timeout_sec: 30,
    command_sha256: 'c'.repeat(64) };
}

/**
 * Append one real state via `transition`. `rejected` and `executing` start from pending.
 * `unknown` starts from executing (`creator_dead`). `nowMs` must keep an approve inside the expiry window.
 */
export function seedState(home: string, id: ApprovalId, kind: 'rejected' | 'executing' | 'unknown', nowMs: number): ApprovalState {
  const record = readRecord(home, id);
  if (record === null) throw new Error(`seedState: no record ${id}`);
  const actor = ACTOR;
  let result;
  if (kind === 'rejected') {
    if (record.disposition !== 'pending') throw new Error('seedState rejected needs a pending record');
    result = transition(home, id, () => ({ event: { type: 'reject', reason: 'no', interactive_tty: true, prefix_confirmed: true },
      context: { now_ms: nowMs, actor } }));
  } else if (kind === 'executing') {
    if (record.disposition !== 'pending') throw new Error('seedState executing needs a pending record');
    const proof = proofFor(record);
    result = transition(home, id, () => ({ event: { type: 'approve', proof, creator: null }, context: { now_ms: nowMs, actor } }));
  } else {
    result = transition(home, id, () => ({ event: { type: 'creator_dead', evidence: { alive: false, reason: 'missing_pid' } },
      context: { now_ms: nowMs, actor } }));
  }
  const expected = kind === 'rejected' ? 'rejected' : kind;
  if (result.kind !== 'committed' || result.current.state?.status !== expected) {
    throw new Error(`seedState ${kind} did not commit: ${JSON.stringify(result)}`);
  }
  return result.current.state;
}

function snapKind(st: fs.Stats): TreeSnap['type'] {
  if (st.isSymbolicLink()) return 'symlink';
  if (st.isDirectory()) return 'dir';
  if (st.isFile()) return 'file';
  return 'other';
}

/** Paths, types, bytes, mode and mtimeMs for `root` and everything under it. Does not follow symlinks. */
export function snapshotTree(root: string): TreeSnap[] {
  const out: TreeSnap[] = [];
  const visit = (abs: string): void => {
    const st = fs.lstatSync(abs);
    const type = snapKind(st);
    const rel = path.relative(root, abs) || '.';
    let bytes: string | null = null;
    if (type === 'file') bytes = fs.readFileSync(abs).toString('base64');
    else if (type === 'symlink') bytes = fs.readlinkSync(abs);
    out.push({ path: rel, type, mode: st.mode, mtimeMs: st.mtimeMs, bytes });
    if (type !== 'dir') return;
    for (const name of fs.readdirSync(abs).sort()) visit(path.join(abs, name));
  };
  visit(root);
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return out;
}

const WRITE_FLAGS = fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_TRUNC;

function mutating(name: string): never {
  throw new Error(`mutating io call: ${name}`);
}

/** ApprovalIo that serves real reads and throws on every mutating call, including a writing `openSync`. */
export function writeTrapIo(base: ApprovalIo = fs): ApprovalIo {
  return {
    ...base,
    mkdirSync: () => mutating('mkdirSync'),
    writeSync: () => mutating('writeSync'),
    fsyncSync: () => mutating('fsyncSync'),
    linkSync: () => mutating('linkSync'),
    unlinkSync: () => mutating('unlinkSync'),
    renameSync: () => mutating('renameSync'),
    openSync: ((p: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
      if (typeof flags === 'number' && (flags & WRITE_FLAGS) !== 0) mutating('openSync');
      if (typeof flags === 'string' && /[wa+]/.test(flags)) mutating('openSync');
      return base.openSync(p, flags, mode);
    }) as typeof fs.openSync,
  };
}
