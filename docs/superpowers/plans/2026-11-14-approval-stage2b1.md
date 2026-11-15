# Approval stage 2b-1 Implementation Plan

> **For agentic workers:** 依使用者指定的 mail team 流程，由 node-engineer 分三片實作；lead 只安排一次 cli-architect-reviewer 設計審查。不得 commit、push、PR，亦不追加人工設計核准輪。

**Goal:** 讓 runtime 取得 enrollment，集中強化列入 agent 的 invocation；沒有檔案或所有 allow 為空時維持逐位元組相容。本片不是完整 approval gate。

**Architecture:** 重用 stage 1 loader 與 stage 2a `applyEnrollment`；resolution 決定身分，adapter 建構時決定 flags/env，policy 產生逐項 deny。保持 merge 核心、prompt、state 與 mailbox 協定不變。

**Tech Stack:** Node >=20、TypeScript ESM；沿用 commander ^14.0.3、yaml ^2.5.0、zod ^4.6.5、TypeScript ^7.0.2、Vitest ^4.1.11、Biome ^2.5.15；以上是宣告範圍，實裝版本依既有 lockfile，不升級、不加依賴（`package.json:34`, `package.json:53`）。

**Spec:** `docs/superpowers/specs/2026-11-13-approval-gate-design.md` §3 前提 3/4/5/8（:50–55）、§6.2–6.5/6.9（:285–294）、§8 v12.1（:331–340）、§9（:342）。明確任務的階段範圍優先於完整 spec。

## Global constraints / 決策

- 不改 `.strict()` schema、team/project YAML、run state、CLI 或 `status --json`；不建立 requests/approvals、不允許 proposals、不做收走/輪替/park、wake refusal、每 wake 資格重驗或 status reason（spec :37、:99、:295–296；本次原始任務 Out of scope）。舊 binary 忽略 executors 檔（spec :99）；新 metadata 僅記憶體存在，沒有格式遷移。
- 顯式採 `ENROLLED_SETTING_SOURCES = 'user'`，不是 spec 建議在實測後改成空字串（spec :51、:337）。此差異須由 lead 記錄；不能宣稱 user settings 安全性已成立。
- macOS/Linux；Windows 僅沿用 doctor 不支援診斷。真機/Linux sandbox 效果不由單元測試證明（spec :53、:340）。
- 所有檔案測試使用臨時 home/repo；不讀寫真實 `~/agent-lyceum-config`、`~/.claude`、`~/.codex`。不 symlink node_modules。

## Review Focus

- 首讀壞檔 vs 不存在：slice 1 驗證 error/unknown 不被 disabled 吞掉。
- 同名跨專案/call、instance/resume：slice 1 驗證 tuple 與 metadata 傳遞。
- 自己尚無 request 目錄、別人有 symlink/半途消失：slice 2 驗證先定位、完整清單或 error。
- direct builder/override 空 deny：slice 3 驗證強化無法由 policy 取代。
- whitelist 消除 fake 控制環境：slice 3 用專用 wrapper；未列入原行為保持。

## Decision D1 — first-load failure stops the command (user answer b08ae562, 2026-11-15)

`loadExecutors` throws on invalid/unreadable files (`src/approval-executors.ts:48–75`); a fresh process has no trusted membership. **User decision:** when `<home>/executors.yaml` exists but cannot be read or parsed, `run`, `resume`, solo (`run --agent`) and `call` stop with a clear, secret-free configuration error **before any agent is invoked** (no wake, no worktree side effects beyond what already happens before resolution). This explicitly relaxes "never crash non-enrolled agents" for this one configuration error. Missing file and valid empty allow lists stay byte-identical. Other commands (`status`, `status --json`, `doctor`, `clear`, `project …`, `init`) must NOT fail because of it: `resolveProject` itself never throws for this; it records the load error, and only the agent-invoking entry points refuse. Rejected: continue with unknown membership (breaks fail-closed), salvage/last-known cache (no trusted source, new format).

