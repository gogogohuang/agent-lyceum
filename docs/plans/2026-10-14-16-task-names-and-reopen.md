# task 名稱與重開已完成的 run 實作計畫

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 每個 run 有可讀名稱，`resume`／`clear`／`status` 可用 id、名稱或唯一前綴指到它；`resume [run] "追加要求"` 可以重開已 `done` 的 run，保留 run 目錄、memory、lead worktree 與分支。

**Architecture:** `src/run-store.ts` 新增 `name`、`reopened`、`round_floor` 欄位與純函式（`slugify`、`uniqueName`、`resolveRun`、`roundLimit`）。`src/run-session.ts` 的 `RunOptions` 加 `followup`：建構時在 `resume` 分支寄追加 `task` mail、存 `followups/<n>.md`、重算回合上限；每次 `done` 另存 `done-<n>.md`。`src/cli.ts` 的 `run --name`、`resume [run] [text]`、`clear`、`status` 改用 `resolveRun`。lead 分支已 merge 時，重開前用既有的 `removeAgentWorkspace` + `prepareAgentWorkspace` 從目前 `HEAD` 重切。

**Tech Stack:** TypeScript ESM、Node `fs`、`git`、Vitest、Biome、Commander。不新增依賴。

**Spec:** `docs/specs/16-task-names-and-reopen.md`（決議 1–11）

## Global Constraints

- Node >=20，macOS 與 Linux；不新增依賴。
- 舊 run（沒有 `name`、`reopened`、`round_floor`）必須可讀、可用 id 操作；新欄位全部可省略，`state.json` 的 `schema_version` 不變。
- 不新增指令；沒有給追加文字時，`resume` 的行為與現在完全相同（done 的 run 只印結果）。
- 名稱規則：小寫英數與 `-`，最長 30 字元，取不出來用 `task`；重複時自動加 `-2`、`-3`…；`--name` 指定的名稱重複時報錯。名稱不得與任何 run id 前綴衝突造成歧義時，一律由 `resolveRun` 回報歧義，不猜。
- lead 分支名維持 `agent-lyceum/<run-id>/<lead>`，不含名稱。
- 重開時沙箱、write guard、`owns` 規則不變；程式、prompt、文件與測試不得寫死任何 agent 名稱。
- 破壞相容性或新增行為時，同步更新 `README.md`、`README.zh-TW.md`、`docs/commands.md`、`docs/commands.zh-TW.md`，並通過 `npm run check:docs`（中英標題結構必須一致）。
- 每個 Task 結束時 `npm run typecheck`、`npm test`、`npm run lint` 都要通過。
- Commit 訊息結尾加：`Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`（執行時若系統提示給了別的 attribution，以系統提示為準）。發版不在這份計畫內。

## File Structure

| 檔案 | 責任 |
|---|---|
| `src/run-store.ts` | `RunState.name?`、`reopened?`、`round_floor?`；`slugify`、`uniqueName`、`resolveRun`、`roundLimit` |
| `src/run-session.ts` | `RunOptions.followup`、重開流程、`done-<n>.md`、回合上限、lead 分支重切、已有 `pr_url` 時只 push |
| `src/worktree.ts` | `recutLeadWorkspace`（分支已 merge 時從 `HEAD` 重切） |
| `src/open-pr.ts` | `openPullRequest` 支援「PR 已存在，只 push」 |
| `src/cli.ts` | `run --name`、`resume [run] [text] [--task-file]`、`clear`／`status` 用 `resolveRun` |
| `src/status.ts` | 顯示名稱；`latestRun` 系列接受含 done 的候選 |
| `test/run-names.test.ts`（新增） | 名稱與解析 |
| `test/run-reopen.test.ts`（新增） | 重開、回合上限、`done-<n>.md`、分支重切 |
| `test/cli.test.ts`、`test/status.test.ts` | CLI 與顯示 |
| `README*.md`、`docs/commands*.md`、`docs/specs/16-*.md`、`docs/specs/README.md` | 文件與狀態 |

---

### Task 1: 名稱與 run 解析（純邏輯）

**Files:**
- Modify: `src/run-store.ts`（`RunState` 加欄位、`WireState` 加 zod 欄位、新函式）
- Test: `test/run-names.test.ts`（新增）

