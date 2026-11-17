import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readRegularFileCappedNoFollow } from '../src/fs-util.js';

let dir: string;
beforeEach(() => { dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'approval-capped-'))); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('readRegularFileCappedNoFollow', () => {
  it('capped reader returns fstat dev/ino without changing bytes', () => {
    const f = path.join(dir, 'a.req');
    fs.writeFileSync(f, 'hello world');
    const st = fs.statSync(f);
    const whole = readRegularFileCappedNoFollow(f, 64);
    expect(whole.ok).toBe(true);
    if (!whole.ok) return;
    expect(whole.buf.toString()).toBe('hello world');
    expect(whole.size).toBe(11);
    expect(whole.truncated).toBe(false);
    expect(whole.ino).toBe(st.ino);
    expect(whole.dev).toBe(st.dev);
    expect(whole.mtimeMs).toBe(st.mtimeMs);
    const cut = readRegularFileCappedNoFollow(f, 5);
    expect(cut.ok && cut.buf.toString()).toBe('hello');
    expect(cut.ok && cut.truncated).toBe(true);
    expect(cut.ok && cut.size).toBe(11);
    expect(cut.ok && cut.ino).toBe(st.ino);
  });
  it('refusals stay unchanged and carry no inode fields', () => {
    const target = path.join(dir, 't');
    fs.writeFileSync(target, 'x');
    fs.symlinkSync(target, path.join(dir, 'link'));
    const fifo = path.join(dir, 'fifo');
    execFileSync('mkfifo', [fifo]);
    expect(readRegularFileCappedNoFollow(path.join(dir, 'link'), 8)).toEqual({ ok: false, reason: 'symlink' });
    expect(readRegularFileCappedNoFollow(fifo, 8)).toEqual({ ok: false, reason: 'not_regular' });
    expect(readRegularFileCappedNoFollow(dir, 8)).toEqual({ ok: false, reason: 'not_regular' });
    expect(readRegularFileCappedNoFollow(path.join(dir, 'nope'), 8)).toEqual({ ok: false, reason: 'open_error:ENOENT' });
  });
  it('spend callback is charged for open, fstat, every read incl. EOF, and close', () => {
    const f = path.join(dir, 'a.req');
    fs.writeFileSync(f, 'hello');
    let calls = 0;
    const r = readRegularFileCappedNoFollow(f, 64, () => { calls += 1; });
    expect(r.ok).toBe(true);
    expect(calls).toBe(5); // open, fstat, read(5), read(EOF), close
  });
  it('a throwing spend propagates, stops further work and still closes the fd', () => {
    const f = path.join(dir, 'a.req');
    fs.writeFileSync(f, 'x'.repeat(32));
    const opened = new Set<number>();
    const origOpen = fs.openSync, origClose = fs.closeSync;
    fs.openSync = ((...a: Parameters<typeof fs.openSync>) => { const fd = origOpen(...a); opened.add(fd); return fd; }) as typeof fs.openSync;
    fs.closeSync = ((fd: number) => { opened.delete(fd); return origClose(fd); }) as typeof fs.closeSync;
    try {
      for (let limit = 0; limit < 5; limit++) {
        let used = 0;
        const stop = new Error('stop');
        expect(() => readRegularFileCappedNoFollow(f, 64, () => { if (used >= limit) throw stop; used += 1; })).toThrow(stop);
        expect(opened.size).toBe(0);
      }
    } finally { fs.openSync = origOpen; fs.closeSync = origClose; }
  });
});
