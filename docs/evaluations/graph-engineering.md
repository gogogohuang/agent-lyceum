# 評估：「Graph Engineering」文章能否改善 agent-lyceum

日期：2026-10-27。範圍：只評估，不改程式。所有行號以本報告撰寫時的 `main`（`c5980b0`，0.27.0）為準。

判定用語：**已有**（機制存在）／**部分**／**缺口**（沒有）／**不適用**。標記 **[code]** 表示由程式強制，**[prompt]** 表示只寫在 prompt、AGENT.md 或 scaffold 文字裡。「已有」只代表機制存在，不代表成效經過量測。

## 1. 結論摘要

- 文章提到的結構（獨立 context 的 node、由程式強制的 edge、逐角色選模型、依難度路由、並行、重試／輪數上限、跨 run 的 lessons），agent-lyceum 大多**已有**。真正的缺口只有三處：**沒有由程式強制的品質 gate**、**沒有逐角色的工具範圍**（reviewer 也能改 repo）、**沒有 token／金額預算**。
- 這三個缺口都**不建議**照文章的做法補上。理由分別是：由 dispatcher 跑測試，等於在 sandbox 外執行 agent 寫的程式碼；runtime 沒有回報成本；改成靜態圖，會和 lead 動態路由的設計衝突。
- 最該做的兩件事都只改文件，成本低：(1) 在 `## Saving tokens` 說明「什麼時候不需要整個團隊」，把文章的 4 問題過濾改寫成適合本專案的版本，引導使用者改用 `run --agent` 或 `call`；(2) 說明 `max_rounds` 就是本專案的 run 預算上限，因為一個 round 就是一次喚醒。
- 有條件延後一件事：讓 reviewer／debugger 的 worktree 變更不整合進 repo（即「reviewer 不能寫檔」）。這和進行中的 spec 25（per-agent sandbox allowances）落在同一塊 schema，所以等 spec 25 定案後再決定。

## 2. 對照表