Use one in-memory enrollment context, with identity, an immutable projection of executor command paths and scan limit, or safe file/code/reason error metadata. Never attach full `ExecutorsConfig` with executor env secrets to agents. Error behavior: see Decision D1. Reuse `loadExecutors` and `applyEnrollment`; valid absence/empty allows removes runtime metadata and stays byte-identical. Project resolution uses `{project:name}`; call resolution uses `{project:null}` after the pure merge. No module-global or persisted cache. Reasons never contain YAML values or secrets. Only present whitelist env keys are copied, including empty string values.

## Deliverable mapping / 介面

| 項目 | 落點與明確行為 | 測試落點 |
|---|---|---|
| 1 resolution | `config.ts:149` 的 `resolveProject` 在 `resolveProjectFrom` 後呼叫 helper，identity `{project:name}`；merge 核心 :154 不載入檔案。`call.ts:55` 在 merge 後以 `{project:null}` 呼叫 helper，再取 agent；不要以假 project 名匹配 allow。 | `test/approval-enrollment.test.ts`、新 `test/approval-runtime.test.ts`、`test/call.test.ts` |
| 1 propagation | `WakeInput.agent.enrolled` 與精簡 `.approval` 是唯一 enrollment 表示；在 `adapters/types.ts:6` 註明，**不新增可矛盾的 top-level enrolled boolean**。直接 `buildClaudeSettings(project, {...agent,enrolled:true})` 也看此旗標。這是 spec「WakeInput 欄位」採 nested 表示的解讀，請 lead 記錄。 | adapters、fallback、run/solo/call/tidy 的捕獲 Invoker |
| 2 Claude | `adapters/claude.ts:26,63` 無論 policy override 都加 sandbox.failIfUnavailable=true；保留 enabled=true、allowUnsandboxedCommands=false、disableAllHooks=true。args 僅列入者加 `--strict-mcp-config --mcp-config '{"mcpServers":{}}' --setting-sources user`（inline JSON，無新 MCP 檔）。 | `test/adapters.test.ts`：精確 args/settings 與直接 builder、override negative cases |
| 3 env/Codex | 新小型純函式 `runtimeEnv(agent, source:NodeJS.ProcessEnv):NodeJS.ProcessEnv` 於 `adapters/env.ts`；列入時只複製存在的 PATH/HOME/LANG/TERM/TMPDIR/USER，不補值；未列入時保留 `{...source,AGENT_LYCEUM_AGENT:agent.name}`。兩 adapter 使用；Codex builder 在 mkdir/讀檔前對 enrolled throw `ApprovalError('INVALID_INPUT', 'Approval-enrolled agent cannot use Codex: <name>')`，不得回傳或 spawn。 | adapters：六鍵全有的 exact equality、缺鍵省略、空字串保留、secret/AGENT_LYCEUM_AGENT/FAKE_* 全無；Codex refusal 無副作用 |
| 4 各入口 | resolution 後的 agent 經 spreads 傳遞；`callProject` 保留 agent metadata；run/resume、solo、tidy 與帶任意 policy 的 direct invocation 都走同一 builder。不得把硬化掛在 preflight wrapper。 | runtime/call/memory-tidy/fallback lifecycle 測試；捕獲實際傳給 builder 的 input |
| 5 deny | `policy.ts` 的 `writePolicy` 加 `approvalDenyPaths`（下節）；Claude settings 的 override 也 union 該清單，不能只依 override.deny。 | 新 `test/approval-policy.test.ts`，adapter override 測試 |
| 6 compatibility | 擴充 `test/approval-compat.test.ts` 與其 fixtures，保持非列入既有測試和 fake identity 分支。 | 下列 baseline/head 對照與三片測試 |

