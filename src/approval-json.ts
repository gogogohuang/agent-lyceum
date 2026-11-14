import { z } from 'zod';
import type { Display } from './approval-display.js';
import { ApprovalError } from './approval-error.js';
import type { ApprovalErrorCode } from './approval-error.js';
import type { ApprovalId, DeniedReason, IsoTime, Origin, Proposer, Sha256 } from './approval-types.js';
import { NAME_RE } from './paths.js';

/** Version 1 list metadata only. Never pass persisted records or executor results as list items. */
export interface ApprovalListItemV1 {
  readonly id: ApprovalId;
  readonly origin: Origin;
  readonly proposer: Proposer;
  readonly executor: string | null;
  readonly created_at: IsoTime;
  readonly expires_at: IsoTime;
  readonly display: Display;
  readonly reason: DeniedReason | null;
  readonly payload_sha256: Sha256 | null;
  readonly payload_bytes: number | null;
}

/** No raw exception message: it could contain payload, environment or executor output. */
export interface ApprovalListProblem {
  readonly id: string;
  readonly path: string;
  readonly code: ApprovalErrorCode;
  readonly hint: string;
}
export interface ApprovalListV1 {
  readonly schema_version: 1;
  readonly requests: readonly ApprovalListItemV1[];
  readonly problems: readonly ApprovalListProblem[];
}
export type ApprovalListJson = ApprovalListV1;
export type ApprovalListItem = ApprovalListItemV1;

const text = z.string().refine((s) => !/[\uD800-\uDFFF]/u.test(s));
const name = text.regex(NAME_RE);
const id = text.regex(/^[0-9a-f]{24}$/);
const hash = text.regex(/^[0-9a-f]{64}$/);
const int = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const time = text.regex(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/)
  .refine((s) => Number.isFinite(Date.parse(s)) && new Date(s).toISOString() === s);
const abs = text.refine((s) => s.startsWith('/') && !s.includes('\0'));
const writable = z.object({ dirs: z.array(abs), files: z.array(abs) }).strict();
const sourceId = text.regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/);
const origin = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('run'), project: name, run_id: sourceId, project_dir: abs, role: name, full_writable: writable }).strict(),
  z.object({ kind: z.literal('call'), call_id: sourceId, project_dir: abs, role: name, full_writable: writable }).strict(),
]);
const status = z.enum(['pending', 'denied', 'executing', 'unknown', 'executed', 'failed', 'rejected', 'expired', 'tampered']);
const display = z.object({ persisted: status, computed: status, unrecorded: z.boolean(),
  n: int, updated_at: time }).strict().refine((v) => v.unrecorded === (v.persisted !== v.computed) &&
    (v.persisted === v.computed || (v.persisted === 'pending' && v.computed === 'expired') ||
      (v.persisted === 'executing' && v.computed === 'unknown')));
const reason = z.enum(['not_regular', 'too_large', 'bad_content', 'bad_executor', 'bad_header', 'not_allowed', 'quota', 'scan_limit']);
const item = z.object({ id, origin, proposer: z.object({ role: name, slot: name }).strict(), executor: name.nullable(),
  created_at: time, expires_at: time, display, reason: reason.nullable(), payload_sha256: hash.nullable(), payload_bytes: int.max(65536).nullable() }).strict()
  .refine((v) => v.expires_at >= v.created_at && v.proposer.role === v.origin.role)
  .refine((v) => (v.payload_sha256 === null) === (v.payload_bytes === null))
  .refine((v) => (v.display.persisted === 'denied') === (v.reason !== null))
  .refine((v) => v.display.persisted === 'denied' ||
    (v.executor !== null && v.payload_sha256 !== null && v.payload_bytes !== null))
  .refine((v) => (v.display.n === 0) === ['pending', 'denied'].includes(v.display.persisted))
  .refine((v) => v.display.n !== 0 || v.display.updated_at === v.created_at);
const problem = z.object({ id: text, path: text, code: z.enum([
  'UNSUPPORTED_PLATFORM', 'UNSUPPORTED_LINK', 'UNSUPPORTED_VERSION', 'UNSAFE_PATH', 'IO_ERROR',
  'CORRUPT_RECORD', 'CORRUPT_STATE', 'CORRUPT_HIGH_WATER', 'PAYLOAD_MISMATCH', 'SOURCE_MISMATCH',
  'SEQUENCE_OVERFLOW', 'INVALID_INPUT',
]), hint: text }).strict();
const envelope = z.object({ schema_version: z.literal(1), requests: z.array(z.unknown()), problems: z.array(problem) }).strict();
const compare = (a: string, b: string): number => a === b ? 0 : a < b ? -1 : 1;

/**
 * Validate the v1 envelope, isolate corrupt request items as problems, sort copies and serialize with LF.
 * Invalid envelope/problem metadata throws INVALID_INPUT (unknown versions UNSUPPORTED_VERSION).
 * Invalid request entries are never emitted, and their raw values/messages are never copied into problems.
 */
export function serializeApprovalList(value: unknown): string {
  if (typeof value === 'object' && value !== null && 'schema_version' in value && value.schema_version !== 1) {
    throw new ApprovalError('UNSUPPORTED_VERSION', 'Unsupported approvals list schema_version');
  }
  const parsed = envelope.safeParse(value);
  if (!parsed.success) throw new ApprovalError('INVALID_INPUT', 'Invalid approvals list envelope/problems');
  const requests: ApprovalListItemV1[] = [];
  const problems: ApprovalListProblem[] = [...parsed.data.problems];
  for (const [index, raw] of parsed.data.requests.entries()) {
    const result = item.safeParse(raw);
    if (result.success) requests.push(result.data);
    else {
      const candidateId = typeof raw === 'object' && raw !== null && 'id' in raw ? id.safeParse(raw.id) : null;
      problems.push({ id: candidateId?.success ? candidateId.data : '<unknown>', path: `requests[${index}]`, code: 'CORRUPT_RECORD', hint: 'Invalid approval list item' });
    }
  }
  requests.sort((a, b) => compare(a.id, b.id));
  problems.sort((a, b) => compare(a.id, b.id) || compare(a.path, b.path) || compare(a.code, b.code));
  return `${JSON.stringify({ schema_version: 1, requests, problems })}\n`;
}
