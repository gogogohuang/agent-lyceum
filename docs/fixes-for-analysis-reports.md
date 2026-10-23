# 分析報告的修正清單（給剛接觸 AI agent 的人）

agent-lyceum 是一個命令列工具：你交一個任務，它叫一組 AI agent（lead 帶著幾個 member）在你的 git repo 裡分工做完，agent 之間用「檔案信箱」互相寄信。
這份文件處理三份已存在的文件：

- **評估報告** = `docs/review-analysis-reports.md`。它評估下面兩份報告，列出 I-01…I-31 共 31 個改善項目。
- **R1** = `docs/analysis-agent-context-and-mail.md`：agent 的 context 與 mail 怎麼運作。
- **R2** = `docs/analysis-context-sharing-need.md`：要不要讓 agent 之間廣泛共享 context，以及 G、F 兩個小改善。

評估報告本身又被另外三位成員重新驗證過一輪（對照程式碼與歷次 run 資料）。這份清單只記錄「驗證之後，哪些地方要改」。
使用方式：先看〈名詞小字典〉；〈審查結論統計〉看全貌；要動手時，A 修評估報告、B 修 R1／R2、C 是程式或規格的建議（**本次都不實作**）；每一條都自成一體，可單獨閱讀。
本文件只寫建議，沒有修改任何程式、測試或既有文件。

## 名詞小字典

- **context（上下文）**：agent 這一次動手前「看得到的所有資料」，包含提示文字、信件、記憶檔。看不到的，它就不知道。
- **prompt（提示）**：送給模型的那一大段文字，描述這次要做什麼。
- **system prompt（系統提示）**：prompt 裡「身分與規矩」的部分（你是誰、不可以做什麼），通常每次都一樣。
- **session / resume（對話延續）**：session 是模型端保存的一段對話；resume 是「接著上次的 session 繼續」，而不是從空白開始。
- **wake（喚醒）**：dispatcher（調度程式）叫一個 agent 起來工作一次。agent 做完就睡，下次被喚醒再來。
- **attempt（一次嘗試）**：為某封信喚醒 agent 的「一次實際執行」，會留下紀錄（`a1`、`a2`…）。**retry（重試）** = 同一個模型再試一次；**fallback（備援）** = 換另一個模型再試。
- **mail / outbox / inbox**：agent 之間的信。agent 把信寫到自己的 outbox（寄件匣），dispatcher 檢查後搬進對方的 inbox（收件匣）。
- **lead / member**：lead 是組長，拆工並決定何時結束（送 `done`）；member 是被分派工作的成員。
- **worktree**：同一個 git repo 的另一份獨立工作目錄與分支，讓多個 agent 或多個 run 同時改檔而不互相踩到。
- **guard（守衛）**：每次喚醒結束後檢查「受保護的檔案」（`AGENT.md`、`COMMON.md`、記錄檔等）有沒有被不該改的人改過，改了就還原。
- **COMMON.md**：整個專案共用的筆記，每次喚醒都會塞進 prompt，由 lead 維護。
- **records（記錄）**：`shared/common/records/` 下，一個檔案一則的「決策」與「教訓」；harness（執行框架）只把有效的、最新的放進 prompt（每種 6 KB）。
- **task memory（任務記憶）**：只屬於這一次任務的記憶資料夾；任務清除（`clear`）時會被刪掉。
- **`_shared`**：task memory 裡給大家共用的資料夾（本次驗證的材料就放在這裡）。
- **sandbox（沙箱）**：作業系統層級的限制，限定 agent 只能寫哪些資料夾。它限制「寫」，不限制「讀」。
- **runtime（執行環境）**：實際跑 agent 的程式，這裡是 `claude` 或 `codex` 兩種。
- **`retryPrompt`**：重試時改用的提示文字（`src/run-session.ts:45` 附近），告訴 agent「上次失敗了」。
- **`beginAttempt`**：開始一次嘗試並記錄的函式（`src/message-store.ts`）。
- **park（暫存收起）**：把失敗嘗試留在 outbox 的草稿先收起來、不寄出，免得半成品被當成正式信件。
- **G 與 F**：R2 提出的兩個小改善。G = 把「進度寫進 task memory」的提示文字改得更明確；F = 重做時，把失敗那次的草稿（已 park）放進新的 prompt。
- **snapshot／snapshot ref**：每個 run 開始時，agent-lyceum 會在 git 裡替當時的程式碼存一個暫時的 commit（snapshot），並用一個特殊的名字（ref，`refs/agent-lyceum/<run>/*`）指著它。run 被 `clear` 後這些 ref 會被刪掉，commit 也就找不到了，所以它不是穩定的基準。
- **claim（認領）**：dispatcher 把某幾封信交給某個 agent 處理時留下的一筆紀錄（`mail/claims/*.json`），記著「哪個 agent 正在處理哪些信」。中斷後若重做，會有第二個 claim。
- **follow-up（追加任務）**：run 結束後，使用者再給同一個 run 一個新任務，讓原本那組 agent 接著做。
- **語料**：本文件拿來數「幾次、幾個 run、幾封信」的那批既有 run 資料：依 run id 排序的前 17 個 run（147 封信，最大一封 15,357 B），即全部早於 d52bff（040459）的 run。d52bff、8e32b2（評估報告所在的 run）與進行中的 run 不計。語料小、來自單一專案（自己開發自己），所以數字只是方向，不是量測。如果某處改用別的範圍（例如全部 19 個非當前 run），該處會明說。
- **髒窗口**：agent 已經把受保護的檔案改壞，但 guard 還沒把它還原的那一小段時間；這段時間內別的 agent 可能讀到壞內容。
- **fake runtime／fake invoker（假執行環境）**：測試用的假程式，代替真的 `claude`／`codex`，不花模型呼叫，行為由測試寫死。
- **seed mail（種子信）**：run 開始時，dispatcher 把使用者的任務包成第一封信寄給 lead（`run-session.ts:283-285`）。
- **Open items**：agent 回信時固定要有的一個段落，列「還沒做完或沒驗證的事」。
- **`status --json`**：`agent-lyceum status` 的機器可讀輸出，`plugins/status-monitor` 依賴它，格式不能變。
- **已驗證／推論**：已驗證 = 有指令輸出或 `檔案:行號` 為證；推論 = 合理但還沒親眼確認。每條都標明，推論要寫還缺什麼。

縮寫：**v1、v2、v3** = 三份驗證紀錄（runtime-debugger、cli-architect、code-explorer 各一份，放在本次任務的 task memory `_shared/`，`clear` 後會消失）。所以每條都直接給程式碼的 `檔案:行號`，不要只靠 v1–v3。

## 審查結論統計

對 I-01…I-31 的「整項」判定：**成立 22、部分成立 9、不成立 0、無法驗證 0**。

- 「成立」的意思是：**評估報告指出的問題在 base commit 確實存在**。這不表示評估報告的每一句話、每一個修法都對。
- 很多項目的「子論點」或「建議修法」仍然是錯的，或引用的行號漂移、標籤標錯。這些放在 **A（評估報告本身的錯誤）** 與〈被推翻的項目〉。
- 「部分成立」= 問題只在某些條件下存在，或核心前提被高估。

| 編號 | 判定 | 一句話理由 | 證據位置 |
|---|---|---|---|
| I-01 | 成立 | 中斷後重做時，「第幾次重試」的計數恆為 0，所以重試用的提示文字（`retryPrompt`）不會出現，G 的後半句對主要事件無效 | `run-session.ts:440`、`fallback.ts:204`；d041c8 `log.jsonl` 第 22 行 `"attempt":0` |
| I-02 | 成立 | 提示只在喚醒開頭組一次，同一次喚醒內的重試拿不到剛收起來的草稿 | `run-session.ts:379,440,493,498` |
| I-03 | 部分成立 | 草稿「重複貼」的情況確實可能發生，但「失敗也存下對話編號」只在失敗結果帶回編號時為真；逾時／取消不帶 | `run-session.ts:449`、`process-runner.ts:174,216-217` |
| I-04 | 成立 | `retryPrompt` 說「信被丟棄、請重寄」，與 F 的「草稿已收起」矛盾 | `run-session.ts:45` |
| I-05 | 成立 | 7 個停在 `started` 的嘗試，都是 run 死在那次嘗試、之後都沒有再 resume，不是 F 的缺口（現已可標已驗證） | 各 run `mail/attempts/*.json` 與 `log.jsonl` 尾端（v1、v3 腳本） |
| I-06 | 部分成立 | G 只改措辭難改變行為；但「Memory 段已有同要求」說過頭——有重疊、沒有「何時寫」 | `prompt.ts:213-215` |
| I-07 | 成立 | R1／R2 缺 team／`run --agent`／`call` 三模式矩陣，G 適用面不明 | `call.ts:59-63`、`solo.ts:15-20`、`policy.ts:120-125` |
| I-08 | 成立 | 兩個 run 同時跑時，A 的守衛會把 B 合法改的共用檔還原掉（單元重現成立，端到端未跑） | `guard.ts:84-90,107-133`、`run-session.ts:593,926`、`project-lock.ts:299-305` |
| I-09 | 成立 | R1／R2 缺 ask 回答流向：答案只回給提問者，`--assume-defaults` 記為 by=default | `run-session.ts:708-723`、`ask-reply.ts:196-200`、`config.ts:239` |
| I-10 | 部分成立 | 缺「>16 KiB 任務只給指示＋首十行」的說明；但「漏 COMMON 注入」說錯，R1 有寫，真缺口在 R1:96 | `task.ts:5-6,69-79`、`run-session.ts:283-285` |
| I-11 | 成立 | tidy／clear 的 context 生命週期未交代；tidy 看不到 COMMON，clear 會刪 `_shared` | `memory-tidy.ts:367-375`、`run-cleanup.ts:92-94` |
| I-12 | 部分成立 | follow-up 的 "fresh sessions" 只對 `resume:false`（member 預設）為真；lead 預設保留 session | `prompt.ts:47`、`run-session.ts:209,222-235`、`config.ts:236` |
| I-13 | 成立 | R2:76「只比對交接索引一個檔」寫得不對；守衛另外還保護固定檔與記錄樹，且記錄樹上層是 symlink（捷徑檔）時整批不保護 | `guard.ts:47-54,107-133`（:110） |
| I-14 | 部分成立 | 「Claude 載入 CLAUDE.md」可由 flag 確認，但摘要把「未實測」限定詞丟了；還漏 user 層級來源 | `claude.ts:68-82`、`claude --help` |
| I-15 | 成立 | 他人 worktree／memory 在 Claude 下可讀（含沙箱內），已實測；R2:94,174 不是這個問題 | `policy.ts:148,158`；`git -C` 與 `head` 實測 |
| I-16 | 成立 | R1 §6 十三項建議無優先度、狀態、owner；R2 無處置表 | R1:162-176；R2 §3 只評 B–I |
| I-17 | 成立 | R1 §6 #12 成立條件未寫；但條件是「無 OS sandbox，或 Codex 的 repo `CLAUDE.md`／`AGENTS.md`（事後還原，`policy.ts:200-201`）」，不是 Codex＋`can_edit_agent_md` | `run-session.ts:593`、`worktree.ts:541`、`policy.ts:196-203` |
| I-18 | 部分成立 | 提示 notes 已部分實作；但「缺 `can_edit_agent_md` 警告」是錯的，`policy.ts:203` 已有 | `policy.ts:196-203`、`validate.ts:132`、`cli.ts:557` |
| I-19 | 部分成立 | 備援 note 在備援已有自己的 session 時不準屬實；但「R1／R2 均未提」錯（R1:41 有）、原因也講錯 | `run-session.ts:413,423,429,449` |
| I-20 | 成立 | mail 內文原文進 prompt、無長度上限；但語料中沒有超大信，優先度應為中 | `prompt.ts:304`、`mailbox.ts:174,281` |
| I-21 | 成立 | `done` 只檢查 records 預算，不檢查 COMMON 大小；「直接擋 done」風險高 | `mailbox.ts:307-322` |
| I-22 | 成立 | `done` 前沒有檢查被拒信（`rejected/`），lead 可能帶著被拒信結束；語料中 0 次 | `run-session.ts:663-665` |
| I-23 | 成立 | Rules 沒寫 context 衝突時的優先順序；評估報告提議的順序自相矛盾 | `prompt.ts:218-223` |
| I-24 | 成立 | `paths.common` 無人讀取（死欄位）；刪除修法不完整，`call.ts:75` 也在寫 | `paths.ts:65`、`call.ts:75` |
| I-25 | 部分成立 | R2 的基準 hash 是 run snapshot；但行號與修法文字都有誤（修法又把 snapshot 叫 HEAD） | `git merge-base --is-ancestor` rc=1；R2:7 |
| I-26 | 成立 | 17 run／147 mail 的排除規則正文未寫；修法寫的「run 052756 前」是錯的 | v3 重算：前 17 個 run id、全部早於 d52bff |
| I-27 | 成立 | 「13 個 run 的 61 封回覆」實為 11 個 run；原因已找到（證據檔少算排除的 run） | 證據檔第 77 行；v3 計數 |
| I-28 | 成立 | 「重新探索環境」是人工分類，grep 結果 31–48 而非 35–40，且腳本不在 repo | v3 的 grep 重算 |
| I-29 | 成立 | request-changes 15 次中 8 次集中在兩個 run；計數已驗證，「sandbox 影響」仍是推論 | v3 每 run 計數 |
| I-30 | 成立 | 事件編號 a1／c1／e1 全靠 repo 外的證據檔，`clear` 後消失；兩份標註慣例不同 | R2:6、R2:9；`how-it-works.md:43` |
| I-31 | 部分成立 | R1 §6 #10 自我撤回、R2:167 殘留屬實；但「9 條、>400 字」兩個數字錯 | R1:7-16（10 條）、R1:41（386 字）、R1:173、R2:167 |

