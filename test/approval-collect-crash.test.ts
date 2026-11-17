import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type CollectDeps, type CollectInput, type CollectLog, collectSlot, prepareSlot } from '../src/approval-collect.js';
import { SCAN_WORK_BUDGET } from '../src/approval-budget.js';
import type { ExecutorConfig, ExecutorsConfig } from '../src/approval-executors.js';
import type { SnapshotInput } from '../src/approval-origin.js';
import { type SlotRef, requestPaths } from '../src/approval-paths.js';
import { readHighWater } from '../src/approval-high-water.js';
import { readCurrent, transition } from '../src/approval-state.js';
import { listCommittedIds, readRecord } from '../src/approval-store.js';
import type { ApprovalRecord, Origin } from '../src/approval-types.js';

const NOW = new Date('2026-11-17T00:00:00.000Z');
const sha = (b: string | Buffer): string => createHash('sha256').update(b).digest('hex');
const exec = (over: Partial<ExecutorConfig> = {}): ExecutorConfig =>
  ({ command: ['/bin/true'], allow: [], timeout_sec: 60, env: {}, expires_days: 7, max_pending: 100, max_payload_bytes: 4096, ...over });

let home: string;
let slot: SlotRef;
let logs: CollectLog[];
let tokens: number;
beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'approval-collect-crash-')));
  slot = { kind: 'run', project: 'proj', run_id: 'run.1', slot: 'worker' };
  logs = [];
  tokens = 0;
});
afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

const config: ExecutorsConfig = { executors: { 'exec-a': exec() }, limits: { max_total_pending: 100, max_scan_entries: 200, retention_days: 90 } };
const origin: Origin = { kind: 'run', project: 'proj', run_id: 'run.1', project_dir: '/proj', role: 'worker', full_writable: { dirs: ['/proj'], files: [] } };
const snap: SnapshotInput = { runtime_candidates: [{ runtime: 'claude-code', sandbox: null, allow_web: null }],
  writable: { dirs: ['/proj'], files: [] }, project_dir: '/proj', executor: config.executors['exec-a'] as ExecutorConfig };
const input = (over: Partial<CollectInput> = {}): CollectInput => ({ home, slot, agent: 'worker', runDir: path.join(home, 'run'), config, origin,
  inputs: new Map([['exec-a', snap]]), premises: [{ check: 'p1', ok: true, code: 'ok' }], ...over });
// A fresh deps object (new closures, new token counter) per call: re-entry never shares state with the crashed pass.
const freshDeps = (over: Partial<CollectDeps> = {}): CollectDeps => ({ io: fs, budget: SCAN_WORK_BUDGET, now: () => NOW,
  token: () => `t${tokens++}`, fault: () => undefined, log: (_e, f) => { logs.push(f); }, ...over });
const paths = () => requestPaths(home, slot);
const put = (name: string, body: string): void => {
  fs.mkdirSync(paths().proposals, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(paths().proposals, name), body);
};
const BODIES: Array<[string, string]> = [['a.req', 'executor: exec-a\n\nfirst'], ['b.req', 'executor: exec-a\n\nsecond'],
  ['c.req', 'executor: exec-a\n\nthird'], ['bad.req', 'no header']];
const records = (): ApprovalRecord[] => listCommittedIds(home).ids.map((id) => readRecord(home, id) as ApprovalRecord);
const crashOnce = (point: string): CollectDeps['fault'] => { let hit = false; return (p) => { if (p === point && !hit) { hit = true; throw new Error('simulated crash'); } }; };

/** What must be true once a slot's first batch is fully collected, however it got there. */
function expectCollectedOnce(): ApprovalRecord[] {
  const recs = records();
  expect(recs).toHaveLength(4); // 3 pending + 1 denied: no lost request, no extra record
  expect(new Set(recs.map((r) => r.id)).size).toBe(4); // no duplicate id
  expect(new Set(recs.map((r) => r.source_key.seq))).toEqual(new Set([1])); // all from seq 1
  for (const [name, body] of BODIES.slice(0, 3)) {
    const rec = recs.find((r) => (r.source_key as { filename?: string }).filename === name) as ApprovalRecord;
    expect(rec).toMatchObject({ disposition: 'pending', payload_sha256: sha(body.split('\n\n')[1] as string) });
    expect(fs.readFileSync(path.join(home, 'approvals', rec.id, 'payload'), 'utf8')).toBe(body.split('\n\n')[1]);
  }
  expect(recs.find((r) => (r.source_key as { filename?: string }).filename === 'bad.req')).toMatchObject({ disposition: 'denied', reason: 'bad_header' });
  expect(fs.existsSync(path.join(paths().collected, '1.done'))).toBe(true);
  expect(fs.readdirSync(paths().proposals)).toEqual([]);
  expect(readHighWater(paths().root, home)).toBe(1);
  expect(fs.existsSync(path.join(paths().root, '.coord'))).toBe(false);
  return recs;
}

const POINTS = ['rotation:renamed', 'rotation:recreated', 'collection:high-water', 'collection:enumerated', 'collection:before-done',
  'collection:done', 'payload_committed', 'record_committed'];

