# Approval stage 3 Implementation Plan

> **For agentic workers:** 依 mail team 流程由 node-engineer 逐片實作，cli-reviewer 對照本契約；lead 安排最多一次獨立設計審查與跨 runtime 安全審查。不得 commit、push、PR、merge；本文件不代表實作已通過驗證。

**Goal:** 完成 v12/v12.1 §10 第 3 項：claim wake 的 proposals 輪替、收走、park 與 recovery；全程 DEFAULT-OFF。

**Architecture:** 重用 approval store 的來源鍵、link 提交、狀態、高水位與 gate；新增小型同步 rotation/collection 模組，純解析與 I/O 分離。失敗只暫停該 slot，不能丟棄請求來換取 wake，也不能阻擋郵件 commit。

**Tech Stack:** package 0.42.2；Node >=20、TypeScript ESM/NodeNext/ES2022，Node fs/crypto。宣告版本 commander ^14.0.3、yaml ^2.5.0、zod ^4.6.5、Vitest ^4.1.11、TS ^7.0.2、Biome ^2.5.15（`package.json:3,34,53`、`tsconfig.json:3`）；實裝依現有 lockfile，不升級、不新增依賴。

**Spec:** [approval gate v12/v12.1](../specs/2026-11-13-approval-gate-design.md) §4.1/4.3/4.4/4.5/4.8/5/10；沿用 [stage 1](2026-11-14-approval-store-stage1.md)、[2b-1](2026-11-14-approval-stage2b1.md)、[2b-2 含 Amendments A/B](2026-11-16-approval-stage2b2.md)。本次明確 stage 範圍優先於 spec 全功能清單。

## Global constraints / 發布邊界

- 不改 `.strict()` schema、project/team YAML、run `state.json`、mail/journal 協定、CLI、call、verify、tidy、format、executor runner、feedback、gc CLI；不做 stage 4+。舊格式繼續載入，不遷移；既有 v1 approval 格式不變，未知版本沿用拒絕。舊 binary 忽略新增 requests/approvals；舊 gate reader 仍能讀既有 reason codes。
- **非可發布：第 0 步未驗證。** F3 user settings、Linux 與真機「不能寫 approvals／別人的 proposals」皆未驗證；fake runtime 不證明 OS/tool enforcement。只承諾 process crash，不承諾斷電、同 UID 祖先置換、逃逸背景程序已停止或讀取隔離。
- 所有測試 temp `AGENT_LYCEUM_HOME`、scratch repo、fake invoker；不讀真實 home、claude/codex、不執行真 sandbox 實驗。不得重生成 f4936b0 fixtures。
- 每片先新增失敗測試、最小實作、跑 typecheck 與該片測試，通過才下一片；新失敗先診斷。最後 qa 記錄完整四項 gate 的真實輸出；不能把 tsx pipe `listen EPERM` 說成測試通過。

## 需 lead 記錄的決策 / deviations

以下是明確裁決提案，lead 記錄後交實作；不默認為使用者已同意。所有替代均明列，沒有待 implementer 猜的選項。

