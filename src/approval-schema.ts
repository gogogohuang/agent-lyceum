import path from 'node:path';
import { ApprovalError } from './approval-error.js';
import type { ApprovalErrorCode } from './approval-error.js';
import { approvalId } from './approval-id.js';
import type { ApprovalRecord, ApprovalState, SourceKey } from './approval-types.js';
import { NAME_RE } from './paths.js';

type Obj = Record<string, unknown>;
type Fail = (field: string, why: string) => never;

/** Strict v1 hand validators for record.json and state/<n>.json. Pure: no I/O; the size cap belongs to the io layer. */
class Reader {
  readonly fail: Fail;
  constructor(readonly file: string, readonly code: ApprovalErrorCode) {
    this.fail = (field, why) => { throw new ApprovalError(code, `Invalid ${field}: ${why}`, file); };
  }
  obj(v: unknown, field: string, keys: readonly string[]): Obj {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) this.fail(field, 'expected an object');
    const o = v as Obj;
    for (const k of Object.keys(o)) if (!keys.includes(k)) this.fail(`${field}.${k}`, 'unknown key');
    for (const k of keys) if (!(k in o)) this.fail(`${field}.${k}`, 'missing key');
    return o;
  }
  str(v: unknown, field: string, re?: RegExp): string {
    if (typeof v !== 'string' || /[\uD800-\uDFFF]/u.test(v) || (re && !re.test(v))) this.fail(field, 'bad string');
    return v as string;
  }
  nstr(v: unknown, field: string): string | null { return v === null ? null : this.str(v, field); }
  int(v: unknown, field: string, min: number, max = Number.MAX_SAFE_INTEGER): number {
    if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < min || v > max) this.fail(field, 'bad integer');
    return v as number;
  }
  bool(v: unknown, field: string): boolean { if (typeof v !== 'boolean') this.fail(field, 'expected boolean'); return v as boolean; }
  oneOf<T extends string>(v: unknown, field: string, set: readonly T[]): T {
    if (!set.includes(v as T)) this.fail(field, 'unexpected value');
    return v as T;
  }
  name(v: unknown, field: string): string { return this.str(v, field, NAME_RE); }
  hash(v: unknown, field: string): string { return this.str(v, field, /^[0-9a-f]{64}$/); }
  abs(v: unknown, field: string): string {
    const s = this.str(v, field);
    if (!path.isAbsolute(s) || s.includes('\0')) this.fail(field, 'expected an absolute path');
    return s;
  }
  date(v: unknown, field: string): string {
    const s = this.str(v, field, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    const t = Date.parse(s);
    if (Number.isNaN(t) || new Date(t).toISOString() !== s) this.fail(field, 'not a canonical UTC date');
    return s;
  }
}

function version(v: unknown, file: string, code: ApprovalErrorCode): void {
  const sv = typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Obj).schema_version : undefined;
  if (sv === undefined) { if (typeof v === 'object' && v !== null && !Array.isArray(v)) new Reader(file, code).fail('schema_version', 'missing'); return; }
  if (sv !== 1) throw new ApprovalError('UNSUPPORTED_VERSION', `Unsupported schema_version ${JSON.stringify(sv)}`, file);
}

const DENIED = ['not_regular', 'too_large', 'bad_content', 'bad_executor', 'bad_header', 'not_allowed', 'quota', 'scan_limit'] as const;
const BYTES = ['too_large', 'bad_content', 'bad_executor', 'bad_header', 'not_allowed', 'quota'] as const;
const FILENAME = /^(?!\.)[A-Za-z0-9._-]{1,64}\.req$/;

function sourceKey(r: Reader, v: unknown, f: string): SourceKey {
  const variant = (v as Obj | null)?.variant;
  const base = ['kind', 'source_id', 'slot', 'seq', 'variant'];
  const shape: Record<string, readonly string[]> = {
    payload: [...base, 'filename', 'payload_sha256'], denied_bytes: [...base, 'filename', 'reason', 'request_sha256'],
    denied_entry: [...base, 'filename', 'reason'], denied_size: [...base, 'filename', 'reason', 'size'],
    denied_scan: [...base, 'reason'] };
  const o = r.obj(v, f, shape[r.oneOf(variant, `${f}.variant`, Object.keys(shape))] ?? []);
  r.oneOf(o.kind, `${f}.kind`, ['run', 'call']); r.str(o.source_id, `${f}.source_id`, /^[A-Za-z0-9][A-Za-z0-9_.-]*$/);
  r.name(o.slot, `${f}.slot`); r.int(o.seq, `${f}.seq`, 1);
  if ('filename' in o) r.str(o.filename, `${f}.filename`, FILENAME);
  if (variant === 'payload') r.hash(o.payload_sha256, `${f}.payload_sha256`);
  if (variant === 'denied_bytes') { r.oneOf(o.reason, `${f}.reason`, BYTES); r.hash(o.request_sha256, `${f}.request_sha256`); }
  if (variant === 'denied_entry') r.oneOf(o.reason, `${f}.reason`, ['not_regular']);
  if (variant === 'denied_size') { r.oneOf(o.reason, `${f}.reason`, ['too_large']); r.int(o.size, `${f}.size`, 0); }
  if (variant === 'denied_scan') r.oneOf(o.reason, `${f}.reason`, ['scan_limit']);
  return o as unknown as SourceKey;
}

