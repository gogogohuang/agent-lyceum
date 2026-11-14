import fs from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { ApprovalError } from '../src/approval-error.js';
import { approvalId } from '../src/approval-id.js';
import { parseApprovalRecord, parseApprovalState } from '../src/approval-schema.js';
import type { SourceKey } from '../src/approval-types.js';

// biome-ignore lint/suspicious/noExplicitAny: mutation helpers poke arbitrary nested JSON
type M = any;
const F = '/x/record.json';
const H = 'a'.repeat(64);
const T0 = '2026-11-14T00:00:00.000Z';
const T1 = '2026-11-21T00:00:00.000Z';
const b = { kind: 'run', source_id: 'run.1', slot: 'agent--2', seq: 1 } as const;
const writable = { dirs: ['/p/a'], files: ['/p/b'] };
const origin = { kind: 'run', project: 'proj', run_id: 'run.1', project_dir: '/p', role: 'agent', full_writable: writable };
const snap = { schema_version: 1, sha256: H, premises: [{ check: 'c', ok: true, code: 'ok' }] };
const mk = (source_key: SourceKey, extra: object) => ({ schema_version: 1, id: approvalId(source_key), source_key,
  origin, proposer: { role: 'agent', slot: 'agent--2' }, created_at: T0, expires_at: T1, executor: null,
  summary: null, payload_sha256: null, payload_bytes: null, qualification: null, ...extra });
const pk: SourceKey = { ...b, variant: 'payload', filename: 'a.req', payload_sha256: H };
const pending = () => mk(pk, { disposition: 'pending', executor: 'deploy', summary: 'hi', payload_sha256: H,
  payload_bytes: 10, qualification: snap });
const denied: Record<string, () => object> = {
  bytes: () => mk({ ...b, variant: 'denied_bytes', filename: 'a.req', reason: 'quota', request_sha256: H },
    { disposition: 'denied', reason: 'quota', ignored_count: null }),
  entry: () => mk({ ...b, variant: 'denied_entry', filename: 'a.req', reason: 'not_regular' },
    { disposition: 'denied', reason: 'not_regular', ignored_count: null }),
  size: () => mk({ ...b, variant: 'denied_size', filename: 'a.req', reason: 'too_large', size: 70000 },
    { disposition: 'denied', reason: 'too_large', ignored_count: null }),
  scan: () => mk({ ...b, variant: 'denied_scan', reason: 'scan_limit' },
    { disposition: 'denied', reason: 'scan_limit', ignored_count: 3 }),
};
const rec = (v: unknown) => () => parseApprovalRecord(v, F);
const code = (fn: () => unknown) => { try { fn(); } catch (e) { return e instanceof ApprovalError ? e.code : 'other'; } return 'none'; };
const clone = (v: object) => JSON.parse(JSON.stringify(v)) as M;

