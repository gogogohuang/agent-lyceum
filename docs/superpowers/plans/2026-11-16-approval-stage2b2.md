# Approval stage 2b-2 Implementation Plan

> **For agentic workers:** 依使用者原始任務（mail df8e43）的 mail team 流程：node-engineer 依序實作三片（每片 cli-reviewer 審），docs-writer 一片；lead 只安排一次 cli-architect-reviewer 設計審查，安全改動另有獨立跨 runtime 審查。不得 push、PR、merge；只在 run 自己的 worktree 分支內 commit。

**Goal:** 列入（enrolled）的 slot 在每次 wake 前重驗資格；不合格就不喚醒，並在人類可讀的 `status` 顯示原因。沒有 `executors.yaml` 或所有 `allow` 為空時，行為、輸出與 I/O 與升級前相同。

**Architecture:** 一個新的小模組 `src/approval-wake-gate.ts` 把既有函式（`resolveOrigin`/`qualificationHash`、`projectPremiseChecks`/`agentPremiseChecks`、`approvalContainmentChecks`、`assertRealDir`）組成「每輪一次的 gate pass」；`RunSession` 在選批次（`pickBatch`）之前用它過濾待喚醒清單，所以被擋的 slot 從不進入 `wake()`/`claimMessages`/`Promise.all`。原因寫到 run 目錄的一個側檔，`status` 只在人類輸出讀它。

**Tech Stack:** 同 2b-1（`docs/superpowers/plans/2026-11-14-approval-stage2b1.md:9`）：Node >=20、TS ESM、commander/yaml/zod、Vitest、Biome，依既有 lockfile；不加、不升依賴。

**Spec:** `docs/superpowers/specs/2026-11-13-approval-gate-design.md` §3 :45、:59；§4.1 :87–93；§6 :283–298（尤其 :294–295）；§9 :344、:364；§10 :375–377、:385。

## Global constraints（沿用 2b-1 :13–18，另加）

- 不改 `.strict()` schema、team/project YAML、`state.json`（`src/run-store.ts:231` 的 enum 不加值）、mailbox/journal 協定、CLI 旗標、`status --json`。不建立 `requests/`、不加 `proposals/` allow、不做 rotate/collect/park/`ok.json`/approvals CLI/executor/feedback/gc。`ENROLLED_SETTING_SOURCES = 'user'` 不動；不得宣稱 user settings 層安全（2b-1 handoff F3 仍是 stage 3 blocker）。
- 不呼叫 `this.note()`：它寫入 `state.notes`（`src/run-session.ts:412–418`），而 `notes` 會出現在 `status --json`（`src/status.ts:369`）。
- 理由文字一律固定類別（lesson `cross-model-review-evidence`；先例 `src/approval-runtime.ts:41–51`）：不得複製 `resolveOrigin` 的 hint（它含路徑，`src/approval-origin.ts:106`）、YAML/zod 訊息或 executor env。

## Decisions（逐項對應 lead 的驗收 1–7）

**D1 `status --json`（lead 已定，不重開）。** 原因只在人類 `status`；以 WeakMap 掛在 report 外，沿用 `lastVerifyOf`/`belowCeiling` 先例（`src/status.ts:380,385,650`）。只有「目前設定有列入 agent 或 `approvalError`」時才讀側檔（in-memory 判斷，無 I/O）。Rejected：在 `RunReport` 加欄位（spec :295、:364 禁止）。

**D2 基準與重算。** 基準（baseline）＝本 process 實際要執行的東西：`run()` 開頭（`recover()` 之後）對 `this.project` 每個 enrolled slot，以 session 開始時讀一次的 `loadExecutors` 計算 `Map<executor, sha256>`（`qualificationHash`，`src/approval-origin.ts:89`）與 canonical project dir。每個 gate pass 從磁碟重讀 `loadGlobal`/`loadProjectRaw`（`src/config.ts:145,150`）與 `loadExecutors`，以 `resolveProjectFrom`+`applyEnrollment`（pure）得到 fresh 專案，再用與 constructor 相同的 `soloProject`/`bindRunProject` 綁定（`src/run-session.ts:238,243`；抽成 `sessionProject()` 共用，兩邊 run-only 項目因此一致）。比對透過新的 `revalidateQualification(origin, executor, expected, resolver)`（`approval-origin.ts` 內；`revalidateOrigin` :114 改為呼叫它，行為不變），由它產生 `PROJECT_MISSING`/`PROJECT_PATH_MISMATCH`/`AGENT_MISSING`/`EXECUTOR_MISSING`/`NOT_ALLOWED`/`PREMISE_FAILED`/`SNAPSHOT_MISMATCH`/`ORIGIN_UNREADABLE`（:23–24、:97–123），另比對 fresh executor 集合與 baseline 相同（新增或移除 executor 都算 `SNAPSHOT_MISMATCH`）。「專案被移除」＝`lstat(projectPaths(home,name).config)` 為 ENOENT（先於 YAML 讀取，不靠 `readYaml` 的錯誤字串，未驗證其形狀）。SnapshotInput 由新的 pure `slotSnapshotInputs(bound, slot, config)` 建：candidates 用 `candidatesFor`/`agentForCandidate`；writable 用 `writePolicy(bound, {...agent, enrolled: undefined})` 的 allowDirs/allowFiles（去掉 enrolled 以免觸發 `approvalDenyPaths` 掃描，`src/policy.ts:230`；allow 清單不依賴它，:187–203），經 `staticWritable` 扣除 run-only（`memory.task`、`outboxDir`、`_shared` 與其 index——兩者在 task memory 的 run 目錄下，`src/policy.ts:74–83`；`ws.gitDir` 因 gate 在 workspace 準備前執行而不出現）。每輪讀取量：3 個 YAML（各 ≤1 MiB）＋下述 containment＋每個待喚醒 enrolled slot 一串 lstat 與至多一次 `opendir` 讀一項；不讀 payload、不輪詢（gate 只在迴圈每輪、且有 enrolled slot 待喚醒時執行）。Rejected：(a) 只比較 run 開始時的 hash（偵測不到 wake 之間的修改）；(b) 把 executor 設定放進 `ResolvedAgent.approval` 當基準（2b-1 刻意不帶 executor env，2b-1 plan :32）；(c) 對未綁定專案算 static set（stage 3 `approve` 才需要，見 Open items O5）。

**D3 每輪重驗哪些前提。** 一律以 doctor 同一組函式、只看 `level: 'error'`（warn 不擋）：P1 OS sandbox、P3 對外通道、P4 Codex 候選、P6 Windows（`agentPremiseChecks`，`src/doctor-approval-premises.ts:20–37`，經 `projectPremiseChecks` :43–56 對 fresh 專案每個 enrolled agent 執行）；P7 `verify.commands`（:49）；P2 containment（`approvalContainmentChecks`，`src/doctor-approval-containment.ts:309`，含 command[0] 每個 symlink hop 與其目錄，:326–341，所以 2b-1 F1b 的中間 hop 在每輪被擋）。PremiseResult 只有兩個固定 id：`project-premises`、`containment`（有 error 即 ok=false）；同專案任一 enrolled agent 的前提錯誤會擋該專案全部 enrolled slot（fail-closed，與 doctor「有 error 就不可用」一致）。不重驗：P0（第 0 步，人工發布關卡）、P4 MCP/`--setting-sources`/`failIfUnavailable` 與 P5 env 白名單（invocation 建構時的常數，2b-1 已集中加，`src/adapters/claude.ts`）、P4(ii) user settings 白名單（未建，F3）。注意 P1 的探測在 process 內快取（`src/policy.ts:241–247`），mid-run 移除 `bwrap` 不會被 gate 發現，後盾是 2b-1 的 `failIfUnavailable`。Rejected：每輪只做「本 slot 的 grants 對 protected set」的局部 containment（需拆 containment 模組，且漏掉其他專案新加的 grant）；只在 run 開始做 containment（漏 F1b mid-run）。成本：containment 走訪上限 20000 entries/深度 8、每專案一次 `git rev-parse`（5 s timeout）（:29–30、:252），同步執行；迴圈是批次同步的（`await Promise.all` :1433 之後才進下一輪），gate 執行時本 process 沒有進行中的 wake，所以不阻塞任何 agent。

**D4 不喚醒路徑**：見下表。核心：gate 在 `pickBatch`（`src/run-session.ts:1401`）之前過濾，被擋的 slot 不進 `awake`，因此不會有 claim、attempt、`WakeOutcome` 失敗，`settle` 不會判 `agent_failed`（:1119），也不消耗 round。

