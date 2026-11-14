import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ApprovalError } from '../src/approval-error.js';
import { approvalId } from '../src/approval-id.js';
import type { ApprovalIo } from '../src/approval-io.js';
import { recordPaths } from '../src/approval-paths.js';
import { readCurrent, transition, type TransitionResult } from '../src/approval-state.js';
import { publishRecord } from '../src/approval-store.js';
import type { ApprovalProof, TransitionEvent } from '../src/approval-transition.js';
import type { Actor, ApprovalRecord, ApprovalState, Current, SourceKey } from '../src/approval-types.js';

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const T0 = Date.parse('2026-11-14T00:00:00.000Z');
const T1 = T0 + 7 * 86400_000;
const NOW = T0 + 1000;
const PAYLOAD = Buffer.from('{"cmd":"deploy"}\n');
const writable = { dirs: ['/p/a'], files: ['/p/b'] };
const origin = { kind: 'run', project: 'proj', run_id: 'run.1', project_dir: '/p', role: 'agent', full_writable: writable } as const;
const snap = { schema_version: 1, sha256: 'b'.repeat(64), premises: [] } as const;
const A: Actor = { user: 'u', tty: '/dev/ttys1', pid: 100, pid_started: 'SA' };
const B: Actor = { user: 'u', tty: '/dev/ttys2', pid: 200, pid_started: 'SB' };
const ownerOf = (a: Actor) => ({ pid: a.pid, pid_started: a.pid_started as string });
const alive = { alive: true, reason: 'matching_start' } as const;
const dead = { alive: false, reason: 'missing_pid' } as const;

function pendingRecord(): ApprovalRecord {
  const key: SourceKey = { kind: 'run', source_id: 'run.1', slot: 'agent--2', seq: 1, variant: 'payload', filename: 'a.req', payload_sha256: sha(PAYLOAD) };
  return { schema_version: 1, id: approvalId(key), source_key: key, origin, proposer: { role: 'agent', slot: 'agent--2' },
    created_at: new Date(T0).toISOString(), expires_at: new Date(T1).toISOString(), executor: 'deploy', summary: null,
    payload_sha256: sha(PAYLOAD), payload_bytes: PAYLOAD.length, qualification: snap, disposition: 'pending' } as ApprovalRecord;
}
function deniedRecord(): ApprovalRecord {
  const key: SourceKey = { kind: 'run', source_id: 'run.1', slot: 'agent--2', seq: 2, variant: 'denied_entry', filename: 'd.req', reason: 'not_regular' };
  return { schema_version: 1, id: approvalId(key), source_key: key, origin, proposer: { role: 'agent', slot: 'agent--2' },
    created_at: new Date(T0).toISOString(), expires_at: new Date(T1).toISOString(), executor: null, summary: null,
    payload_sha256: null, payload_bytes: null, qualification: null, disposition: 'denied', reason: 'not_regular', ignored_count: null } as ApprovalRecord;
}

let home: string;
let rec: ApprovalRecord;
let sdir: string;
beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'approval-state-')));
  rec = pendingRecord();
  publishRecord(home, rec, PAYLOAD);
  sdir = recordPaths(home, rec.id).state;
});
afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

const stateJson = (n: number, a: Actor = A, now = NOW): ApprovalState => ({ schema_version: 1, n, previous: n - 1,
  updated_at: new Date(now).toISOString(), actor: a, status: 'executing', owner: ownerOf(a), timeout_sec: 30,
  viewed_bytes: PAYLOAD.length, viewed_sha256: sha(PAYLOAD), command_sha256: 'c'.repeat(64) });
