# Approval stage 3 Implementation Plan

> **For agentic workers:** 依 mail team 流程由 node-engineer 逐片實作，cli-reviewer 對照本契約審查（含跨 runtime 安全審查）。本版已吸收唯一一次獨立設計審查（M1/M2/M3/m1），不再另開設計審查。不得 commit、push、PR、merge；本文件不代表實作已通過驗證。

**Goal:** 完成 v12/v12.1 §10 第 3 項：claim wake 的 proposals 輪替、收走、park 與 recovery；全程 DEFAULT-OFF。

**Architecture:** 重用 approval store 的來源鍵、link 提交、狀態、高水位與 gate；新增小型同步 rotation/collection 模組，純解析與 I/O 分離，所有收走 I/O 經「有限工作預算」包裝。失敗只暫停該 slot，不能丟棄請求來換取 wake，也不能阻擋郵件 commit。

**Tech Stack:** package 0.42.2；Node >=20、TypeScript ESM/NodeNext/ES2022，Node fs/crypto。宣告版本 commander ^14.0.3、yaml ^2.5.0、zod ^4.6.5、Vitest ^4.1.11、TS ^7.0.2、Biome ^2.5.15（`package.json:3,34,53`、`tsconfig.json:3`）；依現有 lockfile，不升級、不新增依賴。

**Spec:** [approval gate v12/v12.1](../specs/2026-11-13-approval-gate-design.md) §4.1/4.3/4.4/4.5/4.8/5/10；沿用 [stage 1](2026-11-14-approval-store-stage1.md)、[2b-1](2026-11-14-approval-stage2b1.md)、[2b-2 含 Amendments A/B](2026-11-16-approval-stage2b2.md)。

## Global constraints / 發布邊界

- 不改 `.strict()` schema、project/team YAML、run `state.json`、`approval-gate.json` v1 格式、mail/journal 協定、CLI、call、verify、tidy、format、executor runner、feedback、gc CLI；不做 stage 4+。舊格式繼續載入，不遷移；既有 v1 approval 格式不變。舊 binary 忽略新增的 requests/approvals 子項與 `.coord/`；舊 gate reader 仍讀得既有 reason codes。
- **非可發布：第 0 步未驗證。** F3 user settings、Linux 與真機「不能寫 approvals／別人的 proposals」皆未驗證；fake runtime 不證明 OS/tool enforcement。只承諾 process crash，不承諾斷電、同 UID 祖先置換、逃逸背景程序已停止或讀取隔離。
- 所有測試用 temp `AGENT_LYCEUM_HOME`、scratch repo、fake invoker；不讀真實 home、claude/codex、不做真 sandbox 實驗。

## 相容基準與切片前進規則（M3）

- **不動：** `--fork-session`（`src/adapters/claude.ts:109`，1c4b433 的 session 保護）、`test/approval-compat.test.ts` 與 `test/fixtures/approval-compat/**`（f4936b0 凍結）。不 normalize、不重生、不移除旗標、不改歷史測試。其三個 run-time 場景（`no-file`／`empty-allow`／`other-tuples` … `match f4936b0`）在 stage 3 前已紅（`_shared/baseline-reply.md:54-56`；診斷 ce98fe60 §1），維持紅、具名列出。
- **基準來源身分：** `BASE=734e64d`，tree `8cd2c493306ccbd90b9c70a37d8beb614c8dce88`、`src` tree `80b7df22…`、`test` tree `6790b6f3…`。S1 開工前必須 `git diff --quiet 734e64d HEAD -- src test scripts plugins package.json package-lock.json tsconfig.json` exit 0（本版撰寫時已跑，diffstat 空）；否則停下回報 lead，不得改用別的基準。
- **基準缺陷清單（預存紅，名稱以 baseline-reply.md:54-63 為準）：** approval-compat ×3、`cli.test.ts` watch ×1、`process-runner.test.ts` ×4、`run-lifecycle.test.ts` ×1、`web-api.test.ts` 413 ×1，加 1 unhandled error。stage 3 不修它們。
- **零差異測試（新，S1 第一步、只動 test）：** 新 `test/approval-stage3-baseline.test.ts`＋`test/fixtures/approval-stage3-baseline/`。沿用 approval-compat 的 `fixture()` 慣例：只把 disposable root 換成 `<ROOT>`；不得改 args/flags/順序/訊息。場景：no-file、empty-allow、other-tuples 三種 executors 狀態 ×（project lead/member/qa、solo、call）× normal/session/worktree/policy 變體的 Claude/Codex invocation（cmd/args/stdin/cwd/env/settingsRaw）、prompts、writePolicy/enforcementFor/protectedPathsFor；再加一個 fake-runtime 完整 run（worktree 模式，lead+member，各一封 mail，含 resume）後的 home 磁碟樹（相對路徑＋型別＋權限位，不含內容）與 `status`、`status --json` bytes。時間用 `vi.useFakeTimers({ now: 固定值, toFake: ["Date"] })`；run id、claim/attempt id、pid 用固定替換表（只換 `state.json`/status 中這些值本身），規則寫在測試檔頂並對 baseline 與現行碼完全相同。
- **擷取方式（可重現、不引入 stage 3 期望）：** `B=$(mktemp -d); git archive 734e64d | tar -x -C "$B"; ln -s "$PWD/node_modules" "$B/node_modules"; cp test/approval-stage3-baseline.test.ts "$B/test/"; (cd "$B" && UPDATE_STAGE3_BASELINE_FIXTURES=1 npx vitest run test/approval-stage3-baseline.test.ts --configLoader runner)`；再把 `$B/test/fixtures/approval-stage3-baseline/` 複製回來，並寫 `SOURCE.txt`（BASE commit/tree、node/vitest 版本、每檔 sha256、上列指令）。測試檔只 import 734e64d 已存在的 API，沒有任何字面期望值；不帶旗標時只比較。fixtures 一經提交即凍結，後續 slice 不得重生；若 baseline 本身在此環境跑不動（例如 listen EPERM），記錄失敗並回報 lead，不得改用現行碼產生。
- **切片前進（只代表可繼續實作）：** (a) 本片新測試全綠；(b) `npm run typecheck` exit 0；(c) `test/approval-stage3-baseline.test.ts` 全綠；(d) 本片允許清單內既有測試檔以 `npx vitest run <files> --reporter=json --outputFile="$TMPDIR/<slice>.json"` 跑，失敗名稱集合 ⊆ 上列基準缺陷清單（新增任何失敗即停、先診斷）。歷史紅測試照樣執行、照樣紅、具名列在每片回報。
- **不豁免：** 使用者「全部既有測試不修改且全綠」的驗收仍 **UNMET**；本規則不授權宣稱完成。最後仍跑完整 `npm run lint && npm run typecheck && npm test && npm run check:docs`，列出所有失敗（含預存者），由 lead／使用者決定歷史 delta。

