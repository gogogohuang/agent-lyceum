# 評估：以〈Harness, Loops, Graphs〉重新檢視 agent-lyceum

日期：2026-11-01。這份文件只做評估：除了修正 `docs/specs/27-dispatcher-verify.md` 的錯誤（§5），沒有修改程式、設定或其他文件，也不授權任何實作。

- 程式行號一律以 `78041b1` 為準，可用 `git show 78041b1:<path> | nl -ba` 重開。`78041b1` 和 `55ae675`（0.31.1）的差別只有 spec 27 與 `docs/specs/README.md`，`src/` 相同（`git diff --stat 55ae675 78041b1`）。
- 文章只依任務提供的摘要（作者 @m4lkxx，2026-10-25）評估，沒有讀全文。摘要的分層是：L1 Harness 手（shell／檔案／測試／git，工具少而文件清楚）；L2 Harness 記憶與牆（狀態存在 context 外、權限限制）；L3 Loop 檢查（測試必須能失敗，證據強度從確定性測試到自我回報）；L4 Loop 回饋（給方向，同樣結果重複就退出）；L5 Graph 形狀（拆節點、能平行就平行）；L6 Graph 閘門（凍結已通過的結果、只重跑失敗節點、依撤銷成本設閘）；L7 學習（把失敗變成對應層的約束）；多數任務做到 L4 就夠。表格中的對應是本文的解讀，不是文章的說法。
- 本機 run 資料的取樣見附錄 A。

判定用語：**已有**／**部分**／**缺口**。
標記：**[code]** 表示由程式強制，**[prompt]** 表示只寫在 prompt、AGENT.md 或 scaffold 文字裡，靠模型自行遵守。
本文的行為判定都來自**讀碼**，沒有實際執行程式；除非另外註明，一律視為**未驗證（未實測）**。「已有」也不代表成效有量測過。

## 1. 結論摘要

- **L3 是最值得補的一層，前一輪這點判斷正確。** `done` 之後只有結構檢查、records 預算和未整合工作的降級，沒有任何程式會去驗內容。本機 18 個 run 裡有 17 個 `completed`，全都是 lead 自己宣告的（附錄 A）。
- **前一輪有四處要修正：** L4 比「只退回格式與重複信」多很多（§3）；L6 有訊息層級的「不重跑」，只是沒有語意上的「通過」；L7 不只靠 lead；L1、L2、L5 的「很完整」要加限定。
- **spec 27 的方向可行，但 27.5 的安全論述原本站不住**，這是本次最重要的發現：
  - 開啟 verify 後，任何成員寫的程式碼都能在 sandbox 外執行，這和 spec 14.2-9「lead 不拿到不受限的 shell」直接衝突。
  - 依讀碼，verify 對受保護檔案內容的一般修改**不會被 guard 發現**（下一批喚醒前的 `rebase` 會把它收為基準），spec 原本寫的相反。
  - agent 能改測試腳本，所以 exit code 0 不等於測試通過。
  - 這些都不是實作細節，而是使用者開啟前要知道的取捨。spec 已改成如實陳述（§5），但風險本身還在。
- **`settle` 是同步函式**，spec 27 原本的接點無法處理逾時與 Ctrl-C，要改成 async（§4）。
- **建議順序：** 先決定 27 的安全取捨 → 實作 27 → L4 只做窄版（§6.2）→ L6 先只做偵測（§6.3）。本機資料只記到完全相同的重複信 0 次，**沒有量測過任務結果是否重複**，所以 L4、L6 的急迫性目前無法判斷；這支持先做小版本，不代表問題不存在。

## 2. 逐層對照表

