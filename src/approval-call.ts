import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { collectSlot, type CollectDeps, type CollectResult } from './approval-collect.js';
import { ApprovalError } from './approval-error.js';
import { type ExecutorsConfig, loadFreshConfig } from './approval-runtime.js';
import { qualificationHash, type SnapshotInput } from './approval-origin.js';
import { publishExclusive, readApprovalFile } from './approval-io.js';
import { approvalName, approvalSourceId, requestPaths } from './approval-paths.js';
import { withSlotCoord } from './approval-rotation.js';
import { snapshotInputs } from './approval-snapshot.js';
import type { Origin, PremiseResult, WritableSet } from './approval-types.js';
import { callGateVerdict, type GateCode } from './approval-wake-gate.js';
import { callProject, resolveCallAgent } from './call.js';
import { ConfigError, type ResolvedAgent, type ResolvedProject } from './config.js';
import type { PremiseOptions } from './doctor-approval-premises.js';
import { canonicalPath, NAME_RE } from './paths.js';

/** One mebibyte, including the trailing LF. A larger marker is refused before any wake. */
const MARKER_LIMIT = 1024 * 1024;

const absPath = z.string().refine((s) => path.isAbsolute(s) && !s.includes('\0'), 'absolute path');
const markerSchema = z.strictObject({
  schema_version: z.literal(1),
  call_id: z.string(),
  role: z.string(),
  project_dir: absPath,
  successful_attempt: z.number().int().safe().positive(),
  full_writable: z.strictObject({ dirs: z.array(absPath), files: z.array(absPath) }),
  qualifications: z.record(z.string().regex(NAME_RE), z.string().regex(/^[0-9a-f]{64}$/))
    .refine((q) => Object.keys(q).length > 0, 'qualifications'),
});

/** Local v1 success marker for one enrolled call. It is not an approval-store schema. */
export interface CallApprovalOk {
  schema_version: 1;
  call_id: string;
  role: string;
  project_dir: string;
  successful_attempt: number;
  full_writable: { dirs: string[]; files: string[] };
  qualifications: Record<string, string>;
}

interface CallApprovalView {
  ok: true;
  project: ResolvedProject;
  agent: ResolvedAgent;
  config: ExecutorsConfig;
  inputs: Map<string, SnapshotInput>;
  origin: Origin;
  premises: readonly PremiseResult[];
  qualifications: Record<string, string>;
}

const bad = (code: GateCode): { ok: false; code: GateCode } => ({ ok: false, code });
const markerError = (why: string): never => { throw new ApprovalError('CORRUPT_RECORD', why); };

