# 共用檔歸屬與拆開 RunSession 實作計畫

> **給執行的 agent：** 必須使用子技能 superpowers:subagent-driven-development（建議）或 superpowers:executing-plans，一個 task 做完再做下一個。步驟用 `- [ ]` 追蹤。

**目標：** 兩件事分開交。第一件只寫規格：兩個 run 同時跑時，共用檔被改了要分得出是誰。第二件不改行為，把 `RunSession` 結尾「誰失敗就停」抽成可以單獨測的函式。

**架構：** 規格不選實作、不改 `src/guard.ts`。現在的 guard 分不出「另一個 run 的 lead 合法改的」和「這個 run 裡不該改的人改的」，所以看到另一個 run 還活著就整批留下。這個放行要寫進規格當禁止項。`RunSession` 只抽判斷，不把二十幾個欄位包去新檔再傳回來。

**技術：** Node.js 20+、TypeScript ESM（import 結尾加 `.js`）、Vitest。不新增依賴。

## 全域限制

- 這份計畫不改 `runTeam` 的簽章，不改 `max_rounds` 的預設 `0`，不改信箱格式，不改舊 run 的讀法。
- 重構期間不准改既有測試來配合新結構。`npm test` 要維持通過。
- 規格選定做法之前，不准改 `src/guard.ts` 的放行條件。
- 使用者看得到的行為若以後真的改了，要同時改 `docs/write-scope.md` 和 `docs/write-scope.zh-TW.md`。這份計畫的兩個 task 都還不會改到那個行為。

## 不在這份計畫

這些已經有結論，不要加任務：

- `docs/configuration.md` 的「When you do not need the whole team」和「What max_rounds limits」，以及中文的對應小節，已經寫好了。
- `done` 前由 dispatcher 跑測試、lint、型別檢查。dispatcher 用的是使用者權限，等於在沙箱外執行 agent 寫的程式。
- reviewer、debugger 的變更要不要整合。要先分開「不合進來」和「repo 唯讀」。現在的擋下流程會把 `completed` 改判成 `blocked`。
- token 或花費上限。adapter 讀不到輸入 token，也讀不到費用。
- 用程式硬性限制審查最多兩輪。
- 把「另一個 run 還活著」繼續當成共用檔的放行理由。這是現況，也是要修的洞，但修法不在這份。

## 檔案

- 新增 `docs/specs/26-cross-run-shared-writes.md`：只寫規格。
- 新增 `src/batch-failure.ts`：從 `settle` 抽出的純函式。
- 新增 `test/batch-failure.test.ts`。
- 修改 `src/run-session.ts`：`settle` 結尾改呼叫這個函式。行為與現在相同。

兩條互不依賴。Task 1 合併不必等 Task 2。

---

### Task 1：寫下共用檔的規格，不改程式

**檔案：**

- 新增：`docs/specs/26-cross-run-shared-writes.md`

**介面：**

- 使用：現況在 `src/guard.ts` 的 `check`（另一個 run 還活著就 `continue`）和 `checkRecords`（同樣放行）。測試現況的是 `test/guard-concurrent-runs.test.ts` 第一個案例：另一個 run 還活著時，`COMMON.md`、records、`AGENT.md` 的修改會留下。
- 提供：一份規格。它不匯出函式。後續實作必須同時滿足下面「必須同時成立」的兩句，並且不准用規格裡寫明禁止的修法。

- [ ] **步驟 1：新增規格檔，內容如下**

