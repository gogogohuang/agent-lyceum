# Approval Store Stage 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Team lead 分派每個 slice；本任務不 commit、不啟動下個階段。

**Goal:** 只交付 v12/v12.1 §10 任務 1 的獨立、預設關閉 approval store，鎖定跨階段 API，不啟用核可關卡。

**Architecture:** 純函式負責來源鍵、資格快照、狀態轉換與顯示；小型同步 I/O 模組負責 no-follow 讀取、hard-link 提交與高水位。所有入口顯式接收 home、時間或 resolver；既有 runtime、dispatcher、CLI 不 import 新模組。

**Tech Stack:** Node >=20、TypeScript ESM / NodeNext / ES2022；Node fs、crypto、child_process、worker_threads。沿用 package.json 的 yaml ^2.5.0、zod ^4.6.5、Vitest ^4.1.11、TypeScript ^7.0.2、Biome ^2.5.15；實際安裝版本以 lockfile 為準，不新增依賴、不改 manifest/lockfile。目前 package.json 是 0.41.0，不能沿用 shared context 的 v0.5.x 描述。

**Spec:** [v12/v12.1 contract](../specs/2026-11-13-approval-gate-design.md)，完整閱讀 §1–12 及附錄。舊 v8 分支不是契約；未讀取或採用其 D2、D10。

狀態：design revision round 1，待 cli-architect-reviewer 重新審查，尚未實作。Q1–Q9 已由 product-lead 採納（task 3af6574c；decision `approval-store-stage1-v12`；本 run `_shared/lead-decisions.md`），包含 review 4b3d1432 的 approve recovery 修正。下表保留決策與拒絕方案，不再是待批 default；不要求使用者重批。此 wake 只改本 plan，短 API 文件由後續 docs-writer 依原授權交付。

## Global Constraints

- 實作交付只新增 `src/approval-*.ts`、`test/approval-*.test.ts`、`docs/approval-store-api.md` 與本文件；唯一既有程式碼變更是 `src/project-lock.ts:105` 加 `export`。
- 不改既有測試、`.strict()` config schemas、`ResolvedAgent`、`WakeInput`、run `state.json`、mail、CLI、adapters、doctor、status、settle、call、run-session。`status --json` 逐字不變。
- 沒有 import-time I/O；沒有自動讀 executors.yaml、建目錄、掛 timer、啟動行程或網路。即使存在 executors.yaml，既有程式也不載入新模組。
- 舊 project.yaml、team.yaml、run 目錄繼續使用原 reader。舊 binary 忽略新增頂層檔案；新 approval reader 遇未知 `schema_version` 明確拒絕，絕不猜測或就地遷移。
- macOS/Linux；Windows 寫入回 `UNSUPPORTED_PLATFORM`，說明此功能不支援，不模擬安全保證。無新 daemon、watcher、依賴。
- 不做 §10 任務 2–6，含 OS 前提檢查、agent 標記整合、收走/格式解析、配額、輪替實作、CLI、執行器、回饋與 gc。沒有 stage-1 sandbox 保證或「至多一次執行」宣稱。
- 只保證 process crash 恢復，非斷電/OS crash 持久性。禁止 hard-link 失敗後 rename fallback；高水位的 replace-rename 是 spec 另定的用途。
- 測試只用 temp home/scratch repo，不讀真實 ~/agent-lyceum-config、claude/codex 或人類證據目錄。真機 §8.0 不執行；§8:333–340 是 spec 的人類紀錄，不是本次重新驗證，Linux 仍未驗證。

## Review Focus

1. 同一 id 的已提交 record 在狀態前進後重播，必須原樣採用，不能重新 pending（S4）。
2. 最高數字狀態損毀、symlink/FIFO、未知版本不能被當成不存在或退回較小 n（S3、S6）。
3. PID 重用的確定不符與無法比較不同；grace 邊界必須可重現（S5）。
4. 原 run clear 後不讀原 run；新增靜態 grant 必須讓快照不符，run 專屬 grant 消失則不變（S2）。
5. hard-link 已成功但 cleanup 失敗/崩潰仍是提交成功；兩個真正並行參與者不得都聲稱勝出（S3、S4、S8）。

## 既有依據與決策邊界

以下行號以 HEAD `32eb0a5` 定位，可用 `nl -ba <file>` 重現：

| 依據 | 對設計的約束 |
|---|---|
| src/project-lock.ts:105–107、173–191、324–335 | pidStart 私有、writer locale 不變；lockHolderAlive fail-open 不可重用；temp/link/finally 是先例，但新模組補 fsync/錯誤區分。 |
| src/fs-util.ts:4–10、97–126 | atomicWrite 會覆蓋，不能用於不可變檔；capped no-follow 有 size/truncated、無 inode，且終端 no-follow 不防祖先 symlink。 |
| src/policy.ts:177–201；src/config.ts:47–76 | allowDirs 含 task memory/outbox/gitDir，也有靜態 grant；ResolvedAgent 無列入欄位。 |
| src/paths.ts:5、33–40、101–114 | assertName 可用於 project/slot/executor；run-id 有 dot，不能直接用 assertName；canonicalPath 會做真路徑 I/O，不能偷放進純函式。 |
| src/schema.ts:3–4、26–27、40–45 | runtime 為 claude-code/codex，allowWeb 有 none；沿用 zod，不改既有 strict schema。 |
| src/fallback.ts:24–43、46–55；src/config.ts:40–44、59–62 | 候選順序沿用 candidatesFor，不帶 tierModel；逐候選以 agentForCandidate 取得有效 allowWeb/sandbox，再映射快照欄位，不複製 primary 設定。 |
| src/message-store.ts:6–12 | 有 fault seam 先例；新模組使用每次呼叫 hook，避免跨測試的全域 hook。 |
| test/project-lock.test.ts:1–37、vitest.config.ts:1–17 | 現有測試用 temp dir、child process；tsx 路徑依本地 node_modules，不能只把外部 bin 放 PATH 就宣稱全部測試可跑。 |
| package.json:34–64、tsconfig.json:2–21、scripts/check-docs.mjs:1–21 | Node >=20、ESM、src-only typecheck；docs checker 不普查所有 plans，需另做本文件相對連結檢查。 |

### Lead 已採納決策表（Q1–Q9；owner 均為 product-lead）

| ID / 問題 | Lead 採納的細化與後果 | 不採用的替代方案 |
|---|---|---|
| Q1 §10 task1 含 loader 與 ResolvedAgent，但請求禁止改既有檔 | 實作獨立 loader/schema；新增 `ApprovalQualification` wrapper，延後 ResolvedAgent/WakeInput 欄位到 stage2。這是明示的 stage1 scope 調整。 | 刪掉 loader 會漏契約；直接修改 ResolvedAgent 違反明確限制。 |
| Q2 spec 未定來源鍵精確 bytes、denied hash | 採下節 LP v1 domain-separated tuple；可讀但拒收的檔用完整已讀 request bytes hash，accepted 用 payload hash；oversize 不 hash 截斷內容。列為 spec 細化，需先鎖 golden。 | v8 決策、JSON.stringify 或 delimiter-only 無契約且可能歧義；所有 denied 用固定字串會合併不同來源。 |
| Q3 strict liveness 未定可比較 mismatch / grace 等號 | 可比較不符立即 dead；不可驗證直到 `now >= executing.updated_at + (timeout_sec+60)*1000` 為 dead。相符永遠 alive，不以 timeout 代替執行器監督。 | 把 mismatch 也當無法驗證會延誤 PID 重用處理；把相符 PID 到時直接判死錯殺活行程。 |
| Q4 高水位格式與併發 | `collected.seq` 為十進位整數加 LF；rotate/high-water/manual requests gc 必須以共同的 canonical slot root 為 coordination identity，從選號到目錄變更/advance/移除全程序列化，包含 orphan/call slot；現有 run/call lease 本身不是證明。store publication 可並行；stage1 不提供 allocator/lock。 | 兩個 writer 的 read-max/rename 會倒退，不能謊稱原子 max；改 journal/hardlink 高水位偏離 spec 檔案格式。stage3/6 接線前必須以同一協定序列化或拒絕重疊，不可直接假設既有 run lease 已涵蓋 gc。 |
| Q5 grant 重疊與純 resolver | 注入有 provenance 的 static/run grant 分組；對有效集合精確扣 run-only 項、保留同路徑的 static grant。canonicalize 在注入邊界執行；候選有效設定取自 agentForCandidate，再正規化 localBinding/unixSockets/allowWeb。 | 依路徑包含 run-id 猜，或扣掉 run 祖先下所有項，會漏 sandbox.write 靜態 grant。 |
| Q6 record/state 版本、上限與 rejected record | 下節 v1 strict schema；denied 無 executor/qualification/payload 時以 null 明示；metadata 1 MiB 上限，超出 fail-closed（大快照需日後擴版）。 | 無界 JSON 可能阻塞/OOM；強制 denied 一定有 executor/snapshot 無法表達 bad_executor。 |
| Q7 loader spec 未給數值下限/timeout default、allow 空值範圍 | timeout_sec 必填正整數；其餘下節 defaults；所有 allow 都空才 disabled（某 executor 空不關掉其他項）。 | 猜 timeout=60 會把範例當 default；任一空 allow 關掉全功能有意外。 |
| Q8 symlink 與 filesystem 信任 | home 在邊界 canonicalize；home 以下 store/slot 祖先逐層 lstat 拒 symlink，檔案 O_NOFOLLOW/O_NONBLOCK；private 0700 父目錄由可信操作者擁有，不聲稱可抵禦同 UID 惡意競爭替換祖先。 | 純 JS pathname API 無 openat directory-fd 保證，不能把 lstat 描述成完整 TOCTOU 防護；不加 native dependency。 |
| Q9 competing transitions 的優先序與衝突 | approve 先 clock rollback、expiry、hash、其餘資格/人類確認；reject 可拒過期但未寫 expiry 的 pending；approve 對最新 executing 先用新 now/liveness 懶惰檢查，live 不寫、dead 只寫 unknown；所有 EEXIST 重讀重判且不延用過期 proof，recovery 後不得執行。 | 加全域優先鎖偏離 spec；輸家照舊 proposal 或無條件拒 executing，會漏 recovery 或繞過當前狀態。 |