| 層 | 現況 | 判定 | 證據 |
|---|---|---|---|
| L1 手：工具 | Claude 的 allow 清單是 Bash/Read/Glob/Grep 加對 repo 的 Edit，只有 `allow_web` 能逐角色調整。Codex 只設 sandbox 與 writable roots。工具本身由 runtime 提供。 | 已有，委由 runtime [code] | `src/adapters/claude.ts:30-36`；`src/adapters/codex.ts:66-79` |
| L1 手：工具少 | 喚醒沒有傳 `--bare`、`--setting-sources` 這類隔離參數。本次第一次 Claude 喚醒的工具清單裡出現了使用者帳號的 MCP（Datadog、Slack 等）與 skills（連線狀態在 run 中有變動）；實際呼叫是否會被拒絕：**未驗證**。 | 部分 | `src/adapters/claude.ts:77-91`；本次喚醒的觀察 |
| L1 手：文件清楚 | 每次喚醒注入 AGENT.md、團隊協定、COMMON、records、memory 索引。內容是否清楚由各專案決定。 | 已有；內容 [prompt] | `docs/how-it-works.md:5`；`src/prompt.ts:354` |
| L2 記憶：狀態在 context 外 | 信件是檔案，`state.json`、memory、records、handoff 都在 context 外，新 session 也能接續。 | 已有 [code] | `docs/how-it-works.md:4,6-7`；`src/records.ts:11-12`；`src/run-store.ts:188-233` |
| L2 牆：寫入 | deny 清單涵蓋他人 memory、信箱、`runs/`、`project.yaml`、`team.yaml`、其他 worktree。強度依平台分 os／tool-rules／post-hoc／prompt-only；`strict` 預設關閉。 | 已有 [code]，強度依平台 | `src/policy.ts:204-233,258-264`；`src/schema.ts:158`；`docs/write-scope.md:14-22` |
| L2 牆：事後還原 | guard 只還原受保護檔案。另一個 run 活著時，無法歸屬的變更會保留，連本 run agent 的違規也一樣。 | 部分 [code] | `src/guard.ts:78-86,134-138`；`docs/write-scope.md:20` |
| L2 牆：讀取與網路 | 寫入範圍不限制讀取。網路放寬的 Claude key 端到端效果未驗證；Codex 只有一個全開全關的開關。 | 缺口（讀）；部分（網路） | `src/adapters/claude.ts:12-14,30`；`src/adapters/codex.ts:72`；`docs/write-scope.md:30` |
| L3 檢查：確定性 | run 裡沒有任何程式執行專案指令；`src/` 內 `spawn`／`execFile` 的用途是 runtime、git、ps、gh、編輯器，schema 也沒有指令欄位。 | 缺口 | `src/schema.ts:131-139`；`src/process-runner.ts:184`；`src/worktree.ts:38`；`src/open-pr.ts:14` |
| L3 檢查：結構 | `done` 要有 outcome 與規定標題，`completed` 要 Steps 全勾；不合就退回。 | 已有 [code]，只驗形式 | `src/format.ts:105-119`；`src/run-session.ts:989-1009` |
| L3 檢查：跨機制 | 有未整合工作時 `completed` 降為 `blocked`；records 超預算時拒收 `done`；handoff 沒更新只記 note。 | 已有 [code]，不驗內容 | `src/run-outcome.ts:21-24`；`src/mailbox.ts:387-393`；`src/run-session.ts:1043-1051` |
| L3 檢查：自我回報 | 跑測試、派 reviewer 都是 lead 自己說的；`## Verification` 只取前 400 字顯示。文件明寫不驗證。 | 只有自述 [prompt] | `src/format.ts:121-129`；`docs/how-it-works.md:9`；`src/run-session.ts:1333` |
| L4 回饋：有方向 | 退回信指出缺什麼；Retry／Redo notice 帶上次的錯誤與未送出的草稿；未整合時說明分支與 patch。 | 已有 [code]；照做與否 [prompt] | `src/run-session.ts:1001,921-926`；`src/redo.ts:293-305` |
| L4 重複就停：呼叫失敗 | 有 fallback chain 時依錯誤類型決定重試或換模型，`auth` 直接停；沒有 chain 時所有錯誤（含 `auth`）都重試 `retry` 次。設定錯誤一律直接停。一直失敗時 run 以 `agent_failed`／`lead_failed` 結束。 | 已有 [code]，只算次數 | `src/fallback.ts:115-133`；`src/run-session.ts:1070-1077` |
| L4 重複就停：信件 | 完全相同的信不再送，通知有上限；格式退回、`done` 退回、`ask` 退回都有上限。 | 已有 [code]，只認形式 | `src/mailbox.ts:289-302,451-461,480-485`；`src/duplicate-notices.ts:6,25-33`；`src/run-session.ts:993,1112-1134` |
| L4 重複就停：結果 | 沒有比對「這次的錯誤和上次一樣」或「工作區沒變」。`rg fingerprint src` 只命中 memory tidy 與 worktree 的完整性檢查。審查迴圈 2 輪上限只在 lead 的 AGENT.md。 | 缺口 | `src/memory-tidy.ts:98`；`src/worktree.ts:82` |
| L4 總上限 | `max_rounds` 計算呼叫次數，預設 0（不限）。沒有 `done` 就提醒一次，然後 `idle`。 | 已有（預設關閉）[code] | `src/run-session.ts:726,690,1285-1288,1259-1271`；`src/schema.ts:155` |
| L5 形狀：拆節點 | 由 lead 用信件決定，沒有宣告式的圖或相依。 | 已有 [prompt]；限制 [code] | `src/mailbox.ts:413-424`；`src/prompt.ts:24` |
| L5 形狀：平行 | 有未讀信的成員同時喚醒，lead 單獨喚醒；同角色可開 instance。獨立與否由 lead 判斷。行程數不設上限；跨檔案不相容不會被偵測。 | 已有 [code]；判斷 [prompt] | `src/run-session.ts:625-631,1321`；`docs/how-it-works.md:19,28,35` |
| L6 凍結 | 已 commit 的訊息不會重新喚醒；失敗或中斷才重做那封信（§3）。但沒有「通過」的概念，後面的工作可以改掉已審過的檔案，系統不會知道。 | 部分 [code]（只到訊息層級） | `src/run-session.ts:1025-1033,835`；`src/message-store.ts:379-386` |
| L6 只重跑失敗 | 粒度是一次喚醒的整封信（§3）。重試不還原副作用，只在 prompt 說明。 | 部分 | `src/run-session.ts:821-824`；`src/redo.ts:299-305` |
| L6 依撤銷成本設閘 | 不自動 merge，結果留在分支；PR 只在 `completed` 才開；`ask` 讓 run 等人。其他（如破壞性操作要先問）只在 lead 的 AGENT.md。沒有可依操作設定閘門的機制。 | 部分 [code] | `src/run-session.ts:1159-1167,1185`；`src/mailbox.ts:373-379`；`docs/how-it-works.md:17` |
| L7 學習 | lead 寫 records 與 handoff、各 agent 寫 memory，都是 prompt 規則。程式只做預算限制、`shared-not-updated` 提示，以及使用者觸發的 `tidy`。失敗不會自動變成約束；guard 和 log 的資料沒有回流管道。 | 部分 [prompt] | `src/prompt.ts:95,116,168,306`；`src/mailbox.ts:387-393`；`src/run-session.ts:1046-1050`；`src/cli.ts:625-629` |

