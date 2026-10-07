# 可靠性與效能 實作計畫

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 移除對 `ps`／`which` 的脆弱依賴、替 `log.jsonl` 加輪替、量測 `state.json` 的成長、並避免每輪重複解析信箱。

**Architecture:** 四個互相獨立的 Task，各自一個 PR 也可以。外部程式依賴改成「注入式」函式，讓單元測試不碰真實系統。

**Tech Stack:** TypeScript ESM、Node `fs`、Vitest。

**Spec:** `docs/specs/03-reliability-performance.md`

## Global Constraints

- Node >=20，macOS 與 Linux；Windows 只維持現狀（警告）。
- 舊鎖檔（`pid_started` 為 `ps -o lstart=` 的字串）必須不被誤判成「PID 已重用」。
- `schema_version: 2` 與信箱協定不變。
- `log.jsonl` 預設上限 8 MiB；`log_max_bytes: 0` 代表不輪替。

---

### Task 1: 程序啟動時間不再依賴 `ps`（Linux 讀 `/proc`）

**Files:**
- Modify: `src/project-lock.ts`（`pidStart`、`lockHolderAlive`）
- Test: `test/project-lock.test.ts`

**Interfaces:**
- Produces:
  - `export function parseProcStat(text: string): string | undefined` — 回傳 `/proc/<pid>/stat` 第 22 欄（starttime，ticks）
  - `export interface PidStartIo { platform: NodeJS.Platform; readFile(p: string): string | undefined; ps(pid: number): string | undefined }`
  - `export function pidStartFrom(pid: number, io: PidStartIo): string | undefined` — Linux 回 `"proc:<ticks>"`，其他情況回 `ps` 字串
  - `lockHolderAlive` 只在新舊兩個啟動時間「同一種格式」時才比較

- [ ] **Step 1: 寫失敗的測試**

在 `test/project-lock.test.ts` 加入（檔頭 import 補 `parseProcStat, pidStartFrom, lockHolderAlive, type LockInfo` 自 `../src/project-lock.js`，已 import 的略過）：

```ts
describe("pid start time", () => {
  // comm is field 2 and may hold spaces and parentheses; starttime is field 22
  const stat = (start: string) => `4242 (my (odd) proc) S 1 4242 4242 0 -1 4194560 100 0 0 0 1 2 0 0 20 0 1 0 ${start} 1000 100 18446744073709551615`;

  it("reads starttime from /proc stat even when the command name has spaces and parentheses", () => {
    expect(parseProcStat(stat("987654"))).toBe("987654");
  });

  it("returns undefined for text that is not a stat line", () => {
    expect(parseProcStat("garbage")).toBeUndefined();
    expect(parseProcStat("1 (x) S 1")).toBeUndefined();
  });

  it("uses /proc on linux and falls back to ps when it cannot be read", () => {
    const io = (readFile: PidStartIo["readFile"]): PidStartIo => ({ platform: "linux", readFile, ps: () => "Tue Oct  7 11:00:00 2026" });
    expect(pidStartFrom(4242, io(() => stat("55")))).toBe("proc:55");
    expect(pidStartFrom(4242, io(() => undefined))).toBe("Tue Oct  7 11:00:00 2026");
  });

  it("uses ps on other platforms", () => {
    expect(pidStartFrom(1, { platform: "darwin", readFile: () => stat("55"), ps: () => "Tue Oct  7 11:00:00 2026" })).toBe("Tue Oct  7 11:00:00 2026");
  });

  it("does not call a live holder dead when the lock was written in the other start-time format", () => {
    const other = process.platform === "linux" ? "Tue Oct  7 11:00:00 2026" : "proc:1";
    const info: LockInfo = { token: "t", hostname: "h", pid: process.pid, pid_started: other, run_id: "r", acquired_at: "", heartbeat_at: "" };
    expect(lockHolderAlive(info)).toBe(true);
  });

  it("calls a holder dead when the same-format start time differs (pid reused)", () => {
    const now = pidStartFrom(process.pid, { platform: process.platform, readFile: (p) => { try { return fs.readFileSync(p, "utf8"); } catch { return undefined; } }, ps: () => undefined });
    if (!now) return; // no way to read a start time on this machine
    const wrong = now.startsWith("proc:") ? "proc:1" : "Mon Jan  1 00:00:00 2001";
    const info: LockInfo = { token: "t", hostname: "h", pid: process.pid, pid_started: wrong, run_id: "r", acquired_at: "", heartbeat_at: "" };
    expect(lockHolderAlive(info)).toBe(false);
  });
});
```

