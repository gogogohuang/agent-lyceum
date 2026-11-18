import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildClaudeSettings } from '../src/adapters/claude.js';
import type { Invoker, WakeInput, WakeResult } from '../src/adapters/index.js';
import { SCAN_WORK_BUDGET } from '../src/approval-budget.js';
import { collectCallApproval, readCallApprovalOk } from '../src/approval-call.js';
import type { CollectDeps } from '../src/approval-collect.js';
import { qualificationHash } from '../src/approval-origin.js';
import { requestPaths } from '../src/approval-paths.js';
import { loadFreshConfig } from '../src/approval-runtime.js';
import { snapshotInputs } from '../src/approval-snapshot.js';
import { listCommittedIds, readRecord } from '../src/approval-store.js';
import { callAgent, callProject, resolveCallAgent, type CallOptions } from '../src/call.js';
import { setFaultHook } from '../src/message-store.js';
import { canonicalPath } from '../src/paths.js';
import { setOsSandboxForTest, writePolicy } from '../src/policy.js';
import { makeEnv, write, type TestEnv } from './helpers.js';

const PREMISE = { platform: 'linux' as const, sandboxAvailable: () => true };
const NOW = new Date('2026-11-18T00:00:00.000Z');
const OK = (text: string): WakeResult => ({ ok: true, text, exitCode: 0, timedOut: false });
const fail = (kind: WakeResult['kind'], error = `${kind} error`): WakeResult =>
  ({ ok: false, text: '', exitCode: 1, timedOut: kind === 'timeout', error, kind });
const CANCELLED: WakeResult = { ok: false, text: '', exitCode: null, timedOut: false, cancelled: true };

let env: TestEnv;
let said: string[];
let tokens: number;
let premiseOk: boolean;
afterEach(() => {
  setFaultHook(undefined);
  setOsSandboxForTest(undefined);
  vi.restoreAllMocks();
  env?.cleanup();
});

const deps = (over: Partial<CollectDeps> = {}): CollectDeps => ({
  io: fs, budget: SCAN_WORK_BUDGET, now: () => NOW, token: () => `t${tokens++}`,
  actor: () => ({ user: 'tester', tty: null, pid: 1, pid_started: null }),
  probe: { signal0: () => 'exists', start: () => 'start', compare: () => 'match' },
  fault: () => undefined, log: () => undefined, ...over,
});

function enroll(allow = '[{call: fe-member}]'): void {
  env = makeEnv();
  said = [];
  tokens = 0;
  premiseOk = true;
  setOsSandboxForTest(true);
  const tool = path.join(env.root, 'exec', 'bin', 'tool');
  write(tool, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(tool, 0o755);
  fs.writeFileSync(path.join(env.home, 'executors.yaml'),
    `executors:\n  x:\n    command: ["${tool}"]\n    allow: ${allow}\n    timeout_sec: 5\n`);
}

const chain = (): void => {
  const file = path.join(env.home, 'team.yaml');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('  fe-member:', '  fe-member:\n    fallback: [{ model: haiku }]'));
};

const req = (payload: string): string => `executor: x\n\n${payload}`;
const slotOf = (callId: string) => requestPaths(env.home, { kind: 'call', call_id: callId });
const records = () => listCommittedIds(env.home).ids.map((id) => readRecord(env.home, id));
const callIdOf = (proposals: string): string => path.basename(path.dirname(proposals));

function run(invoker: Invoker, over: Partial<CallOptions> = {}) {
  return callAgent({
    home: env.home, agent: 'fe-member', task: 'what is here?', dir: env.repo, invoker,
    say: (line) => said.push(line), sleep: async () => {},
    approvalPremise: { platform: 'linux', sandboxAvailable: () => premiseOk },
    approvalCollect: deps(), ...over,
  });
}

const put = (proposals: string, name: string, body: string): void => {
  fs.mkdirSync(proposals, { recursive: true });
  fs.writeFileSync(path.join(proposals, name), body);
};