```markdown
# 26 兩個 run 同時跑時，共用檔是誰改的

狀態：規格。尚未選定做法，所以不准改 `src/guard.ts`。

## 現況

`COMMON.md`、`shared/common/records/`、各 agent 的 `AGENT.md` 是同一個專案的所有 run 共用的。`ProtectedGuard.check` 在另一個 run 的鎖還活著時，這些檔的變更不還原、不放進 `violations/`、也不寄信給 lead，並把變更收成新的基準。run log 記 `protected-change-unattributed`。

這樣做是為了不要把另一個 run 的 lead 合法寫入還原掉。副作用是：這一次被喚醒的人如果沒有權限卻改了同一個檔，也會一起留下。這段時間只剩作業系統的沙箱擋得住。沒有沙箱時，這個人的寫入會留下來。

`test/guard-concurrent-runs.test.ts` 鎖住的是現況，不是這份規格要的結果。

## 必須同時成立

1. 另一個 run 的 lead 有權改的共用檔，這個 run 的 guard 不能把它還原。
2. 這個 run 裡沒有權限的人改了共用檔，就算另一個 run 還活著，也要還原、把寫入留在 `violations/`、並通知這個 run 的 lead。

分不出是哪一種時，維持現況（留下、記 `protected-change-unattributed`）。不准為了分不出來就兩種都還原，也不准兩種都沉默留下卻不記 log。

## 禁止的修法

看到另一個 run 還活著，或看到另一個 run 的 lead 還活著，就把這一批的共用檔變更全部留下。這就是現在的程式。它守得住第 1 句，守不住第 2 句。

## 候選做法

兩種都還沒選。選定之前不准改 `src/guard.ts`。選定時要寫明：寫到一半當機，恢復後第 1 句和第 2 句還在不在。

1. **dispatcher 代寫。** agent 不直接改這些共用檔，只在信裡交出內容，由 dispatcher 套用並留下寫入者。agent 仍可能用 shell 直接改檔，所以這條還得靠沙箱擋住直接寫入。
2. **每個 run 一份複本，結束時才合併。** 衝突就擋下並通知 lead，不要自動覆蓋。兩個 lead 同時改同一檔會衝突，這個結果可以接受。

## 選定做法之後才做

- 改 `src/guard.ts`。
- 新增測試：另一個 run 還活著時，這個 run 沒有權限的成員改 `COMMON.md`，檔要被還原。既有「另一個 run 的修改要留下」的測試仍要通過；若兩種寫入在同一次檢查裡分不開，測試要寫明送進 guard 的資料裡哪一個欄位把他們分開。
- 同步 `docs/write-scope.md` 與 `docs/write-scope.zh-TW.md`。
```

- [ ] **步驟 2：確認沒有改到程式**

執行：`git diff --stat -- src test`

預期：沒有輸出。規格檔在 `docs/specs/`，不在這兩個目錄。

- [ ] **步驟 3：提交**

```bash
git add docs/specs/26-cross-run-shared-writes.md
git commit -m "$(cat <<'EOF'
docs: specify who may keep a shared-file edit across runs

EOF
)"
```

---

### Task 2：抽出「這一批誰失敗就停」

**檔案：**

- 新增：`src/batch-failure.ts`
- 新增：`test/batch-failure.test.ts`
- 修改：`src/run-session.ts`（`settle` 結尾，約 1070–1077 行）

**介面：**

- 使用：`src/run-store.ts` 的 `RunFailure`、`TriedModel`。`WakeOutcome` 今天是 `run-session.ts` 的內部型別 `{ ok: boolean; cancelled?: boolean; error?: string; attempts?: number; tried?: TriedModel[] }`，新檔自己宣告同一形狀，不要從 `run-session.ts` 回匯入。
- 提供：

```ts
export function batchFailure(
  batch: { name: string }[],
  results: { ok: boolean; cancelled?: boolean; error?: string; attempts?: number; tried?: TriedModel[] }[],
  lead: string,
  retry: number,
): { endReason: "lead_failed" | "agent_failed"; failure: RunFailure } | undefined;
```

規則與現在的 `settle` 相同：找第一個 `ok === false` 且沒有 `cancelled` 的結果。沒有就回 `undefined`。有的話，那個 agent 的名字等於 `lead` 時 `endReason` 是 `lead_failed`，否則是 `agent_failed`。`failure.attempts` 用結果裡的 `attempts`，沒有就用 `retry + 1`。有 `tried` 才放進 `failure`。`batch[failedIdx]` 不存在時，用 `must(..., "failed agent")` 丟出，跟現在一樣。

