import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApprovalError } from '../src/approval-error.js';
import { loadExecutors, parseExecutors, qualificationOf } from '../src/approval-executors.js';
import type { ApprovalIo } from '../src/approval-io.js';

const U = '/Users/test';
const F = '/h/executors.yaml';
const parse = (t: string) => parseExecutors(t, F, U);
const bad = (t: string) => { try { parse(t); } catch (e) { return e instanceof ApprovalError ? e : new Error('other'); } return null; };
const minimal = 'executors:\n  deploy:\n    command: ["/usr/bin/deploy"]\n    timeout_sec: 30\n    allow: [{project: p1, agent: dev}]\n';

describe('parseExecutors', () => {
  it('applies defaults and returns frozen-safe data', () => {
    const c = parse(minimal);
    expect(c.limits).toEqual({ max_total_pending: 50, max_scan_entries: 200, retention_days: 90 });
    expect(c.executors.deploy).toEqual({ command: ['/usr/bin/deploy'], allow: [{ project: 'p1', agent: 'dev' }],
      timeout_sec: 30, env: {}, expires_days: 7, max_pending: 10, max_payload_bytes: 4096 });
  });
  it('accepts empty document, empty executors and empty allow', () => {
    expect(parse('{}').executors).toEqual({});
    expect(parse('executors: {}\nlimits: {max_total_pending: 5, max_scan_entries: 6, retention_days: 7}').limits)
      .toEqual({ max_total_pending: 5, max_scan_entries: 6, retention_days: 7 });
    expect(parse('executors:\n  e: {command: ["/x"], timeout_sec: 1, allow: []}').executors.e?.allow).toEqual([]);
  });
  it('accepts call allow entries and explicit values', () => {
    const c = parse('executors:\n  e:\n    command: [/x]\n    timeout_sec: 2\n    allow: [{call: c1}, {project: p, agent: a}]\n    expires_days: 3\n    max_pending: 4\n    max_payload_bytes: 65536\n');
    expect(c.executors.e?.allow).toEqual([{ call: 'c1' }, { project: 'p', agent: 'a' }]);
    expect(c.executors.e).toMatchObject({ expires_days: 3, max_pending: 4, max_payload_bytes: 65536 });
  });
  it('expands only ~ and ~/ in env values; $VAR stays literal', () => {
    const c = parse('executors:\n  e:\n    command: [/x]\n    timeout_sec: 1\n    allow: []\n    env: {A: "~", B: "~/x", C: "$HOME/x", D: "a~b", E: "~root/x", F: ""}\n');
    expect(c.executors.e?.env).toEqual({ A: U, B: `${U}/x`, C: '$HOME/x', D: 'a~b', E: '~root/x', F: '' });
  });
  it.each([
    ['invalid yaml', 'executors: [unclosed'],
    ['top-level non-object', '- a'],
    ['unknown top key', 'extra: 1'],
    ['unknown executor key', minimal.replace('timeout_sec: 30', 'timeout_sec: 30\n    shell: true')],
    ['unknown limits key', 'limits: {x: 1}'],
    ['missing timeout', minimal.replace('    timeout_sec: 30\n', '')],
    ['missing allow', minimal.replace('    allow: [{project: p1, agent: dev}]\n', '')],
    ['missing command', minimal.replace('    command: ["/usr/bin/deploy"]\n', '')],
    ['two commands', minimal.replace('["/usr/bin/deploy"]', '["/usr/bin/deploy", "-x"]')],
    ['empty command', minimal.replace('["/usr/bin/deploy"]', '[]')],
    ['string command', minimal.replace('["/usr/bin/deploy"]', '"/usr/bin/deploy"')],
    ['relative command', minimal.replace('/usr/bin/deploy', 'deploy')],
    ['tilde command', minimal.replace('/usr/bin/deploy', '~/deploy')],
    ['zero timeout', minimal.replace('timeout_sec: 30', 'timeout_sec: 0')],
    ['float timeout', minimal.replace('timeout_sec: 30', 'timeout_sec: 1.5')],
    ['string timeout', minimal.replace('timeout_sec: 30', 'timeout_sec: "30"')],
    ['negative days', minimal.replace('timeout_sec: 30', 'timeout_sec: 30\n    expires_days: -1')],
    ['payload too big', minimal.replace('timeout_sec: 30', 'timeout_sec: 30\n    max_payload_bytes: 65537')],
    ['payload zero', minimal.replace('timeout_sec: 30', 'timeout_sec: 30\n    max_payload_bytes: 0')],
    ['bad executor name', minimal.replace('  deploy:', '  ../x:')],
    ['project and call mixed', minimal.replace('{project: p1, agent: dev}', '{project: p1, agent: dev, call: c}')],
    ['project without agent', minimal.replace('{project: p1, agent: dev}', '{project: p1}')],
    ['bad project name', minimal.replace('p1', 'a/b')],
    ['bad env key', minimal.replace('timeout_sec: 30', 'timeout_sec: 30\n    env: {"A-B": x}')],
    ['non-string env', minimal.replace('timeout_sec: 30', 'timeout_sec: 30\n    env: {A: 1}')],
    ['duplicate key', `${minimal}  deploy:\n    command: ["/x"]\n    timeout_sec: 1\n    allow: []\n`],
    ['alias', 'executors:\n  a: &x {command: [/x], timeout_sec: 1, allow: []}\n  b: *x\n'],
    ['zero limit', 'limits: {max_total_pending: 0}'],
    ['bad tag', 'executors: !!binary aGk='],
  ])('rejects %s with an error naming the file', (_n, text) => {
    const e = bad(text);
    expect(e).toBeInstanceOf(ApprovalError);
    expect((e as ApprovalError).path).toBe(F);
  });
  it('names the field path', () => {
    expect(bad(minimal.replace('timeout_sec: 30', 'timeout_sec: 0'))?.message).toContain('executors.deploy.timeout_sec');
  });
  it('does not read anything at parse time', () => {
    const spy = vi.spyOn(fs, 'readFileSync'); parse(minimal);
    expect(spy).not.toHaveBeenCalled(); spy.mockRestore();
  });
});

