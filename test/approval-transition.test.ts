import { describe, expect, it } from 'vitest';
import {
  decideTransition, OUTPUT_CAP_BYTES, type ApprovalProof, type Decision, type TransitionEvent,
} from '../src/approval-transition.js';
import type { Actor, ApprovalRecord, ApprovalState, Current, ExitData, StateData } from '../src/approval-types.js';

const H = (c: string) => c.repeat(64);
const CREATED = Date.parse('2026-11-14T00:00:00.000Z');
const EXPIRES = CREATED + 3600_000;
const NOW = CREATED + 1000;
const actor: Actor = { user: 'u', tty: '/dev/ttys001', pid: 100, pid_started: 'S100' };
const ctx = (now = NOW, a: Actor = actor) => ({ now_ms: now, actor: a });

const record = {
  schema_version: 1, id: 'a'.repeat(24), disposition: 'pending', executor: 'ex', summary: null,
  payload_sha256: H('1'), payload_bytes: 10, created_at: new Date(CREATED).toISOString(),
  expires_at: new Date(EXPIRES).toISOString(), qualification: { schema_version: 1, sha256: H('2'), premises: [] },
} as unknown as ApprovalRecord;
const denied = { ...record, disposition: 'denied', reason: 'quota', executor: null } as unknown as ApprovalRecord;
const pending: Current = { record, n: 0, state: null };
const st = (data: StateData, n = 1): Current => ({ record, n, state: { ...data, schema_version: 1, n, previous: n - 1,
  updated_at: new Date(NOW).toISOString(), actor } as ApprovalState });
const owner = { pid: 100, pid_started: 'S100' };
const executing = st({ status: 'executing', owner, timeout_sec: 30, viewed_bytes: 10, viewed_sha256: H('1'), command_sha256: H('3') });
const unknown = st({ status: 'unknown', reason: 'creator_dead', detail: 'x' }, 2);
const proof = (over: Partial<ApprovalProof> = {}): ApprovalProof => ({
  origin_ok: true, premises_ok: true, executor_registered: true, allowed: true, interactive_tty: true,
  prefix_confirmed: true, completely_viewed: true, viewed_bytes: 10, viewed_sha256: H('1'),
  observed_payload_sha256: H('1'), owner, timeout_sec: 30, command_sha256: H('3'), ...over });
const approve = (p: ApprovalProof | null, creator = null): TransitionEvent => ({ type: 'approve', proof: p, creator });
const alive = { alive: true, reason: 'matching_start' } as const;
const dead = { alive: false, reason: 'missing_pid' } as const;
const exit = (over: Partial<ExitData> = {}): TransitionEvent => ({ type: 'executor_exit', result: {
  exit_code: 0, signal: null, failure: null, error_code: null,
  stdout: { text: 'o', truncated: false }, stderr: { text: '', truncated: false }, ...over } });

const refusedWith = (d: Decision, code: string) => { expect(d).toMatchObject({ kind: 'refuse', code }); };
const appended = (d: Decision): ApprovalState => { expect(d.kind).toBe('append'); return (d as { next: ApprovalState }).next; };

