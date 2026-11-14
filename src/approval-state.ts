import path from 'node:path';
import { ApprovalError } from './approval-error.js';
import { defaultApprovalIo, publishExclusive, readApprovalFile } from './approval-io.js';
import type { ApprovalIo, FaultPoint } from './approval-io.js';
import { recordPaths } from './approval-paths.js';
import { parseApprovalState } from './approval-schema.js';
import { readRecord } from './approval-store.js';
import type { StoreDeps } from './approval-store.js';
import { decideTransition } from './approval-transition.js';
import type { Decision, TransitionContext, TransitionEvent } from './approval-transition.js';
import type { ApprovalId, ApprovalState, Current } from './approval-types.js';

const STATE_LIMIT = 1024 * 1024;
const NUMERIC = /^\d+\.json$/;
const CANONICAL = /^[1-9][0-9]*\.json$/;
export const DEFAULT_MAX_CONFLICTS = 32;

export type TransitionResult =
  | { readonly kind: 'committed'; readonly current: Current }
  | { readonly kind: 'unchanged'; readonly current: Current; readonly decision: Exclude<Decision, { kind: 'append' }> }
  | { readonly kind: 'contended'; readonly current: Current };

const corrupt = (file: string, why: string, cause?: unknown): ApprovalError =>
  new ApprovalError('CORRUPT_STATE', `State sequence is invalid (${why}): ${file}`, file, cause === undefined ? undefined : { cause });

/** Read and strictly parse state/<n>.json; null only when the file does not exist. */
function readState(home: string, dir: string, n: number, io: ApprovalIo): ApprovalState | null {
  const file = path.join(dir, `${n}.json`);
  const buf = readApprovalFile(file, STATE_LIMIT, io, home);
  if (buf === null) return null;
  let value: unknown;
  try { value = JSON.parse(buf.toString('utf8')); } catch (e) { throw corrupt(file, 'not valid JSON', e); }
  const state = parseApprovalState(value, file);
  if (state.n !== n) throw corrupt(file, 'n does not match the file name');
  return state;
}

/** Highest numeric n in `names`; alias (`01.json`, `0.json`) and unsafe-integer names are fail-closed. Temp/other names are ignored. */
function highestN(dir: string, names: readonly string[]): number {
  let max = 0;
  for (const name of names) {
    if (!NUMERIC.test(name)) continue;
    const n = Number(name.slice(0, -5));
    if (!CANONICAL.test(name) || !Number.isSafeInteger(n)) throw corrupt(path.join(dir, name), 'alias or overflow state name');
    if (n > max) max = n;
  }
  return max;
}

/**
 * The current state: the record plus the numerically highest state file. A `denied` record has
 * no state. The highest file must parse, carry its own n, and (for n>1) have a readable
 * predecessor n-1; any failure throws and never falls back to a lower n. Missing record.json is
 * CORRUPT_RECORD (no synthetic pending). `home` must be canonical.
 */
export function readCurrent(home: string, id: ApprovalId, io: ApprovalIo = defaultApprovalIo): Current {
  const record = readRecord(home, id, io);
  const paths = recordPaths(home, id);
  if (record === null) throw new ApprovalError('CORRUPT_RECORD', 'record.json does not exist', paths.record);
  if (record.disposition === 'denied') return { record, n: 0, state: null };
  for (let attempt = 0; ; attempt++) {
    let names: string[];
    try {
      names = io.readdirSync(paths.state) as string[];
    } catch (e) {
      if ((e as NodeJS.ErrnoException | null)?.code === 'ENOENT') return { record, n: 0, state: null };
      throw new ApprovalError('IO_ERROR', `readdir failed: ${paths.state}`, paths.state, { cause: e });
    }
    const n = highestN(paths.state, names);
    if (n === 0) return { record, n: 0, state: null };
    const state = readState(home, paths.state, n, io);
    const prev = n > 1 ? readState(home, paths.state, n - 1, io) : true;
    if (state !== null && prev !== null) return { record, n, state };
    // A file vanished between readdir and read: re-read once, then fail closed.
    if (attempt >= 1) throw corrupt(paths.state, state === null ? 'highest state vanished' : 'missing predecessor');
  }
}

/**
 * Append transitions until one is committed, refused/no-op, or conflicts run out. Every loop
 * re-reads the latest state and calls `decide(latest)` again, so now/owner/probe/proof are fresh
 * on each retry (never the initial event). EEXIST means another writer took n+1: re-read, re-decide.
 * `committed` is NOT a spawn authorization: only a committed `executing` whose owner is this
 * process may be handed to an executor. `contended` (after `maxConflicts` lost races, no sleep)
 * tells the caller to retry. A write error (e.g. `executed` cannot be written) throws and leaves
 * the previous state (`executing`) in place.
 */
export function transition(home: string, id: ApprovalId,
  decide: (latest: Current) => { readonly event: TransitionEvent; readonly context: TransitionContext },
  deps: StoreDeps = {}, maxConflicts: number = DEFAULT_MAX_CONFLICTS): TransitionResult {
  if (!Number.isSafeInteger(maxConflicts) || maxConflicts < 1) throw new ApprovalError('INVALID_INPUT', 'maxConflicts must be a positive integer');
  const io = deps.io ?? defaultApprovalIo;
  const stateDir = recordPaths(home, id).state;
  const publishDeps = { root: home, io, token: deps.token, diagnostic: deps.diagnostic,
    fault: (p: FaultPoint) => deps.fault?.(p) };
  for (let tries = 0; tries < maxConflicts; tries++) {
    const latest = readCurrent(home, id, io);
    const { event, context } = decide(latest);
    const decision = decideTransition(latest, event, context);
    if (decision.kind !== 'append') return { kind: 'unchanged', current: latest, decision };
    const bytes = Buffer.from(`${JSON.stringify(decision.next, null, 2)}\n`, 'utf8');
    if (publishExclusive(path.join(stateDir, `${decision.next.n}.json`), bytes, publishDeps) === 'created') {
      return { kind: 'committed', current: { record: latest.record, n: decision.next.n, state: decision.next } };
    }
  }
  return { kind: 'contended', current: readCurrent(home, id, io) };
}
