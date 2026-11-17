// Independent QA flows for approval stage 2b-2, adopted from the QA review: the whole enroll -> break -> status -> fix -> resume path,
// slotDirVerdict on hostile slot names and directories, and `call` leaving the home tree untouched when the gate refuses.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Invoker, WakeInput, WakeResult } from '../src/adapters/index.js';
import { slotDirVerdict } from '../src/approval-wake-gate.js';
import { callAgent } from '../src/call.js';
import { runTeam, type RunSummary } from '../src/dispatcher.js';
import { outboxDir, setOsSandboxForTest } from '../src/policy.js';
import { loadRunState } from '../src/run-store.js';
import { buildStatusReport, formatStatusReport } from '../src/status.js';
import { prepareTask } from '../src/task.js';
import { FULL_DONE, makeEnv, withSections, write, type TestEnv } from './helpers.js';

vi.setConfig({ testTimeout: 30_000 });

const OK: WakeResult = { ok: true, text: '', exitCode: 0, timedOut: false };
const SECRET = 'FLOWS-SECRET-4821';
const PREMISE_OK = { platform: 'linux' as const, sandboxAvailable: () => true };
let env: TestEnv;
let tool: string;
beforeEach(() => setOsSandboxForTest(true));
afterEach(() => { setOsSandboxForTest(undefined); env?.cleanup(); });

let seq = 0;
const mail = (i: WakeInput, to: string, subject: string, type = 'reply') =>
  write(path.join(outboxDir(i.project, i.agent.name), `${String(++seq).padStart(6, '0')}-${Math.random()}.md`),
    `---\nto: ${to}\ntype: ${type}\nsubject: ${subject}\n${type === 'done' ? 'outcome: completed\n' : ''}---\n\n${type === 'done' ? FULL_DONE : withSections(type, `body of ${subject}`)}\n`);
