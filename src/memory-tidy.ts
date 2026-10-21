import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { realInvoker, type Invoker } from "./adapters/index.js";
import type { ResolvedProject } from "./config.js";
import { atomicWrite } from "./fs-util.js";
import { ensureProjectDirs } from "./mailbox.js";
import { commonFile, memoryDirs, recordsDir, repoDirFor, writePolicy, type WritePolicy } from "./policy.js";
import { buildTidyPrompts, MEMORY_INDEX_LIMIT, type TidyRecordsContext } from "./prompt.js";
import { activeRecordsBytes, effectiveActive, listRecords, RECORD_KINDS, RECORDS_BUDGET } from "./records.js";
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

/** The content hashes of every earlier tidy's archive in `dir` (not this tidy's own folder), which no tidy may touch. */
function earlierArchives(dir: string, stamp: string): Record<string, string> {
  return Object.fromEntries(Object.entries(fingerprint(dir)).filter(([rel]) => rel.startsWith(`${ARCHIVE_DIR}/`) && !rel.startsWith(`${ARCHIVE_DIR}/${stamp}/`)));
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
  /** Set when the project records were tidied too: their folder (its archive is `<recordsDir>/.archive/<archive>`). */
  recordsDir?: string;
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

/** The live files of the project records (the archive is not listed). */
const liveRecordFiles = (project: ResolvedProject): MemoryFile[] => (isPlainDir(recordsDir(project)) ? listMemoryFiles(recordsDir(project)).filter((f) => !f.rel.startsWith(`${ARCHIVE_DIR}/`)) : []);

function isPlainDir(p: string): boolean {
  try {
    return fs.lstatSync(p).isDirectory();
  } catch {
    return false;
  }
}

function describeRecords(project: ResolvedProject, say: (l: string) => void): void {
  const live = liveRecordFiles(project);
  const bytes = live.reduce((n, f) => n + f.bytes, 0);
  const active = RECORD_KINDS.map((k) => `${k} ${effectiveActive(listRecords(project, k)).length}`).join(", ");
  say(`records ${recordsDir(project)}: ${live.length} file(s), ${kb(bytes)}; active: ${active}`);
}

/** The lead's wake-up also tidies the project records, in a default project-layer tidy or with `--agent <lead>`. */
const recordsInScope = (o: TidyOptions): boolean => o.layer === "project" && (!o.agent || o.agent === o.project.lead);

function recordsContext(project: ResolvedProject, archiveDir: string, live: MemoryFile[]): TidyRecordsContext {
  const dir = recordsDir(project);
  const entries: TidyRecordsContext["entries"] = [];
  const known = new Set<string>();
  for (const kind of RECORD_KINDS)
    for (const r of listRecords(project, kind)) {
      const rel = `${kind}/${path.basename(r.file)}`;
      known.add(rel);
      entries.push({ kind, id: r.id, rel, status: r.status, date: r.date, bytes: live.find((f) => f.rel === rel)?.bytes ?? 0, title: r.title, invalid: r.invalid });
    }
  return { dir, archiveDir, entries, otherFiles: live.filter((f) => !known.has(f.rel)) };
}

const hasReport = (archiveDir: string): boolean => {
  const f = path.join(archiveDir, TIDY_REPORT_FILE);
  return fs.existsSync(f) && fs.readFileSync(f, "utf8").trim() !== "";
};

/** Tidy one agent's memory directory (`dir`, if it has files) and, for the lead, the project records, in one wake-up. */
async function tidyOne(o: TidyOptions, t: { agent: string; layer: Layer; dir: string | undefined }, stamp: string, withRecords: boolean): Promise<TidyResult> {
  const { project } = o;
  const say = o.say ?? ((s: string) => console.log(s));
  const base = { agent: t.agent, layer: t.layer, dir: t.dir ?? recordsDir(project) };
  const agent = project.agents[t.agent]!;
  const live = t.dir ? listMemoryFiles(t.dir).filter((f) => !f.rel.startsWith(`${ARCHIVE_DIR}/`)) : [];
  const recLive = withRecords ? liveRecordFiles(project) : [];
  const memPart = live.length > 0;
  const recPart = recLive.length > 0;
  if (!memPart && !recPart) return { ...base, status: "skipped", problems: ["no memory files: nothing to tidy"] };

  const recDir = recordsDir(project);
  const dirs = [...memoryDirs(agent), ...(recPart ? [recDir] : [])];
  const others = dirs.filter((d) => d !== t.dir && d !== recDir);
  const before = t.dir && memPart ? listMemoryFiles(t.dir).map((f) => f.rel) : [];
  const recBefore = recPart ? listMemoryFiles(recDir).map((f) => f.rel) : [];
  const watched = [commonFile(project)].filter((f) => fs.existsSync(f));
  const watchedBefore = watched.map((f) => fs.readFileSync(f, "utf8"));
  const othersBefore = others.map((d) => fingerprint(d));
  const archivesBefore = { mem: t.dir && memPart ? earlierArchives(t.dir, stamp) : {}, rec: recPart ? earlierArchives(recDir, stamp) : {} };
  const archiveDir = t.dir ? path.join(t.dir, ARCHIVE_DIR, stamp) : undefined;
  const recArchive = path.join(recDir, ARCHIVE_DIR, stamp);
  const workDir = tidyWorkDir(project, stamp, t.agent);
  const snapshot = path.join(workDir, "snapshot");
  const state = t.dir ? readTidyState(t.dir) : undefined;
  const changes = memPart && t.layer === "project" ? projectChanges(project.dir, state?.head) : undefined;
  const missing = memPart && t.dir ? findMissingPaths(t.dir, t.layer === "project" ? project.dir : undefined) : [];
  const index = t.dir && fs.existsSync(path.join(t.dir, "MEMORY.md")) ? fs.readFileSync(path.join(t.dir, "MEMORY.md"), "utf8") : "";
  const prompts = buildTidyPrompts(agent, {
    layer: t.layer,
    ...(memPart ? { dir: t.dir, archiveDir } : {}),
    files: live,
    index,
    changes,
    missing,
    ...(recPart ? { records: recordsContext(project, recArchive, recLive) } : {}),
  });

  ensureProjectDirs(project);
  snapshotDirs(dirs, snapshot);
  const fail = (problems: string[]): TidyResult => {
    restoreDirs(dirs, snapshot);
    for (const [i, f] of watched.entries()) atomicWrite(f, watchedBefore[i]!);
    fs.rmSync(snapshot, { recursive: true, force: true });
    return { ...base, status: "failed", ...(recPart ? { recordsDir: recDir } : {}), problems };
  };

  // The runtime may write only the directories being tidied (and read what it could read before): not the repo, outbox or shared files.
  const normal = writePolicy(project, agent);
  const allowDirs = [...(memPart && t.dir ? [t.dir] : []), ...(recPart ? [recDir] : [])];
  const policy: WritePolicy = {
    allowDirs,
    allowFiles: [],
    readDirs: [...new Set([repoDirFor(project, t.agent), ...normal.readDirs, ...normal.allowDirs.filter((d) => !allowDirs.includes(d)), ...normal.allowFiles.map((f) => path.dirname(f))])],
    deny: normal.deny,
  };

  say(`tidying ${t.layer} memory of ${t.agent} (${live.length} file(s)${recPart ? `, ${recLive.length} project record file(s)` : ""}) …`);
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
    policy,
  }).catch((e: Error) => ({ ok: false, text: "", exitCode: null, timedOut: false, error: e.message }));
  if (!result.ok) return fail([`the wake-up failed: ${result.error ?? "unknown error"}`]);

  // Anything that throws from here on (a report path that is a directory, a state file that cannot be written) is a failed tidy that is rolled back.
  let problems: string[] = [];
  try {
    others.forEach((d, i) => {
      if (JSON.stringify(fingerprint(d)) !== JSON.stringify(othersBefore[i])) problems.push(`the agent changed ${d}, which is not the ${t.layer} memory being tidied`);
    });
    watched.forEach((f, i) => {
      if (!fs.existsSync(f) || fs.readFileSync(f, "utf8") !== watchedBefore[i]) problems.push(`the agent changed ${f}, which a tidy may not touch`);
    });
    if (memPart && t.dir && archiveDir) {
      if (JSON.stringify(earlierArchives(t.dir, stamp)) !== JSON.stringify(archivesBefore.mem)) problems.push(`the agent changed an earlier archive under ${path.join(t.dir, ARCHIVE_DIR)}`);
      problems.push(...verifyConservation(before, t.dir, stamp));
      if (!hasReport(archiveDir)) problems.push(`${ARCHIVE_DIR}/${stamp}/${TIDY_REPORT_FILE} is missing or empty`);
    }
    if (recPart) {
      if (JSON.stringify(earlierArchives(recDir, stamp)) !== JSON.stringify(archivesBefore.rec)) problems.push(`project records: the agent changed an earlier archive under ${path.join(recDir, ARCHIVE_DIR)}`);
      problems.push(...verifyConservation(recBefore, recDir, stamp).map((p) => `project records: ${p}`));
      if (!hasReport(recArchive)) problems.push(`project records: ${ARCHIVE_DIR}/${stamp}/${TIDY_REPORT_FILE} is missing or empty`);
    }
    if (!problems.length && memPart && t.dir) writeTidyState(t.dir, { ...(changes?.head ? { head: changes.head } : {}), at: (o.now?.() ?? new Date()).toISOString(), archive: stamp });
  } catch (e) {
    problems = [...problems, `the tidy could not be checked or finished: ${(e as Error).message}`];
  }
  if (problems.length) return fail(problems);

  fs.rmSync(snapshot, { recursive: true, force: true });
  return { ...base, status: "tidied", archive: stamp, ...(recPart ? { recordsDir: recDir } : {}), problems: [] };
}