**入口完整性：** run/resume 由 CLI resolver 取得 project（`src/cli.ts:67,377`）；bindRunProject 複製 agent（`src/run-store.ts:330–340`），solo 也複製（`src/solo.ts:15–20`）。fallback/tier 已 spread agent（`src/fallback.ts:51–55`），勿重新依候選 runtime 算 enrolled。instances 以 metadata 還原 role（`src/instances.ts:306`），cap 已支援 enrolled（:47）；驗證 synthesizeSlots（:280）及 resume 既有 instance table 不漏旗標，不改 instance state。`call.ts:188–204` 用候選 agent，`memory-tidy.ts:379–389` 直接 invoke 並帶 policy；兩者都必須覆蓋。`invokeWithSandboxChecks` 確實在沒有 sandbox 或有 policy 時直通（`src/sandbox-invocation.ts:167–169`）。verify 現在是 dispatcher 的 `sh -c`，不是 agent wake（`src/verify.ts:43–51`）；不改它，測試只用合成 policy wake 代表 verify/format。

## Deny enumeration / 失敗行為

`approvalDenyPaths(project:ResolvedProject, agent:ResolvedAgent, io:ApprovalIo=defaultApprovalIo):string[]`（新 `src/approval-policy.ts`，`policy.ts` 只整合）對非列入立即回 []，不做 I/O；context 僅含 command paths、scan limit、identity/safe reason，不含 executor env。direct enrolled builder 沒 context 時，以既有安全 loader 取一次；不能以省略 metadata 繞過硬化。**區分非 throwing 的 policy inspection 與嚴格 invocation 檢查**：inventory 回傳 ready/unavailable 的結構化結果，writePolicy 在可用時附完整清單；不可用時保留固定 deny，供 validation/guard 安全檢視與診斷，不 throw。這不是可交給 runtime 的完整政策；enrolled adapter 必須在任何產物/spawn 前另檢查結果，unavailable 就 throw 安全 ApprovalError，永不使用部分 inventory。原因是 validateProject 對全體 agent 呼叫 enforcementFor→writePolicy（`src/validate.ts:104`, `src/policy.ts:250–251`），guard 也呼叫 writePolicy（:315–316）。混合 team run/resume/未列入 solo 不得因 enrolled inventory 失敗而全域中止。run/call 包裝能捕捉同步 builder throw；tidy 必須按 slice 3 修正。這不是持久 slot refused 機制。

1. **先定位自己：** bound run 用 `{kind:'run',project:project.name,run_id:project.run.id,slot:agent.name}`；call 用 `{kind:'call',call_id:path.basename(project.paths.root)}`。用 `requestPaths` 驗證（`src/approval-paths.ts:52–64`）。未綁定 run 的 tidy/直接 settings 沒有 request slot，故無 own exclusion；它不配置 proposals。不得用 role 排除別的 instance，亦不得從 workDir 猜 run id。
2. 固定 deny：`storePaths(home).approvals`、`.executors`、**所有** config executor 的 command[0]（不只准此 agent 的 executor）。附 main repo `project.dir/.claude/{settings.json,settings.local.json}` 與該 agent worktree `repoDirFor(...)/.claude/...`，穩定去重；override scratch cwd 不可取代這兩個來源（spec :51；現有 repo/worktree 選擇 `src/policy.ts:115–117`）。安全 deny 不得被既有 addDeny 的 allowFile/grantOwnDir 過濾。
3. 使用窄的可注入 opendirSync/readSync/closeSync 介面，逐 entry 計數，所有成功/錯誤/超限出口都 close；不擴大既有 ApprovalIo 的必填 public surface。每層只緩存至剩餘訪問預算，未超限後才排序；巨大單目錄不允許整目錄 readdir 分配。計數對每個讀入 entry 一次、超限一律同類錯誤，錯誤不得因未排序順序而產生成功的部分清單。lstat 每層，固定深度列 `requests/projects/<project>/<run>/<slot>` 及 `requests/calls/<call-id>`，不進 proposals/collected/parked、不讀 mail 或 state；`approvalName`/`approvalSourceId` 驗證名稱。排序後逐個 slot root 加 deny，僅排除與自己的 validated SlotRef 完全相同 root。**不 deny requests/、projects/、calls/ 或自己 root，不加 proposals allow**。其他 project、run、call 和相同 role 的不同 slot 都要列出。requests 不存在為空 inventory。
4. 不照抄 `runDenyPaths` 吞 I/O 錯誤的 entries helper（`src/policy.ts:87–109`）。symlink/non-directory/非法名字、EACCES/EIO、讀到一半 entry 消失、超過 config.limits.max_scan_entries 的總訪問量，都回 unavailable 安全 path/code 錯誤，由 invocation 邊界 throw，不能把部分清單交給 runtime、跟 symlink 或擴大成 requests-wide deny；排序不代表競態被消除。測試用 injectable ApprovalIo 模擬，不靠 chmod 在 root 下碰運氣。只接受整個 requests root 尚未存在的 ENOENT 為空。