**Interfaces:**
- Produces（後面的 Task 依賴這些名稱與形狀）：
  - `RunState` 新增：`name?: string`、`reopened?: { at: string }[]`、`round_floor?: number`
  - `export function slugify(text: string): string`
  - `export function uniqueName(base: string, taken: string[]): string`
  - `export type RunRef = { dir: string; state: RunState }`
  - `export type Resolved = { ok: true; run: RunRef } | { ok: false; reason: "none" | "ambiguous"; candidates: RunRef[] }`
  - `export function resolveRun(runs: RunRef[], query: string): Resolved`
  - `export function roundLimit(state: Pick<RunState, "round_floor">, maxRounds: number): number`

- [ ] **Step 1: 寫失敗測試**

```ts
// test/run-names.test.ts
import { describe, expect, it } from "vitest";
import { newRunState, resolveRun, roundLimit, slugify, uniqueName, type RunRef } from "../src/run-store.js";

const ref = (run_id: string, name?: string): RunRef => ({ dir: `/r/${run_id}`, state: newRunState({ run_id, name }) });

describe("slugify", () => {
  it("lowercases, joins words with -, keeps 30 chars", () => {
    expect(slugify("Login: Session or JWT?")).toBe("login-session-or-jwt");
    expect(slugify("a".repeat(50))).toHaveLength(30);
  });
  it("falls back to task when nothing usable is left", () => {
    expect(slugify("登入功能")).toBe("task");
    expect(slugify("  ---  ")).toBe("task");
  });
});

describe("uniqueName", () => {
  it("adds -2, -3 … when the name is taken", () => {
    expect(uniqueName("login", [])).toBe("login");
    expect(uniqueName("login", ["login"])).toBe("login-2");
    expect(uniqueName("login", ["login", "login-2"])).toBe("login-3");
  });
});

describe("resolveRun", () => {
  const runs = [ref("20261014T010000Z-aaa", "login"), ref("20261014T020000Z-bbb", "login-2"), ref("20261013T010000Z-ccc")];
  it("matches a full id, an exact name, and a unique prefix", () => {
    expect(resolveRun(runs, "20261014T010000Z-aaa")).toMatchObject({ ok: true, run: { dir: "/r/20261014T010000Z-aaa" } });
    expect(resolveRun(runs, "login")).toMatchObject({ ok: true, run: { dir: "/r/20261014T010000Z-aaa" } });
    expect(resolveRun(runs, "login-2")).toMatchObject({ ok: true, run: { dir: "/r/20261014T020000Z-bbb" } });
    expect(resolveRun(runs, "20261013")).toMatchObject({ ok: true, run: { dir: "/r/20261013T010000Z-ccc" } });
  });
  it("an exact name or id wins over a longer prefix match", () => {
    expect(resolveRun(runs, "login")).toMatchObject({ ok: true });
  });
  it("reports ambiguous prefixes and unknown names", () => {
    expect(resolveRun(runs, "2026101")).toMatchObject({ ok: false, reason: "ambiguous" });
    expect(resolveRun(runs, "nope")).toMatchObject({ ok: false, reason: "none" });
  });
});

describe("roundLimit", () => {
  it("is max_rounds counted from the last reopen", () => {
    expect(roundLimit({}, 30)).toBe(30);
    expect(roundLimit({ round_floor: 12 }, 30)).toBe(42);
  });
});
```

- [ ] **Step 2: 確認測試失敗**

Run: `npx vitest run test/run-names.test.ts`
Expected: FAIL（`slugify`、`resolveRun` 等未匯出）

- [ ] **Step 3: 實作**

在 `RunState` 介面（`steps?: Step[];` 之後）加：

```ts
  /** Readable name; lets `resume`, `clear` and `status` find the run without its id. Absent on runs from older versions. */
  name?: string;
  /** One entry per time a finished run was reopened with a follow-up. */
  reopened?: { at: string }[];
  /** `rounds` at the last reopen; the round limit counts from here. */
  round_floor?: number;
```

在 `WireState` 的 `steps:` 行之後加：

```ts
    name: z.string().optional(),
    reopened: z.array(z.object({ at: z.string() })).optional(),
    round_floor: nonNeg.optional(),
```

檔尾加：