const execYaml = (allow: string): string => `executors:\n  x:\n    command: ["${tool}"]\n    allow: ${allow}\n    timeout_sec: 5\n    env:\n      TOKEN: ${SECRET}\n`;
const ALLOW_FE = '[{project: demo, agent: fe-member}]';
const setup = (allow = ALLOW_FE) => {
  env = makeEnv();
  tool = path.join(env.root, 'exec', 'bin', 'tool');
  write(tool, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(tool, 0o755);
  fs.writeFileSync(path.join(env.home, 'executors.yaml'), execYaml(allow));
};
const runDir = () => path.join(env.project().paths.runs, 'run-1');
const gateFile = () => path.join(runDir(), 'approval-gate.json');
async function go(invoker: Invoker, resume = false): Promise<RunSummary> {
  const project = env.project();
  const rd = path.join(project.paths.runs, 'run-1');
  const common = { project, runDir: rd, invoker, log: () => {}, sleep: async () => {}, approvalPremise: PREMISE_OK };
  if (resume) return runTeam({ ...common, resume: loadRunState(rd) });
  return runTeam({ ...common, task: prepareTask({ text: 'build', cwd: env.root, runDir: rd }) });
}
const humanStatus = (): string => formatStatusReport(buildStatusReport(env.project(), 'run-1'), Date.now(), false);

describe('enroll -> run -> break qualification -> status -> fix -> resume', () => {
  it('refuses the slot, shows a recorded verdict, keeps status --json identical, and wakes the slot again after the fix', async () => {
    setup();
    let leadWakes = 0;
    const first = await go(async (i) => {
      if (i.agent.name === 'lead') {
        if (++leadWakes === 1) {
          mail(i, 'fe-member', 'work', 'task');
          fs.writeFileSync(path.join(env.home, 'executors.yaml'), execYaml('[{project: demo, agent: qa-member}]')); // the enrollment is lost
        } else mail(i, 'lead', 'finished', 'done');
      }
      return OK;
    });
    expect(first.endReason).toBe('done');
    const entry = JSON.parse(fs.readFileSync(gateFile(), 'utf8')).slots['fe-member'];
    expect(entry).toMatchObject({ class: 'refused', code: 'NOT_ALLOWED' });

    const text = humanStatus();
    expect(text).toMatch(/fe-member 記錄於 \d{4}-\d\d-\d\dT/);
    expect(text).toContain('當時判定');
    expect(text).not.toContain(SECRET);
    expect(text.slice(text.indexOf('核可關卡：'))).not.toContain(env.root);

    // the machine-readable report does not depend on executors.yaml or on the gate file
    const jsonOf = () => JSON.stringify(buildStatusReport(env.project(), 'run-1', 1));
    const withExecutors = jsonOf();
    fs.rmSync(path.join(env.home, 'executors.yaml'));
    expect(jsonOf()).toBe(withExecutors);
    const gateBackup = fs.readFileSync(gateFile());
    fs.rmSync(gateFile());
    expect(jsonOf()).toBe(withExecutors);
    fs.writeFileSync(gateFile(), gateBackup);

    // repair the enrollment and resume: the slot is woken again
    fs.writeFileSync(path.join(env.home, 'executors.yaml'), execYaml(ALLOW_FE));
    const woken: string[] = [];
    const second = await go(async (i) => {
      woken.push(i.agent.name);
      if (i.agent.name === 'lead') mail(i, 'lead', 'finished again', 'done');
      else mail(i, 'lead', 'reply');
      return OK;
    }, true);
    expect(second.endReason).toBe('done');
    expect(woken).toContain('fe-member');
  });
});

describe('slotDirVerdict on hostile directories and slot names', () => {
  const ref = (slot: string) => ({ kind: 'run' as const, project: 'demo', run_id: 'run-1', slot });
  it('never wakes a slot with an unsafe or unjudgeable request directory, and one slot never changes another slot\'s verdict', () => {
    setup();
    const rd = path.join(env.root, 'rd');
    fs.mkdirSync(rd, { recursive: true });
    const base = path.join(env.home, 'requests', 'projects', 'demo', 'run-1');
    const verdict = (slot: string) => slotDirVerdict(env.home, ref(slot), rd, slot, 200);

    expect(verdict('fe-member')).toEqual({ kind: 'wake' }); // nothing there yet
    fs.mkdirSync(path.join(base, 'fe-member'), { recursive: true });
    fs.writeFileSync(path.join(base, 'fe-member', 'proposals'), 'x'); // a plain file where the directory belongs
    expect(verdict('fe-member')).toMatchObject({ kind: 'skipped', code: 'DIR_ANOMALY' });
    fs.rmSync(path.join(base, 'fe-member', 'proposals'));
    fs.mkdirSync(path.join(base, 'fe-member', 'proposals'));
    expect(verdict('fe-member')).toEqual({ kind: 'wake' }); // an empty directory is fine
    fs.writeFileSync(path.join(base, 'fe-member', 'proposals', 'junk.txt'), 'x');
    expect(verdict('fe-member')).toMatchObject({ kind: 'skipped', code: 'UNDETERMINABLE' }); // leftover output

    expect(verdict('qa-member')).toEqual({ kind: 'wake' }); // isolation: the other slot is unaffected
    fs.symlinkSync(env.root, path.join(base, 'qa-member')); // the slot root is a symlink
    expect(verdict('qa-member')).toMatchObject({ kind: 'skipped', code: 'DIR_ANOMALY' });
    expect(verdict('fe-member')).toMatchObject({ kind: 'skipped', code: 'UNDETERMINABLE' }); // unchanged by qa-member's problem

    for (const hostile of ['../x', 'a/b', '', 'a\u0000b', 'x'.repeat(300), '..', '.', 'ünï']) {
      expect(verdict(hostile).kind, JSON.stringify(hostile.slice(0, 20))).not.toBe('wake');
    }
  });
});

describe('call when the gate refuses', () => {
  const listing = (dir: string): string[] =>
    (fs.readdirSync(dir, { recursive: true }) as string[]).map((rel) => `${rel}:${fs.statSync(path.join(dir, rel)).mtimeMs}`).sort();
  it('leaves the whole home tree untouched, starts no agent, leaks nothing, and works again once the premise holds', async () => {
    setup('[{call: fe-member}]');
    const before = listing(env.home);
    let invoked = 0;
    const invoker: Invoker = async () => { invoked++; return OK; };
    const refused = await callAgent({ home: env.home, agent: 'fe-member', task: 't', dir: env.repo, invoker, say: () => {}, approvalPremise: { platform: 'linux', sandboxAvailable: () => false } }).catch((e: unknown) => e as Error);
    expect(refused).toBeInstanceOf(Error);
    expect(invoked).toBe(0);
    expect(listing(env.home)).toEqual(before); // no call directory, no lock, nothing rewritten
    expect((refused as Error).message).toContain('No agent was started');
    expect((refused as Error).message).not.toContain(SECRET);
    expect((refused as Error).message).not.toContain(env.root);
    expect(((refused as Error).message.match(/agent-lyceum doctor/g) ?? []).length).toBe(1); // the hint appears once

    const ok = await callAgent({ home: env.home, agent: 'fe-member', task: 't', dir: env.repo, invoker, say: () => {}, approvalPremise: PREMISE_OK });
    expect(ok.ok).toBe(true);
    expect(invoked).toBe(1);
  });
});
