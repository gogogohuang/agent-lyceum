# 程式品質與維護性 實作計畫

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 收緊 TypeScript 設定、加入 lint，並在有測試保護的前提下把 `runTeam` 的判斷邏輯抽成純函式、狀態收進 `RunSession`。

**Architecture:** 兩階段。Task 1–4 是「不改行為」的設定收緊與 lint；Task 5–6 才動 `dispatcher.ts`，且重構期間 `test/` 不得修改（修改代表行為變了，要停下來檢討）。

**Tech Stack:** TypeScript 5.9、Biome 2（只啟用 linter）、Vitest。

**Spec:** `docs/specs/04-code-quality.md`

## 已量測的現況（2026-10-07）

| 設定 | 開啟後的錯誤數 |
|---|---|
| `noImplicitOverride` | 0 |
| `noUnusedLocals` | 0 |
| `noUnusedParameters` | 1（`src/dispatcher.ts:26` 的 `retryPrompt(…, attempt, …)`）|
| `noUncheckedIndexedAccess` | 79：`status.ts` 24、`validate.ts` 19、`worktree.ts` 10、`run-cleanup.ts` 9、`format.ts` 6、`mailbox.ts` 5、`dispatcher.ts` 4、`cli.ts` 1、`prompt.ts` 1（類型：TS18048 ×29、TS2345 ×22、TS2532 ×21、TS2322 ×7）|

Biome 2.5.15 以 Task 4 的設定對 `src/`、`test/` 掃描：5 個 error（4 個未使用 import、1 個未使用參數，後者由 Task 1 一併修掉）與約 30 項 warning（見 Task 4 的待辦清單）。

## Global Constraints

- 不得改變任何執行期行為：Task 1–4 的 diff 只能是型別收窄、明確檢查、設定檔。
- 只對 `src/` 與 `test/` 做 lint；formatter 不啟用（避免整份重排）。
- Task 5–6 期間 `git diff --stat test/` 必須為空（Task 5 新增測試檔除外）。
- Node >=20。

---

### Task 1: 開啟 `noImplicitOverride`、`noUnusedLocals`、`noUnusedParameters`

**Files:**
- Modify: `tsconfig.json`
- Modify: `src/dispatcher.ts:26-28` 與 `:201`（`retryPrompt` 的呼叫處）

- [ ] **Step 1: 開啟旗標，確認只有一個錯誤**

`tsconfig.json` 的 `compilerOptions` 加入：

```json
    "noImplicitOverride": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
```

Run: `npm run typecheck`
Expected: 只有 `src/dispatcher.ts(26,38): error TS6133: 'attempt' is declared but its value is never read.`

- [ ] **Step 2: 移除未使用的參數**

`src/dispatcher.ts` 的 `retryPrompt` 改為：

```ts
function retryPrompt(prompt: string, error?: string): string {
```

函式本體不變。`wake` 內的呼叫（約第 201 行）改為 `retryPrompt(base.userPrompt, result?.error)`。

- [ ] **Step 3: 驗證**

Run: `npm run typecheck && npm test`
Expected: 全 PASS

- [ ] **Step 4: Commit**

```bash
git add tsconfig.json src/dispatcher.ts
git commit -m "chore(ts): enable noImplicitOverride, noUnusedLocals and noUnusedParameters"
```

---

### Task 2: `must()` 斷言輔助函式

**Files:**
- Create: `src/assert.ts`
- Create: `test/assert.test.ts`

**Interfaces:**
- Produces: `export function must<T>(value: T | undefined | null, what: string): T` — 值為 `undefined`／`null` 時丟出 `Error("internal: <what> is missing")`，否則回傳它。只用在「程式不變式保證存在」的地方（取代 `arr[i]!`），不用在使用者輸入。

- [ ] **Step 1: 寫失敗的測試**

