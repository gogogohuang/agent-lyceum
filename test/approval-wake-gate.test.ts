import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GATE_TEXT, quarantinedSlots, baselineFor, loadFreshView, qualificationVerdict, readGateFile, slotDirVerdict, slotSnapshotInputs, writeGateFile } from '../src/approval-wake-gate.js';
import type { FreshView, GateCode, GateVerdict } from '../src/approval-wake-gate.js';
import type { ResolvedProject } from '../src/config.js';
import { bindRunProject } from '../src/run-store.js';
import { soloProject } from '../src/solo.js';
import { qualificationHash } from '../src/approval-origin.js';

vi.setConfig({ testTimeout: 30_000 });

const SECRET = 'SENTINEL-SECRET-7f3a';
const SPATH = 'SENTINEL-PATH-9c1d';
let root: string; let home: string; let repo: string; let tool: string; let runDir: string;
const mk = (p: string, text = '', mode?: number): string => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
  if (mode !== undefined) fs.chmodSync(p, mode);
  return p;
};
const projFile = () => path.join(home, 'projects', 'p', 'project.yaml');
const projYaml = (o: { dir?: string; dev?: string; qa?: string } = {}): string =>
  `dir: ${o.dir ?? repo}\nteam:\n  lead: lead\nagents:\n  lead:\n    runtime: claude-code\n  dev:\n    runtime: claude-code\n${o.dev ?? ''}  qa:\n    runtime: claude-code\n${o.qa ?? ''}`;
const execYaml = (allow = '[{project: p, agent: dev}]', extra = ''): string =>
  `executors:\n  x:\n    command: ["${tool}"]\n    allow: ${allow}\n    timeout_sec: 5\n    env:\n      TOKEN: ${SECRET}\n${extra}`;