## 決策（lead 記錄後交實作）

1. **D1 — reader：** 真 API 在 `src/fs-util.ts:97–116`；只在成功分支加 `ino:number, dev:number, mtimeMs:number`，原 buf/size/truncated 與拒絕語意不變。`test/approval-rotation.test.ts:10` 的「零 runtime exports」階段性斷言只改這一項，保留型別與非法 destination 檢查。拒絕另寫 reader。
2. **D2 — coordination：** canonical slot root 下 `.coord/` 獨佔 `mkdirSync(0700)`，整個同步操作持有；EEXIST／非真目錄即暫停該 slot（不等、不依 mtime/PID 偷鎖）。正常 finally 只 rmdir 自己建立的空鎖；crash 遺留需操作者停掉所有相關 dispatcher 後手動移除。拒絕 in-process mutex 與自動 stale takeover。future `requests gc` 必須同用此鎖（含 orphan/call root），從選 target 至 high-water 對齊、rename→刪目錄→刪 done 全程持鎖；不用於 record/state CAS。
3. **D3（取代舊版）— 有限工作預算、超出即 fail-closed（M2）：** 見下節。拒絕舊版「串流全部子項」：O(N) 同步工作可讓單一 slot 卡住整個 dispatcher。
4. **D4 — slot recovery error 不可先推進 claim：** 新 hook 失敗時跳過該 slot 後續 recovery/collection/wake，保留該 claim/attempt 原狀。拒絕 catch 後仍 save abandoned。hook 不存在時走原流程。
5. **D5 — race 與 I/O 不是 agent denied：** inode 不符、ENOENT、EACCES 等：本 pass 不提交該筆、不寫該目錄 done、slot skipped，下一 pass 重讀；已證明 symlink/FIFO/dir 才 `not_regular` denied。
6. **D6 — status 不擴 schema：** GateFile 嚴格 v1 不動（`src/approval-wake-gate.ts:251–271`）。人類 formatter 在 gate side file 存在時以 store reader 即時計算本 run 已提交 record 數（含 denied），標示「已收錄請求記錄 N（含拒收）」；讀不到顯示固定「計數無法判定」。這個 reader 同樣走預算包裝；超出顯示「計數無法判定」。
7. **D7（取代舊版）— grant 快照的精確對應（M1）：** 見下節。
8. **D8 — hard-link probe：** enrolled-only scratch probe（doctor 在既有 approvals/requests 真目錄或最近真祖先；collection 在實際 approvals 與 slot root 亦驗）。O_EXCL 建立、link 第二唯一名、只 unlink 自己建立者；任何錯誤回固定 `unsupported`／`io` 類別。default-off 零 probe。
9. **D9（m1）— 固定診斷類別：** 見「Observability」節。

### D3：掃描工作預算（M2）

- 新 `src/approval-budget.ts`：
  - `export const SCAN_WORK_BUDGET = 65_536;`（每 slot 每 pass）。偏離 lead 建議的 32768：使用者要求的 20000 項測試需 20000×(1 dirent＋1 lstat)=40000 單位才能在預算內得到精確排序與 ignored_count；32768 會讓該測試必然溢出。拒絕「32768 且 20000 項斷言溢出」（違背原驗收的 scan_limit 聚合記錄）。
  - `export class ScanBudgetExceeded extends Error { readonly op: CollectOp }`（非 ApprovalError，只在 collector 內捕捉）。
  - `export interface ScanBudget { readonly limit: number; used: number; op: CollectOp; spend(n?: number): void }`、`export function scanBudget(limit?: number): ScanBudget`。
  - `export type DirIo = ApprovalIo & Pick<typeof fs, "opendirSync" | "rmdirSync">;`
  - `export function budgetedIo(base: DirIo, budget: ScanBudget): DirIo`：每個 fs 呼叫先 `spend(1)`；`readdirSync` 改為 `opendirSync`＋逐筆 `readSync`，每筆 `spend(1)`，**永不呼叫 base.readdirSync**，結束必 `closeSync`。stage-1 的 `listCommittedIds`／`readCurrent`／`readHighWater`／`maxCollectedSequence`／`publishRecord`／`publishExclusive`／`advanceHighWater` 已接受 `io` 參數，因此不改它們就被限界（`src/approval-store.ts:47-55`、`src/approval-state.ts:56-65`、`src/approval-high-water.ts:79,101`）。
