import { ApprovalError } from './approval-error.js';
import type { Liveness } from './approval-liveness.js';
import type { Actor, ApprovalRecord, ApprovalState, Current, ExecutionOwner, ExitData, Sha256, StateData } from './approval-types.js';

/** Per-field cap on stored executor output (spec 4.8), counted in UTF-8 bytes. */
export const OUTPUT_CAP_BYTES = 65536;

export interface TransitionContext { readonly now_ms: number; readonly actor: Actor }

/** Result of validations done by a future UI/runner (spec 3); this module only judges them. */
export interface ApprovalProof {
  readonly origin_ok: boolean; readonly premises_ok: boolean; readonly executor_registered: boolean;
  readonly allowed: boolean; readonly interactive_tty: boolean; readonly prefix_confirmed: boolean;
  readonly completely_viewed: boolean; readonly viewed_bytes: number; readonly viewed_sha256: Sha256;
  readonly observed_payload_sha256: Sha256; readonly owner: ExecutionOwner;
  readonly timeout_sec: number; readonly command_sha256: Sha256;
}

export type TransitionEvent =
  | { readonly type: 'reject'; readonly reason: string | null; readonly interactive_tty: boolean; readonly prefix_confirmed: boolean }
  | { readonly type: 'approve'; readonly proof: ApprovalProof | null; readonly creator: Liveness | null }
  | { readonly type: 'lazy'; readonly trigger: 'list_all' | 'approve' | 'collect'; readonly creator: Liveness | null }
  | { readonly type: 'executor_exit'; readonly result: ExitData }
  | { readonly type: 'interrupt'; readonly group_termination_requested: true; readonly detail: string }
  | { readonly type: 'creator_dead'; readonly evidence: Liveness }
  | { readonly type: 'resolve'; readonly outcome: 'executed' | 'failed'; readonly conclusion: string;
      readonly interactive_tty: boolean; readonly prefix_confirmed: boolean };

/** `SEQUENCE_OVERFLOW` is added to the planned set: no other code names "n+1 is not representable". */
export type TransitionDenial = 'ALREADY_HANDLED' | 'NOT_APPLICABLE' | 'CLOCK_ROLLBACK' | 'QUALIFICATION_FAILED' |
  'CONFIRMATION_REQUIRED' | 'INVALID_PROOF' | 'NOT_CREATOR' | 'SEQUENCE_OVERFLOW';

export type Decision =
  | { readonly kind: 'append'; readonly next: ApprovalState }
  | { readonly kind: 'noop' }
  | { readonly kind: 'refuse'; readonly code: TransitionDenial; readonly hint: string };

const HASH = /^[0-9a-f]{64}$/;
const TERMINAL = new Set(['denied', 'executed', 'failed', 'rejected', 'expired', 'tampered']);

const refuse = (code: TransitionDenial, hint: string): Decision => ({ kind: 'refuse', code, hint });
const NOOP: Decision = { kind: 'noop' };
const ownerIs = (o: ExecutionOwner, a: Actor): boolean => a.pid === o.pid && a.pid_started === o.pid_started;
const confirmed = (tty: boolean, prefix: boolean, a: Actor): boolean => tty && prefix && typeof a.tty === 'string' && a.tty !== '';
const utf8 = (s: string): number => Buffer.byteLength(s, 'utf8');

function statusOf(current: Current): string {
  if (current.n === 0) {
    if (current.state !== null) throw new ApprovalError('INVALID_INPUT', 'decideTransition: n=0 with a state');
    return current.record.disposition;
  }
  if (current.state === null || current.state.n !== current.n) {
    throw new ApprovalError('INVALID_INPUT', 'decideTransition: state does not match n');
  }
  return current.state.status;
}

/** Pure: reads nothing, probes nothing, spawns nothing. A returned `append` is never a spawn authorization by itself. */
export function decideTransition(current: Current, event: TransitionEvent, context: TransitionContext): Decision {
  if (!Number.isFinite(context.now_ms)) throw new ApprovalError('INVALID_INPUT', 'decideTransition: invalid now_ms');
  const status = statusOf(current);
  if (TERMINAL.has(status)) return refuse('ALREADY_HANDLED', `request is already ${status}`);
  const next = (data: StateData): Decision => {
    if (current.n >= Number.MAX_SAFE_INTEGER) return refuse('SEQUENCE_OVERFLOW', 'state sequence cannot grow');
    let updated_at: string;
    try { updated_at = new Date(context.now_ms).toISOString(); }
    catch { throw new ApprovalError('INVALID_INPUT', 'decideTransition: now_ms is not a valid time'); }
    return { kind: 'append', next: { ...data, schema_version: 1, n: current.n + 1, previous: current.n, updated_at,
      actor: context.actor } };
  };
  const na = (): Decision => refuse('NOT_APPLICABLE', `${event.type} does not apply to ${status}`);
  const now = context.now_ms;

  if (status === 'pending') {
    const record = current.record as Extract<ApprovalRecord, { disposition: 'pending' }>;
    const expired = now > Date.parse(record.expires_at);
    switch (event.type) {
      case 'reject':
        return confirmed(event.interactive_tty, event.prefix_confirmed, context.actor)
          ? next({ status: 'rejected', reason: event.reason })
          : refuse('CONFIRMATION_REQUIRED', 'reject needs an interactive TTY and a confirmed prefix');
      case 'lazy':
        return expired ? next({ status: 'expired' }) : NOOP;
      case 'approve':
        return approvePending(record, event.proof, context, expired, next);
      default:
        return na();
    }
  }
  if (status === 'executing') {
    const state = current.state as Extract<ApprovalState, { status: 'executing' }>;
    switch (event.type) {
      case 'executor_exit':
        return ownerIs(state.owner, context.actor) ? exitDecision(event.result, next)
          : refuse('NOT_CREATOR', 'only the creator process may complete the execution');
      case 'interrupt':
        if (!ownerIs(state.owner, context.actor)) return refuse('NOT_CREATOR', 'only the creator process may interrupt');
        if (event.group_termination_requested !== true) return refuse('INVALID_PROOF', 'process group termination was not requested');
        return next({ status: 'unknown', reason: 'interrupted', detail: event.detail });
      case 'approve':
      case 'lazy':
      case 'creator_dead': {
        const liveness = event.type === 'creator_dead' ? event.evidence : event.creator;
        if (!liveness) return refuse('INVALID_PROOF', 'creator liveness evidence is required');
        return liveness.alive ? NOOP : next({ status: 'unknown', reason: 'creator_dead', detail: `creator ${liveness.reason}` });
      }
      default:
        return na();
    }
  }
  // unknown
  if (event.type === 'approve') return refuse('ALREADY_HANDLED', 'unknown is only resolved manually (resolve)');
  if (event.type !== 'resolve') return na();
  if (event.outcome !== 'executed' && event.outcome !== 'failed') return refuse('INVALID_PROOF', 'outcome must be executed or failed');
  if (typeof event.conclusion !== 'string' || event.conclusion === '') return refuse('INVALID_PROOF', 'a conclusion is required');
  if (!confirmed(event.interactive_tty, event.prefix_confirmed, context.actor)) {
    return refuse('CONFIRMATION_REQUIRED', 'resolve needs an interactive TTY and a confirmed prefix');
  }
  return next({ status: event.outcome, method: 'manual', conclusion: event.conclusion });
}

