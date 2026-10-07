import fs from "node:fs";

/**
 * Append-only run log, one JSON object per line. When the next line would push the file past `maxBytes`
 * (0 = no limit) the file becomes `<name>.1.jsonl`, replacing an older one, and a new file starts.
 */
export function createRunLog(file: string, maxBytes: number): (event: string, data?: Record<string, unknown>) => void {
  let size = fs.existsSync(file) ? fs.statSync(file).size : 0;
  return (event, data = {}) => {
    const line = JSON.stringify({ ts: new Date().toISOString(), event, ...data }) + "\n";
    const bytes = Buffer.byteLength(line);
    if (maxBytes > 0 && size > 0 && size + bytes > maxBytes) {
      fs.renameSync(file, file.replace(/\.jsonl$/, ".1.jsonl"));
      size = 0;
    }
    fs.appendFileSync(file, line);
    size += bytes;
  };
}