const writeRaw = (name: string, text: string) => { fs.mkdirSync(sdir, { recursive: true }); fs.writeFileSync(path.join(sdir, name), text, { flag: 'wx' }); };
const writeState = (n: number, a: Actor = A) => writeRaw(`${n}.json`, JSON.stringify(stateJson(n, a)));
const codeOf = (fn: () => unknown) => { try { fn(); } catch (e) { return e instanceof ApprovalError ? e.code : `other:${String(e)}`; } return 'none'; };
const files = () => (fs.existsSync(sdir) ? fs.readdirSync(sdir).sort() : []);
const proof = (a: Actor, over: Partial<ApprovalProof> = {}): ApprovalProof => ({ origin_ok: true, premises_ok: true,
  executor_registered: true, allowed: true, interactive_tty: true, prefix_confirmed: true, completely_viewed: true,
  viewed_bytes: PAYLOAD.length, viewed_sha256: sha(PAYLOAD), observed_payload_sha256: sha(PAYLOAD), owner: ownerOf(a),
  timeout_sec: 30, command_sha256: 'c'.repeat(64), ...over });

/** The only trusted spawn rule (spec): committed + executing + owner is this process. */
const spawnSpy = () => { const calls: string[] = []; return { calls, consider(r: TransitionResult, me: Actor) {
  if (r.kind === 'committed' && r.current.state?.status === 'executing' && r.current.state.owner.pid === me.pid) calls.push('spawn'); } }; };

/** Full approve callback per the plan: fresh now/proof/probe from the latest state on every call. */
function approver(me: Actor, liveness: { alive: boolean; reason: never } | typeof alive | typeof dead, log: { n: number; now: number }[] = []) {
  let now = NOW;
  return { log, decide: (latest: Current) => {
    now += 1000; log.push({ n: latest.n, now });
    const status = latest.state?.status ?? latest.record.disposition;
    const event: TransitionEvent = status === 'executing' ? { type: 'approve', proof: null, creator: liveness }
      : status === 'pending' ? { type: 'approve', proof: proof(me), creator: null } : { type: 'approve', proof: null, creator: null };
    return { event, context: { now_ms: now, actor: me } };
  } };
}

/** Wrap the real fs; `onLink(target)` runs right before the first link into state/ (forced pre-link EEXIST). */
function hookedIo(onLink: (target: string, count: number) => void, extra: Partial<ApprovalIo> = {}): ApprovalIo {
  let count = 0;
  return { ...fs, linkSync(a: fs.PathLike, b: fs.PathLike) {
    if (String(b).startsWith(sdir)) onLink(String(b), ++count);
    return fs.linkSync(a, b);
  }, ...extra } as ApprovalIo;
}

