# 同一專案同時跑多個 task 實作計畫

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 讓同一個專案能同時執行多個 run（task），每個 run 在自己的 git worktree 裡工作，完成後把成果留在分支上、不動使用者的 working tree。

**Architecture:** 專案層的 `lock.json` 改成 per-run 的 `locks/<run-id>.json`，用一個短暫的 admission mutex 讓「計數 + 建立」原子化，上限由 `dispatcher.max_concurrent_runs`（預設 1）控制。`max_concurrent_runs > 1` 時所有 run 強制 worktree 模式：lead 也進 `worktrees/<run-id>/<lead>`，起點是 `HEAD`；成員的改動合回 lead 的 worktree（`integrateAgentChanges` 多一個 target 參數），run 結束時在 lead 分支上提交一次。

**Tech Stack:** TypeScript ESM、Node `fs`／`child_process`、`git worktree`、Vitest、Biome。

**Spec:** `docs/specs/07-concurrent-runs.md`

## Global Constraints

- Node >=20，macOS 與 Linux；Windows 只維持現狀（警告）。
- `max_concurrent_runs` 預設 `1`：未設定時，行為與現在完全相同，既有測試必須全部通過。
- 舊 run、舊 `project.yaml`、舊的專案層 `lock.json` 必須可讀；`schema_version: 2` 與信箱協定不變。
- 不自動合併、不動使用者的 working tree／index／HEAD；不新增全域資源上限；不新增非必要依賴。
- 破壞相容性或新增設定時，同步更新 `README.md`、`README.zh-TW.md`、`docs/commands.md`、`docs/commands.zh-TW.md`，並通過 `npm run check:docs`。
- 每個 Task 結束時 `npm run typecheck`、`npm test`、`npm run lint` 都要通過。
- lead 分支名為 `agent-lyceum/<run-id>/<lead 的 agent 名稱>`（spec 中的 `/lead` 是範例；預設團隊的 lead 就叫 `lead`）。

## File Structure

| 檔案 | 責任 |
|---|---|
| `src/schema.ts`、`src/validate.ts`、`src/scaffold.ts` | 新設定 `max_concurrent_runs` 與驗證規則 |
| `src/project-lock.ts` | per-run 鎖、admission mutex、舊鎖相容、`listRunLocks`／`inspectRunLock`／`forceUnlock(root, runId?)` |
| `src/cli.ts`、`src/status.ts`、`src/doctor.ts` | 以 run 為單位取鎖／判斷存活／解鎖／診斷 |
| `src/worktree.ts` | `snapshotHead`、`snapshotBase` 可指定來源目錄、`integrateAgentChanges`／`inspectWorkspace` 可指定 target、`commitWorkspace`、`finishLeadBranch` |
| `src/run-session.ts`、`src/run-store.ts` | lead worktree、起點、成員合回 lead、結束時提交、`result_branch` |
| `src/run-cleanup.ts` | `clear` 以 lead worktree 為比較對象，未合入就拒絕 |
| `test/helpers.ts` | `makeConcurrent(env, n)` |

---

### Task 1: 設定 `max_concurrent_runs` 與驗證

**Files:**
- Modify: `src/schema.ts`（`DispatcherPartial`、`DispatcherSettings`、`DISPATCHER_DEFAULTS`）
- Modify: `src/worktree.ts`（`resolveWorkspaceMode`）
- Modify: `src/validate.ts:86-92`
- Modify: `src/scaffold.ts`（專案範本的 `dispatcher:` 區塊）
- Modify: `test/helpers.ts`
- Test: `test/worktree.test.ts`、`test/validate.test.ts`

**Interfaces:**
- Produces:
  - `DispatcherSettings.max_concurrent_runs: number`（預設 `1`）
  - `resolveWorkspaceMode(d)`：`max_concurrent_runs > 1` 時一律回 `"worktree"`
  - `makeConcurrent(env: TestEnv, n = 2): void`（測試輔助）

- [ ] **Step 1: 寫失敗的測試**

`test/helpers.ts` 在 `makeParallel` 之後加入：

```ts
/** Let the demo project run `n` runs at once (each in its own git worktree). */
export function makeConcurrent(env: TestEnv, n = 2): void {
  env.editProjectYaml((t) => t.replace("max_concurrent_runs: 1", `max_concurrent_runs: ${n}`));
}
```

`test/worktree.test.ts`：把 `settings` 輔助函式改成

```ts
const settings = (over: Partial<{ max_parallel: number; max_concurrent_runs: number; workspace_mode: "auto" | "shared" | "worktree" }>) => ({
  max_rounds: 30, max_parallel: 1, max_concurrent_runs: 1, wake_timeout_sec: 600, retry: 1, strict: false, workspace_mode: "auto" as const, log_max_bytes: 0, ...over,
});
```

並在 `describe("workspace mode", ...)` 內加一個測試：

```ts
  it("uses worktrees for every run when several runs may be active at once", () => {
    expect(resolveWorkspaceMode(settings({ max_concurrent_runs: 2 }))).toBe("worktree");
    expect(resolveWorkspaceMode(settings({ max_concurrent_runs: 2, workspace_mode: "auto" }))).toBe("worktree");
    expect(resolveWorkspaceMode(settings({ max_concurrent_runs: 1 }))).toBe("shared");
  });
```

`test/validate.test.ts`：檔頭 import 補上 `makeConcurrent`（`import { initGitRepo, makeConcurrent, makeEnv, type TestEnv } from "./helpers.js";`），在 `describe("validate", ...)` 內加入：

```ts
  it("accepts max_concurrent_runs > 1 in a git repo", () => {
    env = makeEnv();
    initGitRepo(env.repo);
    makeConcurrent(env, 3);
    expect(env.project().dispatcher.max_concurrent_runs).toBe(3);
    expect(errors(env)).toEqual([]);
  });

  it("rejects max_concurrent_runs > 1 with workspace_mode shared", () => {
    env = makeEnv();
    initGitRepo(env.repo);
    makeConcurrent(env, 2);
    env.editProjectYaml((t) => t.replace("workspace_mode: auto", "workspace_mode: shared"));
    expect(errors(env).join("\n")).toMatch(/max_concurrent_runs/);
  });

  it("rejects max_concurrent_runs > 1 when the project is not a git repository, with one clear message", () => {
    env = makeEnv();
    makeConcurrent(env, 2);
    const list = errors(env);
    expect(list.filter((m) => /git repository/.test(m))).toHaveLength(1);
    expect(list.join("\n")).toMatch(/max_concurrent_runs: 1/);
  });

  it("defaults max_concurrent_runs to 1", () => {
    env = makeEnv();
    expect(env.project().dispatcher.max_concurrent_runs).toBe(1);
  });
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx vitest run test/worktree.test.ts test/validate.test.ts`
Expected: FAIL（`max_concurrent_runs` 是 strict schema 的未知欄位，`env.project()` 丟錯；`resolveWorkspaceMode` 回 `shared`）。

- [ ] **Step 3: 實作**

`src/schema.ts`：`DispatcherPartial` 在 `max_parallel` 後加一行

```ts
    max_concurrent_runs: z.number().int().positive().optional(),
```

`DispatcherSettings` 在 `max_parallel: number;` 後加

```ts
  /** How many runs of one project may be active at once. Above 1, every run works in its own git worktree. */
  max_concurrent_runs: number;
```

`DISPATCHER_DEFAULTS` 在 `max_parallel: 1,` 後加 `max_concurrent_runs: 1,`。

`src/worktree.ts` 取代 `resolveWorkspaceMode`：

```ts
/** Agents share the repo, or each non-lead agent gets its own git worktree. `auto` picks worktrees as soon as agents can run in parallel; several concurrent runs always do. */
export function resolveWorkspaceMode(
  d: Pick<DispatcherSettings, "workspace_mode" | "max_parallel"> & Partial<Pick<DispatcherSettings, "max_concurrent_runs">>,
): WorkspaceMode {
  if ((d.max_concurrent_runs ?? 1) > 1) return "worktree";
  if (d.workspace_mode === "worktree") return "worktree";
  if (d.workspace_mode === "shared") return "shared";
  return d.max_parallel > 1 ? "worktree" : "shared";
}
```

`src/validate.ts`：把「Parallel agents each need their own checkout」那一整段（`if (... workspace_mode === "shared" && max_parallel > 1) {...} else if (...) {...}`）取代為

```ts
  // Parallel agents and concurrent runs each need their own checkout, which needs git.
  const concurrent = project.dispatcher.max_concurrent_runs > 1;
  if (concurrent && project.dispatcher.workspace_mode === "shared") {
    err(`dispatcher.workspace_mode "shared" cannot be combined with max_concurrent_runs > 1: every run needs its own git worktree (use "auto" or "worktree").`);
  } else if (concurrent && fs.existsSync(project.dir) && !isGitRepo(project.dir)) {
    err(`max_concurrent_runs > 1 needs ${project.dir} to be a git repository (each run works in its own git worktree). Set max_concurrent_runs: 1.`);
  } else if (project.dispatcher.workspace_mode === "shared" && project.dispatcher.max_parallel > 1) {
    err(`dispatcher.workspace_mode "shared" cannot be combined with max_parallel > 1: parallel agents need separate git worktrees (use "auto" or "worktree").`);
  } else if (!concurrent && resolveWorkspaceMode(project.dispatcher) === "worktree" && fs.existsSync(project.dir) && !isGitRepo(project.dir)) {
    err(`Parallel runs (worktree workspaces) need ${project.dir} to be a git repository. Run sequentially instead (max_parallel: 1, workspace_mode: auto or shared).`);
  }
```

`src/scaffold.ts`：範本裡 `max_parallel: 1 ...` 那行之後加一行

```
  max_concurrent_runs: 1  # >1 lets several runs of this project be active at once, each in its own git worktree (needs a git repo); every run's work stays on its own branch
```

（注意範本是 template literal，縮排與其他 `dispatcher:` 子項一致，兩個空格。）

- [ ] **Step 4: 跑測試確認通過**

Run: `npx vitest run test/worktree.test.ts test/validate.test.ts test/config.test.ts && npm run typecheck`
Expected: PASS。若 `test/config.test.ts` 有比對範本全文或 `config show` 輸出的測試失敗，把期望值補上新的 `max_concurrent_runs` 一行。

- [ ] **Step 5: Commit**

```bash
git add src/schema.ts src/worktree.ts src/validate.ts src/scaffold.ts test/helpers.ts test/worktree.test.ts test/validate.test.ts test/config.test.ts
git commit -m "feat(config): add dispatcher.max_concurrent_runs and its validation"
```

