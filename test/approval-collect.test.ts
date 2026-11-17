import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type CollectDeps, type CollectInput, type CollectLog, collectSlot, prepareSlot } from '../src/approval-collect.js';
import { SCAN_WORK_BUDGET } from '../src/approval-budget.js';
import type { ExecutorConfig, ExecutorsConfig } from '../src/approval-executors.js';
import { approvalId } from '../src/approval-id.js';
import { type SnapshotInput, qualificationHash } from '../src/approval-origin.js';
import { type SlotRef, requestPaths } from '../src/approval-paths.js';
import { readCurrent } from '../src/approval-state.js';
import { listCommittedIds, publishRecord, readRecord } from '../src/approval-store.js';
import type { ApprovalRecord, Origin, SourceKey } from '../src/approval-types.js';

const NOW = new Date('2026-11-17T00:00:00.000Z');
const sha = (b: string | Buffer): string => createHash('sha256').update(b).digest('hex');
const exec = (over: Partial<ExecutorConfig> = {}): ExecutorConfig =>
  ({ command: ['/bin/true'], allow: [], timeout_sec: 60, env: {}, expires_days: 7, max_pending: 10, max_payload_bytes: 4096, ...over });

let home: string;
let slot: SlotRef;
let logs: CollectLog[];
let tokens: number;
beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'approval-collect-')));
  slot = { kind: 'run', project: 'proj', run_id: 'run.1', slot: 'worker' };
  logs = [];
  tokens = 0;
});
afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

function config(over: { executors?: Record<string, ExecutorConfig>; limits?: Partial<ExecutorsConfig['limits']> } = {}): ExecutorsConfig {
  return { executors: over.executors ?? { 'exec-a': exec(), 'exec-b': exec() },
    limits: { max_total_pending: 50, max_scan_entries: 200, retention_days: 90, ...over.limits } };
}
const origin: Origin = { kind: 'run', project: 'proj', run_id: 'run.1', project_dir: '/proj', role: 'worker', full_writable: { dirs: ['/proj'], files: [] } };
function inputFor(cfg: ExecutorsConfig, over: Partial<CollectInput> = {}): CollectInput {
  const snapshot = (name: string): SnapshotInput => ({ runtime_candidates: [{ runtime: 'claude-code', sandbox: null, allow_web: null }],
    writable: { dirs: ['/proj'], files: [] }, project_dir: '/proj', executor: cfg.executors[name] as ExecutorConfig });
  return { home, slot, agent: 'worker', runDir: path.join(home, 'run'), config: cfg, origin,
    inputs: new Map([['exec-a', snapshot('exec-a')]]), premises: [{ check: 'p1', ok: true, code: 'ok' }], ...over };
}
function depsFor(over: Partial<CollectDeps> = {}): CollectDeps {
  return { actor: () => ({ user: 'test', tty: null, pid: 1, pid_started: null }),
  probe: { signal0: () => 'exists', start: () => 'start', compare: () => 'match' }, io: fs, budget: SCAN_WORK_BUDGET, now: () => NOW, token: () => `t${tokens++}`, fault: () => undefined,
    log: (_e, f) => { logs.push(f); }, ...over };
}
const proposals = (ref: SlotRef = slot): string => requestPaths(home, ref).proposals;
function put(name: string, body: string | Buffer = 'executor: exec-a\n\npayload', ref: SlotRef = slot): string {
  fs.mkdirSync(proposals(ref), { recursive: true, mode: 0o700 });
  const f = path.join(proposals(ref), name);
  fs.writeFileSync(f, body);
  return f;
}
function records(): ApprovalRecord[] {
  return listCommittedIds(home).ids.map((id) => readRecord(home, id) as ApprovalRecord);
}
const byFile = (recs: ApprovalRecord[], filename: string): ApprovalRecord =>
  recs.find((r) => 'filename' in r.source_key && r.source_key.filename === filename) as ApprovalRecord;
const collected = (n: number): string => path.join(requestPaths(home, slot).collected, String(n));
const doneFile = (n: number): string => `${collected(n)}.done`;