- [ ] **步驟 1：寫會失敗的測試**

```ts
import { describe, expect, it } from "vitest";
import { batchFailure } from "../src/batch-failure.js";

const agent = (name: string) => ({ name });

describe("batchFailure", () => {
  it("returns undefined when every result ok or cancelled", () => {
    expect(batchFailure([agent("lead"), agent("fe")], [{ ok: true }, { ok: false, cancelled: true }], "lead", 2)).toBeUndefined();
  });

  it("stops on the first real failure and counts a missing attempt number as retry + 1", () => {
    const got = batchFailure([agent("lead"), agent("fe")], [{ ok: true }, { ok: false, error: "boom" }], "lead", 2);
    expect(got).toEqual({ endReason: "agent_failed", failure: { agent: "fe", error: "boom", attempts: 3 } });
  });

  it("names a lead failure and keeps tried models", () => {
    const tried = [{ runtime: "claude-code" as const, model: "opus", kind: "rate_limit" as const }];
    const got = batchFailure([agent("lead")], [{ ok: false, error: "limited", attempts: 1, tried }], "lead", 2);
    expect(got?.endReason).toBe("lead_failed");
    expect(got?.failure.tried).toEqual(tried);
  });
});
```

`TriedModel` 的欄位若和上面的字面不合，以 `src/run-store.ts` 的型別為準，改測試資料，不要放寬函式。

- [ ] **步驟 2：執行，確認會失敗**

執行：`npx vitest run test/batch-failure.test.ts`

預期：FAIL，找不到 `../src/batch-failure.js`。

- [ ] **步驟 3：寫最小實作，並讓 settle 改呼叫它**

`src/batch-failure.ts`：

```ts
import { must } from "./assert.js";
import type { RunFailure, TriedModel } from "./run-store.js";

export function batchFailure(
  batch: { name: string }[],
  results: { ok: boolean; cancelled?: boolean; error?: string; attempts?: number; tried?: TriedModel[] }[],
  lead: string,
  retry: number,
): { endReason: "lead_failed" | "agent_failed"; failure: RunFailure } | undefined {
  const failedIdx = results.findIndex((r) => !r.ok && !r.cancelled);
  if (failedIdx < 0) return undefined;
  const failed = must(batch[failedIdx], "failed agent");
  const r = results[failedIdx];
  return {
    endReason: failed.name === lead ? "lead_failed" : "agent_failed",
    failure: { agent: failed.name, error: r?.error, attempts: r?.attempts ?? retry + 1, ...(r?.tried ? { tried: r.tried } : {}) },
  };
}
```

`settle` 結尾原本的 `findIndex` 到設定 `this.endReason` 那段，改成：

```ts
const stop = batchFailure(batch, results, project.lead, this.cfg.retry);
if (stop) {
  this.failure = stop.failure;
  state.failure = this.failure;
  this.endReason = stop.endReason;
  return;
}
```

不要改 `settle` 裡這段之前的流程。

- [ ] **步驟 4：執行，確認通過**

執行：`npx vitest run test/batch-failure.test.ts test/dispatcher.test.ts test/outcome.test.ts`

預期：PASS。

再執行：`npm test` 和 `npm run typecheck`

預期：都通過。

- [ ] **步驟 5：提交**

```bash
git add src/batch-failure.ts src/run-session.ts test/batch-failure.test.ts
git commit -m "$(cat <<'EOF'
refactor: decide batch failure outside RunSession

EOF
)"
```

## 這份做完才考慮

`wake` 和 `settle` 剩下的流程仍然長。下一刀還是只抽能單獨測的判斷，例如 `done` 契約要不要退回。不要把 `wake` 整段搬到新檔，再把 `RunSession` 的欄位整包傳進去。共用檔的程式要等 Task 1 的規格選定做法之後另開計畫。
