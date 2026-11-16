import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecutorsConfig } from '../src/approval-executors.js';
import { resolveProjectFrom, type ResolvedProject } from '../src/config.js';
import { approvalContainmentChecks } from '../src/doctor-approval-containment.js';
import { GlobalConfig, ProjectConfig } from '../src/schema.js';

let root: string;
let home: string;
let repo: string;
let tool: string;
const put = (file: string, text = '') => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); return file; };
const sym = (target: string, file: string) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.symlinkSync(target, file); };
const config = (): ExecutorsConfig => ({ executors: { x: { command: [tool], allow: [{ project: 'p', agent: 'dev' }], timeout_sec: 5, env: {}, expires_days: 7, max_pending: 10, max_payload_bytes: 4096 } }, limits: { max_total_pending: 50, max_scan_entries: 200, retention_days: 90 } });
const raw = () => ProjectConfig.parse({ dir: repo, team: { lead: 'dev' }, agents: { dev: { runtime: 'claude-code' } } });
const actual = (): ResolvedProject => resolveProjectFrom(home, 'p', GlobalConfig.parse({}), raw());
const errors = (executionProjects: readonly ResolvedProject[] = []) => approvalContainmentChecks(home, config(), { mode: 'grants', executionProjects }).checks.filter((c) => c.level === 'error');
const overlap = (ps: readonly ResolvedProject[] = []) => expect(errors(ps).some((c) => c.message.startsWith('Approval protected path overlaps'))).toBe(true);
const disk = (name: string, grant?: string) => put(path.join(home, 'projects', name, 'project.yaml'), `dir: ${repo}\nteam:\n  lead: dev\nagents:\n  dev:\n    runtime: claude-code\n${grant ? `    sandbox:\n      write: [${JSON.stringify(grant)}]\n` : ''}`);
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'contain-grants-')));
  home = path.join(root, 'home'); repo = path.join(root, 'repo'); fs.mkdirSync(repo);
  tool = put(path.join(root, 'bin', 'tool'));
  fs.writeFileSync(tool, Buffer.from([0x7f, 0x45, 0x4c, 0x46])); fs.chmodSync(tool, 0o755);
  put(path.join(home, 'team.yaml'), 'agents: {}\n'); disk('p'); disk('q');
});
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });

describe('grants omit descendant aliases only', () => {
  it.each(['p', 'q'])('depth nine in project %s is not an authority input', (name) => {
    put(path.join(home, 'projects', name, 'runs', ...Array.from({ length: 10 }, (_, i) => `d${i}`), 'file'));
    expect(errors()).toEqual([]);
    const diagnostic = approvalContainmentChecks(home, config());
    expect(diagnostic.checks.some((c) => c.message.includes('deeper than'))).toBe(true);
    expect(diagnostic).toEqual(approvalContainmentChecks(home, config(), { mode: 'diagnostic' }));
  });
  it('more than the diagnostic walk cap does not become a grant error', () => {
    const dir = path.join(home, 'projects', 'q', 'task-memory'); fs.mkdirSync(dir);
    for (let i = 0; i < 20001; i++) put(path.join(dir, `f${i}`));
    expect(errors()).toEqual([]);
    expect(approvalContainmentChecks(home, config()).checks.some((c) => c.message.includes('more than 20000'))).toBe(true);
  }, 60000);
  it.each(['p', 'q'])('executor/config/dangling/cyclic descendants in %s do not add authority', (name) => {
    const dir = path.join(home, 'projects', name, 'runs');
    sym(tool, path.join(dir, 'executor')); sym(path.join(home, 'executors.yaml'), path.join(dir, 'executors-config'));
    sym(path.join(home, 'projects', 'p', 'project.yaml'), path.join(dir, 'project-config'));
    sym(path.join(root, 'missing'), path.join(dir, 'dangling'));
    sym(path.join(dir, 'b'), path.join(dir, 'a')); sym(path.join(dir, 'a'), path.join(dir, 'b'));
    expect(errors()).toEqual([]);
  });
  it('never lists a descendant directory, including actual enrolled policy paths', () => {
    const p = actual(); p.agents.dev!.enrolled = true;
    put(path.join(home, 'projects', 'p', 'runs', 'r1', 'nested', 'mail'));
    put(path.join(home, 'projects', 'q', 'task-memory', 'deep', 'file'));
    const spy = vi.spyOn(fs, 'readdirSync');
    const open = vi.spyOn(fs, 'opendirSync');
    expect(errors([p])).toEqual([]);
    expect(spy.mock.calls.map(([dir]) => String(dir))).toEqual([path.join(home, 'projects')]);
    expect(open).not.toHaveBeenCalled();
    expect(p.agents.dev!.enrolled).toBe(true);
  });
});