```ts
export function slugify(text: string): string {
  const s = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30)
    .replace(/-+$/g, "");
  return s || "task";
}

/** `base`, or `base-2`, `base-3` … the first that is not in `taken`. */
export function uniqueName(base: string, taken: string[]): string {
  if (!taken.includes(base)) return base;
  for (let n = 2; ; n++) if (!taken.includes(`${base}-${n}`)) return `${base}-${n}`;
}

export type RunRef = { dir: string; state: RunState };
export type Resolved = { ok: true; run: RunRef } | { ok: false; reason: "none" | "ambiguous"; candidates: RunRef[] };

/** Find a run by full id, exact name, or a prefix of either that matches exactly one run. An exact id or name always wins. */
export function resolveRun(runs: RunRef[], query: string): Resolved {
  const exact = runs.filter((r) => r.state.run_id === query || r.state.name === query);
  if (exact.length === 1) return { ok: true, run: exact[0] as RunRef };
  const pool = exact.length ? exact : runs.filter((r) => r.state.run_id.startsWith(query) || (r.state.name ?? "").startsWith(query));
  if (pool.length === 1) return { ok: true, run: pool[0] as RunRef };
  return { ok: false, reason: pool.length ? "ambiguous" : "none", candidates: pool };
}

export const roundLimit = (state: Pick<RunState, "round_floor">, maxRounds: number): number => (state.round_floor ?? 0) + maxRounds;
```

- [ ] **Step 4: 確認測試通過**

Run: `npx vitest run test/run-names.test.ts && npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/run-store.ts test/run-names.test.ts
git commit -m "feat(run): run names, resolveRun and round limit helpers"
```

---

### Task 2: 名稱寫入與 CLI 解析（`run --name`、`resume`／`clear`／`status` 用名稱）

**Files:**
- Modify: `src/run-session.ts`（新 run 的 `newRunState` 傳入 `name`；`RunOptions.name?`）
- Modify: `src/cli.ts`（`run --name`；`resume`／`clear`／`status --task-id` 的 run 參數改用 `resolveRun`）
- Modify: `src/status.ts`（`formatTaskList`、`buildTaskListReport` 顯示名稱）
- Test: `test/cli.test.ts`、`test/status.test.ts`

**Interfaces:**
- Consumes: `slugify`、`uniqueName`、`resolveRun`、`RunRef`（Task 1）；`listRuns(project, Infinity)`（`src/status.ts`，既有）
- Produces: `RunOptions.name?: string`（已決定好、不重複的名稱）；`src/cli.ts` 內部 `findRun(pr: ResolvedProject, query: string): RunRef`（找不到或有歧義時 `fail(...)`，歧義時列出候選的名稱、id、`task_summary`）

- [ ] **Step 1: 寫失敗測試**

`test/run-names.test.ts` 加（用 `test/helpers.ts` 既有的環境與 fake invoker；參考 `test/run-lifecycle.test.ts` 的開頭怎麼建 `env` 與呼叫 `runTeam`）：

```ts
it("a new run gets a name from its task, and a second one gets -2", async () => {
  const a = await runTeam({ project: env.project(), task: prepared("Login with session"), runDir: dirFor(), log: () => {}, invoker: DONE, name: "login-with-session" });
  expect(loadRunState(a.runDir).name).toBe("login-with-session");
});
```

`test/cli.test.ts` 加（沿用該檔既有 `runCli` 之類的 helper；先 `grep -n "function\|const run" test/cli.test.ts | head` 看名稱）：

```ts
it("clear finds a run by its name and by a unique id prefix", () => { /* 建一個 state.json 含 name: "login" 的 run 目錄；`clear login --dry-run` 輸出含該 run id；`clear 2026101 --dry-run` 同 */ });
it("an ambiguous prefix lists the candidates and exits 1", () => { /* 兩個 run id 同前綴；輸出含兩個名稱與 task_summary，exit code 1 */ });
```

- [ ] **Step 2: 確認測試失敗**

Run: `npx vitest run test/run-names.test.ts test/cli.test.ts`
Expected: FAIL

- [ ] **Step 3: 實作**

`src/run-session.ts`：`RunOptions` 加 `name?: string;`；新 run 的 `newRunState({...})` 加 `name: opts.name,`。

`src/cli.ts`：