describe('readCurrent', () => {
  it('no state dir / empty dir -> n=0 pending', () => {
    expect(readCurrent(home, rec.id)).toMatchObject({ n: 0, state: null });
    fs.mkdirSync(sdir, { recursive: true });
    expect(readCurrent(home, rec.id)).toMatchObject({ n: 0, state: null });
  });
  it('denied record has no state, even if a stray file exists', () => {
    const d = deniedRecord();
    publishRecord(home, d, null);
    const dd = recordPaths(home, d.id).state;
    fs.mkdirSync(dd, { recursive: true }); fs.writeFileSync(path.join(dd, '1.json'), '{garbage');
    expect(readCurrent(home, d.id)).toMatchObject({ n: 0, state: null });
    expect(readCurrent(home, d.id).record.disposition).toBe('denied');
  });
  it('missing record.json is CORRUPT_RECORD with the path, not a synthetic pending', () => {
    const id = 'f'.repeat(24);
    expect(codeOf(() => readCurrent(home, id))).toBe('CORRUPT_RECORD');
    fs.mkdirSync(recordPaths(home, id).root, { recursive: true });
    expect(codeOf(() => readCurrent(home, id))).toBe('CORRUPT_RECORD');
  });
  it('orders numerically: 10 beats 2 (files 1..10)', () => {
    for (let n = 1; n <= 10; n++) writeState(n);
    expect(readCurrent(home, rec.id).n).toBe(10);
  });
  it('ignores temp and unrelated names', () => {
    writeState(1);
    writeRaw('.approval-1-x.tmp', 'junk'); writeRaw('notes.txt', 'x'); writeRaw('2.json.bak', 'x');
    expect(readCurrent(home, rec.id).n).toBe(1);
  });
  it.each([
    ['unparseable JSON', (n: number) => writeRaw(`${n}.json`, '{nope')],
    ['bad schema', (n: number) => writeRaw(`${n}.json`, JSON.stringify({ ...stateJson(n), status: 'weird' }))],
    ['unknown version', (n: number) => writeRaw(`${n}.json`, JSON.stringify({ ...stateJson(n), schema_version: 2 }))],
    ['n does not match name', (n: number) => writeRaw(`${n}.json`, JSON.stringify(stateJson(n + 5)))],
    ['empty file', (n: number) => writeRaw(`${n}.json`, '')],
    ['oversize file', (n: number) => writeRaw(`${n}.json`, ' '.repeat(1024 * 1024 + 1))],
    ['symlink', (n: number) => { fs.mkdirSync(sdir, { recursive: true }); fs.symlinkSync(path.join(sdir, '1.json'), path.join(sdir, `${n}.json`)); }],
    ['directory', (n: number) => { fs.mkdirSync(sdir, { recursive: true }); fs.mkdirSync(path.join(sdir, `${n}.json`)); }],
  ])('highest unreadable (%s) is fail-closed and never falls back to n-1', (_name, make) => {
    writeState(1); make(2);
    expect(codeOf(() => readCurrent(home, rec.id))).not.toBe('none');
  });
  it('the highest file with an unsupported version reports UNSUPPORTED_VERSION', () => {
    writeState(1); writeRaw('2.json', JSON.stringify({ ...stateJson(2), schema_version: 2 }));
    expect(codeOf(() => readCurrent(home, rec.id))).toBe('UNSUPPORTED_VERSION');
  });
  it('missing predecessor is fail-closed', () => {
    writeState(1); writeState(3);
    expect(codeOf(() => readCurrent(home, rec.id))).toBe('CORRUPT_STATE');
    expect(codeOf(() => { fs.rmSync(path.join(sdir, '1.json')); fs.rmSync(path.join(sdir, '3.json')); writeState(2); readCurrent(home, rec.id); })).toBe('CORRUPT_STATE');
  });
  it('corrupt predecessor is fail-closed', () => {
    writeRaw('1.json', '{x'); writeState(2);
    expect(codeOf(() => readCurrent(home, rec.id))).toBe('CORRUPT_STATE');
  });
  it.each(['01.json', '0.json', '007.json', '9007199254740992.json', '99999999999999999999.json'])('alias/overflow name %s is fail-closed', (name) => {
    writeState(1); writeRaw(name, JSON.stringify(stateJson(1)));
    expect(codeOf(() => readCurrent(home, rec.id))).toBe('CORRUPT_STATE');
  });
  it('a file that vanishes between readdir and read is retried once, then fail-closed', () => {
    writeState(1); writeState(2);
    let reads = 0;
    const io = { ...fs, readdirSync: ((d: fs.PathLike) => { reads++; return fs.readdirSync(d); }) as typeof fs.readdirSync,
      openSync: ((f: fs.PathLike, ...r: unknown[]) => {
        if (String(f).endsWith('2.json')) { const e = new Error('gone') as NodeJS.ErrnoException; e.code = 'ENOENT'; throw e; }
        return (fs.openSync as (...a: unknown[]) => number)(f, ...r);
      }) as typeof fs.openSync } as ApprovalIo;
    expect(codeOf(() => readCurrent(home, rec.id, io))).toBe('CORRUPT_STATE');
    expect(reads).toBe(2);
  });
});