另外在檔頭 import 補 `import type { PidStartIo } from "../src/project-lock.js";`（或併入同一行 `type PidStartIo`）。`fs` 若尚未 import 也補上。

- [ ] **Step 2: 確認失敗**

Run: `npx vitest run test/project-lock.test.ts -t "pid start time"`
Expected: FAIL（`parseProcStat` 不是匯出）

- [ ] **Step 3: 實作**

`src/project-lock.ts` 取代 `pidStart` 函式（原第 34–38 行）：

```ts
/** Field 22 (starttime, in clock ticks) of a /proc/<pid>/stat line. The command name (field 2) may contain spaces and ")". */
export function parseProcStat(text: string): string | undefined {
  const end = text.lastIndexOf(")");
  if (end < 0) return undefined;
  const fields = text.slice(end + 2).split(" "); // fields[0] is field 3 (state), so field 22 is fields[19]
  const v = fields[19];
  return v && /^\d+$/.test(v) ? v : undefined;
}

export interface PidStartIo {
  platform: NodeJS.Platform;
  readFile(p: string): string | undefined;
  ps(pid: number): string | undefined;
}

/** A start time that identifies one process: `proc:<ticks>` on Linux, the `ps` text elsewhere or when /proc cannot be read. */
export function pidStartFrom(pid: number, io: PidStartIo): string | undefined {
  if (io.platform === "linux") {
    const text = io.readFile(`/proc/${pid}/stat`);
    const ticks = text ? parseProcStat(text) : undefined;
    if (ticks) return `proc:${ticks}`;
  }
  return io.ps(pid);
}

const realIo: PidStartIo = {
  platform: process.platform,
  readFile: (p) => {
    try {
      return fs.readFileSync(p, "utf8");
    } catch {
      return undefined;
    }
  },
  ps: (pid) => {
    const r = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" });
    const out = r.status === 0 ? r.stdout.trim() : "";
    return out || undefined;
  },
};

function pidStart(pid: number): string | undefined {
  return pidStartFrom(pid, realIo);
}

/** Two start times can only be compared when they were taken the same way. */
const sameKind = (a: string, b: string) => a.startsWith("proc:") === b.startsWith("proc:");
```

`lockHolderAlive` 內：

```ts
  if (info.pid_started) {
    const now = pidStart(info.pid);
    if (now && sameKind(now, info.pid_started) && now !== info.pid_started) return false;
  }
```

- [ ] **Step 4: 確認通過**

Run: `npx vitest run test/project-lock.test.ts`
Expected: 全 PASS

- [ ] **Step 5: Commit**

```bash
git add src/project-lock.ts test/project-lock.test.ts
git commit -m "fix(lock): read a process start time from /proc on Linux; never compare start times taken differently"
```

---

### Task 2: 偵測 `bwrap` 不再依賴 `which`

**Files:**
- Modify: `src/fs-util.ts`
- Modify: `src/policy.ts:1`、`src/policy.ts:129`
- Create: `test/fs-util.test.ts`

**Interfaces:**
- Produces: `export function findOnPath(cmd: string, pathVar?: string): boolean`（預設讀 `process.env.PATH`）

- [ ] **Step 1: 寫失敗的測試**

`test/fs-util.test.ts`：

```ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findOnPath } from "../src/fs-util.js";

let dir: string;
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("findOnPath", () => {
  it("finds an executable file in a PATH entry", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "lyceum-path-"));
    fs.writeFileSync(path.join(dir, "bwrap"), "#!/bin/sh\n", { mode: 0o755 });
    expect(findOnPath("bwrap", `/nonexistent${path.delimiter}${dir}`)).toBe(true);
  });

  it("ignores a file that is not executable, a missing file and empty PATH entries", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "lyceum-path-"));
    fs.writeFileSync(path.join(dir, "bwrap"), "x", { mode: 0o644 });
    expect(findOnPath("bwrap", dir)).toBe(false);
    expect(findOnPath("nope", `${path.delimiter}${dir}`)).toBe(false);
    expect(findOnPath("bwrap", "")).toBe(false);
  });
});
```

- [ ] **Step 2: 確認失敗**

Run: `npx vitest run test/fs-util.test.ts`
Expected: FAIL（`findOnPath` 不存在）

- [ ] **Step 3: 實作**

`src/fs-util.ts` 末尾加：

```ts
/** Is `cmd` an executable file in one of the PATH directories? (No `which`: it may be missing in slim containers.) */
export function findOnPath(cmd: string, pathVar: string = process.env.PATH ?? ""): boolean {
  return pathVar
    .split(path.delimiter)
    .filter(Boolean)
    .some((d) => {
      try {
        fs.accessSync(path.join(d, cmd), fs.constants.X_OK);
        return true;
      } catch {
        return false;
      }
    });
}
```

`src/policy.ts`：第 129 行改為 `else if (process.platform === "linux") sandboxProbe = findOnPath("bwrap");`。檔頭加 `import { findOnPath } from "./fs-util.js";`。接著 `grep -n spawnSync src/policy.ts`：若只剩 import 那一行，刪掉第 1 行的 `import { spawnSync } from "node:child_process";`。

- [ ] **Step 4: 驗證**

Run: `npm run typecheck && npx vitest run test/fs-util.test.ts test/doctor.test.ts test/adapters.test.ts`
Expected: 全 PASS

- [ ] **Step 5: Commit**

```bash
git add src/fs-util.ts src/policy.ts test/fs-util.test.ts
git commit -m "fix(policy): find bwrap by scanning PATH instead of calling which"
```

---

### Task 3: `log.jsonl` 輪替

**Files:**
- Create: `src/run-log.ts`
- Create: `test/run-log.test.ts`
- Modify: `src/schema.ts`（`DispatcherPartial`、`DispatcherSettings`、`DISPATCHER_DEFAULTS`）
- Modify: `src/dispatcher.ts:70-72`
- Modify: `src/policy.ts:54`
- Modify: README 兩份的設定說明（見 Step 6）

**Interfaces:**
- Produces: `export function createRunLog(file: string, maxBytes: number): (event: string, data?: Record<string, unknown>) => void`；超過上限時把現有檔案改名為 `log.1.jsonl`（覆蓋舊的 `.1`），新檔從頭開始。
- Produces: 設定 `dispatcher.log_max_bytes`（整數 ≥ 0，預設 `8388608`）。

- [ ] **Step 1: 寫失敗的測試**

`test/run-log.test.ts`：

```ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRunLog } from "../src/run-log.js";

let dir: string;
const lines = (f: string) => fs.readFileSync(f, "utf8").trim().split("\n").map((l) => JSON.parse(l));
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("createRunLog", () => {
  it("appends one JSON line per event with a timestamp", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "lyceum-log-"));
    const file = path.join(dir, "log.jsonl");
    const log = createRunLog(file, 0);
    log("start", { a: 1 });
    log("end");
    const rows = lines(file);
    expect(rows.map((r) => r.event)).toEqual(["start", "end"]);
    expect(rows[0].a).toBe(1);
    expect(typeof rows[0].ts).toBe("string");
  });

  it("rotates to log.1.jsonl when the next line would pass the limit, without losing or repeating events", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "lyceum-log-"));
    const file = path.join(dir, "log.jsonl");
    const log = createRunLog(file, 300);
    for (let i = 0; i < 12; i++) log("e", { i, pad: "x".repeat(40) });
    const old = lines(path.join(dir, "log.1.jsonl")).map((r) => r.i);
    const cur = lines(file).map((r) => r.i);
    expect(fs.statSync(file).size).toBeLessThanOrEqual(300);
    // only one older file is kept, so the tail of the sequence is contiguous across the two files
    const all = [...old, ...cur];
    expect(all).toEqual(Array.from({ length: all.length }, (_, k) => 12 - all.length + k));
    expect(cur.at(-1)).toBe(11);
  });

  it("never rotates when the limit is 0", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "lyceum-log-"));
    const file = path.join(dir, "log.jsonl");
    const log = createRunLog(file, 0);
    for (let i = 0; i < 50; i++) log("e", { pad: "x".repeat(100) });
    expect(fs.existsSync(path.join(dir, "log.1.jsonl"))).toBe(false);
  });

  it("continues an existing file after a resume (size is read from disk)", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "lyceum-log-"));
    const file = path.join(dir, "log.jsonl");
    fs.writeFileSync(file, JSON.stringify({ ts: "t", event: "old", pad: "x".repeat(200) }) + "\n");
    const log = createRunLog(file, 260);
    log("new", { pad: "y".repeat(100) });
    expect(lines(path.join(dir, "log.1.jsonl"))[0].event).toBe("old");
    expect(lines(file)[0].event).toBe("new");
  });
});
```

