import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { realInvoker, type Invoker } from "./adapters/index.js";
import type { ResolvedProject } from "./config.js";
import { atomicWrite } from "./fs-util.js";
import { ensureProjectDirs } from "./mailbox.js";
import { memoryDirs } from "./policy.js";
import { buildTidyPrompts } from "./prompt.js";
import { git, isGitRepo } from "./worktree.js";

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

// ---- baseline: where the project stood at the last tidy ----

export interface TidyState {
  /** HEAD of the project repo when the last tidy finished. */
  head?: string;
  at: string;
  /** The archive folder of that tidy. */
  archive?: string;
}

export function readTidyState(dir: string): TidyState | undefined {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dir, TIDY_STATE_FILE), "utf8")) as TidyState;
    return j && typeof j === "object" && typeof j.at === "string" ? j : undefined;
  } catch {
    return undefined;
  }
}

export function writeTidyState(dir: string, st: TidyState): void {
  atomicWrite(path.join(dir, TIDY_STATE_FILE), JSON.stringify(st, null, 2));
}

// ---- what changed in the project since then ----

export interface ProjectChanges {
  head?: string;
  since?: string;
  log: string[];
  stat: string[];
  note?: string;
}

const LOG_LINES = 50;
const STAT_LINES = 40;

function tryGit(cwd: string, args: string[]): string | undefined {
  try {
    return git(cwd, args);
  } catch {
    return undefined;
  }
}

const lines = (s: string | undefined): string[] => (s ? s.split("\n").filter(Boolean) : []);

export function projectChanges(repoDir: string, since?: string): ProjectChanges {
  if (!fs.existsSync(repoDir) || !isGitRepo(repoDir)) return { log: [], stat: [], note: "the project directory is not a git repository" };
  const head = tryGit(repoDir, ["rev-parse", "HEAD"]);
  if (!head) return { log: [], stat: [], note: "the repository has no commits yet" };
  if (!since) return { head, log: [], stat: [], note: "first tidy: there is no earlier baseline, only the path check applies" };
  if (since === head) return { head, since, log: [], stat: [], note: "no commits since the last tidy" };
  if (tryGit(repoDir, ["cat-file", "-t", `${since}^{commit}`]) !== "commit") return { head, since, log: [], stat: [], note: "the baseline commit of the last tidy no longer exists in this repository (history was rewritten?)" };
  const log = lines(tryGit(repoDir, ["log", "--oneline", "--no-decorate", `${since}..${head}`]));
  const stat = lines(tryGit(repoDir, ["diff", "--stat", since, head]));
  return {
    head,
    since,
    log: log.length > LOG_LINES ? [...log.slice(0, LOG_LINES), `… and ${log.length - LOG_LINES} more commits`] : log,
    stat: stat.length > STAT_LINES ? [...stat.slice(0, STAT_LINES - 1), stat.at(-1) ?? ""] : stat,
  };
}

// ---- paths the memory mentions that are gone ----

export interface MissingPath {
  file: string;
  path: string;
}

const PATH_TOKEN = /`([^`\n]+)`/g;

function looksLikePath(t: string): boolean {
  if (!t.includes("/") || /\s/.test(t) || t.includes("://")) return false;
  if (/^-|[*?{}<>$|;&=]/.test(t)) return false;
  return true;
}

/** Backticked paths in the live Markdown files of `dir` that do not exist. Relative ones are looked up in `repoDir` (skipped without it). */
export function findMissingPaths(dir: string, repoDir: string | undefined): MissingPath[] {
  const seen = new Set<string>();
  const out: MissingPath[] = [];
  for (const f of listMemoryFiles(dir)) {
    if (f.rel.startsWith(`${ARCHIVE_DIR}/`) || !f.rel.endsWith(".md")) continue;
    const text = fs.readFileSync(path.join(dir, f.rel), "utf8");
    for (const m of text.matchAll(PATH_TOKEN)) {
      const tok = (m[1] ?? "").trim();
      if (!looksLikePath(tok)) continue;
      const abs = tok.startsWith("~/") ? path.join(os.homedir(), tok.slice(2)) : path.isAbsolute(tok) ? tok : repoDir ? path.join(repoDir, tok) : undefined;
      if (!abs || fs.existsSync(abs)) continue;
      const key = `${f.rel}\0${tok}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ file: f.rel, path: tok });
    }
  }
  return out;
}