| 文章論點 | agent-lyceum 現況 | 判定 | 證據 |
|---|---|---|---|
| A node：單一職責 | 職責靠每個 agent 的 `AGENT.md` 人格文字界定，系統不檢查「只做一件事」 | 部分 [prompt] | `src/scaffold.ts:9-38` |
| A node：獨立 context | 每次喚醒都是新 session；只有設了 `resume: true` 才會續用 session | 已有 [code] | `docs/how-it-works.md:4`；`src/schema.ts:64` |
| A node：獨立工具 | 所有 Claude agent 的允許清單都相同（Bash/Read/Glob/Grep，加上對自己 repo 的 Edit），schema 也沒有 per-agent tools 欄位；只有 `allow_web` 可以逐角色開 | 缺口 [code] | `src/adapters/claude.ts:28-34`；`src/schema.ts:57-74` |
| A edge：路由 | 派工由 lead 在信件裡決定；dispatcher 只強制「誰能寄給誰」（`can_message`）、信件型別與格式 | 部分（決定權 [prompt]，限制 [code]） | `src/mailbox.ts:397-411`；`src/prompt.ts:203` |
| A loop 是最小的圖 | 主迴圈依信箱挑出要喚醒的 agent，直到出現結束原因 | 已有 [code] | `src/run-session.ts:1232,1270` |
| B 4 問題過濾 | 沒有「要不要用多 agent」的判斷指引；單人模式本身已存在（`run --agent`、`call`） | 缺口（只缺指引） | `docs/commands.md:37-47`；`docs/specs/11-solo-agent.md`；`docs/configuration.md:145-175` 沒提到單人模式 |
| C 先定義可驗證產出 | `done` 必須帶 outcome 和固定標題，`completed` 還要求 Steps 全部勾選；只檢查結構，不驗證內容真假 | 部分 [code 結構] | `src/format.ts:101-116`；`docs/how-it-works.md:9`（"does not verify what the lead reports"） |
| C 獨立子任務並行 | 不同角色同時喚醒；同一角色用 `parallel: true` 開 instance（上限 `max_instances`）；子任務是否獨立由 lead 判斷 | 已有 [code]，判斷 [prompt] | `docs/how-it-works.md:11`；spec 23 |
| C 每條路徑至少過一個 gate | 派 reviewer 是 lead 的規則；`done` 不要求任何 reviewer 核可 | 缺口 [prompt-only] | tech-lead `AGENT.md:67`；`src/run-outcome.ts:19-24` |
| D 一 agent 一動詞 | 只有人格文字規範 | 部分 [prompt] | `src/scaffold.ts:32` |
| D reviewer 不能寫檔 | 每個成員 worktree 的變更都會整合進 repo，不檢查角色；12 個現存 run 裡，沒有任何 reviewer 的 integrate 事件帶有檔案 | 缺口 [code]（目前沒造成問題） | `src/run-session.ts:871-890`；`src/adapters/claude.ts:33`；`log.jsonl` 的統計見 §3 C1 |
| D fixer 不能 merge | agent 不能 commit／push；整合由 dispatcher 做，merge 由使用者手動做 | 已有 [code] | `README.md:15`（"The dispatcher never merges"）；`src/prompt.ts:183` |
| D 模型配任務 | 每個角色可設 `model`／`effort`；lead 依任務難度在 task 上標 `tier`（spec 24），dispatcher 依 ladder 選模型 | 已有 [code]，選 tier 是 lead 判斷 | `src/schema.ts:57-62,98-106`；`src/mailbox.ts:425-428`；`src/prompt.ts:48` |
| （區分）fallback chain | 由錯誤觸發，跟任務難度無關：rate limit／quota 換下一個模型，timeout／crash 用同模型重試，auth 錯誤就停 | 另一套機制 | `src/fallback.ts:101-120`；spec 20 |
| E 硬約束寫在程式 | 寫入範圍（deny 規則加 OS sandbox）、guard 事後還原受保護檔案、`can_message`、只有 lead 能送 `done`、`ask` 需要 `can_ask_user`、tier 驗證、records 超出預算時擋 `done` | 已有 [code]，強度依平台而定 | `src/policy.ts:119-213`；`src/guard.ts:37-113`；`src/mailbox.ts:358-377,397-411,425-428`；`docs/write-scope.md:9-14` |
| E 只靠 prompt 的規則 | 不在前景啟動 server、審查最多 2 輪、reviewer／debugger 不修改、跑 DoD 指令 | prompt-only | `src/prompt.ts:70-72`；tech-lead `AGENT.md:67` |
| E 特定目錄永不自動修改 | 受保護的範圍限於 AGENT.md／COMMON.md／repo 的 CLAUDE.md、AGENTS.md／他人記憶與信箱／records／config；repo 其他檔案不受限 | 部分 [code] | `src/policy.ts:141-156`；`docs/write-scope.md:3-9` |
| E 信心 < 0.7 就升級給人 | 沒有信心值的概念；人工升級靠 `ask`，需要 `can_ask_user`，送出後 run 進入 waiting | 部分 | `src/mailbox.ts:358-360`；`src/run-outcome.ts:42` |
| F state 白名單 | 一次喚醒只給一封信（lead 可以同時收到多封 reply）；COMMON.md 和 records 則給所有 agent，不分角色 | 部分 [code] | `docs/how-it-works.md:5`；`src/prompt.ts:314-360` |
| F 讀取隔離 | 寫入有範圍，讀取不受限 | 不適用（文章談的是注入什麼，不是能讀什麼） | lesson `write-scope-is-not-read-isolation`；`src/adapters/claude.ts:11-20` |
| F 跨 run 的 lessons learned | records（decisions／lessons，一筆一檔，每類 6 KB）、各 agent 的 global／project memory 與 skill 精煉、任務交接 `_shared/` | 已有 [code] | `src/records.ts:8-12`；`src/mailbox.ts:371-377`；`src/prompt.ts:83-92` |
| F watch list | 沒有獨立概念；decision 裡寫的「重新評估觸發條件」扮演同樣角色 | 部分（已有等效做法） | decision `no-broad-context-sharing`（指向報告 §4 的觸發條件） |
| G 硬 gate（test／type／lint） | dispatcher 不執行專案指令；DoD 是 lead 的規則；真正的硬 gate 是結果分支上的 CI 加上人工 merge | 缺口（在 run 內）；run 外有 CI | `src/schema.ts:76-91`（沒有 command 欄位）；`.github/workflows/ci.yml:23-27`；`README.md:15` |
| G 軟 gate（另一個模型審查） | 可以把 reviewer 設在另一個 runtime，COMMON 也規定配對；但不強制 | 部分 [prompt] | `src/schema.ts:58`；`docs/configuration.md:159-176` |
| G 人工 gate | `ask`／waiting／`resume --answer`；`open_pr` 只在 `completed` 時才開 | 已有 [code] | `src/run-outcome.ts:42`；`docs/how-it-works.md:65-70` |
| G gate 只判定不修復 | 只在人格文字裡規定；QA 在自己的 worktree 仍然可以 Edit | 部分 [prompt] | `src/scaffold.ts:34`；`src/adapters/claude.ts:33` |
| G gate 會腐化、要抽查 | 沒有抽查機制；`doctor` 會列出每個 agent 的執行層級，`strict` 可以拒絕非 OS 層的強制 | 部分 | `src/policy.ts:194-199`；`src/schema.ts:142`（`strict`） |
| G outcome | `completed` 必須通過契約；有未整合的工作時降為 `blocked`；契約被退 2 次後以 `partial` 結束 | 已有 [code] | `src/run-outcome.ts:19-24`；`src/format.ts:101-116` |
| H prompt chaining／orchestrator-workers | lead 依序派工、收 reply；成員只能寄信給 `can_message` 名單 | 已有 | `src/mailbox.ts:397-411`；`src/scaffold.ts:9-20` |
| H routing（簡單任務走便宜模型） | spec 24 的 tier | 已有 | 同上「D 模型配任務」 |
| H parallelization | 不同角色並行，加上 spec 23 instance | 已有 [code] | `docs/how-it-works.md:11` |
| H evaluator-optimizer 最大輪數 | 審查迴圈本身沒有程式上限（2 輪是 prompt 規則）；整個 run 的上限是 `max_rounds`；退件與重複信各有上限 | 部分 | `src/schema.ts:139`；`src/run-session.ts:1266-1268`；`src/duplicate-notices.ts` |
| I 重試上限 | `retry` 預設 2，加上 fallback | 已有 [code] | `src/schema.ts:141`；`src/fallback.ts:101-120` |
| I 單次執行時間上限 | `wake_timeout_sec` 預設 600 秒，逾時就 kill 整個 process group | 已有 [code] | `src/schema.ts:140`；`src/process-runner.ts:238` |
| I 最大輪數 | `max_rounds` 計的是喚醒總數（含重試），預設 0＝不限；達上限時以 `partial` 結束，調高上限後可以 `resume` | 已有（預設關閉） | `src/run-session.ts:717,1266-1268`；`src/schema.ts:139`；`src/cli.ts:404-405` |
| I token／金額預算 | 沒有；adapter 只讀 output token 和 cache 讀寫量，不讀 input token，也不讀費用 | 缺口 | `src/adapters/claude.ts:149-151`；`src/adapters/codex.ts:33-38` |
| I 排程／webhook／雲端 routine | 沒有，只能手動在 CLI 執行 `run`／`resume` | 缺口（不適用，見 §4） | `grep -rn "createServer\|node:http" src` 無結果 |
| I 手動階段：讀每個 diff | 不自動 merge，結束時印出 `git merge <branch>`；有沒有讀 diff 則無從強制 | 部分 | `docs/how-it-works.md:21,31` |
| J 理解債 | 文件沒有討論這點；但「不自動 merge」加上「完成狀態是 lead 自報」的說明，實際上把讀 diff 留給了人 | 部分 | `docs/how-it-works.md:9`；`README.md:15` |
| K 90.2%、2–3 倍 | repo 內沒有這兩個數字；repo 自己的量測方向相反（見 §5） | 未確認 | `docs/analysis-context-sharing-need.md:13,147` |

