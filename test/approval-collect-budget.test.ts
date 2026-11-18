import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type CollectDeps, type CollectInput, type CollectLog, collectSlot } from '../src/approval-collect.js';
import { type DirIo, SCAN_WORK_BUDGET, budgetedIo, scanBudget } from '../src/approval-budget.js';
import type { ExecutorConfig, ExecutorsConfig } from '../src/approval-executors.js';
import { approvalId } from '../src/approval-id.js';
import type { SnapshotInput } from '../src/approval-origin.js';
import { type SlotRef, requestPaths } from '../src/approval-paths.js';
import { readCurrent } from '../src/approval-state.js';
import { listCommittedIds, publishRecord, readRecord } from '../src/approval-store.js';
import type { ApprovalRecord, Origin, SourceKey } from '../src/approval-types.js';

const NOW = new Date('2026-11-17T00:00:00.000Z');
const sha = (b: string | Buffer): string => createHash('sha256').update(b).digest('hex');
const exec = (over: Partial<ExecutorConfig> = {}): ExecutorConfig =>
  ({ command: ['/bin/true'], allow: [], timeout_sec: 60, env: {}, expires_days: 7, max_pending: 100000, max_payload_bytes: 4096, ...over });

let home: string;
let slot: SlotRef;
let logs: CollectLog[];
let tokens: number;
beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'approval-budget-collect-')));
  slot = { kind: 'run', project: 'proj', run_id: 'run.1', slot: 'worker' };
  logs = [];
  tokens = 0;
});
afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

const cfg = (limits: Partial<ExecutorsConfig['limits']> = {}): ExecutorsConfig =>
  ({ executors: { 'exec-a': exec() }, limits: { max_total_pending: 1000000, max_scan_entries: 200, retention_days: 90, ...limits } });
const origin: Origin = { kind: 'run', project: 'proj', run_id: 'run.1', project_dir: '/proj', role: 'worker', full_writable: { dirs: ['/proj'], files: [] } };
function inputFor(config: ExecutorsConfig): CollectInput {
  const snap: SnapshotInput = { runtime_candidates: [{ runtime: 'claude-code', sandbox: null, allow_web: null }],
    writable: { dirs: ['/proj'], files: [] }, project_dir: '/proj', executor: config.executors['exec-a'] as ExecutorConfig };
  return { home, slot, agent: 'worker', runDir: path.join(home, 'run'), config, origin, inputs: new Map([['exec-a', snap]]),
    premises: [{ check: 'p1', ok: true, code: 'ok' }] };
}
function depsFor(over: Partial<CollectDeps> = {}): CollectDeps {
  return { actor: () => ({ user: 'test', tty: null, pid: 1, pid_started: null }),
  probe: { signal0: () => 'exists', start: () => 'start', compare: () => 'match' }, io: fs, budget: SCAN_WORK_BUDGET, now: () => NOW, token: () => `t${tokens++}`, fault: () => undefined,
    log: (_e, f) => { logs.push(f); }, ...over };
}
const paths = () => requestPaths(home, slot);
function putMany(dir: string, count: number, body: (i: number) => string = (i) => `executor: exec-a\n\npayload ${i}`): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (let i = 0; i < count; i++) fs.writeFileSync(path.join(dir, `f${String(i).padStart(6, '0')}.req`), body(i));
}
const done = (n: number): string => path.join(paths().collected, `${n}.done`);
const records = (): ApprovalRecord[] => listCommittedIds(home).ids.map((id) => readRecord(home, id) as ApprovalRecord);

/** Counts what a budget would charge for the calls it sees: one per fs call and one per directory entry. */
function countingIo(): { io: DirIo; used: () => number; lstats: string[] } {
  let used = 0;
  const lstats: string[] = [];
  const io = { ...fs } as unknown as Record<string, unknown>;
  for (const name of ['mkdirSync', 'openSync', 'fstatSync', 'readSync', 'writeSync', 'fsyncSync', 'linkSync', 'unlinkSync', 'renameSync', 'rmdirSync', 'closeSync']) {
    const fn = (fs as unknown as Record<string, (...a: unknown[]) => unknown>)[name] as (...a: unknown[]) => unknown;
    io[name] = (...a: unknown[]) => { used += 1; return fn(...a); };
  }
  io.lstatSync = (p: string, ...r: unknown[]) => { used += 1; lstats.push(String(p)); return (fs.lstatSync as (...a: unknown[]) => unknown)(p, ...r); };
  io.opendirSync = (p: string, ...r: unknown[]) => {
    used += 1;
    const d = (fs.opendirSync as (...a: unknown[]) => fs.Dir)(p, ...r);
    return { path: d.path, readSync: () => { const e = d.readSync(); if (e !== null) used += 1; return e; }, closeSync: () => d.closeSync() };
  };
  return { io: io as unknown as DirIo, used: () => used, lstats };
}

