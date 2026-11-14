import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { expect, it } from 'vitest';
import { approvalId } from '../src/approval-id.js';
import { readRecord } from '../src/approval-store.js';
import type { SourceKey } from '../src/approval-types.js';

const workerSource = `
const { workerData, parentPort } = require('node:worker_threads');
require(workerData.tsx);
const fs = require('node:fs');
const path = require('node:path');
const { publishRecord } = require(workerData.module);
const gate = new Int32Array(workerData.sab);
const io = { ...fs, linkSync: (tmp, target) => {
  if (path.basename(target) === 'record.json') {
    Atomics.add(gate, 0, 1); Atomics.notify(gate, 0);
    if (Atomics.wait(gate, 1, 0, 15000) === 'timed-out') throw Error('pre-link barrier timed out');
  }
  return fs.linkSync(tmp, target);
}};
parentPort.postMessage(publishRecord(workerData.home, workerData.record, Buffer.from('hello'), { io }));
`;

it('publishRecord has one winner with every writer forced to the same record pre-link barrier', async () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'approval-api-race-')));
  const workers: Worker[] = [];
  const count = 8;
  const sab = new SharedArrayBuffer(8);
  const gate = new Int32Array(sab);
  const hash = createHash('sha256').update('hello').digest('hex');
  const key: SourceKey = { kind: 'call', source_id: 'c1', slot: 'writer', seq: 1, variant: 'payload', filename: 'a.req', payload_sha256: hash };
  const id = approvalId(key);
  const time = '2026-11-14T00:00:00.000Z';
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const results = Array.from({ length: count }, (_, n) => {
      const record = { schema_version: 1, id, source_key: key,
        origin: { kind: 'call', call_id: 'c1', project_dir: '/p', role: 'writer', full_writable: { dirs: [], files: [] } },
        proposer: { role: 'writer', slot: 'writer' }, created_at: time, expires_at: time, executor: 'local', summary: `writer-${n}`,
        payload_sha256: hash, payload_bytes: 5, qualification: { schema_version: 1, sha256: hash, premises: [] }, disposition: 'pending' };
      const worker = new Worker(workerSource, { eval: true, workerData: { home, record, sab,
        tsx: createRequire(import.meta.url).resolve('tsx/cjs'), module: fileURLToPath(new URL('../src/approval-store.ts', import.meta.url)) } });
      workers.push(worker);
      return new Promise<{ kind: string; record: unknown }>((resolve, reject) => {
        worker.once('message', resolve);
        worker.once('error', reject);
        worker.once('exit', (code) => { if (code !== 0) reject(new Error(`worker exited ${code}`)); });
      });
    });
    const operation = async () => {
      while (!stopped && Atomics.load(gate, 0) !== count) await new Promise((resolve) => setTimeout(resolve, 10));
      Atomics.store(gate, 1, 1);
      Atomics.notify(gate, 1);
      return Promise.all(results);
    };
    // Observe early worker rejection while waiting for the barrier as well.
    const failed = Promise.all(results).then(() => new Promise<never>(() => {}));
    const out = await Promise.race([operation(), failed, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('publishRecord race timed out')), 20000);
    })]);
    expect(out.filter((r) => r.kind === 'created')).toHaveLength(1);
    expect(out.filter((r) => r.kind === 'existing')).toHaveLength(count - 1);
    const winner = readRecord(home, id);
    for (const result of out) expect(result.record).toEqual(winner);
    expect(fs.readFileSync(path.join(home, 'approvals', id, 'payload'), 'utf8')).toBe('hello');
    expect(fs.readdirSync(path.join(home, 'approvals', id)).sort()).toEqual(['payload', 'record.json']);
  } finally {
    stopped = true;
    clearTimeout(timer);
    await Promise.all(workers.map((worker) => worker.terminate()));
    fs.rmSync(home, { recursive: true, force: true });
  }
}, 25000);
