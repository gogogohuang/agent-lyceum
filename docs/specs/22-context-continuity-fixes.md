# 22 context 連續性修正（修正清單 C 類的處置與設計）

狀態：已審查通過（round 2 approve），實作中。輸入：修正清單 `docs/fixes-for-analysis-reports.md` 的 C 類（C-01…C-16）與複審 `docs/independent-review-of-fixes.md`，兩份都只在分支 `docs/fixes-for-analysis-reports` 上（`git show docs/fixes-for-analysis-reports:docs/<檔名>`）。背景：`docs/analysis-context-sharing-need.md`（下稱 R2）§4 的 F／G 規格、`docs/review-analysis-reports.md`。

所有 `檔案:行號` 都以目前 HEAD 的 `src/` 重新核對過。HEAD 的 `src/` 與修正清單的基準 `088a180` 相同（`git diff --stat 088a180 HEAD -- src` 沒有輸出），但本文不直接引用修正清單或複審的行號，每一處都重新開檔確認過。

## 22.1 問題

- 修正清單 C 類列了 16 條「程式或規格有洞」的建議，每條都寫著「需另開任務實作」。其中有 4 條（C-03、C-06、C-11、C-14），複審判定照字面做會出事；另有一個 blocker（RD-01）：用 2d1b53 當 `sessionId === undefined` 規則的反例是錯的。
- 使用者要求：依修正清單的結論寫 spec 並實作；判準見 22.2。
- 核心缺口是「同一個 agent 跨嘗試的連續性」（決策紀錄 `no-broad-context-sharing`）。具體有三處：
  - resume 後重做時，agent 不知道這是重做（`attempt` 每次 wake 從 0 起算：`src/fallback.ts:204`，`src/run-session.ts:440`）。
  - 失敗那次嘗試的 outbox 草稿被收起來後，沒有交還給它自己（`src/run-session.ts:493,498` 只做 park）。
  - prompt 只在 wake 開頭組一次（`src/run-session.ts:379`），同一個 wake 內的重試看不到剛收起的草稿。

## 22.2 判準與決議表

判準（使用者訂的）：
- **本次實作**：複審與修正清單都確認問題成立；修法小而可測；不改檔案格式（`state.json`、mail frontmatter、claim、attempt、config 都不可改）；不改權限模型；不需要真實的付費 runtime 就能驗證。
- **延後**：問題成立，但需要真實 runtime 驗證、改動面大，或需要使用者先決定政策。使用者已點名 C-09、C-10、C-14 延後。
- **不做**：複審證明不成立，或風險大於效益。

| 項 | 標題 | 處置 | 一句理由 | 證據（HEAD） |
|---|---|---|---|---|
| C-01 | G 的觸發點錯位（resume 重做時 `attempt`=0） | **本次實作**（22.5） | 兩份文件都確認。改成每次 invoke 依「同 agent、message id 有交集、status failed 的先前 attempt」判斷，只讀現有的 claim／attempt 檔 | `src/fallback.ts:204`（`attempt: 0`）、`:221,226`（只在同一個 wake 內遞增）；`src/run-session.ts:440`；`src/message-store.ts:126-137,255-262` |
| C-02 | F 的草稿只在 wake 開頭算一次 | **本次實作**（22.5） | 兩份文件都確認。在 `invoke` 回呼內、`beginAttempt` 之後重新選 | `src/run-session.ts:379,426,440,493-499`；`src/message-store.ts:218`（新 attempt 是 `started`） |
| C-03 | F 與 resume 的重複注入 | **本次實作，按複審重新設計**（22.5.6） | 修正清單的「失敗者自己回傳 id 就略過」與原本的 `sessionId === undefined` 都不採用；符合條件的草稿一律有界注入（≤4 KB），接受可能重複 | `src/process-runner.ts:174,216,217`（取消／逾時不帶 id）；`src/run-session.ts:423,429,449`；`src/message-store.ts:174-186`（attempt 沒有 runtime／session 欄位） |
| C-04 | `retryPrompt` 的「discarded」與草稿段互相矛盾 | **本次實作**（22.5.4） | 有草稿時改寫那一句，沒有草稿時不動；保留「檢查 repo、重新寄信」的要求（CA-04） | `src/run-session.ts:44-45` |
| C-05 | G 要進 `## Rules` 並說明何時寫 | **延後** | 改的是系統提示；被 resume 的 Claude 可能看不到（C-16），而且效果要用新的真實 run 量測（CA-05 的口徑） | `src/prompt.ts:209-216,218-231`；`src/adapters/claude.ts:76-77,81` |
| C-06 | 跨 run 的 guard 還原另一個 run 的合法共享寫入 | **延後** | 缺陷成立（CA-06 已用兩個 fake run 重現），但修法要設計跨 run 寫入協定，會動到權限模型；「另一個 lead 在活動就跳過」不得採用 | `src/guard.ts:42-45,82-105,107-133`（授權只看本批 `running`）；`src/run-session.ts:593,926`；`src/project-lock.ts:299` |
| C-07 | 切換備援的 note 說「starts a fresh session」，有時不準 | **本次實作**（22.6） | 只改 `state.notes` 裡那一句的值；JSON 結構不變 | `src/run-session.ts:407-416,423,429`；`src/status.ts:330,488` |
| C-08 | mail 內文沒有長度上限，原文進 prompt | **本次實作**（22.7） | 只截 prompt 端，不改 mail 格式；明訂每封與整批的預算、切在 UTF-8 邊界（CA-08）。route／hash 讀全文的資源問題另案 | `src/prompt.ts:295-306`（`:304` 原文）；`src/mailbox.ts:148-152,165-180,281` |
| C-09 | `done` 不檢查 COMMON.md 大小 | **延後**（使用者點名） | 硬擋可能讓既有專案一升級就無法 `done`；solo 也無權縮減 COMMON。prompt 已有截斷提醒（CA-09），「agent 不知道」不成立 | `src/prompt.ts:253-260`；`src/mailbox.ts:307-318`；`src/policy.ts:120,134` |
| C-10 | solo 模式 records 超預算時 `done` 永遠被拒 | **延後**（使用者點名） | CA-10 已用 fake 重現；修法本身很小（加 `!project.solo`），但牽涉 solo 的政策（solo 該不該管 records），由使用者決定 | `src/mailbox.ts:312`；`src/solo.ts:15-20`；`src/policy.ts:120,131,155`；`src/schema.ts:122`（`max_rounds` 預設 0） |
| C-11 | `done` 前不檢查被拒的信 | **延後** | 要知道「哪些拒信還沒處理」，得先設計拒信的身分與「已解決」規則；`log.jsonl` 會輪替（CA-11），而在 `state.json` 加欄位就是改格式。語料裡 0 次 `rejected` 事件，效益低 | `src/run-session.ts:663-666`；`src/run-log.ts:12-15`；`src/schema.ts:126`；`src/mailbox.ts:191-194,264-277` |
| C-12 | Rules 沒寫 context 衝突的優先順序 | **延後** | 改的是系統提示（受 C-16 影響），模型會不會照做要用真實 runtime 才能驗證；措辭也要先按 CA-12 限定在「harness 注入的內容之間」 | `src/prompt.ts:218-231`；`src/adapters/claude.ts:76-77`；`src/adapters/codex.ts:84` |
| C-13 | `paths.common` 是沒人用的死欄位 | **本次實作**（22.8） | 只存在記憶體，不寫入磁碟；package 只有 `bin`、沒有 library 匯出，刪掉沒有相容問題 | `src/paths.ts:49,65`；`src/call.ts:75`；`package.json`（只有 `bin`） |
| C-14 | Codex＋`can_edit_agent_md` 的可寫根會變寬 | **延後**（使用者點名） | 需要先做設計決策（不支援並報錯／改由 dispatcher 套用／接受並揭露），而且 OS 沙箱的實際行為要用真實 Codex 驗證 | `src/adapters/codex.ts:7-12`；`src/policy.ts:136-139,203` |
| C-15 | attempt id 在 a1 損毀、a2 有效時覆蓋 a2 | **本次實作**（22.9） | CA-15 已實跑確認。新編號改成「檔名與目錄名裡最大的 n＋1」；id 格式不變 | `src/message-store.ts:200-212,215-221`（`:217` 的 `count + 1`） |
| C-16 | resume 的 Claude 可能沿用舊的系統提示 | **延後** | 只有 `claude --help` 的文字可依，需要真實 Claude 實驗（涵蓋 compact 前後）；本 spec 新增的文字一律放在 user prompt，所以不受它影響 | `src/adapters/claude.ts:76-77,81,87`；`src/adapters/codex.ts:84` |

合計：本次實作 8 項（C-01、C-02、C-03、C-04、C-07、C-08、C-13、C-15），延後 8 項（C-05、C-06、C-09、C-10、C-11、C-12、C-14、C-16），不做 0 項。
沒有任何一項判為「不做」：16 項的問題都被證實成立，被否決的只是個別修法（見 22.14）。

## 22.3 與修正清單、複審不同之處