---

### Task 2: per-run 鎖與 admission mutex

**Files:**
- Modify: `src/project-lock.ts`（整段鎖邏輯，保留 `pidStartFrom` 等程序判斷）
- Modify: `test/fixtures/lock-holder.ts`
- Modify: `test/project-lock.test.ts`（`describe("project lock")` 整段取代；`describe("pid start time")` 不動）

**Interfaces:**
- Produces:
  - `export const LOCK_FILE = "lock.json"`（舊版、專案層；只讀取與清除）
  - `export const LOCKS_DIR = "locks"`
  - `export interface LockOptions { heartbeatMs?: number; maxConcurrent?: number }`（`maxConcurrent` 預設 `1`，含自己）
  - `acquireProjectLock(root: string, runId: string, opts?: LockOptions): ProjectLease`
  - `listRunLocks(root: string): LockInfo[]`（per-run 與舊 `lock.json`，只含讀得懂的，依 `acquired_at` 排序）
  - `inspectRunLock(root: string, runId: string): LockInfo | undefined`
  - `forceUnlock(root: string, runId?: string): LockInfo | undefined`（有 `runId`：移除該 run 的鎖，舊 `lock.json` 若屬於它也移除；沒有：只移除舊 `lock.json`）
  - 移除 `inspectProjectLock`

- [ ] **Step 1: 寫失敗的測試**

`test/fixtures/lock-holder.ts` 整檔取代為：

```ts
// Helper process for project-lock tests: tries to take a run's lock, reports, optionally holds it.
import { acquireProjectLock } from "../../src/project-lock.js";

const [root, runId, holdMs, max] = process.argv.slice(2);
try {
  const lease = acquireProjectLock(root, runId, { maxConcurrent: max ? Number(max) : 1 });
  process.stdout.write("ACQUIRED\n");
  setTimeout(() => {
    lease.release();
    process.exit(0);
  }, Number(holdMs ?? 0));
} catch (e) {
  process.stdout.write(`DENIED ${(e as Error).message}\n`);
  process.exit(3);
}
```

`test/project-lock.test.ts`：

1. 檔頭 import 改為：

```ts
import { acquireProjectLock, forceUnlock, inspectRunLock, listRunLocks, lockHolderAlive, LOCK_FILE, LOCKS_DIR, parseProcStat, pidStartFrom, type LockInfo, type PidStartIo } from "../src/project-lock.js";
```

2. `startHolder` 改為多一個 `max` 參數：

```ts
function startHolder(root: string, runId: string, holdMs: number, max = 1) {
  const child = spawn(tsx, [holder, root, runId, String(holdMs), String(max)], { stdio: ["ignore", "pipe", "pipe"] });
```
（函式其餘內容不變。）

3. 檔內加兩個輔助函式（放在 `tmp` 之後）：

```ts
const runLockFile = (root: string, runId: string) => path.join(root, LOCKS_DIR, `${runId}.json`);
const deadPid = () => Number(spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"]).stdout.toString());
const writeLock = (file: string, over: Partial<LockInfo> & { run_id: string }) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const now = new Date().toISOString();
  fs.writeFileSync(file, JSON.stringify({ token: `t-${over.run_id}`, hostname: os.hostname(), pid: process.pid, acquired_at: now, heartbeat_at: now, ...over }));
};
```

4. 整個 `describe("project lock", ...)`（從 `describe("project lock", () => {` 到它的結尾 `});`，即 `describe("pid start time"` 之前）取代為：

```ts
describe("run locks", () => {
  it("lets exactly one of two processes start when only one run may be active", async () => {
    const root = tmp();
    const a = startHolder(root, "run-a", 1500);
    const b = startHolder(root, "run-b", 1500);
    const results = (await Promise.all([a.first, b.first])).sort();
    expect(results[0]).toBe("ACQUIRED");
    expect(results[1]).toMatch(/^DENIED .*run-(a|b)/);
    await Promise.all([a.exited, b.exited]);
    expect(listRunLocks(root)).toEqual([]);
  }, 20_000);

  it("lets two processes run at the same time when two runs may be active, and never a third", async () => {
    const root = tmp();
    const a = startHolder(root, "run-a", 2000, 2);
    const b = startHolder(root, "run-b", 2000, 2);
    const c = startHolder(root, "run-c", 2000, 2);
    const results = (await Promise.all([a.first, b.first, c.first])).sort();
    expect(results.filter((r) => r === "ACQUIRED")).toHaveLength(2);
    expect(results.filter((r) => r.startsWith("DENIED"))).toHaveLength(1);
    await Promise.all([a.exited, b.exited, c.exited]);
    expect(listRunLocks(root)).toEqual([]);
  }, 30_000);

  it("lets different projects run at the same time", () => {
    const r1 = tmp();
    const r2 = tmp();
    const l1 = acquireProjectLock(r1, "x");
    const l2 = acquireProjectLock(r2, "y");
    expect(inspectRunLock(r1, "x")?.run_id).toBe("x");
    expect(inspectRunLock(r2, "y")?.run_id).toBe("y");
    l1.release();
    l2.release();
  });

  it("lets two different runs hold a lock when the limit is 2, and refuses a third naming the runs in the way", () => {
    const root = tmp();
    const a = acquireProjectLock(root, "run-a", { maxConcurrent: 2 });
    const b = acquireProjectLock(root, "run-b", { maxConcurrent: 2 });
    expect(listRunLocks(root).map((l) => l.run_id).sort()).toEqual(["run-a", "run-b"]);
    expect(() => acquireProjectLock(root, "run-c", { maxConcurrent: 2 })).toThrow(/run-a.*run-b.*max_concurrent_runs/s);
    expect(fs.existsSync(runLockFile(root, "run-c"))).toBe(false);
    a.release();
    acquireProjectLock(root, "run-c", { maxConcurrent: 2 }).release();
    b.release();
  });

  it("refuses the same run twice, however high the limit, and names the holder", () => {
    const root = tmp();
    const l = acquireProjectLock(root, "run-1", { maxConcurrent: 5 });
    expect(() => acquireProjectLock(root, "run-1", { maxConcurrent: 5 })).toThrow(/run-1.*still running/s);
    l.release();
  });

  it("allows only one run by default and names the one in the way", () => {
    const root = tmp();
    const l = acquireProjectLock(root, "run-1");
    expect(() => acquireProjectLock(root, "run-2")).toThrow(/run-1/);
    l.release();
    acquireProjectLock(root, "run-2").release();
  });

  it("does not count locks whose process is gone", () => {
    const root = tmp();
    writeLock(runLockFile(root, "dead"), { run_id: "dead", pid: deadPid() });
    expect(lockHolderAlive(inspectRunLock(root, "dead")!)).toBe(false);
    acquireProjectLock(root, "new").release();
  });

  it("counts an older version's project-wide lock.json held by a live process", () => {
    const root = tmp();
    writeLock(path.join(root, LOCK_FILE), { run_id: "old-run" });
    expect(inspectRunLock(root, "old-run")?.run_id).toBe("old-run");
    expect(() => acquireProjectLock(root, "new")).toThrow(/old-run/);
    const l = acquireProjectLock(root, "new", { maxConcurrent: 2 });
    expect(listRunLocks(root).map((x) => x.run_id).sort()).toEqual(["new", "old-run"]);
    l.release();
  });

  it("replaces an older version's lock.json whose process is gone", () => {
    const root = tmp();
    writeLock(path.join(root, LOCK_FILE), { run_id: "old-run", pid: deadPid(), hostname: "other-host.local" });
    acquireProjectLock(root, "run-new").release();
    expect(fs.existsSync(path.join(root, LOCK_FILE))).toBe(false);
  });

  it("release never deletes a lock that belongs to another token", () => {
    const root = tmp();
    const l = acquireProjectLock(root, "run-1");
    const file = runLockFile(root, "run-1");
    const other = { ...JSON.parse(fs.readFileSync(file, "utf8")), token: "someone-else" };
    fs.writeFileSync(file, JSON.stringify(other));
    l.release();
    expect(fs.existsSync(file)).toBe(true);
    expect(inspectRunLock(root, "run-1")?.token).toBe("someone-else");
  });

  it("does not take over a live holder just because its heartbeat is late", () => {
    const root = tmp();
    const l = acquireProjectLock(root, "run-1");
    const file = runLockFile(root, "run-1");
    const info = JSON.parse(fs.readFileSync(file, "utf8"));
    info.heartbeat_at = new Date(Date.now() - 3600_000).toISOString();
    fs.writeFileSync(file, JSON.stringify(info));
    expect(() => acquireProjectLock(root, "run-1")).toThrow(/still running|heartbeat/);
    l.release();
  });

  it("reclaims a run's lock whose process is gone, even if the hostname changed since", () => {
    const root = tmp();
    writeLock(runLockFile(root, "run-x"), { run_id: "run-x", pid: deadPid(), hostname: "other-host.local" });
    const l = acquireProjectLock(root, "run-x");
    expect(inspectRunLock(root, "run-x")?.pid).toBe(process.pid);
    l.release();
  });

  it("treats a reused pid (different start time) as a dead holder", () => {
    // the start time is in the format this platform writes: `proc:<ticks>` on Linux, `ps` text elsewhere
    const root = tmp();
    writeLock(runLockFile(root, "old"), { run_id: "old", pid_started: process.platform === "linux" ? "proc:1" : "Thu Jan  1 00:00:00 1970" });
    expect(lockHolderAlive(inspectRunLock(root, "old")!)).toBe(false);
    acquireProjectLock(root, "new").release();
  });

  it("asks for a manual unlock when the old lock file cannot be understood, and force-unlock clears it", () => {
    const root = tmp();
    fs.writeFileSync(path.join(root, LOCK_FILE), "garbage");
    expect(() => acquireProjectLock(root, "r")).toThrow(/unlock/);
    expect(forceUnlock(root)?.token).toBeUndefined();
    expect(fs.existsSync(path.join(root, LOCK_FILE))).toBe(false);
    acquireProjectLock(root, "r").release();
  });

  it("force-unlock by run id removes only that run's lock", () => {
    const root = tmp();
    const a = acquireProjectLock(root, "run-a", { maxConcurrent: 2 });
    const b = acquireProjectLock(root, "run-b", { maxConcurrent: 2 });
    expect(forceUnlock(root, "run-a")?.run_id).toBe("run-a");
    expect(listRunLocks(root).map((l) => l.run_id)).toEqual(["run-b"]);
    a.release();
    b.release();
  });

  it("keeps the heartbeat fresh while held", async () => {
    const root = tmp();
    const l = acquireProjectLock(root, "r", { heartbeatMs: 30 });
    const t0 = inspectRunLock(root, "r")!.heartbeat_at;
    await new Promise((r) => setTimeout(r, 150));
    expect(inspectRunLock(root, "r")!.heartbeat_at > t0).toBe(true);
    l.release();
  });

  it("rejects a run id that is not a plain name", () => {
    const root = tmp();
    expect(() => acquireProjectLock(root, "../escape")).toThrow(/run id/i);
  });
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx vitest run test/project-lock.test.ts`
Expected: FAIL（`listRunLocks`／`inspectRunLock`／`LOCKS_DIR` 不存在，import 即失敗）。