1. **D1 — reader 位置與 compile-only 測試。** 真 API 在 `src/fs-util.ts:97–116`，不是 approval-io；只在成功分支加 `ino:number, dev:number, mtimeMs:number`，原 buf/size/truncated 與拒絕語意不變。`test/approval-rotation.test.ts:10` 目前要求零 runtime exports/emitted `export {}`，必須只更新這項階段性斷言、保留型別與非法 destination 檢查。拒絕複製另一個 reader 或保留已過期零 exports 斷言；保留 no-follow/nonblock 防線，也不改 fixtures。
2. **D2 — coordination 必須新增，不能假裝已有鎖。** `src/approval-high-water.ts:11–23` 明說沒有鎖且 run lease 不足。採 canonical slot root 下 `.coord/` 的獨佔 `mkdirSync(0700)`，整個同步操作持有；EEXIST/非真目錄立即暫停該 slot，不等待、不依 mtime/PID 偷鎖。正常 finally 只 rmdir 自己建立的空鎖；真 process crash 遺留鎖需操作者停掉所有相關 dispatcher/gc 後手動移除。拒絕 in-process mutex 與自動 stale takeover（跨行程不互斥／可能雙持鎖）。這是刻意 fail-closed 的可用性取捨；不聲稱無人介入 crash recovery。
3. **D3 — scan 三要求互斥。** spec §4.4 要全體 `(mtime,name)` 排序與精確 ignored_count，§10 卻要求 cap 即停；沒有讀剩餘項就無法知道其 mtime／總數。採 cap 限制「處理／讀 payload」：`opendirSync` 串流所有直接子項，計數；以最多 cap 大小的選擇集合保留全體最早 `(mtimeMs, UTF-8 name bytes)`，最後排序，其他不讀內容，ignored_count=直接子項總數−選入數。dot/非法名仍佔直接子項 cap，選入後忽略；不遞迴。拒絕 filesystem enumeration 前 cap（重入可能換集合／不滿足全體排序）、假造 ignored_count。偏離 §10「cap 即停」，時間 O(N log cap)、記憶體 O(cap)，20000 項測試明驗；mtime 可操控仍是 DoS，不能宣稱 O(cap) wake latency。
4. **D4 — slot recovery error 不可先推進 claim。** 現在 `recoverRunMail` 先 finish started，再無條件 save claimed→abandoned（`src/message-store.ts:456–480`）；新 hook 失敗時跳過該 slot 後續 recovery/collection/wake、保留該 claim/attempt 原狀。拒絕 catch 後仍 save abandoned（失去 park 重試視窗）。不改 outboxOf/parkOutbox 本身或歷史 abandoned，hook 不存在走原流程。
5. **D5 — race 與 I/O 不是 agent denied。** spec §4.4 的 inode 不符「丟棄該筆」採本 pass 不提交、不寫該目錄 done、slot skipped；下一 settle 重讀。ENOENT/read EACCES 等也同樣保留重試，不偽裝 not_regular；已證明 symlink/FIFO/dir 才 denied。拒絕丟失該筆後仍 done。所有候選完成／明確 ignore／durable denied 後才 done；持續 mutation 能 DoS，但不能安全地當成功。
6. **D6 — status 不擴 schema。** GateFile 目前嚴格 v1 只有 slots/class/code/at（`src/approval-wake-gate.ts:251–271`）；不加計數欄位或 reason enum。人類 formatter 在既有 gate side file 存在時，以 store reader 即時計算本 run 的已提交 record 數（含 denied，排除 incomplete／只計數的 denied），標示「已收錄請求記錄 N（含拒收）」；損毀顯示固定「計數無法判定」。不是 pending approval count。拒絕 state.notes 或 report 欄位（會污染 JSON）；舊 binary 仍讀得 gate side file。
7. **D7 — qualification/full_writable 的差異需補齊。** `baselineFor` 現把 staticSet 當 full_writable（`src/approval-wake-gate.ts:106–113`），`slotSnapshotInputs:86–89` 沒有 static duplicates 或 workspace gitDir 排除。收走時 origin.full_writable 改用實際完整 allowDirs/allowFiles，hash 用排除 run-only 的 static set；以來源分類保留明確 sandbox.write 等靜態重複授權，不以 ancestor subtraction 猜測。拒絕照抄錯置欄位／把 proposals/gitDir 寫進 hash（clear 後無法核可）；不改 persisted schema。既有 gate baseline 同用修正後 builder（baseline 不持久化）。

8. **D8 — hard-link doctor 診斷與唯讀現況衝突。** `src/doctor-approval.ts:23,44–47` 現稱唯讀且只有 containment/premises，未見 hard-link capability probe。採 enrolled-only 安全 scratch probe：doctor 在已存在的 approvals/requests 真目錄（缺少則用最近真祖先）驗證 link；collection 在實際 approvals 與 slot root 亦驗，不以 doctor 的結果當永久授權。scratch 以 O_EXCL 建立、link 第二個唯一名、只 unlink 自己成功建立的名稱；不改既有檔，任何 probe/cleanup error 都回固定 failed。拒絕僅相信 filesystem 名稱或發生 UNSUPPORTED_LINK 後仍 wake；這是 doctor enrolled 路徑新增暫存寫入的明列偏離，不改 default-off。

### O5 / O6 / F3（可直接貼 decision record）

