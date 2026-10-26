# 23 同角色動態多實例（M1：lead 決定數量）

狀態：**已核准，可實作**（第 2 輪審查 e41adc17 之後由 lead 仲裁，2c77f98b；不再有審查輪次，cli-reviewer 依 23.15 的具名測試檢查實作）。第 2 版依第 1 輪審查 8342adfe 修訂，第 3 版併入 lead 對 F1、F2、M1、M2 的仲裁（23.2）。輸入：使用者任務 3afade 的 9 條定案決策與使用者回覆 475ce42f（run 的 `task-memory/<run>/_shared/user-task-3afade.md`），以及先前的評估報告（同目錄 `dynamic-instances-eval.md`，下稱「評估」）。評估假設的是 `agents.<role>.instances: N` 設定鍵；使用者改成「lead 標記決定數量＋內部預設上限 4＋可選覆寫」，本文依此改寫評估 §2。

所有 `檔案:行號` 都在目前 HEAD（第 2 版用 `cdb3d18`，第 3 版新增的引用在 `278f392` 重新開檔；兩者 `git diff --stat 6ae0d9e HEAD -- src plugins` 都沒有輸出，所以與評估基準 `6ae0d9e`、第 1 版所用的 `73e67c4` 的原始碼相同）重新開檔確認過；評估的行號只當線索，沒有直接沿用。動態實例尚不存在，所以凡是「新程式會怎樣」都是設計；凡是真實 runtime／OS sandbox 的行為都標「未驗證」。

## 23.1 目標與限制

**目標**：同一個 run 裡，任何非 lead 的角色都可以有多個實例，各自在自己的 worktree 平行處理互不相依的 task；使用者不必在 `project.yaml` 註冊 `frontend-2`。開幾個由 lead 決定：lead 在新 thread 的 task 上標平行，dispatcher 只管上限。

**使用者定案（不重新辯論）**：(1) lead 用 frontmatter 標平行，沒標就不展開，dispatcher 不判斷相依；(2) 實例數 = min(lead 平行任務數, 上限)，rate_limit／quota 冷卻中不新開；(3) 每角色每 run 上限內部預設 4，`project.yaml` 可用一個鍵覆寫；(4) 槽位表決定且可重播，名稱 `<role>--<k>`，實例第一次被派到才建 worktree，崩潰重播／resume／舊版拒絕新 run 都要成立；(5) 只在 worktree 模式，否則上限 1；(6) lead 沒標時行為逐位元相同，用完整 fixture 證明；(7) 同角色共用 role memory、只有一個實例可寫，task memory 各自一份；Linux 無 bwrap 的 Codex 只靠提示，要明講；(8) 實例回信對 lead 顯示角色名＋編號；(9) lead 提示與 AGENT.md 指引何時可標平行。

**字面需求的兩組衝突與使用者核准的取捨**（475ce42f，23.2 的 D-12、D-13）：
- 決策 4「槽位表在 run 開始寫入 state」與決策 6「沒標時 state 逐位元相同」不能同時照字面做到 → 使用者核准延遲寫入。
- 決策 6 若涵蓋 lead 的系統提示，與決策 9「lead prompt 要有平行指引」不能同時照字面做到 → 使用者核准「功能可用時＝HEAD 全文＋固定段落」。

**非目標**：自動判斷相依（觸發 B，評估 §3 已否決）、自動合併同檔衝突、共享模式平行、`run --agent`（solo）平行、per-role 上限鍵（延後，23.19）。

## 23.2 決議總表

### 第 1 輪審查的修訂對照

| 審查項 | 處置 | 改動的節 | 新增測試（23.15） |
|---|---|---|---|
| R1 自訂 memory 路徑讓實例 ≥2 可寫共用 memory | 新增實體包含檢查（realpath、symlink 別名）：啟用前、開實例後、喚醒前、resume 時；衝突就讓該角色不展開（fail closed），doctor 預警 | D-11、D-17、23.4、23.6、23.10、23.11（含強制等級表）、23.13 | T-R1-1…T-R1-7 |
| R2 journal 撕裂尾端吞掉之後的完整紀錄 | append 前先補齊未結束的最後一行；短寫入視為失敗 | D-18、23.8.1、23.14 | T-R2-1…T-R2-5 |
| R3 未標記與直接定址的新 thread 繞過 blocked 保護 | 啟用後，寄給角色**或任一實例名**的信一律進保留佇列；指派器對所有「新 thread」套用同一個接收條件，只有親和性修訂可進 blocked／refused 實例 | D-07、D-15、23.7、23.9 | T-R3-1…T-R3-6 |
| R4 非 lead 也能展開 | 啟用與 `parallel` 只認 router 解析出的寄件人（outbox 擁有者）＝lead；其他寄件人照常投遞、旗標忽略、note＋log；`parallel` 記在 journal、不信任信件檔 | D-01、D-02、23.3、23.7.1 | T-R4-1…T-R4-3 |
| R5 外來 `reply_to` 遮住有效的 `thread` 親和性 | 每個候選 id 各自查 owner、先篩到收件角色，再依序取第一個 | D-08、23.7.2 規則 1 | T-R5-1…T-R5-3 |
| C1 D-12/D-13 的「必然」說法過頭 | 改寫成「衝突字面需求間的選擇」並標使用者已核准 | 23.1、D-12、D-13 | — |
| C2 lead 提示段落位置與 fixture 不一致 | 字面附加在 HEAD 全文最後：`HEAD + "\n\n" + 段落` | D-13、23.12、23.15 | T-C2-1 |
| 驗證備註：D-16 不可迴圈或卡住 | idle 前若通知是新寄出的就重算 pending；同一組保留信只通知一次；只因冷卻而保留時改為可中斷的等待 | D-16、23.9 | T-D16-1…T-D16-4 |

### Lead arbitration (round 2)

第 2 輪審查（e41adc17）確認 R1、R2、R4、C1、C2、D-16 已解決，留下兩個 major（F1、F2）與兩個 minor（M1、M2）交 lead 仲裁。下表四條是 **lead 的決定**（2c77f98b），本文照字面併入，不是設計者的選擇；審查的 probe：`/var/folders/9t/x460lwd91bq29hrp5xpzks2c0000gn/T/spec23-review-r2.uGlg9b/probe-design-r2.mts`（F1 `:129-132`、F2 `:133-136,152-160`、M1 `:176-178`）。

| 審查項 | lead 的決定 | 改動的節 | 新增測試（23.15） |
|---|---|---|---|
| F1 同一封信有兩個角色的 owner，單數 `ownerOf` 只留一個 | 改成 `ownersOf(id, targetRole)`：收集該 id 的所有歸屬紀錄（assign、intent `from`、intent `about`），只留「`targetRole` 已開的實例」，再依 assign > from > about 取；候選 id 的順序仍是 `reply_to`、`thread`（`thread` 等於信自己的 id 時略過） | D-08、23.7.2 規則 1、23.14 | T-F1-1、T-F1-2 |
| F2 延遲啟用讓啟用前的工作找不到 owner | 不新增持久化。角色 R 的啟用在 journal 有一個位置（啟用標記，23.7.2）；被引用的 id 若其 journal 紀錄早於這個位置（resume 後才啟用的 v2 run，其所有紀錄都算），且以本名牽涉 R（寄件人 R、收件人 R，或 dispatcher 關於 R 的整合失敗／拒絕通知），就以親和性（規則 1，可繞過接收條件）歸給 R 的實例 1。journal 裡完全沒有的 id 仍是新 thread；不對所有未知的回覆開放 | D-19、23.7.2 規則 1、23.8、23.9、23.10、23.14 | T-F2-1…T-F2-5 |
| M1 doctor 把保守懷疑寫成確定 | 保守檢查的訊息說 memory 位置「may prevent extra instances for some runs」；「one task at a time」的確定措辭只用在確知的衝突 | 23.11、23.13 | T-M1-1 |
| M2 唯讀可用性預檢的時機沒寫 | 組 lead 提示時執行唯讀的可用性預檢（含包含檢查的 `instanceCap`），不寫任何東西，維持未使用 run 的位元組契約；四個安全重檢不變 | 23.11、23.12、23.14 | T-M2-1 |

F2 中「關於 R 的整合失敗」的身分不需要新紀錄就能在啟用時推得（23.7.2 規則 1 的 `involves`）：失敗信的 journal 來源鍵是 `integration:<key>`（`src/run-session.ts:594-606`），`key` 是該次喚醒的 claim id，而 claim 紀錄 `mail/claims/<key>.json` 的 `agent` 欄位就是被擋的成員（`src/run-session.ts:647,895`、`src/message-store.ts:106-113,126-137`）；沒有 claim 時 `key` 是 `<agent>-<rounds>`（`src/run-session.ts:647`）。拒絕 worktree 的通知來源鍵是 `refused:<runId>:<agent>`（`src/run-session.ts:616`）。所以採用「推得」，**沒有**採用 lead 給的備案（啟用時補寫 `about`）。`state.blocked_integrations` 的紀錄只有 agent、branch、reason、report，沒有信件 id（`src/run-store.ts:109`、`src/run-session.ts:594`），不能單獨用來找到那封失敗信，所以不用它。

「使用者交給設計者」的決定都在下表，每條都有理由與被否決的替代（細節在後面各節，否決方案彙整在 23.18）。

| # | 項目 | 決定 | 理由 | 依據（HEAD） |
|---|---|---|---|---|
| D-01 | 平行欄位 | frontmatter `parallel: true`，只認 YAML 布林 `true`；只在**寄件人是 lead**（router 依 outbox 目錄解析出的寄件人，不是 frontmatter 的 `from`）且是「新 thread 的 `task`」（沒有 `reply_to`、沒有 `thread`）時有效。有效與否記在 journal 的 intent，指派器只信 journal | 決策 1 是 lead 決定；寄件人身分只有 router 知道；收件匣裡的檔案不是 dispatcher 自己的紀錄 | 寄件人＝迭代的 outbox 擁有者 `src/mailbox.ts:253`；frontmatter `:286` |
| D-02 | 欄位值錯誤／用錯 | 寄件人不是 lead：不論值為何都照常投遞、忽略、記 note＋log（不退件）。lead 寫非布林（`"yes"`、`1`）→ 退件。lead 的 `parallel: true` 用在 reply／帶 `reply_to`/`thread`／非 task → 照常投遞、忽略、記 note | 成員信今天會被接受（審查 probe：`non-lead task with parallel flag: accepted=1`），不能因新欄位多出退件；lead 型別錯代表有意圖但寫錯，退件讓它重寄 | 退件流程 `src/mailbox.ts:264-277` |
| D-03 | 上限鍵 | `dispatcher.max_instances`：整數 1–8，選填；沒寫＝內部預設 4；寫 1＝關閉平行 | 單一全域鍵最小（`DispatcherPartial` 只在 `project.yaml`）；per-role 要碰 global/project 兩層合併與來源追蹤 | `src/schema.ts:76-89`、`src/config.ts:127-128,334-374` |
| D-04 | 實例 1 的名稱 | 實例 1 就是角色本名（`frontend`）；其餘 `frontend--2` … `frontend--N` | 角色本名的 session、task memory、last_wake、既有 thread 與未使用時的行為完全不動 | sessions／last_wake 以名稱為鍵 `src/run-session.ts:432,452,472` |
| D-05 | 名稱碰撞 | 不禁止設定名稱含 `--`；只有「要開的實例名剛好是已設定的 agent」時，那個實例不開（該角色上限截在碰撞前）並記 note；doctor 預先警告；resume 時 state 裡已開的實例名若變成設定中的 agent → 拒絕 resume | 「只在有影響時報錯」；舊設定一律可載入 | 設定 agent 鍵無格式檢查 `src/schema.ts:97,106` |
| D-06 | 槽位表啟用時機 | **延遲啟用**（使用者已核准）：第一封有效的 `parallel: true` task 被路由、且在寫任何該信的檔案之前，才把 `instances` 寫進 state 並把 `schema_version` 升到 3 | 見 D-12 | `src/run-store.ts:12,215-217,263-266` |
| D-07 | 投遞 vs 指派 | 路由**不選實例**：角色 R 啟用後，寄給 R **或 R 的任一實例名**的信都先進 R 的保留佇列 `mail/inbox/R/pending/`；每輪開頭由「指派器」依序搬到實例信箱，選擇先寫進 route journal 再搬 | 路由的 exactly-once 鍵維持 (來源, 收件名)，不會因重播改選實例（評估 §4.1）；路由的決定不依賴 blocked 這類會在崩潰與 resume 之間改變的狀態；飽和時要真正的 FIFO 就需要一個佇列 | journal 鍵 `src/message-store.ts:46,58-59`；`unreadFiles` 只列檔案、子目錄不算未讀 `src/mailbox.ts:155-163` |
| D-08 | 親和性來源 | 只看 route journal：信的 `reply_to`、`thread` **各自**算 `ownersOf(id, R)`：收集該 id 所有歸屬紀錄（被指派給哪個實例、由哪個實例寄出、dispatcher 寫的「關於某實例」），只留 R 已開的實例，再依 assign > from > about 取一個（lead 仲裁 F1）；候選之間依 `reply_to`、`thread` 的順序取第一個 | journal 在信寫出前就 fsync（`append` 先於寫檔）；外來角色的 `reply_to`（例如 qa 的審查）不可遮住有效的 thread（審查 R5）；同一封跨角色的信可同時屬於兩個角色的實例（審查 F1） | `src/message-store.ts:62-71`、`src/mailbox.ts:110-127` |
| D-09 | 飽和 | 全部可用實例都忙 → 留在保留佇列，依檔名（投遞順序）FIFO，有實例空出才指派 | 決策 2；不偷塞實例 1 | 檔名嚴格遞增 `src/mailbox.ts:42-47` |
| D-10 | 冷卻 | 角色主要模型在冷卻中時不開新實例；已開且可分派的實例仍可接 | 決策 2「冷卻中不新開」的字面；冷卻表只在喚醒開始時過濾，無法攔在途的呼叫 | `src/run-session.ts:384`、`src/fallback.ts:50-87` |
| D-11 | memory | 實例 1 是唯一寫者；實例 ≥2 的 `memory` 只有自己的 task memory，role 的 global/project 改放唯讀欄位；實例 ≥2 一律 `can_edit_agent_md: false`；另加 D-17 的實體包含檢查 | 預設路徑下消除 allow/deny 重疊與 Codex 祖先目錄放寬（評估 §4.5）；自訂路徑由 D-17 把關 | `src/policy.ts:126-151`、`src/adapters/codex.ts:7-12` |
| D-12 | 決策 4 vs 6 | 見下（使用者已核准） | | |
| D-13 | 決策 6 vs 9 | 見下（使用者已核准） | | |
| D-14 | 指引放哪 | 有約束力的規則放 `prompt.ts` 注入的 lead 協定（功能可用時才出現）；AGENT.md 範本放 `scaffold.ts` 的 lead persona（只影響之後 `init` 的新檔）與雙語文件；不動任何人 `~/agent-lyceum-config` 下的 AGENT.md | 現有 AGENT.md 不受程式控制；注入文字是唯一保證送到 lead 的地方 | `src/prompt.ts:122-236`、`src/scaffold.ts:5-16`（lead persona） |
| D-15 | 直接定址實例 | 允許 `to: frontend--2`（已開的實例），收件權限等同 `to: frontend`；信同樣進保留佇列，指派器對它套用與其他新 thread 相同的接收條件（23.9）；同角色實例之間互寄一律拒絕 | 直接定址不能成為繞過 blocked 保護的捷徑（審查 R3）；修訂可用 `reply_to` 回到原實例 | 收件人檢查 `src/mailbox.ts:330-341` |
| D-16 | 保留信卡住 | 主迴圈準備以 idle 結束、但仍有保留信時：只因冷卻而等 → 可中斷地等到最早的冷卻結束再跑一輪；否則對「這一組保留信」寄一次 failure 給 lead，新寄出就重算 pending 繼續，已通知過才 idle | 不靜默結束、不無限迴圈；沿用 nudge 的一次性模式 | `src/run-session.ts:917-934` |
| D-17 | 共用 memory 的實體包含檢查 | 實例 ≥2 的每個可寫根（cwd／worktree、task memory、outbox、git 目錄、`allowFiles` 的父目錄）與該角色每個共用 memory 路徑，以 realpath（含 symlink 別名）比對，任一方在另一方之內 → 該實例不開（通常＝角色不展開）；已開的實例在 resume 時衝突 → 拒絕 resume | `validate` 用未綁定專案，看不到 task 路徑（審查 R1 probe：`validate.ok=true; Codex writable task root is inside shared role memory=true`）；Codex 忽略 deny | `src/validate.ts:51-63`、`src/run-store.ts:279-283`、`src/adapters/codex.ts:7-12` |
| D-18 | journal 撕裂尾端 | `RouteJournal` 每個實例第一次 append 前，若檔案最後一個位元組不是 `\n`，先補一個 `\n` 與新紀錄同一次寫入；寫入位元組數不足視為失敗並拋錯 | 不補就會把下一筆完整紀錄接在殘行後面，重啟後兩筆都被丟（審查 R2 probe：`after restart exists=false`）；指派與親和性都靠 journal | `src/message-store.ts:42-54,62-71` |
| D-19 | 啟用前工作的親和性（lead 仲裁 F2） | 被引用的 id 的 journal 紀錄早於 R 的啟用標記、且以本名牽涉 R → 歸給實例 1（規則 1）；不新增任何紀錄 | 啟用前的 intent 沒有 assign／`from`／`about`（`src/mailbox.ts:113-119`），被擋的工作要靠回覆修正，否則會被當成新 thread 而一直保留 | `src/run-session.ts:594-606,616,647`、`src/message-store.ts:126-137` |