- **計價：** 合法檔名的直接子項 = 1 dirent＋1 lstat；不合法檔名 = 1 dirent（不 lstat、不記錄、不計入 cap 與 ignored_count）；其餘每次 fs 呼叫 1。記憶體：選取集合 ≤ `max_scan_entries`（以 `(mtimeMs, UTF-8 name bytes)` 的 bounded max-heap），任何名稱陣列 ≤ 預算。
- **pass 順序（持 `.coord/`）：** 讀 high-water（損毀→DIR_ANOMALY）→ link probe → 列 `collected/`（數字升序 un-done）→ 每個 un-done 目錄：完整列舉＋lstat 合法候選 → 列舉完成後才全體排序、取前 cap、`ignored_count = 候選總數 − cap`（精確）→ 逐筆讀檔／分類／發佈 → `.done`；再旋轉本次成功輸出並同樣處理。配額 inventory 延遲到第一筆通過 executor 允許檢查的有效請求才建立，同一 pass 內只建一次並以本 pass 發佈數遞增。
- **溢出（任一階段 `ScanBudgetExceeded`）：** 立即停止此 slot：不寫任何 `.done`、不寫 scan_limit、不估 ignored_count、不刪不搬任何 bytes；本 pass 已發佈的 record 保留（deterministic id，重入採用）。verdict：列舉／處理階段→`skipped RESIDUAL_OUTPUT`；inventory 階段→`skipped UNDETERMINABLE`（拒收而不猜配額）。log `approval_collect {slot, op, class:"budget", seq?}`。釋放 `.coord/`，迴圈繼續下一個 slot。
- **取消與重入：** pass 同步不可中斷，只保證有限 fs 呼叫次數，**不保證 wall-clock**（單一 fs 呼叫在掛住的檔案系統上可無限期阻塞）。settle 與 pre-wake 迴圈在每個 slot 之前檢查 `opts.signal?.aborted`，已取消則剩餘 slot 不收走（log `class:"cancelled"`），commitClaim 照常；未完成目錄留待下次 settle／resume。重入安全來自：done 只在完整處理後寫、id 決定性、seq 只增、record 不覆寫。
- **飢餓取捨（明列）：** 單一 `collected/<seq>` 超過預算或持續被改動，該 slot 會一直被跳過、永不 wake，直到操作者介入：停掉此 project 所有 run，檢查該 slot 的 `collected/<seq>/`，把不要的檔搬到 approval home 之外，再 `resume`。store record 數使 inventory 超出預算時，同樣阻擋所有 enrolled slot 的收走，直到 gc（stage 5/6）存在；stage 3 不提供自動解法。拒絕自動丟棄／部分標 done（會遺失請求）。

### D7：session project、實際 invocation 與 unbound 的精確對應（M1）

