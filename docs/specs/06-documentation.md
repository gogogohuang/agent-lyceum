# 06 文件

狀態：已實作並提交於分支 `chore/06-documentation`（PR #40）。

## 問題

1. `docs/plans/2026-10-06-agent-lyceum-improvements.md` 開頭寫「此階段僅建立文件，尚未實作或驗證下列功能」，但功能已實作並發佈（0.4.x），讀者會誤判專案狀態。
2. `README.md` 的指令表格中，`resume`、`status`、`clear`、`doctor` 單一儲存格長達數行到十行，難以閱讀，也難以維護中英兩版同步。
3. 中英文 README 各自維護，沒有機制確認兩者一致。

## 需求

1. 更新計畫文件開頭：把狀態改為「已實作（0.4.x）」，保留原文作為設計紀錄，並連到 `docs/upgrading-run-v2.md`。不改動規格內文。
2. 新增 `docs/commands.md`（與 `docs/commands.zh-TW.md`），每個指令一節：用途、參數、行為、退出碼、範例。README 的表格每列縮成一句話並連結到對應章節。退出碼的完整說明只留一份（commands 文件），README 只放摘要。
3. 新增 `docs/specs/README.md` 所列 spec 完成後，在各 spec 檔頭加 `狀態：已完成（PR #…）`；不要刪除。
4. 在 CI 加一個輕量檢查（shell 即可）：`README.md` 與 `README.zh-TW.md` 的二級標題數量與順序相同，不一致就失敗。不要求內容逐字對應。

## 驗收

- README 表格每個儲存格不超過兩行。
- 所有 README 內連結（相對路徑）有效；用 `grep` 檢查目標檔案存在即可。
- 標題一致性檢查在故意改壞其中一份時會失敗。

## 不做

- 不改變任何指令行為，也不改寫既有說明內容，只搬移與縮短。
