import { ApprovalError } from './approval-error.js';
import type { ExecutionOwner, IsoTime } from './approval-types.js';
import { pidStart, samePidStart } from './project-lock.js';

export type Liveness = { readonly alive: boolean;
  readonly reason: 'matching_start' | 'missing_pid' | 'start_mismatch' | 'unverifiable_grace' | 'unverifiable_elapsed' };

/** Injected process facts. Any throw or `undefined` is treated as "unverifiable", never as dead. */
export interface CreatorProbe {
  signal0(pid: number): 'exists' | 'missing' | 'unverifiable';
  start(pid: number): string | undefined;
  compare(written: string, observed: string): 'match' | 'mismatch' | 'unverifiable';
}

const PROC = /^proc:\d+$/;

/** Strict compare: only provable differences are `mismatch`. Never uses lockHolderAlive's quarter-hour tolerance. */
export function defaultCompare(a: string, b: string): 'match' | 'mismatch' | 'unverifiable' {
  if (a === b || samePidStart(a, b)) return 'match';
  if (PROC.test(a) && PROC.test(b)) return 'mismatch';
  // Two ps strings differing, or mixed formats: no proof of a shared locale/TZ, so not comparable.
  return 'unverifiable';
}

/** Only ESRCH proves absence; EPERM and unknown errors are unverifiable. */
export function defaultSignal0(pid: number): 'exists' | 'missing' | 'unverifiable' {
  try {
    process.kill(pid, 0);
    return 'exists';
  } catch (e) {
    return (e as NodeJS.ErrnoException | null)?.code === 'ESRCH' ? 'missing' : 'unverifiable';
  }
}

export const defaultProbe: CreatorProbe = { signal0: defaultSignal0, start: pidStart, compare: defaultCompare };

const GRACE_EXTRA_SEC = 60;

const invalid = (what: string): never => {
  throw new ApprovalError('INVALID_INPUT', `creatorLiveness: invalid ${what}`);
};

/**
 * Strict liveness of the process that moved a request to `executing` at `executingAt`.
 * missing pid -> dead; verified matching start -> alive (even past timeout); comparable mismatch -> dead;
 * otherwise alive until now >= executingAt + (timeoutSec + 60)s, dead at equality or later.
 * A clock earlier than `executingAt` stays inside the grace window. Invalid input throws INVALID_INPUT.
 */
export function creatorLiveness(owner: ExecutionOwner, executingAt: IsoTime, timeoutSec: number,
  nowMs: number, probe: CreatorProbe = defaultProbe): Liveness {
  if (!Number.isSafeInteger(owner?.pid) || owner.pid <= 0) invalid('owner.pid');
  if (typeof owner.pid_started !== 'string' || owner.pid_started === '') invalid('owner.pid_started');
  const startedMs = Date.parse(executingAt);
  if (!Number.isFinite(startedMs)) invalid('executingAt');
  if (!Number.isFinite(timeoutSec) || timeoutSec <= 0) invalid('timeoutSec');
  if (!Number.isFinite(nowMs)) invalid('nowMs');

  let signal: ReturnType<CreatorProbe['signal0']> = 'unverifiable';
  try { signal = probe.signal0(owner.pid); } catch { /* unverifiable */ }
  if (signal === 'missing') return { alive: false, reason: 'missing_pid' };

  let verdict: ReturnType<CreatorProbe['compare']> = 'unverifiable';
  try {
    const observed = probe.start(owner.pid);
    if (observed) verdict = probe.compare(owner.pid_started, observed);
  } catch { /* unverifiable */ }
  if (verdict === 'match') return { alive: true, reason: 'matching_start' };
  if (verdict === 'mismatch') return { alive: false, reason: 'start_mismatch' };

  const threshold = startedMs + (timeoutSec + GRACE_EXTRA_SEC) * 1000;
  return nowMs >= threshold ? { alive: false, reason: 'unverifiable_elapsed' } : { alive: true, reason: 'unverifiable_grace' };
}