**D5 原因持久化。** 新側檔 `<runDir>/approval-gate.json`：`{"schema_version":1,"slots":{"<slot>":{"class":"refused"|"skipped","code":"<GateCode>","at":"<ISO>"}}}`，只由 dispatcher 以 `atomicWrite`（`src/fs-util.ts:5`）在內容改變時寫入；session 開始（有 enrolled agent 時）重寫為空 `slots`。讀取用 `readRegularFileNoFollow`（:61）＋zod strict；不存在＝無原因；損毀/未知版本＝人類 status 印一行固定文字「核可關卡狀態檔無法讀取」，不 throw。舊 run 沒有它照常載入；舊 binary 不讀它（`status.ts` 只讀特定檔，spec :298）；`clear` 刪整個 run 目錄。內容只含 slot 名、固定 code 與時間。Rejected：`state.json` 新欄位（違反「不改 run state」）；`state.notes`（洩入 `status --json`）；從 `log.jsonl` 回推（monitor 每次輪詢都要掃整個 log，且 log 會輪替）。

**D6 入口覆蓋。**
- `run`/`resume`/solo（`run --agent`，同一個 `RunSession`，`soloProject` 已在 constructor 套用，:237–238）：完整 gate。resume 的 `recover()`（:1340–1352）不新增任何 approval 步驟；gate 在 `run()` 迴圈內、逐 slot try/catch，不會讓 resume 失敗。
- 同角色實例 `name--k`：enrolled 角色上限為 1（`src/instances.ts:47`），實務上沒有 k≥2；gate 以 slot 名評估、identity 以 `roleOfName`；若 enrolled slot 沒有 baseline（例如 mid-run 開出的實例）一律 `refused NO_BASELINE`，refused 的實例由既有 `acceptsNew → "refused"` 不再收 held mail（:559）。
- fallback/tier 候選：同一 wake 內的嘗試，不逐候選重驗；hash 已含所有 runtime 候選，前提逐候選判斷（premises :26–34）。
- `call`：在 `callAgent` 建 call 目錄與 lease 之前（`src/call.ts:161` 之前）對 enrolled agent 跑 `agentPremiseChecks('call/<role>')`＋containment，error 即以固定文字的 `ConfigError` 結束、不 invoke、無副作用。不做 hash 比對（解析與 wake 同一瞬間，baseline==fresh）、不做 request 目錄檢查（新 call id 的目錄必然不存在）。
- `tidy`（帶 policy 的 wake）、verify（`sh -c`，非 agent wake）、format：不 gate。理由：spec 明定這類 wake 沒有 `proposals/`（:93），gate 保護的請求通道不存在；2b-1 的強化仍套用。Rejected：gate tidy（多一套前提 I/O，不保護任何東西）。

**D7 嚴格 attempt 讀取。** 新增 `latestSlotAttempt(runDir, slot, maxEntries): LatestAttempt`（`src/message-store.ts`；`listAttempts` :287 不動）。只在該 slot 的 `proposals/` 存在且非空時呼叫——這是 2b-2 唯一用途：判斷殘留輸出屬於誰（spec :91）。因為收走與 park 是 stage 3，三種結果在本片都「略過不喚醒」，只是 code 不同；stage 3 再把可判定的分支接上 rotate。規則：`opendirSync` 逐項計數至 `config.limits.max_scan_entries`（超過＝undeterminable）；以檔名 `^[0-9a-z]+-(.+)-[0-9a-f]{6}-a(\d+)\.json$` 僅「篩選屬於此 slot 的檔」，從不用來排序；每個候選檔用 no-follow reader 讀、zod 驗 `id`/`claim_id`/`agent===slot`/`n` 正安全整數/`status` enum/`started_at` 可解析，任一不符＝undeterminable；他人的損毀檔忽略（slot 隔離）。排序鍵 `(Date.parse(started_at), n)` 數值比較，最大兩筆鍵相同＝undeterminable；再嚴格讀其 claim（no-follow＋zod）。`claim ∈ {output_ready, committed}` → `RESIDUAL_OUTPUT`（待收走）；claim `abandoned` 或 attempt `failed` → `RESIDUAL_OUTPUT`（待 park）；其他 → `UNDETERMINABLE`。Rejected：每次 enrolled wake 都讀 attempts（多一次 O(attempts) 掃描，卻沒有可保護的輸出）。

## 不喚醒路徑（D4）

| 觸發 | 類別 / code | 動作與通知 | `status`（人類） | 不會 `agent_failed` / 空轉的原因 | 下次 |
|---|---|---|---|---|---|
| fresh 載入 `executors.yaml`、global、project YAML 失敗 | refused `CONFIG_INVALID` | 加入 `this.refused`（:217）；`deliverOnce` key `approval-refused:<run>:<slot>`（同 :957–969 形式，含 `{about}` 規則）；log `approval_gate {slot,class,code,premises}`；`say` | 「本 run 不再喚醒：<固定文字>；修正後 resume」 | `pendingAgents` 已排除 refused（:628）；無其他人待喚醒就走既有 idle 結束（:1384–1396） | resume：D1 在任何 wake 前停止（`approval-runtime.ts:61`）；修好後重算 baseline |
| 專案被移除 / 角色被移出 team / 移出 allow、executor 增減 | refused `PROJECT_MISSING`/`AGENT_MISSING`/`NOT_ALLOWED`/`EXECUTOR_MISSING`/`SNAPSHOT_MISMATCH` | 同上 | 同上 | 同上 | 同上 |
| canonical 專案路徑 ≠ baseline | refused `PROJECT_PATH_MISMATCH` | 同上 | 同上 | 同上 | 同上 |
| 快照欄位改變（sandbox、allow_web、static writable、candidates、executor 條目） | refused `SNAPSHOT_MISMATCH` | 同上 | 同上 | 同上 | 同上 |
| 任一前提 error | refused `PREMISE_FAILED`（`project-premises`/`containment`） | 同上，訊息請使用者跑 `doctor` | 同上，附前提 id | 同上 | 同上 |
| baseline 無法計算 / 無 baseline | refused `ORIGIN_UNREADABLE`/`NO_BASELINE` | 同上 | 同上 | 同上 | 同上 |
| `requests/…/<slot>` 或其祖先、`proposals/` 是 symlink/非目錄/lstat 錯 | skipped `DIR_ANOMALY` | 本輪移出清單；`deliverOnce` key `approval-skip:<run>:<slot>:<code>`；log 每 (slot,code) 一次 | 「暫停喚醒（每輪重驗）：<固定文字>」 | 本輪不喚醒；若沒有其他人可喚醒，現有 `stallHeld`→`idle`（:1393–1395），不消耗 round | 每輪與 resume 重驗，異常排除即恢復（spec :87、:385） |
| `proposals/` 非空，最近 attempt 可判定 | skipped `RESIDUAL_OUTPUT` | 同上 | 「有待處理的殘留輸出（stage 3 收走/park）」 | 同上 | 同上 |
| `proposals/` 非空，無法判定（損毀 JSON、非一般檔、平手、超過掃描上限、claim 讀不到） | skipped `UNDETERMINABLE` | 同上 | 同上 | 同上 | 同上 |
| slot 評估時任何未預期 throw | skipped `UNDETERMINABLE` | 同上（逐 slot try/catch） | 同上 | 同上 | 同上 |

- 不存在的 slot 目錄（2b-2 從不建立它）＝正常。dir 檢查用 `requestPaths`（`src/approval-paths.ts:52`），祖先逐層 `assertRealDir`（`src/approval-io.ts:51`；把私有的 `ancestorsExist` :59 匯出重用）。
- **lead 本身**：refused → 直接以 `lead_failed` 結束 run、不喚醒任何人（先例：lead worktree 被拒 :1411–1414），不寄信給自己；skipped → 只 log/側檔/`say`，不寄給自己。
- gate 寄出新的 lead 通知後，同一輪重算一次待喚醒清單（同 `stallHeld` 的 "notified" :1391），讓 lead 本輪就能處理；`deliverOnce` 以 run journal 去重，resume 後同一 key 不重寄。
- 每一輪只有兩種結局：至少喚醒一人（round+1，受 `max_rounds` 限制），或沒有可喚醒者而以 `idle` 結束。不存在「被跳過卻仍被選中」的路徑。
- TOCTOU：gate 到 spawn 之間只有 workspace 準備（git，秒級）；stage 2b-2 不給 agent 任何核可寫入點，containment 與 stage 3 的 approve/執行前重驗才是防線。

## 介面（S1 定稿）

