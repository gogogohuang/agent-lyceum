# 評估：「Graph Engineering」文章能否改善 agent-lyceum

日期：2026-10-27。這份文件只做評估：沒有修改程式、設定或既有文件，也不授權任何實作。

- 程式行號一律以 `c5980b0`（0.27.0）為準，可用 `git show c5980b0:<path> | nl -ba` 重開。
- 文章內容只依任務提供的摘要（A–K）評估，沒有讀原文全文。
- 本機 run 資料來自 `~/agent-lyceum-config/projects/agent-lyceum/runs/`（本文寫成 `$RUNS`），取樣時間 2026-10-27；取樣方式與腳本見附錄 A。

判定用語：**已有**（機制存在）／**部分**／**缺口**（沒有）／**不適用**。
標記：**[code]** 表示由程式強制，**[prompt]** 表示只寫在 prompt、AGENT.md 或 scaffold 文字裡，靠模型自行遵守。
「已有」只代表機制存在；除非另外註明，成效都**沒有量測**過。

## 1. 結論摘要

- 文章提到的結構，agent-lyceum 大多已有：每個 node 有獨立 context、`can_message` 等由程式強制的收信限制、每個角色可分別設定模型、依難度選模型（tier）、並行 instance、重試／timeout／喚醒次數上限、跨 run 的 records 與 memory。缺口有三個：run 內沒有由程式執行的品質 gate、沒有逐角色的工具範圍、沒有 token 或金額預算。
- 這三個缺口現在都不建議補。原因是成本和風險，不是做不到：
  - 由 dispatcher 用目前的權限直接跑專案指令，會讓 agent 寫的程式碼在 sandbox 外執行；另建隔離的指令執行器（runner）成本高。
  - adapter 目前沒有解析費用欄位。
  - 逐角色的寫入限制和進行中的 spec 25 是同一塊。
- 最值得做的兩件事都只改文件，而且要另外派工：
  1. 在 `## Saving tokens` 加入「什麼時候不需要整個團隊」的判斷。這是依本專案改寫文章 B 的版本，語意和原文不同，見 §3.1。
  2. 寫明 `max_rounds` 是**喚醒嘗試次數**上限，可以用來限制工作量，但**不是**金額預算。

## 2. 對照表

