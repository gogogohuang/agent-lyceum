import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type { ResolvedProject } from "./config.js";
import { readRegularFileNoFollow } from "./fs-util.js";
import { recordsDir, recordsKindDir } from "./policy.js";

export type RecordKind = "decisions" | "lessons";
export const RECORD_KINDS: readonly RecordKind[] = ["decisions", "lessons"];

/** Cap of one kind's effective-active entries in a prompt (and, for `done`, the most they may add up to). */
export const RECORDS_BUDGET = 6 * 1024;

const ID_RE = /^[a-z0-9-]+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface ProjectRecord {
  kind: RecordKind;
  id: string;
  file: string;
  status: "active" | "superseded";
  /** `YYYY-MM-DD`; empty when the frontmatter is invalid. */
  date: string;
  run?: string;
  supersedes: string[];
  title: string;
  body: string;
  /** Why the entry could not be read as a record; set entries still count as active so nothing silently disappears. */
  invalid?: string;
}

function parseEntry(kind: RecordKind, file: string): ProjectRecord {
  const id = path.basename(file, ".md");
  const fallback: ProjectRecord = { kind, id, file, status: "active", date: "", supersedes: [], title: path.basename(file), body: "" };
  // Never open a symlink (it could point into .archive/ or outside the tree) or a FIFO/device (it blocks the reader).
  const buf = readRegularFileNoFollow(file);
  if (!buf) return { ...fallback, invalid: "not a readable regular file (symlinks and special files are never read)" };
  const text = buf.toString("utf8");
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n([\s\S]*))?$/.exec(text);
  if (!m) return { ...fallback, body: text.trim(), invalid: "missing frontmatter" };
  const body = (m[2] ?? "").trim();
  let fm: unknown;
  try {
    fm = parseYaml(m[1]!);
  } catch (e) {
    return { ...fallback, body, invalid: `frontmatter is not valid YAML: ${(e as Error).message.split("\n")[0]}` };
  }
  if (!fm || typeof fm !== "object" || Array.isArray(fm)) return { ...fallback, body, invalid: "frontmatter is not a mapping" };
  const f = fm as Record<string, unknown>;
  const problems: string[] = [];
  if (!ID_RE.test(id)) problems.push("file name must be lowercase letters, digits and -");
  if (f.status !== "active" && f.status !== "superseded") problems.push("status must be active or superseded");
  // YAML parses an unquoted 2026-01-02 as a Date.
  const date = f.date instanceof Date ? f.date.toISOString().slice(0, 10) : f.date;
  if (typeof date !== "string" || !DATE_RE.test(date)) problems.push("date must be YYYY-MM-DD");
  if (typeof f.title !== "string" || !f.title.trim() || /[\r\n]/.test(f.title.trim())) problems.push("title must be one non-empty line");
  let supersedes: string[] = [];
  if (f.supersedes !== undefined) {
    if (Array.isArray(f.supersedes) && f.supersedes.every((x) => typeof x === "string")) supersedes = f.supersedes as string[];
    else problems.push("supersedes must be a list of ids");
  }
  if (f.run !== undefined && typeof f.run !== "string") problems.push("run must be a string");
  if (problems.length) return { ...fallback, body, invalid: problems.join("; ") };
  return {
    kind,
    id,
    file,
    status: f.status as "active" | "superseded",
    date: date as string,
    run: f.run as string | undefined,
    supersedes,
    title: (f.title as string).trim(),
    body,
  };
}

/** Every `*.md` entry of one kind, sorted by id. Entries that cannot be parsed are listed with `invalid` set; a missing folder is an empty list. */
export function listRecords(project: ResolvedProject, kind: RecordKind): ProjectRecord[] {
  const dir = recordsKindDir(project, kind);
  let names: string[];
  try {
    // A symlinked records/ or kind folder could point at archived or outside entries: list nothing, never descend.
    for (const d of [recordsDir(project), dir]) if (!fs.lstatSync(d).isDirectory()) return [];
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((n) => n.endsWith(".md"))
    .sort()
    .map((n) => parseEntry(kind, path.join(dir, n)));
}

/** Entries shown in prompts: `status: active` and not named in another entry's `supersedes`. */
export function effectiveActive(records: ProjectRecord[]): ProjectRecord[] {
  const replaced = new Set<string>();
  for (const r of records) for (const id of r.supersedes) if (id !== r.id) replaced.add(id);
  return records.filter((r) => r.status === "active" && !replaced.has(r.id));
}

function newestFirst(records: ProjectRecord[]): ProjectRecord[] {
  return [...records].sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id));
}

function renderEntry(r: ProjectRecord): string {
  return `## ${r.title} [${r.id}]${r.body ? `\n${r.body}` : ""}`;
}

/** Bytes the effective-active entries of a kind take in a prompt (each rendered whole, as `buildRecordsView` does). */
export function activeRecordsBytes(project: ResolvedProject, kind: RecordKind): number {
  return Buffer.byteLength(effectiveActive(listRecords(project, kind)).map(renderEntry).join("\n\n"));
}

/**
 * The text of one kind for a prompt: effective-active entries, newest first, whole entries only until the budget is
 * used (never cut inside one); the rest are one line each, to read on demand. Undefined when there is nothing to show.
 */
export function buildRecordsView(project: ResolvedProject, kind: RecordKind, budgetBytes: number = RECORDS_BUDGET): string | undefined {
  const entries = newestFirst(effectiveActive(listRecords(project, kind)));
  if (entries.length === 0) return undefined;
  const shown: string[] = [];
  let used = 0;
  let i = 0;
  for (; i < entries.length; i++) {
    const text = renderEntry(entries[i]!);
    const size = Buffer.byteLength(text) + (shown.length ? 2 : 0);
    if (used + size > budgetBytes) break;
    shown.push(text);
    used += size;
  }
  const rest = entries.slice(i);
  const parts = [...shown];
  if (rest.length) {
    parts.push(
      `${shown.length ? "More" : "These"} active entries did not fit in ${budgetBytes} bytes; read the file on demand:`,
      rest.map((r) => `- [${r.id}] ${r.title} (read: ${r.file})`).join("\n"),
    );
  }
  return parts.join("\n\n");
}
