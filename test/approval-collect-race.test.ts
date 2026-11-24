import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type CollectDeps, type CollectInput, type CollectLog, collectSlot, prepareSlot } from '../src/approval-collect.js';
import { type DirIo, SCAN_WORK_BUDGET } from '../src/approval-budget.js';
import type { ExecutorConfig, ExecutorsConfig } from '../src/approval-executors.js';
import type { SnapshotInput } from '../src/approval-origin.js';
import { type SlotRef, requestPaths } from '../src/approval-paths.js';
import { listCommittedIds, readRecord } from '../src/approval-store.js';
import type { ApprovalRecord, Origin } from '../src/approval-types.js';

const NOW = new Date('2026-11-17T00:00:00.000Z');
const exec = (): ExecutorConfig =>
  ({ command: ['/bin/true'], allow: [], timeout_sec: 60, env: {}, expires_days: 7, max_pending: 100, max_payload_bytes: 4096 });

let home: string;
let slot: SlotRef;
let logs: CollectLog[];
let tokens: number;
beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'approval-collect-race-')));
  slot = { kind: 'run', project: 'proj', run_id: 'run.1', slot: 'worker' };
  logs = [];
  tokens = 0;
});
afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

const config: ExecutorsConfig = { executors: { 'exec-a': exec() }, limits: { max_total_pending: 100, max_scan_entries: 200, retention_days: 90 } };
const originOf = (role: string): Origin => ({ kind: 'run', project: 'proj', run_id: 'run.1', project_dir: '/proj', role, full_writable: { dirs: ['/proj'], files: [] } });
const snap: SnapshotInput = { runtime_candidates: [{ runtime: 'claude-code', sandbox: null, allow_web: null }],
  writable: { dirs: ['/proj'], files: [] }, project_dir: '/proj', executor: config.executors['exec-a'] as ExecutorConfig };
const input = (ref: SlotRef = slot, agent = 'worker'): CollectInput => ({ home, slot: ref, agent, runDir: path.join(home, 'run'), config, origin: originOf(agent),
  inputs: new Map([['exec-a', snap]]), premises: [{ check: 'p1', ok: true, code: 'ok' }] });
const deps = (over: Partial<CollectDeps> = {}): CollectDeps => ({ actor: () => ({ user: 'test', tty: null, pid: 1, pid_started: null }),
  probe: { signal0: () => 'exists', start: () => 'start', compare: () => 'match' }, io: fs, budget: SCAN_WORK_BUDGET, now: () => NOW, token: () => `t${tokens++}`,
  fault: () => undefined, log: (_e, f) => { logs.push(f); }, ...over });
const paths = (ref: SlotRef = slot) => requestPaths(home, ref);
const put = (name: string, body: string, ref: SlotRef = slot): void => {
  fs.mkdirSync(paths(ref).proposals, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(paths(ref).proposals, name), body);
};
const records = (): ApprovalRecord[] => listCommittedIds(home).ids.map((id) => readRecord(home, id) as ApprovalRecord);
const CLASSES = new Set(['held', 'not_directory', 'symlink', 'missing', 'corrupt', 'unsupported', 'permission', 'race', 'mismatch', 'budget', 'cancelled', 'io']);
const OPS = new Set(['coord', 'high_water', 'link_probe', 'rotate', 'park', 'list', 'scan', 'read', 'publish', 'done', 'inventory', 'counter', 'pass']);
const FIELDS = new Set(['slot', 'op', 'class', 'seq', 'id', 'count']);

