import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { latestSlotAttempt } from '../src/message-store.js';

vi.setConfig({ testTimeout: 15_000 });
let runDir: string;
beforeEach(() => { runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'latest-attempt-')); });
afterEach(() => fs.rmSync(runDir, { recursive: true, force: true }));

const attDir = () => path.join(runDir, 'mail', 'attempts');
const claimDir = () => path.join(runDir, 'mail', 'claims');
let seq = 0;
/** Writes claim + attempt; returns the attempt file path. */
function put(agent: string, n: number, started: string, opts: { claim?: string; attempt?: string; stamp?: string; skipClaim?: boolean } = {}): string {
  const claimId = `${(1000 + ++seq).toString(36)}-${agent}-${String(seq).padStart(6, '0').replace(/\d/g, 'a')}`;
  const id = `${claimId}-a${n}`;
  fs.mkdirSync(attDir(), { recursive: true });
  fs.mkdirSync(claimDir(), { recursive: true });
  if (!opts.skipClaim) fs.writeFileSync(path.join(claimDir(), `${claimId}.json`), JSON.stringify({ id: claimId, agent, message_ids: [], files: [], status: opts.claim ?? 'output_ready', created: started }));
  const f = path.join(attDir(), `${id}.json`);
  fs.writeFileSync(f, JSON.stringify({ id, claim_id: claimId, agent, n, status: opts.attempt ?? 'output_ready', started_at: opts.stamp ?? started }));
  return f;
}
const T = '2026-11-16T10:00:00.000Z';

