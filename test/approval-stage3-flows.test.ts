// Approval stage 3, S3b/S3c: request collection in the run lifecycle (settle, pre-claim classification, grants, park on failure).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Invoker, WakeInput, WakeResult } from '../src/adapters/index.js';
import { defaultDirIo } from '../src/approval-budget.js';
import { loadFreshConfig } from '../src/approval-runtime.js';
import { unboundSnapshotInputs } from '../src/approval-snapshot.js';
import { baselineFor, GATE_TEXT } from '../src/approval-wake-gate.js';
import { runTeam, type RunSummary } from '../src/dispatcher.js';
import { canonicalPath } from '../src/paths.js';
import { outboxDir, setOsSandboxForTest, writePolicy } from '../src/policy.js';
import { bindRunProject, loadRunState } from '../src/run-store.js';
import { prepareTask } from '../src/task.js';
import { initGitRepo, FULL_DONE, makeEnv, withSections, write, type TestEnv } from './helpers.js';
import type { RunOptions } from '../src/dispatcher.js';

vi.setConfig({ testTimeout: 30_000 });

const OK: WakeResult = { ok: true, text: '', exitCode: 0, timedOut: false };
const PREMISE_OK = { platform: 'linux' as const, sandboxAvailable: () => true };
let env: TestEnv;
let tool: string;
beforeEach(() => setOsSandboxForTest(true));
afterEach(() => { setOsSandboxForTest(undefined); env?.cleanup(); });

let seq = 0;
const mail = (i: WakeInput, to: string, subject: string, type = 'reply') =>
  write(path.join(outboxDir(i.project, i.agent.name), `${String(++seq).padStart(6, '0')}-${Math.random()}.md`),
    `---\nto: ${to}\ntype: ${type}\nsubject: ${subject}\n${type === 'done' ? 'outcome: completed\n' : ''}---\n\n${type === 'done' ? FULL_DONE : withSections(type, `body of ${subject}`)}\n`);