describe('configured and actual grants are a union', () => {
  it.each(['equal', 'ancestor', 'descendant'])('retains sandbox.write %s overlap', (kind) => {
    const protectedDir = path.join(home, 'requests');
    disk('q', kind === 'equal' ? protectedDir : kind === 'ancestor' ? home : path.join(protectedDir, 'child'));
    overlap([actual()]);
  });
  it('retains configured unsafe grants when actual is safe', () => { const p = actual(); disk('p', path.join(home, 'requests')); overlap([p]); });
  it('retains actual unsafe teammate grants when disk is safe', () => {
    const p = actual(); p.agents.peer = { ...p.agents.dev!, name: 'peer', sandbox: { write: [tool], network: [], unixSockets: [], localBinding: false } }; overlap([p]);
  });
  it('checks every execution binding, including a later unsafe binding', () => {
    const safe = actual(); const unsafe = actual(); unsafe.dir = path.dirname(tool);
    overlap([safe, unsafe]); overlap([unsafe, safe]);
  });
  it('retains actual fallback grants', () => {
    const p = actual();
    p.agents.dev!.sandbox = { write: [tool], network: [], unixSockets: [], localBinding: false };
    p.agents.dev!.fallback = [{ runtime: 'codex' }];
    expect(errors([p]).some((c) => c.message.includes('(fallback 1)') && c.message.includes('overlaps'))).toBe(true);
  });
  it('retains actual allowFiles', () => { const p = actual(); p.agents.dev!.canEditAgentMd = true; p.agents.dev!.agentMd = tool; overlap([p]); });
  it('retains actual cwd', () => { const p = actual(); p.dir = path.dirname(tool); overlap([p]); });
  it.each(['root', 'dir', 'gitDir'])('retains actual workspace %s', (field) => {
    const p = actual();
    p.workspaces = { dev: { agent: 'dev', root: repo, dir: repo, gitDir: path.join(root, 'gitdir'), commonDir: path.join(root, 'common'), branch: 'x', base: 'x', [field]: path.dirname(tool) } };
    overlap([p]);
  });
  it('retains all global call configured grants', () => {
    put(path.join(home, 'team.yaml'), `agents:\n  helper:\n    runtime: claude-code\n    sandbox:\n      write: [${JSON.stringify(tool)}]\n`); overlap();
  });
  it.each(['task-memory', 'runs', 'worktrees'])('retains the %s envelope root', (name) => {
    sym(path.dirname(tool), path.join(home, 'projects', 'q', name)); overlap();
  });
  it('retains the calls envelope root', () => { sym(path.dirname(tool), path.join(home, 'calls')); overlap(); });
  it('retains git common dir roots', () => {
    execFileSync('git', ['init', '-q', repo]);
    tool = put(path.join(repo, '.git', 'bin', 'tool')); fs.writeFileSync(tool, Buffer.from([0x7f, 0x45, 0x4c, 0x46])); fs.chmodSync(tool, 0o755); overlap();
  });
  it.each(['root', 'ancestor'])('configured grant %s symlink still resolves protected target', (kind) => {
    const alias = path.join(root, 'alias');
    fs.mkdirSync(path.join(home, 'requests'), { recursive: true });
    sym(path.join(home, 'requests'), alias);
    disk('q', kind === 'root' ? alias : path.join(alias, 'child')); overlap();
  });
});

describe('grants preserve root uncertainty and protected hops', () => {
  it('a cyclic configured grant is an error', () => { const a = path.join(root, 'a'); const b = path.join(root, 'b'); sym(b, a); sym(a, b); disk('q', a); expect(errors().length).toBeGreaterThan(0); });
  it.each(['fifo', 'oversize'])('foreign project config %s still fails closed', (kind) => {
    const file = path.join(home, 'projects', 'q', 'project.yaml');
    if (kind === 'fifo') { fs.rmSync(file); execFileSync('mkfifo', [file]); } else fs.appendFileSync(file, '#'.repeat(1024 * 1024));
    expect(errors().some((c) => c.message.includes('project "q" config'))).toBe(true);
  });
  it('foreign transient root resolution errors remain fail closed', () => {
    const a = path.join(home, 'projects', 'q', 'runs'); sym(a, a);
    expect(errors().length).toBeGreaterThan(0);
  });
  it('protects a command middle hop and its writable directory', () => {
    sym(tool, path.join(repo, 'hop')); const command = path.join(root, 'outside', 'exec'); sym(path.join(repo, 'hop'), command); tool = command; overlap();
  });
  it('protects interpreter middle hops in grants mode', () => {
    sym(tool, path.join(repo, 'interp-hop'));
    const interp = path.join(root, 'interpreter', 'sh'); sym(path.join(repo, 'interp-hop'), interp);
    tool = put(path.join(root, 'script', 'exec'), `#!${interp}\n`); fs.chmodSync(tool, 0o755);
    expect(errors().some((c) => c.message.includes('interpreter symlink hop') && c.message.includes('project dir'))).toBe(true);
  });
  it('protects a store middle hop', () => {
    const target = path.join(root, 'store'); fs.mkdirSync(target); sym(target, path.join(repo, 'hop')); sym(path.join(repo, 'hop'), path.join(home, 'approvals')); overlap();
  });
  it('rejects command link/../x without normalizing away the link', () => {
    sym(path.dirname(tool), path.join(root, 'link')); tool = `${root}/link/../tool`;
    expect(errors().some((c) => c.message.includes("path contains '.' or '..'"))).toBe(true);
  });
});
