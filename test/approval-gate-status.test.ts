import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Invoker, WakeInput, WakeResult } from '../src/adapters/index.js';
import { GATE_TEXT } from '../src/approval-wake-gate.js';
import { runTeam } from '../src/dispatcher.js';
import { outboxDir, setOsSandboxForTest } from '../src/policy.js';
import { buildStatusReport, formatStatus, formatStatusReport } from '../src/status.js';
import { prepareTask } from '../src/task.js';
import { makeEnv, withSections, write, type TestEnv } from './helpers.js';

const spy = vi.hoisted(() => ({ reads: 0 }));
vi.mock('../src/approval-wake-gate.js', async (orig) => {
  const real = await orig<typeof import('../src/approval-wake-gate.js')>();
  return { ...real, readGateFile: (dir: string) => { spy.reads++; return real.readGateFile(dir); } };
});
vi.setConfig({ testTimeout: 30_000 });

const OK: WakeResult = { ok: true, text: '', exitCode: 0, timedOut: false };
const SECRET = 'SENTINEL-SECRET-st-77';
const SPATH = 'SENTINEL-PATH-st-91';
const NOW = Date.parse('2026-11-16T12:00:00.000Z');
let env: TestEnv;
let tool: string;
beforeEach(() => { spy.reads = 0; setOsSandboxForTest(true); });
afterEach(() => { setOsSandboxForTest(undefined); env?.cleanup(); });