- [ ] **Step 2: 確認失敗**

Run: `npx vitest run test/run-log.test.ts`
Expected: FAIL（模組不存在）

- [ ] **Step 3: 實作 `src/run-log.ts`**

```ts
import fs from "node:fs";

/**
 * Append-only run log, one JSON object per line. When the next line would push the file past `maxBytes`
 * (0 = no limit) the file becomes `<name>.1.jsonl`, replacing an older one, and a new file starts.
 */
export function createRunLog(file: string, maxBytes: number): (event: string, data?: Record<string, unknown>) => void {
  let size = fs.existsSync(file) ? fs.statSync(file).size : 0;
  return (event, data = {}) => {
    const line = JSON.stringify({ ts: new Date().toISOString(), event, ...data }) + "\n";
    const bytes = Buffer.byteLength(line);
    if (maxBytes > 0 && size > 0 && size + bytes > maxBytes) {
      fs.renameSync(file, file.replace(/\.jsonl$/, ".1.jsonl"));
      size = 0;
    }
    fs.appendFileSync(file, line);
    size += bytes;
  };
}
```

- [ ] **Step 4: 確認通過**

Run: `npx vitest run test/run-log.test.ts`
Expected: 全 PASS

- [ ] **Step 5: 設定與接線**

`src/schema.ts`：
- `DispatcherPartial` 內加 `log_max_bytes: z.number().int().min(0).optional(),`
- `DispatcherSettings` 加 `/** log.jsonl is rotated to log.1.jsonl past this size; 0 = never. */ log_max_bytes: number;`
- `DISPATCHER_DEFAULTS` 加 `log_max_bytes: 8 * 1024 * 1024,`

`src/dispatcher.ts` 取代第 70–72 行：

```ts
  const log = createRunLog(path.join(runDir, "log.jsonl"), cfg.log_max_bytes);
```

並在 import 區加 `import { createRunLog } from "./run-log.js";`。檔案中其他使用 `logFile` 的地方（`grep -n logFile src/dispatcher.ts`）若只有被刪的那兩處則無需處理。

`src/policy.ts:54`（若 Plan 02 已改過，在其基礎上）加入 `"log.1.jsonl"`：

```ts
const RUN_ENTRIES = ["state.json", "log.jsonl", "log.1.jsonl", "result.md", "task.md", "snapshots", "violations", "agents", "mail"];
```

- [ ] **Step 6: 文件與全部測試**

Run: `grep -rn "wake_timeout_sec" README.md README.zh-TW.md src | grep -v "src/schema.ts"`
對每個列出設定項目的地方（README 的設定表、`src/scaffold.ts` 的範本註解、`src/config.ts` 的來源說明，若有），在 `wake_timeout_sec` 旁以相同格式補上 `log_max_bytes`（預設 `8388608`，說明「`log.jsonl` 超過此大小改名為 `log.1.jsonl`；0 為不輪替」）。沒有任何命中則在 README 的 Layout 之後補一小段說明。