## 檔案與九項交付對照

| 交付 | 新 src 檔案 | 新 test 檔案 | slice |
|---|---|---|---|
| 1 types/paths/schema | approval-types.ts、approval-schema.ts、approval-paths.ts | approval-types.test.ts、approval-paths.test.ts | S1 |
| 2 id/denied variants | approval-id.ts | approval-id.test.ts | S1 |
| 3 payload/record exclusive publish | approval-io.ts、approval-store.ts | approval-io.test.ts、approval-store.test.ts | S3/S4 |
| 4 numeric state/pure transition/display | approval-transition.ts、approval-state.ts、approval-display.ts | approval-transition.test.ts、approval-state.test.ts、approval-display.test.ts | S5/S6/S7 |
| 5 strict liveness | approval-liveness.ts；project-lock.ts 只加 export | approval-liveness.test.ts | S5 |
| 6 origin/static qualification | approval-origin.ts、approval-executors.ts | approval-origin.test.ts、approval-executors.test.ts | S2a/S2b |
| 7 JSON output | approval-json.ts | approval-json.test.ts | S7 |
| 8 high-water / types-only rotation | approval-high-water.ts、approval-rotation.ts | approval-high-water.test.ts、approval-rotation.test.ts | S4b/S7 |
| 9 true concurrency prototype | 上述 I/O/store/state | approval-concurrency.test.ts | S8（S3 後先跑 raw-link 原型） |

不新增 barrel/service/class framework；`ApprovalError` 是唯一 Error subclass。`approval-schema.ts` 集中 metadata validators；executor schema 保持在 approval-executors.ts。介面以以下簽名為準；型別位置由上表決定。

## 固定型別、bytes 與磁碟契約

以下 TS 是契約摘錄，非待貼上的完整實作。所有持久化結構以 readonly 建模；parser validate 後回傳新物件，不共享 caller 可變輸入；不是靠 chmod 防同 UID 修改。

```ts
type Sha256 = string; // /^[0-9a-f]{64}$/
type ApprovalId = string; // /^[0-9a-f]{24}$/
type IsoTime = string; // UTC Date.toISOString() canonical form, valid date
type Sequence = number; // safe integer; >0；state previous 可為 0
interface SourceBase { readonly kind: "run" | "call"; readonly source_id: string;
  readonly slot: string; readonly seq: Sequence }
type DeniedReason = "not_regular" | "too_large" | "bad_content" |
  "bad_executor" | "bad_header" | "not_allowed" | "quota" | "scan_limit";
type SourceKey = SourceBase & (
  { readonly variant: "payload"; readonly filename: string; readonly payload_sha256: Sha256 } |
  { readonly variant: "denied_bytes"; readonly filename: string;
    readonly reason: Exclude<DeniedReason, "not_regular" | "scan_limit">; readonly request_sha256: Sha256 } |
  { readonly variant: "denied_entry"; readonly filename: string; readonly reason: "not_regular" } |
  { readonly variant: "denied_size"; readonly filename: string; readonly reason: "too_large"; readonly size: number } |
  { readonly variant: "denied_scan"; readonly reason: "scan_limit" });
interface WritableSet { readonly dirs: readonly string[]; readonly files: readonly string[] }
type Origin = { readonly kind: "run"; readonly project: string; readonly run_id: string;
  readonly project_dir: string; readonly role: string; readonly full_writable: WritableSet } |
  { readonly kind: "call"; readonly call_id: string; readonly project_dir: string;
    readonly role: string; readonly full_writable: WritableSet };
interface PremiseResult { readonly check: string; readonly ok: boolean; readonly code: string }
interface QualificationSnapshot { readonly schema_version: 1; readonly sha256: Sha256;
  readonly premises: readonly PremiseResult[] }
interface Proposer { readonly role: string; readonly slot: string }
interface RecordBase { readonly schema_version: 1; readonly id: ApprovalId;
  readonly source_key: SourceKey; readonly origin: Origin; readonly proposer: Proposer;
  readonly created_at: IsoTime; readonly expires_at: IsoTime;
  readonly executor: string | null; readonly summary: string | null;
  readonly payload_sha256: Sha256 | null; readonly payload_bytes: number | null;
  readonly qualification: QualificationSnapshot | null }
type ApprovalRecord = RecordBase & (
  { readonly disposition: "pending"; readonly executor: string; readonly payload_sha256: Sha256;
    readonly payload_bytes: number; readonly qualification: QualificationSnapshot } |
  { readonly disposition: "denied"; readonly reason: DeniedReason; readonly ignored_count: number | null });
type Status = "pending" | "denied" | "executing" | "unknown" | "executed" |
  "failed" | "rejected" | "expired" | "tampered";
interface Actor { readonly user: string; readonly tty: string | null;
  readonly pid: number; readonly pid_started: string | null }
interface ExecutionOwner { readonly pid: number; readonly pid_started: string }
interface Output { readonly text: string; readonly truncated: boolean }
interface ExitData { readonly exit_code: number | null; readonly signal: string | null;
  readonly failure: "exit" | "timeout" | "spawn" | null; readonly error_code: string | null;
  readonly stdout: Output; readonly stderr: Output }
type StateData =
  { readonly status: "executing"; readonly owner: ExecutionOwner; readonly timeout_sec: number;
    readonly viewed_bytes: number; readonly viewed_sha256: Sha256; readonly command_sha256: Sha256 } |
  { readonly status: "executed" | "failed"; readonly method: "executor"; readonly result: ExitData } |
  { readonly status: "executed" | "failed"; readonly method: "manual"; readonly conclusion: string } |
  { readonly status: "unknown"; readonly reason: "creator_dead" | "interrupted"; readonly detail: string } |
  { readonly status: "rejected"; readonly reason: string | null } |
  { readonly status: "expired" } |
  { readonly status: "tampered"; readonly observed_sha256: Sha256 };
type ApprovalState = StateData & { readonly schema_version: 1; readonly n: Sequence;
  readonly previous: number; readonly updated_at: IsoTime; readonly actor: Actor };
interface Current { readonly record: ApprovalRecord; readonly n: number;
  readonly state: ApprovalState | null } // n=0 implies no state; disposition supplies status
```

schema invariants：source kind/id/slot 與 origin/proposer 一致、id 重算相同、accepted source hash 等於 record hash、expires_at >= created_at；denied reason 與 variant 一致。所有數字有限 safe integer、size/count >=0（ignored_count 對 scan_limit 必須 >0，其他 null）、payload_bytes <=65536；pid>0；timeout>0。字串無 lone surrogate；日期不能以 Date.parse 的寬鬆正規化吞錯。沒有任何 secret/env value 或 command bytes 存進 record；snapshot 只存 hash 與安全檢查代碼。未知 schema_version 回 `UNSUPPORTED_VERSION`，缺版本不是舊 approval 格式、不接受。

