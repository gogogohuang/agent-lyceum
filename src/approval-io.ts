import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ApprovalError } from './approval-error.js';

/** Injectable fs surface (S3). `renameSync` is listed so tests can prove it is never called. */
export type ApprovalIo = Pick<typeof fs, 'lstatSync' | 'mkdirSync' | 'openSync' | 'fstatSync' |
  'readSync' | 'writeSync' | 'fsyncSync' | 'closeSync' | 'linkSync' | 'unlinkSync' | 'renameSync' |
  'readdirSync'>;
export const defaultApprovalIo: ApprovalIo = fs;

export type FaultPoint = 'temp_written' | 'temp_synced' | 'linked' | 'temp_removed';

export interface PublishDeps {
  /** Canonical, trusted root (the approval home). Every component below it is lstat-checked. */
  readonly root: string;
  readonly io?: ApprovalIo;
  /** Random token for temp names; default crypto.randomUUID. */
  readonly token?: () => string;
  /** Called after each step; a throw simulates a process crash at that point. */
  readonly fault?: (point: FaultPoint) => void;
  /** Receives non-fatal problems (cleanup failure after a successful link). */
  readonly diagnostic?: (error: ApprovalError) => void;
}

const MAX_TEMP_TRIES = 8;
const UNSUPPORTED_LINK_ERRNOS = new Set(['ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'ENOSYS']);

function codeOf(e: unknown): string | undefined {
  return (e as NodeJS.ErrnoException | null)?.code;
}
function ioError(what: string, file: string, e: unknown): ApprovalError {
  return new ApprovalError('IO_ERROR', `${what} failed (${codeOf(e) ?? 'unknown'}): ${file}`, file, { cause: e });
}

/** Components of `target`'s parent below `root`, each prefix as an absolute path. Rejects escapes. */
function ancestorsBelow(root: string, target: string): string[] {
  const rel = path.relative(root, path.dirname(target));
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel) || target === root) {
    throw new ApprovalError('UNSAFE_PATH', 'Approval path is outside its root', target);
  }
  const out: string[] = [];
  let cur = root;
  for (const part of rel === '' ? [] : rel.split(path.sep)) {
    cur = path.join(cur, part);
    out.push(cur);
  }
  return out;
}

function assertRealDir(io: ApprovalIo, dir: string): void {
  const st = io.lstatSync(dir);
  if (!st.isDirectory()) {
    throw new ApprovalError('UNSAFE_PATH', 'Approval path component is not a real directory (symlink?)', dir);
  }
}

/** Read-side ancestor check; returns false if an ancestor is missing (file is then absent). */
function ancestorsExist(io: ApprovalIo, root: string, file: string): boolean {
  for (const dir of ancestorsBelow(root, file)) {
    try {
      assertRealDir(io, dir);
    } catch (e) {
      if (e instanceof ApprovalError) throw e;
      if (codeOf(e) === 'ENOENT') return false;
      throw ioError('lstat', dir, e);
    }
  }
  return true;
}

/**
 * Safe bounded read. Returns null ONLY when the file (or an ancestor below `root`) does not
 * exist (ENOENT). Rejects symlinks, non-regular files (FIFO/dir/socket/device), content over
 * `limit` bytes, invalid UTF-8, and files swapped while reading. Never blocks on a FIFO.
 * `root` is REQUIRED: the canonical approval home; every component between it and the file is
 * lstat-checked, and a file outside it is rejected. A same-UID attacker replacing ancestors concurrently is not covered.
 */
export function readApprovalFile(file: string, limit: number, root: string,
  io: ApprovalIo = defaultApprovalIo): Buffer | null {
  if (!ancestorsExist(io, root, file)) return null;
  const c = fs.constants;
  let fd: number;
  try {
    fd = io.openSync(file, c.O_RDONLY | c.O_NOFOLLOW | c.O_NONBLOCK);
  } catch (e) {
    const code = codeOf(e);
    if (code === 'ENOENT') return null;
    if (code === 'ELOOP') throw new ApprovalError('UNSAFE_PATH', 'Approval file is a symlink', file, { cause: e });
    throw ioError('open', file, e);
  }
  let buf: Buffer;
  let before: fs.Stats;
  try {
    before = io.fstatSync(fd);
    if (!before.isFile()) throw new ApprovalError('UNSAFE_PATH', 'Approval file is not a regular file', file);
    if (before.size > limit) throw new ApprovalError('CORRUPT_RECORD', `Approval file exceeds ${limit} bytes`, file);
    const chunk = Buffer.alloc(limit + 1);
    let total = 0;
    for (;;) {
      const n = io.readSync(fd, chunk, total, chunk.length - total, null);
      if (n === 0) break;
      total += n;
      if (total > limit) throw new ApprovalError('CORRUPT_RECORD', `Approval file exceeds ${limit} bytes`, file);
    }
    buf = Buffer.from(chunk.subarray(0, total));
  } catch (e) {
    try { io.closeSync(fd); } catch { /* original error wins */ }
    throw e instanceof ApprovalError ? e : ioError('read', file, e);
  }
  try {
    io.closeSync(fd);
  } catch (e) {
    throw ioError('close', file, e);
  }
  let after: fs.Stats;
  try {
    after = io.lstatSync(file);
  } catch (e) {
    throw new ApprovalError('UNSAFE_PATH', 'Approval file changed while being read', file, { cause: e });
  }
  if (!after.isFile() || after.dev !== before.dev || after.ino !== before.ino) {
    throw new ApprovalError('UNSAFE_PATH', 'Approval file changed while being read', file);
  }
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch (e) {
    throw new ApprovalError('CORRUPT_RECORD', 'Approval file is not valid UTF-8', file, { cause: e });
  }
  return buf;
}