- **O5：** stage 3 在 record 存既有 qualification.sha256/premises、origin 的 canonical project_dir、role、run_id、完整 writable 與 proposer.slot；不增加格式或讀原 run 的依賴。共用 snapshot builder 輸入完整 effective grants、run-only（task、outbox、shared/index、ws.gitDir、proposals）、明確 static duplicates；hash 沿用 qualificationHash。日後 approve resolver 以 fresh UNBOUND 配置、proposer.slot 合成該 role/instance，分別重建 normal 與 solo 的純 binding（固定虛擬 run path，不建目錄、不讀原 run）；排除上述 run-only 後只接受與存入 hash 完全一致的候選，無匹配即拒絕。兩種模式須枚舉，因 solo 會改 lead/canEditAgentMd（`src/solo.ts:18–23`）；instance 用既有 synthesizeSlots（`src/instances.ts:280–299`），不能直接以 role 代 slot。S3 必測 bound→刪 run→unbound normal/solo/instance static 相等、重複靜態 grant 不漏、設定改變不符；approve 本身不實作。拒絕信任 origin.full_writable 作 authority 或 hash role 的寬鬆近似；不可重建時 fail-closed。
- **O6：** wake/collection 沿用 Amendment A/B grants-mode：actual+fresh grants、blocked 優先、foreign-incomplete skipped；不擴成 diagnostic descendant walk。未來 approve/execute 需重新跑 grants authority（含所有 project/call、來源 fresh grants、完整 protected/executor/interpreter/hops）且任何 unknown 不可執行；doctor diagnostic alias scan 額外展示，不能代替 authority，也不因 mutable descendant alias 自動新增 authority。executor 身分/hash、payload/資格於執行前再驗；本階段只記錄契約，不實作 approve/execute。拒絕把 doctor 所有 error 等同 authority 或沿用舊 wake verdict 授權執行（DoS／過期證據）。
- **F3：** 保留 `ENROLLED_SETTING_SOURCES="user"`（`src/adapters/claude.ts:13,104`）且不加「最小 whitelist 已安全」聲稱。JSON key whitelist 可單測，但 plugin/hook/settings merge、空來源 OAuth、network/WebFetch 與 excludedCommands 的 runtime 效果無法便宜且完整測試（spec §10 (f)）；故本階段不加部分檢查，不改 user 檔／adapter 安全旗標。docs/最終報告固定標示「非可發布：第 0 步未驗證」，F3 由 lead/security+使用者真機驗證負責，預設阻擋發布；拒絕用 strings/key 存在或 fake runtime 測試解除 blocker。

## Interfaces / module boundaries

- 新 `approval-link-check.ts`：`checkApprovalLinks(home:string,dir:string,deps?:StoreDeps):void`；lstat 每層，只在 home 內真目錄 probe，uuid 可注入；不建立缺少的目錄，probe 名以 `.approval-link-` 開頭，成功完全清理。失敗 throw ApprovalError，公開診斷只固定類別；Windows 不 probe、保留 unsupported。
- `approval-rotation.ts` 實作既有 `Rotate`/`Park`/`ProposalsOf`（不改三個型別簽名）；`rotate(home,slot,dest):RotationResult` 不分配 seq、不寫 done、不解析；呼叫者持鎖。`park(home,slot,attemptId):ParkResult` 自己取得 coordination 後用 rotate。新增 `withSlotCoord<T>(home:string,slot:SlotRef,fn:()=>T):T`、`createRotation(deps:RotationDeps):{rotate:Rotate;park:Park}` 供 I/O/fault 注入，production exports 綁預設 deps。
- `RotationDeps={io?:ApprovalIo & Pick<typeof fs,'opendirSync'|'rmdirSync'>;fault?:(point:string)=>void}`；不用全域 fault 設定。collection 持鎖 callback 內用 rotate，不再進 park 或重入同一鎖。slot root/所有祖先安全 mkdir 0700；驗證 canonical home，再驗證所有下層 lstat，不接受 arbitrary dest path。
- 新 `approval-snapshot.ts`：`snapshotGrants(bound:ResolvedProject,slot:string,proposalsDir?:string):GrantInput`（effective/run_only/static_duplicates 三集合）；`slotSnapshotInputs` 原簽名不變並改用它。policy 內共用 grant 組裝來標示來源，不另複製一套 permissions；靜態來源為 global/project memory、records/common/persona/instructions、明確 sandbox.write，run-only 為上列 task/outbox/shared/index/gitDir/proposals。
- 新 `approval-request.ts`：`parseRequest(bytes:Buffer,config:ExecutorsConfig):ParsedRequest`，union 為 `{kind:'valid';executor:string;summary:string|null;payload:Buffer}` 或 `{kind:'denied';reason:DeniedReason}`。純 UTF-8/header/whitelist/size，不做 allow/quota/I/O。
- 新 `approval-collect.ts`：`collectSlot(input:CollectInput,deps:CollectDeps):CollectResult`；input 明列 `home,slot:SlotRef,runDir,config:ExecutorsConfig,origin:Origin,snapshots:ReadonlyMap<string,SnapshotInput>,premises:readonly PremiseResult[]`；deps 為 `io`（rotation I/O）、`now:()=>Date,token:()=>string,actor:()=>Actor,probe:CreatorProbe,fault:(point:string)=>void`，production defaults；result `{created:number;existing:number;denied:number;verdict:GateVerdict}`。它取得 slot coordination、先重驗資格／前提與實際 approvals/slot link probe，再處理 un-done，最後按 latestSlotAttempt 的 claim 歸屬旋轉／park；其他 slot 的迴圈屬 RunSession。
- `prepareSlot(input:CollectInput,deps:CollectDeps):CollectResult & {proposals?:string}` 同模組，共用收走核心，最後確保 proposals 存在、空、canonical；無法判定不回傳 proposals。settle 與 pre-wake 都使用同一分類，不另寫「成功」判斷。
- `GateDeps.slotDir(slot):GateVerdict` 簽名不變；RunSession closure 呼叫 prepareSlot，成功 path 暫存 session map。新 `WakeInput.proposalsDir?:string`（內部，非 config schema）；policy wakes 或非 enrolled 必忽略。`writePolicy(project,agent,proposalsDir?:string)` 僅 enrolled bound run 加入 canonical slot proposals；第三參數不預設推導。`buildClaudeSettings` 新增尾端 optional proposalsDir，invocation 將 input 欄位傳入；policy override 永不加此 grant。**不可拿 WakeInput.policy 承載它**：那會改 cwd 成 scratch（`src/adapters/types.ts:23–29`、`src/adapters/claude.ts:83–89`）。Codex 仍沿用 enrolled refusal，call 不傳欄位。
- `recoverRunMail` opts 新增 `proposalsOf?:ProposalsOf,parkProposals?:(agent:string,attemptId:string,canonicalProposals:string)=>void,onProposalsError?:(agent:string)=>void`；RunSession closure 用 trusted SlotRef 與 home 呼叫 park，核對 callback path 與 requestPaths 相同。無 hook 不作新 I/O；message-store 不自行從 agent 檔推導 home。error callback 標記本 pass blocked，固定碼 log/side-file。