```ts
// src/approval-wake-gate.ts
export type GateCode = OriginErrorCode | 'NO_BASELINE' | 'DIR_ANOMALY' | 'RESIDUAL_OUTPUT' | 'UNDETERMINABLE';
export type GateVerdict = { kind: 'wake' } | { kind: 'refused' | 'skipped'; code: GateCode; premises?: readonly ('project-premises' | 'containment')[] };
export interface SlotBaseline { readonly slot: string; readonly origin: Origin; readonly hashes: ReadonlyMap<string, Sha256> }
export interface FreshView { readonly project: ResolvedProject; readonly bound: ResolvedProject; readonly config: ExecutorsConfig; readonly premises: readonly PremiseResult[] }
export interface GateDeps { loadFresh(): { ok: true; view: FreshView } | { ok: false; code: OriginErrorCode }; slotDir(slot: string): GateVerdict; now(): Date }
export function slotSnapshotInputs(bound: ResolvedProject, slot: string, config: ExecutorsConfig): Map<string, SnapshotInput>;
export function baselineFor(bound: ResolvedProject, slot: string, config: ExecutorsConfig, runId: string): SlotBaseline;
export function qualificationVerdict(baseline: SlotBaseline, view: FreshView): GateVerdict;  // pure, via revalidateQualification
export function slotDirVerdict(home: string, ref: SlotRef, runDir: string, slot: string, maxScan: number, io?: ApprovalIo): GateVerdict;
export const GATE_TEXT: Readonly<Record<GateCode, { mail: string; status: string }>>;  // fixed text only
export function writeGateFile(runDir: string, slots: Readonly<Record<string, GateEntry>>): void;
export function readGateFile(runDir: string): { slots: Record<string, GateEntry> } | 'unreadable' | undefined;
// src/approval-origin.ts
export function revalidateQualification(origin: Origin, executor: string, expected: Sha256, resolver: OriginResolver): OriginResult;
// src/message-store.ts
export type LatestAttempt = { kind: 'none' } | { kind: 'found'; attempt: AttemptRecord; claim: ClaimStatus } | { kind: 'undeterminable'; why: 'corrupt' | 'unsafe_entry' | 'scan_limit' | 'tie' | 'claim' | 'io' };
export function latestSlotAttempt(runDir: string, slot: string, maxEntries: number): LatestAttempt;
```

`RunOptions.approvalGate?: Partial<GateDeps>` 是測試 seam（同 `opts.instanceCheck`/`opts.invoker`/`opts.sleep` 的先例）。`RunSession` 只在 `this.project` 有 enrolled agent 時建立 gate 狀態；否則 `gatedPending()` 直接回傳 `pendingAgents()`。

## Default-off 證明（驗收 8）

- `test/fixtures/approval-compat/` 現有 24 檔（20 檔來自 stage 2a commit `ee0f967`，4 個 `rt.*` 來自 2b-1 `134ffaa`；`git log --diff-filter=A` 已查）全部不重產、不改；每片 gate 加 `git diff --exit-code -- test/fixtures/approval-compat`。既有測試檔不修改（S1 的 `revalidateOrigin` 重構必須讓 `test/approval-origin.test.ts` 原樣通過）。
- 零額外 I/O：無 enrolled agent 時 gate 狀態不建立（in-memory 判斷）。測試以計數型 `GateDeps` 與 `vi.spyOn` 包 fs（`lstatSync`/`opendirSync`/`readFileSync`）跑一個 fake-invoker run，斷言 gate deps 0 次呼叫、`approval-gate.json` 不存在、`log.jsonl` 無 `approval_gate`。status：無 enrolled 時 `readGateFile` 0 次呼叫，人類與 JSON 輸出逐字相同。

## 三個順序 slices（node-engineer；每片先寫失敗測試）

Gate（每片）：`npm run lint && npm run typecheck && npm test && npm run check:docs`，貼結尾行；沙盒內需 `*.pipe` listen stub，基準已知 7–8 個失敗（watch、4 個 process-runner、run-lifecycle、web-api 413，見 2b-1 handoff Pitfalls），新增失敗一律先修；node_modules 實體複製到 `$TMPDIR`，不 symlink。所有檔案測試用臨時 `AGENT_LYCEUM_HOME`/repo；時間用注入的 `now`/Vitest fake timers。

### Slice 1 — pure 建構塊（D2、D3 計算部分、D5 檔案、D7）
- 測試（新檔 `test/approval-wake-gate.test.ts`、`test/approval-latest-attempt.test.ts`、`test/approval-revalidate-qualification.test.ts`）：`same config gives same hashes for bound lead/member/solo`；`sandbox.write change gives SNAPSHOT_MISMATCH`；`executor added for role gives SNAPSHOT_MISMATCH`；`project dir canonical change gives PROJECT_PATH_MISMATCH`；`missing project.yaml gives PROJECT_MISSING`；`premise error in another enrolled agent refuses with project-premises`；`containment error refuses with containment`；`slot dir absent is wake`；`symlinked slot root / ancestor / proposals is DIR_ANOMALY`；`non-empty proposals with output_ready claim is RESIDUAL_OUTPUT`；`latest attempt orders a2 before a10 with equal started_at`；`latest attempt orders by started_at across claims`；`equal keys are undeterminable`；`corrupt JSON of this slot is undeterminable, of another agent is ignored`；`FIFO/symlink attempt entry is undeterminable without blocking`；`scan cap is undeterminable`；`revalidateOrigin behaviour unchanged`；`gate file round-trip, unknown version and corrupt file read as unreadable`；`GATE_TEXT contains no config value (sentinel secret in executor env and path)`.
- Allowed：新 `src/approval-wake-gate.ts`；`src/approval-origin.ts`（只加 `revalidateQualification` 與重構 `revalidateOrigin`）；`src/message-store.ts`（只加 `latestSlotAttempt`）；`src/approval-io.ts`（只匯出 `ancestorsExist`）；上列新測試。Not allowed：run-session、call、status、schema/config/run-store、mailbox、adapters、policy、doctor 模組、既有測試與 fixtures。

### Slice 2 — 接進 RunSession 與 call（D4、D6）
- 測試（新檔 `test/approval-wake-gate-run.test.ts`、`test/approval-wake-gate-call.test.ts`，fake invoker，invoker 在 lead 的 wake 中改設定以模擬「wake 之間」）：`member not woken after project config edited between wakes and stays refused`；`… after project removed`；`… after project dir canonical path changed`；`lead gets exactly one notice per refused slot`；`refused slot leaves no claim and no attempt`；`resume re-checks: fixed config wakes the slot`；`dir anomaly skips only that slot, other members still woken`；`resume with an anomalous slot completes`；`skip clears when the anomaly is removed before the next pass`；`corrupt attempt JSON with non-empty proposals: not woken`；`only skipped slots hold mail: run ends idle without consuming rounds`；`refused lead ends lead_failed with no wake`；`solo enrolled agent is gated`；`enrolled slot without baseline is refused NO_BASELINE`；`gate throw in one slot does not reject the batch`；`call refuses enrolled agent on premise error before any file is created`；`non-enrolled run: zero gate calls, no gate file, no approval_gate log`；`status --json of these runs equals the same run with the gate file deleted`.
- Allowed：`src/run-session.ts`（gate 狀態、`sessionProject()` 抽取、`gatedPending()` 取代 `run()` 內三處 `pendingAgents()` :1370/:1382/:1391、baseline、通知、lead 結束）；`src/call.ts`（:161 之前的 gate）；上列新測試。Not allowed：`run-store.ts`、`mailbox.ts`、`message-store.ts` 的既有函式、`recoverRunMail`、`settle`/`wake()` 內部、adapters、policy、prompt、status。

### Slice 3 — 人類 `status` 顯示（D1、D5 讀取）
- 測試（新檔 `test/approval-gate-status.test.ts`）：`human status lists refused and skipped slots with fixed text`；`unreadable gate file prints one fixed line and status still works`；`no enrolled agent: gate file ignored, readGateFile not called`；`status --json byte-identical with and without gate file`（`JSON.stringify` 比對）；既有 status 測試與 approval-compat fixtures 原樣通過。
- Allowed：`src/status.ts`（`buildStatusReport` 以 WeakMap 掛原因、`formatStatusReport` 在 `tierLines` 之後加「核可關卡：」區塊）；新測試。Not allowed：`StatusReport`/`RunReport` 型別、`describeRun`、`plugins/status-monitor`。

### Docs（docs-writer → docs-reviewer）
`docs/approval-store-api.md`：更新標題與開頭段落（:1、:7–15 目前寫「沒有 run-session/wake 整合」，2b-1 起已不正確）；在「Doctor checks (stage 2a)」之後新增「Wake gate (stage 2b-2)」：判斷順序、D4 表的 code 與類別、側檔格式與相容性、`status --json` 不變、未 gate 的入口與理由、未驗證項目。不改 README（無 CLI 表面變化，故無雙語配對要求）。`npm run check:docs` 必須通過。

