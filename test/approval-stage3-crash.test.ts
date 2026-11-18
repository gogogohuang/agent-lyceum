// Stage 3 QA: each fault window crashes once, then a new RunSession (resume) re-enters.
// A leftover `.coord` is created after the crash to simulate a killed process: the next session must not steal it.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Invoker, WakeInput, WakeResult } from '../src/adapters/index.js';
import { defaultDirIo } from '../src/approval-budget.js';
import { readHighWater } from '../src/approval-high-water.js';
import * as snapshotMod from '../src/approval-snapshot.js';
import { readCurrent, transition } from '../src/approval-state.js';
import type { ApprovalId } from '../src/approval-types.js';
import { runTeam, type RunOptions, type RunSummary } from '../src/dispatcher.js';
import { listAttempts, setFaultHook } from '../src/message-store.js';
import { outboxDir, setOsSandboxForTest } from '../src/policy.js';
import { loadRunState } from '../src/run-store.js';
import { prepareTask } from '../src/task.js';
import { FULL_DONE, initGitRepo, makeEnv, withSections, write, type TestEnv } from './helpers.js';

vi.setConfig({ testTimeout: 60_000 });

const OK: WakeResult = { ok: true, text: '', exitCode: 0, timedOut: false };
const FAIL: WakeResult = { ok: false, text: '', exitCode: 1, timedOut: false, error: 'boom' };
const CANCEL: WakeResult = { ok: false, text: '', exitCode: null, timedOut: false, cancelled: true, error: 'cancelled' };
const PREMISE_OK = { platform: 'linux' as const, sandboxAvailable: () => true };
const SEED = 'SEED-PARKED-BYTES-NEVER-COLLECTED';
const SEED_FILE = `executor: x\n\n${SEED}\n`;

let env: TestEnv;
let tool: string;
let mailN = 0;
beforeEach(() => { setOsSandboxForTest(true); mailN = 0; });
afterEach(() => { setFaultHook(undefined); setOsSandboxForTest(undefined); vi.restoreAllMocks(); env?.cleanup(); });

const mail = (i: WakeInput, to: string, subject: string, type: string, text: string) =>
  write(path.join(outboxDir(i.project, i.agent.name), `${String(++mailN).padStart(6, '0')}-crash.md`),
    `---\nto: ${to}\ntype: ${type}\nsubject: ${subject}\n${type === 'done' ? 'outcome: completed\n' : ''}---\n\n${type === 'done' ? `${FULL_DONE}\n${text}\n` : withSections(type, text)}\n`);

const setup = () => {
  env = makeEnv();
  tool = path.join(env.root, 'exec', 'bin', 'tool');
  write(tool, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(tool, 0o755);
  fs.writeFileSync(path.join(env.home, 'executors.yaml'),
    `executors:\n  x:\n    command: ["${tool}"]\n    allow: [{project: demo, agent: fe-member}, {project: demo, agent: qa-member}]\n    timeout_sec: 5\n    max_pending: 100\n`);
  initGitRepo(env.repo);
};
const runDir = () => path.join(env.project().paths.runs, 'run-1');
const slotRoot = (slot: string) => path.join(env.home, 'requests', 'projects', 'demo', 'run-1', slot);
const requestFile = (name: string, payload: string): string => `executor: x\nsummary: s ${name}\n\n${payload}\n`;
const req = (dir: string, name: string, payload: string): void => write(path.join(dir, name), requestFile(name, payload));
const seedParked = (): void => write(path.join(slotRoot('fe-member'), 'parked', 'seed-att', 'seed.req'), SEED_FILE);

interface Rec { id: string; source_key: { seq: number; slot?: string; variant?: string; filename?: string }; proposer?: { slot?: string } }
const records = (): Rec[] => {
  const dir = path.join(env.home, 'approvals');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((n) => /^[0-9a-f]{24}$/.test(n) && fs.existsSync(path.join(dir, n, 'record.json'))).sort()
    .map((n) => JSON.parse(fs.readFileSync(path.join(dir, n, 'record.json'), 'utf8')) as Rec);
};
const payloadOf = (id: string): string => {
  const p = path.join(env.home, 'approvals', id, 'payload');
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
};
const idsFor = (marker: string): string[] => records().filter((r) => payloadOf(r.id).includes(marker)).map((r) => r.id);
/** Approval dirs whose payload contains `marker` and which have no `record.json` yet. */
const incompleteFor = (marker: string): string[] => {
  const dir = path.join(env.home, 'approvals');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((n) => /^[0-9a-f]{24}$/.test(n)).map((n) => path.join(dir, n))
    .filter((d) => !fs.existsSync(path.join(d, 'record.json')) && fs.existsSync(path.join(d, 'payload')) && fs.readFileSync(path.join(d, 'payload'), 'utf8').includes(marker));
};
const claims = (): Array<{ agent: string; status: string }> => {
  const dir = path.join(runDir(), 'mail', 'claims');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as { agent: string; status: string });
};
/** Slot tree minus a lock we planted. Used to prove a held `.coord` changes nothing. */
const tree = (slot: string): string[] => {
  const root = slotRoot(slot);
  if (!fs.existsSync(root)) return [];
  const out: string[] = [];
  const walk = (d: string, prefix: string) => {
    for (const name of fs.readdirSync(d).sort()) {
      if (prefix === '' && name === '.coord') continue;
      const p = path.join(d, name);
      if (fs.lstatSync(p).isDirectory()) walk(p, `${prefix}${name}/`);
      else out.push(`${prefix}${name}:${fs.readFileSync(p, 'utf8')}`);
    }
  };
  walk(root, '');
  return out;
};
const expire = (id: string): void => {
  transition(env.home, id as ApprovalId, () => ({
    event: { type: 'lazy', trigger: 'collect', creator: null },
    context: { now_ms: Date.now() + 8 * 86_400_000, actor: { user: 'u', tty: null, pid: 1, pid_started: null } },
  }));
  expect(readCurrent(env.home, id as ApprovalId).state?.status).toBe('expired');
};
const statusOf = (id: string): string | undefined => readCurrent(env.home, id as ApprovalId).state?.status;
const assertSeed = (): void => {
  expect(fs.readFileSync(path.join(slotRoot('fe-member'), 'parked', 'seed-att', 'seed.req'), 'utf8')).toBe(SEED_FILE);
  expect(records().some((r) => payloadOf(r.id).includes(SEED))).toBe(false);
};
const assertNoReuse = (slot: string): void => {
  const nums = fs.readdirSync(path.join(slotRoot(slot), 'collected')).filter((n) => /^\d+$/.test(n));
  expect(nums).toEqual(['1']);
  expect(fs.existsSync(path.join(slotRoot(slot), 'collected', '1.done'))).toBe(true);
  expect(readHighWater(slotRoot(slot), env.home)).toBe(1);
  const seqs = records().filter((r) => r.proposer?.slot === slot).map((r) => r.source_key.seq);
  expect(seqs.every((s) => s === 1)).toBe(true);
  expect(new Set(seqs).size).toBeLessThanOrEqual(1);
};