describe('latestSlotAttempt', () => {
  it('none when there is no attempts dir or no attempt of this slot', () => {
    expect(latestSlotAttempt(runDir, 'dev', 50)).toEqual({ kind: 'none' });
    put('other', 1, T);
    expect(latestSlotAttempt(runDir, 'dev', 50)).toEqual({ kind: 'none' });
  });
  it('orders a2 before a10 numerically when started_at is equal', () => {
    put('dev', 2, T, { claim: 'abandoned' });
    put('dev', 10, T, { claim: 'committed' });
    const r = latestSlotAttempt(runDir, 'dev', 50);
    expect(r.kind === 'found' && r.attempt.n).toBe(10);
    expect(r.kind === 'found' && r.claim).toBe('committed');
  });
  it('orders by started_at across claims, not by n or file name', () => {
    put('dev', 9, '2026-11-16T09:00:00.000Z');
    put('dev', 1, '2026-11-16T11:00:00.000Z', { claim: 'abandoned' });
    const r = latestSlotAttempt(runDir, 'dev', 50);
    expect(r.kind === 'found' && r.attempt.n).toBe(1);
    expect(r.kind === 'found' && r.claim).toBe('abandoned');
  });
  it('compares started_at as dates, not strings (different offsets)', () => {
    put('dev', 1, '2026-11-16T12:00:00.000+05:00');
    put('dev', 2, '2026-11-16T08:00:00.000Z', { claim: 'committed' });
    const r = latestSlotAttempt(runDir, 'dev', 50);
    expect(r.kind === 'found' && r.attempt.n).toBe(2);
  });
  it('equal keys are undeterminable (tie)', () => {
    put('dev', 1, T);
    put('dev', 1, T);
    expect(latestSlotAttempt(runDir, 'dev', 50)).toEqual({ kind: 'undeterminable', why: 'tie' });
  });
  it('corrupt JSON of this slot is undeterminable; of another agent it is ignored', () => {
    put('dev', 1, T);
    const bad = put('dev', 2, T);
    fs.writeFileSync(bad, '{not json');
    expect(latestSlotAttempt(runDir, 'dev', 50)).toEqual({ kind: 'undeterminable', why: 'corrupt' });
    fs.rmSync(attDir(), { recursive: true });
    put('dev', 1, T);
    const other = put('qa', 2, T);
    fs.writeFileSync(other, '{not json');
    const r = latestSlotAttempt(runDir, 'dev', 50);
    expect(r.kind).toBe('found');
  });
  it('wrong field values of this slot are corrupt (agent, n, status, started_at, id)', () => {
    const cases: Record<string, (o: Record<string, unknown>) => void> = {
      agent: (o) => { o.agent = 'qa'; }, n: (o) => { o.n = 0; }, nfloat: (o) => { o.n = 1.5; }, status: (o) => { o.status = 'weird'; },
      stamp: (o) => { o.started_at = 'not a date'; }, id: (o) => { o.id = 'zzz'; },
    };
    for (const [name, mut] of Object.entries(cases)) {
      fs.rmSync(attDir(), { recursive: true, force: true });
      const f = put('dev', 1, T);
      const o = JSON.parse(fs.readFileSync(f, 'utf8'));
      mut(o);
      fs.writeFileSync(f, JSON.stringify(o));
      expect(latestSlotAttempt(runDir, 'dev', 50), name).toEqual({ kind: 'undeterminable', why: 'corrupt' });
    }
  });
  it('a FIFO or symlink attempt entry is undeterminable without blocking', () => {
    const f = put('dev', 1, T);
    fs.rmSync(f);
    execFileSync('mkfifo', [f]);
    expect(latestSlotAttempt(runDir, 'dev', 50)).toEqual({ kind: 'undeterminable', why: 'unsafe_entry' });
    fs.rmSync(f);
    const target = path.join(runDir, 'target.json');
    fs.writeFileSync(target, '{}');
    fs.symlinkSync(target, f);
    expect(latestSlotAttempt(runDir, 'dev', 50)).toEqual({ kind: 'undeterminable', why: 'unsafe_entry' });
  });
  it('a FIFO of another agent is not opened', () => {
    put('dev', 1, T);
    const o = put('qa', 1, T);
    fs.rmSync(o);
    execFileSync('mkfifo', [o]);
    expect(latestSlotAttempt(runDir, 'dev', 50).kind).toBe('found');
  });
  it('an attempt file over 64 KiB is undeterminable', () => {
    const f = put('dev', 1, T);
    fs.writeFileSync(f, JSON.stringify({ pad: 'x'.repeat(70_000) }));
    expect(latestSlotAttempt(runDir, 'dev', 50)).toEqual({ kind: 'undeterminable', why: 'corrupt' });
  });
  it('more entries than the scan cap is undeterminable', () => {
    for (let i = 1; i <= 5; i++) put('dev', i, `2026-11-16T10:00:0${i}.000Z`);
    expect(latestSlotAttempt(runDir, 'dev', 4)).toEqual({ kind: 'undeterminable', why: 'scan_limit' });
    expect(latestSlotAttempt(runDir, 'dev', 5).kind).toBe('found');
  });
  it('an unreadable claim is undeterminable: missing, corrupt, FIFO, oversize, wrong status, wrong agent', () => {
    const claimOf = (f: string) => path.join(claimDir(), `${JSON.parse(fs.readFileSync(f, 'utf8')).claim_id}.json`);
    const run = (prep: (c: string) => void) => {
      fs.rmSync(attDir(), { recursive: true, force: true });
      fs.rmSync(claimDir(), { recursive: true, force: true });
      const c = claimOf(put('dev', 1, T));
      prep(c);
      return latestSlotAttempt(runDir, 'dev', 50);
    };
    const und = { kind: 'undeterminable', why: 'claim' };
    expect(run((c) => fs.rmSync(c))).toEqual(und);
    expect(run((c) => fs.writeFileSync(c, 'nope'))).toEqual(und);
    expect(run((c) => { fs.rmSync(c); execFileSync('mkfifo', [c]); })).toEqual(und);
    expect(run((c) => fs.writeFileSync(c, JSON.stringify({ pad: 'x'.repeat(70_000) })))).toEqual(und);
    expect(run((c) => { const o = JSON.parse(fs.readFileSync(c, 'utf8')); o.status = 'x'; fs.writeFileSync(c, JSON.stringify(o)); })).toEqual(und);
    expect(run((c) => { const o = JSON.parse(fs.readFileSync(c, 'utf8')); o.agent = 'qa'; fs.writeFileSync(c, JSON.stringify(o)); })).toEqual(und);
  });
  it('a claim_id that is not a plain file name is undeterminable', () => {
    const f = put('dev', 1, T);
    const o = JSON.parse(fs.readFileSync(f, 'utf8'));
    o.claim_id = '../../x';
    fs.writeFileSync(f, JSON.stringify(o));
    expect(latestSlotAttempt(runDir, 'dev', 50).kind).toBe('undeterminable');
  });
  it('ignores sub-directories and non-json names in attempts/', () => {
    put('dev', 1, T);
    fs.mkdirSync(path.join(attDir(), 'some-id', 'log'), { recursive: true });
    fs.writeFileSync(path.join(attDir(), 'note.txt'), 'x');
    expect(latestSlotAttempt(runDir, 'dev', 50).kind).toBe('found');
  });
  it('an unreadable attempts dir is undeterminable (io)', () => {
    fs.mkdirSync(path.join(runDir, 'mail'), { recursive: true });
    fs.writeFileSync(attDir(), 'a file, not a directory');
    expect(latestSlotAttempt(runDir, 'dev', 50)).toEqual({ kind: 'undeterminable', why: 'io' });
  });
  it('slot names with hyphens and instance suffixes are matched exactly', () => {
    put('node-engineer', 1, T);
    put('node', 1, T);
    const r = latestSlotAttempt(runDir, 'node', 50);
    expect(r.kind === 'found' && r.attempt.agent).toBe('node');
    expect(latestSlotAttempt(runDir, 'engineer', 50)).toEqual({ kind: 'none' });
  });
});