## Security review focus（給 security + security-reviewer）

1. TOCTOU：gate（pass 開頭）→ workspace 準備 → `claimMessages` → spawn 的窗口；確認沒有在 gate 之後才讀取並信任的設定。
2. Fail-closed：每個 I/O 錯誤、throw、zod 失敗、平手、掃描上限都落在 refused/skipped，絕不落到 wake；沒有部分結果被當成「通過」。
3. symlink/FIFO：slot 目錄祖先、`proposals/`、attempt/claim 檔、側檔都用 lstat/no-follow/nonblocking 讀取；`opendir` 必定 close。
4. Slot 隔離：一個 slot 的異常不改變其他 slot 的判定、不讓 `Promise.all`/resume 失敗；他人損毀 attempt 不影響本 slot。
5. 文字洩漏：通知、log、側檔、`status` 只含 slot/專案名、固定 code、固定文字；以 sentinel secret/路徑測試。
6. Baseline 來源：baseline 是 in-memory 專案＋session 開始的 executors 讀取，確認兩者之間的窗口只會讓 executor 條目被吸收（O3），不會讓 enrolled 判定或 sandbox 設定被替換。
7. 未 gate 的入口（tidy、verify、format、web summary）與 user settings 層（F3）明確列為未涵蓋，不被文件寫成已防護。

## Dimension coverage

1. **Compatibility & Format：** 新側檔有 `schema_version`，舊 run 無檔照常；舊 binary 忽略；`state.json`/journal/`status --json` 不變；無 enrolled 時逐位元組相同（24 fixtures）。
2. **File & Process Safety：** 只讀不寫 `requests/`；no-follow/lstat；不 spawn 新程序（containment 既有的 `git rev-parse` 除外）；固定文字。
3. **Concurrency & Recovery：** gate 在批次之間同步執行；側檔 atomicWrite；Ctrl-C/timeout/odd exit 沿用既有 lifecycle（gate 不碰 claim）；resume 每 slot 重算；去重靠 journal。
4. **Platform & Operability：** macOS/Linux；Linux sandbox 探測快取（D3）；每輪成本受 containment 上限約束；錯誤指向 `doctor`。
5. **Testability & Maintainability：** pure 函式＋`GateDeps` seam；fake invoker、臨時 home；不碰真實 `claude`/`codex`/`~/agent-lyceum-config`。
6. **Observability & Diagnosability：** `log.jsonl` `approval_gate` 事件、側檔、人類 `status` 區塊、lead 通知、終端 `say`；沒有靜默跳過。
7. **Run-loop liveness（額外）：** 每輪必然喚醒至少一人或結束；被跳過的 slot 不消耗 round、不觸發 `agent_failed`。

## Risks / decisions made for the lead

- 前提錯誤以「專案」為單位擋所有 enrolled slot（不解析 doctor 訊息分配到單一 agent）。Rejected：解析訊息（脆弱）或重構 premises 模組（超出範圍）。
- containment 每輪執行；大型 home 超過 20000 entries 時會判 `PREMISE_FAILED` 擋住所有 enrolled slot（與 doctor 已有的 error 相同語意）。Rejected：只在 run 開始做（漏 F1b mid-run）。見 O1。
- tidy/verify/format 不 gate（D6）；`call` 只 gate 前提與 containment。
- 不建 `proposals/`，所以 `RESIDUAL_OUTPUT`/`UNDETERMINABLE` 在 2b-2 只有測試或人為放置才會發生；strict reader 的實際用途留給 stage 3。
- refused lead 以既有 `lead_failed` 結束 run（outcome `failed`，`src/run-store.ts:350`），不新增 end reason。Rejected：讓 run 繼續喚醒成員（其回覆永遠沒人讀）。
- 2b-2 的 enrollment 名單仍在 run 開始時固定：mid-run 新列入的 agent 不被偵測（非列入路徑零 I/O 的代價）；移出名單則被 `NOT_ALLOWED` 擋。
- 計數：任務寫「20 個 fixture」，實際 24 檔（20＋2b-1 的 4 個），兩者都不得變。
- 未驗證：真實 Claude CLI、Linux、真沙盒、並行 run 同時改設定。

## Open items（owner / 預設）

- **O1**（user，經 lead）：大型 home 的 containment 掃描上限造成全面拒絕。預設：照 fail-closed 實作，文件寫明「doctor 有 error 就不能喚醒 enrolled agent」；若不可接受，另開任務改 containment 的上限或範圍。
- **O2**（lead）：tidy 不 gate。預設：不 gate（D6）。
- **O3**（lead）：CLI 解析與 session 開始的 executors 讀取之間若 executor 條目被改，被吸收進 baseline。預設：接受（條目不影響 agent invocation；stage 3 approve/執行前會重驗）。
- **O4**（lead）：mid-run 新列入不偵測。預設：接受，下次 run/resume 生效。
- **O5**（stage 3 architect）：`approve` 用的 resolver 需在未綁定專案上得到與 bound slot 相同的 static set；2b-2 兩邊都綁定同一 run，不需要也不證明這點。

## Design review disposition（lead，review 81fa6ab9，唯一一輪；不再送設計審查）

Reviewer verdict: request-changes（3 major、2 minor）。以下修正**取代**上文衝突處，實作以本節為準。

- **R1 major unbounded-gate-io → 接受。** gate 路徑（只在有 enrolled agent 時）讀 global/project YAML、`executors.yaml` 以外的檔案一律改用既有 `readRegularFileCappedNoFollow`（`src/fs-util.ts:103`，O_NOFOLLOW|O_NONBLOCK、fstat isFile、上限）；fresh global/project YAML 也經此讀取（上限 1 MiB，超過、FIFO、非一般檔、symlink → `CONFIG_INVALID` refused），再交給既有 pure 解析（`resolveProjectFrom`）。attempt/claim 單檔上限 64 KiB、側檔上限 64 KiB；超過/FIFO/非一般檔 → attempt/claim 為 `UNDETERMINABLE`，側檔為 status 的 `unreadable`。一般（非 enrolled）的 `loadGlobal`/`loadProjectRaw` 不改。測試：FIFO 與超限各一，覆蓋 fresh YAML、attempt、claim、側檔，斷言不阻塞（Vitest timeout 內完成）。Slice 1 Allowed 加入：gate 專用的小 loader 放在 `src/approval-wake-gate.ts`（不改 `src/config.ts` 既有函式；若需要 export 既有 pure helper，只加 export）。
- **R2 major pre-gate-recovery → 接受，縮小範圍。** 威脅說明：`mail/attempts`、claims 在 run 目錄內、對 agent 逐項 deny（`src/policy.ts:95–109`），所以這是 robustness 而非 agent 可利用的通道；FIFO 讓 `listAttempts` 阻塞對所有 run 都是既有行為。做法：`run()` 在 `recover()` 之前，若有 enrolled agent，先對每個 enrolled slot 以 R1 的有界讀取器嚴格掃描該 slot 的 attempt/claim 檔（只依檔名篩選屬於該 slot 的檔），任何不安全/損毀 → 該 slot 進入 quarantine（skipped `UNDETERMINABLE`，本 process 不喚醒，下次 run/resume 重驗）。`listAttempts`/`recoverRunMail` 加**可選**參數 `skipFile?: (name: string) => boolean`，在 `readFileSync` 之前依檔名略過 quarantined slot 的檔；未傳時行為與位元組完全不變（非 enrolled 永不傳）。健康 slot 照常 recover。Slice 2 Allowed 加入 `src/message-store.ts` 的 `listAttempts`/`recoverRunMail` 這一個可選參數（不得改其他邏輯）。新增測試：resume 時 enrolled slot A 有 FIFO attempt、slot B 有可 recover 的工作 → 不阻塞、batch 不 reject、A 不喚醒、B 正常前進；另一個 A 為可解析但欄位錯誤的 attempt。
- **R3 major lost-refusal-diagnostics → 接受。** 人類 `status` 對每個顯示的 run，只要 `<runDir>/approval-gate.json` 存在就以 R1 讀取器讀取並顯示，與目前設定是否 enrolled 無關（取代 D1「只在目前有 enrolled 時讀」）。代價：人類 status 每個 run 多一次 open（ENOENT 即止）；檔案不存在時人類輸出逐位元組不變。`status --json` 永不讀它、永不變。新增端到端測試：enroll → wake 中移除最後一個 allow → refused 持續 → 另起 status 仍見原因、JSON 不變；同測移除 `executors.yaml`。
- **R4 minor diagnostic-write-failure → 預設：** 側檔寫入/重設失敗時，in-memory 封鎖不變（絕不因記錄失敗而喚醒），log 寫一筆固定事件 `approval_gate_file_error`（best-effort），終端 `say` 一行固定文字；session 開始的重設失敗時舊條目可能殘留，status 區塊標示寫入時間 `at` 讓人判斷。`atomicWrite` 不保證 fsync 持久性，文件照寫。故障注入測試：重設與更新各一次 throw → 被擋 slot 仍不喚醒。
- **R5 minor overstated-scan-bound → 接受。** 修正成本描述：containment 會重讀所有專案的 global/project YAML，20000 是每次 alias walk 的拒絕門檻、在 `readdirSync` 配置之後計數，不是全 home 工作上限；gate 同步執行期間 Ctrl-C 為 best-effort（gate 結束後才處理）。寫入 Risks 與 docs，不新增 scanner（O1 不重開）。