/** Tidy the memory of the chosen agents, one after another. Only ever called by a person (`agent-lyceum tidy`). */
export async function tidyMemory(o: TidyOptions): Promise<TidyResult[]> {
  const say = o.say ?? ((s: string) => console.log(s));
  const withRecords = recordsInScope(o) && liveRecordFiles(o.project).length > 0;
  const lead = o.project.lead;
  let targets: MemoryTarget[];
  try {
    targets = targetsFor(o.project, { layer: o.layer, agent: o.agent });
  } catch (e) {
    // `--agent <lead>` with no project memory directory is fine when there are records to tidy.
    if (!(withRecords && o.agent === lead && o.project.agents[lead])) throw e;
    targets = [];
  }
  const results: TidyResult[] = [];
  const stamp = tidyStamp(o.now?.()); // one per tidy, for every agent
  const jobs: { agent: string; layer: Layer; dir: string | undefined }[] = targets.map((t) => ({ ...t }));
  if (withRecords && !jobs.some((j) => j.agent === lead)) jobs.push({ agent: lead, layer: o.layer, dir: undefined });
  for (const j of jobs) {
    if (o.dryRun) {
      if (j.dir) describeTarget(j as MemoryTarget, o.project, say);
      if (withRecords && j.agent === lead) describeRecords(o.project, say);
      results.push({ agent: j.agent, layer: j.layer, dir: j.dir ?? recordsDir(o.project), status: "dry-run", problems: [] });
      continue;
    }
    const r = await tidyOne(o, j, stamp, withRecords && j.agent === lead);
    results.push(r);
    if (o.signal?.aborted) break;
  }
  return results;
}

