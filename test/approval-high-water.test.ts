import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ApprovalError } from '../src/approval-error.js';
import {
  type HighWaterFault,
  advanceHighWater,
  maxCollectedSequence,
  nextCollectedSequence,
  readHighWater,
} from '../src/approval-high-water.js';
import { type ApprovalIo, defaultApprovalIo } from '../src/approval-io.js';
import { requestPaths } from '../src/approval-paths.js';

let home: string;
let slot: string;
let hwFile: string;
let collected: string;
beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'approval-hw-')));
  const p = requestPaths(home, { kind: 'run', project: 'proj', run_id: 'run.1', slot: 'worker' });
  slot = p.root;
  hwFile = p.high_water;
  collected = p.collected;
  fs.mkdirSync(slot, { recursive: true });
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof ApprovalError) return e.code;
    throw e;
  }
  return 'none';
}
const mkdirs = (...ns: (number | string)[]) => {
  for (const n of ns) fs.mkdirSync(path.join(collected, String(n)), { recursive: true });
};
const tmps = () => fs.readdirSync(slot).filter((n) => n.endsWith('.tmp'));

describe('readHighWater', () => {
  it('missing file (and missing slot) is 0', () => {
    expect(readHighWater(slot, home)).toBe(0);
    expect(readHighWater(path.join(home, 'requests', 'nope'), home)).toBe(0);
  });
  it('parses decimal + LF', () => {
    fs.writeFileSync(hwFile, '0\n');
    expect(readHighWater(slot, home)).toBe(0);
    fs.writeFileSync(hwFile, '12\n');
    expect(readHighWater(slot, home)).toBe(12);
    fs.writeFileSync(hwFile, `${Number.MAX_SAFE_INTEGER}\n`);
    expect(readHighWater(slot, home)).toBe(Number.MAX_SAFE_INTEGER);
  });
  it.each([
    [''], ['5'], ['5\n\n'], ['05\n'], ['-1\n'], ['+1\n'], [' 5\n'], ['5 \n'], ['1\n2\n'], ['5\r\n'],
    ['1e3\n'], ['﻿5\n'], ['x\n'], ['9007199254740992\n'], ['99999999999999999999\n'],
  ])('corrupt %j fails closed', (content) => {
    fs.writeFileSync(hwFile, content);
    expect(code(() => readHighWater(slot, home))).toBe('CORRUPT_HIGH_WATER');
  });
  it('oversize, symlink, FIFO and directory fail closed', () => {
    fs.writeFileSync(hwFile, `${'1'.repeat(40)}\n`);
    expect(code(() => readHighWater(slot, home))).toBe('CORRUPT_HIGH_WATER');
    fs.rmSync(hwFile);
    fs.writeFileSync(path.join(slot, 'real'), '3\n');
    fs.symlinkSync('real', hwFile);
    expect(code(() => readHighWater(slot, home))).toBe('CORRUPT_HIGH_WATER');
    fs.rmSync(hwFile);
    execFileSync('mkfifo', [hwFile]);
    expect(code(() => readHighWater(slot, home))).toBe('CORRUPT_HIGH_WATER');
    fs.rmSync(hwFile);
    fs.mkdirSync(hwFile);
    expect(code(() => readHighWater(slot, home))).toBe('CORRUPT_HIGH_WATER');
  });
  it('a read error other than ENOENT is fail-closed, not 0', () => {
    fs.writeFileSync(hwFile, '3\n');
    const bad: ApprovalIo = { ...defaultApprovalIo, openSync: () => { throw Object.assign(new Error('x'), { code: 'EACCES' }); } };
    expect(code(() => readHighWater(slot, home, bad))).toBe('CORRUPT_HIGH_WATER');
  });
});

