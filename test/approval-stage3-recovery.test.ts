// Approval stage 3, S3c: recovery hooks of `recoverRunMail` and the crash/re-entry matrix of the lifecycle fault points.
// Every crash is a thrown fault; every re-entry is a new session that resumes the run.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Invoker, WakeInput, WakeResult } from '../src/adapters/index.js';
import { runTeam, type RunSummary } from '../src/dispatcher.js';
import { beginAttempt, claimMessages, finishAttempt, finishLoadedAttempt, listAttempts, loadAttempt, loadClaim, markOutputReady, recoverRunMail, setFaultHook } from '../src/message-store.js';
import { outboxDir, setOsSandboxForTest } from '../src/policy.js';
import { loadRunState } from '../src/run-store.js';
import { prepareTask } from '../src/task.js';
import { FULL_DONE, makeEnv, withSections, write, type TestEnv } from './helpers.js';

vi.setConfig({ testTimeout: 30_000 });

const OK: WakeResult = { ok: true, text: '', exitCode: 0, timedOut: false };
const FAIL: WakeResult = { ok: false, text: '', exitCode: 1, timedOut: false, error: 'boom' };
const PREMISE_OK = { platform: 'linux' as const, sandboxAvailable: () => true };
let env: TestEnv;
let tool: string;
beforeEach(() => setOsSandboxForTest(true));
afterEach(() => { setFaultHook(undefined); setOsSandboxForTest(undefined); env?.cleanup(); });

let seq = 0;
const mail = (i: WakeInput, to: string, subject: string, type = 'reply') =>
  write(path.join(outboxDir(i.project, i.agent.name), `${String(++seq).padStart(6, '0')}-${Math.random()}.md`),
    `---\nto: ${to}\ntype: ${type}\nsubject: ${subject}\n${type === 'done' ? 'outcome: completed\n' : ''}---\n\n${type === 'done' ? FULL_DONE : withSections(type, `body of ${subject}`)}\n`);