const execYaml = (allow: string): string => `executors:\n  x:\n    command: ["${tool}"]\n    allow: ${allow}\n    timeout_sec: 5\n`;
const ALLOW_FE = '[{project: demo, agent: fe-member}]';
const ALLOW_BOTH = '[{project: demo, agent: fe-member}, {project: demo, agent: qa-member}]';
const setup = (allow = ALLOW_FE) => {
  env = makeEnv();
  tool = path.join(env.root, 'exec', 'bin', 'tool');
  write(tool, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(tool, 0o755);
  fs.writeFileSync(path.join(env.home, 'executors.yaml'), execYaml(allow));
};
const runDir = () => path.join(env.project().paths.runs, 'run-1');
const slotRoot = (slot: string) => path.join(env.home, 'requests', 'projects', 'demo', 'run-1', slot);
const req = (dir: string, name: string, payload = 'do it'): void => write(path.join(dir, name), `executor: x\nsummary: s ${name}\n\n${payload}\n`);
const records = (): Record<string, any>[] => {
  const dir = path.join(env.home, 'approvals');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((n) => /^[0-9a-f]{24}$/.test(n)).sort().map((n) => JSON.parse(fs.readFileSync(path.join(dir, n, 'record.json'), 'utf8')));
};
const events = (): Record<string, any>[] => fs.readFileSync(path.join(runDir(), 'log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

interface Go { resume?: boolean; solo?: string; signal?: AbortSignal; collect?: RunOptions['approvalCollect']; keepRun?: boolean }
async function go(invoker: Invoker, o: Go = {}): Promise<RunSummary> {
  const project = env.project();
  const rd = path.join(project.paths.runs, 'run-1');
  const common = { project, runDir: rd, invoker, log: () => {}, sleep: async () => {}, approvalPremise: PREMISE_OK, signal: o.signal, soloAgent: o.solo, approvalCollect: o.collect };
  if (o.resume) return runTeam({ ...common, resume: loadRunState(rd) });
  return runTeam({ ...common, task: prepareTask({ text: 'build', cwd: env.root, runDir: rd }) });
}
/** The lead sends a task to each of `to` on its first wake, and `done` once every one of `await` has replied. Members run `member`. */
function team(to: string[], member: (i: WakeInput) => WakeResult | Promise<WakeResult>, seen: WakeInput[] = []): Invoker {
  let leadWakes = 0;
  const heard = new Set<string>();
  return async (i) => {
    seen.push(i);
    if (i.agent.name === 'lead') {
      for (const n of to) if (i.userPrompt.includes(`from: ${n}`)) heard.add(n);
      if (++leadWakes === 1) for (const t of to) mail(i, t, `work for ${t}`, 'task');
      else if (to.every((n) => heard.has(n))) mail(i, 'lead', 'finished', 'done');
      return OK;
    }
    const r = await member(i);
    if (r.ok) mail(i, 'lead', `reply from ${i.agent.name}`);
    return r;
  };
}
const FAIL: WakeResult = { ok: false, text: '', exitCode: 1, timedOut: false, error: 'boom' };

describe('settle collects finished output', () => {
  it('collects a member\'s requests after its wake, with the grant it had and the qualification the gate judged', async () => {
    setup();
    const seen: WakeInput[] = [];
    const s = await go(team(['fe-member'], (i) => { req(i.proposalsDir as string, 'a.req'); write(path.join(i.proposalsDir as string, 'bad.req'), 'no header\n'); return OK; }, seen));
    expect(s.endReason).toBe('done');
    const fe = seen.find((i) => i.agent.name === 'fe-member') as WakeInput;
    const proposals = canonicalPath(path.join(slotRoot('fe-member'), 'proposals'));
    expect(fe.proposalsDir).toBe(proposals);
    expect(writePolicy(fe.project, fe.agent, fe.proposalsDir).allowDirs).toContain(proposals);
    expect(fe.systemPrompt).toContain(proposals);
    expect(fe.userPrompt).toContain(proposals);
    expect(fs.readdirSync(proposals)).toEqual([]);
    expect(fs.readdirSync(path.join(slotRoot('fe-member'), 'collected', '1')).sort()).toEqual(['a.req', 'bad.req']);
    expect(fs.existsSync(path.join(slotRoot('fe-member'), 'collected', '1.done'))).toBe(true);
    const recs = records();
    expect(recs.map((r) => r.disposition).sort()).toEqual(['denied', 'pending']);
    const pending = recs.find((r) => r.disposition === 'pending') as Record<string, any>;
    const config = (loadFreshConfig(env.home, { userHome: os.homedir() }) as { config: any }).config;
    const bound = bindRunProject(env.project(), runDir(), 'run');
    expect(pending.qualification.sha256).toBe(baselineFor(bound, 'fe-member', config, 'run-1').hashes.get('x'));
    expect(pending.origin.full_writable.dirs).toContain(proposals);
    expect(pending.proposer).toEqual({ role: 'fe-member', slot: 'fe-member' });
  });

  it('a successful wake whose outbox mail is rejected still has its requests collected (the rejection does not undo the collection)', async () => {
    setup();
    const s = await go(team(['fe-member'], (i) => {
      req(i.proposalsDir as string, 'a.req');
      write(path.join(outboxDir(i.project, i.agent.name), '000900-malformed.md'), 'no frontmatter at all\n');
      return OK;
    }));
    expect(s.endReason).toBe('done');
    expect(fs.existsSync(path.join(runDir(), 'mail', 'outbox', 'fe-member', 'rejected', '000900-malformed.md'))).toBe(true);
    expect(events().some((e) => e.event === 'rejected')).toBe(true);
    expect(fs.readdirSync(path.join(slotRoot('fe-member'), 'collected', '1'))).toEqual(['a.req']);
    expect(fs.existsSync(path.join(slotRoot('fe-member'), 'collected', '1.done'))).toBe(true);
    expect(records().map((r) => r.disposition)).toEqual(['pending']);
  });
  it('claim wakes only: the lead (not enrolled) is told nothing and granted nothing', async () => {
    setup();
    const seen: WakeInput[] = [];
    await go(team(['fe-member'], () => OK, seen));
    const lead = seen.find((i) => i.agent.name === 'lead') as WakeInput;
    expect('proposalsDir' in lead).toBe(false);
    expect(`${lead.systemPrompt}\n${lead.userPrompt}`).not.toMatch(/Approval request|\.req|proposals/);
    expect(writePolicy(lead.project, lead.agent).allowDirs.some((d) => d.includes('requests'))).toBe(false);
  });

  it('tidy, verify, format and call never name a request directory (only the claim wake in run-session does)', () => {
    const src = path.join(__dirname, '..', 'src');
    const users = fs.readdirSync(src).filter((f) => f.endsWith('.ts') && fs.readFileSync(path.join(src, f), 'utf8').includes('proposalsDir')).sort();
    expect(users).toEqual(['approval-snapshot.ts', 'policy.ts', 'prompt.ts', 'run-session.ts']);
    for (const f of ['memory-tidy.ts', 'verify.ts', 'format.ts', 'call.ts']) expect(users).not.toContain(f);
    expect(fs.readdirSync(path.join(src, 'adapters')).filter((f) => fs.readFileSync(path.join(src, 'adapters', f), 'utf8').includes('proposalsDir')).sort()).toEqual(['claude.ts', 'types.ts']);
  });

  it('a solo wake carries the grant and the prompt path, and its request is collected with the solo qualification', async () => {
    setup();
    let input: WakeInput | undefined;
    const s = await go(async (i) => { input = i; req(i.proposalsDir as string, 's.req'); mail(i, 'fe-member', 'finished', 'done'); return OK; }, { solo: 'fe-member' });
    expect(s.endReason).toBe('done');
    const i = input as WakeInput;
    const proposals = canonicalPath(path.join(slotRoot('fe-member'), 'proposals'));
    expect(i.proposalsDir).toBe(proposals);
    expect(i.systemPrompt).toContain(proposals);
    expect(i.userPrompt).toContain(proposals);
    const recs = records();
    expect(recs).toHaveLength(1);
    const config = (loadFreshConfig(env.home, { userHome: os.homedir() }) as { config: any }).config;
    const unbound = unboundSnapshotInputs(env.project(), 'fe-member', config, undefined, 'solo');
    expect(recs[0]?.qualification.sha256).toBe(
      (await import('../src/approval-origin.js')).qualificationHash(unbound.get('x') as never),
    );
  });
});

describe('failure, cancel and retry', () => {
  it('a failed attempt\'s requests are set aside, never collected; every retry has its own empty directory, grant and prompt path', async () => {
    setup();
    const seen: WakeInput[] = [];
    const dirsAtEntry: string[][] = [];
    let calls = 0;
    const s = await go(team(['fe-member'], (i) => {
      dirsAtEntry.push(fs.readdirSync(i.proposalsDir as string));
      if (++calls === 1) { req(i.proposalsDir as string, 'x.req', 'from the failed attempt'); return FAIL; }
      req(i.proposalsDir as string, 'ok.req');
      return OK;
    }, seen));
    expect(s.endReason).toBe('done');
    const fe = seen.filter((i) => i.agent.name === 'fe-member');
    expect(fe).toHaveLength(2);
    for (const i of fe) {
      expect(i.proposalsDir).toBe(canonicalPath(path.join(slotRoot('fe-member'), 'proposals')));
      expect(i.systemPrompt).toContain(i.proposalsDir as string);
      expect(i.userPrompt).toContain(i.proposalsDir as string);
    }
    expect(dirsAtEntry).toEqual([[], []]);
    const parked = fs.readdirSync(path.join(slotRoot('fe-member'), 'parked'));
    expect(parked).toHaveLength(1);
    expect(fs.readFileSync(path.join(slotRoot('fe-member'), 'parked', parked[0] as string, 'x.req'), 'utf8')).toContain('from the failed attempt');
    expect(fs.readdirSync(path.join(slotRoot('fe-member'), 'collected', '1'))).toEqual(['ok.req']);
    expect(records()).toHaveLength(1);
  });

  it('when the failed attempt\'s requests cannot be set aside only that slot stops; its requests and unread mail stay, the lead is told once, the run goes on', async () => {
    setup();
    let calls = 0;
    const leadSeen: WakeInput[] = [];
    const failingRename = { ...defaultDirIo, renameSync: () => { throw Object.assign(new Error('secret-errno-text'), { code: 'EXDEV' }); } } as typeof defaultDirIo;
    const s = await go(team(['fe-member'], (i) => { calls++; req(i.proposalsDir as string, 'x.req'); return FAIL; }, leadSeen), { collect: { io: failingRename } });
    expect(calls).toBe(1); // no retry, no fallback, not called again while blocked
    expect(s.endReason).not.toBe('agent_failed');
    expect(events().some((e) => e.event === 'approval_collect' && e.op === 'park' && e.class === 'io')).toBe(true);
    expect(fs.readFileSync(path.join(slotRoot('fe-member'), 'proposals', 'x.req'), 'utf8')).toContain('do it'); // nothing lost
    expect(records()).toHaveLength(0);
    const gate = JSON.parse(fs.readFileSync(path.join(runDir(), 'approval-gate.json'), 'utf8'));
    expect(gate.slots['fe-member'].class).toBe('skipped'); // the later pass of the gate may name the cause more exactly
    expect(['UNDETERMINABLE', 'DIR_ANOMALY', 'RESIDUAL_OUTPUT']).toContain(gate.slots['fe-member'].code);
    const notices = leadSeen.filter((i) => i.agent.name === 'lead' && i.userPrompt.includes('fe-member cannot be woken'));
    expect(notices.length).toBeGreaterThan(0);
    expect(notices[0]?.userPrompt).toContain('could not be set aside');
    expect(notices[0]?.userPrompt).not.toContain('secret-errno-text');
    const log = fs.readFileSync(path.join(runDir(), 'log.jsonl'), 'utf8');
    expect(log).not.toContain('secret-errno-text');
    expect(fs.readFileSync(path.join(runDir(), 'approval-gate.json'), 'utf8')).not.toContain('secret-errno-text');
    // a new session: the abandoned claim's leftovers are classified from the latest attempt and set aside; the redo is woken on an empty directory
    const entry: string[][] = [];
    const second = await go(team(['fe-member'], (i) => { entry.push(fs.readdirSync(i.proposalsDir as string)); return OK; }), { resume: true });
    expect(second.endReason).toBe('done');
    expect(entry[0]).toEqual([]);
    expect(fs.readdirSync(path.join(slotRoot('fe-member'), 'parked')).length).toBe(1);
    expect(records()).toHaveLength(0);
  });

  it('a failed park of one slot leaves the healthy pending slot running, and the blocked slot is not woken again', async () => {
    setup(ALLOW_BOTH);
    const seen: string[] = [];
    const io = { ...defaultDirIo, renameSync: (src: fs.PathLike, dest: fs.PathLike) => {
      if (String(src).endsWith('/fe-member/proposals')) throw Object.assign(new Error('x'), { code: 'EXDEV' });
      return defaultDirIo.renameSync(src, dest);
    } } as typeof defaultDirIo;
    const s = await go(team(['fe-member', 'qa-member'], (i) => {
      seen.push(i.agent.name); req(i.proposalsDir as string, 'x.req');
      return i.agent.name === 'fe-member' ? FAIL : OK;
    }), { collect: { io } });
    expect(seen).toContain('qa-member');
    expect(seen.filter((n) => n === 'fe-member')).toHaveLength(1);
    expect(s.endReason).not.toBe('agent_failed');
    expect(fs.existsSync(path.join(slotRoot('fe-member'), 'proposals', 'x.req'))).toBe(true);
    const gate = JSON.parse(fs.readFileSync(path.join(runDir(), 'approval-gate.json'), 'utf8'));
    expect(gate.slots['fe-member']).toBeDefined();
    expect(gate.slots['qa-member']).toBeUndefined();
  });

  it('a collection view that cannot be read after a successful wake gates the slot, keeps the request and tells the lead (no raw error text)', async () => {
    setup();
    const leadSeen: WakeInput[] = [];
    const s = await go(team(['fe-member'], (i) => {
      req(i.proposalsDir as string, 'x.req');
      fs.writeFileSync(path.join(env.home, 'executors.yaml'), 'executors: [');
      return OK;
    }, leadSeen));
    const gateText = fs.readFileSync(path.join(runDir(), 'approval-gate.json'), 'utf8');
    const gate = JSON.parse(gateText);
    expect(gate.slots['fe-member']).toMatchObject({ class: 'skipped', code: 'UNDETERMINABLE' });
    expect(fs.existsSync(path.join(slotRoot('fe-member'), 'proposals', 'x.req'))).toBe(true);
    expect(records()).toHaveLength(0);
    expect(s.endReason).toBe('done');
    expect(events().some((e) => e.event === 'approval_collect' && e.class === 'io')).toBe(true);
    expect(gateText).not.toContain('executors: [');
    const told = leadSeen.filter((i) => i.agent.name === 'lead' && i.userPrompt.includes('kept where they are but were not collected'));
    expect(told.length).toBeGreaterThan(0);
    expect(told[0]?.userPrompt).not.toContain('executors: [');
    expect(fs.readFileSync(path.join(runDir(), 'log.jsonl'), 'utf8')).not.toContain('executors: [');
  });

  it('DIR_ANOMALY text names every class that produces it', () => {
    const { mail, status } = GATE_TEXT.DIR_ANOMALY;
    for (const cause of ['unsafe directory', 'collected.seq', '.coord', 'hard-link', 'log.jsonl']) expect(mail).toContain(cause);
    for (const cls of ['symlink', 'not_directory', 'corrupt', 'held', 'unsupported', 'approval_collect']) expect(status).toContain(cls);
    // each class comes with its repair step
    for (const fix of ['plain directories', 'fix collected.seq', 'stop all runs, then remove a stale .coord directory', 'filesystem with hard links']) expect(status).toContain(fix);
  });
});

describe('pre-claim classification and isolation of slots', () => {
  it('an enrolled slot with an unsafe or undeterminable request directory is never woken and keeps its files; the other slot keeps running', async () => {
    setup(ALLOW_BOTH);
    write(path.join(slotRoot('fe-member'), 'proposals', 'stray.req'), 'executor: x\n\nleft by nobody we know\n'); // no attempt explains it
    fs.mkdirSync(slotRoot('qa-member'), { recursive: true });
    fs.symlinkSync(env.root, path.join(slotRoot('qa-member'), 'proposals'));
    const seen: string[] = [];
    const s = await go(team(['fe-member', 'qa-member'], (i) => { seen.push(i.agent.name); return OK; }));
    expect(seen).toEqual([]); // both are skipped, the lead still ends the run (it is told, and does the work itself)
    expect(s.endReason).not.toBe('lead_failed');
    expect(fs.readFileSync(path.join(slotRoot('fe-member'), 'proposals', 'stray.req'), 'utf8')).toContain('left by nobody');
    expect(fs.lstatSync(path.join(slotRoot('qa-member'), 'proposals')).isSymbolicLink()).toBe(true);
    expect(records()).toHaveLength(0);
    const gate = JSON.parse(fs.readFileSync(path.join(runDir(), 'approval-gate.json'), 'utf8')).slots;
    expect(gate['fe-member']).toMatchObject({ class: 'skipped', code: 'UNDETERMINABLE' });
    expect(gate['qa-member']).toMatchObject({ class: 'skipped', code: 'DIR_ANOMALY' });
  });

  it('a slot with an unsafe directory does not stop a healthy enrolled slot from being woken and collected', async () => {
    setup(ALLOW_BOTH);
    fs.mkdirSync(slotRoot('qa-member'), { recursive: true });
    fs.symlinkSync(env.root, path.join(slotRoot('qa-member'), 'proposals'));
    const seen: string[] = [];
    const s = await go(team(['fe-member'], (i) => { seen.push(i.agent.name); req(i.proposalsDir as string, 'a.req'); return OK; }));
    expect(s.endReason).toBe('done');
    expect(seen).toEqual(['fe-member']);
    expect(records()).toHaveLength(1);
  });
});

describe('settle:aborted', () => {
  it('a cancel after the first slot leaves the others uncollected, the claims still commit, and resume collects them once', async () => {
    setup(ALLOW_BOTH);
    initGitRepo(env.repo); // worktree mode: both members run in one batch
    const ctl = new AbortController();
    const done = { n: 0 };
    const collect: RunOptions['approvalCollect'] = { fault: (point) => { if (point === 'collection:done' && ++done.n === 1) ctl.abort(); } };
    const first = await go(team(['fe-member', 'qa-member'], (i) => { req(i.proposalsDir as string, `${i.agent.name}.req`); return OK; }), { signal: ctl.signal, collect });
    expect(first.endReason).toBe('cancelled');
    expect(events().some((e) => e.event === 'approval_collect' && e.class === 'cancelled')).toBe(true);
    const before = records().length;
    expect(before).toBe(1);
    // the second slot's output is still in its request directory, not lost
    const left = ['fe-member', 'qa-member'].filter((n) => fs.readdirSync(path.join(slotRoot(n), 'proposals')).length > 0);
    expect(left).toHaveLength(1);
    await go(team(['fe-member', 'qa-member'], () => OK), { resume: true });
    expect(records()).toHaveLength(2);
    expect(new Set(records().map((r) => r.id)).size).toBe(2);
  });
});
