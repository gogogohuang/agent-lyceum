# 兩份分析報告的評估

基準 commit：`f41a39c`（唯讀評估；R1 = `docs/analysis-agent-context-and-mail.md`，R2 = `docs/analysis-context-sharing-need.md`）。

## 結論摘要

- 兩份報告的程式碼引用可信：R1 抽查 48 處全部成立（3 處差 1–2 行、1 處重複貼上）；R2 抽查 38 處 37 處成立（1 處位置寫錯）。
- R2 的主結論「不做廣泛共享，只做 G＋F」站得住，沒有被本次評估推翻；但 G 的觸發點放錯位置（c1 走 resume，不會進 `retryPrompt`），F 的規格有 3 個洞，必須先補。
- 兩份報告都漏了三個範圍：team／`run --agent`／`call` 三種模式、跨 run 的 guard 交錯（推論）、ask 回答只投遞給提問者。
- 多項標「推論／未驗證」的說法現在已可驗證（他人 worktree／memory 可讀、Claude 預設載入 CLAUDE.md、`done` 不檢查 COMMON）；Codex 的行為仍需真實 runtime。
- R2 數字大致可重現（7 項中 6 項吻合），但兩個歸因（缺 context 的 request-changes、重新探索環境）是人工分類，只驗證了計數；「13 個 run」實為 11 個。
- 改善項目共 31 項（表見 §8）；建議先做的前 5 項見 §9。

## 1. 引用與基準 hash 抽查

| 報告 | 抽查 | 成立 | 偏差 |
|---|---|---|---|
| R1 | 48 | 48 | 3 處差 1–2 行：`claude.ts:11-20` 應為 11-22、`claude.ts:65` 應為 66、`listUnread` 的 155-180 應為 165-180；R1:63 的 `src/prompt.ts:138-140` 重複貼了兩次 |
| R2 | 38 | 37 | 1 處位置寫錯：`run-session.ts:440` 是加上 retry 提示處，同 wake 重試迴圈在 `src/fallback.ts:204-226` |

另核對 `format.ts:5-9`、`run-store.ts:282-287`、`records.ts:12`、`format-rejections.ts:6-7`，皆吻合。

**基準 hash（已驗證）**：R2 寫的 HEAD `55ae335`（及證據檔的 `eb6201f`）是 `git cat-file -t` 為 commit，但 `git merge-base --is-ancestor` 兩者皆 rc=1，不是 HEAD 的祖先，而是 d52bff run 分支上的 snapshot（與 HEAD 的 merge-base 是 `1d4593b`）。`git diff --stat 55ae335 HEAD -- src` 與 `git diff --stat eb6201f HEAD -- src` 輸出皆為空，所以 `src/` 行號引用仍然成立；不準確的只是「HEAD」這個字面。

## 2. R1／R2 一致性

兩份報告沒有互相矛盾；差異多是「一份有寫、另一份未述」。

| 事實 | R1 | R2 | 一致？ | 符合 HEAD |
|---|---|---|---|---|
| 備援 fresh／resumed | R1:11,41,173 不繼承主模型、指出 fresh 提示不準 | R2:33,155 語料無備援事件 | 無矛盾 | 是（`run-session.ts:421-449`、:413） |
| records 6 KB | R1:24,169 每種整筆預算 | R2:56,60 同 | 一致 | 是（`records.ts:12,118-139`） |
| done 預算拒絕 | R1:57,169 | R2:91 未交代拒絕 | 缺細節 | 是（`mailbox.ts:307-318`，不檢查 COMMON） |
| guard 範圍 | R1:10,50,102 固定檔＋records | R2:76 「只比對交接索引一個檔」 | 限定為 handoff 時一致，無限定易誤讀 | 是（`guard.ts:47-54,107-133`） |
| `paths.common` | R1:31,166 指出死欄位 | 未述 | 無矛盾，舊建議未被處置 | 是（`paths.ts:65`，`rg 'paths\.common' src` 無輸出） |
| memory 共享／保密 | R1:9,39,52,115 | R2:70-74,85 | 一致 | 是（`prompt.ts:279-288`、`claude.ts:29`） |
| session 預設／重試 | R1:11,40,119 lead resume、成員 fresh | R2:18,63 成員 fresh | 一致，R2:63 省略「預設」 | 是（`config.ts:136-145,236`；`run-session.ts:429,449`） |
| follow-up／handoff | R1:25,94-95 保留 sessions | R2:32,58,154 | 相容；協定文字落差兩份都漏 | `prompt.ts:47` 稱 fresh，`run-session.ts:209,222-235` 保留 sessions |
| mail 長度 | R1:71-73,167 建議加上限 | R2:64 | 一致；拒絕 C 不等於否決 mail 上限 | 是（`prompt.ts:304` 原樣放入 body） |

