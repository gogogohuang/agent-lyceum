# 收掉巢狀子指令 實作計畫

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `memory tidy` 改成頂層 `tidy`、`memory restore` 改成 `tidy --undo <時間戳>`、`project list` 改成不帶子指令的 `project`，舊寫法直接移除。

**Architecture:** 只改 CLI 這一層（`src/cli.ts`）：指令的註冊方式與旗標檢查。底層的 `tidyMemory()`、`restoreMemory()`、`listProjects()` 完全不動，所以整理與還原的行為不變。另外同步 `status`／`doctor` 提示文字裡的指令名稱，以及中英文文件。

**Tech Stack:** TypeScript ESM、Commander 14、Vitest（用 `tsx` 跑 `src/cli.ts` 的子程序測試，假 runtime 是 `test/fixtures/runtime/fake-claude.mjs`）、Biome。不新增依賴。

**Spec:** `docs/specs/12-flatten-subcommands.md`

## Global Constraints

- Node >=20，macOS 與 Linux；不新增依賴。
- 舊名稱（`memory …`、`project list`）**不留別名、不加「已改為…」提示**。
- `--undo` 必須搭配 `--agent`；`--undo` 不能搭配 `--dry-run`。兩種錯誤都要在**載入專案與取鎖之前**發生，不改任何檔案。
- `restoreMemory()`、`tidyMemory()`、`.archive/`、`.tidy-state.json` 的格式都不改。
- `project add`、`project remove`、`resume`、`call`、`doctor`、`clear`、`init`、`status`、`run` 的名稱與選項不變。
- `docs/commands.md` 與 `docs/commands.zh-TW.md` 的標題層級結構必須一致，連結錨點必須存在（`npm run check:docs` 會檢查）。README 也是一對。
- 破壞相容性，目標版本 0.10.0。**發版不在這份計畫內**，由使用者另外指示。
- Commit 訊息結尾加：`Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`（執行時若系統提示給了別的 attribution，以系統提示為準）。

## 與 spec 的差異（實作決定）

- Spec 12.2 第 8 條說舊寫法會得到 commander 的「unknown command」錯誤。實際上：
  - `agent-lyceum memory tidy` → `error: unknown command 'memory'`，exit 1。與 spec 相同。
  - `agent-lyceum project list` → 因為 `project` 自己有了 action，commander 把 `list` 當成多餘的位置參數，訊息是 `error: too many arguments for 'project'. Expected 0 arguments but got 1.`，exit 1。訊息不同，但一樣是非 0 結束，符合 12.4 的驗收條件。不為了統一訊息另外寫程式。

## File Structure

| 檔案 | 這次的責任 |
|---|---|
| `src/cli.ts` | 移除 `memory` 指令與 `project list`；新增頂層 `tidy`（含 `--undo`）；`project` 加 action；更新 `HELP_LAYERS` 與還原提示文字 |
| `src/doctor.ts` | 提示文字：`memory tidy` → `tidy` |
| `src/status.ts` | 提示文字與註解：`memory tidy` → `tidy` |
| `src/memory-tidy.ts` | 一行註解裡的指令名稱 |
| `test/memory-tidy-cli.test.ts` | 改用新寫法；新增 `--undo` 的兩個錯誤案例與舊指令被移除的案例 |
| `test/project-cli.test.ts`（新增） | `project` 不帶子指令、`project list` 被移除 |
| `test/doctor.test.ts`、`test/status.test.ts` | 比對提示文字的正規表示式 |
| `README.md`、`README.zh-TW.md` | 指令表 |
| `docs/commands.md`、`docs/commands.zh-TW.md` | `tidy` 一節（合併原本兩節）、`project` 一節改名 |
| `docs/specs/12-flatten-subcommands.md`、`docs/specs/README.md` | 狀態與 plan 連結 |

---

### Task 1: 頂層 `tidy` 與 `tidy --undo`，移除 `memory`

**Files:**
- Modify: `src/cli.ts`（`const memoryCmd = …` 到 `memoryCmd.command("restore …")` 結束為止，目前約 480–553 行；以及檔尾的 `HELP_LAYERS`）
- Test: `test/memory-tidy-cli.test.ts`