describe('maxCollectedSequence / nextCollectedSequence', () => {
  it('no collected and no file: 0, next 1', () => {
    expect(maxCollectedSequence(slot, home)).toBe(0);
    expect(nextCollectedSequence(slot, home)).toBe(1);
  });
  it('numeric ordering: 10 > 2, includes .done markers and the persisted value', () => {
    mkdirs(1, 2, 10);
    expect(maxCollectedSequence(slot, home)).toBe(10);
    fs.writeFileSync(path.join(collected, '11.done'), '');
    expect(maxCollectedSequence(slot, home)).toBe(11);
    fs.writeFileSync(hwFile, '40\n');
    expect(maxCollectedSequence(slot, home)).toBe(40);
    expect(nextCollectedSequence(slot, home)).toBe(41);
  });
  it('persisted high-water alone counts when collected is empty or gone', () => {
    fs.writeFileSync(hwFile, '7\n');
    expect(nextCollectedSequence(slot, home)).toBe(8);
    mkdirs(3);
    expect(nextCollectedSequence(slot, home)).toBe(8);
  });
  it('ignores non-numeric names (temp files, dotfiles)', () => {
    mkdirs(2);
    fs.writeFileSync(path.join(collected, '.tmp-99'), '');
    fs.writeFileSync(path.join(collected, 'notes'), '');
    fs.writeFileSync(path.join(collected, '99.done.bak'), '');
    expect(maxCollectedSequence(slot, home)).toBe(2);
  });
  it.each([['007'], ['0'], ['9007199254740992'], ['99999999999999999999']])('alias/overflow dir %s fails closed', (n) => {
    mkdirs(n);
    expect(code(() => maxCollectedSequence(slot, home))).toBe('CORRUPT_HIGH_WATER');
  });
  it('alias/overflow .done marker fails closed', () => {
    fs.mkdirSync(collected);
    fs.writeFileSync(path.join(collected, '05.done'), '');
    expect(code(() => maxCollectedSequence(slot, home))).toBe('CORRUPT_HIGH_WATER');
  });
  it('numeric symlink, FIFO, a numeric plain file and a .done directory fail closed', () => {
    fs.mkdirSync(collected);
    fs.mkdirSync(path.join(home, 'elsewhere'));
    fs.symlinkSync(path.join(home, 'elsewhere'), path.join(collected, '3'));
    expect(code(() => maxCollectedSequence(slot, home))).toBe('UNSAFE_PATH');
    fs.rmSync(path.join(collected, '3'));
    execFileSync('mkfifo', [path.join(collected, '4.done')]);
    expect(code(() => maxCollectedSequence(slot, home))).toBe('UNSAFE_PATH');
    fs.rmSync(path.join(collected, '4.done'));
    fs.writeFileSync(path.join(collected, '5'), '');
    expect(code(() => maxCollectedSequence(slot, home))).toBe('UNSAFE_PATH');
    fs.rmSync(path.join(collected, '5'));
    fs.mkdirSync(path.join(collected, '6.done'));
    expect(code(() => maxCollectedSequence(slot, home))).toBe('UNSAFE_PATH');
  });
  it('collected as a symlink or file is rejected', () => {
    fs.writeFileSync(collected, '');
    expect(code(() => maxCollectedSequence(slot, home))).toBe('UNSAFE_PATH');
  });
  it('MAX_SAFE_INTEGER overflow is rejected by next', () => {
    fs.writeFileSync(hwFile, `${Number.MAX_SAFE_INTEGER}\n`);
    expect(code(() => nextCollectedSequence(slot, home))).toBe('SEQUENCE_OVERFLOW');
    fs.writeFileSync(hwFile, `${Number.MAX_SAFE_INTEGER - 1}\n`);
    expect(nextCollectedSequence(slot, home)).toBe(Number.MAX_SAFE_INTEGER);
  });
  it('corrupt high-water makes max/next fail closed even with good dirs', () => {
    mkdirs(1);
    fs.writeFileSync(hwFile, 'oops');
    expect(code(() => nextCollectedSequence(slot, home))).toBe('CORRUPT_HIGH_WATER');
  });
});

