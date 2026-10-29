# 一次執行如何運作

1. 任務（文字，或 `--task-file` 的唯讀副本 `runs/<id>/task.md`）會成為寄給 lead 的第一封信。≤ 16 KB 的任務直接內嵌，更大的改以引用方式傳遞。超過 1 MB 的檔案會被拒絕。
2. dispatcher 用 `claude -p` 或 `codex exec`（headless）喚醒有未讀信件的 agent。除非設定 `resume: true`，否則每次喚醒都是全新的 session。
3. 每次喚醒的 prompt 都包含：該 agent 的 `AGENT.md`、團隊協定、`COMMON.md`（唯讀，≤ 8 KB）、專案紀錄（見下）、每個記憶資料夾的 `MEMORY.md` 索引、**最舊**一封未讀信件（內文在下述預算內；每次喚醒只處理一封；lead 例外，會一次拿到所有已在等待、內文還放得進 64 KiB 預算的 `reply`/`failure`（最多 20 封），下一封若一點內文都放不進就留著未讀；其他 agent 則會一次拿到同一討論串連續最多 5 封 `reply`/`failure`，並一併決策），以及排隊中信件的標題；排隊的信維持未讀，等各自的喚醒再處理。放進 prompt 的信件內文每封最多 16 KiB，同一次喚醒的信合計最多 64 KiB（header 與截斷標記不計入）；內文超過時會在 UTF-8 字元邊界截斷，並附上原檔路徑。信件檔本身不變。
   **專案紀錄：**lead 把每個決策或教訓各寫成一個檔：`shared/common/records/decisions/<id>.md` 或 `records/lessons/<id>.md`（`id` ＝不含 `.md` 的檔名：小寫字母、數字、`-`）。Frontmatter：`status: active|superseded`（必填）、`date: YYYY-MM-DD`（必填）、`title`（必填）、`run` 與 `supersedes`（選填；`supersedes` 列出同類別的 id）；內文是決策或教訓與原因。只有 lead 能寫紀錄（可改 `status`）；其他 agent 的改動會被還原並記為違規；但若同專案另一個 run 仍存活，該改動無法歸屬，會保留並只記入日誌（見[寫入範圍](write-scope.zh-TW.md)）。每個決策或教訓各是一個檔，所以同時執行的 run 若新增 id 不同的條目，不會改到同一個檔；兩個 run 改同一個條目仍可能衝突。prompt 只顯示有效的 active 條目（`status: active` 且未被其他條目的 `supersedes` 指名），依日期、再依 id 由新到舊，只放完整條目，每類約 6 KB；放不下的條目每個一行，附路徑，需要時再讀。沒有條目就不顯示。某類別有效 active 條目超過 6 KB 時，lead 的 `done` 會被拒絕；把條目標為 `superseded` 或合併即可。`records/.archive/` 放 `tidy` 的輸出，不會顯示。
4. agent 寄信的方式，是在**自己的** `outbox/` 寫一個含 frontmatter（`to`、`type`、`subject`）的 Markdown 檔。dispatcher 會檢查 `can_message`、蓋上真正的寄件者，並移到收件者的 `inbox/`。處理完的信件移至 `inbox/<agent>/read/`。信箱屬於單一 run（`runs/<run-id>/mail/`），信件不會跨 run。舊版本啟動的 run 繼續使用共用的 `shared/{inbox,outbox}/` 信箱（信件不會被搬移），接續這類 run 時會沿用舊版配置。
   每封 `task` 和 `reply` 的內文應包含固定的 `##` 標題（會注入每個 agent 的 prompt）：`task` → `Goal`、`Acceptance criteria`、`Scope`、`Upstream`；`reply` → `Changes`、`Verification`、`Open items`、`Risks`（沒內容就寫 `None`；`done` 免檢）。缺標題的 `task` 或 `reply` 會退回給寄件人，並以 `failure` 信列出缺少的標題；同一 run 內同一寄件人、type 與主旨最多退回兩次，之後仍會送達，但開頭會加上警告說明，run log 也會記一筆 `format-warning`。舊版配置的 run 一律直接送達並附警告。