`test/assert.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { must } from "../src/assert.js";

describe("must", () => {
  it("returns the value, including falsy ones that are not null or undefined", () => {
    expect(must(0, "n")).toBe(0);
    expect(must("", "s")).toBe("");
    expect(must(false, "b")).toBe(false);
  });

  it("throws an internal error naming what is missing", () => {
    expect(() => must(undefined, "lead result")).toThrow("internal: lead result is missing");
    expect(() => must(null, "x")).toThrow("internal: x is missing");
  });
});
```

- [ ] **Step 2: 確認失敗**

Run: `npx vitest run test/assert.test.ts`
Expected: FAIL（模組不存在）

- [ ] **Step 3: 實作**

`src/assert.ts`：

```ts
/** For values the program's own invariants guarantee (never for user input): fail loudly instead of `value!`. */
export function must<T>(value: T | undefined | null, what: string): T {
  if (value === undefined || value === null) throw new Error(`internal: ${what} is missing`);
  return value;
}
```

- [ ] **Step 4: 確認通過並 commit**

Run: `npx vitest run test/assert.test.ts`
Expected: PASS

```bash
git add src/assert.ts test/assert.test.ts
git commit -m "chore: add must() for invariants that indexed access can no longer assume"
```

---

### Task 3: 開啟 `noUncheckedIndexedAccess`（79 處，逐檔）

**Files:** 依序 `src/cli.ts`、`src/prompt.ts`、`src/dispatcher.ts`、`src/mailbox.ts`、`src/format.ts`、`src/run-cleanup.ts`、`src/worktree.ts`、`src/validate.ts`、`src/status.ts`，最後 `tsconfig.json`。

**修法（四種，依情況擇一，不得改變行為）：**

1. **使用者資料或可能真的不存在** → 明確檢查：
   ```ts
   const first = items[0];
   if (!first) return;          // 或 continue / 回傳原本空情況的值
   ```
2. **正規表示式群組**（`m[1]`）→ 已 `if (m)` 判斷過的，用 `m[1] ?? ""`，且該空字串路徑要與原本「群組必存在」的語意相符；若不確定，改用具名群組並以 `m.groups?.name` 檢查。
3. **程式不變式保證存在**（例如 `results[leadIdx]`，`leadIdx` 剛由 `findIndex` 確認 ≥ 0 且 `results` 與 `batch` 同長）→ `must(results[leadIdx], "result of the lead")`，從 `./assert.js` import。
4. **`Record<string, T>` 的查詢**（`obj[key]`）→ `const v = obj[key]; if (!v) …`；如果原本就以 `undefined` 判斷缺席，型別改成 `Record<string, T | undefined>` 更貼切。

- [ ] **Step 1: 用命令列旗標確認現況（先不改 tsconfig）**

Run: `npx tsc -p tsconfig.json --noEmit --noUncheckedIndexedAccess 2>&1 | grep -c 'error TS'`
Expected: `79`

- [ ] **Step 2: 對每個檔案重複（順序見上方 Files）**

對檔案 `F`：
1. `npx tsc -p tsconfig.json --noEmit --noUncheckedIndexedAccess 2>&1 | grep "^src/F"` 取得該檔的錯誤位置。
2. 逐一套用上方四種修法。
3. 同一指令的 `grep -c "^src/F"` 必須為 `0`。
4. `npm run typecheck && npm test`：全 PASS（修正在旗標關閉時也必須通過）。
5. `git add src/F && git commit -m "chore(ts): handle possibly-undefined indexed access in F"`（`F` 換成檔名）。

- [ ] **Step 3: 全部完成後確認旗標下零錯誤**

Run: `npx tsc -p tsconfig.json --noEmit --noUncheckedIndexedAccess 2>&1 | grep -c 'error TS'`
Expected: `0`

- [ ] **Step 4: 正式開啟並 commit**

`tsconfig.json` 的 `compilerOptions` 加入 `"noUncheckedIndexedAccess": true,`。

Run: `npm run typecheck && npm test`
Expected: 全 PASS