## S1 — rotation / coordination / high-water / reader（node-engineer，serial）

**可改：** `src/approval-rotation.ts`、`src/fs-util.ts`、新 `src/approval-link-check.ts`；`src/approval-high-water.ts` 只補 coordination 文件／測試 seam；`test/approval-rotation.test.ts`、`test/approval-high-water.test.ts`、新 `test/approval-rotation-crash.test.ts`、新 `test/approval-capped-read.test.ts`。其他 src、schema、fixtures、manifest 不可動。

- [ ] 測試先失敗：`empty reentry never touches existing parked destination`、`missing proposals rebuilt 0700`、`symlink/file/FIFO ancestor suspends only own slot`、`corrupt high-water blocks even empty wake`、`link probe cleanup and unsupported fail closed`、`numeric seq 10 beats 2 and done-only names`、`coord overlap and stale coord refuse without steal`、`capped reader returns fstat dev/ino without changing bytes`。
- [ ] 實作接口如上；rotate 先 lstat slot/proposals，缺 proposals 重建；非空才 rename，destination 必不存在（任何既存檔案／目錄拒絕），recreate 0700 再 lstat。park 的 attempt id 用 approvalSourceId，不容任意路徑。若 rename 夾縫被換 symlink，之後檢查 destination 真目錄，異常停止且不 follow／不刪來源。
- [ ] 收走呼叫端在鎖內先 readHighWater（損毀即拒）、先完成舊 un-done、非空才 nextCollectedSequence→rotate→advanceHighWater。即使 crash 後 proposals 空，先把 high-water 對齊現存最大值再標 done；復用 stage 1 temp+fsync+rename，不增加另一套 seq 格式。
- [ ] future requests gc **必須同用 `.coord/`**，包括 orphan/call root；從選取 target 至 high-water 對齊、rename→delete dir→remove done 全程持鎖。gc 尚未實作，不能先接沒有此鎖的 gc；不要把這個鎖用於 immutable record/state CAS。
- [ ] 驗證：`npm run typecheck && npx vitest run test/approval-rotation.test.ts test/approval-rotation-crash.test.ts test/approval-capped-read.test.ts test/approval-high-water.test.ts`。AC：空目錄無新 seq、重入不遺失／不重用 seq；不同 process 同 slot 只有一個進 critical section。

## S2 — collection core（node-engineer，S1 後 serial）

**可改：** 新 `src/approval-request.ts`、`src/approval-collect.ts`；新 `test/approval-request.test.ts`、`test/approval-collect.test.ts`、`test/approval-collect-crash.test.ts`、`test/approval-collect-race.test.ts`。既有 store/state/id/schema、gate/session/prompt/adapters/status/fixtures 不可動；以既有 public APIs 重用，不重做 store。

