import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { callApprovalView, collectApprovedCall, publishCallApprovalOk, type CallApprovalOk } from '../src/approval-call.js';
import { requestPaths } from '../src/approval-paths.js';
import { listCommittedIds } from '../src/approval-store.js';
import { setOsSandboxForTest } from '../src/policy.js';
import { COMMANDS } from '../web/src/commands.js';
import { makeEnv, write, type TestEnv } from './helpers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(here, '..', 'src', 'cli.ts');
const tsx = path.join(here, '..', 'node_modules', '.bin', 'tsx');
const PREMISE = { platform: 'linux' as const, sandboxAvailable: () => true };
const REQ = (body: string) => `executor: x\n\n${body}`;

let env: TestEnv;
afterEach(() => {
  setOsSandboxForTest(undefined);
  env?.cleanup();
});

function enroll(): void {
  env = makeEnv();
  setOsSandboxForTest(true);
  const tool = path.join(env.root, 'exec', 'bin', 'tool');
  write(tool, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(tool, 0o755);
  fs.writeFileSync(path.join(env.home, 'executors.yaml'),
    `executors:\n  x:\n    command: ["${tool}"]\n    allow: [{call: fe-member}]\n    timeout_sec: 5\n`);
}

/** Temp bin with an executable `bwrap`, so a Linux child does not need the host's bwrap. */
function childPath(): string {
  const bin = path.join(env.root, 'fake-bin');
  fs.mkdirSync(bin, { recursive: true });
  const stub = path.join(bin, 'bwrap');
  if (!fs.existsSync(stub)) {
    fs.writeFileSync(stub, '#!/bin/sh\nexit 0\n');
    fs.chmodSync(stub, 0o755);
  }
  return `${bin}${path.delimiter}${process.env.PATH ?? ''}`;
}

function run(args: string[], extraEnv: NodeJS.ProcessEnv = {}) {
  const nodeOptions = [extraEnv.NODE_OPTIONS, process.env.NODE_OPTIONS].filter((value) => value).join(' ');
  return spawnSync(tsx, [cli, '--home', env.home, ...args], {
    encoding: 'utf8',
    timeout: 20_000,
    env: {
      ...process.env,
      ...extraEnv,
      PATH: childPath(),
      ...(nodeOptions ? { NODE_OPTIONS: nodeOptions } : {}),
    },
  });
}

const absent = (id: string) => `Call ${id}: no ok.json; nothing collected.\n`;
const complete = (id: string) => `Call ${id}: approval collection complete.\n`;
const invalid = (id: string) => `Call ${id}: invalid or unsupported requests/calls/${id}/ok.json; no collection attempted.\n`;
const retained = (id: string, code: string) =>
  `Call ${id}: approval collection retained (${code}); fix configuration or run agent-lyceum doctor, then retry approvals collect --call ${id}.\n`;
const held = (id: string) =>
  `Call ${id}: approval collection blocked (DIR_ANOMALY). See the approval_collect class in calls/${id}/log.jsonl; if it is held, stop all calls before removing a stale .coord.\n`;

function ids(): string[] {
  return [...listCommittedIds(env.home).ids];
}

/** Every directory and file under home, without following links. */
function tree(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, ent.name);
      const rel = path.relative(root, abs);
      if (ent.isSymbolicLink()) { out.push(`link:${rel}`); continue; }
      if (ent.isDirectory()) { out.push(`dir:${rel}`); walk(abs); continue; }
      out.push(`file:${rel}:${fs.readFileSync(abs).toString('base64')}`);
    }
  };
  if (fs.existsSync(root)) walk(root);
  return out.sort();
}

function files(root: string): Array<{ rel: string; mode: number; mtimeNs: string; bytes: string }> {
  const out: Array<{ rel: string; mode: number; mtimeNs: string; bytes: string }> = [];
  const walk = (dir: string): void => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, ent.name);
      if (ent.isSymbolicLink()) continue;
      if (ent.isDirectory()) { walk(abs); continue; }
      if (!ent.isFile()) continue;
      const st = fs.lstatSync(abs, { bigint: true });
      out.push({ rel: path.relative(root, abs), mode: Number(st.mode & 0o777n), mtimeNs: st.mtimeNs.toString(), bytes: fs.readFileSync(abs).toString('base64') });
    }
  };
  walk(root);
  return out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
}

