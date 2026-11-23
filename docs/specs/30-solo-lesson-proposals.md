# 30 單獨執行的 agent 提案 lesson／decision，由 lead 決議

狀態：**草案 v4**（2026-11-23，已吸收三次獨立 session 審查；v4 修正第三次審查的缺口，並已依第四次〔v4 差異複審〕修正 H1–H4、M1–M6；**第四次的修正處未再審**）。尚未實作；plan：[2026-11-23-30-solo-lesson-proposals.md](../plans/2026-11-23-30-solo-lesson-proposals.md)。編號用 30，因為 [spec 28](28-repeat-detect.md) 的非目標把「跳過指令」預留給 29。行號以 `2e87449`（HEAD，spec 與 plan 尚未 commit）的工作樹為準。

本文的 `D-xx` 是本 spec 的決議。「已確認」＝讀過程式並附位置；「待確認」＝plan 的 Task 0 要先查證，不可當事實。

## 30.1 問題

- project records（`records/decisions/`、`records/lessons/`）只有 lead 能寫。`src/prompt.ts:128` 的 `isLead` 含 `!project.solo`；`src/policy.ts:191` 只對 `isLead` 把 `recordsDir` 放進 `allowDirs`，`:219` 對非 lead 把整個 `recordsDir` 放進 deny。已確認。
- 單獨執行（`run --agent`、`call`）時，被執行的 agent 是「一人團隊的 lead」，但 `solo` 旗標關掉它的 lead 權限（`src/solo.ts:14-20`），records 對它唯讀。已確認。
- 所以單獨呼叫的 agent（例如 reviewer）學到的東西沒有進入專案知識的路徑；它只能寫自己的 memory 或 handoff。
- 現況沒有判準說什麼值得記，程式也不檢查 lesson 是否有依據。`done` 只檢查有效 active 條目是否超過 12 KB（`src/mailbox.ts:397-402`）；格式不合的條目由 `parseEntry` 標 `invalid`（`src/records.ts:32-76`）、`doctor` 警告，但仍算 active。已確認。

### 30.1.1 現有保護機制的事實（影響設計，皆已確認）

- **guard 對 solo 的授權是錯的：** `src/guard.ts:159` 的 `authorized = running.some((a) => a.name === this.project.lead)`。solo run 的 lead 就是 solo agent，所以它改 records 被視為授權，不還原也不記違規。
- **各 runtime 的實際強制程度：** Claude 有 OS 沙箱時 `denyWrite` 擋住；Codex 有 OS 沙箱時 writable roots（`src/adapters/codex.ts:14`）不含 records，同樣擋住；Cursor 只有 `Write(records/**)` 的工具層 deny，擋不住 shell。沒有 OS 沙箱時三者都只剩 guard。
- **tidy 不經 guard：** `tidyMemory` 這條路徑（`src/cli.ts:669`、`src/memory-tidy.ts:370-390`）沒有 `ProtectedGuard`（guard 只在 `src/run-session.ts:364` 與 `src/call.ts:167` 建立），載入的是一般 `loadProject`，所以 `project.solo` 是 `undefined`。它靠 `invoke({ policy })` 覆寫 `allowDirs`，再用 `snapshotDirs`／`fingerprint`／`restoreDirs` 回滾（`restoreDirs` 會先 `rmSync` 整個目錄再還原，`memory-tidy.ts:121-125`）。
- **`call` 的保護範圍：** `callAgent` 用暫時的假專案（`src/call.ts:70`），其 `paths.root` 是 callDir；guard 監看全域 agent 的 `AGENT.md`、callDir 的 `COMMON.md`，以及 `--dir` 裡的 `CLAUDE.md`、`AGENTS.md`（`call.ts:166-167`），且只在 invoke 結束後檢查一次（`:209`）。`call` 只有每個 agent 一把的 `lockAgent`（`:110`），沒有專案鎖。call 的 project 沒有 `run`，guard 的 `keep()`（`guard.ts:99-101`）因此不存違規副本。
- **多 run 並存：** guard 在 `other.length > 0` 時，對 records 的改動記成 `unattributed` 並採納為 baseline，不還原（`guard.ts:166-169`、`:183`）；`call` 的 guard 沒給 `otherLiveRuns`（`call.ts:167`），預設永遠是 `[]`，所以 call 的 guard 永遠走「還原」路徑。
- **handoff 目錄：** `policy.ts` 的 `shared` 是 `sharedDir()`＝`task-memory/<run>/_shared`（`policy.ts:73-76`），**不是** `project.paths.shared`（records 在後者的 `common/records`）。`mayWriteShared`（`policy.ts:183`）沒排除 solo，solo run 的值是 true。

## 30.2 目標與非目標

**目標：**

- 單獨執行的 agent 可以寫「提案」，累積在專案裡，不進任何 prompt 的有效 active 清單。
- 提案必須附證據。
- lead 逐條決議：收下（寫成正式 record）或拒絕。

**非目標：**

