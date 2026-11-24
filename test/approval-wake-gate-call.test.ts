import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Invoker, WakeResult } from '../src/adapters/index.js';
import { callAgent, callsDir } from '../src/call.js';
import { ConfigError } from '../src/config.js';
import { setOsSandboxForTest } from '../src/policy.js';
import { makeEnv, write, type TestEnv } from './helpers.js';

vi.setConfig({ testTimeout: 30_000 });
const SECRET = 'SENTINEL-SECRET-call-31d';
const OK: WakeResult = { ok: true, text: 'done', exitCode: 0, timedOut: false };
let env: TestEnv;
let tool: string;
let calls: number;
const inv: Invoker = async () => { calls++; return OK; };
beforeEach(() => { calls = 0; setOsSandboxForTest(true); });
afterEach(() => { setOsSandboxForTest(undefined); env?.cleanup(); });

const setup = (allow: string) => {
  env = makeEnv();
  tool = path.join(env.root, 'exec', 'bin', 'tool');
  write(tool, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(tool, 0o755);
  fs.writeFileSync(path.join(env.home, 'executors.yaml'), `executors:\n  x:\n    command: ["${tool}"]\n    allow: ${allow}\n    timeout_sec: 5\n    env:\n      TOKEN: ${SECRET}\n`);
};
const call = (agent = 'fe-member', premise = { platform: 'linux' as const, sandboxAvailable: () => true }) =>
  callAgent({ home: env.home, agent, task: 't', dir: env.repo, invoker: inv, say: () => {}, approvalPremise: premise });
const callDirs = () => (fs.existsSync(callsDir(env.home)) ? fs.readdirSync(callsDir(env.home)) : []);

describe('call gate', () => {
  it('an enrolled agent with a failing premise is refused before any call directory, lease or invoke; the text is fixed', async () => {
    setup('[{call: fe-member}]');
    const err = await call('fe-member', { platform: 'linux', sandboxAvailable: () => false }).catch((e) => e);
    expect(err).toBeInstanceOf(ConfigError);
    expect(err.message).toMatch(/was not called/);
    expect(err.message).toContain('project-premises');
    expect(err.message).not.toContain(SECRET);
    expect(err.message).not.toContain(env.root);
    expect(calls).toBe(0);
    expect(callDirs()).toEqual([]);
  });
  it('a containment error (the executor lies inside what the agent may write) is refused with containment', async () => {
    setup('[{call: fe-member}]');
    const team = path.join(env.home, 'team.yaml');
    fs.writeFileSync(team, fs.readFileSync(team, 'utf8').replace('\n  fe-member:\n', `\n  fe-member:\n    sandbox:\n      write: [${path.dirname(tool)}]\n`));
    const err = await call().catch((e) => e);
    expect(err).toBeInstanceOf(ConfigError);
    expect(err.message).toContain('containment');
    expect(calls).toBe(0);
    expect(callDirs()).toEqual([]);
  });
  it('an enrolled agent that passes is called', async () => {
    setup('[{call: fe-member}]');
    expect((await call()).ok).toBe(true);
    expect(calls).toBe(1);
  });
  it('a non-enrolled agent is never judged, even where the premises would fail', async () => {
    setup('[{call: qa-member}]');
    expect((await call('fe-member', { platform: 'linux', sandboxAvailable: () => false })).ok).toBe(true);
    expect(calls).toBe(1);
  });
  it('without executors.yaml nothing changes', async () => {
    env = makeEnv();
    expect((await call('fe-member', { platform: 'linux', sandboxAvailable: () => false })).ok).toBe(true);
  });
});
