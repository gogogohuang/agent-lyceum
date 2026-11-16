import { describe, expect, it } from 'vitest';
import type { ExecutorConfig } from '../src/approval-executors.js';
import { qualificationHash, revalidateOrigin, revalidateQualification } from '../src/approval-origin.js';
import type { OriginResolved, OriginResolver, SnapshotInput } from '../src/approval-origin.js';
import type { ApprovalRecord, Origin } from '../src/approval-types.js';

const W = { dirs: ['/p/a'], files: ['/p/b'] };
const origin: Origin = { kind: 'run', project: 'proj', run_id: 'run.1', project_dir: '/p', role: 'dev', full_writable: W };
const exec: ExecutorConfig = { command: ['/usr/bin/deploy'], allow: [{ project: 'proj', agent: 'dev' }],
  timeout_sec: 30, env: {}, expires_days: 7, max_pending: 10, max_payload_bytes: 4096 };
const cand = { runtime: 'claude-code', sandbox: null, allow_web: null } as const;
const snap = (over: Partial<SnapshotInput> = {}): SnapshotInput => ({ runtime_candidates: [cand], writable: W, project_dir: '/p', executor: exec, ...over });
const resolved = (over: Partial<OriginResolved> = {}): OriginResolved => ({
  qualification: { enrolled: true, executors: ['deploy'] }, snapshot_input: snap(), premises: [{ check: 'c', ok: true, code: 'ok' }], ...over });
const resolver = (r: OriginResolved): OriginResolver => () => ({ ok: true, resolved: r });
const code = (r: { ok: boolean; code?: string }) => (r.ok ? 'ok' : r.code);

describe('revalidateQualification', () => {
  const expected = qualificationHash(snap());
  it('is ok when the fresh hash equals the expected one', () => {
    expect(code(revalidateQualification(origin, 'deploy', expected, resolver(resolved())))).toBe('ok');
  });
  it('gives SNAPSHOT_MISMATCH when the fresh snapshot differs', () => {
    const r = resolved({ snapshot_input: snap({ writable: { dirs: ['/p/a', '/p/c'], files: ['/p/b'] } }) });
    expect(code(revalidateQualification(origin, 'deploy', expected, resolver(r)))).toBe('SNAPSHOT_MISMATCH');
  });
  it('passes resolver refusals through (PROJECT_PATH_MISMATCH, NOT_ALLOWED, PREMISE_FAILED)', () => {
    expect(code(revalidateQualification(origin, 'deploy', expected, resolver(resolved({ snapshot_input: snap({ project_dir: '/q' }) }))))).toBe('PROJECT_PATH_MISMATCH');
    expect(code(revalidateQualification(origin, 'deploy', expected, resolver(resolved({ qualification: { enrolled: false, executors: [] } }))))).toBe('NOT_ALLOWED');
    expect(code(revalidateQualification(origin, 'deploy', expected, resolver(resolved({ premises: [{ check: 'x', ok: false, code: 'bad' }] }))))).toBe('PREMISE_FAILED');
  });
  it('gives ORIGIN_UNREADABLE when the resolver throws and CONFIG_INVALID when the snapshot cannot be hashed', () => {
    expect(code(revalidateQualification(origin, 'deploy', expected, () => { throw new Error('x'); }))).toBe('ORIGIN_UNREADABLE');
    expect(code(revalidateQualification(origin, 'deploy', expected, resolver(resolved({ snapshot_input: snap({ project_dir: '/p', writable: { dirs: ['rel'], files: [] } }) }))))).toBe('CONFIG_INVALID');
  });
});

describe('revalidateOrigin behaviour unchanged', () => {
  const rec = (disposition: 'pending' | 'denied', sha = qualificationHash(snap())): ApprovalRecord => ({
    schema_version: 1, id: 'a'.repeat(24), origin, executor: 'deploy', qualification: { schema_version: 1, sha256: sha, premises: [] },
    disposition } as unknown as ApprovalRecord);
  it('a pending record with a matching hash is ok, a changed one is SNAPSHOT_MISMATCH, a denied one NOT_ALLOWED', () => {
    expect(code(revalidateOrigin(rec('pending'), resolver(resolved())))).toBe('ok');
    expect(code(revalidateOrigin(rec('pending', 'b'.repeat(64)), resolver(resolved())))).toBe('SNAPSHOT_MISMATCH');
    expect(code(revalidateOrigin(rec('denied'), resolver(resolved())))).toBe('NOT_ALLOWED');
  });
});