- 不讓 solo agent 直接寫正式 records，也不讓它決議（D-02）。
- **不讓 CLI 行程直接寫任何提案或 record**（D-14）；沒有人工覆寫指令。
- 不做獨立複核與使用回饋追蹤（延後）。
- 不判斷 lesson 因果是否正確；機械檢查只擋不存在的引用與不合格的決議。
- 不改一般成員（非 lead、非 solo）對 records 的權限；提案區對他們唯讀。

## 30.3 誰能寫什麼（本 spec 的核心不變量）

**保證強度：** 單一存活 run（或只有一個 `call -p`）時，由 policy／OS 沙箱／guard 機制保證。**多個 run 並存時只是盡力而為**（guard 走 `unattributed` 採納，30.8 #6）。`unattributed` 事件目前只進該 run 的 log（`run-session.ts:1045-1047`），**本版不提供顯示給 lead 的通路**（沒有存放處、沒有時間欄位、`call` 也不取），列為已知限制。

| 動作 | 誰 | 怎麼保證 |
|---|---|---|
| 新建 `status: proposed` 的提案 | solo agent（`run --agent`、`call -p`） | policy 放行 `proposals/`；guard 監看（D-03） |
| 把提案改成 `accepted`／`rejected`、寫 `reject_reason`／`accepted_as` | **只有 lead**（一般 run，或 `proposals review` 喚醒） | guard 還原 solo 的此類改動；review 以 policy 限定可寫範圍 |
| 寫正式 `records/decisions`、`records/lessons` | **只有 lead** | 同現況，並修好 solo 的授權漏洞（D-03） |
| `proposals list` | 唯讀 | 不寫任何檔案 |
| `proposals review` 指令本身 | 不寫提案內容或 record；只做 `mkdir proposals/`、喚醒 lead，以及 post-check 失敗時的回滾 | D-14、D-18 |
| tidy 封存已處理的提案 | lead 在 project-layer tidy 喚醒內 | 沿用 tidy 的回滾與保存驗證（D-12） |

## 30.4 決議總表

