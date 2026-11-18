import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { WakeResult } from '../src/adapters/index.js';
import { SCAN_WORK_BUDGET } from '../src/approval-budget.js';
import { collectCallApproval, readCallApprovalOk } from '../src/approval-call.js';
import type { CollectDeps } from '../src/approval-collect.js';
import { requestPaths } from '../src/approval-paths.js';
import { listCommittedIds, readRecord } from '../src/approval-store.js';
import { readCurrent, transition } from '../src/approval-state.js';
import { callAgent } from '../src/call.js';
import { setFaultHook } from '../src/message-store.js';
import { setOsSandboxForTest } from '../src/policy.js';
import { makeEnv, write, type TestEnv } from './helpers.js';

const PREMISE = { platform: 'linux' as const, sandboxAvailable: () => true };
const NOW = new Date('2026-11-18T00:00:00.000Z');
const OK: WakeResult = { ok: true, text: 'kept', exitCode: 0, timedOut: false };
const req = (payload: string): string => `executor: x\n\n${payload}`;

let env: TestEnv;
let tokens: number;
afterEach(() => {
  setFaultHook(undefined);
  setOsSandboxForTest(undefined);
  env?.cleanup();
});

const freshDeps = (over: Partial<CollectDeps> = {}): CollectDeps => ({
  io: fs, budget: SCAN_WORK_BUDGET, now: () => NOW, token: () => `t${tokens++}`,
  actor: () => ({ user: 'tester', tty: null, pid: 1, pid_started: null }),
  probe: { signal0: () => 'exists', start: () => 'start', compare: () => 'match' },
  fault: () => undefined, log: () => undefined, ...over,
});

function enroll(): void {
  env = makeEnv();
  tokens = 0;
  setOsSandboxForTest(true);
  const tool = path.join(env.root, 'exec', 'bin', 'tool');
  write(tool, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(tool, 0o755);
  fs.writeFileSync(path.join(env.home, 'executors.yaml'),
    `executors:\n  x:\n    command: ["${tool}"]\n    allow: [{call: fe-member}]\n    timeout_sec: 5\n`);
}

const records = () => listCommittedIds(env.home).ids.map((id) => readRecord(env.home, id));
const crashOnce = (point: string): (step: string) => void => {
  let hit = false;
  return (step) => { if (step === point && !hit) { hit = true; throw new Error('simulated crash'); } };
};

describe('enrolled call crash recovery', () => {
  it('call crash after ok preserves collectable requests without result', async () => {
    enroll();
    let invokes = 0;
    setFaultHook(crashOnce('call:ok-published'));
    await expect(callAgent({
      home: env.home, agent: 'fe-member', task: 'what is here?', dir: env.repo, say: () => {},
      approvalPremise: PREMISE, approvalCollect: freshDeps(),
      invoker: async (input) => {
        invokes += 1;
        fs.mkdirSync(input.proposalsDir!, { recursive: true });
        fs.writeFileSync(path.join(input.proposalsDir!, 'kept.req'), req('same-payload'));
        return OK;
      },
    })).rejects.toThrow(/simulated crash/);
    const id = fs.readdirSync(path.join(env.home, 'calls')).find((name) => !name.startsWith('.'))!;
    expect(fs.existsSync(path.join(env.home, 'calls', id, 'result.md'))).toBe(false);
    const marker = readCallApprovalOk(env.home, id);
    expect(marker).toMatchObject({ call_id: id, successful_attempt: 1 });
    const again = collectCallApproval(env.home, marker!, { premise: PREMISE, collect: freshDeps(), log: () => undefined });
    expect(again.verdict).toEqual({ kind: 'wake' });
    const recs = records().filter((rec) => rec !== null);
    expect(recs).toHaveLength(1);
    expect(fs.readFileSync(path.join(env.home, 'approvals', recs[0]!.id, 'payload'), 'utf8')).toBe('same-payload');
    expect(fs.existsSync(path.join(env.home, 'calls', id, 'result.md'))).toBe(false);
    expect(invokes).toBe(1);
  });

  it('call collection reentry finishes every unmarked sequence without duplicates', async () => {
    const points = ['rotation:renamed', 'rotation:recreated', 'collection:before-done', 'payload_committed', 'record_committed'];
    for (const point of points) {
      enroll();
      const hits: string[] = [];
      setFaultHook((step) => {
        if (step === point && !hits.includes(point)) {
          hits.push(step);
          throw new Error('simulated crash');
        }
      });
      const r = await callAgent({
        home: env.home, agent: 'fe-member', task: 'what is here?', dir: env.repo, say: () => {},
        approvalPremise: PREMISE, approvalCollect: freshDeps(),
        invoker: async (input) => {
          fs.mkdirSync(input.proposalsDir!, { recursive: true });
          fs.writeFileSync(path.join(input.proposalsDir!, 'a.req'), req('alpha'));
          fs.writeFileSync(path.join(input.proposalsDir!, 'b.req'), req('beta'));
          return OK;
        },
      });
      expect(r.ok, point).toBe(true);
      expect(hits, point).toEqual([point]);
      const slot = requestPaths(env.home, { kind: 'call', call_id: r.callId });
      expect(fs.existsSync(path.join(slot.collected, '1.done')), point).toBe(false);
      const early = records().find((rec) => rec?.disposition === 'pending');
      if (early) {
        transition(env.home, early.id, () => ({ event: { type: 'lazy', trigger: 'collect', creator: null },
          context: { now_ms: NOW.getTime() + 8 * 86_400_000, actor: { user: 'u', tty: null, pid: 1, pid_started: null } } }));
      }
      const marker = readCallApprovalOk(env.home, r.callId);
      const again = collectCallApproval(env.home, marker!, { premise: PREMISE, collect: freshDeps(), log: () => undefined });
      expect(again.verdict, point).toEqual({ kind: 'wake' });
      const recs = records().filter((rec) => rec !== null);
      expect(new Set(recs.map((rec) => rec!.id)).size, point).toBe(recs.length);
      expect(recs.filter((rec) => (rec!.source_key as { filename?: string }).filename === 'a.req'), point).toHaveLength(1);
      expect(fs.existsSync(path.join(slot.collected, '1.done')), point).toBe(true);
      if (early) expect(readCurrent(env.home, early.id).state?.status, point).not.toBe('pending');
      env.cleanup();
    }
  });
});