interface Go { resume?: boolean; collect?: RunOptions['approvalCollect']; signal?: AbortSignal }
async function go(invoker: Invoker, o: Go = {}): Promise<RunSummary> {
  const project = env.project();
  const rd = path.join(project.paths.runs, 'run-1');
  const common = { project, runDir: rd, invoker, log: () => {}, sleep: async () => {}, approvalPremise: PREMISE_OK, signal: o.signal, approvalCollect: o.collect };
  if (o.resume) return runTeam({ ...common, resume: loadRunState(rd) });
  return runTeam({ ...common, task: prepareTask({ text: 'build the crash matrix', cwd: env.root, runDir: rd }) });
}

/** Lead tasks both members once. Members run `member` and, on success, reply with a body unique to this wake. */
function team(tag: string, member: (i: WakeInput) => WakeResult, seen: string[] = [], all?: WakeInput[]): Invoker {
  let leadWakes = 0;
  let sentDone = false;
  const heard = new Set<string>();
  const to = ['fe-member', 'qa-member'];
  return async (i) => {
    seen.push(i.agent.name);
    all?.push(i);
    if (i.agent.name === 'lead') {
      for (const n of to) if (i.userPrompt.includes(`from: ${n}`)) heard.add(n);
      if (++leadWakes === 1) for (const t of to) mail(i, t, `task ${tag} ${t}`, 'task', `Do only the ${tag} job for ${t}. Marker ${tag}.`);
      else if (!sentDone && to.every((n) => heard.has(n))) { sentDone = true; mail(i, 'lead', `done ${tag}`, 'done', `finished ${tag}`); }
      return OK;
    }
    const r = member(i);
    if (r.ok) mail(i, 'lead', `reply ${tag} ${i.agent.name} ${mailN}`, 'reply', `Reply ${tag} from ${i.agent.name} number ${++mailN}.`);
    return r;
  };
}

/**
 * The collect fault has no slot argument. fe-member is the one in the window when its `collected/<seq>`
 * exists without `.done` (or, for `collection:done`, the `.done` link was just written). qa-member's pass is left alone.
 */
function feInCollectWindow(point: string): boolean {
  const dir = path.join(slotRoot('fe-member'), 'collected');
  if (!fs.existsSync(dir)) return false;
  const names = fs.readdirSync(dir);
  if (point === 'collection:done') return names.includes('1.done');
  return names.some((n) => /^\d+$/.test(n) && !names.includes(`${n}.done`));
}
const crashFeCollect = (point: string, stop?: AbortController): RunOptions['approvalCollect'] => {
  let thrown = false;
  return { fault: (p) => {
    if (!thrown && p === point && feInCollectWindow(point)) {
      thrown = true;
      stop?.abort(); // end this session before a later settle in the same process closes the window
      throw new Error(`crash at ${point}`);
    }
  } };
};

/** Throw from `point` only while fe-member's attempt is the one just marked output_ready. qa-member's wake keeps going. */
function crashFeOutputReady(): void {
  const seen = new Set<string>();
  setFaultHook((step) => {
    if (step !== 'attempt:output-ready') return;
    const fresh = listAttempts(runDir()).filter((a) => a.status === 'output_ready' && !seen.has(a.id));
    for (const a of listAttempts(runDir())) if (a.status === 'output_ready') seen.add(a.id);
    if (fresh.some((a) => a.agent === 'fe-member')) throw new Error('crash at attempt:output-ready');
  });
}

const COLLECT_POINTS = ['rotation:renamed', 'rotation:recreated', 'collection:high-water', 'collection:done', 'payload_committed', 'record_committed'] as const;