| # | 決議 | 理由 |
|---|---|---|
| D-01 | 新增提案區 `<project root>/proposals/<kind>/<id>.md`，`kind` 是 `lessons` 或 `decisions`。路徑函式放 `src/policy.ts`，與 `recordsKindDir` 並列。**不放 `records/` 之下**。放在 `shared/` 之外只是慣例上的區隔：`policy.ts` 的 `shared` 是 run 的 handoff 目錄，與 records 無關 | `policy.ts:219` 對非 lead deny 整個 `recordsDir`，parent 的 deny 贏過 child 的 allow（`policy.ts:95-98` 註解）；放在 `records/proposals/` 底下 solo agent 寫不了，還會被 `memory-tidy.ts:281` 的 `liveRecordFiles` 當成 records。提案區是 project root 的同層目錄，沒有任何現有 deny 涵蓋它 |
| D-02 | 只有 solo 的 agent（`project.solo` 有值）可寫提案區，且只能**新建** `status: proposed` 的檔；不能改 `accepted`／`rejected`，不能改別人的提案。非 solo 的一般成員對提案區唯讀；lead 可讀可寫 | 「可以寫，但最後還是 lead 決議」 |
| D-03 | **修 guard**：`checkRecords` 的 `authorized` 改為 `a.name === lead && !project.solo`。solo run 對 records 的改動還原並記違規。新增提案區監看。**判定「自己的」的依據是檔名前綴等於本 run 的短 id**（D-10）。違規規則：<br>(a) 只有 `proposals/(lessons|decisions)/<短id>-<slug>.md` 形式、且前綴等於自己短 id 的檔可被 solo 新增或變更；其他任何路徑（含 `.archive/`、別人前綴、非 `lessons|decisions` 子目錄）的**新增、變更、刪除**一律違規 → 還原或移除（含「預先佔用別人前綴的新檔」、「刪掉別人的提案」）；<br>(b) 既有提案（基準版本）若 `status` 已是 `accepted`／`rejected`，**任何改動都違規**，即使前綴是自己的（防 resume 後把已決議的提案改回 `proposed`）；<br>(c) 自己前綴的檔，基準是 `proposed` 或不存在時允許；**只有「解析出 `accepted`／`rejected`」才違規**。frontmatter 解析失敗或 `status` 拼錯的自家檔放行，由 D-09 第 (1) 層顯示為格式不符（與 D-07 一致，guard 不因格式問題刪檔）；<br>(d) 提案 frontmatter 的 `run` 必須對應本 run、`proposed_by` 必須等於本 agent（由 `checkDecisions` 檢查，不符視為格式不符，lead 不得收下）。<br>**提案區的還原與列舉重用 records 路徑的 `realDirs`／`isLink` 防護**，不得透過 symlink 寫到區外。**只在沒有其他 live run 時判違規並還原**；有其他 live run 時走既有的 `unattributed` 採納路徑（`guard.ts:166-169`），事件記入待審提示（30.3），並在 30.8 記為已知限制。**「其他 run」的定義（修正「視窗內啟動又結束的 run 看不到」）：** `otherLiveRuns` 必須是每次 `check` 重新取值的函式（現行簽名 `() => string[]`），且除了當下存活的 run，還要包含「id 大於本 guard 的 run／call id（run id 依啟動時間排序，`run-store.ts:210`）、不論現在是否存活」的 run；call 的 call id、`run --agent` 的 run id 即基準。`listRunLocks` 只計真正的 run，**專案鎖加 `kind: "call"` 標記，`call` 的鎖不計入 `otherLiveRuns`**（`readLockFile` 只驗 `token`／`pid`／`run_id`，多一個欄位可行），避免 call 削弱並行一般 run 的 guard、也避免兩個並行 `call -p` 互相視為 other 而使前綴規則失效。**`ProtectedGuard` 簽名相容：保留第二個位置參數 `otherLiveRuns`，新增第三個選用 opts `{ recordsRoot, proposalsRoot, shortId, violationsDir }`**（既有呼叫 `run-session.ts:364` 與 `test/guard-concurrent-runs.test.ts` 不改）。`call -p` 傳真實專案路徑與短 id；call 沒有 `run`，違規副本存在 `callDir/guard-violations/` | 見 30.1.1。沒有這項，「只有 lead 能寫正式 records」在無 OS 沙箱時不成立。這是**需要改的既有程式**。tidy 與 review 不經 guard 且 `project.solo` 是 `undefined`，所以此改動對它們與一般 run 的 lead 無影響 |
| D-04 | `run --agent` 本來就綁專案，直接可寫提案區。`call` 必須用 `-p <project>` 才可寫；沒有 `-p` 時 prompt 不提提案區，也沒有寫入權限。`-p` 的解析**用新 helper `resolveProjectRef(home, name)`（放 `src/paths.ts`）**：內部呼叫純函式 `projectPaths(home, name)`、檢查 `project.yaml` 存在、只讀其中的 `dir` 一個欄位；不載入成員與權限，不重用 `loadProject`（它沒有 `-p` 時會用 cwd 推斷專案）。專案不存在則 `call` 報錯退出（exit 非 0）。**資料通路：** `ResolvedProject` 新增選用欄位 `proposalsRef?: { projectRoot, recordsRoot, proposalsRoot, dir, shortId }`（`shortId` 由 dispatcher 在 `callAgent` 以 call id 算出，D-10）（`src/config.ts`），只有 `call -p` 會設；policy、prompt、guard 以它區分「`call -p`」與「無 `-p` 的 `call`」（`project.solo === "call"` 兩者相同，分不出來）。有 `proposalsRef` 時，`proposalsDir`／records 標題清單／guard 監看，以及 prompt 的 `writeScopeRules`（`prompt.ts:128-137`，原本輸出 callDir 下不存在的 `commonFile`、`recordsKindDir`）都改用它的真實路徑，而不是 `paths.root`（那是 callDir）。`call -p` 的鎖寫入 `kind: "call"`（D-03）。已知降級：call 與一般 run 並行時，一般 run 的 guard 不計入 call，call 對 records 的越界寫入會被該 run 的 guard 當成 lead 授權而採納（30.8 #13）。D-05 比對 `--dir` 與 `proposalsRef.dir`。真實 records 因 `recordsDir(project)` 指到 callDir，不在 policy 的 deny 內，由 OS 沙箱與 guard 守，Cursor 與無沙箱時只剩 guard（30.10）。`call -p` 取一把**非 exclusive 的專案鎖**（`acquireProjectLock` 對非 exclusive 的並行 run 相容，`src/project-lock.ts:371-373`），使 `proposals review` 的 exclusive lock 能擋住它。`callProject` 的保護範圍不變，只多監看真實專案的 `recordsRoot`、`proposalsRoot`（D-03）。**修訂 [spec 11](11-solo-agent.md) 決議 3、7**：`call` 沒有 `-p` 時仍不讀專案、不取專案鎖；有 `-p` 時取非 exclusive 專案鎖 | 「一定要指定 project 才可以寫」。review 失敗的回滾會先 `rmSync` 再還原，沒有專案鎖的 `call -p` 在那期間新寫的提案會被吃掉 |
| D-05 | 證據檢查的根目錄：`path:`／`commit:` 預設在 `project.dir`（`run --agent` 的專案 repo）。`call -p --dir X` 且 X 不等於 `project.dir` 時，提案必須寫 `repo: <絕對路徑>`；檢查時若該路徑不存在或不是同一個 repo，證據一律視為「弱證據」，跳過存在性檢查，不退回 | 提案格式本身要能說出證據在哪個 repo；沒有它，lead 在 `project.dir` 檢查必然找不到 |
| D-06 | 待審提案（`status: proposed`）在 lead 的 prompt 提示筆數與路徑；`done` **不擋**。`status`、`doctor`、`proposals list` 顯示待審數量與最舊日期。lead 的提示以**待審筆數 > 0** 為條件，不看 `proposals/` 目錄是否存在，且**必須帶 `!project.solo`**（`prompt.ts:128` 之外沒有帶 `!solo` 的 `isLead`；solo 走的 `buildUserPrompt` 沒有 `isLead` 變數，待審提示要自己寫 `agent.name === project.lead && !project.solo`，否則 solo agent 會看到「請標 accepted」，與 D-02 矛盾） | 只提示；以筆數判斷，避免 `ensureProjectDirs` 之類建目錄造成沒有提案的專案 prompt 改變（驗收 16） |
| D-07 | `evidence` 必填，格式見 30.5。缺少或格式不符的提案，lead prompt 顯示為「格式不符」，且不得標為 `accepted`（檢查見 D-09） | 必填 |
| D-08 | 提案的 `status` 為 `proposed`、`accepted`、`rejected`。已處理的提案留在原處，供之後比對，是否封存見 D-12 | 保留拒絕理由 |
| D-09 | 檢查分兩層，共用 `src/proposals.ts` 的純函式：**(1) 格式與決議完整性**（範圍分級：**`accepted` 才做完整檢查**〔frontmatter 合法、`evidence` 格式合法、單檔 8 KB、`run`／`proposed_by` 與檔名前綴一致〕；**`rejected` 只檢查 `reject_reason` 與 `decided`**，因為 lead 拒絕格式不符或過大的提案是最自然的處理，不可因那份檔案讓 `done` 被退回）：`decided` 與日期欄位要沿用 `records.ts:50-52` 對 YAML Date 轉型的處理；`rejected` 有 `reject_reason` 與 `decided`、`accepted` 有 `accepted_as` 與 `decided` 且指向存在的正式 record（「存在」**包含** records 的 `.archive/`，避免 records 被 tidy 封存後誤報）。**(2) 證據存在性**：`path:`／`commit:` 的存在性與行號（30.7）。第 (1) 層在三個時點執行：組 lead prompt、lead 送 `done`（`mailbox.ts:397` 同處；**`project.solo` 時跳過**：solo run 的 lead 就是 solo agent，它既不能改別人的提案也不能改 records，修不了違規，會使 `done` 死鎖；對**所有** `accepted`／`rejected` 提案檢查，未過就退回並指出路徑）、`proposals review` 的 post-check（未過就整批回滾）。第 (2) 層只在組 lead prompt（顯示強弱證據）、`proposals review`（提示 lead 逐條核對）、`doctor` 執行，**不擋 `done`** | 審查指出：「`done` 時全檢證據存在性」會因程式改動讓不帶 commit 的 `path:` 永久失效、`done` 被永久退回；「比對前後狀態」需要 `mailbox.ts` 目前沒有的基準。只檢查第 (1) 層不需要基準，也擋得住不合格的決議。review 沒有 `done`，所以 post-check 必須用同一個函式 |
| D-10 | 提案 id 格式 `<短 id>-<slug>`，只用小寫字母、數字、`-`；**短 id＝本 run（或 call）唯一部分的前 8 個小寫英數字元**（run id 形如 `20261123T…Z-<32 hex>`，含大寫與 `T`、`Z`，不可直接當前綴）。**前綴由 dispatcher 算好，prompt 直接給字面值**（例如「檔名以 `ab12cd34-` 開頭」），agent 不自己從 id 擷取（run id 以日期開頭，自行擷取會取到日期，被 D-03 (a) 移除）；`run --agent` 由 run-session、`call -p` 由 `callAgent` 算出，並分別傳給 prompt 與 guard（`proposalsRef.shortId`／guard opts）。「前綴＝短 id」的**寫入端是 prompt 規則**，不是機制保證；**強制端是 guard**：沙箱只能控制「能不能寫某目錄」。同一 run 內覆寫自己的提案允許（resume、reopen 沿用同 run id）；覆寫別的 run 的提案，由 D-03 的監看偵測 | 不可宣稱機制保證；`records.ts:14` 的 `ID_RE` 是 `^[a-z0-9-]+$`，直接用 run id 會全部不合格 |
| D-11 | 提案區不計入 12 KB 預算，也不顯示在 solo agent 的 prompt。lead prompt 只顯示 title、路徑、證據摘要，內文要時再讀；單次最多列 **10** 條待審，其餘只給數量。單一提案檔上限 8 KB，超過視為格式不符 | 避免 lead 的 context 被提案吃滿；上限讓「最多列 N 條」與「超大檔」可測 |
| D-12 | 提案區**屬於 tidy 範圍**：lead 的 project-layer tidy 可把「`status` 不是 `proposed`，且 **`decided` 距今超過 30 天**」的提案封存到 `proposals/.archive/<tidy-id>/`（用決議日，不是提案日，否則舊提案今天才被收下就會立刻被封存）；合併重複提案本版**不做**。規則寫在 tidy 的 prompt 裡，由 lead 在喚醒內執行；post-check 機械驗證：沒有檔案消失、被封存的每一個都符合規則、`proposed` 的都沒被搬，**且未封存的提案以 `fingerprint` 比對前後內容不變**（現有 `verifyConservation`〔`memory-tidy.ts:128-141`〕只檢查檔案在不在，不比內容）。`tidy --undo` 還原（擴充 `restoreMemory` 與 `cli.ts` 的輸出）。tidy 的 `watched`（`memory-tidy.ts:336`，本來就含 `commonFile(project)`）在 review 重用 tidy 機制時不可丟掉。**只有提案區、沒有 records 與 memory 的專案也要被 tidy 處理**（「records 必須存在」的前提在 `memory-tidy.ts:326-331`、`:424`、`:437`，`:299` 的 `recordsInScope` 是範圍判斷，一併檢視）。`.archive/` 不顯示在任何 prompt | 已處理的提案不能無限累積；封存是機械規則，可測，也維持「只有 lead 動手」 |
| D-13 | lead 收下提案時**新建**正式 record（不搬檔、不複製），frontmatter 寫 `status: active`，保留 `evidence`、`proposed_by`；提案檔改 `status: accepted` 並寫 `accepted_as: <kind>/<id>`。因為 `renderEntry`（`records.ts:105-107`）只輸出 title 與 body，lead 要把證據摘要寫進 body，prompt 才看得到 | 搬檔會把 `proposed` 狀態帶進 records，變成 `invalid` 卻仍算 active |
| D-14 | 新增指令 `agent-lyceum proposals`，**指令本身不寫任何提案或 record**：<br>• `proposals review -p <project>`：對專案的 lead 做一次**維護性喚醒**，沿用 `tidy` 的機制：專案 exclusive lock（`src/cli.ts:154` `takeLock`）、`invoke({ policy })` 把可寫範圍限定為 `[recordsDir, proposalsDir]`、`snapshotDirs`／`fingerprint`／`restoreDirs` 回滾、`TIDY_REPORT_FILE` 類的報告檔。**不經 guard**（tidy 路徑沒有 guard，`project.solo` 是 `undefined`）。喚醒後執行 D-09 的 post-check（**加上與 `done` 共用的 12 KB 預算檢查函式**：review 沒有 `done`，否則收下提案超限要到下一個一般 run 的 `done` 才被擋），未過整批回滾<br>• `proposals list -p <project>`：唯讀<br>一般 run 的 lead 也可以審，兩條路徑共用同一份審核規則文字與 D-09 的檢查。v1 **不提供**人工覆寫（`accept`／`reject`） | 只跑 `run --agent` 的專案沒有一般 run，需要入口。讓指令自己寫會使決議者變成「執行指令的人」，違反 30.3 的不變量，也繞過 D-09 |
| D-15 | lead 的待審提示附上各 kind 目前 active 位元組數與剩餘預算（`RECORDS_BUDGET - activeRecordsBytes`） | 收下提案可能讓 `done` 因超過 12 KB 被擋（`mailbox.ts:397-402`） |
| D-16 | **只針對 `call -p`**：prompt 顯示既有有效 active records 的標題清單（每條一行，不含內文）。`run --agent` 不改：它現有的 prompt（`prompt.ts:385`、`:403`）已經帶完整的 `<project_decisions>`／`<project_lessons>`。提案區不顯示在任何 solo agent 的 prompt。`call -p` 要列標題，需要真實專案的 records 路徑，由 D-04 的 `proposalsRef` 提供；`buildCallUserPrompt(agent, task)` 要新增選用的 project 參數 | `buildCallUserPrompt` 目前沒有任何 records；其他情境已超額滿足 |
| D-17 | solo agent 的 prompt 加「寫哪裡」判準（逐字見 30.12）：**提案**＝跨任務仍成立、會改變下次做法的教訓或決策；**handoff**（`run --agent` 才有）＝這個 task 的現況、待辦、踩過的坑；**memory**＝只對這個 agent 本身有用的習慣 | solo agent 現在有三處可寫 |
| D-18 | `proposals/` 目錄在 solo run 啟動、`call -p` 啟動、`proposals review` 啟動時建立（`mkdir -p`）。`ensureProjectDirs`（`mailbox.ts:85-90`）不建它，建目錄的呼叫點在 `run-session.ts`（solo run 啟動）、`call.ts`（`call -p`）、`cli.ts`（review）。各 runtime 的 `--add-dir`／allowWrite 在目錄存在時才有確定行為 | 避免第一次寫提案失敗 |