- **事實：** gate baseline 用 session project（`bindRunProject` 只綁 memory.task 與 mailboxes，`src/run-store.ts:336-347`；`baselineFor(project,…)`，`src/run-session.ts:698`）；實際 wake 的 `aproject` 才加 `workspaces`（`src/run-session.ts:866-868`），adapter 以它呼叫 `writePolicy`（`src/adapters/claude.ts:37,89`、`codex.ts:11`），於是多出 `ws.gitDir`，而 `repoInstructionFiles` 變成 lead 工作樹的 `CLAUDE.md`/`AGENTS.md`（`src/policy.ts:61-64,178,190,202`）。現行 `origin.full_writable` 是 static set（`src/approval-wake-gate.ts:106-113`），不是實際 grant。
- **policy 共用組裝：** `src/policy.ts` 新 `export type GrantSource = "memory-global" | "memory-project" | "memory-task" | "outbox" | "git-dir" | "shared" | "records" | "own-dir" | "sandbox-write" | "common-file" | "shared-index" | "agent-md" | "repo-instruction" | "proposals"`、`export interface GrantEntry { kind: "dir" | "file"; path: string; source: GrantSource }`、`export function grantEntries(project: ResolvedProject, agent: ResolvedAgent, requestDir?: string): GrantEntry[]`。它只組 allow 項、不做 deny／approval I/O。writePolicy 的 allowDirs/allowFiles 改為由它依原順序 map 出來（proposals 只在第三參數存在時附在 allowDirs 最後）；`writePolicy(project, agent, requestDir?: string)`。default-off 時不傳第三參數 → 同 bytes（由零差異測試證明）。
- **新 `src/approval-snapshot.ts`：**
  - `export const RUN_ONLY_SOURCES: ReadonlySet<GrantSource>` = memory-task、outbox、git-dir、shared、shared-index、proposals。
  - `export function slotGrants(project: ResolvedProject, agent: ResolvedAgent, requestDir?: string): { full: WritableSet; grant: GrantInput }`：
    - `full` = 所有 entry 的 canonical path（sorted unique）—即 adapter 實際拿到的 allowDirs/allowFiles。
    - `grant.effective` = 同一批 entry，但 `repo-instruction` 一律改寫成**邏輯路徑** `canonicalPath(path.join(project.dir, path.basename(entry.path)))`（在 canonicalize 之前以來源判斷，不以字串前綴猜）；沒有 lead workspace 時就是原路徑，因此與 unbound 投影一致。
    - `grant.run_only` = 來源屬 RUN_ONLY_SOURCES 的 canonical path。
    - `grant.static_duplicates` = 來源**不**屬 RUN_ONLY 且 canonical path ∈ run_only 的 path（例：`sandbox.write` 明列了某 run-only 路徑）。一個 path 只有在「所有來源都是 run-only」時才被扣除。
  - `export function snapshotInputs(project: ResolvedProject, slot: string, config: ExecutorsConfig, requestDir?: string): { full: WritableSet; inputs: Map<string, SnapshotInput> }`：用 `staticWritable(grant)` 作 `writable`，其餘欄位同現行 `slotSnapshotInputs`（`src/approval-wake-gate.ts:75-104`）；`slotSnapshotInputs` 簽名不變、改成呼叫它並丟棄 `full`；`baselineFor` 的 `origin.full_writable` 改為 `full`。
  - `export function unboundSnapshotInputs(unbound: ResolvedProject, slot: string, config: ExecutorsConfig, instances: InstanceTable | undefined, mode: "normal" | "solo"): Map<string, SnapshotInput>`：`bindRunProject(mode === "solo" ? soloProject(unbound, slot) : unbound, path.join(unbound.paths.runs, ".approval-virtual-run"), "run", instances)` 後呼叫 `snapshotInputs`；純計算，不建目錄、不讀原 run。這是 O5 approve resolver 的唯一建構方式（approve 本身不實作）。
- **對應規則：** hash 一律來自 `staticWritable(grant)`；session project（gate）、實際 invocation project（收走）、unbound 虛擬綁定（未來 approve）三者在 run-only 扣除與邏輯指令檔改寫後必須得到相同 hash。`origin.full_writable` = 收走那一刻 `slotGrants(invocationProject, agent, canonicalProposals).full`，其中 `invocationProject` 由新私有方法 `RunSession.invocationProject(): ResolvedProject` 產生，wake() 與收走共用（即現行 `:866-868` 的 spaces 組合）。一般路徑（wake 後同一 settle）＝ adapter 實際 grant；crash/resume 重入時是「收走當時」的 grant（spec §4.4 原文「收走當時的完整可寫集合」，只供顯示，不參與比對）。不新增持久欄位。
- 拒絕：只用 session project（漏實際 grant）；用實際 project 做字串前綴扣除（工作樹指令檔被當 static，clear 後無法重建）；持久化 wake 時 grant（新格式）。

### O5 / O6 / F3（可直接貼 decision record）

- **O5：** record 存既有 qualification.sha256/premises、origin（canonical project_dir、role、run_id、`full_writable`＝實際 grant）與 proposer.slot；不增格式。approve resolver 只能以 `unboundSnapshotInputs` 分別重建 normal 與 solo（solo 會改 lead/canEditAgentMd，`src/solo.ts:15-23`），instance 以 `role--k` 合成 `InstanceTable`；只接受與存入 hash 完全一致的候選，無匹配即拒。拒絕信任 `full_writable` 作 authority。
- **O6：** wake/collection 沿用 Amendment A/B grants-mode（actual+fresh grants、blocked 優先、foreign-incomplete skipped）。未來 approve/execute 需重新跑完整 grants authority；doctor diagnostic alias scan 只展示，不代替 authority。本階段只記錄契約。
- **F3：** 保留 `ENROLLED_SETTING_SOURCES="user"`（`src/adapters/claude.ts:13`），不加部分 whitelist、不改 user 檔；docs/最終報告固定「非可發布：第 0 步未驗證」，F3 由 lead/security＋使用者真機驗證，預設阻擋發布。

## Observability（m1 / D9）

- log `approval_collect` 欄位只允許 `{slot, op, class, seq?, id?, count?}`。`op` 固定：`coord`、`high_water`、`link_probe`、`rotate`、`park`、`list`、`scan`、`read`、`publish`、`done`、`inventory`、`counter`、`pass`。`class` 固定：`held`（`.coord` 已存在）、`not_directory`、`symlink`、`missing`、`corrupt`（high-water/counter/record 不可解析）、`unsupported`（ENOTSUP/EOPNOTSUPP/EXDEV/ENOSYS/EPERM 於 link）、`permission`（EACCES/EPERM 其他）、`race`（inode 不符／中途 ENOENT）、`mismatch`（既有 payload 不同）、`budget`、`cancelled`、`io`（其他 errno）。errno→class 為固定表；未列者一律 `io`。不得寫 raw path、errno 訊息、檔名、summary 或 payload。這只是 log 字串，不是新 schema/enum。
- `GATE_TEXT.DIR_ANOMALY` 改為不暗示只有 symlink 的固定文字（既有測試以常數引用，`test/approval-gate-status.test.ts:86`）：
  - status：`request area needs repair: see log.jsonl "approval_collect" class (symlink/not_directory: make proposals/ and collected/ plain dirs; corrupt: fix collected.seq; held: stop all runs, then remove a stale .coord/; unsupported: use a filesystem with hard links)`
  - mail：`This agent's approval request area needs repair (unsafe directory, unreadable collected.seq, a held .coord lock, or no hard-link support), so it is not woken until that is fixed. See the approval_collect entries in log.jsonl.`
