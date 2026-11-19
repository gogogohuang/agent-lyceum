import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { ApprovalError } from '../src/approval-error.js';
import { publishExclusive } from '../src/approval-io.js';
import type { CreatorProbe } from '../src/approval-liveness.js';
import { recordPaths } from '../src/approval-paths.js';
import { committedIdNames, executorFacts, readAudit, readEntries, readRequestView, resolveIdPrefix } from '../src/approval-query.js';
import type { AuditEvent } from '../src/approval-query.js';
import { makeEnv, type TestEnv } from './helpers.js';
import { seedDenied, seedPending, seedState, snapshotTree, writeTrapIo } from './approval-store-fixture.js';

const RECORD_HINT = 'Committed approval could not be read';
const STATE_HINT = 'State is corrupted; every transition is refused';
const READ_FLAGS = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;
const homes: TestEnv[] = [];

function openHome(): string {
  const env = makeEnv();
  homes.push(env);
  return fs.realpathSync(env.home);
}

afterEach(() => {
  while (homes.length > 0) homes.pop()?.cleanup();
});

function probeOf(signal: 'exists' | 'missing' | 'unverifiable'): { probe: CreatorProbe; calls: () => number } {
  let n = 0;
  return { calls: () => n, probe: {
    signal0() { n += 1; return signal; },
    start() { n += 1; return 'other-start'; },
    compare() { n += 1; return 'mismatch'; },
  } };
}

function touchRecord(home: string, id: string, text: string): void {
  const dir = path.join(home, 'approvals', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'record.json'), text);
}

function guardingFs(): { fs: NonNullable<Parameters<typeof executorFacts>[2]>['fs']; opens: () => number } {
  let opens = 0;
  return { opens: () => opens, fs: {
    realpathSync: fs.realpathSync,
    openSync(p, flags, mode) {
      if (flags !== READ_FLAGS) throw new Error(`open flags ${String(flags)} !== O_RDONLY|O_NOFOLLOW|O_NONBLOCK (${READ_FLAGS})`);
      opens += 1;
      return fs.openSync(p, flags, mode);
    },
    fstatSync: fs.fstatSync,
    readSync: fs.readSync,
    closeSync: fs.closeSync,
  } };
}

function execYaml(commands: Readonly<Record<string, string>>): string {
  const body = Object.entries(commands).map(([name, cmd]) =>
    `  ${name}:\n    command: ["${cmd}"]\n    allow: []\n    timeout_sec: 5\n`).join('');
  return `executors:\n${body}`;
}

it('resolveIdPrefix and committedIdNames choose candidates by record.json', () => {
  const home = openHome();
  const missing = openHome();
  const linked = openHome();
  const allA = 'a'.repeat(24);
  const aThenB = `${'a'.repeat(8)}${'b'.repeat(16)}`;
  const noRecord = 'c'.repeat(24);
  const symId = 'f'.repeat(24);
  fs.mkdirSync(path.join(home, 'approvals'));
  touchRecord(home, allA, '{');
  touchRecord(home, aThenB, '{}');
  fs.mkdirSync(path.join(home, 'approvals', noRecord));
  fs.writeFileSync(path.join(home, 'approvals', noRecord, 'payload'), 'x');
  fs.mkdirSync(path.join(home, 'approvals', 'not-an-id'));
  fs.mkdirSync(path.join(home, 'approvals', 'D'.repeat(24)));
  fs.mkdirSync(path.join(home, 'approvals', 'd'.repeat(23)));
  fs.writeFileSync(path.join(home, 'approvals', 'e'.repeat(24)), 'file-not-dir');
  const outside = path.join(home, 'outside.json');
  fs.writeFileSync(outside, '{');
  fs.mkdirSync(path.join(home, 'approvals', symId));
  fs.symlinkSync(outside, path.join(home, 'approvals', symId, 'record.json'));

  expect(committedIdNames(home).sort()).toEqual([allA, aThenB, symId].sort());
  expect(resolveIdPrefix(home, 'a'.repeat(8))).toEqual({ kind: 'ambiguous', count: 2 });
  expect(resolveIdPrefix(home, 'a'.repeat(9))).toEqual({ kind: 'ok', id: allA });
  expect(resolveIdPrefix(home, `${'a'.repeat(8)}b`)).toEqual({ kind: 'ok', id: aThenB });
  expect(resolveIdPrefix(home, 'b'.repeat(8))).toEqual({ kind: 'not_found' });
  expect(resolveIdPrefix(missing, 'a'.repeat(8))).toEqual({ kind: 'not_found' });
  expect(committedIdNames(missing)).toEqual([]);
  expect(fs.existsSync(path.join(missing, 'approvals'))).toBe(false);

  const real = path.join(linked, 'real-approvals');
  fs.mkdirSync(real);
  fs.symlinkSync(real, path.join(linked, 'approvals'));
  let caught: unknown;
  try { committedIdNames(linked); } catch (e) { caught = e; }
  expect(caught).toBeInstanceOf(ApprovalError);
  expect((caught as ApprovalError).code).toBe('UNSAFE_PATH');
  expect((caught as ApprovalError).path).toBe(path.join(linked, 'approvals'));
  for (const arg of ['a'.repeat(7), 'A'.repeat(8), 'a'.repeat(25), 'zzzzzzzz', '0123456g']) {
    expect(resolveIdPrefix(linked, arg)).toEqual({ kind: 'invalid' });
  }

  const before = snapshotTree(home);
  const listing = readEntries(home, { nowMs: 0, probe: probeOf('missing').probe, probeExecuting: false });
  expect(listing.entries).toEqual([]);
  expect(listing.problems.map((p) => p.id).sort()).toEqual([allA, aThenB, symId].sort());
  expect(listing.problems.find((p) => p.id === allA)).toMatchObject({ code: 'CORRUPT_RECORD', hint: RECORD_HINT });
  expect(listing.problems.find((p) => p.id === aThenB)).toMatchObject({ code: 'CORRUPT_RECORD', hint: RECORD_HINT });
  expect(listing.problems.find((p) => p.id === symId)).toMatchObject({ code: 'UNSAFE_PATH', hint: RECORD_HINT });
  expect(snapshotTree(home)).toEqual(before);
});