## 3. 建議採納項目（依 價值／成本 排序）

### 3.1 文件：先判斷用 `run`、`run --agent` 還是 `call`（改寫後的 4 問題過濾）
- **問題**：成本單位是喚醒次數，每次喚醒大約重讀 300k context（`docs/configuration.md:145-147`、decision `lead-wake-economy-prompt-rules`）。團隊 run 從一開始就是多個 agent；例如 run `20261025T072434377Z` 共喚醒 65 次，其中 lead 佔 27 次（取自該 run 的 `state.json`，統計方法見 architect 的 reply）。單人模式已經存在，但 `## Saving tokens` 完全沒提到它。
- **做法草案**：在 `docs/configuration.md` 的 `## Saving tokens` 加一小節，列出四個問題：需要另一個 runtime 做 maker-checker 審查嗎？工作能拆成彼此獨立、可並行的部分嗎？需要不同專長（設計／實作／驗證）嗎？單一 agent 會撐不住整個 context 嗎？四題都答「否」，就用 `run --agent <member>`；不屬於任何專案時用 `call`。同時寫明：在本專案，第一題通常答「是」，因為跨 runtime 配對審查是刻意的設計（lesson `cross-model-review-finds-misquotes`）。
- **不做成 lead 的 prompt 規則**：lead 是在團隊 run 裡被喚醒的，無法在 run 進行中切換成單人模式，所以這必須是使用者在 `run` 之前做的選擇。lead 那邊已經有對應的規則：獨立工作同批送出，小修可跳過 QA（`src/prompt.ts:25,27`）。
- **影響**：`docs/configuration.md` 和 `docs/configuration.zh-TW.md`，兩者成對，需要通過 `check:docs`。**風險**：這只是建議，效果沒有量測過；使用者可能因此少用 reviewer，所以要明寫配對審查的價值。**需要另開 spec 嗎**：不需要。