Run: `npm run typecheck && npm test`
Expected: 全 PASS（`config show --resolved` 的測試若列舉所有 dispatcher 鍵，補上 `log_max_bytes`，屬預期更新）

- [ ] **Step 7: Commit**

```bash
git add src/run-log.ts test/run-log.test.ts src/schema.ts src/dispatcher.ts src/policy.ts README.md README.zh-TW.md
git commit -m "feat(dispatcher): rotate log.jsonl past dispatcher.log_max_bytes"
```

---

### Task 4: 量測 `state.json`，再決定要不要拆（只量測，不改程式）

**Files:**
- Create（不 commit）: `scripts/.measure-state.ts`

**Interfaces:**
- Consumes: `newRunState`、`saveRunState`（`src/run-store.ts`）。
- Produces: 一份量測結果寫進 PR 描述；若超過門檻，另開 spec，不在這份 plan 內實作。

- [ ] **Step 1: 建立一次性量測腳本**

`scripts/.measure-state.ts`：

```ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { newRunState, saveRunState } from "../src/run-store.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lyceum-measure-"));
const state = newRunState({
  run_id: "measure", project: "p", task_source: "text",
  started_at: new Date().toISOString(), rounds: 0, max_rounds: 1000, pid: process.pid,
  task_summary: "t", mail_layout: "run", workspace_mode: "shared",
});
const handling = [{ from: "lead", type: "task", subject: "do the thing", brief: "x".repeat(120) }];
for (const rounds of [30, 100, 500]) {
  while (state.rounds < rounds) {
    state.rounds++;
    state.wakes.push({ round: state.rounds, agent: "dev", at: new Date().toISOString(), duration_ms: 1234, ok: true, output_tokens: 900, handling, sent: [{ to: "lead", type: "reply", subject: "done step" }] });
  }
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < 20; i++) saveRunState(dir, state);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6 / 20;
  const kb = fs.statSync(path.join(dir, "state.json")).size / 1024;
  console.log(`${rounds} rounds: ${ms.toFixed(2)} ms per save, ${kb.toFixed(0)} KiB`);
}
fs.rmSync(dir, { recursive: true, force: true });
```

- [ ] **Step 2: 執行**

Run: `npx tsx scripts/.measure-state.ts`
Expected: 印出三行（30／100／500 輪的單次寫入毫秒數與檔案大小）。`newRunState` 只要求 `run_id`，其餘為選用。

- [ ] **Step 3: 判讀**

門檻：500 輪時單次寫入 > 10 ms，或檔案 > 1 MiB。
- 未超過：結論是「不需要拆」，把三行數字貼進 PR 描述，並在 `docs/specs/03-reliability-performance.md` 3.2 節末尾加一句「已量測（2026-10-07 起的版本），500 輪 X ms／Y KiB，未超過門檻，不拆」。
- 超過：在 `docs/specs/` 新增 `07-state-wakes-split.md`（把超過最近 200 筆的 wakes 搬到 `wakes.jsonl`，state 內保留彙總；列出 `status.ts` 與 monitor 受影響處）。不在這份 plan 實作。

- [ ] **Step 4: 清理並 commit 文件**

```bash
rm scripts/.measure-state.ts
git add docs/specs
git commit -m "docs(specs): record the state.json growth measurement"
```

---

### Task 5: 每輪不再解析整個信箱

**Files:**
- Modify: `src/mailbox.ts`（`listUnread` 附近，約第 148 行）
- Modify: `src/dispatcher.ts`（`pendingAgents`，約第 141 行）
- Test: `test/mailbox.test.ts`

**Interfaces:**
- Produces: `export function unreadFiles(project: ResolvedProject, agent: string): string[]` — inbox 內未讀 `.md` 的完整路徑，已排序；忽略點開頭檔、非 `.md`、子資料夾。`listUnread` 改用它，行為不變。
- 行為保證：格式壞掉的信原本就以「(unreadable message)」佔位算未讀，因此改用檔案存在判斷，與現況一致。

- [ ] **Step 1: 寫失敗的測試**