state 檔名 canonical `[1-9][0-9]*.json`；任何純數字 alias（如 01.json、0.json）、超過 safe integer 或對應非一般檔均 `CORRUPT_STATE`，不能忽略。metadata schema 為 discriminated union + strict keys，無 pending/denied 狀態檔。`approval-schema.ts` 匯出 `parseApprovalRecord(value: unknown, file: string): ApprovalRecord`、`parseApprovalState(value: unknown, file: string): ApprovalState`，error 帶 file 與欄位路徑，供 store/state 共用。先找數字最大，再讀最高者；驗證內部 n=檔名、previous=n-1、前序檔存在且鏈可驗證；損毀任何必要前序同樣 fail-closed。不是只確認 JSON.parse 成功。初始 denied 若有數字狀態則損毀。

### Source encoding v1（Q2）

`lp(s) = ASCII(decimal(Buffer.byteLength(s,"utf8"))) || ASCII(":") || UTF8(s)`；十進位無 leading zero，空值 `0:`，欄位直接串接，**無隱含 LF、NUL、BOM、JSON、Unicode normalize 或末尾分隔**。拒絕 lone surrogate。固定 tuple：

`["agent-lyceum/approval-source/v1", variant, kind, source_id, slot, decimal(seq), ...suffix]`

| variant | suffix（順序固定） | 使用範圍 |
|---|---|---|
| payload | filename, payload_sha256 | 通過收走 |
| denied_bytes | filename, reason, request_sha256 | 已取得完整 bounded bytes 的所有內容拒收（含 executor 上限 too_large） |
| denied_entry | filename, "not_regular" | 無可讀內容的 entry |
| denied_size | filename, "too_large", decimal(size) | 超全域上限、不可完整讀，不 hash truncated buffer |
| denied_scan | "scan_limit" | 每 seq 一筆；ignored_count 存 record，不進 key，重掃數量改變不再新增聚合記錄 |

`encodeSourceKey(key: SourceKey): Buffer`；`approvalId(key: SourceKey): ApprovalId` = sha256(encoded bytes).digest("hex").slice(0,24)。`source_id` 與 slot 必填（call 用 role 作 slot，不用空字串）；run/call id 驗證 `^[A-Za-z0-9][A-Za-z0-9_.-]*$` 並禁止 `.`/`..`；project/role/slot/executor 用 assertName。request filename 依 §4.3 regex 且非 dotfile。所有拒收原因有測試；parser/collector 不在此階段。

Golden：`lp("中")` 的 hex 是 `333ae4b8ad`，`lp("")` 是 `303a`；測試 hard-code 完整 tuple 的 encoded hex 與獨立預算的 id，不拿同一 encoder 當 oracle。測試 delimiter/換行/多 byte、tuple 邊界歧義、run/call/variant/seq/hash 改動均不同。對不合法的 filename/id 拒絕，不產生路徑。

### Paths

```ts
type SlotRef = { readonly kind: "run"; readonly project: string; readonly run_id: string;
  readonly slot: string } | { readonly kind: "call"; readonly call_id: string };
interface StorePaths { readonly approvals: string; readonly requests: string; readonly executors: string;
  readonly trash: string; readonly feedback: string; readonly denied_count: string }
interface RequestPaths { readonly root: string; readonly proposals: string; readonly collected: string;
  readonly parked: string; readonly high_water: string; readonly ok: string | null }
interface RecordPaths { readonly root: string; readonly record: string; readonly payload: string;
  readonly state: string; readonly work: string }
storePaths(home: string): StorePaths;
requestPaths(home: string, slot: SlotRef): RequestPaths;
recordPaths(home: string, id: ApprovalId): RecordPaths;
```

純 join/validate，home 必須絕對且由邊界提供 canonical home，不自行 resolveHome。路徑依 §4.1（call root 無額外 slot 層）；`collected.seq` 在 slot root，`.done` 是 collected 下 sibling marker，不是 sequence 目錄內檔案。列舉 approval id 只接受 24 lower hex 目錄，忽略 dot metadata；合法 id 名但非真目錄必須診斷。

## S2 API：executor loader、membership、origin 與 snapshot

```ts
type ExecutorAllow = { readonly project: string; readonly agent: string } | { readonly call: string };
interface ExecutorConfig { readonly command: readonly [string]; readonly allow: readonly ExecutorAllow[];
  readonly timeout_sec: number; readonly env: Readonly<Record<string,string>>;
  readonly expires_days: number; readonly max_pending: number; readonly max_payload_bytes: number }
interface ExecutorsConfig { readonly executors: Readonly<Record<string,ExecutorConfig>>;
  readonly limits: { readonly max_total_pending: number; readonly max_scan_entries: number;
    readonly retention_days: number } }
type ExecutorsLoad = { readonly enabled: boolean; readonly config: ExecutorsConfig | null };
parseExecutors(text: string, file: string, userHome: string): ExecutorsConfig;
loadExecutors(home: string, userHome: string, io?: ApprovalIo): ExecutorsLoad;
interface ApprovalQualification { readonly enrolled: boolean; readonly executors: readonly string[] }
qualificationOf(config: ExecutorsConfig | null,
  identity: { readonly project: string | null; readonly role: string }): ApprovalQualification;
```

loader 只由直接呼叫啟用；ENOENT 回 `{enabled:false,config:null}`，其他 I/O/YAML/schema error 帶檔案與欄位路徑，不吞錯。所有 objects strict；YAML 重複鍵/aliases 造成非法型別要拒絕。executors 與 limits 可缺（defaults 空、50/200/90），allow 必填可空；timeout_sec 必填正 safe integer；env default {}、expires_days=7、max_pending=10、max_payload_bytes=4096（1..65536）；days/limits 皆正 safe integer。command 恰一元素，必須 absolute path（拒 `~` command）；env 值只以注入 userHome 展開 `~`/`~/`，不展開 `$VAR`，不用 configPath；key 為環境變數名稱。executor/allow 名稱 assertName；project 與 call entry 互斥。schema 只檢查形狀，不做 executable/shebang/containment/sandbox 判斷。qualificationOf 是 allow 聯集、sorted unique executor 名；role 已由 caller 用 roleOfName 還原，不用 `--k` regex 猜角色。

```ts
interface GrantInput { readonly effective: WritableSet; readonly run_only: WritableSet;
  readonly static_duplicates: WritableSet } // canonical paths；標示同一路徑另有靜態授權
staticWritable(input: GrantInput): WritableSet;
interface SnapshotInput { readonly runtime_candidates: readonly {
  readonly runtime: "claude-code" | "codex"; readonly sandbox: {
    readonly write: readonly string[]; readonly network: readonly string[];
    readonly local_binding: boolean; readonly unix_sockets: readonly string[] } | null;
  readonly allow_web: "none" | "search" | "fetch" | null }[];
  readonly writable: WritableSet; readonly project_dir: string; readonly executor: ExecutorConfig }
qualificationHash(input: SnapshotInput): Sha256;
interface OriginResolved { readonly qualification: ApprovalQualification;
  readonly snapshot_input: SnapshotInput; readonly premises: readonly PremiseResult[] }
type OriginErrorCode = "PROJECT_MISSING" | "PROJECT_PATH_MISMATCH" | "AGENT_MISSING" |
  "EXECUTOR_MISSING" | "NOT_ALLOWED" | "PREMISE_FAILED" | "SNAPSHOT_MISMATCH" |
  "CONFIG_INVALID" | "ORIGIN_UNREADABLE";
type OriginResult = { readonly ok: true; readonly resolved: OriginResolved } |
  { readonly ok: false; readonly code: OriginErrorCode; readonly hint: string };
type OriginResolver = (origin: Origin, executor: string) => OriginResult;
resolveOrigin(origin: Origin, executor: string, resolver: OriginResolver): OriginResult;
revalidateOrigin(record: ApprovalRecord, resolver: OriginResolver): OriginResult;
```

