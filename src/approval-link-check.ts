import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { type DirIo, defaultDirIo } from './approval-budget.js';
import { ApprovalError } from './approval-error.js';

/**
 * Scratch hard-link probe (plan D8): proves `dir` accepts hard links before enrolled collection
 * relies on `linkSync` publication. Creates one O_EXCL file, links a second unique name to it,
 * and unlinks ONLY the names it created. Diagnostics use two fixed categories and never carry
 * a path, an errno text or agent-controlled data:
 *   UNSUPPORTED_LINK  link failed with ENOTSUP/EOPNOTSUPP/EXDEV/ENOSYS/EPERM (or non-POSIX platform)
 *   IO_ERROR          anything else
 *   UNSAFE_PATH       `dir` or an ancestor below `home` is not a real directory, or is outside `home`
 * Callers pass an EXISTING directory (doctor: the nearest real ancestor of approvals/requests).
 */

export interface LinkCheckDeps {
  readonly io?: DirIo;
  readonly token?: () => string;
  readonly platform?: NodeJS.Platform;
}

const UNSUPPORTED = new Set(['ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'ENOSYS', 'EPERM']);
const codeOf = (e: unknown): string | undefined => (e as NodeJS.ErrnoException | null)?.code;
const io_ = (what: string, e: unknown): ApprovalError =>
  new ApprovalError('IO_ERROR', `Hard-link probe failed: ${what}`, null, { cause: e });

function assertChain(io: DirIo, home: string, dir: string): void {
  const rel = path.relative(home, dir);
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new ApprovalError('UNSAFE_PATH', 'Hard-link probe directory is outside the approval home');
  }
  let cur = home;
  for (const part of ['', ...(rel === '' ? [] : rel.split(path.sep))]) {
    cur = part === '' ? cur : path.join(cur, part);
    let st: fs.Stats;
    try { st = io.lstatSync(cur); } catch (e) { throw io_('lstat', e); }
    if (!st.isDirectory()) throw new ApprovalError('UNSAFE_PATH', 'Hard-link probe path is not a real directory');
  }
}

export function checkApprovalLinks(home: string, dir: string, deps: LinkCheckDeps = {}): void {
  if ((deps.platform ?? process.platform) === 'win32') {
    throw new ApprovalError('UNSUPPORTED_LINK', 'Hard-link probe is not supported on this platform');
  }
  const io = deps.io ?? defaultDirIo;
  assertChain(io, home, dir);
  const id = `${process.pid}-${(deps.token ?? randomUUID)()}`;
  const first = path.join(dir, `.link-probe-${id}.a`);
  const second = path.join(dir, `.link-probe-${id}.b`);
  const c = fs.constants;
  let created = false;
  let linked = false;
  let failure: ApprovalError | undefined;
  try {
    const fd = io.openSync(first, c.O_CREAT | c.O_EXCL | c.O_WRONLY | c.O_NOFOLLOW, 0o600);
    created = true;
    try { io.closeSync(fd); } catch (e) { throw io_('close', e); }
    try {
      io.linkSync(first, second);
      linked = true;
    } catch (e) {
      const code = codeOf(e);
      throw code !== undefined && UNSUPPORTED.has(code)
        ? new ApprovalError('UNSUPPORTED_LINK', 'Hard links are not supported here', null, { cause: e })
        : io_('link', e);
    }
  } catch (e) {
    failure = e instanceof ApprovalError ? e : io_('create', e);
  }
  // Remove only what this call created, whatever happened above.
  for (const [made, file] of [[linked, second], [created, first]] as const) {
    if (!made) continue;
    try { io.unlinkSync(file); } catch (e) { failure ??= io_('cleanup', e); }
  }
  if (failure) throw failure;
}
