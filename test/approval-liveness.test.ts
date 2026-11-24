import { describe, expect, it } from 'vitest';
import { ApprovalError } from '../src/approval-error.js';
import { creatorLiveness, defaultCompare, type CreatorProbe } from '../src/approval-liveness.js';
import { lockHolderAlive } from '../src/project-lock.js';

const EXEC_AT = '2026-11-14T00:00:00.000Z';
const T0 = Date.parse(EXEC_AT);
const TIMEOUT = 30;
const THRESHOLD = T0 + (TIMEOUT + 60) * 1000;
const owner = { pid: 4242, pid_started: 'Sat Nov 14 00:00:00 2026' };

const probe = (over: Partial<CreatorProbe> = {}): CreatorProbe => ({
  signal0: () => 'exists',
  start: () => undefined,
  compare: () => 'unverifiable',
  ...over,
});
const run = (p: CreatorProbe, now = T0 + 1000, o = owner) => creatorLiveness(o, EXEC_AT, TIMEOUT, now, p);

describe('creatorLiveness', () => {
  it('dead pid is dead immediately', () => {
    expect(run(probe({ signal0: () => 'missing' }))).toEqual({ alive: false, reason: 'missing_pid' });
  });
  it('live pid with matching start is alive, even far past timeout', () => {
    const p = probe({ start: () => 'x', compare: () => 'match' });
    expect(run(p, THRESHOLD + 10 * 3600_000)).toEqual({ alive: true, reason: 'matching_start' });
  });
  it('comparable mismatch is dead immediately (inside grace)', () => {
    const p = probe({ start: () => 'x', compare: () => 'mismatch' });
    expect(run(p, T0)).toEqual({ alive: false, reason: 'start_mismatch' });
  });
  it('unverifiable start: alive at threshold-1, dead at threshold and after', () => {
    expect(run(probe(), THRESHOLD - 1)).toEqual({ alive: true, reason: 'unverifiable_grace' });
    expect(run(probe(), THRESHOLD)).toEqual({ alive: false, reason: 'unverifiable_elapsed' });
    expect(run(probe(), THRESHOLD + 1)).toEqual({ alive: false, reason: 'unverifiable_elapsed' });
  });
  it('incomparable start strings fall to grace', () => {
    const p = probe({ start: () => 'x', compare: () => 'unverifiable' });
    expect(run(p, THRESHOLD - 1).alive).toBe(true);
    expect(run(p, THRESHOLD).alive).toBe(false);
  });
  it('EPERM / unknown signal result is not death', () => {
    expect(run(probe({ signal0: () => 'unverifiable' }), THRESHOLD - 1).alive).toBe(true);
    expect(run(probe({ signal0: () => 'unverifiable' }), THRESHOLD).alive).toBe(false);
  });
  it('EPERM does not override a verified matching start', () => {
    const p = probe({ signal0: () => 'unverifiable', start: () => 'x', compare: () => 'match' });
    expect(run(p, THRESHOLD + 1)).toEqual({ alive: true, reason: 'matching_start' });
  });
  it('start reader throw is unverifiable, not dead', () => {
    const p = probe({ start: () => { throw new Error('ps failed'); } });
    expect(run(p, THRESHOLD - 1)).toEqual({ alive: true, reason: 'unverifiable_grace' });
    expect(run(p, THRESHOLD).alive).toBe(false);
  });
  it('signal0 or compare throw is unverifiable', () => {
    expect(run(probe({ signal0: () => { throw new Error('boom'); } }), THRESHOLD - 1).alive).toBe(true);
    const p = probe({ start: () => 'x', compare: () => { throw new Error('boom'); } });
    expect(run(p, THRESHOLD - 1).alive).toBe(true);
    expect(run(p, THRESHOLD).alive).toBe(false);
  });
  it('clock rollback stays in grace', () => {
    expect(run(probe(), T0 - 3600_000)).toEqual({ alive: true, reason: 'unverifiable_grace' });
  });
  it('invalid input throws INVALID_INPUT instead of living forever', () => {
    const bad = (fn: () => unknown) => {
      try { fn(); } catch (e) { expect(e).toBeInstanceOf(ApprovalError); expect((e as ApprovalError).code).toBe('INVALID_INPUT'); return; }
      throw new Error('did not throw');
    };
    bad(() => creatorLiveness(owner, EXEC_AT, TIMEOUT, Number.NaN, probe()));
    bad(() => creatorLiveness(owner, 'not a date', TIMEOUT, T0, probe()));
    bad(() => creatorLiveness(owner, EXEC_AT, 0, T0, probe()));
    bad(() => creatorLiveness(owner, EXEC_AT, Number.NaN, T0, probe()));
    bad(() => creatorLiveness(owner, EXEC_AT, Infinity, T0, probe()));
    bad(() => creatorLiveness({ pid: 0, pid_started: 'a' }, EXEC_AT, TIMEOUT, T0, probe()));
    bad(() => creatorLiveness({ pid: 1.5, pid_started: 'a' }, EXEC_AT, TIMEOUT, T0, probe()));
    bad(() => creatorLiveness({ pid: 5, pid_started: '' }, EXEC_AT, TIMEOUT, T0, probe()));
  });
  it('does not call the start reader when the pid is missing', () => {
    let called = false;
    run(probe({ signal0: () => 'missing', start: () => { called = true; return 'x'; } }));
    expect(called).toBe(false);
  });
});

describe('defaultCompare', () => {
  it('same string matches; locale variants of one instant match', () => {
    expect(defaultCompare('a', 'a')).toBe('match');
    expect(defaultCompare('Sat Nov 14 00:00:00 2026', 'Sat Nov 14 00:00:00 2026')).toBe('match');
  });
  it('two different proc ticks mismatch', () => {
    expect(defaultCompare('proc:100', 'proc:200')).toBe('mismatch');
  });
  it('different ps strings or mixed formats are unverifiable, never mismatch', () => {
    expect(defaultCompare('Sat Nov 14 00:00:00 2026', 'Sat Nov 14 00:00:05 2026')).toBe('unverifiable');
    expect(defaultCompare('proc:100', 'Sat Nov 14 00:00:00 2026')).toBe('unverifiable');
  });
});

describe('lockHolderAlive stays fail-open', () => {
  it('unverifiable start on a live pid is still alive (unchanged)', () => {
    const io = { platform: 'darwin' as const, readFile: () => undefined, ps: () => undefined, psUtc: () => undefined, signal0: () => true };
    expect(lockHolderAlive({ pid: 1, pid_started: 'Sat Nov 14 00:00:00 2026' }, io)).toBe(true);
  });
});