- [ ] **Step 3: 實作**

`src/project-lock.ts`：保留檔頭 import、`LockInfo`、`ProjectLease`、`parseProcStat`、`PidStartIo`、`pidStartFrom`、`realIo`、`pidStart`、`sameKind`、`lockHolderAlive`。其餘（常數、`Read`、`readLock`、`inspectProjectLock`、`heldError`、`unreadableError`、`tryCreate`、`reclaim`、`acquireProjectLock`、`forceUnlock`）以下列內容取代。

常數與型別（取代檔頭的 `LOCK_FILE`／`RECLAIM_FILE`／`HEARTBEAT_MS`／`LockOptions`）：

```ts
/** The project-wide lock of older versions. Still read (it counts as one active run) and cleared; never written. */
export const LOCK_FILE = "lock.json";
/** One lock file per active run: `<project home>/locks/<run-id>.json`. */
export const LOCKS_DIR = "locks";
const ADMIT_FILE = ".admit";
const HEARTBEAT_MS = 5000;

export interface LockOptions {
  heartbeatMs?: number;
  /** Most runs that may hold a lock of this project at once, this one included. Default 1. */
  maxConcurrent?: number;
}
```

其餘函式：

```ts
type Read = { kind: "none" } | { kind: "unreadable" } | { kind: "ok"; info: LockInfo };

function readLockFile(file: string): Read {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return { kind: "none" };
  }
  try {
    const j = JSON.parse(text);
    if (j && typeof j.token === "string" && typeof j.pid === "number" && typeof j.run_id === "string") return { kind: "ok", info: j as LockInfo };
  } catch {
    /* fall through */
  }
  return { kind: "unreadable" };
}

const runLockFile = (root: string, runId: string) => path.join(root, LOCKS_DIR, `${runId}.json`);
const legacyFile = (root: string) => path.join(root, LOCK_FILE);

function assertRunId(runId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(runId)) throw new Error(`Invalid run id "${runId}" for a lock: use letters, digits, ".", "-" or "_".`);
}

/** Per-run lock files (not temp or mutex files), then the old project-wide one if it exists. */
function lockFiles(root: string): string[] {
  const dir = path.join(root, LOCKS_DIR);
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith(".json") && !n.startsWith("."));
  } catch {
    /* no locks yet */
  }
  const files = names.sort().map((n) => path.join(dir, n));
  if (fs.existsSync(legacyFile(root))) files.push(legacyFile(root));
  return files;
}

/** Every lock of a project that can be read: one per run, plus an older version's `lock.json`. Oldest first. */
export function listRunLocks(root: string): LockInfo[] {
  const out: LockInfo[] = [];
  for (const f of lockFiles(root)) {
    const r = readLockFile(f);
    if (r.kind === "ok") out.push(r.info);
  }
  return out.sort((a, b) => a.acquired_at.localeCompare(b.acquired_at) || a.run_id.localeCompare(b.run_id));
}

/** The lock a run holds (per-run file, or an older version's `lock.json` written for that run), if readable. */
export function inspectRunLock(root: string, runId: string): LockInfo | undefined {
  const own = readLockFile(runLockFile(root, runId));
  if (own.kind === "ok") return own.info;
  const old = readLockFile(legacyFile(root));
  return old.kind === "ok" && old.info.run_id === runId ? old.info : undefined;
}

function heldError(info: LockInfo): Error {
  const late = Math.round((Date.now() - Date.parse(info.heartbeat_at)) / 1000);
  return new Error(
    `Run ${info.run_id} is still running (pid ${info.pid}, heartbeat ${Number.isFinite(late) ? late : "?"}s ago). ` +
      `A run cannot be started or resumed twice; wait for it to end, or stop it first.`,
  );
}

function limitError(active: LockInfo[], max: number): Error {
  const list = active.map((l) => `${l.run_id} (pid ${l.pid})`).join(", ");
  return new Error(
    `This project already has ${active.length} run(s) active: ${list}. At most ${max} may run at once (dispatcher.max_concurrent_runs: ${max}); ` +
      `wait for one to end, stop one, or raise max_concurrent_runs in project.yaml.`,
  );
}

function unreadableError(file: string): Error {
  return new Error(`The run lock ${file} cannot be read or has no known owner. Check that no run is active, then run \`agent-lyceum unlock --force\`.`);
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Counting the active runs and creating our lock must happen as one step, or two starts could both pass the count.
 * A short-lived mutex file serialises them; a holder that died leaves it behind for at most 10 s.
 */