| 文章論點 | agent-lyceum 現況 | 判定 | 證據 |
|---|---|---|---|
| A node：單一職責 | 職責只寫在每個 agent 的人格文字裡，系統不檢查。 | 部分 [prompt] | `src/scaffold.ts:9-38` |
| A node：獨立 context | 每次喚醒都是新 session，設了 `resume: true` 才沿用。 | 已有 [code] | `docs/how-it-works.md:4`；`src/schema.ts:64` |
| A node：獨立工具 | 所有 Claude agent 的工具清單都一樣：Bash/Read/Glob/Grep，加上對自己 repo 的 Edit。逐角色可調的只有 `allow_web`。 | 缺口 [code] | `src/adapters/claude.ts:28-34`；`src/schema.ts:57-74` |
| A edge：條件式路由 | 要寄給誰由 lead 在信件裡決定。dispatcher 用程式強制 `can_message`、信件型別和格式。動態信箱本身就可以看成條件式路由的一種圖。 | 部分（決定 [prompt]，限制 [code]） | `src/mailbox.ts:397-411`；`src/prompt.ts:203` |
| A loop 是最小的圖 | 主迴圈依信箱挑出下一批要喚醒的 agent。 | 已有 [code] | `src/run-session.ts:1232,1270` |
| B 4 問題過濾 | 沒有「要不要用多 agent」的判斷指引；單人模式本身已經有（`run --agent`、`call`）。 | 缺口（缺的是指引） | `docs/commands.md:37-47`；`docs/specs/11-solo-agent.md`；`docs/configuration.md:145-175` 沒提到單人模式 |
| C 先定義可驗證產出 | `done` 只檢查結構：要有 outcome 和規定的標題，`completed` 還要求 Steps 全部打勾。報告內容是真是假不檢查。 | 部分 [code 結構] | `src/format.ts:100-118`；`docs/how-it-works.md:9`（"does not verify what the lead reports"） |
| C 獨立子任務並行 | 不同角色會同時喚醒。同一角色可用 `parallel: true` 開多個 instance。工作是否真的獨立由 lead 判斷。 | 已有 [code]；判斷 [prompt] | `docs/how-it-works.md:11`；`docs/specs/23-dynamic-instances.md` |
| C 每條路徑至少過一個 gate | 派 reviewer 是 lead 的規則；`done` 不需要任何 reviewer 核可。 | 缺口 [prompt-only] | lead 規則是 `~/agent-lyceum-config/agents/tech-lead/AGENT.md` 的〈Standard flow〉（使用者設定檔，不在 repo 內）；`src/run-outcome.ts:13-25` |
| D 一 agent 一動詞 | 只有人格文字。 | 部分 [prompt] | `src/scaffold.ts:32` |
| D reviewer 不能寫檔 | 每個成員 worktree 的變更都會整合回 repo，整合時不看角色。現存資料裡沒有 reviewer 的 integrate 事件帶有檔案；debugger 有（見附錄 A）。 | 缺口 [code] | `src/run-session.ts:871-890`；`src/adapters/claude.ts:33` |
| D fixer 不能 merge | dispatcher 代為收集與整合變更，從不 merge。「不要 commit／push」是 prompt 規則，沒有證據顯示有指令層級的禁止。 | 部分（不 merge [code]；不 commit [prompt]） | `README.md:15`；`src/prompt.ts:183`；`src/worktree.ts:619-655` |
| D 模型配任務 | 每個角色可設 `model`／`effort`。lead 在 task 上標 `tier`，dispatcher 驗證後依 ladder 選模型。 | 已有 [code]；選 tier 是 lead 的判斷 | `src/schema.ts:57-62`；`src/mailbox.ts:423-428`；`docs/specs/24-model-tiers.md` |
| （區分）fallback chain | 依錯誤類型決定，和難度無關。有 chain 時：rate limit／quota 換下一個；timeout／network／crash 先重試同一個，用完再換；auth 錯誤直接停。沒有 chain（legacy）時，所有錯誤都重試 `retry` 次，包括 auth。 | 另一套機制 | `src/fallback.ts:99-120`；`docs/specs/20-llm-fallback.md` |
| E 硬約束寫在程式 | 由程式強制的有：寫入範圍（deny 規則；有 OS sandbox 時由 OS 強制）、只有 lead 能送 `done`、`ask` 需要 `can_ask_user`、tier 驗證、records 超出預算時擋下 `done`、worktree 衝突時拒絕整合。強制的強度依平台和 runtime 而定，分為 os／tool-rules／prompt-only／post-hoc。 | 已有 [code]，強度依平台 | `src/policy.ts:119-168,186-203`；`src/mailbox.ts:358-377,397-411`；`src/worktree.ts:633-655`；`docs/write-scope.md:9-14` |
| E 事後還原 | guard 只在事後還原這幾類檔案：各 agent 的 AGENT.md、COMMON 等共享 context、repo 的 CLAUDE.md／AGENTS.md、handoff 索引（records 另有處理）。其他被 policy 擋寫的路徑（例如他人的 memory 或信箱）不在還原範圍。 | 部分 [code] | `src/guard.ts:78-85` |
| E 只靠 prompt 的規則 | 包括：不在前景啟動 server、審查最多 2 輪、reviewer／debugger 不修改、送 `done` 前要跑 DoD 指令。 | prompt-only | `src/prompt.ts:70-72`；lead AGENT.md〈Standard flow〉〈Definition of Done〉 |
| E 信心 < 0.7 就升級給人 | 沒有信心值。人工升級靠 `ask`，需要 `can_ask_user`。 | 部分 | `src/mailbox.ts:358-360`；`src/run-outcome.ts:42` |
| F state 白名單 | 一次喚醒只給一封信（lead 可一次收多封 reply）。COMMON 和 records 給所有 agent，不分角色。 | 部分 [code] | `docs/how-it-works.md:5`；`src/prompt.ts:314-330` |
| F 跨 run：讀取端 | records 會注入 prompt，只放有效的條目，每類上限 6 KB，超過就擋 `done`。 | 已有 [code] | `src/records.ts:8-12`；`src/mailbox.ts:371-377` |
| F 跨 run：寫入端 | 寫 lessons、精煉 memory、寫 handoff，都是 prompt 規則。 | 部分 [prompt] | `src/prompt.ts:82-87` |
| F watch list | 沒有獨立的機制。decision 裡寫的「重新評估觸發條件」有類似作用。 | 部分 | `docs/analysis-context-sharing-need.md` §4 |
| G 硬 gate（test／type／lint） | run 裡沒有：dispatcher 不執行專案指令，schema 也沒有指令欄位，DoD 是 prompt 規則。repo 自己的 CI 只在 push 到 `main` 和開 PR 時跑，不會自動檢查本機的結果分支。required checks 或 branch protection：未確認。 | 缺口 | `src/schema.ts:76-91`；`.github/workflows/ci.yml:3-6,23-27` |
| G 軟 gate（另一個模型審查） | reviewer 可以設在另一個 runtime，本專案 COMMON 也規定要配對。但沒有任何強制。 | 部分 [prompt] | `src/schema.ts:58`；`docs/configuration.md:159-176` |
| G 人工 gate | `ask` 會讓 run 進入 waiting，之後 `resume --answer`；`open_pr` 只在 `completed` 時才開。 | 已有 [code] | `src/run-outcome.ts:42`；`docs/how-it-works.md:65-70` |
| G gate 只判定不修復 | 只有人格文字；QA 在自己的 worktree 仍能 Edit。 | 部分 [prompt] | `src/scaffold.ts:34`；`src/adapters/claude.ts:33` |
| G 寧可誤擋不可誤放 | 程式層傾向誤擋：衝突、違規或 git apply 失敗時，整批變更都不套用（`src/worktree.ts:633-655`）；有未整合的工作時，`completed` 降為 `blocked`。審查和驗證是否偏向誤擋：只寫在 prompt，沒有量測。 | 部分 | `src/worktree.ts:633-655`；`src/run-outcome.ts:21-23` |
| G gate 會腐化、要抽查 | 沒有抽查審查品質的機制。`doctor`／`strict` 檢查的是 sandbox 的強制等級，不是 reviewer 抓不抓得到缺陷。 | 缺口 | `src/policy.ts:186-203`；`src/schema.ts:142` |
| G outcome | 契約檢查、未整合時降級、契約被退件後以 `partial` 結束，都由程式處理。 | 已有 [code] | `src/run-outcome.ts:13-25`；`src/format.ts:100-118` |
| Evidence check 機制 | 「每個說法都要附證據、reviewer 要重開證據」只寫在本專案 COMMON 的 Evidence rule 和各 reviewer 的人格裡。dispatcher 不驗證內容真假。 | 部分 [prompt] | `docs/how-it-works.md:9`；`src/scaffold.ts:35` |
| H prompt chaining／orchestrator-workers／routing／parallelization | lead 依序派工；成員只能寄信給 `can_message` 名單裡的人；用 tier 選模型；可開並行 instance。 | 已有 | `src/mailbox.ts:397-411,423-428`；`docs/how-it-works.md:11` |
| H evaluator-optimizer 最大輪數 | 審查迴圈本身沒有程式上限，「最多 2 輪」是 prompt 規則。整個 run 有 `max_rounds`。重複信的通知有上限。 | 部分 | `src/schema.ts:139`；`src/run-session.ts:679-686,1266-1268`；`src/duplicate-notices.ts` |
| I 重試上限、單次時間上限 | `retry` 預設 2；`wake_timeout_sec` 預設 600 秒，逾時就終止整個 process group。 | 已有 [code] | `src/schema.ts:138-142`；`src/process-runner.ts:238` |
| I 最大輪數 | `max_rounds` 計算的是喚醒嘗試次數，重試也算（`src/run-session.ts:717`）。每次嘗試前和外層迴圈都會檢查（`:679-686`、`:1266-1268`）。預設 0，代表不限。達到上限時以 `partial` 結束，調高上限後可以 `resume`。 | 已有（預設關閉） | `src/schema.ts:139`；`src/run-outcome.ts:47-48`；`src/cli.ts:404-405` |
| I 金額預算（超額就停並告警） | 沒有。adapter 只解析 output token 和 cache 讀寫；input token 和費用都沒解析。runtime 有沒有輸出這些欄位：未確認。 | 缺口 | `src/adapters/claude.ts:149-151`；`src/adapters/codex.ts:33-38` |
| I 至少 5 次可靠的手動 run 才升級 | 沒有這類規定或統計。agent-lyceum 本身沒有「升級到排程」這個階段。 | 不適用 | 同下一列 |
| I 排程／webhook／雲端 routine | 沒有，只能手動 `run`／`resume`。 | 缺口（建議不做，見 §4） | `grep -rn "createServer\|node:http" src` 無結果 |
| J 理解債、cognitive surrender | 文件沒有直接討論。現有設計把「讀 diff」留給人：不自動 merge，並寫明 lead 的完成是自己回報。 | 部分 | `docs/how-it-works.md:9,21,31`；`README.md:15` |
| J 圖只用在小而可機器驗證的任務、和同事一起設計（pair-design） | 沒有任務大小或可驗證性的限制。跨 runtime 配對審查和 pair-design 類似，但對象是另一個模型，不是同事。 | 部分 [prompt] | 本專案 COMMON〈Roles〉 |
| K 90.2%、2–3 倍 | 見 §5。 | 未確認／不可外推 | §5 |