| 項 | 修正清單說 | 本 spec | 原因 |
|---|---|---|---|
| C-01 | 觸發條件改用 F 的候選；驗證用 `grep … \| head -3` | 照做，並和 C-02 共用同一個選取函式，每次 invoke 都重選；沒有草稿也會觸發重做提示（CA-01）。驗證改用 fake runtime 測試，不用那條 grep（QR-02：`head -3` 會截掉目標事件） | CA-01、QR-02 |
| C-01 | G 加在 `retryPrompt` | G 的「先讀 task memory」放進 user prompt 的 Retry／Redo notice。G 的另一半（Memory 段、何時寫）屬於 C-05，延後 | C-16：系統提示對被 resume 的 Claude 可能無效；user prompt 每次都經 stdin 重送（`src/adapters/claude.ts:87`、`src/adapters/codex.ts:84`） |
| C-03 | 「只有失敗那次自己回傳了 session id 時才略過注入」 | **不略過**：符合條件就一律有界注入，接受可能重複 | CA-03：resume:false 的成員與切換候選模型時都會錯關 F；attempt 記錄沒有 runtime／candidate／session 欄位（`src/message-store.ts:174-186`），要記錄就得改 attempt 格式，違反判準 |
| C-03 | 引用 A-05 的 2d1b53 反例 | 撤回這個反例；原規則 `sessionId === undefined` 也不採用，理由改用程式路徑（22.4 #7） | RD-01 blocker |
| C-04 | 有草稿時改文字；測試「無草稿的與舊版完全相同」 | 有草稿時改「discarded」那句；但只要 agent 有 task memory，Retry notice 就會多一句 G。逐字不變只保證「沒有先前失敗的 attempt」與「agent 沒有 task memory 且沒有草稿」兩種情況 | 實作 C-01 的 G 就必然改到 retry 文字；本 spec 明訂哪些情況逐字不變 |
| C-07 | key 寫成 `` `${agent.name}@${to.key}` ``；驗收「`status --json` 逐字相同」 | key 用與 `run-session.ts:423` 共用的 helper（主要模型用 agent 名稱）；驗收改成「JSON 欄位與結構不變，只有那一筆 note 的值不同」 | CA-07：notes 本來就在 JSON 裡 |
| C-08 | 「沿用 `task.ts:6` 的 16 KiB 模式」 | 每封 16 KiB、整批 64 KiB，切在 UTF-8 字元邊界，附原檔路徑；`task.ts` 沒有可直接沿用的截斷 helper | CA-08 |
| C-13 | 驗證指令 `rg 'paths\\.common'`（雙反斜線） | 用 `rg 'paths\.common' src test plugins scripts`（單引號內只有一個反斜線），再加上 `rg -n 'common:' src/paths.ts src/call.ts` | CA-13：雙反斜線會漏抓 |
| C-15 | `max(existingFileNames) + 1` | 也把 attempt **目錄**（`<id>/log`、`<id>/outbox`）算進去，並限定在同一個 claim 的完整 `-a<n>` 名稱內 | CA-15；JSON 損毀時目錄仍在，只看 JSON 會重用舊的 outbox 目錄 |
| C-06 | 方向之一：「另一個活躍 run 的 lead 寫的變更不還原」 | 延後，並明文禁止這個方向 | CA-06：分不出是 lead 寫的，還是同時段沒有沙箱的 member 寫的 |
| C-09 | 「`done` 附非阻擋提醒」 | 延後 | 使用者點名；CA-09：`done` 之後沒有下一次 wake，寄給 lead 的提醒使用者看不到，要先決定顯示位置 |
| C-11 | 從 `log.jsonl` 取本段的 `rejected` 事件 | 延後 | CA-11：log 會輪替並覆蓋舊備份（`src/run-log.ts:12-15`），拒信記錄也沒有穩定的配對鍵 |
| C-16 | 「lead 永遠看不到」 | 只寫「compact 之前可能沿用舊系統提示（依 help 文字，未實測）」 | CA-16、QR-06 |

## 22.4 複審中兩位審查者意見不一致的四項（#6、#7、#9、#12）

| # | 爭點 | 我的判斷 | 依據（HEAD） |
|---|---|---|---|
| 6 | 評估報告提議「備援一律不帶 sessionId」，修正清單判它不可取，算不算被推翻 | **部分**（同意 RD 的分類）；設計上採 CA 的結論：保留備援的 session，改 note（C-07） | 「會失去連續性」有程式依據：備援有自己的 session key（`src/run-session.ts:423`），resume 時讀（`:429`）、成功或帶 id 時寫回（`:449`）。主要模型冷卻期間，每次 wake 都直接從備援開始（`src/fallback.ts:83-87`），一律 fresh 會讓每次 wake 都失去連續性。但這是取捨，不是證據推翻；原報告也列了改 note 的替代方案。改 note 的改動比移除既有能力小，所以採它 |
| 7 | I-03 的「只在 `sessionId === undefined` 時注入」 | **反例要撤回（RD 對），規則本身仍不採用（CA 對）**；兩者不衝突 | 2d1b53 的那次失敗發生在第一次成功之前，新 run 的 `sessions` 是空的（`src/run-store.ts:215-216,231`），所以原規則會准許注入，不能當反例。但一般情況下，規則依賴的 `sessionId` 是這個 key「先前記錄的 id」（`src/run-session.ts:429`），而逾時、取消都不帶 id（`src/process-runner.ts:216-217`），所以不會寫回（`:449` 需要 `result.sessionId`）。逾時之後的重試會 resume 較早的 session；那個 session 裡有沒有逾時那次的 turns，取決於 runtime（未知）。在這種情況下規則會關掉 F，正好是最需要草稿的時候。本 spec 改採一律有界注入（22.5.6） |
| 9 | 「COMMON 超過 8 KB 就擋 `done`」有沒有風險 | **CA 的限定版成立**：沒有排除 solo、也沒有規劃升級的硬擋確實有風險；只擋 team lead 的版本可行，但屬於政策決定，所以 C-09 延後 | solo agent 就是 `project.lead`（`src/solo.ts:18`），但 `isLead` 對 solo 為 false（`src/policy.ts:120`），COMMON 只在 `isLead` 時才放進 `allowFiles`（`:134`）。也就是說，solo 被要求縮減它無權寫的檔。records 的同型鎖死在 `src/mailbox.ts:312` 對 solo 也成立，CA-10 已用 fake 重現。team 專案升級後被擋住的風險取決於既有 COMMON 的大小；本專案目前是 5,923 B（`wc -c`，未超過），其他專案未知 |
| 12 | 「R2:165 呼叫點寫錯」「必須在 `beginAttempt` 之前選」 | **撤回「必須在 `beginAttempt` 之前」（兩人都同意）**；「R2:165 寫錯」不是評估報告的指控（RD 對），所以這一條的總判定是**部分** | `beginAttempt` 寫入的是 `status: "started"`（`src/message-store.ts:218`），選取條件是 `failed`，所以在它之後選也不會選到自己。本 spec 刻意在 `beginAttempt` 之後選，並把剛建立的 attempt id 明確排除（22.5.5）。評估報告 `docs/review-analysis-reports.md:106,135` 的原文是「base.userPrompt 只算一次；應每次 invoke、beginAttempt 前重選」，沒有說 R2:165 寫錯 |

## 22.5 重做脈絡：C-01＋C-02＋C-03＋C-04

### 22.5.1 決議

| # | 決議 |
|---|---|
| 1 | 每次 invoke（每一次呼叫 runtime）都重新找「先前失敗的 attempt」：條件是同一個 agent、status `failed`、它所屬 claim 的 `message_ids` 與這次要處理的 message id 有交集，而且 claim 的狀態是 `claimed` 或 `abandoned`。這是 C-01 與 C-02 共用的選取。 |
| 2 | 找得到時，prompt 一定加上提示：同一個 wake 內的重試（`attempt > 0`）用既有的 `# Retry notice`；其他情況（resume 重做、取消後重做、前一個 run 段落 agent_failed 之後的 resume）用新的 `# Redo notice`。兩者都會提醒：檢查 repo、重新寄信、先讀 task memory（G 的重做那一半）。 |
| 3 | 草稿：從最新的候選 attempt 開始，讀它們 `mail/attempts/<id>/outbox/` 裡實際存在的檔案，以有界、不跟隨 symlink 的方式讀，整段上限 4 KB、最多 5 個檔案，附在提示之後。標示「未驗證、未投遞」。 |
| 4 | 不依 session 狀態略過注入（C-03 的重新設計）。 |
| 5 | 所有新文字都只放在 **user prompt**，不碰系統提示（避開 C-16）。 |
| 6 | 找不到候選時，prompt 與現在逐字相同。任何讀取錯誤都不會讓 wake 失敗，只記 log，然後照沒有草稿的方式繼續。 |
| 6a | 選取路徑讀 claim／attempt 的 JSON 時，**不用**既有的 `listAttempts`／`loadClaim`（它們用 `readFileSync` 讀全文、跟隨 symlink、遇 FIFO 會卡住：`src/message-store.ts:121-122,200-206`），改用 `redo.ts` 內的有界 metadata reader（22.5.2a）。這只保證**本 spec 新增的選取路徑**不跟隨、不阻塞；既有的 `recoverRunMail` 與 `beginAttempt` 仍用舊 reader（22.5.2a 末段），所以不宣稱整個 resume 能處理 metadata FIFO。 |
| 7 | 不改任何檔案格式；`log.jsonl` 只新增事件與 `wake` 事件的一個選用欄位。 |

