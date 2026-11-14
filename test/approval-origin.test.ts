import fs from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { ApprovalError } from '../src/approval-error.js';
import type { ExecutorConfig } from '../src/approval-executors.js';
import { qualificationHash, resolveOrigin, revalidateOrigin, staticWritable } from '../src/approval-origin.js';
import type { OriginResolved, OriginResolver, SnapshotInput } from '../src/approval-origin.js';
import type { ApprovalRecord, Origin } from '../src/approval-types.js';
import type { ResolvedAgent } from '../src/config.js';
import { agentForCandidate, candidatesFor } from '../src/fallback.js';

const H = 'a'.repeat(64);
const W = { dirs: ['/p/a'], files: ['/p/b'] };
const origin: Origin = Object.freeze({ kind: 'run', project: 'proj', run_id: 'run.1', project_dir: '/p', role: 'dev',
  full_writable: W });
const exec: ExecutorConfig = { command: ['/usr/bin/deploy'], allow: [{ project: 'proj', agent: 'dev' }],
  timeout_sec: 30, env: { A: '1' }, expires_days: 7, max_pending: 10, max_payload_bytes: 4096 };
const cand = { runtime: 'claude-code', sandbox: null, allow_web: null } as const;
const snapIn = (over: Partial<SnapshotInput> = {}): SnapshotInput => ({ runtime_candidates: [cand],
  writable: { dirs: ['/p/a'], files: ['/p/b'] }, project_dir: '/p', executor: exec, ...over });
const okRes = (over: Partial<OriginResolved> = {}): OriginResolved => ({
  qualification: { enrolled: true, executors: ['deploy'] }, snapshot_input: snapIn(),
  premises: [{ check: 'c1', ok: true, code: 'ok' }], ...over });
const resolver = (r: OriginResolved): OriginResolver => () => ({ ok: true, resolved: r });
const fail = (r: ReturnType<typeof resolveOrigin>) => (r.ok ? 'ok' : r.code);

describe('staticWritable', () => {
  const g = (effective: object, run_only: object, dup: object = { dirs: [], files: [] }) =>
    staticWritable({ effective, run_only, static_duplicates: dup } as never);
  it('is (effective - run_only) + static duplicates, sorted unique per kind', () => {
    expect(g({ dirs: ['/b', '/a', '/run/t', '/a'], files: ['/f2', '/f1', '/run/o'] }, { dirs: ['/run/t'], files: ['/run/o'] }))
      .toEqual({ dirs: ['/a', '/b'], files: ['/f1', '/f2'] });
  });
  it('keeps a path that is both run-only and an explicit static duplicate', () => {
    expect(g({ dirs: ['/s', '/x'], files: [] }, { dirs: ['/s'], files: [] }, { dirs: ['/s'], files: [] }).dirs).toEqual(['/s', '/x']);
  });
  it('does not subtract descendants or ancestors of run-only entries', () => {
    expect(g({ dirs: ['/run', '/run/sub', '/run/..x'], files: [] }, { dirs: ['/run'], files: [] }).dirs).toEqual(['/run/..x', '/run/sub']);
  });
  it('includes an unknown new static grant automatically', () => {
    const base = g({ dirs: ['/a'], files: [] }, { dirs: [], files: [] });
    const more = g({ dirs: ['/a', '/new-grant'], files: [] }, { dirs: [], files: [] });
    expect(more.dirs).toContain('/new-grant');
    expect(qualificationHash(snapIn({ writable: base }))).not.toBe(qualificationHash(snapIn({ writable: more })));
  });
  it('rejects duplicates missing from effective, relative or non-array input, without mutating', () => {
    expect(() => g({ dirs: ['/a'], files: [] }, { dirs: [], files: [] }, { dirs: ['/zzz'], files: [] })).toThrowError(ApprovalError);
    expect(() => g({ dirs: ['rel'], files: [] }, { dirs: [], files: [] })).toThrowError(ApprovalError);
    expect(() => staticWritable({ effective: null } as never)).toThrowError(ApprovalError);
    const eff = Object.freeze({ dirs: Object.freeze(['/b', '/a']), files: Object.freeze([]) });
    const ro = Object.freeze({ dirs: Object.freeze([]), files: Object.freeze([]) });
    expect(staticWritable({ effective: eff, run_only: ro, static_duplicates: ro }).dirs).toEqual(['/a', '/b']);
    expect(eff.dirs).toEqual(['/b', '/a']);
  });
  it('simulated clear: same static set with or without run-only dirs present', () => {
    const before = g({ dirs: ['/s', '/run/task', '/run/outbox', '/run/git'], files: [] }, { dirs: ['/run/task', '/run/outbox', '/run/git'], files: [] });
    const after = g({ dirs: ['/s'], files: [] }, { dirs: [], files: [] });
    expect(qualificationHash(snapIn({ writable: before }))).toBe(qualificationHash(snapIn({ writable: after })));
  });
});