這片不修改任何 request/store 檔案，不新增 lock；半寫 executors 必須得到 error 而非 disabled。列舉為 O(訪問的目錄 entry)，有全局上限，不逐 payload 掃描、不加輪詢；同時新增 slot 在列舉後出現仍有 TOCTOU，前提 containment 與未來重驗才是必要防線，不聲稱一次 enumerate 可封鎖未來路徑。Ctrl-C/timeout/odd runtime exit、partial mail、stale locks、crash/resume 仍走原 lifecycle，本片不重寫恢復。

## 三個順序 slices（node-engineer；每片先測試再實作）

### Slice 1 — enrollment + default-off baseline（交付 1、6）

- [ ] 擴充 compatibility test，先在 `/private/tmp` 的 `git archive f4936b0` 實體複本生成並提交回本次工作樹的 fixture；copy test driver 只 import baseline 已有 API，不能讓 baseline 讀新模組。固定 env 全集合（含假的 secret/USER）、os.homedir、PATH、run/call/workDir/session id、sandbox probe、time；只替換 disposable root/real root，不正規化排序、args、settings 或文字。參照既有 fixture 流程（`test/approval-compat.test.ts:11–14,37–48,55–61`）。
- [ ] fixtures 覆蓋兩 adapter args/env/stdin/cwd、Claude settings 原始 bytes、一般/override/session/worktree；writePolicy/enforcementFor/protectedPathsFor 與所有 system/user/solo/call/tidy prompt builders（`src/prompt.ts:147,201,209,384,482`）。無 executors 與合法空 allows 兩種情境跑同一 fixture；另測同名但未列入的 project/call。先在 baseline **不開 update** 比對，再在 head 比對，保留兩次原始輸出。既有政策 fixture 已覆蓋 doctor（`test/approval-compat.test.ts:86–100`），不要重產舊檔掩蓋差異。
- [ ] 依 Decision D1 實作 helper、精簡 ResolvedAgent.approval、兩 resolution wrapper；不改純 merge、schema、state/prompt 或 dispatcher 行為。測 project/call tuple、empty/absent、malformed/duplicate YAML/alias/oversize/FIFO/symlink/EACCES、D1 選定的 first-load 錯誤行為、未知不猜名單、跨 project 不繼承；fallback/tier/solo/bind/resume instance metadata 及 cap=1。
- [ ] 只修改 stage2a 的 doctor-only boundary assertions（`test/doctor-approval.test.ts:155–173`）為新 runtime loader 與 error metadata 契約；更新該模組舊註解（`src/doctor-approval.ts:19–22`）。非列入 adapter/fake-runtime 測試不改。
- [ ] 每片 gate：先 `npm run typecheck`，再 `npm run lint && npm run typecheck && npm test`；若前者缺依賴/EPERM，仍分別嘗試 lint/typecheck/test 並保存 exit/output，不能把短路當 suite attempt。只有已知 sandbox 阻礙可明列 unverified 後由 lead 決定續片；任何新邏輯失敗先修。

Allowed: `src/{config,approval-enrollment,call,doctor-approval}.ts`、`src/adapters/types.ts` 與上述 test/fixtures。不得動 schema/run-store/dispatcher/prompt 產品碼、mail 或 stage 1 store。