**D-12（使用者已核准，475ce42f）：槽位表延後到第一封有效平行 task 才寫，同時升 v3。** 互相衝突的是兩條字面需求：決策 4「槽位表在 run 開始寫入 state」與決策 6「沒標時 state 逐位元相同」——run 開始就寫任何新欄位，從不平行的 run 的 `state.json` 就不再逐位元相同。這不是程式碼逼出來的唯一做法：`WireState` 是 `.passthrough()`（`src/run-store.ts:212`）、`normalize` 保留未知欄位（`:222-224`），所以 run 開始時寫一個休眠的 v2 表也能載入；但那樣 state 位元組改變（違反決策 6），而且舊版仍會 resume 這個 run，`recover()` 會 commit 它不認得的 agent 的 ready claim（`src/run-session.ts:891-896,901`，評估 §5），所以「舊版拒絕」的版本門檻終究要在第一次使用時升。取捨：表與 v3 都在第一次需要時寫，而且一定早於該信的任何檔案（23.6）。決策 4 的本意（實例分配持久化、可重播、舊版拒絕）保留；只有「寫入時機」從 run 開始改成第一封平行 task。從不平行的 run 維持 v2，舊版照常看得到、可 resume。

**D-13（使用者已核准，475ce42f）：lead 系統提示在功能可用時＝HEAD 全文＋固定段落。** 互相衝突的是：決策 6 若涵蓋 lead 的系統提示，與決策 9「lead prompt 要有平行指引」。也有不改系統提示的做法：只靠 persona（AGENT.md）、COMMON.md 或任務文字教 lead 這個欄位（outbox 的 frontmatter 本來就接受未知欄位：`src/mailbox.ts:286-355`）；但那些文字不受程式控制，無法保證送到每個 lead。取捨：注入。功能不可用（共享模式、`max_instances: 1`、solo、沒有任何成員的有效上限 > 1）時 lead 系統提示逐位元相同；可用時是 `HEAD 全文 + "\n\n" + PARALLEL_SECTION(N)`，字面附加在最後（23.12）。其他（成員提示、`writePolicy`、`status --json`、state、mail、journal）在未使用時一律逐位元相同。

## 23.3 lead 的平行標記

```
---
to: frontend
type: task
subject: "Settings page"
parallel: true
---
```

- 解析位置：`routeOutboxes` 讀 frontmatter 時（`src/mailbox.ts:286` 的 `d`）。新增純函式 `parallelFlag({ value: d.parallel, senderIsLead, type, replyTo, thread, cap })`，回傳 `"absent" | "invalid" | { ignored: reason } | "on"`。判斷順序：
  1. 欄位不存在 → `"absent"`（未使用時唯一的路徑，沒有任何新 I/O）。
  2. `senderIsLead === false`（`sender.name !== project.lead`，`sender` 是 `routeOutboxes` 迭代到的 outbox 擁有者，`src/mailbox.ts:253`；frontmatter 的 `from` 不參與）→ `{ ignored: "not-lead" }`，**不論值為何**。
  3. 值不是布林 → `"invalid"` → `reject("parallel must be true or false (YAML boolean)…")`，走既有退件與 failure 回信（`src/mailbox.ts:264-277`）。
  4. 值是 `false` → `"absent"`。
  5. type 不是 `task`、或有 `reply_to`／`thread` → `{ ignored: "not-a-new-task" }`。
  6. 收件角色的有效上限是 1（23.4，含 D-17 的包含檢查）→ `{ ignored: <cap 的原因> }`，例如 `parallel tasks run one at a time in this run: agents take turns in the checkout (not a git repository)`。
  7. 其餘 → `"on"`。
- `ignored`：照常投遞（R 已啟用時進保留佇列、依親和性或預設處理，23.7），記 `log("parallel_ignored", { from, id, to, reason })` 與一條 `state.notes`（每個 (寄件人, 原因) 每段 run 一次）。寄件人不是 lead 時，note 為「frontend's mail <id> has `parallel: true`, but only the lead (tech-lead) can start parallel instances: it was delivered as an ordinary task.」
- 多收件人：`to: [frontend, backend]` 加 `parallel: true` → 對每個收件角色各自判斷。
- **旗標存在 journal，不存在信件檔**：`"on"` 的那封信，其 intent 行帶 `parallel: true`（23.7.1）；投遞出去的信的 frontmatter（`deliveredMeta`，`src/mailbox.ts:134-146`）**不變**、`MessageMeta` 不加欄位。指派器只讀 journal，所以就算有人在 `pending/` 放一個帶 `parallel: true` 的檔案（在只靠提示的平台上做得到），也不會開實例。
- 啟用（23.6）只會因 `"on"` 發生，所以非 lead 的信永遠不會寫 v3、不會開實例。

## 23.4 上限與設定鍵

```yaml
dispatcher:
  max_instances: 2   # 選填，1–8；沒寫＝4；1＝不平行
```

- `schema.ts`：`DispatcherPartial`（`src/schema.ts:76-89`，`.strict()`）加 `max_instances: z.number().int().min(1).max(8).optional()`。上界 8 是防手誤（`40` 會變成 40 個同時的 session）；之後放寬上界相容，收緊不相容。
- `DispatcherSettings`（`src/schema.ts:110-119`）加選填 `max_instances?: number`，**不**放進 `DISPATCHER_DEFAULTS`（`:121-128`）。原因：`flattenResolved` 列出 `project.dispatcher` 全部鍵（`src/config.ts:380-383`），`resolveProjectWithSources` 依 `DISPATCHER_DEFAULTS` 的鍵列來源（`:347-350`）；放進預設會讓每個專案的 `doctor --resolved` 多一行。沒寫時 `stripUndef` 不帶這個鍵（`:128,293-295`），輸出不變；有寫時 `resolveProjectWithSources` 補一筆 `dispatcher.max_instances` 來源。預設值 4 是 `src/instances.ts` 的常數 `DEFAULT_MAX_INSTANCES`。
- 有效上限（純函式 `instanceCap(project, mode, role, check)`）：下列任一成立 → 1，並帶原因字串：`mode !== "worktree"`（決策 5；`planWorkspace` 已涵蓋非 git、無 commit、reftable：`src/worktree.ts:251-259,275-283`）、`project.solo`、`project.run?.layout !== "run"`（legacy 信箱）、`role === project.lead`、角色名不符 `NAME_RE`（`src/paths.ts:4`，否則實例名不能當目錄／分支名）。其餘＝`dispatcher.max_instances ?? 4`，再截在第一個「名稱碰撞（D-05）」或「包含衝突（D-17，`check(role, k)` 回傳衝突）」的實例號之前。截到 1 時原因寫出衝突的兩個路徑。
- **舊 `project.yaml`**：鍵是選填，照常載入。**舊版程式讀到寫了這個鍵的 `project.yaml`**：`DispatcherPartial` 是 strict，舊版會以「Unrecognized key」拒絕整個專案（錯誤訊息格式 `src/config.ts:88-91`，會指出 `dispatcher`）。這和過去任何新鍵相同；文件要寫「混用版本時不要寫這個鍵（不寫就是 4）」。

## 23.5 實例命名

- `slotName(role, k)`：`k === 1 ? role : \`${role}--${k}\``。`--` 不含 `#`（YAML 註解、`NAME_RE` 會拒絕：`src/paths.ts:4`）。角色名符合 `NAME_RE` 時，`<role>--<k>` 也符合，所以可當 `run --agent` 的名稱檢查（`src/cli.ts:289`）、worktree 目錄（`src/worktree.ts:337`）與分支 `agent-lyceum/<run>/<name>`（`:436`）。
- **設定名稱含 `--` 的舊專案**：不新增任何格式檢查，照常載入與執行。回歸案例：設定 `agents: { lead, "fe--x", qa }`，`validateProject` 無新錯誤、跑一個沒平行的 run，`status --json` 與 HEAD 相同。
- **碰撞**（設定中有 `frontend--2` 這個 agent，且 `frontend` 也是角色）：
  - doctor：`warn`「agent "frontend--2" has the name instance 2 of "frontend" would get, so "frontend" runs at most 1 instance(s) at a time」。不是錯誤：沒平行時沒有影響。
  - 執行時：`instanceCap` 截在碰撞前；要開的實例名碰撞時不開，note 一次。
  - resume：state 裡已開的實例名，現在變成設定中的 agent → 拒絕 resume（23.10）。
- 實例的 `name` 就是它在所有以名稱為鍵的地方的身分：信箱、claim、attempt、sessions、active、last_wake、wakes、task memory、worktree（`src/run-session.ts:363-368,432,436,452,472`、`src/message-store.ts:126-137`、`src/run-store.ts:279-283`）。claim id 含 agent 名（`src/message-store.ts:128`），attempt 編號的 regex 會跳脫 claim id（`:220`），所以 `--` 無影響。

## 23.6 槽位表、格式門檻與啟用時機

**State 新欄位**（`RunState` 加選填 `instances`；`WireState` 加對應 zod 物件，`src/run-store.ts:168-212`）：

```json
"schema_version": 3,
"instances": { "roles": { "frontend": ["frontend", "frontend--2"] } }
```

- `roles[<role>]`：這個 run 已開的實例，依編號排列，`[0]` 一定是角色本名。只增不減。
- 沒有平行時：沒有 `instances` 鍵，`schema_version` 維持 2（`newRunState` 不變：`src/run-store.ts:215-217`）。
- `STATE_SCHEMA_VERSION` 改成 3，代表「這版讀得懂 ≤3」；新 run 仍寫 2，只有啟用時才寫 3。拒絕較新版本的判斷抽成純函式 `assertSupportedVersion(v, supported)`（目前內嵌在 `src/run-store.ts:263-266`），方便測「supported=2 讀 3」。
- 只有路由與實例分配表放在 journal（23.7）；state 只記「開了哪些實例」。

**啟用（`enable(role)`）的寫入順序**：`routeOutboxes` 處理一封 `parallelFlag === "on"` 的信（這已保證寄件人是 lead、收件角色 R 的有效上限 > 1 且通過 D-17 的啟用前檢查），而 R 尚未啟用時：

1. RunSession 回呼：`state.schema_version = 3`、`state.instances.roles[R] = [R]`、`saveState()`（atomic write，`src/run-store.ts:271-273`）。`fault("instances:enabled")`。
2. 重新綁定專案（23.14 `run-session.ts`），寄給 R 與 R 的實例名的信從此進保留佇列。
3. 才開始 `deliverOnce`（journal intent → 寫檔）。

崩潰在 1 之後、3 之前：resume 時 R 已啟用，重播的這封信照樣進保留佇列，與第一次一致。崩潰在 1 之前：什麼都沒寫，重播重新判斷。