function writable(r: Reader, v: unknown, f: string): void {
  const o = r.obj(v, f, ['dirs', 'files']);
  for (const k of ['dirs', 'files']) {
    if (!Array.isArray(o[k])) r.fail(`${f}.${k}`, 'expected an array');
    for (const [i, p] of (o[k] as unknown[]).entries()) r.abs(p, `${f}.${k}[${i}]`);
  }
}

function originOf(r: Reader, v: unknown, f: string): Obj {
  const run = (v as Obj | null)?.kind === 'run';
  const o = r.obj(v, f, run ? ['kind', 'project', 'run_id', 'project_dir', 'role', 'full_writable']
    : ['kind', 'call_id', 'project_dir', 'role', 'full_writable']);
  r.oneOf(o.kind, `${f}.kind`, ['run', 'call']);
  if (run) { r.name(o.project, `${f}.project`); r.str(o.run_id, `${f}.run_id`, /^[A-Za-z0-9][A-Za-z0-9_.-]*$/); }
  else r.str(o.call_id, `${f}.call_id`, /^[A-Za-z0-9][A-Za-z0-9_.-]*$/);
  r.abs(o.project_dir, `${f}.project_dir`); r.name(o.role, `${f}.role`); writable(r, o.full_writable, `${f}.full_writable`);
  return o;
}

function snapshot(r: Reader, v: unknown, f: string): void {
  const o = r.obj(v, f, ['schema_version', 'sha256', 'premises']);
  if (o.schema_version !== 1) r.fail(`${f}.schema_version`, 'expected 1');
  r.hash(o.sha256, `${f}.sha256`);
  if (!Array.isArray(o.premises)) r.fail(`${f}.premises`, 'expected an array');
  (o.premises as unknown[]).forEach((p, i) => {
    const q = r.obj(p, `${f}.premises[${i}]`, ['check', 'ok', 'code']);
    r.str(q.check, `${f}.premises[${i}].check`); r.bool(q.ok, `${f}.premises[${i}].ok`); r.str(q.code, `${f}.premises[${i}].code`);
  });
}

export function parseApprovalRecord(value: unknown, file: string): ApprovalRecord {
  version(value, file, 'CORRUPT_RECORD');
  const r = new Reader(file, 'CORRUPT_RECORD');
  const pending = (value as Obj | null)?.disposition === 'pending';
  const common = ['schema_version', 'id', 'source_key', 'origin', 'proposer', 'created_at', 'expires_at', 'executor',
    'summary', 'payload_sha256', 'payload_bytes', 'qualification', 'disposition'];
  const o = r.obj(value, 'record', pending ? common : [...common, 'reason', 'ignored_count']);
  r.oneOf(o.disposition, 'disposition', ['pending', 'denied']);
  r.str(o.id, 'id', /^[0-9a-f]{24}$/);
  const key = sourceKey(r, o.source_key, 'source_key');
  const origin = originOf(r, o.origin, 'origin');
  const pr = r.obj(o.proposer, 'proposer', ['role', 'slot']);
  r.name(pr.role, 'proposer.role'); r.name(pr.slot, 'proposer.slot');
  const created = r.date(o.created_at, 'created_at');
  if (r.date(o.expires_at, 'expires_at') < created) r.fail('expires_at', 'earlier than created_at');
  if (origin.kind !== key.kind || (origin.run_id ?? origin.call_id) !== key.source_id) r.fail('origin', 'does not match source_key');
  if (pr.slot !== key.slot || pr.role !== origin.role) r.fail('proposer', 'does not match source_key/origin');
  try { if (approvalId(key) !== o.id) r.fail('id', 'does not match source_key'); }
  catch (e) { if (e instanceof ApprovalError && e.code === 'INVALID_INPUT') r.fail('source_key', 'rejected by id encoder'); throw e; }
  const present = (x: unknown, f: string, check: (v: unknown, f: string) => unknown) => { if (x !== null) check(x, f); };
  r.nstr(o.summary, 'summary');
  present(o.executor, 'executor', (v, f) => r.name(v, f));
  present(o.payload_sha256, 'payload_sha256', (v, f) => r.hash(v, f));
  present(o.payload_bytes, 'payload_bytes', (v, f) => r.int(v, f, 0, 65536));
  present(o.qualification, 'qualification', (v, f) => snapshot(r, v, f));
  if (pending) {
    if (key.variant !== 'payload') return r.fail('source_key.variant', 'pending requires payload');
    for (const k of ['executor', 'payload_sha256', 'payload_bytes', 'qualification']) if (o[k] === null) r.fail(k, 'required when pending');
    if (o.payload_sha256 !== key.payload_sha256) r.fail('payload_sha256', 'does not match source_key');
  } else {
    r.oneOf(o.reason, 'reason', DENIED);
    if (key.variant === 'payload') return r.fail('source_key.variant', 'denied record needs a denied variant');
    if (o.reason !== key.reason) r.fail('reason', 'does not match source_key');
    if (o.reason === 'scan_limit') r.int(o.ignored_count, 'ignored_count', 1);
    else if (o.ignored_count !== null) r.fail('ignored_count', 'only allowed for scan_limit');
  }
  return value as ApprovalRecord;
}

