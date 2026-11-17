import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Invoker, WakeInput, WakeResult } from '../src/adapters/index.js';
import { type CollectInput, collectSlot, collectedRecordCount } from '../src/approval-collect.js';
import { SCAN_WORK_BUDGET } from '../src/approval-budget.js';
import { ApprovalError } from '../src/approval-error.js';
import { GATE_TEXT } from '../src/approval-wake-gate.js';
import { requestPaths } from '../src/approval-paths.js';
import { resolveProject } from '../src/config.js';
import { runTeam } from '../src/dispatcher.js';
import { diagnoseApproval } from '../src/doctor-approval.js';
import { outboxDir, setOsSandboxForTest } from '../src/policy.js';
import { buildStatusReport, formatStatus } from '../src/status.js';
import { prepareTask } from '../src/task.js';
import { makeEnv, withSections, write, type TestEnv } from './helpers.js';

const spy = vi.hoisted(() => ({ count: 0 }));
vi.mock('../src/approval-collect.js', async (orig) => {
  const real = await orig<typeof import('../src/approval-collect.js')>();
  return { ...real, collectedRecordCount: (...a: Parameters<typeof real.collectedRecordCount>) => { spy.count++; return real.collectedRecordCount(...a); } };
});
vi.setConfig({ testTimeout: 30_000 });

const OK: WakeResult = { ok: true, text: '', exitCode: 0, timedOut: false };
const NOW = Date.parse('2026-11-16T12:00:00.000Z');
const SECRET = 'SENTINEL-SECRET-s4-77';
const EVIL = 'SENTINEL-PATH-s4-91';
let env: TestEnv;
let tool: string;
beforeEach(() => { spy.count = 0; setOsSandboxForTest(true); });
afterEach(() => { setOsSandboxForTest(undefined); env?.cleanup(); });

const execPath = () => path.join(env.home, 'executors.yaml');
const execYaml = (allow: string) => `executors:\n  x:\n    command: ["${tool}"]\n    allow: ${allow}\n    timeout_sec: 5\n    env:\n      TOKEN: ${SECRET}\n`;
function setup(): void {
  env = makeEnv();
  tool = path.join(env.root, 'exec', 'bin', 'tool');
  write(tool, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(tool, 0o755);
  fs.writeFileSync(execPath(), execYaml('[{project: demo, agent: fe-member}]'));
}
let seq = 0;
const mail = (i: WakeInput, to: string, subject: string) =>
  write(path.join(outboxDir(i.project, i.agent.name), `${String(++seq).padStart(6, '0')}-${Math.random()}.md`), `---\nto: ${to}\ntype: task\nsubject: ${subject}\n---\n\n${withSections('task', 'body')}\n`);
async function runBreaking(breakIt: () => void): Promise<string> {
  const project = env.project();
  const runDir = path.join(project.paths.runs, 'run-1');
  let wakes = 0;
  const invoker: Invoker = async (i) => { if (i.agent.name === 'lead' && ++wakes === 1) { mail(i, 'fe-member', 'w'); breakIt(); } return OK; };
  await runTeam({ project, task: prepareTask({ text: 't', cwd: env.root, runDir }), runDir, invoker, log: () => {}, sleep: async () => {}, approvalPremise: { platform: 'linux', sandboxAvailable: () => true } });
  return runDir;
}

/** Commits `n` records for (run, project, slot) through the real collector. */
function collect(runId: string, project: string, files: Record<string, string>): void {
  const slot = { kind: 'run' as const, project, run_id: runId, slot: 'fe-member' };
  const ex = { command: ['/bin/true'], allow: [], timeout_sec: 60, env: {}, expires_days: 7, max_pending: 50, max_payload_bytes: 4096 };
  const cfg = { executors: { x: ex }, limits: { max_total_pending: 50, max_scan_entries: 200, retention_days: 90 } };
  const dir = requestPaths(env.home, slot).proposals;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const [f, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), body);
  const snap = { runtime_candidates: [{ runtime: 'claude-code', sandbox: null, allow_web: null }], writable: { dirs: ['/p'], files: [] }, project_dir: '/p', executor: ex };
  const input: CollectInput = { home: env.home, slot, agent: 'fe-member', runDir: path.join(env.root, 'unused'), config: cfg,
    origin: { kind: 'run', project, run_id: runId, project_dir: '/p', role: 'fe-member', full_writable: { dirs: ['/p'], files: [] } },
    inputs: new Map([['x', snap]]), premises: [{ check: 'p1', ok: true, code: 'ok' }], current: { attemptId: 'a1', outcome: 'collect' } };
  const r = collectSlot(input, { io: fs, budget: SCAN_WORK_BUDGET, now: () => new Date(NOW), token: () => `t${Math.random()}`,
    actor: () => ({ user: 'u', tty: null, pid: 1, pid_started: null }), probe: { signal0: () => 'exists', start: () => 'start', compare: () => 'match' },
    fault: () => undefined, log: () => {} });
  expect(r.verdict.kind).not.toBe('skipped');
}
const rewrite = (f: string, t: string) => { fs.rmSync(f, { force: true }); fs.writeFileSync(f, t); };
const req = (n: string) => `executor: x\n\npayload-${n}`;