function markerFor(id: string): CallApprovalOk {
  const view = callApprovalView({ home: env.home, callId: id, role: 'fe-member', projectDir: env.repo, premise: PREMISE });
  if (!view.ok) throw new Error(`view ${view.code}`);
  return {
    schema_version: 1, call_id: id, role: 'fe-member', project_dir: view.origin.project_dir,
    successful_attempt: 1, full_writable: view.origin.full_writable, qualifications: { ...view.qualifications },
  };
}

function publish(id: string): { ok: CallApprovalOk; slot: ReturnType<typeof requestPaths> } {
  const ok = markerFor(id);
  publishCallApprovalOk(env.home, ok);
  return { ok, slot: requestPaths(env.home, { kind: 'call', call_id: id }) };
}

function holdLive(role: string): void {
  fs.mkdirSync(path.join(env.home, 'calls'), { recursive: true });
  fs.writeFileSync(path.join(env.home, 'calls', `.lock-${role}`), JSON.stringify({ pid: process.pid, call_id: 'live-holder' }));
}

describe('approvals collect --call', () => {
  it('collect call without ok is a read-only no-op', () => {
    enroll();
    const id = 'failed-call';
    const slot = requestPaths(env.home, { kind: 'call', call_id: id });
    write(path.join(slot.parked, '1', 'failed.req'), REQ('parked-body'));
    write(path.join(slot.proposals, 'left.req'), REQ('still-there'));
    write(path.join(slot.collected, '4', 'open.req'), REQ('not-done'));
    const before = tree(env.home);
    const r = run(['approvals', 'collect', '--call', id]);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(absent(id));
    expect(r.stderr).toBe('');
    expect(tree(env.home)).toEqual(before);
    expect(ids()).toEqual([]);
    expect(fs.existsSync(path.join(env.home, 'approvals'))).toBe(false);
    expect(fs.existsSync(path.join(env.home, 'calls', id, 'log.jsonl'))).toBe(false);
    expect(fs.existsSync(path.join(env.home, 'calls', '.lock-fe-member'))).toBe(false);
  });

  it('collect call finishes unmarked directories and rotates residual proposals idempotently', () => {
    enroll();
    const id = 'recover-call';
    const { slot } = publish(id);
    write(path.join(slot.collected, '1', 'old.req'), REQ('from-seq'));
    write(path.join(slot.proposals, 'new.req'), REQ('from-prop'));
    fs.mkdirSync(slot.parked, { recursive: true });
    execFileSync('mkfifo', [path.join(slot.parked, 'unread')]);
    const first = run(['approvals', 'collect', '--call', id]);
    expect(first.status).toBe(0);
    expect(first.stdout).toBe(complete(id));
    expect(first.stderr).toBe('');
    expect(fs.existsSync(path.join(slot.collected, '1.done'))).toBe(true);
    expect(fs.existsSync(path.join(slot.collected, '2.done'))).toBe(true);
    expect(fs.existsSync(path.join(slot.proposals, 'new.req'))).toBe(false);
    expect(fs.existsSync(path.join(env.home, 'calls', id, 'result.md'))).toBe(false);
    expect(fs.existsSync(path.join(env.home, 'calls', id, 'log.jsonl'))).toBe(false);
    const recs = ids();
    expect(recs).toHaveLength(2);
    const payloads = recs.map((rec) => fs.readFileSync(path.join(env.home, 'approvals', rec, 'payload'), 'utf8')).sort();
    expect(payloads).toEqual(['from-prop', 'from-seq']);
    const snap = files(env.home);
    const second = run(['approvals', 'collect', '--call', id]);
    expect(second.status).toBe(0);
    expect(second.stdout).toBe(first.stdout);
    expect(second.stderr).toBe('');
    expect(files(env.home)).toEqual(snap);
    expect(fs.existsSync(path.join(env.home, 'calls', '.lock-fe-member'))).toBe(false);
    expect(fs.existsSync(path.join(slot.root, '.coord'))).toBe(false);
    expect(fs.existsSync(path.join(env.home, 'calls', id, 'log.jsonl'))).toBe(false);
  });

  it('collect call refuses a live lease and a held coordination directory', () => {
    enroll();
    const liveId = 'live-ok';
    const { slot } = publish(liveId);
    write(path.join(slot.proposals, 'stay.req'), REQ('do-not-collect'));
    holdLive('fe-member');
    const live = run(['approvals', 'collect', '--call', liveId]);
    expect(live.status).toBe(1);
    expect(live.stderr).toBe('fe-member is already being called (call live-holder, pid ' + process.pid + '). Wait for it to finish.\n');
    expect(live.stdout).toBe('');
    expect(fs.readFileSync(path.join(slot.proposals, 'stay.req'), 'utf8')).toBe(REQ('do-not-collect'));
    expect(ids()).toEqual([]);
    expect(fs.readFileSync(path.join(env.home, 'calls', '.lock-fe-member'), 'utf8')).toContain('live-holder');

    env.cleanup();
    enroll();
    const heldId = 'held-coord';
    const heldSlot = publish(heldId).slot;
    write(path.join(heldSlot.proposals, 'stay.req'), REQ('coord-sentinel'));
    fs.mkdirSync(path.join(heldSlot.root, '.coord'));
    const blocked = run(['approvals', 'collect', '--call', heldId]);
    expect(blocked.status).toBe(1);
    expect(blocked.stderr).toBe(held(heldId));
    expect(blocked.stdout).toBe('');
    expect(fs.readFileSync(path.join(heldSlot.proposals, 'stay.req'), 'utf8')).toBe(REQ('coord-sentinel'));
    expect(fs.lstatSync(path.join(heldSlot.root, '.coord')).isDirectory()).toBe(true);
    expect(ids()).toEqual([]);
    const log = fs.readFileSync(path.join(env.home, 'calls', heldId, 'log.jsonl'), 'utf8');
    expect(log).toContain('"event":"approval_collect"');
    expect(log).toContain('"class":"held"');
    expect(log).not.toContain('coord-sentinel');
    expect(log).not.toContain('stay.req');

    env.cleanup();
    enroll();
    const plain = 'live-no-ok';
    const plainSlot = requestPaths(env.home, { kind: 'call', call_id: plain });
    write(path.join(plainSlot.proposals, 'left.req'), REQ('unmarked'));
    holdLive('fe-member');
    const before = tree(env.home);
    const noop = run(['approvals', 'collect', '--call', plain]);
    expect(noop.status).toBe(0);
    expect(noop.stdout).toBe(absent(plain));
    expect(noop.stderr).toBe('');
    expect(tree(env.home)).toEqual(before);
    expect(ids()).toEqual([]);
  });

  it('collect call rejects unsafe markers and changed qualifications', () => {
    const badId = '../bad';
    enroll();
    const bad = run(['approvals', 'collect', '--call', badId]);
    expect(bad.status, 'bad id').toBe(1);
    expect(bad.stderr, 'bad id').toBe(invalid(badId));
    expect(bad.stdout, 'bad id').toBe('');
    expect(fs.existsSync(path.join(env.home, 'requests'))).toBe(false);
    expect(ids()).toEqual([]);

    const cases: Array<{ name: string; id: string; arrange: (id: string) => void; stderr: string }> = [
      {
        name: 'ancestor symlink', id: 'sym-call', arrange: (id) => {
          const outside = path.join(env.root, 'outside-requests');
          write(path.join(outside, 'calls', id, 'ok.json'), 'not-followed\n');
          fs.symlinkSync(outside, path.join(env.home, 'requests'));
        }, stderr: invalid('sym-call'),
      },
      {
        name: 'fifo', id: 'fifo-call', arrange: (id) => {
          const ok = requestPaths(env.home, { kind: 'call', call_id: id }).ok!;
          fs.mkdirSync(path.dirname(ok), { recursive: true });
          execFileSync('mkfifo', [ok]);
        }, stderr: invalid('fifo-call'),
      },
      {
        name: 'oversize', id: 'big-call', arrange: (id) => {
          const ok = requestPaths(env.home, { kind: 'call', call_id: id }).ok!;
          fs.mkdirSync(path.dirname(ok), { recursive: true });
          fs.writeFileSync(ok, Buffer.alloc(1024 * 1024 + 1, 0x61));
        }, stderr: invalid('big-call'),
      },
      {
        name: 'unknown version', id: 'ver-call', arrange: (id) => {
          const { slot } = publish(id);
          fs.chmodSync(slot.ok!, 0o600);
          fs.writeFileSync(slot.ok!, `${JSON.stringify({ schema_version: 2, call_id: id })}\n`);
        }, stderr: invalid('ver-call'),
      },
      {
        name: 'mismatched call_id', id: 'mix-call', arrange: (id) => {
          const { ok, slot } = publish(id);
          const body = { ...ok, call_id: 'other-id' };
          fs.chmodSync(slot.ok!, 0o600);
          fs.writeFileSync(slot.ok!, `${JSON.stringify(body)}\n`);
        }, stderr: invalid('mix-call'),
      },
      {
        name: 'role removed', id: 'role-call', arrange: () => {
          publish('role-call');
          const team = path.join(env.home, 'team.yaml');
          fs.writeFileSync(team, fs.readFileSync(team, 'utf8').replace(
            / {2}fe-member:\n {4}runtime: claude-code\n {4}agent_md: agents\/fe-member\/AGENT.md\n {4}memory: \{ global: agents\/fe-member\/memory \}\n {4}# model: sonnet {8}# cheaper model for routine work\n/,
            '',
          ));
        }, stderr: retained('role-call', 'AGENT_MISSING'),
      },
      {
        name: 'executors removed', id: 'exec-call', arrange: () => {
          publish('exec-call');
          fs.rmSync(path.join(env.home, 'executors.yaml'));
        }, stderr: retained('exec-call', 'NOT_ALLOWED'),
      },
      {
        name: 'allow revoked', id: 'allow-call', arrange: () => {
          publish('allow-call');
          const file = path.join(env.home, 'executors.yaml');
          fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('allow: [{call: fe-member}]', 'allow: []'));
        }, stderr: retained('allow-call', 'NOT_ALLOWED'),
      },
      {
        name: 'dir removed', id: 'dir-call', arrange: () => {
          const { ok } = publish('dir-call');
          fs.rmSync(ok.project_dir, { recursive: true });
        }, stderr: retained('dir-call', 'PROJECT_PATH_MISMATCH'),
      },
      {
        name: 'dir symlink', id: 'link-call', arrange: () => {
          const { ok } = publish('link-call');
          const elsewhere = path.join(env.root, 'elsewhere');
          fs.mkdirSync(elsewhere);
          fs.rmSync(ok.project_dir, { recursive: true });
          fs.symlinkSync(elsewhere, ok.project_dir);
        }, stderr: retained('link-call', 'PROJECT_PATH_MISMATCH'),
      },
      {
        name: 'hash mismatch', id: 'hash-call', arrange: () => {
          publish('hash-call');
          write(path.join(env.home, 'calls', 'hash-call', 'log.jsonl'), 'torn-tail');
          const file = path.join(env.home, 'executors.yaml');
          fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('timeout_sec: 5', 'timeout_sec: 9'));
        }, stderr: retained('hash-call', 'SNAPSHOT_MISMATCH'),
      },
      {
        name: 'key-set mismatch', id: 'keys-call', arrange: () => {
          publish('keys-call');
          const file = path.join(env.home, 'executors.yaml');
          const tool = path.join(env.root, 'exec', 'bin', 'tool');
          fs.appendFileSync(file, `  y:\n    command: ["${tool}"]\n    allow: [{call: fe-member}]\n    timeout_sec: 5\n`);
        }, stderr: retained('keys-call', 'SNAPSHOT_MISMATCH'),
      },
    ];
    for (const c of cases) {
      env.cleanup();
      enroll();
      c.arrange(c.id);
      const before = ids();
      const r = run(['approvals', 'collect', '--call', c.id]);
      expect(r.status, c.name).toBe(1);
      expect(r.stdout, c.name).toBe('');
      expect(r.stderr, c.name).toBe(c.stderr);
      expect(ids(), c.name).toEqual(before);
      if (c.name === 'ancestor symlink') {
        expect(fs.readFileSync(path.join(env.root, 'outside-requests', 'calls', c.id, 'ok.json'), 'utf8')).toBe('not-followed\n');
      }
      if (c.stderr === invalid(c.id)) expect(fs.existsSync(path.join(env.home, 'calls', c.id, 'log.jsonl')), c.name).toBe(false);
      if (c.name === 'hash mismatch') {
        const text = fs.readFileSync(path.join(env.home, 'calls', c.id, 'log.jsonl'), 'utf8');
        expect(text.startsWith('torn-tail\n'), c.name).toBe(true);
        const lines = text.split('\n').filter((line) => line.length > 0);
        expect(lines, c.name).toHaveLength(2);
        expect(lines[1], c.name).toContain('"event":"approval_collect"');
        expect(lines[1], c.name).not.toContain('timeout_sec');
      }
    }
  }, 30_000);

  it('collect call prints the lock path when the call lock cannot be taken', () => {
    enroll();
    const id = 'lock-call';
    publish(id);
    const stub = path.join(env.root, 'lock-eexist.mjs');
    fs.writeFileSync(stub, `import fs from 'node:fs';
import path from 'node:path';
const writeFileSync = fs.writeFileSync;
fs.writeFileSync = function (...args) {
  if (String(args[0]).includes(path.sep + '.lock-')) {
    const err = new Error('EEXIST');
    err.code = 'EEXIST';
    throw err;
  }
  return writeFileSync(...args);
};
`);
    const file = path.join(env.home, 'calls', '.lock-fe-member');
    const r = run(['approvals', 'collect', '--call', id], { NODE_OPTIONS: `--import ${pathToFileURL(stub).href}` });
    expect(r.status).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr).toBe(`Could not take ${file}; try again.\n`);
    expect(fs.existsSync(file)).toBe(false);
    expect(ids()).toEqual([]);
  });

  it('collect call does not append diagnostics through a symlinked log', () => {
    enroll();
    const id = 'symlink-log';
    publish(id);
    const victim = path.join(env.root, 'victim-log');
    fs.writeFileSync(victim, 'victim\n');
    const dir = path.join(env.home, 'calls', id);
    fs.mkdirSync(dir, { recursive: true });
    fs.symlinkSync(victim, path.join(dir, 'log.jsonl'));
    const yaml = path.join(env.home, 'executors.yaml');
    fs.writeFileSync(yaml, fs.readFileSync(yaml, 'utf8').replace('timeout_sec: 5', 'timeout_sec: 9'));
    const said: string[] = [];
    const result = collectApprovedCall({ home: env.home, callId: id, premise: PREMISE, say: (line) => said.push(line) });
    expect(result).toEqual({ kind: 'blocked', code: 'SNAPSHOT_MISMATCH' });
    expect(fs.readFileSync(victim, 'utf8')).toBe('victim\n');
    expect(said).toContain('Approval call diagnostics could not be persisted.');
  });

  it('web command whitelist excludes every approvals command', () => {
    const ids = Object.keys(COMMANDS);
    expect(ids.some((id) => id.toLowerCase().includes('approval'))).toBe(false);
    for (const def of Object.values(COMMANDS)) {
      expect(def.id.toLowerCase()).not.toContain('approval');
      expect(def.label.toLowerCase()).not.toContain('approval');
      expect(def.argv.toString().toLowerCase()).not.toContain('approval');
    }
  });
});