```ts
import { resolveRun, slugify, uniqueName, type RunRef } from "./run-store.js";
import { listRuns } from "./status.js";

/** The run a user typed: full id, name or unique prefix. Exits with the candidates when it is unknown or ambiguous. */
function findRun(pr: ResolvedProject, query: string): RunRef {
  assertName("run", query);
  const r = resolveRun(listRuns(pr, Infinity), query);
  if (r.ok) return r.run;
  if (r.reason === "none") return fail(`Run "${query}" not found in ${pr.paths.runs}. List runs with: agent-lyceum status --task-list`);
  const list = r.candidates.map((c) => `  ${c.state.name ?? "(no name)"}  ${c.state.run_id}  ${c.state.task_summary}`).join("\n");
  return fail(`"${query}" matches several runs:\n${list}\nGive more of the name or id.`);
}
```

`run` 動作：加 `.option("--name <name>", "name for this run (default: made from the task)")`，opts 型別加 `name?: string`。在 `const runId = newRunId();` 之前先決定名稱（`prepareTask` 在 try 內，所以名稱在 `prepared` 取得後決定；把 `runTeam({... })` 前加）：

```ts
const taken = listRuns(pr, Infinity).map((r) => r.state.name).filter((n): n is string => !!n);
if (opts.name) {
  assertName("name", opts.name);
  if (taken.includes(opts.name)) fail(`A run named "${opts.name}" already exists in project ${pr.name}.`);
}
const name = opts.name ?? uniqueName(slugify(taskMessageBody(prepared).subject), taken);
```

並在 `runTeam({...})` 傳入 `name`。`taskMessageBody` 已由 `src/task.ts` 匯出，在 cli.ts 補 import。

`resume`、`clear`、`status --task-id`：把 `const dir = path.join(pr.paths.runs, runId); if (!fs.existsSync(...)) fail(...)` 這類手寫查找換成 `const { dir, state } = findRun(pr, runId)`，後續仍用 `state.run_id` 取完整 id（`clear` 傳給 `planRunCleanup`／`takeLock` 的要用 `state.run_id`，不是使用者輸入）。`status --task-id` 在建 report 前同樣先 `findRun(...).state.run_id`。

`src/status.ts`：`formatTaskList` 每列在 id 旁印名稱（沒有名稱就不印）；`buildTaskListReport` 的每筆加 `name: s.name`。`printRun` 的 `Run ${summary.runId} ended` 改成 `Run ${name ?? runId}`：`RunSummary` 加 `name?: string`（由 `state.name` 填）。

- [ ] **Step 4: 確認測試通過**

Run: `npx vitest run test/run-names.test.ts test/cli.test.ts test/status.test.ts && npm run typecheck && npm run lint`
Expected: PASS；既有測試不變（沒有 `name` 的 run 顯示照舊）。

- [ ] **Step 5: Commit**

```bash
git add src test
git commit -m "feat(cli): run names; resume, clear and status accept id, name or prefix"
```

---

### Task 3: 重開核心（`followup`、`done-<n>.md`、回合上限）

**Files:**
- Modify: `src/run-session.ts`
- Test: `test/run-reopen.test.ts`（新增）

**Interfaces:**
- Consumes: `roundLimit`（Task 1）、`RunState.reopened`／`round_floor`
- Produces: `RunOptions.followup?: { text: string }`。語意：只能與 `resume` 一起用；`resume.end_reason` 必須是 `"done"`，否則丟 `Error("followup needs a finished (done) run")`。結果檔：每次 `done` 存 `done-<n>.md`（`n` = `(state.reopened?.length ?? 0) + 1`），`result.md` 仍是最新一份；追加文字存 `followups/<n>.md`（`n` = 這次重開後 `reopened.length`）。

- [ ] **Step 1: 寫失敗測試**