const popts = { platform: 'linux' as const, sandboxAvailable: () => true };
const bindPlain = (p: ResolvedProject): ResolvedProject => bindRunProject(p, runDir, 'run');
const load = (bind = bindPlain) => loadFreshView({ home, project: 'p', userHome: root, bind, premise: popts });
function view(bind = bindPlain): FreshView {
  const r = load(bind);
  if (!r.ok) throw new Error(`load failed: ${r.code}`);
  return r.view;
}
const verdictOf = (v: GateVerdict) => (v.kind === 'wake' ? 'wake' : `${v.kind}:${v.code}`);

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wake-gate-')));
  home = path.join(root, 'home');
  repo = path.join(root, 'repo');
  runDir = path.join(home, 'projects', 'p', 'runs', 'run-1');
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(runDir, { recursive: true });
  tool = mk(path.join(root, 'exec', 'bin', 'tool'), '#!/bin/sh\nexit 0\n', 0o755);
  mk(path.join(home, 'team.yaml'), 'agents:\n  helper:\n    runtime: claude-code\n');
  mk(projFile(), projYaml());
  mk(path.join(home, 'executors.yaml'), execYaml());
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('baseline and qualification verdict', () => {
  it('same config gives same hashes for bound lead/member/solo, whatever the run dir', () => {
    const other = path.join(home, 'projects', 'p', 'runs', 'run-2');
    fs.mkdirSync(other, { recursive: true });
    for (const slot of ['dev', 'lead']) {
      mk(path.join(home, 'executors.yaml'), execYaml(`[{project: p, agent: ${slot}}]`));
      const a = view();
      const b = view((p) => bindRunProject(p, other, 'run'));
      const ha = baselineFor(a.bound, slot, a.config, 'run-1').hashes;
      expect([...ha.keys()]).toEqual(['x']);
      expect(baselineFor(b.bound, slot, b.config, 'run-2').hashes).toEqual(ha);
      expect(qualificationVerdict(baselineFor(a.bound, slot, a.config, 'run-1'), view())).toEqual({ kind: 'wake' });
    }
    const solo = (p: ResolvedProject) => bindRunProject(soloProject(p, 'dev'), runDir, 'run');
    mk(path.join(home, 'executors.yaml'), execYaml());
    const s1 = view(solo);
    const base = baselineFor(s1.bound, 'dev', s1.config, 'run-1');
    expect(base.hashes.size).toBe(1);
    expect(qualificationVerdict(base, view(solo))).toEqual({ kind: 'wake' });
  });
  it('slot inputs hold exactly the allowed executors and are absolute-path clean', () => {
    const v = view();
    const inputs = slotSnapshotInputs(v.bound, 'dev', v.config);
    expect([...inputs.keys()]).toEqual(['x']);
    expect(() => qualificationHash(inputs.get('x') as never)).not.toThrow();
    expect(slotSnapshotInputs(v.bound, 'qa', v.config).size).toBe(0);
  });
  it('sandbox.write change gives SNAPSHOT_MISMATCH', () => {
    const base = baselineFor(view().bound, 'dev', view().config, 'run-1');
    const extra = path.join(root, 'extra');
    fs.mkdirSync(extra);
    mk(projFile(), projYaml({ dev: `    sandbox:\n      write: [${extra}]\n` }));
    expect(verdictOf(qualificationVerdict(base, view()))).toBe('refused:SNAPSHOT_MISMATCH');
  });
  it('executor added for the role gives SNAPSHOT_MISMATCH; removed gives NOT_ALLOWED', () => {
    const base = baselineFor(view().bound, 'dev', view().config, 'run-1');
    mk(path.join(home, 'executors.yaml'), execYaml('[{project: p, agent: dev}]', `  y:\n    command: ["${tool}"]\n    allow: [{project: p, agent: dev}]\n    timeout_sec: 5\n`));
    expect(verdictOf(qualificationVerdict(base, view()))).toBe('refused:SNAPSHOT_MISMATCH');
    mk(path.join(home, 'executors.yaml'), execYaml('[{project: p, agent: qa}]'));
    expect(verdictOf(qualificationVerdict(base, view()))).toBe('refused:NOT_ALLOWED');
    mk(path.join(home, 'executors.yaml'), 'executors: {}\n');
    expect(verdictOf(qualificationVerdict(base, view()))).toBe('refused:EXECUTOR_MISSING');
    fs.rmSync(path.join(home, 'executors.yaml'));
    expect(verdictOf(qualificationVerdict(base, view()))).toBe('refused:EXECUTOR_MISSING');
  });
  it('an executor entry change (timeout, env) gives SNAPSHOT_MISMATCH', () => {
    const base = baselineFor(view().bound, 'dev', view().config, 'run-1');
    mk(path.join(home, 'executors.yaml'), execYaml().replace('timeout_sec: 5', 'timeout_sec: 6'));
    expect(verdictOf(qualificationVerdict(base, view()))).toBe('refused:SNAPSHOT_MISMATCH');
  });
  it('project dir canonical change gives PROJECT_PATH_MISMATCH', () => {
    const base = baselineFor(view().bound, 'dev', view().config, 'run-1');
    const moved = path.join(root, SPATH);
    fs.mkdirSync(moved);
    mk(projFile(), projYaml({ dir: moved }));
    expect(verdictOf(qualificationVerdict(base, view()))).toBe('refused:PROJECT_PATH_MISMATCH');
    // a symlink to the original dir keeps the canonical path: not a mismatch
    fs.rmSync(moved, { recursive: true });
    fs.symlinkSync(repo, moved);
    mk(projFile(), projYaml({ dir: moved }));
    expect(qualificationVerdict(base, view())).toEqual({ kind: 'wake' });
  });
  it('missing project.yaml gives PROJECT_MISSING', () => {
    fs.rmSync(projFile());
    expect(load()).toEqual({ ok: false, code: 'PROJECT_MISSING' });
  });
  it('a role removed from the team gives AGENT_MISSING', () => {
    const base = baselineFor(view().bound, 'dev', view().config, 'run-1');
    mk(projFile(), 'dir: ' + repo + '\nteam:\n  lead: lead\nagents:\n  lead:\n    runtime: claude-code\n');
    expect(verdictOf(qualificationVerdict(base, view()))).toBe('refused:AGENT_MISSING');
  });
  it('a slot with no executors has no baseline hashes, and the verdict is NO_BASELINE', () => {
    const v = view();
    const base = baselineFor(v.bound, 'qa', v.config, 'run-1');
    expect(base.hashes.size).toBe(0);
    expect(verdictOf(qualificationVerdict(base, v))).toBe('refused:NO_BASELINE');
  });
  it('premise error in another enrolled agent refuses with project-premises', () => {
    mk(path.join(home, 'executors.yaml'), execYaml('[{project: p, agent: dev}, {project: p, agent: qa}]'));
    mk(projFile(), projYaml());
    const base = baselineFor(view().bound, 'dev', view().config, 'run-1');
    expect(qualificationVerdict(base, view())).toEqual({ kind: 'wake' });
    mk(projFile(), projYaml({ qa: '    allow_web: search\n' }));
    expect(qualificationVerdict(base, view())).toEqual({ kind: 'refused', code: 'PREMISE_FAILED', premises: ['project-premises'] });
  });
  it('containment error refuses with containment', () => {
    const base = baselineFor(view().bound, 'dev', view().config, 'run-1');
    mk(projFile(), projYaml({ qa: `    sandbox:\n      write: [${path.dirname(tool)}]\n` }));
    expect(qualificationVerdict(base, view())).toEqual({ kind: 'refused', code: 'PREMISE_FAILED', premises: ['containment'] });
  });
  it('premises given by the caller are the only ones judged (pure): a failing premise refuses', () => {
    const v = view();
    const base = baselineFor(v.bound, 'dev', v.config, 'run-1');
    const bad: FreshView = { ...v, premises: [{ check: 'project-premises', ok: false, code: 'failed' }, { check: 'containment', ok: false, code: 'failed' }] };
    expect(qualificationVerdict(base, bad)).toEqual({ kind: 'refused', code: 'PREMISE_FAILED', premises: ['project-premises', 'containment'] });
  });
});