## 3. 建議採納項目（依 價值／成本 排序）

以下都只是**提案**。實作要另外派工，本次沒有授權。

### 3.1 文件：先判斷用 `run`、`run --agent` 還是 `call`
- **問題**：成本單位是喚醒次數（`docs/configuration.md:145-147`）。團隊 run 一開始就是多 agent，例如 `$RUNS/20261025T072434377Z-55044276fcd45ef37a1381ef126ba186` 共 65 次喚醒，lead 佔 27 次（附錄 A）。單人模式已經有了，但 `## Saving tokens` 沒有提到。
- **做法草案**：在 `docs/configuration.md` 與 `.zh-TW.md` 加一小節，列出四個本專案版的問題：
  1. 需要另一個 runtime 做 maker-checker 審查嗎？
  2. 工作能拆成獨立、可並行的部分嗎？
  3. 需要不同的專長嗎？
  4. 單一 agent 會撐不住 context 嗎？

  四題都答「否」，就用 `run --agent`；不屬於任何專案時用 `call`。
- **和文章 B 的差異（要寫明）**：原文是「任一題答否，就維持單一 loop」，題目也包含「任務會不會重複發生」「不同類型的任務需不需要不同處理」。這裡改了題目，也改了判斷規則（變成「全部答否才用單人」），所以是**依本專案改寫的經驗法則，不是照搬原文**；它對成本和品質的效果都沒有量測。在本專案，第一題通常答「是」，因為跨 runtime 審查是刻意的設計。
- **不做成 lead 的 prompt 規則**：lead 被喚醒時已經在團隊 run 裡，不能中途改成單人模式。lead 這邊已經有對應的規則（`src/prompt.ts:25,27`）。
- **影響**：只動兩個成對的文件，需要通過 `check:docs`。**風險**：低；使用者可能因此少用 reviewer。**需另開 spec 嗎**：不需要。

