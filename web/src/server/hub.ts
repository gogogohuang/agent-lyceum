import type { QuotaReport, WatchFrame, WebEvent } from "../types.js";

export interface ProjectWatch {
  beat(): void;
  close(): void;
}

/** The CLI supplies this. The hub does not load projects or import the dispatcher. */
export interface WatchFactory {
  list(): string[];
  watch(name: string, onFrame: (frame: WatchFrame) => void): ProjectWatch;
  /** `signal` aborts when the hub closes: implementations should pass it to what they spawn. */
  quota?(signal?: AbortSignal): Promise<QuotaReport[]>;
  summarize?(input: { runtime: "claude" | "codex"; prompt: string }): Promise<string>;
}

export function createWebHub(factory: WatchFactory, hooks?: { onSubscribers?: (count: number) => void }) {
  const watchers = new Map<string, ProjectWatch>();
  const latest = new Map<string, WatchFrame>();
  const listeners = new Set<(event: WebEvent) => void>();
  let quota: QuotaReport[] | undefined;
  let quotaAt = 0;
  let quotaToken = 0;
  let inflight = 0;
  const quotaAbort = new AbortController();

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
    inflight += 1;
    const read = factory.quota;
    return Promise.resolve()
      .then(() => read(quotaAbort.signal))
      .then((reports) => {
        if (token !== quotaToken) return quota;
        quota = reports;
        quotaAt = Date.now();
        emit({ type: "quota", reports });
        return reports;
      })
      .catch(() => quota)
      .finally(() => {
        inflight -= 1;
      });
  };

  const projectList = (): { name: string; frame: WatchFrame }[] =>
    [...latest].map(([name, frame]) => ({ name, frame })).sort((a, b) => a.name.localeCompare(b.name));

  return {
    start: sync,
    beat: sync,
    refreshQuota,
    subscriberCount: () => listeners.size,
    quotaBusy: () => inflight > 0,
    /** True when a successful read is still inside `maxAgeMs`. A missing or failed read is not fresh. */
    quotaFresh: (maxAgeMs: number) => quota !== undefined && Date.now() - quotaAt < maxAgeMs,
    frame(name: string): WatchFrame | undefined {
      return latest.get(name);
    },
    close() {
      quotaToken += 1;
      quotaAbort.abort(); // asks in-flight quota children to end (SIGTERM); it does not wait for them
      for (const watch of watchers.values()) watch.close();
      watchers.clear();
      listeners.clear();
    },
    snapshot: projectList,
    subscribe(listener: (event: WebEvent) => void): () => void {
      listeners.add(listener);
      const projects = projectList();
      try {
        listener({ type: "snapshot", projects, ...(quota ? { quota } : {}) });
      } catch {
        listeners.delete(listener);
        return () => {};
      }
      hooks?.onSubscribers?.(listeners.size);
      return () => {
        if (!listeners.delete(listener)) return;
        hooks?.onSubscribers?.(listeners.size);
      };
    },
  };
}

export type WebHub = ReturnType<typeof createWebHub>;