describe('slot directory verdict', () => {
  const ref = { kind: 'run', project: 'p', run_id: 'run-1', slot: 'dev' } as const;
  const slotRoot = () => path.join(home, 'requests', 'projects', 'p', 'run-1', 'dev');
  const verdict = () => verdictOf(slotDirVerdict(home, ref, runDir, 'dev', 50));
  it('slot dir absent is wake (nothing is created)', () => {
    expect(verdict()).toBe('wake');
    expect(fs.existsSync(path.join(home, 'requests'))).toBe(false);
  });
  it('slot dir without proposals, or with an empty proposals dir, is wake', () => {
    fs.mkdirSync(slotRoot(), { recursive: true });
    expect(verdict()).toBe('wake');
    fs.mkdirSync(path.join(slotRoot(), 'proposals'));
    expect(verdict()).toBe('wake');
  });
  it('symlinked slot root / ancestor / proposals / non-directory is DIR_ANOMALY', () => {
    const elsewhere = path.join(root, 'elsewhere');
    fs.mkdirSync(path.join(elsewhere, 'proposals'), { recursive: true });
    fs.mkdirSync(path.dirname(slotRoot()), { recursive: true });
    fs.symlinkSync(elsewhere, slotRoot());
    expect(verdict()).toBe('skipped:DIR_ANOMALY');
    fs.rmSync(slotRoot());
    fs.mkdirSync(slotRoot());
    fs.symlinkSync(elsewhere, path.join(slotRoot(), 'proposals'));
    expect(verdict()).toBe('skipped:DIR_ANOMALY');
    fs.rmSync(path.join(slotRoot(), 'proposals'));
    fs.writeFileSync(path.join(slotRoot(), 'proposals'), 'x');
    expect(verdict()).toBe('skipped:DIR_ANOMALY');
    fs.rmSync(slotRoot(), { recursive: true });
    fs.rmSync(path.join(home, 'requests', 'projects', 'p', 'run-1'), { recursive: true });
    fs.symlinkSync(elsewhere, path.join(home, 'requests', 'projects', 'p', 'run-1'));
    expect(verdict()).toBe('skipped:DIR_ANOMALY');
  });
  it('an I/O error from lstat is DIR_ANOMALY', () => {
    const io = { ...fs, lstatSync: () => { throw Object.assign(new Error('x'), { code: 'EACCES' }); } } as never;
    expect(verdictOf(slotDirVerdict(home, ref, runDir, 'dev', 50, io))).toBe('skipped:DIR_ANOMALY');
  });
  const attempt = (claim: string, attemptStatus = 'output_ready') => {
    const claimId = '1abc-dev-aaaaaa';
    mk(path.join(runDir, 'mail', 'claims', `${claimId}.json`), JSON.stringify({ id: claimId, agent: 'dev', message_ids: [], files: [], status: claim, created: 'x' }));
    mk(path.join(runDir, 'mail', 'attempts', `${claimId}-a1.json`), JSON.stringify({ id: `${claimId}-a1`, claim_id: claimId, agent: 'dev', n: 1, status: attemptStatus, started_at: '2026-11-16T10:00:00.000Z' }));
  };
  const nonEmpty = () => mk(path.join(slotRoot(), 'proposals', 'f.json'), '{}');
  it('non-empty proposals with output_ready / committed / abandoned claim is RESIDUAL_OUTPUT', () => {
    nonEmpty();
    for (const c of ['output_ready', 'committed', 'abandoned']) {
      fs.rmSync(path.join(runDir, 'mail'), { recursive: true, force: true });
      attempt(c);
      expect(verdict(), c).toBe('skipped:RESIDUAL_OUTPUT');
    }
    fs.rmSync(path.join(runDir, 'mail'), { recursive: true, force: true });
    attempt('claimed', 'failed');
    expect(verdict()).toBe('skipped:RESIDUAL_OUTPUT');
  });
  it('non-empty proposals: no attempt, an unsettled claim, a corrupt or FIFO attempt is UNDETERMINABLE', () => {
    nonEmpty();
    expect(verdict()).toBe('skipped:UNDETERMINABLE');
    attempt('claimed', 'started');
    expect(verdict()).toBe('skipped:UNDETERMINABLE');
    const f = path.join(runDir, 'mail', 'attempts', '1abc-dev-aaaaaa-a1.json');
    fs.writeFileSync(f, '{bad');
    expect(verdict()).toBe('skipped:UNDETERMINABLE');
    fs.rmSync(f);
    execFileSync('mkfifo', [f]);
    expect(verdict()).toBe('skipped:UNDETERMINABLE');
  });
});

