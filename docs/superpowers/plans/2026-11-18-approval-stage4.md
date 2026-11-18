# Approval stage 4 Implementation Plan

> **For agentic workers:** 依既有 mail team 流程，lead 每片寄一封 implementation task；node-engineer 實作、cli-reviewer 審查、qa 驗證。只在設計審查通過後實作。不得 commit、push、PR、merge。本文件不是測試通過或發布聲明。

**Goal:** 完成 spec §10 task 4：enrolled `call` 的逐候選輪替、成功標記、收走與冪等補收；未列入的 call 逐位元相容。

**Architecture:** 重用 rotation、collector、call lease 與 sandbox adapter；新增小型 `approval-call.ts` 組合邊界，不新增 store 或 runtime 抽象。`ok.json` 是成功輸出的提交點，`result.md` 不是收走條件。

**Tech Stack:** Node >=20、TypeScript ESM，Node fs/crypto；package 0.42.2。沿用 lockfile：宣告 commander ^14.0.3、yaml ^2.5.0、zod ^4.6.5、TS ^7.0.2、Vitest ^4.1.11、Biome ^2.5.15（`package.json:3,34,53-64`）。不加依賴、不升級。

**Spec:** [approval gate](../specs/2026-11-13-approval-gate-design.md) §4.1、4.4 call 段、4.9、6 item 8、9、10；[store API](../../approval-store-api.md)；[stage 3 plan](2026-11-17-approval-stage3.md)。原始 user-task 優先於本計畫；如發現真正矛盾，停止並報 lead，不自行選邊。

## Global constraints / 邊界

- DEFAULT-OFF；沒有 executors.yaml、empty allow、只列其他 tuple：原 invocation、prompt、policy、stderr、result 與目錄內容不變。不得更新 compat fixture。
- 不改 executors.yaml、stage 1/2a 的任何 schema 或函式簽名；approval record/state/qualification 的 schema_version 仍為 1。下面的新 marker 是先前僅保留路徑、未定內容的新檔案，不是修改既存 schema。
- 不改 stages 5–6、status --json、web COMMANDS、run dispatcher、run-state、mail 或 worktree 格式。`approvals list` 尚未在本片實作，不可宣稱能用。
- macOS/Linux 沿用既有 premise gate；Windows 不新增支援，沿用警告／拒絕；Linux、Codex 與真實 sandbox 驗證不在本任務，維持「非可發布：第 0 步未驗證」。

## Current evidence / 現況與缺口

| 現況 | 可重現來源 |
|---|---|
| call 先解析 agent、檢查 --dir，再 gate；gate 前不建 call dir 或 lease | `src/call.ts:146-180` |
| resolveCallAgent 用 project:null enrollment；callProject 的 name 卻是 `(call)`，solo 是 call | `src/call.ts:21,61,77-99` |
| call 每 model retry=0；fallback callback 沒有 proposalsDir；guard 後只寫 result，finally release | `src/call.ts:193-235` |
| attempt 是跨 candidate 的 0-based 序號，candidateAttempt 換 model 會歸零；config failure 停止，包括 legacy | `src/fallback.ts:115-118,163-167,233-258` |
| collectSlot/prepareSlot 需要 config、origin、inputs、premises；collector 自己拿 .coord、先處理 un-done 再 rotate；失敗回 verdict | `src/approval-collect.ts:38-50,145,394-465` |
| prepareSlot 可能收走舊 collected；不能拿它當「沒有 ok 的 call」的一般 preflight | `src/approval-collect.ts:416,429-439,463-465` |
| call slot 的 ok 在 requests/calls/<id>/ok.json，不在 calls/<id> | `src/approval-paths.ts:52-64` |
| snapshotInputs 用 project.name 求 qualification；call allow 必須 project:null；直接拿現有 snapshotInputs(callProject) 得不到 call executors | `src/approval-snapshot.ts:54-75`、`src/approval-executors.ts:79-87` |
| proposals 是 run-only，不進 qualification hash；完整 grant 可另取 | `src/approval-snapshot.ts:21,35-47,62-75` |
| allowDirs 有既存可選 proposalsDir；adapter 已接 WakeInput.proposalsDir | `src/policy.ts:205-225,235-244`、`src/adapters/types.ts:31`、`src/adapters/claude.ts:86-89` |
| buildSystemPrompt 可在 solo 基本文字後加 approvalRequestsBlock；call user prompt 無可選參數 | `src/prompt.ts:201-222,225-226` |
| gate containment 比對靜態 grants，不含 proposals；requests 整體受保護 | `src/approval-wake-gate.ts:369-379`、`src/doctor-approval-containment.ts:367-370,437-449,476-479` |
| .coord 是同步 callback 的短鎖，finally 式釋放；不可把 Promise callback 當作跨 await 鎖 | `src/approval-rotation.ts:150-174` |
| 現有 call lease 同角色互斥，拒絕 live holder，dead/unreadable holder 接管 | `src/call.ts:116-142` |

