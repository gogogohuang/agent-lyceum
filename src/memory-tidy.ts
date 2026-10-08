import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ResolvedProject } from "./config.js";

export type Layer = "project" | "global";
export const ARCHIVE_DIR = ".archive";
export const TIDY_STATE_FILE = ".tidy-state.json";
export const TIDY_REPORT_FILE = "tidy-report.md";
export const STAMP_RE = /^\d{8}T\d{6}Z$/;

/** `20261008T031500Z`: UTC, sortable, safe in a file name. */
export const tidyStamp = (d: Date = new Date()): string => d.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");

export interface MemoryTarget {
  agent: string;
  layer: Layer;
  dir: string;
}

/** The memory directories to tidy. Without `agent`, every agent that has a directory for the layer; with it, that agent or an error. */
export function targetsFor(project: ResolvedProject, opts: { layer: Layer; agent?: string }): MemoryTarget[] {
  const pick = (name: string): MemoryTarget | undefined => {
    const dir = project.agents[name]?.memory[opts.layer];
    return dir ? { agent: name, layer: opts.layer, dir } : undefined;
  };
  if (opts.agent) {
    if (!project.agents[opts.agent]) throw new Error(`No agent "${opts.agent}" in project ${project.name}. Agents: ${Object.keys(project.agents).join(", ")}.`);
    const t = pick(opts.agent);
    if (!t) throw new Error(`Agent "${opts.agent}" has no ${opts.layer} memory directory.`);
    return [t];
  }
  return Object.keys(project.agents).flatMap((n) => pick(n) ?? []);
}

export interface MemoryFile {
  rel: string;
  bytes: number;
  mtime: string;
}

function walk(dir: string, base: string, out: MemoryFile[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, base, out);
    else if (e.isFile()) {
      const rel = path.relative(base, full).split(path.sep).join("/");
      if (rel === TIDY_STATE_FILE) continue;
      const st = fs.statSync(full);
      out.push({ rel, bytes: st.size, mtime: st.mtime.toISOString() });
    }
  }
}

/** Every file under `dir` (the archive included, the state file not), `/`-separated and sorted. */
export function listMemoryFiles(dir: string): MemoryFile[] {
  const out: MemoryFile[] = [];
  walk(dir, dir, out);
  return out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
}

export interface MemoryStats {
  files: number;
  bytes: number;
  indexBytes: number;
  oldest?: string;
  newest?: string;
}

/** Size and age of the live files (the archive is not counted). */
export function memoryStats(dir: string): MemoryStats {
  const live = listMemoryFiles(dir).filter((f) => !f.rel.startsWith(`${ARCHIVE_DIR}/`));
  const times = live.map((f) => f.mtime).sort();
  return {
    files: live.length,
    bytes: live.reduce((n, f) => n + f.bytes, 0),
    indexBytes: live.find((f) => f.rel === "MEMORY.md")?.bytes ?? 0,
    oldest: times[0],
    newest: times.at(-1),
  };
}

/** Content hash of every file (the archive included), to tell whether a directory changed. */
export function fingerprint(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of listMemoryFiles(dir)) out[f.rel] = crypto.createHash("sha256").update(fs.readFileSync(path.join(dir, f.rel))).digest("hex");
  return out;
}

const slot = (into: string, i: number) => path.join(into, String(i));

/** Copy each directory aside (a directory that does not exist is remembered as absent). */
export function snapshotDirs(dirs: string[], into: string): void {
  fs.rmSync(into, { recursive: true, force: true });
  fs.mkdirSync(into, { recursive: true });
  dirs.forEach((d, i) => {
    if (fs.existsSync(d)) fs.cpSync(d, slot(into, i), { recursive: true });
  });
}

/** Put each directory back as `snapshotDirs` saw it, removing whatever was added since. */
export function restoreDirs(dirs: string[], from: string): void {
  dirs.forEach((d, i) => {
    fs.rmSync(d, { recursive: true, force: true });
    if (fs.existsSync(slot(from, i))) fs.cpSync(slot(from, i), d, { recursive: true });
  });
}

/**
 * Nothing may disappear: every file that existed before is still in place, or archived under the same relative
 * path in this tidy's archive folder. Earlier archives must stay as they were; MEMORY.md is never archived.
 */
export function verifyConservation(before: string[], dir: string, stamp: string): string[] {
  const problems: string[] = [];
  for (const rel of before) {
    const here = fs.existsSync(path.join(dir, rel));
    if (here) continue;
    const inArchive = !rel.startsWith(`${ARCHIVE_DIR}/`) && rel !== "MEMORY.md" && fs.existsSync(path.join(dir, ARCHIVE_DIR, stamp, rel));
    if (!inArchive) problems.push(rel === "MEMORY.md" ? `MEMORY.md is missing (the index must stay in place)` : `${rel} is gone: it is neither in place nor under ${ARCHIVE_DIR}/${stamp}/`);
  }
  return problems;
}
