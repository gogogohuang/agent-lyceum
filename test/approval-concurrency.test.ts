import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const WORKERS = 8;

// Worker uses only node:fs (no tsx, no project modules). Barrier: Int32Array [0]=ready count,
// [1]=start flag. Every worker waits at the barrier, so the links really race.
const WORKER_SRC = `
const { workerData, parentPort } = require('node:worker_threads');
const fs = require('node:fs');
const { sab, tmp, target } = workerData;
const i32 = new Int32Array(sab);
fs.writeFileSync(tmp, 'writer ' + tmp, { flag: 'wx', mode: 0o400 });
Atomics.add(i32, 0, 1);
Atomics.notify(i32, 0);
Atomics.wait(i32, 1, 0);
try { fs.linkSync(tmp, target); parentPort.postMessage({ result: 'ok' }); }
catch (e) { parentPort.postMessage({ result: e.code || String(e) }); }
`;

let dir: string;
beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'approval-race-')));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('raw-link prototype (hard-link first-writer-wins)', () => {
  it('8 real threads link the same target: exactly one succeeds, 7 EEXIST', async () => {
    // Portable probe: if hard links do not work here this must FAIL, not skip.
    const a = path.join(dir, 'probe-a');
    fs.writeFileSync(a, 'x');
    fs.linkSync(a, path.join(dir, 'probe-b'));
    expect(fs.statSync(a).nlink).toBe(2);
    fs.rmSync(a);
    fs.rmSync(path.join(dir, 'probe-b'));

    const target = path.join(dir, 'target');
    const sab = new SharedArrayBuffer(8);
    const i32 = new Int32Array(sab);
    const workers: Worker[] = [];
    try {
      const results = Array.from({ length: WORKERS }, (_, n) => {
        const w = new Worker(WORKER_SRC, {
          eval: true,
          workerData: { sab, tmp: path.join(dir, `.tmp-${n}`), target },
        });
        workers.push(w);
        return new Promise<string>((resolve, reject) => {
          w.once('message', (m: { result: string }) => resolve(m.result));
          w.once('error', reject);
        });
      });
      const deadline = Date.now() + 15_000;
      while (Atomics.load(i32, 0) < WORKERS) {
        if (Date.now() > deadline) throw new Error('workers did not reach the barrier');
        Atomics.wait(i32, 0, Atomics.load(i32, 0), 100);
      }
      Atomics.store(i32, 1, 1);
      Atomics.notify(i32, 1);
      const out = await Promise.race([
        Promise.all(results),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error('link race timed out')), 15_000)),
      ]);
      expect(out.filter((r) => r === 'ok')).toHaveLength(1);
      expect(out.filter((r) => r === 'EEXIST')).toHaveLength(WORKERS - 1);
      // The target is one of the writers' complete files; its inode is shared with the winner's temp.
      expect(fs.readFileSync(target, 'utf8')).toMatch(/^writer /);
      expect(fs.statSync(target).nlink).toBe(2);
    } finally {
      await Promise.all(workers.map((w) => w.terminate()));
    }
  }, 20_000);
});