describe('gate file', () => {
  const entry = { class: 'refused', code: 'SNAPSHOT_MISMATCH', at: '2026-11-16T10:00:00.000Z' } as const;
  const file = () => path.join(runDir, 'approval-gate.json');
  it('absent reads as undefined; round-trips; rewriting replaces', () => {
    expect(readGateFile(runDir)).toBeUndefined();
    writeGateFile(runDir, { dev: entry });
    expect(readGateFile(runDir)).toEqual({ slots: { dev: entry } });
    expect(JSON.parse(fs.readFileSync(file(), 'utf8')).schema_version).toBe(1);
    writeGateFile(runDir, {});
    expect(readGateFile(runDir)).toEqual({ slots: {} });
  });
  it('unknown version, corrupt, wrong shape, unknown code, FIFO, symlink and over-limit files read as unreadable', () => {
    const bodies = ['{bad', JSON.stringify({ schema_version: 2, slots: {} }), JSON.stringify({ schema_version: 1, slots: { dev: { ...entry, code: 'WHO' } } }),
      JSON.stringify({ schema_version: 1, slots: {}, extra: 1 }), JSON.stringify({ schema_version: 1, slots: { dev: { ...entry, class: 'x' } } })];
    for (const b of bodies) { fs.writeFileSync(file(), b); expect(readGateFile(runDir), b).toBe('unreadable'); }
    fs.writeFileSync(file(), JSON.stringify({ schema_version: 1, slots: {}, pad: 'x'.repeat(70_000) }));
    expect(readGateFile(runDir)).toBe('unreadable');
    fs.rmSync(file());
    execFileSync('mkfifo', [file()]);
    expect(readGateFile(runDir)).toBe('unreadable');
    fs.rmSync(file());
    fs.writeFileSync(path.join(root, 't.json'), '{}');
    fs.symlinkSync(path.join(root, 't.json'), file());
    expect(readGateFile(runDir)).toBe('unreadable');
  });
});

