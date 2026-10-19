# 單 run 預算上限（P0-2）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 讓使用者可以替單一 run 設 output token 與牆鐘時間上限；達上限時 run 以新的 `end_reason: budget` 結束，信件保留未讀，`resume` 後從該次起重新計算。

**Architecture:** 新增純函式模組 `src/budget.ts`（`checkBudget`）判斷是否超限；`RunSession.run()` 主迴圈在既有 `max_rounds` 檢查旁呼叫它，超限就把 `endReason` 設為 `"budget"`。計算基準（起始 token、起始時間）存在 `RunSession` 記憶體裡，每次 `run`／`resume` 都是新的 `RunSession`，所以「resume 後重新計算」不需要任何新的 state 欄位。設定放在 `dispatcher.max_output_tokens`、`dispatcher.max_wall_min`，預設 `0` = 不限（行為與現在相同）。

**Tech Stack:** TypeScript（ESM）、zod（`src/schema.ts`）、vitest。無新依賴。

**Spec:** `docs/evaluation-orbital.md` §3 P0-2（在 branch `agent-lyceum/20261019T055553060Z-7408c8d722d7bbbdd400d967c4880e66/tech-lead`；用 `git show <branch>:docs/evaluation-orbital.md` 讀）。

## Global Constraints

- 只借 Orbital 的概念，不參考、不複製其程式碼（GPL-3.0；本專案 MIT）。
- 預設關閉：兩個新設定預設 `0`，舊設定檔與舊 `state.json` 行為不變。
- `state.json` 的 `schema_version` 維持不變；唯一的格式變動是 `end_reason` 多一個值 `"budget"`（`status --json` 的消費者把它當字串，`plugins/status-monitor` 的型別是 `string`，不需改）。
- 已在跑的喚醒讓它跑完；只是不再喚醒新的 agent（與 `max_rounds` 相同）。信件保留未讀。
- 只做單 run 預算：**不做**按專案、按週期重置的全域預算；**不做** input／快取 token／金額擷取（需先用真實 CLI 輸出確認欄位，另開一份 plan）。
- output token 只是近似成本；`claude` 與 `codex` 口徑不同，文件必須寫明。
- 用量只含已回報 `outputTokens` 的喚醒（`state.output_tokens`）。
- 指令：`npm run build`（tsc）、`npm test`（vitest run）、`npm run lint`（biome）。

---

## File Structure

- Create `src/budget.ts`：`BudgetLimits`、`BudgetUsage`、`checkBudget()`；一個責任：判斷超限並產生人看得懂的原因。
- Modify `src/schema.ts`：`DispatcherPartial`、`DispatcherSettings`、`DISPATCHER_DEFAULTS` 各加兩個欄位。
- Modify `src/run-store.ts`：`EndReason` 與 `WireState.end_reason` enum 加 `"budget"`。
- Modify `src/run-outcome.ts`：`endOutcome` 加 `case "budget"`。
- Modify `src/run-session.ts`：記憶體基準 + 主迴圈檢查。
- Modify `src/scaffold.ts`：project.yaml 範本加兩行註解範例。
- Test `test/budget.test.ts`（新）、`test/dispatcher.test.ts`、`test/run-outcome.test.ts`、`test/config.test.ts`。
- Modify `docs/configuration.md`、`docs/configuration.zh-TW.md`、`docs/commands.md`、`docs/commands.zh-TW.md`（結束碼段）、`docs/how-it-works.md`、`docs/how-it-works.zh-TW.md`。

### Task 1: `checkBudget` 純函式

**Files:**
- Create: `src/budget.ts`
- Test: `test/budget.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface BudgetLimits { maxOutputTokens: number; maxWallMin: number } // 0 = no limit
  export interface BudgetUsage { outputTokens: number; elapsedMs: number }      // counted from the start of this segment
  export function checkBudget(limits: BudgetLimits, usage: BudgetUsage): string | undefined
  ```
  回傳 `undefined` 表示沒超限；否則回傳一句人看得懂的原因（會直接放進 note）。