describe('transition basics', () => {
  it('approve on pending commits state/1.json (executing), no temp left, exactly one state', () => {
    const spy = spawnSpy();
    const r = transition(home, rec.id, approver(A, alive).decide);
    spy.consider(r, A);
    expect(r.kind).toBe('committed');
    expect(r.current.state).toMatchObject({ status: 'executing', n: 1 });
    expect(files()).toEqual(['1.json']);
    expect(readCurrent(home, rec.id).state).toEqual(r.current.state);
    expect(spy.calls).toEqual(['spawn']);
  });
  it('refusals and no-ops write nothing and report unchanged', () => {
    const r = transition(home, rec.id, () => ({ event: { type: 'lazy', trigger: 'list_all', creator: null }, context: { now_ms: NOW, actor: A } }));
    expect(r).toMatchObject({ kind: 'unchanged', decision: { kind: 'noop' } });
    const r2 = transition(home, rec.id, () => ({ event: { type: 'approve', proof: null, creator: null }, context: { now_ms: T0 - 1, actor: A } }));
    expect(r2).toMatchObject({ kind: 'unchanged', decision: { kind: 'refuse', code: 'CLOCK_ROLLBACK' } });
    expect(files()).toEqual([]);
  });
  it('terminal states accept no further append', () => {
    transition(home, rec.id, () => ({ event: { type: 'reject', reason: null, interactive_tty: true, prefix_confirmed: true }, context: { now_ms: NOW, actor: A } }));
    const r = transition(home, rec.id, approver(B, alive).decide);
    expect(r).toMatchObject({ kind: 'unchanged', decision: { code: 'ALREADY_HANDLED' } });
    expect(files()).toEqual(['1.json']);
  });
  it('rejects a bad maxConflicts and propagates a throwing callback', () => {
    expect(codeOf(() => transition(home, rec.id, approver(A, alive).decide, {}, 0))).toBe('INVALID_INPUT');
    expect(() => transition(home, rec.id, () => { throw new Error('boom'); })).toThrow('boom');
    expect(files()).toEqual([]);
  });
});

