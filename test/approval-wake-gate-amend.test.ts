import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Invoker, WakeInput, WakeResult } from '../src/adapters/index.js';
import type { FreshOptions } from '../src/approval-wake-gate.js';
import { runTeam, type RunSummary } from '../src/dispatcher.js';
import { outboxDir, setOsSandboxForTest } from '../src/policy.js';
import { prepareTask } from '../src/task.js';
import { FULL_DONE, makeEnv, withSections, write, type TestEnv } from './helpers.js';

// Records what the session passes to the fresh-view loader (the real function still runs).
const loads = vi.hoisted(() => ({ opts: [] as unknown[] }));
vi.mock('../src/approval-wake-gate.js', async (orig) => {
  const real = await orig<typeof import('../src/approval-wake-gate.js')>();
  return { ...real, loadFreshView: (o: FreshOptions) => { loads.opts.push(o); return real.loadFreshView(o); } };
});

vi.setConfig({ testTimeout: 20_000 });
const OK: WakeResult = { ok: true, text: '', exitCode: 0, timedOut: false };
let env: TestEnv;
let tool: string;
let seq = 0;
beforeEach(() => { setOsSandboxForTest(true); loads.opts = []; });
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
};
const withVerify = (marker: string) => env.editProjectYaml((t) => t.replace(/\n$/, `\nverify:\n  commands:\n    - { name: unit, run: "printf ran > ${marker}" }\n`));
const dropVerify = () => env.editProjectYaml((t) => t.replace(/\nverify:\n {2}commands:\n.*\n$/, '\n'));
const filesUnder = (dir: string): string[] => fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? filesUnder(path.join(dir, e.name)) : [path.join(dir, e.name)])) : [];