- [ ] **Step 1: 寫會失敗的測試**

`test/budget.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { checkBudget } from "../src/budget.js";

const none = { maxOutputTokens: 0, maxWallMin: 0 };

describe("checkBudget", () => {
  it("never trips with no limits", () => {
    expect(checkBudget(none, { outputTokens: 10_000_000, elapsedMs: 99 * 3_600_000 })).toBeUndefined();
  });

  it("trips at the output token limit, not before", () => {
    const limits = { ...none, maxOutputTokens: 1000 };
    expect(checkBudget(limits, { outputTokens: 999, elapsedMs: 0 })).toBeUndefined();
    expect(checkBudget(limits, { outputTokens: 1000, elapsedMs: 0 })).toMatch(/output token budget \(1000\)/);
  });

  it("trips at the wall-clock limit, not before", () => {
    const limits = { ...none, maxWallMin: 30 };
    expect(checkBudget(limits, { outputTokens: 0, elapsedMs: 30 * 60_000 - 1 })).toBeUndefined();
    expect(checkBudget(limits, { outputTokens: 0, elapsedMs: 30 * 60_000 })).toMatch(/time budget \(30 min\)/);
  });

  it("reports the token limit first when both are exceeded", () => {
    const r = checkBudget({ maxOutputTokens: 10, maxWallMin: 1 }, { outputTokens: 10, elapsedMs: 120_000 });
    expect(r).toMatch(/output token/);
  });
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx vitest run test/budget.test.ts`
Expected: FAIL（找不到 `../src/budget.js`）

- [ ] **Step 3: 實作**

`src/budget.ts`：

```ts
/** Per-run spending limits. 0 = no limit. */
export interface BudgetLimits {
  maxOutputTokens: number;
  maxWallMin: number;
}

/** What this segment of the run (from the start or the last resume) has used so far. */
export interface BudgetUsage {
  outputTokens: number;
  elapsedMs: number;
}

/** Why the run must stop waking agents, or undefined while it is within budget. */
export function checkBudget(limits: BudgetLimits, usage: BudgetUsage): string | undefined {
  if (limits.maxOutputTokens > 0 && usage.outputTokens >= limits.maxOutputTokens) {
    return `Used ${usage.outputTokens} output tokens, reaching the output token budget (${limits.maxOutputTokens}).`;
  }
  if (limits.maxWallMin > 0 && usage.elapsedMs >= limits.maxWallMin * 60_000) {
    return `Ran for ${Math.round(usage.elapsedMs / 60_000)} min, reaching the time budget (${limits.maxWallMin} min).`;
  }
  return undefined;
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `npx vitest run test/budget.test.ts`
Expected: PASS（4 個）

- [ ] **Step 5: Commit**

```bash
git add src/budget.ts test/budget.test.ts
git commit -m "feat(budget): checkBudget decides when a run has used up its budget"
```

### Task 2: 設定欄位與 `budget` 結束原因

**Files:**
- Modify: `src/schema.ts`（`DispatcherPartial` 約 76–89 行、`DispatcherSettings` 約 109–118 行、`DISPATCHER_DEFAULTS` 約 120–127 行）
- Modify: `src/run-store.ts:14`、`src/run-store.ts:174`
- Modify: `src/run-outcome.ts`（`endOutcome` 的 switch）
- Test: `test/config.test.ts`、`test/run-outcome.test.ts`

**Interfaces:**
- Consumes: 無（Task 1 與本 Task 互相獨立，皆由 Task 3 使用）。
- Produces: `DispatcherSettings.max_output_tokens: number`、`DispatcherSettings.max_wall_min: number`（皆預設 `0`）；`EndReason` 含 `"budget"`；`endOutcome("budget")` 回傳 `{ outcome: "partial", note }`。

- [ ] **Step 1: 寫會失敗的測試**

`test/run-outcome.test.ts` 加（沿用檔內既有 import 與風格；先 `sed -n 1,20p test/run-outcome.test.ts` 看 import）：

```ts
  it("a run that hit its budget is partial and says how to go on", () => {
    const r = endOutcome("budget");
    expect(r.outcome).toBe("partial");
    expect(r.note).toMatch(/budget/);
    expect(r.note).toMatch(/resume/);
  });