describe('bounded fresh config read (R1)', () => {
  const globalFile = () => path.join(home, 'team.yaml');
  const cases: [string, string][] = [['global', 'team.yaml'], ['project', path.join('projects', 'p', 'project.yaml')]];
  for (const [label, rel] of cases) {
    it(`${label} YAML: FIFO, symlink, over 1 MiB and bad YAML map to CONFIG_INVALID without blocking`, () => {
      const f = path.join(home, rel);
      const orig = fs.readFileSync(f, 'utf8');
      fs.rmSync(f);
      execFileSync('mkfifo', [f]);
      expect(load()).toEqual({ ok: false, code: 'CONFIG_INVALID' });
      fs.rmSync(f);
      mk(path.join(root, 'real.yaml'), orig);
      fs.symlinkSync(path.join(root, 'real.yaml'), f);
      expect(load()).toEqual({ ok: false, code: 'CONFIG_INVALID' });
      fs.rmSync(f);
      fs.writeFileSync(f, `${orig}\n# ${'x'.repeat(1024 * 1024 + 10)}\n`);
      expect(load()).toEqual({ ok: false, code: 'CONFIG_INVALID' });
      fs.writeFileSync(f, 'dir: [\n');
      expect(load()).toEqual({ ok: false, code: 'CONFIG_INVALID' });
      fs.writeFileSync(f, orig);
      expect(load().ok).toBe(true);
    });
  }
  it('executors.yaml FIFO or invalid maps to CONFIG_INVALID; missing global config too', () => {
    const f = path.join(home, 'executors.yaml');
    fs.rmSync(f);
    execFileSync('mkfifo', [f]);
    expect(load()).toEqual({ ok: false, code: 'CONFIG_INVALID' });
    fs.rmSync(f);
    fs.writeFileSync(f, 'executors: [\n');
    expect(load()).toEqual({ ok: false, code: 'CONFIG_INVALID' });
    fs.writeFileSync(f, execYaml());
    fs.rmSync(globalFile());
    expect(load()).toEqual({ ok: false, code: 'CONFIG_INVALID' });
  });
});