## 30.5 提案格式

```
---
status: proposed          # proposed | accepted | rejected（必填；solo 只能寫 proposed）
date: YYYY-MM-DD          # 必填
title: <一行>             # 必填
proposed_by: <agent>      # 必填
run: <run id 或 call id>  # 必填；語意同正式 record 的 run
evidence:                 # 必填，至少一項，每項是下列其中一種
  - path: src/foo.ts:120 @ <commit sha>   # 檔案、行號，並帶 commit 避免行號漂移
  - commit: <sha>
  - mail: <來源信的檔名或 id>             # 只檢查格式
  - output: "<指令> => <重點輸出>"        # 只檢查格式；值含 `: ` 時必須加引號，否則整份 YAML 解析失敗
repo: <絕對路徑>           # 證據所在的 repo；與 project.dir 不同時必填（D-05）
scope: <適用範圍>          # 選填，建議：模組、版本、情境
supersedes: [<id>]        # 選填，指向同 kind 正式 record 的 id
reject_reason: <一行>      # rejected 時必填
accepted_as: <kind>/<id>  # accepted 時必填
decided: YYYY-MM-DD       # accepted／rejected 時必填；tidy 以此判斷 30 天（D-12）
---
內文分兩段：「觀察到的事實」與「推測的原因」；推測要明寫。
```