function approvePending(record: Extract<ApprovalRecord, { disposition: 'pending' }>, proof: ApprovalProof | null,
  context: TransitionContext, expired: boolean, next: (d: StateData) => Decision): Decision {
  if (context.now_ms < Date.parse(record.created_at)) return refuse('CLOCK_ROLLBACK', 'clock is earlier than created_at');
  if (expired) return next({ status: 'expired' });
  if (!proof) return refuse('INVALID_PROOF', 'approval proof is required');
  const a = context.actor;
  if (!HASH.test(proof.observed_payload_sha256)) return refuse('INVALID_PROOF', 'observed payload hash is malformed');
  if (proof.observed_payload_sha256 !== record.payload_sha256) {
    return next({ status: 'tampered', observed_sha256: proof.observed_payload_sha256 });
  }
  if (!proof.owner || typeof proof.owner.pid_started !== 'string' || proof.owner.pid_started === '' || !ownerIs(proof.owner, a)) {
    return refuse('INVALID_PROOF', 'owner must be the acting process with a known start time');
  }
  if (!Number.isSafeInteger(proof.timeout_sec) || proof.timeout_sec <= 0) return refuse('INVALID_PROOF', 'timeout_sec must be a positive integer');
  if (!HASH.test(proof.command_sha256)) return refuse('INVALID_PROOF', 'command_sha256 is malformed');
  if (!HASH.test(proof.viewed_sha256) || proof.viewed_sha256 !== record.payload_sha256
    || proof.viewed_bytes !== record.payload_bytes) {
    return refuse('INVALID_PROOF', 'viewed bytes/hash do not match the recorded payload');
  }
  if (!proof.origin_ok) return refuse('QUALIFICATION_FAILED', 'origin no longer qualifies');
  if (!proof.premises_ok) return refuse('QUALIFICATION_FAILED', 'premises or qualification snapshot no longer hold');
  if (!proof.executor_registered) return refuse('QUALIFICATION_FAILED', 'executor is no longer registered');
  if (!proof.allowed) return refuse('QUALIFICATION_FAILED', 'executor is no longer allowed');
  if (!proof.interactive_tty || typeof a.tty !== 'string' || a.tty === '') return refuse('CONFIRMATION_REQUIRED', 'an interactive TTY is required');
  if (!proof.prefix_confirmed) return refuse('CONFIRMATION_REQUIRED', 'id prefix was not confirmed');
  if (!proof.completely_viewed) return refuse('CONFIRMATION_REQUIRED', 'payload was not completely viewed');
  return next({ status: 'executing', owner: { pid: proof.owner.pid, pid_started: proof.owner.pid_started },
    timeout_sec: proof.timeout_sec, viewed_bytes: proof.viewed_bytes, viewed_sha256: proof.viewed_sha256,
    command_sha256: proof.command_sha256 });
}

function exitDecision(r: ExitData, next: (d: StateData) => Decision): Decision {
  const bad = (hint: string) => refuse('INVALID_PROOF', hint);
  for (const k of ['stdout', 'stderr'] as const) {
    if (!r[k] || typeof r[k].text !== 'string' || typeof r[k].truncated !== 'boolean') return bad(`${k} is malformed`);
    if (utf8(r[k].text) > OUTPUT_CAP_BYTES) return bad(`${k} exceeds ${OUTPUT_CAP_BYTES} bytes`);
  }
  const { exit_code: code, signal, failure } = r;
  let ok: boolean;
  if (code === 0) ok = signal === null && failure === null;
  else if (failure === 'spawn') ok = code === null && signal === null;
  else if (failure === 'timeout') ok = true;
  else if (code === null) ok = signal !== null && failure === null;
  else ok = signal === null && (failure === null || failure === 'exit');
  if (!ok) return bad('exit data is not a consistent exit tuple');
  return next({ status: code === 0 ? 'executed' : 'failed', method: 'executor', result: r });
}