```

`test/config.test.ts` 加（沿用既有用 `makeEnv` + `editProjectYaml` 的模式，先 `grep -n "editProjectYaml" test/config.test.ts | head -3` 對照）：

```ts
  it("reads dispatcher.max_output_tokens and max_wall_min, both off by default", () => {
    env = makeEnv();
    expect(env.project().dispatcher.max_output_tokens).toBe(0);
    expect(env.project().dispatcher.max_wall_min).toBe(0);
    env.editProjectYaml((t) => t.replace("  max_rounds: 0", "  max_output_tokens: 5000\n  max_wall_min: 45\n  max_rounds: 0"));
    expect(env.project().dispatcher.max_output_tokens).toBe(5000);
    expect(env.project().dispatcher.max_wall_min).toBe(45);
  });
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx vitest run test/run-outcome.test.ts test/config.test.ts`
Expected: FAIL（`endOutcome("budget")` 型別錯誤／`max_output_tokens` 為 undefined 或 zod strict 拒絕未知鍵）

- [ ] **Step 3: 實作**

`src/schema.ts`：`DispatcherPartial` 內 `max_rounds` 之後加

```ts
    max_output_tokens: z.number().int().min(0).optional(),
    max_wall_min: z.number().int().min(0).optional(),
```

`DispatcherSettings` 內 `max_rounds: number;` 之後加

```ts
  /** The run stops waking agents once this segment has used this many output tokens; 0 = no limit. */
  max_output_tokens: number;
  /** The run stops waking agents once this segment has run this many minutes; 0 = no limit. */
  max_wall_min: number;
```

`DISPATCHER_DEFAULTS` 內 `max_rounds: 0,` 之後加 `max_output_tokens: 0,` 與 `max_wall_min: 0,`。

`src/run-store.ts`：第 14 行與第 174 行的聯集／enum 都加 `"budget"`（兩處必須一致）：

```ts
export type EndReason = "done" | "idle" | "max_rounds" | "budget" | "lead_failed" | "agent_failed" | "cancelled" | "waiting";
```

```ts
    end_reason: z.enum(["done", "idle", "max_rounds", "budget", "lead_failed", "agent_failed", "cancelled", "waiting"]).optional(),
```

`src/run-outcome.ts`：`endOutcome` 的 `case "max_rounds":` 之後加

```ts
    case "budget":
      return { outcome: "partial", note: "Stopped at the budget limit before the lead sent done. Unread mail was kept; raise dispatcher.max_output_tokens / max_wall_min if needed, then continue with `agent-lyceum resume`. The budget counts again from that resume." };