**Lead 重試的 session（兩份均漏）**：lead（resume:true）同 candidate 重試會 `--resume` 失敗那次的 session（`run-session.ts:423,429,449`，失敗也寫回 sessionId）；成員預設每次新 session（`config.ts:236`）。因此備援提示 `run-session.ts:413` 的 "starts a fresh session" 在 resume 為 true 時不準確。

## 3. 「推論／未驗證／未知」項目判定

| 項目（位置） | 判定 | 方法與結果 |
|---|---|---|
| Runtime 自動載入 repo CLAUDE.md／AGENTS.md（R1:16,85,118,136,165） | Claude：已驗證 flag；Codex：需真實 runtime | `claude.ts:66-82` 無 `--bare`／`--setting-sources`，`claude --help` 說 `--bare` 才跳過 CLAUDE.md 探索；`codex.ts:78-79` 只有 `-C`。最小實驗：在 `$TMPDIR` scratch repo 放 `AGENTS.md`「第一行寫 MARKER-123」，跑 `codex exec -C <dir> -s workspace-write --skip-git-repo-check "say hi"` 看輸出（會用付費模型，需使用者同意） |
| 他人 worktree 可讀（R1:27,51,168；R2:94,174） | 已驗證（Claude） | `policy.ts:158` 只限寫；實測 `git -C …/worktrees/<run>/tech-lead log -1` 成功。Codex 預設可讀：推論 |
| 他人 memory 可讀（R1:52,115） | 已驗證（Claude） | `head …/cli-architect-reviewer/memory/MEMORY.md` 成功；`policy.ts:148` 只列寫入 deny |
| 重試／備援是否沿用 session（R1:41,174） | 已驗證（靜態） | 見 §2 末段 |
| `done` 檢查 COMMON 大小（R1 §6 #6） | 已驗證：不檢查 | `mailbox.ts:307-318` 只查 records；COMMON 僅在 prompt 截斷（`prompt.ts:255-260`） |
| 並行 wake 讀到未還原的髒檔（R1:175 #12） | 靜態路徑已驗證；實際交錯未重現 | guard 在整批結束後才 check（`run-session.ts:593`，`guard.ts:38-55`）。只在「無 OS sandbox」或「Codex＋`can_edit_agent_md`」時成立（`codex.ts:7-11`、`policy.ts:202`）；成員 worktree 指令檔另由 `worktree.ts:500` 擋下 |
| resume session 與新 COMMON 衝突（R1:170 #7） | 需真實 runtime | 靜態只能確認新舊並存（`config.ts:236`、`prompt.ts:253-260`）；模型如何取捨需實測 |
| metadata 漏記被 park 的草稿（R2:41,172） | 未驗證 | 方法：逐 run 比對 `mail/attempts/*/outbox/` 與 state／log 的 `parked` |
| timeout 嘗試 stdout 為 0 byte（R2:171） | 未驗證 | 方法：對應 attempt 的 `log/stdout.log` 做 `wc -c` |
| 40 KB ≈ 10–13k token（R2:60,175） | 未驗證 | 需 tokenizer，或由舊 run 的 Claude result JSON usage 反推 |
| c2／c3 因果、timeout 沒留 mail、筆記降低耗時、錨定效應（R2:16,17,42,47,68,144,147） | 推論（標得對） | 語料因果歸因，無對照實驗 |
| 成員每次 wake 重付固定內容（R2:63） | 「重付」已驗證，成本大小為推論 | `config.ts:236` 成員 fresh；`prompt.ts` 每次重組 |
| dispatcher 代讀有 confused deputy 風險（R2:74） | 設計推論（合理） | 針對未實作的 C 方案 |

## 4. 數字重算

指令：`git rev-list`、`ls runs`、`find runs/*/mail/inbox`、`grep -A3 '^## Verdict'`、`attempts/*.json` 計數。