describe('EEXIST re-read and re-decide', () => {
  it('callback is called again with the new n and a new now; the initial event is never reused', () => {
    const b = { done: false };
    const io = hookedIo(() => { if (!b.done) { b.done = true; writeState(1, B); } });
    const ap = approver(A, alive);
    const r = transition(home, rec.id, ap.decide, { io });
    expect(ap.log.map((l) => l.n)).toEqual([0, 1]);
    expect(ap.log[1]?.now).toBeGreaterThan(ap.log[0]?.now ?? Infinity);
    expect(r).toMatchObject({ kind: 'unchanged', decision: { kind: 'noop' } });
    expect(files()).toEqual(['1.json']);
  });
  it('approve vs another writer\'s executing: live creator -> noop, spawn spy 0 for the loser', () => {
    const spy = spawnSpy();
    const io = hookedIo((_t, c) => { if (c === 1) writeState(1, B); });
    const r = transition(home, rec.id, approver(A, alive).decide, { io });
    spy.consider(r, A);
    expect(r.kind).toBe('unchanged');
    expect(spy.calls).toEqual([]);
    expect(files()).toEqual(['1.json']);
  });
  it('approve vs executing, dead creator: loser appends unknown (committed), still no spawn', () => {
    const spy = spawnSpy();
    const io = hookedIo((_t, c) => { if (c === 1) writeState(1, B); });
    const r = transition(home, rec.id, approver(A, dead).decide, { io });
    spy.consider(r, A);
    expect(r.kind).toBe('committed');
    expect(r.current.state).toMatchObject({ status: 'unknown', reason: 'creator_dead', n: 2, previous: 1, actor: A });
    expect(spy.calls).toEqual([]);
    expect(files()).toEqual(['1.json', '2.json']);
  });
  it('recovery race: winner commits unknown, loser re-reads unknown and refuses; no third state; both spies 0', () => {
    const spy = spawnSpy();
    writeState(1, B); // dead executing
    const winnerIo = hookedIo((_t, c) => {
      if (c === 1) {
        const w = transition(home, rec.id, approver(B, dead).decide);
        spy.consider(w, B);
        expect(w).toMatchObject({ kind: 'committed', current: { state: { status: 'unknown' } } });
      }
    });
    const ap = approver(A, dead);
    const loser = transition(home, rec.id, ap.decide, { io: winnerIo });
    spy.consider(loser, A);
    expect(loser).toMatchObject({ kind: 'unchanged', decision: { kind: 'refuse', code: 'ALREADY_HANDLED' } });
    expect(ap.log.map((l) => l.n)).toEqual([1, 2]);
    expect(files()).toEqual(['1.json', '2.json']);
    expect(spy.calls).toEqual([]);
  });
  it('approve vs approve: winner spawns once, loser sees live executing and no-ops', () => {
    const spy = spawnSpy();
    const io = hookedIo((_t, c) => { if (c === 1) spy.consider(transition(home, rec.id, approver(B, alive).decide), B); });
    const r = transition(home, rec.id, approver(A, alive).decide, { io });
    spy.consider(r, A);
    expect(r.kind).toBe('unchanged');
    expect(spy.calls).toEqual(['spawn']);
    expect(files()).toEqual(['1.json']);
  });
  it('approve vs expiry: expiry wins first, approve re-reads expired and is refused', () => {
    const io = hookedIo((_t, c) => {
      if (c === 1) transition(home, rec.id, () => ({ event: { type: 'lazy', trigger: 'collect', creator: null }, context: { now_ms: T1 + 1, actor: B } }));
    });
    const r = transition(home, rec.id, approver(A, alive).decide, { io });
    expect(r).toMatchObject({ kind: 'unchanged', decision: { code: 'ALREADY_HANDLED' } });
    expect(readCurrent(home, rec.id).state?.status).toBe('expired');
  });
  it('approve at the expiry boundary vs expiry write: exactly one writer wins n=1', () => {
    const io = hookedIo((_t, c) => {
      if (c === 1) transition(home, rec.id, () => ({ event: { type: 'lazy', trigger: 'collect', creator: null }, context: { now_ms: T1 + 1, actor: B } }));
    });
    const ap = { decide: (): ReturnType<ReturnType<typeof approver>['decide']> => ({ event: { type: 'approve', proof: proof(A), creator: null }, context: { now_ms: T1, actor: A } }) };
    const r = transition(home, rec.id, ap.decide, { io });
    expect(r.kind).toBe('unchanged');
    expect(files()).toEqual(['1.json']);
  });
  it('bounded: maxConflicts lost races give an explicit contended result with the latest current', () => {
    let calls = 0;
    const io = hookedIo((t) => { writeRaw(path.basename(t), JSON.stringify(stateJson(Number.parseInt(path.basename(t), 10), B))); });
    const decide = (latest: Current) => { calls++; return latest.state === null
      ? { event: { type: 'lazy', trigger: 'collect', creator: null } as TransitionEvent, context: { now_ms: T1 + 1, actor: A } }
      : { event: { type: 'creator_dead', evidence: dead } as TransitionEvent, context: { now_ms: T1 + 1, actor: A } }; };
    const r = transition(home, rec.id, decide, { io }, 3);
    expect(r.kind).toBe('contended');
    expect(calls).toBe(3);
    expect(r.current.n).toBe(3);
  });
});