## A. 評估報告本身的錯誤或不準確

**導讀**：評估報告（`docs/review-analysis-reports.md`）是拿來「挑別人的錯」的，但它自己也有錯：有些論點事實不對，有些修法選得不好，有些行號已經漂移，有些標籤（已驗證／推論）貼錯。
不修的話，後面的人會拿這份「評估」當事實再傳下去。A 類全部是**改文件**（只改評估報告），本次只寫建議。
同類小錯合併成一條；每條的細節（原本怎麼說→實際怎樣→證據）另見〈被推翻的項目〉。

### A-01 「失敗也寫回 sessionId」與「兩份均漏 lead 重試」說過頭

1. **編號與標題**：A-01（對應 §2 最後一段、I-03、§7a「F 與 resume」）。白話：評估報告說「失敗的嘗試也會把 session id 存回去」，其實逾時和取消不會。
2. **要改哪裡**：`docs/review-analysis-reports.md` §2 最後一段、§7a「F 與 resume」列、I-03 列。**改文件**；本次只寫建議。程式依據 `src/process-runner.ts:174,214,216-217`、`src/run-session.ts:449`。
3. **為什麼要修正**：session 好比「與模型的對話紀錄本」。逾時被強制中斷時，程式根本沒拿到那本的編號，所以重試接上的是「上一次成功那一本」，不是失敗的那本。評估報告把它寫成一律會接上失敗的 session，F 的風險就被誇大或描述錯。另外它說「R1、R2 兩份都漏了 lead 重試會 resume」，但 R1:41 已寫（「同一個模型重試則沿用該 key 的 session」）。
4. **怎麼修正**：
   - 改前：「失敗也寫回 sessionId，所以 lead 重試已 resume 失敗的 session。」
   - 改後：「只有失敗結果帶回 session id 時才寫回（Claude 印出結果 JSON、Codex 出現 `thread_id`）；逾時、取消、spawn 失敗都沒有 id（`process-runner.ts:174,214,216-217`），此時重試接的是上一次成功 wake 的 session。失敗那次的 turns 是否存在該 session 內，取決於 runtime（無法驗證）。」
   - 刪掉「R1／R2 均漏」，改成「R1:41 已說明同模型重試沿用 session（推論，未驗證）」。
5. **怎麼確認修好了**：`sed -n '174p;214,217p' src/process-runner.ts` 應看到 cancelled、spawn error、timeout 三處回傳都沒有 `sessionId` 欄位；`grep -n "sessionId" src/process-runner.ts` 在這三個分支不應命中。
6. **優先度／把握**：中；已驗證（靜態讀碼）。「失敗 turns 是否留在 session」是推論，還缺真實 runtime 實驗（見〈還沒解答的問題〉）。
7. **相依**：無；A-05（I-03 修法）與 C-03 以此為前提，先做這條。

### A-02 備援（fallback）「fresh session」的原因與修法講錯

1. **編號與標題**：A-02（§2「:413 不準確」、I-19、§7b #10）。白話：評估報告對的結論（備援那句提示有時不準），但理由講錯、修法有一半不可取。
2. **要改哪裡**：`docs/review-analysis-reports.md` §2 最後一段、I-19 列、§7b #10 列。**改文件**；程式面見 C-07。程式依據 `run-session.ts:413,423,429,449`。
3. **為什麼要修正**：評估報告說 `:413` 不準，因為「同一個候選重試會沿用 session」。但 `:413` 談的是**備援候選**，它的 session key 是 `agent@key`（`:423`），與同候選重試是不同路徑。真正不準的時機是：備援已經有自己的 session（本次 run 較早的備援，或 follow-up 前留下的），且 resume 開著。理由講錯，後人照著改會改錯地方。它提的修法「備援一律不帶 sessionId」也不可取：lead 若在長冷卻期間一直停在備援，每次喚醒都失去連續性。
4. **怎麼修正**：
   - 改前：「:413 不準，因為同一候選重試會沿用 session。」
   - 改後：「:413 在第一次切到備援時正確（`state.sessions['agent@key']` 尚無值）；只有備援已持有自己的 session 且 `agent.resume` 為真時才不準（R1:41 的原因）。」
   - 刪掉「備援一律不帶 sessionId」，換成 C-07 的做法。
5. **怎麼確認修好了**：`sed -n '413p;423p' src/run-session.ts` 確認 413 是備援 note、423 是 `agent@key`；新文字不再出現「同候選重試」作為 :413 的理由。
6. **優先度／把握**：低；已驗證。
7. **相依**：無。

### A-03 §3 #12／I-17「Codex＋`can_edit_agent_md` 時成立」的條件是錯的

1. **編號與標題**：A-03（I-17、§3「並行 wake 讀到髒檔」）。白話：評估報告寫錯了「什麼情況下會讀到髒檔」。
2. **要改哪裡**：`docs/review-analysis-reports.md` I-17 列、§3 對應列；並把引用 `worktree.ts:500` 改為 `:541`。**改文件**；本次只寫建議。依據 `policy.ts:196-203`、`worktree.ts:541`、`codex.ts:7-11`。
3. **為什麼要修正**：先講白話：「髒窗口」是指 agent 先把受保護的檔案寫壞、之後 guard 才還原的那一小段時間；問題是「什麼設定下才會有這段時間」。評估報告說「僅無 OS sandbox，或 Codex＋`can_edit_agent_md` 時成立」。但有 `can_edit_agent_md` 的 agent 是「被授權」改這些檔的人（授權判斷在 `guard.ts:87`，`mayEditProtected`），guard 不會還原它的修改，也就沒有「還原前的髒窗口」。有 OS 沙箱時，寫入多半在作業系統層就被擋下，沒有窗口；但 repo 的 `CLAUDE.md`／`AGENTS.md` 對 Codex 即使有 OS 沙箱也只能事後偵測並還原（`policy.ts:200-201`），所以這一類檔案不能說「直接被擋」。寫錯條件，讀者會去查不相關的設定。另外 `worktree.ts:500` 只是常數 `PROTECTED_NAMES`，真正擋整合的檢查在 `:541`。
4. **怎麼修正**：
   - 改前：「僅無 OS sandbox，或 Codex＋`can_edit_agent_md` 時成立。」
   - 改後：「髒窗口存在於兩種情況：沒有 OS sandbox 時的所有受保護檔案；以及 Codex 的 repo `CLAUDE.md`／`AGENTS.md`（即使有 OS sandbox 也是事後偵測還原，`policy.ts:200-201`）。有 OS sandbox 時，Claude 對受保護檔案、Codex 對 repo 指示檔以外的檔案，寫入由 sandbox 直接擋下。被授權者（`can_edit_agent_md`，`guard.ts:87`）的修改不會被還原，也不算髒窗口。Codex＋`can_edit_agent_md` 是另一件事（可寫範圍變寬，見 C-14）。」
   - 引用改 `worktree.ts:541`。
5. **怎麼確認修好了**：`sed -n '541p' src/worktree.ts` 看到 `PROTECTED_NAMES.includes(p)`；`sed -n '196,203p' src/policy.ts` 只是備註（notes），其中 :200-201 寫明 Codex 的 repo 指示檔為 `post-hoc`；授權放行的程式在 `sed -n '84,90p' src/guard.ts`（`mayEditProtected`，:87）。
6. **優先度／把握**：中；已驗證（靜態；實際交錯為推論，需真實並行 run）。
7. **相依**：無。

### A-04 「缺 `can_edit_agent_md` 警告」是錯的（I-18、§7b #11）

1. **編號與標題**：A-04。白話：評估報告說某個警告沒有，其實早就有了。
2. **要改哪裡**：`docs/review-analysis-reports.md` I-18 列、§7b #11 列。**改文件**。依據 `src/policy.ts:203`：`can_edit_agent_md widens Codex writable roots to whole agent directories.`
3. **為什麼要修正**：照著錯誤描述會去「新增」一個重複的警告。真正缺的是：(a) Claude 在沒有 OS 沙箱又開 `can_edit_agent_md` 時的警告；(b) 勸人避免這個組合的說明。
4. **怎麼修正**：
   - 改前：「已有 notes，只缺 `can_edit_agent_md` 警告。」
   - 改後：「Codex 的 `can_edit_agent_md` 警告已有（`policy.ts:203`）；缺的是：沒有 OS 沙箱時對 Claude 的對應警告，以及『避免使用』的建議。」
5. **怎麼確認修好了**：`grep -n "can_edit_agent_md widens" src/policy.ts` 應命中 203 行；新文字不再說「缺警告」。
6. **優先度／把握**：低；已驗證。
7. **相依**：無。

### A-05 I-03 的修法規則 `sessionId === undefined` 不可取

1. **編號與標題**：A-05（I-03 的建議）。白話：評估報告建議「只有沒有 session id 時才注入草稿」，結果會讓 lead 完全收不到草稿。
2. **要改哪裡**：`docs/review-analysis-reports.md` I-03「建議」欄與 §9 #2。**改文件**。程式依據 `run-session.ts:423,429,449`、`config.ts:236`。
3. **為什麼要修正**：lead 預設 `resume: true`（`config.ts:236`），幾乎總是帶著 session id，這條規則等於替 lead 把 F 關掉。語料裡僅有的兩個 F 案例之一（2d1b53：lead 共 3 次逾時，分屬兩個 claim，其中一次 park 了 `done.md`）就是 lead。
4. **怎麼修正**：
   - 改前：「規格明訂：只在 `sessionId === undefined` 時注入。」
   - 改後：「只在『失敗的那次嘗試自己回傳了 session id』時略過注入（草稿多半已在該 session 內）；沒有回傳 id（逾時、取消）時照常注入。」
5. **怎麼確認修好了**：文字中不再出現 `sessionId === undefined`；改後規則套用 2d1b53 的三次逾時（逾時不帶 session id），會判為「應注入」。
6. **優先度／把握**：中；已驗證（靜態；規則在真實 runtime 的效果為推論）。
7. **相依**：先做 A-01。

### A-06 三個建議修法選得不好（I-20、I-21、I-23）

1. **編號與標題**：A-06。白話：評估報告對「問題」判斷對了，但這三個「怎麼修」會帶來新問題。
2. **要改哪裡**：`docs/review-analysis-reports.md` I-20、I-21、I-23 的「建議」欄。**改文件**；實作見 C-08、C-09、C-12。
3. **為什麼要修正**：
   - I-20「`routeOutboxes` 超長就退回」：多花一次喚醒、與格式拒收與重複檢查互相影響，也管不到 dispatcher 自己寫的信（失敗、整合、follow-up）。
   - I-21「COMMON 超過 8 KB 就退回 `done`」：既有專案升級後 `done` 立刻被擋；`run --agent` 的單人模式下 agent 同時是 lead 卻不能寫 records／COMMON，會永遠完成不了。
   - I-23「lead task > COMMON > records > 個人 memory，順序由 lead 決定」：自己矛盾（固定順序卻交給 lead 決定）、漏了 AGENT.md／CLAUDE.md、而且把任務放在 Rules 之上，等於讓任務能蓋過寫入限制。
4. **怎麼修正**：
   - I-20 改前：「`routeOutboxes` 超長就退回」；改後：「prompt 端截斷＋附檔案路徑」，沿用 `task.ts:6` 的 16 KiB 模式。
   - I-21 改前：「COMMON 超過 8 KB 就退回 `done`」；改後：「`done` 時只附非阻擋的提醒，`status` 對 COMMON 過大給警告」。
   - I-23 改前：「lead task > COMMON > records > 個人 memory，順序由 lead 決定」；改後：「Rules 永遠最優先；內容衝突時依 lead 最新的明確指示，並在 Open items 回報衝突」。
5. **怎麼確認修好了**：三列「建議」欄的文字與 C-08、C-09、C-12 一致。
6. **優先度／把握**：中；已驗證（v2 逐項論證；副作用估計為推論）。
7. **相依**：無。

### A-07 對 R1／R2 的幾個指控說過頭（I-10、I-02、I-06）

1. **編號與標題**：A-07。白話：評估報告說「R1 漏了某件事」，但 R1 其實有寫，或 R2 只是沒寫、並非寫錯。
2. **要改哪裡**：`docs/review-analysis-reports.md` I-10、I-02、I-06 列。**改文件**。依據：R1:7,22,84,96；R2:165；`prompt.ts:213-215`。
3. **為什麼要修正**：
   - I-10 說「漏 COMMON 注入」：R1:7,22,84 都有描述。真缺口是 R1:96「跨 run 只能靠 global／project memory 與 records」沒提 COMMON。
   - I-02 說「R2:165 的呼叫點寫錯」：R2:165 只說「兩處呼叫點」，沒有指名是哪兩處——是「未規定」，不是「規定錯了」。「要在 `beginAttempt` 之前選」也不是必要條件：新 attempt 狀態是 `started`，候選的篩選條件是 `failed`，不會選到自己。
   - I-06 說「Memory 段已有同要求」：`prompt.ts:213` 只說「進度放 task memory」，沒說**何時**寫、也沒說被中斷後會從它重來；只是重疊，不是相同。
4. **怎麼修正**：
   - I-10 改前：「R1 漏 COMMON 注入」，引用 `task.ts:55-78`；改後：「R1:96 漏列 COMMON；`task.ts` 引用應為 69-79」。
   - I-02 改前：「R2:165 的呼叫點寫錯，必須在 `beginAttempt` 之前選」；改後：「R2:165 未指名呼叫點（規格空缺）；不要求在 `beginAttempt` 之前選」。
   - I-06 改前：「Memory 段已有同要求」；改後：「Memory 段與 G 重疊，但缺少『何時寫』與『被中斷後會從它重來』」。