describe('collection fault windows re-enter in a new session', () => {
  it.each(COLLECT_POINTS)('%s: crash, refuse a leftover lock, then a new session finishes without loss or a reused seq', async (point) => {
    setup();
    seedParked();
    const seen: string[] = [];
    const wrote = new Set<string>();
    const feMarker = `FE-${point}`;
    const qaMarker = `QA-${point}`;
    const inv = team(point, (i) => {
      if (!wrote.has(i.agent.name)) {
        wrote.add(i.agent.name);
        req(i.proposalsDir as string, `${i.agent.name}.req`, i.agent.name === 'fe-member' ? feMarker : qaMarker);
      }
      return OK;
    }, seen);
    const stop = new AbortController();
    const collect = crashFeCollect(point, stop);
    const first = await go(inv, { collect, signal: stop.signal });
    expect(stop.signal.aborted).toBe(true);
    expect(first.endReason).toBe('cancelled');
    expect(fs.existsSync(path.join(slotRoot('fe-member'), 'collected', '1')) || point === 'collection:done').toBe(true);
    expect(seen).toContain('qa-member'); // woken in the crashing pass
    const feBefore = idsFor(feMarker);
    const qaBefore = idsFor(qaMarker);
    const feRoot = slotRoot('fe-member');
    // The crash has to be the named window. A fault that moved past `.done` (or past mkdir / the high-water write) fails here.
    if (point === 'rotation:renamed') {
      expect(fs.existsSync(path.join(feRoot, 'proposals'))).toBe(false);
      expect(fs.existsSync(path.join(feRoot, 'collected', '1'))).toBe(true);
      expect(fs.existsSync(path.join(feRoot, 'collected', '1.done'))).toBe(false);
      expect(readHighWater(feRoot, env.home)).toBe(0);
      expect(feBefore).toEqual([]);
    }
    if (point === 'rotation:recreated') {
      expect(fs.readdirSync(path.join(feRoot, 'proposals'))).toEqual([]);
      expect(fs.existsSync(path.join(feRoot, 'collected', '1.done'))).toBe(false);
      expect(readHighWater(feRoot, env.home)).toBe(0);
      expect(feBefore).toEqual([]);
    }
    if (point === 'collection:high-water') {
      expect(readHighWater(feRoot, env.home)).toBe(1);
      expect(fs.existsSync(path.join(feRoot, 'collected', '1.done'))).toBe(false);
      expect(feBefore).toEqual([]);
    }
    if (point === 'payload_committed') {
      const incomplete = incompleteFor(feMarker);
      expect(incomplete).toHaveLength(1);
      expect(fs.existsSync(path.join(incomplete[0] as string, 'record.json'))).toBe(false);
      expect(feBefore).toEqual([]);
      expect(fs.existsSync(path.join(feRoot, 'collected', '1.done'))).toBe(false);
    }
    if (point === 'record_committed' || point === 'collection:done') {
      expect(feBefore).toHaveLength(1);
      // No state file yet: the record's disposition is pending (n === 0). A later expire must stay expired.
      const cur = readCurrent(env.home, feBefore[0] as ApprovalId);
      expect(cur.n).toBe(0);
      expect(cur.state).toBeNull();
      expect(cur.record.disposition).toBe('pending');
      expect(fs.existsSync(path.join(feRoot, 'collected', '1.done'))).toBe(point === 'collection:done');
    }
    if (feBefore[0]) expire(feBefore[0]);
    if (qaBefore[0]) expire(qaBefore[0]);
    const frozen = tree('fe-member');
    fs.mkdirSync(path.join(slotRoot('fe-member'), '.coord'), { mode: 0o700 });
    await go(inv, { resume: true });
    expect(tree('fe-member')).toEqual(frozen); // lock not stolen, bytes unchanged
    if (qaBefore[0]) expect(statusOf(qaBefore[0])).toBe('expired');
    fs.rmdirSync(path.join(slotRoot('fe-member'), '.coord'));
    if (point === 'collection:high-water') req(path.join(slotRoot('fe-member'), 'proposals'), 'extra.req', 'FE-HIGH-EXTRA');
    await go(inv, { resume: true });
    const feIds = idsFor(feMarker);
    expect(feIds).toHaveLength(1);
    if (feBefore[0]) {
      expect(feIds).toEqual(feBefore); // same id, not a second record
      expect(statusOf(feBefore[0])).toBe('expired');
    }
    expect(idsFor(qaMarker)).toHaveLength(1);
    if (qaBefore[0]) {
      expect(idsFor(qaMarker)).toEqual(qaBefore);
      expect(statusOf(qaBefore[0])).toBe('expired');
    }
    expect(new Set(records().map((r) => r.id)).size).toBe(records().length);
    if (point === 'collection:high-water') {
      const extra = records().find((r) => payloadOf(r.id).includes('FE-HIGH-EXTRA'));
      expect(extra?.source_key.seq).toBe(2);
      expect(records().find((r) => r.id === feIds[0])?.source_key.seq).toBe(1);
      expect(readHighWater(slotRoot('fe-member'), env.home)).toBe(2);
    } else {
      assertNoReuse('fe-member');
    }
    assertNoReuse('qa-member');
    assertSeed();
  });

  it('collection:before-done ordering: the record exists and .done does not, a held lock changes nothing, re-entry adopts it', async () => {
    setup();
    seedParked();
    const seen: string[] = [];
    const wrote = new Set<string>();
    const inv = team('before-done', (i) => {
      if (!wrote.has(i.agent.name)) {
        wrote.add(i.agent.name);
        req(i.proposalsDir as string, `${i.agent.name}.req`, i.agent.name === 'fe-member' ? 'FE-BEFORE-DONE' : 'QA-BEFORE-DONE');
      }
      return OK;
    }, seen);
    const stop = new AbortController();
    const crashed = await go(inv, { collect: crashFeCollect('collection:before-done', stop), signal: stop.signal });
    expect(crashed.endReason).toBe('cancelled');
    expect(seen).toContain('qa-member');
    expect(fs.existsSync(path.join(slotRoot('fe-member'), 'collected', '1'))).toBe(true);
    expect(fs.existsSync(path.join(slotRoot('fe-member'), 'collected', '1.done'))).toBe(false); // crash is before the done link
    const feId = idsFor('FE-BEFORE-DONE');
    expect(feId).toHaveLength(1);
    const qaId = idsFor('QA-BEFORE-DONE')[0];
    expire(feId[0] as string);
    if (qaId) expire(qaId);
    const frozen = tree('fe-member');
    fs.mkdirSync(path.join(slotRoot('fe-member'), '.coord'), { mode: 0o700 });
    await go(inv, { resume: true });
    expect(tree('fe-member')).toEqual(frozen);
    expect(fs.existsSync(path.join(slotRoot('fe-member'), 'collected', '1.done'))).toBe(false);
    fs.rmdirSync(path.join(slotRoot('fe-member'), '.coord'));
    await go(inv, { resume: true });
    expect(fs.existsSync(path.join(slotRoot('fe-member'), 'collected', '1.done'))).toBe(true);
    expect(idsFor('FE-BEFORE-DONE')).toEqual(feId);
    expect(statusOf(feId[0] as string)).toBe('expired');
    expect(idsFor('QA-BEFORE-DONE')).toHaveLength(1);
    if (qaId) expect(statusOf(qaId)).toBe('expired');
    expect(new Set(records().map((r) => r.id)).size).toBe(records().length);
    assertNoReuse('fe-member');
    assertNoReuse('qa-member');
    assertSeed();
  });

  it('collection:budget: a tight budget stops the large slot only; the small slot is collected in that pass; a new session finishes', async () => {
    setup();
    seedParked();
    const seen: string[] = [];
    const wrote = new Set<string>();
    const feSource = new Map<string, string>();
    const inv = team('budget', (i) => {
      if (wrote.has(i.agent.name)) return OK;
      wrote.add(i.agent.name);
      if (i.agent.name === 'fe-member') {
        const dir = i.proposalsDir as string;
        for (let n = 0; n < 40; n++) {
          const name = `f${n}.req`;
          req(dir, name, `FE-BUDGET-${n}`);
          feSource.set(name, fs.readFileSync(path.join(dir, name), 'utf8'));
        }
      } else req(i.proposalsDir as string, 'q.req', 'QA-BUDGET');
      return OK;
    }, seen);
    const first = await go(inv, { collect: { budget: 400 } });
    expect(first.endReason).toBe('done');
    expect(seen).toContain('qa-member');
    const log = fs.readFileSync(path.join(runDir(), 'log.jsonl'), 'utf8');
    expect(log).toContain('"slot":"fe-member"');
    expect(log).toContain('"class":"budget"');
    const qaNow = records().filter((r) => r.proposer?.slot === 'qa-member' && payloadOf(r.id) === 'QA-BUDGET\n');
    expect(qaNow).toHaveLength(1); // the small slot finishes in the same pass
    const early = records().filter((r) => r.proposer?.slot === 'fe-member').map((r) => r.id);
    expect(early.length, 'exhausted pass committed at least one FE record').toBeGreaterThan(0);
    expect(fs.existsSync(path.join(slotRoot('fe-member'), 'collected', '1.done'))).toBe(false);
    for (const id of early) expire(id);
    const frozen = tree('fe-member');
    fs.mkdirSync(path.join(slotRoot('fe-member'), '.coord'), { mode: 0o700 });
    await go(inv, { resume: true });
    expect(tree('fe-member')).toEqual(frozen);
    fs.rmdirSync(path.join(slotRoot('fe-member'), '.coord'));
    const qaId = qaNow[0]?.id as string;
    expire(qaId);
    await go(inv, { resume: true });
    const fe = records().filter((r) => r.proposer?.slot === 'fe-member');
    const qa = records().filter((r) => r.proposer?.slot === 'qa-member');
    const collectedDir = path.join(slotRoot('fe-member'), 'collected', '1');
    const names = Array.from({ length: 40 }, (_, n) => `f${n}.req`);
    expect(feSource.size).toBe(40);
    expect([...feSource.keys()].sort()).toEqual([...names].sort());
    expect(fs.readdirSync(collectedDir).sort()).toEqual([...names].sort());
    for (const name of names) {
      const n = Number(/^f(\d+)\.req$/.exec(name)?.[1]);
      const fileBytes = feSource.get(name) ?? '';
      const body = `FE-BUDGET-${n}\n`;
      expect(fileBytes, name).toBe(requestFile(name, `FE-BUDGET-${n}`));
      expect(fileBytes.slice(fileBytes.indexOf('\n\n') + 2), name).toBe(body);
      expect(fs.readFileSync(path.join(collectedDir, name), 'utf8'), name).toBe(fileBytes);
      const hits = fe.filter((r) => payloadOf(r.id) === body && r.source_key.filename === name && r.source_key.seq === 1 && r.source_key.variant === 'payload' && r.source_key.slot === 'fe-member');
      expect(hits, name).toHaveLength(1);
    }
    expect(fe, 'fe-member records').toHaveLength(40);
    expect(qa, 'qa-member records').toHaveLength(1);
    expect(records(), 'approval records').toHaveLength(41);
    expect(new Set([...fe, ...qa].map((r) => r.id)).size).toBe(41);
    expect(new Set(fe.map((r) => r.source_key.seq))).toEqual(new Set([1]));
    for (const id of early) {
      expect(fe.some((r) => r.id === id), id).toBe(true);
      expect(statusOf(id)).toBe('expired');
    }
    expect(qa.map((r) => r.id)).toEqual([qaId]);
    expect(payloadOf(qaId)).toBe('QA-BUDGET\n');
    expect(qa[0]?.source_key.seq).toBe(1);
    expect(statusOf(qaId)).toBe('expired');
    expect(fs.existsSync(path.join(slotRoot('fe-member'), 'collected', '1.done'))).toBe(true);
    assertNoReuse('fe-member');
    assertNoReuse('qa-member');
    assertSeed();
  });

  it('payload_committed mismatch: a new session leaves the planted payload, writes no record and no .done', async () => {
    setup();
    seedParked();
    const seen: string[] = [];
    const wrote = new Set<string>();
    const inv = team('mismatch', (i) => {
      if (!wrote.has(i.agent.name)) {
        wrote.add(i.agent.name);
        req(i.proposalsDir as string, `${i.agent.name}.req`, i.agent.name === 'fe-member' ? 'FE-MISMATCH' : 'QA-MISMATCH');
      }
      return OK;
    }, seen);
    const stop = new AbortController();
    const crashed = await go(inv, { collect: crashFeCollect('payload_committed', stop), signal: stop.signal });
    expect(crashed.endReason).toBe('cancelled');
    expect(seen).toContain('qa-member');
    const incomplete = incompleteFor('FE-MISMATCH');
    expect(incomplete).toHaveLength(1);
    const dir = incomplete[0] as string;
    const payload = path.join(dir, 'payload');
    fs.chmodSync(payload, 0o600);
    fs.writeFileSync(payload, 'PLANTED-MISMATCH-BYTES');
    fs.chmodSync(payload, 0o400);
    const qaId = idsFor('QA-MISMATCH')[0];
    if (qaId) expire(qaId);
    const again = await go(inv, { resume: true });
    expect(again.endReason).toBe('done');
    expect(fs.readFileSync(payload, 'utf8')).toBe('PLANTED-MISMATCH-BYTES');
    expect(fs.existsSync(path.join(dir, 'record.json'))).toBe(false);
    expect(fs.existsSync(path.join(slotRoot('fe-member'), 'collected', '1.done'))).toBe(false);
    expect(idsFor('FE-MISMATCH')).toEqual([]);
    expect(fs.readFileSync(path.join(slotRoot('fe-member'), 'collected', '1', 'fe-member.req'), 'utf8')).toContain('FE-MISMATCH');
    expect(idsFor('QA-MISMATCH')).toHaveLength(1);
    if (qaId) expect(statusOf(qaId)).toBe('expired');
    const log = fs.readFileSync(path.join(runDir(), 'log.jsonl'), 'utf8');
    expect(log).toContain('"class":"mismatch"');
    expect(log).not.toContain('PLANTED-MISMATCH-BYTES');
    assertSeed();
  });
});