function tree(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of fs.readdirSync(dir).sort()) {
      const f = path.join(dir, name);
      const st = fs.lstatSync(f);
      out.push(`${path.relative(root, f)}|${st.isDirectory() ? 'd' : 'f'}|${st.ino}|${st.isFile() ? sha(fs.readFileSync(f)) : ''}`);
      if (st.isDirectory()) walk(f);
    }
  };
  if (fs.existsSync(root)) walk(root);
  return out;
}

describe('scan work budget in collection', () => {
  it('20000 valid entries within default budget', () => {
    putMany(paths().proposals, 20000);
    const counting = countingIo();
    const r = collectSlot(inputFor(cfg()), depsFor({ io: counting.io }));
    expect(r).toMatchObject({ created: 200, denied: 1, verdict: { kind: 'wake' } });
    const recs = records();
    const scan = recs.find((x) => x.disposition === 'denied') as ApprovalRecord;
    expect(scan).toMatchObject({ reason: 'scan_limit', ignored_count: 19800, source_key: { variant: 'denied_scan' } });
    expect(recs).toHaveLength(201);
    expect(fs.existsSync(done(1))).toBe(true);
    const charged = counting.used() + 200 * 5; // these ordinary files each use open, fstat, data read, EOF read and close; short reads are covered separately
    console.log(`[budget] 20000 entries: ${charged} of ${SCAN_WORK_BUDGET} units`);
    expect(charged).toBeGreaterThan(40000); // 20000 dirents + 20000 lstat
    expect(charged).toBeLessThan(SCAN_WORK_BUDGET);
    expect(logs).toEqual([]);
  }, 120_000);

  it('beyond budget leaves slot untouched', () => {
    putMany(path.join(paths().collected, '1'), 500); // an earlier, un-done directory
    const before = tree(paths().root);
    const r = collectSlot(inputFor(cfg()), depsFor({ budget: 250 }));
    expect(r).toMatchObject({ created: 0, denied: 0, verdict: { kind: 'skipped', code: 'RESIDUAL_OUTPUT' } });
    expect(logs).toEqual([expect.objectContaining({ slot: 'worker', op: 'scan', class: 'budget', seq: 1 })]);
    expect(tree(paths().root)).toEqual(before); // same names, same inodes, same bytes: not a .done, a scan_limit or a half-written record
    expect(fs.existsSync(done(1))).toBe(false);
    expect(fs.existsSync(path.join(paths().root, '.coord'))).toBe(false); // the lock is always released
    expect(records()).toEqual([]);
    // the next pass with enough budget finishes the same directory
    const again = collectSlot(inputFor(cfg()), depsFor());
    expect(again).toMatchObject({ created: 200, denied: 1, verdict: { kind: 'wake' } });
    expect(fs.existsSync(done(1))).toBe(true);
  });

  it('overflow during processing keeps published records and re-entry adopts them', () => {
    putMany(path.join(paths().collected, '1'), 40);
    const probe = countingIo();
    const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'approval-budget-scratch-')));
    const saved = home;
    home = scratch;
    slot = { ...slot };
    putMany(path.join(paths().collected, '1'), 40);
    collectSlot(inputFor(cfg()), depsFor({ io: probe.io }));
    home = saved;
    fs.rmSync(scratch, { recursive: true, force: true });
    const total = probe.used() + 40 * 5;

    const r = collectSlot(inputFor(cfg()), depsFor({ budget: Math.floor(total * 0.6) }));
    expect(r.verdict).toEqual({ kind: 'skipped', code: 'RESIDUAL_OUTPUT' });
    expect(logs).toEqual([expect.objectContaining({ class: 'budget', seq: 1 })]);
    const partial = records();
    expect(partial.length).toBeGreaterThan(0);
    expect(partial.length).toBeLessThan(40);
    expect(r.created).toBe(partial.length);
    expect(fs.existsSync(done(1))).toBe(false);

    const again = collectSlot(inputFor(cfg()), depsFor());
    expect(again).toMatchObject({ created: 40 - partial.length, existing: partial.length, verdict: { kind: 'wake' } });
    const all = records();
    expect(all).toHaveLength(40);
    expect(new Set(all.map((x) => x.id)).size).toBe(40);
    for (const rec of partial) expect(all.find((x) => x.id === rec.id)).toEqual(rec); // adopted byte for byte, not rewritten
    expect(fs.readdirSync(paths().collected).sort()).toEqual(['1', '1.done']); // no new sequence was used
    expect(fs.existsSync(done(1))).toBe(true);
  });

  it('inventory over budget refuses collection', () => {
    // fixed cost of reading one stored record through the budget (the quota inventory does exactly this per record)
    const seed = (n: number): void => {
      const key: SourceKey = { kind: 'run', source_id: 'old.run', slot: 'worker', seq: n, variant: 'payload', filename: `s${n}.req`, payload_sha256: sha(`p${n}`) };
      publishRecord(home, { schema_version: 1, id: approvalId(key), source_key: key, origin: { ...origin, run_id: 'old.run' }, proposer: { role: 'worker', slot: 'worker' },
        created_at: '2026-11-16T00:00:00.000Z', expires_at: '2026-11-30T00:00:00.000Z', executor: 'exec-a', summary: null, payload_sha256: sha(`p${n}`),
        payload_bytes: `p${n}`.length, qualification: { schema_version: 1, sha256: 'b'.repeat(64), premises: [] }, disposition: 'pending' }, Buffer.from(`p${n}`));
    };
    const unitsOf = (n: number): number => {
      const b = scanBudget(10_000_000);
      const io = budgetedIo(fs, b);
      for (const id of listCommittedIds(home).ids.slice(0, n)) readCurrent(home, id, io);
      return b.used;
    };
    for (let i = 1; i <= 6; i++) seed(i);
    const perRecord = unitsOf(2) - unitsOf(1);
    expect(unitsOf(6) - unitsOf(3)).toBe(3 * perRecord); // constant per record
    expect(perRecord).toBeGreaterThan(0);
    console.log(`[budget] inventory units per stored pending record (readCurrent, no state file): ${perRecord} (+1 directory entry)`);

    for (let i = 7; i <= 200; i++) seed(i);
    putMany(path.join(paths().collected, '1'), 1);
    const r = collectSlot(inputFor(cfg()), depsFor({ budget: 800 }));
    expect(r).toMatchObject({ created: 0, verdict: { kind: 'skipped', code: 'UNDETERMINABLE' } });
    expect(logs).toEqual([expect.objectContaining({ op: 'inventory', class: 'budget', seq: 1 })]);
    expect(records()).toHaveLength(200); // no new pending record, quota never guessed
    expect(fs.existsSync(done(1))).toBe(false);
    expect(fs.existsSync(path.join(paths().root, '.coord'))).toBe(false);
    const again = collectSlot(inputFor(cfg()), depsFor());
    expect(again).toMatchObject({ created: 1, verdict: { kind: 'wake' } });
  });

  it('mutation between enumeration and read', () => {
    const run = (mutate: (dir: string) => void): ReturnType<typeof collectSlot> => {
      putMany(path.join(paths().collected, '1'), 4, (i) => `executor: exec-a\n\npayload ${i}`);
      return collectSlot(inputFor(cfg()), depsFor({ fault: (p) => { if (p === 'collection:enumerated') mutate(path.join(paths().collected, '1')); } }));
    };
    // 1. a candidate disappears after it was listed
    const gone = run((dir) => fs.rmSync(path.join(dir, 'f000002.req')));
    expect(gone.verdict).toEqual({ kind: 'skipped', code: 'RESIDUAL_OUTPUT' });
    expect(logs.at(-1)).toMatchObject({ op: 'read', class: 'race', seq: 1 });
    expect(fs.existsSync(done(1))).toBe(false);
    expect(records().map((x) => (x.source_key as { filename: string }).filename).sort()).toEqual(['f000000.req', 'f000001.req']);
    // re-entry: the two published records are adopted, the survivor is added, then .done
    const again = collectSlot(inputFor(cfg()), depsFor());
    expect(again).toMatchObject({ created: 1, existing: 2, verdict: { kind: 'wake' } });
    expect(fs.existsSync(done(1))).toBe(true);
    // 2. a candidate is replaced by a new file (new inode) after it was listed
    fs.rmSync(paths().root, { recursive: true });
    logs.length = 0;
    const swapped = run((dir) => { fs.rmSync(path.join(dir, 'f000001.req')); fs.writeFileSync(path.join(dir, 'f000001.req'), 'executor: exec-a\n\nreplacement'); });
    expect(swapped.verdict).toEqual({ kind: 'skipped', code: 'RESIDUAL_OUTPUT' });
    expect(logs.at(-1)).toMatchObject({ op: 'read', class: 'race' });
    expect(fs.existsSync(done(1))).toBe(false);
    expect(records().some((x) => (x.source_key as { payload_sha256?: string }).payload_sha256 === sha('replacement'))).toBe(false);
    // 3. a candidate becomes a symlink: proven at open (ELOOP), so it is a not_regular denial, not a retry
    fs.rmSync(paths().root, { recursive: true });
    fs.rmSync(path.join(home, 'approvals'), { recursive: true, force: true });
    logs.length = 0;
    const link = run((dir) => { fs.rmSync(path.join(dir, 'f000003.req')); fs.symlinkSync('/etc/hosts', path.join(dir, 'f000003.req')); });
    expect(link).toMatchObject({ created: 3, denied: 1, verdict: { kind: 'wake' } });
    expect(records().find((x) => x.disposition === 'denied')).toMatchObject({ reason: 'not_regular', source_key: { variant: 'denied_entry', filename: 'f000003.req' } });
    expect(fs.existsSync(done(1))).toBe(true);
    // 4. the collected directory itself is swapped for a symlink before it is read
    fs.rmSync(paths().root, { recursive: true });
    fs.rmSync(path.join(home, 'approvals'), { recursive: true, force: true });
    logs.length = 0;
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'approval-outside-'));
    fs.mkdirSync(paths().proposals, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(paths().proposals, 'a.req'), 'executor: exec-a\n\nx');
    fs.writeFileSync(path.join(outside, 'evil.req'), 'executor: exec-a\n\nevil');
    const swappedDir = collectSlot(inputFor(cfg()), depsFor({ fault: (p) => {
      if (p === 'collection:high-water') { fs.renameSync(path.join(paths().collected, '1'), path.join(outside, 'moved')); fs.symlinkSync(outside, path.join(paths().collected, '1')); }
    } }));
    expect(swappedDir.verdict).toEqual({ kind: 'skipped', code: 'DIR_ANOMALY' });
    expect(logs.at(-1)).toMatchObject({ class: 'not_directory', seq: 1 });
    expect(records()).toEqual([]); // nothing was read through the link
    expect(fs.existsSync(done(1))).toBe(false);
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it('invalid names cost one unit and are never stat\'ed', () => {
    const runWith = (invalid: number): { used: number; lstats: string[] } => {
      fs.rmSync(path.join(home, 'requests'), { recursive: true, force: true });
      fs.rmSync(path.join(home, 'approvals'), { recursive: true, force: true });
      putMany(path.join(paths().collected, '1'), 3);
      for (let i = 0; i < invalid; i++) {
        const kind = i % 4;
        const name = kind === 0 ? `x${i}.txt` : kind === 1 ? `.h${i}.req` : kind === 2 ? `bad name ${i}.req` : `${'a'.repeat(70)}${i}.req`;
        fs.writeFileSync(path.join(paths().collected, '1', name), 'x');
      }
      const c = countingIo();
      expect(collectSlot(inputFor(cfg()), depsFor({ io: c.io })).verdict).toEqual({ kind: 'wake' });
      return { used: c.used(), lstats: c.lstats };
    };
    const none = runWith(0);
    const many = runWith(1000);
    expect(many.used - none.used).toBe(1000); // exactly one unit per invalid name: its dirent
    const statted = many.lstats.filter((f) => /x\d+\.txt|\.h\d+\.req|bad name|a{70}/.test(path.basename(f)));
    expect(statted).toEqual([]);
    expect(records()).toHaveLength(3); // invalid names are not records and not part of scan_limit
    expect(records().some((x) => x.source_key.variant === 'denied_scan')).toBe(false);
  });
});