describe('advanceHighWater', () => {
  it('writes decimal+LF mode 0600, returns the new value, leaves no temp', () => {
    expect(advanceHighWater(slot, 5, { root: home })).toBe(5);
    expect(fs.readFileSync(hwFile, 'utf8')).toBe('5\n');
    expect(fs.statSync(hwFile).mode & 0o777).toBe(0o600);
    expect(tmps()).toEqual([]);
  });
  it('never decreases: takes max(atLeast, persisted, dirs)', () => {
    advanceHighWater(slot, 9, { root: home });
    expect(advanceHighWater(slot, 3, { root: home })).toBe(9);
    expect(fs.readFileSync(hwFile, 'utf8')).toBe('9\n');
    mkdirs(12);
    expect(advanceHighWater(slot, 0, { root: home })).toBe(12);
    expect(readHighWater(slot, home)).toBe(12);
  });
  it('rejects bad atLeast and a corrupt existing value without writing', () => {
    for (const bad of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      expect(code(() => advanceHighWater(slot, bad, { root: home }))).toBe('INVALID_INPUT');
    }
    fs.writeFileSync(hwFile, 'zzz');
    expect(code(() => advanceHighWater(slot, 5, { root: home }))).toBe('CORRUPT_HIGH_WATER');
    expect(fs.readFileSync(hwFile, 'utf8')).toBe('zzz');
  });
  it('creates a missing call slot root privately and uses temp + rename only', () => {
    const cp = requestPaths(home, { kind: 'call', call_id: 'call-1' });
    const renames: string[] = [];
    const io: ApprovalIo = {
      ...defaultApprovalIo,
      renameSync: (a, b) => { renames.push(`${path.basename(String(a))}->${path.basename(String(b))}`); fs.renameSync(a, b); },
    };
    expect(advanceHighWater(cp.root, 1, { root: home, io })).toBe(1);
    expect(fs.statSync(cp.root).mode & 0o777).toBe(0o700);
    expect(renames).toHaveLength(1);
    expect(renames[0]).toMatch(/^\.collected\.seq-\d+-.+\.tmp->collected\.seq$/);
  });
  it('rejects a symlinked slot ancestor', () => {
    fs.mkdirSync(path.join(home, 'real'));
    fs.symlinkSync(path.join(home, 'real'), path.join(home, 'requests-link'));
    // readHighWater maps every unreadable-path error to CORRUPT_HIGH_WATER: fail closed, nothing written
    expect(code(() => advanceHighWater(path.join(home, 'requests-link', 'x'), 1, { root: home }))).toBe('CORRUPT_HIGH_WATER');
    expect(fs.readdirSync(path.join(home, 'real'))).toEqual([]);
  });

  describe('crash windows', () => {
    const crashAt = (point: HighWaterFault) =>
      expect(() =>
        advanceHighWater(slot, 8, { root: home, fault: (p) => { if (p === point) throw new Error(`crash@${p}`); } }),
      ).toThrow(`crash@${point}`);
    it('before rename (temp written / synced): old value intact, temp left, re-run recovers', () => {
      advanceHighWater(slot, 4, { root: home });
      crashAt('temp_written');
      expect(readHighWater(slot, home)).toBe(4);
      crashAt('temp_synced');
      expect(readHighWater(slot, home)).toBe(4);
      expect(tmps()).toHaveLength(2);
      expect(advanceHighWater(slot, 8, { root: home })).toBe(8);
      expect(tmps()).toHaveLength(2); // other attempts' temps are not deleted
    });
    it('after rename: new complete value', () => {
      advanceHighWater(slot, 4, { root: home });
      crashAt('renamed');
      expect(readHighWater(slot, home)).toBe(8);
      expect(fs.readFileSync(hwFile, 'utf8')).toBe('8\n');
    });
    it('first-ever advance crashing before rename leaves no file (0)', () => {
      crashAt('temp_synced');
      expect(fs.existsSync(hwFile)).toBe(false);
      expect(readHighWater(slot, home)).toBe(0);
    });
    it('write/fsync/rename failures remove own temp and keep the old value', () => {
      advanceHighWater(slot, 4, { root: home });
      for (const key of ['writeSync', 'fsyncSync', 'renameSync'] as const) {
        const io: ApprovalIo = { ...defaultApprovalIo, [key]: () => { throw Object.assign(new Error('x'), { code: 'EIO' }); } };
        expect(code(() => advanceHighWater(slot, 8, { root: home, io }))).toBe('IO_ERROR');
        expect(readHighWater(slot, home)).toBe(4);
        expect(tmps()).toEqual([]);
      }
    });
  });
});

describe('serialized scenarios (caller holds the per-slot coordination)', () => {
  it('rotate rename done but high-water not written: next recovers from dirs and .done', () => {
    mkdirs(1, 2);
    advanceHighWater(slot, 2, { root: home });
    // rotate: proposals -> collected/3, then crash before advance
    mkdirs(3);
    expect(readHighWater(slot, home)).toBe(2);
    expect(nextCollectedSequence(slot, home)).toBe(4);
    // only the .done marker remains (dir already gc'd)
    fs.rmSync(path.join(collected, '3'), { recursive: true });
    fs.writeFileSync(path.join(collected, '3.done'), '');
    expect(nextCollectedSequence(slot, home)).toBe(4);
  });
  it('gc advances first then deletes: deleting dirs and markers never goes back', () => {
    mkdirs(1, 2, 3);
    fs.writeFileSync(path.join(collected, '3.done'), '');
    advanceHighWater(slot, 3, { root: home });
    fs.rmSync(path.join(collected, '3.done'));
    fs.rmSync(collected, { recursive: true });
    expect(maxCollectedSequence(slot, home)).toBe(3);
    expect(nextCollectedSequence(slot, home)).toBe(4);
  });
  it('gc crash after advance but before deletion is harmless', () => {
    mkdirs(5);
    advanceHighWater(slot, 5, { root: home });
    expect(nextCollectedSequence(slot, home)).toBe(6);
  });
  it.each([
    ['run slot', () => requestPaths(home, { kind: 'run', project: 'p', run_id: 'r1', slot: 'orphan' })],
    ['call slot', () => requestPaths(home, { kind: 'call', call_id: 'c1' })],
  ])('sequential rotate/gc cycles on an %s only increase', (_n, mk) => {
    const p = mk();
    fs.mkdirSync(p.collected, { recursive: true });
    let last = 0;
    for (let i = 0; i < 4; i++) {
      const n = nextCollectedSequence(p.root, home);
      expect(n).toBeGreaterThan(last);
      fs.mkdirSync(path.join(p.collected, String(n)));
      advanceHighWater(p.root, n, { root: home });
      if (i % 2) { // gc everything
        fs.rmSync(path.join(p.collected, String(n)), { recursive: true });
        advanceHighWater(p.root, n, { root: home });
      }
      expect(maxCollectedSequence(p.root, home)).toBeGreaterThanOrEqual(n);
      last = n;
    }
    expect(last).toBe(4);
  });
});