**開新實例**（指派器，23.7）：`state.instances.roles[R].push(slotName(R, k))` → `saveState()` → `fault("instances:opened")` → 建目錄（`ensureProjectDirs` 的單一 agent 版：信箱、outbox、task memory，`src/mailbox.ts:62-72`）→ **開實例後的包含檢查**（D-17：剛建好的 task memory、outbox 用 `lstat` 確認是真的目錄、不是 symlink，再以 realpath 比對）→ 才寫 journal 的 assign 與搬檔。檢查失敗：不寫 assign、信留在佇列、把 R 標成本 process 內「不再開新實例」，記 note 與 `log("instances", { role, slot, refused: <兩個路徑> })`；已記在 state 的這個實例保持空閒（resume 時由 23.10 的檢查處理）。worktree 不在這裡建：實例第一次進入批次時，由既有的 `prepareAgentWorkspace` 建（`src/run-session.ts:954-956`，決策 4），建好後再檢查一次（23.11）。

**綁定**：`bindRunProject(project, runDir, layout, instances?)`（目前 3 個參數，`src/run-store.ts:279-289`）。有 `instances` 時，對每個 R 的每個 `k ≥ 2` 合成一個 `ResolvedAgent`，插在 R 後面（保持 status 的列順序）：

```ts
{ ...roleAgent, name: slotName(R, k), memory: { task: <taskMemory>/<run>/<slot> },
  sharedMemory: { global: roleAgent.memory.global, project: roleAgent.memory.project },
  canEditAgentMd: false, instance: { role: R, k } }
```

角色本身（k=1）加上 `instance: { role: R, k: 1 }`。三處呼叫都傳 state 的 `instances`：`src/run-session.ts:170`（resume 時；新 run 一開始沒有）、`src/status.ts:286`、`src/status.ts:384`。`memory-tidy` 與 `validate`/`doctor` 用未綁定的專案，看不到實例（`src/memory-tidy.ts:30-42`、`src/cli.ts:283-285`），不需改。

## 23.7 路由：保留佇列與指派

### 23.7.1 路由（`routeOutboxes`）

簽名改成 `routeOutboxes(project, routing?)`；`routing` 為 undefined（現有呼叫者、測試、solo）時行為完全不變。RunSession 傳入：

```ts
interface InstanceRouting {
  cap(role: string): { n: number; reason?: string };   // 23.4，含 D-17 啟用前檢查
  held(role: string): boolean;                        // 已啟用
  enable(role: string): void;                         // 23.6 的步驟 1–2，同步完成
  ignored(reason: string, meta: {...}): void;
}
```

對 `src/mailbox.ts:390` 迴圈裡的每個收件人 t（`:325-341` 的檢查之後）：

- 寄件人與 t 同角色（例如 `frontend--2` 寄 `frontend`、`frontend` 寄 `frontend--2`）→ 退件「cannot message another instance of your own role」。
- t 的角色 R（t 本身或 `project.agents[t].instance.role`）**已啟用**，或這封信剛讓 R 啟用 → `deliverOnce(..., { held: true, parallel?, from? })`：目的地是 `inbox/R/pending/<planned file>`。這同時涵蓋 `to: R` 與 `to: <R 的實例名>`（D-15）；journal 的 `to` 仍是信上寫的收件名，所以 exactly-once 鍵不變。收件權限：寄件人可寄給 R，就可寄給 R 的實例。
- 其他 → 不變。

**只有 `routeOutboxes` 這個迴圈的投遞會進佇列。** dispatcher 自己寫給某個實例的信（退件與重複的 failure 寄回寄件人 `src/mailbox.ts:264-277,372-378`、回答 `ask`）直接進該實例信箱：那些是關於它自己剛寄出的東西。

`deliverOnce` 加第 5 個選填參數 `{ held?: boolean; parallel?: boolean; from?: string; about?: string }`，寫進 intent 行；**重播時一律用 journal 裡記的 `held`**（不是當下的狀態），所以啟用前已規劃的信重播時仍進原本的信箱。`parallel` 只在 `parallelFlag === "on"` 時寫；`from` 只在寄件人屬於已啟用角色時寫（實例 1 也寫）；`about` 只用於 dispatcher 寫給 lead、內容關於某實例的信（整合失敗、拒絕 worktree，`src/run-session.ts:596-606,616-622`）。這些欄位都只在啟用後出現，未使用時 journal 行逐字相同。

`earlierDuplicate`（`src/mailbox.ts:230-247`）在 t 屬於已啟用角色時，掃描 R 與所有實例的信箱、`read/` 與 `pending/`。「同來源重播不是重複」的判斷不變：仍以 `journal.get(source, t)` 跳過（`:357-362`）。

### 23.7.2 指派器（新模組 `src/instances.ts` 的純函式＋RunSession 的薄膠水）

在主迴圈每輪開頭、`pendingAgents()` 之前執行（`src/run-session.ts:917`），也就是每次 `settle` 路由之後、下一批喚醒之前；resume 的 `recover()` 之後的第一輪同樣先跑。對每個已啟用角色 R，依檔名列出 `pending/` 中的信。每封信先用檔名在 journal 找它的 held intent（`byFile` 索引）；找不到的檔案不是 dispatcher 投遞的 → 不動、`log("held_unknown", { role, file })` 一次、不算在保留信內。其餘逐封：

0. **已記錄**：journal 有這封（`msg_id`）的 assign 行 → 搬到記錄的實例（崩潰重播），結束。
1. **親和性（修訂）**：候選 id 依序為信的 `reply_to`、`thread`（`thread` 等於信自己的 id 時略過：`deliveredMeta` 對新 thread 以自己的 id 當 thread，`src/mailbox.ts:139`）。對**每個**候選各自算 `ownersOf(id, R)`，取第一個有結果的候選。找到 → 該實例，**不論忙碌、blocked、refused 或超過目前上限**（修訂一律回原實例）。信上的 `to` 是 R 的另一個實例時，親和性仍優先，`log("assign")` 帶 `addressed: <to>`。

   `ownersOf(id, R)`（純函式，lead 仲裁 F1、F2）：
   1. **明確的歸屬**：收集 journal 中這個 id 的**所有**歸屬紀錄——assign 行的 `slot`、intent 的 `from`、intent 的 `about`——**只留「R 已開的實例」**（`state.instances.roles[R]` 裡的名稱），再依 assign > from > about 取第一個。一封跨角色的信可以同時有 `from: frontend--2` 與指派給 `qa--2` 的 assign 行；對 `frontend` 的修訂得到 `frontend--2`，對 `qa` 的修訂得到 `qa--2`，兩者互不遮蔽（審查 F1：單數的 `ownerOf` 會先挑到 `qa--2`、篩掉後 frontend 的修訂就失去親和性）。
   2. **啟用前的工作**（D-19）：第 1 步沒有結果，且這個 id 在 journal 有 intent 紀錄、該紀錄**早於 R 的啟用標記**、並且**以本名牽涉 R**（`involves(record, R)`，見下）→ 實例 1（`R` 本名）。
   3. 其他 → 沒有親和性（交給規則 2–4；journal 裡完全沒有的 id、或不牽涉 R 的 id，都是新 thread，照樣受接收條件限制）。

   **R 的啟用標記**：journal 中第一筆 `held: true` 且 `to` 是 R 或 R 的實例名的 intent 行的位置（行序）。23.6 的寫入順序保證這就是讓 R 啟用的那封信的 intent：同一個路由 pass 內，`enable(R)` 之後緊接著就是它的 `deliverOnce`，此前 R 不會有 held 的信。不新增任何紀錄類型；`RouteJournal` 建構時順便記下每個 intent 的行序與「每個收件名的第一筆 held 行序」。state 已記 R 啟用、但 journal 還沒有 R 的 held 行（崩潰在 `instances:enabled` 與該信的 intent 之間）→ 視為「標記尚未出現」，journal 中現有的紀錄全部算在啟用前。這個空窗裡 `recover()` 不會為 R 寫整合失敗：lead 一定單獨喚醒（`pickBatch`，`src/run-session.ts:602-608`），每批的 claim 在該批 `settle` 路由後就 commit（`:952-960`），`recover()` 也在任何喚醒前 commit 它處理的 ready claim（`:1166`），中斷（未 ready）的喚醒其 outbox 被移走而不路由（`src/message-store.ts:366`）；所以會啟用 R 的那次路由時，ready claim 只可能是 lead 自己的，而 lead 不做整合（`src/run-session.ts:1159`）。早於標記寫下的整合失敗（R 尚未啟用）不帶 `about`，靠第 1 步的 `involves`（claim 的 agent）歸給實例 1。空窗裡可能寫進 journal 的只剩 dispatcher 直接寄給 R 的退件／回答，在啟用前後都屬於實例 1，結果一致（23.8 表）。被 resume 後才第一次啟用的 v2 run：它在 HEAD 格式下寫的每一筆紀錄都早於標記。

   **`involves(record, R)`**（只用 journal 與 claim 紀錄這些 dispatcher 自己寫的資料，不讀信件內容）成立，當且僅當下列任一：
   - 收件人是 R：intent 的 `to === R`。
   - 寄件人是 R：intent 的 `file` 等於 `<stamp>-R-<msg_id>.md`。投遞的檔名是 `${stamp()}-${from}-${msg_id}.md`（`src/mailbox.ts:117`），`stamp()` 是去掉 `-:.` 的 ISO 時間（`src/mailbox.ts:44-47`，不含 `-`），`msg_id` 已知，所以兩段之間就是寄件人名稱，與 R 逐字比較即可，不需要切分有 `-` 的名稱。路由的來源鍵是雜湊（`sourceIdOf`，`src/message-store.ts:88-96`），看不出寄件人，所以用檔名。
   - 關於 R 的整合失敗：來源鍵是 `integration:<key>`（`src/run-session.ts:596`）。若 `mail/claims/<key>.json` 存在且其 `agent === R` → 成立（claim id 由 `claimMessages` 產生、`agent` 欄位就是被喚醒的成員：`src/message-store.ts:126-137`；`integrateMember` 的 `key` 來自該成員的 claim：`src/run-session.ts:647,895`）；claim 檔不存在時，只有 `key` 符合 `^<R 跳脫後>-\d+$`（沒有 claim 時的備用鍵 `${a.name}-${state.rounds}`，`src/run-session.ts:647`）才成立。`key` 含路徑分隔字元或 `..` 時直接不成立，不讀檔；claim 檔以既有的唯讀方式讀（`loadClaim`，`src/message-store.ts:121-123`），讀不到或解析失敗 → 不成立。claim 目錄在 `mail/claims`，與 journal 一樣對所有 agent 是 deny（`MAIL_ENTRIES`，`src/policy.ts:84,107`；只靠提示的平台上兩者同樣只靠提示）。
   - 關於 R 的拒絕 worktree 通知：來源鍵是 `refused:<runId>:R`（`src/run-session.ts:616`）。
   - 其他 dispatcher 信（`reject:`、`dup:`、`ask-answer:`、`ask-reject:`）的收件人就是相關的成員，已由「收件人是 R」涵蓋；`done-reject:`、`nudge:` 只寄給 lead，不牽涉任何成員。

   第 2 步只讓「確實牽涉 R 的舊紀錄」繞過接收條件：偽造或打錯的 `reply_to`（journal 沒有）、指向不牽涉 R 的舊信（例如 lead 寄給 qa 的 task）、指向啟用後尚未被指派的保留信，都沒有親和性，實例 1 blocked 時照樣保留（T-F2-3）。lead 刻意回覆一封啟用前寄給 R 的舊 task，等於宣告那是修訂，會進實例 1，即使它 blocked——這和啟用後回覆實例的信相同，是 lead 的決定。
2. **直接定址的新 thread**（`to` 是 `k ≥ 2` 的實例名，且規則 1 沒找到 owner）→ 該實例若「接受新 thread」（23.9）就搬過去（忙碌不影響，排在它信箱裡，和今天寄給一般 agent 相同）；否則留在佇列，原因 `blocked|refused|cap`。
3. **平行新 task**（intent 有 `parallel: true`）→ 「可分派」（23.9）實例中編號最小者；沒有時若「已開數 < 有效上限」且 R 的主要模型不在冷卻（`cooldowns.active(candidatesFor(roleAgent)[0].key, now) === 0`，`src/fallback.ts:22-37,50-87`）且下一個名稱不碰撞、不在本 process 停止開新實例的名單 → 開新實例（23.6）；都不行 → 留在佇列，原因 `busy|cap|cooldown|collision|containment`。
4. **其他新 thread**（沒標平行、沒有親和性、`to` 是角色名）→ 實例 1（角色本名）若接受新 thread 就搬過去（忙碌不影響，與今天相同）；否則留在佇列，原因 `blocked|refused`。

**順序**：留在佇列的信只擋住「同一個目的地」後面的新 thread 信：規則 3 的平行信彼此 FIFO（一封留下，後面的平行信也留下）；規則 2 對同一個實例、規則 4 對實例 1 也各自 FIFO（同一個條件，自然成立）。規則 0、1 的信永遠不等。

決定後的持久化順序：`journal.assign({ msg_id, file, role: R, slot })`（append＋fsync，含 D-18 的補尾）→ `fault("assign:recorded")` → `rename(pending/f, inbox/<slot>/f)`（同一個 `mail/inbox` 底下，同檔案系統，原子）→ `fault("assign:moved")` → `log("assign", { id, role, slot, rule: "recorded|affinity|addressed|parallel|default" })`。第一次留在佇列時 `log("held", { id, role, reason })`（同一封、同一原因只記一次，存在記憶體）。

純函式介面（方便不靠檔案系統測試）：

```ts
planAssignments(input: {
  role: string; held: HeldMsg[];            // { file, id, to, replyTo?, thread?, parallel }
  opened: string[]; cap: number;
  owners: (id: string) => string | undefined;  // ＝ ownersOf(id, role)，已限定在 R 的已開實例
  recorded: (id: string) => string | undefined;
  acceptsNew: (slot: string) => true | "blocked" | "refused" | "cap";
  busy: (slot: string) => boolean;          // 信箱有未讀
  coolingDown: boolean; mayOpen: (name: string) => true | "collision" | "containment";
}): { assign: { file: string; slot: string; open?: string; rule: string }[]; waiting: { file: string; reason: string }[] }

// 規則 1 的 owner（lead 仲裁 F1、F2）；journal 的索引與 claim 的讀取由呼叫者注入
ownersOf(id: string, role: string, ctx: {
  opened: string[];                         // state.instances.roles[role]，[0] 是角色本名
  rec: (id: string) => { assign?: string; from?: string; about?: string;
                         intent?: { seq: number; to: string; file: string; source: string } } | undefined;
  mark: number | undefined;                 // R 的啟用標記（第一筆 held intent 的行序）；undefined＝尚未出現
  claimAgent: (claimId: string) => string | undefined;
}): string | undefined
involves(intent: { to: string; file: string; source: string; msg_id: string }, role: string, claimAgent: ...): boolean
```

