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
