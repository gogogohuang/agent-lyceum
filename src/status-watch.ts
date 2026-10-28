import fs from "node:fs";
import type { ResolvedProject } from "./config.js";
import { buildStatusReport, buildTaskListReport, isFinishedRun, type StatusReport } from "./status.js";

/** What `status --json --watch` prints, one JSON object per line: the project's report plus one per task that is not finished (completed or partial). */
export type WatchFrame = { schema_version: 1; report?: StatusReport; runs?: Record<string, StatusReport>; error?: string };

/**
 * The frame for now. Every task that is not finished (running, interrupted, waiting for answers, or ended blocked,
 * failed or cancelled) gets its own report, so it stays listed until it is resumed or cleared.
 * A task that was running in the previous frame and has finished (completed or partial) since is included once more, so the reader sees
 * it finish (and can toast) before it is dropped. `tracked` is that previous set; it is replaced by the ids running now.
 */
export function buildWatchFrame(project: ResolvedProject, tracked: Set<string>, opts?: { allTasks?: boolean }): WatchFrame {
  const all = buildTaskListReport(project).runs;
  const running = all.filter((r) => r.state === "running").map((r) => r.run_id);
  const open = all.filter((r) => !isFinishedRun(r)).map((r) => r.run_id);
  const runs: Record<string, StatusReport> = {};
  // The web page keeps every task. The terminal watch drops one after it has finished, once the finish has been seen.
  const ids = opts?.allTasks ? all.map((r) => r.run_id) : [...open, ...tracked];
  for (const id of new Set(ids)) runs[id] = buildStatusReport(project, id);
  const report = buildStatusReport(project);
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
  const watch = d.watch ?? fsWatch;
  let lastLine = "";
  let watching = "";
  let watcher: { close: () => void } | undefined;
  let timer: NodeJS.Timeout | undefined;

  const emit = () => {
    let frame: WatchFrame;
    let project: ResolvedProject | undefined;
    try {
      project = d.load();
      frame = buildWatchFrame(project, tracked, { allTasks: d.allTasks });
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