### 22.5.2 新模組 `src/redo.ts`（純讀取，不寫檔、不記 log）

```ts
export interface PriorAttempt {
  id: string;          // <claim id>-a<n>
  claimId: string;
  n: number;
  error: string;       // attempt 的 error；記錄讀不到時為 "unknown (attempt record unreadable)"
  at: number;          // 排序用：finished_at ?? started_at ?? 目錄 mtime（epoch ms）
}

export interface Skip { path: string; reason: string }   // path 相對於 run 目錄；reason 見 22.5.3

export interface PriorResult {
  prior: PriorAttempt[];   // 有效候選，新的在前
  skipped: Skip[];         // 被略過的 attempt／claim 記錄或祖先目錄；不影響其他有效候選
}

/** 這次 invoke 之前、同一個 agent 處理同一批信時失敗過的 attempt。不丟例外。 */
export function priorFailedAttempts(runDir: string, agent: string, messageIds: string[], exclude: string): PriorResult;

export interface DraftsResult {
  text: string;                                   // 整段草稿區塊；沒有可用草稿時為 ""
  injected: { path: string; bytes: number; truncated: boolean }[];
  skipped: Skip[];
  reconciled: { attempt: string; onlyOnDisk: string[]; onlyInRecord: string[] }[];
}

/** 依 R2 §4 的讀取契約讀草稿；budget 含標題與所有標記。 */
export function collectDrafts(runDir: string, prior: PriorAttempt[], budget?: number /* 4096 */, maxFiles?: number /* 5 */): DraftsResult;

/** 組出這次 invoke 的 user prompt（純函式，沒有 IO）。 */
export function redoUserPrompt(base: string, o: { attempt: number; error?: string; prior: PriorAttempt[]; drafts: string; taskMemory?: string }): string;
```

`priorFailedAttempts` 的步驟（每一步的略過都寫進 `skipped`，然後繼續處理其他記錄；只有祖先檢查失敗會讓整個結果為空）：
1. 祖先：`runDir`、`mail`、`mail/attempts`、`mail/claims` 逐層 `lstat`，必須是真目錄，不能是 symlink。`mail/attempts` 不存在 → `{prior: [], skipped: []}`（舊 run，與現在相同）。任何一層是 symlink 或不是目錄 → `{prior: [], skipped: [{path, reason: "ancestor_symlink" | "not_dir"}]}`。`mail/claims` 不存在 → 同上，原因 `metadata_missing`。
2. 列出 `readdir(mail/attempts)`（只看名稱，不跟隨）。名稱分兩類：
   - `<name>.json`：用 22.5.2a 的 `readMetadataJson` 讀，再用 `validAttempt(rec, name)` 驗證；不合格就略過（原因 22.5.2a）。保留 `status === "failed"`、`agent === agent`、`id !== exclude` 的記錄。
   - 沒有 `.json` 的名稱：`lstat` 為真目錄、名稱符合 `^(.+)-a([1-9]\d*)$`、`isSegment(claimId)` 成立，而且同名的 `.json` 沒有通過上一步的讀取與驗證（不存在、損毀、過大、不是 regular file）→ 當作「記錄讀不到的 attempt」，`error` 為 `unknown (attempt record unreadable)`。agent 名稱可能含 `-`，所以 agent 只從 claim 檔判斷，不從名字解析。
3. 讀 claim：對每個不同的 claim id，讀 `mail/claims/<claimId>.json`（`readMetadataJson`＋`validClaim(rec, claimId)`；不合格就略過，原因 22.5.2a）。必須 `claim.agent === agent`、`claim.status` 是 `claimed` 或 `abandoned`，而且 `claim.message_ids` 與 `messageIds` 有交集。某個 claim 壞掉只排除屬於它的 attempt，其他 claim 的候選照常保留（N1）。
   - 為什麼排除 `committed` 與 `output_ready`：那批信已經有成功的 attempt，輸出已經或即將被投遞，舊草稿已被取代。
4. 依 `at` 由新到舊排序，`at` 相同時依 `n` 由大到小。`at` 取 attempt 的 `finished_at ?? started_at`（`Date.parse` 結果不是有限數字時視為沒有），都沒有時用目錄的 `lstat` mtime，再沒有就是 0。

讀取量：每次 invoke 讀全部 attempt JSON 一次（每個上限 64 KiB），再對少數 claim id 各讀一次 claim。語料中 17 個 run 共 153 個 attempt（committed 128、failed 18、started 7），一個 run 最多也只有幾十個小檔，成本可以忽略。不限制 attempt 的數量：名稱來自 dispatcher 寫的目錄，每個檔的讀取量有上限，而截掉數量反而可能漏掉最新的候選（目錄順序不是時間順序）。不做快取，因為快取會在平行 wake 之間帶來一致性問題。

### 22.5.2a 有界 metadata reader（R1）

放在 `src/redo.ts` 內，不匯出到其他模組：

```ts
const METADATA_LIMIT = 64 * 1024;
/** 讀一個 claim／attempt JSON：不跟隨 symlink、不阻塞、有上限。不丟例外。 */
function readMetadataJson(file: string): { value: unknown } | { skip: string };
function isSegment(s: unknown): s is string;           // 可以當成單一路徑片段的 id
function validAttempt(v: unknown, fileBase: string): AttemptRecord | string;   // 回傳記錄，或略過原因
function validClaim(v: unknown, claimId: string): ClaimRecord | string;
```

- `readMetadataJson`：用 22.5.3 新增的 `readRegularFileCappedNoFollow(file, METADATA_LIMIT)`（`O_RDONLY|O_NOFOLLOW|O_NONBLOCK`、`fstat` 必須是 regular file、最多讀 `limit + 1` byte）。
  - 開檔失敗：`ELOOP`（leaf 是 symlink）→ `symlink`；其他錯誤 → `open_error:<code>`。
  - `fstat` 不是 regular file（FIFO、socket、device、目錄）→ `not_regular`。FIFO 以 `O_NONBLOCK` 開啟時，沒有寫入端也會立刻回傳，接著被 `fstat` 擋下，所以不會卡住（macOS 實測，見 22.15 的 probe）。
  - 超過 64 KiB → `metadata_too_large`（只讀了 64 KiB＋1 byte，不讀全文）。現有的 claim／attempt JSON 都在 2 KB 以下。
  - `JSON.parse` 失敗、內容不是 UTF-8 文字 → `metadata_unreadable`。
