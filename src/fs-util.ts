import fs from "node:fs";
import path from "node:path";

/** Atomic write: temp file in the same dir, then rename. */
export function atomicWrite(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

/** Is `cmd` an executable file in one of the PATH directories? (No `which`: it may be missing in slim containers.) */
export function findOnPath(cmd: string, pathVar: string = process.env.PATH ?? ""): boolean {
  return pathVar
    .split(path.delimiter)
    .filter(Boolean)
    .some((d) => {
      try {
        fs.accessSync(path.join(d, cmd), fs.constants.X_OK);
        return true;
      } catch {
        return false;
      }
    });
}

/**
 * Up to `limit` bytes of a regular file (symlinks to one are followed), and whether there was more.
 * undefined for anything else (missing, a directory, a FIFO, a device) or on any error: never throws, never reads a huge file whole.
 */
export function readFileCapped(file: string, limit: number): { text: string; truncated: boolean } | undefined {
  let fd: number | undefined;
  try {
    if (!fs.statSync(file).isFile()) return undefined;
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0));
    if (!fs.fstatSync(fd).isFile()) return undefined;
    const buf = Buffer.alloc(limit + 1);
    let n = 0;
    while (n < buf.length) {
      const r = fs.readSync(fd, buf, n, buf.length - n, n);
      if (r === 0) break;
      n += r;
    }
    if (n <= limit) return { text: buf.subarray(0, n).toString("utf8"), truncated: false };
    return { text: buf.subarray(0, limit).toString("utf8"), truncated: true };
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }
}

/**
 * The bytes of a regular file, opened without following a symlink and without blocking (a FIFO opens at once and fails the
 * fstat check). undefined for anything else or on any error: never throws, never hangs.
 */
export function readRegularFileNoFollow(file: string): Buffer | undefined {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
    if (!fs.fstatSync(fd).isFile()) return undefined;
    return fs.readFileSync(fd);
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }
}

/** `buf` cut to at most `limit` bytes, backed up to a character boundary so a multi-byte character is never split. */
export function cutUtf8(buf: Buffer, limit: number): Buffer {
  if (buf.length <= limit) return buf;
  let cut = limit;
  while (cut > 0 && ((buf[cut] ?? 0) & 0xc0) === 0x80) cut--;
  return buf.subarray(0, cut);
}

/** `buf` without a trailing incomplete UTF-8 sequence (a cut-off lead byte and its continuation bytes). */
export function trimPartialUtf8(buf: Buffer): Buffer {
  for (let i = 1; i <= Math.min(3, buf.length); i++) {
    const b = buf[buf.length - i] as number;
    if ((b & 0xc0) === 0x80) continue;
    const need = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc0 ? 2 : 1;
    return need > i ? buf.subarray(0, buf.length - i) : buf;
  }
  return buf;
}

export type CappedRead = { ok: true; buf: Buffer; size: number; truncated: boolean } | { ok: false; reason: string };

/**
 * Up to `limit` bytes of a regular file, opened without following a symlink and without blocking; reads at most `limit + 1` bytes.
 * `size` is the file's size from fstat. Never throws: a refusal says why, from the one open (`symlink`, `not_regular`, `open_error:<code>`).
 */
export function readRegularFileCappedNoFollow(file: string, limit: number): CappedRead {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return { ok: false, reason: "not_regular" };
    const buf = Buffer.alloc(limit + 1);
    let n = 0;
    while (n < buf.length) {
      const r = fs.readSync(fd, buf, n, buf.length - n, n);
      if (r === 0) break;
      n += r;
    }
    return { ok: true, buf: buf.subarray(0, Math.min(n, limit)), size: st.size, truncated: n > limit };
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code ?? "unknown";
    return { ok: false, reason: code === "ELOOP" ? "symlink" : `open_error:${code}` };
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }
}