describe('S4 human status', () => {
  it('count is committed records not pending', async () => {
    setup();
    const runDir = await runBreaking(() => {});
    const runId = path.basename(runDir);
    expect(collectedRecordCount(env.home, runId, 'demo')).toBe(0);
    collect(runId, 'demo', { 'a.req': req('a'), 'b.req': req('b'), 'bad.req': 'executor: nope\n\nx' });
    collect('other-run', 'demo', { 'c.req': req('c') });
    // a payload-only directory has no record.json: not committed
    fs.mkdirSync(path.join(env.home, 'approvals', 'f'.repeat(24)), { recursive: true });
    // an uncollected file still in proposals/ is not counted
    fs.writeFileSync(path.join(requestPaths(env.home, { kind: 'run', project: 'demo', run_id: runId, slot: 'fe-member' }).proposals, 'late.req'), req('late'));
    expect(collectedRecordCount(env.home, runId, 'demo')).toBe(3); // 2 valid + 1 denied, all committed
    expect(collectedRecordCount(env.home, 'other-run', 'demo')).toBe(1);
    const text = formatStatus(env.project(), NOW);
    expect(text).toMatch(/已收走的核可請求（已提交紀錄）：3/);
  });

  it('side file reasons fixed and persist after executor deletion', async () => {
    setup();
    const runDir = await runBreaking(() => fs.rmSync(execPath()));
    collect(path.basename(runDir), 'demo', { 'a.req': req('a') });
    expect(fs.existsSync(execPath())).toBe(false);
    const text = formatStatus(env.project(), NOW);
    expect(text).toContain(GATE_TEXT.EXECUTOR_MISSING.status);
    expect(text).toMatch(/已收走的核可請求（已提交紀錄）：1/);
  });

  it('JSON never reads collection store', async () => {
    setup();
    const runDir = await runBreaking(() => {});
    collect(path.basename(runDir), 'demo', { 'a.req': req('a') });
    const project = env.project();
    spy.count = 0;
    const withExec = JSON.stringify({ schema_version: 1, ...buildStatusReport(project, undefined, NOW) }, null, 2);
    expect(spy.count).toBe(0);
    fs.rmSync(execPath());
    const without = JSON.stringify({ schema_version: 1, ...buildStatusReport(env.project(), undefined, NOW) }, null, 2);
    expect(without).toBe(withExec);
    expect(spy.count).toBe(0);
    expect(withExec).not.toMatch(/核可|collected/);
    formatStatus(env.project(), NOW);
    expect(spy.count).toBeGreaterThan(0); // the spy does observe the human path
  });

  it('damaged or over-budget count is explicit unknown', async () => {
    setup();
    const runDir = await runBreaking(() => {});
    const runId = path.basename(runDir);
    collect(runId, 'demo', { 'a.req': req('a'), 'b.req': req('b') });
    expect(collectedRecordCount(env.home, runId, 'demo', 1)).toBe('unreadable'); // over budget
    expect(formatStatus(env.project(), NOW)).toMatch(/已收走的核可請求（已提交紀錄）：2/);
    const id = fs.readdirSync(path.join(env.home, 'approvals')).find((n) => /^[0-9a-f]{24}$/.test(n)) as string;
    rewrite(path.join(env.home, 'approvals', id, 'record.json'), '{not json');
    expect(collectedRecordCount(env.home, runId, 'demo')).toBe('unreadable');
    const text = formatStatus(env.project(), NOW);
    expect(text).toMatch(/已收走的核可請求（已提交紀錄）：無法讀取（未知，非 0）/);
    expect(text).not.toMatch(/已提交紀錄）：0/);
  });

  it('malicious errors never printed', async () => {
    setup();
    const runDir = await runBreaking(() => {});
    const runId = path.basename(runDir);
    collect(runId, 'demo', { 'a.req': req('a') });
    const id = fs.readdirSync(path.join(env.home, 'approvals')).find((n) => /^[0-9a-f]{24}$/.test(n)) as string;
    rewrite(path.join(env.home, 'approvals', id, 'record.json'), `{"x":"${EVIL} ${SECRET}"`);
    fs.mkdirSync(path.join(env.home, 'approvals', `${EVIL}`), { recursive: true });
    expect(collectedRecordCount(env.home, runId, 'demo')).toBe('unreadable');
    const text = formatStatus(env.project(), NOW);
    expect(text).not.toContain(EVIL);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(env.home + path.sep + 'approvals');
  });
});