### 3.2 文件：說清楚 `max_rounds` 能限制什麼、不能限制什麼
- **問題**：文章 I 要求「超過金額就停並告警」。本專案沒有金額上限；`max_rounds` 限制的是喚醒嘗試次數（含重試），但文件沒有把它當成工作量上限來說明。
- **做法草案**：在 `## Saving tokens` 寫明以下幾點。
  - `max_rounds` 是喚醒嘗試次數的上限，可以限制工作量。
  - 它**不是** token 或金額預算，不保證支出上限。每次喚醒的成本會隨模型、重試、輸出量和快取命中而不同。約 300k context 一次，只是少量的既有觀察（`docs/configuration.md:147`），不是每個 round 的固定量。
  - 達到上限時以 `partial` 結束，要先調高上限才能 `resume`。

  預設值維持 0：改成非零，會讓現有使用者的 run 中途停下。
- **影響**：同 3.1。**需另開 spec 嗎**：不需要。
- **金額預算本身**：延後。adapter 目前沒有解析 input token 和費用欄位；runtime 有沒有提供這些欄位、訂閱方案怎麼計價，都還沒確認。若要做，應該先另開一份調查。

### 3.3（延後評估，不提設計）reviewer／debugger 變更的整合政策
- **現況**：「reviewer 只審」「debugger 不修」只寫在 prompt；整合時不看角色（`src/run-session.ts:871-890`）。
- **要分清兩件事**：「這個角色的變更不整合」和「這個角色的 repo 是唯讀」是兩種不同的政策。前者仍然允許 reviewer 在自己的 checkout 編輯和執行指令，所以不能保證後者。如果拿既有的 blocked-integration 路徑來實作前者，還會讓 `completed` 降為 `blocked`（`src/run-outcome.ts:21-23`）。另外，合法的診斷產出（例如 debugger 寫的報告文件）怎麼處理，也必須先定義清楚。
- **觀察**：現存資料中沒有 reviewer 帶檔案的 integrate 事件；但進行中的 spec 25 run 裡，`runtime-debugger` 整合過 `docs/sandbox-blocks.md`（附錄 A）。那是該任務要求的診斷文件，不算違規。
- **建議**：現在不做，也不提新欄位。spec 25（per-agent sandbox allowances）在同一塊 schema 與政策區域，等它落地後再看。可能的重新評估條件：出現**不該被整合**的 reviewer 或 debugger 變更。