### 3.2 文件：`max_rounds` 就是 run 預算上限
- **問題**：文章 I 要求設 run 預算。在本專案，每次喚醒的嘗試（含重試）都算一個 round（`src/run-session.ts:717`）；達到上限就停下（`:1266-1268`），以 `partial` 結束，調高上限後可以 `resume`（`src/cli.ts:404-405`）。以喚醒為成本單位的預算其實已經存在，只是預設關閉（`src/schema.ts:139`），文件也沒有把它說成成本上限。
- **做法草案**：在 `## Saving tokens` 加一點說明：「把 `max_rounds` 設成你願意付的最多喚醒次數；一個 round 大約是一次完整 context。」並連到 `docs/how-it-works.md` 第 5 點。**預設值不改**：改成非零，會讓現有使用者的 run 中途停在 `partial`。
- **影響**：同 3.1 的兩個檔案。**風險**：上限設太低，run 會停在 `partial`，要先調高才能 `resume`，文件要寫清楚。**需要另開 spec 嗎**：不需要。

### 3.3（有條件延後）讓角色的 repo 變成唯讀：reviewer／debugger 的變更不整合
- **問題**：「reviewer 只審」「debugger 不修」目前只寫在 prompt。每個成員的 worktree 變更都會整合，整合時不檢查角色（`src/run-session.ts:871-890`）。
- **目前沒有發生**：12 個現存 run 的 `log.jsonl` 裡，沒有任何 reviewer 的 `integrate` 事件帶非空的 `files`（`grep '"integrate"' runs/*/log.jsonl`）。
- **做法草案**：加一個 per-agent 旗標。設了旗標的 agent，其 worktree 變更不整合，改走既有的 blocked-integration 回報路徑（`src/run-session.ts:889-890`）。
- **影響**：`src/schema.ts`、`src/config.ts`、`src/run-session.ts`，以及文件。**風險**：如果和 spec 25 的 `sandbox` 欄位重疊，會出現兩個 per-agent 寫入欄位。**需要另開 spec 嗎**：需要，但應作為 spec 25 的延伸，等它落地再決定。**重新評估的觸發條件**：出現 reviewer 或 debugger 的 `integrate` 事件帶有非空的 `files`。

## 4. 不建議採納的項目與理由

