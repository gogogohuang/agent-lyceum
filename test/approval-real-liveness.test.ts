import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { expect, it } from 'vitest';
import { creatorLiveness, defaultSignal0 } from '../src/approval-liveness.js';
import { pidStart } from '../src/project-lock.js';

it('uses real signal-0 and pidStart: own pid matches; an exited child is dead', async (context) => {
  const now = Date.now();
  const at = new Date(now).toISOString();
  const start = pidStart(process.pid);
  expect(defaultSignal0(process.pid)).toBe('exists');
  if (start === undefined) context.skip('Real pidStart unavailable: sandbox may deny ps/proc access');
  expect(creatorLiveness({ pid: process.pid, pid_started: start as string }, at, 1, now + 999999))
    .toEqual({ alive: true, reason: 'matching_start' });
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  try {
    await once(child, 'spawn');
    const pid = child.pid as number;
    const childStart = pidStart(pid);
    expect(childStart).toBeTruthy();
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    await exited;
    expect(creatorLiveness({ pid, pid_started: childStart as string }, at, 1, now))
      .toEqual({ alive: false, reason: 'missing_pid' });
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
    }
  }
}, 10000);