- `isSegment(s)`：字串、長度 1–200、不含 `/`、`\`、NUL，不是 `.` 也不是 `..`，不以 `.` 開頭。claim id 的格式是 `<base36>-<agent>-<hex>`（`src/message-store.ts:128`），agent 名稱沒有字元限制，所以只要求它能當成單一路徑片段，不要求特定字元集。
- `validAttempt(v, fileBase)`（`fileBase` 是去掉 `.json` 的檔名）→ 不合格時回傳 `bad_record`：
  - `v` 是物件；`id`、`claim_id`、`agent`、`status` 都是字串；`n` 是正整數；
  - `isSegment(claim_id)`；`id === fileBase`；`id` 等於 `<claim_id>-a<n>`；
  - `error`、`started_at`、`finished_at` 若存在必須是字串，否則當作沒有。
  - 用來組路徑的只有 `id`，而 `id` 必須等於磁碟上的檔名，所以 JSON 內容無法把讀取導到別的路徑。
- `validClaim(v, claimId)` → 不合格時回傳 `bad_record`：`v` 是物件、`v.id === claimId`、`agent` 與 `status` 是字串、`message_ids` 是字串陣列。claim 檔的路徑只用通過 `isSegment` 的 claim id 組成。
- 略過的 `path` 一律寫成相對於 run 目錄的路徑（例如 `mail/claims/<id>.json`），不寫內容。

不在本 spec 範圍（明文殘留）：
- 既有的 `recoverRunMail`（`src/message-store.ts:255-270`）在 resume 的一開始（`src/run-session.ts:843`）用 `listAttempts` 與 `readFileSync` 讀**所有** attempt 與 claim JSON；`finishAttempt`、`commitClaim`、`abandonClaim`、`markOutputReady` 用 `loadClaim`／`loadAttempt`。這些仍會跟隨 symlink、遇 FIFO 卡住。因此：**本 spec 只保證新增的選取路徑不跟隨、不阻塞**；`mail/attempts` 或 `mail/claims` 裡放了 FIFO 時，resume 會先在 `recoverRunMail` 卡住，到不了選取路徑。
- `beginAttempt` 在 C-15 改寫後不再呼叫 `listAttempts`（編號只看名稱，22.9），但仍用 `loadClaim` 讀**這次 wake 剛寫的** claim（`src/message-store.ts:216`）。
- 把既有 reader 全面換成安全版本，牽涉 claim 生命週期的錯誤處理（讀不到時是否該讓 wake 失敗、`recover` 是否該略過），屬於另一個任務；22.18 列為重啟條件。這些檔只有 dispatcher 寫（policy 禁止 agent 寫 `mail/`，強度見 22.5.9），所以風險等級與現況相同，本 spec 不使它變差。

### 22.5.3 草稿讀取契約（沿用 R2 §4，不重新發明）

R2 §4 的「F 安全讀取契約」與「排序與去重」原樣適用，重點如下：
- **以目錄為準**：檔名只取自 `readdir(attempts/<id>/outbox)`，不取自 attempt 記錄的 `parked`。原因是 park 的 rename 與 `finishAttempt` 不在同一個交易裡（`src/message-store.ts:230-241`、`src/run-session.ts:493-494,498-499`）；park 之後、`finishAttempt` 之前崩潰，`recover` 會記成 `parked: []`，但檔案其實在目錄裡（`src/message-store.ts:257-261`）。兩邊不一致時記入 `reconciled`。
- `attempts/<id>`、`attempts/<id>/outbox` 逐層 `lstat`，必須是真目錄。每個 outbox 最多掃描 64 個 entry。略過以 `.` 開頭的名稱、不是 regular file 的項目（依 `lstat`），以及含 NUL byte 的內容。
- 每個檔案用 `O_RDONLY|O_NOFOLLOW|O_NONBLOCK` 開檔，`fstat` 必須是 regular file，最多讀「剩餘預算＋1」byte。現有 helper 都不合用：`readRegularFileNoFollow` 會整檔讀入（`src/fs-util.ts:61-76`），`readFileCapped` 會跟隨 symlink（`src/fs-util.ts:34`）。所以要在 `src/fs-util.ts` 新增 `readRegularFileCappedNoFollow(file, limit): { buf: Buffer; size: number; truncated: boolean } | undefined`，並新增純函式 `cutUtf8(buf, limit): Buffer`，往回退到不是 continuation byte（`0b10xxxxxx`）的位置才切。C-08 也共用 `cutUtf8`。
- 排序：attempt 由新到舊（22.5.2 的順序），同一個 attempt 內依檔名。去重只針對在上限內完整讀完的檔案：sha256 相同只留最新的一份；被截斷的檔案不去重，也不為算 hash 多讀任何 byte。
- 4 KB（4096 B）是整段的上限，標題、每個檔案的路徑行、圍欄、截斷標記，以及「另有 N 個檔案未顯示」那一行全部計入；最後那一行的空間先預留。
- 區塊格式：

  ````
  # Drafts from your failed attempt (unverified, not delivered)
  These files were in your outbox when an earlier attempt at this message failed. They were set aside and never delivered; they may be incomplete or wrong. Check them against the repository before reusing any of them.

  ## mail/attempts/<attempt id>/outbox/<name> (attempt <n>, <error>)
  ```
  <內容>
  ```
  [truncated: mail/attempts/<attempt id>/outbox/<name>, <fstat size> B]
  (<N> more draft file(s) not shown: mail/attempts/<attempt id>/outbox/)
  ````

  圍欄用 N 個反引號，N = max(3, 內容中最長連續反引號數＋1)，避免內容裡的圍欄把區塊提早關掉。路徑一律相對於 run 目錄。
- 略過的原因代碼（`priorFailedAttempts` 與 `collectDrafts` 共用，寫進各自的 `skipped`，由呼叫端統一記 `draft_skip`）：
  - 草稿：`ancestor_symlink`、`not_dir`、`symlink`、`not_regular`、`bad_name`、`binary`、`over_file_cap`、`over_entry_cap`、`open_error:<code>`。
  - metadata（22.5.2a）：`ancestor_symlink`、`not_dir`、`metadata_missing`、`symlink`、`not_regular`、`metadata_too_large`、`metadata_unreadable`、`bad_record`、`open_error:<code>`。
  - 只有呼叫端用：`error:<message>`（`redoContext` 攔到例外時）。
- 殘餘風險：從 `lstat` 祖先目錄到開檔之間有 race（Node 沒有 `openat`）。最壞的結果是讀到一個 agent 本來就讀得到的檔案，而且長度仍受上限，所以接受。

### 22.5.4 prompt 文字（C-01、C-04）

以下的 `{G}` 只在 `agent.memory.task` 有值時出現，內容是：`` Read your task memory (`<task dir>`) first: progress you recorded there survives a failed attempt. ``

- **`attempt > 0`（同一個 wake 內的重試）**：沿用 `retryPrompt`，簽名改成 `retryPrompt(prompt, error, o: { drafts: boolean; taskMemory?: string })`。
  - 沒有草稿：`…after possibly changing files already. Its mail was discarded. Check the current state of the repository before redoing the work, and send the mail again.{G}`
  - 有草稿（C-04）：把 `Its mail was discarded.` 換成 `Its mail was set aside, not delivered: see the drafts below.`，其餘照舊，最後是 `{G}`，草稿區塊接在後面。
- **`attempt === 0` 而且有候選（resume 重做等）**：新增一段

  ```
  # Redo notice
  An earlier attempt at this message did not finish (<最新候選的 error>; attempt <id>). It may have changed files already, and its mail was set aside, not delivered. Check the current state of the repository before redoing the work, and send the mail again.{G}
  ```
  有草稿時，在 `not delivered` 之後加 `: see the drafts below`。
- **`attempt === 0` 而且沒有候選**：`base.userPrompt` 原樣使用，逐字不變。
- 順序固定：`base` → 提示（Retry 或 Redo）→ 草稿區塊。提示與草稿都在 message 段之後，不影響 COMMON／records／memory 的位置。
- 大小：G 約 100 B；Redo notice 約 300 B；草稿 ≤4096 B。只有重試或重做的 invoke 才會增加。

### 22.5.5 呼叫點（`src/run-session.ts` 的 `wake`）

在 `invoke` 回呼內，`beginAttempt`（`:426`）之後、`invoke({...})`（`:435`）之前：

```ts
const ids = unread.map((m) => m.meta.id);
const redo = this.redoContext(agent.name, ids, att.id);   // 回傳 { prior, drafts }；包 try/catch，出錯時回傳空結果並記 draft_skip(error:<msg>)
const userPrompt = redoUserPrompt(base.userPrompt, { attempt, error: ctx.previous?.error, prior: redo.prior, drafts: redo.drafts.text, taskMemory: agent.memory.task });
```

- `:440` 改成 `userPrompt`。`base.userPrompt`（`:379`）仍只算一次：COMMON、records、memory 索引在同一個 wake 內不重讀，和現在相同。
- `redoContext` 是 `RunSession` 的私有方法：呼叫 `priorFailedAttempts` 與 `collectDrafts`，把兩者的 `skipped` 合併，每一筆記一個 `draft_skip`（帶 `path`、`reason`），再記 22.5.7 的其他事件。`redo.ts` 本身不記 log。`prior` 為空但 `skipped` 不為空時，只記 `draft_skip`，prompt 照沒有候選的方式（逐字不變）。
- `wake` 事件（`:470-481`）在 `prior` 非空時多一個選用欄位 `redo_of: string[]`（候選 attempt id）。
- `call` 不受影響：它沒有 run 目錄，也沒有 claim（`src/call.ts` 走 `runWithFallback`，不經過 `RunSession.wake`）。
- `src/message-store.ts` 的 `parkOutbox` 在每次 rename 之後加 `fault("park:moved")`；`run-session.ts` 在 `parkOutbox` 與 `finishAttempt` 之間加 `fault("park:before-finish")`。只是測試接縫，`faultHook` 未設定時不做事（`src/message-store.ts:7-13`）。

### 22.5.6 C-03：為什麼一律注入

- 可能的「略過」規則都需要知道「下一次 invoke 會不會接上**包含失敗那次 turns** 的同一個 session」。現有資料回答不了：
  - attempt 記錄沒有 runtime、candidate 或 session 欄位（`src/message-store.ts:174-186`），加上去就是改 attempt 格式。
  - 逾時、取消不帶 session id（`src/process-runner.ts:216-217`），所以之後的重試接的是較早記錄的 id（`src/run-session.ts:429`）。那個 session 裡有沒有失敗那次的 turns，取決於 runtime，未知。
  - 切換候選模型時 session key 會變（`:423`）；`resume: false` 的成員（成員的預設，`src/config.ts:236`）每次都是新 session。
- 代價比較：重複注入最多 4 KB，而且只發生在重試或重做時；錯誤略過則會丟掉 agent 唯一的失敗產出。所以接受重複。
- 文字上，草稿標題寫明「unverified, not delivered」。就算 session 裡已有同樣內容，agent 也知道那是沒寄出的版本。
- 實作上的約束：選取與注入**不得**讀 `sessionId`、`state.sessions` 或 `result.sessionId`；`redoContext` 的參數只有 agent 名稱、message id 與這次的 attempt id。T17 鎖住這一點（誤加 `sessionId === undefined` 或「失敗回傳 id 就略過」的閘門會讓 T17 變紅）。

### 22.5.7 可觀測性（`log.jsonl` 新事件）

| 事件 | 何時 | 欄位 |
|---|---|---|
| `redo` | 有候選時，每次 invoke 一筆 | `agent`、`attempt`（這次的 id）、`prior`（候選 id 陣列）、`notice`（`"retry"` 或 `"redo"`） |
| `draft_inject` | 至少注入一個檔時 | `agent`、`attempt`、`files: [{path, bytes, truncated}]` |
| `draft_skip` | 每個被略過的草稿檔、attempt 或 claim 記錄、祖先目錄（`PriorResult.skipped` 與 `DraftsResult.skipped` 合併） | `agent`、`attempt`、`path`（相對於 run 目錄）、`reason` |
| `draft_none` | 有候選但沒有注入任何檔 | `agent`、`attempt`、`prior` |
| `draft_reconcile` | 目錄與記錄的 `parked` 不一致 | `agent`、`attempt`（候選的 id）、`only_on_disk`、`only_in_record` |

`status`、`state.json` 不變。理由：重做是 log 層級的診斷資訊；`state.notes` 已經在 park 時記下路徑（`src/run-session.ts:501-504,845-848`）。

### 22.5.8 邊界情況

| 情況 | 行為 |
|---|---|
| 第一次喚醒，沒有任何 attempt | 沒有候選，prompt 逐字不變 |
| 同一個 wake：a1 寫了 outbox 後逾時 | a2 的 prompt 是 Retry notice（有草稿的版本）＋a1 的草稿 |
| graceful Ctrl-C 後 resume | 舊 claim `abandoned`（`:515`），attempt `failed/cancelled`（`:494`）；新 claim 的 message id 相同 → Redo notice＋草稿 |
| 硬殺後 resume | `recover` 把 `started` 改成 `failed/interrupted` 並補 park（`src/message-store.ts:257-261`）→ Redo notice＋草稿 |
| park 到一半就崩潰 | 以目錄為準：兩處的檔都會讀到（剩下的在 recover 時才被 park），並記 `draft_reconcile` |
| attempt JSON 損毀 | 從目錄名推回 claim，claim 檔的 agent 相符才採用；error 顯示 `unknown (attempt record unreadable)` |
| attempt／claim JSON 是 symlink、FIFO、超過 64 KiB，或 `id`／`claim_id` 不合格 | 選取路徑略過那筆並記 `draft_skip`（`symlink`／`not_regular`／`metadata_too_large`／`bad_record`），不讀 symlink 目標、不阻塞；其他有效候選照常（22.5.2a）。注意：resume 時 `recoverRunMail` 會先用舊 reader 讀這些檔，FIFO 會讓 resume 在那裡卡住（明文殘留，22.5.2a 末段） |
| `mail/claims` 或 `mail/attempts` 是 symlink | 沒有候選，記 `draft_skip`（`ancestor_symlink`），prompt 逐字不變 |
| 某個 claim 壞掉、另一個 claim 有效 | 只排除壞 claim 的 attempt，有效 claim 的候選照常注入 |
| 候選有好幾個 | 提示只寫最新那個的 error 與 id；草稿依新到舊取，最多 5 檔、4 KB |
| agent 失敗時沒寫 outbox | Redo／Retry notice 照樣出現（G 仍有用），記 `draft_none` |
| 平行喚醒的別的成員 | claim 的 agent 不同 → 不選 |
| 到達回合上限而 abandon 的 claim | 沒有 failed attempt → 不觸發 |
| follow-up 重開 | 新 task 的 message id 是新的 → 不觸發 |
| 舊版留下的 run（沒有 `mail/attempts`） | 回傳 `[]`，行為和現在相同 |
| 舊 binary 讀新 run | 沒有新檔、沒有新欄位；新增的 log 事件會被忽略 |
| 讀取丟出例外 | 當作沒有候選，記 `draft_skip`（`reason: "error:<message>"`），wake 照常進行 |

### 22.5.9 與其他模組的相互作用

- **`message-store.ts`**：選取路徑不呼叫它的 reader（`listAttempts`、`loadClaim`），改用 `redo.ts` 的 `readMetadataJson` 直接讀 claim／attempt 檔與 attempt 目錄（22.5.2a），只沿用它的型別與路徑常數；新增兩個 fault 點；C-15 改 `beginAttempt`。不新增欄位。
- **`run-session.ts`**：`invoke` 回呼改 user prompt；新增 `redoContext`、log 事件、`wake` 事件的 `redo_of`。`retryPrompt` 改簽名，原本的呼叫點只有 `:440`。
- **`prompt.ts`**：不改；`buildUserPrompt` 的輸出就是 `base.userPrompt`。C-08 在 `prompt.ts` 裡另做。
- **`mailbox.ts`**：草稿不經過 route：不投遞、不寫 journal、不觸發重複檢查。重複檢查只看收件者的 inbox 與 `read/`（`src/mailbox.ts:230-247`），所以 agent 照草稿重寄一封，不會因為草稿而被判成重複。
- **`guard.ts`**：不受影響；草稿在 run 目錄的 `mail/attempts` 底下，不是受保護檔，guard 也不檢查它（`src/guard.ts:47-55`）。
- **寫入來源（N2）**：policy 禁止 agent 寫 `mail/attempts` 與 `mail/claims`（`src/policy.ts:84,107` 的 `MAIL_ENTRIES` deny），但實際強度依 runtime 與平台而定（`src/policy.ts:186-203`）：有 OS 沙箱時由 OS 擋；Claude 沒有 OS 沙箱時只有 Edit 規則（`src/adapters/claude.ts:11-20,29`），Bash 可以繞過；Codex 沒有 OS 沙箱時只是 prompt 要求。所以**不保證**草稿與 metadata 只來自 dispatcher 的 park；本 spec 因此把它們一律當成不可信的輸入處理（有界、no-follow、驗證 id，22.5.2a、22.5.3），並且只交還給 claim 所屬的 agent 本人。
- **prompt 只是要求**：Redo／Retry notice 的「先讀 task memory」（G）與草稿區塊的「先對照 repo 檢查再使用」都只是 prompt 文字，沒有任何機制強制 agent 照做（22.15）。

## 22.6 C-07：備援切換 note 的文字

- 新增 `sessionKeyOf(agent: ResolvedAgent, c: Candidate): string`（放在 `run-session.ts` 或 `fallback.ts`）：`c.primary ? agent.name : `${agent.name}@${c.key}``。取代 `:423` 的行內寫法。
- `onSwitch`（`:407-416`）：`const resumes = agent.resume && !!state.sessions[sessionKeyOf(agent, to)];` note 文字中的 `the backup starts a fresh session and redoes this wake-up` 依 `resumes` 改成 `the backup resumes its own earlier session and redoes this wake-up` 或維持原文。其餘文字（含副作用警語）不變。
- 判斷時機：`onSwitch` 在備援的 invoke 之前執行，讀的是同一份 `state.sessions`，和 `:429` 實際送出的 `sessionId` 一致。
- 失敗行為：純讀取，不會丟例外。
- 相容：`state.notes` 仍是字串陣列；`status --json` 的欄位與結構不變，只有那一筆 note 的值可能不同。
- 文件：`docs/how-it-works*.md` 的 Fresh session 一條要改（22.12）。

## 22.7 C-08：mail 內文在 prompt 端的上限

- `src/prompt.ts` 新增常數 `MAIL_BODY_LIMIT = 16 * 1024`（每封）與 `MAIL_BATCH_LIMIT = 64 * 1024`（一次 wake 的「要處理的信」合計）。
- `buildUserPrompt`（`:295-306`）：依現有順序，對每封 `current` 訊息算 `limit = min(MAIL_BODY_LIMIT, remaining)`。
  - 內文 byte 數 ≤ `limit`：原文照放。
  - 否則用 `cutUtf8` 切到 `limit` byte，接著加一行：`` [agent-lyceum: this message was cut at <shown> of <total> bytes; read the whole message in `<m.file>` (it moves to `read/` in the same folder after this wake-up)] ``。
  - `remaining -= shown`；標記本身不計入。`remaining` 為 0 時，只放 header 與標記。
- 不變的部分：
  - frontmatter 行（id、from、type…）不截。
  - 排隊中的信本來就只列標題（`:307-310`）。
  - `status` 的摘要仍用全文（`src/run-session.ts:430-432`）。
  - mail 檔、route、hash 都不變。
- 為什麼是 16 KiB：等於 inline task 的上限（`src/task.ts:6`），所以 inline 的使用者任務一定完整。task 不能批次處理（`src/prompt.ts:22`），所以一定是獨自一封、拿得到整批預算。語料中最大的一封是 15,357 B，現有的信都不會被截。
- 為什麼整批 64 KiB：lead 一次最多 5 封（`src/prompt.ts:21`）；語料 p95 約 10.8 KB，5 封典型回覆約 54 KB，不會被截；只有極端情況才截後面的信。
- 收件者讀得到原檔：Claude 的 `Read` 是全域允許的（`src/adapters/claude.ts:29`），Codex 的 sandbox 只限制寫入。inbox 檔在 `commitClaim` 之前一直留在原處（`src/message-store.ts:160-168`）。
- 失敗行為：純字串運算，不會丟例外。
- 資源保護（route／hash／`listUnread` 讀全文）不在範圍內，另案。

## 22.8 C-13：刪除 `paths.common`

- 刪 `ProjectPaths.common`（`src/paths.ts:49`）、`projectPaths` 的那一行（`:65`）、`callProject` 的那一行（`src/call.ts:75`）。
- 確認沒有人用：`rg 'paths\.common' src test plugins scripts` 沒有輸出；`rg -n '\bcommon:' src test plugins scripts` 只命中 `src/paths.ts:49,65` 與 `src/call.ts:75`。COMMON 的實際路徑一律走 `commonFile()`（`src/policy.ts:32-34`）。
- 相容：`ProjectPaths` 只存在記憶體，不寫入磁碟；package 只有 `bin`，沒有 library 匯出（`package.json`）。

## 22.9 C-15：attempt 編號

- `beginAttempt`（`src/message-store.ts:215-221`）：`n = max(已使用的編號, 0) + 1`，已使用的編號從 `readdir(mail/attempts)` 收集（`mail/attempts` 不存在時為空）：
  - **只看名稱、不看內容**：名稱完全符合 `^<escaped claimId>-a(\d+)(\.json)?$` 的任何 entry（檔案、目錄、symlink、FIFO、損毀或 `claim_id` 不同的 JSON，一律）都佔用它的編號。原因：新 attempt 的路徑只由名稱決定（`src/message-store.ts:188,192-194`），而 `atomicWrite` 的 rename 會覆蓋同名檔（`src/fs-util.ts:7-9`）；只要名稱被佔用，就不能把它當空的（R2）。
  - 「限定在同一個 claim」（CA-15）由名稱前綴完成：別的 claim 的 id 不同，名稱就不會符合；`\d+` 之後只允許 `.json` 或結尾，所以 `<claimId>-a1x` 這類名稱不算。
  - `claimId` 要先做 regex escape；`\d+` 轉成數字時用 `Number`，不是安全整數的編號略過（不會在正常資料中出現）。
  - 不開任何 JSON 檔，所以 `beginAttempt` 不再呼叫 `listAttempts`（R1 的附帶效果，22.5.2a）。
- 寫入前的保險：`saveAttempt` 照舊用 `atomicWrite`。在同一個 claim 上，`beginAttempt` 只由持有該 claim 的那一個 wake 依序呼叫（`src/run-session.ts:426`），沒有並行配號，所以不需要 `O_EXCL`；不改 `atomicWrite`。
- 編號耗盡：已用最大編號達 `Number.MAX_SAFE_INTEGER`（+1 不再是安全整數）時，`beginAttempt` 丟出編號耗盡錯誤、寫入前終止，不覆蓋任何 entry。
- id 格式（`<claim id>-a<n>`）與記錄欄位都不變；只是 n 可能跳號。程式裡沒有地方假設 n 連續（`att.n` 只用在 note 文字：`src/run-session.ts:502,846`）。
- 舊 binary 遇到跳號的 run：它算的是「有效記錄數＋1」。在跳號存在的情況下仍可能撞號，這是舊版既有的缺陷，新版不會更糟。
- `listAttempts` 不變。

## 22.10 檔案與函式

| 檔案 | 變更 |
|---|---|
| `src/redo.ts`（新） | `priorFailedAttempts`（回傳 `PriorResult`）、`collectDrafts`、`redoUserPrompt`、型別；模組內的 `readMetadataJson`、`isSegment`、`validAttempt`、`validClaim`（22.5.2a） |
| `src/fs-util.ts` | `readRegularFileCappedNoFollow`、`cutUtf8` |
| `src/run-session.ts` | `retryPrompt` 簽名與文字（C-04、G）；`invoke` 回呼改用 `redoUserPrompt`；`redoContext`；log 事件；`sessionKeyOf` 與 `onSwitch` note（C-07）；fault 點 |
| `src/message-store.ts` | `beginAttempt` 編號（C-15）；`parkOutbox` 的 fault 點 |
| `src/prompt.ts` | `MAIL_BODY_LIMIT`、`MAIL_BATCH_LIMIT`、`buildUserPrompt` 截斷（C-08） |
| `src/paths.ts`、`src/call.ts` | 刪 `common`（C-13） |

不新增依賴。

## 22.11 測試（先紅後綠；全部用 fake invoker 或 `test/fixtures/runtime` 的 fake runtime，加上暫時的 `AGENT_LYCEUM_HOME`，不呼叫真實的 `claude`／`codex`）

| # | 行為 | 測試檔 | 在舊程式下為何是紅的 |
|---|---|---|---|
| T1 | 硬殺（attempt 停在 `started`、outbox 留一個檔）→ resume → 重做的 prompt 含 `# Redo notice`、`interrupted`、草稿區塊與檔案內容 | `test/attempt.test.ts`（延伸 `:124` 那條） | 舊 prompt 沒有 Redo notice |
| T2 | graceful 取消（`signal` abort，fake 先寫 outbox）→ resume → Redo notice 含 `cancelled`＋草稿 | `test/attempt.test.ts` | 同上 |
| T3 | 同一個 wake：a1 寫 outbox 後失敗 → a2 的 prompt 含 `set aside, not delivered: see the drafts below` 與草稿，不含 `discarded` | `test/attempt.test.ts` | 舊版 prompt 只在 wake 開頭算一次 |
| T4 | 同一個 wake 重試、沒有草稿、agent 有 task memory → Retry notice 等於舊文字＋G 一句（逐字比對） | `test/attempt.test.ts` | 沒有 G |
| T5 | 第一次喚醒沒有候選 → `userPrompt === buildUserPrompt(...)`（逐字） | `test/attempt.test.ts` | 在舊版就是綠的（守住不變性） |
| T6 | 選取：別的 agent 的 failed attempt、message id 沒有交集的、claim 為 `committed` 的、`exclude` 自己 → 都不在 `prior`（也不在 `skipped`：它們是正常的不符合，不是壞記錄）；新到舊排序 | `test/redo.test.ts`（新） | 函式不存在 |
| T7 | 以目錄為準：(a) park 第一個檔之後崩潰；(b) park 完所有檔、`finishAttempt` 之前崩潰（`parked: []`）；(c) attempt JSON 損毀 → resume 後都帶回全部草稿，並記 `draft_reconcile`（a、b）或使用目錄推回（c） | `test/redo.test.ts`＋`setFaultHook` | 函式不存在；舊版不帶草稿 |
| T8 | 草稿讀取安全：leaf symlink、`attempts/<id>` 或 `outbox` 是 symlink、草稿 FIFO（放在子程序裡跑，外層 10 s 硬期限）、64 MB sparse file（斷言實際讀取量 ≤ 剩餘預算＋1）、含 NUL 的檔、超過 64 個 entry | `test/redo.test.ts` | 同上 |
| T8m | metadata 讀取安全（R1）。**對象是 helper**：直接呼叫 `priorFailedAttempts`，不跑完整 resume（完整 resume 會先在 `recoverRunMail` 用舊 reader，22.5.2a）。每一案另放一個有效的候選，斷言它仍在 `prior` 裡：(a) attempt JSON 是指向 run 外、內容為有效 failed 記錄的 symlink → 不出現在 `prior`、`skipped` 有 `symlink`；(b) claim JSON 是指向外部有效 claim 的 symlink → 該候選不出現、`symlink`；(c) `mail/claims` 是指向外部目錄的 symlink → `prior` 為空、`ancestor_symlink`；`mail/attempts` 同理；(d) attempt JSON 是 FIFO、(e) claim JSON 是 FIFO → 都在子程序裡跑，外層用 `spawnSync` 的 `timeout: 10_000`＋`killSignal: SIGKILL`，斷言子程序正常結束（沒有 `ETIMEDOUT`）且輸出 `not_regular`；(f) 70 KiB 的 attempt JSON（合法 JSON）與 64 MB sparse claim JSON → `metadata_too_large`，sparse 檔斷言讀取量 ≤ 64 KiB＋1（用 spy 或 `fs.readSync` 計數）；(g) `id` 與檔名不符、`claim_id` 含 `/` 或為 `..`、claim 檔的 `id` 與請求不符 → `bad_record`，且沒有開啟 run 目錄以外的路徑 | `test/redo.test.ts` | 函式不存在 |
| T9 | 預算：超過 4096 B 或 5 個檔 → 截斷標記與「not shown」那一行，總長 ≤4096 B；UTF-8 多位元組字元不會被切壞（`cutUtf8` 單元測試）；內容含 ```` ``` ```` 時圍欄夠長 | `test/redo.test.ts`、`test/fs-util.test.ts` | 同上 |
| T10 | 去重：兩個 attempt 的小檔內容相同 → 只出現一次（新的）；兩個前綴相同、尾端不同的大檔 → 各自截斷出現 | `test/redo.test.ts` | 同上 |
| T11 | 草稿永不投遞（N3）：a1 的草稿用唯一的 subject（例如 `draft-marker-<random>`）與內文標記；a2 寄出另一個 subject。run 結束後：(1) 收件者的 inbox **與** `read/`（`test/attempt.test.ts:22` 的 `allMail`）都沒有草稿的 subject，也沒有任何檔含內文標記；(2) `mail/journal.jsonl` 不存內文（`src/message-store.ts:19-26`），`source` 是寄件檔的內容 hash（`sourceIdOf`，`:88-94`）而不是路徑，所以比對 entry：這個 run 新增的 entry 數等於 a2 那封的收件者數、全部共用同一個 `source`，每筆的 `to` 是預期的收件者，`msg_id` 對應到收件者 inbox／`read/` 裡 subject 為 a2 的那封信；沒有任何 entry 的 `msg_id` 對應到草稿 subject；(3) `mail/attempts/<a1>/outbox/` 裡的草稿原檔仍在、內容不變 | `test/attempt.test.ts` | 在舊版就是綠的（守住不變性） |
| T12 | 讀取出錯時 wake 照常（N1）：兩個 claim 都有同 agent、同 message id 的 failed attempt，其中一個 claim 檔是損毀的 JSON → wake 成功；log 有一筆 `draft_skip`，`path` 是那個 claim 檔、`reason` 是 `metadata_unreadable`；另一個 claim 的 attempt 仍出現在 `redo` 事件的 `prior` 與 prompt 的草稿裡 | `test/attempt.test.ts` | 函式不存在 |
| T13 | C-07：主要模型 429，備援在 `state.sessions` 裡已有自己的 session 且 `resume: true` → note 含 `resumes its own earlier session`；沒有 session 時 → 含 `starts a fresh session` | `test/fallback-lifecycle.test.ts` | 舊版一律是 fresh |
| T14 | C-08：一封 20,000 B、最後一行是唯一標記的信 → prompt 不含那個標記，含 `cut at 16384 of 20000 bytes` 與 inbox 路徑；三位元組的中文字跨在邊界上 → 沒有 U+FFFD；lead 一批 5 封、每封 15 KiB → 第 5 封被截；15 KiB 的單封 → 原文完整 | `test/dispatcher.test.ts` 或新的 `test/prompt-mail-limit.test.ts` | 舊版放原文 |
| T15 | C-15（R2）。每一案在呼叫前記下所有既有 entry 的 sha256／目錄列表，呼叫後斷言它們全部不變，而且回傳的 id 在呼叫前不存在：(a) `a1.json`（壞的）、`a1/outbox/x.md`、`a2.json`（好的）→ `a3`；(b) `a1.json` 壞的、`a2.json` 可解析但 `claim_id: "other"` → `a3`（審查者的反例；字面版 22.9 會算出 `a2` 並覆蓋）；(c) 只有 `a1/outbox/x.md` 與 `a4/` 兩個目錄（沒有任何 JSON）→ `a5`，`a1/` 的內容不變；(d) `a1.json`、`a2.json` 好的、最高的 `a3.json` 損毀 → `a4`；(e) 另一個 claim 的 `-a9.json`、以及 `<claimId>-a1x` 這種名稱 → 不影響編號 | `test/message-store.test.ts` | 舊版在 (a)(b)(d) 覆蓋既有的 JSON，在 (c) 回傳 `a1`、重用既有的 attempt 目錄 |
| T16 | C-13：只靠型別檢查（`npm run typecheck`）＋上面的 `rg` | — | — |
| T17 | C-03「有 session 仍注入」（R3），用 fake invoker 記錄每次收到的 `WakeInput`。每一案都斷言：第二次 invoke 實際收到的 `sessionId`、`userPrompt` 含 Retry 或 Redo notice 與 a1 的草稿內容、草稿沒有被投遞（同 T11 的 (1)）。(a) 成員 `resume: true`、`state.sessions[<agent>]` 預先種入 `S0`；第一次 invoke 寫 outbox 後回傳 `{ok:false, timedOut:true}`（不帶 id，對應 `src/process-runner.ts:216-217`）→ 第二次收到 `sessionId === "S0"`，prompt 仍含草稿；(b) 成員 `resume: false`（成員預設，`src/config.ts:236`）；第一次失敗並回傳 `sessionId: "S1"` → 第二次收到 `sessionId === undefined`，prompt 仍含草稿；(c) 成員 `resume: true`、有 fallback 鏈（主要 A、備援 B），`state.sessions[<agent>@<B 的 key>]` 預先種入 `SB`；A 寫 outbox 後失敗並回傳 `sessionId: "SA"`、`kind` 是會觸發切換的種類 → B 那次收到 `sessionId === "SB"`（依 B 的 key，`src/run-session.ts:423,429`），prompt 含 A 的草稿；另一個變體不種 `SB` → 收到 `undefined`，prompt 仍含 A 的草稿。(c) 另外斷言第二次 invoke 的 runtime／model 確實是 B（沿用 `test/fallback-lifecycle.test.ts` 既有的切換寫法），避免沒有切換也綠 | `test/attempt.test.ts`、`test/fallback-lifecycle.test.ts`（c） | 舊版沒有草稿。實作若誤加 `sessionId === undefined` 閘門，(a) 與 (c) 種 `SB` 的變體變紅；若誤加「失敗回傳 id 就略過」，(b) 與 (c) 變紅 |

既有測試：`test/fallback-lifecycle.test.ts:82` 的 regex 只比對 Retry notice 的開頭，加上 G 之後仍然通過；有完整比對 retry 文字的測試要更新成新文字。沒有測試釘住 `fresh session`（`rg 'fresh session' test` 沒有輸出）。

在 agent 沙箱內跑 `npm test` 時，依 lesson `sandbox-pipe-stub-for-cli-tests` 用 `NODE_OPTIONS="--import <stub>"`。

## 22.12 相容性

- `state.json`、mail frontmatter、claim、attempt、config 的格式全部不變。
- `log.jsonl`：新增 5 種事件（22.5.7），`wake` 事件多一個選用欄位 `redo_of`。舊的讀者（`status` 不讀 log）會忽略它們。
- 舊 run 用新 binary 續跑：舊的 claim／attempt 欄位齊全（attempt 從一開始就有 `agent`、`claim_id`、`status`），可以直接當候選，所以舊 run 被中斷的工作在 resume 時也會拿到 Redo notice 與草稿。這是預期的行為。
- 新 run 用舊 binary 續跑：沒有新檔案或新欄位；舊版不注入草稿，C-15 的跳號見 22.9。
- `status --json`：欄位不變；C-07 只改一筆 note 的值；C-08 不影響摘要。
- prompt 快照：只有重試或重做的 invoke、以及超過上限的信，prompt 才會不同。

## 22.13 Dimension coverage

1. **相容與格式**：見 22.12。沒有改任何格式；新增的 log 事件屬於「只增不改」。
2. **檔案與行程安全**：草稿只交還給 claim 所屬的 agent 本人，不投遞。草稿與 claim／attempt metadata 的讀取都採 no-follow、non-block、有上限（草稿 4 KB、metadata 每檔 64 KiB），祖先目錄（`runDir`、`mail`、`mail/attempts`、`mail/claims`、`attempts/<id>`、`outbox`）逐層 `lstat`，從 JSON 取得的 id 驗證成單一路徑片段且必須等於檔名（22.5.2a，lesson `guard-never-follow-symlinks`）。policy 禁止 agent 寫 `mail/attempts`、`mail/claims`（`src/policy.ts:84,107`），但實際強度依 runtime／平台（OS 沙箱、Claude 的 Edit 規則或只有 prompt，`src/policy.ts:186-203`），所以不當成保證，內容一律當不可信輸入（22.5.9）。殘留：既有的 `recoverRunMail`、`beginAttempt` 的 `loadClaim` 等仍用舊 reader，不在本 spec 範圍（22.5.2a 末段）。寫入範圍與 policy 都不變。C-14 這個擴權問題延後，但不會因本 spec 變大。
3. **並發與復原**：選取以「agent＋message id＋claim 狀態」為準，平行的成員不會互相混到。park 與 `finishAttempt` 之間崩潰的情況，以目錄為準處理。C-15 只依名稱配號，任何被佔用的名稱（含壞 JSON、只有目錄）都不會被重用或覆蓋；編號耗盡時報錯而非覆蓋（T15）。graceful 取消、逾時、硬殺三條路徑各有測試（T1–T3）；C-03 的「有 session 仍注入」由 T17 鎖住。metadata 是 FIFO 時 resume 會在 `recoverRunMail` 卡住，這是既有行為，本 spec 不宣稱修好。
4. **平台與可維運**：macOS 與 Linux 都有 `O_NOFOLLOW`、`O_NONBLOCK`；Windows 上 `?? 0` 退化，只是警告層級。Claude 與 Codex 的差別只在 prompt 透過 stdin 送入，不依賴 session 能力。不新增依賴。wake 迴圈每次 invoke 多一次 readdir 加幾十個小 JSON（22.5.2）。
5. **可測試與可維護**：`redo.ts` 分成純函式與有界讀取；呼叫點只在 `invoke` 回呼一處。全部可以用 fake invoker 與 `setFaultHook` 測，不依賴真實的 `~/agent-lyceum-config`、`claude` 或 `codex`。
6. **可觀測與可診斷**：`redo`、`draft_*` 事件說明為什麼有或沒有草稿；`state.notes` 原有的 park 記錄不變；C-07 讓 note 說的是實話。
7. **證據強度**（本題另加）：F 的直接觀察只有 c1 一件（R2 §3），本 spec 不保證減少 review 輪次。效果指標沿用 R2 §4 的表，task memory 使用率依 CA-05 的口徑量測（被喚醒 ≥2 次的成員有沒有 task memory，另外量這次 wake 有沒有更新）。

## 22.14 不採用的方案

- **C-03「失敗那次自己回傳 session id 就略過注入」**：會錯關 resume:false 的成員與切換候選模型的情況；而且要記錄 runtime／session 就得改 attempt 格式（CA-03）。
- **`sessionId === undefined` 才注入**：逾時、取消不帶 id，規則會在最需要草稿時關掉 F（22.4 #7）。
- **只注入到全新 session**：同上；而且「全新」無法由現有資料可靠判斷。
- **在 `beginAttempt` 之前選取**：不必要（22.4 #12），而且拿不到這次的 attempt id 來明確排除。
- **G 放進系統提示的 Memory／Rules 段**：可能被 C-16 的 snapshot 擋住，效果也要真實 run 量測，所以和 C-05 一起延後。
- **C-08 在 `routeOutboxes` 退回超長的信**：多花一次 wake，也管不到 dispatcher 自己寫的信；但它有自己的用途（資源保護），所以不是被推翻，只是這次不選（CA-21）。
- **C-06「另一個活躍 run 的 lead 寫的變更不還原」**：分不出是 lead 寫的，還是同時段沒有沙箱的 member 寫的，會放過越權寫入（CA-06）。延後時要從「寫入協定（例如 lead 寫入前登記意圖）或跨 run 協調」重新設計，QA 必測「B 在活動時，A 的 member 越權仍會被抓到」。
- **C-11 以 `rejected/` 資料夾或 `log.jsonl` 當來源**：會誤報，log 也會輪替（CA-11）。
- **C-13 保留欄位但修正路徑**：沒有讀者，修了也沒有用處。
- **選取路徑直接用 `listAttempts`／`loadClaim`**（round 0 的寫法）：會跟隨 symlink、遇 FIFO 卡住、讀全文，而且在 runtime invoke 之前執行（R1，審查者 probe 已重現）。
- **這次就把 `message-store.ts` 的所有 reader 換成安全版本**：會改到 `recoverRunMail`、`commitClaim` 等 claim 生命週期的錯誤處理語意（讀不到時是失敗、略過還是重做），超出「小而可測」；本 spec 只讓新增路徑安全，並明寫殘留（22.5.2a）。
- **C-15 依 JSON 的 `claim_id` 排除名稱**（round 0 的寫法）：被排除的名稱仍佔著磁碟路徑，`atomicWrite` 會覆蓋它（R2）。
- **C-15 用 `O_EXCL` 建檔取代算號**：同一個 claim 沒有並行配號，`O_EXCL` 解決的是不存在的問題；而且只保護 JSON，不保護同名的 attempt 目錄。

## 22.15 未驗證（需要真實 runtime，不可升格成事實）

- C-16：被 resume 的 Claude，在 compact 之前是否沿用第一次的系統提示（依 `claude --help` 2.1.309 的文字推論；要實驗：`--resume` 加上不同的 `--append-system-prompt-file`，涵蓋 compact 前後）。本 spec 把新文字放在 user prompt 來迴避，所以這件事不影響本 spec 的正確性，但影響 C-05、C-12 之後的設計。
- 逾時或被殺的 attempt：resume 之後的 Claude／Codex session 是否包含被殺那次的 turns。這決定重複注入的實際比例，不影響正確性。
- 模型會不會照 Redo notice 先讀 task memory、會不會檢查草稿而不是盲目重寄：這兩件都只是 prompt 要求，沒有強制機制；只能用新的真實 run 觀察（R2 §4 的指標表）。
- `O_RDONLY|O_NOFOLLOW|O_NONBLOCK` 的行為：macOS 上已用 probe 確認（leaf symlink → `ELOOP`；沒有寫入端的 FIFO 立刻開啟、`fstat` 不是 regular file；64 MB sparse 檔只讀 64 KiB＋1 byte，整段 1 ms）。Linux 依 POSIX 語意應相同，未實跑；T8／T8m 在 CI 的 Linux 上會驗證。
- Codex 能不能讀 run 目錄裡的 inbox 原檔（C-08 截斷後的指標）：依 `workspace-write` 的語意應該可以，未用真實 Codex 實跑。Claude 的 `Read` 是全域允許的（`src/adapters/claude.ts:29`），但未實跑。
- C-14：Codex 的 OS 沙箱是否真的照 `writable_roots` 放行 lead checkout 根（延後項）。
- C-06：兩個真實 run 實際交錯的時序（機制已由 CA-06 用 fake run 重現）。

## 22.16 受影響的使用者文件（交給 docs-writer，中英成對）

- `docs/how-it-works.md` 與 `docs/how-it-works.zh-TW.md`：
  - 失敗與 resume 段（`:9` 一帶）：重試或重做時會收到 Retry／Redo notice，以及上次未投遞的草稿（只給本人、未驗證、≤4 KB），並提醒先讀 task memory。
  - 備援的 Fresh session 一條（`:68`）：「Nothing from the failed model's output is passed on」要改。失敗那次的 outbox 草稿會以未驗證草稿的形式交還給同一個 agent；備援已有自己的 session 且 `resume: true` 時會接續它（C-07）。
  - mail 段：要處理的信每封最多 16 KiB、一次合計 64 KiB 放進 prompt，超過時附原檔路徑（C-08）。
- `docs/configuration.md`／`.zh-TW.md`：沒有新設定，不必改；如果有描述 `resume` 與備援 session 的段落，與 how-it-works 保持一致。
- `docs/specs/README.md`：索引加一列 `| [22](22-context-continuity-fixes.md) | context 連續性修正（C 類處置、重做脈絡） | 中 | 中（prompt 與 attempt 編號） | — |`。
- README 中英：不必改（沒有破壞性變更、沒有新指令或新設定）。
- 延後項的文件（C-09、C-14 的警告文字等）不在本次範圍。

## 22.17 分工與預估

- **node-engineer**（TDD）：
  - 改 `src/` 的 6 個檔案：新增 `redo.ts`；修改 `fs-util.ts`、`run-session.ts`、`message-store.ts`、`prompt.ts`、`paths.ts`＋`call.ts`。
  - 預估新增約 300–400 行程式，`redo.ts`（含 22.5.2a 的 metadata reader 與驗證）占大部分。
- **qa**：22.11 的 T1–T17（含 T8m），約 40–45 個測試案例。T8m 測的是 `priorFailedAttempts` 這個 helper，不是完整 resume（22.5.2a）。
  - 新增 `test/redo.test.ts`（可以把 C-08 獨立成一個測試檔）。
  - 延伸 `test/attempt.test.ts`、`test/fallback-lifecycle.test.ts`、`test/message-store.test.ts`、`test/fs-util.test.ts`。
- **docs-writer**：22.16 的 2 對文件＋specs 索引。
- 建議的實作順序：C-13 → C-15 → `cutUtf8`／有界讀取 → C-08 → `redo.ts`（T6–T10、T8m）→ `run-session` 接線（T1–T5、T11–T12、T17）→ C-07。
- 完成標準：`npm run typecheck && npm run lint && npm test`，文件改完後再跑 `npm run check:docs`。

## 22.18 延後項的重啟條件

| 項 | 先要有什麼 |
|---|---|
| C-05、C-12 | C-16 的實驗結果；C-12 的措辭限定在「harness 注入的內容之間，寫入限制不可被 task、COMMON、records 或 memory 覆蓋；無法判定時回報衝突」（CA-12） |
| C-06 | architect 提出的跨 run 寫入協定設計（鎖的範圍、持有者、崩潰後怎麼恢復、`suspects` 怎麼歸因），以及必測的越權案例 |
| C-09、C-10 | 使用者決定：solo 是否免除 records／COMMON 的預算；COMMON 超量時是提醒還是只擋 team lead；提醒顯示在 CLI、result 還是 `status` |
| C-11 | 拒信的身分與「已解決」規則；或接受在 `state.json` 新增欄位（屬於格式變更，要有版本說明） |
| C-14 | 使用者在「不支援並報錯／改由 dispatcher 套用／接受並完整揭露」之中選一個，並用真實 Codex 驗證沙箱的實際行為 |
| C-16 | 一次真實的 Claude resume 實驗（compact 前後各一次） |
| （新）`message-store.ts` 全面改用安全 reader | 為 `recoverRunMail`、`commitClaim`、`abandonClaim`、`markOutputReady`、`finishAttempt` 訂出「metadata 讀不到時」的處置（失敗、略過或標記），再把它們換成 22.5.2a 的 reader；不是修正清單 C 類的項目，是 R1 審查留下的殘留 |