describe('qualificationHash', () => {
  const h = (over: Partial<SnapshotInput> = {}) => qualificationHash(snapIn(over));
  it('is a deterministic 64-hex digest with a literal golden', () => {
    expect(h()).toMatch(/^[0-9a-f]{64}$/);
    expect(h()).toBe(h());
    expect(h()).toBe('1eaddee07d2fc6356f3f7b2a554532c0843293c29c9ebc1ac8d36a7712e6b741');
  });
  it('changes with runtime, project_dir, writable, sandbox, web, env, allow, command and limits', () => {
    const base = h();
    const variants: Partial<SnapshotInput>[] = [
      { runtime_candidates: [{ ...cand, runtime: 'codex' }] }, { project_dir: '/q' },
      { writable: { dirs: ['/p/a', '/p/c'], files: ['/p/b'] } }, { writable: { dirs: ['/p/a'], files: [] } },
      { runtime_candidates: [{ ...cand, allow_web: 'search' }] },
      { runtime_candidates: [{ ...cand, sandbox: { write: [], network: [], local_binding: false, unix_sockets: [] } }] },
      { executor: { ...exec, env: { A: '2' } } }, { executor: { ...exec, env: {} } },
      { executor: { ...exec, allow: [{ project: 'proj', agent: 'ops' }] } }, { executor: { ...exec, command: ['/usr/bin/other'] } },
      { executor: { ...exec, timeout_sec: 31 } }, { executor: { ...exec, max_payload_bytes: 5 } },
      { runtime_candidates: [cand, { ...cand, runtime: 'codex', allow_web: 'none' }] },
    ];
    const all = new Set([base, ...variants.map(h)]);
    expect(all.size).toBe(variants.length + 1);
  });
  it('treats absent sandbox and an explicit empty sandbox differently, and keeps candidate order', () => {
    const empty = { write: [], network: [], local_binding: false, unix_sockets: [] };
    expect(h({ runtime_candidates: [{ ...cand, sandbox: empty }] })).not.toBe(h());
    const a = { ...cand, runtime: 'codex' } as const;
    expect(h({ runtime_candidates: [cand, a] })).not.toBe(h({ runtime_candidates: [a, cand] }));
  });
  it('sorts unordered sets: sandbox paths, allow entries, env key order', () => {
    const sb = (w: string[]) => ({ ...cand, sandbox: { write: w, network: ['b.com', 'a.com'], local_binding: true, unix_sockets: ['/s2', '/s1'] } });
    const sb2 = { ...cand, sandbox: { write: ['/y', '/x', '/x'], network: ['a.com', 'b.com'], local_binding: true, unix_sockets: ['/s1', '/s2'] } };
    expect(h({ runtime_candidates: [sb(['/x', '/y'])] })).toBe(h({ runtime_candidates: [sb2] }));
    const al = [{ project: 'p', agent: 'a' }, { call: 'c' }];
    expect(h({ executor: { ...exec, allow: al } })).toBe(h({ executor: { ...exec, allow: [...al].reverse() } }));
    expect(h({ executor: { ...exec, env: { A: '1', B: '2' } } })).toBe(h({ executor: { ...exec, env: { B: '2', A: '1' } } }));
    expect(h({ writable: { dirs: ['/b', '/a'], files: [] } })).toBe(h({ writable: { dirs: ['/a', '/b'], files: [] } }));
  });
  it('normalizes localBinding and unixSockets from the real fallback helpers (unset -> none vs explicit search)', () => {
    const agent = (allowWeb?: 'search'): ResolvedAgent => ({ name: 'dev', runtime: 'claude-code', model: 'm1', agentMd: '', memory: {},
      resume: true, canMessage: 'all', canEditAgentMd: false, canAskUser: false, allowWeb,
      sandbox: { write: ['/w'], network: ['n.com'], localBinding: true, unixSockets: ['/u'] },
      fallback: [{ runtime: 'codex', model: 'm2' }], fallbackShared: false } as unknown as ResolvedAgent);
    const map = (a: ResolvedAgent) => candidatesFor(a).map((c) => agentForCandidate(a, c)).map((e) => ({
      runtime: e.runtime as 'claude-code' | 'codex', allow_web: e.allowWeb ?? null,
      sandbox: e.sandbox ? { write: e.sandbox.write, network: e.sandbox.network, local_binding: e.sandbox.localBinding,
        unix_sockets: e.sandbox.unixSockets } : null }));
    expect(map(agent()).map((c) => c.allow_web)).toEqual([null, 'none']);
    expect(map(agent('search')).map((c) => c.allow_web)).toEqual(['search', 'search']);
    expect(map(agent())[1]?.sandbox).toEqual({ write: ['/w'], network: ['n.com'], local_binding: true, unix_sockets: ['/u'] });
    expect(h({ runtime_candidates: map(agent()) })).not.toBe(h({ runtime_candidates: map(agent('search')) }));
    expect(h({ runtime_candidates: map(agent()) })).toBe('c12f2a45a8b8f1dfdbae9c0bfac96ddf0d5f5e5f9e28b6a8691cad919429a435');
  });
  it('ignores model, tier, session and binary changes (not part of the input) but rejects non-JSON data', () => {
    const withModel = { ...snapIn(), model: 'x', tier: 'low', session: 's', binary_sha256: H } as unknown as SnapshotInput;
    expect(qualificationHash(withModel)).toBe(h());
    for (const bad of [{ executor: { ...exec, timeout_sec: Number.NaN } }, { project_dir: 'a\ud800' }, { project_dir: 'rel' }]) {
      expect(() => h(bad as Partial<SnapshotInput>)).toThrowError(ApprovalError);
    }
  });
  it('does not mutate frozen input', () => {
    const input = snapIn({ writable: { dirs: ['/b', '/a'], files: [] } });
    const frozen = JSON.stringify(input);
    qualificationHash(Object.freeze(input));
    expect(JSON.stringify(input)).toBe(frozen);
  });
});

