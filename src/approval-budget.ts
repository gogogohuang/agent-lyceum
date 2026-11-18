import fs from 'node:fs';
import type { ApprovalIo } from './approval-io.js';

/**
 * Bounded-work wrapper for approval collection (plan D3). Work is counted in charged units: one
 * unit per charged call (lstat, mkdir, open, fstat, read, write, fsync, link, unlink, rename,
 * rmdir, file close, opendir) and one per directory entry returned by a Dir read. When the budget
 * is exhausted the NEXT charged call throws ScanBudgetExceeded instead of running. UNCHARGED:
 * Dir close, the terminating null of a Dir read, and releases made through `unbudgeted`. The
 * entry that overflows the budget has already been fetched from the Dir (at most one entry past
 * overflow). The budget therefore bounds work in units, not an exact count of fs calls, and it
 * does NOT bound wall-clock time: a single call on a hung filesystem can still block.
 */

/** Fixed collection-log operations (plan D9). */
export type CollectOp = 'coord' | 'high_water' | 'link_probe' | 'rotate' | 'park' | 'list' | 'scan' |
  'read' | 'publish' | 'done' | 'inventory' | 'counter' | 'pass';

/** Charged work units per slot per pass; 20000 valid entries (1 dirent + 1 lstat each) fit with room to spare. */
export const SCAN_WORK_BUDGET = 65_536;

export class ScanBudgetExceeded extends Error {
  constructor(readonly op: CollectOp) {
    super(`Scan work budget exceeded during ${op}`);
    this.name = 'ScanBudgetExceeded';
  }
}

export interface ScanBudget {
  readonly limit: number;
  used: number;
  /** Phase label reported by ScanBudgetExceeded; the collector sets it as it moves between phases. */
  op: CollectOp;
  spend(n?: number): void;
}

export function scanBudget(limit: number = SCAN_WORK_BUDGET): ScanBudget {
  const budget: ScanBudget = {
    limit,
    used: 0,
    op: 'pass',
    spend(n = 1) {
      if (budget.used + n > budget.limit) throw new ScanBudgetExceeded(budget.op);
      budget.used += n;
    },
  };
  return budget;
}

export type DirIo = ApprovalIo & Pick<typeof fs, 'opendirSync' | 'rmdirSync'>;

/** A budgeted io carries the io it wraps so an owned lock can be released after the budget ran out. */
export type BudgetedDirIo = DirIo & { readonly unbudgeted: DirIo };

/**
 * `readdirSync` is replaced by opendirSync + per-entry readSync: it NEVER calls `base.readdirSync`,
 * so a directory of any size costs at most `budget.limit` units and its memory is bounded by the
 * same number. The Dir is always closed, also when the budget runs out.
 */
export function budgetedIo(base: DirIo, budget: ScanBudget): BudgetedDirIo {
  const spent = <A extends unknown[], R>(fn: (...a: A) => R) => (...a: A): R => { budget.spend(1); return fn(...a); };
  const countedDir = (dir: fs.Dir): fs.Dir => ({
    path: dir.path,
    readSync: () => {
      const entry = dir.readSync();
      if (entry !== null) budget.spend(1);
      return entry;
    },
    closeSync: () => dir.closeSync(),
  }) as unknown as fs.Dir;
  const io: BudgetedDirIo = {
    ...base,
    unbudgeted: base,
    lstatSync: spent(base.lstatSync.bind(base)) as DirIo['lstatSync'],
    mkdirSync: spent(base.mkdirSync.bind(base)) as DirIo['mkdirSync'],
    openSync: spent(base.openSync.bind(base)) as DirIo['openSync'],
    fstatSync: spent(base.fstatSync.bind(base)) as DirIo['fstatSync'],
    readSync: spent(base.readSync.bind(base)) as DirIo['readSync'],
    writeSync: spent(base.writeSync.bind(base)) as DirIo['writeSync'],
    fsyncSync: spent(base.fsyncSync.bind(base)) as DirIo['fsyncSync'],
    linkSync: spent(base.linkSync.bind(base)) as DirIo['linkSync'],
    unlinkSync: spent(base.unlinkSync.bind(base)) as DirIo['unlinkSync'],
    renameSync: spent(base.renameSync.bind(base)) as DirIo['renameSync'],
    rmdirSync: spent(base.rmdirSync.bind(base)) as DirIo['rmdirSync'],
    // Close always runs first (never leak a descriptor), then it is charged.
    closeSync: ((fd: number) => { base.closeSync(fd); budget.spend(1); }) as DirIo['closeSync'],
    opendirSync: ((p: fs.PathLike, options?: fs.OpenDirOptions) => {
      budget.spend(1);
      return countedDir(base.opendirSync(p, options));
    }) as DirIo['opendirSync'],
    readdirSync: ((p: fs.PathLike, options?: unknown) => {
      if (options !== undefined && typeof options === 'object' && options !== null && (options as { withFileTypes?: boolean }).withFileTypes) {
        throw new TypeError('budgetedIo.readdirSync supports names only');
      }
      const dir = io.opendirSync(p);
      const names: string[] = [];
      try {
        for (;;) {
          const entry = dir.readSync();
          if (entry === null) break;
          names.push(entry.name);
        }
      } finally {
        dir.closeSync();
      }
      return names;
    }) as DirIo['readdirSync'],
  };
  return io;
}

export const defaultDirIo: DirIo = fs;