## 3. 查證前一輪評估

前一輪是人工評估，以下是獨立查證結果。

| 前一輪主張 | 判定 | 證據與修正 |
|---|---|---|
| L1 很完整 | **不確定** | 能力在，但多半來自 runtime。「工具少」不成立：使用者層級的 MCP 也會載入（§2），可否呼叫未驗證。 |
| L2 很完整 | **需修正** | 寫入、狀態外存成立。但讀取不隔離、強度依平台、`strict` 預設關閉、跨 run 時 guard 會放行（§2）。 |
| L5 很完整 | **需修正** | 機制成立，但拆分與獨立性都是 lead 的判斷，也沒有行程上限（`docs/how-it-works.md:19,28`）。 |
| L3 最弱 | **成立** | 其他層都有 [code] 機制，只有這層完全沒有內容檢查。 |
| `done` 不驗證，全靠 lead 自述 | **大致成立，需補充** | 內容確實不驗。但 `done` 有三項程式處理：契約、records 預算、未整合降級（§2 L3）。它們判斷形式，不判斷真假。接受 `done` 之後只有寫 `result.md`、提交分支、可選的開 PR（`src/run-session.ts:1052-1063,1335-1343`），**沒有任何驗證**。 |
| L4 只退回格式不合與完全相同的重複信 | **不成立（範圍太窄）** | 還有：`done` 退回、`ask` 退回、呼叫失敗的重試與分類、連續失敗就停、`nudge`、`max_rounds`（§2 L4）。核心判斷仍對：沒有比對「結果」是否重複。 |
| L6 沒有「通過就凍結」 | **大致成立，需補充** | 語意上的凍結沒有。訊息層級的不重跑有；重開時先前 segment 的 Steps 也不再檢查（`src/run-session.ts:990-992`）。 |
| L7 靠 lead 手寫 | **部分成立** | 失敗不會自動變約束，這點成立。但成員也寫自己的 memory，`tidy` 是程式觸發的 LLM 整理，`done` 有 records 預算。 |