這是 injected resolver contract，**不是現有 config loader 的新分支**。resolveOrigin 驗證 supplied origin 和 resolver 回傳的 canonical project_dir 相同，驗證 enrollment/executor；resolver 處理 project/agent lookup、canonicalize、前提與有效設定，禁止讀原 run/attempt/worktree/task memory。call 只依 origin.role、canonical project_dir 與目前 call 設定；不能靠原 call 目錄存在。resolver 若 throw，包 `ORIGIN_UNREADABLE` 且帶安全 hint，不寫任何檔。revalidateOrigin 比對 snapshot 與所有 premises ok，任何失敗 pending 不變；denied 回 NOT_ALLOWED。各 hint 都提供「修復指定 project/agent/executor 設定後再核可，或 reject；要重做則重新提出」，不能暗示用 resolve 改 pending。

staticWritable 精確 `(effective - run_only) union static_duplicates`，dirs/files 各自 sorted unique；不做祖先子樹扣除/讀檔，caller 必須交全的 effective。static_duplicates 必須是 effective 子集合；確定 provenance 缺失回錯。run_only 的定義是 task memory、outbox、gitDir、proposals，**不是靜態 grant 白名單**；未來新增 static grant 自動納入 effective。snapshot 不納 model/tier/session/run-id、origin.full_writable、executor binary hash；納候選順序與各候選有效 sandbox/allow_web、靜態 dirs/files、project_dir、executor 全條目（含 env，但只持久化 hash）。runtime_candidates 不去重/重排；sandbox path/domain、allow entry、env keys 等無順序意義集合 sorted unique。缺 sandbox 與明確空 sandbox 保留區別。

resolver 邊界的欄位映射（依 `src/fallback.ts:24–55`、`src/config.ts:40–44,59–62`）：先 `candidatesFor(agent)`（不傳 tierModel，排除 wake 的 tier 選擇），保留其順序；每個 `c` 用 `effective = agentForCandidate(agent, c)`。以 `effective.runtime` → `runtime`、`effective.allowWeb ?? null` → `allow_web`；無 sandbox → null，否則 `effective.sandbox.write`/`network` → 同名欄位，`localBinding` → `local_binding`，`unixSockets` → `unix_sockets`，write/socket 路徑由注入邊界 canonicalize。禁止將 primary 的 allowWeb 直接套給所有候選，也不重算既有 fallback 規則。純 hash 函式只接此已正規化資料，沒有 config/run I/O。

對照測試：primary claude-code 且 allowWeb unset，fallback codex 時正規化陣列的 allow_web 必須是 `[null, "none"]`；明設 search 則 `["search", "search"]`。用現有 candidatesFor/agentForCandidate 的結果做 resolver fixture，再斷言獨立 literal snapshot/hash，不能拿 primary 複製值當 oracle。這只是設定快照測試，並不准許列入者使用 Codex（前提檢查仍在 stage2）。模型欄位不 hash；保持候選拓樸時 model/tier/session 改變不影響 hash，實際候選數量/順序改變仍須重新比較。

hash bytes 用 LP domain `agent-lyceum/approval-qualification/v1` 加一個 canonical JSON 字串：objects keys 以 UTF-8 byte order 排序、array 保持上述規定順序；只接受 JSON primitives/arrays/plain objects，無 undefined/nonfinite。env 展開後值參與 hash，不出現在錯誤或 JSON list。premises 結果另存且必須全 ok，檢查名稱非配置欄位，避免每次加診斷就使 hash 改變。

## S3–S4 API：可診斷 I/O 與不可變提交

```ts
type ApprovalErrorCode = "UNSUPPORTED_PLATFORM" | "UNSUPPORTED_LINK" | "UNSUPPORTED_VERSION" |
  "UNSAFE_PATH" | "IO_ERROR" | "CORRUPT_RECORD" | "CORRUPT_STATE" | "CORRUPT_HIGH_WATER" |
  "PAYLOAD_MISMATCH" | "SOURCE_MISMATCH" | "SEQUENCE_OVERFLOW" | "INVALID_INPUT";
// ApprovalError extends Error: readonly code, path:string|null, cause?:unknown；message 不含 secret/payload。
type ApprovalIo = Pick<typeof import("node:fs"), "lstatSync" | "mkdirSync" | "openSync" |
  "fstatSync" | "readSync" | "writeSync" | "fsyncSync" | "closeSync" | "linkSync" |
  "unlinkSync" | "renameSync" | "readdirSync">;
interface StoreDeps { readonly io?: ApprovalIo; readonly token?: () => string;
  readonly fault?: (point: "temp_written" | "temp_synced" | "linked" | "temp_removed" |
    "payload_committed" | "record_committed" | "high_water_renamed") => void;
  readonly diagnostic?: (error: ApprovalError) => void }
readApprovalFile(file: string, limit: number, io?: ApprovalIo): Buffer | null;
// null ONLY terminal ENOENT；已存在祖先必須安全；其他錯誤拋帶 path/code。
publishExclusive(file: string, bytes: Buffer, deps?: StoreDeps): "created" | "exists";
readRecord(home: string, id: ApprovalId, io?: ApprovalIo): ApprovalRecord | null;
publishRecord(home: string, record: ApprovalRecord, payload: Buffer | null,
  deps?: StoreDeps): { readonly kind: "created" | "existing"; readonly record: ApprovalRecord };
```

- 所有 reads：home 以下每個既存祖先 lstat 真目錄；最後 open O_RDONLY|O_NOFOLLOW|O_NONBLOCK、fstat regular、bounded read(limit+1)，fatal UTF-8 decoder 解析 JSON。非 ENOENT 不當 missing。metadata/executors cap 1 MiB、payload cap 65536、高水位 cap 32 bytes（Q6）。拒 symlink/FIFO/socket/device/directory，檢查 dev/ino 與後置 lstat；讀中變換回 UNSAFE_PATH。不得修改 fs-util.ts 來加 ino；本階段無 collector，不需要擴原 API。
- 寫入先驗證安全父目錄，逐層 mkdir(0700)，EEXIST 後再 lstat。temp 為同目錄 `.approval-<pid>-<token>.tmp`，O_CREAT|O_EXCL|O_WRONLY|O_NOFOLLOW，mode0400；writeSync 處理 short write、fsync、close，再 linkSync 到目標，最後只 unlink 自己 temp。不 chmod 既有檔、不刪其他 process temp、不 rename 不可變檔。
- token 預設 crypto.randomUUID；碰撞重試建 temp，最多 8 次回 IO_ERROR，不覆蓋。link 的 EEXIST 只代表目標已存在，caller 必須安全讀取；ENOTSUP/EOPNOTSUPP/EXDEV/ENOSYS 為 UNSUPPORTED_LINK，EPERM 等無法確定原因回 IO_ERROR 並提示檢查 hard-link/權限，兩者都 fail-closed。禁止 fallback。
- link 前例外：無提交，可重試；link 後例外：目標已提交，不撤銷。cleanup failure 透過 diagnostic 回報，回傳 created（不能讓 caller誤以為未提交）；fault hook 模擬 process crash 可以 throw，中斷 caller，重入須由磁碟認定真相。只保證 unlink cleanup 盡力而為，不吞 diagnostic。
- publishRecord 先驗證 record/key/id，mkdir id 後先 read existing record：存在且來源一致就返回 existing，**跳過 payload/state 的所有寫入**，保留原時間/snapshot/disposition；來源不同 SOURCE_MISMATCH（含理論上 96-bit id 碰撞）。損毀 record 不可當未提交。
- record 不存在：以同一傳入 Buffer 驗 hash/size（pending 必有，denied 可 null），publish payload；EEXIST 安全讀取並 Buffer.equals，不相等 PAYLOAD_MISMATCH，不建 record。再 publish record canonical JSON + LF；record EEXIST 直接採先提交有效者，只比來源/key/id/hash 核心欄位，不比較時間/快照。denied 無 payload 時不能靜默採用殘留不匹配 payload。denied 若未成功解析出有效 payload，payload/bytes/hash 都 null，不以 request hash 冒充 payload hash；若已解析完整 bounded payload（例如 quota），可帶 payload 且 hash/bytes 必須一致。metadata 完整保留拒收原因/來源，不要求保存無界或非法原檔。
- record.json 是提交點，沒有它的 id 目錄只是 incomplete；reader 不把 incomplete 當 pending。初始 disposition denied 不建立 state。existing record 不重算配額、不重設 state；已提交 payload 是否被改動留給 approve 的 tampered 判斷（此階段 pure event），不能重播修復。

## S4b API：高水位（Q4）