describe('collection races and hostile input', () => {
  it('two passes on one slot: exactly one enters the critical section, the other changes nothing', () => {
    put('a.req', 'executor: exec-a\n\nonly once');
    let inner: ReturnType<typeof collectSlot> | undefined;
    let during: string[] = [];
    const r = collectSlot(input(), deps({ fault: (p) => {
      if (p === 'collection:enumerated') {
        during = fs.readdirSync(paths().root).sort();
        inner = collectSlot(input(), deps()); // a second dispatcher/run reaches the same slot mid-pass
        expect(fs.readdirSync(paths().root).sort()).toEqual(during); // and left no trace
      }
    } }));
    expect(inner?.verdict).toEqual({ kind: 'skipped', code: 'DIR_ANOMALY' });
    expect(inner).toMatchObject({ created: 0, existing: 0, denied: 0 });
    expect(logs).toEqual([expect.objectContaining({ op: 'coord', class: 'held', slot: 'worker' })]);
    expect(r).toMatchObject({ created: 1, verdict: { kind: 'wake' } });
    expect(records()).toHaveLength(1);
    expect(during).toContain('.coord');
    expect(fs.existsSync(path.join(paths().root, '.coord'))).toBe(false);
    // once released, the lock is free again for the next pass
    expect(collectSlot(input(), deps()).verdict).toEqual({ kind: 'wake' });
  });

  it('a damaged slot suspends only that slot', () => {
    const healthy: SlotRef = { kind: 'run', project: 'proj', run_id: 'run.1', slot: 'healthy' };
    put('a.req', 'executor: exec-a\n\nx');
    put('b.req', 'executor: exec-a\n\ny', healthy);
    fs.writeFileSync(path.join(paths().root, 'collected.seq'), 'not a number');
    const bad = collectSlot(input(), deps());
    expect(bad.verdict).toEqual({ kind: 'skipped', code: 'DIR_ANOMALY' });
    expect(logs.at(-1)).toMatchObject({ op: 'high_water', class: 'corrupt' });
    expect(fs.readdirSync(paths().proposals)).toEqual(['a.req']); // nothing moved, even though a wake is also blocked
    const ok = collectSlot(input(healthy, 'healthy'), deps());
    expect(ok).toMatchObject({ created: 1, verdict: { kind: 'wake' } });
  });

  it('a candidate swapped for a FIFO after listing is denied without hanging', () => {
    for (const n of ['a.req', 'b.req']) put(n, `executor: exec-a\n\n${n}`);
    const r = collectSlot(input(), deps({ fault: (p) => {
      if (p !== 'collection:enumerated') return;
      const f = path.join(paths().collected, '1', 'b.req');
      fs.rmSync(f);
      execFileSync('mkfifo', [f]);
    } }));
    expect(r).toMatchObject({ created: 1, denied: 1, verdict: { kind: 'wake' } });
    expect(records().find((x) => x.disposition === 'denied')).toMatchObject({ reason: 'not_regular', source_key: { variant: 'denied_entry', filename: 'b.req' } });
  }, 10_000);

  it('a non-canonical or overflowing sequence name is a corrupt slot, not a guess', () => {
    put('a.req', 'executor: exec-a\n\nx');
    fs.mkdirSync(path.join(paths().collected, '01'), { recursive: true });
    const r = collectSlot(input(), deps());
    expect(r.verdict).toEqual({ kind: 'skipped', code: 'DIR_ANOMALY' });
    expect(logs.at(-1)).toMatchObject({ op: 'list', class: 'corrupt' });
    expect(fs.readdirSync(paths().proposals)).toEqual(['a.req']);
    expect(records()).toEqual([]);
  });

  it('a filesystem without hard links fails closed before any record or .done is written', () => {
    put('a.req', 'executor: exec-a\n\nx');
    const noLinks = { ...fs, linkSync: () => { throw Object.assign(new Error('EXDEV: cross-device link not permitted'), { code: 'EXDEV' }); } } as unknown as DirIo;
    const r = collectSlot(input(), deps({ io: noLinks }));
    expect(r).toMatchObject({ created: 0, verdict: { kind: 'skipped', code: 'DIR_ANOMALY' } });
    expect(logs).toEqual([expect.objectContaining({ op: 'link_probe', class: 'unsupported' })]);
    expect(records()).toEqual([]);
    expect(fs.existsSync(path.join(paths().collected, '1.done'))).toBe(false);
    expect(fs.readdirSync(path.join(paths().collected, '1'))).toEqual(['a.req']); // the request waits where it is
    expect(collectSlot(input(), deps()).created).toBe(1); // a filesystem with links finishes it
  });

  it('any unexpected throw becomes skipped UNDETERMINABLE and never escapes', () => {
    put('a.req', 'executor: exec-a\n\nx');
    const secret = `${home}/secret-path TOKEN=abc`;
    const bomb = { ...fs, mkdirSync: (p: fs.PathLike, ...rest: unknown[]) => {
      if (String(p).endsWith('approvals')) throw new TypeError(secret);
      return (fs.mkdirSync as (...a: unknown[]) => unknown)(p, ...rest);
    } } as unknown as DirIo;
    let r: ReturnType<typeof collectSlot> | undefined;
    expect(() => { r = collectSlot(input(), deps({ io: bomb })); }).not.toThrow();
    expect(r?.verdict).toEqual({ kind: 'skipped', code: 'UNDETERMINABLE' });
    expect(fs.existsSync(path.join(paths().root, '.coord'))).toBe(false);
    expect(() => prepareSlot(input(), deps({ io: bomb }))).not.toThrow();
    const text = JSON.stringify(logs);
    expect(text).not.toContain('secret');
    expect(text).not.toContain('TOKEN');
    expect(text).not.toContain(home);
    // a throwing logger cannot change or escape the verdict either
    const loud = collectSlot(input(), deps({ io: bomb, log: () => { throw new Error('log sink down'); } }));
    expect(loud.verdict).toEqual({ kind: 'skipped', code: 'UNDETERMINABLE' });
  });

  it('log lines carry only fixed fields and classes, never agent-controlled names, paths or error text', () => {
    // hostile names that are valid request names, plus every failure kind in one go
    put('..secret-token..req', 'executor: exec-a\n\nx');
    put('A_b-c.d.req', 'executor: exec-a\n\ny');
    fs.mkdirSync(path.join(paths().collected, '99'), { recursive: true });
    fs.writeFileSync(path.join(paths().collected, '99', 'planted.req'), 'executor: exec-a\n\nz');
    const key = collectSlot(input(), deps({ budget: 40 })); // budget class
    expect(key.verdict.kind).toBe('skipped');
    fs.writeFileSync(path.join(paths().root, 'collected.seq'), 'oops');
    collectSlot(input(), deps()); // corrupt class
    fs.rmSync(path.join(paths().root, 'collected.seq'));
    fs.mkdirSync(path.join(paths().root, '.coord'));
    collectSlot(input(), deps()); // held class
    expect(logs.length).toBeGreaterThanOrEqual(3);
    for (const entry of logs) {
      expect([...Object.keys(entry)].every((k) => FIELDS.has(k))).toBe(true);
      expect(CLASSES.has(entry.class)).toBe(true);
      expect(OPS.has(entry.op)).toBe(true);
      expect(entry.slot).toBe('worker');
      if (entry.id !== undefined) expect(entry.id).toMatch(/^[0-9a-f]{24}$/);
      for (const n of ['seq', 'count'] as const) if (entry[n] !== undefined) expect(Number.isSafeInteger(entry[n])).toBe(true);
    }
    const text = JSON.stringify(logs);
    for (const leak of [home, 'secret-token', 'planted', 'A_b-c', 'EACCES', 'ENOENT', 'Error']) expect(text).not.toContain(leak);
  });
});