const setup = () => {
  env = makeEnv();
  tool = path.join(env.root, 'exec', 'bin', 'tool');
  write(tool, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(tool, 0o755);
  fs.writeFileSync(path.join(env.home, 'executors.yaml'), `executors:\n  x:\n    command: ["${tool}"]\n    allow: [{project: demo, agent: fe-member}]\n    timeout_sec: 5\n`);
};
const runDir = () => path.join(env.project().paths.runs, 'run-1');
const root = () => path.join(env.home, 'requests', 'projects', 'demo', 'run-1', 'fe-member');
const req = (dir: string, name: string, payload: string): void => write(path.join(dir, name), `executor: x\n\n${payload}\n`);
const records = (): Record<string, any>[] => {
  const dir = path.join(env.home, 'approvals');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((n) => /^[0-9a-f]{24}$/.test(n)).sort().map((n) => JSON.parse(fs.readFileSync(path.join(dir, n, 'record.json'), 'utf8')));
};
const sub = (name: string): string[] => (fs.existsSync(path.join(root(), name)) ? fs.readdirSync(path.join(root(), name)).sort() : []);
async function go(invoker: Invoker, resume = false): Promise<RunSummary> {
  const project = env.project();
  const rd = path.join(project.paths.runs, 'run-1');
  const common = { project, runDir: rd, invoker, log: () => {}, sleep: async () => {}, approvalPremise: PREMISE_OK };
  if (resume) return runTeam({ ...common, resume: loadRunState(rd) });
  return runTeam({ ...common, task: prepareTask({ text: 'build', cwd: env.root, runDir: rd }) });
}
/** Lead tasks fe-member once and finishes after its reply. `member` runs for fe-member's wakes (its n-th wake counts across sessions). */
function team(member: (i: WakeInput, n: number) => WakeResult): { invoker: Invoker; wakes: WakeInput[] } {
  const wakes: WakeInput[] = [];
  let n = 0;
  let sent = false;
  let heard = false;
  const invoker: Invoker = async (i) => {
    if (i.agent.name === 'lead') {
      if (i.userPrompt.includes('from: fe-member')) heard = true;
      if (!sent) { sent = true; mail(i, 'fe-member', 'work', 'task'); } else if (heard) mail(i, 'lead', 'finished', 'done');
      return OK;
    }
    wakes.push(i);
    const r = member(i, ++n);
    if (r.ok) mail(i, 'lead', 'reply');
    return r;
  };
  return { invoker, wakes };
}
/** Crash the first time `point` is reached after fe-member has been woken (the lead's own wakes pass the same points). */
const crashAt = (point: string, t?: { wakes: WakeInput[] }): void => setFaultHook((step) => { if (step === point && (!t || t.wakes.length > 0)) throw new Error(`crash at ${point}`); });
const noDuplicates = (): void => {
  const ids = records().map((r) => r.id);
  expect(new Set(ids).size).toBe(ids.length);
  const seqs = sub('collected').filter((n) => /^\d+$/.test(n));
  expect(new Set(seqs).size).toBe(seqs.length);
};

describe('crash matrix: lifecycle fault points, each followed by a fresh session', () => {
  it('attempt:output-ready: the claim is still claimed, so recovery sets the output aside before abandoning; the unfinished wake\'s requests are never collected', async () => {
    setup();
    const t = team((i) => { req(i.proposalsDir as string, 'first.req', 'FIRST'); return OK; });
    crashAt('attempt:output-ready', t);
    await expect(go(t.invoker)).rejects.toThrow(/crash at attempt:output-ready/);
    setFaultHook(undefined);
    expect(fs.readdirSync(path.join(root(), 'proposals'))).toEqual(['first.req']); // output exists, nothing collected yet
    const s = await go(t.invoker, true);
    expect(s.endReason).toBe('done');
    expect(sub('parked')).toHaveLength(1);
    const parkedDir = path.join(root(), 'parked', sub('parked')[0] as string);
    expect(fs.readFileSync(path.join(parkedDir, 'first.req'), 'utf8')).toContain('FIRST'); // bytes kept, never collected
    expect(sub('collected')).toEqual([]);
    expect(records()).toHaveLength(0); // parked output is never collected, so it can never become a request
    expect(fs.readdirSync(path.join(root(), 'proposals'))).toEqual([]);
    noDuplicates();
  });

  it('recovery:proposals-parked: a crash between the park and the abandon repeats harmlessly', async () => {
    setup();
    const t = team((i) => { req(i.proposalsDir as string, 'first.req', 'FIRST'); return OK; });
    crashAt('attempt:output-ready', t);
    await expect(go(t.invoker)).rejects.toThrow();
    crashAt('recovery:proposals-parked');
    await expect(go(t.invoker, true)).rejects.toThrow(/crash at recovery:proposals-parked/);
    setFaultHook(undefined);
    expect(sub('parked')).toHaveLength(1); // the set-aside happened once, the claim is still `claimed`
    expect(fs.readdirSync(path.join(root(), 'proposals'))).toEqual([]);
    const claims = fs.readdirSync(path.join(runDir(), 'mail', 'claims')).map((f) => JSON.parse(fs.readFileSync(path.join(runDir(), 'mail', 'claims', f), 'utf8')));
    expect(claims.find((c) => c.agent === 'fe-member')?.status).toBe('claimed');
    const s = await go(t.invoker, true);
    expect(s.endReason).toBe('done');
    expect(sub('parked')).toHaveLength(1); // not parked again
    expect(fs.readdirSync(path.join(root(), 'parked', sub('parked')[0] as string))).toEqual(['first.req']);
    expect(sub('collected')).toEqual([]);
    expect(records()).toHaveLength(0);
    noDuplicates();
  });

  it('a history of abandoned claims is not parked again on a later resume', async () => {
    setup();
    const t = team((i) => { req(i.proposalsDir as string, 'r.req', 'P'); return OK; });
    crashAt('attempt:output-ready', t);
    await expect(go(t.invoker)).rejects.toThrow();
    setFaultHook(undefined);
    await go(t.invoker, true);
    const parkedBefore = sub('parked');
    const entries = fs.readdirSync(path.join(root(), 'parked', parkedBefore[0] as string));
    await go(t.invoker, true);
    expect(sub('parked')).toEqual(parkedBefore);
    expect(fs.readdirSync(path.join(root(), 'parked', parkedBefore[0] as string))).toEqual(entries);
    noDuplicates();
  });

  it('failure:proposals-parked: a crash after the set-aside and before the attempt is finished never moves it again', async () => {
    setup();
    const t = team((i, n) => { req(i.proposalsDir as string, n === 1 ? 'x.req' : 'ok.req', n === 1 ? 'FAILED-ATTEMPT' : 'GOOD'); return n === 1 ? FAIL : OK; });
    crashAt('failure:proposals-parked');
    await expect(go(t.invoker)).rejects.toThrow(/crash at failure:proposals-parked/);
    setFaultHook(undefined);
    expect(sub('parked')).toHaveLength(1);
    const entry = sub('parked')[0] as string;
    const started = listAttempts(runDir()).find((a) => a.agent === 'fe-member');
    expect(started?.status).toBe('started'); // the crash left it unfinished
    const s = await go(t.invoker, true);
    expect(s.endReason).toBe('done');
    expect(sub('parked')).toEqual([entry]); // same destination, no second rename
    expect(fs.readFileSync(path.join(root(), 'parked', entry, 'x.req'), 'utf8')).toContain('FAILED-ATTEMPT');
    expect(fs.readdirSync(path.join(root(), 'collected', '1'))).toEqual(['ok.req']);
    expect(records()).toHaveLength(1);
    noDuplicates();
  });

  it('collection:before-done in settle: the record is adopted by the next session, no second id, the same sequence', async () => {
    setup();
    const t = team((i) => { req(i.proposalsDir as string, 'a.req', 'ONCE'); return OK; });
    let armed = true;
    const crashing = { fault: (p: string) => { if (armed && p === 'collection:before-done') throw new Error('crash in collection'); } };
    const project = env.project();
    const rd = path.join(project.paths.runs, 'run-1');
    const common = { project, runDir: rd, invoker: t.invoker, log: () => {}, sleep: async () => {}, approvalPremise: PREMISE_OK };
    // The collector turns a throw into a skipped slot (it never escapes), so the first session ends normally with the slot's output still uncollected.
    await runTeam({ ...common, task: prepareTask({ text: 'build', cwd: env.root, runDir: rd }), approvalCollect: crashing });
    armed = false;
    expect(sub('collected')).toEqual(['1']); // no .done yet
    await go(t.invoker, true);
    expect(sub('collected')).toEqual(['1', '1.done']);
    expect(records()).toHaveLength(1);
    noDuplicates();
  });
});

describe('recoverRunMail hooks', () => {
  const dir = (): string => path.join(env.root, 'run');
  const files = (name: string): string => path.join(env.root, 'in', name);
  /** A claim of `agent` with one attempt in `status`; returns both ids. */
  function claimWithAttempt(agent: string, status: 'started' | 'output_ready' | 'claimed-only' | 'abandoned') {
    write(files(`${agent}-${status}.md`), 'x');
    const claim = claimMessages(dir(), agent, [{ file: files(`${agent}-${status}.md`), meta: { id: `m-${agent}-${status}` } } as never]);
    if (status === 'claimed-only') return { claim, attempt: undefined };
    const att = beginAttempt(dir(), claim.id);
    if (status === 'output_ready') { finishAttempt(dir(), att.id, 'output_ready'); markOutputReady(dir(), claim.id); }
    if (status === 'abandoned') { finishAttempt(dir(), att.id, 'failed', { error: 'x' }); const c = loadClaim(dir(), claim.id); fs.writeFileSync(path.join(dir(), 'mail', 'claims', `${claim.id}.json`), JSON.stringify({ ...c, status: 'abandoned' })); }
    return { claim, attempt: att };
  }
  const trace = () => {
    const calls: string[] = [];
    return { calls, opts: { proposalsOf: (a: string) => `/canon/${a}/proposals`, parkProposals: (a: string, id: string, p: string) => { calls.push(`${a}:${id}:${p}`); }, onProposalsError: (a: string) => { calls.push(`error:${a}`); } } };
  };

  it('parks a started attempt and a claimed claim\'s newest attempt before they are failed/abandoned; never a history of abandoned claims or an output_ready claim', () => {
    env = makeEnv();
    const started = claimWithAttempt('fe-member', 'started');
    const ready = claimWithAttempt('qa-member', 'output_ready');
    const old = claimWithAttempt('lead', 'abandoned');
    const claimedOnly = claimWithAttempt('other', 'claimed-only');
    const t = trace();
    const order: string[] = [];
    const rep = recoverRunMail(dir(), { ...t.opts, parkProposals: (a, id, p) => { order.push(`park:${a}:${loadClaim(dir(), started.claim.id).status}`); t.opts.parkProposals(a, id, p); } });
    expect(rep.interrupted.map((x) => x.attempt.id)).toEqual([(started.attempt as { id: string }).id]);
    expect(rep.abandoned.map((c) => c.id).sort()).toEqual([started.claim.id, claimedOnly.claim.id].sort());
    expect(rep.ready.map((c) => c.id)).toEqual([ready.claim.id]);
    expect(t.calls.filter((c) => !c.startsWith('error')).every((c) => c.startsWith('fe-member:'))).toBe(true); // qa (ready), lead (history) and `other` (no attempt) are never parked
    expect(t.calls.some((c) => c.includes(old.claim.id))).toBe(false);
    expect(order[0]).toBe('park:fe-member:claimed'); // parked while the claim was still `claimed`
    expect(loadClaim(dir(), started.claim.id).status).toBe('abandoned');
  });

  it('a park that throws leaves that slot\'s attempt started and claim claimed, tells the caller, and still recovers the other slots', () => {
    env = makeEnv();
    const bad = claimWithAttempt('fe-member', 'started');
    const good = claimWithAttempt('qa-member', 'started');
    const t = trace();
    const rep = recoverRunMail(dir(), { ...t.opts, parkProposals: (a, id, p) => { if (a === 'fe-member') throw new Error('nope'); t.opts.parkProposals(a, id, p); } });
    expect(t.calls.filter((c) => c.startsWith('error'))).toEqual(['error:fe-member']);
    expect(loadAttempt(dir(), (bad.attempt as { id: string }).id).status).toBe('started');
    expect(loadClaim(dir(), bad.claim.id).status).toBe('claimed');
    expect(loadAttempt(dir(), (good.attempt as { id: string }).id).status).toBe('failed');
    expect(loadClaim(dir(), good.claim.id).status).toBe('abandoned');
    expect(rep.interrupted).toHaveLength(1);
    expect(rep.abandoned.map((c) => c.id)).toEqual([good.claim.id]);
  });

  it('without the hooks nothing changes; with scan-verified text (readFile) no attempt or claim file is opened a second time', () => {
    env = makeEnv();
    const a = claimWithAttempt('fe-member', 'started');
    const reads: string[] = [];
    const texts = new Map<string, string>();
    for (const kind of ['attempts', 'claims']) for (const f of fs.readdirSync(path.join(dir(), 'mail', kind))) if (f.endsWith('.json')) texts.set(`${kind}/${f}`, fs.readFileSync(path.join(dir(), 'mail', kind, f), 'utf8'));
    const spy = vi.spyOn(fs, 'readFileSync');
    try {
      const t = trace();
      recoverRunMail(dir(), { ...t.opts, skipFile: () => false, readFile: (name, kind) => { reads.push(`${kind}/${name}`); return texts.get(`${kind}/${name}`); } });
      const direct = spy.mock.calls.map((c) => String(c[0])).filter((p) => /mail[\\/](attempts|claims)[\\/].+\.json$/.test(p));
      expect(direct).toEqual([]); // not one of them was read from disk by recovery
    } finally {
      spy.mockRestore();
    }
    expect(reads.sort()).toEqual([...texts.keys()].sort()); // each file's text was asked for exactly once
    expect(loadAttempt(dir(), (a.attempt as { id: string }).id).status).toBe('failed');
  });

  it('finishLoadedAttempt writes the same bytes as finishAttempt', () => {
    env = makeEnv();
    vi.useFakeTimers({ now: new Date('2026-11-17T00:00:00Z'), toFake: ['Date'] });
    try {
      const a = claimWithAttempt('fe-member', 'started');
      const id = (a.attempt as { id: string }).id;
      const file = path.join(dir(), 'mail', 'attempts', `${id}.json`);
      const before = fs.readFileSync(file);
      finishAttempt(dir(), id, 'failed', { error: 'e', parked: ['p'] });
      const viaId = fs.readFileSync(file);
      fs.writeFileSync(file, before);
      finishLoadedAttempt(dir(), JSON.parse(before.toString('utf8')), 'failed', { error: 'e', parked: ['p'] });
      expect(fs.readFileSync(file).equals(viaId)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