這些是 stage 4 尚未接線的缺口，不是互斥規格：spec 已明定 call 需新增能力。特別修正 snapshotInputs 的 call identity 是 stage-3 helper 的實作擴充，**不改其簽名**。若實作者發現其他矛盾、必須動 stage 1/2a 簽名／schema 或 fixture，停工交 lead 問使用者。

## Locked decisions / 決策

### D1 — grant、prompt、containment

只在 agent.enrolled 分支做以下工作；未列入保留目前 callback 及兩個 prompt builder 的呼叫。新增 helper 使用現有 `snapshotInputs(project, agent.name, config, proposalsDir)`；在 `approval-snapshot.ts:59` 將 qualification identity 改為 `project.solo === "call" ? null : project.name`。其餘候選／grant／hash 演算法不變。

每次 invoke callback 先確認 proposals 存在、為真目錄且空，才設定 WakeInput.proposalsDir。enrolled system prompt 改用 `buildSystemPrompt(project, agent, proposalsDir)`，它會走現有 solo 基底再附格式說明。user prompt 保留 `buildCallUserPrompt` 原文，在 call.ts 附 `\n\nApproval request directory (see the system prompt): ${proposalsDir}`。不擴任何 prompt 函式簽名；透過 WakeInput 讓 adapter 呼叫既有 writePolicy，不能用 input.policy override 繞過 invokeWithSandboxChecks。

gate 保留在建目錄之前；每候選開始前重驗 gate 與資格 baseline（D2）。containment 的靜態 grant 故意不含唯一本人的 proposals 例外，不能把 requests 父目錄加進 allow，也不能拿含 proposals 的 full grant 對整個 requests 做重疊檢查。具體例外由 requestPaths 精確定位、rotation 的逐祖先 lstat 與 policy 的 own-slot 排除組合；測試別人 proposals、ok、collected、parked 與 store 仍不可寫（`src/approval-policy.ts:60-64,126`）。不承諾同 UID 敵手競態或讀取隔離。

**Rejected:** 新增 buildSoloSystemPrompt/buildCallUserPrompt 參數（不必要）；把 proposals grant 塞入 sandbox.write（擴大設定、改 hash）；對 requests 全樹開放（破壞安全邊界）。

### D2 — 新檔 ok.json 與 snapshot 來源

`requests/calls/<call-id>/ok.json` 精確 local v1 shape（strict parsing，拒絕未知欄位；role/executor keys 用 approvalName，paths 必須 absolute 且無 NUL，arrays 僅接受字串）：

```ts
interface CallApprovalOk {
  schema_version: 1;
  call_id: string;              // approvalSourceId；必須等於 CLI id
  role: string;                 // approvalName；global agent 名
  project_dir: string;          // canonical --dir，非 home/callDir
  successful_attempt: number;   // safe integer >=1，跨 candidates 的 ctx.attempt+1
  full_writable: { dirs: string[]; files: string[] }; // 成功 wake 的 canonical full grant
  qualifications: Record<string, string>; // executor name -> qualificationHash，非空、64 lowercase hex
}
```

不存 task、payload、runtime output、env 或整份 config。baseline 為第一次 invoke 前的 snapshotInputs（完整 fallback 候選清單，不只當前 model）；成功 marker 帶該 baseline hash 與成功 wake 的 full grant。每候選前／收走前以目前 global team、fresh executors config、記錄的 project_dir 重建 callProject；executor key set 與每個 hash 須精確等於 baseline。不得在設定漂移後以新權限替舊輸出建立新資格。

收走 input：home = canonical CLI home；slot = `{kind:'call',call_id}`；agent = marker.role；runDir = `<home>/calls/<id>`（collector 此欄沿用介面，不能創造 run state）；origin = `{kind:'call',call_id,role,project_dir,full_writable}`；config / inputs 從 fresh view；premises 重新檢查，**不可從 marker 讀一個舊的 ok 布林**。gate 可回 wake 時轉成兩筆 `{check:'project-premises'|'containment',ok:true,code:'ok'}`；非 wake 不呼叫 collector。收走前 canonical --dir 必須仍存在且相同；不存在／symlink 改指向則 retain，不換到其他 cwd。

