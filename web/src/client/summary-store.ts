/** Progress summaries, one per project run, kept in localStorage like slack-dispatcher's viewer.summaries. */
const KEY = "lyceum.summaries";

export type SavedSummary = { text: string; generatedAt: number };

export interface KeyValueStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

export interface SummaryStore {
  load: (project: string, runId: string) => SavedSummary | null;
  save: (project: string, runId: string, data: SavedSummary) => void;
  forget: (project: string, runId: string) => void;
  forgetProject: (project: string) => void;
}

type Entries = Record<string, SavedSummary>;

const entryKey = (project: string, runId: string) => `${project}/${runId}`;

function isSavedSummary(value: unknown): value is SavedSummary {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.text === "string" && record.text.trim().length > 0 && typeof record.generatedAt === "number";
}

function readAll(storage: () => KeyValueStorage): Entries {
  try {
    const parsed: unknown = JSON.parse(storage().getItem(KEY) ?? "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter(([, value]) => isSavedSummary(value))) as Entries;
  } catch {
    return {};
  }
}

/** Write newest first; when storage is full, give up the oldest until it fits. The newest is never given up. */
function writeAll(storage: () => KeyValueStorage, entries: Entries): void {
  const sorted = Object.entries(entries).sort(([, a], [, b]) => b.generatedAt - a.generatedAt);
  for (let keep = sorted.length; keep >= Math.min(1, sorted.length); keep--) {
    try {
      storage().setItem(KEY, JSON.stringify(Object.fromEntries(sorted.slice(0, keep))));
      return;
    } catch {
      /* full, or storage is unavailable: try with one fewer */
    }
  }
}

export function createSummaryStore(storage: () => KeyValueStorage): SummaryStore {
  // A summary request can finish after its run was deleted; these keep it from being written back.
  const forgottenRuns = new Set<string>();
  const forgottenProjects = new Set<string>();

  return {
    load: (project, runId) => readAll(storage)[entryKey(project, runId)] ?? null,
    save: (project, runId, data) => {
      const key = entryKey(project, runId);
      if (forgottenRuns.has(key) || forgottenProjects.has(project)) return;
      writeAll(storage, { ...readAll(storage), [key]: data });
    },
    forget: (project, runId) => {
      const key = entryKey(project, runId);
      forgottenRuns.add(key);
      const all = readAll(storage);
      if (!(key in all)) return;
      delete all[key];
      writeAll(storage, all);
    },
    forgetProject: (project) => {
      forgottenProjects.add(project);
      const prefix = `${project}/`;
      const all = readAll(storage);
      const kept = Object.fromEntries(Object.entries(all).filter(([key]) => !key.startsWith(prefix)));
      if (Object.keys(kept).length !== Object.keys(all).length) writeAll(storage, kept);
    },
  };
}

export const summaries = createSummaryStore(() => window.localStorage);