任務要求特別查的項目：

- **`done` 之後有沒有程式驗證：** 沒有內容驗證（上表）。
- **重複信偵測的範圍（`src/mailbox.ts:281-302,466-470`）：**
  - 比對同寄件人、同收件人、同 type、同 `reply_to`、空白正規化後同內文、同有效 tier。範圍含收件人的未讀、已讀；instance 模式下含同角色各 instance 與 pending。
  - 內文少於 20 字元不算。`ask`、`done` 在這之前就 `continue` 了，不適用。比對不跨 run。
  - 所以換個 `reply_to`、改一個字就不算重複，語意相同的循環抓不到。
- **失敗計數：** 有，但都是分開的次數，沒有比對內容。
  - `state.done_rejections`（`src/run-session.ts:993-994`，重開時歸零 `:290`）
  - `state.ask_rejections`（`:1112-1113`）
  - `format-rejections.json`（`src/format-rejections.ts:6-28`）
  - `duplicate-notices.json`（`src/duplicate-notices.ts:6-33`）
  - 單次喚醒內的重試（`src/fallback.ts:115-119`）與 cooldown（`src/run-session.ts:828`）
- **重複失敗偵測：** 只有「同一封信完全相同」這一種，都不比對內容或結果。計數的生命週期不同：單次喚醒內的重試每次 `resume` 重新開始；`state` 的計數在一般 `resume` 延續（`src/run-session.ts:272`），`done_rejections` 只在重開時歸零（`:285-290`）；兩個 json 檔案在 `resume` 後重新載入、繼續累計（`src/format-rejections.ts:11-27`、`src/duplicate-notices.ts:13-31`）。
- **`redo`／`resume` 的粒度：**
  - `redo` 不是指令（`src/cli.ts` 無此命令）。它是 `src/redo.ts` 的 prompt 組裝：同一 agent 重做同一封信時，附上失敗紀錄與至多 4 KB 草稿。
  - 重試的粒度是一次喚醒。失敗時 outbox 被隔離、信留未讀（`src/run-session.ts:813,835`）。
  - `resume` 的粒度是**未讀訊息**：recover 收尾後從未讀繼續，`output_ready` 的只補路由（`src/run-session.ts:1215-1240`）。
  - `resume <run> "<text>"` 是在同一 worktree 上開新任務（`src/run-session.ts:285-292`），沒有「從某步驟重跑」的選項。

## 4. 審查 spec 27：接點與尚未解決的問題

**接點合理：** `settle` 內契約檢查之後、`noteTierIgnored` 之前。這時 lead 單獨喚醒（`src/run-session.ts:628`），工作區不會被同 run 的其他 agent 改動；成員工作已在先前的 settle 整合；claim 還沒 commit，崩潰可重播。**但**如 §5 所述要改 async。

以下是**設計缺口，不是事實錯誤，所以依任務限制沒有改進 spec**，建議實作前補：

| # | 缺口 | 為什麼重要 | 建議 |
|---|---|---|---|
| G1 | 使用者還沒決定是否接受 27.5 的風險。前次評估判定「不可採」 | 開啟後等於 agent 能逃出 sandbox，含網路與 `project.yaml` | 使用者明確決定；預設關閉要保留。文件要直說這會讓 sandbox 不再是保證 |
| G2 | agent 能改驗證腳本 | exit code 0 可能什麼都沒驗，L3 的「測試必須能失敗」不成立 | 在 `## Dispatcher verification` 列出 `package.json`、測試目錄等是否相對 base 有改，交給人判斷。清單如何定：待決 |
| G3 | `completed` 且有 `blocked_integrations` 時，27.6 仍會跑驗證，最後還是 `blocked`（`src/run-outcome.ts:21-24`） | 白跑，而且驗的是缺成員工作的樹 | 第 1 步加上 `blocked_integrations` 為空 |
| G4 | D-13 沒說 `verify_rejections` 重開時歸零（`done_rejections` 有，`src/run-session.ts:290`） | 第二段可能直接用完退回次數 | 明訂歸零 |
| G5 | 被退回的 `done` 的 Steps 仍會併入 `state.steps`（`src/mailbox.ts:395-396`、`src/run-session.ts:1022`） | 驗證失敗時 `status` 顯示步驟全勾 | 退回時清掉 `route.steps`。契約退回路徑也有同樣現象，修之前先確認是否刻意 |
| G6 | 27.10 要改 `src/status.ts`，但 `status --json` 不能變（COMMON 硬限制；`src/status.ts:349-351`） | 破壞 `plugins/status-monitor` | 明訂只改文字輸出 |
| G7 | 驗證期間 `state.active` 是空的（`src/run-session.ts:764`），單條可長達 7200 秒 | 監視面板看起來像閒置 | 只用 `log` 與 console，或另加不影響 JSON 的顯示 |
| G8 | 崩潰若發生在 `rejectDone` 之後、`saveState`（`:1023`）之前，計數會少算一次 | 27.9 只要求不重複計數；實際是可能少算，等於多一次退回機會 | 影響小，建議接受並寫明。提早 `saveState` 不能解決：重啟若在存檔後、`rejectDone` 前，同一個 `done` 會再計一次（`deliverOnce` 只防重複送信）。要 exactly-once 得記下已處理的 source |
| G9 | `runInvocation` 的 log 不設上限且分 stdout／stderr（`src/process-runner.ts:179-180`），和 D-11 的單一 1 MiB 檔案不同 | 想重用它（才有 `killTree`、`killAllRunning` 註冊）就要調整 | `verify.ts` 重用行程控制，log 另處理 |
| G10 | 27.10 沒列 `docs/write-scope.md` | 那裡是寫入保證的權威說明，開 verify 後內容不再完整 | 加入影響清單 |