```

- [ ] **Step 4: 跑測試與編譯**

Run: `npx vitest run test/run-outcome.test.ts test/config.test.ts && npm run build`
Expected: PASS；`tsc` 沒有錯誤。若 `tsc` 指出其他 `switch (endReason)` 缺 case，照該處既有 `max_rounds` 的處理補 `budget`（本計畫調查時只有 `src/run-outcome.ts` 窮舉）。

- [ ] **Step 5: Commit**

```bash
git add src/schema.ts src/run-store.ts src/run-outcome.ts test/run-outcome.test.ts test/config.test.ts
git commit -m "feat(budget): dispatcher.max_output_tokens / max_wall_min and the budget end reason"
```

### Task 3: 主迴圈在超限時結束 run

**Files:**
- Modify: `src/run-session.ts`（`run()` 約 865–900 行；import 區）
- Test: `test/dispatcher.test.ts`

**Interfaces:**
- Consumes: `checkBudget`、`BudgetLimits`（Task 1）；`cfg.max_output_tokens`、`cfg.max_wall_min`（Task 2；`cfg` 是 `run-session.ts` 內既有的 dispatcher 設定變數，與 `cfg.max_rounds` 同一個）；`this.note()`。
- Produces: 主迴圈在 `max_rounds` 檢查**之前**多一個預算檢查；超限時 `this.endReason = "budget"`，並用 `this.note(reason)` 留紀錄。

- [ ] **Step 1: 寫會失敗的測試**

`test/dispatcher.test.ts`（`OK` 沒有 `outputTokens`，這裡自訂）：

```ts
  it("ends with end_reason budget once the output token budget is used, leaving mail unread", async () => {
    env = makeEnv();
    env.editProjectYaml((t) => t.replace("  max_rounds: 0", "  max_output_tokens: 1000\n  max_rounds: 0"));
    const seen: string[] = [];
    const s = await run(async (i) => {
      seen.push(i.agent.name);
      if (i.agent.name === "lead" && seen.length === 1) mail(i, "fe-member", "implement login", "task");
      else if (i.agent.name === "fe-member") mail(i, "lead", "login implemented");
      else mail(i, "lead", "all good", "done");
      return { ...OK, outputTokens: 600 };
    });
    expect(seen).toEqual(["lead", "fe-member"]); // 1200 tokens after two wake-ups: the lead is not woken a third time
    expect(s.endReason).toBe("budget");
    expect(s.outcome).toBe("partial");
    const state = JSON.parse(fs.readFileSync(path.join(s.runDir, "state.json"), "utf8"));
    expect(state.end_reason).toBe("budget");
    expect(state.notes.join("\n")).toMatch(/output token budget \(1000\)/);
    expect(fs.readdirSync(path.join(inboxDir(env.project(), "lead"))).filter((f) => f.endsWith(".md")).length).toBe(1); // the member's reply is still unread
  });

  it("has no budget unless one is set", async () => {
    env = makeEnv();
    const s = await run(async (i) => {
      if (i.agent.name === "lead") mail(i, "lead", "all good", "done");
      return { ...OK, outputTokens: 10_000_000 };
    });
    expect(s.endReason).toBe("done");
  });
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx vitest run test/dispatcher.test.ts -t "budget"`
Expected: 第一個 FAIL（`seen` 有三筆、`endReason` 為 `done`）；第二個 PASS。

- [ ] **Step 3: 實作**

`src/run-session.ts` 檔頭 import 加：

```ts
import { checkBudget } from "./budget.js";
```

在 `run()` 內、`let leadWasLast = false;` 之前加基準（每個 `RunSession` = 一次 `run`／`resume`，所以 resume 自然重新計算）：

```ts
    // The budget counts from the start of this run or resume, not from the first wake-up ever.
    const budgetFrom = { tokens: state.output_tokens, at: Date.now() };
```

在主迴圈中，`if (pending.length === 0) { this.endReason = "idle"; break; }` 之後、`max_rounds` 檢查之前加：

```ts
      const overBudget = checkBudget(
        { maxOutputTokens: this.cfg.max_output_tokens, maxWallMin: this.cfg.max_wall_min },
        { outputTokens: state.output_tokens - budgetFrom.tokens, elapsedMs: Date.now() - budgetFrom.at },
      );
      if (overBudget) {
        this.note(overBudget);
        this.endReason = "budget";
        break;
      }