發布：序列化 JSON + LF，最多 1 MiB；超限在 wake 前拒絕（先以 successful_attempt=Number.MAX_SAFE_INTEGER 驗證 baseline 可序列化且整份 marker 不超限），成功時在短 `.coord` 內用 `publishExclusive` 寫 0400 temp + fsync + link，不覆寫、不改成 rename；同名已存在須安全讀回、逐欄相同才接受，否則 fail-closed。讀取用 `readApprovalFile(ok, 1048576, home)`，含祖先安全／nofollow／nonblock；invalid JSON/shape/version 一律拒絕，缺檔才是 no-op（`src/approval-io.ts:72-81,154-198`）。不做電力中斷持久性承諾。

舊 binary 忽略此新檔與新 requests 子樹，不會自行補收；不認識新 approvals command，回既有 unknown-command 錯誤；既有 team/project/run/state 讀法不變。未來 marker version 不是 1 時新 reader 明確拒絕，不能當作成功或缺檔。

**Rejected:** 空 marker（遺失 --dir 與角色）；存整份 team/config（含敏感資料且過期）；只看 result.md（違反 crash 規格）；補收時任意接受新資格（權限漂移）；改 stage-1 Origin/record schema（不需要且需使用者批准）。

### D3 — 每候選 preflight、失敗與取消

在既有 runWithFallback.invoke callback 內，sandbox invoke **之前**執行，單候選與 chain 相同。n = `String(ctx.attempt + 1)`；不使用 candidateAttempt（不同 model 會撞號）。目前 retry=0 不變；未來即使 retry>0，ctx.attempt 仍不重複。

preflight 在短 withSlotCoord 內確認 proposals：若已存在，用 lstat + opendir/read 一個 dirent 確認真目錄且空；若缺失，用 `rotate(home, slot, {kind:'parked',attempt_id:n})` 的 missing/empty 分支重建。已非空且無已知成功標記時拒絕，不猜它屬於誰，也不收走。所有空目錄也經 rotate 的 high-water 檢查。確認後才 canonicalize/grant。不在 live wake 持 .coord。

runtime 的普通 throw 仍轉既有 failed WakeResult。**只包 runtime await 的 catch**；新 fault seams 不能被此 catch 吞掉。若 result.ok=false 或 result.cancelled=true（亦含 timeout），在 callback return 前 `rotation.park(home, slot, n)`，不管下一候選是否存在。park 失敗：log，將普通失敗改 `{ok:false,kind:'config',...}` 停止 fallback；取消則保留 cancelled，結束且無 ok。不可為了繼續而混入上一候選輸出。已 aborted 的 enrolled call 在 invoke 前回 cancelled、不啟 runtime、無 ok（未列入舊分支不改）。成功即使 abort 隨後到達，已返回的成功結果仍提交；如果 runtime 回 cancelled 或訊號在啟動前已取消則不提交。

preflight 失敗回 `WakeResult`（ok:false, text:'', exitCode:null, timedOut:false, kind:'config'），error 固定為 `Approval call not started: proposals could not be confirmed empty. Run agent-lyceum doctor; inspect requests/calls/<call-id>.`，不叫 invoker、不試下一候選。park 失敗 error 固定 `Approval call stopped: failed-attempt proposals could not be parked. Inspect requests/calls/<call-id>.`。id 僅用 validated callId，不插入 filesystem error/payload。

**Rejected:** prepareSlot 當 preflight（它會在沒有 ok 時處理 un-done）；只首候選清空（失敗輸出污染）；盲目 park 不明殘檔（掩蓋資料歸屬問題）；park 失敗仍 fallback（混收）；整個 invoke Promise 放在 withSlotCoord（同步 helper 提早解鎖）。

### D4 — finalization 的精確順序與 fault

取得最終 outcome 後：

1. 現有 `guard.check([agent])` 與 reverted 警告。
2. enrolled 且 result.ok、非 cancelled：發布 D2 ok（只寫一次，成功 attempt=n）；`fault('call:ok-published')`。
3. 現有 atomicWrite result.md（成功／失敗文字完全沿用）；enrolled 成功後 `fault('call:result-written')`。
4. 只有已成功發布 ok 才 fresh-view + collectSlot（它自行 rotate 非空 proposals，先補未 done）；`fault('call:collection-finished')`。
5. 返回原 CallResult；finally lease.release。

enrolled 失敗 callback park 後 `fault('call:failed-proposals-parked')`。rotation／collector deps 的 fault 轉交既有 message-store.fault，沿用 rotation:renamed、rotation:recreated、collection:* 與 store 提交點。**所有新 seam 僅在 enrolled 分支**（`src/message-store.ts:8-14`）；不能改未列入 integration 的 fault 序列。