function withAdmission<T>(root: string, fn: () => T): T {
  const mutex = path.join(root, LOCKS_DIR, ADMIT_FILE);
  const deadline = Date.now() + 5000;
  for (;;) {
    let fd: number | undefined;
    try {
      fd = fs.openSync(mutex, "wx");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    if (fd !== undefined) {
      try {
        return fn();
      } finally {
        fs.closeSync(fd);
        fs.rmSync(mutex, { force: true });
      }
    }
    try {
      if (Date.now() - fs.statSync(mutex).mtimeMs > 10_000) fs.rmSync(mutex, { force: true });
    } catch {
      /* released meanwhile */
    }
    if (Date.now() > deadline) throw new Error(`Could not take the project's admission lock ${mutex}; another process holds it. Try again.`);
    sleepSync(20);
  }
}

/** Create the lock file only if absent: write a private temp file, then hard-link it into place (atomic, never half-written). */
function tryCreate(file: string, info: LockInfo): boolean {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${info.token}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(info, null, 2));
  try {
    fs.linkSync(tmp, file);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw e;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

export function acquireProjectLock(root: string, runId: string, opts: LockOptions = {}): ProjectLease {
  assertRunId(runId);
  fs.mkdirSync(path.join(root, LOCKS_DIR), { recursive: true });
  const file = runLockFile(root, runId);
  const max = opts.maxConcurrent ?? 1;
  const now = new Date().toISOString();
  const info: LockInfo = {
    token: crypto.randomBytes(16).toString("hex"),
    hostname: os.hostname(),
    pid: process.pid,
    pid_started: pidStart(process.pid),
    run_id: runId,
    acquired_at: now,
    heartbeat_at: now,
  };

  withAdmission(root, () => {
    // 1. This run's own lock: a live holder means it is already running; a dead one is replaced.
    const own = readLockFile(file);
    if (own.kind === "unreadable") throw unreadableError(file);
    if (own.kind === "ok") {
      if (lockHolderAlive(own.info)) throw heldError(own.info);
      fs.rmSync(file, { force: true });
    }
    // 2. An older version's project-wide lock counts as one active run; a dead one is cleared.
    const old = readLockFile(legacyFile(root));
    if (old.kind === "unreadable") throw unreadableError(legacyFile(root));
    if (old.kind === "ok" && old.info.run_id === runId && lockHolderAlive(old.info)) throw heldError(old.info);
    if (old.kind === "ok" && !lockHolderAlive(old.info)) fs.rmSync(legacyFile(root), { force: true });
    // 3. The other runs that are active now.
    const active = listRunLocks(root).filter((l) => l.run_id !== runId && lockHolderAlive(l));
    if (active.length >= max) throw limitError(active, max);
    if (!tryCreate(file, info)) throw new Error(`Could not take the run lock ${file}; another process just took it. Try again.`);
  });

  let released = false;
  let lost = false;
  const mine = () => {
    const r = readLockFile(file);
    return r.kind === "ok" && r.info.token === info.token;
  };
  const timer = setInterval(() => {
    if (released) return;
    if (!mine()) {
      lost = true;
      clearInterval(timer);
      return;
    }
    info.heartbeat_at = new Date().toISOString();
    try {
      atomicWrite(file, JSON.stringify(info, null, 2));
    } catch {
      /* try again next tick */
    }
  }, opts.heartbeatMs ?? HEARTBEAT_MS);
  timer.unref();

  const release = () => {
    if (released) return;
    released = true;
    clearInterval(timer);
    process.off("exit", release);
    if (mine()) fs.rmSync(file, { force: true });
  };
  process.on("exit", release);

  return {
    info,
    get lost() {
      return lost;
    },
    release,
  };
}

/**
 * Remove a lock regardless of owner (the `unlock --force` escape hatch). With a run id: that run's lock (and an
 * older version's `lock.json` when it was written for that run). Without: only the older project-wide `lock.json`.
 * Returns what was there, if readable.
 */
export function forceUnlock(root: string, runId?: string): LockInfo | undefined {
  if (runId === undefined) {
    const old = readLockFile(legacyFile(root));
    fs.rmSync(legacyFile(root), { force: true });
    fs.rmSync(`${legacyFile(root)}.reclaim`, { force: true });
    return old.kind === "ok" ? old.info : undefined;
  }
  assertRunId(runId);
  const info = inspectRunLock(root, runId);
  fs.rmSync(runLockFile(root, runId), { force: true });
  const old = readLockFile(legacyFile(root));
  if (old.kind === "ok" && old.info.run_id === runId) fs.rmSync(legacyFile(root), { force: true });
  return info;
}
```

檔案中 `atomicWrite` 的 import 保留（`import { atomicWrite } from "./fs-util.js";`）。

- [ ] **Step 4: 跑測試確認通過**

Run: `npx vitest run test/project-lock.test.ts`
Expected: PASS（`src/cli.ts`、`src/status.ts`、`src/doctor.ts` 此時還在 import 被移除的 `inspectProjectLock`，整體 typecheck 要等 Task 3；只跑這個檔案即可）。

- [ ] **Step 5: Commit**

```bash
git add src/project-lock.ts test/project-lock.test.ts test/fixtures/lock-holder.ts
git commit -m "feat(lock): one lock per run with an admission mutex and a concurrency limit"
```

> 注意：此 commit 之後到 Task 3 完成之前，`npm run typecheck` 會失敗；Task 2 與 Task 3 要連續完成。

---

### Task 3: CLI、status、doctor 改看 run 層級的鎖

**Files:**
- Modify: `src/cli.ts`（import、`takeLock`、`clear`、`unlock`）
- Modify: `src/status.ts:9`、`src/status.ts:61-66`
- Modify: `src/doctor.ts:6`、`src/doctor.ts:154-173`
- Test: `test/status.test.ts`、`test/doctor.test.ts`、`test/run-lifecycle.test.ts`、`test/cancel.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `acquireProjectLock(root, runId, { maxConcurrent })`、`listRunLocks`、`inspectRunLock`、`forceUnlock(root, runId?)`
- Produces:
  - `takeLock(pr, runId, opts?: { ignoreLimit?: boolean })`（`clear` 傳 `ignoreLimit: true`，因為它不是新的 run）
  - CLI：`unlock [run-id] [-p name] --force`

- [ ] **Step 1: 寫失敗的測試**

`test/status.test.ts`：先看檔頭 import，補上 `acquireProjectLock`（`import { acquireProjectLock } from "../src/project-lock.js";`），加入（若檔內已有 `makeRunDir`／建立 run 的輔助函式就沿用；否則用以下自帶版本）：

```ts
describe("several runs at once", () => {
  it("shows every run whose own lock is held as running, and a crashed one as interrupted", () => {
    env = makeEnv();
    const p = env.project();
    const mk = (id: string) => {
      const dir = path.join(p.paths.runs, id);
      fs.mkdirSync(dir, { recursive: true });
      saveRunState(dir, newRunState({ run_id: id, project: "demo", max_rounds: 5, task_summary: id, pid: 999_999 }));
    };
    mk("20261007T000001000Z-aaaa");
    mk("20261007T000002000Z-bbbb");
    mk("20261007T000003000Z-cccc");
    const l1 = acquireProjectLock(p.paths.root, "20261007T000001000Z-aaaa", { maxConcurrent: 2 });
    const l2 = acquireProjectLock(p.paths.root, "20261007T000002000Z-bbbb", { maxConcurrent: 2 });
    const states = Object.fromEntries(buildTaskListReport(p).runs.map((r) => [r.run_id, r.state]));
    expect(states).toEqual({
      "20261007T000001000Z-aaaa": "running",
      "20261007T000002000Z-bbbb": "running",
      "20261007T000003000Z-cccc": "interrupted",
    });
    l1.release();
    l2.release();
  });
});
```
檔頭 import 需有 `fs`、`path`、`newRunState`／`saveRunState`（自 `../src/run-store.js`）、`buildTaskListReport`（自 `../src/status.js`）、`makeEnv`、`TestEnv`；缺哪個補哪個，並確保檔內有 `let env: TestEnv; afterEach(() => env?.cleanup());`（多數測試檔已有）。

`test/doctor.test.ts`：加入

```ts
  it("lists every active run lock and notes that concurrent runs start from HEAD", async () => {
    env = makeEnv();
    initGitRepo(env.repo);
    makeConcurrent(env, 2);
    write(path.join(env.repo, "dirty.txt"), "x\n");
    const p = env.project();
    const a = acquireProjectLock(p.paths.root, "run-a", { maxConcurrent: 2 });
    const b = acquireProjectLock(p.paths.root, "run-b", { maxConcurrent: 2 });
    const { bin } = fakeBin(env.root);
    const report = await diagnoseProject(p, { env: envWith(bin, "full") });
    const msgs = report.checks.map((c) => `${c.level}:${c.message}`).join("\n");
    expect(msgs).toMatch(/A run is active: run-a/);
    expect(msgs).toMatch(/A run is active: run-b/);
    expect(msgs).toMatch(/info:.*uncommitted.*concurrent runs start from HEAD/);
    a.release();
    b.release();
  });
```
檔頭 import 補 `acquireProjectLock`（自 `../src/project-lock.js`）、`initGitRepo`、`makeConcurrent`、`write`（`import { initGitRepo, makeConcurrent, makeEnv, write, type TestEnv } from "./helpers.js";`）；`fakeBin`、`envWith` 是該檔既有的輔助函式。

`test/run-lifecycle.test.ts`：檔頭加 `import { acquireProjectLock, listRunLocks } from "../src/project-lock.js";`，把第 59 行

```ts
    expect(fs.existsSync(path.join(env.project().paths.root, "lock.json"))).toBe(false);
```
改為

```ts
    expect(listRunLocks(env.project().paths.root)).toEqual([]);
```

並在檔尾 `describe` 內加入：

```ts
  it("refuses to start a second run while another holds the lock and max_concurrent_runs is 1", () => {
    const t = setup({ calls: [] });
    const lease = acquireProjectLock(env.project().paths.root, "other-run");
    try {
      const r = t.sync(["run", "x", "-p", "demo"]);
      expect(r.code).toBe(1);
      expect(r.err).toMatch(/other-run/);
      expect(r.err).toMatch(/max_concurrent_runs/);
    } finally {
      lease.release();
    }
  }, 60_000);

  it("unlock names the lock, needs --force, and with several locks insists on a run id", () => {
    const t = setup({ calls: [] });
    const root = env.project().paths.root;
    const a = acquireProjectLock(root, "run-a", { maxConcurrent: 2 });
    const b = acquireProjectLock(root, "run-b", { maxConcurrent: 2 });
    try {
      const many = t.sync(["unlock", "-p", "demo", "--force"]);
      expect(many.code).toBe(1);
      expect(many.err).toMatch(/run-a/);
      expect(many.err).toMatch(/run-b/);
      expect(many.err).toMatch(/unlock <run-id>/);
      expect(listRunLocks(root)).toHaveLength(2);

      const noForce = t.sync(["unlock", "run-a", "-p", "demo"]);
      expect(noForce.code).toBe(1);
      expect(listRunLocks(root)).toHaveLength(2);

      const one = t.sync(["unlock", "run-a", "-p", "demo", "--force"]);
      expect(one.code).toBe(0);
      expect(listRunLocks(root).map((l) => l.run_id)).toEqual(["run-b"]);
    } finally {
      a.release();
      b.release();
    }
  }, 60_000);
```

`test/cancel.test.ts`：檔頭加 `import { listRunLocks } from "../src/project-lock.js";`，把兩處 `fs.existsSync(path.join(env.project().paths.root, "lock.json"))` 改成 `listRunLocks(env.project().paths.root).length > 0`（第一處期望 `true`，第二處期望 `false`，其餘不變）。

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx vitest run test/status.test.ts test/doctor.test.ts test/run-lifecycle.test.ts test/cancel.test.ts`
Expected: FAIL（`src/cli.ts` 等仍 import 已移除的 `inspectProjectLock`；`unlock` 不接受 run id）。

- [ ] **Step 3: 實作**

`src/status.ts`：第 9 行改為 `import { inspectRunLock, lockHolderAlive } from "./project-lock.js";`，`runIsAlive` 內

```ts
  if (project && s.schema_version >= 2) {
    const l = inspectRunLock(project.paths.root, s.run_id);
    if (l) return lockHolderAlive(l);
  }
  return alive(s.pid);
```
（取代原本的 `inspectProjectLock` 版本；函式註解改為「Runs with a lock (schema 2) are judged by the lock holder of that run; ...」。）

`src/doctor.ts`：第 6 行改為 `import { listRunLocks, lockHolderAlive } from "./project-lock.js";`。取代 git 檢查與 lock 檢查（原 154–173 行）：

```ts
  if (fs.existsSync(project.dir) && isGitRepo(project.dir)) {
    if (resolveWorkspaceMode(project.dispatcher) === "worktree") {
      const dirty = dirtyPaths(project.dir);
      if (dirty.length && project.dispatcher.max_concurrent_runs > 1) {
        checks.push({ level: "info", subject: "git", message: `${dirty.length} uncommitted change(s) in ${project.dir}: concurrent runs start from HEAD and do not see them.` });
      } else if (dirty.length) {
        checks.push({ level: "warn", subject: "git", message: `${dirty.length} uncommitted change(s) in ${project.dir}: a parallel run would refuse to start until they are committed or stashed.` });
      } else checks.push({ level: "ok", subject: "git", message: "Repo is clean; parallel runs can start." });
    }
  }

  for (const lock of listRunLocks(project.paths.root)) {
    const alive = lockHolderAlive(lock);
    checks.push({
      level: "warn",
      subject: "lock",
      message: alive
        ? `A run is active: ${lock.run_id} (pid ${lock.pid}).`
        : `A stale run lock is left by ${lock.run_id} (pid ${lock.pid} is gone); \`agent-lyceum unlock ${lock.run_id} --force\` clears it.`,
    });
  }
```
（若原檔 `dirty` 之外的 `info` level 已存在於 `DoctorCheck`，沿用；原檔已使用 `"info"`。）

`src/cli.ts`：
- import 改為 `import { acquireProjectLock, forceUnlock, inspectRunLock, listRunLocks, LOCK_FILE, lockHolderAlive, type ProjectLease } from "./project-lock.js";`
- `takeLock` 取代為：

```ts
/** Take the lock of one run, or exit with the reason. `ignoreLimit`: the caller does not start a run (e.g. `clear`). */
function takeLock(pr: ResolvedProject, runId: string, opts: { ignoreLimit?: boolean } = {}): ProjectLease {
  try {
    return acquireProjectLock(pr.paths.root, runId, { maxConcurrent: opts.ignoreLimit ? Number.MAX_SAFE_INTEGER : pr.dispatcher.max_concurrent_runs });
  } catch (e) {
    return fail((e as Error).message);
  }
}
```
- `clear` 內 `const lease = takeLock(pr, runId);` 改為 `const lease = takeLock(pr, runId, { ignoreLimit: true });`。`run`、`resume` 不變。
- `unlock` 指令整段取代為：

```ts
program
  .command("unlock [run-id]")
  .description("Remove the run lock a crashed run left behind. Shows the lock first; needs --force to remove it. With several locks, name the run.")
  .option("-p, --project <name>")
  .option("--force", "remove the lock even though its owner cannot be confirmed dead")
  .action((runId: string | undefined, opts: { project?: string; force?: boolean }) => {
    try {
      const pr = loadProject(opts.project);
      const root = pr.paths.root;
      if (runId) assertName("run", runId);
      const locks = listRunLocks(root);
      if (!runId && locks.length > 1) {
        const list = locks.map((l) => `  ${l.run_id}  pid ${l.pid}${lockHolderAlive(l) ? " (alive)" : " (gone)"}`).join("\n");
        fail(`Several runs hold a lock:\n${list}\nName the one to unlock: agent-lyceum unlock <run-id> --force`);
      }
      const target = runId ?? locks[0]?.run_id;
      if (!target) {
        if (!fs.existsSync(path.join(root, LOCK_FILE))) {
          console.log(`Project ${pr.name} has no run lock.`);
          return;
        }
        console.log("The lock file exists but cannot be read.");
        if (!opts.force) fail("Not removed. Check that no run is active, then repeat with --force.");
        forceUnlock(root);
        console.log("Lock removed.");
        return;
      }
      const info = inspectRunLock(root, target);
      if (!info) fail(`Run "${target}" holds no readable lock. List the locks with: agent-lyceum doctor`);
      console.log(`Lock held for run ${info!.run_id} by pid ${info!.pid} on ${info!.hostname}, last heartbeat ${info!.heartbeat_at}${lockHolderAlive(info!) ? " (that process is still alive)" : " (that process is gone)"}.`);
      if (!opts.force) fail("Not removed. Check that no run is active, then repeat with --force.");
      forceUnlock(root, target);
      console.log(`Lock removed. Resume the run with: agent-lyceum resume ${target}`);
    } catch (e) {
      fail((e as Error).message);
    }
  });
```

- [ ] **Step 4: 跑測試確認通過**

Run: `npm run typecheck && npx vitest run && npm run lint`
Expected: PASS（全部 25+ 個測試檔；`fatal: path 'ignored.log' exists ...` 那行是既有測試的預期 stderr，不是失敗）。

- [ ] **Step 5: Commit**

```bash
git add src/cli.ts src/status.ts src/doctor.ts test/status.test.ts test/doctor.test.ts test/run-lifecycle.test.ts test/cancel.test.ts
git commit -m "feat(cli): per-run locks in run, resume, clear, unlock, status and doctor"
```

---

### Task 4: worktree 基礎能力（起點 HEAD、可指定目標、提交 lead 分支）

**Files:**
- Modify: `src/worktree.ts`（`assertWorktreeRunnable`、`snapshotBase`、`integrateAgentChanges`、`inspectWorkspace`；新增 `snapshotHead`、`commitWorkspace`、`finishLeadBranch`；`collectAgentChanges` 改用 `commitWorkspace`）
- Test: `test/worktree.test.ts`、`test/integration.test.ts`

**Interfaces:**
- Produces:
  - `assertWorktreeRunnable(project, opts: { fresh: boolean; concurrent?: boolean })`：`concurrent` 時不檢查 dirty，改檢查 `HEAD` 存在
  - `snapshotHead(project: ResolvedProject, runId: string): string` — 建立 `refs/agent-lyceum/<run>/base-0` 指向 `HEAD`，回傳 ref
  - `snapshotBase(project, runId, n, from = project.dir): string` — 對 `from`（例如 lead 的 worktree）取快照
  - `integrateAgentChanges(project, changes, targetRoot?: string)` — `targetRoot` 是要套用變更的 checkout 根目錄（預設使用者的 repo）
  - `inspectWorkspace(project, runId, agent, target?: string)` — 與 `target` 比較「是否已在裡面」
  - `commitWorkspace(root: string, message: string): { head: string; committed: boolean }`
  - `export interface ResultBranch { branch: string; head: string; base: string; files: number; patch?: string }`
  - `finishLeadBranch(ws: AgentWorkspace, message: string, patchFile: string): ResultBranch`

- [ ] **Step 1: 寫失敗的測試**

`test/worktree.test.ts`：檔頭 import 補 `assertWorktreeRunnable, commitWorkspace, finishLeadBranch, inspectWorkspace, integrateAgentChanges, collectAgentChanges, snapshotHead`（自 `../src/worktree.js`，已有者略過）與 `makeConcurrent`，並確認有 `import fs from "node:fs"; import path from "node:path";`。在檔尾加入：

```ts
describe("concurrent runs: base and lead workspace", () => {
  function concurrentRepo() {
    env = makeEnv();
    initGitRepo(env.repo);
    makeConcurrent(env, 2);
    return env.project();
  }

  it("starts from HEAD even when the working tree has uncommitted changes, and leaves the working tree alone", () => {
    const p = concurrentRepo();
    write(path.join(env.repo, "src/web/a.txt"), "uncommitted edit\n");
    expect(() => assertWorktreeRunnable(p, { fresh: true, concurrent: true })).not.toThrow();
    expect(() => assertWorktreeRunnable(p, { fresh: true })).toThrow(/uncommitted/);
    const ref = snapshotHead(p, "run-1");
    expect(ref).toBe("refs/agent-lyceum/run-1/base-0");
    expect(git(env.repo, "rev-parse", ref)).toBe(git(env.repo, "rev-parse", "HEAD"));
    const ws = prepareAgentWorkspace(p, "run-1", "lead", ref);
    expect(fs.readFileSync(path.join(ws.dir, "src/web/a.txt"), "utf8")).toBe("a\n"); // the edit is not part of the run
    expect(fs.readFileSync(path.join(env.repo, "src/web/a.txt"), "utf8")).toBe("uncommitted edit\n");
    expect(ws.branch).toBe("agent-lyceum/run-1/lead");
  });

  it("refuses a repository without any commit", () => {
    env = makeEnv();
    git(env.repo, "init", "-q", "-b", "main");
    makeConcurrent(env, 2);
    expect(() => assertWorktreeRunnable(env.project(), { fresh: true, concurrent: true })).toThrow(/no commit yet/);
  });

  it("snapshots the lead's worktree for members and brings a member's files into the lead's worktree, not the repo", () => {
    const p = concurrentRepo();
    const lead = prepareAgentWorkspace(p, "run-1", "lead", snapshotHead(p, "run-1"));
    write(path.join(lead.dir, "src/web/lead-note.txt"), "lead was here\n");
    const ref = snapshotBase(p, "run-1", 1, lead.root);
    const member = prepareAgentWorkspace(p, "run-1", "fe-member", ref);
    expect(fs.readFileSync(path.join(member.dir, "src/web/lead-note.txt"), "utf8")).toBe("lead was here\n");
    write(path.join(member.dir, "src/web/feature.txt"), "built\n");
    const r = integrateAgentChanges(p, collectAgentChanges(member, ["src/web/**"]), lead.root);
    expect(r.status).toBe("integrated");
    expect(fs.readFileSync(path.join(lead.dir, "src/web/feature.txt"), "utf8")).toBe("built\n");
    expect(fs.existsSync(path.join(env.repo, "src/web/feature.txt"))).toBe(false);
    expect(git(env.repo, "status", "--porcelain")).toBe("");
  });

  it("commits the lead's work on its branch and writes a patch; a run with no changes commits nothing", () => {
    const p = concurrentRepo();
    const lead = prepareAgentWorkspace(p, "run-1", "lead", snapshotHead(p, "run-1"));
    const none = finishLeadBranch(lead, "msg", path.join(env.root, "none.patch"));
    expect(none).toMatchObject({ files: 0, head: lead.base });
    expect(none.patch).toBeUndefined();

    write(path.join(lead.dir, "src/web/new.txt"), "new\n");
    const rb = finishLeadBranch(lead, "agent-lyceum: lead's work for run run-1", path.join(env.root, "lead.patch"));
    expect(rb.files).toBe(1);
    expect(rb.branch).toBe("agent-lyceum/run-1/lead");
    expect(git(env.repo, "log", "-1", "--format=%s", rb.branch)).toBe("agent-lyceum: lead's work for run run-1");
    expect(fs.readFileSync(rb.patch!, "utf8")).toContain("src/web/new.txt");
    expect(commitWorkspace(lead.root, "again")).toMatchObject({ committed: false, head: rb.head });
    expect(git(env.repo, "status", "--porcelain")).toBe("");
    // merging the branch brings the work in
    git(env.repo, "merge", "-q", "--no-edit", rb.branch);
    expect(fs.readFileSync(path.join(env.repo, "src/web/new.txt"), "utf8")).toBe("new\n");
  });

  it("inspectWorkspace compares a member with the lead's worktree, and the lead with the repo", () => {
    const p = concurrentRepo();
    const lead = prepareAgentWorkspace(p, "run-1", "lead", snapshotHead(p, "run-1"));
    const ref = snapshotBase(p, "run-1", 1, lead.root);
    const member = prepareAgentWorkspace(p, "run-1", "fe-member", ref);
    write(path.join(member.dir, "src/web/feature.txt"), "built\n");
    integrateAgentChanges(p, collectAgentChanges(member, ["src/web/**"]), lead.root);
    // the member's file is in the lead's worktree, so the member holds nothing that exists nowhere else
    expect(inspectWorkspace(p, "run-1", "fe-member", lead.root)?.unintegrated).toEqual([]);
    // the lead's worktree holds it, and the repo does not have it yet
    expect(inspectWorkspace(p, "run-1", "lead")?.dirty).toContain("src/web/feature.txt");
    finishLeadBranch(lead, "m", path.join(env.root, "p.patch"));
    expect(inspectWorkspace(p, "run-1", "lead")?.unintegrated).toContain("src/web/feature.txt");
    git(env.repo, "merge", "-q", "--no-edit", lead.branch);
    expect(inspectWorkspace(p, "run-1", "lead")?.unintegrated).toEqual([]);
  });
});
```
（`write`、`git`、`initGitRepo`、`makeEnv`、`prepareAgentWorkspace`、`snapshotBase` 檔內大多已 import；缺的補上。）

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx vitest run test/worktree.test.ts`
Expected: FAIL（`snapshotHead`、`commitWorkspace`、`finishLeadBranch` 不存在；`snapshotBase` 不接受第四個參數）。

- [ ] **Step 3: 實作**

`src/worktree.ts`：

1. `assertWorktreeRunnable` 整個取代：

```ts
/** Refuse to start a worktree run when it cannot be isolated; returns nothing when it is fine. */
export function assertWorktreeRunnable(project: ResolvedProject, opts: { fresh: boolean; concurrent?: boolean }): void {
  if (!isGitRepo(project.dir)) {
    throw new Error(`Parallel runs (worktree workspaces) need ${project.dir} to be a git repository. Run sequentially instead: dispatcher.max_parallel: 1.`);
  }
  if (!opts.fresh) return;
  if (opts.concurrent) {
    // A concurrent run starts from HEAD and never touches the working tree, so uncommitted changes are fine.
    if (tryGit(project.dir, ["rev-parse", "--verify", "-q", "HEAD"]) === undefined) {
      throw new Error(`Concurrent runs start from HEAD, but ${project.dir} has no commit yet. Make an initial commit, or set dispatcher.max_concurrent_runs: 1.`);
    }
    return;
  }
  const dirty = dirtyPaths(project.dir);
  if (dirty.length) {
    const shown = dirty.slice(0, 5).join(", ") + (dirty.length > 5 ? `, ... (${dirty.length} in all)` : "");
    throw new Error(
      `Parallel runs start from a clean repo, but ${project.dir} has uncommitted changes: ${shown}. ` +
        `Commit or stash them first (agent-lyceum never touches your own edits), or run sequentially with dispatcher.max_parallel: 1.`,
    );
  }
}
```

2. `snapshotBase` 簽名與第一行：

```ts
export function snapshotBase(project: ResolvedProject, runId: string, n: number, from: string = project.dir): string {
  const top = toplevel(from);
```
（其餘主體不變；`from` 是 lead 的 worktree 時，快照的是那個 checkout 的 HEAD 加工作區內容。）並在 `snapshotBase` 之前新增：

```ts
/** `refs/agent-lyceum/<run>/base-0` pointing at the repo's HEAD: where a concurrent run starts. Nothing in the repo changes. */
export function snapshotHead(project: ResolvedProject, runId: string): string {
  const top = toplevel(project.dir);
  const sha = git(top, ["rev-parse", "--verify", "HEAD^{commit}"]);
  const ref = `refs/agent-lyceum/${runId}/base-0`;
  git(top, ["update-ref", ref, sha]);
  return ref;
}
```

3. 在 `collectAgentChanges` 之前新增，並讓 `collectAgentChanges` 使用它：

```ts
/** Commit whatever is in a checkout (user hooks and signing off, dispatcher identity). Returns the HEAD afterwards and whether a commit was made. */
export function commitWorkspace(root: string, message: string): { head: string; committed: boolean } {
  git(root, ["add", "-A"]);
  let committed = false;
  if (tryGit(root, ["diff", "--cached", "--quiet"]) === undefined) {
    // hooks belong to the user's repo (a worktree shares them): do not run them for the dispatcher's own commit
    git(root, ["-c", "commit.gpgsign=false", "commit", "-q", "--no-verify", "-m", message], IDENTITY);
    committed = true;
  }
  return { head: git(root, ["rev-parse", "HEAD"]), committed };
}
```
`collectAgentChanges` 開頭（原 `git(root, ["add", "-A"]);` 到 `const head = ...;` 這幾行）取代為：

```ts
  const { root } = workspace;
  const { head } = commitWorkspace(root, `agent-lyceum: changes by ${workspace.agent}`);
```
（原函式第一行 `const { root } = workspace;` 保留一次即可，並刪除原本的 `git add`／`diff --cached`／`commit`／`const head` 四段。）

4. `integrateAgentChanges` 簽名與第一行：

```ts
export function integrateAgentChanges(project: ResolvedProject, changes: ChangeSet, targetRoot?: string): IntegrationResult {
  const top = targetRoot ?? toplevel(project.dir);
```
函式上方註解補一句：「`targetRoot`: the checkout to bring the changes into — the lead's worktree in a concurrent run; by default your repo's working tree.」

5. `inspectWorkspace` 簽名與取得 `top` 的那行：

```ts
export function inspectWorkspace(project: ResolvedProject, runId: string, agent: string, target?: string): WorkspaceWork | undefined {
```
並把函式內 `const top = toplevel(project.dir);` 改為 `const top = target ?? toplevel(project.dir);`。

6. 在 `listWorkspaceAgents` 之前新增：

```ts
export interface ResultBranch {
  branch: string;
  head: string;
  /** The snapshot the run started from. */
  base: string;
  /** Files the branch changes relative to `base`. */
  files: number;
  /** The same changes as a patch file (absent when nothing changed). */
  patch?: string;
}

/** Commit the lead's checkout on its branch (once, at the end of a run) and write what changed as a patch. Never touches your repo's working tree. */
export function finishLeadBranch(ws: AgentWorkspace, message: string, patchFile: string): ResultBranch {
  const { head } = commitWorkspace(ws.root, message);
  const files = head === ws.base ? [] : git(ws.root, ["diff", "--name-only", ws.base, head]).split("\n").filter(Boolean);
  if (files.length) fs.writeFileSync(patchFile, git(ws.root, ["diff", "--binary", "--full-index", ws.base, head]) + "\n");
  return { branch: ws.branch, head, base: ws.base, files: files.length, patch: files.length ? patchFile : undefined };
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `npm run typecheck && npx vitest run test/worktree.test.ts test/integration.test.ts test/run-cleanup.test.ts`
Expected: PASS（既有 `integration`、`run-cleanup` 測試不傳新參數，行為不變）。

- [ ] **Step 5: Commit**

```bash
git add src/worktree.ts test/worktree.test.ts
git commit -m "feat(worktree): start from HEAD, integrate into a chosen checkout, commit the lead's branch"
```

---

### Task 5: run 接上 lead worktree 與結束時提交

**Files:**
- Modify: `src/run-store.ts`（`RunState.result_branch`）
- Modify: `src/run-session.ts`（import、`RunSummary`、`RunSession` 欄位、constructor、`wake`、`integrateMember`、`run`）
- Modify: `src/cli.ts`（`reportRun`）
- Test: `test/integration.test.ts`

**Interfaces:**
- Consumes: Task 4 的 `assertWorktreeRunnable(project, { fresh, concurrent })`、`snapshotHead`、`snapshotBase(..., from)`、`integrateAgentChanges(..., targetRoot)`、`finishLeadBranch`、`ResultBranch`、`dirtyPaths`、`existingAgentWorkspace`、`prepareAgentWorkspace`
- Produces:
  - `RunState.result_branch?: ResultBranch`
  - `RunSummary.resultBranch?: ResultBranch`
  - 檔案 `runs/<run-id>/lead.patch`（有變更時）

- [ ] **Step 1: 寫失敗的測試**

`test/integration.test.ts`：檔頭 import 補 `makeConcurrent`（`import { ..., makeConcurrent, ... } from "./helpers.js"`，在現有 helpers import 上加）。在 `describe("dispatcher integration", ...)` 內，`start` 之後加入：

```ts
  it("a concurrent run works in the lead's own worktree, brings members into it, and commits one branch without touching the repo", async () => {
    env = makeEnv();
    initGitRepo(env.repo);
    makeParallel(env);
    makeConcurrent(env, 2);
    write(path.join(env.repo, "src/web/a.txt"), "uncommitted edit\n"); // yours, and not part of the run
    const headBefore = git(env.repo, "rev-parse", "HEAD");
    let leadCalls = 0;
    let leadDir = "";
    const { summary, runDir } = await start(async (i) => {
      if (i.agent.name === "lead") {
        leadDir = i.workspace!.dir;
        expect(i.workspace!.branch).toBe("agent-lyceum/run-1/lead");
        expect(fs.readFileSync(path.join(leadDir, "src/web/a.txt"), "utf8")).toBe("a\n");
        if (++leadCalls === 1) {
          write(path.join(leadDir, "tests/lead-note.txt"), "lead\n");
          mail(i.project, "lead", "fe-member", "job", "task");
        } else {
          expect(fs.readFileSync(path.join(leadDir, "src/web/feature.txt"), "utf8")).toBe("member built\n"); // brought into the lead's worktree
          mail(i.project, "lead", "lead", "bye", "done");
        }
      } else {
        write(path.join(i.workspace!.dir, "src/web/feature.txt"), "member built\n");
        mail(i.project, i.agent.name, "lead", "finished");
      }
      return OK;
    });
    expect(summary.outcome).toBe("completed");
    expect(summary.resultBranch).toMatchObject({ branch: "agent-lyceum/run-1/lead", files: 2 });
    expect(loadRunState(runDir).result_branch?.head).toBe(summary.resultBranch!.head);
    expect(fs.readFileSync(path.join(runDir, "lead.patch"), "utf8")).toContain("src/web/feature.txt");
    // the repo: HEAD, working tree and index are as they were
    expect(git(env.repo, "rev-parse", "HEAD")).toBe(headBefore);
    expect(git(env.repo, "status", "--porcelain")).toBe("M src/web/a.txt");
    expect(fs.existsSync(path.join(env.repo, "src/web/feature.txt"))).toBe(false);
    // the branch carries the work
    expect(git(env.repo, "show", "agent-lyceum/run-1/lead:src/web/feature.txt")).toBe("member built");
    expect(git(env.repo, "show", "agent-lyceum/run-1/lead:tests/lead-note.txt")).toBe("lead");
  });

  it("two concurrent runs of one project do not see each other's files", async () => {
    env = makeEnv();
    initGitRepo(env.repo);
    makeConcurrent(env, 2);
    const project = env.project();
    const runOne = async (id: string) => {
      const runDir = path.join(project.paths.runs, id);
      const task = prepareTask({ text: `task ${id}`, cwd: env.root, runDir });
      return runTeam({
        project,
        task,
        runDir,
        log: () => {},
        invoker: async (i) => {
          write(path.join(i.workspace!.dir, `src/web/${id}.txt`), `${id}\n`);
          expect(fs.readdirSync(path.join(i.workspace!.dir, "src/web")).filter((f) => f.endsWith(".txt") && f !== "a.txt")).toEqual([`${id}.txt`]);
          mail(i.project, "lead", "lead", "bye", "done");
          return OK;
        },
      });
    };
    const [a, b] = await Promise.all([runOne("run-a"), runOne("run-b")]);
    expect([a.outcome, b.outcome]).toEqual(["completed", "completed"]);
    expect(git(env.repo, "status", "--porcelain")).toBe("");
    expect(git(env.repo, "ls-tree", "--name-only", "agent-lyceum/run-a/lead", "src/web/")).toBe("src/web/a.txt\nsrc/web/run-a.txt");
    expect(git(env.repo, "ls-tree", "--name-only", "agent-lyceum/run-b/lead", "src/web/")).toBe("src/web/a.txt\nsrc/web/run-b.txt");
  });
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx vitest run test/integration.test.ts -t "concurrent"`
Expected: FAIL（`i.workspace` 對 lead 是 `undefined`；`summary.resultBranch` 不存在）。

- [ ] **Step 3: 實作**

`src/run-store.ts`：`import type { ResultBranch } from "./worktree.js";`；`RunState` 在 `snapshots?: number;` 後加

```ts
  /** Concurrent runs: where the lead's work ended up (`git merge <branch>`). Set when the run ends. */
  result_branch?: ResultBranch;
```
（`WireState` 是 `passthrough()`，`normalize` 以 `...(w as object)` 保留此欄位，不需改。若 `run-store.ts` 與 `worktree.ts` 之間出現循環 import，改用 `import type` 即可，不會有執行期相依。）

`src/run-session.ts`：

1. import 行改為：

```ts
import { assertWorktreeRunnable, collectAgentChanges, dirtyPaths, existingAgentWorkspace, finishLeadBranch, git, integrateAgentChanges, prepareAgentWorkspace, resolveWorkspaceMode, snapshotBase, snapshotHead, type AgentWorkspace, type ResultBranch } from "./worktree.js";
```

2. `RunSummary` 加：

```ts
  /** Concurrent runs: the branch holding the lead's work. */
  resultBranch?: ResultBranch;
```

3. `RunSession` 欄位（`batchSpaces` 之後）加：

```ts
  /** Concurrent runs: the lead's own git worktree for the whole run. */
  private readonly leadSpace: AgentWorkspace | undefined;
```

4. constructor：`if (wsMode === "worktree") assertWorktreeRunnable(project, { fresh: !resume });` 改為

```ts
    const concurrent = cfg.max_concurrent_runs > 1;
    if (wsMode === "worktree") assertWorktreeRunnable(project, { fresh: !resume, concurrent });
```
在 constructor 內 `saveState();`（`guard`／`deliver` 區塊之後那一行）之後、`this.opts = opts;` 之前加入：

```ts
    // Concurrent runs: the lead works in its own worktree cut from HEAD, so no other run (and not you) shares its files.
    let leadSpace: AgentWorkspace | undefined;
    if (concurrent) {
      if (resume) {
        leadSpace = existingAgentWorkspace(project, runId, project.lead);
        if (!leadSpace) throw new Error(`Run ${runId} has no worktree for ${project.lead} (was it cleared?), so it cannot be resumed.`);
      } else {
        leadSpace = prepareAgentWorkspace(project, runId, project.lead, snapshotHead(project, runId));
        const uncommitted = dirtyPaths(project.dir).length;
        say(`  starting from HEAD ${leadSpace.base.slice(0, 8)}${uncommitted ? ` (your ${uncommitted} uncommitted file(s) are not part of this run)` : ""}; ${project.lead} works on branch ${leadSpace.branch}`);
        log("lead-workspace", { base: leadSpace.base, branch: leadSpace.branch, dir: leadSpace.dir, uncommitted });
      }
    }
    this.leadSpace = leadSpace;
```

5. `wake()`：把

```ts
    const aproject = Object.keys(this.batchSpaces).length ? { ...project, workspaces: this.batchSpaces } : project;
```
改為

```ts
    const spaces = this.leadSpace ? { ...this.batchSpaces, [project.lead]: this.leadSpace } : this.batchSpaces;
    const aproject = Object.keys(spaces).length ? { ...project, workspaces: spaces } : project;
```
並把 `workspace: this.batchSpaces[agent.name],` 改為 `workspace: spaces[agent.name],`。

6. `integrateMember`：`const r = integrateAgentChanges(project, changes);` 改為 `const r = integrateAgentChanges(project, changes, this.leadSpace?.root);`。

7. `run()` 迴圈內：`const ref = snapshotBase(project, runId, state.snapshots);` 改為 `const ref = snapshotBase(project, runId, state.snapshots, this.leadSpace?.root);`。

8. 新增方法（放在 `recover()` 之前）：

```ts
  /** Concurrent runs, at the end of the run whatever the reason: the lead's work is committed on its branch for you to merge. */
  private finishLead(): ResultBranch | undefined {
    const { say, log, state, runDir, runId, project } = this;
    if (!this.leadSpace) return undefined;
    try {
      const rb = finishLeadBranch(this.leadSpace, `agent-lyceum: ${project.lead}'s work for run ${runId}\n\n${state.task_summary}`, path.join(runDir, "lead.patch"));
      state.result_branch = rb;
      log("lead-branch", { ...rb });
      say(rb.files ? `  work is on branch ${rb.branch} (${rb.files} file(s)); bring it into your repo with: git merge ${rb.branch}` : `  ${rb.branch}: no file changes`);
      return rb;
    } catch (e) {
      this.note(`Could not commit the work on ${this.leadSpace.branch}: ${(e as Error).message.split("\n")[0]}. It is still in ${this.leadSpace.root}.`);
      return undefined;
    }
  }
```

9. `run()` 結尾：在 `log("end", ...)` 之前呼叫，並放進回傳：

```ts
    const resultBranch = this.finishLead();
    log("end", { reason: endReason, outcome, rounds: state.rounds });
    this.saveState();
    if (this.pendingDoneFile) finishDone(this.pendingDoneFile);
    return { runId, runDir, rounds: state.rounds, endReason, outcome, outcomeNote, verification: this.doneVerification, doneMessage: this.doneMessage, resultBranch };
```
（`finishLead` 要在 `state.ended_at = ...` 之後、`this.saveState()` 之前，確保 `result_branch` 被寫進 `state.json`。）

`src/cli.ts` `reportRun`：在 `if (summary.doneMessage) {...}` 之前加：

```ts
  if (summary.resultBranch?.files) {
    console.log(`\nThe work is on branch ${summary.resultBranch.branch} (${summary.resultBranch.files} file(s)); your working tree was not touched.\nBring it in with: git merge ${summary.resultBranch.branch}${summary.resultBranch.patch ? `\n(or apply the patch: git apply ${summary.resultBranch.patch})` : ""}`);
  }
```

> 已知限制（寫進 README 的併發段落，Task 7）：lead 若被設定 `can_edit_agent_md: true`，仍可編輯使用者 repo 的 `CLAUDE.md`／`AGENTS.md`（`policy.repoInstructionFiles`），這是明確授權的例外，不在 worktree 內；`ProtectedGuard` 會照常偵測。

- [ ] **Step 4: 跑測試確認通過**

Run: `npm run typecheck && npx vitest run`
Expected: PASS。若 `lint` 對新 import 順序有意見，依 Biome 輸出調整。

- [ ] **Step 5: Commit**

```bash
git add src/run-store.ts src/run-session.ts src/cli.ts test/integration.test.ts
git commit -m "feat(run): concurrent runs work in the lead's worktree and commit one branch"
```

---

### Task 6: `clear` 對 lead 分支的保護

**Files:**
- Modify: `src/run-cleanup.ts`（`planRunCleanup` 的 worktree 迴圈）
- Test: `test/run-cleanup.test.ts`

**Interfaces:**
- Consumes: Task 4 的 `inspectWorkspace(project, runId, agent, target?)`、`existingAgentWorkspace`
- Produces: 行為：lead 分支未合入 `HEAD` 時 `planRunCleanup` 產生 refusal，訊息含 `git merge <branch>`；成員以 lead 的 worktree 為比較對象

- [ ] **Step 1: 寫失敗的測試**

`test/run-cleanup.test.ts`：檔頭 import 補 `makeConcurrent`，從 `../src/worktree.js` 補 `commitWorkspace, finishLeadBranch, snapshotHead`（`prepareAgentWorkspace`、`snapshotBase`、`collectAgentChanges`、`integrateAgentChanges` 已 import）。在檔尾加入：

```ts
describe("clear: a concurrent run's branch", () => {
  function concurrentRun() {
    env = makeEnv();
    initGitRepo(env.repo);
    makeParallel(env);
    makeConcurrent(env, 2);
    const p = env.project();
    makeRun("run-1");
    const lead = prepareAgentWorkspace(p, "run-1", "lead", snapshotHead(p, "run-1"));
    write(path.join(lead.dir, "src/web/lead.txt"), "lead work\n");
    return { p, lead };
  }

  it("refuses while the lead's branch is not merged, and says how to merge it", () => {
    const { p, lead } = concurrentRun();
    finishLeadBranch(lead, "msg", path.join(env.root, "x.patch"));
    const plan = planRunCleanup(p, "run-1");
    expect(plan.refusals.join("\n")).toMatch(/lead has work that is not in the repo.*src\/web\/lead\.txt/s);
    expect(plan.refusals.join("\n")).toContain(`git merge ${lead.branch}`);
  });

  it("deletes the lead's worktree and branch once the branch is merged", () => {
    const { p, lead } = concurrentRun();
    finishLeadBranch(lead, "msg", path.join(env.root, "x.patch"));
    git(env.repo, "merge", "-q", "--no-edit", lead.branch);
    const plan = planRunCleanup(p, "run-1");
    expect(plan.refusals).toEqual([]);
    expect(plan.items.map((i) => i.kind)).toContain("workspace");
    expect(executeRunCleanup(plan).failed).toEqual([]);
    expect(git(env.repo, "branch", "--list", lead.branch)).toBe("");
    expect(exists(p.paths.root, "worktrees", "run-1", "lead")).toBe(false);
  });

  it("--keep-worktrees keeps the unmerged branch and clears the rest", () => {
    const { p, lead } = concurrentRun();
    finishLeadBranch(lead, "msg", path.join(env.root, "x.patch"));
    const plan = planRunCleanup(p, "run-1", { keepWorktrees: true });
    expect(plan.refusals).toEqual([]);
    expect(executeRunCleanup(plan).failed).toEqual([]);
    expect(git(env.repo, "branch", "--list", lead.branch)).toContain("run-1/lead");
    expect(exists(p.paths.runs, "run-1")).toBe(false);
  });

  it("does not make a member's work block clear when the lead's worktree already has it", () => {
    const { p, lead } = concurrentRun();
    const member = prepareAgentWorkspace(p, "run-1", "fe-member", snapshotBase(p, "run-1", 1, lead.root));
    write(path.join(member.dir, "src/web/feature.txt"), "built\n");
    integrateAgentChanges(p, collectAgentChanges(member, ["src/web/**"]), lead.root);
    finishLeadBranch(lead, "msg", path.join(env.root, "x.patch"));
    git(env.repo, "merge", "-q", "--no-edit", lead.branch);
    const plan = planRunCleanup(p, "run-1");
    expect(plan.refusals).toEqual([]);
    expect(plan.items.filter((i) => i.kind === "workspace").map((i) => i.agent).sort()).toEqual(["fe-member", "lead"]);
  });
});
```
（`write`、`git`、`initGitRepo`、`makeParallel`、`makeRun`、`exists` 檔內已存在或已 import；`makeParallel` 讓 `fe-member` 有 `owns`。）

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx vitest run test/run-cleanup.test.ts -t "concurrent run's branch"`
Expected: FAIL（lead 的未合入分支沒被辨識；成員以使用者 repo 為比較對象，被當成有未整合的工作）。

- [ ] **Step 3: 實作**

`src/run-cleanup.ts`：import 補 `existingAgentWorkspace`（自 `./worktree.js`）。把 worktree 迴圈的開頭與拒絕訊息改為：

```ts
  // A concurrent run has a worktree for the lead: members' work lands there, and the lead's branch is what you merge.
  const leadWs = existingAgentWorkspace(project, runId, project.lead);
  for (const agent of listWorkspaceAgents(project, runId)) {
    const w = inspectWorkspace(project, runId, agent, agent === project.lead ? undefined : leadWs?.root);
    if (!w) continue;
    const files = [...new Set([...w.dirty, ...w.unintegrated])];
    const holdsWork = files.length > 0 || !!w.unknown;
    if (keepWorktrees || holdsWork) {
      plan.keep.push({ agent, branch: w.branch, path: w.root, files: files.length ? files : w.unknown ? [`(${w.unknown})`] : [] });
      if (holdsWork && !keepWorktrees) {
        const merge = agent === project.lead && leadWs ? ` Merge it first with \`git merge ${w.branch}\`.` : "";
        plan.refusals.push(
          `${agent} has work that is not in the repo: ${files.length ? files.join(", ") : w.unknown} (branch ${w.branch}, worktree ${w.root}).${merge} ` +
            `Bring it in or discard it by hand, or use --keep-worktrees to keep the worktree and branch and clear the rest.`,
        );
      }
      continue;
    }
