# 一次執行如何運作

1. 任務（文字，或 `--task-file` 的唯讀副本 `runs/<id>/task.md`）會成為寄給 lead 的第一封信。≤ 16 KB 的任務直接內嵌，更大的改以引用方式傳遞。超過 1 MB 的檔案會被拒絕。
2. dispatcher 用 `claude -p` 或 `codex exec`（headless）喚醒有未讀信件的 agent。除非設定 `resume: true`，否則每次喚醒都是全新的 session。
3. 每次喚醒的 prompt 都包含：該 agent 的 `AGENT.md`、團隊協定、`COMMON.md`（唯讀，≤ 8 KB）、每個記憶資料夾的 `MEMORY.md` 索引、**最舊**一封未讀信件全文（每次喚醒只處理一封；lead 例外，會一次拿到連續最多 5 封 `reply`/`failure` 並一併決策），以及排隊中信件的標題；排隊的信維持未讀，等各自的喚醒再處理。
4. agent 寄信的方式，是在**自己的** `outbox/` 寫一個含 frontmatter（`to`、`type`、`subject`）的 Markdown 檔。dispatcher 會檢查 `can_message`、蓋上真正的寄件者，並移到收件者的 `inbox/`。處理完的信件移至 `inbox/<agent>/read/`。信箱屬於單一 run（`runs/<run-id>/mail/`），信件不會跨 run。舊版本啟動的 run 繼續使用共用的 `shared/{inbox,outbox}/` 信箱（信件不會被搬移），接續這類 run 時會沿用舊版配置。
   每封 `task` 和 `reply` 的內文應包含固定的 `##` 標題（會注入每個 agent 的 prompt）：`task` → `Goal`、`Acceptance criteria`、`Scope`、`Upstream`；`reply` → `Changes`、`Verification`、`Open items`、`Risks`（沒內容就寫 `None`；`done` 免檢）。缺標題的信仍會送達，但開頭會加上警告說明，run log 也會記一筆 `format-warning`。
5. 結束條件：lead 寄出 `type: done`、所有信箱都空了，或（有設上限時）喚醒次數達到 `max_rounds`；預設 `0` 代表不限輪數。`done` 的 frontmatter 必須有 `outcome: completed|partial|blocked|failed`，內文要有 `## Result`、`## Files`、`## Verification`、`## Not done`；`completed` 還要求 `## Steps` 全部勾選。不符合的 `done` 會退回給 lead（最多兩次，之後以 `partial` 收下）。agent-lyceum 不會驗證 lead 回報的內容是否屬實。喚醒失敗最多重試 `retry` 次（預設 2，即最多呼叫 3 次）；仍然失敗就停止整個 run（成員失敗為 `agent_failed`，lead 失敗為 `lead_failed`），不會少了它繼續跑：它正在處理的那封信維持未讀，結束訊息會告訴你怎麼查原因與怎麼繼續（修正後 `agent-lyceum resume <run>`，或用 `clear` 放棄）。同一個寄件人寄給同一個收件人、type、reply_to 與內文（忽略空白差異）都相同的信不會再被投遞，並通知寄件人，避免兩個 agent 對著同一封信繞圈。

