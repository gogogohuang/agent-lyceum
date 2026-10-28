import fs from "node:fs";
import path from "node:path";

export const WATCH_RESTART_EXIT = 75;
export const WATCH_RESTART_MESSAGE = "status --watch: agent-lyceum code changed on disk; restart to load it";

/** Sorted relative paths, sizes and mtimes; unreadable trees never trigger a restart. */
export function codeFingerprint(dir: string, ext: string): string {
  const files: string[] = [];
  function visit(relative: string): void {
    for (const entry of fs.readdirSync(path.join(dir, relative), { withFileTypes: true })) {
      const rel = path.join(relative, entry.name);
      if (entry.isDirectory()) visit(rel);
      else if (entry.isFile() && path.extname(entry.name) === ext) {
        const stat = fs.statSync(path.join(dir, rel));
        files.push(`${rel}:${stat.size}:${stat.mtimeMs}`);
      }
    }
  }
  try {
    visit("");
    return files.sort().join("\n");
  } catch {
    return "";
  }
}

/** Two equal reads debounce changes; they do not establish build completion. */
export function watchCodeChange(read: () => string): () => boolean {
  const initial = read();
  let previous = initial;
  return () => {
    const current = read();
    const changed = current !== "" && current !== initial && current === previous;
    previous = current;
    return changed;
  };
}