it('read-only queries make no mutating io call', () => {
  const empty = openHome();
  const emptyBefore = snapshotTree(empty);
  const io = writeTrapIo();
  const quiet = probeOf('missing');
  expect(committedIdNames(empty, io)).toEqual([]);
  expect(resolveIdPrefix(empty, '01234567', io)).toEqual({ kind: 'not_found' });
  expect(readEntries(empty, { nowMs: 0, probe: quiet.probe, probeExecuting: false }, io)).toEqual({ entries: [], problems: [] });
  expect(quiet.calls()).toBe(0);
  expect(executorFacts(empty, null, { userHome: empty, io, fs: guardingFs().fs })).toEqual({ kind: 'none' });
  expect(executorFacts(empty, 'deploy', { userHome: empty, io, fs: guardingFs().fs })).toEqual({ kind: 'unregistered', name: 'deploy' });
  expect(snapshotTree(empty)).toEqual(emptyBefore);
  expect(fs.existsSync(path.join(empty, 'approvals'))).toBe(false);

  const home = openHome();
  const payload = Buffer.from('same-payload');
  const a = seedPending(home, { payload });
  const b = seedPending(home, { payload });
  const c = seedPending(home, { payload: Buffer.from('other-payload') });
  const denied = seedDenied(home);
  const before = snapshotTree(home);
  const counted = probeOf('missing');
  const opts = { nowMs: Date.parse(a.record.created_at) + 1000, probe: counted.probe, probeExecuting: false as const };
  const listing = readEntries(home, opts, io);
  expect(counted.calls()).toBe(0);
  expect(listing.problems).toEqual([]);
  expect(listing.entries.map((e) => e.id).sort()).toEqual([a.id, b.id, c.id, denied.id].sort());
  for (const entry of listing.entries) {
    expect(entry.display?.computed).toBe(entry.id === denied.id ? 'denied' : 'pending');
    expect(entry.display?.unrecorded).toBe(false);
  }
  const view = readRequestView(home, a.id, { nowMs: opts.nowMs, probe: counted.probe }, io);
  expect(view.current).toMatchObject({ kind: 'ok', display: { computed: 'pending', unrecorded: false } });
  expect(view.payload.kind).toBe('bytes');
  if (view.payload.kind === 'bytes') {
    expect(view.payload.bytes.equals(payload)).toBe(true);
    expect(view.payload.observed_sha256).toBe(createHash('sha256').update(payload).digest('hex'));
  }
  expect(view.same).toEqual([{ id: b.id, display: expect.objectContaining({ computed: 'pending' }), reason: null, code: null }]);
  const deniedView = readRequestView(home, denied.id, { nowMs: opts.nowMs, probe: counted.probe }, io);
  expect(deniedView.payload).toEqual({ kind: 'none' });
  expect(deniedView.same).toEqual([]);
  const audit = readAudit(home, a.id, { nowMs: opts.nowMs, probe: counted.probe }, io);
  expect(audit.events).toEqual([]);
  expect(audit.current).toMatchObject({ kind: 'ok', display: { computed: 'pending' } });
  expect(resolveIdPrefix(home, a.id, io)).toEqual({ kind: 'ok', id: a.id });
  expect(executorFacts(home, 'deploy', { userHome: home, io, fs: guardingFs().fs })).toEqual({ kind: 'unregistered', name: 'deploy' });
  expect(counted.calls()).toBe(0);
  expect(snapshotTree(home)).toEqual(before);
});