**Interfaces:**
- Consumes（都已存在，不要改）：
  - `tidyMemory(opts: { project: ResolvedProject; layer: Layer; agent?: string; dryRun?: boolean; signal?: AbortSignal })`
  - `restoreMemory(opts: { project: ResolvedProject; agent: string; layer: Layer; stamp: string }): { restored: string[]; skipped: { rel: string; reason: string }[] }`
  - `src/cli.ts` 內的 `fail(msg: string, code = 1): never`、`loadProject(name?: string)`、`takeLock(pr, id)`、`layerOpt(v)`、`tidyStamp()`、`preflight(pr)`、`cancelOnSignals()`
- Produces：CLI 指令 `tidy [-p] [--agent] [--layer] [--dry-run] [--undo <stamp>]`。Task 3 的提示文字與 Task 4 的文件都用這個寫法。

- [ ] **Step 1: 把測試改成新寫法，並加上新案例**

在 `test/memory-tidy-cli.test.ts`：

1. 把 `describe("memory tidy → restore", …` 改成 `describe("tidy → tidy --undo", …`。
2. 檔案中所有 `["memory", "tidy", ` 改成 `["tidy", `（共 7 處）。
3. 第一個測試裡的還原呼叫，把

```ts
    const back = t.sync(["memory", "restore", stamp!, "-p", "demo", "--agent", "lead"]);
```

改成

```ts
    expect(r.out).toContain(`agent-lyceum tidy --undo ${stamp} -p demo --agent lead`);
    const back = t.sync(["tidy", "--undo", stamp!, "-p", "demo", "--agent", "lead"]);
```

4. 在 `describe` 區塊的最後一個 `it(...)` 之後、`});` 之前，加上三個測試：

```ts
  it("--undo without --agent is refused before anything is touched", () => {
    const t = setup(() => ({ calls: [] }));
    const before = fingerprint(t.memDir);
    const r = t.sync(["tidy", "--undo", "20261008T031500Z", "-p", "demo"]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/--agent/);
    expect(fingerprint(t.memDir)).toEqual(before);
  });

  it("--undo with --dry-run is refused", () => {
    const t = setup(() => ({ calls: [] }));
    const before = fingerprint(t.memDir);
    const r = t.sync(["tidy", "--undo", "20261008T031500Z", "-p", "demo", "--agent", "lead", "--dry-run"]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/--dry-run/);
    expect(fingerprint(t.memDir)).toEqual(before);
  });

  it("the old `memory` command is gone", () => {
    const t = setup(() => ({ calls: [] }));
    const r = t.sync(["memory", "tidy", "-p", "demo", "--dry-run"]);
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/unknown command/);
  });
```

- [ ] **Step 2: 跑測試，確認失敗**

Run: `npx vitest run test/memory-tidy-cli.test.ts`
Expected: FAIL。大部分案例的 exit code 不是預期值，stderr 有 `error: unknown command 'tidy'`；最後一個「old `memory` command is gone」會因為 `memory` 還存在而失敗。

- [ ] **Step 3: 改 `src/cli.ts`**

(a) 刪掉這一行：

```ts
const memoryCmd = program.command("memory").description("Look after the agents' long-term memory");
```

`layerOpt` 函式留著不動。

(b) 把 `memoryCmd.command("tidy")` 整段（從 `memoryCmd` 到該指令 `.action(...)` 結束的 `});`）的**開頭**改成掛在 `program` 上，並加上 `--undo`。也就是把

```ts
memoryCmd
  .command("tidy")
  .summary("Have agents tidy their own memory")
  .description("Have agents tidy their own memory: merge duplicates, fix stale entries, archive what is obsolete (never deletes).\n\nManual only; nothing triggers it automatically.")
  .option("-p, --project <name>")
  .option("--agent <name>", "tidy only this agent (default: every agent)")
  .option("--layer <layer>", "project (default) or global; global memory is shared by every project, so it is never tidied unless you ask")
  .option("--dry-run", "only show the memory sizes and what changed in the project; wake nobody, change nothing")
  .action(async (opts: { project?: string; agent?: string; layer?: string; dryRun?: boolean }) => {
    try {
      const layer = layerOpt(opts.layer);
      const pr = loadProject(opts.project);
```

換成