有待處理信件的成員會平行喚醒，沒有上限，且絕不與 lead 同時執行。它們在哪裡工作取決於資料夾；見[同時執行多個 task](#同時執行多個-task)。worktree 只隔離檔案，無法隔離對外部服務、資料庫或網路的副作用。

## 同時執行多個 task

並行不需要任何設定，同一專案可同時有任意多個 run，只要每個 run 都有自己的 worktree。新的 run（包括單獨的 `run --agent <name>`）怎麼做取決於資料夾：

- **有 commit 的 git repo（預設 `files` ref 儲存）：** **每個** run 都在自己的 git worktree 工作：lead 在 `projects/<name>/worktrees/<run-id>/<lead>`、branch 為 `agent-lyceum/<run-id>/<lead>`，每個成員的 worktree 從 lead 的內容分出。run 從你 repo 的 `HEAD` 起跑，所以允許你有未提交的修改，但這些修改**不會**在其中（啟動訊息會寫出有幾個檔案）。你的工作目錄、index 與 HEAD 一律不會被動到，結果也**不會**寫進你的工作目錄：請用 `git merge <branch>` 或 `open_pr` 取得。
- **非 git 資料夾、沒有 commit 的 repo，或使用 reftable 的 repo：** run 直接在該資料夾工作、一次只跑一個 agent，並以一行 info 說明原因，而不是報錯。同時只能有一個這樣的 run；再開第二個會被拒絕，並列出擋住的 run。有自己 worktree 的 run 可與它並存。
- **衝突：** 同一個 run 的兩個 agent 改了同一個檔案時，後到者的變更會被拒絕、它的 branch 保留，並通知 lead。不同檔案之間彼此不相容的修改不會被偵測到。

- **結束：** run 結束時（done、cancelled、failed、idle 或達到輪數上限），lead 的成果會一次提交在它的 branch 上，並寫成 `runs/<run-id>/lead.patch`，run 會印出 `git merge <branch>`。停下來向你提問（`waiting`）的 run 還沒結束：不會提交、也不會印 merge 提示；成果留在 lead 的 worktree，`resume` 會在同一個 worktree 繼續。
- **啟動時決定：** run 會在狀態中記錄 lead 是否在 worktree 工作（`lead_workspace`）。`resume` 沿用 run 啟動時的方式。舊版啟動、沒有這個欄位的 run：若是平行 run，接續時 lead 在資料夾、成員在 worktree、全部平行；否則直接在該資料夾工作。
- **`tidy`：** `tidy` 與 `tidy --undo` 需要獨占專案：有任何 run 在執行時會拒絕，執行期間也不能啟動任何 run。
- **`clear`：** lead 的 branch 尚未合併時，`clear <run-id>` 會拒絕（用 `--keep-worktrees` 可保留它）。當機 run 留下的鎖用 `clear --lock [run-id] [-p name] --force` 移除；有多把鎖時要指定是哪個 run。

已知限制：

- agent 程序數量沒有上限：每個執行中的 run 裡，有待處理信件的成員會同時被喚醒。
- `can_edit_agent_md: true` 的 lead 修改的是它自己 worktree 裡的 `CLAUDE.md`／`AGENTS.md`；這些修改要等你合併它的 branch 才會進到你的 repo。
- `COMMON.md` 與各 `AGENT.md` 由專案的所有 run 共用。每個 run 的防護只判斷它自己的 agent 工作期間發生的修改，所以某個 run 的修改會被保留；但若兩個 run 的喚醒時間重疊，一個 run 在另一個 run 的 agent 工作期間所做的修改，可能被另一個 run 還原。
- 兩個 run 修改同一個檔案時，要由你在合併時自行整合；agent-lyceum 從不自動合併。

## 接續已完成的 run

每個 run 都有**名稱**：由 task 第一行產生（小寫字母、數字與 `-`，最多 30 字元；沒有可用字元時用 `task`；重複時加 `-2`、`-3`），或用 `run --name <name>` 指定（字元與長度限制相同；名稱已被使用會拒絕）。`resume`、`clear` 與 `status --task-id` 接受完整 run id、名稱，或兩者之一的唯一前綴；前綴有歧義時會列出候選並以 `1` 結束，空字串會被拒絕。`status` 會在 id 旁顯示名稱。

已完成（`done`）的 run 可以用追加要求重開：`agent-lyceum resume [run] "<追加要求>"`（或 `--task-file f`）。lead 會把這段文字當成新的 `task` 收到，run 沿用同一個 run 目錄、任務記憶、session 與 lead 的 worktree 繼續。

- **哪些 run：** 只有已完成的 run 能重開。仍在執行的 run 會拒絕；尚未完成的 run 若帶文字也會拒絕（先不帶文字 resume 它）。不帶文字時行為不變：已完成的 run 只印出結果。沒指定 run 時，候選是已完成的 run，由新到舊：剛好一個就用它，沒有就報錯，有多個就列出（在終端機可用編號或名稱選；非互動環境則報錯並列出候選）。只有一個參數時，只有在它不可能是 run 參照（含空白，或含 run 名稱不能用的字元）才會被當成追加要求；單一個詞的追加要求要寫成 `resume <run> "<text>"` 或用 `--task-file`。
- **保留什麼：** 追加要求存成 `runs/<run-id>/followups/<n>.md`。每份 `done` 報告保留為 `done-<n>.md`，`result.md` 永遠是最新一份。`state.json` 新增 `name`、`reopened`、`round_floor`、`step_base`（都是選填，舊的 run 照樣能讀）。進度（`## Steps`）會接續：重開時的清單保留，lead 為追加要求列的步驟接在後面（再次列出的舊步驟只更新勾選狀態）；追加要求的 `completed` 只要求它自己的步驟全部勾選。未解決的 blocked integration 會保留；每段重開的 done 規範提醒重新計算。
- **輪數上限：** 有設 `max_rounds` 時，它從重開時起算：`rounds` 持續累加，上限是重開當下的輪數加 `max_rounds`。
- **lead 的 branch**（lead 有 worktree 的 run）：若該 branch 已合併進你的 `HEAD`，且 lead 的 worktree 乾淨、自 run 結束後沒被動過，worktree 與 branch（同名，`agent-lyceum/<run-id>/<lead>`）會從你目前的 `HEAD` 重新切出，並印一行說明。否則沿用原本的 worktree 與 branch。若已記錄 PR（`pr_url`）且 branch 沒有重切，新的 `open_pr: true` 只會 push（「pull request updated」），而且只在該 PR 仍開啟時；若它已被合併（含 squash merge）或關閉，就改開一個新的 PR；若 branch 重切了，已記錄的 `pr_url` 會被清掉（舊網址留在 run 的 notes），要求時再開一個新的 PR。agent-lyceum 仍然從不合併。
- **交接筆記：** lead 在送 `done` 之前，把追加要求會用到的內容寫進 agent-lyceum home 裡的 `task-memory/<run-id>/_shared/`（`MEMORY.md` 為索引）：做過的決定與理由、介面約定、目前狀態、剩下的事與下一步、踩過的坑。成員可讀不可寫（用 `run --agent` 啟動的 run 只有一個 agent，它就是自己的 lead，所以可寫；`call` 沒有這個資料夾）。run 重開後，每個 agent 的每次喚醒都在 prompt 裡拿到 `MEMORY.md`（前 8 KB，較長的索引會被截斷並標示），重開的 `task` 信的 `Upstream` 也會指向它；第一段的 prompt 不含它。若 lead 在該段沒有更動 `MEMORY.md` 就送出 `done`，run 不會被擋，只會在 run 的 notes 加一筆 `shared-not-updated`。`clear` 會連同任務記憶一併刪除；`tidy` 不會動它。只放這個 task 的筆記，跨 task 的教訓仍放 project 或 global memory。

## 開 PR

當你的 task 要求開 PR 時，lead 會在它的 `done` 報告的 frontmatter 加上 `open_pr: true`。如果 run 之後以 `completed` 結束，且 lead 的 branch 有變更，就由 agent-lyceum（不是 agent）把 `agent-lyceum/<run-id>/<lead>` 推到 `origin`，並對 repo 的預設分支執行 `gh pr create`，以 lead 的報告作為描述（結尾為 `🤖 Opened by agent-lyceum`）。run 的結果會印出 PR 網址，`state.json` 也會把它記為 `pr_url`。只有 lead 能提出要求：其他人都不能送出 `done`，也沒有任何 agent 的沙箱被放寬——`git push` 與 `gh` 在沙箱外以你自己的憑證執行。

- 它需要 lead 的 branch，所以只有在 run 有自己的 worktree 時（有 commit 的 git repo）才有作用。否則這個要求會被回報並略過。
- 無法照辦的要求（run 沒有完成、沒有變更、沒有 `gh`、沒有 `origin`、push 或 `gh` 失敗）絕不會改變 run 的結果。run 會說明沒有開的原因並保留 branch；push 或 `gh pr create` 失敗時，還會印出可手動完成的指令。
- 開 PR 會把 lead 的 branch 與報告發布到 `origin`。因此，提出要求（`open_pr: true`）的 agent 能把它在沙箱內讀得到的任何東西送上遠端，所以只有在可以接受這件事時，才在 task 裡要求開 PR。push 與 `gh pr create` 從你的主 repo 執行，絕不在 agent 的 worktree 裡執行，因為 agent 能寫入那個目錄。
- agent-lyceum 從不合併，也不等待 CI 或審查。在有 commit 的 git repo 裡，`doctor` 會告訴你有沒有 `gh` 與 `origin`（不會檢查 `gh` 是否已登入）。
