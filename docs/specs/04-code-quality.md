# 04 程式品質與維護性

狀態：已實作並提交於分支 `chore/04a-ts-lint、chore/04b-run-session`（PR #40）。

分兩階段，先低風險的設定收緊，再做重構。

## 4.1 TypeScript 與 lint 設定（先做）

**問題**
- `tsconfig.json` 只開 `strict`。`dispatcher.ts` 有許多 `results[leadIdx].ok`、`route.done!`、`contract!.outcome!` 這類在型別上不安全的存取。
- 沒有 ESLint / Prettier / Biome 設定，風格一致性只靠人工。

**需求**
1. `tsconfig.json` 逐項啟用並修正，每項各一個 commit：
   - `noImplicitOverride`
   - `noUnusedLocals`、`noUnusedParameters`
   - `noUncheckedIndexedAccess`（預期修改最多）
2. 新增 lint（二選一，建議 Biome，單一依賴、含 format；若團隊偏好 ESLint 則用 `typescript-eslint`）：
   - 必開規則：不得有未處理的 Promise（`noFloatingPromises` / `no-floating-promises`）、未使用的 import、`no-explicit-any`。
   - 不得為了通過 lint 做大範圍重新排版：先以現有風格為準設定 formatter，第一次 format 的 diff 單獨成一個 commit，且 `git blame` 忽略清單（`.git-blame-ignore-revs`）記錄它。
3. `package.json` 新增 `lint` script，CI 在 `typecheck` 之前執行。

**驗收**
- `npm run typecheck`、`npm run lint`、`npm test` 全過。
- 不改變任何執行期行為（diff 內不得有邏輯變更，只有型別收窄、非空斷言改為明確檢查）。

## 4.2 拆分 `runTeam`（之後再做）

**問題**
`src/dispatcher.ts` 的 `runTeam` 約 440 行，`wake`、`settle`、`integrateMember` 等閉包共用十餘個可變區域變數（`claims`、`attempts`、`batchSpaces`、`endReason`、`pendingDoneFile`、`doneOutcome`…）。結果：
- `settle` 無法單獨測試，只能走整合測試。
- 狀態轉移（done 驗收、integration 阻擋 completed、lead 失敗）散在閉包與迴圈尾端。

**需求**
1. 把閉包變數收進 `RunSession` class（欄位），`wake`、`settle`、`integrateMember`、`pickBatch`、`pendingAgents` 變成方法。`runTeam` 只負責建立 session、恢復（resume）、跑迴圈與收尾。
2. 把「done 報告 → outcome」的判斷（`dispatcher.ts` 約 373–391 行：契約檢查、`completed` 遇未整合工作降為 `blocked`）抽成純函式 `resolveDoneOutcome(contract, blockedIntegrations, rejections)`，並加單元測試。
3. 同樣把結尾的 `outcome` / `outcomeNote` 三元運算抽成 `endOutcome(endReason, ...)` 純函式。
4. 對外 API 不變：`runTeam` 簽章、`RunSummary`、`export` 的型別與常數維持原樣。

**前置條件**
- 4.1 完成。
- 現有 `dispatcher.test.ts`、`integration.test.ts`、`run-lifecycle.test.ts` 全綠，作為重構的安全網；重構期間不修改這些測試（若必須修改，代表行為變了，應停下來檢討）。

**驗收**
- 重構前後 `test/` 無需改動即全數通過。
- 新增的純函式有針對每個分支的測試。
- `dispatcher.ts` 單一函式不超過約 80 行。

## 4.3 其他小項

- `dispatcher.ts` 第 8、14 行的 import 超長，改成多行（lint format 會自動處理）。
- `retryPrompt(prompt, attempt, error)` 的 `attempt` 參數未使用，隨 4.1 的 `noUnusedParameters` 一起清掉。
