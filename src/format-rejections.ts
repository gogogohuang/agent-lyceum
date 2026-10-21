import fs from "node:fs";
import path from "node:path";
import { atomicWrite } from "./fs-util.js";

/** How many times one sender's mail (same type and subject) is sent back for missing sections before it is delivered with a warning instead. */
export const MAX_FORMAT_REJECTIONS = 2;
const FILE = "format-rejections.json";
export function formatRejectionKey(from: string, type: string, subject: string): string {
  return `${from}|${type}|${subject.trim().toLowerCase()}`;
}
function load(runDir: string): Record<string, number> {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(runDir, FILE), "utf8"));
    return data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, number>) : {};
  } catch {
    return {};
  }
}
export function formatRejections(runDir: string, key: string): number {
  return load(runDir)[key] ?? 0;
}
/** Record one more rejection for `key` and return the new count. */
export function countFormatRejection(runDir: string, key: string): number {
  const all = load(runDir);
  const n = (all[key] ?? 0) + 1;
  all[key] = n;
  atomicWrite(path.join(runDir, FILE), `${JSON.stringify(all, null, 2)}\n`);
  return n;
}