```ts
program
  .command("tidy")
  .summary("Have agents tidy their own memory, or undo one tidy")
  .description(
    "Have agents tidy their own memory: merge duplicates, fix stale entries, archive what is obsolete (never deletes).\n\n" +
      "Manual only; nothing triggers it automatically.\n\n" +
      "With --undo <stamp> it tidies nothing and instead:\n" +
      "  - moves the files of that tidy's archive back (nothing that exists now is overwritten)\n" +
      "  - re-adds them to MEMORY.md\n" +
      "  - needs --agent, and cannot be combined with --dry-run",
  )
  .option("-p, --project <name>")
  .option("--agent <name>", "tidy only this agent (default: every agent); required with --undo")
  .option("--layer <layer>", "project (default) or global; global memory is shared by every project, so it is never tidied unless you ask")
  .option("--dry-run", "only show the memory sizes and what changed in the project; wake nobody, change nothing")
  .option("--undo <stamp>", "undo the tidy with this timestamp: move its archived files back")
  .action(async (opts: { project?: string; agent?: string; layer?: string; dryRun?: boolean; undo?: string }) => {
    try {
      const layer = layerOpt(opts.layer);
      if (opts.undo !== undefined) {
        if (opts.dryRun) fail("--undo cannot be combined with --dry-run.");
        if (!opts.agent) fail("--undo needs --agent <name>: an archive belongs to one agent's memory.");
        const target = loadProject(opts.project);
        const undoLease = takeLock(target, `restore-${tidyStamp()}`);
        try {
          const r = restoreMemory({ project: target, agent: opts.agent, layer, stamp: opts.undo });
          for (const f of r.restored) console.log(`  restored  ${f}`);
          for (const s of r.skipped) console.log(`  skipped   ${s.rel}: ${s.reason}`);
          if (!r.restored.length && !r.skipped.length) console.log(`Archive ${opts.undo} holds no files to restore.`);
        } finally {
          undoLease.release();
        }
        return;
      }
      const pr = loadProject(opts.project);
```

這段 action 其餘的內容（`if (opts.dryRun) { … }` 之後到結尾）保持原樣，只改下一步的提示文字。

(c) 同一個 action 裡，把還原提示

```ts
— undo with: agent-lyceum memory restore ${r.archive} -p ${pr.name} --agent ${r.agent}${r.layer === "global" ? " --layer global" : ""}`);
```

改成

```ts
— undo with: agent-lyceum tidy --undo ${r.archive} -p ${pr.name} --agent ${r.agent}${r.layer === "global" ? " --layer global" : ""}`);
```

(d) 刪掉整個 `memoryCmd.command("restore <stamp>")` 區塊，也就是從

```ts
memoryCmd
  .command("restore <stamp>")
```

到它 `.action(...)` 結束的 `});`（緊接在 `function useColor()` 之前）。

(e) 檔尾的 `HELP_LAYERS`，把

```ts
  "Run:": ["run", "resume", "clear", "call", "memory"],
```

改成

```ts
  "Run:": ["run", "resume", "clear", "call", "tidy"],
```

- [ ] **Step 4: 跑測試，確認通過**

Run: `npx vitest run test/memory-tidy-cli.test.ts`
Expected: PASS，9 個測試全過。

Run: `npm run typecheck`
Expected: 沒有錯誤（特別確認沒有殘留的 `memoryCmd` 參照）。

- [ ] **Step 5: Commit**

```bash
git add src/cli.ts test/memory-tidy-cli.test.ts
git commit -m "refactor(cli)!: memory tidy/restore become tidy and tidy --undo"
```

---

### Task 2: `project` 不帶子指令就列出，移除 `project list`

**Files:**
- Modify: `src/cli.ts`（`const project = program.command("project")…` 與其後的 `project.command("list")` 區塊，目前約 77–97 行）
- Create: `test/project-cli.test.ts`

**Interfaces:**
- Consumes（已存在，不要改）：`listProjects(home: string): { name: string; dir: string }[]`、`home()`（`src/cli.ts` 內）、`makeEnv()`（`test/helpers.ts`，建立一個含專案 `demo` 的 home，回傳 `{ home, root, cleanup(), project() }`）
- Produces：CLI `agent-lyceum project`（列出）。Task 4 的文件用這個寫法。

