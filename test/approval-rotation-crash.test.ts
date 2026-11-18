import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type DirIo, ScanBudgetExceeded, budgetedIo, defaultDirIo, scanBudget } from '../src/approval-budget.js';
import { ApprovalError } from '../src/approval-error.js';
import { advanceHighWater, nextCollectedSequence, readHighWater } from '../src/approval-high-water.js';
import { checkApprovalLinks } from '../src/approval-link-check.js';
import { type SlotRef, requestPaths } from '../src/approval-paths.js';
import { CoordHeldError, createRotation, park, rotate, withSlotCoord } from '../src/approval-rotation.js';

let home: string;
const slot: SlotRef = { kind: 'run', project: 'proj', run_id: 'run.1', slot: 'worker' };
const other: SlotRef = { kind: 'run', project: 'proj', run_id: 'run.1', slot: 'healthy' };
let p: ReturnType<typeof requestPaths>;
beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'approval-rot-')));
  p = requestPaths(home, slot);
});
afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

class Crash extends Error {}
const crashAt = (point: string) => createRotation({ fault: (x) => { if (x === point) throw new Crash(point); } });
function put(ref: SlotRef, name = 'a.req', body = 'executor: x\n\nbody'): string {
  const dir = requestPaths(home, ref).proposals;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const f = path.join(dir, name);
  fs.writeFileSync(f, body);
  return f;
}
function codeOf(fn: () => unknown): string {
  try { fn(); } catch (e) { if (e instanceof ApprovalError) return e.code; throw e; }
  return 'none';
}
const mode = (f: string) => fs.lstatSync(f).mode & 0o777;