## 5. spec 27 的修正清單

只修事實錯誤與自相矛盾，編號不變。

| 位置 | 原文問題 | 修正 |
|---|---|---|
| 27.1 | 「`completed` 是唯一條件」：還需要 lead 分支與檔案變更（`src/run-session.ts:1185-1188`） | 改寫條件 |
| 27.1 | 「正面處理這個風險」與 27.2、27.5「不做隔離、未解決」矛盾；也沒說這推翻前次「不可採」 | 改為如實說明 |
| 27.2 | 「agent 寫不到設定家目錄」不正確：memory 等都在那裡；deny 的是 `project.yaml`、`team.yaml`（`src/policy.ts:220`） | 改正，並註明不約束 verify 本身 |
| D-04 | 行號 `984-988` 不對；實際 `982-986`。另外「驗的是會提交的那棵樹」漏了 verify 的產物也會被提交（`src/worktree.ts:506`） | 改行號、補說明 |
| D-15 | `call` 不適用的理由錯：`call` 有工作目錄（`src/call.ts:25-26`）；真正原因是沒有信箱與 `done`（`src/policy.ts:188`） | 改理由 |
| 27.4、27.10 | 要補 `docs/upgrading-run-v2.md`，但該文件談 run 格式，和 D-12「不改格式」矛盾 | 改指 `docs/configuration.md` 的 Mixed versions（`docs/configuration.md:183`） |
| 27.5 事實段 | 漏了改寫 `project.yaml`、網路、成員為作者、與 spec 14.2-9 衝突、`strict` 不涵蓋、exit code 可被改腳本繞過 | 補上 |
| 27.5 第 6 點 | 「風險同一類，只是時機提前」低估：人沒機會先看 diff，且在 run 中執行 | 改寫 |
| 27.6 開頭 | 行號 `:990-1021`、`:1049` 不對；實際 `:989-1009`、下一步 `:1010`。未提 `settle`／`recover` 是同步函式，與 Ctrl-C、逾時的要求矛盾 | 改行號、寫明要改 async；27.10 同步 |
| 27.6 崩潰段 | 「驗證本身不改工作區，重跑是安全的」與 27.5、27.8 矛盾 | 改為不保證冪等 |
| 27.7 | 「28、29 只讀這些欄位」與 27.2「成員層級 gate 屬於 29」矛盾（那需要新的執行點） | 限定範圍 |
| 27.11 | 「各自在自己的 worktree 驗證，互不干擾」與 27.5 矛盾 | 改為只說 cwd 不同，其他可能互相干擾 |
| 27.8 guard | 「下一次比對會當成變更處理」與程式不符：`rebase`（`src/guard.ts:72-76`、`src/run-session.ts:1318`）會收為基準；`project.yaml` 也不在清單內（`src/guard.ts:78-86`） | 改寫，標未實測；symlink 類替換由 `unsafeToRead` 分支處理（`src/guard.ts:117-124`） |

