import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ApprovalError } from '../src/approval-error.js';
import {
  type ApprovalIo,
  type FaultPoint,
  defaultApprovalIo,
  publishExclusive,
  readApprovalFile,
} from '../src/approval-io.js';

let root: string;
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'approval-io-')));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
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
function errno(c: string): NodeJS.ErrnoException {
  const e: NodeJS.ErrnoException = new Error(c);
  e.code = c;
  return e;
}
function io(over: Partial<ApprovalIo>): ApprovalIo {
  return { ...defaultApprovalIo, ...over };
}
const tmps = (dir: string) => fs.readdirSync(dir).filter((n) => n.endsWith('.tmp'));

describe('readApprovalFile', () => {
  it('reads a regular file and maps only ENOENT to null', () => {
    fs.writeFileSync(path.join(root, 'a'), 'héllo');
    expect(readApprovalFile(path.join(root, 'a'), 100, root, defaultApprovalIo)?.toString()).toBe('héllo');
    expect(readApprovalFile(path.join(root, 'missing'), 100, root, defaultApprovalIo)).toBeNull();
    expect(readApprovalFile(path.join(root, 'no/dir/x'), 100, root, defaultApprovalIo)).toBeNull();
    const eio = io({ openSync: () => { throw errno('EIO'); } });
    expect(code(() => readApprovalFile(path.join(root, 'a'), 100, root, eio))).toBe('IO_ERROR');
    const eacces = io({ openSync: () => { throw errno('EACCES'); } });
    expect(code(() => readApprovalFile(path.join(root, 'a'), 100, root, eacces))).toBe('IO_ERROR');
  });

  it('rejects a terminal symlink and a symlinked ancestor', () => {
    fs.writeFileSync(path.join(root, 'real'), 'x');
    fs.symlinkSync('real', path.join(root, 'link'));
    expect(code(() => readApprovalFile(path.join(root, 'link'), 100, root, defaultApprovalIo))).toBe('UNSAFE_PATH');
    fs.mkdirSync(path.join(root, 'd'));
    fs.writeFileSync(path.join(root, 'd/f'), 'x');
    fs.symlinkSync('d', path.join(root, 'dl'));
    expect(code(() => readApprovalFile(path.join(root, 'dl/f'), 100, root, defaultApprovalIo))).toBe('UNSAFE_PATH');
  });

  it('rejects a directory and a FIFO without blocking', () => {
    fs.mkdirSync(path.join(root, 'dir'));
    expect(code(() => readApprovalFile(path.join(root, 'dir'), 100, root, defaultApprovalIo))).toBe('UNSAFE_PATH');
    execFileSync('mkfifo', [path.join(root, 'fifo')]);
    expect(code(() => readApprovalFile(path.join(root, 'fifo'), 100, root, defaultApprovalIo))).toBe('UNSAFE_PATH');
  });

  it('rejects oversize and invalid UTF-8; accepts exactly the cap', () => {
    fs.writeFileSync(path.join(root, 'big'), Buffer.alloc(11, 0x61));
    expect(code(() => readApprovalFile(path.join(root, 'big'), 10, root, defaultApprovalIo))).toBe('CORRUPT_RECORD');
    fs.writeFileSync(path.join(root, 'ten'), Buffer.alloc(10, 0x61));
    expect(readApprovalFile(path.join(root, 'ten'), 10, root, defaultApprovalIo)?.length).toBe(10);
    fs.writeFileSync(path.join(root, 'bad'), Buffer.from([0xff, 0xfe]));
    expect(code(() => readApprovalFile(path.join(root, 'bad'), 10, root, defaultApprovalIo))).toBe('CORRUPT_RECORD');
  });

  it('root is required: omitting it is a type error and the ancestor check runs through it', () => {
    fs.mkdirSync(path.join(root, 'real'));
    fs.writeFileSync(path.join(root, 'real/f'), 'secret');
    fs.symlinkSync('real', path.join(root, 'ln'));
    // @ts-expect-error root is a required parameter
    const missingRoot = () => readApprovalFile(path.join(root, 'ln/f'), 100);
    expect(typeof missingRoot).toBe('function'); // never called: only the type error matters
    expect(code(() => readApprovalFile(path.join(root, 'ln/f'), 100, root))).toBe('UNSAFE_PATH');
  });

  it('rejects a path outside the root', () => {
    expect(code(() => readApprovalFile(path.join(root, '..', 'x'), 10, root, defaultApprovalIo))).toBe('UNSAFE_PATH');
  });

  it('detects a file swapped between open and the post-read lstat', () => {
    fs.writeFileSync(path.join(root, 'a'), 'x');
    const swap = io({
      closeSync: (fd) => {
        fs.closeSync(fd);
        fs.rmSync(path.join(root, 'a'));
        fs.writeFileSync(path.join(root, 'a'), 'y');
      },
    });
    expect(code(() => readApprovalFile(path.join(root, 'a'), 10, root, swap))).toBe('UNSAFE_PATH');
  });
});