### Slice 2 — 逐項 deny（交付 5）

- [ ] 寫 approval-policy failing tests，再實作上述 helper 與 writePolicy integration。測跨 projects/runs/calls、當前 slot 尚未建立也先排除、literal suffix vs instance、未 bound tidy、repo/worktree settings、executor union、無 requests-wide deny/無 proposal allow；unrelated/empty/absent 的 I/O spy=0。
- [ ] 注入中途 EIO、child ENOENT、symlink 每層、非法名字、non-dir、scan cap，斷言不回傳部分清單/不跟連結；加入 mixed-team validation/run/resume 與 non-enrolled solo 的 inventory-failure locality 測試；direct enrolled settings 無 context 的 integration 測試移至 slice 3。重跑 slice 1 fixture 與每片 gate。

Allowed: 新 `src/approval-policy.ts`、`src/policy.ts`、`test/approval-policy.test.ts` 與相關 test；必要時允許 validate/doctor 診斷 plumbing，無 schema/state 變更。不得改 allowDirs、guard、containment checker、輪替、mail 或 state；不要提前新增 refusal scheduler。

### Slice 3 — central adapter hardening + fake-runtime（交付 2、3、4、6）

- [ ] adapters tests 先 fail：enrolled 新舊 session、fallback/tier、policy override 即使 deny=[] 仍補安全 deny、直接 settings builder enrolled true 都有固定 flags/failIfUnavailable/hooks；無 enrolled 的同組測試 fixture 完全不變；Codex 同樣含 override/direct entry 必須在任何 I/O 前拒絕。
- [ ] 實作 `adapters/{env,claude,codex}.ts` 的純 env helper、常數、inline empty MCP 與 settings/override deny union。直接 settings builder 用 agent.enrolled；不能只在 buildInvocation 外層處理。測六鍵 exact equality、清掉 inherited secrets/identity、白名單缺項不補。
- [ ] fake runtime 僅新增 enrolled-test opt-in 的鄰接 fixture descriptor（例如測試 wrapper 以絕對路徑載入 descriptor，再啟動 fake；identity/script 路徑在 wrapper 檔內，**不加 env key、不改產品 args**）。`fake-claude.mjs:27` 原環境 identity 分支與 `test/adapters.test.ts:406` 的非列入 spawn 完全保留；enrolled wrapper 專用 fixture 執行後回報實收 env 和身分。以捕獲 Invoker 驗證 run/resume/solo/call/tidy 送達相同 metadata，再至少一個實際 fake child 驗證 adapter 產物；不依賴 claude/codex 真 CLI。保持既有 timeout/crash/cancel 測試不改。
- [ ] 修正 `memory-tidy.ts:358–389`：snapshot 建立後的政策建構與同步/非同步 invoke 例外一律以 try/catch 交既有 fail，restore、清 snapshot、回 failed 並繼續後續獨立 jobs；不能只用 invoke(...).catch。測同步 throw、snapshot 後 inventory failure、no spawn、cleanup、下一個 unrelated job 繼續。加入 sentinel executor secret 不進 args/settings/env/prompts/errors 的 regression。
- [ ] 重跑 baseline/head compatibility（head 不開 UPDATE）、每片 gate，最後 `npm run check:docs`。qa 獨立覆蓋六項正/負例與 default-off 全套；docs-writer 僅在後續授權更新雙語 write-scope/configuration，明言 2b-1 只建構硬化、未做每 wake 資格 gate/收走；不能宣稱完整核可能力已上線。

Allowed: adapters、上述 test/fixtures；call/run-session 只在捕獲測試證明 metadata 遺失時做最小 propagation 修正；memory-tidy 明確允許上述同步例外與 cleanup/locality 修正。不得改 prompt、verify 執行、process-runner 的 signals/timeout 或狀態格式。Test time 用 Vitest fake timers、固定 run id 與 fixture descriptor；純 env 參數化，fs 用 ApprovalIo，無亂數依賴/真實 home；無新 abstraction framework。