describe('rotate and park', () => {
  it('missing proposals rebuilt 0700', () => {
    const r = rotate(home, slot, { kind: 'collected', seq: 1 });
    expect(r).toEqual({ kind: 'empty', proposals: p.proposals });
    expect(fs.lstatSync(p.proposals).isDirectory()).toBe(true);
    expect(mode(p.proposals)).toBe(0o700);
    expect(fs.existsSync(p.high_water)).toBe(false); // an empty rotate allocates and records nothing
    expect(fs.existsSync(p.collected)).toBe(false);
    // slot root present, proposals removed afterwards
    fs.rmdirSync(p.proposals);
    expect(park(home, slot, 'a1')).toEqual({ kind: 'empty', proposals: p.proposals });
    expect(mode(p.proposals)).toBe(0o700);
    expect(fs.existsSync(path.join(p.parked))).toBe(false);
  });

  it('rotates a non-empty proposals dir whole, recreates it empty 0700 and advances the high-water', () => {
    put(slot, 'a.req');
    put(slot, '.hidden', 'dotfiles count as content');
    const r = rotate(home, slot, { kind: 'collected', seq: 1 });
    expect(r).toEqual({ kind: 'rotated', destination: path.join(p.collected, '1'), proposals: p.proposals });
    expect(fs.readdirSync(path.join(p.collected, '1')).sort()).toEqual(['.hidden', 'a.req']);
    expect(fs.readdirSync(p.proposals)).toEqual([]);
    expect(mode(p.proposals)).toBe(0o700);
    expect(mode(p.collected)).toBe(0o700);
    expect(readHighWater(p.root, home)).toBe(1);
  });

  it('empty reentry never touches existing parked destination', () => {
    const f = put(slot);
    expect(park(home, slot, 'attempt-1').kind).toBe('rotated');
    const dest = path.join(p.parked, 'attempt-1', 'a.req');
    const ino = fs.statSync(dest).ino;
    expect(fs.existsSync(f)).toBe(false);
    for (let i = 0; i < 2; i++) {
      expect(park(home, slot, 'attempt-1')).toEqual({ kind: 'empty', proposals: p.proposals });
    }
    expect(fs.statSync(dest).ino).toBe(ino);
    expect(fs.readFileSync(dest, 'utf8')).toBe('executor: x\n\nbody');
    // same for collected
    put(slot, 'b.req');
    expect(rotate(home, slot, { kind: 'collected', seq: 1 }).kind).toBe('rotated');
    expect(rotate(home, slot, { kind: 'collected', seq: 1 }).kind).toBe('empty');
    expect(fs.readdirSync(path.join(p.collected, '1'))).toEqual(['b.req']);
  });

  it('refuses an existing destination or a reused/lower sequence when there is something to move', () => {
    put(slot);
    fs.mkdirSync(path.join(p.parked, 'attempt-1'), { recursive: true });
    expect(codeOf(() => park(home, slot, 'attempt-1'))).toBe('UNSAFE_PATH');
    expect(fs.readdirSync(p.proposals)).toEqual(['a.req']); // nothing moved
    fs.mkdirSync(path.join(p.collected, '3'), { recursive: true });
    expect(codeOf(() => rotate(home, slot, { kind: 'collected', seq: 2 }))).toBe('INVALID_INPUT');
    expect(codeOf(() => rotate(home, slot, { kind: 'collected', seq: 3 }))).toBe('UNSAFE_PATH'); // destination exists
    expect(codeOf(() => rotate(home, slot, { kind: 'collected', seq: 0 }))).toBe('INVALID_INPUT');
    expect(fs.readdirSync(p.proposals)).toEqual(['a.req']);
    expect(rotate(home, slot, { kind: 'collected', seq: 4 }).kind).toBe('rotated');
  });

  it('park validates the attempt id before any I/O', () => {
    for (const bad of ['../x', 'a/b', '', '.hidden', 'a\nb']) {
      expect(codeOf(() => park(home, slot, bad))).toBe('INVALID_INPUT');
    }
    expect(fs.existsSync(path.join(home, 'requests'))).toBe(false); // no directory, no .coord created
  });

  it('corrupt high-water blocks even empty wake', () => {
    fs.mkdirSync(p.proposals, { recursive: true, mode: 0o700 });
    fs.writeFileSync(p.high_water, 'garbage');
    expect(codeOf(() => rotate(home, slot, { kind: 'collected', seq: 1 }))).toBe('CORRUPT_HIGH_WATER');
    expect(codeOf(() => park(home, slot, 'a1'))).toBe('CORRUPT_HIGH_WATER');
    put(slot);
    expect(codeOf(() => rotate(home, slot, { kind: 'collected', seq: 1 }))).toBe('CORRUPT_HIGH_WATER');
    expect(fs.readdirSync(p.proposals)).toEqual(['a.req']); // never discarded to make a wake possible
    expect(fs.readFileSync(p.high_water, 'utf8')).toBe('garbage'); // never repaired silently
  });

  it('symlink/file/FIFO ancestor suspends only own slot', () => {
    const elsewhere = path.join(home, 'elsewhere');
    fs.mkdirSync(elsewhere);
    fs.writeFileSync(path.join(elsewhere, 'victim.req'), 'v');
    const variants: [string, () => void][] = [
      ['proposals symlink', () => { fs.mkdirSync(p.root, { recursive: true }); fs.symlinkSync(elsewhere, p.proposals); }],
      ['proposals file', () => { fs.mkdirSync(p.root, { recursive: true }); fs.writeFileSync(p.proposals, 'x'); }],
      ['proposals FIFO', () => { fs.mkdirSync(p.root, { recursive: true }); execFileSync('mkfifo', [p.proposals]); }],
      ['collected symlink', () => { put(slot); fs.symlinkSync(elsewhere, p.collected); }],
      ['collected file', () => { put(slot); fs.writeFileSync(p.collected, 'x'); }],
      ['parked symlink', () => { put(slot); fs.symlinkSync(elsewhere, p.parked); }],
      ['slot root symlink', () => { fs.mkdirSync(path.dirname(p.root), { recursive: true }); fs.mkdirSync(path.join(elsewhere, 'proposals')); fs.writeFileSync(path.join(elsewhere, 'proposals', 'w.req'), 'w'); fs.symlinkSync(elsewhere, p.root); }],
      ['two-hop symlinked ancestor', () => {
        const real = path.join(home, 'real'); const hop = path.join(home, 'hop1');
        fs.mkdirSync(path.join(real, 'run.1', 'worker', 'proposals'), { recursive: true });
        fs.writeFileSync(path.join(real, 'run.1', 'worker', 'proposals', 'w.req'), 'w');
        fs.symlinkSync(real, hop);
        fs.mkdirSync(path.join(home, 'requests', 'projects'), { recursive: true });
        fs.symlinkSync(hop, path.join(home, 'requests', 'projects', 'proj'));
      }],
    ];
    for (const [name, arrange] of variants) {
      fs.rmSync(path.join(home, 'requests'), { recursive: true, force: true });
      fs.rmSync(path.join(home, 'real'), { recursive: true, force: true });
      fs.rmSync(path.join(home, 'hop1'), { force: true });
      arrange();
      const entries = fs.readdirSync(elsewhere).sort();
      const dest = name.startsWith('parked') ? () => park(home, slot, 'a1') : () => rotate(home, slot, { kind: 'collected', seq: 1 });
      expect(codeOf(dest), name).toBe('UNSAFE_PATH');
      expect(fs.existsSync(path.join(elsewhere, 'victim.req')), name).toBe(true);
      expect(fs.readdirSync(elsewhere).sort(), name).toEqual(entries); // nothing created or moved through the link
      // a healthy slot of the same project is not affected
      if (name !== 'two-hop symlinked ancestor' && name !== 'slot root symlink') {
        put(other);
        expect(rotate(home, other, { kind: 'collected', seq: 1 }).kind, name).toBe('rotated');
      }
    }
    expect(fs.readFileSync(path.join(home, 'real', 'run.1', 'worker', 'proposals', 'w.req'), 'utf8')).toBe('w');
  });
});