describe('qualificationOf', () => {
  const cfg = parse(`executors:
  zeta: {command: [/z], timeout_sec: 1, allow: [{project: p1, agent: dev}, {project: p1, agent: dev}]}
  alpha: {command: [/a], timeout_sec: 1, allow: [{project: p1, agent: dev}, {project: p2, agent: ops}]}
  callonly: {command: [/c], timeout_sec: 1, allow: [{call: dev}]}
  none: {command: [/n], timeout_sec: 1, allow: []}
`);
  it('returns the sorted unique union for a run identity', () => {
    expect(qualificationOf(cfg, { project: 'p1', role: 'dev' })).toEqual({ enrolled: true, executors: ['alpha', 'zeta'] });
  });
  it('keeps the same role in different projects distinct', () => {
    expect(qualificationOf(cfg, { project: 'p2', role: 'dev' })).toEqual({ enrolled: false, executors: [] });
    expect(qualificationOf(cfg, { project: 'p2', role: 'ops' })).toEqual({ enrolled: true, executors: ['alpha'] });
  });
  it('matches call entries only for call identities (project null)', () => {
    expect(qualificationOf(cfg, { project: null, role: 'dev' })).toEqual({ enrolled: true, executors: ['callonly'] });
    expect(qualificationOf(cfg, { project: 'p1', role: 'other' }).enrolled).toBe(false);
  });
  it('is not enrolled with a null config', () => {
    expect(qualificationOf(null, { project: 'p1', role: 'dev' })).toEqual({ enrolled: false, executors: [] });
  });
});

describe('loadExecutors', () => {
  let home: string;
  beforeEach(() => { home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'approval-exec-'))); });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));
  const calls = () => {
    const log: string[] = [];
    const target = fs as unknown as Record<string, unknown>;
    const io = new Proxy(fs, { get: (_t, k: string) => {
      const v = target[k];
      if (typeof v !== 'function') return v;
      return (...a: unknown[]) => {
        log.push(`${k}:${String(a[0])}`);
        if (k === 'mkdirSync') throw new Error('mkdir');
        return (v as (...x: unknown[]) => unknown)(...a);
      };
    } }) as unknown as ApprovalIo;
    return { io, log };
  };
  it('missing file is disabled and creates nothing', () => {
    const { io, log } = calls();
    expect(loadExecutors(home, U, io)).toEqual({ enabled: false, config: null });
    expect(fs.readdirSync(home)).toEqual([]);
    expect(log.some((l) => l.startsWith('mkdirSync'))).toBe(false);
  });
  it('loads a valid file, enabled, touching only executors.yaml', () => {
    fs.writeFileSync(path.join(home, 'executors.yaml'), minimal);
    const { io, log } = calls();
    const r = loadExecutors(home, U, io);
    expect(r.enabled).toBe(true);
    expect(r.config?.executors.deploy?.timeout_sec).toBe(30);
    for (const l of log.filter((x) => x.startsWith('openSync'))) expect(l).toBe(`openSync:${path.join(home, 'executors.yaml')}`);
  });
  it('an empty union of allows is disabled', () => {
    fs.writeFileSync(path.join(home, 'executors.yaml'), 'executors:\n  e: {command: [/x], timeout_sec: 1, allow: []}\n');
    expect(loadExecutors(home, U).enabled).toBe(false);
    fs.writeFileSync(path.join(home, 'executors.yaml'), '{}');
    expect(loadExecutors(home, U).enabled).toBe(false);
  });
  it('does not swallow invalid content, symlinks or oversize files', () => {
    fs.writeFileSync(path.join(home, 'executors.yaml'), 'executors: [');
    expect(() => loadExecutors(home, U)).toThrowError(ApprovalError);
    fs.rmSync(path.join(home, 'executors.yaml'));
    fs.writeFileSync(path.join(home, 'real.yaml'), minimal);
    fs.symlinkSync(path.join(home, 'real.yaml'), path.join(home, 'executors.yaml'));
    expect(() => loadExecutors(home, U)).toThrowError(ApprovalError);
    fs.rmSync(path.join(home, 'executors.yaml'));
    fs.writeFileSync(path.join(home, 'executors.yaml'), `# ${'x'.repeat(1024 * 1024)}\n`);
    expect(() => loadExecutors(home, U)).toThrowError(ApprovalError);
  });
});