## 30.6 流程

1. solo agent 結束前，若有符合 D-17 判準的內容，寫一條提案（`proposed`）。
2. 一般 run 的 lead 的 prompt 顯示待審筆數、路徑、剩餘預算（D-06、D-11、D-15）；沒有一般 run 的專案，用 `proposals review` 喚醒 lead。
3. lead 逐條對照 `evidence` 處理：成立就依 D-13 新建正式 record 並把提案標 `accepted`；不成立就標 `rejected` 並寫 `reject_reason`。
4. 一般 run：送 `done` 時做 D-09 第 (1) 層檢查。`review`：post-check，未過回滾。
5. tidy 依 D-12 封存已處理且超過 30 天的提案。

## 30.7 機械檢查（證據存在性，D-09 第 (2) 層）

- `path:`：檔案存在於檢查根目錄（D-05）的指定 commit，行號不超過該版本的行數。沒帶 commit 時只檢查檔案存在與行號不超過目前行數，標為「弱證據」。
- `commit:`：在檢查根目錄的 repo 裡存在。
- `mail:`、`output:`：只檢查欄位格式，不計為「已驗證」。
- 至少一項 `path:` 或 `commit:` 通過，才算「有可驗證證據」；其餘的提案仍可被收下，但 lead prompt 標明「無可機械驗證的證據」。
- 不檢查結論是否正確。