5. **怎麼確認修好了**：`sed -n '7p;96p' docs/analysis-agent-context-and-mail.md` 可核對 R1 內容；`sed -n '165p' docs/analysis-context-sharing-need.md` 確認 R2:165 無指名呼叫點。
6. **優先度／把握**：低；已驗證。
7. **相依**：無。

### A-08 標籤（已驗證／推論）貼錯：該升的沒升、不該標已驗證的標了

1. **編號與標題**：A-08（I-05、§3 metadata park、§3 timeout 0 B、I-08、I-14、I-26、I-29、I-31、I-03）。
2. **要改哪裡**：`docs/review-analysis-reports.md` 上述各列與結論摘要第 10 行。**改文件**。
3. **為什麼要修正**：標籤是讀者決定「能不能直接相信」的依據。標錯有兩個方向：
   - 該升為已驗證：I-05（7 個 `started` 的 attempt，各自都是該 run 的最後一個事件，之後都沒有再 resume）、§3「metadata 漏記 park」（18 個失敗 attempt 的 `parked` 與 `outbox/` 完全吻合）、§3「timeout stdout 0 B」（`log/stdout.log` 大小確為 0）。一個腳本就能定案，卻標推論。
   - I-08 由「推論」改「機制已驗證（單元重現），端到端未跑」。
   - 不該標已驗證：I-26（偏向舊 run 是推論）、I-29（sandbox 影響是推論，只有計數已驗證）、I-31（數字是錯的）、I-03（問題欄寫推論，把握欄卻寫已驗證）。
   - 摘要第 10 行「Claude 預設載入 CLAUDE.md」丟掉了 §3 的限定詞「已驗證 flag，未實測」。
4. **怎麼修正**：
   - 改前：I-05、metadata park、timeout 0 B 標「推論／未驗證」；I-26、I-29、I-31、I-03 標「已驗證」；I-14 摘要無限定詞。
   - 改後：前三者升為「已驗證」；後四者改標「推論」（I-31 直接改數字）；I-14 摘要補回「（Claude：flag 已驗證，repo 層級未實測；Codex 無法驗證）」。可複製的驗證（只算語料的前 17 個 run id，後面的 run 不計）：
   ```
   python3 -I - <<'PY'   # 在 ~/agent-lyceum-config/projects/agent-lyceum 下執行
   import os,glob,json,collections
   R="runs"
   runs=sorted(d for d in os.listdir(R) if os.path.isdir(os.path.join(R,d)))[:17]
   c=collections.Counter(json.load(open(f))["status"] for r in runs for f in glob.glob(f"{R}/{r}/mail/attempts/*.json"))
   print(c)
   PY
   ```
   實際輸出（撰寫本文時實跑）：`Counter({'committed': 128, 'failed': 18, 'started': 7})`。若不加 `[:17]` 篩選，會多算後面的 run：`committed 163、failed 22、started 8`。
5. **怎麼確認修好了**：每列的「把握」欄與其證據欄一致（問題欄寫推論就不能標已驗證）。
6. **優先度／把握**：中；已驗證。
7. **相依**：無。

### A-09 基準 hash 與修法文字：評估報告犯了自己指出的錯（I-25、I-26 修法）

1. **編號與標題**：A-09。白話：評估報告批評 R2 用「run snapshot 當 HEAD」，自己也這樣做。
2. **要改哪裡**：`docs/review-analysis-reports.md` §1 基準 hash 段、I-25「建議」、I-26「建議」。**改文件**。
3. **為什麼要修正**：`f41a39c` 是 run 052756 的 snapshot，不是 `main` 的祖先（`git merge-base --is-ancestor f41a39c HEAD` 回傳 1）；I-25 的修法甚至寫「與 HEAD f41a39c 無差異」，把 snapshot 稱作 HEAD。白話：snapshot 是 run 開始時暫存的 commit，只靠一個特殊名字的 ref 指著；`clear` 會刪掉這個 ref（`run-cleanup.ts:89-90` 只負責 snapshot ref；run 的 worktree 與分支另在 `:87` 刪除），commit 失去指向，之後這個 hash 就查不到了。I-26 的修法寫「截至 run 052756 前」，但語料其實結束於 **d52bff（040459）之前**。
4. **怎麼修正**：
   - 改前（I-25）：「基準為 run 分支 snapshot 55ae335，`src/` 與 HEAD f41a39c 無差異。」
   - 改後：「基準 commit 用 `main` 上的 `088a180`；註明『`src/` 與 snapshot X 相同』時不要用 HEAD 一詞，也不要把 run snapshot 當穩定基準。」
   - I-26 改前：「截至 run 052756 前」→ 改後：「語料 = 依 run id 排序的前 17 個 run，即 d52bff 之前啟動的全部 run」。
   ```
   git merge-base --is-ancestor f41a39c main; echo $?   # 預期 1（不是祖先）
   git merge-base --is-ancestor 088a180 main; echo $?   # 預期 0
   ```
5. **怎麼確認修好了**：文中凡引用的 commit 都能 `git cat-file -t <hash>` 在 `main` 上解析；不再有「HEAD f41a39c」。
6. **優先度／把握**：低；已驗證。
7. **相依**：與 B-10 同做。

### A-10 數字與重算口徑：計數錯、區間錯、兩份報告的標準不一

1. **編號與標題**：A-10（§6／I-31 計數、I-28 grep 範圍、§1 偏差計數、§4 指令欄）。
2. **要改哪裡**：`docs/review-analysis-reports.md` §1、§4「command」行、§6、I-28、I-31。**改文件**。
3. **為什麼要修正**：
   - §6／I-31 寫「摘要 9 條」「儲存格 >400 字」：實際 R1:7-16 是 **10** 條，R1:41 那格約 **386** 字（去掉空白為 384）。
   - I-28 寫「grep 35–40」：換詞表實際落在 **31–48**（`node_modules\|EPERM\|registry` = 31；加 `sandbox` = 47；再加 `configLoader\|.pipe\|403` = 48）。
   - §1 對 R1 與 R2 用不同標準：`claude.ts:11-20` 在 R1 算偏差，R2:72 同一個引用卻不算；R2 的 `:440` 被算成失敗，R1 偏 1 行的卻算成立。
   - §4 的「command」欄只列工具名（`git rev-list`、`grep -A3`…），它引用的 `f1.sh`／`rc.sh` 不在 repo，這正是它批評 R2 的「不可重現」。
   - 兩個它自稱「原因未查」的問題其實用現有資料就能答：13 個 run 的來源（見 B-11）、7 個 `started` 的來源（A-08）。
4. **怎麼修正**：改前：「9 條」「>400 字」「35–40」；改後：把數字改為 10 條、386 字、31–48；統一用同一標準重算兩份報告的偏差數；把實際用過的 grep 詞表與腳本內嵌到評估報告附錄（或標「不可重現」）。可複製：
   ```
   sed -n '7,16p' docs/analysis-agent-context-and-mail.md | grep -c '^[-*0-9]'   # 預期 10
   sed -n '41p' docs/analysis-agent-context-and-mail.md | python3 -I -c 'import sys;print([len(c.strip()) for c in sys.stdin.read().split("|")])'   # 預期最長的格約 384（驗證者含空白算 386），都不到 400
   ```
5. **怎麼確認修好了**：上面兩個指令輸出與新文字相符；評估報告附錄能獨立重跑出 31／47／48。
6. **優先度／把握**：低；已驗證（計數）；grep 區間依詞表而異。
7. **相依**：無。

### A-11 引用行號漂移（評估報告自己的引用）

1. **編號與標題**：A-11。白話：評估報告引用的行號有 8 處對不上，要改成實際行號。
2. **要改哪裡**：`docs/review-analysis-reports.md` 各處。**改文件**。
3. **為什麼要修正**：行號是別人查證的入口。31 個抽查引用中 6 處有誤（5 處差 1–2 行、1 處主題不對），加上 I-11、`config.ts` 兩處。不改，讀者點進去會看到不相干的內容。
4. **怎麼修正**（舊→新）：

   | 位置 | 舊（改前） | 新（改後） | 說明 |
   |---|---|---|---|
   | §3「重試／備援」 | R1:174 | R1:173 | 174 是 #11（無沙箱警告）；173 才是 #10 |
   | §3「他人 worktree 可讀」 | R2:94、R2:174 | 移除 | 這兩行問的是「docs-writer 的 worktree 看不看得到 lead 整合的程式」（git 可見性），不是讀取權限 |
   | I-25 | R2:9 | R2:7 | R2:9 是引用格式說明 |
   | I-30、§6 | R2:5 | R2:6 | 證據檔那行 |
   | I-30、§6 | R2:8 | R2:9 | R2:8 是空行；標註慣例在 R2:9 |
   | I-11 | `cli.ts:633,643,666` | `cli.ts:468`（clear） | 633、643、666 是 `tidy` 的選項與鎖，不支援「clear 刪除」的說法 |
   | session 預設 | `config.ts:136-145` | `config.ts:215,236` | 136-145 是通用的 `pick` 輔助函式 |
   | I-17 | `worktree.ts:500` | `worktree.ts:541` | 500 只是常數 |
   | I-10 | `task.ts:55-78` | `task.ts:69-79` | 內文邏輯位置 |
   | 多處 | `mailbox.ts:307-318` 與 `307-322` 混用；`guard.ts:47-54` 與 `47-55` 混用 | 各選一個並全文統一 | 兩個範圍都有效，只是不一致 |

   另：`claude.ts:11-20` 其實有效（`denyRules` 到 :22，兩條 `Edit` 規則在 :13、:20），不必列為偏差。

   確認指令（可複製）：
   ```
   sed -n '173p' docs/analysis-agent-context-and-mail.md | cut -c1-40   # 應是 #10（備援切換）
   sed -n '468p' src/cli.ts | cut -c1-60                                # 應與 clear 有關
   ```
5. **怎麼確認修好了**：對評估報告裡每個 `檔案:行號` 做 `sed -n`，內容與所述主題一致。
6. **優先度／把握**：低；已驗證（v1、v2、v3 31 項抽查）。
7. **相依**：無。

### A-12 §9「前 5 項」排序與優先度與證據不符

1. **編號與標題**：A-12（§9、各項優先度、I-12 的 E5）。
2. **要改哪裡**：`docs/review-analysis-reports.md` §9、I-16／I-20／I-22／I-24 等優先度、§5 E5。**改文件**。
3. **為什麼要修正**：
   - §9 #4 的標題寫了「`done` 不檢查 COMMON」（I-21），但編號清單（I-14…I-17）沒有 I-21；§9 完全沒列 I-20，卻把 I-20 標高。
   - #5 幾乎都是低優先或推論項（I-25、I-27、I-28），#3 放了標推論的 I-08。
   - 優先度要跟著證據走：I-20 在 179 封信的語料裡最大 15,357 B、沒有超過 16 KiB，降為中；I-22 語料中 0 次拒收，降為低；I-24 沒有行為影響，降為低；I-16 降為中；§7b #2（CLAUDE.md 載入）因 F2 已實測，由低升為中；§7b #9 降為低。
   - E5 沒說「fresh sessions」只影響 `resume:true` 的 agent（lead 預設）。
4. **怎麼修正**：
   - 改前：§9 標題與清單編號對不上、漏 I-20；I-20／I-22／I-24／I-16 等優先度與證據不符；I-08 標推論；E5 沒限定對象。
   - 改後：§9 順序見本文件〈建議執行順序〉，標題與編號一一對應並納入 I-20；優先度依上列證據調整（I-20 中、I-22 低、I-24 低、I-16 中、§7b #2 中、§7b #9 低）；I-08 標「機制已驗證、端到端未跑」；E5 補「只影響 `resume:true` 的 agent」。
5. **怎麼確認修好了**：§9 標題與清單的 I- 編號一一對應；每個高優先度項目都在 §9 或有說明為何不在。
6. **優先度／把握**：中；已驗證。優先度調整是 lead 的裁定，不是量測結果（語料小、單一專案）。
7. **相依**：A-08（先把標籤更正）。

## B. R1／R2 需要修的文件內容

**導讀**：R1（`docs/analysis-agent-context-and-mail.md`）與 R2（`docs/analysis-context-sharing-need.md`）是分析報告，不是程式。它們的缺口多半是「少寫了一種情況」「數字或來源沒交代清楚」「標籤不夠誠實」。
B 類全部是**改文件**（只動 R1、R2），本次只寫建議，不修改。每條都附驗證方式，改完可以自己跑。

### B-01 補上三種執行模式的對照表（I-07，含 solo 的 `_shared` 寫入）

1. **編號與標題**：B-01（I-07 + E2）。白話：agent-lyceum 有三種跑法（team、`run --agent` 單人、`call` 單次），兩份報告只講 team，G 到底適用哪一種沒說清楚。
2. **要改哪裡**：R1:7-11、R1:20-43；R2:51-63、R2:98-104。**改文件**。依據：`src/call.ts:59-63`、`src/solo.ts:15-20`、`src/policy.ts:120-125`、`src/prompt.ts:105-120`。
3. **為什麼要修正**：好比「公司制度」只寫了正職員工，沒寫工讀生與外包——G 說「所有 agent 都要先讀 task memory」，但 `call` 根本沒有信箱、不 resume、只載全域 memory（`call.ts:59-63`），套不上。另外評估報告與 E2 都漏了：`run --agent` 的單人 agent 其實可以寫 `_shared`（`policy.ts:125`：`agent.name === project.lead`），而單人 prompt 的 Memory 段寫「never record task-specific details there」，與 G 要它記進 task memory 直接衝突（`prompt.ts` 約 :90 附近；`run-store.ts:282` 又給每個 agent 一個 task 目錄）。
4. **怎麼修正**：
   - 改前：「所有 agent 每次醒來都……」（沒有限定模式）。
   - 改後：加一張表，欄 = team／`run --agent`／`call`，列 = 能否寄信、是否 resume、載入哪些 context、能否寫 COMMON／records／`_shared`、G 是否適用。草稿：
     | 項目 | team | `run --agent` | `call` |
     |---|---|---|---|
     | 寄信（outbox） | 可 | 可（只為送 `done`） | 不可 |
     | resume | lead 預設是 | 保留設定 | 否（`resume: false`） |
     | 寫 `_shared`／COMMON／records | 只有 lead | `_shared` 可寫、records／COMMON 不可 | 不可 |
     | G 是否適用 | 是 | 需明訂（與 solo prompt 的 "never record task-specific details" 衝突） | N/A |
   - 把 R2 中的「所有」改成「team 模式下的」。
