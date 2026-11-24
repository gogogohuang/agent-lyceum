import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecutorsConfig } from '../src/approval-executors.js';
import { resolveProjectFrom, type ResolvedProject } from '../src/config.js';
import { approvalContainmentChecks } from '../src/doctor-approval-containment.js';
import { GlobalConfig, ProjectConfig } from '../src/schema.js';

// Only the exact foreign cwd is made to fail; every other git call runs for real.
const gitFail = vi.hoisted(() => ({ cwd: '' }));
vi.mock('node:child_process', async (orig) => {
  const real = await orig<typeof import('node:child_process')>();
  return { ...real, execFileSync: ((cmd: string, args: readonly string[], o: { cwd?: string }) => {
    if (gitFail.cwd && o?.cwd === gitFail.cwd) throw new Error('fatal: SENTINEL-GIT-STDERR');
    return (real.execFileSync as (...a: unknown[]) => unknown)(cmd, args, o);
  }) as typeof real.execFileSync };
});

let root: string;
let home: string;
let repo: string;
let repoQ: string;
let tool: string;
const put = (file: string, text = '') => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); return file; };
const config = (allowYaml: ExecutorsConfig['executors'][string]['allow'] = [{ project: 'p', agent: 'dev' }]): ExecutorsConfig => ({ executors: { x: { command: [tool], allow: allowYaml, timeout_sec: 5, env: {}, expires_days: 7, max_pending: 10, max_payload_bytes: 4096 } }, limits: { max_total_pending: 50, max_scan_entries: 200, retention_days: 90 } });
const actual = (): ResolvedProject => resolveProjectFrom(home, 'p', GlobalConfig.parse({}), ProjectConfig.parse({ dir: repo, team: { lead: 'dev' }, agents: { dev: { runtime: 'claude-code' } } }));
const disp = (o: Parameters<typeof approvalContainmentChecks>[2] = {}, cfg = config()) => approvalContainmentChecks(home, cfg, { mode: 'grants', ...o });
const disk = (name: string, dir: string, grant?: string) => put(path.join(home, 'projects', name, 'project.yaml'), `dir: ${dir}\nteam:\n  lead: dev\nagents:\n  dev:\n    runtime: claude-code\n${grant ? `    sandbox:\n      write: [${JSON.stringify(grant)}]\n` : ''}`);
beforeEach(() => {
  gitFail.cwd = '';
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'contain-disp-')));
  home = path.join(root, 'home'); repo = path.join(root, 'repo'); repoQ = path.join(root, 'repoq'); fs.mkdirSync(repo); fs.mkdirSync(repoQ);
  tool = put(path.join(root, 'bin', 'tool'));
  fs.writeFileSync(tool, Buffer.from([0x7f, 0x45, 0x4c, 0x46])); fs.chmodSync(tool, 0o755);
  put(path.join(home, 'team.yaml'), 'agents: {}\n'); disk('p', repo); disk('q', repoQ);
});
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });

describe('typed containment disposition', () => {
  it('safe active and foreign projects are clear', () => {
    expect(disp({ activeProject: 'p' }).disposition).toBe('clear');
  });
  it('a foreign project with invalid YAML is foreign-incomplete, repaired it is clear; the active one is blocked', () => {
    const q = path.join(home, 'projects', 'q', 'project.yaml');
    fs.writeFileSync(q, 'dir: [unclosed\n');
    const r = disp({ activeProject: 'p' });
    expect(r.disposition).toBe('foreign-incomplete');
    expect(r.checks.some((c) => c.level === 'error')).toBe(true);
    disk('q', repoQ);
    expect(disp({ activeProject: 'p' }).disposition).toBe('clear');
    fs.writeFileSync(path.join(home, 'projects', 'p', 'project.yaml'), 'dir: [unclosed\n');
    expect(disp({ activeProject: 'p' }).disposition).toBe('blocked');
  });
  it('a foreign project entry that is not a directory is foreign-incomplete', () => {
    fs.symlinkSync(root, path.join(home, 'projects', 'z'));
    expect(disp({ activeProject: 'p' }).disposition).toBe('foreign-incomplete');
  });
  it('a git helper failure in a foreign checkout is foreign-incomplete, in the active or an actual checkout it is blocked', () => {
    fs.mkdirSync(path.join(repoQ, '.git'));
    gitFail.cwd = repoQ;
    const r = disp({ activeProject: 'p' });
    expect(r.disposition).toBe('foreign-incomplete');
    fs.mkdirSync(path.join(repo, '.git'));
    gitFail.cwd = repo;
    expect(disp({ activeProject: 'p' }).disposition).toBe('blocked');
    gitFail.cwd = repoQ;
    expect(disp({ activeProject: 'q', executionProjects: [] }).disposition).toBe('blocked');
  });
  it('a foreign grant that cannot be canonicalized is unknown; a protected path that cannot is blocked', () => {
    fs.symlinkSync(path.join(root, 'b'), path.join(root, 'a')); fs.symlinkSync(path.join(root, 'a'), path.join(root, 'b'));
    disk('q', repoQ, path.join(root, 'a', 'x'));
    expect(disp({ activeProject: 'p' }).disposition).toBe('foreign-incomplete');
    disk('q', repoQ);
    const looped = path.join(root, 'a', 'tool');
    const cfg = config(); cfg.executors.x.command = [looped];
    expect(disp({ activeProject: 'p' }, cfg).disposition).toBe('blocked');
  });
  it('a proven overlap is blocked, also when a foreign project is unreadable at the same time', () => {
    disk('q', repoQ, path.dirname(tool));
    expect(disp({ activeProject: 'p' }).disposition).toBe('blocked');
    disk('q', repoQ, path.dirname(tool));
    disk('r', repoQ); fs.writeFileSync(path.join(home, 'projects', 'r', 'project.yaml'), 'dir: [x\n');
    expect(disp({ activeProject: 'p' }).disposition).toBe('blocked');
  });
  it('a foreign project that overlaps an actual execution project is still checked: actual overlap is blocked', () => {
    const a = actual(); a.agents.dev.sandbox = { write: [path.dirname(tool)], network: [], localBinding: false, unixSockets: [] } as never;
    fs.writeFileSync(path.join(home, 'projects', 'q', 'project.yaml'), 'dir: [x\n');
    expect(disp({ activeProject: 'p', executionProjects: [a] }).disposition).toBe('blocked');
  });
  it('an unreadable foreign project named by an executor allow entry is not escalated a second time', () => {
    fs.writeFileSync(path.join(home, 'projects', 'q', 'project.yaml'), 'dir: [x\n');
    const cfg = config([{ project: 'p', agent: 'dev' }, { project: 'q', agent: 'dev' }]);
    expect(disp({ activeProject: 'p' }, cfg).disposition).toBe('foreign-incomplete');
    const missing = config([{ project: 'p', agent: 'dev' }, { project: 'nope', agent: 'dev' }]);
    expect(disp({ activeProject: 'p' }, missing).disposition).toBe('blocked');
    const noAgent = config([{ project: 'p', agent: 'dev' }, { project: 'q', agent: 'ghost' }]);
    disk('q', repoQ);
    expect(disp({ activeProject: 'p' }, noAgent).disposition).toBe('blocked');
  });
  it('a call (activeProject null): every disk project is foreign, the actual call project is not', () => {
    fs.writeFileSync(path.join(home, 'projects', 'p', 'project.yaml'), 'dir: [x\n');
    expect(disp({ activeProject: null }).disposition).toBe('foreign-incomplete');
    const a = actual(); a.agents.dev.sandbox = { write: [path.dirname(tool)], network: [], localBinding: false, unixSockets: [] } as never;
    expect(disp({ activeProject: null, executionProjects: [a] }).disposition).toBe('blocked');
  });
  it('global agent resolution failures and a missing project list stay blocked; no activeProject means blocked', () => {
    fs.writeFileSync(path.join(home, 'projects', 'q', 'project.yaml'), 'dir: [x\n');
    expect(disp().disposition).toBe('blocked');
    fs.writeFileSync(path.join(home, 'team.yaml'), 'agents: [broken\n');
    expect(disp({ activeProject: 'p' }).disposition).toBe('blocked');
  });
  it('diagnostic mode is unchanged: no disposition field, same checks with or without activeProject', () => {
    fs.writeFileSync(path.join(home, 'projects', 'q', 'project.yaml'), 'dir: [x\n');
    const plain = approvalContainmentChecks(home, config());
    expect('disposition' in plain).toBe(false);
    expect(approvalContainmentChecks(home, config(), { activeProject: 'p' }).checks).toEqual(plain.checks);
    expect(plain.checks.some((c) => c.level === 'error' && c.message.startsWith('Approval containment scan is incomplete:'))).toBe(true);
  });
});