## 30.8 已知缺口與限制

| # | 缺口 | 處理 |
|---|---|---|
| 1 | 提案堆積 | `status`、`doctor`、`proposals list` 顯示數量與最舊日期，`proposals review` 提供處理入口；已處理的由 tidy 封存（D-12）。未處理的不自動過期，留待後續 |
| 2 | lead context 被提案吃滿 | D-11 |
| 3 | 多個 solo run 重複或矛盾的提案 | 不自動去重；lead 比對。D-16 讓 `call -p` 看得到既有 record 標題 |
| 4 | `evidence` 可能被編造 | 30.7 只擋不存在的 `path:`／`commit:`；擋不住錯誤因果，靠 lead 審核與「事實與推測分開寫」 |
| 5 | 各 runtime 強制程度不同 | D-03；30.1.1 已列各 runtime 的實際程度；`AgentEnforcement`（`policy.ts:9-20`）目前沒有 records／proposals 欄位，plan 決定是否加入以便 `doctor` 顯示 |
| 6 | **多 run 並存時 D-03 對提案區與 records 不還原**（`unattributed` 採納） | 已知限制，與現有 records 的行為一致；30.3 已把保證強度改為「單一存活 run 機制保證，並行盡力而為」；`unattributed` 事件只進 run log，不顯示給 lead（無資料通路，延後）；文件要寫明 |
| 13 | `call` 與一般 run 並行時，一般 run 的 guard 不計入 call（`kind: "call"` 的鎖），call 對 records 的越界寫入會被當成 lead 授權而採納；call 本身的 guard 仍監看 | 已知降級，換取 call 不削弱 run 的 guard 與兩個並行 `call -p` 前綴規則仍生效 |
| 12 | 一般 run 中非 lead 成員寫提案區，guard 不偵測（guard 目前不知道提案區） | 本版只靠 policy 唯讀；偵測延後 |
| 11 | guard 只在視窗頭尾各看一次，期間啟動又結束的 run 看不到，會誤還原 lead 的合法寫入 | D-03 已把「id 大於本 guard 基準的 run」也算 other，並要求 `otherLiveRuns` 每次 `check` 重取；驗收 4 加此案例（對 `run --agent` 同樣適用） |
| 7 | 同一個 agent 同時只能一個 call（`lockAgent`） | 平行提案的測試用「兩個不同 agent」或「一個 call 加一個 `run --agent`」，並補同 agent 被擋的反向案例 |
| 8 | 提案者與 lead 同模型，審核可能只是附和 | 不在本 spec 範圍；獨立複核延後 |
| 9 | D-03 讓使用者在 solo run 進行中手改 records 被還原 | 行為變更，寫進 30.10 與文件 |
| 10 | `status --json` 加欄位會影響 `web/` 的消費端 | plan 的 Task 8 確認 `web/` 是否讀未知欄位 |

## 30.9 待確認（plan 的 Task 0 要先查）