describe('write failures and crash points', () => {
  const executingFor = (a: Actor) => { writeState(1, a); };
  const exitEvent = (a: Actor) => () => ({ event: { type: 'executor_exit', result: { exit_code: 0, signal: null, failure: null,
    error_code: null, stdout: { text: 'ok', truncated: false }, stderr: { text: '', truncated: false } } } as TransitionEvent,
    context: { now_ms: NOW + 5000, actor: a } });
  it('executed cannot be written (link fails): throws IO_ERROR, state stays executing, no temp left', () => {
    executingFor(A);
    const io = hookedIo(() => { const e = new Error('disk') as NodeJS.ErrnoException; e.code = 'EIO'; throw e; });
    expect(codeOf(() => transition(home, rec.id, exitEvent(A), { io }))).toBe('IO_ERROR');
    expect(readCurrent(home, rec.id).state?.status).toBe('executing');
    expect(files()).toEqual(['1.json']);
  });
  it('executed temp write fails (ENOSPC): nothing committed, still executing', () => {
    executingFor(A);
    const io = { ...fs, writeSync: () => { const e = new Error('full') as NodeJS.ErrnoException; e.code = 'ENOSPC'; throw e; } } as unknown as ApprovalIo;
    expect(codeOf(() => transition(home, rec.id, exitEvent(A), { io }))).toBe('IO_ERROR');
    expect(readCurrent(home, rec.id).state?.status).toBe('executing');
    expect(files()).toEqual(['1.json']);
  });
  it('link succeeds, temp cleanup fails: committed once, diagnostic reported, leftover temp ignored', () => {
    const diags: string[] = [];
    const io = { ...fs, unlinkSync: (p: fs.PathLike) => { if (String(p).endsWith('.tmp')) { const e = new Error('x') as NodeJS.ErrnoException; e.code = 'EIO'; throw e; } fs.unlinkSync(p); } } as unknown as ApprovalIo;
    const r = transition(home, rec.id, approver(A, alive).decide, { io, diagnostic: (e) => diags.push(e.message) });
    expect(r.kind).toBe('committed');
    expect(diags).toHaveLength(1);
    expect(files().filter((f) => /^\d+\.json$/.test(f))).toEqual(['1.json']);
    expect(files().some((f) => f.endsWith('.tmp'))).toBe(true);
    expect(readCurrent(home, rec.id).n).toBe(1);
    // The leftover temp does not block later transitions.
    const r2 = transition(home, rec.id, approver(B, dead).decide);
    expect(r2.kind).toBe('committed');
    expect(readCurrent(home, rec.id).state?.status).toBe('unknown');
  });
  it.each(['temp_written', 'temp_synced'] as const)('crash at %s leaves the request unchanged (pending)', (point) => {
    expect(() => transition(home, rec.id, approver(A, alive).decide, { fault: (p) => { if (p === point) throw new Error('crash'); } })).toThrow('crash');
    expect(readCurrent(home, rec.id)).toMatchObject({ n: 0, state: null });
    expect(files().filter((f) => /^\d+\.json$/.test(f))).toEqual([]);
  });
  it.each(['linked', 'temp_removed'] as const)('crash at %s after the link: exactly one state is visible', (point) => {
    expect(() => transition(home, rec.id, approver(A, alive).decide, { fault: (p) => { if (p === point) throw new Error('crash'); } })).toThrow('crash');
    expect(readCurrent(home, rec.id)).toMatchObject({ n: 1, state: { status: 'executing' } });
    expect(files().filter((f) => /^\d+\.json$/.test(f))).toEqual(['1.json']);
  });
  it('unsupported hard links fail closed with UNSUPPORTED_LINK and never rename', () => {
    let renames = 0;
    const io = hookedIo(() => { const e = new Error('nolink') as NodeJS.ErrnoException; e.code = 'ENOTSUP'; throw e; },
      { renameSync: (() => { renames++; }) as unknown as typeof fs.renameSync });
    expect(codeOf(() => transition(home, rec.id, approver(A, alive).decide, { io }))).toBe('UNSUPPORTED_LINK');
    expect(renames).toBe(0);
    expect(readCurrent(home, rec.id).n).toBe(0);
  });
  it('corrupt latest state makes transition fail closed without appending', () => {
    writeState(1); writeRaw('2.json', '{bad');
    expect(codeOf(() => transition(home, rec.id, approver(A, dead).decide))).toBe('CORRUPT_STATE');
    expect(files()).toEqual(['1.json', '2.json']);
  });
});
