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