## Dimension coverage

1. **Compatibility & Format：** baseline/head bytes + empty allows；只記憶體欄位，無持久格式、CLI 或 status JSON 變更；舊 binary 忽略新設定，沒有新增強制力，勿以舊版執行列入 agent。
2. **File & Process Safety：** centralized flags/env/deny、override union、symlink fail-safe；OS enforcement 依 runtime backend，Edit deny 非 Bash 保證、post-hoc guard 非本次防線。保留已知無讀取隔離；不執行 executor 或 shell 拼接輸入。
3. **Concurrency & Recovery：** 無新 write/lock；半讀/半寫得到 metadata/error，列舉錯誤不靜默降級；保持既有中斷/timeout/partial mail/resume，並明列跨行程名單遺失與 inventory TOCTOU。
4. **Platform & Operability：** macOS USER、Linux 未驗證、Windows 診斷；Codex 防禦拒絕；bounded metadata scan，無 payload 掃描/輪詢/依賴。
5. **Testability & Maintainability：** 沿用小函式、ApprovalIo、fake Invoker/child、temporary home；三片各 typecheck/lint/suite attempt；不重新實作 stage 1/2a。
6. **Observability & Diagnosability：** runtime error metadata 含 file/code/safe reason，供 2b-2；doctor 沿用現有錯誤輸出（`src/doctor-approval.ts:35–40`）；建構錯誤走既有 wake/call failure/log。無新 state/mail/violations 格式，不提早加 status reason。

## Risks / lead 必須記錄的選擇

- D1 已由使用者決定：首讀失敗時 run/resume/solo/call 在喚醒任何 agent 前停止；其他指令不受影響。無可信 previous caller，移除 last-known 設計。
- 使用者指定 user source 優先於 spec 空來源建議；拒絕自行切換。user sandbox/permissions 合併檢查與每 wake 重驗不在本片；真機效果未驗證，不能用 mock 稱已證實（spec :51、:340）。
- 單一 `WakeInput.agent.enrolled` 解讀替代獨立頂層欄位，拒絕兩個可不一致的 boolean；lead 記錄此介面解讀。`approval` context 是無 executor env 的最小投影，僅記憶體，故重啟未知不能靠舊 state 推論。
- 額外 safety 選擇：inventory 異常時 inspection 回 unavailable、嚴格 invocation 建構失敗而非使用部分 deny/擴大 deny；全局 scan cap 沿用 limits.max_scan_entries 而非新 config，舊 requests 太大可能影響列入 invocation。失敗不是持久 slot refused；lead 記錄與「不新增 wake refusal」的區別。
- direct builder 無 snapshot 用 safe loader；拒絕信任 caller 省略 metadata，正常 resolved wake 不重載 config。其他 slot 後建的路徑仍需 containment；不追加鎖/每 wake inventory 同步機制。
- 未增 prompt 規則、proposals allow、CLI/收走，是明確 stage 邊界，完整 spec §6.2/6.5 的列入能力留後續；非列入 prompt fixtures 本片仍完成。
- 工作樹實際 HEAD 為 `cfb1b6366cf23daf57ff036a3c5dd8ca9d3403f7`（author `git rev-parse HEAD`），lead 為 7461ad8；lead/reviewer 均執行 `git diff --stat 7461ad8 cfb1b63` 無輸出，tracked tree 相同；f4936b0 物件可讀（`git cat-file -t f4936b0` => commit）。

## Sole design review disposition (e1e7de16)

Request changes: unresolved-enrollment-authority awaits user; failure-locality-before-invocation corrected through structured inspection plus strict adapter boundary; synchronous-builder-catch-gap corrected in tidy. Minor resource bound uses capped opendir and guaranteed closure; secret-bearing context projected; direct-settings integration moved to slice 3. No second design review. Acceptance still requires implementation tests and independent diff/security/risk/QA evidence.
