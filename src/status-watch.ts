import fs from "node:fs";
import path from "node:path";
import type { ResolvedProject } from "./config.js";
import { buildStatusReport, buildTaskListReport, currentRun, isFinishedRun, memoryAdviceLines, type StatusReport } from "./status.js";

/** What `status --json --watch` prints, one JSON object per line: the project's report plus one per task that is not finished (completed or partial). */
export type WatchFrame = { schema_version: 1; report?: StatusReport; runs?: Record<string, StatusReport>; error?: string };

/**
 * The frame for now. Every task that is not finished (running, interrupted, waiting for answers, or ended blocked,
 * failed or cancelled) gets its own report, so it stays listed until it is resumed or cleared.
 * A task that was running in the previous frame and has finished (completed or partial) since is included once more, so the reader sees
 * it finish (and can toast) before it is dropped. `tracked` is that previous set; it is replaced by the ids running now.
 */
/**
 * Reports of finished runs, kept so a sweep does not rebuild them (about 300 ms each). An entry is reused while the
 * run's state.json is unchanged and it is younger than `FINISHED_TTL_MS`. That TTL still covers what lives outside
 * the file, such as unread mail. Advice is copied from the lines passed for this call, so it stays inside
 * `ADVICE_TTL_MS` and the two TTLs do not stack.
 */
export type FinishedCache = Map<string, { stamp: string; at: number; report: StatusReport }>;
const FINISHED_TTL_MS = 5 * 60_000;
/** Tidy advice is the same for every run of a project. Recompute it on this cadence, not on every beat. */
const ADVICE_TTL_MS = 5 * 60_000;

function withAdvice(report: StatusReport, advice: string[]): StatusReport {
  const current = report.memory_advice ?? [];
  if (current.length === advice.length && current.every((line, index) => line === advice[index])) return report;
  if (advice.length === 0) {
    const { memory_advice: _dropped, ...rest } = report;
    return rest;
  }
  return { ...report, memory_advice: advice };
}

function stampOf(project: ResolvedProject, id: string): string {
  try {
    const st = fs.statSync(path.join(project.paths.runs, id, "state.json"));
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return "";
  }
}

export function buildWatchFrame(project: ResolvedProject, tracked: Set<string>, opts?: { allTasks?: boolean; cache?: FinishedCache; advice?: string[] }): WatchFrame {
  const all = buildTaskListReport(project).runs;
  const running = all.filter((r) => r.state === "running").map((r) => r.run_id);
  const open = all.filter((r) => !isFinishedRun(r)).map((r) => r.run_id);
  const runs: Record<string, StatusReport> = {};
  // The web page keeps every task. The terminal watch drops one after it has finished, once the finish has been seen.
  const ids = opts?.allTasks ? all.map((r) => r.run_id) : [...open, ...tracked];
  const finished = new Set(all.filter(isFinishedRun).map((r) => r.run_id));
  const cache = opts?.cache;
  const now = Date.now();
  const advice = opts?.advice ?? memoryAdviceLines(project);
  for (const id of new Set(ids)) {
    const stamp = cache && finished.has(id) ? stampOf(project, id) : "";
    const hit = stamp ? cache?.get(id) : undefined;
    if (hit && hit.stamp === stamp && now - hit.at < FINISHED_TTL_MS) {
      const report = withAdvice(hit.report, advice);
      if (report !== hit.report) cache?.set(id, { stamp: hit.stamp, at: hit.at, report });
      runs[id] = report;
      continue;
    }
    runs[id] = buildStatusReport(project, id, now, advice);
    if (stamp) cache?.set(id, { stamp, at: now, report: runs[id] });
  }
  if (cache) for (const id of cache.keys()) if (!finished.has(id)) cache.delete(id);
  // The project's own report shows the current run, which is usually one already built above.
  const currentId = currentRun(project)?.state.run_id;
  const report = currentId && runs[currentId] ? runs[currentId] : buildStatusReport(project, undefined, now, advice);
  tracked.clear();
  for (const id of running) tracked.add(id);
  return { schema_version: 1, report, runs };
}

export interface WatchDeps {
  /** The project, loaded again each time so config edits and new runs show up. */
  load: () => ResolvedProject;
  /** The directory whose changes mean the status may have changed (the project's runs directory). */
  dir: (project: ResolvedProject) => string;
  write: (line: string) => void;
  debounceMs: number;
  /** Include finished tasks. The browser page uses this; `status --json --watch` does not. */
  allTasks?: boolean;
  watch?: (dir: string, onChange: () => void) => { close: () => void };
}

function fsWatch(dir: string, onChange: () => void): { close: () => void } {
  return fs.watch(dir, { recursive: true }, onChange);
}

/**
 * Print a frame now and again whenever something under the runs directory changes (debounced; a round writes several files).
 * A frame equal to the last one is not printed. `beat()` is the slow fallback: it re-arms a watcher that could not start
 * (the directory did not exist yet), and picks up what a missed file event or a dead lock holder left unnoticed.
 */
export function createStatusWatcher(d: WatchDeps): { beat: () => void; close: () => void } {
  const tracked = new Set<string>();
  const cache: FinishedCache = new Map();
  const watch = d.watch ?? fsWatch;
  let lastLine = "";
  let watching = "";
  let watcher: { close: () => void } | undefined;
  let timer: NodeJS.Timeout | undefined;
  let adviceCache: { key: string; at: number; lines: string[] } | undefined;

  const emit = () => {
    let frame: WatchFrame;
    let project: ResolvedProject | undefined;
    try {
      project = d.load();
      const now = Date.now();
      const key = `${project.name}\0${project.dir}`;
      if (!adviceCache || adviceCache.key !== key || now - adviceCache.at >= ADVICE_TTL_MS) {
        adviceCache = { key, at: now, lines: memoryAdviceLines(project) };
      }
      frame = buildWatchFrame(project, tracked, { allTasks: d.allTasks, cache, advice: adviceCache.lines });
    } catch (e) {
      frame = { schema_version: 1, error: (e as Error).message };
    }
    const line = JSON.stringify(frame);
    if (line !== lastLine) {
      lastLine = line;
      d.write(line);
    }
    if (project) arm(d.dir(project));
  };

  const arm = (dir: string) => {
    if (watcher && watching === dir) return;
    watcher?.close();
    watcher = undefined;
    if (!fs.existsSync(dir)) return;
    try {
      watcher = watch(dir, schedule);
      watching = dir;
    } catch {
      /* recursive watch unsupported or the directory vanished: the beat covers it */
    }
  };

  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(emit, d.debounceMs);
  };

  return {
    beat: emit,
    close: () => {
      if (timer) clearTimeout(timer);
      watcher?.close();
    },
  };
}