describe('publishExclusive', () => {
  const target = () => path.join(root, 'sub', 'target');

  it('creates parents 0700, publishes with mode 0400, first writer wins', () => {
    expect(publishExclusive(target(), Buffer.from('one'), { root })).toBe('created');
    expect(publishExclusive(target(), Buffer.from('two'), { root })).toBe('exists');
    expect(fs.readFileSync(target(), 'utf8')).toBe('one');
    expect(fs.statSync(target()).mode & 0o777).toBe(0o400);
    expect(fs.statSync(path.dirname(target())).mode & 0o777).toBe(0o700);
    expect(tmps(path.dirname(target()))).toEqual([]);
  });

  it('uses an O_EXCL|O_NOFOLLOW same-dir temp, mode 0400, and never calls rename', () => {
    const calls: string[] = [];
    let opened: { file: string; flags: number; mode: number } | undefined;
    const spy = io({
      openSync: ((f: fs.PathLike, flags: number, mode: number) => {
        opened = { file: String(f), flags, mode };
        return fs.openSync(f, flags, mode);
      }) as ApprovalIo['openSync'],
      renameSync: () => { calls.push('rename'); },
      linkSync: (a, b) => { calls.push(`link ${path.dirname(String(a)) === path.dirname(String(b))}`); fs.linkSync(a, b); },
    });
    publishExclusive(target(), Buffer.from('x'), { root, io: spy });
    expect(calls).toEqual(['link true']);
    expect(path.dirname(opened!.file)).toBe(path.dirname(target()));
    expect(path.basename(opened!.file)).toMatch(/^\.approval-\d+-.+\.tmp$/);
    const c = fs.constants;
    expect(opened!.flags & (c.O_CREAT | c.O_EXCL | c.O_WRONLY | c.O_NOFOLLOW)).toBe(
      c.O_CREAT | c.O_EXCL | c.O_WRONLY | c.O_NOFOLLOW,
    );
    expect(opened!.mode).toBe(0o400);
  });

  it('handles short writes', () => {
    const short = io({
      writeSync: ((fd: number, buf: Uint8Array, off: number, len: number) =>
        fs.writeSync(fd, buf, off, Math.min(len, 2))) as ApprovalIo['writeSync'],
    });
    publishExclusive(target(), Buffer.from('abcdefg'), { root, io: short });
    expect(fs.readFileSync(target(), 'utf8')).toBe('abcdefg');
  });

  it('a zero-byte write is an IO_ERROR, not an endless loop', () => {
    const zero = io({ writeSync: (() => 0) as ApprovalIo['writeSync'] });
    expect(code(() => publishExclusive(target(), Buffer.from('abc'), { root, io: zero }))).toBe('IO_ERROR');
    expect(fs.existsSync(target())).toBe(false);
    expect(tmps(path.dirname(target()))).toEqual([]);
  });

  it('fsync failure: nothing published, own temp removed', () => {
    const bad = io({ fsyncSync: () => { throw errno('EIO'); } });
    expect(code(() => publishExclusive(target(), Buffer.from('x'), { root, io: bad }))).toBe('IO_ERROR');
    expect(fs.existsSync(target())).toBe(false);
    expect(tmps(path.dirname(target()))).toEqual([]);
  });

  it('close failure after fsync does not close the fd twice', () => {
    let closes = 0;
    const bad = io({ closeSync: (fd) => { closes++; fs.closeSync(fd); throw errno('EIO'); } });
    expect(code(() => publishExclusive(target(), Buffer.from('x'), { root, io: bad }))).toBe('IO_ERROR');
    expect(closes).toBe(1);
    expect(tmps(path.dirname(target()))).toEqual([]);
  });

  it('EEXIST on link surfaces as exists and removes own temp', () => {
    fs.mkdirSync(path.dirname(target()), { recursive: true });
    fs.writeFileSync(target(), 'winner');
    expect(publishExclusive(target(), Buffer.from('loser'), { root })).toBe('exists');
    expect(fs.readFileSync(target(), 'utf8')).toBe('winner');
    expect(tmps(path.dirname(target()))).toEqual([]);
  });

  it.each([
    ['ENOTSUP', 'UNSUPPORTED_LINK'],
    ['EOPNOTSUPP', 'UNSUPPORTED_LINK'],
    ['EXDEV', 'UNSUPPORTED_LINK'],
    ['ENOSYS', 'UNSUPPORTED_LINK'],
    ['EPERM', 'IO_ERROR'],
    ['ENOSPC', 'IO_ERROR'],
    ['EACCES', 'IO_ERROR'],
    ['EIO', 'IO_ERROR'],
  ])('link %s is fail-closed as %s, with no rename fallback', (e, expected) => {
    let renamed = 0;
    const bad = io({ linkSync: () => { throw errno(e); }, renameSync: () => { renamed++; } });
    expect(code(() => publishExclusive(target(), Buffer.from('x'), { root, io: bad }))).toBe(expected);
    expect(renamed).toBe(0);
    expect(fs.existsSync(target())).toBe(false);
    expect(tmps(path.dirname(target()))).toEqual([]);
  });

  it('retries a temp-name collision and keeps the other writer temp', () => {
    const dir = path.dirname(target());
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(dir, `.approval-${process.pid}-same.tmp`), 'other');
    const names = ['same', 'fresh'];
    const token = () => names.shift() ?? 'extra';
    expect(publishExclusive(target(), Buffer.from('y'), { root, token })).toBe('created');
    expect(fs.readFileSync(path.join(dir, `.approval-${process.pid}-same.tmp`), 'utf8')).toBe('other');
    expect(fs.readFileSync(target(), 'utf8')).toBe('y');
  });

  it('gives IO_ERROR when every temp name collides', () => {
    const dir = path.dirname(target());
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(dir, `.approval-${process.pid}-same.tmp`), 'other');
    expect(code(() => publishExclusive(target(), Buffer.from('y'), { root, token: () => 'same' }))).toBe('IO_ERROR');
    expect(fs.readFileSync(path.join(dir, `.approval-${process.pid}-same.tmp`), 'utf8')).toBe('other');
    expect(fs.existsSync(target())).toBe(false);
  });

  it('rejects symlinked ancestors for writes', () => {
    fs.mkdirSync(path.join(root, 'real'));
    fs.symlinkSync('real', path.join(root, 'sub'));
    expect(code(() => publishExclusive(target(), Buffer.from('x'), { root }))).toBe('UNSAFE_PATH');
    expect(fs.readdirSync(path.join(root, 'real'))).toEqual([]);
  });

  it('rejects a target outside the root', () => {
    expect(code(() => publishExclusive(path.join(root, '..', 'escape'), Buffer.from('x'), { root }))).toBe('UNSAFE_PATH');
  });

  describe('crash windows (fault injection)', () => {
    function crashAt(point: FaultPoint): void {
      const fault = (p: FaultPoint) => {
        if (p === point) throw new Error(`crash@${p}`);
      };
      expect(() => publishExclusive(target(), Buffer.from('data'), { root, fault })).toThrow(`crash@${point}`);
    }
    const dir = () => path.dirname(target());

    it('after temp write: no target, temp left', () => {
      crashAt('temp_written');
      expect(fs.existsSync(target())).toBe(false);
      expect(tmps(dir())).toHaveLength(1);
    });
    it('after sync: no target, temp left', () => {
      crashAt('temp_synced');
      expect(fs.existsSync(target())).toBe(false);
      expect(tmps(dir())).toHaveLength(1);
    });
    it('after link: target complete and committed, temp left', () => {
      crashAt('linked');
      expect(fs.readFileSync(target(), 'utf8')).toBe('data');
      expect(tmps(dir())).toHaveLength(1);
    });
    it('during cleanup: unlink failure still counts as committed, with a diagnostic', () => {
      const diags: ApprovalError[] = [];
      const bad = io({ unlinkSync: () => { throw errno('EACCES'); } });
      const r = publishExclusive(target(), Buffer.from('data'), {
        root, io: bad, diagnostic: (e) => diags.push(e),
      });
      expect(r).toBe('created');
      expect(fs.readFileSync(target(), 'utf8')).toBe('data');
      expect(diags).toHaveLength(1);
      expect(diags[0]?.code).toBe('IO_ERROR');
      expect(diags[0]?.message).not.toContain('data');
    });
    it('crash after cleanup (temp_removed): committed, no temp', () => {
      crashAt('temp_removed');
      expect(fs.readFileSync(target(), 'utf8')).toBe('data');
      expect(tmps(dir())).toEqual([]);
    });

    it('re-entry after a crash does not delete other writers temps and sees the committed truth', () => {
      crashAt('linked');
      const leftover = tmps(dir());
      fs.writeFileSync(path.join(dir(), '.approval-999-foreign.tmp'), 'foreign');
      expect(publishExclusive(target(), Buffer.from('data'), { root })).toBe('exists');
      expect(tmps(dir()).sort()).toEqual([...leftover, '.approval-999-foreign.tmp'].sort());
      expect(fs.readFileSync(target(), 'utf8')).toBe('data');
    });

    it('fault hook sees each point in order', () => {
      const seen: FaultPoint[] = [];
      publishExclusive(target(), Buffer.from('x'), { root, fault: (p) => seen.push(p) });
      expect(seen).toEqual(['temp_written', 'temp_synced', 'linked', 'temp_removed']);
    });
  });
});