describe('pending / approve', () => {
  it('approves with a full proof: executing, audit fields filled', () => {
    const s = appended(decideTransition(pending, approve(proof()), ctx()));
    expect(s).toMatchObject({ status: 'executing', n: 1, previous: 0, schema_version: 1, actor, owner, timeout_sec: 30,
      viewed_bytes: 10, viewed_sha256: H('1'), command_sha256: H('3'), updated_at: new Date(NOW).toISOString() });
  });
  it('clock rollback refuses (checked before expiry and proof)', () => {
    refusedWith(decideTransition(pending, approve(null), ctx(CREATED - 1)), 'CLOCK_ROLLBACK');
  });
  it('now == created_at is allowed', () => {
    expect(decideTransition(pending, approve(proof()), ctx(CREATED)).kind).toBe('append');
  });
  it('expiry boundary: now == expires_at approves, +1 ms expires (even with null proof)', () => {
    expect(decideTransition(pending, approve(proof()), ctx(EXPIRES)).kind).toBe('append');
    expect(appended(decideTransition(pending, approve(null), ctx(EXPIRES + 1)))).toMatchObject({ status: 'expired' });
  });
  it('missing proof is INVALID_PROOF', () => refusedWith(decideTransition(pending, approve(null), ctx()), 'INVALID_PROOF'));
  it('hash mismatch -> tampered with observed hash', () => {
    expect(appended(decideTransition(pending, approve(proof({ observed_payload_sha256: H('9') })), ctx())))
      .toMatchObject({ status: 'tampered', observed_sha256: H('9') });
  });
  it('malformed observed hash is INVALID_PROOF, not tampered', () => {
    refusedWith(decideTransition(pending, approve(proof({ observed_payload_sha256: 'zz' })), ctx()), 'INVALID_PROOF');
  });
  it.each([
    ['origin_ok', 'QUALIFICATION_FAILED'], ['premises_ok', 'QUALIFICATION_FAILED'],
    ['executor_registered', 'QUALIFICATION_FAILED'], ['allowed', 'QUALIFICATION_FAILED'],
    ['interactive_tty', 'CONFIRMATION_REQUIRED'], ['prefix_confirmed', 'CONFIRMATION_REQUIRED'],
    ['completely_viewed', 'CONFIRMATION_REQUIRED'],
  ] as const)('proof.%s=false refuses with %s', (field, code) => {
    refusedWith(decideTransition(pending, approve(proof({ [field]: false })), ctx()), code);
  });
  it('actor without a tty refuses CONFIRMATION_REQUIRED', () => {
    refusedWith(decideTransition(pending, approve(proof()), ctx(NOW, { ...actor, tty: null })), 'CONFIRMATION_REQUIRED');
  });
  it.each([
    ['empty pid_started', { owner: { pid: 100, pid_started: '' } }],
    ['owner != actor pid', { owner: { pid: 101, pid_started: 'S100' } }],
    ['owner != actor start', { owner: { pid: 100, pid_started: 'other' } }],
    ['viewed_bytes mismatch', { viewed_bytes: 9 }],
    ['viewed_sha256 mismatch', { viewed_sha256: H('8') }],
    ['viewed_sha256 malformed', { viewed_sha256: 'x' }],
    ['timeout 0', { timeout_sec: 0 }],
    ['timeout fractional', { timeout_sec: 1.5 }],
    ['command hash malformed', { command_sha256: 'x' }],
  ] as const)('%s -> INVALID_PROOF', (_n, over) => {
    refusedWith(decideTransition(pending, approve(proof(over as Partial<ApprovalProof>)), ctx()), 'INVALID_PROOF');
  });
  it('actor with null pid_started cannot be owner', () => {
    const a = { ...actor, pid_started: null };
    refusedWith(decideTransition(pending, approve(proof({ owner: { pid: 100, pid_started: '' } })), ctx(NOW, a)), 'INVALID_PROOF');
  });
});

describe('pending / reject, lazy, others', () => {
  const rej = (over = {}): TransitionEvent => ({ type: 'reject', reason: 'no', interactive_tty: true, prefix_confirmed: true, ...over });
  it('reject with tty + prefix -> rejected (no viewed proof needed)', () => {
    expect(appended(decideTransition(pending, rej(), ctx()))).toMatchObject({ status: 'rejected', reason: 'no' });
  });
  it('reject works on an expired-but-unwritten pending', () => {
    expect(appended(decideTransition(pending, rej(), ctx(EXPIRES + 5000)))).toMatchObject({ status: 'rejected' });
  });
  it.each([{ interactive_tty: false }, { prefix_confirmed: false }])('reject %j -> CONFIRMATION_REQUIRED', (o) => {
    refusedWith(decideTransition(pending, rej(o), ctx()), 'CONFIRMATION_REQUIRED');
  });
  it('reject without actor tty refuses', () => {
    refusedWith(decideTransition(pending, rej(), ctx(NOW, { ...actor, tty: null })), 'CONFIRMATION_REQUIRED');
  });
  it.each(['list_all', 'approve', 'collect'] as const)('lazy(%s): expired after expiry, noop before and at boundary', (trigger) => {
    const ev: TransitionEvent = { type: 'lazy', trigger, creator: null };
    expect(appended(decideTransition(pending, ev, ctx(EXPIRES + 1)))).toMatchObject({ status: 'expired' });
    expect(decideTransition(pending, ev, ctx(EXPIRES))).toEqual({ kind: 'noop' });
  });
  it('inapplicable events are NOT_APPLICABLE', () => {
    for (const ev of [exit(), { type: 'interrupt', group_termination_requested: true, detail: '' },
      { type: 'creator_dead', evidence: dead }, { type: 'resolve', outcome: 'failed', conclusion: 'c', interactive_tty: true, prefix_confirmed: true }] as TransitionEvent[]) {
      refusedWith(decideTransition(pending, ev, ctx()), 'NOT_APPLICABLE');
    }
  });
});