describe('S4 doctor link probe', () => {
  let root: string;
  const mk = (p: string, t: string) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, t); };
  const mkProject = (enabled: boolean) => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-s4-')));
    const home = path.join(root, 'home');
    const repo = path.join(root, 'repo');
    fs.mkdirSync(repo, { recursive: true });
    const t = path.join(root, 'bin', 'tool');
    mk(t, '#!/bin/sh\nexit 0\n'); fs.chmodSync(t, 0o755);
    mk(path.join(home, 'team.yaml'), 'agents:\n  helper:\n    runtime: claude-code\n');
    mk(path.join(home, 'projects', 'p', 'project.yaml'), `dir: ${repo}\nteam:\n  lead: dev\nagents:\n  dev:\n    runtime: claude-code\n  w:\n    runtime: claude-code\n`);
    if (enabled) mk(path.join(home, 'executors.yaml'), `executors:\n  x:\n    command: ["${t}"]\n    allow: [{project: p, agent: w}]\n    timeout_sec: 5\n`);
    return { home, project: resolveProject(home, 'p') };
  };
  const o = (linkProbe: (h: string, d: string) => void) => ({ sandboxAvailable: () => true, platform: 'linux' as const, linkProbe });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  it('doctor link failure and default-off zero probes', () => {
    const calls: string[] = [];
    const off = mkProject(false);
    expect(diagnoseApproval(off.project, { ...o((h, d) => { calls.push(d); }), userHome: root })).toEqual([]);
    expect(calls).toHaveLength(0);
    fs.rmSync(root, { recursive: true, force: true });

    const on = mkProject(true);
    const ok = diagnoseApproval(on.project, { ...o((h, d) => { calls.push(d); }), userHome: root });
    expect(calls).toHaveLength(1);
    expect(ok.some((c) => /hard.link/i.test(c.message) && c.level === 'error')).toBe(false);
    const bad = diagnoseApproval(on.project, { ...o(() => { throw new ApprovalError('UNSUPPORTED_LINK', `no links at ${EVIL}`, EVIL); }), userHome: root });
    const hit = bad.find((c) => c.subject === 'approval' && c.level === 'error' && /hard.link/i.test(c.message));
    expect(hit).toBeDefined();
    expect(hit?.message).toContain('UNSUPPORTED_LINK');
    expect(JSON.stringify(bad)).not.toContain(EVIL);
  });

  it('malicious errors never printed', () => {
    const on = mkProject(true);
    for (const err of [new ApprovalError('IO_ERROR', EVIL, EVIL, { cause: Object.assign(new Error(SECRET), { code: EVIL }) }), new Error(`${EVIL} ${SECRET}`)]) {
      const out = diagnoseApproval(on.project, { ...o(() => { throw err; }), userHome: root });
      const text = JSON.stringify(out);
      expect(text).not.toContain(EVIL);
      expect(text).not.toContain(SECRET);
      expect(out.some((c) => c.level === 'error' && /hard.link/i.test(c.message))).toBe(true);
    }
  });
});