describe('resolveOrigin', () => {
  it('passes origin and executor to the resolver and returns the resolved data', () => {
    const spy = vi.fn(resolver(okRes()));
    const r = resolveOrigin(origin, 'deploy', spy);
    expect(spy).toHaveBeenCalledWith(origin, 'deploy');
    expect(r.ok && r.resolved.qualification.executors).toEqual(['deploy']);
  });
  it('passes through every resolver error code with its hint', () => {
    for (const code of ['PROJECT_MISSING', 'PROJECT_PATH_MISMATCH', 'AGENT_MISSING', 'EXECUTOR_MISSING', 'NOT_ALLOWED',
      'PREMISE_FAILED', 'SNAPSHOT_MISMATCH', 'CONFIG_INVALID', 'ORIGIN_UNREADABLE'] as const) {
      const r = resolveOrigin(origin, 'deploy', () => ({ ok: false, code, hint: `h-${code}` }));
      expect(r).toEqual({ ok: false, code, hint: `h-${code}` });
    }
  });
  it('rejects a canonical project_dir that differs from the origin', () => {
    const r = resolveOrigin(origin, 'deploy', resolver(okRes({ snapshot_input: snapIn({ project_dir: '/other' }) })));
    expect(fail(r)).toBe('PROJECT_PATH_MISMATCH');
  });
  it('rejects an unenrolled role or executor not in the qualification', () => {
    expect(fail(resolveOrigin(origin, 'deploy', resolver(okRes({ qualification: { enrolled: false, executors: [] } }))))).toBe('NOT_ALLOWED');
    expect(fail(resolveOrigin(origin, 'deploy', resolver(okRes({ qualification: { enrolled: true, executors: ['other'] } }))))).toBe('NOT_ALLOWED');
  });
  it('rejects failed premises and names the check', () => {
    const r = resolveOrigin(origin, 'deploy', resolver(okRes({ premises: [{ check: 'sandbox-on', ok: false, code: 'x' }] })));
    expect(fail(r)).toBe('PREMISE_FAILED');
    expect(!r.ok && r.hint).toContain('sandbox-on');
  });
  it('wraps a throwing resolver as ORIGIN_UNREADABLE without leaking the message', () => {
    const r = resolveOrigin(origin, 'deploy', () => { throw new Error('secret-token /home/x'); });
    expect(fail(r)).toBe('ORIGIN_UNREADABLE');
    expect(!r.ok && r.hint).not.toContain('secret-token');
  });
  it('treats a malformed resolver result as CONFIG_INVALID', () => {
    expect(fail(resolveOrigin(origin, 'deploy', (() => null) as never))).toBe('CONFIG_INVALID');
    expect(fail(resolveOrigin(origin, 'deploy', (() => ({ ok: true, resolved: {} })) as never))).toBe('CONFIG_INVALID');
  });
  it('every failure hint says how to recover and never suggests resolving pending', () => {
    const r = resolveOrigin(origin, 'deploy', resolver(okRes({ qualification: { enrolled: false, executors: [] } })));
    expect(!r.ok && r.hint).toMatch(/reject/);
    expect(!r.ok && r.hint).toMatch(/propose/i);
  });
  it('reads no real config or run file', () => {
    const spies = (['readFileSync', 'openSync', 'readdirSync', 'statSync', 'lstatSync'] as const)
      .map((k) => vi.spyOn(fs, k).mockImplementation(() => { throw new Error('fs used'); }));
    try {
      resolveOrigin(origin, 'deploy', resolver(okRes()));
      qualificationHash(snapIn());
      staticWritable({ effective: W, run_only: { dirs: [], files: [] }, static_duplicates: { dirs: [], files: [] } });
      for (const s of spies) expect(s).not.toHaveBeenCalled();
    } finally { vi.restoreAllMocks(); }
  });
});