| 數字 | R2 值 | 重算 | 結果 |
|---|---|---|---|
| runs | 17 | `ls runs` 19，排除當前 run 與 d52bff = 17 | 吻合（排除規則正文未寫） |
| inbox mails | 147 | 18 個 run 共 158，去掉 d52bff（11）= 147 | 吻合 |
| request-changes | 15 | request-changes 15、approve-with-comment 4、approve 4、pass 2 | 吻合；集中度：0a2b9f=5、6e01a3=3（兩個 run 占 8/15） |
| 失敗 attempt | 18（6 interrupted、6 timeout、6 runtime） | 153 個 attempt：committed 128、failed 18、**started 7**；失敗中 interrupted 6、timeout 6、其餘 6 | 吻合；另有 7 個 `started` 未被報告提及（來源未查；resume 時 recovery 會把 `started` 轉為 failed／interrupted，見 `run-session.ts:843,869`、`message-store.ts:257-260`、R2:115，故應不構成 F 的缺口（推論）） |
| 成員回覆數 | 61（13 個 run） | lead inbox 82 封扣 user／dispatcher = 61，分布在 **11** 個 run | 回覆數吻合，run 數差 2（原因未查） |
| 36／61 重新探索環境 | 36 | 關鍵字 grep 35–40（依詞表） | 數量級接近；人工分類無法機械重現，屬推論 |
| node-engineer 被喚醒 8 個 run、1 個留 task memory | 8／1 | 8 個 run；僅 0a2b9f 有 `task-memory/<run>/node-engineer` | 吻合 |
| G 成本 | 173 B／29 B | `Buffer.byteLength` 為 173、29 | 吻合 |

## 5. 缺口清單

| 編號 | 缺口 | 把握 |
|---|---|---|
| E1 | 只分析同批 wake，漏掉跨 run 時序：A 批次取得基準後 B 的 lead 合法更新 COMMON／records，A 的 guard 把它還原或移除。未實跑 | 推論 |
| E2 | 一般 team wake 被泛化為所有 agent；漏 `call`（只留 global memory、resume=false、無 mail／ask、無 COMMON／records）與 `run --agent`（保留 resume、不可寫 COMMON／records），G 的適用面不明 | 已驗證 |
| E3 | ask 路徑：使用者回答只投遞給提問者（from=user 的 reply），不廣播；`--assume-defaults` 產生 by=default，不能稱使用者親答 | 已驗證 |
| E4 | tidy 不收到 COMMON／handoff 內容、不能改它們；`clear` 清整個 task-memory/run（含 `_shared`）與 run/mail，保留 COMMON／records／project／global memory，兩份均未交代 | 已驗證 |
| E5 | `prompt.ts:47` 說 follow-up 為 fresh sessions，實際保留 `resume.sessions`（`run-session.ts:209,222-235`） | 已驗證 |
| E6 | guard 範圍需限定；records 上層為 symlink 時 guard 跳過該批保護（`guard.ts:109-110`） | 已驗證 |
| E7 | 初始任務 >16 KiB 時 mail 只含讀 `task.md` 的指示與首十行（`task.ts:5-6,55-78`），屬引用式 context | 已驗證 |
| E8 | R2 沒有逐項處置 R1 §6 的 13 項建議，不能把「不做 B／C／D／E」讀成 13 項全否決 | 已驗證 |

## 6. 可讀性

- 標註慣例不一致：R1:3 只有「推論，未驗證」，R2:8 用觀察／推論／未知。
- R1:5-16 摘要 9 條、每條 2–4 行且塞滿行號，與 §1–§5 重複；R1:41 儲存格 >400 字，與 §6 #10 重述同事。
- R1 §6 #10 內含自我撤回（「故不需新增此建議」），不像建議；R2:11-24 結論段巢狀層次亂；R2:167 「本題額外加的維度」為任務敘述殘留。
- R2:5 的證據檔在 repo 外，`clear` 後消失（`how-it-works.md:43`）。
- 兩份報告放在 `docs/` 頂層與使用者文件同層，且只有中文；建議標頭註明「分析快照，非現行規格」。
- 可併入使用者文件：write-scope 文件缺「寫入範圍不是讀取隔離」一句；how-it-works 缺「context 優先序未定義」；其餘（mail 格式、重複防護、fresh session）已涵蓋。併入需同步 zh-TW 並跑 `check:docs`。

