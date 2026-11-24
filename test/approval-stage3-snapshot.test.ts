// Approval stage 3, S3a/S3d: grants as data (`grantEntries`), the one qualification snapshot (`approval-snapshot.ts`) and its agreement between the
// session project, the project a wake really ran with (worktrees) and an unbound virtual binding, checked on a real worktree run.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Invoker, WakeInput, WakeResult } from '../src/adapters/index.js';
import type { ExecutorsConfig } from '../src/approval-executors.js';
import { qualificationHash } from '../src/approval-origin.js';
import { loadFreshConfig } from '../src/approval-runtime.js';
import { RUN_ONLY_SOURCES, slotGrants, snapshotInputs, unboundSnapshotInputs } from '../src/approval-snapshot.js';
import { baselineFor, slotSnapshotInputs } from '../src/approval-wake-gate.js';
import { resolveProject, type ResolvedProject } from '../src/config.js';
import { runTeam } from '../src/dispatcher.js';
import { canonicalPath } from '../src/paths.js';
import { grantEntries, outboxDir, setOsSandboxForTest, writePolicy } from '../src/policy.js';
import { bindRunProject, loadRunState, type InstanceTable } from '../src/run-store.js';
import { soloProject } from '../src/solo.js';
import { prepareTask } from '../src/task.js';
import { initGitRepo, FULL_DONE, makeEnv, withSections, write, type TestEnv } from './helpers.js';

vi.setConfig({ testTimeout: 60_000 });

const OK: WakeResult = { ok: true, text: '', exitCode: 0, timedOut: false };
const PREMISE_OK = { platform: 'linux' as const, sandboxAvailable: () => true };
let env: TestEnv;
let tool: string;
beforeEach(() => setOsSandboxForTest(true));
afterEach(() => { setOsSandboxForTest(undefined); env?.cleanup(); });

const byBytes = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));
const canon = (xs: readonly string[]): string[] => [...new Set(xs.map(canonicalPath))].sort(byBytes);
let seq = 0;
const mail = (i: WakeInput, to: string, subject: string, type = 'reply') =>
  write(path.join(outboxDir(i.project, i.agent.name), `${String(++seq).padStart(6, '0')}-${Math.random()}.md`),
    `---\nto: ${to}\ntype: ${type}\nsubject: ${subject}\n${type === 'done' ? 'outcome: completed\n' : ''}---\n\n${type === 'done' ? FULL_DONE : withSections(type, `body of ${subject}`)}\n`);
const ALLOW = '[{project: demo, agent: lead}, {project: demo, agent: fe-member}]';
const setup = (): void => {
  env?.cleanup();
  env = makeEnv();
  tool = path.join(env.root, 'exec', 'bin', 'tool');
  write(tool, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(tool, 0o755);
  fs.writeFileSync(path.join(env.home, 'executors.yaml'), `executors:\n  x:\n    command: ["${tool}"]\n    allow: ${ALLOW}\n    timeout_sec: 5\n`);
};
const config = (): ExecutorsConfig => (loadFreshConfig(env.home, { userHome: os.homedir() }) as { config: ExecutorsConfig }).config;
const records = (): Record<string, any>[] => {
  const dir = path.join(env.home, 'approvals');
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => /^[0-9a-f]{24}$/.test(n)).sort().map((n) => JSON.parse(fs.readFileSync(path.join(dir, n, 'record.json'), 'utf8'))) : [];
};
const hashOf = (inputs: Map<string, any>): string => qualificationHash(inputs.get('x') as never);
const req = (dir: string, name: string): void => write(path.join(dir, name), `executor: x\nsummary: ${name}\n\nrun it\n`);