it('default list show and audit never record expired or unknown', () => {
  const home = openHome();
  const io = writeTrapIo();
  const pending = seedPending(home);
  const created = Date.parse(pending.record.created_at);
  seedState(home, pending.id, 'executing', created + 1000);
  const expired = seedPending(home, { expiresAt: pending.record.created_at });
  const boundary = seedPending(home, { createdAt: pending.record.created_at, expiresAt: new Date(created + 5000).toISOString() });
  const before = snapshotTree(home);
  const filesBefore = fs.readdirSync(recordPaths(home, pending.id).state).sort();
  const dead = probeOf('missing');
  const nowMs = created + 1;
  const hidden = readEntries(home, { nowMs, probe: dead.probe, probeExecuting: false }, io);
  expect(dead.calls()).toBe(0);
  const byId = new Map(hidden.entries.map((e) => [e.id, e]));
  expect(byId.get(pending.id)?.display).toBeNull();
  expect(byId.get(expired.id)?.display).toMatchObject({ persisted: 'pending', computed: 'expired', unrecorded: true, n: 0 });
  expect(byId.get(boundary.id)?.display).toMatchObject({ computed: 'pending', unrecorded: false });
  expect(fs.existsSync(recordPaths(home, expired.id).state)).toBe(false);

  const shown = readEntries(home, { nowMs, probe: dead.probe, probeExecuting: true }, io);
  expect(dead.calls()).toBe(1);
  expect(shown.entries.find((e) => e.id === pending.id)?.display).toMatchObject({
    persisted: 'executing', computed: 'unknown', unrecorded: true, n: 1,
  });
  const request = readRequestView(home, expired.id, { nowMs, probe: dead.probe }, io);
  expect(request.current).toMatchObject({ kind: 'ok', display: { computed: 'expired', unrecorded: true } });
  const executing = readRequestView(home, pending.id, { nowMs, probe: dead.probe }, io);
  expect(executing.current).toMatchObject({ kind: 'ok', display: { computed: 'unknown', unrecorded: true } });
  const auditExpired = readAudit(home, expired.id, { nowMs, probe: dead.probe }, io);
  expect(auditExpired.events).toEqual([]);
  expect(auditExpired.current).toMatchObject({ kind: 'ok', display: { computed: 'expired', unrecorded: true } });
  const auditExecuting = readAudit(home, pending.id, { nowMs, probe: dead.probe }, io);
  expect(auditExecuting.events.map((e) => ('state' in e ? e.state.status : e.code))).toEqual(['executing']);
  expect(auditExecuting.current).toMatchObject({ kind: 'ok', display: { computed: 'unknown', unrecorded: true } });
  const atExpiry = readEntries(home, { nowMs: created + 5000, probe: dead.probe, probeExecuting: false }, io);
  expect(atExpiry.entries.find((e) => e.id === boundary.id)?.display).toMatchObject({ computed: 'pending', unrecorded: false });
  expect(fs.readdirSync(recordPaths(home, pending.id).state).sort()).toEqual(filesBefore);
  expect(snapshotTree(home)).toEqual(before);
});