1. guard 對提案區的監看實作細節：`rebase()`（`run-session.ts:1493`）每個 batch 重取基準，與檔名前綴判定無關（第三次審查已讀過確認）；剩下要確認的是 D-03 (b) 的「基準版本 status」如何從 `readTree` 取得。
2. ~~call id 格式~~ 已結案：call id 就是 `newRunId()`（`call.ts:159`），與 run id 同格式，短 id 取法相同。
3. 提案區加入 spec 25 的受保護路徑：`sandbox-invocation.ts:86` 已把 `project.home` 整個列為保護，只需在 spec 25 加註（已確認，不需再查）。
4. `web/` 是否消費 `status --json` 的固定欄位。
5. 一般 run 中「非 lead 成員寫提案區」目前 guard **完全不知道提案區**（已讀程式確認），D-03 的監看只對 solo 實作；一般成員的偵測本版不做，只靠 policy 唯讀，記入 30.8。

## 30.10 風險

- **中**：D-03 改 guard 的授權條件，使既有 solo run 在寫 records 時開始被還原；預期的修正，但是行為改變，文件與發版說明要寫明。
- **中**：`call -p` 新增專案鎖，改變 spec 11 的決議 3。
- **中**：提案區是新的寫入面，各 runtime 強制程度不同（30.1.1、30.8 #5）。
- **低**：沒有提案的既有專案行為不變（驗收 16）。

## 30.11 驗收

| # | 驗收 | 層級 |
|---|---|---|
| 1 | `run --agent` 的 agent 能新建 `proposals/lessons/<id>.md`（`status: proposed`） | policy 單元 + guard 測試 |
| 2 | solo agent 寫 `records/lessons/x.md`：guard 還原並記違規（有無 OS 沙箱的 policy allow／deny 內容另以 policy 單元測試驗；OS 沙箱本身不在單元測試範圍） | guard 與 policy 單元測試 |
| 3 | 單一 live run 下，solo agent：改別人前綴的既有或新增提案、寫 `status: accepted`、把基準已是 `accepted`／`rejected` 的提案（含自己前綴、resume 同 run id）改回 `proposed` 或任何改動：被還原並記違規；自己前綴、基準 `proposed` 或不存在、結果仍 `proposed`：允許；`proposals/lessons` 換成 symlink：不跟隨、還原不寫到區外；刪除別人的提案、在 `.archive/` 或別人前綴下新增：違規；自家檔 frontmatter 壞掉：放行（由 D-09 標格式不符）；`run --agent` 在其他 run 於某 batch 內啟動又結束時，lead 的寫入不被還原。有其他 live run 時走 `unattributed`，不還原 | guard 單元測試 |
| 4 | `call` 無 `-p`：prompt 不含提案區、沒有寫入權限、不取專案鎖。有 `-p`：可寫、取非 exclusive 專案鎖、guard 監看真實專案路徑（`proposalsRef`）。**`call -p` 進行中，另一個 run 的 lead 新增 record 或把提案標 `accepted`：不被還原**，包含「該 run 在 call 開始後才啟動、call 結束前就已結束」的情況（D-03 的「其他 run」定義）；兩個並行 `call -p` 前綴規則各自生效；`call` 的鎖帶 `kind: "call"`，不計入一般 run guard 的 `otherLiveRuns`。`-p` 專案不存在：exit 非 0。`-p` 與 `--dir` 不同時證據根目錄與 `repo:` 規則（D-05）生效 | call 與 CLI 測試 |
| 5 | 存在 `accepted` 但缺 `accepted_as`／`decided`、或 `rejected` 但缺 `reject_reason`／`decided` 的提案：一般 run 的 lead 送 `done` 被退回，訊息指出路徑；`proposed` 的待審提案不影響 `done`；**`project.solo` 時 `done` 不做此檢查**；solo agent 的 prompt 不含「請標 accepted」的待審提示 | mailbox 與 prompt 測試 |
| 6 | lead prompt 顯示待審筆數、路徑、剩餘預算；超過 10 條時只列 10 條並給總數；以筆數 > 0 為條件 | prompt 測試 |
| 7 | 兩個不同 agent 各寫一條，兩者都保留；同 agent 第二個 `call` 被擋 | call 測試 |
| 8 | 收下後：正式 record 含 `evidence`、`proposed_by`，body 含證據摘要；提案檔 `status: accepted` 且有 `accepted_as` | 流程測試（fake invoker） |
| 9 | 單檔超過 8 KB 視為格式不符；`path:`／`commit:` 引用不存在時 lead prompt 標「無可機械驗證的證據」，且不擋 `done` | proposals 測試 + prompt 測試 |
| 10 | `call -p` 的 prompt 含既有 active records 標題清單，不含內文；`run --agent` 的 records 區塊與現況位元組相同（solo 的提案規則段是新增的，D-17） | prompt 測試 |
| 11 | `proposals/` 是 symlink 時，guard 與列舉不跟隨 | guard 測試 |
| 12 | tidy：`status` 不是 `proposed` 且 `decided` 超過 30 天的提案被封存（提案日很舊但剛決議的不封存），`proposed` 的不動；未封存提案內容被改動時 post-check 回滾；只有提案區的專案也被處理；`tidy --undo` 還原 | tidy 測試 |
| 19 | `accepted_as` 指向已被 tidy 封存到 records `.archive/` 的 record：D-09 第 (1) 層與 `doctor` 不誤報 | proposals 與 doctor 測試 |
| 13 | `proposals list` 只讀：前後專案檔案位元組不變；顯示待審數、最舊日期、格式不符項目 | CLI 測試 |
| 14 | `proposals review`：同專案有活著的 run 或 `call -p` 時被 exclusive lock 拒絕；policy 覆寫的可寫範圍只有 `recordsDir` 與 `proposalsDir`；喚醒期間不經 guard；post-check 未過或報告缺少時整批回滾 | CLI 測試 + 流程測試 |
| 15 | `proposals review` 與一般 run 的 lead 審核，對同一批不合格提案套用同一個 D-09 函式，結果相同 | 流程測試 |
| 16 | 沒有任何提案的既有專案，lead 與一般成員的 prompt 位元組與現在完全相同；`proposals/` 目錄存在但為空也相同 | prompt 快照測試 |
| 17 | `status`、`doctor` 顯示待審數量與最舊日期；`doctor` 對 `accepted_as` 指向不存在的 record 與格式不符的提案報警 | status 與 doctor 測試 |
| 18 | solo 的 `proposals/` 在 solo run、`call -p`、`review` 啟動時被建立 | policy／call／CLI 測試 |

