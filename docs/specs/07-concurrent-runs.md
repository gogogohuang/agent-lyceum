# 07 同一專案同時跑多個 task

狀態：設計已與使用者逐題確認（grilling），尚未實作。

## 7.1 問題

- `src/project-lock.ts` 的 `lock.json` 放在專案根目錄，整個專案只有一把鎖；`takeLock`（`src/cli.ts`）取不到就報 "Only one run per project at a time"。
- 資料本來就按 run 隔離：信箱在 `runs/<run-id>/mail/`、task memory 在 `task-memory/<run-id>/`、agent worktree 在 `worktrees/<run-id>/<agent>`。
- 真正無法併發的原因是 repo：lead 在單 agent 模式直接改使用者的 working tree，兩個 run 會互相覆蓋。

## 7.2 決議

| # | 決議 |
|---|---|
| 1 | 新設定 `dispatcher.max_concurrent_runs`，預設 `1`（行為與現在相同）。`> 1` 時**所有** run 強制 `workspace_mode: worktree`，不看當下有幾個 run 在跑。`validate` 擋掉 `workspace_mode: shared` 與它並用。 |
| 2 | `> 1` 時 `project.dir` 必須是 git repo，否則 `validate` 報錯並指向設成 `1`。 |
| 3 | 新 run 的起點固定為 `HEAD`（快照 `refs/agent-lyceum/<run-id>/base-0`），**允許**未提交改動；啟動時印出起點 sha 與未提交檔案數的警告。task 不碰使用者的 working tree。 |
| 4 | 鎖改為 per-run：`locks/<run-id>.json`，格式、heartbeat、pid 加 start-time 判斷、reclaim mutex 不變。同一 run 不可被同時 `resume` 兩次，不同 run 可併行，總數受 `max_concurrent_runs` 限制。 |
| 5 | 相容舊版：專案層 `lock.json` 持有者仍存活時，視為一個存活的 run，計入併發數；持有者已死則依 `unlock` 規則處理。 |
| 6 | lead 在 `worktrees/<run-id>/lead` 工作，分支 `agent-lyceum/<run-id>/lead`。非 lead agent 的 worktree 從 lead 分支分出，完成後合回 lead 的 worktree（不是使用者的 repo）。 |
| 7 | run 結束時（任何 `end_reason`）在 lead 分支提交一次，身分沿用 `agent-lyceum <agent-lyceum@localhost>`，訊息含 run id 與任務摘要。**不自動合併**；結果訊息印出 `git merge agent-lyceum/<run-id>/lead`，patch 檔仍保留。 |
| 8 | `clear <run-id>`：lead 分支尚未合入 `HEAD` 時拒絕；`--keep-worktrees` 可保留分支並清除其餘。已合入才刪分支。 |
| 9 | 不帶 id 的指令：`resume` 選最新、未完成且沒在跑的 run；`unlock --force` 只有一把鎖時移除它，多把時列出並要求指定 run id，不猜；`status` 列出全部執行中的 run。 |
| 10 | 不加全域資源上限。實際 CLI 程序數為 `max_concurrent_runs × max_parallel`，文件要註明。 |

## 7.3 影響的檔案

- `src/project-lock.ts`：per-run 鎖路徑、`listRunLocks(root)`、舊 `lock.json` 相容、`forceUnlock(root, runId?)`。
- `src/schema.ts`、`src/config.ts`、`src/validate.ts`：`max_concurrent_runs` 欄位、預設值、規則 1、2。
- `src/cli.ts`：`takeLock` 檢查併發數；`unlock [run-id]`；`resume`、`clear` 只看該 run 的鎖。
- `src/worktree.ts`、`src/run-session.ts`：lead worktree、起點快照改為 HEAD、agent worktree 分出自 lead 分支、run 結束提交。
- `src/run-cleanup.ts`：分支是否已合入 `HEAD` 的判斷。
- `src/status.ts`、`src/doctor.ts`：`runIsAlive` 查該 run 自己的鎖；列出所有鎖；`doctor` 說明起點為 HEAD。
- `README.md`、`README.zh-TW.md`、`docs/commands.md`（含 zh-TW）：新設定、`unlock [run-id]`、乘數說明。
- status-monitor 已是一個執行中 task 一個分頁，預期不用改，實作時以測試確認。

## 7.4 驗收

先寫失敗測試再實作：

1. 兩個不同 run 同時取鎖成功；同一 run 重複取鎖失敗；超過 `max_concurrent_runs` 被拒並列出執行中的 run id。
2. 舊 `lock.json`（持有者存活）計入併發數；持有者已死不阻擋。
3. `validate`：`shared` + `max_concurrent_runs > 1` 報錯；非 git repo + `> 1` 報錯。
4. 起點為 `HEAD`：working tree 有未提交檔案時仍可啟動，且 task 看不到它們、警告有印出。
5. run 結束後 lead 分支有 commit；使用者的 working tree 與 HEAD 未被改動。
6. `clear`：分支未合入 HEAD 拒絕；`--keep-worktrees` 保留分支；已合入則刪除；只動目標 run 的 worktree。
7. `unlock --force`：單鎖移除；多鎖不帶 id 拒絕並列出。
8. 整合測試：用 `test/fixtures/runtime/fake-claude.mjs` 同時跑兩個 task，各在自己的 worktree，互不污染，working tree 不變。
9. `max_concurrent_runs` 未設時，既有全部測試行為不變。

## 7.5 範圍外

自動合併、跨 run 的檔案衝突偵測、全域排程器、同一 run 跨機器執行。