```bash
git add tsconfig.json
git commit -m "chore(ts): enable noUncheckedIndexedAccess"
```

---

### Task 4: 加入 Biome lint

**Files:**
- Create: `biome.json`
- Modify: `package.json`（devDependencies、scripts）
- Modify: `.github/workflows/ci.yml`
- Modify: 4 個未使用 import 所在的測試檔

**Interfaces:**
- Produces: `npm run lint`；有 error 時 exit 1，warning 不影響 exit code。

- [ ] **Step 1: 安裝並建立設定**

Run: `npm i -D @biomejs/biome`

`biome.json`：

```json
{
  "formatter": { "enabled": false },
  "assist": { "enabled": false },
  "linter": {
    "enabled": true,
    "rules": {
      "recommended": true,
      "style": { "noNonNullAssertion": "off", "useTemplate": "off", "useImportType": "off" },
      "correctness": { "noUnusedImports": "error" },
      "suspicious": {
        "noExplicitAny": "warn",
        "noAssignInExpressions": "warn",
        "useIterableCallbackReturn": "warn"
      },
      "complexity": {
        "noCommaOperator": "warn",
        "noAdjacentSpacesInRegex": "warn"
      }
    }
  },
  "files": { "includes": ["src/**", "test/**"] }
}
```

`package.json` 的 `scripts` 加：`"lint": "biome lint",`

- [ ] **Step 2: 看現況**

Run: `npx biome lint 2>&1 | tail -5`
Expected: 4 個 `noUnusedImports` error（`test/integration.test.ts:5` 與 `:7`、`test/cancel.test.ts:3`、`test/adapters.test.ts:6`）與一批 warning。

- [ ] **Step 3: 修掉所有 error**

Run: `npx biome lint --diagnostic-level=error`
對列出的每一項：未使用的 import 直接移除該具名項目或整行（`npx biome lint --write --only=correctness/noUnusedImports` 可自動處理，處理後檢視 diff 確認只刪 import）。

- [ ] **Step 4: 確認 error 清零**

Run: `npx biome lint --diagnostic-level=error; echo exit=$?`
Expected: `exit=0`

- [ ] **Step 5: 接入 CI**

`.github/workflows/ci.yml`：在 `npm run typecheck` 之前加 `- run: npm run lint`。

- [ ] **Step 6: 驗證並 commit**

Run: `npm run lint && npm run typecheck && npm test`
Expected: lint exit 0（仍有 warning）、其餘全 PASS

```bash
git add biome.json package.json package-lock.json .github/workflows/ci.yml src test
git commit -m "chore: add Biome lint (errors fail CI, the rest stay warnings)"
```

> **後續（2026-10-07）：** 下列 warning 已全部清除，`biome.json` 移除了降級設定，這些規則現在都是 error。

**Warning 待辦清單（本 plan 不處理，之後可逐步轉為 error）：**
- `noAssignInExpressions`：`src/config.ts:163-165`（`else if ((runtime = inferRuntime(...)))` 鏈）、`src/process-runner.ts:141`（`while ((nl = text.indexOf("\n")) >= 0)`）、`src/dispatcher.ts:136,349`（`(state.notes ??= []).push`、`(w.sent ??= []).push`）
- `useIterableCallbackReturn`：`src/status.ts:340,349`（`forEach` 的箭頭函式回傳了 `lines.push(...)` 的結果）
- `noCommaOperator`：`src/cli.ts:168`，`test/outcome.test.ts:69,107`，`test/cancel.test.ts:59,69`
- `noExplicitAny`：`test/` 內 12 處
- 正規表示式類：`test/validate.test.ts:19,26,98`、`test/dispatcher.test.ts:396`、`test/config.test.ts:114`、`test/status.test.ts:139`、`test/cli.test.ts:19`

---

### Task 5: 把「結果判定」抽成純函式

