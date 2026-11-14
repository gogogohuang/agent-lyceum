import { createHash } from 'node:crypto';
import path from 'node:path';
import { ApprovalError } from './approval-error.js';
import type { ApprovalQualification, ExecutorConfig } from './approval-executors.js';
import { lp } from './approval-id.js';
import type { ApprovalRecord, Origin, PremiseResult, Sha256, WritableSet } from './approval-types.js';

/** Static grants: caller supplies the FULL effective set plus run-only entries and explicit static duplicates (canonical paths). */
export interface GrantInput { readonly effective: WritableSet; readonly run_only: WritableSet; readonly static_duplicates: WritableSet }
export interface CandidateSnapshot {
  readonly runtime: 'claude-code' | 'codex';
  readonly sandbox: { readonly write: readonly string[]; readonly network: readonly string[];
    readonly local_binding: boolean; readonly unix_sockets: readonly string[] } | null;
  readonly allow_web: 'none' | 'search' | 'fetch' | null;
}
export interface SnapshotInput {
  readonly runtime_candidates: readonly CandidateSnapshot[];
  readonly writable: WritableSet; readonly project_dir: string; readonly executor: ExecutorConfig;
}
export interface OriginResolved {
  readonly qualification: ApprovalQualification; readonly snapshot_input: SnapshotInput; readonly premises: readonly PremiseResult[];
}
export type OriginErrorCode = 'PROJECT_MISSING' | 'PROJECT_PATH_MISMATCH' | 'AGENT_MISSING' | 'EXECUTOR_MISSING' |
  'NOT_ALLOWED' | 'PREMISE_FAILED' | 'SNAPSHOT_MISMATCH' | 'CONFIG_INVALID' | 'ORIGIN_UNREADABLE';
export type OriginResult = { readonly ok: true; readonly resolved: OriginResolved } |
  { readonly ok: false; readonly code: OriginErrorCode; readonly hint: string };
/** Injected boundary: looks up project/agent, canonicalizes, checks premises. It must not read the original run. */
export type OriginResolver = (origin: Origin, executor: string) => OriginResult;

const invalid = (why: string): never => { throw new ApprovalError('INVALID_INPUT', `Invalid approval origin input: ${why}`); };
const byBytes = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));
const sortedUnique = (xs: readonly string[]) => [...new Set(xs)].sort(byBytes);

function pathList(v: unknown, field: string): readonly string[] {
  if (!Array.isArray(v) || v.some((p) => typeof p !== 'string' || !path.isAbsolute(p) || p.includes('\0'))) invalid(`${field} must be absolute paths`);
  return v as string[];
}
function setOf(v: unknown, field: string): { dirs: readonly string[]; files: readonly string[] } {
  if (typeof v !== 'object' || v === null) return invalid(`${field} missing`);
  const o = v as Record<string, unknown>;
  return { dirs: pathList(o.dirs, `${field}.dirs`), files: pathList(o.files, `${field}.files`) };
}