```ts
// test/run-reopen.test.ts（env、invoker 寫法照 test/run-lifecycle.test.ts）
it("reopening a done run mails the follow-up to the lead and ends done again", async () => {
  const first = await runTeam({ project: env.project(), task: prepared("Build login"), runDir, log: () => {}, invoker: leadDone("first result") });
  expect(first.endReason).toBe("done");
  let seen = "";
  const second = await runTeam({
    project: env.project(), resume: loadRunState(runDir), runDir, log: () => {},
    followup: { text: "Also add rate limiting" },
    invoker: async (i) => { seen = i.prompt; return leadDoneReply("second result"); },
  });
  expect(second.endReason).toBe("done");
  expect(seen).toContain("Also add rate limiting");
  const st = loadRunState(runDir);
  expect(st.reopened).toHaveLength(1);
  expect(fs.readFileSync(path.join(runDir, "followups", "1.md"), "utf8")).toContain("Also add rate limiting");
  expect(fs.existsSync(path.join(runDir, "done-1.md"))).toBe(true);
  expect(fs.readFileSync(path.join(runDir, "done-2.md"), "utf8")).toContain("second result");
  expect(fs.readFileSync(path.join(runDir, "result.md"), "utf8")).toContain("second result");
});

it("the round limit counts from the reopen, so a run that used its rounds can still be reopened", async () => {
  // 第一段用掉 max_rounds（把 project 的 max_rounds 設成 2、第一段跑 2 輪）
  // 重開後 state.max_rounds === 2 + 2，且第二段能再跑 2 輪
});

it("followup on a run that is not done is refused", async () => {
  await expect(runTeam({ project: env.project(), resume: cancelledState, runDir, followup: { text: "x" }, log: () => {}, invoker: OK })).rejects.toThrow(/finished \(done\)/);
});
```

- [ ] **Step 2: 確認測試失敗**

Run: `npx vitest run test/run-reopen.test.ts`
Expected: FAIL（`followup` 不是 `RunOptions` 欄位）

- [ ] **Step 3: 實作**

`src/run-session.ts`：

1. `RunOptions` 加 `/** Reopen a done run: this text becomes a new task for the lead. */ followup?: { text: string };`
2. 建構子開頭（`if (resume?.end_reason === "waiting") ...` 之後）：
   ```ts
   if (opts.followup && (!resume || resume.end_reason !== "done")) throw new Error("followup needs a finished (done) run");
   ```
3. `if (resume) { state = {...} }` 區塊：`max_rounds` 改為 `roundLimit(resume, cfg.max_rounds)`；之後加：
   ```ts
   if (opts.followup) {
     state.reopened = [...(resume.reopened ?? []), { at: new Date().toISOString() }];
     state.round_floor = resume.rounds;
     state.max_rounds = roundLimit(state, cfg.max_rounds);
     state.result_branch = undefined;
   }
   ```