## 4. 不建議採納的項目與理由

| 項目 | 理由 |
|---|---|
| 在 run 內加入由程式執行的硬 gate（`done` 前跑 test／lint／typecheck，看 exit code） | 現有 adapter 把 sandbox 交給 runtime（`src/adapters/claude.ts:43-45`、`src/adapters/codex.ts:62-79`）。dispatcher 本身用使用者權限執行，直接在 dispatcher 裡跑專案指令，就等於在 sandbox 外執行 agent 寫的程式碼，**這個做法不可採**。理論上可以另建一個 sandbox 或容器內的確定性 runner，只讀 exit code、不信任 LLM 的文字回報。但那需要定義 runner 的輸入、結果的可信度、平台支援（Linux 沒有 bwrap 時怎麼辦），以及在 sandbox 內已知會失敗的測試怎麼處理（本機曾觀察到約 7 個，跟環境有關）。**目前成本高於需要，所以不建議**。在那之前，品質檢查靠 PR 上的 CI 和人工 merge；結果分支開 PR 才會觸發 CI（`ci.yml:3-6`），是否設為 required check：未確認。 |
| 由程式強制審查最多 2 輪 | 審查結論是自由文字，dispatcher 不解析內容；它也不知道哪些信屬於「同一個變更」。要強制，就得新增結構化的 verdict 和計數器。規則本身是「超過 2 輪由 lead 決定」，強行擋下第三輪，可能把真正的 blocker 也擋掉。整個 run 的上限已經有 `max_rounds`。實際有沒有超過 2 輪：未統計（未確認）。 |
| 4 問題過濾做成 lead 的 prompt 規則 | lead 被喚醒時已經在團隊 run 裡，改成給使用者看的文件（§3.1）即可。 |
| 定期用注入缺陷的方式抽查 reviewer 是否腐化 | 不是做不到：例如在離線、公開的測試分支注入已知缺陷，看 reviewer 能不能抓到。但這要多花喚醒，也要維護缺陷樣本。目前沒有自動彙總的審查結論指標；既有的人工分類（`docs/analysis-context-sharing-need.md:147`：15 次要求修改裡，1 次觀察到、1 次推論和缺 context 有關）只能當探索性資料。**等有實際需要時再評估**。 |
| 新增 lessons／watch list 機制 | records／lessons、memory 精煉、decision 裡的重新評估條件已經涵蓋同樣的功能；多一種 record，每次喚醒的 prompt 就更長。不過要注意，寫入這些內容目前只靠 prompt（§2 F）。 |
| 把流程改成固定的工作流程（實作→審查→QA 寫死） | 文章摘要並沒有要求靜態圖：A 允許條件式路由，H 也包含 orchestrator-workers，動態信箱可以看成圖的一種。固定流程會犧牲 lead 的彈性，例如小修可跳過 QA（`src/prompt.ts:27`）、標 tier、開並行 instance，所以現在不採用。必要的確定性檢查（`can_message`、衝突時拒絕整合、`done` 契約）可以和動態路由並存，而且已經存在。 |
| 進一步縮減注入給每個 agent 的 context（更嚴格的白名單） | 本專案先前的取捨（`docs/analysis-context-sharing-need.md`）是不擴大共享。那份觀察沒有找到 context 過多的證據，但也不代表 context 一定沒有過多；目前沒有資料支持再縮減。至於讀取權限隔離，那是另一個問題（安全），和 prompt 裡給什麼不同，不在本次範圍。 |
| 排程、webhook、雲端 routine | 這超出本機 CLI 的範圍；需要排程的人可以自己用 cron 跑 `npx agent-lyceum run`。文章「至少 5 次可靠的手動 run 才升級」的建議，應該由使用者自己決定要不要遵循，工具不必強制。 |
| 信心 < 0.7 就升級給人 | runtime 沒有提供信心值。升級給人已經有 `ask` 這條路徑。 |

## 5. 文章本身的可疑之處或不適用前提

