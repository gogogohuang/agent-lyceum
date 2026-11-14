import path from 'node:path';
import { ApprovalError } from './approval-error.js';
import type { ApprovalId } from './approval-types.js';
import { assertName } from './paths.js';

export type SlotRef = { readonly kind: 'run'; readonly project: string; readonly run_id: string;
  readonly slot: string } | { readonly kind: 'call'; readonly call_id: string };
export interface StorePaths {
  readonly approvals: string; readonly requests: string; readonly executors: string;
  readonly trash: string; readonly feedback: string; readonly denied_count: string;
}
export interface RequestPaths {
  readonly root: string; readonly proposals: string; readonly collected: string;
  readonly parked: string; readonly high_water: string; readonly ok: string | null;
}
export interface RecordPaths {
  readonly root: string; readonly record: string; readonly payload: string;
  readonly state: string; readonly work: string;
}

/** Pure lexical validation. Canonicalization and ancestor safety belong to the caller. */
function checkHome(home: string): void {
  if (!path.isAbsolute(home) || /[\0\uD800-\uDFFF]/u.test(home) ||
      home.split(path.sep).some((part) => part === '.' || part === '..')) {
    throw new ApprovalError('UNSAFE_PATH', 'Approval home must be an absolute canonical path', home);
  }
}

/** Validate names using the same grammar as existing project and role names. */
export function approvalName(kind: string, value: string): void {
  try { assertName(kind, value); }
  catch { throw new ApprovalError('INVALID_INPUT', `Invalid approval ${kind}`); }
}

/** Run/call IDs may contain dots, but never path separators or dot segments. */
export function approvalSourceId(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value) || /\n/.test(value)) {
    throw new ApprovalError('INVALID_INPUT', 'Invalid approval run/call id');
  }
}

/** Pure paths; home is absolute and canonical, supplied by the boundary. No I/O. */
export function storePaths(home: string): StorePaths {
  checkHome(home);
  const approvals = path.join(home, 'approvals');
  return { approvals, requests: path.join(home, 'requests'), executors: path.join(home, 'executors.yaml'),
    trash: path.join(approvals, '.trash'), feedback: path.join(approvals, '.feedback'),
    denied_count: path.join(approvals, '.denied-count') };
}

/** Call roots intentionally have no slot segment. No directories are created. */
export function requestPaths(home: string, slot: SlotRef): RequestPaths {
  const { requests } = storePaths(home);
  let root: string;
  if (slot.kind === 'run') {
    approvalName('project', slot.project); approvalName('slot', slot.slot); approvalSourceId(slot.run_id);
    root = path.join(requests, 'projects', slot.project, slot.run_id, slot.slot);
  } else if (slot.kind === 'call') {
    approvalSourceId(slot.call_id);
    root = path.join(requests, 'calls', slot.call_id);
  } else { throw new ApprovalError('INVALID_INPUT', 'Invalid approval slot kind'); }
  return { root, proposals: path.join(root, 'proposals'), collected: path.join(root, 'collected'),
    parked: path.join(root, 'parked'), high_water: path.join(root, 'collected.seq'),
    ok: slot.kind === 'call' ? path.join(root, 'ok.json') : null };
}

export function recordPaths(home: string, id: ApprovalId): RecordPaths {
  const { approvals } = storePaths(home);
  if (!/^[0-9a-f]{24}$/.test(id) || id.length !== 24) {
    throw new ApprovalError('INVALID_INPUT', 'Invalid approval id');
  }
  const root = path.join(approvals, id);
  return { root, record: path.join(root, 'record.json'), payload: path.join(root, 'payload'),
    state: path.join(root, 'state'), work: path.join(root, 'work') };
}
