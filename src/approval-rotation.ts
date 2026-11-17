import path from 'node:path';
import { type BudgetedDirIo, type DirIo, defaultDirIo } from './approval-budget.js';
import { ApprovalError } from './approval-error.js';
import { advanceHighWater, maxCollectedSequence, readHighWater } from './approval-high-water.js';
import { type SlotRef, approvalSourceId, requestPaths } from './approval-paths.js';
import type { Sequence } from './approval-types.js';

/** Destination below the canonical slot root; never an arbitrary caller-supplied path. */
export type RotationDestination =
  | { readonly kind: 'collected'; readonly seq: Sequence }
  | { readonly kind: 'parked'; readonly attempt_id: string };

/** Describes a completed rename/recreation, or a missing proposals directory recreated without rotation. */
export type RotationResult =
  | { readonly kind: 'rotated'; readonly destination: string; readonly proposals: string }
  | { readonly kind: 'empty'; readonly proposals: string };

/**
 * Caller holds exclusive canonical-slot coordination (`withSlotCoord`, shared with requests gc) from
 * sequence selection through rename, recreation and high-water advance (including orphan/call slots).
 * lstat slot/proposals, reject symlinks/non-directories; missing proposals is rebuilt, not an error.
 * Rename the whole proposals directory to dest, recreate proposals (0700), and lstat it again.
 * Unsafe/I/O failures throw ApprovalError: the caller suspends this slot's collection AND wake, reports
 * its reason, and leaves other slots running.
 * An EMPTY proposals directory is never renamed (re-entry after a crash between rename and the caller's
 * bookkeeping is idempotent and never meets ENOTEMPTY). A corrupt high-water fails closed even then.
 * For `collected`, the persisted high-water is advanced after the recreation, never lowered. Rotation
 * never allocates the sequence (the caller picks `nextCollectedSequence`), never writes `.done`, never parses requests.
 */
export type Rotate = (home: string, slot: SlotRef, dest: RotationDestination) => RotationResult;

/** Parked output is never collected or used as redoContext drafts. */
export type ParkResult = RotationResult;

/**
 * Failure/cancellation/recovery hook: takes the slot coordination itself, then rotate(slot, parked/<attempt-id>).
 * Recovery parks started attempts and newly abandoned claimed/output_ready attempts BEFORE saving abandoned;
 * do not re-park every historical abandoned claim on each resume. Call fallback attempts use their attempt number.
 */
export type Park = (home: string, slot: SlotRef, attemptId: string) => ParkResult;

/**
 * Future recoverRunMail hook: return the canonical proposals path for an enrolled slot, or undefined when absent
 * (including tidy/verify/format policy wakes). Resolve from trusted request layout, never agent output.
 * Only a type contract: no recovery/wake integration is implemented.
 */
export type ProposalsOf = (agent: string) => string | undefined;

export interface RotationDeps {
  readonly io?: DirIo;
  /** Called at named points (`rotation:renamed`, `rotation:recreated`); a throw simulates a crash there. */
  readonly fault?: (point: string) => void;
}

/** The slot's `.coord` directory exists: another run/gc holds the slot, or a crash left it. Never stolen. */
export class CoordHeldError extends ApprovalError {
  constructor() {
    super('IO_ERROR', 'Slot coordination is held (.coord exists); stop all runs and remove a stale .coord manually');
    this.name = 'CoordHeldError';
  }
}

const codeOf = (e: unknown): string | undefined => (e as NodeJS.ErrnoException | null)?.code;
const ioErr = (what: string, e: unknown): ApprovalError =>
  new ApprovalError('IO_ERROR', `Rotation ${what} failed (${codeOf(e) ?? 'unknown'})`, null, { cause: e });
const unsafe = (what: string): ApprovalError => new ApprovalError('UNSAFE_PATH', `${what} is not a real directory`);

