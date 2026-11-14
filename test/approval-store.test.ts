import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ApprovalError } from '../src/approval-error.js';
import { approvalId } from '../src/approval-id.js';
import { recordPaths } from '../src/approval-paths.js';
import { listCommittedIds, publishRecord, readRecord } from '../src/approval-store.js';
import type { ApprovalIo } from '../src/approval-io.js';
import type { ApprovalRecord, SourceKey } from '../src/approval-types.js';

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const T0 = '2026-11-14T00:00:00.000Z';
const T1 = '2026-11-21T00:00:00.000Z';
const T2 = '2026-11-15T00:00:00.000Z';
const base = { kind: 'run', source_id: 'run.1', slot: 'agent--2', seq: 1 } as const;
const writable = { dirs: ['/p/a'], files: ['/p/b'] };
const origin = { kind: 'run', project: 'proj', run_id: 'run.1', project_dir: '/p', role: 'agent', full_writable: writable } as const;
const snap = { schema_version: 1, sha256: 'b'.repeat(64), premises: [{ check: 'c', ok: true, code: 'ok' }] } as const;

const PAYLOAD = Buffer.from('{"cmd":"deploy"}\n');
function pendingFor(payload: Buffer, over: Partial<ApprovalRecord> = {}): ApprovalRecord {
  const key: SourceKey = { ...base, variant: 'payload', filename: 'a.req', payload_sha256: sha(payload) };
  return { schema_version: 1, id: approvalId(key), source_key: key, origin, proposer: { role: 'agent', slot: 'agent--2' },
    created_at: T0, expires_at: T1, executor: 'deploy', summary: 'hi', payload_sha256: sha(payload),
    payload_bytes: payload.length, qualification: snap, disposition: 'pending', ...over } as ApprovalRecord;
}
function deniedRecord(): ApprovalRecord {
  const key: SourceKey = { ...base, variant: 'denied_entry', filename: 'd.req', reason: 'not_regular' };
  return { schema_version: 1, id: approvalId(key), source_key: key, origin, proposer: { role: 'agent', slot: 'agent--2' },
    created_at: T0, expires_at: T1, executor: null, summary: null, payload_sha256: null, payload_bytes: null,
    qualification: null, disposition: 'denied', reason: 'not_regular', ignored_count: null };
}

let home: string;
beforeEach(() => { home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'approval-store-'))); });
afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

const codeOf = (fn: () => unknown) => { try { fn(); } catch (e) { return e instanceof ApprovalError ? e.code : 'other'; } return 'none'; };
const listDir = (d: string) => (fs.existsSync(d) ? fs.readdirSync(d).sort() : null);
const snapshotTree = (d: string): string[] => {
  const out: string[] = [];
  const walk = (p: string) => { for (const n of fs.readdirSync(p)) { const f = path.join(p, n); out.push(`${f}:${fs.statSync(f).mtimeMs}:${fs.statSync(f).isDirectory() ? 'd' : fs.readFileSync(f, 'hex')}`); if (fs.statSync(f).isDirectory()) walk(f); } };
  walk(d); return out.sort();
};
const crashAt = (point: string) => ({ fault: (p: string) => { if (p === point) throw new Error(`crash at ${p}`); } });