**核對無誤、未改：** `doneContract`、`resolveDoneOutcome`、`integrateMember`、`routeOutboxes`、`deliverOnce`、`rejectDone`、`sourceIdOf` 都存在且行為相符；`src/process-runner.ts:238` 是逾時計時；spec 14.2-3、14.2-9 的引用正確；D-12（`WireState` 為 `passthrough`，`src/run-store.ts:233`）；`ProjectConfig` 是 `.strict()`（`src/schema.ts:131-139`）；`verify-reject:<source id>` 的冪等可行，`sourceIdOf` 含 mtime 與內容（`src/message-store.ts:175-181`），重送的新 `done` 會有新 key。

## 6. 建議（依 價值／成本 排序）

以下都只是**提案**，實作要另外派工。

### 6.1 先決定 spec 27 的安全取捨，再實作
要回答的問題只有一個：**願不願意為了確定性驗證，在開啟的專案裡放棄「agent 程式碼跑在 sandbox 內」的保證。** 本文建議接受「預設關閉、使用者明確開啟」，因為 L3 是唯一完全沒有 [code] 內容檢查的層，而且 PR 上的 CI 不涵蓋沒開 PR 的 run。開啟前先補 §4 的 G1–G6。

### 6.2 L4 設計方向：同樣結果重複就停（28）

**先看有多少價值：** D-07 的 `max_rejections` 預設 2，所以光 verify 這條路最多只省 1 次喚醒。任務結果是否重複目前沒有資料（附錄 A 只記到重複信）。因此第一版要小，並先加量測。

- **做法：**
  1. **verify 重複：** 每次失敗算指紋 = 指令 `name` + exit code + 輸出尾端的 hash（先去掉時間與路徑等明顯會變的字串）。**指紋相同且 27.7 的工作區 hash 也相同**，視為很可能沒有進展（這是啟發式判斷），就不再退回，直接走 D-08 降為 `partial`，note 寫明原因。只有指紋相同、工作區有變，就在退回信裡標出「和上次同樣的失敗」，這才是給方向。
  2. **只記錄，不停：** 第二階段 log 跨 wake 的訊號（同一 agent 連續失敗的錯誤文字、一個 thread 的來回次數），先累積資料，有證據再決定要不要停。
- **要改的模組：** 新檔 `src/repeat-detect.ts`（指紋、比對）；`src/run-session.ts`（退回路徑）；`src/run-store.ts`（選填欄位）；`src/run-outcome.ts`（note）。
- **不要新增 `EndReason`：** 它會出現在 `status --json`（`src/status.ts:347`）。
- **風險：**
  - 假陰性：flaky 測試或輸出帶亂數，指紋每次都不同，這時退回上限仍是保底。
  - 假陽性：工作區相同不代表輸入都相同。被 ignore 的相依、環境變數、外部服務變了，結果可能不同；27.7 的 diff hash 也還沒定義基準與未追蹤檔案的範圍。後果是少一次退回、降為 `partial`，不會誤報成功，所以可以接受，但實作前要先定 hash 的範圍。
  - 工作區 hash 要走已釘住 git 目錄的 `agentGit`（`src/worktree.ts`），因為 agent 能改 worktree 的 git 檔案（`docs/write-scope.md:24`）。沒有 worktree 的模式取不到 hash，要退回只靠次數。
- **與 27 的依賴：** 第 1 項**硬依賴** 27.7 的紀錄與 D-11 的 log。第 2 項不依賴 27，可以先做。

### 6.3 L6 設計方向：通過就凍結、只重跑失敗步驟（29）

**先分清楚：** 現在的粒度是信件，dispatcher 不知道「步驟」，也不解析審查結論（`docs/evaluations/graph-engineering.md` §4）。真正的步驟圖要把動態路由改成固定流程，前次已判定不採用。可行的是兩個較小的方向：

- **方向 A：verify 結果快取（內容定址）。** 記下 `(指令 name, 工作區 hash) → 通過`。同一個 hash 再跑時，跳過已通過的指令，只跑失敗的那條與其後的指令。**這個 key 不足以保證結果仍成立：** 指令內容（`project.yaml` 的 `run`）、被 ignore 的相依、環境變數都不在 key 裡，指令也不保證 hermetic（spec 27.4、27.5）。這裡的錯誤方向是誤放，比 6.2 嚴重。在定義好執行身分與失效規則之前，**不要跳過指令**；跳過也會改變 D-05、D-06 的行為，要改 spec 27。
  - 改動：`src/verify.ts`、`src/run-store.ts`。
  - 風險：`fail_fast` 下任何改動都會讓 hash 變，快取幾乎只在「沒改就重送」時命中，而 6.2 已會擋這種情況，**實際價值可能很低**。讓使用者宣告每條指令的 `inputs` 可提高命中率，但沒宣告到的相依會造成誤放，且違反「寧可誤擋」。這部分不建議先做。