describe('collection crash points', () => {
  it.each(POINTS)('crash at %s then a fresh re-entry loses nothing', (point) => {
    for (const [n, b] of BODIES) put(n, b);
    const first = collectSlot(input(), freshDeps({ fault: crashOnce(point) }));
    expect(first.verdict).toMatchObject({ kind: 'skipped' }); // an unexpected throw never escapes collectSlot
    // A real crash would not release the lock. The operator-visible rule is: never stolen, never waited for.
    fs.mkdirSync(path.join(paths().root, '.coord'), { mode: 0o700 });
    const frozen = fs.readdirSync(paths().root).sort();
    const stuck = collectSlot(input(), freshDeps());
    expect(stuck.verdict).toEqual({ kind: 'skipped', code: 'DIR_ANOMALY' });
    expect(logs.at(-1)).toMatchObject({ op: 'coord', class: 'held' });
    expect(fs.readdirSync(paths().root).sort()).toEqual(frozen);
    fs.rmdirSync(path.join(paths().root, '.coord')); // the operator stops all runs and removes the stale lock

    // records that already exist must not move back to pending when the same source is replayed
    const early = records().find((r) => r.disposition === 'pending');
    if (early) {
      transition(home, early.id, () => ({ event: { type: 'lazy', trigger: 'collect', creator: null },
        context: { now_ms: NOW.getTime() + 8 * 86_400_000, actor: { user: 'u', tty: null, pid: 1, pid_started: null } } }));
    }
    const second = collectSlot(input(), freshDeps());
    expect(second.verdict).toEqual({ kind: 'wake' });
    const recs = expectCollectedOnce();
    if (early) {
      const cur = readCurrent(home, early.id);
      expect(cur.n).toBe(1);
      expect(cur.state?.status).toBe('expired'); // still expired, never reset to pending
    }
    // the sequence is never reused: new output gets seq 2 and leaves everything above untouched
    put('d.req', 'executor: exec-a\n\nfourth');
    expect(collectSlot(input(), freshDeps()).created).toBe(1);
    const all = records();
    expect(all).toHaveLength(5);
    expect(all.filter((r) => r.source_key.seq === 2)).toHaveLength(1);
    for (const old of recs) expect(all.find((r) => r.id === old.id)?.created_at).toBe(old.created_at);
    expect(readHighWater(paths().root, home)).toBe(2);
  });

  it('a crash that really leaves no lock behind is also safe to re-enter', () => {
    for (const [n, b] of BODIES) put(n, b);
    collectSlot(input(), freshDeps({ fault: crashOnce('collection:before-done') }));
    expect(fs.existsSync(path.join(paths().root, '.coord'))).toBe(false); // released by the failing pass itself
    expect(collectSlot(input(), freshDeps()).verdict).toEqual({ kind: 'wake' });
    expectCollectedOnce();
  });

  it('collection:budget: overflow at any fs call, then re-entry with a fresh budget completes', () => {
    let swept = 0;
    for (let budget = 20; budget <= 900; budget += 23) {
      fs.rmSync(path.join(home, 'requests'), { recursive: true, force: true });
      fs.rmSync(path.join(home, 'approvals'), { recursive: true, force: true });
      logs.length = 0;
      for (const [n, b] of BODIES) put(n, b);
      const cut = collectSlot(input(), freshDeps({ budget }));
      if (cut.verdict.kind === 'wake') break; // the budget was large enough: sweep finished
      swept += 1;
      expect(fs.existsSync(path.join(paths().root, '.coord'))).toBe(false);
      expect(logs.at(-1)).toMatchObject({ class: 'budget' });
      const ids = records().map((r) => r.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(collectSlot(input(), freshDeps()).verdict).toEqual({ kind: 'wake' });
      expectCollectedOnce();
    }
    expect(swept).toBeGreaterThan(10); // the sweep really cut passes in many different places
  });

  it('rotation:renamed while parking: a fresh re-entry rebuilds proposals and never meets ENOTEMPTY', () => {
    put('a.req', 'executor: exec-a\n\nfailed attempt output');
    const crashed = prepareSlot(input({ current: { attemptId: 'a1', outcome: 'park' } }), freshDeps({ fault: crashOnce('rotation:renamed') }));
    expect(crashed.verdict).toMatchObject({ kind: 'skipped' });
    expect(fs.existsSync(paths().proposals)).toBe(false); // crash window between rename and mkdir
    expect(fs.readFileSync(path.join(paths().parked, 'a1', 'a.req'), 'utf8')).toBe('executor: exec-a\n\nfailed attempt output');
    const again = prepareSlot(input({ current: { attemptId: 'a1', outcome: 'park' } }), freshDeps());
    expect(again).toMatchObject({ verdict: { kind: 'wake' }, proposals: paths().proposals });
    expect(fs.statSync(paths().proposals).mode & 0o777).toBe(0o700);
    expect(fs.readdirSync(paths().parked)).toEqual(['a1']);
    expect(records()).toEqual([]); // parked output is never collected
    expect(readHighWater(paths().root, home)).toBe(0);
  });

  it('rotation:recreated: the high-water catches up and the sequence is not reused', () => {
    put('a.req', 'executor: exec-a\n\none');
    collectSlot(input(), freshDeps({ fault: crashOnce('rotation:recreated') }));
    expect(readHighWater(paths().root, home)).toBe(0); // crashed before the high-water was advanced
    expect(fs.existsSync(path.join(paths().collected, '1'))).toBe(true);
    collectSlot(input(), freshDeps());
    expect(fs.existsSync(path.join(paths().collected, '1.done'))).toBe(true);
    put('b.req', 'executor: exec-a\n\ntwo');
    collectSlot(input(), freshDeps());
    expect(records().map((r) => r.source_key.seq).sort()).toEqual([1, 2]);
    expect(readHighWater(paths().root, home)).toBe(2);
  });
});
