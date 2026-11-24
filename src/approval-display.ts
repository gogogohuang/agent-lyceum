import { ApprovalError } from './approval-error.js';
import type { Liveness } from './approval-liveness.js';
import { parseApprovalRecord, parseApprovalState } from './approval-schema.js';
import type { Current, IsoTime, Status } from './approval-types.js';

export interface Display {
  readonly persisted: Status;
  readonly computed: Status;
  readonly unrecorded: boolean;
  /** Persisted sequence, including for an unwritten expired/unknown display. */
  readonly n: number;
  /** Persisted state time, or record creation time at sequence zero. */
  readonly updated_at: IsoTime;
}

/** Pure display only: never probes a PID or writes a transition. Supply fresh creator evidence for executing. */
export function computeDisplay(current: Current, nowMs: number, creator: Liveness | null): Display {
  if (!Number.isFinite(nowMs)) throw new ApprovalError('INVALID_INPUT', 'computeDisplay: invalid nowMs');
  const record = parseApprovalRecord(current.record, 'record');
  const state = current.state === null ? null : parseApprovalState(current.state, 'state');
  if (current.n !== (state?.n ?? 0) || (record.disposition === 'denied' && state !== null)) {
    throw new ApprovalError('CORRUPT_STATE', 'computeDisplay: inconsistent current sequence/disposition');
  }
  const n = current.n;
  const updated_at = state?.updated_at ?? record.created_at;
  const persisted = state?.status ?? record.disposition;
  let computed = persisted;
  if (persisted === 'pending' && nowMs > Date.parse(record.expires_at)) computed = 'expired';
  if (persisted === 'executing') {
    if (creator === null || creator === undefined) {
      throw new ApprovalError('INVALID_INPUT', 'computeDisplay: executing requires creator liveness evidence');
    }
    if (!creator.alive) computed = 'unknown';
  }
  return { persisted, computed, unrecorded: persisted !== computed, n, updated_at };
}