- **方向 B：已審查變更的偵測（建議優先）。** 不阻止，只提醒。
  - 讓 reviewer／QA 的 reply 帶選填的 frontmatter `verdict: approve`，dispatcher 記下 `(thread, 工作區 hash 或檔案清單)`。之後成員整合若實際套用到這些檔案，就在下一封給 lead 的信加註，`done` 的 note 也列出「審查後又被改過的檔案」。`integrate` 事件的 `files` 是嘗試的變更，整合被擋時也有（`src/run-session.ts:895-901`），要看 `status` 與實際套用的路徑；它也看不到 lead 自己之後的修改，所以 `done` 時要再比一次 lead 工作區。replay 與格式都還沒設計，這只是方向。
  - 改動：`src/mailbox.ts`（驗證欄位，比照 `tier`）、`src/run-session.ts`、`src/run-store.ts`、`src/format.ts`（不動契約）。
  - 風險：`verdict` 仍是自我回報，只能說明「審過的東西變了」，不能證明審得對；檔案層級會有誤報；reviewer 也可能用另一個 worktree 看到過時內容。硬性阻擋不建議（可能卡住合理的修正）。
- **與 27 的依賴：** A 硬依賴 27。B 只需要共用工作區 hash 的 helper，可以獨立，也可以只比檔案路徑而完全不依賴 27。27.2 所說的「成員層級 gate」會放大 27.5 的暴露次數，**不建議**，至少要等 sandbox 內執行有解。
- **依撤銷成本設閘：** 現有 `open_pr` 只認 `completed` 已是一個例子；有了 27 就自然變強。不需要新機制。

### 6.4 文件：實作前不要改 `docs/how-it-works.md:9`
"does not verify what the lead reports" 目前正確。等 27 上線再改，並同步改 `docs/write-scope.md`。

## 7. 不建議採納的項目與理由

| 項目 | 理由 |
|---|---|
| 依測試框架解析輸出算失敗指紋 | 要維護多種格式，而工作區 hash 加輸出尾端已能處理最明確的情況（spec 27.2 也排除）。 |
| 固定步驟圖 | 會犧牲 lead 的彈性；前次評估已判定不採用，本次沒有新證據。 |
| 成員層級的 verify gate | 暴露次數放大，每次 `reply` 都在 sandbox 外跑 agent 的程式碼。 |
| 由 dispatcher 解析審查內容，或強制 2 輪上限 | 結論是自由文字，理由見 `docs/evaluations/graph-engineering.md` §4。6.3 B 的選填欄位是較弱但可行的替代。 |
| 把 L7 自動化（失敗自動寫成 lesson） | records 每類只有 6 KB 預算（`src/records.ts:12`），自動寫入會很快爆量；「把失敗變成哪一層的約束」本身就需要判斷。現有資料也不足以看出哪種失敗值得記。 |
| 把 L5、L6 排在 L3 前面 | 摘要說多數任務做到 L4 就夠；本專案的 L3 卻還是空的。 |

## 8. 評估範圍

| 面向 | 本次狀況 |
|---|---|
| 格式與相容 | 本次不改格式。27 新增設定鍵與選填 state 欄位，舊版本會拒絕含 `verify` 的 `project.yaml`。§6 的欄位都應是選填。`status --json` 不可變（G6）。 |
| 取消與部分完成 | 27 的取消依賴 `settle` 改 async（§5）。現有程式選出 `done` 時不移動檔案（`src/mailbox.ts:382-397`），要到 `finishDone` 才移走，所以**只要未來的接點在取消時於 `rejectDone`、`finishDone` 之前返回**，`resume` 就會再驗一次。這個接點還不存在，未實測。 |
| 安全 | §1、§4 G1–G2；spec 27.5。這是 27 最大的未解決項。 |
| 並行與恢復 | 多個 run 同時跑 verify 共用機器資源與連接埠，未驗證。verify 改到跨 run 共享檔案時，對其他 run 的 guard 也是無法歸屬的變更。 |
| 平台 | sandbox 強度依平台而異，開啟 verify 時各平台都不受保護。 |
| 測試與可維護性 | 本次沒有改程式，沒有跑 `npm test`。行號以腳本核對（見下），另跑 `npm run check:docs`。`settle` 改 async 會影響所有用到它的測試，工作量未估。 |
| 可診斷性 | §6.2 第 2 項是為了補資料；目前 `state.json` 與 `log.jsonl` 已足以做附錄 A 的統計。 |
| 後續分工 | 本文不授權實作。使用者決定 G1 後：實作者先細化 G 項與取消、重播設計；QA 用假指令驗取消、恢復、guard 接縫；文件角色在實作後才更新雙語 configuration、how-it-works 與 write-scope。 |