- docs 為每個 class 給處置步驟；`.coord` 移除前必須確認沒有存活的 run/gc。doctor 的 link probe 失敗以既有 premise 形式顯示固定類別。

## Interfaces / module boundaries

- `src/approval-link-check.ts`：`checkApprovalLinks(home: string, dir: string, deps?: { io?: DirIo; token?: () => string }): void`；失敗 throw `ApprovalError`，診斷只用固定類別；Windows 不 probe、回 unsupported。
- `src/approval-rotation.ts`：實作既有 `Rotate`/`Park`/`ProposalsOf`（簽名不變）。`createRotation(deps: RotationDeps): { rotate: Rotate; park: Park; withSlotCoord<T>(home: string, slot: SlotRef, fn: () => T): T }`；`RotationDeps = { io?: DirIo; fault?: (point: string) => void }`；production exports 綁預設。rotate 不分配 seq、不寫 done、呼叫者持鎖；park 自己持鎖後呼叫 rotate。
- `src/approval-request.ts`：`parseRequest(bytes: Buffer, config: ExecutorsConfig): { kind: "valid"; executor: string; summary: string | null; payload: Buffer } | { kind: "denied"; reason: DeniedReason }`，純函式。
- `src/approval-collect.ts`：
  - `interface CollectInput { home: string; slot: SlotRef; agent: string; runDir: string; config: ExecutorsConfig; origin: Origin; inputs: ReadonlyMap<string, SnapshotInput>; premises: readonly PremiseResult[]; current?: { attemptId: string; outcome: "collect" | "park" } }`
  - `interface CollectDeps { io: DirIo; budget: number; now: () => Date; token: () => string; actor: () => Actor; probe: CreatorProbe; fault: (point: string) => void; log: (event: "approval_collect", fields: CollectLog) => void }`；production `budget = SCAN_WORK_BUDGET`。
  - `collectSlot(input, deps): CollectResult`，`CollectResult = { created: number; existing: number; denied: number; verdict: GateVerdict }`；`prepareSlot(input, deps): CollectResult & { proposals?: string }`（成功時保證 proposals 存在、空、canonical）。兩者共用核心、各建一個新 `scanBudget(deps.budget)`；任何未預期 throw 轉成 `skipped UNDETERMINABLE`，不外拋。
- `GateDeps.slotDir(slot): GateVerdict` 簽名不變；RunSession closure 呼叫 `prepareSlot`，成功的 proposals 暫存 session map。`WakeInput.requestDir?: string`（內部欄位）；policy wakes、call、非 enrolled 必不帶。`buildClaudeSettings` 尾端新增 optional `requestDir`。不可借 `WakeInput.policy`（會改 cwd，`src/adapters/types.ts:23–29`、`src/adapters/claude.ts:83–89`）。Codex 維持 enrolled refusal。
- `src/message-store.ts`：新 `export function finishLoadedAttempt(runDir: string, rec: AttemptRecord, status: Exclude<AttemptStatus, "started">, extra?: { error?: string; parked?: string[] }): AttemptRecord`（不 `loadAttempt`）；`finishAttempt` 改為 `finishLoadedAttempt(runDir, loadAttempt(runDir, id), …)`，寫出 bytes 不變。`recoverRunMail` opts 新增 `proposalsOf?: ProposalsOf; parkProposals?: (agent: string, attemptId: string, canonicalProposals: string) => void; onProposalsError?: (agent: string) => void`。**現行 `finishAttempt` 會重新讀檔（`:422-423`），所以 `opts.readFile` 存在（scan-verified 路徑）時，recovery 必須改用 `finishLoadedAttempt(runDir, a, …)`，以 listAttempts 回傳的已驗證紀錄為準，不得 reopen**；無 `readFile` 時維持原 `finishAttempt` 呼叫。

## S1 — 基準擷取、rotation、coordination、high-water、reader、budget（serial）

**可改：** 新 `test/approval-stage3-baseline.test.ts`＋`test/fixtures/approval-stage3-baseline/**`（只在本片第一步、改 src 之前建立）；`src/approval-rotation.ts`、`src/fs-util.ts`、新 `src/approval-link-check.ts`、新 `src/approval-budget.ts`；`src/approval-high-water.ts` 只補註解；`test/approval-rotation.test.ts`、`test/approval-high-water.test.ts`、新 `test/approval-rotation-crash.test.ts`、`test/approval-capped-read.test.ts`、`test/approval-budget.test.ts`。**不可動：** 其他 src、schema、`test/approval-compat.test.ts`、`test/fixtures/approval-compat/**`、manifest、依賴。