describe('S2 revision regressions', () => {
  it('quota-denied re-entry must not create a second outcome', () => {
    const cfg = config({ limits: { max_total_pending: 1 } });
    put('a.req', 'executor: exec-a\n\na');
    put('b.req', 'executor: exec-a\n\nb');
    let hit = false;
    collectSlot(
      inputFor(cfg),
      depsFor({
        fault: (p) => {
          if (p === 'collection:before-done' && !hit) {
            hit = true;
            throw new Error('cut');
          }
        },
      }),
    );
    console.log(
      'QUOTA first',
      records().map((r) => [r.source_key, r.disposition]),
    );
    const result = collectSlot(inputFor(cfg), depsFor({ now: () => new Date('2026-12-01T00:00:00Z') }));
    console.log(
      'QUOTA replay',
      result,
      records().map((r) => [r.source_key, r.disposition]),
    );
    expect(records()).toHaveLength(2);
  });
  it('corrupt state must not silently release quota', () => {
    const cfg = config({ limits: { max_total_pending: 1 } });
    put('a.req');
    collectSlot(inputFor(cfg), depsFor());
    const rec = records()[0]!;
    const dir = path.join(home, 'approvals', rec.id, 'state');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, '1.json'), '{broken');
    put('b.req');
    const result = collectSlot(inputFor(cfg), depsFor());
    console.log('CORRUPT', result, 'logs', logs, 'records', records().length);
    expect(result.verdict).toEqual({ kind: 'skipped', code: 'UNDETERMINABLE' });
    expect(records()).toHaveLength(1);
    expect(logs).toEqual([expect.objectContaining({ op: 'inventory', class: 'corrupt' })]);
  });
  it('denied counter closes fd at every budget cutoff', () => {
    const leaks = [];
    for (let limit = 15; limit <= 400; limit++) {
      fs.rmSync(path.join(home, 'requests'), { recursive: true, force: true });
      fs.rmSync(path.join(home, 'approvals'), { recursive: true, force: true });
      put('a.req', 'bad header');
      const opened = new Map<number, string>();
      const io = {
        ...fs,
        openSync: (...args: Parameters<typeof fs.openSync>) => {
          const fd = fs.openSync(...args);
          opened.set(fd, String(args[0]));
          return fd;
        },
        closeSync: (fd: number) => {
          opened.delete(fd);
          return fs.closeSync(fd);
        },
      };
      collectSlot(inputFor(config()), depsFor({ budget: limit, io }));
      expect(collectSlot(inputFor(config()), depsFor()).verdict.kind).toBe('wake');
      if (opened.size) leaks.push({ limit, files: [...opened.values()].map((x) => path.relative(home, x)) });
      for (const fd of opened.keys()) fs.closeSync(fd);
    }
    console.log('LEAKS', JSON.stringify(leaks));
    expect(leaks).toEqual([]);
  }, 30_000);
  it('short request reads cannot bypass scan-work budget', () => {
    put('a.req', 'executor: exec-a\n\n' + 'x'.repeat(4096));
    const origOpen = fs.openSync,
      origRead = fs.readSync,
      origClose = fs.closeSync;
    const requestFds = new Set<number>();
    let calls = 0;
    fs.openSync = (...a: Parameters<typeof fs.openSync>) => {
      const fd = origOpen(...a);
      if (String(a[0]).endsWith('/a.req')) requestFds.add(fd);
      return fd;
    };
    fs.readSync = ((fd: number, b: Buffer, offset: number, length: number, position: number | null) => {
      if (requestFds.has(fd)) {
        calls++;
        return origRead(fd, b, offset, Math.min(1, length), position);
      }
      return origRead(fd, b, offset, length, position);
    }) as typeof fs.readSync;
    fs.closeSync = (fd: number) => {
      requestFds.delete(fd);
      return origClose(fd);
    };
    let result: ReturnType<typeof collectSlot> | undefined;
    try {
      result = collectSlot(inputFor(config()), depsFor({ budget: 300 }));
    } finally {
      fs.openSync = origOpen;
      fs.readSync = origRead;
      fs.closeSync = origClose;
    }
    console.log('SHORT_READS', calls, 'budget', 300, result, logs);
    expect(calls).toBeLessThanOrEqual(300);
    expect(result?.verdict.kind).toBe('skipped');
    expect(records()).toHaveLength(0);
    expect(fs.existsSync(doneFile(1))).toBe(false);
  });
  it('lazy expiry must be recorded by collection per spec4.5', () => {
    put('a.req');
    collectSlot(inputFor(config()), depsFor());
    const rec = records()[0]!;
    put('b.req');
    collectSlot(inputFor(config()), depsFor({ now: () => new Date('2026-12-01T00:00:00Z') }));
    const current = readCurrent(home, rec.id);
    console.log('LAZY', current.n, current.state);
    expect(current.state?.status).toBe('expired');
    put('c.req');
    collectSlot(inputFor(config()), depsFor({ now: () => new Date('2026-12-01T00:00:00Z') }));
    expect(readCurrent(home, rec.id).n).toBe(1);
  });
  it('large configured scan cap keeps sorting work subquadratic', () => {
    const count = 3000;
    for (let i = 0; i < count; i++) {
      const f = put('f' + String(i).padStart(5, '0') + '.req');
      fs.utimesSync(f, new Date(10000000 - i * 1000), new Date(10000000 - i * 1000));
    }
    let comparisons = 0;
    const io = {
      ...fs,
      lstatSync: ((...a: Parameters<typeof fs.lstatSync>) => {
        const st = fs.lstatSync(...a);
        if (String(a[0]).endsWith('.req')) {
          const m = st.mtimeMs;
          Object.defineProperty(st, 'mtimeMs', {
            get: () => {
              comparisons++;
              return m;
            },
          });
        }
        return st;
      }) as typeof fs.lstatSync,
    };
    const start = Date.now();
    collectSlot(
      inputFor(config({ limits: { max_scan_entries: count } })),
      depsFor({
        io,
        fault: (p) => {
          if (p === 'collection:enumerated') throw new Error('stop after selection');
        },
      }),
    );
    console.log('SORT', count, 'mtime accesses', comparisons, 'ms', Date.now() - start);
    expect(comparisons).toBeLessThan(count * 100);
  });
});