5. 結束條件：lead 寄出 `type: done`、所有信箱都空了，或（有設上限時）喚醒次數達到 `max_rounds`；預設 `0` 代表不限輪數。`done` 的 frontmatter 必須有 `outcome: completed|partial|blocked|failed`，內文要有 `## Result`、`## Files`、`## Verification`、`## Not done`；`completed` 還要求 `## Steps` 全部勾選。不符合的 `done` 會退回給 lead（最多兩次，之後以 `partial` 收下）。agent-lyceum 不會驗證 lead 回報的內容是否屬實。喚醒失敗最多重試 `retry` 次（預設 2，即最多呼叫 3 次）；仍然失敗就停止整個 run（成員失敗為 `agent_failed`，lead 失敗為 `lead_failed`），不會少了它繼續跑：它正在處理的那封信維持未讀，結束訊息會告訴你怎麼查原因與怎麼繼續（修正後 `agent-lyceum resume <run>`，或用 `clear` 放棄）。agent 為同一封信再次被喚醒時（重試，或 `resume` 後重做），prompt 會帶 Retry 或 Redo 提示；若上一次嘗試在 `outbox/` 留下尚未投遞的草稿，也會一併交還：只給同一個 agent、標為未驗證、最多 4 KB、不會被投遞。prompt 也會要求 agent 先讀自己的 task memory。這些都是 prompt 要求，模型是否照做尚未用真實 runtime 驗證。同一個寄件人寄給同一個收件人、type、reply_to 與內文（忽略空白差異）都相同的信不會再被投遞，並通知寄件人，避免兩個 agent 對著同一封信繞圈。

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
- `COMMON.md` 與各 `AGENT.md` 由專案的所有 run 共用。每個 run 的防護只判斷它自己的 agent 工作期間發生的修改，所以某個 run 的修改會被保留。若該批喚醒期間同專案另一個 run 仍存活，且該批沒有任何 agent 可編輯該檔案，guard 不會還原這項變更（無法歸屬），改記 `protected-change-unattributed`；見[寫入範圍](write-scope.zh-TW.md)。
- 兩個 run 修改同一個檔案時，要由你在合併時自行整合；agent-lyceum 從不自動合併。

## 同一成員的平行實例

lead 可以讓一位成員同時處理幾個互不相依的 task：該成員會有額外的**實例**，各自在自己的 worktree 工作。由 lead 決定；dispatcher 不判斷 task 之間是否相依。（規格 23.1、23.3）