export interface RestoreResult {
  restored: string[];
  skipped: { rel: string; reason: string }[];
  /** The same for the project records archive of that stamp, when the lead's undo found one. */
  records?: { restored: string[]; skipped: { rel: string; reason: string }[] };
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

/** Move the files of `archive` back under `dir`. Nothing that exists now is overwritten. */
function moveBack(dir: string, archive: string): { restored: string[]; skipped: { rel: string; reason: string }[] } {
  const restored: string[] = [];
  const skipped: { rel: string; reason: string }[] = [];
  for (const f of listMemoryFiles(archive).filter((f) => f.rel !== TIDY_REPORT_FILE)) {
    const from = path.join(archive, f.rel);
    const to = path.join(dir, f.rel);
    if (fs.existsSync(to)) {
      skipped.push({ rel: f.rel, reason: "a file with this name exists now; it was not overwritten" });
      continue;
    }
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.renameSync(from, to);
    pruneEmpty(path.dirname(from), archive);
    restored.push(f.rel);
  }
  return { restored, skipped };
}

/**
 * Move the files of one tidy's archive back to where they were. Nothing that exists now is overwritten.
 * For the lead on the project layer this covers the project records archive of the same stamp too; either archive may be the only one.
 */
export function restoreMemory(o: { project: ResolvedProject; agent: string; layer: Layer; stamp: string }): RestoreResult {
  if (!STAMP_RE.test(o.stamp)) throw new Error(`"${o.stamp}" is not an archive stamp (expected something like 20261008T031500Z).`);
  const isLead = o.layer === "project" && o.agent === o.project.lead;
  const recDir = recordsDir(o.project);
  const recArchive = path.join(recDir, ARCHIVE_DIR, o.stamp);
  const recHas = isLead && isPlainDir(recDir) && fs.existsSync(recArchive);
  let dir: string | undefined;
  try {
    dir = targetsFor(o.project, { layer: o.layer, agent: o.agent })[0]!.dir;
  } catch (e) {
    if (!(isLead && o.project.agents[o.agent])) throw e;
  }
  const archive = dir ? path.join(dir, ARCHIVE_DIR, o.stamp) : undefined;
  const memHas = !!archive && fs.existsSync(archive);
  if (!memHas && !recHas) {
    const recs = isLead ? `${dir ? "; project records archives: " : " Project records archives: "}${listArchives(recDir).join(", ") || "(none)"}` : "";
    throw new Error(`No archive ${o.stamp} for ${o.agent} (${o.layer}).${dir ? ` Archives: ${listArchives(dir).join(", ") || "(none)"}` : ""}${recs}.`);
  }

  const mem = dir && memHas ? moveBack(dir, archive!) : { restored: [], skipped: [] };
  if (dir && memHas) {
    const indexFile = path.join(dir, "MEMORY.md");
    const index = fs.existsSync(indexFile) ? fs.readFileSync(indexFile, "utf8") : "";
    const add = mem.restored.filter((rel) => rel.endsWith(".md") && !index.includes(rel)).map((rel) => `- [${titleOf(path.join(dir, rel), rel)}](${rel}) — restored from tidy ${o.stamp}`);
    if (add.length) atomicWrite(indexFile, `${index.replace(/\n*$/, index ? "\n" : "")}${add.join("\n")}\n`);
  }
  return { ...mem, ...(recHas ? { records: moveBack(recDir, recArchive) } : {}) };
}

/** The stamps of the archives in a memory directory, oldest first. */
export function listArchives(dir: string): string[] {
  try {
    return fs.readdirSync(path.join(dir, ARCHIVE_DIR)).filter((n) => STAMP_RE.test(n)).sort();
  } catch {
    return [];
  }
}

export const ADVICE_COMMITS = 50;

export interface TidyAdvice {
  agent: string;
  reason: string;
}

/** Hints only: project memory whose index is larger than what an agent is shown, or whose baseline is far behind. Never acts. */
export function tidyAdvice(project: ResolvedProject): TidyAdvice[] {
  const out: TidyAdvice[] = [];
  for (const t of targetsFor(project, { layer: "project" })) {
    if (!fs.existsSync(t.dir)) continue;
    const s = memoryStats(t.dir);
    if (s.indexBytes > MEMORY_INDEX_LIMIT) {
      out.push({ agent: t.agent, reason: `MEMORY.md is ${s.indexBytes} bytes, more than the ${MEMORY_INDEX_LIMIT} an agent is shown` });
      continue;
    }
    const since = readTidyState(t.dir)?.head;
    if (!since || !fs.existsSync(project.dir) || !isGitRepo(project.dir)) continue;
    const n = Number(tryGit(project.dir, ["rev-list", "--count", `${since}..HEAD`]));
    if (Number.isFinite(n) && n >= ADVICE_COMMITS) out.push({ agent: t.agent, reason: `${n} commits since the last tidy` });
  }
  for (const kind of RECORD_KINDS) {
    const bytes = activeRecordsBytes(project, kind);
    if (bytes > RECORDS_BUDGET) out.push({ agent: project.lead, reason: `active ${kind} records are ${bytes} bytes, more than the ${RECORDS_BUDGET} an agent is shown (\`done\` is refused while over)` });
  }
  return out;
}