describe('fixed text only (sentinels)', () => {
  it('GATE_TEXT has an entry per code and no sentinel, path or placeholder', () => {
    const codes: GateCode[] = ['PROJECT_MISSING', 'PROJECT_PATH_MISMATCH', 'AGENT_MISSING', 'EXECUTOR_MISSING', 'NOT_ALLOWED', 'PREMISE_FAILED',
      'SNAPSHOT_MISMATCH', 'CONFIG_INVALID', 'ORIGIN_UNREADABLE', 'NO_BASELINE', 'DIR_ANOMALY', 'RESIDUAL_OUTPUT', 'UNDETERMINABLE'];
    expect(Object.keys(GATE_TEXT).sort()).toEqual([...codes].sort());
    const text = JSON.stringify(GATE_TEXT);
    for (const bad of [SECRET, SPATH, root, '${', '/']) expect(text).not.toContain(bad);
    for (const t of Object.values(GATE_TEXT)) { expect(t.mail.length).toBeGreaterThan(0); expect(t.status.length).toBeGreaterThan(0); }
  });
  it('verdicts and the side file from refusals carry neither the secret env value nor a sentinel path', () => {
    const base = baselineFor(view().bound, 'dev', view().config, 'run-1');
    const moved = path.join(root, SPATH);
    fs.mkdirSync(moved);
    const refusals: GateVerdict[] = [];
    mk(projFile(), projYaml({ dir: moved }));
    refusals.push(qualificationVerdict(base, view()));
    mk(projFile(), projYaml({ dev: `    sandbox:\n      write: [${moved}]\n` }));
    refusals.push(qualificationVerdict(base, view()));
    mk(projFile(), projYaml({ qa: `    sandbox:\n      write: [${path.dirname(tool)}]\n` }));
    mk(path.join(home, 'executors.yaml'), execYaml('[{project: p, agent: dev}, {project: p, agent: qa}]'));
    refusals.push(qualificationVerdict(base, view()));
    mk(path.join(home, 'executors.yaml'), execYaml().replace('timeout_sec: 5', 'timeout_sec: 9'));
    refusals.push(qualificationVerdict(base, view()));
    const bad = path.join(root, SPATH, 'x.yaml');
    mk(bad, 'executors: [\n');
    fs.rmSync(path.join(home, 'executors.yaml'));
    fs.symlinkSync(bad, path.join(home, 'executors.yaml'));
    const failed = load();
    expect(failed).toEqual({ ok: false, code: 'CONFIG_INVALID' });
    expect(refusals.every((r) => r.kind === 'refused')).toBe(true);
    const slots = Object.fromEntries(refusals.map((r, i) => [`s${i}`, { class: 'refused' as const, code: (r as { code: GateCode }).code, at: '2026-11-16T10:00:00.000Z' }]));
    writeGateFile(runDir, slots);
    const bytes = fs.readFileSync(path.join(runDir, 'approval-gate.json'), 'utf8');
    for (const out of [JSON.stringify(refusals), JSON.stringify(failed), bytes]) {
      for (const bad2 of [SECRET, SPATH, root]) expect(out).not.toContain(bad2);
    }
  });
});

describe('directory close failures never turn into a wake or an all-clear', () => {
  const ref = { kind: 'run', project: 'p', run_id: 'run-1', slot: 'dev' } as const;
  const proposals = () => path.join(home, 'requests', 'projects', 'p', 'run-1', 'dev', 'proposals');
  const failingClose = () => {
    const real = fs.opendirSync.bind(fs);
    return vi.spyOn(fs, 'opendirSync').mockImplementation(((...a: Parameters<typeof fs.opendirSync>) => {
      const d = real(...a);
      return { readSync: () => d.readSync(), closeSync: () => { d.closeSync(); throw Object.assign(new Error('I/O'), { code: 'EIO' }); } };
    }) as never);
  };
  it('an empty proposals dir whose close fails is DIR_ANOMALY', () => {
    fs.mkdirSync(proposals(), { recursive: true });
    const spy = failingClose();
    try { expect(verdictOf(slotDirVerdict(home, ref, runDir, 'dev', 50))).toBe('skipped:DIR_ANOMALY'); } finally { spy.mockRestore(); }
  });
  it('a non-empty proposals dir is never a wake when closes fail (the attempt scan also fails: UNDETERMINABLE)', () => {
    mk(path.join(proposals(), 'f.json'), '{}');
    const claimId = '1abc-dev-aaaaaa';
    mk(path.join(runDir, 'mail', 'claims', `${claimId}.json`), JSON.stringify({ id: claimId, agent: 'dev', status: 'committed' }));
    mk(path.join(runDir, 'mail', 'attempts', `${claimId}-a1.json`), JSON.stringify({ id: `${claimId}-a1`, claim_id: claimId, agent: 'dev', n: 1, status: 'committed', started_at: '2026-11-16T10:00:00.000Z' }));
    const spy2 = failingClose();
    try { expect(verdictOf(slotDirVerdict(home, ref, runDir, 'dev', 50))).toBe('skipped:UNDETERMINABLE'); } finally { spy2.mockRestore(); }
  });
  it('the recovery preflight quarantines every slot when a scan directory fails to close', () => {
    mk(path.join(runDir, 'mail', 'claims', 'x.txt'), '');
    const spy = failingClose();
    try { expect([...quarantinedSlots(runDir, ['dev', 'qa'])].sort()).toEqual(['dev', 'qa']); } finally { spy.mockRestore(); }
  });
});
