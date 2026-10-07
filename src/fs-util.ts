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