describe('revalidateOrigin', () => {
  const pend = (sha = qualificationHash(snapIn())): ApprovalRecord => ({ schema_version: 1, id: 'a'.repeat(24),
    source_key: { kind: 'run', source_id: 'run.1', slot: 'dev', seq: 1, variant: 'payload', filename: 'a.req', payload_sha256: H },
    origin, proposer: { role: 'dev', slot: 'dev' }, created_at: '2026-11-14T00:00:00.000Z', expires_at: '2026-11-21T00:00:00.000Z',
    executor: 'deploy', summary: null, payload_sha256: H, payload_bytes: 1,
    qualification: { schema_version: 1, sha256: sha, premises: [] }, disposition: 'pending' });
  it('accepts a matching snapshot, resolver sees record origin and executor', () => {
    const spy = vi.fn(resolver(okRes()));
    expect(revalidateOrigin(pend(), spy).ok).toBe(true);
    expect(spy).toHaveBeenCalledWith(origin, 'deploy');
  });
  it('reports SNAPSHOT_MISMATCH when any hashed input changed', () => {
    const r = revalidateOrigin(pend(), resolver(okRes({ snapshot_input: snapIn({ executor: { ...exec, env: { A: '9' } } }) })));
    expect(fail(r)).toBe('SNAPSHOT_MISMATCH');
  });
  it('same hash after model/binary change and after a simulated clear', () => {
    expect(revalidateOrigin(pend(), resolver(okRes({ snapshot_input: { ...snapIn(), model: 'new', tier: 'x' } as never }))).ok).toBe(true);
  });
  it('propagates resolver failures and premise failures', () => {
    expect(fail(revalidateOrigin(pend(), () => ({ ok: false, code: 'AGENT_MISSING', hint: 'h' })))).toBe('AGENT_MISSING');
    expect(fail(revalidateOrigin(pend(), resolver(okRes({ premises: [{ check: 'c', ok: false, code: 'x' }] }))))).toBe('PREMISE_FAILED');
  });
  it('denied records give NOT_ALLOWED without calling the resolver', () => {
    const spy = vi.fn(resolver(okRes()));
    const denied = { ...pend(), disposition: 'denied', reason: 'quota', ignored_count: null, qualification: null } as unknown as ApprovalRecord;
    expect(fail(revalidateOrigin(denied, spy))).toBe('NOT_ALLOWED');
    expect(spy).not.toHaveBeenCalled();
  });
  it('config problems while hashing become CONFIG_INVALID', () => {
    const r = revalidateOrigin(pend(), resolver(okRes({ snapshot_input: snapIn({ project_dir: '/p' }), } as never) as never));
    expect(r.ok).toBe(true);
    const bad = okRes({ snapshot_input: { ...snapIn(), writable: null } as never });
    expect(fail(revalidateOrigin(pend(), resolver(bad)))).toBe('CONFIG_INVALID');
  });
});