**Files:**
- Create: `src/run-outcome.ts`
- Create: `test/run-outcome.test.ts`
- Modify: `src/dispatcher.ts`（`settle` 內約 373–383 行；檔尾約 472–482 行）

**Interfaces:**
- Consumes: `DoneContract`（`src/format.ts`：`{ outcome?: RunOutcome; missing: string[]; verification?: string }`）、`EndReason`（`src/run-store.ts`）、`RunOutcome`（`src/schema.ts`）。
- Produces:
  - `export interface UnintegratedWork { agent: string; branch: string; report: string }`
  - `export function resolveDoneOutcome(contract: DoneContract, rejections: number, unintegrated: UnintegratedWork[]): { outcome: RunOutcome; note?: string; verification?: string }`
  - `export function endOutcome(endReason: EndReason, done?: { outcome: RunOutcome; note?: string }): { outcome: RunOutcome; note?: string }`

- [ ] **Step 1: 寫失敗的測試**

`test/run-outcome.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { endOutcome, resolveDoneOutcome } from "../src/run-outcome.js";

describe("resolveDoneOutcome", () => {
  it("accepts a done that meets the contract with the outcome the lead declared", () => {
    expect(resolveDoneOutcome({ outcome: "completed", missing: [], verification: "npm test: passed" }, 0, [])).toEqual({
      outcome: "completed",
      note: undefined,
      verification: "npm test: passed",
    });
  });

  it("downgrades a done that still breaks the contract to partial and says what was missing", () => {
    const r = resolveDoneOutcome({ outcome: "completed", missing: ["## Files", "## Not done"] }, 2, []);
    expect(r.outcome).toBe("partial");
    expect(r.note).toBe("Completion contract not met after 2 reminder(s): missing ## Files; ## Not done. Reported as partial; the lead's report is kept as written.");
  });

  it("will not call the job completed while a member's work is not in the repo", () => {
    const r = resolveDoneOutcome({ outcome: "completed", missing: [] }, 0, [
      { agent: "fe", branch: "agent-lyceum/r/fe", report: "/r/fe.md" },
      { agent: "qa", branch: "agent-lyceum/r/qa", report: "/r/qa.md" },
    ]);
    expect(r.outcome).toBe("blocked");
    expect(r.note).toBe("Not completed: work of fe (branch agent-lyceum/r/fe), qa (branch agent-lyceum/r/qa) was never brought into the repo; see /r/fe.md, /r/qa.md.");
  });

  it("keeps partial and blocked reports as they are, even with unintegrated work", () => {
    expect(resolveDoneOutcome({ outcome: "partial", missing: [] }, 0, [{ agent: "fe", branch: "b", report: "r" }]).outcome).toBe("partial");
    expect(resolveDoneOutcome({ outcome: "blocked", missing: [] }, 0, []).outcome).toBe("blocked");
  });
});

describe("endOutcome", () => {
  it("takes the lead's outcome when the run ended with a done", () => {
    expect(endOutcome("done", { outcome: "completed" })).toEqual({ outcome: "completed", note: undefined });
    expect(endOutcome("done", { outcome: "blocked", note: "n" })).toEqual({ outcome: "blocked", note: "n" });
  });

  it("maps every other end reason", () => {
    expect(endOutcome("lead_failed")).toEqual({ outcome: "failed", note: "The lead's wake-up failed." });
    expect(endOutcome("cancelled").outcome).toBe("cancelled");
    expect(endOutcome("cancelled").note).toContain("agent-lyceum resume");
    expect(endOutcome("idle")).toEqual({ outcome: "partial", note: "All mailboxes were empty but the lead never sent a done message." });
    expect(endOutcome("max_rounds")).toEqual({ outcome: "partial", note: "Stopped at the round limit before the lead sent done." });
  });
});
```

- [ ] **Step 2: 確認失敗**

Run: `npx vitest run test/run-outcome.test.ts`
Expected: FAIL（模組不存在）

- [ ] **Step 3: 實作 `src/run-outcome.ts`**