## 30.12 逐字文字（dispatcher 文字維持英文；plan 的 Task 4 實作時以此為準，可微調措辭但不可改語意）

**solo agent 的提案規則：**

```
## Proposals
You cannot write the project's decisions or lessons. When you learn something that stays true across tasks and would change how the next run should work, write it as a proposal: one Markdown file `<short-id>-<slug>.md` in `<proposals>/lessons/` or `<proposals>/decisions/`. `<short-id>` is exactly `{{prefix}}` (the dispatcher fills in the literal value, for example `ab12cd34`; never derive it yourself). Use only lowercase letters, digits and `-`.
Start the file with `status: proposed`, `date`, `title`, `proposed_by`, `run` and at least one `evidence` entry (a file path with line and commit, a commit, a mail, or a command with its key output). Put `repo` when the evidence is in a different repository than the project. Write the facts you observed first, then your guess about the cause, and mark it as a guess.
Never edit an existing proposal of another run, and never set `status` to anything but `proposed`. The lead decides.
Where things go: a proposal is for lessons and decisions that outlive this task; {{handoff clause, only for `run --agent`: the handoff notes are for the state, next steps and pitfalls of this task only;}} your memory is for habits that matter to you alone.
```

**lead 的待審提示：**

```
## Proposals waiting for you
<N> proposals await a decision (oldest: <date>). Showing <min(N,10)>: <path — title — evidence strength>.
For each one, check the evidence yourself, then either create the record (a new file, not a copy) and set the proposal to `status: accepted` with `accepted_as: <kind>/<id>`, or set `status: rejected` with `reject_reason`. In both cases also write `decided: <today's date>`. Put a short summary of the evidence in the record's body. Active <kind> entries use <used> of <budget> bytes; merge or supersede before you exceed it.
```

## 30.13 影響的檔案

| 檔案 | 改動 |
|---|---|
| `src/policy.ts` | `proposalsDir`／`proposalsKindDir`；solo 的 `allowDirs`；非 solo 對提案區唯讀 |
| `src/proposals.ts`（新） | 提案解析、D-09 兩層檢查、待審清單 |
| `src/guard.ts` | 修 `checkRecords` 授權條件；提案區監看（D-03 a–d）；選用的 `recordsRoot`／`proposalsRoot`／`runTag`／`otherLiveRuns`；違規副本目錄 |
| `src/config.ts` | `ResolvedProject.proposalsRef`（D-04） |
| `src/prompt.ts` | solo 規則與判準、`call -p` 標題清單（`buildCallUserPrompt` 加 project 參數）；lead 待審提示（`!project.solo`） |
| `src/mailbox.ts` | `done` 時的 D-09 第 (1) 層（`project.solo` 跳過） |
| `src/call.ts`、`src/cli.ts`、`src/paths.ts`、`src/run-session.ts` | `call -p`（`resolveProjectRef`、非 exclusive 專案鎖、傳 `otherLiveRuns`）；`proposals review`／`list`；solo run 啟動時 `mkdir proposals/` |
| `src/memory-tidy.ts`、`src/cli.ts` | 提案區納入 tidy 與 undo（`restoreMemory`、輸出）；只有提案區的專案不 skip；未封存提案 `fingerprint` |
| `src/status.ts`、`src/doctor.ts` | 待審數量、最舊日期、格式檢查 |
| `docs/*` | 中英文件；spec 11 決議 3、7 與 spec 25 受保護路徑加註 |

## 30.14 後續（不在本 spec）

- 人工覆寫（`proposals accept`／`reject`，需記 `decided_by: human`）。
- 獨立複核；使用回饋追蹤。
- 未處理提案的自動過期；合併重複提案。
- 是否讓 `call -p` 也看到 rejected 提案標題。