describe('publishRecord', () => {
  it('creates payload then record; payload bytes are exactly the hashed buffer', () => {
    const rec = pendingFor(PAYLOAD);
    const r = publishRecord(home, rec, PAYLOAD);
    expect(r.kind).toBe('created');
    expect(r.record).toEqual(rec);
    const p = recordPaths(home, rec.id);
    expect(fs.readFileSync(p.payload).equals(PAYLOAD)).toBe(true);
    expect(sha(fs.readFileSync(p.payload))).toBe(rec.payload_sha256);
    expect(fs.readFileSync(p.record, 'utf8').endsWith('\n')).toBe(true);
    expect(readRecord(home, rec.id)).toEqual(rec);
    expect(fs.readdirSync(p.root).sort()).toEqual(['payload', 'record.json']);
  });

  it('rejects a payload whose hash or size differs from the record, writing nothing', () => {
    const rec = pendingFor(PAYLOAD);
    expect(codeOf(() => publishRecord(home, rec, Buffer.from('other')))).toBe('INVALID_INPUT');
    expect(codeOf(() => publishRecord(home, pendingFor(PAYLOAD, { payload_bytes: 3 }), PAYLOAD))).toBe('INVALID_INPUT');
    expect(codeOf(() => publishRecord(home, rec, null))).toBe('INVALID_INPUT');
    expect(listDir(path.join(home, 'approvals'))).toBeNull();
  });

  it('rejects a malformed record (strict schema) before any write', () => {
    const bad = { ...pendingFor(PAYLOAD), extra: 1 } as unknown as ApprovalRecord;
    expect(codeOf(() => publishRecord(home, bad, PAYLOAD))).toBe('CORRUPT_RECORD');
    expect(listDir(path.join(home, 'approvals'))).toBeNull();
  });

  it('payload EEXIST with identical bytes is reused (record missing: completes)', () => {
    const rec = pendingFor(PAYLOAD);
    const p = recordPaths(home, rec.id);
    fs.mkdirSync(p.root, { recursive: true, mode: 0o700 });
    fs.writeFileSync(p.payload, PAYLOAD);
    expect(publishRecord(home, rec, PAYLOAD).kind).toBe('created');
    expect(readRecord(home, rec.id)).toEqual(rec);
  });

  it('payload EEXIST with different bytes: PAYLOAD_MISMATCH, no record created, payload untouched', () => {
    const rec = pendingFor(PAYLOAD);
    const p = recordPaths(home, rec.id);
    fs.mkdirSync(p.root, { recursive: true, mode: 0o700 });
    fs.writeFileSync(p.payload, 'tampered');
    expect(codeOf(() => publishRecord(home, rec, PAYLOAD))).toBe('PAYLOAD_MISMATCH');
    expect(fs.existsSync(p.record)).toBe(false);
    expect(fs.readFileSync(p.payload, 'utf8')).toBe('tampered');
  });

  it('record EEXIST returns the first committed record, never overwrites', () => {
    const first = pendingFor(PAYLOAD);
    publishRecord(home, first, PAYLOAD);
    const later = pendingFor(PAYLOAD, { created_at: T2, summary: 'later', qualification: { ...snap, sha256: 'c'.repeat(64) } });
    const r = publishRecord(home, later, PAYLOAD);
    expect(r.kind).toBe('existing');
    expect(r.record).toEqual(first);
    expect(readRecord(home, first.id)).toEqual(first);
  });

  it('losing a record race at the link point adopts the winner (pre-link barrier via io hook)', () => {
    const winner = pendingFor(PAYLOAD);
    const loser = pendingFor(PAYLOAD, { created_at: T2, summary: 'loser' });
    const p = recordPaths(home, winner.id);
    const io: ApprovalIo = { ...fs, linkSync: (a: fs.PathLike, b: fs.PathLike) => {
      if (String(b) === p.record) fs.writeFileSync(p.record, `${JSON.stringify(winner, null, 2)}\n`); // winner commits just before our link
      return fs.linkSync(a, b);
    } } as ApprovalIo;
    const r = publishRecord(home, loser, PAYLOAD, { io });
    expect(r.kind).toBe('existing');
    expect(r.record).toEqual(winner);
    expect(fs.readdirSync(p.root).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });

  it('precommit crash leaves an incomplete entry: not listed, readRecord null, re-entry completes', () => {
    const rec = pendingFor(PAYLOAD);
    for (const point of ['temp_written', 'temp_synced', 'payload_committed'] as const) {
      fs.rmSync(path.join(home, 'approvals'), { recursive: true, force: true });
      expect(() => publishRecord(home, rec, PAYLOAD, crashAt(point))).toThrow(`crash at ${point}`);
      expect(readRecord(home, rec.id)).toBeNull();
      expect(listCommittedIds(home)).toEqual([]);
      expect(publishRecord(home, rec, PAYLOAD).kind).toBe('created');
      expect(listCommittedIds(home)).toEqual([rec.id]);
      expect(fs.readFileSync(recordPaths(home, rec.id).payload).equals(PAYLOAD)).toBe(true);
    }
  });

  it('crash between record link and cleanup (record_committed / linked): committed, replay is a no-op', () => {
    const rec = pendingFor(PAYLOAD);
    expect(() => publishRecord(home, rec, PAYLOAD, crashAt('record_committed'))).toThrow();
    expect(readRecord(home, rec.id)).toEqual(rec);
    expect(publishRecord(home, rec, PAYLOAD).kind).toBe('existing');
  });

  it('replay after commit writes nothing, also once state has advanced to executed', () => {
    const rec = pendingFor(PAYLOAD);
    publishRecord(home, rec, PAYLOAD);
    const p = recordPaths(home, rec.id);
    fs.mkdirSync(p.state);
    const actor = { user: 'u', tty: null, pid: 1, pid_started: null };
    const st = (n: number, extra: object) => ({ schema_version: 1, n, previous: n - 1, updated_at: T2, actor, ...extra });
    fs.writeFileSync(path.join(p.state, '1.json'), JSON.stringify(st(1, { status: 'executing',
      owner: { pid: 1, pid_started: 'x' }, timeout_sec: 5, viewed_bytes: 1, viewed_sha256: 'a'.repeat(64), command_sha256: 'a'.repeat(64) })));
    fs.writeFileSync(path.join(p.state, '2.json'), JSON.stringify(st(2, { status: 'executed', method: 'manual', conclusion: 'ok' })));
    const before = snapshotTree(path.join(home, 'approvals'));
    const calls: string[] = [];
    const io = new Proxy(fs, { get: (t, k) => (typeof k === 'string' && ['openSync', 'linkSync', 'mkdirSync', 'writeSync', 'unlinkSync', 'renameSync'].includes(k) && k !== 'openSync'
      ? (...a: unknown[]) => { calls.push(k); return (t as never as Record<string, (...x: unknown[]) => unknown>)[k]?.(...a); } : (t as never)[k]) }) as unknown as ApprovalIo;
    const r = publishRecord(home, pendingFor(PAYLOAD, { created_at: T2 }), PAYLOAD, { io });
    expect(r.kind).toBe('existing');
    expect(calls).toEqual([]);
    expect(snapshotTree(path.join(home, 'approvals'))).toEqual(before);
  });

  it('corrupt existing record is rejected, not treated as uncommitted', () => {
    const rec = pendingFor(PAYLOAD);
    const p = recordPaths(home, rec.id);
    fs.mkdirSync(p.root, { recursive: true, mode: 0o700 });
    fs.writeFileSync(p.record, '{not json');
    expect(codeOf(() => publishRecord(home, rec, PAYLOAD))).toBe('CORRUPT_RECORD');
    expect(fs.readFileSync(p.record, 'utf8')).toBe('{not json');
    expect(fs.existsSync(p.payload)).toBe(false);
  });

  it('existing record with a different source key or payload hash is SOURCE_MISMATCH', () => {
    const rec = pendingFor(PAYLOAD);
    const other = pendingFor(Buffer.from('zzz'));
    const p = recordPaths(home, rec.id);
    fs.mkdirSync(p.root, { recursive: true, mode: 0o700 });
    // a valid record for another source placed under this id (id collision / corruption)
    fs.writeFileSync(p.record, JSON.stringify({ ...other, id: rec.id }));
    expect(codeOf(() => publishRecord(home, rec, PAYLOAD))).toBe('CORRUPT_RECORD'); // schema: id does not match source_key
    const forged = { ...rec, source_key: { ...rec.source_key } };
    fs.writeFileSync(p.record, JSON.stringify(forged));
    expect(publishRecord(home, rec, PAYLOAD).kind).toBe('existing');
    // same id, differing core field (payload_bytes) -> SOURCE_MISMATCH
    fs.writeFileSync(p.record, JSON.stringify({ ...rec, payload_bytes: rec.payload_bytes === null ? 1 : rec.payload_bytes + 1 }));
    expect(codeOf(() => publishRecord(home, rec, PAYLOAD))).toBe('SOURCE_MISMATCH');
  });

  it('record.json that is a symlink is rejected', () => {
    const rec = pendingFor(PAYLOAD);
    const p = recordPaths(home, rec.id);
    fs.mkdirSync(p.root, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(home, 'elsewhere'), JSON.stringify(rec));
    fs.symlinkSync(path.join(home, 'elsewhere'), p.record);
    expect(codeOf(() => publishRecord(home, rec, PAYLOAD))).toBe('UNSAFE_PATH');
  });

  it('denied record: no payload file, no state; a stray payload is rejected', () => {
    const rec = deniedRecord();
    expect(publishRecord(home, rec, null).kind).toBe('created');
    const p = recordPaths(home, rec.id);
    expect(fs.readdirSync(p.root)).toEqual(['record.json']);
    expect(readRecord(home, rec.id)).toEqual(rec);
    expect(publishRecord(home, rec, null).kind).toBe('existing');

    fs.rmSync(path.join(home, 'approvals'), { recursive: true });
    fs.mkdirSync(p.root, { recursive: true, mode: 0o700 });
    fs.writeFileSync(p.payload, 'stray');
    expect(codeOf(() => publishRecord(home, rec, null))).toBe('PAYLOAD_MISMATCH');
    expect(fs.existsSync(p.record)).toBe(false);
  });

  it('denied record with a payload buffer must carry matching hash and bytes; null hash with payload is rejected', () => {
    expect(codeOf(() => publishRecord(home, deniedRecord(), PAYLOAD))).toBe('INVALID_INPUT');
    expect(listDir(path.join(home, 'approvals'))).toBeNull();
  });

  it('never calls renameSync', () => {
    const calls: string[] = [];
    const io = { ...fs, renameSync: (...a: unknown[]) => { calls.push('rename'); void a; throw new Error('no rename'); } } as unknown as ApprovalIo;
    publishRecord(home, pendingFor(PAYLOAD), PAYLOAD, { io });
    expect(calls).toEqual([]);
  });

  it('UNSUPPORTED_LINK on the payload link fails closed and creates no record', () => {
    const io = { ...fs, linkSync: () => { throw Object.assign(new Error('x'), { code: 'EXDEV' }); } } as unknown as ApprovalIo;
    const rec = pendingFor(PAYLOAD);
    expect(codeOf(() => publishRecord(home, rec, PAYLOAD, { io }))).toBe('UNSUPPORTED_LINK');
    expect(readRecord(home, rec.id)).toBeNull();
  });
});

describe('readRecord / listCommittedIds', () => {
  it('readRecord rejects a record stored under the wrong id', () => {
    const a = pendingFor(PAYLOAD);
    publishRecord(home, a, PAYLOAD);
    const wrong = 'f'.repeat(24);
    const wp = recordPaths(home, wrong);
    fs.mkdirSync(wp.root, { recursive: true });
    fs.copyFileSync(recordPaths(home, a.id).record, wp.record);
    expect(codeOf(() => readRecord(home, wrong))).toBe('CORRUPT_RECORD');
  });
  it('listCommittedIds ignores incomplete, dot and non-id entries; missing dir is empty', () => {
    expect(listCommittedIds(home)).toEqual([]);
    const a = pendingFor(PAYLOAD);
    publishRecord(home, a, PAYLOAD);
    fs.mkdirSync(path.join(home, 'approvals', 'a'.repeat(24)));
    fs.mkdirSync(path.join(home, 'approvals', '.trash'));
    expect(listCommittedIds(home)).toEqual([a.id]);
  });
});