Lead 另外決定：fixed-text sentinel 測試要做整合層（通知、log、側檔、人類 status 全部掃 sentinel secret 與 sentinel 路徑），不只測 `GATE_TEXT` 常數。

## Amendment A — mutable containment / retained premises（task d8dbebd3）

本節取代 D3、O1、R5 中「完整 doctor alias 掃描結果直接當成 wake 前提」以及 D2/D6 的 fresh-only 前提敘述；其餘決策不變。不增加設計 reviewer 或人工核准輪，由 lead 依本節與獨立安全報告決定。只交付設計，未實作以下契約。

### Context / checked evidence

安全報告 `_shared/security-review-full.md` 的兩條靜態鏈經重新核對：

- `src/approval-wake-gate.ts:184–186` 把 fresh project checks 與全域 containment errors 轉成前提；`src/doctor-approval-containment.ts:280–294,370–381` 會走訪 agent 可寫的後代，深度上限或 alias overlap 造成 error；`src/run-session.ts:744–747` 讓 enrolled lead 的 refused 結束 run。
- P7 在 `src/doctor-approval-premises.ts:49`，但只對 fresh project 執行；hash inputs 不含 verify（`src/approval-wake-gate.ts:74–108`）。實際 shell verifier 使用 retained `project.verify`（`src/run-session.ts:1204–1205,1302–1311`，`src/verify.ts:51`）。因此「磁碟修好了」不等於「執行中的 verifier 消失」。

2026-11-16 重跑 security 的三份原 probe（不是修補後測試）：在既有 disposable `git archive 95f76cf` 副本 `/private/tmp/claude-501/arch2b2.QIH1`，臨時 HOME 與 AGENT_LYCEUM_HOME，執行 `node node_modules/vitest/vitest.mjs run --configLoader runner test/sec-probe-dos.test.ts test/sec-probe-crossproject.test.ts test/sec-probe-p7.test.ts --reporter verbose`。結果 `Test Files 3 passed (3); Tests 7 passed (7)`、exit 0，表示缺陷重現，並非修補驗收：

- cross-project `before={"kind":"wake"} after={"kind":"refused","code":"PREMISE_FAILED","premises":["containment"]}`。
- `[lead enrolled] wakes=["lead","qa-member"] end=lead_failed outcome=failed`。
- 指向 executors.yaml 的 memory alias 讓 member refused；dangling alias 控制組仍 wake。
- `inMemoryVerify=["unit"] diskHasVerify=false wakes=["lead","fe-member","lead"] end=done`；`staleVerifyExecuted=stale-verify`。

先前失敗 wake 的原始輸出保存在 task memory `cli-architect/probe-head-95f76cf.out.txt`；本次重跑得到相同上述結果。真 runtime、Linux 與修補效果尚未驗證。

### Decision A1 — wake gate 檢查授權根目錄，doctor 保留後代診斷

**界線：** grant 是設定或實際 invocation 明確授予的目錄／檔案／cwd，含其 canonical 目標；祖先與 symlink hop 會決定這個授權或 protected 路徑到底落在哪裡。grant 內新建的任意後代並不是新的 grant。把後代 alias 當作獨立 grant，會讓「可以建立連結」錯當成「已被授予連結目標的寫入權」。因此修正的是權限輸入模型，不是把不完整的安全檢查當成功。

在 `ApprovalContainmentOptions` 加內部可選 `mode?: 'diagnostic' | 'grants'`（預設 diagnostic）及 `executionProjects?: readonly ResolvedProject[]`。不改 public CLI 或持久化 schema。

1. diagnostic 模式保持現有 doctor 的順序、文字、alias 掃描與限額完全不變；不解析 DoctorCheck.message 來分類。
2. grants 模式保留所有專案與所有 global call 的設定讀取、grant 根目錄及 conservative envelope 根目錄、git common dir inventory、protected set 建構、canonical 雙向 overlap 比對與所有 I/O error 的 fail-closed 結果。只略過 `envelope` 的 `aliasesBelow` 遞迴，不把任意 mutable descendant 變成 grant。`sandbox.write`、allowFiles、project dir、worktrees、calls、task-memory、runs 等根目錄不得漏掉。
3. configured grant 自身或其祖先若是 symlink，仍解析其 canonical target；protected command/interpreter 的每個 kernel-order hop 與 hop directory 保護原樣保留。`link/../x` 的拒絕、middle-hop、root canonical 失敗／循環的 error 不能弱化。grant 等於、包含或落在 protected 範圍內仍 refused；root 正好是指向 executors 的 symlink 與 root 內任意新增的 link 是不同案例。
4. `executionProjects` **加到**既有磁碟 inventory，絕不取代它。抽出既有 agent × candidate grant 收集迴圈共用；保留 actual 與 fresh 的聯集，包含 `writePolicy` allowDirs/allowFiles、repo/cwd、workspace root/gitDir、sandbox.write。收集時去掉 agent.enrolled，避免 `writePolicy` 為 deny inventory 另做 I/O；allow 集合不依賴 enrolled（`src/policy.ts:178–203,230`）。不可用 `staticWritable`：實際 run-only grants 也須檢查。以來源標籤區分 retained/session，doctor 訊息不改。
5. grants 模式不掃自己或他人 memory 的後代，不引入 own-grants map、reason id 或 skipped 特例。合法深目錄／alias 既不拒絕 unrelated slot，也不終止 enrolled lead。真正配置錯誤仍走原 `PREMISE_FAILED / containment` refused；slot requests/proposals 目錄檢查、quarantine 與恢復修訂不變。

**alias 的權限解釋與限制：** Claude adapter 將實際 cwd、allowDirs/allowFiles 寫入 sandbox filesystem.allowWrite、deny 寫入 denyWrite（`src/adapters/claude.ts:60–69`），Edit 另有 allow/deny 規則（:35–49）；enrolled denies union strict approval raw/canonical paths（:35–39）。Codex roots 由實際 policy 推導，沒有 deny list，enrolled Codex 直接拒絕（`src/adapters/codex.ts:11–18,64–66`）。在依 canonical 目標執行的 OS sandbox 下，memory 內建立 `link -> executors.yaml/project.yaml` 不新增目標的 allowWrite；spec §8 :336 記載 shell 經 proposals symlink 寫 approvals 被擋。不能把這項有限證據擴充成 Claude Edit 或 Linux 的實測保證：Edit 的 alias 規則解析、user settings 仍未驗證。若 Edit 本身可經 alias 逃逸，這是 adapter/發布前提失效，全面拒絕別的 slot 並不能撤銷攻擊者既有 authority；既有 doctor 與 stage-0/stage-3 blocker 保留，不宣稱此片建立完整安全屏障。沒有新的 prompt-only 或 post-hoc 保護；真正強制仍依 OS 與 runtime tool rules，guard 不是 containment 的替代。

**Rejected：** (a) 調高遞迴限額：一個更深目錄即可再觸發；(b) 把所有 containment error 降成 skipped：真正 protected grant 也會被錯當成可恢復目錄雜訊；(c) 只檢查本 slot：漏跨專案 configured grant；(d) 自己 alias 才 skipped、他人忽略：增加 owner map 與每輪掃描，且任意後代仍不是 authority；(e) 移除 containment 或忽略 canonical error：漏實際 root/hop 重疊。

### Decision A2 — actual 與 fresh 都是 premise inputs

`loadFreshView` 加必填 `actual: ResolvedProject`，只在已啟用 gate 路徑使用。每輪以當下 `this.project` 傳入，不能在 `initGate()` destructuring 的舊 project 上閉包（`rebind()` 會替換它，`src/run-session.ts:466`）。fresh 仍做原 bounded loader、enrollment、solo/bind 與 hash 檢查。

