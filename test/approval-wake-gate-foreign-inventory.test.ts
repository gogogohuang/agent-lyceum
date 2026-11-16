import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Invoker, WakeInput, WakeResult } from '../src/adapters/index.js';
import { runTeam, type RunSummary } from '../src/dispatcher.js';
import { inboxDir, outboxDir, setOsSandboxForTest } from '../src/policy.js';
import { bindRunProject, loadRunState } from '../src/run-store.js';
import { prepareTask } from '../src/task.js';
import { FULL_DONE, makeEnv, withSections, write, type TestEnv } from './helpers.js';

// Only the exact foreign checkout is made to fail; every other git call runs for real.
const gitFail = vi.hoisted(() => ({ cwd: '' }));
vi.mock('node:child_process', async (orig) => {
  const real = await orig<typeof import('node:child_process')>();
  return { ...real, execFileSync: ((cmd: string, args: readonly string[], o: { cwd?: string }) => {
    if (gitFail.cwd && o?.cwd === gitFail.cwd) throw new Error('fatal: SENTINEL-GIT-STDERR');
    return (real.execFileSync as (...a: unknown[]) => unknown)(cmd, args, o);
  }) as typeof real.execFileSync };
});

vi.setConfig({ testTimeout: 20_000 });
const OK: WakeResult = { ok: true, text: '', exitCode: 0, timedOut: false };
const SPATH = 'SENTINEL-PATH-5d9e';
const SPARSE = 'SENTINEL-PARSE-77c1';
let env: TestEnv;
let tool: string;
let proj0: ReturnType<TestEnv['project']>;
let seq = 0;
beforeEach(() => { setOsSandboxForTest(true); gitFail.cwd = ''; });
afterEach(() => { setOsSandboxForTest(undefined); env?.cleanup(); });

const mail = (i: WakeInput, to: string, subject: string, type = 'reply') =>
  write(path.join(outboxDir(i.project, i.agent.name), `${String(++seq).padStart(6, '0')}-${Math.random()}.md`),
    `---\nto: ${to}\ntype: ${type}\nsubject: ${subject}\n${type === 'done' ? 'outcome: completed\n' : ''}---\n\n${type === 'done' ? FULL_DONE : withSections(type, `body of ${subject}`)}\n`);