describe('latestSlotAttempt: ordering under one claim and directory close failures', () => {
  it('a2 and a10 of ONE claim are ordered by numeric n, not by file name', () => {
    const claimId = '1abc-dev-aaaaaa';
    fs.mkdirSync(attDir(), { recursive: true });
    fs.mkdirSync(claimDir(), { recursive: true });
    fs.writeFileSync(path.join(claimDir(), `${claimId}.json`), JSON.stringify({ id: claimId, agent: 'dev', message_ids: [], files: [], status: 'committed', created: T }));
    for (const n of [10, 2]) fs.writeFileSync(path.join(attDir(), `${claimId}-a${n}.json`), JSON.stringify({ id: `${claimId}-a${n}`, claim_id: claimId, agent: 'dev', n, status: 'committed', started_at: T }));
    const r = latestSlotAttempt(runDir, 'dev', 50);
    expect(r.kind === 'found' && r.attempt.n).toBe(10);
  });
  const failingClose = () => {
    const real = fs.opendirSync.bind(fs);
    return vi.spyOn(fs, 'opendirSync').mockImplementation(((...a: Parameters<typeof fs.opendirSync>) => {
      const d = real(...a);
      return { readSync: () => d.readSync(), closeSync: () => { d.closeSync(); throw Object.assign(new Error('I/O'), { code: 'EIO' }); } };
    }) as never);
  };
  it('a close failure is undeterminable (io), never a result', () => {
    put('dev', 1, T);
    const spy = failingClose();
    try { expect(latestSlotAttempt(runDir, 'dev', 50)).toEqual({ kind: 'undeterminable', why: 'io' }); } finally { spy.mockRestore(); }
  });
  it('an earlier refusal is kept when close also fails (scan_limit)', () => {
    for (let i = 1; i <= 5; i++) put('dev', i, `2026-11-16T10:00:0${i}.000Z`);
    const spy = failingClose();
    try { expect(latestSlotAttempt(runDir, 'dev', 4)).toEqual({ kind: 'undeterminable', why: 'scan_limit' }); } finally { spy.mockRestore(); }
  });
});