describe('inventory unreadable state', () => {
  it('reports unreadable committed state as fixed corrupt occupancy', () => {
    put('a.req'); collectSlot(inputFor(config()), depsFor());
    const rec=records()[0]!; const dir=path.join(home,'approvals',rec.id,'state'); fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir,'1.json'),'{}');
    const io={...fs,openSync:((...args:Parameters<typeof fs.openSync>)=>{
      if(String(args[0]).endsWith('/state/1.json'))throw Object.assign(new Error('secret path'),{code:'EACCES'});
      return fs.openSync(...args);
    })};
    put('b.req'); const result=collectSlot(inputFor(config()),depsFor({io}));
    expect(result.verdict).toEqual({kind:'skipped',code:'UNDETERMINABLE'});
    expect(logs).toEqual([expect.objectContaining({op:'inventory',class:'corrupt'})]); expect(records()).toHaveLength(1);
  });
});
describe('lazy collection state and replay races', () => {
  it('records creator-dead unknown once and keeps it occupying quota', () => {
    put('a.req');
    collectSlot(inputFor(config()), depsFor());
    const rec = records()[0]!;
    const actor = { user: 'u', tty: null, pid: 42, pid_started: 'start' };
    const dir = path.join(home, 'approvals', rec.id, 'state');
    fs.mkdirSync(dir);
    fs.writeFileSync(
      path.join(dir, '1.json'),
      JSON.stringify({
        schema_version: 1,
        n: 1,
        previous: 0,
        updated_at: NOW.toISOString(),
        actor,
        status: 'executing',
        owner: { pid: 42, pid_started: 'start' },
        timeout_sec: 60,
        viewed_bytes: rec.payload_bytes,
        viewed_sha256: rec.payload_sha256,
        command_sha256: sha('command'),
      }),
    );
    const dead = Object.assign(depsFor(), {
      actor: () => actor,
      probe: { signal0: () => 'missing' as const, start: () => undefined, compare: () => 'unverifiable' as const },
    });
    put('b.req');
    collectSlot(inputFor(config({ limits: { max_total_pending: 1 } })), dead);
    expect(readCurrent(home, rec.id)).toMatchObject({ n: 2, state: { status: 'unknown', reason: 'creator_dead' } });
    put('c.req');
    collectSlot(inputFor(config()), dead);
    expect(readCurrent(home, rec.id).n).toBe(2);
  });
  it('rereads a lazy state publication lost to another writer', () => {
    put('a.req');
    collectSlot(inputFor(config()), depsFor());
    const rec = records()[0]!;
    let raced = false;
    const io = {
      ...fs,
      linkSync: (from: fs.PathLike, to: fs.PathLike) => {
        if (String(to).endsWith('/state/1.json') && !raced) {
          raced = true;
          fs.linkSync(from, to);
        }
        fs.linkSync(from, to);
      },
    };
    put('b.req');
    collectSlot(inputFor(config()), depsFor({ io, now: () => new Date('2026-12-01T00:00:00Z') }));
    expect(raced).toBe(true);
    expect(readCurrent(home, rec.id)).toMatchObject({ n: 1, state: { status: 'expired' } });
  });
  it.each(['pending', 'denied'])('adopts committed %s before changed executor configuration', (disposition) => {
    put('a.req');
    const cfg = config();
    const first = inputFor(cfg, disposition === 'denied' ? { inputs: new Map() } : {});
    collectSlot(
      first,
      depsFor({
        fault: (p) => {
          if (p === 'collection:before-done') throw new Error('cut');
        },
      }),
    );
    const before = records();
    expect(before[0]?.disposition).toBe(disposition);
    collectSlot(inputFor(config({ executors: {} })), depsFor());
    expect(records()).toEqual(before);
    expect(fs.existsSync(doneFile(1))).toBe(true);
  });
});
describe('collectSlot', () => {
  it('outcome table all rows', () => {
    const cfg = config({ executors: { 'exec-a': exec(), 'exec-b': exec() } });
    put('ok.req', 'executor: exec-a\nsummary: hi\n\npayload text');
    put('ignored.txt'); put('.hidden.req'); put('x.req.tmp'); put('.x.req.tmp'); put('bad name.req'); put('noreq');
    fs.symlinkSync('/etc/hosts', path.join(proposals(), 'link.req'));
    execFileSync('mkfifo', [path.join(proposals(), 'fifo.req')]);
    fs.mkdirSync(path.join(proposals(), 'dir.req'));
    put('big.req', Buffer.alloc(67585, 0x61));
    put('badcontent.req', 'executor: exec-a\n\nesc \u001b[31m');
    put('badexec.req', 'executor: nope\n\nx');
    put('badhead.req', 'no header here');
    put('notallowed.req', 'executor: exec-b\n\nx');
    put('toolarge.req', `executor: exec-a\n\n${'x'.repeat(4097)}`);

    const r = collectSlot(inputFor(cfg), depsFor());
    expect(r).toEqual({ created: 1, existing: 0, denied: 9, verdict: { kind: 'wake' } });
    expect(logs).toEqual([]);
    expect(fs.existsSync(doneFile(1))).toBe(true);
    expect(fs.readdirSync(proposals())).toEqual([]);
    expect(fs.statSync(proposals()).mode & 0o777).toBe(0o700);
    const recs = records();
    expect(recs).toHaveLength(10); // ignored names make no record at all

    const key = (f: string): SourceKey => byFile(recs, f).source_key;
    const ok = byFile(recs, 'ok.req');
    expect(ok).toMatchObject({ disposition: 'pending', executor: 'exec-a', summary: 'hi', payload_bytes: 12, payload_sha256: sha('payload text'),
      proposer: { role: 'worker', slot: 'worker' }, created_at: NOW.toISOString(), expires_at: '2026-11-24T00:00:00.000Z' });
    expect((ok as { qualification: { sha256: string } }).qualification.sha256).toBe(qualificationHash(inputFor(cfg).inputs.get('exec-a') as SnapshotInput));
    expect(ok.source_key).toMatchObject({ variant: 'payload', kind: 'run', source_id: 'run.1', slot: 'worker', seq: 1, filename: 'ok.req', payload_sha256: sha('payload text') });
    expect(fs.readFileSync(path.join(home, 'approvals', ok.id, 'payload'), 'utf8')).toBe('payload text');

    for (const f of ['link.req', 'fifo.req', 'dir.req']) {
      expect(key(f), f).toMatchObject({ variant: 'denied_entry', reason: 'not_regular' });
      expect(byFile(recs, f)).toMatchObject({ disposition: 'denied', reason: 'not_regular', ignored_count: null, executor: null, payload_sha256: null });
    }
    expect(key('big.req')).toMatchObject({ variant: 'denied_size', reason: 'too_large', size: 67585 });
    const bytes = (f: string, body: string | Buffer): void => {
      expect(key(f), f).toMatchObject({ variant: 'denied_bytes', request_sha256: sha(body) });
    };
    expect(key('badcontent.req')).toMatchObject({ reason: 'bad_content' }); bytes('badcontent.req', 'executor: exec-a\n\nesc \u001b[31m');
    expect(key('badexec.req')).toMatchObject({ reason: 'bad_executor' }); bytes('badexec.req', 'executor: nope\n\nx');
    expect(key('badhead.req')).toMatchObject({ reason: 'bad_header' }); bytes('badhead.req', 'no header here');
    expect(key('notallowed.req')).toMatchObject({ reason: 'not_allowed' }); bytes('notallowed.req', 'executor: exec-b\n\nx');
    expect(key('toolarge.req')).toMatchObject({ reason: 'too_large', variant: 'denied_bytes' });
    for (const f of ['badcontent.req', 'badexec.req', 'badhead.req', 'notallowed.req', 'toolarge.req']) {
      expect(byFile(recs, f)).toMatchObject({ disposition: 'denied', ignored_count: null });
      expect(fs.existsSync(path.join(home, 'approvals', byFile(recs, f).id, 'payload'))).toBe(false); // denied: no payload copy
    }
    // quota and scan_limit rows live in their own tests below; denied records never get a state file
    for (const rec of recs.filter((x) => x.disposition === 'denied')) expect(fs.existsSync(path.join(home, 'approvals', rec.id, 'state'))).toBe(false);
  });

  it('scan_limit is one aggregate denied record, selected by (mtime, name)', () => {
    const cfg = config({ limits: { max_scan_entries: 3 } });
    for (const [i, n] of ['e.req', 'a.req', 'd.req', 'b.req', 'c.req'].entries()) {
      const f = put(n);
      fs.utimesSync(f, new Date(2026, 0, 1, 0, 0, i), new Date(2026, 0, 1, 0, 0, i));
    }
    const same = new Date(2026, 5, 1);
    for (const n of ['z.req', 'y.req']) fs.utimesSync(put(n), same, same);
    collectSlot(inputFor(cfg), depsFor());
    const recs = records();
    const names = recs.filter((r) => 'filename' in r.source_key).map((r) => (r.source_key as { filename: string }).filename).sort();
    expect(names).toEqual(['d.req', 'e.req', 'a.req'].sort()); // the three oldest by mtime
    const scan = recs.find((r) => r.source_key.variant === 'denied_scan') as ApprovalRecord;
    expect(scan).toMatchObject({ disposition: 'denied', reason: 'scan_limit', ignored_count: 4 });
    expect(scan.source_key).toEqual({ variant: 'denied_scan', kind: 'run', source_id: 'run.1', slot: 'worker', seq: 1, reason: 'scan_limit' });
    expect(fs.existsSync(doneFile(1))).toBe(true);
  });

  it('directory anomaly and false premise create nothing', () => {
    // false premise: nothing rotates, nothing is denied, no .done, bytes stay
    put('a.req'); put('bad.req', 'junk');
    const r1 = collectSlot(inputFor(config(), { premises: [{ check: 'p1', ok: true, code: 'ok' }, { check: 'p2', ok: false, code: 'FAIL' }] }), depsFor());
    expect(r1.verdict).toEqual({ kind: 'skipped', code: 'PREMISE_FAILED' });
    expect(fs.readdirSync(proposals()).sort()).toEqual(['a.req', 'bad.req']);
    expect(fs.existsSync(requestPaths(home, slot).collected)).toBe(false);
    expect(fs.existsSync(path.join(home, 'approvals'))).toBe(false);
    expect(fs.existsSync(path.join(requestPaths(home, slot).root, '.coord'))).toBe(false);
    // directory anomaly: proposals is a symlink
    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'approval-target-'));
    fs.writeFileSync(path.join(target, 'x.req'), 'executor: exec-a\n\nx');
    fs.rmSync(proposals(), { recursive: true });
    fs.symlinkSync(target, proposals());
    const r2 = collectSlot(inputFor(config()), depsFor());
    expect(r2).toMatchObject({ created: 0, denied: 0, verdict: { kind: 'skipped', code: 'DIR_ANOMALY' } });
    expect(fs.readdirSync(target)).toEqual(['x.req']);
    expect(fs.existsSync(requestPaths(home, slot).collected)).toBe(false);
    expect(records()).toEqual([]);
    expect(logs).toEqual([expect.objectContaining({ slot: 'worker', op: 'rotate', class: 'not_directory' })]);
    fs.rmSync(target, { recursive: true, force: true });
  });

  it('replay adopts executed record', () => {
    put('a.req', 'executor: exec-a\n\nreplay me');
    expect(collectSlot(inputFor(config()), depsFor()).created).toBe(1);
    const rec = records()[0] as ApprovalRecord;
    // advance the record by hand: executing (n=1) -> executed (n=2)
    const stateDir = path.join(home, 'approvals', rec.id, 'state');
    fs.mkdirSync(stateDir);
    const actor = { user: 'u', tty: null, pid: 42, pid_started: 'x' };
    const h = 'a'.repeat(64);
    fs.writeFileSync(path.join(stateDir, '1.json'), JSON.stringify({ schema_version: 1, n: 1, previous: 0, updated_at: NOW.toISOString(), actor, status: 'executing',
      owner: { pid: 42, pid_started: 'x' }, timeout_sec: 60, viewed_bytes: 11, viewed_sha256: h, command_sha256: h }));
    fs.writeFileSync(path.join(stateDir, '2.json'), JSON.stringify({ schema_version: 1, n: 2, previous: 1, updated_at: NOW.toISOString(), actor, status: 'executed',
      method: 'manual', conclusion: 'done by hand' }));
    // simulate a crash before .done: the same source is processed again
    fs.rmSync(doneFile(1));
    const again = collectSlot(inputFor(config()), depsFor({ now: () => new Date('2026-11-18T00:00:00.000Z') }));
    expect(again).toEqual({ created: 0, existing: 1, denied: 0, verdict: { kind: 'wake' } });
    const cur = readCurrent(home, rec.id);
    expect(cur.n).toBe(2);
    expect(cur.state?.status).toBe('executed'); // never back to pending
    expect(cur.record.created_at).toBe(NOW.toISOString()); // the first commit wins
    expect(fs.existsSync(doneFile(1))).toBe(true);
    expect(records()).toHaveLength(1);
  });

  it('payload mismatch leaves incomplete', () => {
    put('a.req', 'executor: exec-a\n\nreal payload');
    const key: SourceKey = { kind: 'run', source_id: 'run.1', slot: 'worker', seq: 1, variant: 'payload', filename: 'a.req', payload_sha256: sha('real payload') };
    const id = approvalId(key);
    fs.mkdirSync(path.join(home, 'approvals', id), { recursive: true });
    fs.writeFileSync(path.join(home, 'approvals', id, 'payload'), 'planted bytes', { mode: 0o400 });
    const r = collectSlot(inputFor(config()), depsFor());
    expect(r).toMatchObject({ created: 0, verdict: { kind: 'skipped', code: 'RESIDUAL_OUTPUT' } });
    expect(logs).toEqual([expect.objectContaining({ op: 'publish', class: 'mismatch', seq: 1, id })]);
    expect(fs.readFileSync(path.join(home, 'approvals', id, 'payload'), 'utf8')).toBe('planted bytes'); // never overwritten
    expect(fs.existsSync(path.join(home, 'approvals', id, 'record.json'))).toBe(false);
    expect(fs.existsSync(doneFile(1))).toBe(false);
    expect(fs.existsSync(collected(1))).toBe(true); // the request stays in place
    // the operator fixes the planted payload; re-entry completes with the same id
    fs.rmSync(path.join(home, 'approvals', id, 'payload'));
    const ok = collectSlot(inputFor(config()), depsFor());
    expect(ok).toMatchObject({ created: 1, verdict: { kind: 'wake' } });
    expect(records().map((x) => x.id)).toEqual([id]);
    expect(fs.existsSync(doneFile(1))).toBe(true);
  });

  it('two publishers one link wins', () => {
    put('a.req', 'executor: exec-a\n\nrace');
    // first, learn the exact record this source produces, in a scratch home
    const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'approval-collect-scratch-')));
    const saved = home;
    home = scratch;
    put('a.req', 'executor: exec-a\n\nrace');
    collectSlot(inputFor(config()), depsFor());
    const winner = records()[0] as ApprovalRecord;
    home = saved;
    fs.rmSync(scratch, { recursive: true, force: true });
    // the other publisher commits the very same record between our payload and record links
    let raced = false;
    const r = collectSlot(inputFor(config()), depsFor({ fault: (point) => {
      if (point === 'payload_committed' && !raced) {
        raced = true;
        expect(publishRecord(home, { ...winner, created_at: '2026-11-17T00:00:00.000Z' }, Buffer.from('race')).kind).toBe('created');
      }
    } }));
    expect(raced).toBe(true);
    expect(r).toMatchObject({ created: 0, existing: 1, verdict: { kind: 'wake' } });
    expect(records()).toHaveLength(1);
    expect(records()[0]).toEqual(winner);
    expect(fs.existsSync(doneFile(1))).toBe(true);
  });

  it('quota includes executing unknown but not computed expired', () => {
    const cfg = config({ executors: { 'exec-a': exec({ max_pending: 3 }), 'exec-b': exec() } });
    const seed = (n: number, over: { expires?: string; state?: (dir: string) => void; disposition?: 'denied' } = {}): void => {
      const key: SourceKey = { kind: 'run', source_id: 'old.run', slot: 'worker', seq: n, variant: 'payload', filename: `s${n}.req`, payload_sha256: sha(`p${n}`) };
      const rec: ApprovalRecord = { schema_version: 1, id: approvalId(key), source_key: key, origin: { ...origin, run_id: 'old.run' }, proposer: { role: 'worker', slot: 'worker' },
        created_at: '2026-10-01T00:00:00.000Z', expires_at: over.expires ?? '2026-11-20T00:00:00.000Z', executor: 'exec-a', summary: null,
        payload_sha256: sha(`p${n}`), payload_bytes: 2, qualification: { schema_version: 1, sha256: 'b'.repeat(64), premises: [] }, disposition: 'pending' };
      publishRecord(home, rec, Buffer.from(`p${n}`));
      if (over.state) { const dir = path.join(home, 'approvals', rec.id, 'state'); fs.mkdirSync(dir); over.state(dir); }
    };
    const actor = { user: 'u', tty: null, pid: 42, pid_started: 'x' };
    const h = 'a'.repeat(64);
    const executing = (dir: string): void => { fs.writeFileSync(path.join(dir, '1.json'), JSON.stringify({ schema_version: 1, n: 1, previous: 0, updated_at: NOW.toISOString(), actor,
      status: 'executing', owner: { pid: 42, pid_started: 'x' }, timeout_sec: 60, viewed_bytes: 2, viewed_sha256: h, command_sha256: h })); };
    const unknown = (dir: string): void => { executing(dir); fs.writeFileSync(path.join(dir, '2.json'), JSON.stringify({ schema_version: 1, n: 2, previous: 1, updated_at: NOW.toISOString(), actor,
      status: 'unknown', reason: 'creator_dead', detail: 'x' })); };
    const executed = (dir: string): void => { executing(dir); fs.writeFileSync(path.join(dir, '2.json'), JSON.stringify({ schema_version: 1, n: 2, previous: 1, updated_at: NOW.toISOString(), actor,
      status: 'executed', method: 'manual', conclusion: 'ok' })); };
    seed(1); // live pending: counts
    seed(2, { expires: '2026-11-01T00:00:00.000Z' }); // computed expired, never written: does not count
    seed(3, { state: executing }); // executing: counts
    seed(4, { state: unknown }); // unknown: counts
    seed(5, { state: executed }); // terminal: does not count
    put('new.req', 'executor: exec-a\n\nnew one');
    const r = collectSlot(inputFor(cfg), depsFor());
    expect(r).toMatchObject({ created: 0, denied: 1 });
    expect(byFile(records(), 'new.req')).toMatchObject({ disposition: 'denied', reason: 'quota', source_key: { variant: 'denied_bytes', reason: 'quota' } });
    // with room for exactly one more (3 counted + 1 <= 4) the same request is accepted, and the pass counts it
    fs.rmSync(home, { recursive: true, force: true });
    fs.mkdirSync(home);
    seed(1); seed(2, { expires: '2026-11-01T00:00:00.000Z' }); seed(3, { state: executing }); seed(4, { state: unknown }); seed(5, { state: executed });
    put('new.req', 'executor: exec-a\n\nnew one'); put('new2.req', 'executor: exec-a\n\nnew two');
    const roomy = config({ executors: { 'exec-a': exec({ max_pending: 4 }), 'exec-b': exec() } });
    const r2 = collectSlot(inputFor(roomy), depsFor());
    expect(r2).toMatchObject({ created: 1, denied: 1 }); // the second one in this same pass sees the first
    // and the overall limit
    fs.rmSync(home, { recursive: true, force: true });
    fs.mkdirSync(home);
    seed(1); seed(3, { state: executing });
    put('new.req', 'executor: exec-a\n\nnew one');
    const total = collectSlot(inputFor(config({ limits: { max_total_pending: 2 } })), depsFor());
    expect(total).toMatchObject({ created: 0, denied: 1 });
    expect(byFile(records(), 'new.req')).toMatchObject({ reason: 'quota' });
  });

  it('replay of a request that filled the quota adopts it instead of denying it', () => {
    const cfg = config({ executors: { 'exec-a': exec({ max_pending: 1 }), 'exec-b': exec() } });
    put('a.req', 'executor: exec-a\n\nfills the quota');
    const crash = collectSlot(inputFor(cfg), depsFor({ fault: (p) => { if (p === 'collection:before-done') throw new Error('crash'); } }));
    expect(crash.created).toBe(1);
    const again = collectSlot(inputFor(cfg), depsFor());
    expect(again).toMatchObject({ created: 0, existing: 1, denied: 0, verdict: { kind: 'wake' } });
    expect(records()).toHaveLength(1);
    expect(records()[0]).toMatchObject({ disposition: 'pending' });
  });

  it('denied cap 100 and approximate counter', () => {
    const cfg = config({ limits: { max_scan_entries: 500 } });
    for (let i = 0; i < 102; i++) put(`d${String(i).padStart(3, '0')}.req`, `executor: nope${i}\n\nx`);
    const r = collectSlot(inputFor(cfg), depsFor());
    expect(r).toMatchObject({ created: 0, denied: 102, verdict: { kind: 'wake' } });
    expect(records()).toHaveLength(100); // the first 100 keep a full record, the rest are only counted
    const counter = path.join(home, 'approvals', '.denied-count', 'run', 'proj', 'worker');
    expect(fs.readFileSync(counter, 'utf8')).toBe('102\n');
    expect(fs.existsSync(doneFile(1))).toBe(true);
    expect(listCommittedIds(home).ids).toHaveLength(100); // the counter directory is never listed as a record

    // a later wake: counted only, still no new record, counter keeps growing (an approximation by design)
    put('e1.req', 'executor: nope\n\nx');
    expect(collectSlot(inputFor(cfg), depsFor())).toMatchObject({ denied: 1 });
    expect(records()).toHaveLength(100);
    expect(fs.readFileSync(counter, 'utf8')).toBe('103\n');

    // a damaged counter is never read as 0: the slot is skipped and nothing is marked done
    fs.writeFileSync(counter, 'garbage');
    put('e2.req', 'executor: nope\n\nx');
    const bad = collectSlot(inputFor(cfg), depsFor());
    expect(bad.verdict).toEqual({ kind: 'skipped', code: 'RESIDUAL_OUTPUT' });
    expect(logs.at(-1)).toMatchObject({ op: 'counter', class: 'corrupt', seq: 3 });
    expect(fs.existsSync(doneFile(3))).toBe(false);
    expect(fs.readFileSync(counter, 'utf8')).toBe('garbage');
  });
});

