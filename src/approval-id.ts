import { createHash } from 'node:crypto';
import { ApprovalError } from './approval-error.js';
import { approvalName, approvalSourceId } from './approval-paths.js';
import type { ApprovalId, SourceKey } from './approval-types.js';

function invalid(field: string): never {
  throw new ApprovalError('INVALID_INPUT', `Invalid approval source ${field}`);
}

/** LP v1 primitive: decimal UTF8 byte length, colon, exact UTF8 bytes; no normalization. */
export function lp(value: string): Buffer {
  // In Unicode mode this range matches only unpaired surrogates, not valid pairs.
  if (typeof value !== 'string' || /[\uD800-\uDFFF]/u.test(value)) invalid('string');
  const bytes = Buffer.from(value, 'utf8');
  return Buffer.concat([Buffer.from(`${bytes.length}:`, 'ascii'), bytes]);
}

/** The one request-filename grammar: 1-64 chars of [A-Za-z0-9._-], no leading dot, `.req` suffix. */
export const REQUEST_FILENAME_RE = /^(?!\.)[A-Za-z0-9._-]{1,64}\.req$/;
export function isRequestFilename(value: unknown): value is string {
  return typeof value === 'string' && REQUEST_FILENAME_RE.test(value);
}

function hash(value: string): string {
  if (typeof value !== 'string' || value.length !== 64 || !/^[0-9a-f]{64}$/.test(value)) invalid('sha256');
  return value;
}

function integer(value: number, min: number, field: string): string {
  if (!Number.isSafeInteger(value) || value < min) invalid(field);
  return String(value);
}

/** Encode the approved v1 domain/variant tuple. Only source fields determine identity. */
export function encodeSourceKey(key: SourceKey): Buffer {
  if (key.kind !== 'run' && key.kind !== 'call') invalid('kind');
  approvalSourceId(key.source_id);
  approvalName('slot', key.slot);
  const tuple = ['agent-lyceum/approval-source/v1', key.variant, key.kind, key.source_id,
    key.slot, integer(key.seq, 1, 'seq')];
  if (key.variant !== 'denied_scan') {
    if (!isRequestFilename(key.filename)) invalid('filename');
    tuple.push(key.filename);
  }
  switch (key.variant) {
    case 'payload': tuple.push(hash(key.payload_sha256)); break;
    case 'denied_bytes':
      if (!['too_large', 'bad_content', 'bad_executor', 'bad_header', 'not_allowed', 'quota'].includes(key.reason)) invalid('reason');
      tuple.push(key.reason, hash(key.request_sha256)); break;
    case 'denied_entry':
      if (key.reason !== 'not_regular') invalid('reason');
      tuple.push(key.reason); break;
    case 'denied_size':
      if (key.reason !== 'too_large') invalid('reason');
      tuple.push(key.reason, integer(key.size, 0, 'size')); break;
    case 'denied_scan':
      if (key.reason !== 'scan_limit') invalid('reason');
      tuple.push(key.reason); break;
    default: invalid('variant');
  }
  return Buffer.concat(tuple.map(lp));
}

export function approvalId(key: SourceKey): ApprovalId {
  return createHash('sha256').update(encodeSourceKey(key)).digest('hex').slice(0, 24);
}
