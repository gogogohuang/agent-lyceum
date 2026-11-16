import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { scanRecoveryInputs } from '../src/approval-wake-gate.js';
import { recoverRunMail } from '../src/message-store.js';

vi.setConfig({ testTimeout: 90_000 });
const here = path.dirname(fileURLToPath(import.meta.url));
let runDir: string;
beforeEach(() => { runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'recovery-scan-')); });
afterEach(() => fs.rmSync(runDir, { recursive: true, force: true }));

const attDir = () => path.join(runDir, 'mail', 'attempts');
const claimDir = () => path.join(runDir, 'mail', 'claims');
const put = (dir: string, name: string, body: unknown) => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, name), typeof body === 'string' ? body : JSON.stringify(body)); };
const claim = (agent: string, status: string, over: Record<string, unknown> = {}) => {
  const id = `1abc-${agent}-aaaaaa`;
  return { id, agent, message_ids: ['m1'], files: ['/x/inbox/f.md'], status, created: '2026-11-16T10:00:00.000Z', ...over };
};
const SLOTS = ['dev', 'qa'];

describe('scanRecoveryInputs: the entry cap counts every entry, not only .json names', () => {
  it('overflows on a folder of non-JSON names (cap 3, six junk files)', () => {
    for (let i = 0; i < 6; i++) put(claimDir(), `junk-${i}`, 'x');
    const r = scanRecoveryInputs(runDir, SLOTS, 3);
    expect(r.overflow).toBe(true);
    expect([...r.quarantined].sort()).toEqual([...SLOTS].sort());
    expect(r.allowed.claims.size).toBe(0);
  });
  it('overflows on mixed json and non-json names (cap 3: two json plus three junk)', () => {
    const c = claim('dev', 'committed');
    put(claimDir(), `${c.id}.json`, c);
    put(claimDir(), 'other-1abc-qa-bbbbbb.json', '{}');
    for (let i = 0; i < 3; i++) put(claimDir(), `junk-${i}`, 'x');
    expect(scanRecoveryInputs(runDir, SLOTS, 3).overflow).toBe(true);
  });
  it('does not overflow when the total entry count is within the cap', () => {
    const c = claim('dev', 'committed');
    put(claimDir(), `${c.id}.json`, c);
    put(claimDir(), 'junk-0', 'x');
    expect(scanRecoveryInputs(runDir, SLOTS, 3).overflow).toBe(false);
  });
});