marker publish 失敗是成功提交失敗：throw 固定 `Approval call success marker could not be committed; no collection was attempted. Inspect requests/calls/<call-id>/ok.json.`，不寫成功 result、不 collect，CLI 1。result.md 寫失敗保留已提交 ok，CLI 1，後續可補收。collector 的 skipped verdict 或 fresh config/premise failure只 log／提示，不改成功結果、exit code 或 result.md；意外普通 collection 例外也如此。fault('call:ok-published') 等用來模擬 crash 的 throw 必須在可吞 collection 錯誤的 catch 外。

接受窗口：ok 已提交、result 尚未寫時 crash，請求可補收但沒有答案檔；不重建 result、不自動重跑 call。ok 前 crash 一律不補收，即使 runtime 其實已完成。無 call resume。

**Rejected:** result 先於 ok（可能永久漏收）；collector 失敗讓 call 失敗（違反 user-task）；guard 前收走（違反順序）；成功 marker 跟每個 candidate 都寫（誤認失敗輸出）。

### D5 — recovery CLI、鎖與冪等

新增 `program.command('approvals')` group，子命令 `collect`，requiredOption `--call <call-id>`；無 positional、無 run target、無 --json，本片不加其他 approvals 命令。用現有 home() / try-catch / fail 模式（`src/cli.ts:46,573-603,959`）。不進 web COMMANDS。

流程：canonical home + approvalSourceId → **安全讀 ok，缺檔立刻 exit 0**，stdout `Call <id>: no ok.json; nothing collected.`（不建 requests、approvals、log 或 lock）→ strict parse marker → 取得 lockAgent(home, role, fresh newRunId()) 排除仍活著的 call／另一個補收 → 再讀 marker、確認相同 → fresh view / baseline 比對 → collectSlot → finally release。不得依賴 result.md、不得啟 runtime、不得讀 parked。未列入／agent 消失／executors 移除：retain，exit 1；不是把該 call 改成 failed 或丟掉 request。

`.coord` 是 collector 的短鎖；**live call 不保證持有 .coord**。live call 的第一道排除是 `.lock-<role>`（現有訊息 `<role> is already being called ... Wait for it to finish.`）；已有 ok 且 .coord held/stale 時 collector 回 DIR_ANOMALY + class held（源自 CoordHeldError），CLI 1。不偷 .coord；訊息 `Call <id>: approval collection blocked (DIR_ANOMALY). See approval_collect diagnostics; stop all calls before removing a stale .coord.`。無 ok 的 live call 仍只 no-op，不收失敗輸出。lockAgent 的既有 stale 規則不另改；不是新增 ps 或 lock schema。

成功 stdout 固定 `Call <id>: approval collection complete.`，exit 0；不列數量（第二次與第一次輸出相同）。second successful pass 只保證持久檔案的檔名、bytes、mode、mtime 不變；目錄 mtime 在不變量之外，不宣稱整棵樹的 metadata 不變。`.lock-<role>` 與 `.coord` 在 pass 進行中可以存在，結束時必須不在。成功空 pass 不寫 log、不更新 done/high-water/marker；由 collector 既有 empty 行為達成。只對實際失敗 append 診斷；跨程序重新載入、不靠記憶體去重。

**Rejected:** .coord 跨 runtime 長持（同步 API 不支援，且變更鎖模型）；只靠 ok 判斷 live call 已結束（finalization 還在跑）；無 ok 回 1（腳本恢復可安全 no-op）；executors 不在時以 marker 內舊 config 收走（繞過撤銷）；重建答案（不是本任務）。

### D6 — diagnostics、no feedback

新增 failure wrapper 用固定分類 JSON `approval_collect`（slot=role、op/class，沿用 CollectLog）；call 原本 sandbox event 走 stderr（`src/call.ts:220`、`src/sandbox-invocation.ts:42-45`），enrolled approval diagnostics 同時透過 say 到 stderr，及 append `<home>/calls/<id>/log.jsonl`。只在失敗才 lazy 建立 `createRunLog(file, project.dispatcher.log_max_bytes)`（`src/run-log.ts:7-20`），外層 try/catch。此診斷非 journal/replay authority；首次 append 前若末 byte 非 LF，先補 LF，避免 torn tail 吞掉下一筆；成功 pass 不建立 logger。不寫 state.json、mail 或 violations（call 沒有 run state）。只有失敗 append；記錄不能含未處理 errno 文本、payload、executor env、request 檔名；wrapper 失敗用 op:pass/class:io。logging 自己失敗不能改成功 call，但要 best-effort stderr 固定 `Approval call diagnostics could not be persisted.`。