- [ ] **Step 1: 寫失敗的測試**

建立 `test/project-cli.test.ts`：

```ts
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { makeEnv, type TestEnv } from "./helpers.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(here, "..", "src", "cli.ts");
const tsx = path.join(here, "..", "node_modules", ".bin", "tsx");

let env: TestEnv | undefined;
let emptyHome: string | undefined;
afterEach(() => {
  env?.cleanup();
  env = undefined;
  if (emptyHome) fs.rmSync(emptyHome, { recursive: true, force: true });
  emptyHome = undefined;
});

function run(home: string, args: string[]) {
  const r = spawnSync(tsx, [cli, "--home", home, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

describe("project (no subcommand)", { timeout: 60_000 }, () => {
  it("lists the registered projects", () => {
    env = makeEnv();
    const r = run(env.home, ["project"]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^demo {2}-> {2}\S+/m);
  });

  it("says so when no project is registered", () => {
    emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), "agent-lyceum-empty-"));
    const r = run(emptyHome, ["project"]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/No projects registered\./);
  });

  it("the old `project list` is gone", () => {
    env = makeEnv();
    const r = run(env.home, ["project", "list"]);
    expect(r.code).not.toBe(0);
    expect(r.out).not.toMatch(/demo/);
  });
});
```

- [ ] **Step 2: 跑測試，確認失敗**

Run: `npx vitest run test/project-cli.test.ts`
Expected: FAIL。前兩個案例：`project` 不帶子指令時 commander 只印 help，stdout 沒有 `demo  ->  …` 也沒有 `No projects registered.`。第三個案例：`project list` 目前仍然成功（exit 0 且印出 `demo`）。

（`listProjects()` 在 `projects/` 資料夾不存在時回傳空陣列，所以空的 home 不需要先建立任何東西。）

- [ ] **Step 3: 改 `src/cli.ts`**

把

```ts
const project = program.command("project").description("Manage registered projects");
```

換成

```ts
const project = program
  .command("project")
  .summary("List registered projects, or add / remove one")
  .description("Without a subcommand, list the registered projects.\n\nSubcommands:\n  - add <name> --dir <repo>: register a project\n  - remove <name> [--purge]: unregister one")
  .action(() => {
    const list = listProjects(home());
    if (!list.length) console.log("No projects registered.");
    for (const p of list) console.log(`${p.name}  ->  ${p.dir}`);
  });
```

然後刪掉整個 `list` 子指令區塊：

```ts
project
  .command("list")
  .description("List registered projects")
  .action(() => {
    const list = listProjects(home());
    if (!list.length) console.log("No projects registered.");
    for (const p of list) console.log(`${p.name}  ->  ${p.dir}`);
  });
```

`project.command("add <name>")` 與 `project.command("remove <name>")` 兩個區塊不動。

- [ ] **Step 4: 跑測試，確認通過**

Run: `npx vitest run test/project-cli.test.ts`
Expected: PASS，3 個測試全過。

Run: `npx tsx src/cli.ts project --help`
Expected: 說明裡有 `Without a subcommand, list the registered projects.`，Commands 只列 `add` 與 `remove`（以及 `help`），沒有 `list`。

- [ ] **Step 5: Commit**

```bash
git add src/cli.ts test/project-cli.test.ts
git commit -m "refactor(cli)!: bare project lists projects; drop project list"
```

---

### Task 3: `status` 與 `doctor` 的提示文字

**Files:**
- Modify: `src/doctor.ts`（`tidyAdvice` 那一行，目前約 174 行）
- Modify: `src/status.ts`（註解約 215 行、提示約 514 行）
- Modify: `src/memory-tidy.ts`（註解約 329 行）
- Test: `test/doctor.test.ts`（約 108–114 行）、`test/status.test.ts`（約 234–241 行）

**Interfaces:**
- Consumes：Task 1 產生的指令寫法 `agent-lyceum tidy -p <project> [--agent <name>]`。
- Produces：無（只有顯示文字）。

- [ ] **Step 1: 先改測試的比對**

`test/doctor.test.ts`，把

```ts
    expect(r.checks.some((c) => c.level === "info" && c.subject === "memory" && /memory tidy/.test(c.message))).toBe(true);
```

改成

