# `run --detach`：脫離 session 的背景執行 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `agent-lyceum run … --detach`（與 `resume … --detach`）把 run 交給一個完全脫離目前終端機／Claude session 的背景程序，指令本身很快返回；使用者可以 `/clear`、關掉 TUI 或繼續做別的事，run 仍會跑完，再用 `status` 與 `result.md` 接回進度。

**Architecture:** 新增 `src/detach.ts`：以 `detached: true`、`stdio` 導向 log 檔、`unref()` 重新執行自己（同一個 CLI、去掉 `--detach` 的相同參數）。父程序等到子程序的 run 出現在 `state.json`（以 `state.pid === 子程序 pid` 辨識）或子程序提早結束，才回報：run 名稱、pid、log 路徑、如何看進度與取消。子程序提早失敗（設定錯誤、鎖被占用、預檢失敗）時，父程序印出 log 並以子程序的結束碼結束，錯誤不會被吞掉。取消沿用既有的 SIGTERM 處理（乾淨取消、結束碼 130、信件保留）。

**Tech Stack:** TypeScript（ESM）、`node:child_process`、commander、vitest。無新依賴。

**Spec:** 本 plan 回應對話中的需求（`/clear` 後 run 不能因 session 結束而被殺）；背景見 `docs/evaluation-orbital.md` §3 P1-2 / P2-2。

## Global Constraints

- 只借 Orbital 的概念，不參考、不複製其程式碼（GPL-3.0；本專案 MIT）。
- 不新增依賴；不新增常駐程序：run 結束，背景程序就結束（與「一次性 CLI」定位一致）。
- 沒有 `--detach` 時行為完全不變。
- 不改 `state.json`、`schema_version`、信箱格式；唯一新增的檔案是 `<project>/detached/<stamp>-<pid>.log`（放在 `pr.paths.root` 下，**不是** `runs/` 底下，避免被 `listRuns` 掃到）。
- macOS／Linux 支援；Windows 不處理（專案本來就只對 Windows 顯示警告）。
- `--detach` 不可與需要互動的流程並用：`resume --answer` 若沒有 `--no-edit`（會開編輯器）要拒絕。
- 指令：`npm run build`、`npm test`、`npm run lint`、`node scripts/check-docs.mjs`。

---

## File Structure

- Create `src/detach.ts`：`spawnDetached()`，一個責任：重新執行自己並脫離，回報子程序狀態。
- Modify `src/cli.ts`：`run`（約 258 行）與 `resume`（約 328 行）加 `--detach` 選項與一個共用 helper `detachAndReport()`。
- Test `test/detach.test.ts`（新，helper 單元測試）、`test/detach-cli.test.ts`（新，沿用 `test/run-lifecycle.test.ts` 的 fake-claude 設定）。
- Modify `docs/commands.md`、`docs/commands.zh-TW.md`（`run`、`resume` 段）、`README.md`／`README.zh-TW.md`（一行提示）。

### Task 1: `spawnDetached` 輔助函式

**Files:**
- Create: `src/detach.ts`
- Test: `test/detach.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface DetachOptions {
    /** CLI arguments for the child, without `--detach`. */
    args: string[];
    /** Directory for the child's log file (created when missing). */
    logDir: string;
    /** The child's run is visible: called every `pollMs`; true ends the wait. */
    ready: (childPid: number) => boolean;
    pollMs?: number;    // default 100
    timeoutMs?: number; // default 20_000
    /** The command to run; default `[process.execPath, ...process.execArgv, process.argv[1]]`. Tests override it. */
    command?: string[];
  }
  export interface DetachResult {
    pid: number;
    logFile: string;
    /** "ready": the run is up; "exited": the child ended during the wait (see exitCode); "timeout": still starting. */
    status: "ready" | "exited" | "timeout";
    exitCode?: number | null;
  }
  export function spawnDetached(opts: DetachOptions): Promise<DetachResult>;
  ```

- [ ] **Step 1: 寫會失敗的測試**

`test/detach.test.ts`：

```ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { spawnDetached } from "../src/detach.js";

const dirs: string[] = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "detach-test-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const node = (code: string) => [process.execPath, "-e", code];

describe("spawnDetached", () => {
  it("reports ready once the child's run is visible, and leaves the child running", async () => {
    const logDir = tmp();
    const marker = path.join(tmp(), "ready");
    const r = await spawnDetached({
      args: [],
      logDir,
      command: node(`require("fs").writeFileSync(${JSON.stringify(marker)}, "x"); setTimeout(() => {}, 1500)`),
      ready: () => fs.existsSync(marker),
      pollMs: 20,
    });
    expect(r.status).toBe("ready");
    expect(() => process.kill(r.pid, 0)).not.toThrow(); // still alive
    process.kill(r.pid, "SIGKILL");
  });

  it("returns the child's exit code and log when it ends during the wait", async () => {
    const logDir = tmp();
    const r = await spawnDetached({ args: [], logDir, command: node(`console.error("bad config"); process.exit(1)`), ready: () => false, pollMs: 20 });
    expect(r.status).toBe("exited");
    expect(r.exitCode).toBe(1);
    expect(fs.readFileSync(r.logFile, "utf8")).toContain("bad config");
  });

  it("times out when the child is neither ready nor finished", async () => {
    const logDir = tmp();
    const r = await spawnDetached({ args: [], logDir, command: node("setTimeout(() => {}, 3000)"), ready: () => false, pollMs: 20, timeoutMs: 200 });
    expect(r.status).toBe("timeout");
    process.kill(r.pid, "SIGKILL");
  });

  it("puts the child in its own process group, so a terminal Ctrl-C does not reach it", async () => {
    const logDir = tmp();
    const r = await spawnDetached({ args: [], logDir, command: node("setTimeout(() => {}, 1500)"), ready: () => true, pollMs: 20 });
    expect(r.status).toBe("ready");
    // a detached child leads its own group: group id == pid
    const pgid = Number(require("node:child_process").execFileSync("ps", ["-o", "pgid=", "-p", String(r.pid)], { encoding: "utf8" }).trim());
    expect(pgid).toBe(r.pid);
    process.kill(r.pid, "SIGKILL");
  });
});
```

（測試檔是 ESM：把最後一個測試的 `require("node:child_process")` 改成檔頭 `import { execFileSync } from "node:child_process";` 後直接用 `execFileSync`。）

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx vitest run test/detach.test.ts`
Expected: FAIL（找不到 `../src/detach.js`）

- [ ] **Step 3: 實作**

`src/detach.ts`：

```ts
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export interface DetachOptions {
  /** CLI arguments for the child, without `--detach`. */
  args: string[];
  /** Directory for the child's log file (created when missing). */
  logDir: string;
  /** The child's run is visible: called every `pollMs`; true ends the wait. */
  ready: (childPid: number) => boolean;
  pollMs?: number;
  timeoutMs?: number;
  /** The command to run; default is this same CLI. Tests override it. */
  command?: string[];
}

export interface DetachResult {
  pid: number;
  logFile: string;
  /** "ready": the run is up; "exited": the child ended during the wait (see exitCode); "timeout": still starting. */
  status: "ready" | "exited" | "timeout";
  exitCode?: number | null;
}