fresh view/config/role/path/hash 不可用：stderr `Call <id>: approval collection retained (<CODE>); fix configuration or run agent-lyceum doctor, then retry approvals collect --call <id>.`；CODE 取既有 gate 固定 code。malformed marker：`Call <id>: invalid or unsupported requests/calls/<id>/ok.json; no collection attempted.`（exit 1）。collection skipped：同 retained 模板，用 verdict.code；held 用 D5 訊息。marker/result 寫失敗見 D4，result I/O 沿用既有具檔名的錯誤。終端錯誤均指出檔案／setting 或診斷入口。

call prompt 只說如何提出 request，不附 request status/denial/executor output；不寫 `.feedback/`，也不把 pending/denied 結果塞回 WakeResult、prompt 或第二次 invoke。`status` 不新增 call gate section；既有 doctor 診斷 config/premises，call 專用故障看本 call log 與 CLI。

**Rejected:** 成功 recovery 每次寫 audit/log（破壞第二次 state 相同）；將 log 進 state.notes（會影響 status --json）；給 agent 即時 collector 反饋（stage 5–6 外、call 沒下次 wake）。

## Two mergeable slices / 實作與測試

### S1 — enrolled call lifecycle（node-engineer；lead 一封 task）

**Allowed:** `src/call.ts`、新增 `src/approval-call.ts`、`src/approval-snapshot.ts`（僅 D1 call identity）、新增 `test/approval-call.test.ts`、新增 `test/approval-call-crash.test.ts`、延伸 `test/call.test.ts`、`test/approval-compat.test.ts`。既有 fixture 只讀。**Must not touch:** cli.ts、stage 1/2a modules、其他 schema/signature、run-session/dispatcher、web、其他 docs、dist、lockfile。

**Interfaces produced by approval-call.ts:** `CallApprovalOk`（D2）；`callApprovalView({home,callId,role,projectDir,premise,expected?})` 回 `{ok:true, project, agent, config, inputs, origin, premises, qualifications}` 或 `{ok:false,code}`（沿用 GateCode）；`readCallApprovalOk(home,callId): CallApprovalOk|null`、`publishCallApprovalOk(home,ok): void`；`collectCallApproval(home,ok,deps): CollectResult`（fresh view + 精確 baseline 比對後才 collectSlot）。deps 包含 `premise:PremiseOptions`、`collect:CollectDeps`、`log`；production defaults 沿用 defaultCollectDeps、runtime platform/userHome；測試 inject。helper 無 CLI、無 runtime invoke、無 lease ownership；呼叫者必持 call lease。新 pure parse/shape validation 私有，重用現有 primitives；不新創總體 interface framework。

- [ ] 先寫下表 S1 named tests，跑出正確原因的 red；再按 D1–D4 接線與 D6 診斷，完成 green。
- [ ] S1 acceptance：成功含 marker、record，失敗/取消只有 park；new recovery helper 能直接補 crash，尚無 CLI；所有未列入 fixture bytes 不動。
- [ ] Verify: `npx vitest run test/approval-call.test.ts test/approval-call-crash.test.ts test/call.test.ts test/approval-compat.test.ts test/approval-rotation.test.ts test/approval-collect-crash.test.ts test/integration.test.ts`。不能跑的測試列原始錯誤，不宣稱 green。

### S2 — approvals collect --call（node-engineer；S1 收妥後另寄 task）

**Allowed:** `src/cli.ts`、`src/approval-call.ts`（新增 recovery entry）、新增 `test/approval-call-cli.test.ts`、延伸 `test/cli.test.ts`。可只讀 S1 測試/helper。**Must not touch:** S1 call lifecycle（問題交 lead）、stage 1/2a、schema、fallback、web COMMANDS、status、fixture、dist、lockfile、其他 docs。

**Interface produced:** `collectApprovedCall({home,callId,premise?,collect?,say?}): {kind:'absent'|'complete'} | {kind:'blocked',code:string}`；安全讀 marker、lease、fresh view、收走、release 全在此同步邊界。unsafe marker/id/lease acquisition throw，CLI 用 D5–D6 固定文字轉 exit 1；不外洩 parser payload。pure result 不呼叫 process.exit；CLI 印固定 stdout、blocked 用 fail。完整 S1 helper 仍可獨立使用，S2 不改既有簽名。

