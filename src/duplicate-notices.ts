import fs from "node:fs";
import path from "node:path";
import { atomicWrite } from "./fs-util.js";

/** How many distinct sent-again mails of one repeat are announced to the sender before further repeats are set aside silently. */
export const MAX_DUPLICATE_NOTICES = 2;
const FILE = "duplicate-notices.json";

/** Key of one sender's repeat of earlier mail; JSON keeps it unambiguous whatever the names contain. */
export function duplicateNoticeKey(sender: string, repeats: Iterable<[string, string]>): string {
  return JSON.stringify([sender, [...repeats].map(([to, id]) => [to, id]).sort()]);
}
function load(runDir: string): Record<string, string[]> {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(runDir, FILE), "utf8"));
    return data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, string[]>) : {};
  } catch {
    return {};
  }
}
/**
 * Decide whether the repeat found in outbox mail `source` is announced. Idempotent per source: the notified source ids
 * are stored, so a replay after a crash neither counts twice nor loses a notice it already earned.
 */
export function shouldNotifyDuplicate(runDir: string, key: string, source: string): boolean {
  const all = load(runDir);
  const seen = Array.isArray(all[key]) ? all[key] : [];
  if (seen.includes(source)) return true;
  if (seen.length >= MAX_DUPLICATE_NOTICES) return false;
  all[key] = [...seen, source];
  atomicWrite(path.join(runDir, FILE), `${JSON.stringify(all, null, 2)}\n`);
  return true;
}