```ts
readHighWater(slotRoot: string, io?: ApprovalIo): number;
maxCollectedSequence(slotRoot: string, io?: ApprovalIo): number;
nextCollectedSequence(slotRoot: string, io?: ApprovalIo): Sequence;
advanceHighWater(slotRoot: string, atLeast: number, deps?: StoreDeps): number;
```

`collected.seq` bytes 僅 `0\n` 或 `[1-9][0-9]*\n`，無 BOM/空格/多行/正負號；最大 Number.MAX_SAFE_INTEGER。ENOENT=0，存在但任何錯誤 CORRUPT_HIGH_WATER。`maxCollectedSequence` = max(high-water, collected 正整數真目錄名及 `<n>.done` 一般檔名的 n)；無 collected=0（仍納 high-water）。alias/overflow 數字名、numeric symlink/FIFO 均 fail-closed；非數字 temp/name 忽略。`.done` 內容不需讀，但型態須驗。next=max+1，溢位拒絕。

所有高水位 helper 的 doc comment 明訂 **caller-held COMMON per-slot exclusive coordination**：identity 是 canonical slot root（run: projects/project/run-id/slot；call: calls/call-id），rotation、manual requests gc 與 orphan slot 清理必須用同一 identity/協定。既有 run/call lease 不會自動協調 manual gc，不能拿它作此條件已成立的證據。

共同 critical section 從讀取高水位/掃描現存 sequence/選擇 next 或 gc 對象之前開始，直到以下該次操作全部完成才釋放：rotate 的 proposals 檢查、directory rename、重建空 proposals、advance high-water；或 gc 的重新確認對象、先 advance high-water、rename/delete collected 目錄、最後移除 .done。任何 orphan run/call 亦同，不能因無 live run 就略過協調。崩潰後的恢復也必須先進同一協定，再重讀磁碟，不靠暫存的選號。stage3/6 在接線前須實作共同序列化或拒絕重疊；stage1 不設計鎖機制、不新增 token/lease 抽象、不宣稱並行高水位安全。

在此條件下 advance 重新讀 max，取 max(atLeast,max)，temp0600 + fsync + close + rename 至 collected.seq，回新值。next 不保留序號；rotate 成功後更新，gc 刪任何 sequence 前先 advance。atomic rename 前後故障保留舊/新完整值；rotate rename 成功、高水位未更新由現存 dir/.done 補回。S4b 只實作 helper，不開 lease、不 rotate、不 gc；測試用同一 caller 依序模擬 rotation/gc，包含 orphan/call path，驗證 max 不倒退；無協調時不呼叫，不以 race 測試宣稱 helper 自行排他。

## S5–S6 API：純轉換、strict liveness、numeric publication

```ts
type Liveness = { readonly alive: boolean; readonly reason: "matching_start" | "missing_pid" |
  "start_mismatch" | "unverifiable_grace" | "unverifiable_elapsed" };
interface CreatorProbe { signal0(pid: number): "exists" | "missing" | "unverifiable";
  start(pid: number): string | undefined;
  compare(a: string, b: string): "match" | "mismatch" | "unverifiable" }
creatorLiveness(owner: ExecutionOwner, executingAt: IsoTime, timeoutSec: number,
  nowMs: number, probe?: CreatorProbe): Liveness;
interface TransitionContext { readonly now_ms: number; readonly actor: Actor }
interface ApprovalProof { readonly origin_ok: boolean; readonly premises_ok: boolean;
  readonly executor_registered: boolean; readonly allowed: boolean;
  readonly interactive_tty: boolean; readonly prefix_confirmed: boolean;
  readonly completely_viewed: boolean; readonly viewed_bytes: number; readonly viewed_sha256: Sha256;
  readonly observed_payload_sha256: Sha256; readonly owner: ExecutionOwner;
  readonly timeout_sec: number; readonly command_sha256: Sha256 }
type TransitionEvent = { readonly type: "reject"; readonly reason: string | null;
  readonly interactive_tty: boolean; readonly prefix_confirmed: boolean } |
  { readonly type: "approve"; readonly proof: ApprovalProof | null;
    readonly creator: Liveness | null } |
  { readonly type: "lazy"; readonly trigger: "list_all" | "approve" | "collect";
    readonly creator: Liveness | null } |
  { readonly type: "executor_exit"; readonly result: ExitData } |
  { readonly type: "interrupt"; readonly group_termination_requested: true; readonly detail: string } |
  { readonly type: "creator_dead"; readonly evidence: Liveness } |
  { readonly type: "resolve"; readonly outcome: "executed" | "failed";
    readonly conclusion: string; readonly interactive_tty: boolean; readonly prefix_confirmed: boolean };
type TransitionDenial = "ALREADY_HANDLED" | "NOT_APPLICABLE" | "CLOCK_ROLLBACK" |
  "QUALIFICATION_FAILED" | "CONFIRMATION_REQUIRED" | "INVALID_PROOF" | "NOT_CREATOR";
type Decision = { readonly kind: "append"; readonly next: ApprovalState } |
  { readonly kind: "noop" } | { readonly kind: "refuse"; readonly code: TransitionDenial; readonly hint: string };
decideTransition(current: Current, event: TransitionEvent, context: TransitionContext): Decision;
readCurrent(home: string, id: ApprovalId, io?: ApprovalIo): Current;
type TransitionResult = { readonly kind: "committed"; readonly current: Current } |
  { readonly kind: "unchanged"; readonly current: Current; readonly decision: Exclude<Decision,{kind:"append"}> } |
  { readonly kind: "contended"; readonly current: Current };
transition(home: string, id: ApprovalId,
  decide: (latest: Current) => { readonly event: TransitionEvent; readonly context: TransitionContext },
  deps?: StoreDeps, maxConflicts?: number): TransitionResult;
```

probe default signal0 用 process.kill(pid,0)：只 ESRCH=missing，EPERM/其他=unverifiable；start 用新匯出的 pidStart，保留其 writer 行為。compare：同字串/samePidStart=match，兩個 `proc:<ticks>` 不同=mismatch；兩個可解析 ps start 在同一表示環境確認不同=mismatch；不相容格式、locale/TZ 無法證明可比較=unverifiable，**不直接套 lockHolderAlive 的寬鬆 quarter-hour 相等規則**。若無相同表示環境證據，default ps 不同當 unverifiable，測試注入可比較 mismatch。signal missing 立即 dead；其餘只要 start 可驗 match 即 alive（signal0 的 EPERM 不推翻已驗 start）；可比較 mismatch dead；其他使用 Q3 grace 規則。時間回撥仍在 grace；非法時間/timeout/owner 是錯誤，不能讓 NaN 永遠 alive。start 讀取錯誤走 unverifiable，不是 dead。

純轉換函式不讀檔、probe、TTY、env，不 spawn、不 kill。proof 是未來 UI/runner 驗證結果，不是假裝此函式已實作 §3；actor/owner 比對 pid + pid_started。拒絕不得回寫。規則如下（所有 append 都填 schema_version=1,n=current.n+1,previous=current.n,updated_at=now ISO,actor；n 溢位拒絕）：

| current / event | 前置條件及結果 |
|---|---|
| pending / reject | interactive_tty=true、actor.tty 非空且 prefix_confirmed=true 才 rejected（§3 輔助防線）；不要求 viewed proof。未通過回 CONFIRMATION_REQUIRED。 |
| pending / lazy | now>expires_at → expired；否則 noop（trigger 僅三種；readonly 命令無寫入 event）。 |
| pending / approve | creator=null；Q9 順序：now<created_at → CLOCK_ROLLBACK；now>expires_at → expired；通過時鐘/expiry 後 proof 必填（缺值 INVALID_PROOF），observed hash 不符 → tampered；其他 proof 每項必須通過才 executing。now==expires_at 可 approve。 |
| pending / approve proof | owner.pid_started 非空、owner=actor、TTY 非空且 interactive/prefix/full-view 均真；viewed_bytes==record.payload_bytes、viewed_sha256==observed==record.hash；timeout>0、command hash合法；其餘 origin/premises/registered/allow 全真。缺 started/size/hash 錯為 INVALID_PROOF；資格錯為 QUALIFICATION_FAILED；未完整看/TTY/prefix 為 CONFIRMATION_REQUIRED。 |
| executing / executor_exit | actor=executing.owner 才 executed（exit_code=0,failure=null,signal=null）或 failed（非0、timeout、spawn、signal）；output 的 UTF-8 bytes 各<=65536，truncated 明示；不符合 exit tuple 的資料 INVALID_PROOF。 |
| executing / interrupt | actor=owner 且已要求停止群組，unknown/interrupted；終止成功與外部結果不能保證，不重試。 |
| executing / approve、creator_dead 或 lazy | 必須有對最新 owner/time 取得的 creator evidence。alive=false → unknown/creator_dead；alive=true → noop（處理中，無寫入）；缺 evidence → INVALID_PROOF。approve 此分支 proof=null，不檢查 pending 的 approval proof，也絕不建立新 executing。 |
| unknown / resolve | outcome 只 executed/failed，interactive TTY+actor.tty 非空+prefix 成立 → method=manual + conclusion；不產生 execution owner/spawn。 |
| unknown / approve | ALREADY_HANDLED，不寫檔、不重新 executing；只有 resolve 可人工結案。 |
| 終態 / 任何事件 | ALREADY_HANDLED；其他非法組合 NOT_APPLICABLE。denied 永遠不寫 state。 |