```

（`this.cfg` 是否為欄位：`run-session.ts` 的 `settle()` 已寫 `this.cfg.retry`，所以存在；若主迴圈所在方法已解構出 `cfg`，用它即可。）

- [ ] **Step 4: 跑測試確認通過**

Run: `npx vitest run test/dispatcher.test.ts`
Expected: 全部 PASS（含原有測試）

- [ ] **Step 5: 全部檢查**

Run: `npm run build && npm test && npm run lint`
Expected: 全過

- [ ] **Step 6: Commit**

```bash
git add src/run-session.ts test/dispatcher.test.ts
git commit -m "feat(budget): stop waking agents once the run's budget is used"
```

### Task 4: 範本、文件與結束碼

**Files:**
- Modify: `src/scaffold.ts:97` 附近（project.yaml 範本）
- Modify: `docs/configuration.md`、`docs/configuration.zh-TW.md`（第 23 行的 dispatcher 範例與該節的欄位說明）
- Modify: `docs/commands.md`、`docs/commands.zh-TW.md`（第 244 行附近的 exit code 段：預算結束屬 `partial`，回傳 `2`）
- Modify: `docs/how-it-works.md`、`docs/how-it-works.zh-TW.md`（結束條件段，約第 8 行）

- [ ] **Step 1: 範本**

`src/scaffold.ts` 的 `max_rounds: 0 ...` 之後加兩行：

```
  max_output_tokens: 0  # 0 = no limit; stop waking agents once a run (or a resume) has used this many output tokens
  max_wall_min: 0       # 0 = no limit; stop waking agents once a run (or a resume) has run this many minutes
```

注意縮排與同檔其他行一致（兩個空格）。`src/demo.ts:92` 用 `replace("max_rounds: 0 ", …)`，不受影響。

- [ ] **Step 2: 文件**

在 `docs/configuration.md` 補一段（英文）：

> `max_output_tokens`／`max_wall_min`（預設 `0`，不限）：run 達到上限就不再喚醒新的 agent，已在跑的喚醒會跑完，信件保留未讀；run 以 `end_reason: budget`、outcome `partial` 結束（結束碼 `2`）。`resume` 後重新計算（從該次起算，不是累計）。output token 是近似成本，`claude` 與 `codex` 計法不同，不含 input／快取 token 或金額。

中文檔同義。`commands*.md` 的結束碼段在「達到 `max_rounds`」旁補「或預算上限」。`how-it-works*.md` 的結束條件加「或達到預算上限（`max_output_tokens`、`max_wall_min`）」。

- [ ] **Step 3: 檢查**

Run: `node scripts/check-docs.mjs && npm test`
Expected: `docs ok`；測試全過（若有測試斷言 scaffold 範本全文，同步更新）。

- [ ] **Step 4: Commit**

```bash
git add src/scaffold.ts docs/configuration.md docs/configuration.zh-TW.md docs/commands.md docs/commands.zh-TW.md docs/how-it-works.md docs/how-it-works.zh-TW.md
git commit -m "docs(budget): document dispatcher.max_output_tokens and max_wall_min"
```

---

## Self-Review

- **覆蓋：** P0-2 的步驟 2（`dispatcher.budget` 的 token／牆鐘、`end_reason: budget`、信件保留、resume 重算）由 Task 1–4 涵蓋。步驟 1（擷取 input／快取／金額）與「全域預算」**刻意不在本 plan**（見 Global Constraints），需先用真實 `claude -p --output-format json`／`codex exec --json` 輸出確認欄位後另寫 plan。
- **命名偏離報告：** 報告寫 `dispatcher.budget: { … }`；本 plan 用平的 `max_output_tokens`／`max_wall_min`，與既有 `max_rounds`、`wake_timeout_sec` 風格一致，且 `DispatcherPartial` 是 `.strict()` 的平面物件。
- **佔位掃描：** 無 TBD；Task 2 Step 1 兩處「先看既有 import／模式」是對既有測試檔風格的對齊，不是省略內容（測試本體已完整給出）。
- **型別一致：** `checkBudget(limits: BudgetLimits, usage: BudgetUsage)`、`maxOutputTokens`／`maxWallMin`（camelCase，模組內）對應 `max_output_tokens`／`max_wall_min`（snake_case，設定），Task 3 做轉換；`EndReason` 兩處 `"budget"` 一致。
- **已知限制：** 牆鐘時間不含 Ctrl-C 到 `resume` 之間的時間，也不跨 resume 累計（符合「resume 重新計算」）；token 用量只含有回報 `outputTokens` 的喚醒。