5. **怎麼確認修好了**：對表中每個格子找得到 `檔案:行號`；`sed -n '59,63p' src/call.ts` 應看到 `resume: false`、`canMessage: []`。
6. **優先度／把握**：高；已驗證（靜態讀碼）。
7. **相依**：無；C-05（G 措辭）要等這張表。

### B-02 補上 ask（向使用者提問）的回答流向（I-09）

1. **編號與標題**：B-02。白話：agent 可以向使用者提問，但兩份報告沒說「答案回到誰手上」。
2. **要改哪裡**：R1:57；R2 全文需補一句。**改文件**。依據：`run-session.ts:708-723`（`deliverAnswers`）、`ask-reply.ts:196-200`（`applyDefaults`）、`config.ts:239`。
3. **為什麼要修正**：好比員工問老闆，老闆只回信給提問的那位，其他人不會知道。答案以 `from:"user"` 只寄給提問者（一個 asker 一封）；用 `--assume-defaults` 時答案記為 `by: "default"`。提問者預設就是 lead（`can_ask_user ?? isLead`），所以「其他成員看不到答案」是常態。想讓大家都知道，仍須由提問者或 lead 寫進 COMMON／records。不寫，讀者會誤以為答案會廣播。
4. **怎麼修正**：
   - 改前：兩份報告沒有 ask 回答流向的說明。
   - 改後：加一段流程：agent 寫 ask → dispatcher 收集 → 使用者回答（或 `--assume-defaults`）→ `ask-reply` 寄到**提問者**的 inbox（`from:"user"`，預設答案標 `by: "default"`）→ 要共享須由提問者持久化。
5. **怎麼確認修好了**：`grep -n "by: \"default\"" src/ask-reply.ts` 命中 `applyDefaults`；新文字提到「只給提問者」。
6. **優先度／把握**：中；已驗證。
7. **相依**：無。

### B-03 補上初始任務（task.md）的引用式 context，並更正 R1:96（I-10）

1. **編號與標題**：B-03。白話：使用者給的任務如果很長，不會整篇塞進 prompt；R1 沒講，且 R1:96 少列了 COMMON。
2. **要改哪裡**：R1:73、R1:96；R2:64。**改文件**。依據：`task.ts:5-6`（`TASK_FILE_MAX` 1 MB、`TASK_INLINE_MAX` 16 KiB）、`task.ts:69-79`（`taskMessageBody`）、`run-session.ts:283-285`（seed mail）。
3. **為什麼要修正**：任務超過 16 KiB 時，lead 收到的只是「請去讀 `task.md`」的指示加前十行。R1:96 說「跨 run 只能靠 global／project memory 與 records」，漏了 COMMON（它每次喚醒都注入）。評估報告把問題寫成「漏 COMMON 注入」是錯的（R1:7,22,84 有寫），真缺口是 R1:96 這一句。
4. **怎麼修正**：
   - R1:96 改前：「跨 run 只能靠 global／project memory 與 records。」
   - 改後：「跨 run 的**自動注入來源**有 global／project memory、records 與 COMMON.md；task memory 不會跨 run。」
   - 補一段：使用者任務 → seed mail → lead；>16 KiB 時只給指示與首十行，全文在 `task.md`。
5. **怎麼確認修好了**：`sed -n '5,6p' src/task.ts` 看到兩個常數；R1:96 的新句含 COMMON。
6. **優先度／把握**：中；已驗證。
7. **相依**：無。

### B-04 補上 tidy／clear 對 context 的生命週期（I-11）

1. **編號與標題**：B-04。白話：記憶檔什麼時候會被整理、什麼時候會被整個刪掉，兩份報告沒講。
2. **要改哪裡**：R1:171,176；R2:66。**改文件**。依據：`memory-tidy.ts:367-375`、`prompt.ts:389-430`、`run-cleanup.ts:92-94`、`docs/how-it-works.md:43`、`cli.ts:468`。
3. **為什麼要修正**：tidy（整理記憶）只允許寫那個記憶資料夾與（對 lead）records，`allowFiles: []`，看不到也改不了 COMMON，所以「tidy 會自動解決 COMMON 過期」是錯的。`clear` 則會連 `task-memory/<run>`（含 `_shared`）一起刪掉。不寫，使用者會把重要結論放進 `_shared` 以為會留下。
4. **怎麼修正**：
   - 改前：兩份報告沒說 tidy 與 clear 對各資料夾的影響，且有「tidy 會自動解決 COMMON 過期」的暗示。
   - 改後：加一張四欄表（自動載入／可讀／可整理／可刪除），每個資料夾（global、project、task memory、`_shared`、COMMON、records）一列；明寫「tidy 不處理 COMMON；`clear` 刪 task memory 與 `_shared`」。評估報告中支持 `clear` 的引用改為 `cli.ts:468`、`run-cleanup.ts:92-94`。
5. **怎麼確認修好了**：`grep -n "COMMON\|_shared" src/memory-tidy.ts` 無命中（表示 tidy 不碰它們）；`sed -n '92,94p' src/run-cleanup.ts` 看到刪除 task-memory。
6. **優先度／把握**：中；已驗證（E4 的 `memory-tidy.ts` 只讀了部分，靠 grep 與 `how-it-works.md:43` 佐證）。
7. **相依**：無。

### B-05 記錄「follow-up 的 fresh sessions」只對 `resume:false` 成立（I-12）

1. **編號與標題**：B-05。白話：協定文字說追加任務時 agent「從全新對話開始」，但 lead 預設會接續舊對話。
2. **要改哪裡**：R1:94；R2:32,58,154；評估報告 E5。**改文件**。依據：`prompt.ts:47`、`run-session.ts:209,222-235`、`config.ts:236`。
3. **為什麼要修正**：`run-session.ts:209` 重開時把舊的 `sessions` 展開帶入，之後沒有任何程式清掉它們（讀 :209 與 :222-235 可確認）。只有 `resume:true` 的 agent（lead 預設）會接著舊 session；member 預設 `resume:false`，對他們 "fresh sessions" 是真的。不寫清楚，會把「文字與行為不一致」當成「全部 agent 都不一致」。
4. **怎麼修正**：
   - 改前：「follow-up 時 agent 都從新 session 開始。」
   - 改後：「follow-up 時 `resume:false` 的 agent（member 預設）從新 session 開始；`resume:true` 的 agent（lead 預設）保留舊 session，協定文字 `prompt.ts:47` 對它們不準確。」
   - 另列「要改協定文字，還是清掉 sessions」交 lead 決定；清除會改變 lead 的連續性，是設計決定（本次不實作）。
5. **怎麼確認修好了**：`grep -n sessions src/run-session.ts` 預期命中 :98、:429、:449、:485（讀取與寫入 session id）；另外分開讀 `sed -n '209p;222,235p' src/run-session.ts`：:209 是 `...resume` 展開，:222-235 沒有任何刪除或清空 `sessions` 的動作。
6. **優先度／把握**：中；已驗證。
7. **相依**：與 F1（C-16）相關：依 `claude --help` 文字（未實測），lead 即使 session 保留，系統提示也不會更新。

### B-06 更正 R2:76 對 guard 範圍的描述，並補 symlink 例外（I-13）

1. **編號與標題**：B-06。白話：R2 說 guard「只比對交接索引一個檔」，其實不止。
2. **要改哪裡**：R2:76；R1:50,102。**改文件**。依據：`guard.ts:47-54`（固定檔：`AGENT.md`、`COMMON.md`、repo 指示檔、交接索引）、`guard.ts:107-133`（records 樹）、`guard.ts:109-110`（symlink 例外）。
3. **為什麼要修正**：R2:76 照字面讀是錯的；但若解讀為「在 `_shared` 內只檢查交接索引」則為真（`policy.ts:197,202` 也這樣寫）。另外 records 上層若是 symlink，這一批就**整批不做 records 保護**（避免寫穿 symlink），R1 沒提這個例外。
4. **怎麼修正**：
   - R2:76 改前：「只比對交接索引一個檔」→ 改後：「就 `_shared` 內的檔案而言，只比對交接索引；整體上 guard 還保護 AGENT.md、COMMON.md、repo 指示檔與 records 樹（詳見 R1 清單）」。
   - R1 補：「records 的上一層或上上層是 symlink 時，該批次跳過 records 保護（`guard.ts:109-110`）」。
5. **怎麼確認修好了**：`sed -n '47,54p;109,110p' src/guard.ts` 與新文字吻合。
6. **優先度／把握**：中；已驗證。
7. **相依**：無。

### B-07 Claude 載入 CLAUDE.md 的標籤，並補上「user 層級」這個漏列的 context 來源（I-14 + F2）

1. **編號與標題**：B-07。白話：每次喚醒 Claude，它還會自己載入你家目錄的 `~/.claude/CLAUDE.md` 與自動記憶，兩份報告都沒把它列為 context 來源。
2. **要改哪裡**：R1:16,85,118,136,165；R2 的 context 來源清單。**改文件**。依據：`src/adapters/claude.ts:68-82`（沒傳 `--bare`／`--setting-sources`）、`claude --help`（2.1.309）。
3. **為什麼要修正**：這是**已觀察到**的事實：在 agent 的 Claude 喚醒中，context 含 `~/.claude/CLAUDE.md`（使用者私人全域指示）與該使用者的 auto-memory 索引；`prompt.ts` 並沒有讀它們。表示每個 Claude agent 都有一個 agent-lyceum 管不到的 context 來源，可能與 COMMON、Rules 衝突。repo 層級的 CLAUDE.md 載入則沒法觀察（這個 repo 沒有）；Codex 載入 AGENTS.md 也無法驗證。此外 agent-lyceum 把 memory、records、`_shared` 資料夾以 `--add-dir` 傳入（`claude.ts:66,82`），放在那裡的 CLAUDE.md 可能被載入（推論，未查）。
4. **怎麼修正**：
   - 改前：「Claude 載入 CLAUDE.md（推論）。」
   - 改後：「Claude：預設 auto-discovery，已驗證 flag；**user 層級（`~/.claude/CLAUDE.md`、auto-memory）已在 Claude 喚醒中觀察到**；repo 層級未實測。Codex：推論。」
   - 在 context 來源清單新增「user 層級 CLAUDE.md 與 auto-memory（agent-lyceum 不控制）」。
   ```
   claude --help | grep -n -- '--bare\|--setting-sources\|--add-dir'
   ```
   預期：列出 `--bare`（"Minimal mode… skip CLAUDE.md auto-discovery"）、`--setting-sources`、`--add-dir`。
5. **怎麼確認修好了**：兩份報告的來源清單含 user 層級；摘要不再把「Claude 載入 CLAUDE.md」寫成無限定的事實。
6. **優先度／把握**：中（F2 已觀察；§7b #2 由低升中）；已驗證（user 層級為觀察，repo 層級與 Codex 為推論，還缺：在含 repo CLAUDE.md／AGENTS.md 的專案跑真實 runtime）。**此版本相依**：行為與 Claude Code 版本有關，寫入前重讀 `claude --help`。
7. **相依**：無。

### B-08 他人 worktree／memory「可讀」改標已驗證（Claude），並移除誤引（I-15）

1. **編號與標題**：B-08。白話：「別的 agent 能不能讀我的記憶」已經實測過，答案是能讀（Claude），但報告還標「未驗證」。
2. **要改哪裡**：R1:27,51,52,115,168；R2:85（已把「別人本來就讀得到」當事實）、R2:94、R2:174；write-scope 相關文件加一句「寫入隔離不是讀取隔離」。**改文件**。依據：`policy.ts:148,158`（deny 只管寫）、`claude.ts:29`。
3. **為什麼要修正**：實測（含 OS 沙箱內）：`head …/agents/<別人>/memory/MEMORY.md` 成功；`git -C …/worktrees/<run>/tech-lead log -1` 成功；對別人 memory 寫入則 "operation not permitted"。R1 標推論、R2 卻當事實，兩份信心標籤不一致（評估報告卻稱「一致」）。R2:94、R2:174 問的是「docs-writer 的 worktree 是否含 lead 整合後的程式」，是 git 可見性，與讀取權限無關，不該拿來佐證。
4. **怎麼修正**：
   - 改前：「他人 worktree／memory 可讀（未驗證）。」
   - 改後：「Claude：可讀，已實測（macOS，含 OS 沙箱內）；Linux bwrap 與 Codex 未驗證。」
   - 引用既有教訓 `write-scope-is-not-read-isolation`。
   ```
   git -C <別人的 worktree> log --oneline -1                 # 預期印出 088a180 …
   head -3 <別人的 agents/x/memory/MEMORY.md>               # 預期印出內容
   touch <別人的 agents/x/memory/__probe>                    # 預期 Operation not permitted
   ```