**Approve 的完整 pure-event 路徑（修正 missing-command-transition）：** 呼叫端仍只呼叫既有 `transition`，不加 CLI/runner/service。傳入的 callback 在每次收到 latest 時取得新 now/context：latest 是 executing，就以該 state 的 owner、updated_at、timeout_sec 呼叫 creatorLiveness，產生 `{type:"approve",proof:null,creator:freshEvidence}`；latest 是 pending，產生 `{type:"approve",proof:freshProof,creator:null}`（origin/hash/confirmation 證據重新檢查；若新 now 已 rollback/expired 可帶 null proof，由純函式先判 clock/expiry）；unknown/終態則帶 null proof/creator 讓純函式拒絕。不先對 executing 一律拒絕，不先把 latest 改成 synthetic pending，不另外發布 lazy 再用原 pending proof 繼續。

EEXIST 必須回到 readCurrent → callback(new latest) → 新 now/probe/proof → decide，不能只對舊 event 再呼叫 pure function。例如 A 對 pending 決定 approve，B 先建立 executing，A 輸掉 n+1 後必須對 B 的 owner 重新 probe：B live → unchanged/noop；B dead → 競爭下一個 unknown，成功者回 committed/current=unknown，其餘重讀 unknown → refuse。recovery 贏家本次到此結束，不能再跑 approve；任何輸家看到 unknown/人工結案亦只能拒絕，沒有 unknown→executing 路徑。

`TransitionResult.committed` **不等於可執行**：未來可信入口只可在本次成功提交的 current.state.status==executing 且 owner==本行程時交給 executor；committed unknown/expired/tampered 都不得 spawn，unchanged/contended 亦不得 spawn。此階段沒有 runner；測試只以本地 harness 的 spawn spy 驗證上述判斷，不能宣稱已有執行整合。pure decideTransition 不自己 probe；callback 使用注入 probe/time，依序記錄讀到的 n/owner/now，驗證 fresh evidence。

transition 讀 latest → 每次呼叫 decide(latest) 重新取得 now/proof/liveness → pure decide → publish state/n+1。同序 EEXIST 重讀重判，**不宣稱輸家也成功**；若 latest 已處理，回 unchanged/refuse；仍適用才能競爭下一個合法 transition。default maxConflicts=32，耗盡回 contended（明示重試），不忙等、不 sleep。readCurrent 無 record 回帶路徑 CORRUPT_RECORD，不製造 synthetic pending；讀最高與鏈時遇 ENOENT race 重讀一次，再錯誤。不實作自動 executor action；遵循上述 committed/current/owner 條件，尤其 recovery 的 committed unknown 不能 spawn。

## S7 API：唯讀顯示、JSON、types-only 輪替

```ts
interface Display { readonly persisted: Status; readonly computed: Status;
  readonly unrecorded: boolean; readonly n: number; readonly updated_at: IsoTime }
computeDisplay(current: Current, nowMs: number, creator: Liveness | null): Display;
interface ApprovalListItem { readonly id: ApprovalId; readonly origin: Origin;
  readonly proposer: Proposer; readonly executor: string | null;
  readonly created_at: IsoTime; readonly expires_at: IsoTime; readonly display: Display;
  readonly reason: DeniedReason | null; readonly payload_sha256: Sha256 | null;
  readonly payload_bytes: number | null }
interface ApprovalListProblem { readonly id: string; readonly path: string;
  readonly code: ApprovalErrorCode; readonly hint: string }
interface ApprovalListJson { readonly schema_version: 1;
  readonly requests: readonly ApprovalListItem[]; readonly problems: readonly ApprovalListProblem[] }
serializeApprovalList(value: ApprovalListJson): string;
```

computeDisplay pending 超期 → computed expired；executing dead → computed unknown；其餘同 persisted。updated_at/n 永遠是已持久化序號時間，computed 不偽造新 audit/feedback sequence；無 state 使用 created_at/0。executing 必須 supplied liveness，缺 evidence拒絕，不隱含 alive。這個函式完全無 I/O，測試用 throwing write spy 與整樹 byte snapshot 兩種方法證明唯讀。serializer 驗證 v1，穩定 sort requests by id、problems by(id,path,code)，固定鍵順序、JSON.stringify + LF；不列 payload、summary、snapshot/env、執行器輸出。corrupt request 以 problems 明示，不偽裝狀態；serializer 不掃描磁碟、不代 list CLI 選擇預設篩選。

`approval-rotation.ts` **只有 export type/interface 與 doc comments，不宣告可呼叫的假實作或 throw stub**：

```ts
type RotationDestination = { readonly kind: "collected"; readonly seq: Sequence } |
  { readonly kind: "parked"; readonly attempt_id: string };
type RotationResult = { readonly kind: "empty"; readonly proposals: string } |
  { readonly kind: "rotated"; readonly destination: string; readonly proposals: string };
/** Caller holds COMMON per-slot coordination shared with manual gc/orphan/call cleanup,
 * from sequence selection through mutation/high-water/marker removal, not just a run lease.
 * Validate real slot/proposals, recreate ENOENT, skip empty;
 * directory rename then recreate0700; collected advances high-water only after rename.
 * Symlink/non-dir pauses only this slot. Does not mark done or parse requests. */
type Rotate = (home: string, slot: SlotRef, destination: RotationDestination) => RotationResult;
/** Same rotate contract, parked attempts never collected nor redo drafts. */
type Park = (home: string, slot: SlotRef, attemptId: string) => RotationResult;
/** Recovery hook: lookup a slot's proposals path only, undefined if not configured.
 * No mkdir. Claim-state/attempt attribution and park-before-abandon belong to stage3. */
type ProposalsOf = (slot: string) => string | undefined;
```

compile-only assignment assertions（Vitest expectTypeOf 及 `tsc --noEmit` 的臨時 test tsconfig）涵蓋三者；runtime module import 不建立目錄、不產生可呼叫 rotate。不能把 types-only 測試當輪替恢復整合已驗證。

## Slice 順序與 red/green 接縫

每 slice 目標產品碼 <=400 changed lines，tests 可使總量較大；每次 wake 約 7 分鐘上限，slice 不等於必須一 wake 完成。先做一組 red/green，剩餘 assertions 在 task memory/交 lead 的 partial 報告列出，再續同 slice，不虛報 PASS/完成；不得為趕時間略測。超過則依純函式/I/O 再拆，禁止單一 wake 填完整 store。node-engineer 逐 slice 實作，qa 最後用獨立 temp fixtures 驗收；cli-reviewer 負責實作 diff，本 architect 不 review。除 S5 export 外所有 slice **must not touch 既有 src/test/schema/config/CLI、manifest、lockfile、dist**；tests 全在上表新檔，不另加 fixture 檔，可於 temp 產生 worker script。

每 slice 必須保留以下四步紀錄（命令的 Vitest 檔案 filter 用該列 tests）：

- [ ] 先新增下表 assertions，執行 `npm test -- <test paths>`，確認因缺實作/錯行為而 FAIL（不是依賴或 loader 問題）。
- [ ] 按本 API 補最小實作，只改列明 allowed files。
- [ ] 執行相同命令至 PASS；補 `npm run typecheck` 與 `npm run lint`，不把 skip 算成功。
- [ ] 記錄紅/綠輸出、實際變更行數、scope；交 lead 分派獨立審查後才下一 slice，不 commit。

