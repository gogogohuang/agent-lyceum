import type { QuotaReport, WatchFrame, WebEvent } from "../types.js";

export interface ProjectWatch {
  beat(): void;
  close(): void;
}

/** The CLI supplies this. The hub does not load projects or import the dispatcher. */
export interface WatchFactory {
  list(): string[];
  watch(name: string, onFrame: (frame: WatchFrame) => void): ProjectWatch;
  quota?(): Promise<QuotaReport[]>;
  summarize?(input: { runtime: "claude" | "codex"; prompt: string }): Promise<string>;
}

export function createWebHub(factory: WatchFactory) {
  const watchers = new Map<string, ProjectWatch>();
  const latest = new Map<string, WatchFrame>();
  const listeners = new Set<(event: WebEvent) => void>();
  let quota: QuotaReport[] | undefined;
  let quotaToken = 0;

  const emit = (event: WebEvent) => {
    for (const listener of listeners) {
      try {
        listener(event);
      } catch {
        /* one subscriber cannot stop the others */
      }
    }
  };

  const sync = () => {
    let names: string[];
    try {
      names = factory.list();
    } catch {
      return;
    }
    const want = new Set(names);
    for (const [name, watch] of watchers) {
      if (want.has(name)) continue;
      watch.close();
      watchers.delete(name);
      latest.delete(name);
      emit({ type: "removed", name });
    }
    for (const name of names) {
      if (watchers.has(name)) continue;
      try {
        const watch = factory.watch(name, (frame) => {
          latest.set(name, frame);
          emit({ type: "frame", name, frame });
        });
        watchers.set(name, watch);
      } catch (e) {
        const frame: WatchFrame = { schema_version: 1, error: (e as Error).message };
        latest.set(name, frame);
        emit({ type: "frame", name, frame });
      }
    }
    for (const watch of watchers.values()) {
      try {
        watch.beat();
      } catch {
        /* one project's sweep cannot stop the others */
      }
    }
  };

  const refreshQuota = (): Promise<QuotaReport[] | undefined> => {
    if (!factory.quota) return Promise.resolve(quota);
    const token = ++quotaToken;
    return factory
      .quota()
      .then((reports) => {
        if (token !== quotaToken) return quota;
        quota = reports;
        emit({ type: "quota", reports });
        return reports;
      })
      .catch(() => quota);
  };

  return {
    start: sync,
    beat: sync,
    refreshQuota,
    frame(name: string): WatchFrame | undefined {
      return latest.get(name);
    },
    close() {
      quotaToken += 1;
      for (const watch of watchers.values()) watch.close();
      watchers.clear();
      listeners.clear();
    },
    subscribe(listener: (event: WebEvent) => void): () => void {
      listeners.add(listener);
      const projects = [...latest].map(([name, frame]) => ({ name, frame })).sort((a, b) => a.name.localeCompare(b.name));
      try {
        listener({ type: "snapshot", projects, ...(quota ? { quota } : {}) });
      } catch {
        listeners.delete(listener);
      }
      return () => listeners.delete(listener);
    },
  };
}

export type WebHub = ReturnType<typeof createWebHub>;