- **90.2%**：出處是 Anthropic〈How we built our multi-agent research system〉（https://www.anthropic.com/research/multi-agent-research-system）。原文說的是：在 Anthropic **內部的研究型評測**中，Opus 4 當 lead、Sonnet 4 當 subagent 的多 agent 系統，表現比單一 Opus 4 高 90.2%。同一篇文章也說，agent 的 token 用量約為一般聊天的 4 倍，多 agent 系統約為 15 倍（比較對象是聊天，不是單 agent 研究系統）；並指出彼此依賴多的工作（例如多數程式開發）比較不適合多 agent。
  - 這是廠商自己公布的結果，本次沒有重現。
  - 它也不能證明效益**只**來自「隔離 context」。
  - 那個評測的任務類型、基準和指標都和本專案不同，**不能外推**；本報告不引用這個數字支持任何設計。
- **2–3 倍品質提升**：可能的原始貼文（https://x.com/bcherny/status/2007179861115511237）開啟時回傳 403，原文措辭和方法都**未確認**。repo 內也沒有能證明品質提升倍數的受控評估，不能套用。
- **靜態圖 vs 動態信箱**：文章摘要沒有規定要用靜態圖（見 §4）。差別在於：本專案把確定性檢查放在 dispatcher 的收信和整合層，下一步怎麼走則由 lead 動態決定。這兩者可以並存。
- **「硬 gate 由系統跑」**：在 agent-lyceum，這個前提要先有一個隔離的指令 runner 才成立（§4 第一列），文章沒有討論這個成本。

## 6. 評估範圍說明

| 面向 | 本次狀況 |
|---|---|
| 格式與相容 | 不改任何格式，也沒有 migration。§3.1、§3.2 只動文件；§3.3 如果將來要做，會動到 schema，需要另開 spec。 |
| 取消與部分完成 | 不適用。§3.2 只說明既有的 `partial`／`resume` 行為。 |
| 平台 | 寫入限制的強度依平台而定（macOS 有 OS sandbox；Linux 沒有 bwrap、Windows、Codex 時，等級較低，見 `src/policy.ts:186-203`）。§4 的 runner 成本有一部分正是來自這裡。 |
| 測試與可維護性 | 本次沒有改程式，也沒有跑測試；只跑了 `npm run check:docs`。 |
| 可診斷性 | 附錄 A 的數字取自 `state.json`（rounds、wakes、token 欄位）與 `log.jsonl`（`integrate` 事件）。這些欄位已經可以支撐 §3.3 的重新評估條件。 |
| 後續分工 | 實作：無。驗證：只需要 `check:docs`。§3.1／§3.2 要另外派工，做成雙語文件變更並經過文件審查；本次沒有授權。 |

## 附錄 A：本機 run 資料的取樣方法

以下兩段指令只讀取資料，取樣時間 2026-10-27。`$RUNS=~/agent-lyceum-config/projects/agent-lyceum/runs`，當時有 12 份 `state.json`。

```bash
RUNS=~/agent-lyceum-config/projects/agent-lyceum/runs
# 每個 run 的喚醒數、lead 喚醒數、token 欄位
node -e 'const fs=require("fs"),p=require("path"),R=process.argv[1];
for(const d of fs.readdirSync(R).sort()){const f=p.join(R,d,"state.json");if(!fs.existsSync(f))continue;
const s=JSON.parse(fs.readFileSync(f,"utf8")),w=s.wakes||[];
console.log(d,"rounds",s.rounds,"wakes",w.length,"lead",w.filter(x=>x.agent==="tech-lead").length,"out",s.output_tokens,"cache_read",s.cache_read_tokens)}' "$RUNS"
# reviewer／debugger 帶有檔案的 integrate 事件
node -e 'const fs=require("fs"),p=require("path"),R=process.argv[1];
for(const d of fs.readdirSync(R).sort()){const f=p.join(R,d,"log.jsonl");if(!fs.existsSync(f))continue;
for(const l of fs.readFileSync(f,"utf8").split("\n")){if(!l.includes("\"integrate\""))continue;let e;try{e=JSON.parse(l)}catch{continue}
if(/reviewer|debugger/.test(e.agent||"")&&(e.files||[]).length)console.log(d,e.agent,JSON.stringify(e.files))}}' "$RUNS"
```

當時的結果：
- `20261025T072434377Z-…`：rounds 65、wakes 65、lead 27、output 853,648、cache_read 94,694,908。
- 已結束的 run 都是 rounds = wakes。兩個進行中的 run 差 1，因為當下正有一次喚醒在執行。
- 第二段只列出 `20261027T031319310Z-…`（spec 25 run）的 `runtime-debugger`：`A docs/sandbox-blocks.md`、`M docs/sandbox-blocks.md`；沒有任何 reviewer。

這些數字只代表這台機器上現存的 run，不是通則。