- [ ] 先寫 S2 named tests，確認 red；依 D5 wire CLI，再測 green。
- [ ] Acceptance：跨程序補收、第二次成功後持久檔案的檔名／bytes／mode／mtime 不變且 `.lock-<role>` 與 `.coord` 已不在、無 ok 完全不寫、live/held/config 撤銷 fail closed；COMMANDS 不含 approvals 任何 entry。
- [ ] Verify: `npx vitest run test/approval-call-cli.test.ts test/approval-call.test.ts test/approval-call-crash.test.ts test/call.test.ts test/approval-compat.test.ts test/cli.test.ts test/integration.test.ts`。

### Named-test contract / 每句 spec 對應

下列名字是實作時的精確 test title；同一測試可有 table cases。

| spec 句子／風險 | slice、test title 與必斷言 |
|---|---|
| §4.4 每 fallback 嘗試前 empty；§4.1 空才 grant/prompt | S1 `call prepares an empty canonical proposals directory before every candidate`：第一與第二 candidate 進入 fake invoker 時空且路徑一致；單候選同測；system 格式、user 路徑、actual adapter settings/policy 都含自己 proposals |
| §4.1 不能確保 empty 就不喚醒 | S1 `call refuses unsafe or unattributable proposals before invoking`：symlink/FIFO/file/nonempty/corrupt seq/held coord/mkdir permission 分例，invoker count=0、no records、外部 sentinel 不變 |
| §4.4 失敗候選 park；§9 第一項 | S1 `call parks failed candidates and collects only the successful candidate`：rate_limit→success，各寫不同 request；parked/1 存第一份；record 僅第二份，無 feedback |
| §9 僅成功候選有 ok | S1 `call publishes ok only for the successful attempt`：第一 invoke 及其失敗後無 marker；第二成功 marker.successful_attempt=2；全失敗、auth、throw、timeout、取消均無 marker（各自失敗內容 park） |
| §4.4 ok 早於 result；guard 後、release 前 collect | S1 `call commits ok before result and collects after guard under its lease`：seam 上讀檔不存在 result；invoker 改 protected persona，marker 前已還原；collection 時另一同角色 call 被 lease 拒絕 |
| §4.4 accepted ok/result crash window | S1 `call crash after ok preserves collectable requests without result`：setFaultHook 在 call:ok-published 單次 throw；新 deps/helper 補收得到同 payload，仍無 result；不啟 runtime |
| §4.4 call 無 resume，處理中 crash 可補收 | S1 `call collection reentry finishes every unmarked sequence without duplicates`：rotation:renamed/recreated、collection:before-done、record 提交前後 fault，fresh deps 重入補收；已完成 state 不回 pending |
| §4.4 failed call 無 ok 永不收；§9 no-op | S2 `collect call without ok is a read-only no-op`：含 failed parked、尚非空 proposals、未 done collected；零 records、零新目錄/log，exit 0；不要只測 empty failed call |
| §4.4 重入未 done + proposals；§9 idempotent | S2 `collect call finishes unmarked directories and rotates residual proposals idempotently`：不同 seq 加殘留各一筆；分兩次新程序/helper，deep compare files/bytes/modes/mtime，second stdout 同、退出0 |
| §4.4 collection errors 不 fail call | S1 `call keeps success when approval collection is retained`：config invalid/removed allow、premise fail、EACCES/ENOSPC/inventory budget 注入；result 與 CallResult 成功，retained log 與提示，重試可恢復 |
| §4.9、§9 no feedback | S1 `call never sends approval feedback or writes delivery markers`：先放其他既有 approval，再呼叫與 fallback；兩 prompt 無任何舊 approval id/status/output，無 `.feedback` 寫入、無 collector 後 invoke |
| §9 沒 executors bytes 不變 | S1 `unenrolled calls preserve legacy invocation output and artifacts`：no-file、empty-allow、other-tuples；spy 真 callback 的 WakeInput，再比較既有 rt.prompts/policies/claude/codex fixture，result/stderr/tree 保持既有；requests/approvals 不存在 |
| .coord / live 排除 | S2 `collect call refuses a live lease and a held coordination directory`：有 ok 的 live call 不動 request；stale .coord 不被偷；無 ok live call no-op |
| 新 marker / config 故障 | S2 `collect call rejects unsafe markers and changed qualifications`：bad id、ancestor symlink、FIFO、>1MiB、unknown version、mismatched call_id、role 消失、executors 移除、allow 撤銷、dir 移除或改 symlink、hash/key-set 不符；exit1、no new records、具 D6 診斷 |
| lifecycle failure | S1 `call stops fallback when parking or preparation fails`：park error 下一 invoker 不啟；cancel 保持 cancelled；fresh cancelled preflight 不啟 runtime；marker link fail 不收；result write fail marker 留存 |
| exact grant & web 排除 | S1 `call grants only its own proposals subtree`：policy/Claude settings 允許自身 proposals、不允許 ok/collected/parked/store/他人 proposals；default code path 無新增 grant。S2 `web command whitelist excludes every approvals command` 靜態讀 COMMANDS，不啟 server |