- [ ] `header and whitelist table`：檔名用 isRequestFilename（含 no leading dot）；整檔 fatal UTF-8、Cc 僅 LF/TAB、Cf、非 U+0020/U+3000 的 Zs、Zl/Zp、variation selector、Default_Ignorable_Code_Point 與 spec 額外六個外觀空白全部拒收。ESC、CR、DEL、bidi、ZWJ、NBSP、U+3164、VS16 拒；U+3000 允許，絕不 sanitize。
- [ ] header 以第一個 `\n\n` 切，最多兩個非空 `key: value` 行，key 僅 executor/summary 各最多一次；summary optional ≤300 Unicode code points；executor 必填非空、名稱必註冊；只移除固定 `: ` 語法空格，不 trim payload。header 2048 bytes 含分隔空行；先全域讀 cap=67584（size/truncated 雙檢）、全檔 whitelist、header 形狀、executor lookup、executor payload cap；同時缺 executor 且壞 header 時 bad_header 優先，合法 header 缺 executor 才 bad_executor。summary/executor 反序允許、payload 可空；無 YAML。
- [ ] `outcome table all rows`：不合法名 ignore；not_regular／too_large／bad_content／bad_executor／bad_header／not_allowed／quota／scan_limit 各斷言既有 SourceKey variant、record disposition/reason；目錄異常和前提 false 不 rotate、不 done、不 denied。有效→pending＋資格快照；無 state 檔。不允許 raw error/path 流進 log/status。
- [ ] `scan 20000 entries is bounded memory and exact aggregate`：D3 演算法，先 lstat collected 真目錄與祖先；mtime 不存在／讀取競態 D5；每筆 capped no-follow read 後再 lstat 比 dev/ino/regular，hash、複本、whitelist 全用同份 Buffer（payload 子 Buffer 不改 bytes）。單檔敗可繼續其他候選，但該目錄有未解錯誤不得 done。
- [ ] `replay adopts executed record`、`payload mismatch leaves incomplete`、`two publishers one link wins`：依 stage 1 approvalId/publishRecord；讀既有 record 在 quota 之前採用，不能把舊 pending 改 denied、不能回到 pending／覆寫狀態。record 是提交點；EEXIST payload byte compare、unsupported link 不 fallback rename。兩個 barrier child 直接測 publishRecord 的既有 CAS（slot collector 則由 S1 coordination 排他）。
- [ ] `quota includes executing unknown but not computed expired`：listCommittedIds/readCurrent/computeDisplay/creatorLiveness；同 project-or-call＋base role＋executor max_pending、全域 max_total_pending；store corrupt/inventory unknown 不當 0，暫停本 slot。收走對該 role pending/executing 以既有 transition lazy/collect 寫 expired/unknown（注入 actor/time/probe）；CAS conflict 重讀，不覆蓋 executing。配額是跨 run 軟限制，不另加全域鎖。
- [ ] `denied cap 100 and approximate counter`：每 project-or-call＋base role 前 100 denied 完整 record，超過只更新 `.denied-count/`；用既有 LP/sha256 對 identity 命名，檔案為十進位非負 safe integer＋LF、temp+rename；損毀不當 0，固定類別記錄並不 done。計數可重複／競爭近似，不影響安全，不測精確值。scan_limit 每個 seq 一個 deterministic denied_scan（若已超 denied 保留額度則只計數）；ignored_count 存精確值。
- [ ] 驗證：`npm run typecheck && npx vitest run test/approval-request.test.ts test/approval-collect.test.ts test/approval-collect-crash.test.ts test/approval-collect-race.test.ts test/approval-store.test.ts test/approval-state.test.ts test/approval-publish-race.test.ts`。AC：所有表列 outcomes、負向與 crash replay 均通過，沒有新 request/state 格式。

## S3 — lifecycle wiring / grants / snapshot（node-engineer，S2 後 serial）

**可改：** `src/run-session.ts`、`src/message-store.ts`、`src/approval-wake-gate.ts`、`src/policy.ts`、`src/adapters/types.ts`、`src/adapters/claude.ts`、`src/prompt.ts`；必要 snapshot 小 helper 放新 `src/approval-snapshot.ts`（從 gate 抽出，不改 hash 演算法）。新 `test/approval-stage3-flows.test.ts`、`test/approval-stage3-recovery.test.ts`、`test/approval-stage3-snapshot.test.ts`、`test/approval-stage3-compat.test.ts`；可擴充相關 approval gate/adapters/policy 測試但保留既有相容斷言。禁止 config/schema/run-store/call/verify/guard/locks/fixtures/dependencies。