const setup = (allow: string) => {
  env = makeEnv();
  tool = path.join(env.root, 'exec', 'bin', 'tool');
  write(tool, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(tool, 0o755);
  fs.writeFileSync(path.join(env.home, 'executors.yaml'), `executors:\n  x:\n    command: ["${tool}"]\n    allow: ${allow}\n    timeout_sec: 5\n`);
  // a second project of the same home, with its own checkout
  const foreignRepo = path.join(env.root, `repo-${SPATH}`);
  fs.mkdirSync(foreignRepo);
  fs.mkdirSync(path.join(env.home, 'projects', 'other'), { recursive: true });
  fs.copyFileSync(foreignYaml0(), path.join(env.home, 'projects', 'other', 'project.yaml'));
  fixForeign = () => fs.writeFileSync(foreignYaml(), fs.readFileSync(foreignYaml0(), 'utf8').replace(env.repo, foreignRepo));
  fixForeign();
  proj0 = env.project();
};
let fixForeign: () => void;
const foreignYaml0 = () => path.join(env.home, 'projects', 'demo', 'project.yaml');
const foreignYaml = () => path.join(env.home, 'projects', 'other', 'project.yaml');
const breakForeign = () => fs.writeFileSync(foreignYaml(), `dir: [${SPARSE}\n`);
const runDirOf = () => path.join(proj0.paths.runs, 'run-1');
const events = () => fs.readFileSync(path.join(runDirOf(), 'log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const woke = () => events().filter((e) => e.event === 'wake').map((e) => e.agent as string);
const gateEntries = () => JSON.parse(fs.readFileSync(path.join(runDirOf(), 'approval-gate.json'), 'utf8')).slots;
const filesUnder = (dir: string): string[] => fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? filesUnder(path.join(dir, e.name)) : [path.join(dir, e.name)])) : [];
const claimsOf = (agent: string): string[] => filesUnder(path.join(runDirOf(), 'mail', 'claims')).concat(filesUnder(path.join(runDirOf(), 'mail', 'attempts'))).filter((f) => path.basename(f).includes(`-${agent}-`));
const notices = (re: RegExp): string[] => filesUnder(inboxDir(bindRunProject(proj0, runDirOf(), 'run'), 'lead')).map((f) => fs.readFileSync(f, 'utf8')).filter((t) => re.test(t));

async function go(invoker: Invoker, resume = false): Promise<RunSummary> {
  const project = proj0;
  const runDir = runDirOf();
  const common = { project, runDir, invoker, log: () => {}, sleep: async () => {} };
  return resume ? runTeam({ ...common, resume: loadRunState(runDir) }) : runTeam({ ...common, task: prepareTask({ text: 'build', cwd: env.root, runDir }) });
}
const everything = (): string => [fs.readFileSync(path.join(runDirOf(), 'log.jsonl'), 'utf8'), fs.readFileSync(path.join(runDirOf(), 'approval-gate.json'), 'utf8'), ...filesUnder(path.join(proj0.paths.runs, 'run-1')).filter((f) => f.includes(`${path.sep}inbox${path.sep}`)).map((f) => fs.readFileSync(f, 'utf8'))].join('\n');

/**
 * fe-member is enrolled and holds mail; qa-member is not and holds independent work. The lead breaks the other project in its first wake;
 * qa-member's wake (the pass in which fe-member is skipped) repairs it; fe-member must then be woken by the very next pass of the same process.
 */
function betweenPass(breakIt: () => void, repairIt: () => void, probe: () => void): Invoker {
  let leadWakes = 0;
  const heard = new Set<string>();
  return async (i) => {
    if (i.agent.name === 'lead') {
      for (const n of ['fe-member', 'qa-member']) if (i.userPrompt.includes(`from: ${n}`)) heard.add(n);
      if (++leadWakes === 1) { mail(i, 'fe-member', 'fe work A', 'task'); mail(i, 'qa-member', 'qa work B', 'task'); breakIt(); } else if (heard.size === 2) mail(i, 'lead', 'finished', 'done');
    } else if (i.agent.name === 'qa-member') { probe(); repairIt(); mail(i, 'lead', 'qa replied'); } else mail(i, 'lead', 'fe replied');
    return OK;
  };
}

describe('foreign project inventory unknown', () => {
  for (const [kind, breakIt, repairIt] of [
    ['invalid YAML', breakForeign, () => fixForeign()],
    ['git failure in its checkout', () => { fs.mkdirSync(path.join(env.root, `repo-${SPATH}`, '.git')); gitFail.cwd = path.join(env.root, `repo-${SPATH}`); }, () => { gitFail.cwd = ''; fs.rmSync(path.join(env.root, `repo-${SPATH}`, '.git'), { recursive: true }); }],
  ] as [string, () => void, () => void][]) {
    it(`${kind}: the enrolled slot is skipped for one pass (no claim, no invoke), then woken by the next pass of the same process`, async () => {
      setup('[{project: demo, agent: fe-member}]');
      const seenInProbe: unknown[] = [];
      const s = await go(betweenPass(breakIt, repairIt, () => seenInProbe.push({ entry: gateEntries()['fe-member'], claims: claimsOf('fe-member'), woke: woke().filter((n) => n === 'fe-member').length })));
      expect(seenInProbe).toEqual([{ entry: expect.objectContaining({ class: 'skipped', code: 'UNDETERMINABLE' }), claims: [], woke: 0 }]);
      expect(s.endReason).toBe('done');
      const order = woke();
      expect(order.indexOf('qa-member')).toBeLessThan(order.indexOf('fe-member'));
      expect(gateEntries()).toEqual({}); // skipped cleared, never refused
      expect(claimsOf('fe-member').length).toBeGreaterThan(0);
      expect(notices(/Approval safety or output state could not be determined/)).toHaveLength(1);
      expect(events().filter((e) => e.event === 'approval_gate')).toEqual([expect.objectContaining({ slot: 'fe-member', class: 'skipped', code: 'UNDETERMINABLE', premises: ['containment'] })]);
      const all = everything();
      for (const leak of [SPATH, SPARSE, 'SENTINEL-GIT-STDERR']) expect(all).not.toContain(leak);
    });
  }

  it('foreign still broken when no other work is left: the run ends idle (not lead_failed), mail stays, resume after the repair wakes the slot', async () => {
    setup('[{project: demo, agent: fe-member}]');
    let leadWakes = 0;
    const s = await go(async (i) => { if (i.agent.name === 'lead' && ++leadWakes === 1) { mail(i, 'fe-member', 'fe work', 'task'); breakForeign(); } return OK; });
    expect(s.endReason).toBe('idle');
    expect(woke().every((n) => n === 'lead')).toBe(true);
    expect(s.rounds).toBe(woke().length);
    expect(claimsOf('fe-member')).toEqual([]);
    expect(gateEntries()['fe-member']).toMatchObject({ class: 'skipped', code: 'UNDETERMINABLE' });
    fixForeign();
    const seen: string[] = [];
    const s2 = await go(async (i) => { seen.push(i.agent.name); mail(i, 'lead', i.agent.name === 'lead' ? 'finished' : 'ok', i.agent.name === 'lead' ? 'done' : 'reply'); return OK; }, true);
    expect(seen).toContain('fe-member');
    expect(s2.endReason).toBe('done');
    expect(gateEntries()).toEqual({});
  });

  it('an enrolled lead with an unreadable foreign project is not woken, not lead_failed; after the repair a resume wakes it', async () => {
    setup('[{project: demo, agent: lead}]');
    breakForeign();
    const seen: string[] = [];
    const s = await go(async (i) => { seen.push(i.agent.name); return OK; });
    expect(s.endReason).toBe('idle');
    expect(seen).toEqual([]);
    expect(gateEntries().lead).toMatchObject({ class: 'skipped', code: 'UNDETERMINABLE' });
    fixForeign();
    const s2 = await go(async (i) => { seen.push(i.agent.name); mail(i, 'lead', 'finished', 'done'); return OK; }, true);
    expect(seen).toEqual(['lead']);
    expect(s2.endReason).toBe('done');
  });

  it('unknown plus a proven problem is refused, not skipped: snapshot change, unsafe grant, and a real earlier refusal survive the repair', async () => {
    // (a) the slot's own configuration changed
    setup('[{project: demo, agent: fe-member}]');
    let s = await go(betweenPass(() => { breakForeign(); env.editProjectYaml((t) => t.replace('    can_message: [lead]\n    # memory', `    can_message: [lead]\n    sandbox:\n      write: [${path.join(env.root, 'extra')}]\n    # memory`)); }, () => {}, () => {}));
    expect(gateEntries()['fe-member']).toMatchObject({ class: 'refused', code: 'SNAPSHOT_MISMATCH' });
    expect(claimsOf('fe-member')).toEqual([]);
    env.cleanup();
    // (b) a proven protected overlap in the active project
    setup('[{project: demo, agent: fe-member}]');
    s = await go(betweenPass(() => { breakForeign(); env.editProjectYaml((t) => t.replace('  qa-member:\n    can_message: [lead]', `  qa-member:\n    can_message: [lead]\n    sandbox:\n      write: [${path.dirname(tool)}]`)); }, () => {}, () => {}));
    expect(gateEntries()['fe-member']).toMatchObject({ class: 'refused', code: 'PREMISE_FAILED' });
    expect(events().find((e) => e.event === 'approval_gate')).toMatchObject({ slot: 'fe-member', class: 'refused', premises: ['containment'] });
    expect(claimsOf('fe-member')).toEqual([]);
    env.cleanup();
    // (c) an earlier refusal is not erased when the foreign project is repaired
    setup('[{project: demo, agent: fe-member}]');
    s = await go(betweenPass(() => { breakForeign(); fs.writeFileSync(path.join(env.home, 'executors.yaml'), `executors:\n  x:\n    command: ["${tool}"]\n    allow: [{project: demo, agent: qa-member}]\n    timeout_sec: 5\n`); }, () => fixForeign(), () => {}));
    expect(gateEntries()['fe-member']).toMatchObject({ class: 'refused', code: 'NOT_ALLOWED' });
    expect(claimsOf('fe-member')).toEqual([]);
    expect(s.endReason).toBe('idle'); // fe-member never replies
  });

  it('a proven unsafe grant of the active project stays refused after the foreign project is repaired; an enrolled lead then ends lead_failed', async () => {
    setup('[{project: demo, agent: lead}]');
    env.editProjectYaml((t) => t.replace('  qa-member:\n    can_message: [lead]', `  qa-member:\n    can_message: [lead]\n    sandbox:\n      write: [${path.dirname(tool)}]`));
    proj0 = env.project();
    breakForeign();
    let s = await go(async () => OK);
    expect(s.endReason).toBe('lead_failed');
    expect(gateEntries().lead).toMatchObject({ class: 'refused', code: 'PREMISE_FAILED' });
    fixForeign();
    s = await go(async () => OK, true);
    expect(s.endReason).toBe('lead_failed');
  });
});