```ts
    expect(r.checks.some((c) => c.level === "info" && c.subject === "memory" && /agent-lyceum tidy -p /.test(c.message))).toBe(true);
```

`test/status.test.ts`，把

```ts
    expect(formatStatusReport(report, Date.now(), false)).toMatch(/memory tidy/);
```

改成

```ts
    expect(formatStatusReport(report, Date.now(), false)).toMatch(/agent-lyceum tidy -p /);
```

兩個檔案裡 `it(...)`／`describe(...)` 的標題文字（例如 `"only suggests a memory tidy: …"`、`"status: memory tidy hint"`）是在描述「整理記憶」這件事，不是指令名稱，保持不動。

- [ ] **Step 2: 跑測試，確認失敗**

Run: `npx vitest run test/doctor.test.ts test/status.test.ts`
Expected: FAIL，上面兩個斷言不成立（訊息裡仍是 `agent-lyceum memory tidy -p`）。

- [ ] **Step 3: 改三個原始檔**

`src/doctor.ts`，把訊息裡的

```ts
Consider: agent-lyceum memory tidy -p ${project.name} --agent ${a.agent} (doctor only suggests; it never tidies).
```

改成

```ts
Consider: agent-lyceum tidy -p ${project.name} --agent ${a.agent} (doctor only suggests; it never tidies).
```

`src/status.ts`，把

```ts
（建議執行 agent-lyceum memory tidy -p ${report.project.name}；status 只提示，不會自動整理）
```

改成

```ts
（建議執行 agent-lyceum tidy -p ${report.project.name}；status 只提示，不會自動整理）
```

同檔的註解

```ts
  /** Hints that a `memory tidy` might help. Only a suggestion; nothing runs it. */
```

改成

```ts
  /** Hints that a `tidy` might help. Only a suggestion; nothing runs it. */
```

`src/memory-tidy.ts` 的註解，把 `` (`agent-lyceum memory tidy`) `` 改成 `` (`agent-lyceum tidy`) ``。

- [ ] **Step 4: 跑測試，確認通過，並確認沒有殘留**

Run: `npx vitest run test/doctor.test.ts test/status.test.ts`
Expected: PASS。

Run: `grep -rn "memory tidy\|memory restore\|project list" src plugins --include="*.ts" --include="*.mjs" --include="*.js" | grep -v node_modules`
Expected: 沒有任何輸出。若 `plugins/` 有命中，一併改成新寫法並在 commit 內包含該檔。

- [ ] **Step 5: Commit**

```bash
git add src/doctor.ts src/status.ts src/memory-tidy.ts test/doctor.test.ts test/status.test.ts
git commit -m "refactor: point memory hints at the new tidy command"
```

---

### Task 4: 文件（README 與 docs/commands，中英文）

**Files:**
- Modify: `README.md`、`README.zh-TW.md`（指令表的三列）
- Modify: `docs/commands.md`、`docs/commands.zh-TW.md`
- Modify: `docs/specs/12-flatten-subcommands.md`、`docs/specs/README.md`

**Interfaces:**
- Consumes：Task 1、2 的指令寫法。
- Produces：錨點 `#project-and-project-remove` 與 `#tidy`（中英文兩份 `docs/commands` 都用同樣的英文標題，所以錨點相同）。

這個 task 沒有單元測試；它的檢查是 `npm run check:docs`（標題層級一致、連結與錨點存在）。

- [ ] **Step 1: 先改 README 的連結，讓檢查失敗**

`README.md`，把這三列

```markdown
| Project | `project list` / `project remove <name> [--purge]` | List or unregister projects. [details](docs/commands.md#project-list-and-remove) |
```
```markdown
| Run | `memory tidy [-p name] [--agent a] [--layer project\|global] [--dry-run]` | Have agents tidy their own memory (manual only; archives, never deletes). [details](docs/commands.md#memory-tidy) |
| Run | `memory restore <timestamp> -p name --agent a` | Undo a tidy: move its archived files back. [details](docs/commands.md#memory-restore) |
```

分別改成