- [ ] `settle empty batch collects ready and committed`：精確插在 `routeOutboxes`（`run-session.ts:1222`）後、doneContract/verify/commitClaim（:1278）前；遍歷所有 enrolled claim slots，不依 batch/results。每 slot 先新鮮資格/前提（同 gate actual+fresh grants contract），再所有數字升序 un-done collected、再 latest claim 成功的 proposals；每個成功目錄才 publishExclusive `<seq>.done`（固定 `done\n`）。錯誤固定碼 log＋gate entry，catch 後照常 commitClaim；mail redo/拒收不回滾 request。resume `settle([],[])`（:1568）同樣補收，前提不成立不能先旋轉。
- [ ] `preclaim residual classification`：維持 evaluateSlot :738–750 的 quarantine→baseline→fresh/qualification→slotDir 順序，slotDir 改 prepareSlot。claim output_ready/committed→collect；claim abandoned 或已確定 failed/interrupted→park；claimed+output_ready 未經 recovery、started 未完成、none/tie/corrupt→UNDETERMINABLE。先看 claim，不能只看 attempt。成功空目錄才 wake；失敗維持 skipped RESIDUAL_OUTPUT（收走未完成）、DIR_ANOMALY（unsafe/I/O/high-water/coord）、UNDETERMINABLE（歸屬／foreign inventory unknown）。資格失敗仍原 refused，foreign unknown 不得借 residual 分支升為 sticky。成功清 side reason；skipped 不 claim、不增 round、不空轉，idle 後需 resume，無新 timer。
- [ ] `solo grant path and every retry`：只一般 claim wake 加 proposalsDir 並傳 adapter，prompt 尾端加入 canonical path、檔名/no-dot/兩行 header/白名單限制與原子寫入提示；system 與每次 user prompt 都帶路徑（resumed Claude 舊 system snapshot 不能只靠更新 system）。tidy/verify/format policy wakes、call、不 enrolled 都無欄位／grant／prompt。attempt 失敗後重試／fallback 前再次 ensure 空、失敗就不 invoke；不能只在第一個 claim 前檢查。不傳 policy override，不改 cwd/env/flags。
- [ ] `failure cancel park before finish`：兩個 parkOutbox call sites（:1043/:1049）後、finishAttempt 前加 park；保持 outbox 草稿邏輯原樣。park 失敗記錄並擋本 slot 後續 retry/fallback，其他 slot 繼續；不把 proposals 混入 att.parked/redoContext。timeout/非零/無 session id 沿用 WakeResult.ok 判斷，不發明 runtime exit 成功規則。
- [ ] `recovery b parks before abandon once`：從 scan-verified readFile/skipFile 建立 attempts 快照一次，仍不 re-open attempt/claim；不以 lexical aN 判最新。started 的最新 slot attempt：outbox park（原行為）→proposals park→finish failed；claimed 且其 output_ready attempt 為該 slot 最新：proposals park→fault→save abandoned。若多個未完成 attempt 歸屬衝突，slot unknown 不移輸出。只本次 claimed→abandoned 的 (b)，不重 park historical abandoned；(b) outbox 仍照原行為路由。每 slot catch，失敗後不 finish/save 該 slot、不放進 ready，通知 RunSession block；其他 slot recover→settle 仍執行。測正常後續 committed 收走失敗不被歷史 abandoned 誤 park。
- [ ] `snapshot bound and unbound after clear`：實作 D7/O5 共用 grant provenance；origin 完整集合含 proposals/worktree，hash 不含，static 重複不丟。既有 grant/body safety不因 hash helper 增權。測 normal lead/member、solo、role--2、legacy layout、explicit sandbox.write 與 run-only 同路徑；rebind 不變、static change mismatch。不實作 approve resolver，測試用純 synthetic binding 模擬其契約。
- [ ] 驗證：`npm run typecheck && npx vitest run test/approval-stage3-flows.test.ts test/approval-stage3-recovery.test.ts test/approval-stage3-snapshot.test.ts test/approval-stage3-compat.test.ts test/approval-wake-gate*.test.ts test/approval-recovery-scan.test.ts test/approval-latest-attempt.test.ts test/approval-compat.test.ts`。AC：壞 slot 不 wake/不漏 request、健康 slot 繼續；scan-verified text 未 re-open；mail commit 不被收走錯誤擋住。

## S4 — human status / docs / final gates（S3 後）

**node-engineer 可改：** `src/status.ts`（只 formatter）、`src/doctor-approval.ts`（D8 probe 接線）、必要 `src/approval-collect.ts` readonly count export `collectedRecordCount(home:string,runId:string,project:string):number|'unreadable'`；新 `test/approval-stage3-status.test.ts`。**docs-writer 可改：** `docs/write-scope.md`、`docs/write-scope.zh-TW.md`、`docs/approval-store-api.md`。兩者檔案 disjoint，可並行；S1–S3 不可並行，docs 不能先宣稱功能已存在。不得動 StatusReport/run schemas、JSON renderer、其他 docs。