describe('prepareSlot', () => {
  it('returns the canonical empty proposals directory and creates it when missing', () => {
    const r = prepareSlot(inputFor(config()), depsFor());
    expect(r).toEqual({ created: 0, existing: 0, denied: 0, verdict: { kind: 'wake' }, proposals: proposals() });
    expect(fs.statSync(proposals()).mode & 0o777).toBe(0o700);
    expect(fs.readdirSync(proposals())).toEqual([]);
    expect(fs.existsSync(path.join(requestPaths(home, slot).root, '.coord'))).toBe(false);
  });

  it('finishes un-done collected dirs first, even when leftover output is undeterminable', () => {
    put('a.req', 'executor: exec-a\n\nfrom an earlier wake');
    collectSlot(inputFor(config()), depsFor({ fault: (p) => { if (p === 'collection:before-done') throw new Error('crash'); } }));
    expect(fs.existsSync(doneFile(1))).toBe(false);
    put('left.req', 'executor: exec-a\n\nleftover'); // new output nobody has classified
    const r = prepareSlot(inputFor(config()), depsFor());
    expect(r).toMatchObject({ verdict: { kind: 'skipped', code: 'UNDETERMINABLE' }, existing: 1 });
    expect(fs.existsSync(doneFile(1))).toBe(true);
    expect(fs.readdirSync(proposals())).toEqual(['left.req']); // never discarded to make a wake possible
    expect(fs.existsSync(collected(2))).toBe(false);
  });

  it('collects leftover output of a finished attempt and parks that of a failed one', () => {
    put('a.req', 'executor: exec-a\n\ncollect me');
    const c = prepareSlot(inputFor(config(), { current: { attemptId: 'a1', outcome: 'collect' } }), depsFor());
    expect(c).toMatchObject({ created: 1, verdict: { kind: 'wake' }, proposals: proposals() });
    expect(fs.readdirSync(proposals())).toEqual([]);
    put('b.req', 'executor: exec-a\n\ndo not collect me');
    const p = prepareSlot(inputFor(config(), { current: { attemptId: 'a2', outcome: 'park' } }), depsFor());
    expect(p).toMatchObject({ created: 0, verdict: { kind: 'wake' }, proposals: proposals() });
    expect(fs.readFileSync(path.join(requestPaths(home, slot).parked, 'a2', 'b.req'), 'utf8')).toBe('executor: exec-a\n\ndo not collect me');
    expect(records()).toHaveLength(1);
    // a re-entry of the same park (crash before the caller's bookkeeping) is a no-op, never ENOTEMPTY
    const again = prepareSlot(inputFor(config(), { current: { attemptId: 'a2', outcome: 'park' } }), depsFor());
    expect(again.verdict).toEqual({ kind: 'wake' });
  });
});