describe('crash points re-enter without loss', () => {
  for (const kind of ['collected', 'parked'] as const) {
    const dest = kind === 'collected' ? { kind, seq: 1 } as const : { kind, attempt_id: 'att-1' } as const;
    const destDir = () => (kind === 'collected' ? path.join(p.collected, '1') : path.join(p.parked, 'att-1'));
    for (const point of ['rotation:renamed', 'rotation:recreated']) {
      it(`${point} (${kind}): fresh re-entry loses nothing, reuses no seq, never hits ENOTEMPTY`, () => {
        put(slot, 'a.req', 'payload');
        expect(() => crashAt(point).rotate(home, slot, dest)).toThrow(Crash);
        expect(fs.readFileSync(path.join(destDir(), 'a.req'), 'utf8')).toBe('payload'); // not lost
        const before = fs.existsSync(p.proposals);
        expect(before).toBe(point === 'rotation:recreated'); // renamed: proposals is gone
        // fresh "process"
        const again = createRotation({}).rotate(home, slot, dest);
        expect(again.kind).toBe('empty');
        expect(fs.lstatSync(p.proposals).isDirectory()).toBe(true);
        expect(mode(p.proposals)).toBe(0o700);
        expect(fs.readFileSync(path.join(destDir(), 'a.req'), 'utf8')).toBe('payload');
        if (kind === 'collected') {
          expect(readHighWater(p.root, home)).toBe(1); // caught up on re-entry
          expect(nextCollectedSequence(p.root, home)).toBe(2); // never 1 again
          advanceHighWater(p.root, 0, { root: home });
          expect(readHighWater(p.root, home)).toBe(1); // only grows
          put(slot, 'b.req');
          expect(rotate(home, slot, { kind: 'collected', seq: 2 }).kind).toBe('rotated');
          expect(readHighWater(p.root, home)).toBe(2);
        } else {
          put(slot, 'b.req');
          expect(park(home, slot, 'att-2').kind).toBe('rotated');
          expect(fs.readdirSync(destDir())).toEqual(['a.req']); // att-1 untouched
        }
      });
    }
  }
});