interface Out { s: RunSummary; wakes: string[]; gate: Record<string, { class: string; code: string }>; claims: (a: string) => string[]; log: Record<string, unknown>[] }
async function go(project: ReturnType<TestEnv['project']>, invoker: Invoker): Promise<Out> {
  const runDir = path.join(project.paths.runs, 'run-1');
  const s = await runTeam({ project, runDir, invoker, task: prepareTask({ text: 'p', cwd: env.root, runDir }), log: () => {}, sleep: async () => {} });
  const gateFile = path.join(runDir, 'approval-gate.json');
  const gate = fs.existsSync(gateFile) ? JSON.parse(fs.readFileSync(gateFile, 'utf8')).slots : {};
  const log = fs.readFileSync(path.join(runDir, 'log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const claims = (a: string) => filesUnder(path.join(runDir, 'mail', 'claims')).concat(filesUnder(path.join(runDir, 'mail', 'attempts'))).filter((f) => path.basename(f).includes(`-${a}-`));
  return { s, wakes: log.filter((e) => e.event === 'wake').map((e) => e.agent as string), gate, claims, log };
}
/** The lead tasks qa-member first (which does `act` in its own memory), then fe-member, then finishes. */
function script(act: (i: WakeInput) => void, edit: () => void = () => {}): Invoker {
  let leadWakes = 0;
  return async (i) => {
    if (i.agent.name === 'lead') {
      if (++leadWakes === 1) { mail(i, 'qa-member', 'qa work', 'task'); edit(); } else if (leadWakes === 2) mail(i, 'fe-member', 'fe work', 'task'); else mail(i, 'lead', 'finished', 'done');
    } else if (i.agent.name === 'qa-member') { act(i); mail(i, 'lead', 'qa done'); } else mail(i, 'lead', `${i.agent.name} replied`);
    return OK;
  };
}
const deepDir = (i: WakeInput) => fs.mkdirSync(path.join(i.agent.memory.task as string, 'a/b/c/d/e/f/g/h/i'), { recursive: true });
const toExecutors = (i: WakeInput) => { const d = i.agent.memory.task as string; fs.mkdirSync(d, { recursive: true }); fs.symlinkSync(path.join(env.home, 'executors.yaml'), path.join(d, 'y')); };
const dangling = (i: WakeInput) => { const d = i.agent.memory.task as string; fs.mkdirSync(d, { recursive: true }); fs.symlinkSync(path.join(env.root, 'nowhere'), path.join(d, 'x')); };

describe('a non-enrolled agent cannot stop enrolled slots by creating descendants in its own memory', () => {
  for (const [name, act] of [['a deep directory', deepDir], ['a symlink to executors.yaml', toExecutors], ['a dangling symlink (control)', dangling]] as const) {
    it(`member enrolled, ${name}: woken, no refusal, run done`, async () => {
      setup('[{project: demo, agent: fe-member}]');
      const r = await go(env.project(), script(act));
      expect(r.wakes).toContain('fe-member');
      expect(r.gate).toEqual({});
      expect(r.s.endReason).toBe('done');
      expect(r.log.some((e) => e.event === 'approval_gate')).toBe(false);
    });
  }
  it('lead enrolled, a deep directory: the lead is woken again and finishes (no lead_failed)', async () => {
    setup('[{project: demo, agent: lead}]');
    const r = await go(env.project(), script(deepDir));
    expect(r.s.endReason).toBe('done');
    expect(r.gate).toEqual({});
    expect(r.wakes.filter((n) => n === 'lead').length).toBeGreaterThan(1);
  });
});

describe('the session project and the fresh disk project are both judged', () => {
  it('a verifier retained in memory but removed from disk refuses the member: never invoked, no claim, no attempt; the lead still finishes', async () => {
    setup('[{project: demo, agent: fe-member}]');
    const marker = path.join(env.root, 'marker');
    withVerify(marker);
    const project = env.project();
    expect(project.verify?.commands.map((c) => c.name)).toEqual(['unit']);
    const r = await go(project, script(() => {}, dropVerify));
    expect(r.wakes).not.toContain('fe-member');
    expect(r.claims('fe-member')).toEqual([]);
    expect(r.gate['fe-member']).toMatchObject({ class: 'refused', code: 'PREMISE_FAILED' });
    expect(r.log.find((e) => e.event === 'approval_gate')).toMatchObject({ slot: 'fe-member', premises: ['project-premises'] });
    // the session passed its own current project, with the verifier the disk no longer has
    const passed = loads.opts.map((o) => (o as FreshOptions).actual);
    expect(passed.length).toBeGreaterThan(0);
    for (const a of passed) { expect(a?.name).toBe('demo'); expect(a?.verify?.commands.map((c) => c.name)).toEqual(['unit']); }
  });
  it('a verifier added to disk after the start refuses the member', async () => {
    setup('[{project: demo, agent: fe-member}]');
    const r = await go(env.project(), script(() => {}, () => withVerify(path.join(env.root, 'm2'))));
    expect(r.wakes).not.toContain('fe-member');
    expect(r.gate['fe-member']).toMatchObject({ class: 'refused', code: 'PREMISE_FAILED' });
  });
  it('control: neither side has a verifier, the member is woken', async () => {
    setup('[{project: demo, agent: fe-member}]');
    const r = await go(env.project(), script(() => {}));
    expect(r.wakes).toContain('fe-member');
    expect(r.gate).toEqual({});
  });
  it('control, existing behaviour: a non-enrolled lead finishing with a retained verifier still runs it (the gate does not cover that path)', async () => {
    setup('[{project: demo, agent: fe-member}]');
    const marker = path.join(env.root, 'marker');
    withVerify(marker);
    const r = await go(env.project(), async (i) => { if (i.agent.name === 'lead') mail(i, 'lead', 'finished', 'done'); return OK; });
    expect(r.wakes).toEqual(['lead']);
    expect(fs.existsSync(marker)).toBe(true);
  });
  it('a teammate grant retained in the session that pointed at the executor, then removed from disk, still refuses the member (containment)', async () => {
    setup('[{project: demo, agent: fe-member}]');
    const grant = (t: string) => t.replace('  qa-member:\n    can_message: [lead]', `  qa-member:\n    can_message: [lead]\n    sandbox:\n      write: [${path.dirname(tool)}]`);
    env.editProjectYaml(grant);
    const retained = fs.readFileSync(path.join(env.home, 'projects', 'demo', 'project.yaml'), 'utf8');
    const project = env.project();
    const r = await go(project, script(() => {}, () => env.editProjectYaml((t) => t.replace(`\n    sandbox:\n      write: [${path.dirname(tool)}]`, ''))));
    expect(fs.readFileSync(path.join(env.home, 'projects', 'demo', 'project.yaml'), 'utf8')).not.toBe(retained);
    expect(r.wakes).not.toContain('fe-member');
    expect(r.claims('fe-member')).toEqual([]);
    expect(r.gate['fe-member']).toMatchObject({ class: 'refused', code: 'PREMISE_FAILED' });
    expect(r.log.find((e) => e.event === 'approval_gate')).toMatchObject({ premises: ['containment'] });
  });
  it('without an enrolled agent the loader is never called and no gate file content appears', async () => {
    setup('[{project: demo, agent: nobody}]');
    const r = await go(env.project(), script(() => {}));
    expect(loads.opts).toEqual([]);
    expect(r.s.endReason).toBe('done');
    expect(fs.existsSync(path.join(env.project().paths.runs, 'run-1', 'approval-gate.json'))).toBe(false);
  });
});