describe('lifecycle fault windows re-enter in a new session', () => {
  it('rotation:renamed while parking: the renamed bytes survive, a held lock does not rebuild proposals, and a new session does', async () => {
    setup();
    seedParked();
    const stop = new AbortController();
    const seen: string[] = [];
    const wrote = new Set<string>();
    let thrown = false;
    const inv = team('park-renamed', (i) => {
      if (wrote.has(i.agent.name)) return OK;
      wrote.add(i.agent.name);
      if (i.agent.name === 'fe-member') {
        req(i.proposalsDir as string, 'fe-member.req', 'FE-PARK-RENAME');
        return FAIL;
      }
      req(i.proposalsDir as string, 'qa-member.req', 'QA-PARK-RENAME');
      return OK;
    }, seen);
    const first = await go(inv, {
      signal: stop.signal,
      collect: { fault: (p) => {
        if (thrown || p !== 'rotation:renamed') return;
        const parked = path.join(slotRoot('fe-member'), 'parked');
        const names = fs.existsSync(parked) ? fs.readdirSync(parked).filter((n) => n !== 'seed-att') : [];
        if (names.length === 1 && !fs.existsSync(path.join(slotRoot('fe-member'), 'proposals'))) {
          thrown = true;
          stop.abort();
          throw new Error('crash at rotation:renamed');
        }
      } },
    });
    expect(first.endReason).toBe('cancelled');
    expect(thrown).toBe(true);
    expect(seen).toContain('qa-member');
    const parked = fs.readdirSync(path.join(slotRoot('fe-member'), 'parked')).filter((n) => n !== 'seed-att');
    expect(parked).toHaveLength(1);
    expect(fs.readFileSync(path.join(slotRoot('fe-member'), 'parked', parked[0] as string, 'fe-member.req'), 'utf8')).toBe(requestFile('fe-member.req', 'FE-PARK-RENAME'));
    expect(fs.existsSync(path.join(slotRoot('fe-member'), 'proposals'))).toBe(false);
    const frozen = tree('fe-member');
    fs.mkdirSync(path.join(slotRoot('fe-member'), '.coord'), { mode: 0o700 });
    await go(inv, { resume: true });
    expect(tree('fe-member')).toEqual(frozen);
    fs.rmdirSync(path.join(slotRoot('fe-member'), '.coord'));
    await go(inv, { resume: true });
    expect(fs.lstatSync(path.join(slotRoot('fe-member'), 'proposals')).isDirectory()).toBe(true);
    expect(fs.readdirSync(path.join(slotRoot('fe-member'), 'parked')).filter((n) => n !== 'seed-att')).toEqual(parked);
    expect(idsFor('FE-PARK-RENAME')).toHaveLength(0);
    expect(idsFor('QA-PARK-RENAME')).toHaveLength(1);
    expect(new Set(records().map((r) => r.id)).size).toBe(records().length);
    assertSeed();
  });

  it('attempt:output-ready ordering: recovery parks before abandon; a held lock does not take the bytes; the other slot was woken', async () => {
    setup();
    seedParked();
    const seen: string[] = [];
    const wrote = new Set<string>();
    const inv = team('output-ready', (i) => {
      if (!wrote.has(i.agent.name)) {
        wrote.add(i.agent.name);
        req(i.proposalsDir as string, `${i.agent.name}.req`, i.agent.name === 'fe-member' ? 'FE-OUTPUT-READY' : 'QA-OUTPUT-READY');
      }
      return OK;
    }, seen);
    crashFeOutputReady();
    await expect(go(inv)).rejects.toThrow(/crash at attempt:output-ready/);
    setFaultHook(undefined);
    expect(seen).toContain('qa-member');
    expect(fs.readFileSync(path.join(slotRoot('fe-member'), 'proposals', 'fe-member.req'), 'utf8')).toContain('FE-OUTPUT-READY');
    expect(claims().find((c) => c.agent === 'fe-member')?.status).toBe('claimed');
    const frozen = tree('fe-member');
    fs.mkdirSync(path.join(slotRoot('fe-member'), '.coord'), { mode: 0o700 });
    await go(inv, { resume: true });
    expect(tree('fe-member')).toEqual(frozen); // park refused, claim stays claimed
    expect(claims().find((c) => c.agent === 'fe-member')?.status).toBe('claimed');
    const qaId = idsFor('QA-OUTPUT-READY')[0] as string;
    expect(qaId).toBeTruthy();
    expire(qaId);
    fs.rmdirSync(path.join(slotRoot('fe-member'), '.coord'));
    await go(inv, { resume: true });
    const parked = fs.readdirSync(path.join(slotRoot('fe-member'), 'parked')).filter((n) => n !== 'seed-att');
    expect(parked).toHaveLength(1);
    expect(fs.readFileSync(path.join(slotRoot('fe-member'), 'parked', parked[0] as string, 'fe-member.req'), 'utf8')).toBe(requestFile('fe-member.req', 'FE-OUTPUT-READY'));
    expect(idsFor('FE-OUTPUT-READY')).toHaveLength(0);
    expect(statusOf(qaId)).toBe('expired');
    expect(claims().find((c) => c.agent === 'fe-member')?.status).toBe('abandoned');
    expect(new Set(records().map((r) => r.id)).size).toBe(records().length);
    assertNoReuse('qa-member');
    assertSeed();
  });

  it('recovery:proposals-parked ordering: the park is durable and the claim is still claimed; a later session does not park again', async () => {
    setup();
    seedParked();
    const seen: string[] = [];
    const wrote = new Set<string>();
    const inv = team('recovery-park', (i) => {
      if (!wrote.has(i.agent.name)) {
        wrote.add(i.agent.name);
        req(i.proposalsDir as string, `${i.agent.name}.req`, i.agent.name === 'fe-member' ? 'FE-RECOVERY' : 'QA-RECOVERY');
      }
      return OK;
    }, seen);
    crashFeOutputReady();
    await expect(go(inv)).rejects.toThrow(/crash at attempt:output-ready/);
    setFaultHook((step) => { if (step === 'recovery:proposals-parked') throw new Error('crash at recovery:proposals-parked'); });
    await expect(go(inv, { resume: true })).rejects.toThrow(/crash at recovery:proposals-parked/);
    setFaultHook(undefined);
    expect(seen).toContain('qa-member');
    expect(claims().find((c) => c.agent === 'fe-member')?.status).toBe('claimed'); // abandon has not been saved
    const parked = fs.readdirSync(path.join(slotRoot('fe-member'), 'parked')).filter((n) => n !== 'seed-att');
    expect(parked).toHaveLength(1);
    expect(fs.readFileSync(path.join(slotRoot('fe-member'), 'parked', parked[0] as string, 'fe-member.req'), 'utf8')).toBe(requestFile('fe-member.req', 'FE-RECOVERY'));
    const frozen = tree('fe-member');
    fs.mkdirSync(path.join(slotRoot('fe-member'), '.coord'), { mode: 0o700 });
    await go(inv, { resume: true });
    expect(tree('fe-member')).toEqual(frozen);
    expect(claims().find((c) => c.agent === 'fe-member')?.status).toBe('claimed');
    fs.rmdirSync(path.join(slotRoot('fe-member'), '.coord'));
    await go(inv, { resume: true });
    expect(fs.readdirSync(path.join(slotRoot('fe-member'), 'parked')).filter((n) => n !== 'seed-att')).toEqual(parked); // not parked again
    expect(idsFor('FE-RECOVERY')).toHaveLength(0);
    const qaId = idsFor('QA-RECOVERY')[0] as string;
    expect(qaId).toBeTruthy();
    expect(new Set(records().map((r) => r.id)).size).toBe(records().length);
    assertSeed();
  });

  it('failure:proposals-parked ordering: the attempt is still started and the parked bytes stay; a new session does not move them again', async () => {
    setup();
    seedParked();
    const seen: string[] = [];
    let feCalls = 0;
    let qaWrote = false;
    const inv = team('failure-park', (i) => {
      if (i.agent.name === 'fe-member') {
        feCalls++;
        if (feCalls === 1) req(i.proposalsDir as string, 'fe-member.req', 'FE-FAILURE');
        return feCalls === 1 ? FAIL : OK;
      }
      if (!qaWrote) { qaWrote = true; req(i.proposalsDir as string, 'qa-member.req', 'QA-FAILURE'); }
      return OK;
    }, seen);
    setFaultHook((step) => { if (step === 'failure:proposals-parked') throw new Error('crash at failure:proposals-parked'); });
    await expect(go(inv)).rejects.toThrow(/crash at failure:proposals-parked/);
    setFaultHook(undefined);
    expect(feCalls).toBe(1);
    expect(seen).toContain('qa-member');
    expect(listAttempts(runDir()).find((a) => a.agent === 'fe-member')?.status).toBe('started');
    const parked = fs.readdirSync(path.join(slotRoot('fe-member'), 'parked')).filter((n) => n !== 'seed-att');
    expect(parked).toHaveLength(1);
    expect(fs.readFileSync(path.join(slotRoot('fe-member'), 'parked', parked[0] as string, 'fe-member.req'), 'utf8')).toBe(requestFile('fe-member.req', 'FE-FAILURE'));
    const frozen = tree('fe-member');
    fs.mkdirSync(path.join(slotRoot('fe-member'), '.coord'), { mode: 0o700 });
    await go(inv, { resume: true });
    expect(tree('fe-member')).toEqual(frozen);
    expect(listAttempts(runDir()).find((a) => a.agent === 'fe-member' && a.status === 'started')).toBeTruthy();
    fs.rmdirSync(path.join(slotRoot('fe-member'), '.coord'));
    await go(inv, { resume: true });
    expect(fs.readdirSync(path.join(slotRoot('fe-member'), 'parked')).filter((n) => n !== 'seed-att')).toEqual(parked);
    expect(fs.readFileSync(path.join(slotRoot('fe-member'), 'parked', parked[0] as string, 'fe-member.req'), 'utf8')).toBe(requestFile('fe-member.req', 'FE-FAILURE'));
    expect(idsFor('FE-FAILURE')).toHaveLength(0);
    expect(idsFor('QA-FAILURE')).toHaveLength(1);
    expect(new Set(records().map((r) => r.id)).size).toBe(records().length);
    assertNoReuse('qa-member');
    assertSeed();
  });

  it('settle:aborted: a cancel after the first slot leaves the other uncollected, commits both claims, and a new session collects once', async () => {
    setup();
    seedParked();
    const seen: string[] = [];
    const wrote = new Set<string>();
    const ctl = new AbortController();
    let doneLinks = 0;
    const inv = team('settle-abort', (i) => {
      if (!wrote.has(i.agent.name)) {
        wrote.add(i.agent.name);
        req(i.proposalsDir as string, `${i.agent.name}.req`, i.agent.name === 'fe-member' ? 'FE-ABORT' : 'QA-ABORT');
      }
      return OK;
    }, seen);
    const first = await go(inv, {
      signal: ctl.signal,
      collect: { fault: (p) => { if (p === 'collection:done' && ++doneLinks === 1) ctl.abort(); } },
    });
    expect(first.endReason).toBe('cancelled');
    expect(seen).toContain('fe-member');
    expect(seen).toContain('qa-member'); // woken in the aborted pass
    const collected = (['FE-ABORT', 'QA-ABORT'] as const).filter((m) => idsFor(m).length === 1);
    const waiting = (['FE-ABORT', 'QA-ABORT'] as const).filter((m) => idsFor(m).length === 0);
    expect(collected).toHaveLength(1);
    expect(waiting).toHaveLength(1);
    const waitingSlot = waiting[0] === 'FE-ABORT' ? 'fe-member' : 'qa-member';
    expect(fs.readFileSync(path.join(slotRoot(waitingSlot), 'proposals', `${waitingSlot}.req`), 'utf8')).toContain(waiting[0] as string);
    for (const agent of ['fe-member', 'qa-member']) expect(claims().find((c) => c.agent === agent)?.status).toBe('committed');
    const keptId = idsFor(collected[0] as string)[0] as string;
    expire(keptId);
    const second = await go(inv, { resume: true });
    expect(second.endReason).toBe('done');
    expect(idsFor('QA-ABORT')).toHaveLength(1);
    expect(idsFor('FE-ABORT')).toHaveLength(1);
    expect(idsFor(collected[0] as string)).toEqual([keptId]);
    expect(statusOf(keptId)).toBe('expired');
    expect(new Set(records().map((r) => r.id)).size).toBe(records().length);
    assertNoReuse('fe-member');
    assertNoReuse('qa-member');
    assertSeed();
  });
});