**未驗證項目：**
- 本文所有行為判定都是讀碼，沒有實際執行。其中影響最大的是「verify 改動受保護檔案時 guard 不會偵測」（另一個 runtime 的 reviewer 也只做了讀碼追蹤）。
- 任務結果是否實際重複：沒有量測。
- 使用者層級 MCP 在喚醒中可否實際呼叫。
- 文章全文的論點（只有摘要）。
- Claude sandbox 放寬 key 的端到端效果（沿用 spec 25 的未驗證標記）。
- lead 的 AGENT.md 是使用者設定檔，不在 repo 內，本文引用時沒有行號。

## 附錄 A：本機 run 資料的取樣方法

只讀資料，取樣時間 2026-11-01。

```bash
RUNS=~/agent-lyceum-config/projects/agent-lyceum/runs
node -e 'const fs=require("fs"),p=require("path"),R=process.argv[1];const c={},e={},r={};
for(const d of fs.readdirSync(R)){const f=p.join(R,d,"state.json");if(!fs.existsSync(f))continue;const s=JSON.parse(fs.readFileSync(f,"utf8"));
c[s.outcome??"(none)"]=(c[s.outcome??"(none)"]||0)+1;for(const w of s.wakes||[]){c.wakes=(c.wakes||0)+1;if(w.ok===false){c.failed=(c.failed||0)+1;const k=String(w.error).slice(0,30);e[k]=(e[k]||0)+1}}
for(const lf of ["log.1.jsonl","log.jsonl"]){const l=p.join(R,d,lf);if(!fs.existsSync(l))continue;for(const li of fs.readFileSync(l,"utf8").split("\n")){let x;try{x=JSON.parse(li)}catch{continue}
if(x.event==="rejected"){const k=String(x.reason).slice(0,20);r[k]=(r[k]||0)+1}if(["done-rejected","violation","nudge"].includes(x.event))c[x.event]=(c[x.event]||0)+1}}}
console.log(c,e,r)' "$RUNS"
```

當時的結果：

- 18 個 run，17 個 `completed`，1 個未結束（本次）；332 次喚醒（本次仍在增加），61 次失敗。
- 失敗主要是額度上限（約 32 次）和逾時（7 次）。其餘約 20 次的 error 欄位是 Codex 的 JSON 片段，**本文沒有逐一判讀原因**；這也說明 `wakes[].error` 不適合直接拿來當指紋。
- `done-rejected` 1 次；`rejected` 8 次，其中 7 次是 records 超預算、1 次是格式；**完全相同的重複信 0 次**；`nudge` 0 次；`violation` 12 次。
- 同一 run、同一 agent、error 前 50 字元相同且 ≥ 3 次的組合只有 1 個，原因是額度上限（指令見下）。error 欄位含未判讀的片段，這只是粗略的下限。

```bash
node -e 'const fs=require("fs"),p=require("path"),R=process.argv[1];for(const d of fs.readdirSync(R)){const f=p.join(R,d,"state.json");if(!fs.existsSync(f))continue;const c={};for(const w of JSON.parse(fs.readFileSync(f,"utf8")).wakes||[])if(w.ok===false){const k=w.agent+"|"+String(w.error||"").slice(0,50);c[k]=(c[k]||0)+1}for(const[k,v]of Object.entries(c))if(v>=3)console.log(d,k,v)}' "$RUNS"
```

**這些統計沒有比對工作區內容、任務結果或相鄰錯誤，不能用來主張「結果沒有重複」。**

這些數字只代表這台機器上現存的 18 個 run，不是通則。run 目錄也可能被清理過，樣本有偏差。