```ts
import type { DoneContract } from "./format.js";
import type { EndReason } from "./run-store.js";
import type { RunOutcome } from "./schema.js";

export interface UnintegratedWork {
  agent: string;
  branch: string;
  report: string;
}

/** What a lead's `done` amounts to: its declared outcome, unless the contract is broken or member work never reached the repo. */
export function resolveDoneOutcome(
  contract: DoneContract,
  rejections: number,
  unintegrated: UnintegratedWork[],
): { outcome: RunOutcome; note?: string; verification?: string } {
  const ok = contract.missing.length === 0;
  let outcome: RunOutcome = ok ? (contract.outcome ?? "partial") : "partial";
  let note = ok ? undefined : `Completion contract not met after ${rejections} reminder(s): missing ${contract.missing.join("; ")}. Reported as partial; the lead's report is kept as written.`;
  if (outcome === "completed" && unintegrated.length) {
    outcome = "blocked";
    note = `Not completed: work of ${unintegrated.map((b) => `${b.agent} (branch ${b.branch})`).join(", ")} was never brought into the repo; see ${unintegrated.map((b) => b.report).join(", ")}.`;
  }
  return { outcome, note, verification: contract.verification };
}

/** How a run turned out, from why it stopped (`done` carries the lead's own verdict). */
export function endOutcome(endReason: EndReason, done?: { outcome: RunOutcome; note?: string }): { outcome: RunOutcome; note?: string } {
  switch (endReason) {
    case "done":
      return { outcome: done?.outcome ?? "partial", note: done?.note };
    case "lead_failed":
      return { outcome: "failed", note: "The lead's wake-up failed." };
    case "cancelled":
      return { outcome: "cancelled", note: "Cancelled before the lead finished. Unread mail was kept; continue with `agent-lyceum resume`." };
    case "idle":
      return { outcome: "partial", note: "All mailboxes were empty but the lead never sent a done message." };
    case "max_rounds":
      return { outcome: "partial", note: "Stopped at the round limit before the lead sent done." };
  }
}
```

- [ ] **Step 4: 確認通過**

Run: `npx vitest run test/run-outcome.test.ts`
Expected: PASS

- [ ] **Step 5: 接回 `dispatcher.ts`**

`settle` 內，把

```ts
      const ok = !contract || contract.missing.length === 0;
      doneOutcome = ok ? contract!.outcome! : "partial";
      doneVerification = contract?.verification;
      doneNote = ok ? undefined : `Completion contract not met after …`;
      const unintegrated = state.blocked_integrations ?? [];
      if (doneOutcome === "completed" && unintegrated.length) {
        doneOutcome = "blocked";
        doneNote = `Not completed: …`;
      }
```

整段（`const ok` 到該 `if` 區塊結束）換成：

```ts
      const resolved = resolveDoneOutcome(must(contract, "completion contract of the done report"), state.done_rejections ?? 0, state.blocked_integrations ?? []);
      doneOutcome = resolved.outcome;
      doneNote = resolved.note;
      doneVerification = resolved.verification;
```

檔尾，把 `const outcome: RunOutcome = …` 與 `const outcomeNote = …` 兩段換成：

```ts
  const { outcome, note: outcomeNote } = endOutcome(endReason, endReason === "done" ? { outcome: doneOutcome ?? "partial", note: doneNote } : undefined);