interface Seen { inputs: Map<string, WakeInput>; summary: Awaited<ReturnType<typeof runTeam>>; runDir: string }
/** A run in a scratch git repo (so the lead and every member get a worktree): the lead and fe-member each write one request. */
async function realRun(o: { solo?: boolean; editYaml?: (t: string, runsDir: string) => string } = {}): Promise<Seen> {
  setup();
  initGitRepo(env.repo);
  const runsDir = env.project().paths.runs;
  env.editProjectYaml((t) => (o.editYaml ?? ((x) => x))(t.replace('  fe-member:\n    can_message: [lead]', '  fe-member:\n    can_message: [lead]\n    can_edit_agent_md: true'), runsDir));
  const project = env.project();
  const runDir = path.join(project.paths.runs, 'run-1');
  const inputs = new Map<string, WakeInput>();
  let sent = false;
  let heard = false;
  const invoker: Invoker = async (i) => {
    if (!inputs.has(i.agent.name)) inputs.set(i.agent.name, i);
    if (i.proposalsDir) req(i.proposalsDir, `${i.agent.name}.req`);
    if (o.solo) { mail(i, i.agent.name, 'finished', 'done'); return OK; }
    if (i.agent.name === 'lead') {
      if (i.userPrompt.includes('from: fe-member')) heard = true;
      if (!sent) { sent = true; mail(i, 'fe-member', 'work', 'task'); } else if (heard) mail(i, 'lead', 'finished', 'done');
    } else mail(i, 'lead', 'reply');
    return OK;
  };
  const summary = await runTeam({ project, runDir, invoker, log: () => {}, sleep: async () => {}, approvalPremise: PREMISE_OK, soloAgent: o.solo ? 'fe-member' : undefined, task: prepareTask({ text: 'build', cwd: env.root, runDir }) });
  return { inputs, summary, runDir };
}
const recordOf = (slot: string): Record<string, any> => records().find((r) => r.proposer.slot === slot && r.disposition === 'pending') as Record<string, any>;

describe('grantEntries and writePolicy', () => {
  it('writePolicy\'s allow lists are the entries in order; a proposals directory is one more dir at the very end and nothing else changes', () => {
    setup();
    initGitRepo(env.repo);
    const p = env.project();
    const bound = bindRunProject(p, path.join(p.paths.runs, 'run-1'), 'run');
    for (const name of ['lead', 'fe-member']) {
      const agent = bound.agents[name] as never;
      const plain = writePolicy(bound, agent);
      const entries = grantEntries(bound, agent);
      expect(plain.allowDirs).toEqual(entries.filter((e) => e.kind === 'dir').map((e) => e.path));
      expect(plain.allowFiles).toEqual(entries.filter((e) => e.kind === 'file').map((e) => e.path));
      const withDir = writePolicy(bound, agent, '/canon/proposals');
      expect(withDir.allowDirs).toEqual([...plain.allowDirs, '/canon/proposals']);
      expect(withDir.allowFiles).toEqual(plain.allowFiles);
      expect(withDir.deny).toEqual(plain.deny);
      // The lead (and a solo agent) hold the project's own proposals directory (spec 30), which is also tagged `proposals`; the
      // approval request directory is the extra entry that `withDir` appended last, so it is the only difference.
      expect(entries.filter((e) => e.source === 'proposals').length).toBe(name === 'lead' ? 1 : 0);
    }
    expect(RUN_ONLY_SOURCES.has('proposals') && RUN_ONLY_SOURCES.has('git-dir') && !RUN_ONLY_SOURCES.has('own-dir')).toBe(true);
  });
});