- [ ] 第一步：依 M3 節擷取 baseline fixtures，提交前 `SOURCE.txt` 完整；現行碼跑該測試全綠（此時 src 未改，應零差異）。
- [ ] 先紅後綠：`empty reentry never touches existing parked destination`、`missing proposals rebuilt 0700`、`symlink/file/FIFO ancestor suspends only own slot`、`corrupt high-water blocks even empty wake`、`link probe cleanup and unsupported fail closed`、`numeric seq 10 beats 2 and done-only names`、`coord overlap and stale coord refuse without steal`、`capped reader returns fstat dev/ino without changing bytes`、`budgetedIo never calls readdirSync and counts one unit per entry`、`budget overflow throws ScanBudgetExceeded and closes the dir`、`SCAN_WORK_BUDGET is 65536`。
- [ ] rotate：lstat slot/proposals，缺 proposals 重建；非空才 rename，destination 必不存在；recreate 0700 再 lstat；park 的 attempt id 過 `approvalSourceId`。收走端在鎖內：readHighWater（損毀即拒）→舊 un-done→非空才 `nextCollectedSequence`→rotate→`advanceHighWater`。
- [ ] 驗證：`npm run typecheck && npx vitest run test/approval-stage3-baseline.test.ts test/approval-rotation.test.ts test/approval-rotation-crash.test.ts test/approval-capped-read.test.ts test/approval-high-water.test.ts test/approval-budget.test.ts`＋M3 (d)。AC：空目錄無新 seq、重入不遺失／不重用 seq；兩個 process 同 slot 只一個進 critical section。

## S2 — collection core（S1 後 serial）

**可改：** 新 `src/approval-request.ts`、`src/approval-collect.ts`；新 `test/approval-request.test.ts`、`test/approval-collect.test.ts`、`test/approval-collect-crash.test.ts`、`test/approval-collect-race.test.ts`、`test/approval-collect-budget.test.ts`。**不可動：** store/state/id/schema、gate/session/prompt/adapters/status/policy、所有 fixtures。

- [ ] `header and whitelist table`：檔名 `^[A-Za-z0-9._-]{1,64}\.req$` 且不以 `.` 開頭；全檔 fatal UTF-8；Cc 僅 LF/TAB；Cf、非 U+0020/U+3000 的 Zs、Zl/Zp、variation selector、Default_Ignorable_Code_Point 與 spec 額外六個外觀空白全拒。ESC、CR、DEL、bidi、ZWJ、NBSP、U+3164、VS16 拒；U+3000 允許；絕不 sanitize。
- [ ] header 以第一個 `\n\n` 切，最多兩行 `key: value`，key 僅 executor/summary 各一次；summary 選填 ≤300 code points；executor 必填且已註冊；header ≤2048 bytes 含分隔；全域讀 cap 65536+2048=67584（size/truncated 雙檢）→ whitelist → header 形狀 → executor → executor `max_payload_bytes`。壞 header 優先於缺 executor。無 YAML；hash 與複本取自同一 Buffer。
- [ ] `outcome table all rows`：ignore／not_regular／too_large／bad_content／bad_executor／bad_header／not_allowed／quota／scan_limit 各斷言 SourceKey variant 與 disposition/reason；目錄異常與前提 false 不 rotate、不 done、不 denied；有效→pending＋資格快照。
- [ ] `replay adopts executed record`、`payload mismatch leaves incomplete`、`two publishers one link wins`、`quota includes executing unknown but not computed expired`、`denied cap 100 and approximate counter`（`.denied-count/`，十進位＋LF，temp+rename，損毀不當 0、不 done）：沿用舊版契約，不改 store。
- [ ] `test/approval-collect-budget.test.ts`（M2）：
  - `20000 valid entries within default budget`：預設預算，選前 200、一筆 scan_limit、`ignored_count === 19800`、done 寫入，並以計數 io 斷言用量 < 65536。
  - `beyond budget leaves slot untouched`：注入 `budget` 使列舉中途溢出；斷言無 done、無 scan_limit、所有檔案 bytes 與 inode 不變、verdict `skipped RESIDUAL_OUTPUT`、log class `budget`。
  - `overflow during processing keeps published records and re-entry adopts them`：第二次以足夠預算完成，id 不重複、無新 seq。
  - `inventory over budget refuses collection`：store 預先放 N 筆，注入預算使 inventory 溢出；verdict `skipped UNDETERMINABLE`、無新 pending、無 done。並量測每筆 record 的 inventory 單位為固定常數（寫入測試輸出供 docs 引用）。
  - `mutation between enumeration and read`：fault seam 刪除／替換一個候選 → `race`、無 done；重入完成。
  - `invalid names cost one unit and are never stat'ed`。
- [ ] 驗證：`npm run typecheck && npx vitest run test/approval-stage3-baseline.test.ts test/approval-request.test.ts test/approval-collect*.test.ts test/approval-store.test.ts test/approval-state.test.ts test/approval-publish-race.test.ts`＋M3 (d)。

## S3 — lifecycle wiring / grants / snapshot（S2 後 serial）

**可改：** `src/run-session.ts`、`src/message-store.ts`、`src/approval-wake-gate.ts`、`src/policy.ts`、`src/adapters/types.ts`、`src/adapters/claude.ts`、`src/prompt.ts`、新 `src/approval-snapshot.ts`；新 `test/approval-stage3-flows.test.ts`、`test/approval-stage3-recovery.test.ts`、`test/approval-stage3-snapshot.test.ts`；可擴充 approval gate/adapters/policy 測試但不改既有斷言。**不可動：** config/schema/run-store/call/verify/guard/locks/所有 fixtures/依賴、`test/approval-compat.test.ts`。