**Test seams:** 延用 test/call.test.ts 的 temp home/scratch repo/fake Invoker、approvalPremise 注入；不得讀真實 ~/agent-lyceum-config、啟 claude/codex。fake invoker 控制成功/錯誤/abort 並寫指定 proposals。enrolled fallback 正向案例用兩個 Claude model；不要用既有 premise 會拒絕的 Codex candidate 來證明成功流程。時間 now 固定、token 用遞增計數、actor/probe 注入 CollectDeps；filesystem permission/ENOSPC/budget 以 spy/deps 控制（不要靠 root 下 chmod 的假測試）。setFaultHook 每 case finally reset；沿用 collector crash tests 的一次性 fault 與 freshDeps（`test/approval-collect-crash.test.ts:20-61`）。throw seam 會跑 finally，不能聲稱等同 SIGKILL；真正 stale .coord 用明確 fixture，operator 清掉後再測 recovery。現有 compat tests `test/approval-compat.test.ts:118-200` 已覆蓋 call invocation/prompts/policy；`test/call.test.ts:90-158,179-304` 覆蓋現有 result/fallback/cancel，全部保留。

## Documentation contract / docs-writer 同步更新

docs-writer 另收 lead task，不能讓 node-engineer 順手改雙語文案。S1/S2 的每個新錯誤路徑必附下列對應 doc 句，docs-reviewer 對照 D3–D6 精確訊息。不要讓文件寫成「恢復一定成功」。

- `docs/approval-store-api.md`：替換 stage-3「call never carry proposals」「call slots not collected」「collection for call not implemented」，保留 policy wakes 不配；加入 D2 marker table、1MiB/0400/exclusive publication、fresh baseline 與 premise、D4 順序、D5 locks、D6 retained diagnostics。明說 .coord 只在短 pass；live 排除靠 call lease。
- `docs/commands.md` / `docs/commands.zh-TW.md`：新增同層 `## approvals collect`（兩語 heading/link 對齊 check:docs 慣例）、syntax、無 ok exit0 no-op、有 ok 補 un-done 後 rotate、第二次不寫、無 TTY 要求、exit1 invalid/config/held、live lease 訊息、stale coord 必先停所有 call 才手動移除、輸出/log 位置；call 節增加 enrolled 行為及無 feedback。明說 list/show/approve 仍未實作，不提供現在可執行的 list 命令作唯一恢復方法。
- `docs/write-scope.md` / `docs/write-scope.zh-TW.md`：更新只有 claim wake 有 proposals 與 call 尚未支援的敘述；call grant 只有本人 proposals，並非 requests 根；partial/failed proposals 永不收，park 失敗停止 fallback、preflight 不空不啟 runtime、collect failure 保留 success；同 UID/子行程/讀取隔離限制照舊。
- spec §4.4 call paragraph：保留已接受取捨並補具體說明：「ok.json 已提交但 result.md 未寫的崩潰，可用 approvals collect --call 補收；不會重建答案、不自動重跑，是否重跑由使用者決定。list 畫面待後續階段。」不得改變設計語義或加入 approve/execute。
- 新 failure 對應：D3 preflight/park → write-scope + commands call；D4 marker/result publish → store API + commands call；D5 live/.coord → store API + commands collect；D6 invalid marker/fresh config/hash/premises/collector budget/log-write → store API + commands collect。錯誤文件須含 retained output、不丟資料、修復後重試與診斷檔位置。
- 文案完成跑 `npm run check:docs`；本設計交付只新增這份 plan，不修改上述文件。

## Dimension coverage