describe('snapshot of what a slot may write', () => {
  const session = (p: ResolvedProject) => bindRunProject(p, path.join(p.paths.runs, 'run-1'), 'run');
  const withWorkspaces = (b: ResolvedProject): ResolvedProject => ({
    ...b,
    workspaces: Object.fromEntries(['lead', 'fe-member'].map((n) => [n, { dir: path.join(env.root, 'wt', n, 'repo'), root: path.join(env.root, 'wt', n), gitDir: path.join(env.root, 'gitdirs', n) }])) as never,
  });

  it('the actual grants (worktree git dir, the lead\'s own instruction files, proposals) are in `full` but never change the hash', () => {
    setup();
    initGitRepo(env.repo);
    env.editProjectYaml((t) => t.replace('  fe-member:\n    can_message: [lead]', '  fe-member:\n    can_message: [lead]\n    can_edit_agent_md: true'));
    const base = session(env.project());
    const actual = withWorkspaces(base);
    const proposals = path.join(env.root, 'req', 'proposals');
    const a = snapshotInputs(base, 'fe-member', config());
    const b = snapshotInputs(actual, 'fe-member', config(), proposals);
    expect(hashOf(b.inputs)).toBe(hashOf(a.inputs));
    expect(b.full.dirs).toContain(canonicalPath(path.join(env.root, 'gitdirs', 'fe-member')));
    expect(b.full.dirs).toContain(canonicalPath(proposals));
    expect(b.full.files).toContain(canonicalPath(path.join(env.root, 'wt', 'lead', 'repo', 'CLAUDE.md')));
    expect(a.full.dirs).not.toContain(canonicalPath(proposals));
    // the logical instruction files (in the project directory) are what the hash is built from
    const w = (b.inputs.get('x') as { writable: { files: string[]; dirs: string[] } }).writable;
    expect(w.files).toContain(canonicalPath(path.join(env.repo, 'CLAUDE.md')));
    expect(w.files.some((f) => f.includes(`${path.sep}wt${path.sep}`))).toBe(false);
    expect(w.dirs).not.toContain(canonicalPath(proposals));
    expect(w.dirs.some((d) => d.includes(`${path.sep}mail${path.sep}outbox`))).toBe(false); // run-only
  });

  it('slotSnapshotInputs (the gate\'s entry point) is the same computation', () => {
    setup();
    const b = session(env.project());
    expect(hashOf(slotSnapshotInputs(b, 'fe-member', config()))).toBe(hashOf(snapshotInputs(b, 'fe-member', config()).inputs));
    expect(slotSnapshotInputs(b, 'qa-member', config()).size).toBe(0); // not allowed any executor
  });

  it('a path with a static source as well as a run-only one stays in the hash input (static duplicate); one with only run-only sources is dropped', () => {
    setup();
    const p = env.project();
    const b = session(p);
    const agent = { ...b.agents['fe-member']!, sandbox: { write: [outboxDir(b, 'fe-member')], network: [], localBinding: false, unixSockets: [] } };
    const dup = { ...b, agents: { ...b.agents, 'fe-member': agent } } as ResolvedProject;
    const { grant } = slotGrants(dup, agent);
    expect(grant.static_duplicates.dirs).toEqual([canonicalPath(outboxDir(b, 'fe-member'))]);
    expect(snapshotInputs(dup, 'fe-member', config()).inputs.get('x')?.writable.dirs).toContain(canonicalPath(outboxDir(b, 'fe-member')));
    expect(snapshotInputs(b, 'fe-member', config()).inputs.get('x')?.writable.dirs).not.toContain(canonicalPath(outboxDir(b, 'fe-member')));
  });

  it('an unbound virtual binding gives the session\'s hash: normal, solo, and a synthesized same-role instance', () => {
    setup();
    const p = env.project();
    const b = session(p);
    expect(hashOf(unboundSnapshotInputs(p, 'fe-member', config(), undefined, 'normal'))).toBe(hashOf(snapshotInputs(b, 'fe-member', config()).inputs));
    const solo = bindRunProject(soloProject(p, 'fe-member'), path.join(p.paths.runs, 'run-1'), 'run');
    expect(hashOf(unboundSnapshotInputs(p, 'fe-member', config(), undefined, 'solo'))).toBe(hashOf(snapshotInputs(solo, 'fe-member', config()).inputs));
    expect(hashOf(unboundSnapshotInputs(p, 'lead', config(), undefined, 'solo'))).not.toBe(hashOf(unboundSnapshotInputs(p, 'lead', config(), undefined, 'normal'))); // solo changes the lead's grants
    const table: InstanceTable = { roles: { 'fe-member': ['fe-member', 'fe-member--2'] } };
    const inst = withWorkspaces(bindRunProject(p, path.join(p.paths.runs, 'run-9'), 'run', table));
    expect(hashOf(snapshotInputs(inst, 'fe-member--2', config(), path.join(env.root, 'req2', 'proposals')).inputs)).toBe(hashOf(unboundSnapshotInputs(p, 'fe-member--2', config(), table, 'normal')));
  });

  it('nothing is created: the virtual binding reads and writes no run folder', () => {
    setup();
    const before = fs.existsSync(env.project().paths.runs) ? fs.readdirSync(env.project().paths.runs) : [];
    unboundSnapshotInputs(env.project(), 'fe-member', config(), undefined, 'normal');
    expect(fs.existsSync(env.project().paths.runs) ? fs.readdirSync(env.project().paths.runs) : []).toEqual(before);
  });
});