- [ ] 測 `count is committed records not pending`、`side file reasons fixed and persist after executor deletion`、`JSON never reads collection store`、`doctor link failure error and default-off zero probes`、`malicious errors never printed`、`damaged count is explicit unknown`；沿用 gateLines 只 human 格式讀側檔（`src/status.ts:671–676`）。記錄的原因有時間戳、不是目前健康證明；doctor 維持 containment 詳細定位，rotation 錯誤提示操作者檢查 slot/proposals、collected.seq 或 `.coord/`，不印 agent error 字串。
- [ ] 文件寫實作到哪：request 位置/格式、rotation/recovery/seq、鎖與 stale 手動處理、D3 效能、record 提交點、rejected/soft quota/計數近似、park 不成 redo 草稿、(b) mail 與 proposals 不一致。完整保留 spec §4.4 殘留背景程序/fd 風險、§5 的非讀取隔離／injection／同內容新 seq／lazy expiry 通知延遲、clear 未收走輸出消失、process crash 非斷電保證。明列沒有 approve/execute/feedback/gc/call 收走；F3/Linux/真 sandbox 未驗證與「非可發布：第 0 步未驗證」。
- [ ] `npm run typecheck && npx vitest run test/approval-stage3-status.test.ts test/approval-gate-status.test.ts test/approval-compat.test.ts && npm run check:docs`；AC：人類輸出新資訊、JSON bytes 不變、雙語 headings/links 一致。
- [ ] qa 獨立驗所有 crash/negative cases；cli-reviewer 對 rotation/symlink/inode/collection/recover 順序跨 runtime review，lead 只收一次設計 review。最後 `npm run lint && npm run typecheck && npm test && npm run check:docs`，記錄 pass/fail/skip 和 sandbox 限制；使用者 clean worktree 重跑。未驗證項列 Not done，不稱整體安全已完成。

## fault() matrix / re-entry acceptance

注入 point 在相應 deps.fault，整合 seam 用既有 message-store fault；每個 point 單獨 crash＋重新建 session（不只同 process retry）。真 crash 遺留 `.coord/` 的測試先證實不偷鎖，再由 fixture 模擬操作者停機清鎖後重入；不把 finally 解鎖當 SIGKILL 證據。

| point | 位置／步驟 | 必驗重入 |
|---|---|---|
| `rotation:renamed` | rotate rename 後、mkdir 前（collected 與 parked 各測） | 缺 proposals 重建；來源完整、無新重複 seq／ENOTEMPTY |
| `rotation:recreated` | mkdir+lstat 後、高水位前 | 空 proposals 不再 rotate；現存 seq 推高水位 |
| `collection:high-water` | advanceHighWater 後、解析／done 前 | un-done 原 seq 補收、新 seq 永遠更大 |
| `collection:before-done` / `collection:done` | 全候選提交後、done link 前／後 | 既有 id 原樣採用；done 後不再處理、狀態永不回 pending |
| `payload_committed` | 沿用 publishRecord payload link 後、record link 前 | incomplete 補 record；不同 payload fail-closed、不得覆寫 |
| `record_committed` | 沿用 publishRecord record link 後 | 採既有 record／進展後 state；無重複 id/quota |
| `attempt:output-ready` | finishAttempt output_ready 後、markOutputReady 前（RunSession 呼叫點） | claim claimed→先 park 再 abandon、無 request record |
| `recovery:proposals-parked` | recover (b) park 後、save abandoned 前 | 空 proposals park 冪等；這次才 abandon，後續成功輸出不誤 park |
| `failure:proposals-parked` | failure/cancel park 後、finish failed 前 | started recovery 不重搬到既存 dest、無 redo proposals |

另將 high-water 的 temp_written/temp_synced/renamed、publishExclusive temp_written/temp_synced/linked/temp_removed 各故障映射到既有 stage-1 tests，S2 加 payload/record 名稱篩選確定打中正確 link。所有 window 共通：沒有 lost request、沒有 duplicate id、沒有 reused seq、沒有狀態倒退；park 的 request 保留原 bytes 但永不收走。

## Default-off byte identity / named proof