export function parseApprovalState(value: unknown, file: string): ApprovalState {
  version(value, file, 'CORRUPT_STATE');
  const r = new Reader(file, 'CORRUPT_STATE');
  const status = (value as Obj | null)?.status;
  const method = (value as Obj | null)?.method;
  const extra: Record<string, readonly string[]> = {
    executing: ['owner', 'timeout_sec', 'viewed_bytes', 'viewed_sha256', 'command_sha256'],
    'executed:executor': ['method', 'result'], 'failed:executor': ['method', 'result'],
    'executed:manual': ['method', 'conclusion'], 'failed:manual': ['method', 'conclusion'],
    unknown: ['reason', 'detail'], rejected: ['reason'], expired: [], tampered: ['observed_sha256'] };
  r.oneOf(status, 'status', ['executing', 'executed', 'failed', 'unknown', 'rejected', 'expired', 'tampered']);
  const kind = status === 'executed' || status === 'failed' ? `${status}:${String(method)}` : String(status);
  if (!extra[kind]) r.fail('method', 'unexpected value');
  const o = r.obj(value, 'state', ['schema_version', 'n', 'previous', 'updated_at', 'actor', 'status', ...(extra[kind] ?? [])]);
  const n = r.int(o.n, 'n', 1);
  if (r.int(o.previous, 'previous', 0) !== n - 1) r.fail('previous', 'must equal n-1');
  r.date(o.updated_at, 'updated_at');
  const a = r.obj(o.actor, 'actor', ['user', 'tty', 'pid', 'pid_started']);
  r.str(a.user, 'actor.user', /.+/s); r.nstr(a.tty, 'actor.tty'); r.int(a.pid, 'actor.pid', 1); r.nstr(a.pid_started, 'actor.pid_started');
  if (status === 'executing') {
    const w = r.obj(o.owner, 'owner', ['pid', 'pid_started']);
    r.int(w.pid, 'owner.pid', 1); r.str(w.pid_started, 'owner.pid_started', /.+/s);
    r.int(o.timeout_sec, 'timeout_sec', 1); r.int(o.viewed_bytes, 'viewed_bytes', 0);
    r.hash(o.viewed_sha256, 'viewed_sha256'); r.hash(o.command_sha256, 'command_sha256');
  } else if (method === 'executor') {
    const x = r.obj(o.result, 'result', ['exit_code', 'signal', 'failure', 'error_code', 'stdout', 'stderr']);
    if (x.exit_code !== null) r.int(x.exit_code, 'result.exit_code', -255, 255);
    r.nstr(x.signal, 'result.signal'); r.nstr(x.error_code, 'result.error_code');
    if (x.failure !== null) r.oneOf(x.failure, 'result.failure', ['exit', 'timeout', 'spawn']);
    for (const k of ['stdout', 'stderr']) {
      const s = r.obj(x[k], `result.${k}`, ['text', 'truncated']); r.str(s.text, `result.${k}.text`); r.bool(s.truncated, `result.${k}.truncated`);
    }
  } else if (method === 'manual') r.str(o.conclusion, 'conclusion');
  else if (status === 'unknown') { r.oneOf(o.reason, 'reason', ['creator_dead', 'interrupted']); r.str(o.detail, 'detail'); }
  else if (status === 'rejected') r.nstr(o.reason, 'reason');
  else if (status === 'tampered') r.hash(o.observed_sha256, 'observed_sha256');
  return value as ApprovalState;
}
