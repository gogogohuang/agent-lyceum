import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type DirIo, SCAN_WORK_BUDGET, ScanBudgetExceeded, budgetedIo, scanBudget } from '../src/approval-budget.js';

let dir: string;
beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'approval-budget-')));
  for (let i = 0; i < 10; i++) fs.writeFileSync(path.join(dir, `f${i}`), 'x');
});
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('scan work budget', () => {
  it('SCAN_WORK_BUDGET is 65536', () => {
    expect(SCAN_WORK_BUDGET).toBe(65536);
    expect(scanBudget().limit).toBe(65536);
    expect(scanBudget(7).limit).toBe(7);
  });
  it('budgetedIo never calls readdirSync and counts one unit per entry', () => {
    const readdirSync = vi.fn(() => { throw new Error('readdirSync must not be called'); });
    const base = { ...fs, readdirSync } as unknown as DirIo;
    const budget = scanBudget(1000);
    const io = budgetedIo(base, budget);
    const names = io.readdirSync(dir) as string[];
    expect([...names].sort()).toEqual(Array.from({ length: 10 }, (_, i) => `f${i}`));
    expect(readdirSync).not.toHaveBeenCalled();
    expect(budget.used).toBe(1 + 10); // opendir + one per entry
    io.lstatSync(path.join(dir, 'f0'));
    expect(budget.used).toBe(12);
    io.mkdirSync(path.join(dir, 'd'));
    expect(budget.used).toBe(13);
  });
  it('budget overflow throws ScanBudgetExceeded and closes the dir', () => {
    const closes: number[] = [];
    const base: DirIo = {
      ...fs,
      opendirSync: ((p: string) => {
        const d = fs.opendirSync(p);
        const close = d.closeSync.bind(d);
        d.closeSync = () => { closes.push(1); close(); };
        return d;
      }) as unknown as DirIo['opendirSync'],
    } as DirIo;
    const budget = scanBudget(4);
    budget.op = 'scan';
    const io = budgetedIo(base, budget);
    let err: unknown;
    try { io.readdirSync(dir); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(ScanBudgetExceeded);
    expect((err as ScanBudgetExceeded).op).toBe('scan');
    expect(closes).toHaveLength(1);
    expect(budget.used).toBeLessThanOrEqual(4);
    expect(() => io.lstatSync(dir)).toThrow(ScanBudgetExceeded); // exhausted: later calls are refused too
  });
  it('a budget overflow before a call means the call is not made; close always happens', () => {
    const budget = scanBudget(1);
    const io = budgetedIo(fs as unknown as DirIo, budget);
    const fd = io.openSync(path.join(dir, 'f0'), 'r');
    expect(() => io.fstatSync(fd)).toThrow(ScanBudgetExceeded);
    expect(() => io.closeSync(fd)).toThrow(ScanBudgetExceeded); // charged after the close
    expect(() => fs.fstatSync(fd)).toThrow(/EBADF/); // but the descriptor is closed
  });
});
