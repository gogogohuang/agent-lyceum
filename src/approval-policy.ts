import fs from 'node:fs';
import path from 'node:path';
import { ApprovalError } from './approval-error.js';
import { canonicalPath } from './paths.js';
import { approvalName, approvalSourceId, requestPaths, type SlotRef } from './approval-paths.js';
import type { ResolvedAgent, ResolvedProject } from './config.js';

/** The two calls the request scan needs; injectable so tests can fail any step without chmod. */
export interface DenyScanIo {
  readonly lstatSync: typeof fs.lstatSync;
  readonly opendirSync: (p: string) => { readSync(): fs.Dirent | null; closeSync(): void };
}
export const defaultDenyScanIo: DenyScanIo = fs;

/** `ready`: the complete list. `unavailable`: nothing partial is ever returned; `fixed` is only what needs no scan. */
export type DenyInventory =
  | { readonly ready: true; readonly paths: readonly string[] }
  | { readonly ready: false; readonly error: ApprovalError; readonly fixed: readonly string[] };

const errnoOf = (e: unknown): string => (e as NodeJS.ErrnoException | null)?.code ?? 'unknown';

/**
 * Each path as given, then (when different) its canonical form: a runtime that compares real paths (macOS /tmp is /private/tmp),
 * a symlinked home, or an executor command that is a symlink into a writable directory must not leave a rule unmatched.
 * Canonical forms also cover missing paths via their existing ancestors; the literal path is always retained.
 */
function withCanonical(paths: readonly string[]): string[] {
  const out: string[] = [];
  for (const p of paths) {
    out.push(p);
    out.push(canonicalPath(p));
  }
  return [...new Set(out)];
}

/** The approval store, the executors file, every executor command, the repo-level Claude settings (raw and canonical forms). */
function fixedDenies(project: ResolvedProject, agent: ResolvedAgent): string[] {
  const repoDirs = [project.dir, project.workspaces?.[agent.name]?.dir ?? project.dir];
  return withCanonical([
    path.join(project.home, 'approvals'),
    path.join(project.home, 'executors.yaml'),
    ...(agent.approval?.commands ?? []),
    ...repoDirs.flatMap((d) => ['settings.json', 'settings.local.json'].map((f) => path.join(d, '.claude', f))),
  ]);
}

/** The request slot of the wake being built: a bound run's slot, or the call. Unbound (tidy, direct) has none. */
function ownSlot(project: ResolvedProject, agent: ResolvedAgent): SlotRef | null {
  if (project.solo === 'call') return { kind: 'call', call_id: path.basename(project.paths.root) };
  if (project.run) return { kind: 'run', project: project.name, run_id: project.run.id, slot: agent.name };
  return null;
}

type Level = (name: string) => void;
const projectLevel: Level = (n) => approvalName('project', n);
const runLevel: Level = (n) => approvalSourceId(n);
const slotLevel: Level = (n) => approvalName('slot', n);

/**
 * Every slot root under `<home>/requests` except the caller's own, sorted. Bounded (`max` entries read in total), `lstat` per
 * level, fixed depth, never follows a link, never enters a slot. A missing `requests/` is empty. Anything else unexpected throws.
 */