describe('enrolled call lifecycle', () => {
  it('call prepares an empty canonical proposals directory before every candidate', async () => {
    enroll();
    chain();
    const seen: WakeInput[] = [];
    const entered: string[][] = [];
    const r = await run(async (input) => {
      entered.push(input.proposalsDir ? fs.readdirSync(input.proposalsDir) : ['missing']);
      seen.push(input);
      return seen.length === 1 ? fail('rate_limit') : OK('from backup');
    });
    expect(r.ok).toBe(true);
    expect(seen).toHaveLength(2);
    expect(entered).toEqual([[], []]);
    const dir = seen[0]?.proposalsDir;
    expect(dir).toEqual(expect.any(String));
    expect(seen[1]?.proposalsDir).toBe(dir);
    expect(fs.lstatSync(dir!).isDirectory()).toBe(true);
    for (const input of seen) {
      expect(input.systemPrompt).toMatch(/Approval requests/);
      expect(input.systemPrompt).toContain(input.proposalsDir!);
      expect(input.userPrompt).toContain(`Approval request directory (see the system prompt): ${input.proposalsDir}`);
      const settings = buildClaudeSettings(input.project, input.agent, undefined, input.proposalsDir);
      const allow = (settings.sandbox as { filesystem: { allowWrite: string[] } }).filesystem.allowWrite;
      expect(allow).toContain(input.proposalsDir);
      expect(writePolicy(input.project, input.agent, input.proposalsDir).allowDirs).toContain(input.proposalsDir);
    }

    env.cleanup();
    enroll();
    const single: WakeInput[] = [];
    const singleEntered: string[][] = [];
    const solo = await run(async (input) => {
      singleEntered.push(input.proposalsDir ? fs.readdirSync(input.proposalsDir) : ['missing']);
      single.push(input);
      return OK('once');
    });
    expect(solo.ok).toBe(true);
    expect(single).toHaveLength(1);
    expect(singleEntered).toEqual([[]]);
    expect(single[0]?.proposalsDir).toEqual(expect.any(String));
  });

  it('call refuses unsafe or unattributable proposals before invoking', async () => {
    const cases = ['symlink', 'fifo', 'file', 'nonempty', 'corrupt-seq', 'held-coord', 'mkdir-permission'] as const;
    for (const kind of cases) {
      enroll();
      chain();
      const sentinel = path.join(env.root, 'sentinel.txt');
      write(sentinel, 'keep');
      const realMkdir = fs.mkdirSync;
      const spy = vi.spyOn(fs, 'mkdirSync').mockImplementation(((p: fs.PathLike, opts?: fs.MakeDirectoryOptions) => {
        const target = String(p);
        if (kind === 'mkdir-permission' && target.includes(`${path.sep}proposals`)) {
          const err = new Error('EACCES') as NodeJS.ErrnoException;
          err.code = 'EACCES';
          throw err;
        }
        const made = realMkdir(p, opts);
        if (target.endsWith(`${path.sep}log`) && target.includes(`${path.sep}calls${path.sep}`)) {
          const callId = path.basename(path.dirname(target));
          const root = slotOf(callId).root;
          realMkdir(root, { recursive: true });
          const proposals = slotOf(callId).proposals;
          if (kind === 'symlink') {
            realMkdir(path.join(env.root, 'link-target'), { recursive: true });
            fs.symlinkSync(path.join(env.root, 'link-target'), proposals);
          } else if (kind === 'fifo') execFileSync('mkfifo', [proposals]);
          else if (kind === 'file') fs.writeFileSync(proposals, 'not a directory');
          else if (kind === 'nonempty') put(proposals, 'orphan.req', req('leftover'));
          else if (kind === 'corrupt-seq') fs.writeFileSync(path.join(root, 'collected.seq'), 'nope\n');
          else if (kind === 'held-coord') realMkdir(path.join(root, '.coord'));
        }
        return made;
      }) as typeof fs.mkdirSync);
      let calls = 0;
      const r = await run(async () => { calls += 1; return OK('no'); });
      spy.mockRestore();
      expect(calls, kind).toBe(0);
      expect(r.error, kind).toBe(`Approval call not started: proposals could not be confirmed empty. Run agent-lyceum doctor; inspect requests/calls/${r.callId}.`);
      expect(records(), kind).toEqual([]);
      expect(fs.readFileSync(sentinel, 'utf8'), kind).toBe('keep');
      env.cleanup();
    }
  });

  it('call parks failed candidates and collects only the successful candidate', async () => {
    enroll();
    chain();
    let n = 0;
    const r = await run(async (input) => {
      n += 1;
      put(input.proposalsDir!, `n${n}.req`, req(`body-${n}`));
      return n === 1 ? fail('rate_limit') : OK('done');
    });
    expect(r.ok).toBe(true);
    const slot = slotOf(r.callId);
    expect(fs.readFileSync(path.join(slot.parked, '1', 'n1.req'), 'utf8')).toBe(req('body-1'));
    const recs = records().filter((rec) => rec !== null);
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({ disposition: 'pending', origin: { kind: 'call', call_id: r.callId } });
    expect(fs.readFileSync(path.join(env.home, 'approvals', recs[0]!.id, 'payload'), 'utf8')).toBe('body-2');
    expect(fs.existsSync(path.join(env.home, 'approvals', '.feedback'))).toBe(false);
  });

  it('call publishes ok only for the successful attempt', async () => {
    enroll();
    chain();
    const during: Array<string | null> = [];
    let n = 0;
    const r = await run(async (input) => {
      n += 1;
      if (!input.proposalsDir) { during.push('missing'); return n === 1 ? fail('rate_limit') : OK('done'); }
      during.push(readCallApprovalOk(env.home, callIdOf(input.proposalsDir))?.call_id ?? null);
      put(input.proposalsDir, 'a.req', req(`try-${n}`));
      return n === 1 ? fail('rate_limit') : OK('done');
    });
    expect(during[0]).toBeNull();
    expect(during[1]).toBeNull();
    expect(r.ok).toBe(true);
    expect(readCallApprovalOk(env.home, r.callId)).toMatchObject({ schema_version: 1, successful_attempt: 2, call_id: r.callId });
    env.cleanup();

    const blocked: Array<{ name: string; reply: WakeResult | 'throw'; invokes: number }> = [
      { name: 'all-fail', reply: fail('rate_limit', 'err1'), invokes: 2 },
      { name: 'auth', reply: fail('auth', 'nope'), invokes: 1 },
      { name: 'throw', reply: 'throw', invokes: 1 },
      { name: 'timeout', reply: fail('timeout', 'slow'), invokes: 2 },
      { name: 'cancel', reply: CANCELLED, invokes: 1 },
    ];
    for (const spec of blocked) {
      enroll();
      chain();
      let calls = 0;
      const out = await run(async (input) => {
        calls += 1;
        put(input.proposalsDir!, `f${calls}.req`, req(`fail-${calls}`));
        if (spec.reply === 'throw') throw new Error('kaboom');
        return spec.reply;
      });
      expect(readCallApprovalOk(env.home, out.callId), spec.name).toBeNull();
      const parked = slotOf(out.callId).parked;
      for (let i = 1; i <= spec.invokes; i += 1) {
        expect(fs.readFileSync(path.join(parked, String(i), `f${i}.req`), 'utf8'), spec.name).toBe(req(`fail-${i}`));
      }
      expect(calls, spec.name).toBe(spec.invokes);
      env.cleanup();
    }
  });

  it('call commits ok before result and collects after guard under its lease', async () => {
    enroll();
    const persona = path.join(env.home, 'agents/fe-member/AGENT.md');
    const before = fs.readFileSync(persona, 'utf8');
    let resultMissing = false;
    let restored = false;
    let refusal: unknown;
    setFaultHook((step) => {
      if (step === 'call:ok-published') {
        const id = fs.readdirSync(path.join(env.home, 'calls')).find((name) => !name.startsWith('.'));
        resultMissing = !fs.existsSync(path.join(env.home, 'calls', id!, 'result.md'));
        restored = fs.readFileSync(persona, 'utf8') === before;
      }
      if (step === 'collection:before-done') {
        const second = callAgent({
          home: env.home, agent: 'fe-member', task: 'other', dir: env.repo, invoker: async () => OK('x'),
          say: () => {}, approvalPremise: PREMISE,
        });
        second.then(() => { refusal = 'started'; }, (err) => { refusal = err; });
      }
    });
    const r = await run(async (input) => {
      fs.writeFileSync(persona, '# hijacked\n');
      if (input.proposalsDir) put(input.proposalsDir, 'kept.req', req('kept-body'));
      return OK('kept');
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(r.ok).toBe(true);
    expect(resultMissing).toBe(true);
    expect(restored).toBe(true);
    expect(fs.readFileSync(persona, 'utf8')).toBe(before);
    expect((refusal as Error).message).toMatch(/already being called/);
    expect(fs.readFileSync(path.join(r.callDir, 'result.md'), 'utf8')).toBe('kept\n');
  });

  it('call does not block when the diagnostic log is a fifo', async () => {
    enroll();
    const started = Date.now();
    const r = await run(async (input) => {
      const id = callIdOf(input.proposalsDir!);
      execFileSync('mkfifo', [path.join(env.home, 'calls', id, 'log.jsonl')]);
      fs.writeFileSync(path.join(env.home, 'executors.yaml'), 'not: [yaml\n');
      put(input.proposalsDir!, 'keep.req', req('fifo-body'));
      return OK('still-ok');
    });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(r).toMatchObject({ ok: true, text: 'still-ok' });
    expect(said).toContain('Approval call diagnostics could not be persisted.');
    expect(fs.readFileSync(path.join(r.callDir, 'result.md'), 'utf8')).toBe('still-ok\n');
  }, 15_000);

  it('call keeps success when approval collection is retained', async () => {
    const cases = ['config-invalid', 'allow-removed', 'premise', 'eacces', 'enospc', 'budget'] as const;
    for (const kind of cases) {
      enroll();
      const yaml = fs.readFileSync(path.join(env.home, 'executors.yaml'), 'utf8');
      let calls = 0;
      const io = { ...fs } as CollectDeps['io'];
      if (kind === 'eacces' || kind === 'enospc') {
        const code = kind === 'eacces' ? 'EACCES' : 'ENOSPC';
        io.mkdirSync = ((p: fs.PathLike, opts?: fs.MakeDirectoryOptions) => {
          if (String(p).includes(`${path.sep}approvals`)) {
            const err = new Error(code) as NodeJS.ErrnoException;
            err.code = code;
            throw err;
          }
          return fs.mkdirSync(p, opts);
        }) as typeof fs.mkdirSync;
      }
      const r = await run(async (input) => {
        calls += 1;
        put(input.proposalsDir!, 'keep.req', req('recover-me'));
        if (kind === 'config-invalid') fs.writeFileSync(path.join(env.home, 'executors.yaml'), 'not: [yaml\n');
        if (kind === 'allow-removed') fs.writeFileSync(path.join(env.home, 'executors.yaml'), yaml.replace('[{call: fe-member}]', '[]'));
        if (kind === 'premise') premiseOk = false;
        return OK('still-ok');
      }, { approvalCollect: deps(kind === 'budget' ? { budget: 1 } : { io }) });
      expect(r, kind).toMatchObject({ ok: true, text: 'still-ok' });
      expect(fs.readFileSync(path.join(r.callDir, 'result.md'), 'utf8'), kind).toBe('still-ok\n');
      expect(said.some((line) => line.startsWith(`Call ${r.callId}: approval collection retained (`)), kind).toBe(true);
      expect(fs.readFileSync(path.join(r.callDir, 'log.jsonl'), 'utf8'), kind).toMatch(/"event":"approval_collect"/);
      if (kind === 'config-invalid' || kind === 'allow-removed') fs.writeFileSync(path.join(env.home, 'executors.yaml'), yaml);
      if (kind === 'premise') premiseOk = true;
      const marker = readCallApprovalOk(env.home, r.callId);
      expect(marker, kind).not.toBeNull();
      const again = collectCallApproval(env.home, marker!, { premise: PREMISE, collect: deps(), log: () => undefined });
      expect(again.verdict, kind).toEqual({ kind: 'wake' });
      expect(records().some((rec) => rec?.disposition === 'pending'), kind).toBe(true);
      expect(calls, kind).toBe(1);
      env.cleanup();
    }
  });

  it('call never sends approval feedback or writes delivery markers', async () => {
    enroll();
    chain();
    const token = 'APPROVAL-SENTINEL-9f3a';
    const other = requestPaths(env.home, { kind: 'call', call_id: 'other-call' });
    put(other.proposals, 'old.req', req(token));
    fs.mkdirSync(path.join(env.home, 'approvals'), { recursive: true });
    fs.writeFileSync(path.join(env.home, 'approvals', 'note.txt'), `executed ${token}`);
    const prompts: string[] = [];
    let calls = 0;
    const r = await run(async (input) => {
      calls += 1;
      prompts.push(input.systemPrompt, input.userPrompt);
      if (input.proposalsDir) put(input.proposalsDir, 'mine.req', req('mine'));
      return calls === 1 ? fail('rate_limit') : OK('done');
    });
    expect(r.ok).toBe(true);
    expect(calls).toBe(2);
    expect(records().filter((rec) => rec?.disposition === 'pending')).toHaveLength(1);
    expect(prompts.join('\n')).not.toContain(token);
    expect(fs.existsSync(path.join(env.home, 'approvals', '.feedback'))).toBe(false);
  });

  it('call stops fallback when parking or preparation fails', async () => {
    enroll();
    chain();
    const realRename = fs.renameSync.bind(fs);
    const parkSpy = vi.spyOn(fs, 'renameSync').mockImplementation(((from: fs.PathLike, to: fs.PathLike) => {
      if (String(to).includes(`${path.sep}parked${path.sep}`)) {
        const err = new Error('EACCES') as NodeJS.ErrnoException;
        err.code = 'EACCES';
        throw err;
      }
      return realRename(from, to);
    }) as typeof fs.renameSync);
    let calls = 0;
    const parked = await run(async (input) => {
      calls += 1;
      put(input.proposalsDir!, 'a.req', req('park-me'));
      return fail('rate_limit');
    });
    parkSpy.mockRestore();
    expect(calls).toBe(1);
    expect(parked.error).toBe(`Approval call stopped: failed-attempt proposals could not be parked. Inspect requests/calls/${parked.callId}.`);
    expect(readCallApprovalOk(env.home, parked.callId)).toBeNull();
    env.cleanup();

    enroll();
    chain();
    const cancelSpy = vi.spyOn(fs, 'renameSync').mockImplementation(((from: fs.PathLike, to: fs.PathLike) => {
      if (String(to).includes(`${path.sep}parked${path.sep}`)) {
        const err = new Error('EACCES') as NodeJS.ErrnoException;
        err.code = 'EACCES';
        throw err;
      }
      return realRename(from, to);
    }) as typeof fs.renameSync);
    const cancelled = await run(async (input) => {
      put(input.proposalsDir!, 'c.req', req('cancel-me'));
      return CANCELLED;
    });
    cancelSpy.mockRestore();
    expect(cancelled).toMatchObject({ ok: false, cancelled: true });
    expect(readCallApprovalOk(env.home, cancelled.callId)).toBeNull();
    env.cleanup();

    enroll();
    const ac = new AbortController();
    ac.abort();
    let fresh = 0;
    const early = await run(async () => { fresh += 1; return OK('no'); }, { signal: ac.signal });
    expect(fresh).toBe(0);
    expect(early).toMatchObject({ ok: false, cancelled: true });
    expect(readCallApprovalOk(env.home, early.callId)).toBeNull();
    env.cleanup();

    enroll();
    const realLink = fs.linkSync.bind(fs);
    const link = vi.spyOn(fs, 'linkSync').mockImplementation(((from: fs.PathLike, to: fs.PathLike) => {
      if (String(to).endsWith(`${path.sep}ok.json`)) {
        const err = new Error('EIO') as NodeJS.ErrnoException;
        err.code = 'EIO';
        throw err;
      }
      return realLink(from, to);
    }) as typeof fs.linkSync);
    await expect(run(async (input) => {
      put(input.proposalsDir!, 'm.req', req('marker'));
      return OK('yes');
    })).rejects.toThrow(/Approval call success marker could not be committed; no collection was attempted\. Inspect requests\/calls\/.+\/ok\.json\./);
    link.mockRestore();
    expect(records()).toEqual([]);
    env.cleanup();

    enroll();
    const resultSpy = vi.spyOn(fs, 'renameSync').mockImplementation(((from: fs.PathLike, to: fs.PathLike) => {
      if (String(to).endsWith(`${path.sep}result.md`)) throw new Error(`rename failed: ${String(to)}`);
      return realRename(from, to);
    }) as typeof fs.renameSync);
    await expect(run(async (input) => {
      put(input.proposalsDir!, 'r.req', req('result'));
      return OK('yes');
    })).rejects.toThrow(/result\.md/);
    resultSpy.mockRestore();
    const id = fs.readdirSync(path.join(env.home, 'calls')).find((name) => !name.startsWith('.'))!;
    expect(readCallApprovalOk(env.home, id)).toMatchObject({ call_id: id });
    expect(fs.existsSync(path.join(env.home, 'calls', id, 'result.md'))).toBe(false);
  });

  it('call grants only its own proposals subtree', async () => {
    enroll();
    const other = requestPaths(env.home, { kind: 'call', call_id: 'other-call' });
    put(other.proposals, 'x.req', req('other'));
    const runSlot = requestPaths(env.home, { kind: 'run', project: 'demo', run_id: 'run1', slot: 'qa-member' });
    put(runSlot.proposals, 'y.req', req('run'));
    const notes: string[] = [];
    const r = await run(async (input) => {
      if (!input.proposalsDir) notes.push('missing proposalsDir');
      else {
        const settings = buildClaudeSettings(input.project, input.agent, undefined, input.proposalsDir);
        const fsSandbox = (settings.sandbox as { filesystem: { allowWrite: string[]; denyWrite: string[] } }).filesystem;
        const own = slotOf(callIdOf(input.proposalsDir));
        if (!fsSandbox.allowWrite.includes(input.proposalsDir)) notes.push('own proposals not allowed');
        for (const blocked of [own.ok, own.collected, own.parked, path.join(env.home, 'approvals'), other.proposals, runSlot.proposals]) {
          if (blocked && fsSandbox.allowWrite.includes(blocked)) notes.push(`allowed ${blocked}`);
        }
        if (!fsSandbox.denyWrite.some((p) => p.includes(`${path.sep}approvals`))) notes.push('store not denied');
        if (!fsSandbox.denyWrite.some((p) => p.includes('other-call'))) notes.push('other proposals not denied');
        if (!writePolicy(input.project, input.agent, input.proposalsDir).allowDirs.includes(input.proposalsDir)) notes.push('policy missing proposals');
      }
      return OK('granted');
    });
    expect(r.ok).toBe(true);
    expect(notes).toEqual([]);
    env.cleanup();

    env = makeEnv();
    said = [];
    let plainDir: string | undefined = 'unset';
    let plainGrant = false;
    const plain = await callAgent({
      home: env.home, agent: 'fe-member', task: 'what is here?', dir: env.repo,
      invoker: async (input) => {
        plainDir = input.proposalsDir;
        plainGrant = writePolicy(input.project, input.agent).allowDirs.some((d) => d.includes(`${path.sep}proposals`));
        return OK('plain');
      },
      say: () => {},
    });
    expect(plain.ok).toBe(true);
    expect(plainDir).toBeUndefined();
    expect(plainGrant).toBe(false);
    expect(fs.existsSync(path.join(env.home, 'requests'))).toBe(false);
  });

  it('call binds the wake grant and the success marker to the same view resolution', async () => {
    enroll();
    const sentinel = path.join(env.root, 'sentinel-grant');
    fs.mkdirSync(sentinel);
    const canon = canonicalPath(sentinel);
    const team = path.join(env.home, 'team.yaml');
    const original = fs.readFileSync(team, 'utf8');
    const fresh = original.replace('  fe-member:', `  fe-member:\n    sandbox:\n      write: [${JSON.stringify(sentinel)}]`);
    const qualificationsFor = (text: string, callId: string): Record<string, string> => {
      const saved = fs.readFileSync(team, 'utf8');
      fs.writeFileSync(team, text);
      try {
        const resolved = resolveCallAgent(env.home, 'fe-member');
        const project = callProject(env.home, resolved, env.repo, path.join(env.home, 'calls', callId));
        const loaded = loadFreshConfig(env.home, { userHome: os.homedir() });
        if (!loaded.ok) throw new Error('oracle executors');
        const proposals = canonicalPath(requestPaths(env.home, { kind: 'call', call_id: callId }).proposals);
        const snap = snapshotInputs(project, resolved.name, loaded.config, proposals);
        const out: Record<string, string> = {};
        for (const [name, input] of snap.inputs) out[name] = qualificationHash(input);
        return out;
      } finally {
        fs.writeFileSync(team, saved);
      }
    };
    const realRead = fs.readFileSync.bind(fs);
    let teamReads = 0;
    const teamTexts: string[] = [];
    const spy = vi.spyOn(fs, 'readFileSync').mockImplementation(((file: fs.PathOrFileDescriptor, options?: unknown) => {
      if (typeof file === 'string' && path.resolve(file) === path.resolve(team)) {
        teamReads += 1;
        const text = teamReads === 1 ? original : fresh;
        teamTexts.push(text);
        if (typeof options === 'string' || (typeof options === 'object' && options !== null && 'encoding' in options)) return text;
        return Buffer.from(text);
      }
      return realRead(file, options as never);
    }) as typeof fs.readFileSync);
    const grants: string[][] = [];
    let r: Awaited<ReturnType<typeof run>>;
    try {
      r = await run(async (input) => {
        grants.push(writePolicy(input.project, input.agent, input.proposalsDir).allowDirs);
        return OK('from the view');
      });
    } finally {
      spy.mockRestore();
    }
    const marker = readCallApprovalOk(env.home, r.callId);
    const opening = qualificationsFor(original, r.callId);
    const viewed = qualificationsFor(fresh, r.callId);
    expect(r.ok).toBe(true);
    expect(teamReads).toBeGreaterThan(1);
    expect(teamTexts[0]).toBe(original);
    expect(teamTexts.slice(1).some((text) => text === fresh)).toBe(true);
    expect({
      grantHasSentinel: grants[0]?.includes(canon) === true,
      markerHasSentinel: marker?.full_writable.dirs.includes(canon) === true,
      hashIsView: JSON.stringify(marker?.qualifications) === JSON.stringify(viewed),
      hashIsOpening: JSON.stringify(marker?.qualifications) === JSON.stringify(opening),
    }).toEqual({ grantHasSentinel: true, markerHasSentinel: true, hashIsView: true, hashIsOpening: false });
  });
});