it('corrupt highest or missing predecessor state is a problem in every listing and refuses lazy writes', () => {
  const home = openHome();
  const io = writeTrapIo();
  const payload = Buffer.from('gap-payload');
  const gap = seedPending(home, { payload });
  const twin = seedPending(home, { payload });
  const bad = seedPending(home);
  const alias = seedPending(home);
  const created = Date.parse(gap.record.created_at);
  const actor = { user: 'u', tty: '/dev/ttys1', pid: 7, pid_started: 'proc:7' };
  publishExclusive(path.join(recordPaths(home, gap.id).state, '3.json'), Buffer.from(`${JSON.stringify({
    schema_version: 1, n: 3, previous: 2, updated_at: new Date(created + 5000).toISOString(), actor, status: 'expired',
  }, null, 2)}\n`), { root: home });
  fs.mkdirSync(recordPaths(home, bad.id).state, { recursive: true });
  fs.writeFileSync(path.join(recordPaths(home, bad.id).state, '1.json'), '{nope');
  seedState(home, alias.id, 'executing', created + 1000);
  fs.writeFileSync(path.join(recordPaths(home, alias.id).state, '01.json'), '{"alias":true}\n');
  const before = snapshotTree(home);
  const lists = [recordPaths(home, gap.id).state, recordPaths(home, bad.id).state, recordPaths(home, alias.id).state]
    .map((dir) => fs.readdirSync(dir).sort());
  const counted = probeOf('missing');
  const now = { nowMs: created + 1000, probe: counted.probe };
  const listing = readEntries(home, { ...now, probeExecuting: true }, io);
  expect(listing.entries.map((e) => e.id)).toEqual([twin.id]);
  for (const id of [gap.id, bad.id, alias.id]) {
    expect(listing.problems.find((p) => p.id === id)).toMatchObject({ code: 'CORRUPT_STATE', hint: STATE_HINT });
  }
  for (const id of [gap.id, bad.id, alias.id]) {
    expect(readRequestView(home, id, now, io).current).toMatchObject({ kind: 'corrupt', code: 'CORRUPT_STATE' });
    expect(readAudit(home, id, now, io).current).toMatchObject({ kind: 'corrupt', code: 'CORRUPT_STATE' });
  }
  const gapView = readRequestView(home, twin.id, now, io);
  expect(gapView.same).toEqual([{ id: gap.id, display: null, reason: null, code: 'CORRUPT_STATE' }]);
  const gapAudit = readAudit(home, gap.id, now, io);
  expect(gapAudit.events.some((e) => e.n === 3 && 'state' in e && e.state.status === 'expired')).toBe(true);
  expect(gapAudit.events.some((e) => e.n === 2)).toBe(false);
  const badAudit = readAudit(home, bad.id, now, io);
  expect(badAudit.events).toEqual([expect.objectContaining({ n: 1, code: 'CORRUPT_STATE', path: path.join(recordPaths(home, bad.id).state, '1.json') })]);
  const aliasAudit = readAudit(home, alias.id, now, io);
  expect(aliasAudit.events.some((e) => e.n === 1 && 'state' in e)).toBe(true);
  expect(aliasAudit.events.some((e) => 'path' in e && e.path.endsWith(`${path.sep}01.json`) && e.code === 'CORRUPT_STATE')).toBe(true);
  expect(counted.calls()).toBe(0);
  expect([recordPaths(home, gap.id).state, recordPaths(home, bad.id).state, recordPaths(home, alias.id).state]
    .map((dir) => fs.readdirSync(dir).sort())).toEqual(lists);
  expect(snapshotTree(home)).toEqual(before);
});