## 23.8 崩潰重播（評估 §4.1）

路由本身不選實例，所以既有四個故障點的語意不變；新增的選擇（啟用、開實例、指派）各自在寫入前持久化。每個故障點的行為：

| 故障點（既有 seam：`src/message-store.ts:6-13`） | 崩潰時的磁碟狀態 | resume 後 | 保證 |
|---|---|---|---|
| `instances:enabled`（新） | state 已記 R 啟用；這封信還沒有 intent，所以 journal 還沒有 R 的啟用標記 | `recover()` 的 ready claim 只會是 lead 自己的（lead 單獨喚醒，23.7.2 啟用標記），不整合、不為 R 寫紀錄 →`settle([],[])` 重新路由（`src/run-session.ts:891-899`），R 已啟用 → intent 帶 `held`，成為 R 的啟用標記 | 只投遞一次，在 pending；空窗裡寫的紀錄算在啟用前，但都屬於實例 1，親和性結果與標記位置無關（23.7.2 規則 1） |
| `route:intent`（`src/mailbox.ts:120`） | intent（含 `held`）已寫；檔案未寫 | 重播 `deliverOnce`：`prior` 存在（`:110`），依 `prior.held` 寫到 pending 同一檔名 | 同一檔名、同內容；`journal.get` 存在 → 不做重複判斷（`:359`），不誤退 |
| `route:written`（`:127`） | pending 已有檔；`delivered` 未記 | 重播：檔案內容相同不重寫（`:126`），記 `delivered` | 一份；指派器只在整個路由 pass 之後跑，此時尚未搬走 |
| `route:delivered`（`:130`） | 已記 delivered；outbox 檔還在 | 重播：`prior.delivered` 為真 → `fresh=false`，不再列入 delivered（`:128,391`）。**held 的 intent 若已 delivered，一律不重寫檔案**（檔案可能已被指派搬走；現有「檔案不在就重寫」的修復只用於非 held） | 不會在 pending 重生第二份 |
| `route:source-done`（`:395`） | 所有收件人已投遞；outbox 檔還在 | 重播同上，然後搬到 `sent/` | 同上 |
| `instances:opened`（新） | state 已記新實例；目錄可能未建；沒有 assign 行 | 綁定時合成該實例；`ensureProjectDirs` 補建目錄；resume 時的包含檢查（23.10）；實例空閒，重新套規則 1–4 | 至多多一個空實例，不重複投遞 |
| `assign:recorded`（新） | assign 行已寫；檔案仍在 pending | 規則 0：搬到記錄的實例 | 不會改選別的實例 |
| `assign:moved`（新） | 檔案已在實例信箱 | pending 已無此檔，指派器不做事；實例照常喚醒 | 一份 |
| journal 某一行寫到一半（新，23.8.1） | 最後一行是殘行、沒有 `\n` | 重啟時殘行被略過（`src/message-store.ts:52-53`）；這一行代表的動作視為沒發生：殘的是 intent → 重播重新規劃；殘的是 assign → 檔案仍在 pending（rename 在 assign 之後），指派器重新決定；殘的是 delivered → 重播再記一次。下一次 append 先補 `\n` | 之後的紀錄不會被殘行吞掉 |

另外：實例的喚醒中斷 → 其 claim 在 `recover` 變成 abandoned、信留在該實例信箱（`src/message-store.ts:296-298`），下一批由同一個實例重做；redo 草稿依 agent 名篩選（`src/redo.ts:150,170`），所以來自同一實例。信不會在實例之間移動：指派後只存在於該實例的信箱與 `read/`。

### 23.8.1 journal 的撕裂尾端（D-18）

**問題（HEAD）**：`append` 以 `"a"` 開檔、寫 `JSON.stringify(obj) + "\n"`、fsync（`src/message-store.ts:62-71`），不檢查檔案原本是否以 `\n` 結尾，也不檢查 `writeSync` 寫了幾個位元組。若上一筆在寫到一半時中斷（斷電、磁碟滿造成短寫入），下一筆完整紀錄會接在殘行後面成為同一行；解析時整行 `JSON.parse` 失敗而被略過（`:52-53`），兩筆一起消失。審查的 probe 在 HEAD 上重現：`same-process intent exists=true; after restart exists=false`。對實例而言，丟掉的可能是 assign 或 `from`，親和性就會在信已搬走後遺失。

**修正**：
1. 每個 `RouteJournal` 物件第一次 append 時，以 `"a+"` 開檔、`fstat` 取大小；大小 > 0 且最後一個位元組（`readSync` 讀 1 位元組）不是 `\n` → 這次寫入的內容是 `"\n" + JSON + "\n"`。之後同一物件的 append 不再檢查（自己寫的一定以 `\n` 結尾）。`routeOutboxes` 每次都 `new RouteJournal`（`src/mailbox.ts:252`），RunSession 的 `this.journal()` 每次呼叫也新建一個（`src/run-session.ts:327-328`），每個物件各檢查一次，成本是一次 1 位元組的讀。
2. `writeSync` 的回傳值小於要寫的位元組數 → 拋錯（不更新記憶體中的索引）。路由因此中斷，等同崩潰，由 resume 處理；殘行由下一次 append 的第 1 點補尾。
3. 補尾用 `\n` 而不是截斷：最後一行若其實是完整的 JSON、只缺 `\n`，今天的解析器會接受它（`text.split("\n")` 的最後一段），截斷會丟掉一筆有效紀錄。
4. 讀取（建構子）不寫任何東西，補尾只在 append 時發生。目前建 `RouteJournal` 的只有上述兩處，都是同一個 dispatcher（`grep -rn RouteJournal src`）；同一個 run 只有一個 dispatcher（run 鎖），所以不會兩個 process 同時補尾；之後若有唯讀使用者（例如 status）建它，也不會寫檔。

**對未使用功能的 run 的影響（對照決策 6）**：這個修正也作用在從未平行的 run，因為 `RouteJournal` 是共用的。格式正常的 journal（最後一個位元組是 `\n`，或檔案不存在／為空）寫出的位元組與 HEAD 完全相同，compat fixture 不受影響；只有在 journal 已經損壞（最後一行殘缺）時行為改變：HEAD 會讓下一筆紀錄消失，新版保留它。這是損壞狀態下的錯誤修正，不屬於「lead 沒標平行時的正常行為」，所以不違反決策 6；在 23.16 與發佈說明寫明。已經被 HEAD 併成一行的舊 journal 不做修復（見 23.18）。

## 23.9 新 thread 的接收條件、blocked 與飽和（評估 §4.2）

兩個判斷，都只在 R 已啟用後使用（啟用前的路由與今天相同：寄給 blocked 或 refused 的 agent 的信照樣進它的信箱，`src/mailbox.ts:390`）：

實例 s（屬於 R）**接受新 thread**（`acceptsNew`）當且僅當：
- 不在 `this.refused`（worktree 被拒，`src/run-session.ts:150,612-624`；只存在記憶體，resume 後重新嘗試，與今天相同）→ 否則 `"refused"`；
- 不在 `state.blocked_integrations`（`src/run-session.ts:588-594`）→ 否則 `"blocked"`。整合被擋時 worktree 保留未完成的修改且不換快照（`src/worktree.ts:422-433`），新 thread 進去會疊在舊工作上；
- 編號 `k ≤ 有效上限` → 否則 `"cap"`（上限調低後，超出的實例只處理修訂）。實例 1 永遠滿足。

實例 s **可分派**（給規則 3 的平行信用）＝接受新 thread，且信箱沒有未讀（`unreadFiles(project, s).length === 0`，`src/mailbox.ts:155-163`），且本輪尚未被指派。指派器在批次之間執行，此時沒有 active 的喚醒（`Promise.all` 屏障，`src/run-session.ts:966-969`），所以不另查 `state.active`。

這兩個條件套用到所有進入已啟用角色的新 thread：沒標平行的（規則 4，預設實例 1）、直接定址的（規則 2）、平行的（規則 3）。**只有規則 0、1（已記錄、親和性修訂）可以進 blocked／refused／超過上限的實例。** 不能進去的新 thread 留在 `pending/`，依目的地 FIFO（23.7.2），條件解除時（整合成功使 `blocked_integrations` 移除該實例，`src/run-session.ts:589-590`；resume 清掉 `refused`；上限調高）在下一輪開頭被指派。

