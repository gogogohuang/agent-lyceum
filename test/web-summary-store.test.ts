import { describe, expect, it, vi } from "vitest";
import type { ShortOutcome } from "../web/src/client/api";
import { createSummaryCleanup } from "../web/src/client/summary-cleanup";
import { createSummaryStore } from "../web/src/client/summary-store";

const KEY = "lyceum.summaries";

function memoryStorage(limit = Infinity) {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (value.length > limit) throw new Error("QuotaExceededError");
      map.set(key, value);
    },
  };
}

function freshStore() {
  const storage = memoryStorage();
  return createSummaryStore(() => storage);
}

const summary = (generatedAt: number, text = "做完登入頁") => ({ text, generatedAt });
const outcome = (exit: number | null): ShortOutcome => ({ mode: "short", exit, signal: null, stdout: "", stderr: "", timedOut: false, truncated: false });

describe("summary store", () => {
  it("round-trips a summary per project run", () => {
    const store = freshStore();
    store.save("web", "r1", summary(1));
    expect(store.load("web", "r1")).toEqual(summary(1));
    expect(store.load("web", "r2")).toBeNull();
    expect(store.load("api", "r1")).toBeNull();
  });

  it("survives a reload: a new store on the same storage reads what was saved", () => {
    const storage = memoryStorage();
    createSummaryStore(() => storage).save("web", "r1", summary(1));
    expect(createSummaryStore(() => storage).load("web", "r1")).toEqual(summary(1));
  });

  it("ignores corrupt or malformed storage", () => {
    const storage = memoryStorage();
    const store = createSummaryStore(() => storage);
    storage.setItem(KEY, "{not json");
    expect(store.load("web", "r1")).toBeNull();
    storage.setItem(KEY, "[]");
    expect(store.load("web", "r1")).toBeNull();
    storage.setItem(KEY, JSON.stringify({ "web/r1": { text: 1, generatedAt: 1 }, "web/r2": { text: "  ", generatedAt: 1 } }));
    expect(store.load("web", "r1")).toBeNull();
    expect(store.load("web", "r2")).toBeNull();
    store.save("web", "r1", summary(1));
    expect(store.load("web", "r1")).toEqual(summary(1));
  });

  it("survives a storage that throws", () => {
    const thrower = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    };
    const store = createSummaryStore(() => thrower);
    expect(() => store.save("web", "r1", summary(1))).not.toThrow();
    expect(store.load("web", "r1")).toBeNull();
    expect(() => store.forget("web", "r1")).not.toThrow();
  });

  it("keeps every summary while storage has room", () => {
    const store = freshStore();
    for (let i = 0; i < 200; i++) store.save("web", `r${i}`, summary(i));
    expect(store.load("web", "r0")).toEqual(summary(0));
    expect(store.load("web", "r199")).toEqual(summary(199));
  });

  it("drops the oldest summaries only when storage is full, and keeps the new one", () => {
    const storage = memoryStorage(100);
    const store = createSummaryStore(() => storage);
    store.save("web", "r1", summary(1));
    store.save("web", "r2", summary(2));
    store.save("web", "r3", summary(3));
    expect(store.load("web", "r3")).toEqual(summary(3));
    expect(store.load("web", "r1")).toBeNull();
  });

  it("forgets one run without touching the others", () => {
    const store = freshStore();
    store.save("web", "r1", summary(1));
    store.save("web", "r2", summary(2));
    store.forget("web", "r1");
    expect(store.load("web", "r1")).toBeNull();
    expect(store.load("web", "r2")).toEqual(summary(2));
  });

  it("forgets a whole project but not one whose name shares its prefix", () => {
    const store = freshStore();
    store.save("a", "r1", summary(1));
    store.save("ab", "r1", summary(2));
    store.forgetProject("a");
    expect(store.load("a", "r1")).toBeNull();
    expect(store.load("ab", "r1")).toEqual(summary(2));
  });

  it("does not bring back a run deleted while its summary was still being written", () => {
    const store = freshStore();
    store.forget("web", "r1");
    store.save("web", "r1", summary(1));
    expect(store.load("web", "r1")).toBeNull();
    store.forgetProject("api");
    store.save("api", "r9", summary(2));
    expect(store.load("api", "r9")).toBeNull();
  });
});

describe("summary cleanup after a command", () => {
  const spyStore = () => ({ forget: vi.fn(), forgetProject: vi.fn() });

  it("forgets the run a successful clear deleted", () => {
    const store = spyStore();
    createSummaryCleanup(store)("clear", { project: "web", run: "r1" }, outcome(0));
    expect(store.forget).toHaveBeenCalledWith("web", "r1");
  });

  it("keeps the summary on a dry run, a failure or a timeout", () => {
    const store = spyStore();
    const cleanup = createSummaryCleanup(store);
    cleanup("clear", { project: "web", run: "r1", dryRun: true }, outcome(0));
    cleanup("clear", { project: "web", run: "r1" }, outcome(1));
    cleanup("clear", { project: "web", run: "r1" }, outcome(null));
    cleanup("clear", { project: "web" }, outcome(0));
    expect(store.forget).not.toHaveBeenCalled();
  });

  it("forgets a project only when it was removed with purge", () => {
    const store = spyStore();
    const cleanup = createSummaryCleanup(store);
    cleanup("project.remove", { name: "web" }, outcome(0));
    expect(store.forgetProject).not.toHaveBeenCalled();
    cleanup("project.remove", { name: "web", purge: true }, outcome(1));
    expect(store.forgetProject).not.toHaveBeenCalled();
    cleanup("project.remove", { name: "web", purge: true }, outcome(0));
    expect(store.forgetProject).toHaveBeenCalledWith("web");
  });

  it("ignores commands that delete nothing", () => {
    const store = spyStore();
    createSummaryCleanup(store)("doctor", { project: "web", run: "r1" }, outcome(0));
    expect(store.forget).not.toHaveBeenCalled();
    expect(store.forgetProject).not.toHaveBeenCalled();
  });
});