| 項目 | 理由 |
|---|---|
| 由 dispatcher 在 `done` 前跑 test／lint／typecheck，當作硬 gate | agent-lyceum 本身沒有 sandbox，OS sandbox 是交給 runtime 的（`src/adapters/claude.ts:43-45`、`src/adapters/codex.ts:67-77`）。由 dispatcher 跑 `npm test`，等於用使用者的完整權限執行 agent 寫的程式碼與 `package.json` scripts，繞過了 sandbox。改由 runtime 在 sandbox 內跑，結果仍然是 LLM 回報，算不上硬 gate；而且在 sandbox 內跑完整測試，本來就有約 7 個已知失敗（lesson `sandbox-pipe-stub-for-cli-tests`）。現有的硬 gate 是結果分支上的 CI（`.github/workflows/ci.yml:23-27`）加上人工 merge（`README.md:15`），文件也已經寫明 lead 是自報（`docs/how-it-works.md:9`）。 |
| 由程式強制審查最多 2 輪 | 審查結論是自由文字，format 只檢查標題（`src/format.ts`）。dispatcher 不知道哪些信屬於「同一個變更」，lead 也可以開新 thread。要強制，就得新增結構化的 verdict 和 thread 計數；而規則本身的內容只是「超過 2 輪由 lead 決定」，硬擋反而可能擋掉真正的 blocker。整個 run 的硬上限已經有 `max_rounds`。repo 內沒有超過 2 輪的統計（未確認）。 |
| 以 token 或金額計的預算上限 | adapter 只回報 output token 與 cache token（`src/adapters/claude.ts:149-151`、`src/adapters/codex.ts:33-38`），沒有 input token，也沒有費用。Claude CLI 的 JSON 是否帶 `total_cost_usd`：未確認（repo 沒解析這個欄位）。訂閱制沒有逐 token 計價，要設金額上限就得維護一張會過時的價格表。output token 也不是好的代理指標：run `20261025T072434377Z` 的 output 是 853,648，cache-read 卻是 94,694,908。誠實可行的上限就是 `max_rounds`（§3.2）。 |
| 4 問題過濾做成 lead 的 prompt 規則 | lead 被喚醒時已經在團隊 run 裡，無法改成單人模式；改寫成使用者文件（§3.1）即可。 |
| 定期抽查 gate 腐化（注入假缺陷、統計審查通過率） | 要注入假缺陷，就得多花喚醒並管理假 bug，也和「Nothing hidden」（`README.md:15`）衝突；審查結論是自由文字，做不出通過率。硬 gate 已有 `doctor` 列出執行層級、`strict`、guard／policy 單元測試與 CI 把關。軟 gate 則靠使用者在 merge 前讀 diff。 |
| 新增 lessons／watch list 機制 | 已經有 records／lessons（`src/records.ts`，每類 6 KB）、各 agent memory 的 skill 精煉、任務交接；watch list 的作用，由 decision 裡的重新評估觸發條件達成。多一種 record，每次喚醒的 prompt 就多出位元組。 |
| 靜態圖、寫死 edge（實作→審查→QA） | lead 的動態路由是刻意的設計：可以為小修跳過 QA（`src/prompt.ts:27`）、標 `tier`、開 parallel instance。「硬 edge」真正有價值的部分（`can_message`、受保護檔案、寫入範圍、`done` 契約）已經由程式強制。 |
| 更細的 state 白名單、讀取隔離 | decision `no-broad-context-sharing` 的量測：17 個 run 裡，只有 1 次審查要求修改可以觀察到是缺 context 造成的。問題在 context 不夠，不在給太多；進一步縮減 COMMON 或 records 沒有證據支持。 |
| 排程、webhook、雲端 routine（文章 I 的第 2、3 階段） | 這超出本機 CLI 的範圍；使用者要排程，可以自己用 cron 跑 `npx agent-lyceum run`。需要人介入時，已有 `ask`／`resume --answer`。 |
| 信心 < 0.7 就升級給人 | runtime 不輸出信心值，沒有訊號可以當門檻。升級給人的路徑已經存在（`can_ask_user`）。 |

## 5. 文章本身的可疑之處或不適用前提

- **90.2%**：repo 內沒有出處（未確認）。依 architect 的記憶（未查證），這個數字來自 Anthropic 談多 agent **研究**系統的文章。比較的對象是重度並行的廣度搜尋任務；同一篇文章（依記憶）也提到 token 用量會大增，並且說彼此依賴多的工作（例如多數程式開發）比較不適合。本專案的任務以程式碼為主、有先後依賴，價值來自跨 runtime 的 maker-checker，不是並行搜尋。因此本報告不引用這個數字來支持任何設計。
- **2–3 倍品質提升**：來源未確認，看起來是經驗談，不是 benchmark。repo 內**沒有任何品質量測**，不能套用。
- **靜態圖與動態信箱**：文章的前提是 LangGraph 式的靜態圖，edge 在設計時就固定。agent-lyceum 是由 lead 在 run 進行中透過信件動態決定下一步，硬約束放在信件的接收和整合層（`can_message`、guard、契約），而不是放在 edge 上。所以文章「把約束寫在 edge」對應到本專案，是「寫在 dispatcher 的收信和整合檢查」，這部分已經大致做到（§2 E）。
- **「硬 gate 由系統跑測試」的隱含前提**：文章假設 orchestrator 本身在受信任、隔離的環境執行。agent-lyceum 的 dispatcher 以使用者完整權限執行，sandbox 只套在 runtime 上，所以這個前提不成立（§4 第一列）。
- **「廣播 vs 白名單」**：文章假設 context 過多是主要問題。本專案自己的量測（`docs/analysis-context-sharing-need.md`）顯示，被觀察到的損失來自**同一個 agent 失去自己上一次失敗嘗試的結果**；這個問題已由 spec 22 處理。

## 附：與其他進行中工作的關係

- spec 25（per-agent sandbox allowances，另一個 run 進行中）：§3.3 和它屬於同一塊 schema 與政策區域；本報告不建議在它之外另開欄位。§2 E 的「寫入範圍強度依平台而定」在 spec 25 落地後可能改變，需要回頭重新對照。