const execYaml = (allow: string) => `executors:\n  x:\n    command: ["${tool}"]\n    allow: ${allow}\n    timeout_sec: 5\n    env:\n      TOKEN: ${SECRET}\n`;
const execPath = () => path.join(env.home, 'executors.yaml');
const setup = (enroll = true) => {
  env = makeEnv();
  tool = path.join(env.root, 'exec', 'bin', 'tool');
  write(tool, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(tool, 0o755);
  if (enroll) fs.writeFileSync(execPath(), execYaml('[{project: demo, agent: fe-member}]'));
};
let seq = 0;
const mail = (i: WakeInput, to: string, subject: string, type = 'task') =>
  write(path.join(outboxDir(i.project, i.agent.name), `${String(++seq).padStart(6, '0')}-${Math.random()}.md`), `---\nto: ${to}\ntype: ${type}\nsubject: ${subject}\n---\n\n${withSections(type, 'body')}\n`);
/** Runs the project once: the lead mails fe-member and then breaks the enrollment; returns the run dir. */
async function runBreaking(breakIt: () => void): Promise<string> {
  const project = env.project();
  const runDir = path.join(project.paths.runs, 'run-1');
  let wakes = 0;
  const invoker: Invoker = async (i) => { if (i.agent.name === 'lead' && ++wakes === 1) { mail(i, 'fe-member', 'w'); breakIt(); } return OK; };
  await runTeam({ project, task: prepareTask({ text: 't', cwd: env.root, runDir }), runDir, invoker, log: () => {}, sleep: async () => {}, approvalPremise: { platform: 'linux', sandboxAvailable: () => true } });
  return runDir;
}
const cliJson = (project: ReturnType<TestEnv['project']>) => JSON.stringify({ schema_version: 1, ...buildStatusReport(project, undefined, NOW) }, null, 2);
const gateFile = (runDir: string) => path.join(runDir, 'approval-gate.json');

describe('human status shows the gate reasons', () => {
  it('lists a refused slot with fixed text, even though the CURRENT config has no enrolled agent (last allow removed)', async () => {
    setup();
    const runDir = await runBreaking(() => fs.writeFileSync(execPath(), execYaml('[{project: demo, agent: qa-member}]')));
    const current = env.project();
    expect(current.agents['fe-member']?.enrolled).toBeUndefined();
    const text = formatStatus(current, NOW);
    expect(text).toContain('核可關卡');
    expect(text).toContain('fe-member');
    expect(text).toContain(GATE_TEXT.NOT_ALLOWED.status);
    expect(text).toContain('不再喚醒');
    expect(fs.existsSync(gateFile(runDir))).toBe(true);
  });
  it('shows an entry as a recorded verdict with its timestamp, not as the present state', async () => {
    setup();
    await runBreaking(() => fs.writeFileSync(execPath(), execYaml('[{project: demo, agent: qa-member}]')));
    const text = formatStatus(env.project(), NOW);
    const block = text.slice(text.indexOf('核可關卡：'));
    expect(block).toMatch(/fe-member 記錄於 \d{4}-\d\d-\d\dT[\d:.]+Z：/);
    expect(block).toContain('當時判定');
    expect(block).not.toMatch(/fe-member [^：]*：本 run 不再喚醒/);
  });
  it('the same after executors.yaml is deleted', async () => {
    setup();
    await runBreaking(() => fs.rmSync(execPath()));
    const text = formatStatus(env.project(), NOW);
    expect(text).toContain(GATE_TEXT.EXECUTOR_MISSING.status);
  });
  it('lists a skipped slot as paused', async () => {
    setup();
    const slot = path.join(env.home, 'requests', 'projects', 'demo', 'run-1', 'fe-member');
    await runBreaking(() => { fs.mkdirSync(path.join(env.root, 'elsewhere')); fs.mkdirSync(path.dirname(slot), { recursive: true }); fs.symlinkSync(path.join(env.root, 'elsewhere'), slot); });
    const text = formatStatus(env.project(), NOW);
    expect(text).toContain(GATE_TEXT.DIR_ANOMALY.status);
    expect(text).toContain('暫停喚醒');
  });
  it('fixed text only: the executor secret and a sentinel path never reach the block', async () => {
    setup();
    const moved = path.join(env.root, SPATH);
    fs.mkdirSync(moved);
    await runBreaking(() => env.editProjectYaml((t) => t.replace(env.repo, moved)));
    const text = formatStatus(env.project(), NOW);
    // the header shows the current repo path (the user's own config); the gate block must carry none of it
    const block = text.slice(text.indexOf('核可關卡：'));
    expect(block).toContain(GATE_TEXT.PROJECT_PATH_MISMATCH.status);
    expect(block).not.toContain(SECRET);
    expect(block).not.toContain(SPATH);
    expect(text).not.toContain(SECRET);
  });
  it('a damaged side file prints one fixed line and status still works (FIFO, over 64 KiB, bad JSON, unknown version)', async () => {
    setup();
    const runDir = await runBreaking(() => fs.rmSync(execPath()));
    const file = gateFile(runDir);
    const bodies: (() => void)[] = [
      () => { fs.rmSync(file, { force: true }); execFileSync('mkfifo', [file]); },
      () => { fs.rmSync(file, { force: true }); fs.writeFileSync(file, JSON.stringify({ schema_version: 1, slots: {}, pad: 'x'.repeat(70_000) })); },
      () => fs.writeFileSync(file, '{bad'),
      () => fs.writeFileSync(file, JSON.stringify({ schema_version: 2, slots: {} })),
    ];
    for (const damage of bodies) {
      damage();
      const text = formatStatus(env.project(), NOW);
      expect(text.split('\n').filter((l) => l.includes('核可關卡狀態檔無法讀取'))).toHaveLength(1);
      expect(text).toContain('專案：');
      if (fs.lstatSync(file).isFIFO()) fs.rmSync(file);
    }
  });
  it('a tampered slot name cannot inject control characters', async () => {
    setup();
    const runDir = await runBreaking(() => fs.rmSync(execPath()));
    fs.writeFileSync(gateFile(runDir), JSON.stringify({ schema_version: 1, slots: { 'a\u001b[31mb\nc': { class: 'refused', code: 'NOT_ALLOWED', at: 'x\u001b[0m' } } }));
    const text = formatStatus(env.project(), NOW);
    expect(text).not.toContain('\u001b');
    expect(text).toContain(GATE_TEXT.NOT_ALLOWED.status);
  });
});

describe('status --json and runs without a gate file', () => {
  it('JSON is byte-identical with and without the gate file (report and CLI string), and the file is never read on that path', async () => {
    setup();
    const runDir = await runBreaking(() => fs.rmSync(execPath()));
    const project = env.project();
    spy.reads = 0;
    const withFile = [JSON.stringify(buildStatusReport(project, undefined, NOW)), cliJson(project)];
    expect(spy.reads).toBe(0);
    fs.rmSync(gateFile(runDir));
    const without = [JSON.stringify(buildStatusReport(project, undefined, NOW)), cliJson(project)];
    expect(withFile).toEqual(without);
    expect(withFile.join('')).not.toMatch(/approval-gate|核可/);
  });
  it('a run with no gate file (not enrolled): no block, and only one open attempt of the file', async () => {
    setup(false);
    await runBreaking(() => {});
    const text = formatStatus(env.project(), NOW);
    expect(text).not.toContain('核可關卡');
    expect(spy.reads).toBe(1);
  });
  it('formatting a report built without a run does not read anything', () => {
    setup(false);
    const report = buildStatusReport(env.project(), undefined, NOW);
    expect(report.run).toBeUndefined();
    spy.reads = 0;
    formatStatusReport(report, NOW);
    expect(spy.reads).toBe(0);
  });
});