## 7. G／F 規格漏洞與 R1 §6 狀態

### 7a. G／F 規格漏洞

| 項 | 漏洞 | 把握 |
|---|---|---|
| G 觸發點 | 把「Read your task memory first.」加在 `retryPrompt`，但 `retryPrompt` 只在 `ctx.attempt > 0`（`run-session.ts:440`），`attempt` 每次 wake 從 0 開始（`fallback.ts:204`）；c1（d041c8）resume 後重做的 wake 是 `"attempt":0`，不會進 `retryPrompt` | 已驗證 |
| G 措辭 | Memory 段已有同樣要求（`prompt.ts:213`），node-engineer 仍 1/8 run 有寫；只改措辭恐無效 | 措辭已存在：已驗證；成效：推論 |
| F 計算時機 | `base.userPrompt` 只算一次（`run-session.ts:379`），同 wake 剛被 park 的草稿（:498）會漏掉；應每次 invoke、`beginAttempt`（:426）前重選 | 已驗證 |
| F 與 `retryPrompt` | 現有 "Its mail was discarded … send the mail again"（`run-session.ts:45`）與草稿段互相矛盾 | 已驗證 |
| F 與 resume | lead 重試已 resume 失敗 session，再注入會重複；應只在全新 session（`sessionId === undefined`）注入 | 程式路徑已驗證；是否有害為推論 |
| F attempt 編號 | JSON 損壞時 `listAttempts` 跳過，`beginAttempt` 編號變小並覆寫（`message-store.ts:217,237`）；未實測 | 程式路徑已驗證 |
| F 其他 | 重複檢查不讀 `mail/attempts`（`mailbox.ts:230-247`）、`parkOutbox` 跳過子目錄（`message-store.ts:235`）、讀取契約相容（`paths.ts:4`）、message id 交集可對上 c1（兩個 claim 皆 `463774b6`）：皆無需改，建議在規格註明 | 已驗證 |

### 7b. R1 §6 十三項現況

| # | 項目 | 現況 | 證據 | 優先度 |
|---|---|---|---|---|
| 1 | context 優先順序未定義 | 開放 | `prompt.ts`、`how-it-works.md` grep precedence 無結果 | 中 |
| 2 | repo CLAUDE.md／AGENTS.md 是否載入 | 開放（Claude 已可確認 flag） | §3 | 低 |
| 3 | `paths.ts:65` 死欄位 | 開放 | `rg 'paths\.common' src` 無輸出 | 中 |
| 4 | mail 內文無上限 | 開放 | `prompt.ts:304` | 高 |
| 5 | 無附件機制 | 開放（僅缺文件） | `mailbox.ts:32-36` | 低 |
| 6 | `done` 不檢查 COMMON 大小 | 開放（正確，非過時） | `mailbox.ts:307-322` | 中 |
| 7 | resume session 與新 COMMON 衝突 | 開放（推論） | `config.ts:236` | 低 |
| 8 | 重複注入 | 開放 | `prompt.ts:253-288` | 低 |
| 9 | 遺失 mail（忽略 failure） | 開放 | `run-session.ts:663-665`；done 前不檢查 `rejected/` | 中 |
| 10 | 備援提示 "fresh session" 不準 | 前半（備援提示 "fresh session" 不準）開放，見 I-19；後半（retry 提示）報告已自行撤回 | `run-session.ts:413,423,429,449` | 中 |
| 11 | 無 OS sandbox 警告 | 部分已處理 | `policy.ts:196,202`、`validate.ts:132`、`cli.ts:557`；缺 `can_edit_agent_md` 警告 | 低 |
| 12 | guard 事後還原 | 開放（推論）；窗口條件較窄，worktree 分離已存在 | §3 | 低 |
| 13 | memory 跨任務洩漏 | 開放（只靠規範） | `prompt.ts:213-215` | 低 |

## 8. 改善項目表