describe('executing', () => {
  it('exit 0 -> executed (creator only)', () => {
    expect(appended(decideTransition(executing, exit(), ctx()))).toMatchObject({ status: 'executed', method: 'executor', n: 2, previous: 1 });
  });
  it.each([
    ['non-zero', { exit_code: 2, failure: 'exit' as const }],
    ['non-zero without failure tag', { exit_code: 2 }],
    ['timeout', { exit_code: null, signal: 'SIGKILL', failure: 'timeout' as const }],
    ['spawn failure', { exit_code: null, failure: 'spawn' as const, error_code: 'ENOENT' }],
    ['signal', { exit_code: null, signal: 'SIGTERM' }],
  ])('%s -> failed', (_n, over) => {
    expect(appended(decideTransition(executing, exit(over), ctx()))).toMatchObject({ status: 'failed', method: 'executor' });
  });
  it.each([
    ['exit 0 with failure', { failure: 'exit' as const }],
    ['exit 0 with signal', { signal: 'SIGTERM' }],
    ['spawn with exit code', { exit_code: 1, failure: 'spawn' as const }],
    ['null code, no signal, no failure', { exit_code: null }],
    ['non-zero with signal', { exit_code: 1, signal: 'SIGTERM' }],
  ])('inconsistent tuple (%s) -> INVALID_PROOF', (_n, over) => {
    refusedWith(decideTransition(executing, exit(over), ctx()), 'INVALID_PROOF');
  });
  it('non-creator completion -> NOT_CREATOR (pid and start both matter)', () => {
    refusedWith(decideTransition(executing, exit(), ctx(NOW, { ...actor, pid: 7 })), 'NOT_CREATOR');
    refusedWith(decideTransition(executing, exit(), ctx(NOW, { ...actor, pid_started: 'X' })), 'NOT_CREATOR');
  });
  it('output byte cap in UTF-8 bytes: 65536 ok, 65537 refused, multibyte counted as bytes', () => {
    const out = (text: string) => exit({ stdout: { text, truncated: true } });
    expect(decideTransition(executing, out('a'.repeat(OUTPUT_CAP_BYTES)), ctx()).kind).toBe('append');
    refusedWith(decideTransition(executing, out('a'.repeat(OUTPUT_CAP_BYTES + 1)), ctx()), 'INVALID_PROOF');
    refusedWith(decideTransition(executing, out('é'.repeat(OUTPUT_CAP_BYTES / 2 + 1)), ctx()), 'INVALID_PROOF');
    refusedWith(decideTransition(executing, exit({ stderr: { text: 'a'.repeat(OUTPUT_CAP_BYTES + 1), truncated: true } }), ctx()), 'INVALID_PROOF');
  });
  it('interrupt by creator -> unknown/interrupted; non-creator refused; no group stop refused', () => {
    const ev: TransitionEvent = { type: 'interrupt', group_termination_requested: true, detail: 'SIGINT' };
    expect(appended(decideTransition(executing, ev, ctx()))).toMatchObject({ status: 'unknown', reason: 'interrupted', detail: 'SIGINT' });
    refusedWith(decideTransition(executing, ev, ctx(NOW, { ...actor, pid: 7 })), 'NOT_CREATOR');
    refusedWith(decideTransition(executing, { ...ev, group_termination_requested: false as unknown as true }, ctx()), 'INVALID_PROOF');
  });
  const recovery: [string, (l: typeof dead | typeof alive | null) => TransitionEvent][] = [
    ['approve', (l) => ({ type: 'approve', proof: null, creator: l })],
    ['lazy', (l) => ({ type: 'lazy', trigger: 'list_all', creator: l })],
    ['creator_dead', (l) => ({ type: 'creator_dead', evidence: l as typeof dead })],
  ];
  it.each(recovery)('%s with dead creator -> unknown/creator_dead only, never executing', (_n, mk) => {
    const other = { ...actor, pid: 555, pid_started: 'S555' };
    const s = appended(decideTransition(executing, mk(dead), ctx(NOW, other)));
    expect(s).toMatchObject({ status: 'unknown', reason: 'creator_dead', actor: other });
  });
  it.each(recovery)('%s with live creator -> noop (no write)', (_n, mk) => {
    expect(decideTransition(executing, mk(alive), ctx(NOW, { ...actor, pid: 555 }))).toEqual({ kind: 'noop' });
  });
  it.each(recovery.slice(0, 2))('%s without evidence -> INVALID_PROOF', (_n, mk) => {
    refusedWith(decideTransition(executing, mk(null), ctx()), 'INVALID_PROOF');
  });
  it('approve on executing ignores a pending-style proof and never re-executes', () => {
    const d = decideTransition(executing, { type: 'approve', proof: proof(), creator: dead }, ctx());
    expect(appended(d).status).toBe('unknown');
  });
  it('reject/resolve on executing are NOT_APPLICABLE', () => {
    refusedWith(decideTransition(executing, { type: 'reject', reason: null, interactive_tty: true, prefix_confirmed: true }, ctx()), 'NOT_APPLICABLE');
    refusedWith(decideTransition(executing, { type: 'resolve', outcome: 'failed', conclusion: 'c', interactive_tty: true, prefix_confirmed: true }, ctx()), 'NOT_APPLICABLE');
  });
});