describe('parseApprovalRecord', () => {
  it('accepts pending and every denied branch, returning the same data', () => {
    for (const v of [pending(), ...Object.values(denied).map((f) => f())]) {
      expect(parseApprovalRecord(v, F)).toEqual(v);
    }
  });
  it('accepts a call origin', () => {
    const k: SourceKey = { ...pk, kind: 'call', source_id: 'call.1' };
    const o = { kind: 'call', call_id: 'call.1', project_dir: '/p', role: 'agent', full_writable: writable };
    expect(() => parseApprovalRecord(mk(k, { disposition: 'pending', executor: 'e', payload_sha256: H,
      payload_bytes: 0, qualification: snap, origin: o }), F)).not.toThrow();
  });
  it('rejects wrong or missing versions with the right code', () => {
    expect(code(rec({ ...pending(), schema_version: 2 }))).toBe('UNSUPPORTED_VERSION');
    const m = clone(pending()); delete m.schema_version;
    expect(code(rec(m))).toBe('CORRUPT_RECORD');
    expect(code(rec(null))).toBe('CORRUPT_RECORD');
    expect(code(rec([]))).toBe('CORRUPT_RECORD');
  });
  it.each([
    ['unknown top key', (r: M) => { r.extra = 1; }],
    ['unknown origin key', (r: M) => { r.origin.extra = 1; }],
    ['unknown source key', (r: M) => { r.source_key.extra = 1; }],
    ['unknown snapshot key', (r: M) => { r.qualification.extra = 1; }],
    ['pending with reason', (r: M) => { r.reason = 'quota'; }],
    ['bad date', (r: M) => { r.created_at = '2026-02-30T00:00:00.000Z'; }],
    ['lenient date', (r: M) => { r.created_at = '2026-11-14'; }],
    ['expires before created', (r: M) => { r.expires_at = '2026-11-13T00:00:00.000Z'; }],
    ['bad hash', (r: M) => { r.payload_sha256 = 'A'.repeat(64); }],
    ['hash differs from source', (r: M) => { r.payload_sha256 = 'b'.repeat(64); }],
    ['id mismatch', (r: M) => { r.id = 'b'.repeat(24); }],
    ['bad id shape', (r: M) => { r.id = 'zz'; }],
    ['bad seq', (r: M) => { r.source_key.seq = 0; }],
    ['bad executor name', (r: M) => { r.executor = '../x'; }],
    ['bad slot name', (r: M) => { r.proposer.slot = 'a/b'; }],
    ['proposer slot mismatch', (r: M) => { r.proposer.slot = 'other'; }],
    ['origin kind mismatch', (r: M) => { r.origin = { kind: 'call', call_id: 'run.1', project_dir: '/p', role: 'agent', full_writable: writable }; }],
    ['origin run mismatch', (r: M) => { r.origin.run_id = 'run.2'; }],
    ['proposer role mismatch', (r: M) => { r.proposer.role = 'other'; }],
    ['relative project_dir', (r: M) => { r.origin.project_dir = 'p'; }],
    ['relative writable', (r: M) => { r.origin.full_writable.dirs = ['rel']; }],
    ['payload too big', (r: M) => { r.payload_bytes = 65537; }],
    ['negative bytes', (r: M) => { r.payload_bytes = -1; }],
    ['float bytes', (r: M) => { r.payload_bytes = 1.5; }],
    ['pending missing snapshot', (r: M) => { r.qualification = null; }],
    ['pending missing executor', (r: M) => { r.executor = null; }],
    ['lone surrogate summary', (r: M) => { r.summary = 'a\ud800'; }],
    ['bad disposition', (r: M) => { r.disposition = 'executing'; }],
    ['bad premise', (r: M) => { r.qualification.premises = [{ check: 'c', ok: 'yes', code: 'x' }]; }],
  ])('rejects pending: %s', (_n, mutate) => {
    const r = clone(pending()); mutate(r);
    expect(code(rec(r))).toBe('CORRUPT_RECORD');
  });
  it.each([
    ['reason differs from variant', (r: M) => { r.reason = 'bad_header'; }],
    ['missing ignored_count key', (r: M) => { delete r.ignored_count; }],
    ['payload variant denied', (r: M) => { r.source_key = { ...r.source_key, variant: 'payload', payload_sha256: H }; }],
  ])('rejects denied_bytes: %s', (_n, mutate) => {
    const r = clone(denied.bytes?.() as object); mutate(r);
    expect(code(rec(r))).toBe('CORRUPT_RECORD');
  });
  it('rejects bad ignored_count rules and denied_size size', () => {
    for (const ic of [0, -1, null, 1.5]) expect(code(rec({ ...(denied.scan?.() as object), ignored_count: ic }))).toBe('CORRUPT_RECORD');
    expect(code(rec({ ...(denied.bytes?.() as object), ignored_count: 2 }))).toBe('CORRUPT_RECORD');
  });
  it('names the file and field in errors and never mutates frozen input', () => {
    const r = clone(pending()); r.payload_bytes = -1;
    try { parseApprovalRecord(Object.freeze(r), F); expect.unreachable(); }
    catch (e) { expect((e as ApprovalError).path).toBe(F); expect((e as ApprovalError).message).toContain('payload_bytes'); }
    const frozen = JSON.stringify(pending());
    const deep = pending();
    parseApprovalRecord(deep, F);
    expect(JSON.stringify(deep)).toBe(frozen);
  });
});