| slice / dependencies | allowed new modules（tests 同上表） | 必要 assertions / acceptance |
|---|---|---|
| S1 / Q2,Q6 | types/schema/paths/id | v1 schema 每個 union 分支、invalid version/date/hash/seq/name/path escape；全九種 denied 原因、四種 denied encoding domain；UTF8 byte-prefix golden、tuple 邊界、重播同 id、seq/run/call 改動不同、call paths 無 slot 層；import-time 無 fs calls。 |
| S2a / S1,Q1,Q7 | executors | missing 與 empty allows disabled、invalid YAML/schema/unknown key/multiple command/relative command、timeout missing、defaults、~ only/$ literal、same role different project、call union、sorted membership；load 沒讀 project/team/run，沒 mkdir。 |
| S2b / S2a,Q5 | origin | frozen input 不 mutate；fake resolver 收到 origin/executor；每個 error code；resolver throw；clear 模擬刪原 run/task/outbox/gitDir 仍同 hash；static sandbox.write/allowFiles/own-dir/records grant 改變 hash，未知新 static grant 也納入；same path static+run 不誤扣；同候選拓樸下 model/tier/session 改動無影響、binary 更新無影響、runtime/env/allow 改動有影響；fallback unset→none 與 explicit search 對照、localBinding/unixSockets 正規化獨立 literal assertions；不讀真 config。 |
| S3 / S1,Q8 | io | safe parent、terminal/ancestor symlink、directory/FIFO（scratch `mkfifo`）不阻塞、oversize/fatalUTF8、only ENOENT=null；short-write、fsync failure、EEXIST、ENOTSUP/EXDEV/EPERM/ENOSPC/EACCES；不叫 rename fallback；temp O_EXCL/mode/same-dir；temp write/sync/link/cleanup 四 crash windows、link後cleanup error 仍已提交且有診斷。此時先跑 S8 raw-link 8-worker barrier prototype。 |
| S4 / S1,S3 | store | payload EEXIST 相同續用、不同拒且不建 record；record EEXIST 用先提交時間/snapshot；precommit crash incomplete reader不列pending，重入補完；commit 後 crash/狀態推進到 executed 再 replay 不寫 payload/state/record；corrupt existing record/source collision拒絕、deny 無payload；hash/copy同buffer。 |
| S4b / S3,Q4 | high-water | missing=0、2/10/.done numeric、只減內容不減 highwater、corrupt/oversize/symlink/unsafe integer fail-closed；max safe +1拒；模擬 rotate rename完成但 highwater未寫由 dir恢復；模擬 gc先advance再刪dir/marker仍不回頭；temp寫入/rename前後crash舊新完整；同一共同協調範圍內 rotation/gc 的序列呼叫只增（包含 orphan/call）；文件/型別comment 固定完整 critical section、不聲稱parallel安全。 |
| S5a / S1,Q3 | liveness；project-lock export | dead PID、live match、comparable mismatch立即dead、unverifiable elapsed threshold-1/threshold/threshold+1；EPERM/unknown signal、start throw/undefined、locale不比較、clock rollback、invalid input；stub probe不跑真ps；原 lockHolderAlive 行為未動。 |
| S5b / S1,S5a,Q9 | transition | §4.5 每列（含每項 approve proof單獨false、approve 對 live executing noop、dead executing unknown、unknown不重啟）、拒 clock rollback/own pidStart缺失、exact expiry；executor0/non0/spawn/timeout/signal；非creator不可完結；interrupt unknown；unknown只能manual resolve；terminal無append；所有audit欄位、output byte caps、immutable inputs、sequence overflow。 |
| S6 / S3,S4,S5b | state | 10>2、n/previous錯誤、最高 unreadable/invalid version/壞schema/缺鏈/alias/overflow不退回2；denied 無狀態；強制 pre-link EEXIST，re-read callback記錄新 n/now/owner/probe/proof；approve pending→別人executing 後重probe的live/noop、dead/unknown、unknown/refuse三種競態；recovery贏家/輸家 spawn spy均0；approve vs approve/expiry、dead→unknown輸家不得再append；32 conflicts明示contended；executed寫失敗留executing，注入dead後unknown；link成功cleanup失敗只一條state。 |
| S7 / S1,S5a,S6 | display/json/rotation | 過期/死亡顯示、n/updated_at不造假；tree byte snapshot + throwing write spy；serializer exact golden/version/sort/no秘密/problems；types-only簽名可typecheck、無runtime rotate export與I/O。 |
| S8 / S3,S4,S5a,S6 | concurrency test only | 下節真實 first-target-link barrier tests，assert EEXIST 與 refreshed callbacks，不能 Promise.all 包 sync API 代替。整套 regression/新doc checks 成功；scope之外 diff 只有 pidStart export。 |

S4 中「advanced state replay」可先以有效 1/2.json fixture 建樹，不必依賴尚未存在 S6 writer，避免循環依賴。S5a/b 分開 fresh wake。S8 原型先驗 hard-link，最終再用真 store/state，不能因底層 link 成功就省略 API 競爭測試。

### 真併發原型與 crash 設計（不是 sandbox 實驗）

`test/approval-concurrency.test.ts` 用 Node worker_threads + SharedArrayBuffer barrier，8 workers；temp script 由測試於 scratch 寫入，透過已編譯到 scratch 的 ESM 新模組 import，使用 process.execPath/Worker，不需 tsx pipe/server。測試用 TypeScript compiler API 或外部 tsc 將 `src` 編譯到 scratch `outDir`（不寫 source dist、不改 tsconfig）；所有 workers import 同版本。raw-link worker只用node:fs，先做 portable probe。每個worker ready→Atomics.wait，parent收齊8個ready後Atomics.store/notify，不靠sleep撞運氣；worker fs真同步、distinct tokens，**不是同thread順序任務**。

raw-link 原型沿用 ready/start barrier。**API 競爭另加 test-only first-target-link barrier**：每 worker 包裝注入 `ApprovalIo.linkSync`，只有第一次目標是該 `record.json` 或指定 `state/<n+1>.json` 時，且已完成 API 決策/temp write/fsync，才 post ready 並 Atomics.wait；parent 收齊 8 個後放行。payload link 不用同一 barrier；重試與其他 target 不再等待，避免 deadlock。wrapped linkSync 真正委派 fs.linkSync，catch EEXIST 後記錄觀察並原樣 rethrow，由正式 API 處理；不注入假 EEXIST、不增加產品 hook。parent 斷言8個都在預期 target 就緒才釋放，才能證明每個loser已經決定要寫，而非起步時就讀到winner。

1. 同 record：8個相同source/payload、不同created_at/snapshot的合法候選競爭，在 record.json target link 才同步。exactly one created、7 existing，wrapper 觀察到恰7次 record EEXIST；最終record完整等於贏家，payload字節一致。排除payload EEXIST計數，不能只靠1 created就稱有走record衝突分支。
2. 同 n+1：所有workers對同一pending決定reject（或另一獨立案例approve），在state/1.json target link同步；1 committed n=1、7 target EEXIST。losers 的 callback 至少呼叫兩次，記錄最新 n=1 與第二個注入 now，不得使用初次event。reject winner 後losers拒絕；approve winner 後losers重新probe最新owner。另混合approve/expired競爭，不預設哪方勝。
3. approve recovery：先seed executing，8 workers的 approve callback fresh probe判dead，在下一個state link同步；1 committed unknown、7 EEXIST後重讀unknown/refuse，只有一條unknown、鏈連續，所有spawn spy為0。另以S6可控競爭驗pending決策輸給新executing後，fresh now/probe跨grace或creator已死轉unknown；live creator unchanged不寫，回傳不能當spawn授權。
4. SIGKILL 實際child進程補充（inline `node -e` script，無新fixture）：在 temp_synced、linked barrier後 parent kill，wait exit，再重入；前者無target、後者target完整且可讀。執行者創建executing後crash，other process以 approve fresh probe判dead後寫unknown，不重新executing。取得ps若sandbox不許，真liveness案例明示unverified，不能skip再說已驗證；pure注入測試仍必跑。

每案例timeout<=20s；finally terminate/join所有workers與child、刪scratch。macOS/Linux hard-link能力失敗使prototype FAIL（不 skip）；Windows 明示unsupported，可skip平台原型但不算macOS/Linux證據。unsupported-link 故障注入測試必跑且證明 fail-closed。assert exactly-one 的對象是成功link/API created，不是last writer內容。所有 fault 點留temp或直接模擬殘留，重入不掃/刪其他writer temp；沒有gc實作。