```markdown
| Project | `project` / `project remove <name> [--purge]` | List or unregister projects. [details](docs/commands.md#project-and-project-remove) |
```
```markdown
| Run | `tidy [-p name] [--agent a] [--layer project\|global] [--dry-run]` | Have agents tidy their own memory (manual only; archives, never deletes). [details](docs/commands.md#tidy) |
| Run | `tidy --undo <timestamp> -p name --agent a` | Undo a tidy: move its archived files back. [details](docs/commands.md#tidy) |
```

`README.zh-TW.md`，把這三列

```markdown
| 專案 | `project list` / `project remove <name> [--purge]` | 列出或取消註冊專案。 [詳細](docs/commands.zh-TW.md#project-list-and-remove) |
```
```markdown
| 執行 | `memory tidy [-p name] [--agent a] [--layer project\|global] [--dry-run]` | 讓 agent 整理自己的記憶（只能手動觸發；封存而非刪除）。 [詳細](docs/commands.zh-TW.md#memory-tidy) |
| 執行 | `memory restore <時間戳> -p name --agent a` | 還原一次整理：把封存的檔案搬回。 [詳細](docs/commands.zh-TW.md#memory-restore) |
```

分別改成

```markdown
| 專案 | `project` / `project remove <name> [--purge]` | 列出或取消註冊專案。 [詳細](docs/commands.zh-TW.md#project-and-project-remove) |
```
```markdown
| 執行 | `tidy [-p name] [--agent a] [--layer project\|global] [--dry-run]` | 讓 agent 整理自己的記憶（只能手動觸發；封存而非刪除）。 [詳細](docs/commands.zh-TW.md#tidy) |
| 執行 | `tidy --undo <時間戳> -p name --agent a` | 還原一次整理：把封存的檔案搬回。 [詳細](docs/commands.zh-TW.md#tidy) |
```

- [ ] **Step 2: 跑檢查，確認失敗**

Run: `npm run check:docs`
Expected: FAIL，列出 README 連到不存在的錨點 `docs/commands.md#project-and-project-remove`、`#tidy`（中英文各一組）。

- [ ] **Step 3: 改 `docs/commands.md`**

(a) `project` 一節。把

```markdown
## project list and remove

**Usage:** `project list` / `project remove <name> [--purge]`

List projects / unregister (keeps context unless `--purge`).
```

改成

```markdown
## project and project remove

**Usage:** `project` / `project remove <name> [--purge]`

- `project` (no subcommand): list the registered projects.
- `project remove <name>`: unregister a project. Its context is kept unless you add `--purge`.
```

(b) `tidy` 一節的標題與用法。把

```markdown
## memory tidy

**Usage:** `memory tidy [-p name] [--agent a] [--layer project|global] [--dry-run]`
```

改成

```markdown
## tidy

**Usage:** `tidy [-p name] [--agent a] [--layer project|global] [--dry-run]` · `tidy --undo <timestamp> -p name --agent a [--layer project|global]`
```

(c) 同一節的選項清單，在 `--dry-run` 那一條後面加一條：

```markdown
- `--undo timestamp`: tidy nothing; undo the tidy with that timestamp instead. See below.
```

(d) 把整個 `## memory restore` 一節（標題、Usage、說明段落、Options 清單）換成下面這段。注意它**沒有 `##` 標題**，接在 `tidy` 一節的最後一段之後：

```markdown
**`tidy --undo <timestamp>`** undoes one tidy: it moves the files of `memory/.archive/<timestamp>/` back to where they were and adds them to `MEMORY.md` if the index does not mention them. `tidy` prints the timestamp, and the exact undo command, when it finishes.

- `--agent a`: whose memory to restore. Required.
- `--layer project|global`: which memory layer (default `project`).
- `--dry-run` cannot be combined with `--undo`.
- A file whose name exists now is not overwritten; it is reported and stays in the archive.
```

(e) 同檔其他提到舊指令的地方。Run: `grep -n "memory tidy\|memory restore\|project list" docs/commands.md`，把每一個命中的指令寫法改成 `tidy`／`tidy --undo`／`project`。

- [ ] **Step 4: 改 `docs/commands.zh-TW.md`（結構要與英文版一致）**

(a) 把

```markdown
## project list and remove

**用法:** `project list` / `project remove <name> [--purge]`

列出專案／取消註冊（除非加 `--purge`，否則保留 context）。
```

改成