```
（取代原本 `for (const agent of listWorkspaceAgents(...)) {` 到 `continue; }` 的對應段落；`plan.items.push({ kind: "workspace", ... })` 之後的程式不動。）

- [ ] **Step 4: 跑測試確認通過**

Run: `npm run typecheck && npx vitest run test/run-cleanup.test.ts test/run-lifecycle.test.ts`
Expected: PASS（既有 `clear` 測試的訊息仍符合 `/src\/web\/a\.txt/`）。

- [ ] **Step 5: Commit**

```bash
git add src/run-cleanup.ts test/run-cleanup.test.ts
git commit -m "feat(clear): refuse to delete a concurrent run's lead branch until it is merged"
```

---

### Task 7: 文件與整體驗證

**Files:**
- Modify: `README.md`、`README.zh-TW.md`、`docs/commands.md`、`docs/commands.zh-TW.md`
- Modify: `docs/specs/07-concurrent-runs.md`（狀態改為已實作）、`docs/specs/README.md`（加一列）

**Interfaces:** 無（文件）。

- [ ] **Step 1: 更新 `README.md`**

1. 指令表 `unlock` 那列改為：

```
| `unlock [run-id] [-p name] --force` | Remove the lock a crashed run left behind. [details](docs/commands.md#unlock) |
```
2. Layout 區塊：把 `├── lock.json                     # held while a run is active: one run per project` 改為

```
    ├── locks/<run-id>.json           # held while that run is active (up to dispatcher.max_concurrent_runs at once)
```
3. 設定範例行（約第 89 行）改為 `dispatcher: { max_rounds: 30, max_parallel: 1, max_concurrent_runs: 1, wake_timeout_sec: 600, retry: 1, strict: false, workspace_mode: auto, log_max_bytes: 8388608 }`。
4. `validate` 規則那一段（約第 98 行）句尾補：`, and with max_concurrent_runs > 1 the repo must be a git repository and workspace_mode must not be shared`。
5. 在 "Parallelism (`max_parallel > 1`)" 那一整段之後，新增一個小節（標題層級與該段相鄰標題一致）：

```markdown
### Several runs at once

By default a project runs one task at a time. Set `dispatcher.max_concurrent_runs: N` (N > 1, needs a git repository) to let up to N runs of the same project be active together; starting one more is refused and names the runs in the way. In this mode **every** run, including a run that has no parallel members, works in its own git worktree: the lead in `projects/<name>/worktrees/<run-id>/<lead>` on branch `agent-lyceum/<run-id>/<lead>`, members in worktrees cut from the lead's. A run starts from your repo's `HEAD`, so your uncommitted changes are allowed and are **not** part of it (the start line says how many files that is). Your working tree, index and HEAD are never touched. When the run ends, for any reason, the lead's work is committed once on its branch and written as `runs/<run-id>/lead.patch`; the run prints `git merge <branch>`. agent-lyceum never merges for you, so two runs that edit the same file are for you to reconcile. `clear <run-id>` refuses while that branch is not merged (use `--keep-worktrees` to keep it). The number of agent processes can reach `max_concurrent_runs × max_parallel`; there is no global cap. A lead with `can_edit_agent_md: true` may still edit your repo's `CLAUDE.md`/`AGENTS.md` directly.
```

- [ ] **Step 2: 更新 `README.zh-TW.md`**

與步驟 1 的五項一一對應（指令表、Layout、設定範例行、validate 規則、新小節），小節標題 `### 同時執行多個 task`，內容為上列英文段落的繁體中文翻譯。標題層級（`#` 數量）必須與英文版相同，否則 `npm run check:docs` 會失敗。

- [ ] **Step 3: 更新 `docs/commands.md` 與 `docs/commands.zh-TW.md`**

`unlock` 一節（英文版第 65–71 行）：

- Usage 改為 ``**Usage:** `unlock [run-id] [-p name] --force` ``。
- 說明段改為：`Remove the lock a crashed run left behind. Each active run holds its own lock (up to dispatcher.max_concurrent_runs at once). Without --force it only shows who holds the lock. Without a run id it acts on the only lock; when several runs hold one it lists them and asks you to name the run.`
- 保留「Upgrading from an older version」段，並在其後加一句：`An older version's project-wide lock.json is still honoured: while its process is alive it counts as one active run.`

`run` 一節加一句：`With dispatcher.max_concurrent_runs > 1 the run starts from HEAD in its own worktree and ends with a branch to merge; see "Several runs at once" in the README.`

`clear` 一節加一句：`A concurrent run's lead branch counts as work that is not in the repo until it is merged into HEAD.`

`zh-TW` 版同步翻譯，標題與層級不變。

- [ ] **Step 4: 更新 spec 索引**

`docs/specs/07-concurrent-runs.md` 第 3 行「狀態」改為 `狀態：已實作（計畫：docs/plans/2026-10-07-07-concurrent-runs.md）。`。`docs/specs/README.md` 表格加一列：

```
| [07](07-concurrent-runs.md) | 同專案多 task 併發 | 中 | 高 | [plan](../plans/2026-10-07-07-concurrent-runs.md) |
```

- [ ] **Step 5: 整體驗證**

Run: `npm run typecheck && npm test && npm run lint && npm run check:docs && npm run build`
Expected: 全部通過。再人工驗證一次真實 CLI（用假的 `claude`，沿用 `test/run-lifecycle.test.ts` 的 `setup` 即可，不需真實 API）：

```bash
npx vitest run test/run-lifecycle.test.ts test/integration.test.ts test/project-lock.test.ts test/run-cleanup.test.ts
```
Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add README.md README.zh-TW.md docs/commands.md docs/commands.zh-TW.md docs/specs/07-concurrent-runs.md docs/specs/README.md
git commit -m "docs: several runs at once (max_concurrent_runs, per-run locks, lead branch)"
```

---

## Self-Review

**Spec coverage（對照 `docs/specs/07-concurrent-runs.md` §7.2）**

| 決議 | Task |
|---|---|
| 1 `max_concurrent_runs` 預設 1；> 1 強制 worktree；`shared` 並用報錯 | Task 1 |
| 2 非 git repo 報錯 | Task 1 |
| 3 起點 `HEAD`、允許未提交、啟動時印出 | Task 4（`snapshotHead`、`assertWorktreeRunnable`）、Task 5（`say`） |
| 4 per-run 鎖、併發上限 | Task 2、Task 3 |
| 5 舊 `lock.json` 相容 | Task 2（計數、清除死鎖）、Task 3（`unlock`） |
| 6 lead worktree；成員從 lead 分出並合回 lead | Task 4（`snapshotBase(..., from)`、`integrateAgentChanges(..., targetRoot)`）、Task 5 |
| 7 結束時自動 commit、不自動合併、印 merge 指令、保留 patch | Task 4（`finishLeadBranch`）、Task 5 |
| 8 `clear` 拒絕未合入分支；`--keep-worktrees` | Task 6 |
| 9 不帶 id 的指令 | Task 3（`resume` 沿用現有邏輯；`unlock` 多鎖要求指定；`status` 以 per-run `runIsAlive` 列出全部執行中） |
| 10 不加全域資源上限 | 無程式；Task 7 文件註明乘數 |

驗收 §7.4 的 9 項：1→Task 2/3、2→Task 2、3→Task 1、4→Task 4/5、5→Task 5、6→Task 6、7→Task 3、8→Task 5、9→各 Task 都先跑全套測試。

**已知取捨（執行者需知）**
- `finishLead` 在 `end_reason` 為 `cancelled` 時也會提交（spec 決議 7）；被中斷的 wake 可能留下半成品檔案，commit 訊息含 run id 與任務摘要，使用者可自行決定是否 merge。
- `inspectWorkspace` 對 lead 的判斷沿用「檔案內容是否已在 repo」的規則，所以 squash merge 或手動套用 patch 後，只要內容相同，也視為已合入（比 spec 的「合入 HEAD」略寬，但與既有 `clear` 的安全語意一致）。
- 提示詞（`src/prompt.ts`）對 worktree 中的 lead 仍寫「teammates cannot see your changes」；實際上成員每次被喚醒時都從 lead 的目前內容取快照，所以看得到。這只是措辭不精確，不影響行為，不在本計畫範圍。

**Placeholder 掃描**：計畫內沒有 TBD／TODO；每個程式步驟都附完整程式碼；Task 3 內描述「檔頭 import 補上」的地方列出了確切的符號與來源模組。

**型別一致性**：`acquireProjectLock(root, runId, { maxConcurrent })`、`listRunLocks`、`inspectRunLock`、`forceUnlock(root, runId?)`（Task 2 定義，Task 3 使用）；`snapshotHead`、`snapshotBase(..., from)`、`integrateAgentChanges(..., targetRoot)`、`inspectWorkspace(..., target)`、`commitWorkspace`、`finishLeadBranch`、`ResultBranch`（Task 4 定義，Task 5、6 使用）；`RunState.result_branch`、`RunSummary.resultBranch`（Task 5 定義並在同 Task 測試）。名稱前後一致。