| Dimension | Handling |
|---|---|
| Compatibility & Format / 相容與格式 | D1–D2 default branch/新 marker v1；舊 binary 忽略 marker、無新 CLI；舊 team/project/run/state 不動；fixtures 不改 |
| File & Process Safety / 檔案與行程安全 | D1 exact grant、D2 capped safe read/exclusive write、D3 rotation lstat；OS/runtime 現有 enforcement + post-hoc guard。無讀隔離、同UID競態或逃逸子行程消失承諾；payload 不進 shell/terminal |
| Concurrency & Recovery / 並發與復原 | D3 fallback/park、D4 crash 提交點/Ctrl-C/timeout/異常退出、D5 call lease + .coord；call 不用 worktree、不新增 resume。無郵件，partial mail N/A |
| Platform & Operability / 平台與可維運 | 現有 macOS/Linux adapter/premise，Windows 不新增支援；無依賴；不加 wake loop polling，全同步有 collector budget；CLI/log/operator repair 明確 |
| Testability & Maintainability / 可測試與可維護 | 既有小模組組合、pure strict marker parse、fake runtime、時間/token/I/O seams；不需真 home/runtime；兩片各自可 merge/review |
| Observability & Diagnosability / 可觀測與可診斷 | D6 call log.jsonl + stderr；不發 mail/改 state/status JSON；doctor 看設定、call 專屬故障具檔名/id；log 寫失敗明示 |

## Open items

| Item | Owner | Default / release treatment |
|---|---|---|
| 這份設計的獨立審查 | lead → cli-architect-reviewer | 未核准前不實作；lead 派 reviewer，不由作者自己派 |
| user clean-worktree npm ci + 全套驗證、Linux/Codex/真 sandbox、第0步 | lead / 使用者 | 本任務不聲稱驗證完成；保留非可發布標籤；不新增已排除工作 |
| 實作發現 spec/code 真矛盾或須改 stage1/2a 簽名/schema/fixtures | node-engineer → lead → 使用者 | 停止該片，無預設授權、不得自行修 spec |

沒有未決的實作產品選擇。上述是審查／驗證關卡，不是讓實作者猜行為。

## Verification / 設計檢查

- 逐讀 user-task、spec 指定段、stage3 plan、API 與上表 primary sources；每句 call contract 都有 named test。
- 兩片各含 call.test + integration.test，避免新增 fault 破壞未 enrolled 路徑。qa 在 code review 後跑上述 focused commands（只指 S1／S2 Verify 的 `npx vitest run` 檔案清單，不含 `npm run lint` 或 `npm run typecheck`）、精確 crash matrix 與跨程序 recovery，qa-reviewer 檢查證據。
- 整合驗證與使用者 clean worktree 檢查（不是任一 slice wake 的一部分）：`npm ci` 後 `npm run lint && npm run typecheck && npm test && npm run check:docs`。agent sandbox listen/tsx-pipe EPERM 是已知限制；列實際可跑項目，不能用 focused pass 代稱全套 green。
- 本文件沒有執行產品測試，不宣稱 implementation 已通過；本次只做 docs diff/check:docs。

## Risks / Decisions made for the lead

- 以 call guard → ok → result → collect → release 解讀允許的順序；拒絕 result-first。取捨是 crash 有 request 無 answer；spec 已接受，使用者決定重跑。
- marker 新格式採 local v1、1MiB、0400 與 baseline hashes；拒絕空 marker/存完整 config。這是作者選定的新檔契約，不冒稱 spec 既有欄位。
- snapshotInputs 只擴 call identity、保留 shared signatures；拒絕 call 專用重複 hash 演算法。若 reviewer 判定這仍屬禁止的 stage1/2a 變更，交 lead 問使用者，不能暗改。
- grant/prompt 用既有 buildSystemPrompt 加 caller 端 user suffix；拒絕新增 prompt API 參數。避免不必要接口變更。
- live recovery 用既有 per-agent lease；拒絕把同步 .coord 當跨 await 鎖。代價是同角色另一個 call 活著也不能補收舊 call；安全優先，稍後重試。
- 不明 pre-wake 殘留 fail closed，不盲目 park；拒絕為了喚醒而丟棄歸屬未知輸出。沒有 ok 的 crash output 不會補收，與 spec 失敗 call 邊界一致。
- 收走前要求 fresh qualification 精確相等；拒絕撤銷後用舊 config 收走。設定變更會留下需要 operator 修復的殘留，不自動拒絕或刪掉請求。
- successful runtime result 已返回後才 abort，仍視作成功提交；拒絕用晚到 signal 推翻已成功輸出。啟動前已 aborted 或 runtime cancelled 不寫 ok。
- 新 call log.jsonl 只記失敗，成功補收固定文字；拒絕每次 audit append（冪等 state 需求）。JSONL 非權威資料，採現有 logger 慣例；寫失敗要 stderr 可見。
- 信任 repo spec/API/current code 的已標號來源，不把 shared context 的舊 package 版本當現況。未測真 runtime/Linux/Codex；拒絕把 fake tests 當 OS 安全證明。