describe('per-slot coordination', () => {
  it('budget exhaustion still releases coord', () => {
    const coord = path.join(p.root, '.coord');
    const budget = scanBudget(100);
    const budgeted = createRotation({ io: budgetedIo(defaultDirIo, budget) });
    expect(() => budgeted.withSlotCoord(home, slot, () => { budget.spend(budget.limit - budget.used); budget.spend(1); }))
      .toThrow(ScanBudgetExceeded);
    expect(fs.existsSync(coord)).toBe(false); // the owner's release did not depend on the work budget
    expect(withSlotCoord(home, slot, () => 'next')).toBe('next'); // a fresh pass enters
    // success path with an exhausted budget also releases
    const b2 = scanBudget(100);
    expect(createRotation({ io: budgetedIo(defaultDirIo, b2) })
      .withSlotCoord(home, slot, () => { b2.spend(b2.limit - b2.used); return 'ok'; })).toBe('ok');
    expect(fs.existsSync(coord)).toBe(false);
    // a release failing for a non-budget reason still leaves .coord (no steal, no silent success)
    const failing = createRotation({ io: { ...defaultDirIo, rmdirSync: () => { throw Object.assign(new Error('x'), { code: 'EIO' }); } } as DirIo });
    expect(() => failing.withSlotCoord(home, slot, () => 1)).toThrow(ApprovalError);
    expect(fs.existsSync(coord)).toBe(true);
    fs.rmdirSync(coord);
  });

  it('coord overlap and stale coord refuse without steal', () => {
    const coord = path.join(p.root, '.coord');
    let ran = 0;
    withSlotCoord(home, slot, () => {
      ran++;
      expect(fs.lstatSync(coord).isDirectory()).toBe(true);
      expect(mode(coord)).toBe(0o700);
      expect(() => withSlotCoord(home, slot, () => { ran += 100; })).toThrow(CoordHeldError); // overlap
      expect(fs.existsSync(coord)).toBe(true); // the refused attempt did not remove the holder's lock
      // another slot is independent
      withSlotCoord(home, other, () => { ran++; });
    });
    expect(ran).toBe(2);
    expect(fs.existsSync(coord)).toBe(false); // released
    // stale lock left by a crashed holder: old mtime, never stolen
    fs.mkdirSync(coord, { mode: 0o700 });
    const old = new Date(Date.now() - 7 * 24 * 3600 * 1000);
    fs.utimesSync(coord, old, old);
    expect(() => withSlotCoord(home, slot, () => { ran += 1000; })).toThrow(CoordHeldError);
    expect(() => park(home, slot, 'a1')).toThrow(CoordHeldError);
    expect(ran).toBe(2);
    expect(fs.existsSync(coord)).toBe(true);
    // the operator removes it, then re-entry works
    fs.rmdirSync(coord);
    expect(withSlotCoord(home, slot, () => 'ok')).toBe('ok');
    // non-directory or symlink in the way: refused, not removed
    fs.writeFileSync(coord, 'x');
    expect(codeOf(() => withSlotCoord(home, slot, () => 1))).toBe('UNSAFE_PATH');
    expect(fs.readFileSync(coord, 'utf8')).toBe('x');
    fs.rmSync(coord);
    fs.symlinkSync(home, coord);
    expect(codeOf(() => withSlotCoord(home, slot, () => 1))).toBe('UNSAFE_PATH');
    expect(fs.lstatSync(coord).isSymbolicLink()).toBe(true);
  });

  it('releases only its own lock, also when the body throws', () => {
    expect(() => withSlotCoord(home, slot, () => { throw new Error('boom'); })).toThrow('boom');
    expect(fs.existsSync(path.join(p.root, '.coord'))).toBe(false);
  });

  it('park holds the lock for its whole operation', () => {
    put(slot);
    let seen = false;
    const io = { ...fs, renameSync: ((a: string, b: string) => { seen = fs.existsSync(path.join(p.root, '.coord')); fs.renameSync(a, b); }) } as unknown as DirIo;
    createRotation({ io }).park(home, slot, 'a1');
    expect(seen).toBe(true);
    expect(fs.existsSync(path.join(p.root, '.coord'))).toBe(false);
  });
});

describe('hard-link probe', () => {
  const dir = () => { const d = path.join(home, 'approvals'); fs.mkdirSync(d, { recursive: true }); return d; };
  const failing = (code: string, on: 'linkSync' | 'openSync'): DirIo => ({ ...fs, [on]: () => { throw Object.assign(new Error(`secret ${code}`), { code }); } }) as unknown as DirIo;

  it('link probe cleanup and unsupported fail closed', () => {
    const d = dir();
    expect(() => checkApprovalLinks(home, d)).not.toThrow();
    expect(fs.readdirSync(d)).toEqual([]); // both names removed
    for (const code of ['ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'ENOSYS', 'EPERM']) {
      let err: unknown;
      try { checkApprovalLinks(home, d, { io: failing(code, 'linkSync') }); } catch (e) { err = e; }
      expect(err, code).toBeInstanceOf(ApprovalError);
      expect((err as ApprovalError).code, code).toBe('UNSUPPORTED_LINK');
      expect((err as Error).message).not.toContain('secret');
      expect((err as Error).message).not.toContain(home);
      expect(fs.readdirSync(d), code).toEqual([]); // the first name was cleaned up
    }
    for (const [code, on] of [['EIO', 'linkSync'], ['EACCES', 'openSync']] as const) {
      let err: unknown;
      try { checkApprovalLinks(home, d, { io: failing(code, on) }); } catch (e) { err = e; }
      expect((err as ApprovalError).code, code).toBe('IO_ERROR');
      expect((err as Error).message).not.toContain('secret');
      expect(fs.readdirSync(d)).toEqual([]);
    }
  });

  it('only touches a real directory below the home and only removes its own names', () => {
    const d = dir();
    fs.writeFileSync(path.join(d, 'keep.txt'), 'k');
    const link = path.join(home, 'linked');
    fs.symlinkSync(d, link);
    expect(codeOf(() => checkApprovalLinks(home, link))).toBe('UNSAFE_PATH');
    expect(codeOf(() => checkApprovalLinks(home, path.join(os.tmpdir())))).toBe('UNSAFE_PATH'); // outside the home
    expect(codeOf(() => checkApprovalLinks(home, path.join(d, 'missing')))).toBe('IO_ERROR');
    checkApprovalLinks(home, d);
    expect(fs.readdirSync(d)).toEqual(['keep.txt']);
  });
});