```

import 加 `import { must } from "./assert.js";`、`import { endOutcome, resolveDoneOutcome } from "./run-outcome.js";`；`RunOutcome` 型別 import 若仍被 `doneOutcome` 宣告使用則保留。若 TypeScript 回報 `endReason` 可能為 `undefined`，在呼叫處改傳 `must(endReason, "end reason")`。

- [ ] **Step 6: 全部測試（`test/` 不得有其他修改）**

Run: `npm run typecheck && npm test && git diff --stat test/`
Expected: 全 PASS；`git diff --stat test/` 只會看到 `test/run-outcome.test.ts` 是新檔（尚未 add 時顯示為 untracked，不在 diff 內）

- [ ] **Step 7: Commit**

```bash
git add src/run-outcome.ts test/run-outcome.test.ts src/dispatcher.ts
git commit -m "refactor(dispatcher): pull the done/end outcome rules out as pure functions"
```

---

### Task 6: `runTeam` 的狀態收進 `RunSession`

**Files:**
- Create: `src/run-session.ts`
- Modify: `src/dispatcher.ts`（`runTeam` 縮成建立 session 並呼叫）

**Interfaces:**
- Consumes: Task 5 的兩個純函式。
- Produces（對外 API 不變）：`dispatcher.ts` 仍匯出 `runTeam`、`newRunId`、`RESULT_FILE`、`MAX_DONE_REJECTIONS`、`RunSummary`、`RunOptions` 與既有型別 re-export。

**搬移規則（機械式，不改邏輯）：**

`RunSession` 的欄位 = 原 `runTeam` 內的區域變數與閉包；方法 = 原閉包。轉換一律是：閉包內對區域變數 `x` 的參照改為 `this.x`，閉包 `const f = (…) => {…}` 改為方法 `f(…) {…}`，呼叫處改為 `this.f(…)`。不得調整語句順序、不得改訊息文字。

```ts
// src/run-session.ts — 結構（內容由 dispatcher.ts 搬入）
export class RunSession {
  // 由建構時決定、之後不變
  private readonly invoke: Invoker;
  private readonly say: (line: string) => void;
  private readonly cfg: DispatcherSettings;
  private readonly runId: string;
  private readonly project: ResolvedProject; // 已 bindRunProject
  private readonly wsMode: ReturnType<typeof resolveWorkspaceMode>;
  private readonly log: ReturnType<typeof createRunLog>;
  private readonly guard: ProtectedGuard;
  // 會變動的狀態（原 runTeam 內的 let / const Map）
  state: RunState;
  private endReason: EndReason | undefined;
  private doneMessage: RunSummary["doneMessage"];
  private pendingDoneFile: string | undefined;
  private doneOutcome: RunOutcome | undefined;
  private doneNote: string | undefined;
  private doneVerification: string | undefined;
  private readonly claims = new Map<string, ClaimRecord>();
  private readonly attempts = new Map<string, AttemptRecord>();
  private readonly noSessionNoted = new Set<string>();
  private batchSpaces: Record<string, AgentWorkspace> = {};
  private leadWasLast = false;
  private nudged = false;

  constructor(private readonly opts: RunOptions) { /* 原 runTeam 開頭到 saveState() 為止 */ }

