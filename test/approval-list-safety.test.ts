import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { computeDisplay } from '../src/approval-display.js';
import { serializeApprovalList } from '../src/approval-json.js';
import { approvalId } from '../src/approval-id.js';
import { listCommittedIds, publishRecord } from '../src/approval-store.js';
import { readCurrent } from '../src/approval-state.js';
import type { ApprovalIo } from '../src/approval-io.js';
import type { ApprovalRecord, SourceKey } from '../src/approval-types.js';

let home: string;
const payload = Buffer.from('hello');
const hash = createHash('sha256').update(payload).digest('hex');
const key: SourceKey = { kind: 'call', source_id: 'c1', slot: 'writer', seq: 1, variant: 'payload', filename: 'a.req', payload_sha256: hash };
const record: ApprovalRecord = { schema_version: 1, id: approvalId(key), source_key: key,
  origin: { kind: 'call', call_id: 'c1', project_dir: '/p', role: 'writer', full_writable: { dirs: [], files: [] } },
  proposer: { role: 'writer', slot: 'writer' }, created_at: '2026-11-14T00:00:00.000Z', expires_at: '2026-11-21T00:00:00.000Z',
  executor: 'local', summary: null, payload_sha256: hash, payload_bytes: payload.length,
  qualification: { schema_version: 1, sha256: hash, premises: [] }, disposition: 'pending' };
beforeEach(() => { home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'approval-list-safe-'))); });
afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

it('isolates corrupt committed records into problems and preserves valid IDs', () => {
  publishRecord(home, record, payload);
  const id = 'f'.repeat(24);
  const dir = path.join(home, 'approvals', id);
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'record.json'), '{corrupt');
  expect(listCommittedIds(home)).toEqual({ ids: [record.id], problems: [{ id, path: path.join(dir, 'record.json'), code: 'CORRUPT_RECORD', hint: 'Committed approval could not be read' }] });
});
it.each(['symlink', 'file'])('rejects %s approvals root before enumerating it', (kind) => {
  const dir = path.join(home, 'approvals');
  if (kind === 'symlink') fs.symlinkSync(home, dir); else fs.writeFileSync(dir, 'x');
  let enumerated = false;
  const io = { ...fs, readdirSync: () => { enumerated = true; return []; } } as unknown as ApprovalIo;
  expect(() => listCommittedIds(home, io)).toThrow(expect.objectContaining({ code: 'UNSAFE_PATH', path: dir }));
  expect(enumerated).toBe(false);
});
it.each(['symlink', 'file'])('rejects %s state dir even when empty, before enumerating it', (kind) => {
  publishRecord(home, record, payload);
  const dir = path.join(home, 'approvals', record.id, 'state');
  if (kind === 'symlink') fs.symlinkSync(home, dir); else fs.writeFileSync(dir, 'x');
  let enumerated = false;
  const io = { ...fs, readdirSync: () => { enumerated = true; return []; } } as unknown as ApprovalIo;
  expect(() => readCurrent(home, record.id, io)).toThrow(expect.objectContaining({ code: 'UNSAFE_PATH', path: dir }));
  expect(enumerated).toBe(false);
});

it('display and serialization make no writes and preserve the complete store byte tree', () => {
  publishRecord(home, record, payload);
  const current = readCurrent(home, record.id);
  const snapshot = (dir: string): unknown => Object.fromEntries(fs.readdirSync(dir).sort().map((name) => {
    const file = path.join(dir, name);
    return [name, fs.lstatSync(file).isDirectory() ? snapshot(file) : fs.readFileSync(file, 'hex')];
  }));
  const before = snapshot(home);
  const spies = (['writeSync', 'writeFileSync', 'mkdirSync', 'linkSync', 'renameSync', 'unlinkSync'] as const)
    .map((name) => vi.spyOn(fs, name).mockImplementation(() => { throw new Error('unexpected write'); }));
  try {
    const display = computeDisplay(current, Date.parse(record.expires_at) + 1, null);
    const output = serializeApprovalList({ schema_version: 1, requests: [{ id: record.id, origin: record.origin,
      proposer: record.proposer, executor: record.executor, created_at: record.created_at, expires_at: record.expires_at,
      display, reason: null, payload_sha256: record.payload_sha256, payload_bytes: record.payload_bytes }], problems: [] });
    expect(JSON.parse(output).requests[0].display.computed).toBe('expired');
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    expect(snapshot(home)).toEqual(before);
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
});