describe('unknown / terminal', () => {
  const res = (over = {}): TransitionEvent => ({ type: 'resolve', outcome: 'executed', conclusion: 'done by hand',
    interactive_tty: true, prefix_confirmed: true, ...over } as TransitionEvent);
  it.each(['executed', 'failed'] as const)('resolve %s -> manual state, no owner', (outcome) => {
    const s = appended(decideTransition(unknown, res({ outcome }), ctx()));
    expect(s).toMatchObject({ status: outcome, method: 'manual', conclusion: 'done by hand', n: 3 });
    expect(s).not.toHaveProperty('owner');
  });
  it('resolve needs tty + prefix; invalid outcome / empty conclusion are INVALID_PROOF', () => {
    refusedWith(decideTransition(unknown, res({ interactive_tty: false }), ctx()), 'CONFIRMATION_REQUIRED');
    refusedWith(decideTransition(unknown, res({ prefix_confirmed: false }), ctx()), 'CONFIRMATION_REQUIRED');
    refusedWith(decideTransition(unknown, res(), ctx(NOW, { ...actor, tty: null })), 'CONFIRMATION_REQUIRED');
    refusedWith(decideTransition(unknown, res({ outcome: 'rejected' }), ctx()), 'INVALID_PROOF');
    refusedWith(decideTransition(unknown, res({ conclusion: '' }), ctx()), 'INVALID_PROOF');
  });
  it('approve on unknown -> ALREADY_HANDLED, never executing', () => {
    refusedWith(decideTransition(unknown, approve(proof(), alive as never), ctx()), 'ALREADY_HANDLED');
  });
  it('other events on unknown are NOT_APPLICABLE', () => {
    refusedWith(decideTransition(unknown, { type: 'lazy', trigger: 'collect', creator: dead }, ctx()), 'NOT_APPLICABLE');
    refusedWith(decideTransition(unknown, exit(), ctx()), 'NOT_APPLICABLE');
  });
  const terminals: [string, Current][] = [
    ['denied', { record: denied, n: 0, state: null }],
    ['executed', st({ status: 'executed', method: 'manual', conclusion: 'c' }, 3)],
    ['failed', st({ status: 'failed', method: 'manual', conclusion: 'c' }, 3)],
    ['rejected', st({ status: 'rejected', reason: null })],
    ['expired', st({ status: 'expired' })],
    ['tampered', st({ status: 'tampered', observed_sha256: H('9') })],
  ];
  it.each(terminals)('%s accepts no append (any event)', (_n, cur) => {
    for (const ev of [approve(proof()), exit(), res(), { type: 'lazy', trigger: 'list_all', creator: dead },
      { type: 'reject', reason: null, interactive_tty: true, prefix_confirmed: true },
      { type: 'creator_dead', evidence: dead }] as TransitionEvent[]) {
      refusedWith(decideTransition(cur, ev, ctx()), 'ALREADY_HANDLED');
    }
  });
});

describe('guards and purity', () => {
  it('sequence overflow is rejected for appends', () => {
    const max = Number.MAX_SAFE_INTEGER;
    const cur = st({ status: 'executing', owner, timeout_sec: 30, viewed_bytes: 10, viewed_sha256: H('1'), command_sha256: H('3') }, max);
    refusedWith(decideTransition(cur, exit(), ctx()), 'SEQUENCE_OVERFLOW');
    expect(decideTransition(cur, { type: 'lazy', trigger: 'collect', creator: alive }, ctx())).toEqual({ kind: 'noop' });
  });
  it('inconsistent current / invalid time throw INVALID_INPUT', () => {
    expect(() => decideTransition({ record, n: 0, state: executing.state }, approve(proof()), ctx())).toThrow(/n=0/);
    expect(() => decideTransition({ record, n: 3, state: executing.state }, approve(proof()), ctx())).toThrow(/state/);
    expect(() => decideTransition(pending, approve(proof()), ctx(Number.NaN))).toThrow(/now_ms/);
    expect(() => decideTransition(pending, approve(proof()), ctx(8.7e15))).toThrow(/now_ms/);
  });
  it('does not mutate its inputs', () => {
    const cur = structuredClone(executing); const ev = exit(); const p = structuredClone(ev);
    const frozen = Object.freeze(cur);
    decideTransition(frozen, ev, ctx());
    expect(cur).toEqual(executing); expect(ev).toEqual(p);
  });
  it('a committed recovery is unknown, never an executing state (no spawn authorization)', () => {
    for (const ev of [approve(null, dead as never), { type: 'creator_dead', evidence: dead }] as TransitionEvent[]) {
      expect(appended(decideTransition(executing, ev, ctx(NOW, { ...actor, pid: 9 }))).status).not.toBe('executing');
    }
  });
});