- **限制：** 只在 worktree 模式（有 commit 的 git repo；否則成員一次只做一件事，旗標會被忽略並留下一條備註）。只有成員能有實例，lead 不行，solo 的 `run --agent` 也不行。每位成員最多 `dispatcher.max_instances` 個實例（1–8，預設 4；見[設定](configuration.zh-TW.md#平行實例)）。（23.4）
- **命名：** 實例 1 就是成員本名（`frontend`），其餘為 `frontend--2`、`frontend--3`……各自有信箱、worktree、branch（`agent-lyceum/<run>/frontend--2`）與 task memory。lead 看到的寄件人是 `frontend--2 (frontend, instance 2)`。實例不能寄信給同角色的另一個實例。（23.5、23.7.1、23.12）
- **標記平行：** lead 在**新的** `task`（沒有 `reply_to`、沒有 `thread`）的 frontmatter 寫 `parallel: true`，對每位收件人分別判斷。非 lead 寄的（成員的信不論值是什麼，包括非布林值，都忽略此欄位）、回信或非 task 信、或收件成員上限只有 1 時，旗標會被忽略：信當一般信投遞並留下備註。`parallel: false` 等於沒寫。lead 的信若值不是 YAML 布林，信會像格式錯誤的信一樣被退回。旗標記在 dispatcher 的 journal，不在投遞出去的信裡。（23.3）
- **保留佇列與指派：** 成員在 run 裡第一次被平行使用之後，寄給它（成員本名或它的實例）的信都先放在 `inbox/<member>/pending/`，由 dispatcher 在每批喚醒前指派。規則順序：修訂回到原本的負責實例；直接寫明某實例的新 task 送到該實例；平行 task 送給編號最小的空閒實例，若上限與冷卻允許就開新實例；其他新 task 送給實例 1。每次決定都先寫進 journal 才搬信，所以當機後重播會回到同一個實例。平行 task 遇到所有實例都忙時留在佇列（`status --json` 顯示 `held: true`）；同一目的地的 task 維持先後順序。（23.6、23.7.2）
- **親和性：** 帶 `reply_to` 或 `thread` 且指向先前工作的信，會回到做那份工作的實例，即使它忙碌、被擋住或超過調低後的上限。成員第一次被平行使用之前做的工作屬於實例 1。（23.7.2）
- **被擋住的實例：** 實例的工作被擋住時（整合失敗，見[衝突](#同時執行多個-task)），在那份工作進入 repo 之前它不接受任何新 thread，直接寫它名字的也不行。新 thread 留在佇列，只有回信能到它那裡。要重做或調整，請回覆關於它的 failure 信（或該實例最後一封信）。（23.9）
- **卡住通知：** 沒有任何東西在跑、卻還有 task 在等時，lead 會收到一封 `failure` 信，逐項列出等待中的 task、目的地與原因。若只剩 rate-limit 冷卻在等，run 會暫停到最早的冷卻結束再開實例。同一組等待中的 task 只通知一次。（23.9）
- **冷卻：** 成員的主要模型因 `rate_limit`／`quota` 冷卻中時不開新實例（見[喚醒失敗時](#喚醒失敗時)）；可能只啟動較少實例，有實例空出來時等待中的 task 才會跑。（23.7.2、23.9）
- **調低上限或 resume：** 已開的實例繼續處理自己的信箱與修訂；超過調低後上限的實例不接新 thread。實例已無法綁定時 `resume` 會拒絕（角色已不在 `project.yaml` 或變成 lead、實例名稱現在是設定中的 agent，或[寫入範圍](write-scope.zh-TW.md#平行實例的共用記憶)的共用記憶檢查不通過）。（23.10）
- **當機安全：** 啟用、開實例與指派都在生效前先寫下，當機或 `resume` 後重播得到相同結果。投遞 journal 最後一行被寫斷時，下一次寫入會補上換行；這對所有 run 都適用，只在 journal 本來就已損壞時才改變行為。（23.8、23.8.1）
- **衝突不會自動合併：** 各實例在各自的 worktree 改檔；兩個實例改同一個檔案，處理方式與兩個 agent 相同（後到者的變更被拒絕並通知 lead）。所以要告訴 lead 讓平行 task 的檔案互不重疊，見[設定](configuration.zh-TW.md#lead-agentmd-平行-task-指引)的指引。（23.12）

從不使用 `parallel: true` 的 run，檔案與狀態和以前相同，唯一差別是功能可用時 lead 的系統提示會多一段 `## Parallel tasks`。（23.12、23.16）

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

## 喚醒失敗時

一次喚醒只有一個候選模型時（沒有 `fallback` 備援鏈，見[備援模型](configuration.zh-TW.md#備援模型)，這次喚醒也沒有比上限便宜的 tier 模型），喚醒失敗不論原因，都在同一個模型上重試最多 `retry` 次，之後停止 run，這部分不變。有多個候選（有備援鏈，或有低於上限的 tier 模型）時，會先為失敗分類：

| 種類 | 處理 |
|---|---|
| `rate_limit`、`quota` | 不重試：立刻改用下一個模型，並把失敗的模型標為冷卻中。 |
| `timeout`、`network`、`crash` | 在同一個模型上重試最多 `retry` 次，之後才切換。 |
| `auth` | 停止。登入問題不會因為換模型而被掩蓋。 |
| `unknown`（認不出的錯誤） | 在同一個模型上重試 `retry` 次，之後停止，不切換。 |

細節：

- **Backoff：** 只有在候選模型多於一個時（較便宜的 tier 模型或 `fallback` 鏈；見 [Model tiers per task](#每個-task-的模型分級)），同一個模型上的重試才會等待：5 秒、15 秒、45 秒，上限 60 秒。只有一個候選就不等。
- **全新 session：** 切換後在備用模型上開新的 session，prompt 附上一般的重試提示，未讀信件照常重新送達；失敗那次嘗試未投遞的 outbox 草稿會以未驗證草稿的形式交還給同一個 agent（見上），除此之外失敗模型的輸出不會帶過去。若備用模型已有自己的 session 且該 agent 設了 `resume: true`，切換會接續那個 session，而不是開新的。備用模型的 session 存在 `state.sessions` 的 `<agent>@<runtime>/<model>` 下；主要模型沿用 agent 名稱這個 key，備用模型不會拿到它的 id。
- **候選順序是 tier 模型 → 上限 → 設定的 fallback。** 喚醒從第一個不在冷卻的候選開始（沒有 tier 時就是主要模型）。（Spec 24.13 R-3）
- **冷卻：**因 `rate_limit` 或 `quota` 失敗的模型，在 `fallback_cooldown_sec`（預設 300 秒）內會被這次 run 的所有喚醒略過，包括平行的喚醒。冷卻存在 `state.json`，所以 `resume` 會保留；新的 run 則從零開始。若備援鏈上每個模型都在冷卻，就整條鏈都試。喚醒開始時在冷卻中的模型不會被永久排除：若原本可用的模型都失敗，喚醒會等最近一個冷卻結束（最久 `fallback_cooldown_sec`）再最後試那個模型，而不是讓 run 失敗。等待會記錄為 `cooldown_wait` 事件。只有存在較便宜的 tier 候選或備援鏈時才會記錄冷卻。
- **切換會被告知：** 切換時印出一行 `<agent> falling back to <runtime>/<model> (<kind>)`，並在 run 的 notes 加一筆，提醒失敗模型已產生的副作用沒有被還原、可能已經發生。
- **全部失敗時** run 照舊以 `agent_failed` 或 `lead_failed` 停止。`failure.tried` 依序列出每個模型各一筆（取該模型最後一次的失敗），結束訊息會逐一列出，並仍然說明如何 `resume`。
- **已知限制：** Codex 在網路斷線時會一直重連，直到喚醒逾時，所以結果是 `timeout` 而不是 `network`。它與其他逾時同樣處理：先重試，再切換。

## 每個 task 的模型分級

設了 `model_tiers` 階梯（見[設定](configuration.zh-TW.md#模型分級)）後，lead 可以讓某個 task 用成員 runtime 上較便宜的模型執行；成員的 `model` 仍是上限。沒有階梯、或沒寫 `tier`，喚醒與先前完全相同。（spec 24.1）

- **標記 task：** lead 在 `task` 的 frontmatter 寫 `tier: low`、`tier: mid` 或 `tier: high`（新 thread 或後續 task 皆可），可與 `parallel: true` 並用。只有 lead 寄出的 `task` 會被採用（以 outbox 擁有者判定寄件人）。值不是這三者時，整封退回，與格式錯誤的信相同。其他情況（成員寄的信、非 task 的信、收件者沒有可降的 tier）信照常投遞但不帶 tier，原因記為 log 事件 `tier_ignored`（`{from, id, to, reason}`，reason 為 `not-lead`、`not-a-task` 或 `no-tiers`）。只有 `not-lead` 與 `not-a-task` 會在 run 的 notes 加一筆，每個寄件人與原因只一次；`no-tiers` 只寫 log。（24.5.1、24.5.2）
- **作用範圍：** tier 只作用於處理那封信的那次喚醒，含其重試與 `resume` 後的重做。同 thread 之後的 reply 與 failure 用上限，所以 lead 要在每個後續 task 再寫一次 `tier`。（24.5.3）
- **批次喚醒：** 一次喚醒處理多封信時，每封都有有效 tier 才降級，並取最高；任一封沒有就用上限。（D-07、24.5.3）
- **嘗試的模型：** 先降級模型，再上限，再 `fallback` 鏈。降級模型遇 `rate_limit`／`quota` 會進冷卻並改用上限；`timeout`／`network`／`crash` 先重試；`auth` 立即停止；`unknown` 在同一模型重試後停止（`src/fallback.ts`）。候選清單只建一次，規則與[喚醒失敗時](#喚醒失敗時)相同。（24.7.1、24.7.2）
- **不是備援：** 在降級模型上的喚醒不會被報成備援；從降級換到上限記為 `tier_step_up`（並附 note 說明失敗嘗試的副作用未還原），不是 fallback。（D-15、24.7.3）
- **Session：** 每個模型各自一個 session（降級模型用 `<agent>@<runtime>/<model>`，上限用 agent 名稱），session 永不跨模型續接。因此 `resume: true` 的成員看不到它在另一個 tier 做過的事；成員預設 `resume: false`，沒有損失。（D-08、24.6）
- **重寄：** 重複信判定納入有效 tier（沒寫算 `high`），所以 lead 在結果不佳後把同一個 task 改用較高 tier 重寄，不會被當重複退回。舊版程式不看 tier，會退回。（D-16、24.5.4、24.13 R-4）
- **哪裡看得到：** 降級喚醒的行是 `waking <agent> (<runtime>/<model>, tier <tier>)`；`wake` log 事件與 `state.wakes[]` 多出 `tier` 與 `model`；某 agent 最後一次喚醒實際跑在低於上限的 tier 模型上時（升回上限或改用備援模型時不算），`status` 多一行 `<agent> tier <tier>（<runtime>/<model>）`（全形括號，前面無空格）。`status --json` 只增加這些選填欄位。（24.7.3、24.9）
- **標錯的代價：** tier 設太低可能降低品質或多一次喚醒；lead 提示要求不確定時用 `high`。效果未量測。（24.13 R-2）
