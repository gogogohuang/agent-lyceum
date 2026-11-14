import { createHash } from 'node:crypto';
import path from 'node:path';
import { ApprovalError } from './approval-error.js';
import { approvalId, encodeSourceKey } from './approval-id.js';
import { defaultApprovalIo, publishExclusive, readApprovalFile } from './approval-io.js';
import type { ApprovalIo, FaultPoint } from './approval-io.js';
import { recordPaths, storePaths } from './approval-paths.js';
import { parseApprovalRecord } from './approval-schema.js';
import type { ApprovalId, ApprovalRecord } from './approval-types.js';

const META_LIMIT = 1024 * 1024;
const PAYLOAD_LIMIT = 65536;
const ID_RE = /^[0-9a-f]{24}$/;

export type StoreFaultPoint = FaultPoint | 'payload_committed' | 'record_committed';

export interface StoreDeps {
  readonly io?: ApprovalIo;
  readonly token?: () => string;
  /** A throw simulates a process crash at that point. */
  readonly fault?: (point: StoreFaultPoint) => void;
  readonly diagnostic?: (error: ApprovalError) => void;
}

const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

/** The committed record for `id`, or null when record.json does not exist (an incomplete entry). Home must be canonical. */
export function readRecord(home: string, id: ApprovalId, io: ApprovalIo = defaultApprovalIo): ApprovalRecord | null {
  const file = recordPaths(home, id).record;
  const buf = readApprovalFile(file, META_LIMIT, home, io);
  if (buf === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(buf.toString('utf8'));
  } catch (e) {
    throw new ApprovalError('CORRUPT_RECORD', 'record.json is not valid JSON', file, { cause: e });
  }
  const record = parseApprovalRecord(value, file);
  if (record.id !== id) throw new ApprovalError('CORRUPT_RECORD', 'record.json id does not match its directory', file);
  return record;
}

/** Ids whose record.json is committed. Incomplete entries (payload only) and non-id names are skipped. */
export function listCommittedIds(home: string, io: ApprovalIo = defaultApprovalIo): ApprovalId[] {
  const dir = storePaths(home).approvals;
  let names: string[];
  try {
    names = io.readdirSync(dir) as string[];
  } catch (e) {
    if ((e as NodeJS.ErrnoException | null)?.code === 'ENOENT') return [];
    throw new ApprovalError('IO_ERROR', `readdir failed: ${dir}`, dir, { cause: e });
  }
  return names.filter((n) => ID_RE.test(n)).sort().filter((id) => readRecord(home, id, io) !== null);
}

function checkInput(record: ApprovalRecord, payload: Buffer | null): ApprovalRecord {
  const parsed = parseApprovalRecord(JSON.parse(JSON.stringify(record)), 'record');
  if (payload === null) {
    if (parsed.disposition === 'pending') throw new ApprovalError('INVALID_INPUT', 'pending record needs its payload');
    if (parsed.payload_sha256 !== null || parsed.payload_bytes !== null) {
      throw new ApprovalError('INVALID_INPUT', 'record names a payload but none was given');
    }
    return parsed;
  }
  if (payload.length > PAYLOAD_LIMIT) throw new ApprovalError('INVALID_INPUT', `payload exceeds ${PAYLOAD_LIMIT} bytes`);
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(payload);
  } catch {
    throw new ApprovalError('INVALID_INPUT', 'payload is not valid UTF-8');
  }
  if (parsed.payload_sha256 !== sha256(payload) || parsed.payload_bytes !== payload.length) {
    throw new ApprovalError('INVALID_INPUT', 'payload hash or size does not match the record');
  }
  return parsed;
}

/** Only source, id and payload identity are compared; created_at, snapshot and disposition of the first commit win. */
function sameSource(a: ApprovalRecord, b: ApprovalRecord): boolean {
  return a.id === b.id && encodeSourceKey(a.source_key).equals(encodeSourceKey(b.source_key)) &&
    a.payload_sha256 === b.payload_sha256 && a.payload_bytes === b.payload_bytes;
}

function adopt(existing: ApprovalRecord, wanted: ApprovalRecord, file: string): { kind: 'existing'; record: ApprovalRecord } {
  if (!sameSource(existing, wanted)) {
    throw new ApprovalError('SOURCE_MISMATCH', 'An approval with this id exists for a different source or payload', file);
  }
  return { kind: 'existing', record: existing };
}

/**
 * Commit `record` (and its `payload`) exactly once. record.json is the commit point; a directory without
 * it is incomplete and is completed by re-entry. An existing valid record is returned untouched and the
 * replay writes nothing. Payload and record are written from the same buffer that was hashed.
 * `home` must be the canonical approval home; it is passed as the root of every read and write.
 */
export function publishRecord(home: string, record: ApprovalRecord, payload: Buffer | null,
  deps: StoreDeps = {}): { readonly kind: 'created' | 'existing'; readonly record: ApprovalRecord } {
  const io = deps.io ?? defaultApprovalIo;
  const wanted = checkInput(record, payload);
  const paths = recordPaths(home, wanted.id);
  if (approvalId(wanted.source_key) !== wanted.id) throw new ApprovalError('INVALID_INPUT', 'record id does not match source key');

  const first = readRecord(home, wanted.id, io);
  if (first) return adopt(first, wanted, paths.record);

  const publishDeps = { root: home, io, token: deps.token, diagnostic: deps.diagnostic,
    fault: (p: FaultPoint) => deps.fault?.(p) };
  if (payload === null) {
    if (readApprovalFile(paths.payload, PAYLOAD_LIMIT, home, io) !== null) {
      throw new ApprovalError('PAYLOAD_MISMATCH', 'A denied record must not sit beside an existing payload', paths.payload);
    }
  } else if (publishExclusive(paths.payload, payload, publishDeps) === 'exists') {
    const have = readApprovalFile(paths.payload, PAYLOAD_LIMIT, home, io);
    if (have === null || !have.equals(payload)) {
      throw new ApprovalError('PAYLOAD_MISMATCH', 'An existing payload differs from the proposed bytes', paths.payload);
    }
  }
  deps.fault?.('payload_committed');

  const bytes = Buffer.from(`${JSON.stringify(wanted, null, 2)}\n`, 'utf8');
  if (publishExclusive(paths.record, bytes, publishDeps) === 'created') {
    deps.fault?.('record_committed');
    return { kind: 'created', record: wanted };
  }
  const winner = readRecord(home, wanted.id, io);
  if (!winner) throw new ApprovalError('IO_ERROR', 'record.json vanished after EEXIST', path.normalize(paths.record));
  return adopt(winner, wanted, paths.record);
}
