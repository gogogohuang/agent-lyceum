# 02 安全與保護機制

狀態：已實作並提交於分支 `chore/02-safety-guard`（PR #40）。

## 問題

`src/guard.ts` 的 `ProtectedGuard.check()` 發現未授權修改時，直接用基準內容覆寫（`restored`）或刪除（`removed`）。被丟掉的內容沒有留存：

- 若修改其實有價值（例如 agent 想改 `COMMON.md` 修一個錯字），lead 只收到「已還原」，無法取回。
- 事後稽核無法確認 agent 實際寫了什麼。

另外 `ProtectedGuard.saveSnapshot` 只存「基準」，沒有存「違規版本」。

## 目標

違規內容在還原前先留存，且可從 run 目錄與 lead 的通知找到。

## 需求

1. 還原或刪除前，把違規版本寫入 `runs/<run-id>/violations/<序號>-<安全檔名>`（沿用 `saveSnapshot` 的檔名清理規則）。檔案被刪除（`before === null` 的反向情況不需處理；`now === null` 時記錄為「被刪除」而不寫檔）。
2. `Violation` 型別新增 `saved?: string`（留存路徑）與 `sha256`（違規內容雜湊）。
3. 寫入 `log.jsonl` 的 `violation` 事件包含 `saved` 與 `sha256`。
4. 傳給 lead 的 failure 訊息（`dispatcher.ts` 的 `settle`）附上留存路徑，並說明「如需採用，請在授權的 agent 內重做」。
5. `guard.check` 的簽章不變（仍回傳 `Violation[]`），以免影響呼叫端；留存目錄由 `ProtectedGuard` 建構時或新方法 `setViolationDir(dir)` 提供。
6. `clear` 會一併刪除 `violations/`（它在 run 目錄內，確認 `RUN_ENTRIES` 清單 `src/policy.ts:54` 與 `run-cleanup.ts` 的刪除範圍涵蓋它）。

## 驗收

- 新測試：agent 修改 `AGENT.md` → 檔案被還原、`violations/` 內有違規版本、其 sha256 與記錄相符。
- 新測試：違規檔被刪除 → 還原且事件標明「被刪除」。
- 授權 agent 修改（`mayEditProtected`）不產生留存。
- 既有 guard 測試不變。

## 風險與備註

- 違規內容可能含敏感資料；它位於 agent-lyceum home 之下，與 log 同等級，不另做處理，但在 README 的 `clear` 說明中註明會一併刪除。
- 不新增上限以外的行為：單檔超過 1 MiB 時只留存前 1 MiB 並標記 `truncated`。