describe('snapshot actual worktree grants (real run in a scratch git repo)', () => {
  it('the adapter\'s grants are the record\'s full_writable, the record hash is the gate\'s, and a fresh unbound rebuild after clear gives the same hash', async () => {
    const { inputs, summary, runDir } = await realRun();
    expect(summary.endReason).toBe('done');
    expect(loadRunState(runDir).lead_workspace).toBe(true);
    for (const slot of ['lead', 'fe-member']) {
      const wake = inputs.get(slot) as WakeInput;
      const rec = recordOf(slot);
      expect(rec, `record of ${slot}`).toBeDefined();
      const pol = writePolicy(wake.project, wake.agent, wake.proposalsDir);
      expect(rec.origin.full_writable).toEqual({ dirs: canon(pol.allowDirs), files: canon(pol.allowFiles) });
      const ws = wake.project.workspaces?.[slot];
      expect(ws, `${slot} has a worktree`).toBeDefined();
      expect(rec.origin.full_writable.dirs).toContain(canonicalPath((ws as { gitDir: string }).gitDir));
      expect(rec.origin.full_writable.dirs).toContain(canonicalPath(wake.proposalsDir as string));
      const leadDir = (wake.project.workspaces as Record<string, { dir: string }>).lead?.dir as string;
      for (const f of ['CLAUDE.md', 'AGENTS.md']) expect(rec.origin.full_writable.files).toContain(canonicalPath(path.join(leadDir, f)));
      // the gate's baseline (computed from the session project, which has no worktrees)
      const bound = bindRunProject(env.project(), runDir, 'run');
      expect(rec.qualification.sha256).toBe(baselineFor(bound, slot, config(), 'run-1').hashes.get('x'));
    }
    // clear: the run folder and the worktrees are gone, the record stays
    fs.rmSync(runDir, { recursive: true, force: true });
    for (const slot of ['lead', 'fe-member']) {
      const root = ((inputs.get(slot) as WakeInput).project.workspaces as Record<string, { root: string }>)[slot]?.root as string;
      fs.rmSync(root, { recursive: true, force: true });
    }
    const fresh = resolveProject(env.home, 'demo');
    for (const slot of ['lead', 'fe-member']) {
      expect(hashOf(unboundSnapshotInputs(fresh, slot, config(), undefined, 'normal'))).toBe(recordOf(slot).qualification.sha256);
    }
    // a changed grant is a different hash
    const member = '    can_message: [lead]\n    can_edit_agent_md: true';
    env.editProjectYaml((t) => t.replace(member, '    can_message: [lead]\n    can_edit_agent_md: false'));
    expect(hashOf(unboundSnapshotInputs(resolveProject(env.home, 'demo'), 'fe-member', config(), undefined, 'normal'))).not.toBe(recordOf('fe-member').qualification.sha256);
    env.editProjectYaml((t) => t.replace('    can_message: [lead]\n    can_edit_agent_md: false', `${member}\n    sandbox: { write: ["${path.join(env.root, 'extra')}"] }`));
    expect(hashOf(unboundSnapshotInputs(resolveProject(env.home, 'demo'), 'fe-member', config(), undefined, 'normal'))).not.toBe(recordOf('fe-member').qualification.sha256);
  });

  it('a sandbox.write naming a run-only path never reaches a record: the preflight refuses it inside the home (the static-duplicate rule is covered above, on the data)', async () => {
    const { inputs, summary, runDir } = await realRun({
      editYaml: (t, runs) => t.replace('    can_message: [lead]\n    can_edit_agent_md: true', `    can_message: [lead]\n    can_edit_agent_md: true\n    sandbox: { write: ["${path.join(runs, 'run-1', 'mail', 'outbox', 'fe-member')}"] }`),
    });
    expect(inputs.has('fe-member')).toBe(false); // refused before any invocation
    expect(summary.endReason).not.toBe('done');
    expect(fs.readFileSync(path.join(runDir, 'log.jsonl'), 'utf8')).toContain('"event":"sandbox-refused"');
    expect(records().filter((r) => r.proposer.slot === 'fe-member')).toEqual([]);
  });

  it('solo: the record equals the solo rebuild and not the normal one', async () => {
    const { inputs, summary, runDir } = await realRun({ solo: true });
    expect(summary.endReason).toBe('done');
    const rec = recordOf('fe-member');
    const wake = inputs.get('fe-member') as WakeInput;
    expect(rec.origin.full_writable).toEqual({ dirs: canon(writePolicy(wake.project, wake.agent, wake.proposalsDir).allowDirs), files: canon(writePolicy(wake.project, wake.agent, wake.proposalsDir).allowFiles) });
    fs.rmSync(runDir, { recursive: true, force: true });
    const fresh = resolveProject(env.home, 'demo');
    expect(hashOf(unboundSnapshotInputs(fresh, 'fe-member', config(), undefined, 'solo'))).toBe(rec.qualification.sha256);
    expect(hashOf(unboundSnapshotInputs(fresh, 'fe-member', config(), undefined, 'normal'))).not.toBe(rec.qualification.sha256);
  });
});