**blocked 之後的修訂**：dispatcher 寫給 lead 的整合失敗信（`src/run-session.ts:596-606`）今天沒有 `thread`/`reply_to`。設計：這封信的 intent 帶 `about: <slot>`，所以 lead 回覆它（`reply_to` = 該信 id）會經規則 1 回到同一實例。屬於已啟用角色的 agent（含實例 1）被擋時，信文多一段：「New tasks are not given to frontend--2 while this work is not in the repo. To redo or adjust it, reply to this message (or to frontend--2's last mail): only replies reach frontend--2 now.」一般 agent 與未啟用角色的信文逐字不變。

**啟用前就 blocked 的工作**（lead 仲裁 F2，D-19）：成員在 R 啟用前被擋時，那封整合失敗信是照 HEAD 寫的：intent 沒有 `about`，信文仍是「You can send frontend a task to redo or adjust it」（`src/run-session.ts:594-606`）。R 之後啟用時，lead 回覆那封失敗信或回覆原本的 task，都經規則 1 的第 2 步（`involves`：失敗信的 claim 屬於 R；原 task 的收件人是 R）歸給實例 1，繞過 blocked，修好後整合成功就解除。lead 若照舊信文寄一封**新的**沒標 task（沒有 `reply_to`），它是新 thread，實例 1 blocked 時被保留；D-16 的 stall 通知會指出「reply to the failure about it to redo it」。

**飽和**：規則 3 的「留在佇列」。被留下的信在 `status` 的 queue 以 `held: true` 顯示（23.13）。

**保留信卡住（D-16）**：主迴圈在 `pending.length === 0` 準備以 idle 結束時（`src/run-session.ts:931-934`，在既有的 nudge 之後），若指派器本輪留下了保留信（`waiting` 非空）：

1. **只因冷卻**（每封保留信的原因都是 `cooldown`）：`log("held_wait", { until })`，以 `opts.signal` 可中斷的方式等到最早的冷卻結束（冷卻長度 ≤ `fallback_cooldown_sec`，預設 300，`src/schema.ts:127`；`mark` 不會縮短既有冷卻，`src/fallback.ts:52-57`），然後 `continue` 回到迴圈開頭（指派器重跑，此時可開新實例）。等待期間沒有任何喚醒，所以冷卻不會被延長；中斷 → `cancelled`。
2. **其他**：`deliverOnce` 一封 failure 給 lead，key `held-stall:<保留信 msg_id 排序後的 sha256 前 16 碼>`，信文逐封列出「信 id、主旨、目的地、原因」，例如「2 task(s) are waiting and nothing else is running: <id> "Settings page" for frontend--2 (its earlier work is blocked: reply to the failure about it to redo it), <id> "Login" for frontend (its earlier work is blocked: reply to the failure about it to redo it). They are assigned as soon as that work is in the repo.」
   - `fresh === true` → `pending = this.pendingAgents()`（lead 現在有未讀），不 idle，繼續這一輪。
   - `fresh === false`（同一組保留信已通知過）→ 照常 idle 結束。保留信留在磁碟，`status` 顯示，`resume` 會再處理。
3. **不會迴圈**：lead 收到通知後若沒有新動作，下一輪 pending 為空 → 既有 nudge 一次 → 再下一輪 key 相同、`fresh === false` → idle。保留信的集合只有在 lead 或成員送出新信時才會改變，每次改變最多一封通知，受 `max_rounds` 限制。

## 23.10 舊版程式與 resume（評估 §5）

**舊版讀啟用過實例的 run**（`schema_version: 3`）：

下表依 HEAD 的程式推得。`git diff --stat 69ff553 HEAD -- src plugins` 沒有輸出（`69ff553` 是 `0.25.1` 的版本提交），所以 0.25.1 的原始碼與 HEAD 相同；已發佈套件的實際輸出 **未實測**。

| 舊版指令 | 結果 | 依據 |
|---|---|---|
| 續跑指定的 run（`run <run>`） | `findRun` 走 `listRuns`，讀取錯誤被吞掉 → 「Run "…" not found」，**沒有任何寫入** | `src/cli.ts:380-382,126-131`、`src/status.ts:60-66` |
| 續跑不指定 run | `latestUnfinishedRun` 也走 `listRuns`，看不到它，可能改挑另一個未完成的 run；這個 run 不被寫入 | `src/cli.ts:385-387`、`src/status.ts:41-42` |
| `clear <run>` | `findRun` → 「not found」，什麼都不刪 | `src/cli.ts:492` |
| 任何直接 `loadRunState` 的路徑 | 「…newer than this agent-lyceum understands (2). Upgrade agent-lyceum.」，寫入前拋出 | `src/run-store.ts:263-266` |
| `status` | 該 run 不出現（被略過）；其他 run 正常 | `src/status.ts:60-66` |

所以舊版的 `recover()`（`src/run-session.ts:891-896,901`）永遠不會在啟用過實例的 run 上執行。「Run not found」對使用者不夠清楚，但舊版已發佈、無法修改；在升級說明（`docs/upgrading-run-v2.md` 的同類文件）寫明。未啟用的 run 仍是 v2，舊版照常 resume（決策 6）。

**新版 resume 啟用過的 run**：在 `RunSession` 建構子、`ensureProjectDirs`（`src/run-session.ts:191`）之前新增 `assertInstancesResumable(base, state.instances, check)`，任一條件成立就拋錯、不寫任何東西：

- state 裡的角色 R 不在設定中 → 「Run <id> has instances of "R", which is no longer an agent of project <p>. Add "R" back to project.yaml to finish or resume this run, or clear it.」
- R 現在是 lead → 同樣拒絕。
- 某個已開實例的名稱現在是設定中的 agent（D-05）→ 拒絕並指出名稱。
- **某個已開的實例 ≥2 現在與 R 的共用 memory 有包含衝突（D-17）**（例如使用者在 run 中斷後把 `memory.project` 改到 task-memory 底下，或建了 symlink）→ 拒絕：「Run <id> cannot be resumed: frontend--2 would be able to write frontend's shared memory (<可寫路徑> is inside <共用路徑>). Move frontend's memory outside <run 資料根目錄>, or clear the run.」這裡只能拒絕：已開的實例有指派過的信與 worktree，不能把它的工作改交給實例 1。
- 尚未開的實例號有衝突 → 不拒絕；`instanceCap` 截在衝突前（23.4），note 一次。

這樣 `recover()` 處理 ready claim 時，`project.agents[c.agent]` 一定找得到實例（綁定來自 state），不會「跳過整合再 commit」（評估 §5）。

**新版 resume 一個 v2 run、之後才第一次啟用**：resume 本身不寫任何新東西（仍是 v2）；第一封有效的平行 task 依 23.6 啟用。這個 run 在啟用前寫的所有 journal 紀錄都早於 R 的啟用標記，回覆其中牽涉 R 的信（含啟用前的整合失敗）照 23.7.2 規則 1 第 2 步歸給實例 1（lead 仲裁 F2，T-F2-2）。

**上限調低**（例如原本開了 3 個、現在 `max_instances: 1`，或專案變成不能用 worktree）：worktree 模式由 state 決定、不重新偵測（`src/worktree.ts:275-280`），所以已開的實例照樣綁定、照樣喚醒，處理完信箱與親和性的修訂；超出上限的實例不接受新 thread（23.9 的 `"cap"`），也不開新的。沒有孤兒，也沒有跳過。上限調高：之後可開到新上限。

**角色改了 runtime／model／memory 路徑**：實例繼承新設定（每次綁定都從設定合成）。共用 memory 路徑改變時，寫者仍是實例 1；新路徑若與已開實例衝突，見上面的拒絕條件。

**一般 agent 被移除時 `recover()` 的同一個缺陷**（ready claim 屬於不在設定中的 agent）今天就存在，與實例無關；修它會改變未使用時的行為，列為延後（23.19）。

## 23.11 memory 與寫入範圍

**單一寫者**：實例 1（角色本名）保留角色原本的 `memory`；實例 ≥2 的 `memory` 只有 `task`，role 的 global/project 放在新欄位 `sharedMemory`（唯讀）。`memoryDirs`（`src/policy.ts:64-66`）不改，因此在預設路徑下：

- 實例 ≥2 的 `allowDirs` 不含共用 memory（`src/policy.ts:126-132`）；在 `deny` 迴圈中，實例 1 的 `memoryDirs` 對它是「別人的 memory」→ deny（`:146-148`）。`readDirs` 加上 `sharedMemory` 的目錄（`:166`）。
- 實例 1 計算 policy 時，兄弟實例的 `memoryDirs` 只有各自的 task memory → 不會 deny 自己的共用 memory。評估 §4.5 的 allow/deny 重疊消失。審查以 HEAD 的 policy 函式套用這個合成形狀，印出 `writer deny(shared)=false; nonwriter allow(shared)=false deny(shared)=true; Codex ancestor root=false; Claude denyWrite=true`。
- task memory 各自一份：`task-memory/<run>/<slot>`（`bindRunProject` 本來就依名稱給，`src/run-store.ts:282`）。

**`can_edit_agent_md`**：實例 ≥2 一律 false。原因：`allowFiles` 加入每個 agent 的 AGENT.md（`src/policy.ts:136-139`），Codex 把 `allowFiles` 的父目錄當 writable root（`src/adapters/codex.ts:10`），預設 memory 在 `agents/<role>/memory`（`src/config.ts:175-178`），AGENT.md 在 `agents/<role>/AGENT.md`（`:148`）→ 父目錄 `agents/<role>` 正好是共用 memory 的祖先。實例 1 若設定可改 AGENT.md 則照舊（它本來就可寫自己的 memory）。

**實體包含檢查（D-17，審查 R1）**：上面只對預設路徑成立。`memory.global`／`memory.project` 可設成任意路徑（`src/config.ts:160-178`），`validate` 的重疊檢查只比較未綁定專案的 memory 目錄（`src/validate.ts:51-63`），看不到每個 run 才綁上的 task memory（`src/run-store.ts:282`）。審查的 probe 把 `frontend.memory.project` 設成 `<taskMemory>/run1`：`validate.ok=true`，而 `frontend--2` 的 task memory 落在共用 memory 裡，Codex 的 writable root 因此涵蓋它（Codex 不會 deny：`src/adapters/codex.ts:7-12`）；Claude 則反過來，deny 蓋住自己的 task memory。兩種都破壞決策 7。

- **比對對象**：角色 R 的共用路徑 `S ∈ {memory.global, memory.project}`（有設的），對實例 s（k ≥ 2）的可寫根 `W ∈ writePolicy(project, s).allowDirs ∪ dirname(allowFiles) ∪ {工作目錄}`；工作目錄在 worktree 建好前用預計的 `workspaceRoot(project, run, s)`（`src/worktree.ts:337`），建好後用 `ws.root` 與 `ws.gitDir`。這正是 Codex 收到的 writable roots 加上 cwd（`src/adapters/codex.ts:7-12,58-60`）與 Claude 的 allow 範圍。
- **衝突**：`isInside(canon(S), canon(W)) || isInside(canon(W), canon(S))`（`isInside`：`src/paths.ts:72-75`）。`canon(p)`＝對 p 最深的已存在祖先取 `fs.realpathSync.native`，再接上其餘部分，所以 symlink 別名（例如 S 是指向 `task-memory/<run>` 的 symlink、或 `/var`→`/private/var`）會被看穿。macOS 的檔案系統預設不分大小寫：在 darwin 上兩邊再轉小寫比較（寧可誤判成衝突）。
- **唯讀的可用性預檢**（lead 仲裁 M2）：lead 的系統提示要知道功能是否可用（23.12 第 1 點），所以 RunSession 在綁定專案、組 lead 提示所需的 `project.run.instances` 時（23.14 `prompt.ts`），對每個成員跑一次含包含檢查的 `instanceCap`（以預計路徑；`canonicalPath` 只做 `lstat`／`realpathSync.native`）。這發生在每個 worktree 模式的 run，包括從不平行的 run，但**不寫任何東西**：不建目錄、不寫 state／journal／log／note，所以未使用 run 的位元組契約（23.15 compat fixture）不變；它的結果只決定 lead 提示是否附加 `PARALLEL_SECTION`（D-13）。預檢判定衝突的角色不在提示裡另外說明，lead 若仍對它標平行，由下面第 1 點忽略並記 note。下面四個安全重檢不因預檢而省略。
- **安全重檢的時機**（只在功能被使用時發生，從不平行的 run 不做這四個檢查）：
  1. 啟用前：`instanceCap` 對 k = 2..上限 以預計路徑檢查；k=2 就衝突 → 上限 1 → `parallel: true` 被忽略（23.3 第 6 點），信照今天的方式進實例 1 的信箱，note 與 `log("parallel_ignored")` 寫出兩個路徑；不升 v3、不建 `pending/`。
  2. 開實例後、assign 前（23.6）：以剛建好的實際目錄再檢查，並確認它們不是 symlink。
  3. 實例進入批次、`prepareAgentWorkspace` 之後、喚醒之前（`src/run-session.ts:954-956`）：以 `ws.root`、`ws.gitDir` 檢查；衝突 → 走既有的 `refuseMember`（`:612-624`），lead 收到的 failure 寫出兩個路徑。
  4. resume：23.10。
- **doctor**：用同一個純函式，對「run 資料根目錄」（`paths.taskMemory`、`paths.runs`、`<paths.root>/worktrees`、repo 的 git common dir）做保守檢查，分兩種（lead 仲裁 M1）：S **等於或包含**其中任一個根目錄 → 每個 run 的實例 ≥2 都必然落在 S 裡，這是確知的衝突，用確定的措辭（「runs one task at a time」）；S **在**某個根目錄**之內**（例如 `task-memory/notes`）→ 只有某些 run 的確切路徑會碰到（執行時的確切比對才知道），措辭是「may prevent extra instances for some runs」。兩種都是 warn（23.13）。這是預警，不擋任何指令；`validate` 不加錯誤（舊設定照常載入）。
- **範圍外**：worktree 內容裡指向 S 的 symlink、Linux 的 bind mount 別名、檢查之後才被替換的路徑元件，realpath 都看不到；前兩者由 OS sandbox 以實際路徑判斷（未驗證），只靠提示的平台沒有防護。

**強制等級（要在文件與 doctor 明講）**：下表只在 D-17 檢查通過時成立；檢查不通過，該角色根本不會有實例 ≥2。

| runtime／平台 | 實例 ≥2 寫共用 memory | 依據 |
|---|---|---|
| 任何 runtime：共用 memory 與實例 ≥2 的可寫根有包含關係 | 不會發生：該實例不開（啟用前／開實例後）、不喚醒（喚醒前），或 resume 被拒 | D-17 |
| Claude＋OS sandbox（macOS；Linux 有 bwrap） | OS 拒絕（`sandbox.filesystem.denyWrite`） | `src/adapters/claude.ts:41-49`、`src/policy.ts:172-179,193-195` |
| Claude 無 OS sandbox | 只有 Edit 工具規則；Bash 可繞過 | `src/policy.ts:194-196` |
| Codex＋OS sandbox | 共用 memory 不在 writable roots | `src/adapters/codex.ts:7-12`、`src/policy.ts:199` |
| Codex 無 OS sandbox（Linux 無 bwrap） | **只靠提示** | `src/policy.ts:199`（`prompt-only`） |

以上是 policy 產出的路徑；真實 CLI 與 OS sandbox 是否照做 **未驗證**。guard 不保護 memory（`src/guard.ts:47-55`），沒有事後還原；非寫者若寫了共用 memory，最後寫入者勝。

**範圍外但要寫明**：單一寫者只在同一個 run 內成立；`memory.project` 跨 run 共用（`src/config.ts:168-178`），兩個同時的 run 各自的實例 1 仍會同時寫——與今天多 run 並行相同，不是新風險。

非寫者的提示（23.12）要求把值得保留的教訓寫進回信，由 lead 或實例 1 決定是否記錄。

## 23.12 提示與呈現

全部改在 `src/prompt.ts`；只有在「功能可用」或「agent 是實例」時才出現新文字。

**1. lead 系統提示（功能可用：worktree 模式、非 solo、至少一個成員的 `instanceCap` > 1；由 23.11 的唯讀可用性預檢判定）**：`buildSystemPrompt` 照 HEAD 組完全文（最後一行是 `NO_DAEMONS_RULE`，`src/prompt.ts:233-235`），然後回傳 `text + "\n\n" + PARALLEL_SECTION(N)`。字面附加在最後，不插在任何既有段落之間；`PARALLEL_SECTION` 是匯出的純函式，結尾沒有換行。N 為 `max_instances ?? 4`。

```
## Parallel tasks
A member can work on up to N tasks at the same time, each in its own instance with its own worktree. To use this, send each independent task as its own new `task` (not a reply, no `reply_to`) with the frontmatter line `parallel: true`. Only your own mail can do this. Instance 1 keeps the member's name; the others are named `<member>--2`, `<member>--3`, and their mail reaches you from those names.
- Mark tasks parallel only when they are independent of each other and change different files. Before you send them, list in each task's `## Scope` the files it will touch; if two lists overlap, do not mark them parallel.
- Never run in parallel work that changes shared components, types, routes, configuration or design tokens: send that first, without the flag, and send the dependent tasks after it is integrated. Changes to the same file are not merged: the later one is blocked and comes back to you as a failure.
- Revisions go back to the instance that did the work: reply to its mail (`reply_to`). An instance whose work is blocked takes no new task, also not one addressed to it by name, until that work is in the repo; to redo it, reply to the failure about it.
- Without `parallel: true`, mail goes to the member itself, one task at a time.
- When rate limits hit, fewer instances may start; waiting tasks run when an instance is free.
- After parallel work is back, have one member type-check and test the combined result before you report `done`.
```

這段把是否需要平行的判斷留給 lead（決策 1），dispatcher 不判斷相依。放在系統提示：resume:true 的 lead 若被 Claude 以 run 開始時記錄的系統提示 resume（`claude --help` 的 `--system-prompt-snapshot`，見 project lesson `claude-wake-loads-user-claude-md`），在同一個 run 中途才變成可用時可能看不到這段（**未驗證**）；但「可用與否」在 run 開始就確定（mode、上限與包含檢查都只看設定與 run 路徑），第一個喚醒就已帶這段；後果只是 lead 不用平行（安全方向），所以不另放 user prompt。

**2. 收件人與隊友清單**：`mates`／`recipients`（`src/prompt.ts:125-127,138,155`）排除 `k ≥ 2` 的實例；lead 由上面那段知道實例名稱。成員提示因此在啟用後也不會跟著變長。

**3. 實例 ≥2 的系統提示**：身分句（`:132`）改為「You are **frontend--2**, instance 2 of **frontend** in the team "…". Other instances of frontend may be working on other tasks at the same time, each in its own worktree.」；`## Memory` 對 `sharedMemory` 列成「project (all tasks of this project, read-only for you: instance 1, `frontend`, maintains it)」，並把「you can write only inside these directories」之後加一句「You cannot write the shared memory: put lessons worth keeping in your reply to the lead.」；user prompt 也列出 `sharedMemory` 的 `MEMORY.md` 索引（`:282-291` 的迴圈改成 memoryDirs＋sharedMemory，標 read-only）。
**實例 1（已啟用時）**：身分句後加一句「Other instances of you (frontend--2, …) may work in parallel; only you write your global/project memory.」。未啟用時逐字不變。

**4. lead 看到的寄件人（決策 8）**：user prompt 的 `from:` 行（`src/prompt.ts:310`）對實例寫成 `from: frontend--2 (frontend, instance 2)`；實例 1 在已啟用時寫 `from: frontend (frontend, instance 1)`。佇列標題行（`:320`）同樣處理。未啟用時逐字不變。

**5. AGENT.md 指引（D-14）**：`scaffold.ts` 的 lead persona（`src/scaffold.ts:5-16`）加一條：「Mark a task `parallel: true` only when it is independent and touches different files from the other open tasks; list each task's files in `## Scope` first; shared components, types, routes and tokens go first, alone.」只影響 `init` 新建的檔案（`writeOnce`，`:74`）。雙語文件附同樣的段落供使用者貼進自己的 lead AGENT.md。本任務不動任何現有 AGENT.md。

## 23.13 status、monitor、doctor

**`status --json`**（`buildStatusReport`／`buildRunReport`，兩處綁定 `src/status.ts:286,384` 都傳 `s.instances`）：

- `agents[]`：綁定後的專案已包含實例列，跟在角色列之後（`:395-403` 依 `project.agents` 列舉）。屬於已啟用角色的每一列（含實例 1）加 `role` 與 `instance` 兩個新欄位；其餘列不變。`unread`、`last_wake`（`state.last_wake[slot]`）、fallback 檢視都以實例名查，天然對齊。保留信不算進任何 agent 的 `unread`（`unreadFiles` 不看子目錄）。
- `run.active`、`run.wakes`、`run.last_wake`：本來就以 agent 名為鍵，實例名直接出現。
- `run.queue`：`queueOf(bound)`（`:262-278`）涵蓋實例信箱；保留佇列的信附加在最後，`agent` 為角色名、加 `held: true`（`QueueItem` 新增選填欄位，`:175-182`）。等待原因只在 `log.jsonl` 的 `held` 事件（status 是另一個 process，不重算指派）。
- `run.instances`：啟用時才出現，值為 `state.instances.roles`。
- 未啟用：綁定不合成任何東西、不加任何鍵 → 逐位元相同（23.15 fixture）。
- 文字頁：實例顯示為 `frontend #2`（`agents` 區塊與「現在／下一個」行）。

**monitor（`plugins/status-monitor/hooks/graph.ts`）**：`blocks()` 依 `report.agents` 每列一塊、以 `run.active[a.name]` 對應（`:63-69`），實例自動成為獨立的塊。`Report` 型別加選填 `role`、`instance`；塊的顯示名在 `instance ≥ 2` 時為 `frontend #2`。依角色分組的樹狀檢視延後（23.19）。

**doctor**（`diagnoseProject`，`src/doctor.ts:159-175` 一帶，新增 `subject: "instances"` 的檢查）：

| 情況 | 等級 | 訊息要點 |
|---|---|---|
| `max_instances` 值不合法 | （載入失敗） | zod 錯誤指出 `dispatcher.max_instances`，doctor 與其他指令一樣停在設定錯誤 |
| `max_instances` 明寫 > 1，但 `isolationBlocker` 有原因 | warn | 「…runs here take turns in the checkout (<原因>): parallel tasks run one at a time」 |
| 沒寫 `max_instances` 且有 blocker | 不加訊息 | 既有的 git info 已說明（`src/doctor.ts:167-168`） |
| 某成員是 Codex、平台無 OS sandbox、有效上限 > 1 | 明寫 >1：warn；預設：info | 「only "<role>" writes its memory; its other instances are only told not to (Codex without an OS sandbox)」 |
| 成員的共用 memory **等於或包含**某個 run 資料根目錄（D-17 的保守檢查，確知的衝突） | warn | 「"frontend" runs one task at a time: its memory <S> contains <根目錄>, where its other instances would write. Move the memory elsewhere to allow parallel tasks.」 |
| 成員的共用 memory **在**某個 run 資料根目錄**之內**（保守檢查，不一定衝突；lead 仲裁 M1） | warn | 「the memory of "frontend" (<S>) is inside <根目錄>, where instances write; this may prevent extra instances for some runs. Move the memory elsewhere to be sure parallel tasks are possible.」 |
| 設定名稱與實例名碰撞（D-05） | warn | 見 23.5 |
| 成員名不符 `NAME_RE` | info | 「"<name>" cannot run as several instances (name is not a valid branch name)」 |
| `doctor --resolved` | — | 只在明寫時列 `dispatcher.max_instances` 與來源 |

## 23.14 逐模組改動

| 模組 | 改動 |
|---|---|
| `src/instances.ts`（新） | 純函式：`DEFAULT_MAX_INSTANCES`、`slotName`、`parseSlotName`、`instanceCap`、`parallelFlag`、`planAssignments`、`ownersOf`、`involves`、`synthesizeSlots`（給 `bindRunProject` 用）、`assertInstancesResumable`、`slotWritableRoots`、`containmentConflict(shared, roots, canon, caseInsensitive)`、`heldStallKey`、`senderLabel`、`PARALLEL_SECTION`（或放 `prompt.ts`）。除 `canon` 與 `claimAgent`（讀 `mail/claims/<id>.json` 的 `agent`）由呼叫者注入外不碰 I/O。 |
| `paths.ts` | `canonicalPath(p)`：最深已存在祖先的 `realpathSync.native`＋其餘部分；放在 `isInside` 旁。 |
| `schema.ts` | `DispatcherPartial.max_instances`；`DispatcherSettings.max_instances?`（不進預設表）。 |
| `config.ts` | `ResolvedAgent` 加選填 `instance?: { role; k }`、`sharedMemory?: { global?; project? }`（只在綁定後出現）；`resolveProjectWithSources` 在明寫時補來源。合成不在 resolve 做。 |
| `run-store.ts` | `STATE_SCHEMA_VERSION = 3`；新 run 仍寫 2（`newRunState` 改成寫常數 `NEW_RUN_SCHEMA_VERSION = 2`）；`RunState.instances?`；`WireState` 加 `instances`（`roles: record(string, array(string).min(1))`）；`assertSupportedVersion`；`bindRunProject` 第 4 參數。 |
| `run-session.ts` | `project` 改成可重新綁定（啟用／開實例後）；建構子在 `:191` 前呼叫 `assertInstancesResumable`（含 D-17）；`routeOutboxes(project, routing)`（`:649`）；指派器在 `:917` 前；D-16 在 `:931` 前（含冷卻等待與重算 pending）；`prepareAgentWorkspace` 後對實例做 D-17 檢查（`:954-956`）；整合失敗與拒絕 worktree 的信帶 `about`，已啟用角色的信文多一段；`ensureProjectDirs` 只對新實例補建目錄。`wake()`、claim、attempt、redo、settle 的 commit 順序不改。 |
| `mailbox.ts` | `routeOutboxes` 第 2 參數；`parallelFlag` 判斷（含寄件人＝lead）與退件；同角色互寄退件；實例收件權限；已啟用角色與其實例名的信一律 held 投遞；`earlierDuplicate` 跨實例；`deliverOnce` 第 5 參數（`held/parallel/from/about`，重播依 journal）；`ensureAgentDirs(project, name)` 抽出。`MessageMeta` 與 `deliveredMeta` 不改。 |
| `message-store.ts` | `RouteJournal`：D-18 的補尾與短寫入檢查（`append`）；intent 讀寫 `held/parallel/from/about`；新行 `{ t: "assign", msg_id, file, role, slot }`；`assigned(id)`、`ownership(id)`（依 msg_id 建索引，回傳該 id 的 assign `slot`、intent `from`／`about` 與 intent 的行序、`to`、`file`、`source`，全部保留、不在這裡挑一個：lead 仲裁 F1）、`firstHeld(name)`（該收件名第一筆 held intent 的行序，供啟用標記：F2）、`byFile(file)`。行序是建構時的解析順序加上本物件之後 append 的順序；殘行不佔行序。舊行照讀；未知 `t` 本來就被忽略（`:42-55`）。 |
| `policy.ts` | `readDirs` 加 `sharedMemory`；其餘靠 `memoryDirs` 不含共用 memory 自然成立；`enforcementFor` 對實例 ≥2 的 Codex 無 OS sandbox 加 note。 |
| `validate.ts` | 不改（看不到實例）。碰撞、名稱與包含檢查放 doctor，避免舊設定出現新錯誤。 |
| `prompt.ts` | 23.12 的 1–4；`buildSystemPrompt` 需要知道功能是否可用：`ResolvedProject.run` 加選填 `instances?: { max: number }`，由 RunSession 綁定時依 `plan.mode` 與 `instanceCap` 設定（`bindRunProject` 不知道 mode：`src/run-session.ts:170,174-175`）；這就是 23.11 的唯讀可用性預檢，不寫任何東西（lead 仲裁 M2）。 |
| `status.ts` | 兩處綁定傳 `instances`；`AgentReport.role/instance`、`QueueItem.held`、`RunReport.instances`；文字頁顯示 `#k`。 |
| `doctor.ts` | 23.13 的檢查。 |
| `plugins/status-monitor` | `Report` 型別與塊的顯示名；測試。 |
| `worktree.ts` | 不改（實例名是合法目錄／分支名；`clear` 依目錄列舉：`src/worktree.ts:768-772`、`src/run-cleanup.ts:76-97`）。 |
| `redo.ts` | 不改（依 agent 名篩選：`src/redo.ts:150,170`）。 |
| `guard.ts` | 不改（受保護檔以 Set 去重 `src/guard.ts:47-55`；授權逐批 `:80-104`，實例 ≥2 沒有 `allowFiles`）。 |
| `memory-tidy.ts`／`run-cleanup.ts`／`fallback.ts` | 不改（tidy 用未綁定專案；冷卻表本來就以 `runtime/model` 為鍵、平行共用：`src/run-session.ts:138-139`）。 |
| `scaffold.ts` | lead persona 一條指引（23.12 第 5 點）。 |

## 23.15 測試

全部用 fake invoker 或 `test/fixtures/runtime`、暫時的 `AGENT_LYCEUM_HOME` 與 scratch git repo（`test/helpers.ts` 的 `makeEnv`、`initGitRepo`），不呼叫真實的 `claude`／`codex`，不讀真實的 `~/agent-lyceum-config`。先紅後綠。審查的 probe（`_shared/spec23-review-r1/probe-head.ts`、`probe-design.ts`）中對應的反例都要變成測試。

**fixture 的產生方式（決策 6）**：實作前在 HEAD 上先提交 `test/instances-compat.test.ts` 與 `test/fixtures/instances/*`（它們在 HEAD 必須通過），之後每次改動都要維持通過。比對整份序列化輸出，不比 key 集合（評估 §5 指出 `test/status.test.ts:289-303` 只比 key）。正規化只替換：ISO 時間戳、run id、`pid`、`duration_ms`、隨機的 claim／訊息 id、暫存目錄前綴；正規化函式本身有測試，證明不會動到其他內容。

| 評估 §9 | 測試檔／案例 |
|---|---|
| 1 未使用時逐位元相同 | `instances-compat.test.ts`：(a) worktree 模式、兩成員、lead 寄兩封**沒標**的 task 給同一成員的 fake run，比對 `status --json`、`state.json`、`mail/journal.jsonl`、每封投遞的信、每個成員的系統提示、每個 agent 的 `writePolicy` 與 `buildClaudeSettings`／`codexWritableRoots`；(b) 同樣情境但 `max_instances: 1` 與共享模式：lead 系統提示也逐位元相同；(c) worktree 模式預設上限：**T-C2-1** lead 系統提示 `=== headLead + "\n\n" + PARALLEL_SECTION(4)`，`headLead` 是 HEAD 產生的 fixture 全文，`PARALLEL_SECTION(4)` 與 23.12 的程式碼區塊逐字相同（另一個測試比對該區塊）；(d) `doctor --resolved` 未寫鍵時相同；(e) 設定名稱含 `--`（`fe--x`）的回歸；(f) 成員被擋（blocked）後 lead 再寄一封沒標的 task：信進該成員信箱（與 HEAD 相同），沒有 `pending/`。 |
| 2 兩實例同批、整合與衝突 | `instances-e2e.test.ts`（fake invoker、真 git）：lead 一次寄兩封 `parallel: true` 給 `frontend` → 同一批喚醒 `frontend` 與 `frontend--2`、各有 worktree；改不同檔 → 都進 lead worktree；改同一檔 → 後者 blocked、lead 收到主旨含 `frontend--2` 的 failure、分支保留、`state.instances.roles.frontend` 為兩個名稱、`schema_version` 3。 |
| 3 親和性、blocked、飽和、冷卻 | `instances.test.ts`（`planAssignments` 純函式）：reply_to 指到實例寄出的信 → 該實例；thread 根被指派給實例 → 該實例；owner 屬於別的角色 → 忽略；沒標 → 實例 1；blocked／refused／有未讀的實例不可分派；`max_instances: 2` 三封平行 → 第三封留下、FIFO、後面的親和性信照常；冷卻中不開新但可用已開空閒的；碰撞名稱不開。另見下方 R3、R5 案例。`instances-e2e.test.ts`：blocked 後 lead 以 `reply_to` 回覆 failure → 回同一實例並在其後整合成功。 |
| 4 故障點 | `instances-route.test.ts`：對 23.8 表中每個故障點（`instances:enabled`、`route:intent`、`route:written`、`route:delivered`、`route:source-done`、`instances:opened`、`assign:recorded`、`assign:moved`）用 `setFaultHook` 拋錯「殺掉」→ 以 resume 重跑 → 斷言整個 run 的 mail 樹中該信恰好一份、在記錄的實例、沒有任何 `rejected`／`dup:` failure。另見下方 R2 案例。`run-lifecycle.test.ts` 擴充：實例喚醒中被取消 → resume 由同一實例重做；`redo.test.ts` 擴充：redo 草稿來自同一實例。 |
| 5 舊版拒絕、調低上限、刪除角色 | `run-store.test.ts`：`assertSupportedVersion(3, 2)` 拋出且訊息含「Upgrade」；新 run 寫 2、啟用後寫 3；v2 state 照讀。`instances-e2e.test.ts`：開了 2 個後把 `max_instances` 改 1 再 resume → `frontend--2` 仍處理完已指派的信與修訂，新的平行信與直接寄給它的新 thread 不再派給它；刪除角色或讓實例名與新設定碰撞 → resume 拋錯，且 run 目錄所有檔案的 mtime 與內容不變。QA 另以已發佈的舊版（`npx agent-lyceum@0.25.1`，需網路）對同一個 run 實測 `resume`／`clear`／`status`。 |
| 6 memory 單一寫者 | `instances-policy.test.ts`：實例 1 的 `writePolicy.allowDirs` 含共用 memory、`deny` 不含；實例 2 的 `deny` 含、`allowDirs` 不含、`readDirs` 含；`buildClaudeSettings` 的 `denyWrite` 對應；角色 `can_edit_agent_md: true` 時實例 2 的 `codexWritableRoots` 不含共用 memory 也不含其祖先；task memory 路徑各自；共享模式下 `parallel: true` 被忽略並有 note。另見下方 R1 案例。`doctor.test.ts`：`setOsSandboxForTest(false)`＋Codex 成員 → 23.13 的訊息與等級。 |
| 7 status 對上實例 | `status.test.ts`：啟用後 `agents` 有 `frontend--2` 列、`role`/`instance` 正確；`active`、`queue`（含 `held: true`）、`last_wake` 的鍵是實例名；保留信不算進 `unread`；指定 run 與多 run 混存時各自綁自己的表。`plugins/status-monitor/hooks/graph.test.ts`：實例塊的顯示名與 active 對應。 |

**第 1 輪審查新增的具名案例**：

- **R1 包含檢查**（`instances-policy.test.ts`、`instances-e2e.test.ts`、`doctor.test.ts`）：
  - T-R1-1：`frontend.memory.project = <taskMemory>/<run>`（審查 probe 的設定）→ lead 的 `parallel: true` 被忽略、信進 `frontend` 信箱、`state.json` 仍 v2 且無 `instances`、沒有 `pending/`、note 與 `parallel_ignored` log 含兩個路徑。
  - T-R1-2：`memory.project` 是指向 `<taskMemory>/<run>` 的 symlink → 同 T-R1-1。
  - T-R1-3：`memory.global` 是 `<paths.root>/worktrees` 的祖先 → 同 T-R1-1。
  - T-R1-4：大小寫別名（`canon` 與 `caseInsensitive` 注入，純函式）：darwin 模式下只差大小寫視為衝突，linux 模式不視為衝突。
  - T-R1-5：開實例後的檢查：測試在 `instances:opened` 之後把 `task-memory/<run>/frontend--2` 換成指向共用 memory 的 symlink → 不寫 assign、信留在 pending、note 寫出路徑、run 不崩潰。
  - T-R1-6：resume 時衝突：開了 `frontend--2` 後中斷，把 `memory.project` 改到 `<taskMemory>/<run>` → resume 拋錯、訊息指名 `frontend--2` 與兩個路徑、run 目錄所有檔案 mtime 與內容不變。
  - T-R1-7：預設路徑不觸發；有衝突設定但從不平行的 run → compat fixture 逐位元相同；`doctor` 對 T-R1-1 的設定給 warn。
- **R2 撕裂尾端**（`message-store.test.ts`、`instances-route.test.ts`）：
  - T-R2-1：journal 以殘行 `{"t":"assign","msg_id":"cut` 結尾 → `intent` → 新的 `RouteJournal` 讀得到這筆 intent（審查 probe 的反例）。
  - T-R2-2：最後一行是完整 JSON 但沒有 `\n` → append 後兩筆都讀得到。
  - T-R2-3：格式正常的 journal → append 後檔案位元組＝原內容＋該筆 JSON＋`\n`（沒有多的換行）；空檔與不存在的檔同。
  - T-R2-4：短寫入（以測試 seam 讓 `writeSync` 回傳較少位元組）→ 拋錯，記憶體索引沒有這筆。
  - T-R2-5：兩次崩潰：在 `assign:recorded` 的 fault hook 中把 journal 截掉最後 10 個位元組再拋錯（模擬 assign 寫到一半）→ resume：該信仍在 pending、重新指派一次、補尾後寫入新的 assign、搬檔 → lead 寄下一封 held 信，在 `route:intent` 再崩潰 → resume：前面的 assign、held intent 與 delivered 都讀得到，後續以 `reply_to` 的修訂回到同一實例，整個 mail 樹每封信一份。
- **R3 新 thread 的接收條件**（`instances.test.ts` 純函式、`instances-e2e.test.ts`）：
  - T-R3-1：R 已啟用、實例 1 blocked，lead 寄沒標的新 task → 留在 pending（原因 blocked），不進 `frontend` 信箱。
  - T-R3-2：同上但 `reply_to` 指到實例 1 的工作 → 進實例 1（修訂）。
  - T-R3-3：`frontend--2` blocked，lead 寄 `to: frontend--2` 的新 task → 留在 pending；refused、超過上限各一案。
  - T-R3-4：T-R3-1／T-R3-3 之後整合成功 → 下一輪依檔名順序指派。
  - T-R3-5：審查 probe 的 `unflagged NEW task -> frontend (blocked)` 反例改為斷言「held」。
  - T-R3-6：啟用前 blocked 的成員收到沒標的 task → 與 HEAD 相同（compat (f)）。
- **R4 只有 lead 能展開**（`mailbox.test.ts`、`instances-e2e.test.ts`）：
  - T-R4-1：成員（`backend`）寄 `to: frontend, type: task, parallel: true` → 信進 `frontend` 信箱、沒有 `pending/`、`state.json` 仍 v2 且無 `instances`、journal 行與沒有該欄位時相同、note 與 `parallel_ignored`（reason `not-lead`）各一。
  - T-R4-2：成員寫 `parallel: "yes"` → 不退件，同 T-R4-1。
  - T-R4-3：R 已啟用後成員寄 `parallel: true` 的新 task → intent 沒有 `parallel`，指派器以規則 4 處理（實例 1），不開新實例；手動在 `pending/` 放一個帶 `parallel: true` 的檔案 → `held_unknown`、不開實例。
- **R5 親和性的 owner 篩選**（`instances.test.ts`）：
  - T-R5-1：`reply_to` 的 owner 是 `qa--2`（別的角色）、`thread` 的 owner 是 `frontend--2` → `frontend--2`（審查 probe 的反例）。
  - T-R5-2：`reply_to` 的 owner 是 `frontend--2`、`thread` 的 owner 是別的角色 → `frontend--2`。
  - T-R5-3：兩個都屬於別的角色 → 沒有親和性，依規則 2–4。
- **D-16 不迴圈、不卡住**（`instances-e2e.test.ts`）：
  - T-D16-1：所有實例 blocked＋保留信、lead 收到通知後不送任何信 → 恰好一封 stall failure、一次 nudge、run 以 idle 結束；lead 的喚醒次數 = 2。
  - T-D16-2：stall 通知是新寄出時 → 同一輪重算 pending 並喚醒 lead（沒有在通知寄出後直接 idle）。
  - T-D16-3：保留信只因冷卻（冷卻表設成 50 ms 後到期）→ 等待後開新實例並指派，沒有 stall failure。
  - T-D16-4：冷卻等待中觸發 abort → `cancelled`。

**lead 仲裁（第 2 輪，2c77f98b）新增的具名案例**（審查 probe `probe-design-r2.mts:129-136,152-160,176-178` 的反例要變成這些測試）：

- **F1 角色限定的 owner**（`instances.test.ts` 的 `ownersOf`／`planAssignments` 純函式，加上 `instances-e2e.test.ts` 一案）：
  - T-F1-1：`frontend` 與 `qa` 都已啟用（各有 `--2`）。`frontend--2` 寄給 `qa` 的信 M（intent `from: frontend--2`），被指派給 `qa--2`（assign 行）。給 `frontend` 的修訂（`reply_to: M`，`thread: M`）→ `frontend--2`；給 `qa` 的修訂（`reply_to: M`）→ `qa--2`。兩者 `log("assign")` 的 rule 都是 `affinity`。e2e 版本以真實路由產生 M 與兩封修訂，斷言落點與 journal 的 assign 行。
  - T-F1-2：同 T-F1-1，但 `frontend--2` 在 `state.blocked_integrations` 裡 → 給 `frontend` 的修訂仍到 `frontend--2`（規則 1 繞過接收條件），不留在 pending；給 `qa` 的修訂仍到 `qa--2`。
- **F2 啟用前的工作**（`instances.test.ts` 純函式、`instances-e2e.test.ts`、`instances-route.test.ts`）：
  - T-F2-1（blocked-before-first-parallel，e2e）：lead 寄一封沒標的 task T 給 `frontend`（run 仍是 v2）→ `frontend` 改到與 lead 衝突的檔 → 整合 blocked、lead 收到失敗信 F（來源 `integration:<claim id>`，intent 沒有 `about`）→ lead 寄一封 `parallel: true` 的新 task P → R 啟用（v3），P 因實例 1 blocked 而開 `frontend--2` → lead 分別以 `reply_to: T` 與 `reply_to: F` 寄兩封修訂 → 兩封都指派給 `frontend`（rule `affinity`，不是 `held`），`frontend` 下一次喚醒後整合成功，`state.blocked_integrations` 不再有 `frontend`。
  - T-F2-2（v2 resume 後才啟用，e2e）：T-F2-1 的前半（T、blocked、F）後中斷 run；新版 resume（仍 v2、resume 不寫新東西）→ lead 寄平行 task 使 R 啟用 → 對 T、F 的修訂同 T-F2-1 到 `frontend` 並解除 blocked。
  - T-F2-3（不放寬未知回覆）：R 已啟用、實例 1 blocked，lead 寄的新 task 帶 (a) journal 裡沒有的 `reply_to`、(b) 指向啟用前 lead 寄給 `qa` 的 task 的 `reply_to`、(c) 指向啟用後仍在 pending 尚未指派的保留信 → 三封都留在 pending（原因 blocked），沒有 assign 行。
  - T-F2-4（`involves` 純函式）：收件人 R；寄件人 R（檔名 `<stamp>-R-<id>.md`），以及名稱有 `-` 的鄰近角色（`fe` 與 `fe-x`）不會互相誤認；`integration:<claim id>` 以 claim 檔的 `agent` 判斷（claim 屬於別人 → 不成立）；沒有 claim 檔時 `integration:R-7` 成立、`integration:R-x-7` 對 R 不成立；`refused:<run>:R` 成立；`key` 含 `/` 或 `..` → 不成立且不讀檔。
  - T-F2-5（啟用標記與崩潰，`instances-route.test.ts`、`instances-e2e-final.test.ts`）：(a) lead 的平行 task 路由時在 `instances:enabled` 拋錯 → resume 的 `recover()` 不為 `frontend` 寫任何紀錄，啟用標記是重播後那封平行 task 的 held intent 行序，也是第一筆提及 `frontend` 的 intent；之後實例 1 的整合失敗 intent 帶 `about: frontend`，回覆它 → `frontend`（即使 blocked）。(b) 強化案例：第一次在 `route:intent` 崩潰，此時成員 claim 為 ready、lead 的平行 task 尚未路由（正常流程不會同時出現，見 23.7.2 啟用標記；測試由成員喚醒代寫 lead 的 outbox 造出，實際 run 中這是寫入範圍違規，`src/policy.ts:149`）→ 第一次 resume 的 `recover()` 整合該 claim（blocked，寫整合失敗；R 尚未啟用，不帶 `about`），重播平行 task 時在 `instances:enabled` 崩潰 → 第二次 resume 跑完：失敗信 intent 早於啟用標記，lead 的回覆經 F2 的 `involves`（claim 的 agent）回到 `frontend`，不到 `frontend--2`。
- **M1 doctor 措辭**（`doctor.test.ts`）：
  - T-M1-1：`memory.project = <paths.taskMemory>/notes` → warn 含「may prevent extra instances for some runs」、不含「one task at a time」；`memory.project = <paths.root>`（包含 task-memory 根目錄）→ warn 含「runs one task at a time」。
- **M2 唯讀預檢**（`instances-compat.test.ts`）：
  - T-M2-1：compat (a) 的從不平行 run（worktree 模式、預設上限）跑完後，run 目錄與 task-memory 根目錄的檔案清單與位元組和 HEAD fixture 相同（預檢沒有建任何目錄或寫任何檔）；lead 系統提示＝T-C2-1；同一設定把所有成員的 `memory.project` 設成 `<paths.taskMemory>`（包含每個 run 的 task memory）→ lead 系統提示與 HEAD 逐位元相同（預檢判定不可用），state／journal／log 也相同。

另外：`config.test.ts`（`max_instances` 0、9、`"2"` 被拒；1、8 可；未寫時 `flattenResolved` 沒有這個鍵）、`mailbox.test.ts`（lead 的 `parallel: "yes"` 退件；lead 的 `parallel: true` 加 `reply_to` 照投遞並 note；同角色互寄退件；`to: frontend--3` 未開 → no such agent）、`prompt-*.test.ts`（23.12 每段的全文）。

**一個 fake invoker 的端到端情境**（qa 驗收用，放 `instances-e2e.test.ts`）：lead 一次寄 3 封平行 task 給 `frontend`（`max_instances: 2`）→ 兩個實例同批、第三封保留 → 一個實例完成後第三封指派給它 → 一封改到同檔被擋 → lead 寄一封沒標的新 task 給被擋的實例（保留）→ lead 回覆 failure → 同一實例重做並整合 → 保留的那封被指派 → lead 寄 `done`；最後斷言 `status --json` 的實例列、`journal.jsonl` 的 assign 行與每封信的落點。

DoD：`npm run typecheck && npm run lint && npm test`，文件改動加 `npm run check:docs`。

## 23.16 相容性

- **舊 `project.yaml`／`team.yaml`**：不新增必填鍵、不新增驗證錯誤。新鍵只在 `dispatcher`。共用 memory 與 run 資料根目錄重疊的舊設定照常載入，只多一條 doctor warn。
- **舊 run 目錄**（v1 legacy、v2）：沒有 `instances` → 不合成、上限依 layout（legacy＝1）；行為不變。
- **新版寫的未啟用 run**：v2，和 HEAD 寫的逐位元相同（正規化後），舊版可 resume。
- **新版寫的已啟用 run**：v3，舊版在寫入前拒絕或看不到（23.10）。
- **journal**：新欄位與新行只在啟用後出現；舊版讀不到（被 state 門檻擋在前面）。D-18 的補尾對所有 run 生效，但只在最後一行已殘缺時寫入多的 `\n`；格式正常的 journal 位元組與 HEAD 相同（23.8.1）。
- **`status --json`**：未啟用時逐位元相同；啟用時只**新增**欄位（`role`、`instance`、`held`、`run.instances`），沒有改名或移除，`plugins/status-monitor` 舊版忽略未知欄位、實例照樣顯示成獨立的塊。
- **mail frontmatter**：`parallel` 是新選填欄位；舊版收到帶 `parallel` 的 outbox 信會照常投遞並忽略它（frontmatter 的未知鍵不檢查：`src/mailbox.ts:286-354`）。新版對非 lead 寄件人同樣照常投遞（只多 note 與 log）。投遞出去的信的 frontmatter 不變。

## 23.17 Dimension coverage

1. **Compatibility & Format**：state v3 只在啟用時寫（23.6，使用者核准）；F2 不新增任何 journal 行型或 state 欄位；lead 提示的可用性預檢唯讀（M2）；`max_instances` 選填，舊 yaml 照讀，舊版遇新鍵的失敗模式已寫明（23.4）；journal 擴充只在啟用後，D-18 的補尾只影響已損壞的 journal（23.8.1）；`status --json` 未用時逐位元相同、啟用時只加欄位（23.13、23.16）；lead 系統提示的唯一差異是字面附加的段落（23.12）。
2. **File & Process Safety**：保留佇列在 `mail/inbox/<role>/pending/`，屬於本來就對所有 agent deny 的 inbox（`src/policy.ts:150`），不改 `runDenyPaths`；指派器只信 journal（`parallel`、held intent），不信佇列裡的檔案內容；指派用同一檔案系統內的 rename；共用 memory 單一寫者靠合成的 policy 加上 D-17 的 realpath 包含檢查（四個時機，fail closed）與各平台強制等級（23.11）；實例 ≥2 關掉 `can_edit_agent_md` 消除 Codex 祖先 root；只有 lead 能展開（23.3）；實例名經 `NAME_RE`，不會有路徑跳脫。
3. **Concurrency & Recovery**：每個選擇在寫入前持久化（23.6、23.8 表）；親和性以角色限定（`ownersOf`，跨角色的信對兩個角色各自成立），啟用前的工作以 journal 行序與 dispatcher 自己的紀錄推得歸屬，不新增紀錄，被擋的工作在啟用後仍能靠回覆修好（lead 仲裁 F1、F2，23.7.2）；journal 殘行不會吞掉之後的紀錄（23.8.1）；所有新 thread（平行、沒標、直接定址）都不進 blocked／refused／超過上限的實例，只有修訂可以（23.9）；保留信卡住時通知一次、只因冷卻就等待，不迴圈也不靜默結束（D-16）；resume 前檢查角色、碰撞與包含衝突，不跳過孤兒（23.10）；Ctrl-C 沿用既有 abandoned claim，冷卻等待可中斷；同一 run 只有一個 dispatcher（run 鎖不變）。
4. **Platform & Operability**：只在 worktree 模式；Codex 無 bwrap 只靠提示並由 doctor 顯示；macOS 不分大小寫的路徑以保守比較處理；冷卻中不開新實例，但在途呼叫的 429 突發放大仍在（評估 §4.7，未緩解，寫進文件）；每輪多一次 `pending/` 目錄讀取、每個 journal 物件多一次 1 位元組讀取，可忽略；無新依賴。
5. **Testability & Maintainability**：分配、上限、包含檢查、stall key 都是 `src/instances.ts` 的純函式（realpath 由呼叫者注入）；端到端用 fake invoker；故障點沿用 `setFaultHook`；審查 probe 的反例全部成為具名測試（23.15）；不需要真實 runtime 或真實設定目錄。
6. **Observability & Diagnosability**：新 log 事件 `instances`（啟用／開實例／包含衝突）、`assign`（含 rule 與 addressed）、`held`（含原因）、`held_wait`、`held_unknown`、`parallel_ignored`（含原因，例如 `not-lead`、包含衝突的兩個路徑）；`state.notes` 記忽略原因；lead 收到的 stall failure 逐封列出原因；`status` 顯示實例列與保留佇列；doctor 的 `instances` 檢查（確知衝突與「可能」分開措辭，M1）；`assign` 的 rule `affinity` 涵蓋啟用前工作的歸屬，可從 journal 行序與 claim 紀錄重現；錯誤訊息指名角色、實例名、路徑與設定鍵。
7. **Cost**（任務相關的額外維度）：總並行＝Σ 實例數，預設每角色 4；每個實例是新 session，系統提示與 context 重付（推論）；lead 提示要求平行後派一次整體驗證，增加一次喚醒；stall 通知最多每組保留信一次喚醒。

## 23.18 不採用的方案

| 方案 | 不採用的原因 |
|---|---|
| 路由時直接選實例並寫 journal（評估 §2 的建議） | journal 鍵要改成 (來源, 實例) 或在 intent 記實例，重播時要先查舊指派；而且飽和時沒有地方放「等實例空出」的信，只能塞實例 1，不是 FIFO。保留佇列把「投遞」和「分配」拆開，兩者各自 exactly-once。 |
| 喚醒時才展開（使用者初步設計，評估 S3） | 要另一份對照表把實例 1 信箱裡的信分給別人，信實體與執行者不一致，`recover()` 與 redo 要多一層對照。 |
| 槽位表在 run 開始寫入（決策 4 字面），或寫休眠的 v2 表 | 見 D-12：從不平行的 run 的 state 位元組改變；休眠 v2 表仍讓舊版 resume 並 commit 未知 agent 的 claim。 |
| 親和性表放 `state.json`（`threads`/`msgs`） | state 在 `settle` 路由**之後**才存（`src/run-session.ts:685`）；崩潰在中間時，lead 已收到實例的回信但表上沒有，修訂會被派錯。journal 在寫信前 fsync。 |
| per-role 上限鍵 `agents.<role>.max_instances` | 要處理 global/project 兩層、來源追蹤與 `AGENT_FIELDS`（`src/config.ts:334-374`）；lead 不標就等於該角色 1。延後。 |
| 多個實例都可寫共用 memory | `MEMORY.md` 最後寫入者勝，條目遺失（評估 §4.5）。 |
| 非寫者寫共用 memory 時用 guard 事後還原 | guard 逐批授權、批中有實例 1 就無法歸責（`src/guard.ts:87`）；要做須另設計，延後。 |
| 全面禁止設定名稱含 `--` | 合法舊設定會失效（評估 §4.6 已撤回）。 |
| 平行 task 用錯場合（reply 等）也退件 | 修訂會卡在退件迴圈；忽略＋note 已足夠讓 lead 知道。 |
| 飽和時退件請 lead 稍後再寄 | 把排程推給 lead、浪費喚醒；佇列成本很低。 |
| （R1）在 `validate` 對 memory 與 run 資料根目錄重疊報錯 | 從不平行的舊設定會突然無法載入；改由 doctor 預警、使用時 fail closed。 |
| （R1）執行時也用 doctor 的保守根目錄檢查 | 會關掉實際上不衝突的設定（例如 memory 在 `task-memory/notes`）；執行時有確切路徑，用確切比對。 |
| （R1）衝突時仍開實例、只把共用 memory 從它的 policy 拿掉 | 兩個路徑互相包含時，allow 與 deny 必然重疊：Codex 只看 allow（可寫共用 memory），Claude 的 deny 會蓋住它自己的 task memory；沒有正確的 policy 可產出。 |
| （R2）截斷殘行而不是補 `\n` | 最後一行若是完整 JSON 只缺換行，今天會被接受，截斷會丟掉有效紀錄。 |
| （R2）解析時從殘行中「撈」出接在後面的紀錄 | 啟發式（要猜 `{"t":` 的起點）；HEAD 已經併成一行的舊 journal 很少見，修復它不值得新增解析規則。 |
| （R3）直接定址的新 thread 不經佇列、直接進實例信箱 | 會讓 blocked／refused 的實例接到新工作（審查 R3）；直接定址也要守同一個接收條件。 |
| （R3）路由時就依 blocked 狀態退件或改送 | blocked 狀態在崩潰與 resume 之間會變（`recover()` 先整合 ready claim 再路由，`src/run-session.ts:891-899`），重播可能做出不同決定；路由維持不看狀態，由指派器在寫 assign 前決定。 |
| （R3）blocked 時把新 thread 改派到別的實例 | 沒標的 task 可能依賴被擋的工作；直接定址的信多半是給那個實例的修訂；等待並通知比猜測安全。 |
| （R4）非 lead 的 `parallel` 退件 | 今天這種信會被接受；新增退件改變成員信的行為（lead 的決定：照常投遞、忽略、記錄）。 |
| （R4）由信件 frontmatter 的 `from` 或投遞後檔案裡的 `parallel` 判斷 | 信件內容由寄件人或（只靠提示的平台上）任何 agent 控制；寄件人身分只有 router 知道，決定記在 dispatcher 自己的 journal。 |
| （F1）單數 `ownerOf(id)` 先挑一個 owner 再篩角色 | 跨角色的信同時屬於寄件實例與收件實例，先挑會丟掉另一個角色的親和性（審查 F1 probe）；lead 決定改成 `ownersOf(id, targetRole)`。 |
| （F2）實例 1 blocked 時，所有找不到 owner 的回覆都放行 | 偽造或打錯的 `reply_to` 會讓新工作疊進被擋的 worktree，等於取消 R3 的保護；lead 明確否決。只放行「確實以本名牽涉 R 的啟用前紀錄」。 |
| （F2）啟用時補寫歸屬紀錄（對啟用前的信補 `from`／`about`／assign，或 lead 給的備案：只補 `about`） | 歸屬可由既有資料推得（23.7.2 的 `involves`），補寫是多餘的寫入路徑，還要處理補寫中途崩潰；lead 只在推不出時才允許。 |
| （F2）另寫一個 journal 啟用行或在 state 記 journal 位置 | 新的行型或 state 欄位；觸發啟用的那封信的 held intent 本來就在啟用時寫，就是標記，不需要另一筆。 |
| （F2）從失敗信的主旨／內文或 lead 信箱裡的檔案找出被擋的成員 | 信件檔在 lead 的信箱，只靠提示的平台上 agent 改得到；claim 紀錄與 journal 是 dispatcher 自己寫、對 agent deny 的資料。 |
| （M1）doctor 不分情況都說「one task at a time」 | 保守檢查會涵蓋其實不衝突的設定（`task-memory/notes`），把懷疑寫成確定會誤導使用者搬動不需要搬的 memory。 |
| （D-16）保留信卡住時直接 idle | 只因冷卻的情況會讓 run 為了幾分鐘的冷卻而結束；其他情況 lead 不知道為什麼沒有回音。 |

## 23.19 延後與未驗證

**延後（各有重啟條件）**：
- per-role 上限鍵：使用者回報需要對單一角色限流時。
- monitor 依角色分組的樹狀檢視：實例列造成面板擁擠的回報出現時。
- 非寫者寫共用 memory 的事後偵測：出現實際遺失或 Codex 無 bwrap 的使用者時。
- `recover()` 對「不在設定中的一般 agent」的 ready claim 仍會 commit（今天就存在，`src/run-session.ts:891-896,901`）：另開任務，屬於行為修正。
- 實例縮編（關閉空閒實例、回收 worktree）：目前實例的 worktree 和一般成員一樣保留到 `clear`。
- 同檔自動合併、整合後自動跑測試：不在 dispatcher 做（評估 §4.3、§4.4）。
- 平行時 429 在途放大的緩解（例如冷卻時延後已排定的喚醒）：需要真實 runtime 量測。
- HEAD 已併成一行的舊 journal 的修復：出現實際案例時。

**未驗證（不可升格成事實）**：
- 真實 Claude／Codex CLI 與 OS sandbox 是否照 policy 擋下實例 ≥2 寫共用 memory，以及它們是否以實際路徑（看穿 symlink）判斷。
- Codex `workspace-write` 是否還有本文沒列入的隱含可寫根（例如暫存目錄）；若有且與共用 memory 重疊，D-17 看不到。
- Codex 在 Linux 的 sandbox 實際用什麼機制（本專案以 `bwrap` 是否在 PATH 判斷：`src/policy.ts:176`）。
- `fs.realpathSync.native` 對**不存在**的路徑部分無法正規化大小寫（存在的部分：本機 macOS、Node v22.22.2 實測 `realpathSync.native("rp/abc")` 回傳磁碟上的 `rp/Abc`，非 native 版回傳 `rp/abc`；所以 `canonicalPath` 必須用 `.native`）。不存在的部分由 darwin 上另以小寫比較處理；Linux 的不分大小寫檔案系統（少見）未處理。
- `fs.writeSync` 在磁碟滿時回傳短寫入而不是拋錯（D-18 第 2 點兩種都處理）。
- 被 resume 的 Claude lead 是否看得到新增的 `## Parallel tasks`（system prompt snapshot）。
- lead 模型是否照指引只在獨立任務上標平行。
- 已發佈的舊版對 v3 run 的實際輸出（23.10 的表是讀程式推得；QA 以 `npx agent-lyceum@0.25.1` 實測，需網路）。
- 成本與 rate limit 的實際放大倍數。
- F2 的推得規則依賴 HEAD 的三個格式：投遞檔名 `<stamp>-<from>-<msg_id>.md`、整合失敗來源鍵 `integration:<claim id 或 agent-rounds>`、拒絕通知來源鍵 `refused:<run>:<agent>`（都已在 `278f392` 開檔確認）。之後若改這些格式，`involves` 要一起改，T-F2-4 會擋下不一致；使用者手動刪掉 `mail/claims/` 的檔案時，啟用前的整合失敗只剩備用鍵的判斷，回覆會被當成新 thread（安全方向：保留＋stall 通知）。

## 23.20 分工

- **node-engineer**（審查 cli-reviewer）：23.14 全部；先提交 23.15 的 compat fixture（在 HEAD 通過），再依序做 `instances.ts` 純函式 → journal 補尾（D-18，可先獨立提交，附 T-R2-1…4）→ state／綁定 → 路由與 journal → 指派器（含 F1 的 `ownersOf` 與 F2 的啟用標記、`involves`）→ 包含檢查（含 M2 的唯讀預檢） → policy／prompt → status／doctor／monitor。估計 4–6 天（沿用評估 §7，推論），第 1 輪修訂約再加 1 天、lead 仲裁約再加半天（推論）。
- **qa**（審查 qa-reviewer）：23.15 的端到端情境、每個故障點、R1–R5、D-16 與 lead 仲裁的 F1、F2、M1、M2 具名案例、舊版實測、跨 runtime 的 policy 產出檢查；報告必須分開「fake 驗證」與「未驗證」。
- **docs-writer**（審查 docs-reviewer），中英成對：`README.md`/`README.zh-TW.md`（功能一句與限制）、`docs/how-it-works*.md`（實例、保留佇列、親和性、blocked 時新 thread 等待、stall 通知、只有 lead 能展開）、`docs/configuration*.md`（`dispatcher.max_instances`、混用舊版的警告、memory 路徑不可放在 run 資料目錄內、lead AGENT.md 範例段落）、`docs/monitor*.md`（實例塊與 `#k`）、`docs/write-scope*.md`（單一寫者、包含檢查與各平台強制等級表）、`docs/upgrading-run-v2.md` 的同類說明（v3 run 與舊版、journal 補尾）。
- 本 spec 已列入 `docs/specs/README.md` 索引。