4. `if (resume) { log("resume", ...) }` 之後（`saveState()` 之前）加：
   ```ts
   if (opts.followup) {
     const n = state.reopened?.length ?? 1;
     fs.mkdirSync(path.join(runDir, "followups"), { recursive: true });
     fs.writeFileSync(path.join(runDir, "followups", `${n}.md`), `${opts.followup.text.trimEnd()}\n`);
     const prev = `done-${n}.md`;
     deliver(project, {
       from: "user", to: project.lead, type: "task",
       subject: opts.followup.text.split("\n").find((l) => l.trim())?.slice(0, 80) ?? "Follow-up",
       body: `## Goal\n${opts.followup.text.trimEnd()}\n\n## Acceptance criteria\nAs stated in the goal; the earlier result still holds unless the goal changes it.\n\n## Scope\nThis run's earlier work and files.\n\n## Upstream\nThe previous final report is in \`${path.join(runDir, prev)}\`; the original task is in \`${path.join(runDir, "task.md")}\`.\n`,
     });
     log("reopen", { n });
   }
   ```
5. 兩處 `state.rounds >= cfg.max_rounds`（約 299、732 行）改成 `state.rounds >= state.max_rounds`。
6. 寫 `result.md` 處（`atomicWrite(path.join(runDir, RESULT_FILE), ...)`）改成先組字串 `const report = ...`，再 `atomicWrite` 兩份：`RESULT_FILE` 與 `path.join(runDir, \`done-${(state.reopened?.length ?? 0) + 1}.md\`)`。
7. `resume` 為 `done` 且沒有 `followup` 的路徑不經過建構子（CLI 先擋），不用處理。

- [ ] **Step 4: 確認測試通過**

Run: `npx vitest run test/run-reopen.test.ts test/run-lifecycle.test.ts && npm run typecheck && npm run lint`
Expected: PASS；舊 run（沒有 `reopened`）行為不變（`done-1.md` 也會寫，`result.md` 不變）。

- [ ] **Step 5: Commit**

```bash
git add src/run-session.ts test/run-reopen.test.ts
git commit -m "feat(run): reopen a done run with a follow-up; done-<n>.md; round limit from the reopen"
```

---

### Task 4: CLI：`resume [run] "追加要求"`

**Files:**
- Modify: `src/cli.ts`（`resume` 命令）
- Modify: `src/status.ts`（`latestRun` 已有；新增 `reopenCandidates`）
- Test: `test/cli.test.ts`

**Interfaces:**
- Consumes: `RunOptions.followup`（Task 3）、`findRun`（Task 2）
- Produces:
  - `resume` 的參數形狀改為 `resume [run-or-text...]`？不——歧義太大。採：`resume [run] [text]` 兩個位置參數，加 `--task-file <path>`。解析規則：
    - 兩個參數：`run` = 第一個，`text` = 第二個。
    - 一個參數：能用 `resolveRun` 解析成 run → 當 run（行為不變）；解析不到（`reason: "none"`）→ 當 `text`，run 取最新（見下）。有歧義 → 照歧義處理（不當 text）。
    - `--task-file`：內容當 `text`，位置參數只剩 run。
  - `export function reopenCandidates(project: ResolvedProject): RunRef[]`（`src/status.ts`）：全部 run 中不在執行中（`!runIsAlive`）者，新到舊。

- [ ] **Step 1: 寫失敗測試**

```ts
it("resume with text and no run reopens the newest finished run", () => { /* 兩個 done 的 run；`resume "加上 rate limit"`；較新的那個被重開（用 fake claude shim，見 test/shims；輸出含 "Reopening run"） */ });
it("resume <name> with text reopens that run; without text it still only prints the result", () => { /* 第二次呼叫不帶文字：exit code 為該 run outcome 的代碼，且沒有新的 followups/1.md */ });
it("one argument that is not a run is taken as the follow-up text", () => { /* `resume "fix the typo"` */ });
it("several candidates and no TTY: lists them and exits 1", () => { /* 兩個 run 都 done、text 無 run、非互動：輸出候選清單 */ });
it("a run that is still alive is refused", () => { /* pid 為存活 process 的 state，未帶 end_reason：reopen 被拒 */ });
```

- [ ] **Step 2: 確認測試失敗**

Run: `npx vitest run test/cli.test.ts -t resume`
Expected: FAIL

- [ ] **Step 3: 實作**

`src/status.ts`：

```ts
/** Runs that could be continued or reopened: not running now. Newest first. */
export function reopenCandidates(project: ResolvedProject): RunRef[] {
  return listRuns(project, Infinity).filter((r) => r.state.end_reason || !runIsAlive(r.state, project));
}
```

`src/cli.ts` 的 `resume`：

- `.command("resume [run] [text]")`，`.option("--task-file <path>", "follow-up text from a file (reopens a finished run)")`；`.description` 加一段說明追加要求與「最新」規則（英文）。
- 取文字：
  ```ts
  let text = opts.taskFile ? fs.readFileSync(opts.taskFile, "utf8") : textArg;
  let query = runArg;
  if (query && !textArg && !opts.taskFile) {
    const r = resolveRun(listRuns(pr, Infinity), query);
    if (!r.ok && r.reason === "none") { text = query; query = undefined; }
  }
  ```
- 選 run：有 `query` → `findRun`。沒有 `query`：`text` 存在 → `reopenCandidates(pr)`；只有一個或有「最新」且互動環境以外 → 見下；沒有 `text` → 維持現有 `latestUnfinishedRun`。
  - 有 `text` 且候選 ≥ 2：互動環境用 `readline` 列出編號清單（名稱、狀態、task 第一行），讓使用者輸入編號或名稱（不用新依賴，沿用 `driveRun` 的 `readline.createInterface` 寫法）；非互動環境 `fail` 並列候選與「請用 `resume <name> "..."`」。候選只有 1 個直接用。0 個：`fail("No run to continue. Start one with: agent-lyceum run \"<task>\"")`。
  - 規格決議 4 說「最新的 run」：若最新一個比其他都新且全部已結束，仍屬「多候選」，照上面列出——不猜。
- `state.end_reason === "done"` 的分支：
  - 有 `text` → 不印結果，往下走（`continueRun` 帶 `followup`）。
  - 沒有 `text` → 現有行為（印結果、`process.exit(...)`）。
- `state.end_reason` 不是 `done` 但有 `text` → `fail("Run <name> is not finished (<reason>); resume it without text first, then follow up.")`（避免把追加要求塞進一個還沒結束的 run）。
- 回合上限檢查：`state.rounds >= pr.dispatcher.max_rounds` 改成 `state.rounds >= roundLimit(state, pr.dispatcher.max_rounds)`；有 `text` 時略過這項（重開會重算）。
- `continueRun(pr, dir, runId)` 加第四個參數 `followup?: { text: string }`，傳給 `runTeam({ ..., followup })`；`Resuming run ...` 那行改成：有 followup 時印 `Reopening run <name ?? id> (follow-up <n>): <text 第一行>`，並把 `${pr.dispatcher.max_rounds}` 換成 `roundLimit(state, pr.dispatcher.max_rounds)`。

- [ ] **Step 4: 確認測試通過**

Run: `npx vitest run test/cli.test.ts && npm run typecheck && npm run lint`
Expected: PASS；既有 `resume` 測試（無文字）不變。

- [ ] **Step 5: Commit**

```bash
git add src test
git commit -m "feat(cli): resume [run] \"text\" reopens a finished run"
```

---

### Task 5: lead 分支重切、已有 PR 只 push

**Files:**
- Modify: `src/worktree.ts`（新增 `recutLeadWorkspace`）
- Modify: `src/run-session.ts`（重開且 `concurrent` 時呼叫）
- Modify: `src/open-pr.ts`（`OpenPrInput.existingUrl?`）
- Test: `test/run-reopen.test.ts`、`test/open-pr.test.ts`

**Interfaces:**
- Consumes: `removeAgentWorkspace`、`prepareAgentWorkspace`、`snapshotHead`、`inspectWorkspace`、`existingAgentWorkspace`（`src/worktree.ts` 既有）；`RunState.result_branch`（有 `head`）
- Produces:
  - `export function recutLeadWorkspace(project: ResolvedProject, runId: string, agent: string, ws: AgentWorkspace, resultHead: string | undefined): { ws: AgentWorkspace; recut: boolean }`：只有在「`resultHead` 已是 `HEAD` 的祖先（`git merge-base --is-ancestor <resultHead> HEAD` 在 `toplevel(project.dir)` 成功）且 worktree 沒有未提交變更（`inspectWorkspace(...).dirty` 為空且沒有 `unknown`）」時，`removeAgentWorkspace` 後 `prepareAgentWorkspace(project, runId, agent, snapshotHead(project, runId))`，回 `recut: true`；否則原樣回 `{ ws, recut: false }`。
  - `OpenPrInput.existingUrl?: string`；`openPullRequest` 在有 `existingUrl` 時只做 `git push`，成功回 `{ status: "opened", url: existingUrl }`（沿用型別，訊息由呼叫端處理）。

- [ ] **Step 1: 寫失敗測試**

```ts
// test/run-reopen.test.ts（需要 git repo 的環境；照 test/integration.test.ts 的 concurrent 測試建 env，max_concurrent_runs: 2）
it("reopening after the lead branch was merged recuts the worktree from HEAD", async () => {
  // 第一段在 lead worktree 寫 a.txt，結束；測試中 `git merge <branch>` 進主 repo；重開後 lead worktree 的 base 為新的 HEAD，且 a.txt 不再算分支的變更
});
it("reopening before the branch is merged keeps the same worktree and branch", async () => { /* 重開後 ws.branch 不變，commit 接在同分支 */ });
```

`test/open-pr.test.ts` 加：

```ts
it("with an existing PR url it only pushes", () => {
  const calls: string[][] = [];
  const r = openPullRequest({ ...input, existingUrl: "https://x/pull/3", run: (cmd, args) => { calls.push([cmd, ...args]); return { ok: true, out: "" }; } });
  expect(r).toEqual({ status: "opened", url: "https://x/pull/3" });
  expect(calls.every((c) => !(c[0] === "gh"))).toBe(true);
});
```

- [ ] **Step 2: 確認測試失敗**

Run: `npx vitest run test/run-reopen.test.ts test/open-pr.test.ts`
Expected: FAIL

- [ ] **Step 3: 實作**

`src/worktree.ts` 檔尾加 `recutLeadWorkspace`（簽名如上，內容如 Interfaces 描述；用 `tryGit(toplevel(project.dir), ["merge-base", "--is-ancestor", resultHead, "HEAD"])`——既有 `tryGit` 在失敗時回 `undefined`、成功回字串，與 `inspectWorkspace` 內 `tryGitAt(... ) === undefined` 的用法一致）。

`src/run-session.ts` 建構子：`if (concurrent && resume)` 取得 `leadSpace` 之後加：

```ts
if (opts.followup && leadSpace) {
  const r = recutLeadWorkspace(project, runId, project.lead, leadSpace, resume.result_branch?.head);
  leadSpace = r.ws;
  if (r.recut) say(`  ${project.lead}'s branch was already merged: a fresh branch ${leadSpace.branch} was cut from HEAD ${leadSpace.base.slice(0, 8)}`);
}
```

`state.result_branch` 在 Task 3 已於重開時清掉；這裡要在清除之前讀取，所以 `recutLeadWorkspace` 呼叫用 `resume.result_branch`（`resume` 是參數，未被改動）。

`src/open-pr.ts`：`OpenPrInput` 加 `existingUrl?: string;`；`openPullRequest` 在 push 成功後 `if (i.existingUrl) return { status: "opened", url: i.existingUrl };`，其餘流程不變。`src/run-session.ts` 的 `maybeOpenPr` 傳 `existingUrl: state.pr_url`，成功且為既有網址時 `say("  pull request updated: <url>")`。

- [ ] **Step 4: 確認測試通過**

Run: `npx vitest run test/run-reopen.test.ts test/open-pr.test.ts test/worktree.test.ts && npm run typecheck && npm run lint`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src test
git commit -m "feat(run): recut the lead branch after it was merged; push only when a PR exists"
```