/** Run this CLI again in the background, in its own process group, with its output in a log file. It outlives the caller. */
export async function spawnDetached(opts: DetachOptions): Promise<DetachResult> {
  const { pollMs = 100, timeoutMs = 20_000 } = opts;
  fs.mkdirSync(opts.logDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:.]/g, "").replace("T", "-").slice(0, 15);
  const logFile = path.join(opts.logDir, `${stamp}-${process.pid}.log`);
  const fd = fs.openSync(logFile, "a");
  const [cmd, ...cmdArgs] = opts.command ?? [process.execPath, ...process.execArgv, process.argv[1]!];
  const child = spawn(cmd!, [...cmdArgs, ...opts.args], { detached: true, stdio: ["ignore", fd, fd] });
  fs.closeSync(fd);
  let exited = false;
  let exitCode: number | null | undefined;
  child.on("exit", (code) => {
    exited = true;
    exitCode = code;
  });
  const pid = child.pid;
  if (!pid) throw new Error("could not start the background process");
  const end = Date.now() + timeoutMs;
  const finish = (r: Omit<DetachResult, "pid" | "logFile">): DetachResult => {
    child.unref(); // the child keeps going when this process exits
    return { pid, logFile, ...r };
  };
  while (Date.now() < end) {
    if (exited) return finish({ status: "exited", exitCode });
    if (opts.ready(pid)) return finish({ status: "ready" });
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return exited ? finish({ status: "exited", exitCode }) : finish({ status: "timeout" });
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `npx vitest run test/detach.test.ts`
Expected: PASS（4 個）

- [ ] **Step 5: Commit**

```bash
git add src/detach.ts test/detach.test.ts
git commit -m "feat(detach): spawnDetached reruns the CLI in the background, outliving its caller"
```

### Task 2: `run --detach` 與 `resume --detach`

**Files:**
- Modify: `src/cli.ts`（`run` 約 258 行、`resume` 約 328 行；import 區）
- Test: `test/detach-cli.test.ts`

**Interfaces:**
- Consumes: `spawnDetached`、`DetachResult`（Task 1）；既有 `listRuns(pr, Infinity)`、`runLabel(state)`（`src/run-store.ts`）、`fail()`、`loadProject()`。
- Produces: CLI 旗標 `run --detach`、`resume --detach`；cli.ts 內部 helper `detachAndReport(pr: ResolvedProject): Promise<never>`。

- [ ] **Step 1: 寫會失敗的 CLI 測試**

`test/detach-cli.test.ts`（照 `test/run-lifecycle.test.ts` 的 `setup()` 寫法：fake `claude`、`tsx` 執行 `src/cli.ts`；先 `sed -n 1,40p test/run-lifecycle.test.ts` 對照，並用 `FAKE_SCRIPT` 的 `calls` 格式）：

```ts
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { initGitRepo, makeEnv, type TestEnv } from "./helpers.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(here, "..", "src", "cli.ts");
const tsx = path.join(here, "..", "node_modules", ".bin", "tsx");
const fake = path.join(here, "fixtures", "runtime", "fake-claude.mjs");

let env: TestEnv;
afterEach(() => env?.cleanup());

function setup(script: object) {
  env = makeEnv();
  initGitRepo(env.repo);
  const bin = path.join(env.root, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "claude"), `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`, { mode: 0o755 });
  const scriptFile = path.join(env.root, "script.json");
  fs.writeFileSync(scriptFile, JSON.stringify(script));
  const envVars = { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_SCRIPT: scriptFile, FAKE_MARKER: path.join(env.root, "marker.json") };
  return (args: string[]) => {
    const r = spawnSync(tsx, [cli, "--home", env.home, ...args], { encoding: "utf8", env: envVars });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };
}
const until = async (cond: () => boolean, ms = 30000) => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
};

describe("run --detach", () => {
  it("returns at once, the run finishes on its own, and status shows it", async () => {
    const sh = setup({ calls: [{ agent: "lead", mail: [{ to: "lead", type: "done", subject: "shipped", outcome: "completed" }] }] });
    const started = sh(["run", "do it", "-p", "demo", "--detach", "--name", "bg-run"]);
    expect(started.code).toBe(0);
    expect(started.out).toMatch(/bg-run/);
    expect(started.out).toMatch(/pid \d+/);
    expect(started.out).toMatch(/\.log/);
    await until(() => JSON.parse(sh(["status", "-p", "demo", "--json"]).out).run?.state === "ended");
    const end = JSON.parse(sh(["status", "-p", "demo", "--json"]).out);
    expect(end.run).toMatchObject({ state: "ended", end_reason: "done", outcome: "completed" });
    const logFile = /Log: (\S+)/.exec(started.out)![1]!;
    expect(fs.readFileSync(logFile, "utf8")).toMatch(/ended: done/);
  }, 90_000);

  it("shows the child's error and exit code when the run cannot start", () => {
    const sh = setup({ calls: [] });
    const r = sh(["run", "do it", "-p", "demo", "--detach", "--name", "Bad Name"]);
    expect(r.code).toBe(1);
    expect(r.err + r.out).toMatch(/Invalid run name/);
  });

  it("refuses --detach together with an interactive answer", () => {
    const sh = setup({ calls: [] });
    const r = sh(["resume", "--answer", "--detach", "-p", "demo"]);
    expect(r.code).toBe(1);
    expect(r.err + r.out).toMatch(/--detach.*--no-edit|--no-edit.*--detach/);
  });
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx vitest run test/detach-cli.test.ts`
Expected: FAIL（commander 回 `unknown option '--detach'`，結束碼 1，但第一個測試要的是 0）

- [ ] **Step 3: 實作**

`src/cli.ts` 檔頭 import 加：

```ts
import { spawnDetached } from "./detach.js";
```

在 `printRun` 附近（`reportRun` 之後）加共用 helper：

```ts
/** `--detach`: run the same command again in the background, then say where it is and how to follow it. Never returns. */
async function detachAndReport(pr: ResolvedProject): Promise<never> {
  const args = process.argv.slice(2).filter((a) => a !== "--detach");
  const r = await spawnDetached({
    args,
    logDir: path.join(pr.paths.root, "detached"),
    ready: (pid) => listRuns(pr, Infinity).some((x) => x.state.pid === pid),
  });
  if (r.status === "exited") {
    // It ended during the start-up wait: a refusal (bad config, lock held) or a very short run. Its output is what the user needs.
    process.stderr.write(fs.readFileSync(r.logFile, "utf8"));
    process.exit(r.exitCode ?? 1);
  }
  const run = listRuns(pr, Infinity).find((x) => x.state.pid === r.pid);
  const label = run ? runLabel(run.state) : "(still starting)";
  console.log(`Started run ${label} in the background (pid ${r.pid}). It keeps going if you close this terminal or session.`);
  console.log(`Log: ${r.logFile}`);
  console.log(`Follow it:  agent-lyceum status -p ${pr.name}`);
  console.log(`Result:     ${run ? path.join(run.dir, RESULT_FILE) : path.join(pr.paths.runs, "<run>", RESULT_FILE)}  (when it ends)`);
  console.log(`Cancel:     kill ${r.pid}   (clean stop; unread mail is kept; continue later with: agent-lyceum resume)`);
  console.log(`If it stops to ask you something it exits with code 3; answer with: agent-lyceum resume --answer -p ${pr.name}`);
  process.exit(0);
}
```

（`fs`、`path`、`RESULT_FILE`、`runLabel`、`listRuns`、`ResolvedProject` 在 cli.ts 已 import；若 `fs` 沒有，補 `import fs from "node:fs"`。`RunRef.dir` 是 run 目錄，`continueRun` 內已用 `dir`。）

`run` 命令：在 `.option("--assume-defaults", …)` 之後加

```ts
  .option("--detach", "start the run in the background, detached from this terminal: it keeps going if you close it; follow it with `status`")
```

action 型別加 `detach?: boolean`，並在 `const pr = loadProject(opts.project);` 之後、`validateProject` 之前加：

```ts
      if (opts.detach) return await detachAndReport(pr);
```

`resume` 命令：加同樣的 option，action 型別加 `detach?: boolean`；在 `const pr = loadProject(opts.project);` 之後加：

```ts
      if (opts.detach && opts.answer && opts.edit) fail("--detach cannot open an editor: use --no-edit with --answer (check ask-reply.md first), or answer in the foreground.");
      if (opts.detach) return await detachAndReport(pr);
```

- [ ] **Step 4: 跑測試確認通過**

Run: `npx vitest run test/detach-cli.test.ts`
Expected: PASS（3 個）。若第一個測試因 `pid` 比對太慢而 `(still starting)`，把 `ready` 的輪詢間隔／逾時調整，不要放寬斷言。

- [ ] **Step 5: 全部檢查**

Run: `npm run build && npm test && npm run lint`
Expected: 全過。特別確認 `test/cli.test.ts` 的 `--help` 輸出快照／斷言若含 `run` 的選項清單，要同步更新。

- [ ] **Step 6: Commit**

```bash
git add src/cli.ts test/detach-cli.test.ts
git commit -m "feat(cli): run --detach and resume --detach start the run in the background"
```

### Task 3: 實測 `/clear` 與文件

**Files:**
- Modify: `docs/commands.md`、`docs/commands.zh-TW.md`（`run`、`resume` 段）、`README.md`、`README.zh-TW.md`（指令表一行）

- [ ] **Step 1: 手動實測（無法自動化，因為要真的 `/clear`）**

在 Claude TUI 內：

1. `! npx agent-lyceum run --task-file <某個小任務> --name detach-check --detach`（用 `!` 前綴，不要用 Bash 工具的 `run_in_background`）。
2. 看到 `Started run detach-check … (pid N)` 後執行 `/clear`。
3. 在新的 context 裡：`ps -p N` 應仍存在；`npx agent-lyceum status` 應顯示 run 仍在進行；等它結束後讀 `result.md`。
4. 另試：run 進行中 `kill N`，確認 `status` 顯示 `cancelled`，`resume` 能接續。

把結果（存活／被殺、`kill` 行為）記進本 plan 的「Verification」，**不要在實測前把「/clear 安全」寫進文件**。

- [ ] **Step 2: 文件**

`docs/commands.md` 的 `run` 段補（英文）：

> `--detach`: start the run in a background process that is detached from this terminal and from any Claude session, then return. It keeps going if you close the terminal or `/clear`. Output goes to `<project>/detached/<time>-<pid>.log`; follow it with `status`, read `result.md` when it ends, and stop it with `kill <pid>` (a clean cancel; unread mail is kept). If the run fails to start, the error and exit code are shown at once. A run that stops to ask a question exits with `3`: answer with `resume --answer`. `resume` accepts `--detach` too, except together with `--answer` unless `--no-edit` is also given.

中文檔同義。README 指令表 `run` 那列補「可加 `--detach` 在背景執行」。

- [ ] **Step 3: 檢查與 commit**

Run: `node scripts/check-docs.mjs && npm test`
Expected: `docs ok`；測試全過

```bash
git add docs/commands.md docs/commands.zh-TW.md README.md README.zh-TW.md
git commit -m "docs: run --detach"
```

---

## Self-Review

- **覆蓋：** 脫離 session（`detached: true`＋`unref`）、錯誤不被吞（提早結束時印 log 並沿用結束碼）、取消（SIGTERM → 既有的乾淨取消）、找回進度（`status`、log 與 `result.md` 路徑）、互動限制（`--answer` 不可並用）、`/clear` 實測（Task 3 Step 1）。
- **佔位掃描：** 無 TBD。Task 1 的最後一個測試與 Task 2 Step 1 各有一句「對照既有檔案的寫法」是為了與既有測試 helper 對齊，測試本體已完整給出。
- **型別一致：** `DetachOptions`／`DetachResult` 在 Task 1 定義，Task 2 只用 `args`、`logDir`、`ready`、`status`、`exitCode`、`pid`、`logFile`；helper 名 `detachAndReport` 在 `run` 與 `resume` 一致。
- **已知限制：**
  1. 啟動窗口最多等 20 秒；run 在窗口內就跑完（很短的任務）會走「exited」路徑，輸出整份 log 並沿用結束碼，這是預期行為。
  2. `ready` 以 `state.pid === 子程序 pid` 辨識 run，依賴 `newRunState` 寫入 `pid: process.pid`（`src/run-session.ts` 已如此）。
  3. `<project>/detached/` 的 log 不會被 `clear` 刪掉，可手動清理；若之後要自動清，另開 plan。
  4. 子程序若在窗口後才失敗，結果只在 log 與 `status` 看得到，不會通知；通知屬於另一個功能（`status --inbox` 或外部通知）。