function ordered(ok: CallApprovalOk): CallApprovalOk {
  return {
    schema_version: 1,
    call_id: ok.call_id,
    role: ok.role,
    project_dir: ok.project_dir,
    successful_attempt: ok.successful_attempt,
    full_writable: { dirs: [...ok.full_writable.dirs], files: [...ok.full_writable.files] },
    qualifications: Object.fromEntries(Object.entries(ok.qualifications).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
  };
}

function parseMarker(bytes: Buffer): CallApprovalOk {
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { return markerError('Invalid approval call marker'); }
  if (text.endsWith('\n')) text = text.slice(0, -1);
  let raw: unknown;
  try { raw = JSON.parse(text); }
  catch { return markerError('Invalid approval call marker'); }
  const parsed = markerSchema.safeParse(raw);
  if (!parsed.success) return markerError('Invalid approval call marker');
  try {
    approvalSourceId(parsed.data.call_id);
    approvalName('role', parsed.data.role);
    for (const name of Object.keys(parsed.data.qualifications)) approvalName('executor', name);
  } catch { return markerError('Invalid approval call marker'); }
  return parsed.data;
}

function serialize(ok: CallApprovalOk): Buffer {
  const bytes = Buffer.from(`${JSON.stringify(ordered(ok))}\n`, 'utf8');
  if (bytes.length > MARKER_LIMIT) markerError('Approval call marker exceeds 1048576 bytes');
  parseMarker(bytes);
  return bytes;
}

function sameMarker(a: CallApprovalOk, b: CallApprovalOk): boolean {
  return JSON.stringify(ordered(a)) === JSON.stringify(ordered(b));
}

function sameQualifications(expected: Readonly<Record<string, string>>, got: Readonly<Record<string, string>>): boolean {
  const a = Object.keys(expected).sort();
  const b = Object.keys(got).sort();
  return a.length === b.length && a.every((key, i) => key === b[i] && expected[key] === got[key]);
}

/**
 * Fresh call project, gate and qualification snapshot. `expected` is the baseline recorded before the first candidate;
 * a different executor set or hash is refused. Does not create directories or take a lease.
 */
export function callApprovalView(o: {
  home: string; callId: string; role: string; projectDir: string; premise: PremiseOptions;
  expected?: Readonly<Record<string, string>>;
}): CallApprovalView | { ok: false; code: GateCode } {
  try { approvalSourceId(o.callId); approvalName('role', o.role); }
  catch { return bad('CONFIG_INVALID'); }
  let agent: ResolvedAgent;
  try { agent = resolveCallAgent(o.home, o.role); }
  catch (e) {
    if (e instanceof ConfigError && /is not an agent|no runtime|AGENT\.md of/.test(e.message)) return bad('AGENT_MISSING');
    return bad('CONFIG_INVALID');
  }
  if (!agent.enrolled) return bad('NOT_ALLOWED');
  const project = callProject(o.home, agent, o.projectDir, path.join(o.home, 'calls', o.callId));
  const gate = callGateVerdict({ home: o.home, agent, actual: project, userHome: os.homedir(), premise: o.premise });
  if (gate.kind !== 'wake') return bad(gate.code);
  const loaded = loadFreshConfig(o.home, { userHome: os.homedir() });
  if (!loaded.ok) return bad('CONFIG_INVALID');
  const proposals = canonicalPath(requestPaths(o.home, { kind: 'call', call_id: o.callId }).proposals);
  const snap = snapshotInputs(project, o.role, loaded.config, proposals);
  if (snap.inputs.size === 0) return bad('NOT_ALLOWED');
  const qualifications: Record<string, string> = {};
  for (const [name, input] of snap.inputs) qualifications[name] = qualificationHash(input);
  if (o.expected && !sameQualifications(o.expected, qualifications)) return bad('SNAPSHOT_MISMATCH');
  const full: WritableSet = { dirs: [...snap.full.dirs], files: [...snap.full.files] };
  try {
    serialize({
      schema_version: 1, call_id: o.callId, role: o.role, project_dir: canonicalPath(o.projectDir),
      successful_attempt: Number.MAX_SAFE_INTEGER, full_writable: { dirs: [...full.dirs], files: [...full.files] }, qualifications,
    });
  } catch { return bad('CONFIG_INVALID'); }
  const premises: readonly PremiseResult[] = [
    { check: 'project-premises', ok: true, code: 'ok' },
    { check: 'containment', ok: true, code: 'ok' },
  ];
  return {
    ok: true, project, agent, config: loaded.config, inputs: snap.inputs, premises, qualifications,
    origin: { kind: 'call', call_id: o.callId, role: o.role, project_dir: canonicalPath(o.projectDir), full_writable: full },
  };
}

/** `null` only when the marker is absent. Invalid bytes are rejected. */
export function readCallApprovalOk(home: string, callId: string): CallApprovalOk | null {
  approvalSourceId(callId);
  const file = requestPaths(home, { kind: 'call', call_id: callId }).ok;
  if (!file) return null;
  const bytes = readApprovalFile(file, MARKER_LIMIT, home);
  if (bytes === null) return null;
  return parseMarker(bytes);
}

/** Exclusive 0400 publication under the slot's short `.coord`. An identical marker is accepted; anything else fails closed. */
export function publishCallApprovalOk(home: string, ok: CallApprovalOk): void {
  const bytes = serialize(ok);
  const slot = { kind: 'call' as const, call_id: ok.call_id };
  const file = requestPaths(home, slot).ok;
  if (!file) markerError('Invalid approval call marker');
  withSlotCoord(home, slot, () => {
    if (publishExclusive(file, bytes, { root: home }) === 'exists') {
      const have = readCallApprovalOk(home, ok.call_id);
      if (!have || !sameMarker(have, ok)) markerError('Approval call marker does not match');
    }
  });
}

/**
 * Finish collection for a published marker. The caller already holds the call lease. A fresh view whose
 * qualifications differ, or a working directory that is no longer the recorded real directory, collects nothing.
 */
export function collectCallApproval(home: string, ok: CallApprovalOk, deps: {
  premise: PremiseOptions; collect: CollectDeps; log: CollectDeps['log'];
}): CollectResult {
  const skip = (code: GateCode): CollectResult => {
    try { deps.log('approval_collect', { slot: ok.role, op: 'pass', class: 'io' }); } catch { /* the caller still reports the code */ }
    return { created: 0, existing: 0, denied: 0, verdict: { kind: 'skipped', code } };
  };
  let st: fs.Stats;
  try { st = fs.lstatSync(ok.project_dir); }
  catch { return skip('PROJECT_PATH_MISMATCH'); }
  if (!st.isDirectory()) return skip('PROJECT_PATH_MISMATCH');
  const view = callApprovalView({
    home, callId: ok.call_id, role: ok.role, projectDir: ok.project_dir, premise: deps.premise, expected: ok.qualifications,
  });
  if (!view.ok) return skip(view.code);
  if (view.origin.project_dir !== ok.project_dir) return skip('PROJECT_PATH_MISMATCH');
  const origin: Origin = {
    kind: 'call', call_id: ok.call_id, role: ok.role, project_dir: ok.project_dir, full_writable: ok.full_writable,
  };
  return collectSlot({
    home, slot: { kind: 'call', call_id: ok.call_id }, agent: ok.role,
    runDir: path.join(home, 'calls', ok.call_id), config: view.config, origin, inputs: view.inputs, premises: view.premises,
  }, deps.collect);
}