5. **怎麼確認修好了**：R1／R2 該處標為「已驗證（Claude／macOS）」，並移除 R2:94、R2:174 作為佐證。
6. **優先度／把握**：中；已驗證（Claude／macOS）；Linux 與 Codex 為推論，還缺實機。
7. **相依**：無。

### B-09 為 R1 §6 加「優先度／狀態／owner」，為 R2 加處置表（I-16）

1. **編號與標題**：B-09。白話：R1 §6 列了 13 項建議，卻沒說哪個先做、做了沒、誰負責；R2 也沒逐項回應。
2. **要改哪裡**：R1:162-176；R2:85-98（只評了 B–I）。**改文件**。
3. **為什麼要修正**：好比一張待辦清單沒有「完成／進行中／誰」欄，三個月後沒人知道哪些已經做過。多項已有現況（例：#3 死欄位仍在、#11 部分實作、#12 靜態成立）。
4. **怎麼修正**：
   - 改前：R1 §6 是 13 條沒有優先度、狀態、owner 的條列；R2 沒有逐項處置。
   - 改後：R1 §6 改成表，欄位：編號｜建議｜優先度｜狀態（待辦／部分實作／已有／拒絕）｜owner。R2 加「處置表」逐項：採用／拒絕／另案／待證據。優先度採本文件 C 類與〈建議執行順序〉。可先把 §7b 的 13 列當初稿（狀態：#1 開放、#2 部分、#3 開放、#4 開放、#5 成立、#6 成立、#7 部分、#8 成立、#9 開放、#10 開放、#11 部分、#12 成立（靜態）、#13 成立）。
5. **怎麼確認修好了**：R1 §6 區段變成表格，13 列資料列各自在新增的「優先度／狀態／owner」欄都有值（目視逐列檢查）。
6. **優先度／把握**：中（lead 由高降中）；已驗證。
7. **相依**：A-12（先確定優先度）。

### B-10 R2 的基準 commit 與「語料規則」要寫進正文（I-25、I-26）

1. **編號與標題**：B-10。白話：R2 說根據「HEAD」，但那是一個會消失的暫時 commit；也沒說「17 個 run、147 封信」是怎麼選的。
2. **要改哪裡**：R2:7（不是 R2:9）、R2:13、R2:167；兩份報告頂端。**改文件**。
3. **為什麼要修正**：snapshot（run 開始時暫存的 commit，見〈名詞小字典〉）只靠一個特殊名字的 ref 指著，`clear` 刪掉 ref 後 commit 就找不到了，這就是 `55ae335` 會消失的原因。R2 的基準 `55ae335` 只存在於 run 的 snapshot ref 與 run 分支（`git for-each-ref --contains` 只列出 run 相關 ref）；`clear` 之後就查不到。語料規則是「依 run id 排序的前 17 個 run，即 d52bff 之前啟動的全部 run」；現在已有 20 個 run，若加上較新的，數字會變（19 個非當前 run：179 封信、19 次 request-changes、76 封回覆分佈在 13 個 run）。不寫規則，數字下次又對不上。d52bff 自己有 2 次 request-changes，排除它會偏向舊 run。
4. **怎麼修正**：
   - 改前：R2 頂端寫基準是 snapshot `55ae335`；正文沒有語料選取規則。
   - 改後：兩份報告頂端加一行：「基準：`main` 的 `088a180`；`src/` 與 snapshot `55ae335`／`eb6201f` 相同；snapshot 於 `clear` 後消失，勿當穩定基準。」
   - R2 正文加：「語料 = 依 run id 排序的前 17 個 run（全部早於 d52bff，R2 自己所在的 run）；排除 d52bff、8e32b2 與進行中的 run。」
   - 結論前註明「在本專案、此語料內」。
   ```
   git merge-base --is-ancestor 55ae335 main; echo $?   # 預期 1
   ls ~/agent-lyceum-config/projects/agent-lyceum/runs | sort | head -18 | tail -2   # 預期先 …c0594a…（第 17 個，語料最後一個），再 …d52bff…（第 18 個，被排除）
   ```
5. **怎麼確認修好了**：R2 頂端的 commit 能在 `main` 上解析；正文能回答「為什麼是 17 個 run」。
6. **優先度／把握**：中（I-26）／低（I-25）；已驗證。
7. **相依**：A-09。

### B-11 更正 R2 的「13 個 run」與證據檔的算術（I-27）

1. **編號與標題**：B-11。白話：R2 說「13 個 run 的 61 封回覆」，其實是 11 個 run；原因是證據檔少算了排除的 run。
2. **要改哪裡**：R2:35（f1）；證據檔 `task-memory/…d52bff…/_shared/evidence-context-gaps.md` 第 71–77 行（repo 外，改這份要另外處理）。**改文件**。
3. **為什麼要修正**：證據檔第 77 行說「4 個 run 沒有成員信」，但列了 5 個（7408c8、9bd62a、c26de0／75f3a8、c0594a），而且漏了 2d1b53（只有 lead 的 1 封信），所以 17−4=13；正確是 17−6=11（推論，但數字完全吻合）。另外證據檔的信件分項 126+18+4+1（+2）加不到它宣稱的 147。若直接用全部 19 個非當前 run，會是 13 個 run 但 76 封，所以 R2 的 13 也不是那個數。
4. **怎麼修正**：
   - 改前：「13 個 run 的 61 封成員回覆」→ 改後：「11 個 run 的 61 封成員回覆」。
   - 證據檔改為列出 6 個無成員信的 run，並重算信件分項使其合計為 147（或註明差額來源）。
5. **怎麼確認修好了**：`python3 -I` 掃描前 17 個 run 的 lead inbox，寄件者不是 `user`／dispatcher 的信共 61 封、分佈 11 個 run。
6. **優先度／把握**：低；已驗證（計數）；「13 的成因」為推論但算式吻合。
7. **相依**：B-10（先定語料規則）。

### B-12 「重新探索環境 36／61」與「request-changes 8／15 集中」的措辭（I-28、I-29）

1. **編號與標題**：B-12。白話：R2 用一個關鍵字搜尋數出「36 封」，但換個詞表就是 31 到 48；「8／15」也集中在兩個 run。
2. **要改哪裡**：R2:35,149、R2:167、R2 §4 觸發條件。**改文件**。
3. **為什麼要修正**：「重新探索環境」是人工分類，沒有可重現判準（grep 結果 31／47／48，看詞表）。request-changes 15 次中 0a2b9f 佔 5、6e01a3 佔 3，比例對少數 run 很敏感（8/15 成立）；語料來自單一專案、自己開發自己；「sandbox 造成」沒有逐 run 資料，是推論。
4. **怎麼修正**：
   - 改前：「重新探索環境 35–40／61」「request-changes 8／15 集中」用固定比例當結論。
   - 改後（I-28）：附分類判準與逐封信件 id 清單，或改述為「約六成（推論）」；基線表使用前先寫死 grep 式。
   - 改後（I-29）：結論改「歸因機率受單一 run 主導」；§4 觸發條件改用絕對數與 run 數；加「在本專案語料內」；sandbox 影響標推論。
5. **怎麼確認修好了**：別人用文中給的詞表與資料能重跑出相同的數；R2 §4 的觸發條件不再用比例。
6. **優先度／把握**：中；I-29 計數已驗證，其餘（分類、sandbox 影響）為推論，還缺逐封人工標註或逐 run 的 sandbox 資料。
7. **相依**：B-10。

### B-13 事件編號要內嵌、標註慣例要統一（I-30）

1. **編號與標題**：B-13。白話：R2 用 a1、c1、e1 稱呼「某次事件」，但對照表放在 repo 外的檔案，任務清除後就沒了。
2. **要改哪裡**：R2:6、R2:9；R1:3。**改文件**。依據：`docs/how-it-works.md:43`（`clear` 會刪 `_shared`）；`grep -c 觀察 docs/analysis-agent-context-and-mail.md` 為 0。
3. **為什麼要修正**：報告放在 `docs/`，長期留存；它的證據卻放在會被刪的地方，將來沒人能核對。R1 用「觀察／推論／未知」，R2 用另一套（R2:9），讀者要切換兩種標籤。
4. **怎麼修正**：
   - 改前：R2 用 a1、c1、e1 稱呼事件，對照在 repo 外的證據檔；R1、R2 標籤慣例不同。
   - 改後：R2 附錄內嵌「事件編號表」（編號｜run id｜發生什麼｜來源檔案或指令）；R1 改用觀察／推論／未知三標籤並補「未知彙整」；兩份統一慣例。
5. **怎麼確認修好了**：把 `_shared` 證據檔移開後，R2 的每個事件編號仍能在 R2 內查到出處。
6. **優先度／把握**：中；已驗證。
7. **相依**：無。

### B-14 R1 §6 #10 自我撤回、R2:167 殘留、其他可讀性（I-31）

1. **編號與標題**：B-14。白話：R1 有一條寫完又自己推翻；R2 結論裡還留著「本題額外加的維度」這類草稿痕跡。
2. **要改哪裡**：R1:5-16（摘要）、R1:41、R1:63（重複貼上）、R1:173；R2:11-24、R2:167；另有 R1:48（`claude.ts:65`→`66`）、R1:52、R1:101 與 R2:72（`claude.ts:11-20`，其實有效，不必改）。**改文件**。
3. **為什麼要修正**：R1:173 寫著「故不需新增此建議」，卻留在建議清單；R2:167 的「本題額外加的維度」是草稿語氣；R1 摘要 10 條、帶行號，太長；R1:63 有一段重複 `` `src/prompt.ts:138-140`），`src/prompt.ts:138-140`） ``。
4. **怎麼修正**：
   - 改前：R1 摘要 10 條帶行號；§6 #10 自我撤回仍在清單；R1:63 有重複片段；R2:167 有草稿語氣。
   - 改後：摘要縮至 ≤5 條、不帶行號；§6 #10 只移出後半（已撤回的 retry 提示說明），前半保留為開放建議（見 C-07）；R2 結論拆四小節；修 `claude.ts:65`→`66`；刪 R1:63 重複片段。
5. **怎麼確認修好了**：`sed -n '63p' docs/analysis-agent-context-and-mail.md` 不再有重複；R1:173 不再自我撤回。
6. **優先度／把握**：低；已驗證。
7. **相依**：B-09（§6 表格化後一併處理）。

### B-15 R1 §6 #11、#12 的現況用語（I-17、I-18 的文件面）

1. **編號與標題**：B-15。白話：R1 §6 把「已經做了一半」和「條件不明」的事寫成單純待辦。
2. **要改哪裡**：R1:174（#11）、R1:175（#12）。**改文件**。依據：`policy.ts:196-203`、`worktree.ts:541`、`validate.ts:132`、`cli.ts:557`。
3. **為什麼要修正**：#11（無沙箱警告）已有 notes，Codex 的 `can_edit_agent_md` 警告也在（`policy.ts:203`）；#12 的「改用 worktree 分離」其實已存在（有 worktree 就隔離），髒窗口只在無 OS 沙箱時。寫成待辦會誘發重複工作。
4. **怎麼修正**：
   - #11 改前：「無沙箱警告待辦」；改後：「已有 notes；缺：Claude 在無 OS 沙箱＋`can_edit_agent_md` 的警告、避免使用的建議。」
   - #12 改前：「改用 worktree 分離待辦」；改後：「靜態路徑成立（`run-session.ts:593` 批次後檢查）；窗口僅在無 OS 沙箱時，或 Codex 的 repo 指示檔（即使有 OS 沙箱也是事後還原，`policy.ts:200-201`）；worktree 分離已存在；shared 模式（無 git）一次一個 agent，無窗口。」
5. **怎麼確認修好了**：兩列的新文字能用 `policy.ts:203`、`worktree.ts:541` 核對。
6. **優先度／把握**：中（#12）／低（#11）；已驗證（靜態；實際交錯為推論）。
7. **相依**：A-03、A-04。

## C. 程式或規格層面的建議

> **需要另開任務實作，本次不改。** C 類每一條都是「改程式」或「改規格」的建議；本次只寫在這裡，沒有動 `src/`、`test/`。實作前請先由 lead 指派，必要時走 architect 與 reviewer。

**導讀**：C 類是驗證過程中確認「程式或規格真的有洞」的地方，主要是 R2 提出的 G、F 兩個小改善的規格空缺，以及幾個獨立的程式問題。
每條說明：問題在哪、不修會怎樣、建議怎麼修、怎麼測。標「推論」的要寫出還缺什麼證據。
所有 `檔案:行號` 以 `main` 的 `088a180` 為準。

### C-01 G 的觸發點錯位：resume 重做時 `attempt` 恆為 0（I-01）