/** mkdir 0700 each missing component below root; existing ones must be real directories. */
function ensureDirs(io: ApprovalIo, root: string, target: string): void {
  const dirs = ancestorsBelow(root, target);
  try {
    assertRealDir(io, root);
  } catch (e) {
    if (e instanceof ApprovalError) throw e;
    throw ioError('lstat', root, e);
  }
  for (const dir of dirs) {
    try {
      io.mkdirSync(dir, { mode: 0o700 });
    } catch (e) {
      if (codeOf(e) !== 'EEXIST') throw ioError('mkdir', dir, e);
    }
    try {
      assertRealDir(io, dir);
    } catch (e) {
      if (e instanceof ApprovalError) throw e;
      throw ioError('lstat', dir, e);
    }
  }
}

/**
 * Exclusive immutable publication: O_EXCL temp (0400) in the target's directory, write, fsync,
 * `linkSync` to the target, unlink own temp. "exists" means another writer committed first and
 * the caller must re-read. Link failures are fail-closed errors; there is NEVER a rename
 * fallback. Failure before the link leaves nothing committed (own temp is removed unless the
 * failure is a simulated crash from `fault`); a failure after the link still returns
 * "created" and reports cleanup problems through `diagnostic`.
 */
export function publishExclusive(file: string, bytes: Buffer, deps: PublishDeps): 'created' | 'exists' {
  const io = deps.io ?? defaultApprovalIo;
  const token = deps.token ?? randomUUID;
  const dir = path.dirname(file);
  ensureDirs(io, deps.root, file);

  const c = fs.constants;
  let tmp = '';
  let fd = -1;
  for (let i = 0; ; i++) {
    if (i >= MAX_TEMP_TRIES) {
      throw new ApprovalError('IO_ERROR', `Could not create a unique temp file in ${dir}`, dir);
    }
    tmp = path.join(dir, `.approval-${process.pid}-${token()}.tmp`);
    try {
      fd = io.openSync(tmp, c.O_CREAT | c.O_EXCL | c.O_WRONLY | c.O_NOFOLLOW, 0o400);
      break;
    } catch (e) {
      if (codeOf(e) !== 'EEXIST') throw ioError('create temp', tmp, e);
    }
  }
  const removeTemp = (): void => {
    try { io.unlinkSync(tmp); } catch (e) {
      if (codeOf(e) !== 'ENOENT') deps.diagnostic?.(ioError('remove temp', tmp, e));
    }
  };

  try {
    let off = 0;
    while (off < bytes.length) {
      const n = io.writeSync(fd, bytes, off, bytes.length - off);
      if (n <= 0) throw new ApprovalError('IO_ERROR', `Short write of 0 bytes to ${tmp}`, tmp);
      off += n;
    }
  } catch (e) {
    try { io.closeSync(fd); } catch { /* original error wins */ }
    removeTemp();
    throw e instanceof ApprovalError ? e : ioError('write temp', tmp, e);
  }
  deps.fault?.('temp_written');
  let closed = false;
  try {
    io.fsyncSync(fd);
    closed = true; // closeSync releases the fd even when it throws; never close twice
    io.closeSync(fd);
  } catch (e) {
    if (!closed) { try { io.closeSync(fd); } catch { /* original error wins */ } }
    removeTemp();
    throw ioError('fsync temp', tmp, e);
  }
  deps.fault?.('temp_synced');

  try {
    io.linkSync(tmp, file);
  } catch (e) {
    removeTemp();
    const code = codeOf(e);
    if (code === 'EEXIST') return 'exists';
    if (code !== undefined && UNSUPPORTED_LINK_ERRNOS.has(code)) {
      throw new ApprovalError('UNSUPPORTED_LINK',
        `Filesystem does not support hard links (${code}); approvals need linkSync: ${dir}`, file, { cause: e });
    }
    throw new ApprovalError('IO_ERROR',
      `Hard link failed (${code ?? 'unknown'}); check hard-link support and permissions: ${dir}`, file, { cause: e });
  }
  deps.fault?.('linked');
  removeTemp();
  deps.fault?.('temp_removed');
  return 'created';
}
