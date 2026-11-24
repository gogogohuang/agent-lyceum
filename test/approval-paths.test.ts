import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { recordPaths, requestPaths, storePaths } from '../src/approval-paths.js';
import type { SlotRef } from '../src/approval-paths.js';

const run = Object.freeze({ kind: 'run', project: 'project-A', run_id: 'run.1', slot: 'agent--2' } as const);
const id = 'a'.repeat(24);
afterEach(() => vi.restoreAllMocks());
it('returns the exact store, run, call and record layouts', () => {
  expect(storePaths('/home/test')).toEqual({ approvals: '/home/test/approvals', requests: '/home/test/requests',
    executors: '/home/test/executors.yaml', trash: '/home/test/approvals/.trash',
    feedback: '/home/test/approvals/.feedback', denied_count: '/home/test/approvals/.denied-count' });
  const root = '/home/test/requests/projects/project-A/run.1/agent--2';
  expect(requestPaths('/home/test', run)).toEqual({ root, proposals: `${root}/proposals`, collected: `${root}/collected`,
    parked: `${root}/parked`, high_water: `${root}/collected.seq`, ok: null });
  const call = '/home/test/requests/calls/call.1';
  expect(requestPaths('/home/test', Object.freeze({ kind: 'call', call_id: 'call.1' }))).toEqual({ root: call,
    proposals: `${call}/proposals`, collected: `${call}/collected`, parked: `${call}/parked`,
    high_water: `${call}/collected.seq`, ok: `${call}/ok.json` });
  const rec = `/home/test/approvals/${id}`;
  expect(recordPaths('/home/test', id)).toEqual({ root: rec, record: `${rec}/record.json`, payload: `${rec}/payload`,
    state: `${rec}/state`, work: `${rec}/work` });
});
it.each(['', '.', 'relative', '~/home', '/home/../escape', '/home/./x', '/home\0x', '/home/\ud800'])('rejects invalid home %j', (home) => {
  for (const fn of [() => storePaths(home), () => requestPaths(home, run), () => recordPaths(home, id)]) expect(fn).toThrowError();
});
it.each(['.', '..', '../x', '/x', 'a/b', 'a\\b', 'a\0b', 'a\n', '中', '-x'])('rejects escaping or malformed names %j', (name) => {
  for (const slot of [{ ...run, project: name }, { ...run, slot: name }, { ...run, run_id: name }, { kind: 'call', call_id: name }]) {
    expect(() => requestPaths('/home/test', slot as SlotRef)).toThrowError();
  }
});
it.each(['', 'A'.repeat(24), 'a'.repeat(23), 'a'.repeat(25), '../' + 'a'.repeat(24), id + '\n'])('rejects malformed approval id %j', (value) => {
  expect(() => recordPaths('/home/test', value)).toThrowError();
});
it('rejects an unknown slot kind', () => {
  expect(() => requestPaths('/home/test', { ...run, kind: 'other' } as unknown as SlotRef)).toThrowError();
});
it('imports and calculates paths without filesystem or process side effects', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'approval-paths-'));
  try {
    vi.resetModules();
    const traps = [vi.spyOn(fs, 'mkdirSync'), vi.spyOn(fs, 'writeFileSync'), vi.spyOn(fs, 'realpathSync'), vi.spyOn(fs, 'lstatSync')];
    for (const trap of traps) trap.mockImplementation(() => { throw new Error('unexpected filesystem operation'); });
    const module = await import('../src/approval-paths.js');
    const ids = await import('../src/approval-id.js');
    module.storePaths(dir); module.requestPaths(dir, run); module.recordPaths(dir, id);
    ids.approvalId({ kind: 'call', source_id: 'call.1', slot: 'role', seq: 1, variant: 'denied_scan', reason: 'scan_limit' });
    for (const trap of traps) expect(trap).not.toHaveBeenCalled();
    vi.restoreAllMocks();
    expect(fs.readdirSync(dir)).toEqual([]);
    expect(run).toEqual({ kind: 'run', project: 'project-A', run_id: 'run.1', slot: 'agent--2' });
  } finally { vi.restoreAllMocks(); fs.rmSync(dir, { recursive: true, force: true }); }
});
