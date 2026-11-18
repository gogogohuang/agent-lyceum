import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Invoker, WakeResult } from '../src/adapters/index.js';
import { callAgent, callsDir } from '../src/call.js';
import { ConfigError } from '../src/config.js';
import { setOsSandboxForTest } from '../src/policy.js';
import { makeEnv, write, type TestEnv } from './helpers.js';

vi.setConfig({ testTimeout: 30_000 });
const OK: WakeResult = { ok: true, text: 'done', exitCode: 0, timedOut: false };
const SPARSE = 'SENTINEL-PARSE-31ab';
let env: TestEnv;
let tool: string;
let calls: number;
const inv: Invoker = async () => { calls++; return OK; };
beforeEach(() => { calls = 0; setOsSandboxForTest(true); });
afterEach(() => { setOsSandboxForTest(undefined); vi.restoreAllMocks(); env?.cleanup(); });

const setup = () => {
  env = makeEnv();
  tool = path.join(env.root, 'exec', 'bin', 'tool');
  write(tool, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(tool, 0o755);
  fs.writeFileSync(path.join(env.home, 'executors.yaml'), `executors:\n  x:\n    command: ["${tool}"]\n    allow: [{call: fe-member}]\n    timeout_sec: 5\n`);
};
const call = (dir = env.repo) => callAgent({ home: env.home, agent: 'fe-member', task: 't', dir, invoker: inv, say: () => {}, approvalPremise: { platform: 'linux', sandboxAvailable: () => true } });
const callDirs = () => (fs.existsSync(callsDir(env.home)) ? fs.readdirSync(callsDir(env.home)) : []);
const demoYaml = () => path.join(env.home, 'projects', 'demo', 'project.yaml');

describe('enrolled call: actual cwd and unreadable foreign projects', () => {
  it('an unreadable project (every disk project is foreign to a call) is not called: fixed text, no lease, call directory or invoke; fixed once repaired and called again', async () => {
    setup();
    const good = fs.readFileSync(demoYaml(), 'utf8');
    fs.writeFileSync(demoYaml(), `dir: [${SPARSE}\n`);
    const err = await call().catch((e) => e);
    expect(err).toBeInstanceOf(ConfigError);
    expect(err.message).toMatch(/was not called: approval state could not be determined \(failed: containment\)\. No agent was started/);
    expect(err.message).not.toContain(SPARSE);
    expect(err.message).not.toContain(env.root);
    expect(calls).toBe(0);
    expect(callDirs()).toEqual([]);
    fs.writeFileSync(demoYaml(), good);
    expect((await call()).ok).toBe(true);
    expect(calls).toBe(1);
  });
  it('a --dir that contains the executor is refused even though it does not overlap the home', async () => {
    setup();
    const dir = path.join(env.root, 'exec');
    const err = await call(dir).catch((e) => e);
    expect(err).toBeInstanceOf(ConfigError);
    expect(err.message).toContain('containment');
    expect(calls).toBe(0);
    expect(callDirs()).toEqual([]);
  });
  it('a proven overlap takes precedence over an unreadable foreign project', async () => {
    setup();
    fs.writeFileSync(demoYaml(), `dir: [${SPARSE}\n`);
    const err = await call(path.join(env.root, 'exec')).catch((e) => e);
    expect(err.message).toMatch(/failed: containment/);
    expect(err.message).toMatch(/premise check failed/);
    expect(calls).toBe(0);
  });
  it('a deep directory in another project memory does not stop a call', async () => {
    setup();
    fs.mkdirSync(path.join(env.home, 'projects', 'demo', 'task-memory', 'r', 'a/b/c/d/e/f/g/h/i'), { recursive: true });
    expect((await call()).ok).toBe(true);
  });
  it('the call id and project used by the gate are the ones the call runs with', async () => {
    setup();
    const r = await call();
    expect(callDirs()).toEqual([r.callId]);
  });
  it('default-off: without executors.yaml no project directory is listed for the gate', async () => {
    env = makeEnv();
    const spy = vi.spyOn(fs, 'readdirSync');
    expect((await call()).ok).toBe(true);
    expect(spy.mock.calls.some((c) => String(c[0]) === path.join(env.home, 'projects'))).toBe(false);
  });
});