function scanSlotRoots(home: string, max: number, io: DenyScanIo): string[] {
  const requests = path.join(home, 'requests');
  const roots: string[] = [];
  let seen = 0;
  const bad = (code: ApprovalError['code'], msg: string, p: string): never => { throw new ApprovalError(code, msg, p); };
  const list = (dir: string): string[] => {
    let handle: ReturnType<DenyScanIo['opendirSync']>;
    try { handle = io.opendirSync(dir); } catch (e) { return bad('IO_ERROR', `opendir failed (${errnoOf(e)}): ${dir}`, dir); }
    const names: string[] = [];
    let primary: unknown;
    let scanFailed = false;
    try {
      for (;;) {
        const ent = handle.readSync();
        if (ent === null) break;
        if (++seen > max) bad('INVALID_INPUT', `Approval request tree has more than ${max} entries: ${requests}`, requests);
        names.push(ent.name);
      }
    } catch (e) {
      scanFailed = true;
      primary = e;
    }
    // Always closed. A scan error that already happened wins; a close failure alone makes the inventory unavailable.
    let closeError: unknown;
    let closeFailed = false;
    try { handle.closeSync(); } catch (e) { closeFailed = true; closeError = e; }
    if (scanFailed) {
      if (primary instanceof ApprovalError) throw primary;
      bad('IO_ERROR', `readdir failed (${errnoOf(primary)}): ${dir}`, dir);
    }
    if (closeFailed) bad('IO_ERROR', `close failed (${errnoOf(closeError)}): ${dir}`, dir);
    return names.sort();
  };
  const realDir = (p: string): void => {
    let st: fs.Stats;
    try { st = io.lstatSync(p); } catch (e) { bad('IO_ERROR', `lstat failed (${errnoOf(e)}): ${p}`, p); return; }
    if (!st.isDirectory()) bad('UNSAFE_PATH', 'Approval request path is not a real directory (symlink or file)', p);
  };
  const descend = (dir: string, levels: Level[]): void => {
    const [check, ...rest] = levels;
    for (const name of list(dir)) {
      try { check!(name); } catch { bad('INVALID_INPUT', `Invalid name in approval request tree: ${dir}`, dir); }
      const child = path.join(dir, name);
      realDir(child);
      if (rest.length) descend(child, rest); else roots.push(child);
    }
  };
  try { io.lstatSync(requests); } catch (e) {
    if (errnoOf(e) === 'ENOENT') return [];
    bad('IO_ERROR', `lstat failed (${errnoOf(e)}): ${requests}`, requests);
  }
  realDir(requests);
  for (const name of list(requests)) {
    const child = path.join(requests, name);
    if (name === 'projects') { realDir(child); descend(child, [projectLevel, runLevel, slotLevel]); }
    else if (name === 'calls') { realDir(child); descend(child, [runLevel]); }
    else bad('INVALID_INPUT', `Unexpected entry in approval request tree: ${requests}`, requests);
  }
  return roots.sort();
}

/**
 * Inspection, never throws. Non-enrolled agents: `[]` with no I/O. Enrolled: the fixed denies plus every OTHER slot's request
 * root, item by item (never `requests/`, never the agent's own root). If the scan cannot be completed the result says so and
 * carries no slot list; adapters must then refuse (`approvalDenyPathsStrict`).
 */
export function approvalDenyInventory(project: ResolvedProject, agent: ResolvedAgent, io: DenyScanIo = defaultDenyScanIo): DenyInventory {
  if (!agent.enrolled) return { ready: true, paths: [] };
  const fixed = fixedDenies(project, agent);
  if (!agent.approval) {
    return { ready: false, fixed, error: new ApprovalError('INVALID_INPUT', `Approval-enrolled agent has no approval context: ${agent.name}`) };
  }
  try {
    const own = ownSlot(project, agent);
    const ownRoot = own ? requestPaths(project.home, own).root : null;
    const ownForms = ownRoot ? new Set([ownRoot, canonicalPath(ownRoot)]) : new Set<string>();
    const others = withCanonical(scanSlotRoots(project.home, agent.approval.maxScanEntries, io).filter((r) => r !== ownRoot))
      .filter((r) => !ownForms.has(r));
    return { ready: true, paths: [...new Set([...fixed, ...others])] };
  } catch (e) {
    const error = e instanceof ApprovalError ? e : new ApprovalError('IO_ERROR', `Approval request scan failed (${errnoOf(e)})`);
    return { ready: false, fixed, error };
  }
}

/** Never throws: the complete list when the scan worked, only the fixed denies when it did not. For `writePolicy`. */
export function approvalDenyPaths(project: ResolvedProject, agent: ResolvedAgent, io: DenyScanIo = defaultDenyScanIo): string[] {
  const inv = approvalDenyInventory(project, agent, io);
  return [...(inv.ready ? inv.paths : inv.fixed)];
}

/** For the invocation boundary: the complete list or a safe ApprovalError. Never a partial list. */
export function approvalDenyPathsStrict(project: ResolvedProject, agent: ResolvedAgent, io: DenyScanIo = defaultDenyScanIo): string[] {
  const inv = approvalDenyInventory(project, agent, io);
  if (!inv.ready) throw inv.error;
  return [...inv.paths];
}