const actor = { user: 'u', tty: null, pid: 7, pid_started: 'x' };
const st = (extra: object, n = 2) => ({ schema_version: 1, n, previous: n - 1, updated_at: T0, actor, ...extra });
const out = { text: 'o', truncated: false };
const exit = { exit_code: 0, signal: null, failure: null, error_code: null, stdout: out, stderr: out };
const states: Record<string, object> = {
  executing: st({ status: 'executing', owner: { pid: 7, pid_started: 'x' }, timeout_sec: 5, viewed_bytes: 3, viewed_sha256: H, command_sha256: H }),
  executed: st({ status: 'executed', method: 'executor', result: exit }),
  failed: st({ status: 'failed', method: 'executor', result: { ...exit, exit_code: null, failure: 'timeout' } }),
  manual: st({ status: 'executed', method: 'manual', conclusion: 'done' }),
  manualFailed: st({ status: 'failed', method: 'manual', conclusion: 'bad' }),
  unknown: st({ status: 'unknown', reason: 'creator_dead', detail: 'd' }),
  interrupted: st({ status: 'unknown', reason: 'interrupted', detail: 'd' }),
  rejected: st({ status: 'rejected', reason: null }),
  rejectedWhy: st({ status: 'rejected', reason: 'no' }, 1),
  expired: st({ status: 'expired' }),
  tampered: st({ status: 'tampered', observed_sha256: H }),
};
const sf = '/x/state/2.json';
describe('parseApprovalState', () => {
  it.each(Object.entries(states))('accepts %s', (_n, v) => {
    expect(parseApprovalState(v, sf)).toEqual(v);
  });
  it.each([
    ['unknown key', (s: M) => { s.extra = 1; }],
    ['unknown nested key', (s: M) => { s.actor.extra = 1; }],
    ['n zero', (s: M) => { s.n = 0; s.previous = -1; }],
    ['n float', (s: M) => { s.n = 1.5; }],
    ['n unsafe', (s: M) => { s.n = Number.MAX_SAFE_INTEGER + 1; }],
    ['previous not n-1', (s: M) => { s.previous = 0; }],
    ['bad date', (s: M) => { s.updated_at = 'nope'; }],
    ['pid zero', (s: M) => { s.actor.pid = 0; }],
    ['user empty', (s: M) => { s.actor.user = ''; }],
    ['bad status', (s: M) => { s.status = 'pending'; }],
  ])('rejects: %s', (_n, mutate) => {
    const s = clone(states.executed as object); mutate(s);
    expect(code(() => parseApprovalState(s, sf))).toBe('CORRUPT_STATE');
  });
  it('rejects bad branch fields', () => {
    const ex = clone(states.executing as object);
    for (const p of [{ timeout_sec: 0 }, { timeout_sec: 1.5 }, { viewed_sha256: 'x' }, { viewed_bytes: -1 },
      { owner: { pid: 0, pid_started: 'x' } }, { owner: { pid: 7, pid_started: null } }, { owner: { pid: 7, pid_started: 'x', z: 1 } }]) {
      expect(code(() => parseApprovalState({ ...ex, ...p }, sf))).toBe('CORRUPT_STATE');
    }
    const ok = clone(states.executed as object);
    for (const p of [{ method: 'other' }, { result: { ...exit, failure: 'boom' } }, { result: { ...exit, stdout: { text: 1, truncated: false } } },
      { result: { ...exit, extra: 1 } }, { method: 'manual' }, { conclusion: 'x' }]) {
      expect(code(() => parseApprovalState({ ...ok, ...p }, sf))).toBe('CORRUPT_STATE');
    }
    expect(code(() => parseApprovalState({ ...(states.unknown as object), reason: 'x' }, sf))).toBe('CORRUPT_STATE');
    expect(code(() => parseApprovalState({ ...(states.tampered as object), observed_sha256: 'g' }, sf))).toBe('CORRUPT_STATE');
    expect(code(() => parseApprovalState({ ...(states.expired as object), reason: null }, sf))).toBe('CORRUPT_STATE');
  });
  it('rejects wrong or missing versions, freezes untouched', () => {
    expect(code(() => parseApprovalState({ ...(states.expired as object), schema_version: 9 }, sf))).toBe('UNSUPPORTED_VERSION');
    const m = clone(states.expired as object); delete m.schema_version;
    expect(code(() => parseApprovalState(m, sf))).toBe('CORRUPT_STATE');
    expect(code(() => parseApprovalState('x', sf))).toBe('CORRUPT_STATE');
    const frozen = Object.freeze(clone(states.executing as object));
    expect(() => parseApprovalState(frozen, sf)).not.toThrow();
  });
  it('has no filesystem use at import or parse', async () => {
    vi.resetModules();
    const spies = (['readFileSync', 'writeFileSync', 'mkdirSync', 'lstatSync', 'readdirSync', 'openSync'] as const)
      .map((k) => vi.spyOn(fs, k).mockImplementation(() => { throw new Error('fs used'); }));
    try {
      const m = await import('../src/approval-schema.js');
      m.parseApprovalRecord(pending(), F); m.parseApprovalState(states.executed, sf);
      for (const s of spies) expect(s).not.toHaveBeenCalled();
    } finally { vi.restoreAllMocks(); }
  });
});