- `project-premises` 成功須 actual **與** fresh bound project 的 `projectPremiseChecks` 都沒有 error；使用現有函式，不複製 verify 或候選判斷。fresh executor allow 被移除時仍先／另由 qualification 判定拒絕，不能因沒有 enrolledNames 而放行 actual。保留 actual enrollment 的 slot 身分；不得用 fresh agent 覆寫 actual agent。
- containment 使用 A1 grants 模式，executionProjects 至少包含 actual 與 fresh bound project。磁碟 inventory 仍涵蓋其他專案；因此隊友的 retained grants 在磁碟修好後仍是拒絕依據。不把 grant 變更偷偷合併回 session，也不動 verify 的執行語意。
- run：actual 是目前 execution project；fresh 以相同 runId/layout/instance table 綁定。solo：兩邊都以同一 `soloProject` 處理，保留它實際留下的 verify；resume：重新解析並重新綁定，但仍同時檢查兩邊，不假設它們相等。工作區已準備者包含 actual workspace roots/gitDir；尚未準備者沿用 project/worktrees/git-common conservative roots，不為 gate 建 workspace。
- instances：每輪使用現有 slot table；actual 的每個 slot 均納入 grant inventory，role enrollment 與 cap=1 不變；未知 enrolled baseline 仍 NO_BASELINE。fallback/tier：兩邊均跑既有逐候選檢查與 grant 收集，tier 不產生另一套配置。此片不新增每次 fallback 的磁碟掃描。
- call：`callGateVerdict` 不能只拿 agent。在 enrolled 分支先純計算 callId/callDir 與 `callProject(home, actualAgent, actualDir, callDir)`，傳 actual project；gate 後才 lock/mkdir/invoke。沿用同一 id 與 project 執行，不重新計算。fresh global call agent 使用 containment inventory 已解析的 `calls` 同 role 項目，加上 `agentPremiseChecks`；缺角色或 error 拒絕。以同一 actualDir/callDir 建 fresh callProject，與 actual 一起納入 executionProjects，覆蓋記憶體、sandbox.write、實際 --dir。call 無 verify；仍無 hash/requests 檢查。非 enrolled call 的路徑與 I/O 原樣不變。

**Rejected：** (a) verify 加入 hash：改 SnapshotInput 契約且沒涵蓋隊友 grants；(b) 只重驗 fresh：原缺陷；(c) 整個 project 深比較：納入非 premise 的無關差異，增加契約；(d) 執行 verify 時才重讀：改 spec 27 retained 設定語意、也晚於 enrolled wake；(e) call 解析與執行「同一瞬間」：兩次 I/O 間仍可能有磁碟變化，必須保留 actual binding。

### Bounded corrective slices / implementation-ready AC

兩個相依的小片；不承諾一片包辦（call actual cwd 與 retained union 需要介面接線）。node-engineer 依序實作，每片測試恢復綠燈才交付；cli-reviewer 做實作審查，不新增設計審查。以下不授權修改並行中的 recovery 修訂。

**C1 authority inventory：** allowed `src/doctor-approval-containment.ts`、新增 `test/approval-containment-grants.test.ts`。只加 options、共用收集 helper、grants-mode branch。AC：

- diagnostic 預設與現有 doctor tests/fixtures 不變；grants 模式不呼叫 aliasesBelow，對同專案／跨專案 depth-9、超過 walk cap、symlink 到 executors/config、dangling/cyclic descendant 均不產生 error。
- configured root 本身與其祖先 symlink 指向 protected、sandbox.write equal/ancestor/descendant、allowFiles、actual cwd、workspace gitDir、retained 隊友 grant 均 error。executor command 多 hop、中間 hop 目錄可寫、link/../x 既有拒絕保留。
- executionProjects 聯集測試：disk 安全 actual 不安全，以及 disk 不安全 actual 安全，都拒絕；config FIFO/oversize/root resolution failure 仍 error、不阻塞。doctor 不傳新 options 時逐字相容。

**C2 gate bindings：** allowed `src/approval-wake-gate.ts`、`src/run-session.ts`（只 gate deps 接線）、`src/call.ts`（僅 enrolled gate 前的純 binding 與傳參）、新 `test/approval-wake-gate-amend.test.ts`／call gate 新測試。AC：

- 原 DoS probes 改成正向測試：non-enrolled agent 合法 own-memory 深目錄或 executors/config alias，不影響 enrolled member 或 lead；lead 正常 done，不多 claim/attempt/refusal；跨專案同樣 wake。自己 memory 也不因任意後代產生新 grant。原 dangling control 保留。
- 原 P7 probe 改成成員從不 invoke、理由 project-premises、無 member claim/attempt；不得用「marker 必不出現」代替這項斷言，非 enrolled lead 的 verifier 仍屬既有未 gate 路徑。另測 fresh 新增 verify、actual retained verify 磁碟刪除、solo/resume、兩邊都是安全的控制組。
- actual 隊友 sandbox.write/grant 指向 requests/executor，磁碟移除後仍 refused containment；不要讓 snapshot mismatch 掩蓋它（變更非待喚醒 slot 的隊友）。actual fallback 的危險設定與 instance grants 都被檢查；rebind 後新的 this.project 真正傳入（spy 比對物件／欄位）。
- call 實際 --dir 若包含 executor 仍拒絕，雖然不與 home overlap；actual call retained grant 與 fresh repaired／fresh unsafe 兩方向都測；拒絕時無 lease、call 目錄或 invocation；其他專案 memory 深目錄不擋 call。
- default-off absent／empty allow：loadFreshView/containment 額外呼叫 0、fixtures 不改、side/log 不新增；status --json 不讀或輸出新資料。24 fixtures 原樣通過，含原 20 個 baseline。

兩片皆不得碰 policy/adapters、schema/config/run-store、mailbox、message-store/recovery、status、locks、manifest/lockfile、既有 fixture 內容；不修改既有測試來掩蓋相容性。測試以 temp home/repo、fake invoker、固定命名／注入 now、注入 sandbox availability；無 real claude/codex、無真實家目錄。時間不需等待、alias 不靠隨機數；I/O spy 檢查不遞迴 mutable descendants。qa 重跑原 probes 的新正向版與 root/hop 負向控制、完整四項 gate 命令，保留實際結尾；本設計沒有聲稱這些修補測試已通過。

**docs-writer：** 在 `docs/approval-store-api.md` 區分 doctor conservative alias diagnostic 與 wake grants validation；說明 actual+fresh、call cwd、仍未驗證的 Edit/Linux、非 enrolled verifier 不被此片停用。既有 status reason 格式與 JSON 規則不變；check:docs 必須通過。

### Dimension coverage（本修訂）

1. **Compatibility & Format：** 無新公開格式／schema／CLI；options 僅內部；舊 YAML/run/state 照舊載入、舊 binary 忽略既有 gate 側檔；default-off 零新增 gate I/O。R3 人類 status 既定 side-file open 例外保留，不宣稱整個人類 status 零 I/O。
2. **File & Process Safety：** 實際 grants canonical 雙向比較、root/ancestor/hop 保護與固定錯誤維持；mutable alias 非授權；沒有加權限、無新 child/injection surface；Edit/user-settings 缺口未解。
3. **Concurrency & Recovery：** current this.project 每 pass 取得，聯集不熱更新；既有 TOCTOU 未消除，未加鎖；no claim 前拒絕。crash mid-write、stale locks、Ctrl-C、timeout、partial mail、odd runtime exit 沿用 lifecycle/側檔 atomicWrite 與並行 recovery 修訂，本片不改。
4. **Platform & Operability：** Node >=20、TS ESM；沿用 package 0.42.1 的 commander ^14.0.3、yaml ^2.5.0、zod ^4.6.5、Vitest ^4.1.11、TS ^7.0.2、Biome ^2.5.15，實際版本依 lockfile；零新依賴。macOS/Linux，Windows 保留既有 unsupported 提示與拒絕，不新增支援。取消 gate 的 descendant walk，仍有全專案讀取與既有 git timeout，非全 home 固定時間保證。
5. **Testability & Maintainability：** 既有小型 containment 收集迴圈共用，無新 registry/owner abstraction；純 binding、fake invoker、temp I/O、current-project spy 為 seam。
6. **Observability & Diagnosability：** 不增 reason id，仍 project-premises/containment、log/mail/側檔與人類 status 固定類別；doctor 繼續能指出 alias 或實際設定的路徑。violations/state 不承擔新的記錄角色。
7. **Liveness / authority：** 不讓合法 mutable descendant 產生全域永久 refusal；實際 protected grant 則保留 refusal／lead_failed，安全性不以靜默略過錯誤換取。