/** Exactly (effective - run_only) + static_duplicates per kind, sorted unique. No ancestor subtraction, no file reads. */
export function staticWritable(input: GrantInput): WritableSet {
  const eff = setOf(input?.effective, 'effective');
  const run = setOf(input?.run_only, 'run_only');
  const dup = setOf(input?.static_duplicates, 'static_duplicates');
  const part = (k: 'dirs' | 'files') => {
    const have = new Set(eff[k]);
    if (dup[k].some((p) => !have.has(p))) invalid(`static_duplicates.${k} must be a subset of effective`);
    const drop = new Set(run[k]);
    return sortedUnique([...eff[k].filter((p) => !drop.has(p)), ...dup[k]]);
  };
  return { dirs: part('dirs'), files: part('files') };
}

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
function canonical(v: unknown): string {
  if (v === null || typeof v === 'boolean') return JSON.stringify(v);
  if (typeof v === 'number') return Number.isFinite(v) ? JSON.stringify(v) : invalid('non-finite number');
  if (typeof v === 'string') return /[\uD800-\uDFFF]/u.test(v) ? invalid('lone surrogate') : JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort(byBytes).map((k) => `${canonical(k)}:${canonical(o[k])}`).join(',')}}`;
  }
  return invalid('unsupported value');
}

function normalize(input: SnapshotInput): Json {
  const e = input.executor;
  if (!Array.isArray(input.runtime_candidates)) invalid('runtime_candidates missing');
  if (typeof input.project_dir !== 'string' || !path.isAbsolute(input.project_dir)) invalid('project_dir must be absolute');
  const w = setOf(input.writable, 'writable');
  const allow = (e.allow as readonly object[]).map((a) => canonical(a)).sort(byBytes);
  return {
    runtime_candidates: input.runtime_candidates.map((c) => ({ runtime: c.runtime, allow_web: c.allow_web,
      sandbox: c.sandbox === null ? null : { write: sortedUnique(pathList(c.sandbox.write, 'sandbox.write')),
        network: sortedUnique(c.sandbox.network), local_binding: c.sandbox.local_binding,
        unix_sockets: sortedUnique(pathList(c.sandbox.unix_sockets, 'sandbox.unix_sockets')) } })),
    writable: { dirs: sortedUnique(w.dirs), files: sortedUnique(w.files) }, project_dir: input.project_dir,
    executor: { command: [...e.command], allow, timeout_sec: e.timeout_sec, env: { ...e.env }, expires_days: e.expires_days,
      max_pending: e.max_pending, max_payload_bytes: e.max_payload_bytes },
  };
}

/** sha256 over LP(domain) + LP(canonical JSON). Model/tier/session/run ids/binary hash are not part of the input type. */
export function qualificationHash(input: SnapshotInput): Sha256 {
  const body = canonical(normalize(input));
  return createHash('sha256').update(Buffer.concat([lp('agent-lyceum/approval-qualification/v1'), lp(body)])).digest('hex');
}

const RECOVER = 'Fix the project/agent/executor configuration and approve again, or reject this request; to redo it, propose it again.';
const bad = (code: OriginErrorCode, hint: string): OriginResult => ({ ok: false, code, hint: `${hint} ${RECOVER}` });

export function resolveOrigin(origin: Origin, executor: string, resolver: OriginResolver): OriginResult {
  let r: OriginResult;
  try { r = resolver(origin, executor); }
  catch { return bad('ORIGIN_UNREADABLE', 'The origin could not be resolved (the resolver threw).'); }
  try {
    if (typeof r !== 'object' || r === null) return bad('CONFIG_INVALID', 'The resolver returned no result.');
    if (!r.ok) return r;
    const { qualification: q, snapshot_input: s, premises } = r.resolved ?? ({} as OriginResolved);
    if (!q || !s || !Array.isArray(premises) || !Array.isArray(q.executors)) return bad('CONFIG_INVALID', 'The resolver returned malformed data.');
    if (s.project_dir !== origin.project_dir) return bad('PROJECT_PATH_MISMATCH', `Project directory is now ${JSON.stringify(s.project_dir)}, not the recorded one.`);
    if (!q.enrolled || !q.executors.includes(executor)) return bad('NOT_ALLOWED', `Role ${origin.role} is not allowed to use executor ${executor}.`);
    const failed = premises.filter((p) => !p.ok).map((p) => p.check);
    if (failed.length > 0) return bad('PREMISE_FAILED', `Premise checks failed: ${failed.join(', ')}.`);
    return r;
  } catch { return bad('CONFIG_INVALID', 'The resolver returned malformed data.'); }
}

export function revalidateOrigin(record: ApprovalRecord, resolver: OriginResolver): OriginResult {
  if (record.disposition !== 'pending') return bad('NOT_ALLOWED', 'A denied request cannot be approved.');
  const r = resolveOrigin(record.origin, record.executor, resolver);
  if (!r.ok) return r;
  let hash: string;
  try { hash = qualificationHash(r.resolved.snapshot_input); }
  catch { return bad('CONFIG_INVALID', 'The effective configuration could not be hashed.'); }
  return hash === record.qualification.sha256 ? r
    : bad('SNAPSHOT_MISMATCH', 'The effective configuration changed since the request was made.');
}