describe('scanRecoveryInputs: full validation of what recovery consumes', () => {
  it('a well-formed claim of every status is allowed and quarantines nothing', () => {
    for (const status of ['claimed', 'output_ready', 'committed', 'abandoned']) {
      const c = claim('dev', status);
      put(claimDir(), `${c.id}.json`, c);
    }
    const r = scanRecoveryInputs(runDir, SLOTS);
    expect([...r.quarantined]).toEqual([]);
    expect(r.allowed.claims.has('1abc-dev-aaaaaa.json')).toBe(true);
  });
  const bad: [string, (c: Record<string, unknown>) => void][] = [
    ['files missing (the reviewer case)', (c) => { delete c.files; }],
    ['files not an array', (c) => { c.files = 'x'; }],
    ['a file entry that is not a string', (c) => { c.files = [1]; }],
    ['a file entry with a NUL', (c) => { c.files = ['a\0b']; }],
    ['too many files', (c) => { c.files = Array.from({ length: 5001 }, () => 'f'); }],
    ['message_ids missing', (c) => { delete c.message_ids; }],
    ['message_ids with a non-string', (c) => { c.message_ids = [null]; }],
    ['status outside the enum', (c) => { c.status = 'weird'; }],
    ['id different from the file name', (c) => { c.id = '1abc-dev-bbbbbb'; }],
    ['id that is not a plain name', (c) => { c.id = '../x'; }],
    ['agent of another slot', (c) => { c.agent = 'qa'; }],
    ['created not a string', (c) => { c.created = 5; }],
  ];
  for (const [name, mutate] of bad) {
    it(`a claim of an enrolled slot with ${name} quarantines that slot only and is not readable by recovery`, () => {
      const c = claim('dev', 'committed');
      mutate(c);
      put(claimDir(), '1abc-dev-aaaaaa.json', c);
      const ok = claim('qa', 'claimed');
      put(claimDir(), `${ok.id}.json`, ok);
      const r = scanRecoveryInputs(runDir, SLOTS);
      expect([...r.quarantined]).toEqual(['dev']);
      expect(r.allowed.claims.has('1abc-dev-aaaaaa.json')).toBe(false);
      expect(r.allowed.claims.has('1abc-qa-aaaaaa.json')).toBe(true);
    });
  }
  it('a damaged or mismatched attempt of an enrolled slot quarantines it; a good one is allowed', () => {
    const att = { id: '1abc-dev-aaaaaa-a1', claim_id: '1abc-dev-aaaaaa', agent: 'dev', n: 1, status: 'started', started_at: '2026-11-16T10:00:00.000Z' };
    put(attDir(), `${att.id}.json`, att);
    put(claimDir(), '1abc-dev-aaaaaa.json', claim('dev', 'claimed'));
    expect([...scanRecoveryInputs(runDir, SLOTS).quarantined]).toEqual([]);
    put(attDir(), '1abc-dev-aaaaaa-a2.json', { ...att, id: '1abc-dev-aaaaaa-a2', n: 3 });
    const r = scanRecoveryInputs(runDir, SLOTS);
    expect([...r.quarantined]).toEqual(['dev']);
    expect(r.allowed.attempts.has('1abc-dev-aaaaaa-a2.json')).toBe(false);
  });
  it('unknown names, FIFOs, symlinks and over-limit files are never allowed, never block, and never quarantine another slot', () => {
    fs.mkdirSync(attDir(), { recursive: true });
    fs.mkdirSync(claimDir(), { recursive: true });
    execFileSync('mkfifo', [path.join(attDir(), 'dev.json')]);
    execFileSync('mkfifo', [path.join(claimDir(), 'dev.json')]);
    fs.symlinkSync('/etc/hosts', path.join(claimDir(), '1abc-qa-cccccc.json'));
    put(claimDir(), '1abc-other-dddddd.json', 'x'.repeat(70_000));
    execFileSync('mkfifo', [path.join(claimDir(), '1abc-other-eeeeee.json')]);
    const ok = claim('qa', 'claimed');
    put(claimDir(), `${ok.id}.json`, ok);
    const r = scanRecoveryInputs(runDir, SLOTS);
    expect(r.allowed.attempts.size).toBe(0);
    expect(r.allowed.claims.size).toBe(0); // qa is quarantined, so its own valid file is not read either
    // the symlink carries qa's name: qa is quarantined (fail closed); dev has only an unknown-name FIFO, which owns nobody
    expect([...r.quarantined]).toEqual(['qa']);
    expect(r.excluded).toBeGreaterThanOrEqual(5);
  });
  it('a file of another agent that is a plain valid regular file stays readable by legacy recovery (not broadened)', () => {
    const c = claim('lead', 'claimed', { files: undefined });
    put(claimDir(), `${c.id}.json`, c);
    const r = scanRecoveryInputs(runDir, SLOTS);
    expect(r.allowed.claims.has('1abc-lead-aaaaaa.json')).toBe(true);
    expect([...r.quarantined]).toEqual([]);
  });
  it('more entries than the cap fails closed: everything is quarantined and nothing is allowed', () => {
    for (let i = 0; i < 5; i++) put(claimDir(), `1abc-qa-a0000${i}.json`, claim('qa', 'claimed', { id: `1abc-qa-a0000${i}` }));
    const r = scanRecoveryInputs(runDir, SLOTS, 3);
    expect(r.overflow).toBe(true);
    expect([...r.quarantined].sort()).toEqual(SLOTS);
    expect(r.allowed.claims.size + r.allowed.attempts.size).toBe(0);
  });
  it('a directory that fails to close fails closed', () => {
    put(claimDir(), '1abc-qa-aaaaaa.json', claim('qa', 'claimed'));
    const real = fs.opendirSync.bind(fs);
    const spy = vi.spyOn(fs, 'opendirSync').mockImplementation(((...a: Parameters<typeof fs.opendirSync>) => {
      const d = real(...a);
      return { readSync: () => d.readSync(), closeSync: () => { d.closeSync(); throw Object.assign(new Error('I/O'), { code: 'EIO' }); } };
    }) as never);
    try {
      const r = scanRecoveryInputs(runDir, SLOTS);
      expect(r.overflow).toBe(true);
      expect([...r.quarantined].sort()).toEqual(SLOTS);
    } finally { spy.mockRestore(); }
  });
  it('an absent mail directory is fine', () => {
    const r = scanRecoveryInputs(runDir, SLOTS);
    expect([...r.quarantined]).toEqual([]);
    expect(r.overflow).toBe(false);
  });
});

describe('recoverRunMail with the scan as its allow-list', () => {
  it('only allowed names are opened: a malformed enrolled claim cannot throw, a healthy peer claim is recovered', () => {
    put(claimDir(), '1abc-dev-aaaaaa.json', { id: '1abc-dev-aaaaaa', agent: 'dev', status: 'committed' });
    const qa = claim('qa', 'claimed');
    put(claimDir(), `${qa.id}.json`, qa);
    const scan = scanRecoveryInputs(runDir, SLOTS);
    const rec = recoverRunMail(runDir, { skipFile: (name, kind) => !scan.allowed[kind].has(name) });
    expect(rec.abandoned.map((c) => c.id)).toEqual(['1abc-qa-aaaaaa']);
  });
  it('without the parameter the legacy behaviour is unchanged (the malformed claim still throws)', () => {
    put(claimDir(), '1abc-dev-aaaaaa.json', { id: '1abc-dev-aaaaaa', agent: 'dev', status: 'committed' });
    expect(() => recoverRunMail(runDir)).toThrow();
  });
});

describe('enrolled resume in its own process, under an external timeout', () => {
  const tsx = path.join(here, '..', 'node_modules', '.bin', 'tsx');
  const child = path.join(here, 'approval-recovery-child.ts');
  for (const kind of ['unknown-attempt-fifo', 'unknown-claim-fifo', 'malformed-claim']) {
    it(`${kind}: the resume finishes, the healthy peer progresses and a slot with a damaged claim is not woken`, () => {
      const r = spawnSync(tsx, [child, kind], { encoding: 'utf8', timeout: 60_000, killSignal: 'SIGKILL', env: process.env });
      expect(r.error, r.stderr).toBeUndefined();
      expect(r.status, r.stderr).toBe(0);
      const out = JSON.parse(r.stdout.trim().split('\n').at(-1) as string);
      expect(out.end).toBe('done');
      expect(out.seen).toContain('qa-member');
      // an unknown name owns no slot, so fe-member (whose own files are fine) is not blamed; a damaged claim of its own quarantines it
      if (kind === 'malformed-claim') expect(out.seen).not.toContain('fe-member');
      expect(out.qaClaim).not.toBe('claimed');
      if (kind === 'malformed-claim') expect(out.gate['fe-member']).toMatchObject({ class: 'skipped', code: 'UNDETERMINABLE' });
    });
  }
});