describe('reviewer probes made durable', () => {
  it('a cancelled wake whose park fails keeps the bytes, is not retried, and a new session wakes on an empty directory', async () => {
    setup();
    seedParked();
    const seen: string[] = [];
    const entry: string[][] = [];
    let feCalls = 0;
    const inv = team('cancel-park', (i) => {
      const dir = i.proposalsDir as string;
      entry.push([i.agent.name, ...fs.readdirSync(dir)]);
      if (i.agent.name === 'fe-member') {
        feCalls++;
        if (feCalls === 1) { req(dir, 'fe-member.req', 'FE-CANCEL'); return CANCEL; }
        return OK;
      }
      if (!fs.existsSync(path.join(dir, 'qa-member.req'))) req(dir, 'qa-member.req', 'QA-CANCEL');
      return OK;
    }, seen);
    const failing = {
      ...defaultDirIo,
      renameSync: ((from: fs.PathLike, to: fs.PathLike) => {
        if (String(from).includes(`${path.sep}fe-member${path.sep}`)) throw Object.assign(new Error('secret-cancel-park'), { code: 'EXDEV' });
        return fs.renameSync(from, to);
      }) as typeof fs.renameSync,
    };
    const first = await go(inv, { collect: { io: failing } });
    expect(feCalls).toBe(1);
    expect(first.endReason).not.toBe('agent_failed');
    expect(fs.readFileSync(path.join(slotRoot('fe-member'), 'proposals', 'fe-member.req'), 'utf8')).toContain('FE-CANCEL');
    expect(idsFor('FE-CANCEL')).toHaveLength(0);
    expect(idsFor('QA-CANCEL')).toHaveLength(1);
    expect(fs.readFileSync(path.join(runDir(), 'log.jsonl'), 'utf8')).not.toContain('secret-cancel-park');
    const callsAtCrash = feCalls;
    await go(inv, { resume: true });
    expect(feCalls).toBe(callsAtCrash + 1);
    const feEntry = entry.filter((e) => e[0] === 'fe-member');
    expect(feEntry.at(-1)).toEqual(['fe-member']); // resumed wake saw an empty proposals directory
    const parked = fs.readdirSync(path.join(slotRoot('fe-member'), 'parked')).filter((n) => n !== 'seed-att');
    expect(parked).toHaveLength(1);
    expect(fs.readFileSync(path.join(slotRoot('fe-member'), 'parked', parked[0] as string, 'fe-member.req'), 'utf8')).toBe(requestFile('fe-member.req', 'FE-CANCEL'));
    expect(idsFor('FE-CANCEL')).toHaveLength(0);
    expect(idsFor('QA-CANCEL')).toHaveLength(1);
    expect(new Set(records().map((r) => r.id)).size).toBe(records().length);
    assertSeed();
  });

  it('a throw from snapshotInputs while collecting keeps the slot undeterminable, hides the error, and still commits the claim', async () => {
    setup();
    seedParked();
    const original = snapshotMod.snapshotInputs;
    vi.spyOn(snapshotMod, 'snapshotInputs').mockImplementation((project, slot, config, proposals) => {
      if (slot === 'fe-member' && proposals && fs.existsSync(proposals) && fs.readdirSync(proposals).some((n) => n.endsWith('.req'))) {
        throw new Error('RAW-SNAPSHOT-SECRET');
      }
      return original(project, slot, config, proposals);
    });
    const all: WakeInput[] = [];
    const inv = team('snapshot-throw', (i) => {
      req(i.proposalsDir as string, `${i.agent.name}.req`, i.agent.name === 'fe-member' ? 'FE-SNAPSHOT' : 'QA-SNAPSHOT');
      return OK;
    }, [], all);
    const summary = await go(inv);
    expect(summary.endReason).toBe('done');
    expect(all.some((i) => i.agent.name === 'fe-member')).toBe(true); // the throw is after the wake, not instead of it
    const gate = JSON.parse(fs.readFileSync(path.join(runDir(), 'approval-gate.json'), 'utf8')) as { slots: Record<string, { code: string }> };
    expect(gate.slots['fe-member']?.code).toBe('UNDETERMINABLE');
    expect(fs.readFileSync(path.join(slotRoot('fe-member'), 'proposals', 'fe-member.req'), 'utf8')).toContain('FE-SNAPSHOT');
    expect(idsFor('FE-SNAPSHOT')).toHaveLength(0);
    expect(idsFor('QA-SNAPSHOT')).toHaveLength(1);
    expect(claims().find((c) => c.agent === 'fe-member')?.status).toBe('committed');
    const lead = all.filter((i) => i.agent.name === 'lead').map((i) => i.userPrompt).join('\n');
    expect(lead).toContain('Approval requests of this agent were kept where they are but were not collected.');
    expect(lead).not.toContain('RAW-SNAPSHOT-SECRET');
    const disk = `${fs.readFileSync(path.join(runDir(), 'log.jsonl'), 'utf8')}\n${fs.readFileSync(path.join(runDir(), 'approval-gate.json'), 'utf8')}`;
    expect(disk).not.toContain('RAW-SNAPSHOT-SECRET');
    expect(new Set(records().map((r) => r.id)).size).toBe(records().length);
    assertSeed();
  });
});