---

### Task 6: 文件與 spec 狀態

**Files:**
- Modify: `README.md`、`README.zh-TW.md`（How a run works 後加「Continuing a finished run」一節；指令表 `resume` 列）
- Modify: `docs/commands.md`、`docs/commands.zh-TW.md`（`run --name`、`resume [run] [text]`、`clear`／`status` 接受名稱）
- Modify: `docs/specs/16-task-names-and-reopen.md`（狀態改「已實作（計畫：docs/plans/2026-10-14-16-task-names-and-reopen.md）」）、`docs/specs/README.md`（plan 欄連結）

- [ ] **Step 1:** 依實作結果寫文件，中英標題結構一致。
- [ ] **Step 2:** Run: `npm run check:docs && npm run typecheck && npm test && npm run lint`；Expected: 全部通過。
- [ ] **Step 3: Commit**

```bash
git add README.md README.zh-TW.md docs
git commit -m "docs: task names and reopening a finished run"
```

---

## Self-Review（對照 spec 16）

- 決議 1（名稱）→ Task 1、2；2（三種寫法）→ Task 1、2；3（沿用 `resume`）→ Task 4；4（選最新、多候選列選項）→ Task 4；5、6（重開、保留、`followups/`）→ Task 3；7（`done-<n>.md`、`reopened`）→ Task 3；8（回合上限）→ Task 1、3、4；9（分支已 merge 重切）→ Task 5；10（已有 PR 只 push）→ Task 5；11（顯示名稱）→ Task 2。
- 驗收 1–8 各有對應測試：1、2 → Task 2；3、5 → Task 3；4、8 → Task 4；6 → Task 5；7 → Task 5。
- 已知取捨：`resume [run] [text]` 一個參數時先嘗試當 run、解析不到才當文字，所以拼錯 run 名稱的人會看到「這段被當成追加要求」；`resume` 的輸出在這種情況印出「Reopening ... follow-up: <第一行>」讓使用者看得出來，並且因為只有已 done 的 run 才會被重開，打錯字的風險限於已結束的 run。
- 17（共享 memory）不在這份計畫內；它依賴這裡的 `followups/`、`done-<n>.md` 與重開流程。