1. **編號與標題**：C-01。白話：G 想在「重做」時多給一段提示，但程式用來判斷「是不是重做」的變數，在最主要的重做情境永遠是 0。
2. **要改哪裡**：`src/run-session.ts:440`（`userPrompt: attempt ? retryPrompt(...) : base.userPrompt`）、`src/fallback.ts:204`（`let ctx = { attempt: 0, ... }`）；R2:102-103 的 G 規格。**改程式＋改規格**；**需要另開任務實作，本次不改**。
3. **為什麼要修正**：先講白話：程式用一個計數 `attempt` 判斷「這是不是重試」，但中斷後重做不算重試，計數是 0，所以重試專用的提示不會出現。細節：`attempt` 是「這一次 wake 內第幾次重試」，每次喚醒都從 0 開始。run 被中斷後 `resume`，重做會被當成新的 wake，`attempt` 是 0，不進 `retryPrompt`。實例：d041c8 的 `log.jsonl` 第 22 行 `"event":"wake","agent":"node-engineer",…,"attempt":0,…,"messages":["463774b6"]`；兩個 claim（claim = 「誰在處理哪幾封信」的紀錄；一個被放棄 abandoned、一個完成 committed）都帶 `message_ids:["463774b6"]`（就是那封信的 id），被中斷那次的 attempt JSON 是 `error:"interrupted"`、`parked:["rev1-reply.md"]`，它沒有 wake 紀錄（log 第 18–20 行是 resume／note／recover：run 重啟時把中斷的事先收尾）。不修，G 掛在 `retryPrompt` 上，主要情境根本觸發不到，G 的成效指標會被誤判為「無效」。
4. **怎麼修正**：
   - 改前：「重試時（`attempt > 0`）在 `retryPrompt` 加一句『先讀你的 task memory』。」
   - 改後：「觸發條件改成『同 agent、message id 有交集、狀態為 failed 的先前 attempt 存在』（也就是 F 的候選選擇），不再依賴 `attempt`。」
   - 偽代碼：
     ```
     const prior = failedAttemptsFor(agent, batchMessageIds)   // 與 F 共用
     const userPrompt = (attempt || prior.length) ? withRedoNotice(base, prior) : base.userPrompt
     ```
   - 副作用：resume 與重做路徑每次喚醒多讀 claims／attempts（便宜）；graceful cancel（`cancelled`）也被涵蓋。
   - 驗證：
     ```
     grep -n '"event":"wake"' <run>/log.jsonl | grep '"attempt":0' | head -3
     python3 -I -c 'import json,glob;[print(f.split("/")[-1],json.load(open(f)).get("status"),json.load(open(f)).get("message_ids")) for f in glob.glob("<run>/mail/claims/*.json")]'
     ```
     預期（d041c8）：兩個 claim 的 `message_ids` 皆含 `463774b6`。
5. **怎麼確認修好了**：qa 用 fake runtime 加「硬殺」或 `started` attempt 的 fixture：中斷→`resume`→新 prompt 含重做提示；同樣的 fixture 在舊程式下不含。
6. **優先度／把握**：高；已驗證（讀碼＋d041c8 run 資料）。
7. **相依**：與 C-02、C-03、C-04 一起定規格；先修 B-01（模式矩陣）才知適用範圍。

### C-02 F 的草稿只算一次，同一次 wake 的重試拿不到（I-02）

1. **編號與標題**：C-02。白話：F 要把失敗那次的草稿放進新 prompt，但程式只在 wake 開頭組一次 prompt，剛失敗的草稿進不去。
2. **要改哪裡**：`src/run-session.ts:379`（`base.userPrompt` 只建一次）、`:440`（每次重試重用）、`:493,498`（`parkOutbox` 在上一次 invoke 內執行）。**改程式＋改規格**；**需要另開任務實作，本次不改**。
3. **為什麼要修正**：好比交班備忘錄在上班前寫好，中途發生的事就不在上面。真實案例：8e32b2 的 `…-docs-reviewer-6b330b-a1` 失敗並 park 了 `review-draft2.md`，接著 `-a2` 在同一個 claim 上跑——所以「同 wake 重試」確實會發生。不修，這種情況 F 完全沒作用。
4. **怎麼修正**：
   - 改前：「prompt 在 wake 開頭組好，所有重試共用。」
   - 改後：「每次 invoke 前重新選候選草稿（多一次 readdir）；草稿段位置固定在重試提示之後。不要求在 `beginAttempt` 之前選：新 attempt 是 `started`，候選篩選條件是 `failed`，選不到自己。」
5. **怎麼確認修好了**：測試：a1 寫 outbox 後逾時→a2 的 prompt 含該草稿（先確認兩次嘗試屬於同一次 wake）。
6. **優先度／把握**：高；已驗證（讀碼＋8e32b2 實例）。
7. **相依**：C-01（共用候選選擇）。

### C-03 F 與 resume 的重複注入：規則要看「失敗者有沒有回傳 session id」（I-03、含 F1 的前提）

1. **編號與標題**：C-03。白話：如果 lead 重試時已經接上失敗那次的對話，草稿再貼一次就重複了；但逾時時它接不上。
2. **要改哪裡**：`src/run-session.ts:423,429,449`；`config.ts:236`；R2 的 F 規格。**改程式＋改規格**；**需要另開任務實作，本次不改**。
3. **為什麼要修正**：session id 只在失敗結果帶回 id 時才存（逾時、取消、spawn 失敗都沒有：`process-runner.ts:174,214,216-217`），所以逾時後 lead 接上的是**上一次成功**的 session。失敗那次的 turns 是否留在 session，取決於 runtime（推論）。評估報告建議的 `sessionId === undefined` 規則會替 lead 關掉 F（見 A-05）。
4. **怎麼修正**：
   - 改前：「只在 `sessionId === undefined` 時注入，或寫明接受重複。」
   - 改後：「只有失敗的那次嘗試自己回傳了 session id 時略過注入；否則照常注入。若要接受重複，規格要明寫並限制大小（≤4 KB，R2 原案）。」
5. **怎麼確認修好了**：fake runtime 三個情境：(a) 失敗結果帶 id→不注入；(b) 逾時無 id→注入；(c) 第一次喚醒（無 session）→注入。
6. **優先度／把握**：中；程式路徑已驗證；「是否有害」為推論，還缺真實 runtime：resume 一個被殺掉的 Claude／Codex 對話，看它是否含被殺那次的 turns。
7. **相依**：A-01、A-05；C-01。

### C-04 `retryPrompt` 與草稿段互相矛盾（I-04）

1. **編號與標題**：C-04。白話：重試提示說「你的信被丟棄了，請再寄一次」，F 又說「這是你收起來的草稿」，agent 會困惑。
2. **要改哪裡**：`src/run-session.ts:45`（"Its mail was discarded … send the mail again"）。**改程式**；**需要另開任務實作，本次不改**。
3. **為什麼要修正**：F 加入草稿段後，兩段文字互斥；resume 重做（C-01 修好後）甚至沒有 `retryPrompt`，F 的草稿標題必須能自己說明。
4. **怎麼修正**：
   - 改前：「Its mail was discarded … send the mail again.」
   - 改後（有草稿時）：「Your earlier mail was set aside, not delivered. The drafts below are unverified; check them before reusing.」；無草稿時文字不變。
5. **怎麼確認修好了**：snapshot 測試：有草稿的 prompt 不含 "discarded"；無草稿的與舊版完全相同。
6. **優先度／把握**：中；已驗證。
7. **相依**：C-02。

### C-05 G 只改措辭難見效，要放進 Rules 並說明「何時寫」（I-06）

1. **編號與標題**：C-05。白話：G 想叫 agent 常把進度寫進記憶，但現有提示已經叫過了，只改措辭不一定有用。
2. **要改哪裡**：`src/prompt.ts:213-215`（Memory 段）、`## Rules` 段（`prompt.ts:218-223` 附近）。**改程式＋改規格**；**需要另開任務實作，本次不改**。
3. **為什麼要修正**：現有文字只說進度放 task memory，沒說**何時**（長指令之前、每步之後）與「被中斷後會從它重來」。R2:46 的「1/8」（node-engineer 被喚醒的 8 個 run 中只有 1 個 run〔0a2b9f〕有 task memory）說明現行文字沒效。G 全文 173 B，成本很低；但只換字很可能仍無效（推論）。
4. **怎麼修正**：
   - 改前（現在的行為）：Memory 段只說「進度放 task memory」，沒說何時寫，也沒進 `## Rules`。
   - 改後（目標行為）：`## Rules` 明寫「長指令之前、每步之後更新 task memory；被中斷後會從它重來」。
   - 細節：把觸發條件放進 `## Rules`；告知喚醒時限秒數（`project.dispatcher.wake_timeout_sec`）；沿用 ≥50% 驗收，連續無改善就撤掉 G。solo 與 call 要明訂：solo prompt 的「never record task-specific details」要同步改，call 標 N/A（見 B-01）。副作用：所有 prompt snapshot 都會變。
5. **怎麼確認修好了**：修改後跑一組 node-engineer 任務，統計「有 task memory 的喚醒／總喚醒」是否 ≥50%。
6. **優先度／把握**：中；推論（還缺：實際效果數據，要新的 run 資料）。
7. **相依**：B-01、C-01（先做完這兩條，C-05 才能定適用範圍）；C-16 的實驗結果也要先看（依 `claude --help` 文字，resume 的 lead 可能看不到新系統提示，未實測）。

### C-06 跨 run 的 guard 會把另一個 run 合法的共享寫入還原（I-08）

1. **編號與標題**：C-06。白話：兩個 run 同時跑，A 的守衛會把 B 的 lead 剛合法改好的 COMMON 與新記錄刪掉，還怪到 A 的無辜成員頭上。
2. **要改哪裡**：`src/guard.ts:84-100,107-133`（授權只比對本 run 的 `running`）、`guard.ts:38-41`（註解只覆蓋批次之間的外部修改）、`src/run-session.ts:593,926`、`src/project-lock.ts:299-305`、`policy.ts:32-47`。**改程式（需設計決定）**；**需要另開任務實作，本次不改**。
3. **為什麼要修正**：先講白話：同一個專案可以同時跑兩個 run，它們共用同一份 COMMON.md 與 records；每個 run 的守衛只認得「自己這個 run 裡誰有權改」，所以另一個 run 的 lead 合法改了共用檔，這邊的守衛會當成有人違規。好比兩個分店共用同一本總帳，A 店的稽核員看到總帳被改，不知道是 B 店店長合法改的，就擦掉並指控 A 店的店員。單元重現：兩份 `bindRunProject` 共用 `COMMON.md`；B 的 lead 改 COMMON 並新增 `records/decisions/new-b.md`；`gA.check([fe-member])` 回報 COMMON 被 `restored`、新記錄被 `removed`，`suspects` 皆為 `fe-member`；之後 COMMON 回到舊內容、B 的記錄消失。兩個 run 的批次時間重疊，且 B 的 lead 在 A 的批次期間寫入 COMMON／records 時會發生（機制已用單元重現驗證，實際時序未驗證；程式路徑：rebase `:926`，A 批次沒有 A 的 lead，`settle` 呼叫 `guard.check(batch)` `:593`）。影響範圍：同一專案所有並行 run。
4. **怎麼修正**：
   - 改前（現在的行為）：守衛只用本 run 的 `running` 判斷誰有權改，另一個 run 的合法寫入會被還原、並歸咎到本 run 的成員。
   - 改後（目標行為）：另一個活躍 run 的 lead 寫的變更視為外部變更、不還原，`suspects` 不再指向無辜的成員。
   - 設計方向：需 architect 決策，方向之一：「另一個活躍 run 的 lead 寫的變更視為外部變更，不還原」；或「用跨 run 鎖，按檔案做 rebase」。同時修 `suspects` 的歸因。單元重現的步驟（runtime-debugger 驗證時用過，**腳本沒有 commit 進 repo**，用 scratch 目錄加 `node --import tsx` 跑，用完已刪）：
   1. 兩份 `bindRunProject`（run A、run B）綁同一個測試專案，兩者共用同一份 `COMMON.md`。
   2. 各建一個 `ProtectedGuard`：`gA`、`gB`。
   3. B 的 lead 改 COMMON 並新增 `records/decisions/new-b.md`；`gB.check([lead])` 回傳 `[]`（合法）。
   4. `gA.check([fe-member])` 回報 COMMON 被 `restored`、新記錄被 `removed`，`suspects` 皆為 `fe-member`；之後 COMMON 回到舊內容、B 的記錄消失。
   - 最小端到端驗證（不用真模型）：
   - 一個暫時的 `AGENT_LYCEUM_HOME`，同一程序內對同一專案呼叫兩次 `runTeam`，用假 invoker。
   - A 的 member invoker 等待一個 promise；B 的 lead invoker 寫 COMMON 與一則 record、寄回信，然後 resolve 該 promise。
   - 斷言：A 批次之後 COMMON 被還原、A 的 `violations/` 與 log 有還原紀錄（目前會，修好後不該）。
5. **怎麼確認修好了**：上述 fake run 在修好後，COMMON 與新記錄保留，A 的 log 沒有 `restored`／`removed`。
6. **優先度／把握**：高；機制已驗證（單元重現），端到端未跑（還缺：兩個並行 fake run 的整合測試）。
7. **相依**：無；先交 cli-architect 做設計決定。

### C-07 備援切換的提示 "starts a fresh session" 有時不準（I-19）

1. **編號與標題**：C-07。白話：切到備援模型時，狀態列說「它從全新對話開始」，但若備援自己已有舊對話就不對。
2. **要改哪裡**：`src/run-session.ts:413`（note 文字）、`onSwitch`；顯示處 `status.ts:330,488`。**改程式**；**需要另開任務實作，本次不改**。
3. **為什麼要修正**：第一次切備援時 `state.sessions['agent@key']` 沒有值，文字正確；備援已有自己的 session 且 `agent.resume` 為真時，文字誤導。評估報告的「備援一律不帶 sessionId」不可取（lead 在長冷卻期間會每次失去連續性）。
4. **怎麼修正**：
   - 改前：「the backup starts a fresh session」
   - 改後：`onSwitch` 內檢查 `agent.resume && state.sessions[\`${agent.name}@${to.key}\`]`，印「resumes its own earlier session」或「starts a fresh session」。
   - 影響：只改 `state.notes` 裡的文字；`status --json` 結構不變；沒有測試釘住這句（`rg 'fresh session' test` 無輸出）。
5. **怎麼確認修好了**：fake 測試兩個情境（備援已有／沒有 session），note 文字各自正確；`status --json` 輸出與修改前逐字相同。
6. **優先度／把握**：低（lead 的清單未給此項優先度，此為本文件建議）；已驗證（靜態）。
7. **相依**：A-02。