export interface TidyOptions {
  project: ResolvedProject;
  layer: Layer;
  agent?: string;
  dryRun?: boolean;
  invoker?: Invoker;
  signal?: AbortSignal;
  say?: (line: string) => void;
  now?: () => Date;
}

export interface TidyResult {
  agent: string;
  layer: Layer;
  dir: string;
  status: "tidied" | "skipped" | "failed" | "dry-run";
  /** The archive stamp of a finished tidy. */
  archive?: string;
  problems: string[];
}

/** Scratch space of one tidy (snapshot and the invocation's logs); outside every memory dir and every run. */
export const tidyWorkDir = (project: ResolvedProject, stamp: string, agent: string): string => path.join(project.paths.root, "tidy-work", stamp, agent);

const kb = (n: number): string => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KiB`);

function describeTarget(t: MemoryTarget, project: ResolvedProject, say: (l: string) => void): void {
  const s = memoryStats(t.dir);
  say(`${t.agent} (${t.layer}): ${s.files} file(s), ${kb(s.bytes)}, MEMORY.md ${kb(s.indexBytes)}${s.oldest ? `, modified ${s.oldest.slice(0, 10)} … ${s.newest?.slice(0, 10)}` : ""}`);
  if (t.layer === "project") {
    const c = projectChanges(project.dir, readTidyState(t.dir)?.head);
    say(`  project changes: ${c.note ?? `${c.log.length} commit(s) since ${c.since?.slice(0, 8)}`}`);
  }
  for (const m of findMissingPaths(t.dir, t.layer === "project" ? project.dir : undefined)) say(`  missing path: ${m.path} (in ${m.file})`);
}

async function tidyOne(o: TidyOptions, t: MemoryTarget, stamp: string): Promise<TidyResult> {
  const { project } = o;
  const say = o.say ?? ((s: string) => console.log(s));
  const base = { agent: t.agent, layer: t.layer, dir: t.dir };
  const agent = project.agents[t.agent]!;
  const live = listMemoryFiles(t.dir).filter((f) => !f.rel.startsWith(`${ARCHIVE_DIR}/`));
  if (live.length === 0) return { ...base, status: "skipped", problems: ["no memory files: nothing to tidy"] };

  const dirs = memoryDirs(agent);
  const others = dirs.filter((d) => d !== t.dir);
  const before = listMemoryFiles(t.dir).map((f) => f.rel);
  const othersBefore = others.map((d) => fingerprint(d));
  const archiveDir = path.join(t.dir, ARCHIVE_DIR, stamp);
  const workDir = tidyWorkDir(project, stamp, t.agent);
  const snapshot = path.join(workDir, "snapshot");
  const state = readTidyState(t.dir);
  const changes = t.layer === "project" ? projectChanges(project.dir, state?.head) : undefined;
  const missing = findMissingPaths(t.dir, t.layer === "project" ? project.dir : undefined);
  const index = fs.existsSync(path.join(t.dir, "MEMORY.md")) ? fs.readFileSync(path.join(t.dir, "MEMORY.md"), "utf8") : "";
  const prompts = buildTidyPrompts(agent, { layer: t.layer, dir: t.dir, archiveDir, files: live, index, changes, missing });

  ensureProjectDirs(project);
  snapshotDirs(dirs, snapshot);
  const fail = (problems: string[]): TidyResult => {
    restoreDirs(dirs, snapshot);
    fs.rmSync(snapshot, { recursive: true, force: true });
    return { ...base, status: "failed", problems };
  };

  say(`tidying ${t.layer} memory of ${t.agent} (${live.length} file(s)) …`);
  const invoke = o.invoker ?? realInvoker;
  const result = await invoke({
    project,
    agent,
    workDir,
    systemPrompt: prompts.systemPrompt,
    userPrompt: prompts.userPrompt,
    timeoutSec: project.dispatcher.wake_timeout_sec,
    signal: o.signal,
    logDir: path.join(workDir, "log"),
  }).catch((e: Error) => ({ ok: false, text: "", exitCode: null, timedOut: false, error: e.message }));
  if (!result.ok) return fail([`the wake-up failed: ${result.error ?? "unknown error"}`]);

  const problems: string[] = [];
  others.forEach((d, i) => {
    if (JSON.stringify(fingerprint(d)) !== JSON.stringify(othersBefore[i])) problems.push(`the agent changed ${d}, which is not the ${t.layer} memory being tidied`);
  });
  problems.push(...verifyConservation(before, t.dir, stamp));
  const reportFile = path.join(archiveDir, TIDY_REPORT_FILE);
  if (!fs.existsSync(reportFile) || fs.readFileSync(reportFile, "utf8").trim() === "") problems.push(`${ARCHIVE_DIR}/${stamp}/${TIDY_REPORT_FILE} is missing or empty`);
  if (problems.length) return fail(problems);

  fs.rmSync(snapshot, { recursive: true, force: true });
  writeTidyState(t.dir, { ...(changes?.head ? { head: changes.head } : {}), at: (o.now?.() ?? new Date()).toISOString(), archive: stamp });
  return { ...base, status: "tidied", archive: stamp, problems: [] };
}

/** Tidy the memory of the chosen agents, one after another. Only ever called by a person (`agent-lyceum memory tidy`). */
export async function tidyMemory(o: TidyOptions): Promise<TidyResult[]> {
  const say = o.say ?? ((s: string) => console.log(s));
  const targets = targetsFor(o.project, { layer: o.layer, agent: o.agent });
  const results: TidyResult[] = [];
  for (const t of targets) {
    if (o.dryRun) {
      describeTarget(t, o.project, say);
      results.push({ agent: t.agent, layer: t.layer, dir: t.dir, status: "dry-run", problems: [] });
      continue;
    }
    const r = await tidyOne(o, t, tidyStamp(o.now?.()));
    results.push(r);
    if (o.signal?.aborted) break;
  }
  return results;
}

export interface RestoreResult {
  restored: string[];
  skipped: { rel: string; reason: string }[];
}

function titleOf(file: string, rel: string): string {
  const text = fs.readFileSync(file, "utf8");
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const name = fm ? /^name:\s*(.+)$/m.exec(fm[1] ?? "")?.[1]?.trim() : undefined;
  if (name) return name;
  const h = /^#\s+(.+)$/m.exec(text)?.[1]?.trim();
  return h || path.basename(rel, path.extname(rel));
}

function pruneEmpty(dir: string, stop: string): void {
  for (let d = dir; d !== stop && d.startsWith(stop + path.sep); d = path.dirname(d)) {
    if (fs.readdirSync(d).length) break;
    fs.rmdirSync(d);
  }
}

/** Move the files of one tidy's archive back to where they were. Nothing that exists now is overwritten. */
export function restoreMemory(o: { project: ResolvedProject; agent: string; layer: Layer; stamp: string }): RestoreResult {
  if (!STAMP_RE.test(o.stamp)) throw new Error(`"${o.stamp}" is not an archive stamp (expected something like 20261008T031500Z).`);
  const [t] = targetsFor(o.project, { layer: o.layer, agent: o.agent });
  const archive = path.join(t!.dir, ARCHIVE_DIR, o.stamp);
  if (!fs.existsSync(archive)) throw new Error(`No archive ${o.stamp} for ${o.agent} (${o.layer}). Archives: ${listArchives(t!.dir).join(", ") || "(none)"}.`);

  const restored: string[] = [];
  const skipped: RestoreResult["skipped"] = [];
  const inArchive = listMemoryFiles(archive).filter((f) => f.rel !== TIDY_REPORT_FILE);
  for (const f of inArchive) {
    const from = path.join(archive, f.rel);
    const to = path.join(t!.dir, f.rel);
    if (fs.existsSync(to)) {
      skipped.push({ rel: f.rel, reason: "a file with this name exists now; it was not overwritten" });
      continue;
    }
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.renameSync(from, to);
    pruneEmpty(path.dirname(from), archive);
    restored.push(f.rel);
  }

  const indexFile = path.join(t!.dir, "MEMORY.md");
  const index = fs.existsSync(indexFile) ? fs.readFileSync(indexFile, "utf8") : "";
  const add = restored.filter((rel) => rel.endsWith(".md") && !index.includes(rel)).map((rel) => `- [${titleOf(path.join(t!.dir, rel), rel)}](${rel}) — restored from tidy ${o.stamp}`);
  if (add.length) atomicWrite(indexFile, `${index.replace(/\n*$/, index ? "\n" : "")}${add.join("\n")}\n`);
  return { restored, skipped };
}

/** The stamps of the archives in a memory directory, oldest first. */
export function listArchives(dir: string): string[] {
  try {
    return fs.readdirSync(path.join(dir, ARCHIVE_DIR)).filter((n) => STAMP_RE.test(n)).sort();
  } catch {
    return [];
  }
}