- [ ] `settle empty batch collects ready and committed`：插在 `routeOutboxes`（`run-session.ts:1222`）後、commitClaim（`:1278`）前；遍歷所有 enrolled slot（不依 batch）；每 slot 之前檢查 abort；錯誤固定碼 log＋gate entry 後照常 commitClaim。resume `settle([],[])`（`:1568`）同樣補收。
- [ ] `preclaim residual classification`：維持 `evaluateSlot`（`:735–750`）順序，slotDir 改 `prepareSlot`。claim output_ready/committed→collect；abandoned 或已確定 failed/interrupted→park；其餘→UNDETERMINABLE。成功空目錄才 wake。
- [ ] `solo grant path and every retry`：只 claim wake 帶 requestDir；system 與每次 user prompt 都帶路徑；tidy/verify/format/call/非 enrolled 無欄位、無 grant、無 prompt 字元；retry/fallback 前再次 ensure。
- [ ] `failure cancel park before finish`：兩個 `parkOutbox` 呼叫點（`:1043/:1049`）後、`finishAttempt` 前加 park；park 失敗擋本 slot 後續 retry/fallback。
- [ ] `recovery b parks before abandon once`：scan-verified 路徑用 `finishLoadedAttempt`（**不 reopen**，以 `readFile` spy 斷言 attempts/claims 檔各只讀一次）；started 最新 attempt：outbox park→proposals park→finish failed；claimed 且其 output_ready attempt 為最新：proposals park→fault→save abandoned；只處理本 pass 由 claimed 轉 abandoned 者；每 slot catch，失敗不 finish/save 該 slot、通知 block。
- [ ] `snapshot actual worktree grants`（M1，實際執行，不只合成綁定）：以 `initGitRepo` 的 scratch repo 起 run（零設定即給 lead 自己的工作樹與 member 工作樹，`plan.leadWorktree`，`src/run-session.ts:303,382`；先斷言 `state.lead_workspace === true`，同 `test/integration.test.ts:411-422`）；member enrolled 且 `can_edit_agent_md: true`、lead enrolled；各寫一個合法 `.req`。斷言：(1) fake invoker 收到的 WakeInput 經 `writePolicy(input.project, input.agent, input.requestDir)` 的 canonical allowDirs/allowFiles **等於** record `origin.full_writable`，且含 `ws.gitDir`、lead 工作樹的 `CLAUDE.md`/`AGENTS.md` 與 proposals；(2) record hash 等於 gate baseline hash；(3) `clear` 該 run、刪除其 worktrees 與 run dir 後，以 fresh unbound 設定 `unboundSnapshotInputs(…, "normal")` 重算的 hash 與 record 完全相等；(4) 把 `sandbox.write` 加上一個 run-only 路徑（static duplicate）後重跑，duplicate 留在 hash 輸入；(5) 改 `can_edit_agent_md` 或 `sandbox.write` 後不相等。另跑 solo（`"solo"` 模式重建）與 `role--2` instance 各一次相同斷言。
- [ ] 驗證：`npm run typecheck && npx vitest run test/approval-stage3-baseline.test.ts test/approval-stage3-*.test.ts test/approval-wake-gate*.test.ts test/approval-recovery-scan.test.ts test/approval-latest-attempt.test.ts test/approval-gate-*.test.ts test/policy*.test.ts test/adapters.test.ts test/approval-adapters.test.ts`＋M3 (d)；另照跑 `test/approval-compat.test.ts`，只確認失敗仍是那三個名稱。

## S4 — human status / doctor / docs / final gates（S3 後）

**node-engineer 可改：** `src/status.ts`（只 human formatter）、`src/doctor-approval.ts`（D8 接線）、`src/approval-collect.ts`（唯讀 `collectedRecordCount(home: string, runId: string, project: string, budget?: number): number | "unreadable"`，走 budgetedIo）；新 `test/approval-stage3-status.test.ts`。**docs-writer 可改：** `docs/write-scope.md`、`docs/write-scope.zh-TW.md`、`docs/approval-store-api.md`。兩者檔案 disjoint 可並行。**不可動：** StatusReport/run schemas、JSON renderer、其他 docs、所有 fixtures。

- [ ] 測 `count is committed records not pending`、`side file reasons fixed and persist after executor deletion`、`JSON never reads collection store`、`doctor link failure and default-off zero probes`、`malicious errors never printed`、`damaged or over-budget count is explicit unknown`、`DIR_ANOMALY text names every class`。
- [ ] docs 只寫已存在者：request 位置/格式、rotation/recovery/seq、`.coord` 與 stale 手動處理、預算數值／溢出結果／飢餓與手動處置、`approval_collect` class→處置表、record 提交點、拒收／軟配額／計數近似、park 不成 redo 草稿、`full_writable` 是收走當時 grant（重入時非原 wake）、§4.4 殘留背景程序/fd 風險、§5 非讀取隔離、F3/Linux/真 sandbox 未驗證與「非可發布：第 0 步未驗證」、approve/execute/feedback/gc/call 收走未實作。
- [ ] 最後：`npm run lint && npm run typecheck && npm test && npm run check:docs` 全跑，失敗逐一對照基準缺陷清單分「預存」與「新增」；新增者必須為零才可交 review；預存者照列，使用者驗收維持 UNMET。