| 編號 | 位置（檔案＋段落/行） | 問題 | 證據 | 建議修法 | 優先度 | 把握 |
|---|---|---|---|---|---|---|
| I-01 | R2 §4 G（R2:102-103） | G 觸發點錯位：c1 resume 後 `attempt` 為 0，不進 `retryPrompt`，G 後半句對主要事件無效 | `run-session.ts:440`、`fallback.ts:204`；d041c8 `log.jsonl` 的 `"attempt":0`；兩個 claim 皆 `message_ids:["463774b6"]` | 改以 F 的候選 attempt（同 agent、message id 有交集、failed）判斷觸發；qa 加「interrupted→resume→重做 prompt 含提示」測試 | 高 | 已驗證 |
| I-02 | R2 §4 F 呼叫點（R2:165） | 草稿只在 `base.userPrompt` 算一次，同 wake 重試拿不到剛 park 的草稿 | `run-session.ts:379,426,498` | 每次 invoke、`beginAttempt` 前重選；固定草稿段位置（retry 提示之後）；加「a1 寫 outbox 後 timeout→a2 prompt 含草稿」測試（需確認為同 wake） | 高 | 已驗證 |
| I-03 | R2 §4 F 與 resume | lead 重試已 resume 失敗 session，F 再注入會重複（重複注入的程式路徑已驗證；是否有害為推論） | `run-session.ts:423,429,449`；`config.ts:236` | 規格明訂：只在 `sessionId === undefined` 時注入，或寫明接受重複 | 中 | 已驗證 |
| I-04 | R2 §4 F 與 `retryPrompt`（`run-session.ts:45`） | 「mail was discarded … send again」與草稿段矛盾 | `run-session.ts:45` | 有草稿時改為「set aside, not delivered; drafts below as unverified」；無草稿時文字不變 | 中 | 已驗證 |
| I-05 | R2 attempt 統計（R2:40） | 7 個 `started` attempt 來源未查；resume 的 recovery 會轉為 failed／interrupted，因此可能不構成 F 的缺口（推論） | `run-session.ts:843,869`、`message-store.ts:257-260`、R2:115；計數 committed 128、failed 18、started 7（§4） | 僅作統計註記；如要確認，查這 7 個 attempt 所屬 run 是否曾 resume | 低 | 推論 |
| I-06 | R2 §4 G 第 1 點（R2:102） | 只改措辭，Memory 段已有同要求（`prompt.ts:213`），難改變行為 | `prompt.ts:213`；R2 §1:46 為 1/8 | 把觸發條件放入 `## Rules`；告知 wake 時限秒數（`cfg.wake_timeout_sec`）；沿用 ≥50% 驗收，連續無改善就撤掉 G | 中 | 推論 |
| I-07 | R1:7-11,20-43；R2:51-63,98-104 | 缺 team／`run --agent`／`call` 模式矩陣，G 適用面不明 | `call.ts:48-65,187-195`、`prompt.ts:105-120`、`solo.ts:15-20`、`policy.ts:120-135` | 加三模式矩陣，限定「所有」；G 明訂是否涵蓋 solo run，call 標 N/A | 高 | 已驗證 |
| I-08 | R1:50,175；R2:76,163 | 漏跨 run guard 交錯（合法共享寫入被另一 run 的 guard 還原） | `policy.ts:32-47`、`project-lock.ts:299-305`、`run-session.ts:926-932`、`guard.ts:84-100,107-132`；未實跑 | 補跨 run 時序與限制；QA 以兩個隔離 fake run 驗證；歸因／協調另案 | 高 | 推論 |
| I-09 | R1:57；R2 全文 | 缺 ask 回答流向：答案只給提問者；`--assume-defaults` 為 by=default | `mailbox.ts:298-304`、`run-session.ts:707-723,731-775`、`ask-reply.ts:196-214` | 補 ask→ask-reply→提問者 inbox 路徑；說明共享決策仍須提問者／lead 持久化 | 中 | 已驗證 |
| I-10 | R1:73,96；R2:64 | 漏初始任務引用式 context（>16 KiB 只給指示與首十行）與 COMMON 注入 | `task.ts:5-6,19-38,55-78`、`run-session.ts:283-285`、`prompt.ts:253-261` | 補 user→task.md／seed mail→lead 路徑與上限；「只能」改為「自動注入的既定來源」 | 中 | 已驗證 |
| I-11 | R1:171,176；R2:66 | tidy／clear 的 context 生命週期未交代 | `memory-tidy.ts:298-299,348-355,367-400`、`prompt.ts:389-430`、`run-cleanup.ts:92-94`、`cli.ts:633,643,666` | 分列自動載入、可讀、可整理、可刪除；不暗示 tidy 自動解決 COMMON 過期 | 中 | 已驗證 |
| I-12 | R1:94；R2:32,58,154 | follow-up「保留 sessions」與協定文字 "fresh sessions" 不一致 | `prompt.ts:47`、`run-session.ts:209,222-235,429,449` | 記錄落差；或改協定文字，或清除 sessions（由 lead 決定哪個錯） | 中 | 已驗證 |
| I-13 | R2:76；R1:50,102 | guard 範圍缺限定；records 上層為 symlink 時跳過保護 | `guard.ts:47-54,107-133`（:109-110） | R2 加「就 handoff 而言」並引 R1 清單；R1 補 symlink 例外 | 中 | 已驗證 |
| I-14 | R1:16,85,118,136,165 | Claude 載入 CLAUDE.md 標推論，但 flag 可確認（Claude 已驗證 flag；Codex 仍為推論） | `claude.ts:66-82`、`claude --help` | 改為「Claude：預設 auto-discovery（已驗證 flag，未實測順序）；Codex：推論」；Codex 以 §3 實驗確認 | 中 | 已驗證 |
| I-15 | R1:27,51,52,115,168；R2:94,174 | 他人 worktree／memory 可讀被標未驗證 | `policy.ts:148,158`、`claude.ts:29`；實測 `git -C`、`head` 成功 | 改標已驗證（Claude），引 lesson `write-scope-is-not-read-isolation`；write-scope 文件補一句「非讀取隔離」 | 中 | 已驗證 |
| I-16 | R1 §6（R1:162-176） | 13 項建議無優先度、狀態與 owner；R2 無處置表 | R1:162-176；R2:85-98；E8 | R1 §6 改表並加「優先度／狀態」欄；R2 加 disposition 表（採用／拒絕／另案／待證據） | 高 | 已驗證 |
| I-17 | R1 §6 #12（R1:175） | 成立條件未寫，且建議的 worktree 分離其實已存在（靜態路徑已驗證；實際交錯為推論） | `run-session.ts:593`、`guard.ts:38-55`、`worktree.ts:500`、`policy.ts:196-203` | 改寫為「僅無 OS sandbox，或 Codex＋`can_edit_agent_md` 時成立」；該建議改為「已有」 | 中 | 已驗證 |
| I-18 | R1 §6 #11（R1:174） | 已部分實作卻寫成待辦 | `validate.ts:132`、`cli.ts:557`、`policy.ts:196,202` | 標「已有 notes，只缺 `can_edit_agent_md` 警告」 | 低 | 已驗證 |
| I-19 | `src/run-session.ts:413`（R1 §6 #10） | 備援 note "starts a fresh session" 在 resume 為 true 時不準；R1/R2 均未提 lead 重試會 resume 失敗 session | `run-session.ts:423,429,449`；`config.ts:236` | 改提示文字（如 "in a session of its own"）或備援一律不帶 sessionId；兩份報告補 lead／成員差異 | 中 | 已驗證 |
| I-20 | `src/prompt.ts:304`、`src/mailbox.ts`（R1 §6 #4） | mail 內文無長度上限，原文入 prompt | `prompt.ts:304`；mailbox 無 body 上限 | `routeOutboxes` 加位元組上限（超過退回並要求改寫為檔案路徑）或 prompt 端截斷附路徑 | 高 | 已驗證 |
| I-21 | `src/mailbox.ts:307-322`（R1 §6 #6） | `done` 不檢查 COMMON.md 大小，只截斷（`prompt.ts:255-260`） | `mailbox.ts:307-322` | 比照 records，COMMON 超過 8 KB 時退回 `done`；或報告明寫「只截斷不擋」 | 中 | 已驗證 |
| I-22 | `src/mailbox.ts:307-322`、`src/run-session.ts:663`（R1 §6 #9） | `done` 前不檢查 `rejected/`，lead 可能在有被拒 mail 時完成 | `run-session.ts:663-665` | `done` 時列出未處理 rejected 筆數並寫入 note | 中 | 已驗證 |
| I-23 | `src/prompt.ts:218-223`（R1 §6 #1） | Rules 沒寫 context 優先順序 | grep precedence 無結果 | 加一行：lead task > COMMON > records > 個人 memory（順序由 lead 決定） | 中 | 已驗證 |
| I-24 | `src/paths.ts:65`（R1 §6 #3） | `common` 指向 `shared/COMMON.md`，與實際 `shared/common/COMMON.md` 不符且無人引用 | `rg 'paths\.common' src` 無輸出；`policy.ts:33` | 刪除欄位及型別（程式碼瑕疵，轉 issue 後自報告移除） | 中 | 已驗證 |
| I-25 | R2:9（前言 HEAD 描述） | 基準 hash 不是 HEAD 的祖先，而是 run 分支 snapshot | `git merge-base --is-ancestor` rc=1；`git diff --stat 55ae335 HEAD -- src` 為空 | 改為「基準為 run 分支 snapshot 55ae335，`src/` 與 HEAD f41a39c 無差異，未 merge 至 main」；兩份頂端加基準 commit 行 | 低 | 已驗證 |
| I-26 | R2:13,167；證據檔「Scanned」 | 17 run／147 mail 的排除規則（19 減當前 run 與 d52bff）正文未寫；d52bff 有 2 次 request-changes，排除會偏向舊 run | 重算 158−11=147 | 正文補排除規則；結論前註明「截至 run 052756 前」 | 中 | 已驗證 |
| I-27 | R2:35（f1） | 「13 個 run 的 61 封回覆」實為 11 個 run（差異已驗證；原因未查） | `f1.sh`：runs with member replies = 11 | 改為 11，或說明 13 的定義（原因未查） | 低 | 已驗證 |
| I-28 | R2:35,149（36／61） | 「重新探索環境」為人工分類，無可重現判準；grep 35–40 取決於詞表 | `f1.sh` 關鍵字 grep 35／39／40 | 附分類判準與逐封 msg id 清單，或改述「約六成」標推論；基線表使用前先定義 grep 式 | 中 | 推論 |
| I-29 | R2:167；R2 §4 觸發條件 | request-changes 15 次中 8 次集中在 0a2b9f（5）與 6e01a3（3），比例對少數 run 敏感；單一專案自舉語料；sandbox 影響無逐 run 資料（計數已驗證；影響為推論） | rc.sh 每 run 計數 | 結論改「歸因機率受單一 run 主導」，§4 觸發條件用絕對數與 run 數；措辭限定「在本專案語料內」；sandbox 影響標推論 | 中 | 已驗證 |
| I-30 | R2:5；R1:3 vs R2:8 | 事件編號 a1、c1、e1 全靠 repo 外證據檔，`clear` 後消失；兩份標註慣例不同 | R2:5；`how-it-works.md:43`；`grep 觀察` 在 R1 無命中 | R2 附錄內嵌事件編號表；R1 改用觀察／推論／未知三標籤並補「未知彙整」 | 中 | 已驗證 |
| I-31 | R1:5-16,41,§6 #10；R2:11-24,167；R1:63,9,52,67 | 摘要過長、儲存格過長、§6 #10 自我撤回、R2 結論層次亂、「本題額外加的維度」殘留；行號小偏差與 R1:63 重複貼上 | §1 偏差清單；§7b #10 | 摘要縮至 ≤5 條不帶行號；§6 #10 只移出後半（自我撤回的 retry 提示說明），前半保留為開放建議（見 I-19）；R2 結論拆四小節；修正行號並刪重複片段 | 低 | 已驗證 |

## 9. 建議先做的前 5 項

1. **G 觸發點錯位（I-01）**：c1 走 resume→attempt 0，`retryPrompt` 不會出現；不修則 G 的指標會誤判為「無效」（證據：`run-session.ts:440`、`fallback.ts:204`、d041c8 log）。
2. **F 規格補洞（I-02、I-03、I-04）**：每次 invoke／`beginAttempt` 前重選草稿；只在全新 session 注入；改 `retryPrompt` 矛盾文字。這三項決定 MVP 能否實作。
3. **範圍缺口（I-07、I-08、I-09）**：team／solo／call 三模式矩陣、跨 run guard 交錯（推論，需 fake run 驗證）、ask 回答流向。
4. **推論改標已驗證與 §6 處置（I-14、I-15、I-16、I-17）**：他人 worktree／memory 可讀、Claude 載入 CLAUDE.md、`done` 不檢查 COMMON；為 R1 §6 加狀態／優先度欄與 R2 處置表。
5. **R2 證據口徑（I-25、I-26、I-27、I-28、I-29）**：基準 hash 說法、17 run 排除規則寫進正文、61 封回覆實為 11 個 run、36／61 無法機械重現、request-changes 8/15 集中於兩個 run。