### C-08 mail 內文沒有長度上限，原文進 prompt（I-20）

1. **編號與標題**：C-08。白話：同事寄來一封超長信，整封原文會塞進收件者的 prompt，沒有任何截斷。
2. **要改哪裡**：`src/prompt.ts:304`（`m.body` 原文）、`src/mailbox.ts:174,281`（整檔讀取，沒有大小常數）。**改程式**；**需要另開任務實作，本次不改**。
3. **為什麼要修正**：prompt 越長越貴、越容易擠掉重要內容。問題屬實；但語料（17 個 run、147 封）最大一封 15,357 B（還是已被 `task.ts:6` 限制的使用者任務），沒有一封超過 16 KiB；若改看全部 19 個非當前 run（179 封），p95 約 10.8 KB。所以優先度是中不是高。注意：評估報告 §9 又漏了這項，內部不一致（A-12）。
4. **怎麼修正**：
   - 改前：「`routeOutboxes` 超過上限就退回並要求改寫成檔案路徑。」
   - 改後：prompt 端截斷：沿用 `task.ts:6` 的 16 KiB 模式，顯示前 N 位元組並指向 `m.file`（收件者可讀）；另加每批次總上限（lead 每次最多取 5 封）。
   - 不用退回的理由：多花一次喚醒；與格式拒收、重複檢查互動；管不到 dispatcher 自己寫的信（失敗、整合、follow-up）。
   - 好處：不改信的格式，舊 run 與舊版不受影響；`status --json` 的摘要用完整內文算（`run-session.ts:430-432`），不變。
5. **怎麼確認修好了**：測試：放一封 >16 KiB 的信，prompt 內只出現前 N 位元組與檔案路徑；`status --json` 與修改前相同。
6. **優先度／把握**：中；已驗證（問題）；實際危害為推論，缺真實超大信的案例。
7. **相依**：無。

### C-09 `done` 不檢查 COMMON.md 大小（I-21）

1. **編號與標題**：C-09。白話：lead 結束任務時，系統會檢查記錄檔有沒有太大，卻不檢查最常用的 COMMON.md，它超過上限只是被截斷。
2. **要改哪裡**：`src/mailbox.ts:307-322`（只檢查 `RECORDS_BUDGET`）、`src/prompt.ts:253-260`（`COMMON_LIMIT` 截斷）、`src/status.ts`／doctor 的警告。**改程式**；**需要另開任務實作，本次不改**。
3. **為什麼要修正**：COMMON 過大時，尾端（通常是最新資訊）被截掉，agent 不知道。但「直接擋 done」風險高：既有專案升級後，COMMON 已超過 8 KB 的會立刻無法 `done`（需在兩份 README 寫升級說明）；單人模式還有 C-10 的問題。目前 COMMON 為 5,224 B，尚未超標。
4. **怎麼修正**：
   - 改前：「COMMON 超過 8 KB 時退回 `done`。」
   - 改後：`done` 時只附非阻擋提醒；`status` 對 COMMON 超過 `COMMON_LIMIT` 顯示警告。若一定要擋，只擋團隊 lead，不擋單人 agent。
5. **怎麼確認修好了**：測試：COMMON 超過上限時，`done` 仍被接受且回覆含提醒；`status`（非 `--json` 輸出）顯示警告。
6. **優先度／把握**：中；已驗證。
7. **相依**：C-10（先決定單人模式的做法）。

### C-10 單人（`run --agent`）模式下 records 超預算會讓 `done` 被永遠拒絕（新發現）

1. **編號與標題**：C-10。白話：單人模式的 agent 被當成 lead 檢查「記錄檔大小」，卻又不能寫記錄檔，一旦超標就沒辦法結束。
2. **要改哪裡**：`src/mailbox.ts:312`（套用 `RECORDS_BUDGET`）、`src/solo.ts:15-20`（`lead: name`）、`src/policy.ts:120,131,155`（solo 不能寫 records／COMMON）。**改程式**；**需要另開任務實作，本次不改**。
3. **為什麼要修正**：靜態推論：solo agent 就是 `project.lead`，所以預算檢查適用；但 `policy.ts:120` 的 `isLead = … && !project.solo` 讓它不能寫 records。records 一旦超過 6 KB，`done` 一直被拒，直到 `max_rounds` 用完。**尚未實跑**。
4. **怎麼修正**：
   - 改前（現在的行為）：solo agent 也套用 records 預算檢查，卻不能寫 records，超標後 `done` 永遠被拒。
   - 改後（目標行為）：預算檢查加條件 `!project.solo`（solo 不檢查），`done` 被接受。
   - 驗證步驟（fake runtime，不呼叫模型）：
   1. 在暫時的 `AGENT_LYCEUM_HOME` 建立專案，records 放超過 6 KB 的有效條目。
   2. 以 `run --agent <name>` 用假 invoker 送出 `done`。
   3. 預期（目前）：回覆含 "records/… hold … bytes of active entries"，`done` 被拒。
5. **怎麼確認修好了**：同一 fixture 在修好後 `done` 被接受。
6. **優先度／把握**：中（本文件建議）；推論（還缺：上述 fake-runtime 測試）。
7. **相依**：無；C-09 要以此為前提。

### C-11 `done` 前不檢查被拒的信（I-22）

1. **編號與標題**：C-11。白話：同事寄的信被擋下來放進 `rejected/`，lead 卻可以不知情就宣布完工。
2. **要改哪裡**：`src/run-session.ts:663-665`（只記 log）、`src/mailbox.ts:213-219`、完成路徑。**改程式**；**需要另開任務實作，本次不改**。
3. **為什麼要修正**：被拒信可能是重要回報。但**不要**直接用 `rejected/` 資料夾當來源，會有誤報：被故意拒絕的重複信、因違反完成合約被收起的 `done`（`mailbox.ts:213-219`）、之後已重寄的格式拒收、跨 follow-up 保留的資料夾。所有 run 的 `log.jsonl` 中 0 個 `"event":"rejected"`，所以優先度低。
4. **怎麼修正**：
   - 改前（現在的行為）：`done` 前不看被拒的信，lead 可以帶著被拒信結束。
   - 改後（目標行為）：`done` 結果附一則非阻擋提醒，列出尚未處理的被拒信。
   - 做法：`done` 時從 `log.jsonl` 取本段的 `rejected` 事件（`run-session.ts:665`），去掉重複與之後已成功寄出的格式拒收，剩下的以非阻擋提醒附在 `done` 結果。
5. **怎麼確認修好了**：測試：一次真正被拒的信（非重複）→`done` 的回覆帶提醒；重複信不帶。
6. **優先度／把握**：低（由中降）；已驗證（缺口）；誤報條件為靜態分析。
7. **相依**：無。

### C-12 Rules 沒寫 context 衝突的優先順序（I-23）

1. **編號與標題**：C-12。白話：COMMON、records、記憶、使用者全域設定彼此矛盾時，agent 沒有規則可依。
2. **要改哪裡**：`src/prompt.ts:218-223`（`## Rules`）；`docs/how-it-works.md` 與其中文版。**改程式＋改文件**；**需要另開任務實作，本次不改**。
3. **為什麼要修正**：沒有規則時 agent 自己選，結果不可預期。評估報告提議的順序有三個問題（見 A-06）：自相矛盾、漏 AGENT.md／repo CLAUDE.md／user 層級 CLAUDE.md（B-07）、讓任務凌駕寫入限制。每次喚醒 prompt 多約 150–250 B（估計，未實測）；`prompt snapshot` 測試要更新；且依 `claude --help` 文字（未實測），被 resume 的 Claude lead 可能看不到新文字（C-16）。
4. **怎麼修正**：
   - 改前：「lead task > COMMON > records > 個人 memory（順序由 lead 決定）」
   - 改後：「`## Rules` 永遠最優先（寫入限制不可被任何內容覆蓋）；內容衝突時，依 lead 最新的明確指示，並在 Open items 回報衝突，而不是默默選一邊。」
   - 同步在 how-it-works 的兩個語言版本說明。
5. **怎麼確認修好了**：`grep -n "precedence\|Rules always" src/prompt.ts`（目前無結果，修好後命中）；兩個語言的 how-it-works 標題與連結仍一致（`npm run check:docs`）。
6. **優先度／把握**：中；已驗證（缺規則）；新規則的行為效果為推論。
7. **相依**：B-07、C-16。

### C-13 `paths.common` 是無人使用的死欄位，刪除修法不完整（I-24）

1. **編號與標題**：C-13。白話：程式裡有個「COMMON.md 的路徑」欄位，路徑是錯的，而且沒有任何地方在讀它。
2. **要改哪裡**：`src/paths.ts:65`（`common: path.join(shared, "COMMON.md")`）、`src/call.ts:75`（也在寫）、`ProjectPaths` 型別。**改程式**；**需要另開任務實作，本次不改**。
3. **為什麼要修正**：實際 COMMON 在 `shared/common/COMMON.md`，欄位指向 `shared/COMMON.md`。`rg 'paths\.common' src test plugins scripts` 無輸出，沒有行為影響；但留著會誤導人。評估報告的修法只提「刪欄位與型別」，漏了 `call.ts:75`（它以 `ProjectPaths` 型別寫了字面值，不刪會編譯失敗）。`projectPaths` 只在記憶體計算、不寫入磁碟（`flattenResolved` 與 `status` 不用），所以沒有相容性風險；欄位自初始 commit 29582d9 就無人使用。
4. **怎麼修正**：
   - 改前（現在的行為）：`ProjectPaths.common` 存在、指向錯的路徑、無人讀取，`call.ts:75` 還在寫。
   - 改後（目標行為）：欄位、型別與 `call.ts:75` 一起刪除。
   - 做法：刪 `paths.ts` 的 `common`、`ProjectPaths` 的欄位與 `call.ts:75`。
   ```
   rg 'paths\.common' src test plugins scripts   # 預期：無輸出
   npm run typecheck                             # 預期：通過
   ```
5. **怎麼確認修好了**：`npm run typecheck && npm run lint && npm test` 通過；`status --json` 輸出不變。
6. **優先度／把握**：低（由中降）；已驗證。
7. **相依**：無。

### C-14 Codex 成員開 `can_edit_agent_md` 會讓可寫範圍變寬（新發現）

1. **編號與標題**：C-14。白話：給 Codex 成員「可改 AGENT.md」的權限，實際上讓它能寫到 lead 整個 checkout 與所有 agent 的資料夾。
2. **要改哪裡**：`src/adapters/codex.ts:7-11`（`codexWritableRoots` 把 `allowFiles` 的 `dirname` 全加進可寫根）、`src/policy.ts:59-61,203`。**改程式**；**需要另開任務實作，本次不改**。
3. **為什麼要修正**：先講白話：沙箱的「可寫資料夾」是用檔案所在的資料夾算的；給一個 agent 改某個檔案的權限，結果變成整個資料夾都能寫。靜態推論：`can_edit_agent_md` 使 `allowFiles` 含 repo 指示檔（在 lead checkout 根）與 `agents/<x>/AGENT.md`，其 `dirname` 變成可寫根——lead checkout 根與所有 `agents/<x>/`（含別人的記憶）。`policy.ts:203` 只寫「whole agent directories」，沒說到 checkout 根。**未用 Codex 實跑**。
4. **怎麼修正**：
   - 改前（現在的行為）：`allowFiles` 的每個檔案，其所在資料夾整個變成可寫根。
   - 改後（目標行為）：只放行確有需要的目錄；警告文字補上 checkout 根。
   - 方向：`codexWritableRoots` 對 `allowFiles` 只在確有需要時放行對應目錄、並把警告文字補上 checkout 根。驗證：寫單元測試，用假 `WakeInput`（Codex、`canEditAgentMd: true`）呼叫 `codexWritableRoots`，列出回傳的根。
5. **怎麼確認修好了**：測試斷言回傳的根不含 lead checkout 根與其他 agent 的資料夾。
6. **優先度／把握**：中（本文件建議）；推論（還缺：Codex 實跑確認沙箱真的照這些根放行）。
7. **相依**：A-04。

### C-15 attempt id 在 a1 損毀、a2 有效時會覆蓋有效的 a2（新發現）

1. **編號與標題**：C-15。白話：編號用「現有有效檔案數 +1」，如果中間有檔案壞掉，新編號會撞上舊的。
2. **要改哪裡**：`src/message-store.ts:200-217`（`listAttempts` 略過壞 JSON、`beginAttempt` 的 `n = count + 1`）。**改程式**；**需要另開任務實作，本次不改**。
3. **為什麼要修正**：靜態推論：a1.json 損毀、a2.json 有效時，下一個 attempt 得到 id `a2`，覆蓋有效的 `a2.json` 並重用它的 outbox 資料夾。實務上不太可能，因為 attempt 以 `atomicWrite` 寫入（`:192`）。
4. **怎麼修正**：
   - 改前（現在的行為）：新編號 = 有效 attempt 檔案數 + 1（`n = count + 1`）。
   - 改後（目標行為）：新編號 = 現有檔名裡最大的 n + 1。
   ```
   const n = Math.max(0, ...existingFileNames.map(parseN)) + 1
   ```
5. **怎麼確認修好了**：單元測試：建 `a1.json`（壞）與 `a2.json`（好），`beginAttempt` 回傳 `a3`。
6. **優先度／把握**：低（本文件建議）；推論（還缺：以上單元測試）。
7. **相依**：C-02（F 會多讀 attempts 時一併處理）。

### C-16 resume 的 Claude lead 不會看到更新後的系統提示（F1，新發現）