在 `test/mailbox.test.ts` 加入（檔頭：`../src/mailbox.js` 的 import 補 `unreadFiles`，`../src/policy.js` 的 import 補 `inboxDir`；`fs`、`path`、`makeEnv` 已在檔頭）：

```ts
describe("unreadFiles", () => {
  it("lists unread .md files sorted by name, skipping dotfiles, other files and folders", () => {
    const env = makeEnv();
    try {
      const p = env.project();
      const dir = inboxDir(p, "lead");
      fs.mkdirSync(path.join(dir, "read"), { recursive: true });
      fs.writeFileSync(path.join(dir, "b.md"), "x");
      fs.writeFileSync(path.join(dir, "a.md"), "x");
      fs.writeFileSync(path.join(dir, ".hidden.md"), "x");
      fs.writeFileSync(path.join(dir, "note.txt"), "x");
      expect(unreadFiles(p, "lead").map((f) => path.basename(f))).toEqual(["a.md", "b.md"]);
      expect(unreadFiles(p, "nobody")).toEqual([]);
    } finally {
      env.cleanup();
    }
  });

  it("still counts a malformed message as unread (so an agent with only that mail is still woken)", () => {
    const env = makeEnv();
    try {
      const p = env.project();
      const dir = inboxDir(p, "lead");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "bad.md"), "no frontmatter at all");
      expect(unreadFiles(p, "lead")).toHaveLength(1);
      expect(listUnread(p, "lead")).toHaveLength(1);
    } finally {
      env.cleanup();
    }
  });
});
```

- [ ] **Step 2: 確認失敗**

Run: `npx vitest run test/mailbox.test.ts -t unreadFiles`
Expected: FAIL（`unreadFiles` 不存在）

- [ ] **Step 3: 實作**

`src/mailbox.ts` 取代 `listUnread` 開頭到 `.sort();` 的部分：

```ts
/** Paths of the unread messages in an agent's inbox, oldest name first. Does not open them. */
export function unreadFiles(project: ResolvedProject, agent: string): string[] {
  const dir = inboxDir(project, agent);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".md") && !e.name.startsWith("."))
    .map((e) => path.join(dir, e.name))
    .sort();
}

export function listUnread(project: ResolvedProject, agent: string): Message[] {
  const files = unreadFiles(project, agent);
  const out: Message[] = [];
```

（保留原本 `for (const f of files) {...}` 與 `return out;`。）

`src/dispatcher.ts` 的 `pendingAgents` 換成：

```ts
  const pendingAgents = (): ResolvedAgent[] => {
    const rows = Object.values(project.agents)
      .map((a) => ({ a, files: unreadFiles(project, a.name) }))
      .filter((r) => r.files.length > 0)
      .map((r) => ({ a: r.a, first: path.basename(r.files[0]) }));
    rows.sort((x, y) => x.first.localeCompare(y.first));
    return rows.map((r) => r.a);
  };
```

import 行加入 `unreadFiles`（`listUnread` 仍被 `wake` 使用，保留）。

- [ ] **Step 4: 全部測試**

Run: `npm run typecheck && npm test`
Expected: 全 PASS（dispatcher／integration／lifecycle 測試不改動即通過，證明行為未變）

- [ ] **Step 5: Commit**

```bash
git add src/mailbox.ts src/dispatcher.ts test/mailbox.test.ts
git commit -m "perf(dispatcher): decide who is pending from file names without parsing every message"
```

## Self-Review

- Spec 3.1 → Task 1、2；3.2 → Task 3、4；3.3 → Task 5。
- Spec 3.1 第 2 點（舊鎖不被誤搶）→ Task 1 的 `sameKind` 與兩個對應測試。
- Spec 3.3 的疑慮（格式錯誤信）→ Task 5 第二個測試證明行為與現況一致。
- 設定項目名稱一致：`log_max_bytes` 在 Task 3 全程相同；`createRunLog`、`unreadFiles`、`findOnPath`、`pidStartFrom`、`parseProcStat` 定義與使用處一致。
- 依賴順序：Task 3 的 `RUN_ENTRIES` 修改以 Plan 02 之後的版本為準；若先做 Plan 03，字串中不含 `"violations"`，兩者合併時留意即可。