### Risks / decisions made for the lead / open items

- **選擇 grants-mode 而非 full diagnostic 成為 wake 前提。** 這是對 O1/R5 的明確修正；不接受 agent-controlled cross-project refusal。替代 rejected：完整掃描一有 error 就永久拒絕。doctor 的額外保守 alias 警告可能與 wake verdict 不同，docs 必須解釋；不能再寫「doctor 任意 error 等價於 wake refusal」。
- **信任邊界假設：** canonical OS grant 才是 shell authority；任意 alias 不新增它。Claude Edit／Linux／user settings 實際效果未驗證；替代 rejected：從 adapter 輸出宣稱已證明所有 runtime enforcement。若安全複驗證明 tool alias 真的擴權，lead 應阻擋安全發布，不能以加回 DoS 掃描稱為修復。
- **未擴張範圍：** other-project mutable .git/config 信任、同 UID 祖先置換、gate→spawn/fallback TOCTOU、已列 O2–O5、stage-3 approve/executor 重驗仍未解；替代 rejected：此片重構 git inventory、鎖或熱載入。自己的 memory 內深目錄／alias 不再觸發 git inventory 差異；不主張消除所有可能的全域 DoS。
- **Retained verifier 不被關閉。** 此片保證 enrolled wake 被擋，不保證非 enrolled lead 不能執行既有 verify；替代 rejected：改 settle/verify 行為。actual+fresh 同時不安全仍使用既有固定 premise code。
- **Call binding 前移只限 enrolled 路徑。** 純 newRunId/callProject 不寫檔；替代 rejected：gate 後再生成不同 binding，或非 enrolled 增加 fresh I/O。
- **O6（stage-3 architect，預設不在本片實作）：** approve/執行前沿用哪種 containment diagnostic/authority contract 需明確另定，不可默認本片授權放寬 stage 3。
- **O7（lead/security，預設依上述兩片交 node-engineer，無新人工核准）：** 修補後獨立安全複驗與 QA 尚待執行；本設計重跑的是原缺陷，不是實作驗收。無其他阻擋設計的開放選項。


## Amendment B — K1 foreign inventory uncertainty（task 3330b976）

**Goal / disposition：** 保留 fail-closed，但把「已知前提不成立」與「無法建立外部專案 inventory」分開。此節取代 Amendment A 所有 inventory error 一律 sticky refusal 的敘述，以及其把 foreign config/git 風險完全留待後續的部分。C1 仍只交付 A 的 inventory API；以下 typed 分類與 gate 行為放 C2，不在並行的 C1 偷改語意。不增加設計／人工核准輪、不動產品碼。

**Evidence：** 已讀 `_shared/risk-review-full.md`、`risk/probes/risk-probe.test.ts` 與 `_shared/security-independent-recheck.txt`。2026-11-16 在 disposable archive 95f76cf `/private/tmp/claude-501/arch2b2.QIH1`，以臨時 HOME/AGENT_LYCEUM_HOME 重跑 `node node_modules/vitest/vitest.mjs run --configLoader runner test/risk-probe.test.ts -t R-XPROJ --reporter verbose`：`Test Files 1 passed (1); Tests 1 passed | 1 skipped (2)`，exit 0。輸出 `R-XPROJ woke=["lead","fe-member"] end=lead_failed`，側檔 lead 為 refused/PREMISE_FAILED。這重現修補前缺陷，不是 C2 成功證據。靜態鏈 `src/doctor-approval-containment.ts:409`（foreign YAML catch）及 :420–423（git catch）→ :312–313（error）→ `src/approval-wake-gate.ts:185` → `src/run-session.ts:744–747`；git timeout 5s 目前只靜態核對（containment :252），未以真實 timeout 重跑。

### B1 typed outcome — 不解析 DoctorCheck 文字

C2 在 containment 模組加內部型別與 options，範圍僅錯誤產生點的來源標記及聚合，不重構 git/inventory：

```ts
export type ContainmentDisposition = 'clear' | 'foreign-incomplete' | 'blocked';
// ApprovalContainmentOptions 新增：
// activeProject?: string | null; // grants mode: run 的專案名；call = null；未給則保守 blocked
// ApprovalInventory 新增：
// disposition?: ContainmentDisposition; // grants mode 必定給，diagnostic 不加欄位
// FreshView 新增必填 containment: ContainmentDisposition;
```

- **聚合優先序：** blocked > foreign-incomplete > clear。只要任何已知 protected overlap 或本地／共用硬失敗，foreign uncertainty 不得覆蓋它。讀取失敗後繼續比較已成功建立的 grants；不因第一個 foreign error 提早回傳，以免遮蔽真正 overlap。
- **blocked：** 任意專案／call／actual/fresh 的已解析 canonical grant 與 protected set 重疊；protected/executor/interpreter/hop 無法驗證；active project 或 actual/fresh executionProjects 的設定／grant／git 無法驗證；global config、project listing 等共用 inventory 失敗；已成功讀取的配置證明 executor allow 身分不存在。這些沿用 refused PREMISE_FAILED/containment。未分類例外與缺少 typed disposition 一律 blocked，不能當成 foreign-incomplete。
- **foreign-incomplete：** activeProject 已明確給定時，另一個 project entry 的型別／YAML 安全讀取／解析／merge 失敗，或該 foreign project 的 grant canonicalization／git common-dir 探測失敗，致 authority inventory 尚無法建立。每個錯誤在原始 catch/emit 點以 project name 或 execution-project source 判定，不能靠字串 stem、路徑 substring 或 message matching。call 的 activeProject=null，所有磁碟 project 是 foreign，但 actual call/executionProjects 與 global call library 的失敗仍 blocked。foreign git 非 checkout 的既有 undefined 不是 error；只有既有 helper throw 的情況才不完整。
- **無雙重升級：** 某 foreign project YAML 讀不出來時，後續 allow-reference validation 不得把同一「未知 agent 清單」又升為 blocked；只有成功 parse/resolve 後證實缺角色，或完整 projects listing 證實缺 project 才是既有硬錯誤。不完整 listing 本身是共用 blocked。可用本次掃描的 `Set<projectName>` 標示 failed foreign resolution；不用新 registry、持久檔或快取。
- **diagnostic 相容：** 保留現有 DoctorCheck 的 level/順序/文字及 sort/dedup；分類在 emit 點用固定內部 disposition 傳給累加器，最後只在 grants mode 回傳新欄位。diagnostic 預設不輸出新欄位；不改 doctor CLI，也不把 error 降 warn。

### B2 C2 gate integration / precedence

`loadFreshView` 以 activeProject=當前 run 專案名傳入 A1 的 grants-mode inventory；actual/fresh 都在 executionProjects。回傳 typed containment 並保持 `PremiseResult('containment').ok=false` 當 blocked **或** foreign-incomplete，只有 clear 是 true。未知絕不可被偽裝成通過。

`qualificationVerdict` 仍用既有 revalidateQualification，不改 approval-origin 或 SnapshotInput 契約。其 PREMISE_FAILED 在 hash 前回傳（`src/approval-origin.ts:108–123`），所以須明確補齊以下分支：

1. 缺 baseline、origin/path、allow/executor、agent、actual/fresh project-premises 錯誤、typed blocked：維持原 refused。已知不安全優先於 uncertainty。
2. 若 revalidateQualification 只因 containment foreign-incomplete 回 PREMISE_FAILED，暫存 unknown，**仍**對該 executor 的既有 SnapshotInput 呼叫 qualificationHash 比對 baseline（throw→固定 CONFIG_INVALID refused）；繼續檢查其他 executor 與集合增減。任何 hash/身分錯誤仍 refused，不得直接跳成 skipped 而遮蔽配置變更。其餘成功路徑不重算 hash。不要複製 hash 正規化演算法或把 false premise 改 true 呼叫 resolver。
3. 所有可確定的資格檢查通過，僅剩 foreign-incomplete 時回 `{kind:'skipped', code:'UNDETERMINABLE', premises:['containment']}`，否則 wake。這重用現有 code/premise id，不增加 public reason、schema 或 side-file 欄位。每 pass 新建的 view 重驗，不把 slot 加 this.refused，也不永久 quarantine。
4. enrolled call 同樣從 typed inventory 判定：blocked 拒絕；foreign-incomplete 回同一 skipped verdict，由 callAgent 的既有 non-wake 分支以固定 ConfigError 結束、無 lease/目錄/invoke。call 沒有 run-loop、自動重試或 side file；修好後使用者重下 call。actual/fresh agent checks 與 actual cwd/grants 都必須先確認，不能因 foreign-incomplete 被遮蔽。