it('executorFacts reports registered, unregistered, config errors and uninspectable commands', () => {
  const home = openHome();
  const root = path.dirname(home);
  const guard = guardingFs();
  const opts = { userHome: root, io: writeTrapIo(), fs: guard.fs };
  expect(executorFacts(home, null, opts)).toEqual({ kind: 'none' });
  expect(executorFacts(home, 'deploy', opts)).toEqual({ kind: 'unregistered', name: 'deploy' });
  fs.writeFileSync(path.join(home, 'executors.yaml'), 'executors: [\n');
  expect(executorFacts(home, 'deploy', opts)).toEqual({ kind: 'config_error', name: 'deploy', code: 'INVALID_INPUT' });
  expect(executorFacts(home, null, opts)).toEqual({ kind: 'none' });
  fs.rmSync(path.join(home, 'executors.yaml'));
  const linkedYaml = path.join(root, 'linked-executors.yaml');
  fs.writeFileSync(linkedYaml, 'executors: {}\n');
  fs.symlinkSync(linkedYaml, path.join(home, 'executors.yaml'));
  expect(executorFacts(home, 'deploy', opts)).toEqual({ kind: 'config_error', name: 'deploy', code: 'UNSAFE_PATH' });
  fs.unlinkSync(path.join(home, 'executors.yaml'));

  const big = Buffer.alloc(65536 + 100, 0x61);
  const bigPath = path.join(root, 'big.bin');
  fs.writeFileSync(bigPath, big);
  fs.chmodSync(bigPath, 0o777);
  const marker = path.join(root, 'ran');
  const script = path.join(root, 'run.sh');
  fs.writeFileSync(script, `#!/bin/sh\necho ran > ${JSON.stringify(marker)}\n`);
  fs.chmodSync(script, 0o755);
  const fifo = path.join(root, 'pipe');
  execFileSync('mkfifo', [fifo]);
  const dirBin = path.join(root, 'dirbin');
  fs.mkdirSync(dirBin);
  const missing = path.join(root, 'missing-bin');
  fs.writeFileSync(path.join(home, 'executors.yaml'), execYaml({
    big: bigPath, tool: script, pipe: fifo, dir: dirBin, gone: missing,
  }));
  const before = snapshotTree(home);
  const beforeBig = fs.lstatSync(bigPath).mtimeMs;
  const registered = executorFacts(home, 'big', opts);
  expect(registered).toEqual({ kind: 'ok', name: 'big', real: fs.realpathSync.native(bigPath),
    sha256: createHash('sha256').update(big).digest('hex') });
  expect(fs.lstatSync(bigPath).mtimeMs).toBe(beforeBig);
  const tool = executorFacts(home, 'tool', opts);
  expect(tool).toMatchObject({ kind: 'ok', name: 'tool', sha256: createHash('sha256').update(fs.readFileSync(script)).digest('hex') });
  expect(fs.existsSync(marker)).toBe(false);
  expect(executorFacts(home, 'other', opts)).toEqual({ kind: 'unregistered', name: 'other' });
  expect(executorFacts(home, 'gone', opts)).toEqual({ kind: 'uninspectable', name: 'gone', configured: missing, code: 'ENOENT' });
  expect(executorFacts(home, 'pipe', opts)).toEqual({ kind: 'uninspectable', name: 'pipe', configured: fifo, code: 'NOT_REGULAR' });
  expect(executorFacts(home, 'dir', opts)).toEqual({ kind: 'uninspectable', name: 'dir', configured: dirBin, code: 'NOT_REGULAR' });
  expect(guard.opens()).toBeGreaterThan(0);
  expect(snapshotTree(home)).toEqual(before);
});

it('readAudit lists state events in sequence order and marks a corrupt n', () => {
  const home = openHome();
  const pending = seedPending(home);
  const created = Date.parse(pending.record.created_at);
  seedState(home, pending.id, 'executing', created + 1000);
  seedState(home, pending.id, 'unknown', created + 2000);
  const dir = recordPaths(home, pending.id).state;
  const actor = { user: 'u', tty: '/dev/ttys1', pid: 7, pid_started: 'proc:7' };
  publishExclusive(path.join(dir, '10.json'), Buffer.from(`${JSON.stringify({
    schema_version: 1, n: 10, previous: 9, updated_at: new Date(created + 3000).toISOString(), actor, status: 'expired',
  }, null, 2)}\n`), { root: home });
  fs.writeFileSync(path.join(dir, '11.json'), '{nope');
  fs.writeFileSync(path.join(dir, '.approval-9-x.tmp'), 'junk');
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'x');
  fs.writeFileSync(path.join(dir, '2.json.bak'), 'x');
  const before = snapshotTree(home);
  const audit = readAudit(home, pending.id, { nowMs: created + 4000, probe: probeOf('missing').probe });
  const shape = (e: AuditEvent): string => ('state' in e ? `state:${e.n}:${e.state.status}` : `bad:${e.n}:${e.code}`);
  expect(audit.events.map(shape)).toEqual(['state:1:executing', 'state:2:unknown', 'state:10:expired', 'bad:11:CORRUPT_STATE']);
  expect(audit.events.some((e) => 'path' in e && (e.path.endsWith('.tmp') || e.path.endsWith('notes.txt') || e.path.endsWith('.bak')))).toBe(false);
  expect(audit.current).toMatchObject({ kind: 'corrupt', code: 'CORRUPT_STATE' });
  expect(audit.record.id).toBe(pending.id);
  expect(snapshotTree(home)).toEqual(before);
});