1. **編號與標題**：C-16。白話：Claude 預設會把「第一次的系統提示」存起來，之後每次接續都用舊版，我們改了規矩它也看不到。
2. **要改哪裡**：`src/adapters/claude.ts:68-82`（組 `claude` 參數）；影響 G、C-12 等所有「改系統提示」的方案。**改程式或改設計（或先改文件）**；**需要另開任務實作，本次不改**。
3. **為什麼要修正**：依 `claude --help` 文字（未實測）：`claude --help`（2.1.309）說 `--system-prompt-snapshot` 預設開啟：「every later request and resume sends the record as-is, even when a later launch passes different text, until the conversation is compacted.」所以（依 help 文字推論，未實測）`resume:true` 的 agent（lead 預設）永遠看不到 persona、protocol、Rules、G 或優先順序文字的更新。Codex 每次喚醒都透過 stdin 送 persona 與 protocol（`codex.ts:84`），不受影響。**只有 help 文字為證，沒有實測**。
4. **怎麼修正**：
   - 改前（現在的行為）：會變動的規則放在系統提示（`--append-system-prompt-file`，help 說 snapshot 包含它），resume 時沿用舊版。
   - 改後（目標行為）：兩條路：(a) 把會變動的規則放進 user prompt（每次都重送），不放系統提示；(b) 在 Claude 啟動參數傳 `--system-prompt-snapshot off`（`claude --help` 2.1.309 列出 `--system-prompt-snapshot <on|off>`；關閉後的實際行為未實測）。先做實驗確認再選。實驗：用 `--resume` 接續一個舊 session，並傳不同的 `--append-system-prompt-file`，看實際生效的是哪一份。
5. **怎麼確認修好了**：實驗顯示接續後新規則生效。
6. **優先度／把握**：中（本文件建議）；推論（還缺：真實 Claude 的 resume 實驗；行為依 Claude Code 版本，寫入前重讀 `claude --help`）。
7. **相依**：無；C-12、C-05 在實作前先看這條的結果。

## 被推翻的項目

評估報告的子論點或建議修法被驗證推翻的，逐項列出（沒有省略）。每項：評估報告原本說什麼 → 實際情況 → 證據。對應的修正建議見 A 類。

| # | 評估報告原本說什麼 | 實際情況 | 證據 | 對應 |
|---|---|---|---|---|
| 1 | §2 最後一段、I-19：「R1／R2 兩份均漏 lead 重試會 resume」 | R1:41 已寫「同一個模型重試則沿用該 key 的 session（推論，未驗證）」 | R1:41；`run-session.ts:429` | A-01、A-02 |
| 2 | §2、I-03、§7a：「失敗也寫回 sessionId」 | 只有失敗結果帶回 id 時才寫回；逾時、取消、spawn 失敗都沒有 | `process-runner.ts:174,214,216-217`；`run-session.ts:449`；語料 18 個失敗 attempt 中 6 個逾時 | A-01 |
| 3 | §2：「`:413` 不準確，因為同候選重試會沿用 session」 | 原因講錯：`:413` 是備援候選（key `agent@key`）。只有備援已有自己的 session 且 resume 為真時才不準 | `run-session.ts:413,423` | A-02 |
| 4 | I-18／§7b #11：「缺 `can_edit_agent_md` 警告」 | 已有：`can_edit_agent_md widens Codex writable roots to whole agent directories.` | `policy.ts:203` | A-04 |
| 5 | I-17／§3 #12：「Codex＋`can_edit_agent_md` 時成立」 | 條件錯：該 agent 被授權，guard 不還原，沒有髒窗口；窗口只在無 OS 沙箱時，或 Codex 的 repo 指示檔（`policy.ts:200-201`）。檢查在 `worktree.ts:541`，不是 `:500` | `policy.ts:196-203`；`codex.ts:7-11`；`worktree.ts:541` | A-03 |
| 6 | I-19 修法選項：「備援一律不帶 sessionId」 | 不可取：lead 在長冷卻期間停在備援，每次喚醒都失去連續性 | `run-session.ts:423,429`（備援 session key 與主模型分開，resume 時沿用） | A-02、C-07 |
| 7 | I-03 修法：只在 `sessionId === undefined` 時注入 | 會替 lead 關掉 F（lead 預設 resume，通常有 id），連 2d1b53 這個 F 案例都排除 | `config.ts:236`；2d1b53 的 `done.md` 被 park | A-05、C-03 |
| 8 | I-20 修法：「`routeOutboxes` 超長就 reject」 | 較差：多一次喚醒；與格式拒收、重複檢查互動；管不到 dispatcher 自己寫的信。較好：prompt 端截斷並附檔案路徑（沿用 `task.ts` 16 KiB 模式） | `task.ts:6`；`prompt.ts:304`；`run-session.ts:430-432` | A-06、C-08 |
| 9 | I-21 修法：「COMMON 超過 8 KB 就擋 `done`」 | 風險：既有專案升級後立刻無法 `done`；單人模式 agent 不能寫 COMMON 而被鎖死。較好：非阻擋提醒＋`status` 警告 | `mailbox.ts:307-322`；`solo.ts:18`；`policy.ts:120,131,155` | A-06、C-09、C-10 |
| 10 | I-23 提議順序：「lead task > COMMON > records > 個人 memory，順序由 lead 決定」 | 自相矛盾；漏 AGENT.md、repo／user 層級 CLAUDE.md；不可把任務放在 Rules 之上（寫入限制必須永遠贏） | `prompt.ts:218-223`；v2 I-23 | A-06、C-12 |
| 11 | I-10：「R1 漏 COMMON 注入」 | R1 有寫（R1:7,22,84）；真缺口是 R1:96 的「跨 run 只能靠 global／project memory 與 records」沒列 COMMON | R1:7,22,84,96；`prompt.ts:253` | A-07、B-03 |
| 12 | I-02：「R2:165 的呼叫點寫錯」；「必須在 `beginAttempt` 前選」 | R2:165 只說「兩處呼叫點」，沒指名（未規定，不是寫錯）；新 attempt 狀態是 `started`，候選條件是 `failed`，不需在 `beginAttempt` 前選 | R2:165；`run-session.ts:379,440,493,498` | A-07、C-02 |
| 13 | I-05、§3 metadata 漏記 park、§3 timeout 0 B：標推論／未驗證 | 現已驗證：7 個 `started` 的 attempt 各自都是該 run 的最後一個事件，之後都沒有再 resume；18 個失敗 attempt 的 `parked` 與 `outbox/` 吻合（另兩個後期案例也吻合）；`log/stdout.log` 為 0 B | 腳本掃描 `runs/*/mail/attempts`；3d9300 `…a1`/`a2`、2d1b53 `…a1`/`a2` 的 stdout 皆 0 | A-08 |
| 14 | I-06：「Memory 段已有同樣要求」 | 重疊，不相同：現有文字沒說「何時寫」，也沒說被中斷後會從它重來 | `prompt.ts:213-215` | A-07、C-05 |
| 15 | I-25 修法：「`src/` 與 HEAD f41a39c 無差異」 | 重蹈覆轍：`f41a39c` 是 run 052756 的 snapshot，不是 `main` 的祖先，`clear` 後消失 | `git merge-base --is-ancestor f41a39c HEAD` rc=1；`run-cleanup.ts:89-90` | A-09 |
| 16 | I-26 修法：「截至 run 052756 前」 | 語料結束於 d52bff（040459）之前；前 17 個 run id 全在其前 | `ls runs \| sort`：第 17 個 c0594a、第 18 個 d52bff | A-09、B-10 |
| 17 | §6／I-31：「摘要 9 條」「儲存格 >400 字」 | 摘要 10 條；R1:41 那格約 386 字（去空白 384） | R1:7-16；R1:41 | A-10 |
| 18 | §3／I-11／I-30／I-25／I-17／I-10 等的引用：R1:174、R2:94／174、R2:9、R2:5、R2:8、`cli.ts:633,643,666`、`config.ts:136-145` | 應為 R1:173；R2:94／174 談 git 可見性而非讀取權限；R2:7；R2:6；R2:9；clear 在 `cli.ts:468`（633/643/666 是 tidy 的選項與鎖）；`config.ts:215,236`（136-145 是通用 `pick`） | 31 項引用抽查：25 項吻合、5 項差 1–2 行、1 項主題不對 | A-11 |
| 19 | §9：#4 標題寫「`done` 不檢查 COMMON」但編號清單漏 I-21；整段漏 I-20 | 兩項都應列入；#5 多為低優先或推論項 | 評估報告 §9 與 §8 對照 | A-12 |
| 20 | §1：R1、R2 偏差用同一標準計數 | 不一致：`claude.ts:11-20` 在 R1 算偏差，R2:72 同引用不算；R2 `:440` 算失敗而 R1 偏 1 行算成立 | `claude.ts:11-22`（denyRules 到 :22，`Edit` 規則在 :13、:20）；R2:114 | A-10 |
| 21 | I-28：「grep 35–40」 | 實際 31–48，看詞表；它依賴的 `f1.sh`／`rc.sh` 不在 repo，與它批評 R2 的不可重現相同 | v3 重算：31／47／48 | A-10、B-12 |

## 建議執行順序

共 8 步，43 條（A-01…A-12、B-01…B-15、C-01…C-16）每一條都在其中一步出現；同一步內依相依關係由前往後做。

1. **A-01、A-05、A-08、A-09、A-12（先更正評估報告的事實、標籤、基準與優先度）**：後面所有條目都引用這些修正。A-09 必須先於 B-10，A-12 必須先於 B-09。
2. **B-10、B-11、B-12（先把語料規則與數字寫對）**：之後所有「幾次、幾個 run」的說法都建立在這裡。
3. **B-01、B-07、B-08，以及 B-02、B-03、B-04、B-05、B-06（補 R1／R2 的範圍與缺漏）**：模式矩陣、user 層級 context、可讀性標籤是 G／F 規格適用面的前提；其餘五條是互不相依的文件缺口。
4. **C-01、C-02、C-03、C-04（G／F 規格補洞）**：決定 R2 的 MVP 能不能實作；四條要一起定規格。
5. **C-06（跨 run guard）**：影響所有並行 run，優先度高；需 architect 先做設計決定與兩個 fake run 的驗證。
6. **C-16、C-12、C-05（F1 先實驗，再決定 Rules 與 G 的文字）**：不知道系統提示會不會被 resume 擋住，就不該寫新的 Rules 文字；C-05 要等 B-01（步驟 3）與 C-01（步驟 4）完成。
7. **C-10、C-09、C-08（單人鎖死、COMMON 提醒、mail 長度）**：C-10 是 C-09 的前提；C-08 用 prompt 端截斷即可。
8. **其餘條目依編號處理**：A-02、A-03、A-04、A-06、A-07、A-10、A-11、B-09、B-13、B-14、B-15、C-07、C-11、C-13、C-14、C-15。它們不影響行為或發生機率低；依相依關係，A-03、A-04 在 B-15、C-14 之前，B-09 在 B-14 之前，A-02 在 C-07 之前。

## 還沒解答的問題

下列都需要真實 runtime（花費模型呼叫）或端到端的整合測試，這次只做靜態讀取與既有 run 資料，沒有做：

- **F1**：`claude --system-prompt-snapshot` 預設開啟時，resume 之後新的系統提示真的不生效嗎？（只有 help 文字為證。）
- **Codex 是否自動載入 `AGENTS.md`？** 與 repo 層級的 `CLAUDE.md` 是否被載入（本 repo 兩者皆無，沒法觀察）。
- **Claude 的 `--resume` 在一次嘗試被殺掉之後，session 內是否含被殺那次的 turns？**（決定 C-03 的「重複注入」是否有害。）
- **I-08 端到端**：兩個並行的 fake run，確認 A 的 guard 真的還原 B 的 COMMON，且 A 的 `violations/` 與 log 有紀錄。
- **單人 `done` 鎖死（C-10）**：records 超過 6 KB＋`run --agent`＋`done`，是否真被拒到 `max_rounds` 用完。
- **C-14**：Codex 成員開 `can_edit_agent_md` 時，實際沙箱是否放行 lead checkout 根與所有 `agents/<x>/`。
- **`--add-dir` 的資料夾**（memory、records、`_shared`）內若放 CLAUDE.md，是否被 Claude 載入（B-07，推論）。
- **Linux（bwrap）** 下「他人 memory 可讀」是否相同（B-08，只在 macOS 驗證）。
- **G 的實際成效**：是否達到 ≥50% 的任務有 task memory，需要新的 run 資料。
- 「40 KB 約 10–13k token」的估算：沒用 tokenizer，無法驗證。

## 限制

- 這份清單只靠**靜態讀取程式碼與既有 run 資料**；沒有呼叫付費模型，也沒有執行 `claude`／`codex` 的真實任務（只讀 `claude --help`，它不連網）。凡寫「推論」的都是這個原因。
- **語料**：見〈名詞小字典〉。若某處改用別的範圍（例如全部 19 個非當前 run：179 封信、19 次 request-changes、76 封回覆分佈在 13 個 run），該處會明說。語料小、來自單一專案，優先度的調整是方向，不是量測。
- **行號基準**：`main` 上的 commit `088a180`。**不要使用 `f41a39c` 或 `55ae335`**：它們是 run 的 snapshot，不是 `main` 的祖先，`clear` 之後就查不到。比對過：`git diff --stat f41a39c HEAD -- src` 為空，所以這些 `src/` 行號在兩處相同。
- 驗證所用的 v1、v2、v3 放在本次任務的 task memory（repo 外），`clear` 後會消失；因此每條都直接寫了 `檔案:行號` 與可複製的指令。
- 行為依 Claude Code 版本（驗證時為 2.1.309）；寫入規格前請重讀 `claude --help`。
- 審查者與作者同為 Claude，獨立性較弱（沒有可用的 Codex 審查者）。