| surface | 保護方式／既有證據＋本階段補測 |
|---|---|
| adapters/settings/env/args | 無 proposalsDir 時原分支／原呼叫不變；`test/approval-compat.test.ts:132` runtime 三 scenarios 的 f4936b0 fixtures；call/policy enrolled 行為亦不得改，`test/approval-adapters.test.ts` |
| prompts/policy | 沒有 enrolled claim path 就不 append 字元、不建 options；相同 runtime fixture＋`:64` write/enforcement/protected fixtures；S3 fake invoker 比較 run/resume/solo/call/tidy 的實際輸入 |
| on-disk layout | 沒 enrolled slots 不初始化 collector、不讀 store/建 locks/requests/approvals；既有 `test/approval-wake-gate-run.test.ts` default-off 檢查，S3 新 compat 比較 temp home 樹與 legacy mailbox，absent/empty/other-tuples 全測 |
| status human | 不產生新 gate 側檔就沒有 collection count；既有 `test/approval-gate-status.test.ts:143,150`；S4 absent/empty allow fixtures 的格式原樣比對。歷史已有 gate 側檔仍顯示記錄原因，是 2b-2 已有例外（同檔 :75），不得清掉 |
| status --json | 不改 report/schema，不讀 collection/gate；既有 `test/approval-gate-status.test.ts:131` report/CLI bytes 與 read spy，`test/approval-gate-flows.test.ts:51`；S4 加 executors absent/present、records/side-file 有無的矩陣 |

既有 fixtures 不覆蓋完整執行後磁碟樹或所有 status bytes，故不能聲稱它們已單獨證明全部；新 S3/S4 補證，不更動 baseline fixtures。

## Dimension coverage

1. **Compatibility & Format：** default-off 按表逐面保護；原 YAML/run/state/mail schemas 不變，v1 record/seq 重用；新增 `.coord/` 是 enrolled-only 私有協定，舊 binary 忽略它且不執行本功能，不承諾混用新舊 collector；無 migration。
2. **File & Process Safety：** canonical slot grant、lstat 每層/來源/目的、no-follow/nonblock、dev/ino、同 Buffer、link commit；OS/tool 防線效果仍未驗證，非 prompt-only 保證。沒有新 shell/child executor、不改 guard，不聲稱背景 process 已終止。
3. **Concurrency & Recovery：** per-slot exclusive mkdir、不同 slot/worktree 可前進；record/state 保留無鎖 CAS；stale 不偷鎖、fault matrix、Ctrl-C/timeout/cancel/partial mail/odd runtime exit 沿用 attempt lifecycle＋新 park。resume 在 scan-verified recovery 後 settle，未解錯誤不 done、不 wake。
4. **Platform & Operability：** macOS/Linux 介面、Windows 只既有 unsupported 警示／拒絕，不新增支援；Claude request grant、Codex enrolled refusal；無新依賴/timer/watcher。D3 O(N log cap) 僅實際 settle/pre-wake 需要時，JSON status 不掃 store。
5. **Testability & Maintainability：** pure parse/來源鍵/快照、小模組；deps 控 time/actor/probe/token/I/O/fault，child barrier 而非 sleep/random race；temp home/fake invoker。node-engineer 實作，qa 獨立驗收，docs-writer 只更新三個指定 docs。
6. **Observability & Diagnosability：** log.jsonl 固定 operation/class/slot/seq/id，無 payload／summary／parser 值／raw path/error；approval-gate.json 用現有 classes，人類 status 原因＋記錄計數／unknown。state.json/mail/violations 不新增用途；doctor 既有前提/containment 詳細診斷，檔案安全異常由固定類別定位設定／檔名種類，不能靜默當空。

## Open items / Risks / decisions made for the lead

- lead：D1–D8、O5/O6 的 record，預設採本文，若拒絕須先修本契約而非 implementer 猜；沒有其他產品問題需再問使用者。qa：baseline 必先在此 0.42.2 clean worktree 跑 suite，記實際 pass/skip/fail，不能引用 merge 前 2509/1 當本次 baseline；本設計尚未執行產品測試。
- F3（lead/security＋使用者）：預設繼續阻擋發布、不新增 partial whitelist，替代「假測試解除 blocker」拒絕；Linux/真 sandbox 由使用者在外層無限制環境驗證，預設 unverified。這些是尚未完成的發布條件，不是單元測試待猜選項。
- 決策風險逐項：D2 接受 stale 鎖需人清理而非 unsafe takeover；D3 接受 O(N) 列舉而非忽略未知數量/非確定選集；D5 接受 mutation DoS 而非丟請求；D6 接受 human 計數掃 store、計數不含 suppressed denied 而非加 schema；D8 接受 enrolled doctor 暫存 probe 寫入而非無證據宣稱硬連結可用；D7/O5 接受精確重建失敗就不能 approve 而非寬鬆採原 grant。deny counter 軟近似、summary code points、header precedence/分隔 bytes、`.done=done\n`、counter 十進位＋LF 是本文補定預設；拒絕未定格式／語系排序／靜默 parser 修正。
- 收走依前提而非郵件接受、park 永不 redo、policy/call 不給 request channel、跨 run quota 不加硬鎖：依使用者與 v12 已選取捨，不擴成 stage 4+。spec 的 background-fd/mtime/同 UID TOCTOU 和非讀隔離風險仍在，拒絕宣稱「沙盒安全已證明」。