  private saveState(): void {}
  private note(text: string): void {}
  private pendingAgents(): ResolvedAgent[] {}
  private pickBatch(pending: ResolvedAgent[]): ResolvedAgent[] {}
  private async wake(agent: ResolvedAgent): Promise<{ ok: boolean; cancelled?: boolean }> {}
  private integrateMember(agent: ResolvedAgent, ws: AgentWorkspace, key: string): void {}
  private settle(batch: ResolvedAgent[], results: { ok: boolean; cancelled?: boolean }[]): void {}
  private recover(): void { /* 原 `if (resume) { const rec = recoverRunMail(...) ... }` 區塊 */ }
  async run(): Promise<RunSummary> { /* 原 while 迴圈與收尾 */ }
}
```

`src/dispatcher.ts` 最後只剩：

```ts
export async function runTeam(opts: RunOptions): Promise<RunSummary> {
  return new RunSession(opts).run();
}
```

加上原有的 `export`、`RESULT_FILE`、`MAX_DONE_REJECTIONS`、`retryPrompt`（`retryPrompt` 隨 `wake` 搬入 `run-session.ts`）。為避免循環匯入，`RunOptions`、`RunSummary`、`RESULT_FILE`、`MAX_DONE_REJECTIONS` 的定義搬到 `src/run-session.ts`，`dispatcher.ts` 從它 re-export：

```ts
export { RunSession, RESULT_FILE, MAX_DONE_REJECTIONS, type RunOptions, type RunSummary } from "./run-session.js";
```

- [ ] **Step 1: 確認安全網全綠**

Run: `npm test`
Expected: 全 PASS（記下測試總數，之後必須相同）

- [ ] **Step 2: 第一個 commit — 只搬「狀態與純輔助」**

建立 `src/run-session.ts`，把 `RunOptions`、`RunSummary`、`RESULT_FILE`、`MAX_DONE_REJECTIONS`、`retryPrompt` 搬過去（`dispatcher.ts` re-export）。`runTeam` 暫時留在 `dispatcher.ts`，從 `run-session.ts` import 這些型別。

Run: `npm run typecheck && npm test`
Expected: 全 PASS，測試總數不變

```bash
git add src/run-session.ts src/dispatcher.ts
git commit -m "refactor(dispatcher): move run types and constants to run-session.ts"
```

- [ ] **Step 3: 第二個 commit — 欄位與建構子**

在 `RunSession` 中加入欄位與建構子（原 `runTeam` 從開頭到 `saveState();` 第一次呼叫為止，含 resume／新 run 兩個分支、`guard`、snapshot、首封任務信）。`runTeam` 暫時改為：

```ts
export async function runTeam(opts: RunOptions): Promise<RunSummary> {
  const session = new RunSession(opts);
  return session.run();
}
```

`run()` 在這個 commit 先放「原 `runTeam` 其餘部分」整段（閉包仍在 `run()` 裡，透過 `this.state` 等取用已搬入欄位的變數）。

Run: `npm run typecheck && npm test`
Expected: 全 PASS，測試總數不變

```bash
git add src/run-session.ts src/dispatcher.ts
git commit -m "refactor(dispatcher): RunSession owns the run's state"
```

- [ ] **Step 4: 第三個 commit — 閉包改方法**

依序把 `saveState`、`note`、`pendingAgents`、`pickBatch`、`integrateMember`、`wake`、`settle`、恢復區塊（`recover`）從 `run()` 內移出成為方法。每搬一個就跑 `npm run typecheck && npm test`；若測試失敗，代表搬動時改了語意，還原該步重做。

Expected（全部搬完）: `run()` 只剩 while 迴圈、收尾與 `return`；`grep -c "" src/run-session.ts` 顯示檔案行數與原 `dispatcher.ts` 相近，且任何單一方法不超過約 80 行（`wake` 與 `settle` 若超過，保持原樣，不為了行數而改邏輯）。

```bash
git add src/run-session.ts src/dispatcher.ts
git commit -m "refactor(dispatcher): turn runTeam's closures into RunSession methods"
```

- [ ] **Step 5: 最終驗證**

Run: `npm run lint && npm run typecheck && npm test && git diff --stat main -- test/`
Expected: lint exit 0；typecheck 無錯；測試全 PASS；`git diff --stat main -- test/` 只包含 Task 2、5 新增的測試檔，沒有任何既有測試檔被修改。

## Self-Review

- Spec 4.1 → Task 1–4；4.2 的 1 → Task 6，2、3 → Task 5；4.3 → Task 1（`retryPrompt`）；import 過長的項目由 Task 6 搬移時自然消失（`dispatcher.ts` 的長 import 會隨之縮短），不另開任務。
- Spec 4.1 的「`no-floating-promises`」未納入：Biome 該規則需要型別資訊且屬 nursery，改由 `tsc` 與測試把關；已在此註明，不視為遺漏。
- Task 3 先用命令列旗標逐檔修正，全部清零後才改 `tsconfig.json`，所以每個 commit 在 CI 上都能通過。
- 名稱一致：`must`、`resolveDoneOutcome`、`endOutcome`、`UnintegratedWork`、`RunSession` 在各 Task 相同。