## fault() matrix / re-entry acceptance

每個 point 單獨 crash＋新建 session 重入（不只同 process retry）。遺留 `.coord/` 測試先證實不偷鎖，再模擬操作者清鎖後重入。

| point | 位置 | 必驗重入 |
|---|---|---|
| `rotation:renamed` | rename 後、mkdir 前（collected/parked 各測） | 缺 proposals 重建；無重複 seq／ENOTEMPTY |
| `rotation:recreated` | mkdir+lstat 後、高水位前 | 空 proposals 不再 rotate；高水位補齊 |
| `collection:high-water` | advanceHighWater 後、處理前 | un-done 原 seq 補收；新 seq 更大 |
| `collection:before-done` / `collection:done` | done link 前／後 | 既有 id 原樣採用；狀態不回 pending |
| `collection:budget` | 注入預算在任一階段溢出 | 無 done、bytes 不變、他 slot 已前進；重入完成 |
| `payload_committed` / `record_committed` | 既有 publishRecord | incomplete 補 record；mismatch fail-closed |
| `attempt:output-ready` | `:1034` 後、`:1067` 前 | claimed→先 park 再 abandon |
| `recovery:proposals-parked` | (b) park 後、save abandoned 前 | 冪等；歷史 abandoned 不重 park |
| `failure:proposals-parked` | failure/cancel park 後、finish 前 | 不重搬到既存 dest |
| `settle:aborted` | 第一個 slot 後設 abort | 其餘 slot 未收、commitClaim 照常；resume 補收 |

共通：沒有 lost request、duplicate id、reused seq、狀態倒退；park 的 request 保留原 bytes 但永不收走；健康 slot 在同一 pass 已 wake 或已收走。

## Dimension coverage

1. **Compatibility & Format：** 無 schema／state／side-file 變更；`.coord/`、`.denied-count/` 為 enrolled-only 私有檔；default-off 由新 734e64d 零差異測試證明；f4936b0 凍結測試與 `--fork-session` 皆不動，三個歷史紅照列、驗收 UNMET。
2. **File & Process Safety：** canonical slot grant、每層 lstat、no-follow/nonblock、dev/ino、同 Buffer、link 提交；full_writable 取實際 grant、hash 用邏輯指令檔＋來源分類；OS/tool 實效未驗證。
3. **Concurrency & Recovery：** per-slot `.coord/`、無偷鎖；預算溢出與取消都留 un-done、重入冪等；recovery 不 reopen（`finishLoadedAttempt`）、park-before-abandon。
4. **Platform & Operability：** macOS/Linux 介面、Windows 只既有拒絕；每 slot pass ≤65536 次 fs 呼叫但無 wall-clock 保證；無新依賴、timer、watcher；飢餓需人工處置已明列。
5. **Testability & Maintainability：** budget／io／fault／clock／token 皆注入；20000 項與超預算分開測；baseline fixtures 由 734e64d archive 擷取；小模組、純 parser。
6. **Observability & Diagnosability：** 固定 op/class log、DIR_ANOMALY 文字列出所有 class 與處置、status 計數 unknown 明示；不輸出 agent 控制的路徑或錯誤。

## Open items / Risks / decisions made for the lead

- **lead 需記錄：** D1–D9、O5/O6/F3；M3 的「切片前進 ≠ 驗收」與使用者全綠要求 UNMET（需使用者決定是否接受 1c4b433 的歷史 delta）。
- **我替 lead 做的決定（含被拒替代）：** 預算 65536 而非建議的 32768（理由見 D3；替代＝32768 讓 20000 測試斷言溢出）；不合法檔名不計入 cap/ignored_count 且不 lstat（替代＝舊版佔 cap，成本加倍）；inventory 延遲建立、溢出→UNDETERMINABLE（替代＝以 0 計或估算）；`full_writable` 在重入時取收走當時 grant（替代＝新增持久欄位，違反不改格式）；工作樹指令檔邏輯路徑定為 `<project_dir>/<basename>`（替代＝符號 token，會改變 hash 輸入型別）；DIR_ANOMALY 文字改寫（替代＝新增 gate code，違反嚴格 v1）；基準擷取用 symlink 現有 node_modules（替代＝`npm ci` 需網路且版本可能漂移；QA 曾用 vitest 4.1.12 而本機 4.1.11，SOURCE.txt 須記錄實際版本）。
- **風險：** store 成長使 inventory 超預算時所有 enrolled 收走停擺直到 gc；持續 mutation 可 DoS 單一 slot；baseline 測試在 sandbox 內可能因 listen EPERM 無法跑完整 run 場景（則回報 lead，不改用現行碼產生）；F3、Linux、真 sandbox、真 runtime 未驗證。
- **角色：** node-engineer 實作 S1–S4 src/test；qa 獨立驗所有 crash/negative/budget/M1 實跑案例與零差異；cli-reviewer 跨 runtime 審 rotation/symlink/inode/collection/recovery/budget；docs-writer 只改三份 docs。