export function createRotation(deps: RotationDeps = {}): {
  rotate: Rotate; park: Park; withSlotCoord: <T>(home: string, slot: SlotRef, fn: () => T) => T;
} {
  const io = deps.io ?? defaultDirIo;
  const fault = deps.fault ?? ((): void => undefined);

  /** true = real directory, false = missing; a symlink/file/FIFO/other is UNSAFE_PATH. lstat only: never follows, never opens. */
  const realDir = (dir: string, what: string): boolean => {
    try {
      if (!io.lstatSync(dir).isDirectory()) throw unsafe(what);
      return true;
    } catch (e) {
      if (e instanceof ApprovalError) throw e;
      if (codeOf(e) === 'ENOENT') return false;
      throw ioErr(`lstat ${what}`, e);
    }
  };
  const ensureDir = (dir: string, what: string): void => {
    if (realDir(dir, what)) return;
    try { io.mkdirSync(dir, { mode: 0o700 }); } catch (e) { if (codeOf(e) !== 'EEXIST') throw ioErr(`mkdir ${what}`, e); }
    if (!realDir(dir, what)) throw ioErr(`mkdir ${what}`, undefined);
  };
  /** Home must exist as a real directory; every component down to the slot root is lstat-checked, missing ones made 0700. */
  const ensureSlotRoot = (home: string, root: string): void => {
    if (!realDir(home, 'approval home')) throw new ApprovalError('IO_ERROR', 'Approval home does not exist');
    const rel = path.relative(home, root);
    let cur = home;
    for (const part of rel.split(path.sep)) {
      cur = path.join(cur, part);
      ensureDir(cur, 'slot path');
    }
  };
  const isEmpty = (dir: string): boolean => {
    let d: ReturnType<DirIo['opendirSync']>;
    try { d = io.opendirSync(dir); } catch (e) { throw ioErr('open proposals', e); }
    try { return d.readSync() === null; } catch (e) { throw ioErr('read proposals', e); } finally { d.closeSync(); }
  };

  const rotate: Rotate = (home, slot, dest) => {
    const p = requestPaths(home, slot);
    if (dest.kind === 'collected') {
      if (!Number.isSafeInteger(dest.seq) || dest.seq < 1) throw new ApprovalError('INVALID_INPUT', 'Invalid collected sequence');
    } else {
      approvalSourceId(dest.attempt_id);
    }
    ensureSlotRoot(home, p.root);
    readHighWater(p.root, home, io); // corrupt = fail closed, even when there is nothing to move

    /** Nothing to move: rebuild a missing proposals, and let a finished rotation's high-water catch up. */
    const nothing = (): RotationResult => {
      ensureDir(p.proposals, 'proposals');
      if (dest.kind === 'collected' && realDir(p.collected, 'collected') && realDir(path.join(p.collected, String(dest.seq)), 'collected entry')) {
        advanceHighWater(p.root, dest.seq, { root: home, io });
      }
      return { kind: 'empty', proposals: p.proposals };
    };
    if (!realDir(p.proposals, 'proposals') || isEmpty(p.proposals)) return nothing();

    const parent = dest.kind === 'collected' ? p.collected : p.parked;
    ensureDir(parent, dest.kind);
    const destination = path.join(parent, dest.kind === 'collected' ? String(dest.seq) : dest.attempt_id);
    try {
      io.lstatSync(destination);
      throw unsafe('Rotation destination already exists; it');
    } catch (e) {
      if (e instanceof ApprovalError) throw e;
      if (codeOf(e) !== 'ENOENT') throw ioErr('lstat destination', e);
    }
    if (dest.kind === 'collected' && dest.seq <= maxCollectedSequence(p.root, home, io)) {
      throw new ApprovalError('INVALID_INPUT', 'Collected sequence is not above the slot high-water');
    }
    try { io.renameSync(p.proposals, destination); } catch (e) { throw ioErr('rename', e); }
    fault('rotation:renamed');
    try { io.mkdirSync(p.proposals, { mode: 0o700 }); } catch (e) { throw ioErr('recreate proposals', e); }
    if (!realDir(p.proposals, 'recreated proposals')) throw ioErr('recreate proposals', undefined);
    fault('rotation:recreated');
    if (dest.kind === 'collected') advanceHighWater(p.root, dest.seq, { root: home, io });
    return { kind: 'rotated', destination, proposals: p.proposals };
  };

  // Releasing a lock this pass created must not depend on the work budget (a budgeted io would refuse the rmdir).
  const releaseIo: DirIo = (io as Partial<BudgetedDirIo>).unbudgeted ?? io;
  const withSlotCoord = <T>(home: string, slot: SlotRef, fn: () => T): T => {
    const p = requestPaths(home, slot);
    ensureSlotRoot(home, p.root);
    const coord = path.join(p.root, '.coord');
    try {
      io.mkdirSync(coord, { mode: 0o700 });
    } catch (e) {
      if (codeOf(e) !== 'EEXIST') throw ioErr('create .coord', e);
      if (realDir(coord, '.coord')) throw new CoordHeldError(); // not a real dir -> UNSAFE_PATH above
      throw ioErr('create .coord', e);
    }
    let result: T;
    try {
      result = fn();
    } catch (e) {
      try { releaseIo.rmdirSync(coord); } catch { /* the original failure wins */ }
      throw e;
    }
    try { releaseIo.rmdirSync(coord); } catch (e) { throw ioErr('release .coord', e); }
    return result;
  };

  const park: Park = (home, slot, attemptId) => {
    approvalSourceId(attemptId);
    return withSlotCoord(home, slot, () => rotate(home, slot, { kind: 'parked', attempt_id: attemptId }));
  };

  return { rotate, park, withSlotCoord };
}

const defaults = createRotation();
export const rotate: Rotate = defaults.rotate;
export const park: Park = defaults.park;
export const withSlotCoord: <T>(home: string, slot: SlotRef, fn: () => T) => T = defaults.withSlotCoord;
