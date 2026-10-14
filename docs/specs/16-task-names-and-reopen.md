# 16 task 名稱與重開已完成的 run

狀態：草案（尚無 plan）。

## 16.1 問題

- run id 是 `20261007T082442893Z-<32 hex>`（`newRunId`），沒有人記得住，`resume`、`clear`、`status` 都要貼 id。
- 已 `done` 的 run 不能再繼續：`resume` 只印結果（`src/cli.ts` 的 `resume`）。實際上 done 之後常有後續（PR review 要改、驗收漏項、追加下一段），現在只能開新 run，丟掉 task memory、mail 歷史、lead 的 worktree 與分支。
- 目標：使用者要記的指令越少越好，不新增指令。

## 16.2 決議

| # | 決議 |
|---|---|
| 1 | 每個 run 有可讀名稱，存在 `state.json` 的 `name`（可省略，舊 run 沒有也可讀）。預設由 task 第一行取 slug（小寫、`-` 連接、最長 30 字元；取不出來用 `task`），同專案重複時加序號（`login-session`、`login-session-2`）。`run --name <name>` 可指定；指定的名稱重複時報錯，不自動加序號。run id 仍是內部識別，不改。 |
| 2 | 凡是接受 `<run-id>` 的地方（`resume`、`clear`、`status`）都接受三種寫法：完整 id、名稱、名稱或 id 的唯一前綴。有歧義時列出候選並結束（exit 1），不猜。 |
| 3 | 不新增指令。重開 done 的 run 用既有的 `resume`：`resume [name\|id] "追加要求"`（也可 `--task-file`）。沒有文字時行為不變（接續中斷／失敗／waiting 的 run；done 的只印結果）。 |
| 4 | 給了文字但沒給 run：選「最新的 run」（含 done）；同專案有多個 run 在 `max_concurrent_runs` 內活躍或候選不唯一時，互動環境用選項加自由輸入列出（名稱、狀態、task 第一行），非互動環境報錯並列出候選。 |
| 5 | 重開：追加文字成為寄給 lead 的新 `task` mail（`Goal` 為追加內容，`Upstream` 指向前一次 `done` 的存檔），run 的 `end_reason`／`ended_at` 清除，重新取得專案 lock。run 仍活著時拒絕。 |
| 6 | 保留：同一個 run 目錄、各 agent 的 task memory、session（`resume: true` 的）、lead 的 worktree 與分支、`task.md`（原任務不改）。追加內容另存 `runs/<run-id>/followups/<n>.md`。 |
| 7 | 每次 `done` 存成 `runs/<run-id>/done-<n>.md`，`result.md` 指向最新一份；`state.json` 加 `reopened: [{at, name?}]`（只記時間，不存追加全文）。 |
| 8 | `max_rounds` 對每次重開重新計算（`rounds` 繼續累加，上限為「重開當下的 rounds + max_rounds」），否則追加幾次就撞牆。 |
| 9 | lead 分支已 merge 進使用者的分支：不拒絕、不詢問，從目前 `HEAD` 重新建立 lead 分支與 worktree，輸出一行說明。分支未 merge：沿用原分支，之後的 commit 接在同一條上（已開的 PR 自然更新）。 |
| 10 | `open_pr: true` 對重開的 run 同樣有效：分支已有 PR 時只 push 更新，不重複開（`state.json` 已有 `pr_url` 即視為已開），訊息印出既有網址。 |
| 11 | `status`、`clear`、run 結束訊息、`git merge` 提示優先顯示名稱；lead 分支名維持 `agent-lyceum/<run-id>/<lead>`（不含名稱，避免改動 15 號 spec 的 git 隔離假設），另在結果訊息同列名稱。 |

## 16.3 與其他 spec 的關係

- 07：重開使用 lead worktree 與結束時提交；`clear` 對未 merge 分支的保護不變。
- 09：`resume --answer` 不變；重開與「回答問題」是兩條不同路徑，互斥（waiting 的 run 先回答）。
- 12：延續「收掉子指令、少記指令」的方向。
- 14：`pr_url` 已存在時的行為見決議 10。
- 17：重開時 lead 的交接 `shared/MEMORY.md` 放進各 agent 的 prompt。

## 16.4 影響的檔案

- `src/run-store.ts`：`name`、`reopened` 欄位（可省略）；名稱 slug 與唯一化；依 id／名稱／前綴解析 run 的函式。
- `src/cli.ts`：`run --name`；`resume` 接受文字與名稱；`clear`、`status` 的 run 參數改用解析函式。
- `src/run-session.ts`：重開流程（寄 task mail、清 end 狀態、`done-<n>.md`、`max_rounds` 重算）。
- `src/workspace`／lead worktree 相關：已 merge 分支的重切。
- `src/status.ts`、`src/format.ts`：顯示名稱。
- `README.md`、`README.zh-TW.md`、`docs/commands.md`（含 zh-TW）。

## 16.5 驗收

先寫失敗測試再實作：

1. 新 run 自動有名稱；同 task 第二次得到 `-2`；`--name` 重複時報錯。
2. `resume`、`clear`、`status` 用完整 id、名稱、唯一前綴都指到同一個 run；有歧義時列出候選並 exit 1。
3. done 的 run 執行 `resume <name> "追加"`：lead 收到新 task mail、run 重開、task memory 與 worktree 仍在；沒有文字時仍只印結果。
4. 不給 run 只給文字：選最新 run；多候選時互動環境列選項，非互動環境報錯。
5. 重開後 `max_rounds` 重新計算；`done-1.md`、`done-2.md` 都在，`result.md` 指向最新。
6. 分支已 merge 時重開會從目前 `HEAD` 重切並說明；未 merge 時沿用原分支。
7. 已有 `pr_url` 的 run 重開後 `open_pr: true`：只 push，不再呼叫 `gh pr create`。
8. 舊 run（沒有 `name`）可讀、可用 id 操作；run 仍活著時重開被拒。

## 16.6 範圍外

跨專案的 run 名稱、改名指令、自動 merge、多個 lead 分支並存。