### B3 truthful liveness / diagnostics

`src/run-session.ts:1548–1580` 每輪重設 gate pass；有其他可執行工作時，下一輪可在 foreign YAML/git 修復後清除 skipped 並喚醒。不增加 timer、poll/retry、睡眠或額外 round；沒有可執行工作時維持既有 idle（不是 lead_failed），原因側檔保留 skipped。idle 後修好需 resume；不是背景等待／保證自動恢復。enrolled lead 被 skipped 不寄自己、不設 lead_failed；其他成員可在原流程前進，但 lead 的 mail 可留到 resume。

- `GATE_TEXT.UNDETERMINABLE.mail` 改為一般固定文字：「Approval safety or output state could not be determined; this slot is not woken. Run doctor for containment diagnostics.」避免把 foreign inventory 說成 earlier output。status 的既有 generic approval-state text 與 class 足夠，不改 status 程式或 JSON。
- skipped 通知的 tail 改固定文字：「Rechecked on each dispatch pass that occurs. If the run ends idle, fix the cause and resume; no background retry is scheduled.」適用既有 skipped 路徑，取代目前 :752 保證原因消失就會自動喚醒的敘述。保留 unread mail，不通知做 gated 工作的替代繞路；此片只改時機敘述，不重設 mailbox 協定。
- log 使用既有 approval_gate、code=UNDETERMINABLE、class=skipped、premises=[containment]，不放 foreign path/parser/git stderr；doctor 仍提供檔案與設定定位。側檔不加欄位；人類 status 已顯示 skipped/時間，docs 必須解釋 idle 後 resume。diagnostic 寫入失敗仍不 invoke。

### C2 addition — acceptance tests / ownership / allowed files

在 A 的 C2 allowed 加 `src/doctor-approval-containment.ts`，只做 B1 累加器／來源分類；其餘仍限 `approval-wake-gate.ts`、RunSession gate/通知固定文字、call enrolled gate 接線及新測試。不得動並行 recovery、policy/adapters、approval-origin、verify/settle、schema/state、status、locks、dependencies、既有 fixture。node-engineer 等 C1 收集後依本節完成 C2；qa 獨立驗收，下列均須先失敗再成功：

- 新 `test/approval-containment-disposition.test.ts`：foreign invalid YAML→foreign-incomplete；repair→clear；foreign git helper throw（vi.mock child_process.execFileSync，僅命中指定 foreign cwd；不等 5s）→foreign-incomplete；active/actual git 同樣 throw→blocked。safe/safe 控制 clear；任何 foreign actual canonical overlap→blocked；unknown+overlap 混合→blocked。diagnostic 原文字／順序不變。foreign root canonical error 為 unknown，protected canonical error 為 blocked。
- 新 `test/approval-wake-gate-foreign-inventory.test.ts` 用 temp home/repo、fake invoker、固定事件順序：lead 先排兩個獨立 non-enrolled 工作，其中第一個製造 foreign invalid YAML、第二個健康 wake 修復；中間 gate 必 skipped（lead 無新增 claim/attempt/invoke，側檔 class=skipped），再下一 pass lead 成功 wake、skipped 清除、不 sticky refused。用固定不同 subject 避免 duplicate-mail artifact；不要靠 setTimeout/fs race。
- enrolled lead 已無其他可執行工作且 foreign 仍壞：run idle、未 lead_failed，mail 保留、round 不因 blocked pass 增加；repair 後 resume 能 invoke。測試必分辨「between-pass repair」與「idle 後 resume」，不能只斷言最終有 wake。
- 混合控制：foreign YAML/git unknown 同時 actual/fresh 有 unsafe protected grant、verify 或 snapshot 差異，必 refused 而非 skipped；同一專案 unsafe grant 的已知負向控制仍 sticky，enrolled lead 仍 lead_failed。foreign repaired 不能擦掉先前真正 refused。
- call：foreign unknown 無 lease/call-dir/invoke，repair 後重下成功；實際 cwd/protected overlap 優先 blocked；default-off spy 無新增 I/O。status --json、24 fixtures 原樣；sentinel 診斷不洩漏 parser/path/stderr。

時間由既有 now seam 控制，git 失敗只 mock 不執行 runtime；所有檔案限 temp home/repo。qa 跑四項 gate `npm run lint && npm run typecheck && npm test && npm run check:docs` 並保存結尾與沙盒限制；本次只驗證原 R-XPROJ。docs-writer 在 API wake-gate 區補 proven-failure/unknown、blocked precedence、call 重下、idle/resume 與 doctor 差異；不改 README/JSON。

### P7 expectation — enrolled boundary, not unrelated verifier shutdown

確認 security-reviewer 的必要 AC 是「unsafe retained verify 存在時，不 invoke enrolled slot，無該次 claim/attempt」。不能要求所有 marker 消失：`src/run-session.ts:1204–1205` 在合規 completed done 上依 retained project.verify 執行，:1302–1311 明確保留 initial settings，`src/verify.ts:51` 為 shell；non-enrolled lead 不進 gate（`src/run-session.ts:776`）。原 probe 的 marker 證明原 bypass，但修補後獨立 non-enrolled lead 仍可能送 completed done 並觸發既有 verify。新增測試分兩項：P7 拒絕 enrolled/no claim；另由 non-enrolled lead 獨立送 done 的控制測試允許既有 verifier 執行 inert marker。不得改 verify、settle、done 路由或禁用無關 verify 來滿足錯誤 marker AC。這不是完整 sandbox 安全保證。

### Dimension coverage / risks / open items（本修訂）

1. **Compatibility & Format：** 只新增內部 typed outcome，diagnostic 預設無新欄位；持久格式、reason id、YAML/state/mailbox/CLI/JSON 不變，舊 binary 與舊 run 照 A。default-off 不建 gate、無新增 I/O（R3 人類 status 例外仍在）。
2. **File & Process Safety：** unknown 從不 claim/invoke；proven overlap 與 protected/hop failure 仍 blocked；未新增寫入授權、OS/tool enforcement 或 post-hoc 假保證。
3. **Concurrency & Recovery：** pass 才重驗、無 timer；暫時失敗可導致 idle，resume 才重啟。crash/atomic 側檔/stale locks/Ctrl-C/timeout/partial mail/odd CLI exit 沿用 A 與既有 lifecycle，未知不增加 attempt；未解 TOCTOU。
4. **Platform & Operability：** 沿用 A 的 Node/TS/libraries/versions，無新依賴；macOS/Linux、Windows 既有拒絕／警示不變；git timeout 不變，型別分類無第二次掃描。真 git timeout、Linux/real runtime 未驗證。
5. **Testability & Maintainability：** emit-site enum + 聚合，非訊息解析；existing fake invoker/now 與 execFileSync mock；不建立 owner registry/跨 pass 快取。
6. **Observability & Diagnosability：** skipped UNDETERMINABLE + containment log、側檔、人類 status、doctor 詳細定位；固定訊息說清 idle/resume。state/violations 不添角色、不漏解析訊息。
7. **Liveness：** 選擇安全的暫停而非成功；另一專案可持續造成 denial/idle，這個剩餘 availability impact 無法在未知 authority 時安全地完全消除。

**Risks / decisions made for lead：** 選 foreign-incomplete 暫停而非 sticky refusal（拒絕替代：一個半寫 YAML 永久終止 enrolled lead）；保留已知不安全優先（拒絕替代：unknown 遮蔽 unsafe）；只把可具名 foreign project 的未知當暫時，共用/local/protected/未分類仍硬拒絕（拒絕替代：任何 exception 都 skipped）；重用 UNDETERMINABLE 與 generic text（拒絕替代：新 public reason/format）；接受 idle 後需 resume（拒絕替代：增加 watcher/backoff、或聲稱背景自動恢復）。這是對原任務「前提失敗 refused」的限縮解讀：證實失敗仍 refused，foreign evidence unavailable 是無法判定，不是前提已成立。diagnostic doctor 仍 error，文件不能等同所有 doctor error 的 sticky 語意。

**Open items：** O8（lead/risk，預設採本節交 C2）：持續 foreign failure 仍可能讓 run idle；安全不允許在未知全域 authority 時繼續 enrolled wake，不能承諾完全排除此 DoS。無新增人工核准；修補證據由既有 cli-reviewer、安全複驗與 qa 驗證。O6/O7 及先前 real-runtime/user-settings/stage-3 blockers 保留，不由本節解除。