```markdown
## project and project remove

**用法:** `project` / `project remove <name> [--purge]`

- `project`（不帶子指令）：列出已註冊的專案。
- `project remove <name>`：取消註冊專案。除非加 `--purge`，否則保留它的 context。
```

(b) 把

```markdown
## memory tidy

**用法:** `memory tidy [-p name] [--agent a] [--layer project|global] [--dry-run]`
```

改成

```markdown
## tidy

**用法:** `tidy [-p name] [--agent a] [--layer project|global] [--dry-run]` · `tidy --undo <時間戳> -p name --agent a [--layer project|global]`
```

(c) 同一節的選項清單，在 `--dry-run` 那一條後面加一條：

```markdown
- `--undo 時間戳`：不整理，改為還原那一次整理。見下方。
```

(d) 把整個 `## memory restore` 一節換成（同樣沒有 `##` 標題）：

```markdown
**`tidy --undo <時間戳>`** 還原一次整理：把 `memory/.archive/<時間戳>/` 的檔案搬回原處，`MEMORY.md` 沒有提到的就補一行索引。`tidy` 結束時會印出時間戳與可以直接執行的還原指令。

- `--agent a`：還原誰的記憶。必填。
- `--layer project|global`：哪一層記憶（預設 `project`）。
- `--dry-run` 不能與 `--undo` 並用。
- 若現在已有同名檔案，不會覆蓋，只會回報並留在封存裡。
```

(e) Run: `grep -n "memory tidy\|memory restore\|project list" docs/commands.zh-TW.md`，把每一個命中的指令寫法改成新寫法。

- [ ] **Step 5: 更新 spec 狀態與索引**

`docs/specs/12-flatten-subcommands.md`，把

```markdown
狀態：設計已同意，尚未實作。
```

改成

```markdown
狀態：已實作（plan：docs/plans/2026-10-12-12-flatten-subcommands.md）。
```

`docs/specs/README.md`，把第 12 列的 `（尚未撰寫）` 改成 `[plan](../plans/2026-10-12-12-flatten-subcommands.md)`。

- [ ] **Step 6: 跑檢查，確認通過**

Run: `npm run check:docs`
Expected: `docs ok`

Run: `grep -rn "memory tidy\|memory restore\|project list\|#memory-tidy\|#memory-restore\|#project-list-and-remove" README.md README.zh-TW.md docs/commands.md docs/commands.zh-TW.md`
Expected: 沒有任何輸出。

- [ ] **Step 7: Commit**

```bash
git add README.md README.zh-TW.md docs/commands.md docs/commands.zh-TW.md docs/specs/12-flatten-subcommands.md docs/specs/README.md docs/plans/2026-10-12-12-flatten-subcommands.md
git commit -m "docs: tidy, tidy --undo and bare project"
```

---

### Task 5: 整體驗證（對照 spec 12.4）

**Files:** 不改檔案；只有在某項檢查失敗時才回到對應的 task 修正。

- [ ] **Step 1: 全部自動檢查**

Run: `npm run typecheck && npm test && npm run check:docs && npx biome check src && npm run build`
Expected: 全部成功；`npm test` 的測試數比改之前的 391 多 6 個（Task 1 新增 3 個、Task 2 新增 3 個），共 397 passed。

- [ ] **Step 2: 看 `--help` 的分層**

Run: `node dist/cli.js --help`
Expected: Run 層列出 `run`、`resume`、`clear`、`call`、`tidy`，沒有 `memory`；Project 層的 `project` 簡述是 `List registered projects, or add / remove one`。

Run: `node dist/cli.js tidy --help`
Expected: 說明裡有 `With --undo <stamp> it tidies nothing and instead:` 與三條條列；Options 有 `--undo <stamp>`。

- [ ] **Step 3: 舊寫法確實失效**

Run: `node dist/cli.js memory tidy; echo "exit=$?"`
Expected: `error: unknown command 'memory'`，`exit=1`。

Run: `node dist/cli.js project list; echo "exit=$?"`
Expected: `error: too many arguments for 'project'. Expected 0 arguments but got 1.`，`exit=1`。

- [ ] **Step 4: 回報**

向使用者回報每一項的實際輸出。有任何一項不符就照實說明，不要標成完成。發版（0.10.0）、開 PR、更新 artifact 都等使用者指示。