## 驗證與交付責任

- **node-engineer:** 只實作上列module與tests、pidStart export；每slice交紅/綠證據，不做stage2–6。pure函式顯式now，I/O注入ApprovalIo，random token注入，fault hook每呼叫，不用全域freeze clock或真config。module schema contract如需調整先報lead，不能自己放寬。
- **qa:** 重跑九交付matrix、真worker/process競爭、fault windows與相容scope；測試runtime行為只用fake-runtime fixture，stage1無runtime呼叫可驗。獨立temp AGENT_LYCEUM_HOME/scratch repo，既有tests不改；記錄macOS/Linux各自已跑與未跑，sandbox deny與dependency失敗不得當產品bug或綠燈。
- **docs-writer:** 依原授權新增短文件 `docs/approval-store-api.md`，以本已定版契約為來源（不把長 plan 當短 API doc）。列 module exports/最小直接呼叫範例、LP/version、error codes、approved Q1 integration deferral、共同協調前置條件、approve recovery/committed不是spawn授權、default-off/未做階段；核對signature及相對links並跑check:docs。不需要另批scope，不建立新CLI教學（尚無指令），不改spec/README/config docs；stage2–6另任務更新雙語命令/設定/write-scope。本 architect revision wake 只改本plan，不代寫短文件。

### 無本地 node_modules 的可重現檢查

本 worktree 沒有 node_modules，不能建立node_modules symlink、安裝到原source或改主checkout。`npm run check:docs` 使用Node builtins，可直接跑。其餘完整套件驗證在 **可丟棄的實體複本**：

1. `mktemp -d` 建scratch；用 `git archive HEAD | tar -x -C "$scratch"` 匯出tracked基底，再複製目前允許新增/修改的檔案到對應路徑（此文件、docs-writer 的短API文件、新approval src/tests、project-lock），不要漏掉untracked。
2. 在scratch `npm ci --ignore-scripts --cache <可用cache>`（離線先 `--offline`，無cache則明示依賴取得未驗證，由有網路的runner執行）。有受信任且lock完全相符的既存dependency tree時可**實體複製**，不可symlink；先記錄版本與lock hash，不借不相符版本當正式驗證。package-lock 根version與package.json目前不同，不自行修檔，讓npm ci實際結果說話。
3. 在scratch 執行 `npm run lint && npm run typecheck && npm test && npm run check:docs`。新test compile-only型別檢查用scratch臨時tsconfig，extends原tsconfig，覆寫rootDir為scratch根目錄、noEmit=true、include為src與test/approval-*.test.ts，moduleResolution沿用原tsconfig。package scripts不覆寫，不關掉失敗測試。
4. 原樹 `git diff --check`、`git status --short`、`git diff --name-only`，確認不含生成物/非授權檔。本次設計只有本plan；實作完成既有tracked變更只允許project-lock單字export。

只有外部binary PATH不足：TS與Vitest import resolution，以及既有test硬寫node_modules/.bin/tsx依賴需要實體依賴樹。完整結果保留exit code和錯誤；本階段不執行npm install、不跑真runtime、不開server。docs checker範圍有限：再用Node builtins解析本文件所有相對Markdown links並assert target存在。本文件無對雙語配對heading的改動。

## Dimension coverage

| 維度 | 處理 |
|---|---|
| Compatibility & Format（相容與格式） | v1 record/state/list，LP domains、strict validators、未知版拒；不改既有config/run/mail/CLI，舊binary不使用新store；Q1明示整合延後。 |
| File & Process Safety（檔案與行程安全） | no-follow+nonblock+capped、祖先檢查、私有目錄、exclusive/fsync/link、拒fallback；不把chmod/prompt當sandbox，不spawn執行器；signal資料只純轉換，process tests finally回收；無shell插值。 |
| Concurrency & Recovery（並發與復原） | immutable record commit、數字CAS state、EEXIST重判、fault/realworker；無stale approval lock；approve fresh recovery與重試、recovered unknown不得spawn；Q4 rotation/manual gc/orphan/call需共同coordination，Ctrl-C/timeout/spawn模型明示unknown/failed；resume重播保留已前進狀態。 |
| Platform & Operability（平台與可維運） | macOS/Linux native硬連結原型，Windows拒寫；Claude/Codex無adapter改動、default-off，真沙盒/Linux發布證據未驗證；沒有wake loop/timer overhead，新reader O(entries+audit鏈)僅顯式呼叫；無新依賴。 |
| Testability & Maintainability（可測試與可維護） | 小純模組+注入clock/fs/random/probe/resolver，temp fixtures，red/green slices；不碰realhome；類型與穩定bytes golden共享契約。 |
| Observability & Diagnosability（可觀測與可診斷） | errors帶code/path/hint，record origin/hash/snapshot與state actor/previous足稽核；list problems明示損毀；無log.jsonl/state.json/mail/violations整合（stage1 N/A）；將來caller須把diagnostic寫run log並交doctor/status，不在stage1假接線。 |
| Trust & release（額外） | 不把injected premise proof當OS驗證；static hash非秘密保存或讀隔離；人類§8.0 evidence與此原型分開，沒有宣稱功能可發布。 |

## Open items

Q1–Q9 已由 lead 採納（決策表保留 owner/採納值/拒絕替代方案），沒有待裁定的 Q default；本 round 的 review findings 均已指定可測契約，待 lead 分派 cli-architect-reviewer 重新審查，無額外使用者批准。stage2–6、人類sandbox發布關卡、Linux實機、共同slot coordination實作均本次不做；不能在最後報告寫成完成。reviewer如發現schema無法滿足spec，由lead帶回architect重新決策。

## Risks / Decisions made for the lead

- Q1是可見的scope衝突；lead採納standalone wrapper，拒直接改ResolvedAgent；必須在最後deviation清單保留，不能稱零偏離。
- Q2/Q6/Q7為spec未定的持久化bytes、denied欄位、caps與loader數值選擇；lead採納v1與fail-closed，拒沿用未批准v8或默猜；先定再落golden，發布後不可悄改id。
- Q3選擇grace等號與PID比較證據；拒fail-open lock helper。ps不同卻不可證明同表示環境時延至grace會暫時顯示處理中，是明示限制。
- Q4共同coordination是外部前置條件，含manual gc/orphan/call完整critical section，既有run lease不足；stage1不建立鎖，stage3/6接線前必須共用協定序列化或拒絕重疊，拒把rename的atomic replace說成atomic max。
- Q5 provenance是額外resolver輸入要求；拒run-id路徑heuristic及靜態grant白名單，避免clear後無法核可或漏grant變更。
- Q8信任private父目錄與同UID操作者，不提供read isolation或完整pathname TOCTOU保證；拒native dependency與無證據OS安全宣稱。mode0400非immutability安全邊界。
- Q9已採納approve fresh lazy recovery（含每次CAS retry）而非無條件拒executing；committed unknown不是spawn授權。proof由未來可信入口提供而非此store可驗證；拒把purebool表當已實作核可/TTY/群組終止。執行器odd exit只定資料/轉換，本stage不跑真外部動作。
- 新增state predecessor驗證與metadata cap是保守fail-closed設計，拒讀壞最高後回退；代價為長audit鏈讀成本，第一版無daemon且只顯式呼叫，暫不加cache/index。
- 信任committed v12/v12.1多於shared context的舊版本摘要；人類macOS記錄只引用不重宣稱。無本地依賴時用scratch實體副本，拒主樹安裝或symlink；network/cache缺失明示unverified。

## Round 1 review disposition

- Major missing-command-transition：approve event 帶 creator evidence，executing先懶惰處理，CAS每次fresh，unknown不得重啟；S5b/S6/S8對應純規則、重試、真並行測試。
- Minor Q4：共同 canonical slot identity 與完整critical section明訂，run lease不當證據；S4b只測serialized helper前置條件，無新鎖。
- Minor contention：ApprovalIo包裝first-target-link barrier，測試必須assert真EEXIST與callback refresh；raw-link、真child kill和20s finally清理保留。
- Minor doc：docs-writer新增短docs/approval-store-api.md已授權；本wake仍僅編輯plan。
- Q1–Q9採納狀態及candidate-effective fallback mapping已同步，保留拒絕方案、六維度、額外release信任限制與約7分鐘wake切分。
