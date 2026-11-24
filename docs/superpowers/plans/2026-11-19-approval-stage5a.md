# Approval stage 5a Implementation Plan

> **For agentic workers:** 依既有 mail team 流程，lead 每片寄一封 implementation task；node-engineer 實作、cli-reviewer 審查、qa 驗證。只在設計審查通過後實作。不得 commit、push、PR、merge。本文件不是測試通過或發布聲明。

**Goal:** 完成 spec §10 task 5 的唯讀半部：`approvals list [--all] [--json]`、`approvals show <id>`、`approvals audit <id>`、`approvals reject <id> [--reason <text>]`，加上共用的外部文字消毒器與可重用的 payload 分頁器。`approve`、執行器、`resolve`、回饋、gc 屬 stage 5b／6，不在本計畫。

**Architecture:** 三片：S1 純函式（消毒、分頁、畫面文字）、S2 查詢層（id 前綴、列表收集與 `--all` 懶惰寫入、稽核讀取、動作者身分、執行器事實）、S3 `src/cli.ts` 接線與 CLI 層 handler。全部重用 `readCurrent`／`transition`／`decideTransition`／`computeDisplay`／`creatorLiveness`／`listCommittedIds`／`serializeApprovalList`；不新增 store、鎖、schema 或狀態格式。唯一的寫入是既有 `transition()` 建立 `state/<n+1>.json`。

**Tech Stack:** Node >=20、TypeScript ESM，Node `fs`/`crypto`/`os`；commander ^14.0.3、yaml ^2.5.0、zod ^4.6.5（`package.json`）。不加依賴、不升級。終端寬度用 `process.stdout.columns`，字寬用本計畫列出的固定範圍表，不引入 wcwidth 套件。

**Spec:** [approval gate](../specs/2026-11-13-approval-gate-design.md) §3（輔助防線）、§4.5、§4.6、§4.8、§4.10、§5、§6、§9；[store API](../../approval-store-api.md)；[stage 4 plan](2026-11-18-approval-stage4.md)。原始 user-task 優先於本計畫；發現真正矛盾時停止並報 lead，不自行選邊。

## Global constraints / 邊界

- DEFAULT-OFF：沒有 `executors.yaml` 時，既有命令的輸出、目錄、compat fixture 逐位元組不變。新子命令是新介面；`approvals` 群組說明字串改變（D4，沒有 fixture 或測試涵蓋 help：`grep -rn "Recover approval requests" test` 無結果，只有 `docs/commands.md:95` 附近文字要由 docs 更新）。
- 四個新命令**都不需要** `executors.yaml`：使用者依 spec §11.4 先移除 `executors.yaml` 再 `reject` 剩下的 `pending`，所以 list/show/audit/reject 只讀 `approvals/`；`show` 另外**嘗試**讀 `executors.yaml` 只為顯示執行器區，讀不到不影響其他區與結束碼。
- 不改 `record.json`、`state/<n>.json`、`ApprovalListV1`（`schema_version: 1`）、`executors.yaml` schema；不改任何 stage 1–4 函式簽名。唯一的既有檔案修改：`src/approval-request.ts` 的私有 `visible` 加上 `export`（S1，行為不變，見 D3）與 `src/cli.ts` 的 `approvals` 群組改為變數持有（S3，`collect` 行為與訊息不變）。
- 不新增 `message-store` 的 `fault()` 全域 seam（教訓 `fault-seams-gate-to-feature`）：崩潰注入一律經 `transition(..., deps: StoreDeps)` 既有的 `deps.fault`（`src/approval-state.ts:96-97`，點位 `temp_written|temp_synced|linked|temp_removed`，`src/approval-io.ts:12,197-232`）。
- 沒有任何命令 spawn 執行器、runtime 或 shell。唯一可能的子行程是既有 `pidStart()`（macOS 上 `ps -o lstart=`，`src/project-lock.ts:83-85,105`），且只在需要 `executing` 存活證據或要寫入狀態時才呼叫（D6）。
- status --json、web `COMMANDS`、run/mail/worktree 格式不變。macOS/Linux；Windows 不新增支援（沿用既有 approval 平台拒絕：本片命令只讀寫 `approvals/`，`publishExclusive` 在 Windows 的限制照舊，文件寫明不支援）。Linux 與真實沙盒驗證不在本任務，維持「非可發布：第 0 步未驗證」。

## Current evidence / 現況

| 現況 | 可重現來源 |
|---|---|
| `readCurrent` 讀 record 與數字最大 `state/<n>.json`，n>1 還要求 n-1 可讀；任何損毀 throw `CORRUPT_STATE`／`CORRUPT_RECORD`，不退回較小 n | `src/approval-state.ts:56-79` |
| `transition(home,id,decide,deps,max=32)` 每次重試重讀並重新呼叫 `decide(latest)`；回 `committed`／`unchanged`／`contended`；寫入錯誤 throw | `src/approval-state.ts:90-109` |
| `reject`：只對 `pending`，需 `interactive_tty`、`prefix_confirmed` 與非空 `actor.tty`；無時鐘前置條件；終態一律 `ALREADY_HANDLED`；`executing`/`unknown` 對 reject 為 `NOT_APPLICABLE` | `src/approval-transition.ts:44,62,74-81,90-113` |
| `lazy`：pending 且 `now > expires_at` → `expired`，否則 noop；executing 需 creator 證據，死亡 → `unknown`（`creator <reason>`），存活 noop；對 `unknown` 為 `NOT_APPLICABLE` | `src/approval-transition.ts:82-83,100-106,111-113` |
| `computeDisplay` 純函式；executing 沒有證據就 throw `INVALID_INPUT` | `src/approval-display.ts:17-36` |
| `creatorLiveness` 嚴格判定；`defaultProbe` 用 `pidStart` | `src/approval-liveness.ts:35,49-72` |
| `listCommittedIds` 讀每個 record，壞 record 變 problem，根目錄不存在回空；根目錄不安全 throw | `src/approval-store.ts:47-72` |
| `serializeApprovalList` 驗 v1 envelope、依 id 排序、JSON+LF；problem code 列舉固定 | `src/approval-json.ts:9-98` |
| `publishExclusive` 會建立缺少的父目錄（`ensureDirs`），temp 名 `.approval-<pid>-<token>.tmp`，fault 丟出時不清 temp | `src/approval-io.ts:165-233` |
| `highestN` 忽略非數字名（temp 不影響），別名（`01.json`）fail-closed | `src/approval-state.ts:39-48` |
| 收走白名單 `visible()`（Cc、Cf、Zs/Zl/Zp、VS、DICP、Hangul/braille 填充；放行 LF、TAB、U+0020、U+3000）目前是私有函式 | `src/approval-request.ts:27-36` |
| record schema 對 `summary` 只驗字串（`nstr`），不驗白名單 | `src/approval-schema.ts:132` |
| `Actor` = `{user, tty: string|null, pid, pid_started: string|null}` | `src/approval-types.ts:37-38` |
| `approvals` 群組以 `program.command("approvals")...command("collect")` 單一鏈建立，無變數可再掛子命令 | `src/cli.ts:937-965` |
| `interactive()` = stdin 與 stdout 皆 TTY；`fail()` 印 stderr 並 `process.exit` | `src/cli.ts:224,48-51` |
| `home()` 是 `path.resolve` 未 canonical；`readApprovalFile` 要求 canonical root | `src/cli.ts:46`、`src/paths.ts:33-36,101-117`、`src/approval-io.ts:72-81` |
| web 白名單測試已存在（不含任何 approval 字樣） | `test/approval-call-cli.test.ts:396-404` |
| compat 測試（f4936b0 fixture，不得重生） | `test/approval-compat.test.ts:62,130,209` |
| 既有 doctor 用的 `escapeControl` 是「跳脫」C0/C1 成 `\uXXXX`，不處理 ESC 序列、Cf、`\r` | `src/doctor-approval-containment.ts:129-137` |

## Locked decisions / 決策

### D1 — 預設 `list` 只列計算狀態為 `pending`

預設 `list`（人類與 `--json`）只列 `computeDisplay(...).computed === 'pending'` 的請求（spec §4.6 末句「`list` 預設只列 `pending` 且未過期者」）。已逾期未記錄、建立者已死的 `executing` 不在預設清單；它們的計算標籤出現在 `show`、`audit` 與 `list --all`。預設 `list` 對 `executing` 不探測 PID（它不可能是 `pending`），只計入尾行的「其他狀態數」。因此預設 `list` 零寫入、零子行程。

user-task 第 1 項「a request past `expires_at` or whose creator is dead is shown with a computed state such as "expired (not yet recorded)", and nothing is written」可被讀成「預設清單也顯示它們」。本計畫採上述讀法，列在「Spec vs code」第 1 項；若使用者要預設也列出，只改 S2 的過濾條件與 S3 的尾行，其他契約不動。

**Rejected:** 預設列出逾期未記錄者（與 spec §4.6 末句衝突，且使用者會在預設清單看到不能核可的項目）。

### D2 — id 前綴與 reject 的確認

- 前綴語法：`^[0-9a-f]{8,24}$`（小寫）。大寫、非 hex、少於 8 或多於 24 字元一律 `invalid`，不做大小寫轉換。
- 候選集合：`approvals/` 下符合 `^[0-9a-f]{24}$` 的目錄名，且 `lstat(<id>/record.json)` 存在（任何型態；不讀內容）。所以損毀的 record 仍可被 `show`／`audit` 指到並顯示損毀；沒有 `record.json` 的未完成目錄不算。
- 恰好一個候選 → `ok`；零 → `not_found`；多個 → `ambiguous`（回報數量）。
- `reject` 的 `prefix_confirmed` = 參數通過上述語法且恰好對應一個已提交 id。不另外要求重打或 y/N（spec §3 的「輸入前 8 碼確認」由參數本身滿足；它只防誤操作，真正屏障是第 0 步 (a)）。
- TTY：CLI 檢查 `process.stdin.isTTY && process.stdout.isTTY`（同 `interactive()`，`src/cli.ts:224`），再由 `decideTransition` 的 `confirmed()` 要求 `actor.tty` 非空。`actor.tty` 來源見 D6。

**Rejected:** y/N 提示（stage 5b approve 才需要完整瀏覽後確認；reject 不可逆但無外部效果，參數前綴已防誤打）；以 `listCommittedIds` 為候選（壞 record 會變成 problem 而無法用 `show` 檢視）。

### D3 — `--reason` 驗證與外部文字消毒

`--reason` 是使用者輸入，在輸入端驗證，不改寫：
- 未給 → `reason: null`。給了空字串 → 拒絕。
- 長度至多 300 個 code point（同 `SUMMARY_LIMIT`，`src/approval-request.ts:13`）。
- 必須通過收走白名單 `visible()`，且**不得含 LF 或 TAB**（單行）。`visible` 改為 `export`（S1，只加關鍵字）。
- 拒絕訊息見 C5；顯示時仍經消毒器（縱深防禦，舊資料或手改 state 檔）。

消毒器 `sanitizeExternal(text)` 的精確規則（依序套用；對同一輸入冪等）：

1. 孤立代理（`/[\uD800-\uDFFF]/` 中不成對者）換成 U+FFFD。
2. 刪除完整 ESC 序列：
   - CSI：`\x1b\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]` 與 8-bit `\x9b[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]`。
   - 字串型（OSC/DCS/SOS/PM/APC）：`\x1b[\]PX^_]` 或 `[\x90\x98\x9d\x9e\x9f]` 開頭，非貪婪到第一個 `\x07`、`\x9c` 或 `\x1b\\` 為止，整段刪除。**沒有終止符**時不整段刪，只刪引導字元（之後的文字以一般文字處理），避免一個未終止的 OSC 吃掉其後所有輸出。**實作須為線性時間**（review F4：非貪婪正規式對連續未終止的 `ESC ]` 為平方時間，64 KiB 實測 853 ms）：單趟掃描，或先找出最後一個終止符位置，超過它的引導字元直接只刪引導。
   - 其他：`\x1b[\x20-\x2f]*[\x30-\x7e]`（如 `ESC ( B`、`ESC 7`）。
3. 每個 `\r` 換成 `⏎`（U+23CE）。`\r\n` 因此成為 `⏎\n`。
4. 每個 TAB 換成一個空格 U+0020（決策，見 Risks；spec 原文為「剝除」，剝除會把 `a\tb` 黏成 `ab`）。
5. 刪除其餘所有 `\p{Cc}`，**只保留 LF**（涵蓋 C0、DEL、C1、殘留的單獨 ESC）。
6. 刪除所有 `\p{Cf}`（bidi 控制、零寬、U+FEFF、tag 等）。
7. U+2028、U+2029（Zl/Zp，非 Cc/Cf，部分終端視為換行，會破壞「每列以 `│ ` 開頭」）換成 `⏎`（review F3）。

適用欄位（**一律**經 `sanitizeExternal`）：`ExitData.stdout.text`、`stderr.text`、`error_code`、`signal`；`unknown.detail`；`rejected.reason`；`manual.conclusion`；`actor.user`、`actor.tty`、`actor.pid_started`；所有印到終端的錯誤／problem 文字與路徑（`ApprovalError.path`、problem `path`/`hint`、`origin.project_dir`、`origin.full_writable`、執行器 `command[0]` 與其真實路徑）；使用者打的 id 參數（回顯時，另截至 64 code point 加 `…`）；`record.executor` 與 `source_key.filename`（review F3：乾淨名稱上 `sanitizeExternal` 為恆等，手改 record 不能經這兩欄注入）。

**不經**消毒器、原樣輸出：payload、`summary`、id、hash、ISO 時間、列舉代碼（status、reason、code）。payload 與 `summary` 顯示前改用 `visible()` **檢查**（不改寫）：不通過就整段不顯示並標示「withheld」（C3），因為 record 是 dispatcher 寫的，不通過代表檔案被改過；這是縱深防禦，不改 spec「不改寫 payload」的原則。

多行外部文字（stdout/stderr/conclusion/detail）消毒後逐行加 `│ ` 前綴輸出，所以偽造的框線不會從行首開始。`list --json` 不經消毒器：JSON 是資料，`JSON.stringify` 已跳脫 C0；v1 item 不含外部文字，problem 的 `hint` 是固定字串（D5）。

**Rejected:** 重用 `escapeControl`（只跳脫 C0/C1，不處理 ESC 序列、Cf、`\r`）；對 payload 也消毒（違反 spec §4.6「顯示就是內容」）；未終止的 OSC 刪到字串尾（會吞掉之後的診斷）；TAB 依 spec 字面刪除（可讀性；記為決策）。

### D4 — 不存在的 store 與 help 文字

- `approvals/` 不存在（沒有 `executors.yaml` 的一般情況）：`list` 印空結果（C1）結束 0；`show`／`audit`／`reject` 依 D2 得 `not_found`（C0）結束 1。**都不建立任何檔案或目錄**（`listCommittedIds` 在 ENOENT 回空，`src/approval-store.ts:57`；前綴解析對 ENOENT 同樣回空）。
- 命令使用的 home = `canonicalPath(home())`（`src/paths.ts:101`）；home 不存在時回傳絕對路徑本身，不建立。
- `approvals` 群組說明改為 `Review, reject and recover approval requests.`；子命令說明：
  - `list`：`List pending approval requests (--all: every state, records expiry).`
  - `show`：`Show one approval request in full. Read-only.`
  - `audit`：`Print the recorded facts and state events of one approval request. Read-only.`
  - `reject`：`Reject a pending approval request (needs a terminal).`
  - `collect`：沿用既有字串不改（`src/cli.ts:941`）。
- `HELP_LAYERS` 的 `"Approvals:"` 不變（`src/cli.ts:987`）。

### D5 — 分頁器（stage 5b approve 重用）

純函式，位元組為單位，只計 payload 位元組（不計前綴、換行顯示、頁首）：

- `paginatePayload(payload, pageBytes = 4096)`：頁 i 涵蓋 `[start, end)`，`start` 從 0 起，`end = min(len, start + pageBytes)`；若 `end < len` 且 `payload[end]` 是 UTF-8 續位元組（`(b & 0xC0) === 0x80`），`end` 往回退到該字元的首位元組。下一頁 `start = end`。不偏好在 LF 切（spec 原文只要求字元邊界）。0 位元組 payload → 一頁 `{index:0,start:0,end:0}`。頁的聯集恰為 `[0, len)`、互不重疊；所有 `end - start` 總和 = `len`（approve 的「已瀏覽位元組」即此總和）。payload 已由 `readApprovalFile` 保證為合法 UTF-8（`src/approval-io.ts:72-81`），所以往回退最多 3 位元組、不會得到空頁（pageBytes ≥ 4）。
- `renderPayloadPage(payload, page, columns)`：把該頁位元組解碼成文字，依 LF 切成邏輯行；每個邏輯行切成顯示列：
  - 顯示寬度 `W = max(20, columns - 2)`。逐 code point 累計寬度：TAB 計 8；下列範圍計 2：U+1100–115F、U+2E80–303E、U+3041–33FF、U+3400–4DBF、U+4E00–9FFF、U+A000–A4CF、U+AC00–D7A3、U+F900–FAFF、U+FE30–FE4F、U+FF00–FF60、U+FFE0–FFE6、U+1F300–1F64F、U+1F900–1F9FF、U+20000–3FFFD；其餘計 1。下一個 code point 會使累計超過 `W` 時，在它之前換列（字元邊界，不改內容，TAB 不展開）。程式註解須寫明：組合字元計 1、TAB 不論欄位一律計 8，只影響換列位置（外觀），不影響內容（review F6）。
  - 前綴：邏輯行的第一列，若它是真正的行首（payload 開頭，或前一個位元組是 LF）用 `│ `；否則（換列、或承接上一頁未完的行）用 `┆ `。
  - LF 本身不顯示；頁以 LF 結尾時，LF 之後的空字串不輸出一列。空行輸出 `│ `（前綴後無內容）。
- 內容可還原：把所有頁的列去掉 2 字元前綴，`┆ ` 列直接接在前一列之後、`│ ` 列（第一列除外）前補 LF，最後若 payload 以 LF 結尾補 LF，得到的位元組等於 payload。這是 S1 的性質測試。
- `columns`：S3 傳入 `process.stdout.isTTY ? (process.stdout.columns || 80) : 80`；測試直接注入。

**Rejected:** 依終端自動換行（續列沒有前綴，偽造框線可從視覺行首開始）；續列也用 `│ `（看不出換列與真換行，等於改變內容的呈現）；偏好在 LF 切頁（頁大小不可預期，approve 的計數較複雜）；用 wcwidth 套件（新依賴）。

### D6 — 動作者身分與 TTY 名稱

`actorIdentity(deps)` 回傳 `Actor`：
- `user`：`os.userInfo().username`；throw 時用 `uid:<process.getuid()>`；仍不可得用 `unknown`。
- `tty`：stdin 不是 TTY → `null`。是 TTY → `ttyName(0)`：
  - Linux：`fs.readlinkSync('/proc/self/fd/0')`，以 `/dev/` 開頭就用它。
  - 其他或上式失敗：`fs.fstatSync(0).rdev`，掃描 `/dev` 下名稱以 `tty` 開頭者與 `/dev/pts/*`（`lstatSync`，`isCharacterDevice()` 且 `rdev` 相等）→ `/dev/<name>`；最多掃 2048 項。
  - 都找不到：`rdev:<十進位 rdev>`（非空，讓 `decideTransition` 的 `confirmed()` 可成立；稽核仍可辨識裝置）。文件與 audit 須說明：`rdev:<n>` 只是裝置號；TTY 檢查是 `isTTY(0) && isTTY(1)`，屬輔助防線（spec §3）；Linux 與 macOS 上的 TTY 名稱查找皆未在真實終端驗證（review F5）。
  - 不 spawn `tty` 或 `ps`。所有 fs 呼叫注入（`ActorDeps`）。
- `pid`：`process.pid`；`pid_started`：`pidStart(process.pid) ?? null`（reject 與 lazy 寫入允許 null；approve 在 5b 才必須非 null）。
- 只在**將要呼叫 `transition()`** 時才計算 actor（reject；`list --all` 在至少有一個 `display.unrecorded` 候選時）。所以 `show`、`audit`、預設 `list`、無候選的 `list --all` 都不會因 actor 而 spawn `ps`。
- lazy 寫入的 actor 不需要 TTY（`tty` 可為 null）。

**Rejected:** spawn `tty(1)`（子行程，沙盒內可能 EPERM）；`process.env.SSH_TTY`/`TTY`（可偽造、常缺）；找不到裝置名就拒絕 reject（在合法終端上也會失敗）。

### D7 — 懶惰寫入（`list --all`）與競態

`list --all` 流程：
1. `readEntries(all=true)`：讀所有已提交 id 的 `readCurrent`；`executing` 以 `creatorLiveness(owner, state.updated_at, state.timeout_sec, now, probe)` 取證據後 `computeDisplay`。
2. 對 `display.unrecorded === true` 的每個 id（逾期的 `pending`、建立者已死的 `executing`）呼叫：
   ```ts
   transition(home, id, (latest) => ({
     event: { type: 'lazy', trigger: 'list_all',
       creator: statusOf(latest) === 'executing' ? creatorLiveness(...fresh from latest, now(), probe) : null },
     context: { now_ms: now(), actor } }), storeDeps)
   ```
   每次重試都用 `latest` 重新取得時間與存活證據（`transition` 已重呼叫 `decide`，`src/approval-state.ts:98-101`）。
3. 結果：`committed` → 該列標 `[recorded now]`；`unchanged`（noop、`ALREADY_HANDLED`、`NOT_APPLICABLE`：另一寫入者先贏或狀態已變）→ 不是 problem；`contended` → 不是 problem，該列顯示計算標籤（下次 `--all` 再試）；throw `ApprovalError` → problem（hint `Lazy state could not be recorded`），該列加 `[not recorded: <CODE>]`，繼續處理其他 id。
4. 對步驟 2 處理過的 id 重新 `readCurrent` + `computeDisplay`（executing 重新探測），輸出最終結果。

並行：兩個 `list --all` 同時寫同一個 n+1，`linkSync` 獨佔，只有一個 `committed`；另一個 EEXIST → 重讀 → 終態 → `ALREADY_HANDLED` → `unchanged`。`reject` 與 lazy、`reject` 與 approve 事件同理（spec §4.5「EEXIST 的一方重新讀取」）。

**Rejected:** 在預設 `list` 或 `show` 順手寫入（spec §4.5、§7 明確禁止）；lazy 失敗讓整個 `list --all` 失敗（一筆壞資料不應遮住其他請求）；contended 當 problem（是正常競態結果，不是錯誤）。

### D8 — 損毀、問題與結束碼

- 「損毀」= `readCurrent` 或 `readRecord` throw `CORRUPT_STATE`／`CORRUPT_RECORD`／`UNSUPPORTED_VERSION`（包含最大 n 損毀、n-1 缺失或損毀、別名檔名，`src/approval-state.ts:39-48,74-77`）。其他 `ApprovalError`（`IO_ERROR`、`UNSAFE_PATH` 等）為「unreadable」。
- 損毀的請求：所有轉換被拒（`transition` 在 `readCurrent` 就 throw，`reject` 與 lazy 都寫不進去）；`list`（預設與 `--all`）**永遠**列出 problem 列，不受 pending 過濾；`show` 盡量顯示 record 可讀部分並標示 `corrupted (<CODE>)`。
- 結束碼規則（四個命令共用）：**輸出中出現任何 problem、損毀、payload 不符或被 withheld 時結束 1；stdout 仍輸出所有可讀內容**。只有成功且完整時結束 0。`reject` 只有在本次 `committed` 時結束 0。
- `list --json` problems 的固定 hint：record 讀取失敗沿用 `Committed approval could not be read`（`src/approval-store.ts:68`）；`readCurrent` 的損毀 `State is corrupted; every transition is refused`；`readCurrent` 其他錯誤 `State could not be read`；lazy 寫入失敗 `Lazy state could not be recorded`。code 只用既有 `ApprovalErrorCode`（`src/approval-json.ts:66-70`）。

**Rejected:** 有 problem 仍結束 0（腳本會把損毀當成功，違反「nothing fails silently」）；有 problem 就不輸出 stdout（使用者看不到其他請求）。

## CLI contract / 命令契約

記號：`<id>` = 完整 24 碼 id；`<p>` = 清單內的唯一前綴（長度 = `uniquePrefixLength(所有候選 id)`：最小的 L ≥ 8 使所有候選的前 L 碼互異，最多 24）；`<arg>` = 使用者參數經消毒並截至 64 code point（超過加 `…`）；`<path>` = 經消毒的絕對路徑；`<label>` = 狀態標籤：

| 情況 | `<label>` |
|---|---|
| persisted = computed（非 denied） | 狀態字：`pending`、`executing`、`unknown`、`executed`、`failed`、`rejected`、`expired`、`tampered` |
| denied | `denied (<reason>)` |
| pending，`now > expires_at` | `expired (not yet recorded)` |
| executing，建立者已死 | `executing, creator dead (not yet recorded)` |
| 損毀 | `corrupted (<CODE>)` |

`<proposer>`：run → `<project>:<role> (run <run_id>)`；call → `call:<role> (call <call_id>)`（取自 `origin`）。

### C0 — 共用錯誤（stderr，結束 1，**不寫任何檔案**）

| 情況 | stderr |
|---|---|
| id 語法錯 | `Approval id "<arg>" is not valid: use 8 to 24 lowercase hex characters as printed by approvals list.` |
| 無符合 | `No approval request matches "<arg>".` |
| 多個符合 | `Approval id prefix "<arg>" matches <k> requests; type more characters.` |
| `approvals/` 不安全或不可讀（symlink、非目錄、EACCES） | `Approvals store cannot be read (<CODE>): <path>.` |

### C1 — `approvals list [--all] [--json]`

**磁碟：** 預設**不寫任何東西**、不 spawn。`--all` 只可能建立 `approvals/<id>/state/<n>.json`（`expired`／`unknown`，經 `transition`，可能附帶建立 `state/` 目錄與 temp 檔清除），以及計算 actor 時 `pidStart()` 的 `ps`。

**人類輸出（stdout）**，排序：先依 `created_at` 再依 id；problem 列排在一般列之後，依 id：

- 一般列：`<p>  <label>  <executor 或 ->  <proposer>  created <created_at>  expires <expires_at>`；`--all` 中本次寫入者尾加 `  [recorded now]`；lazy 寫入失敗者尾加 `  [not recorded: <CODE>]`。
- problem 列：損毀 `<p>  corrupted (<CODE>)  <path>`；其他 `<p>  unreadable (<CODE>)  <path>`。
- 預設模式沒有可列的 pending 時印 `No pending approval requests.`；`--all` 沒有任何請求與 problem 時印 `No approval requests.`。
- 預設模式尾行（只在 k > 0）：`<k> more request(s) not pending; approvals list --all shows every state.`（k = 已提交、可讀、計算狀態非 pending 的數量，含 executing；不含 problem）。

**`--json`（stdout）**：`serializeApprovalList({ schema_version: 1, requests, problems })` 的輸出原樣（JSON + LF，id 排序，`src/approval-json.ts:79-98`）。`requests` 預設只含計算 pending；`--all` 含全部可讀者（`display` 為最終重讀結果；寫入失敗者保持 `unrecorded: true`）。`problems` 依 D8，預設與 `--all` 都包含。不輸出 `[recorded now]` 之類人類欄位（v1 item 是 strict）。

**stderr：** 成功時無。根目錄失敗見 C0（`--json` 時 stdout 空）。

**結束碼：** 0 = 無 problem；1 = 有 problem（stdout 仍完整）或 C0。

### C2 — `approvals show <id>`

**磁碟：** 嚴格唯讀，不寫任何檔案或目錄；只讀 `approvals/`（含其他 record 以找相同 payload）、`executors.yaml` 與 `command[0]`。只有在本請求或相同 payload 的其他請求為 `executing` 時呼叫 probe（`pidStart` 可能 spawn `ps`，不寫檔）。

**stdout**（D5 換列；`columns` 見 D5）：

```
Approval <id>
  status:   <label>
  proposer: <proposer>  slot <proposer.slot>
  created:  <created_at>
  expires:  <expires_at>
  payload:  <bytes> bytes  sha256 <record 前16碼> (recorded)  <讀取當下前16碼> (read now)
  same payload: <p> (<label>), <p> (<label>)
[agent statement, unverified]
│ <summary>
[executor]
  name:    <executor>
  command: <command[0] 真實路徑>
  sha256:  <64 hex>
[payload, complete content] page <i>/<N>, bytes <start>-<end-1> of <bytes>
<D5 rows>
...（每頁一個頁首）
└ end of payload (<bytes> bytes)
```

變化（每一個都是精確字串）：
- 讀到的 hash 與 record 不同：payload 行尾加 `  MISMATCH`；stderr `Approval <id>: payload sha256 does not match record.json; the payload changed after collection.`；仍顯示 payload（若通過 `visible()`）；結束 1。
- payload 檔讀不到：payload 行為 `  payload:  <bytes> bytes  sha256 <前16碼> (recorded)  unreadable (<CODE>)`；payload 區為 `(payload unreadable: <CODE>)`；stderr `Approval <id>: payload cannot be read (<CODE>): <path>.`；結束 1。
- `same payload`：其他已提交且 `payload_sha256` 相同者（排除自己），依 id 排序，最多 20 個，之後 `, … <k> more`；沒有時印 `  same payload: none`；他者損毀時 `(<p> (corrupted))`。
- `summary` 為 null：`(none)`；不通過 `visible()`：`(withheld: fails the request allow-list)`。
- payload 不通過 `visible()`：payload 區只有一行 `(withheld: fails the request allow-list)`（無頁首與結尾行）；stderr `Approval <id>: payload or summary fails the request allow-list and was not displayed; the record may have been altered.`；summary 被 withheld 時同一句；結束 1。
- 執行器：`executors.yaml` 不存在或沒有該名稱 → `  name:    <executor> (not registered)`，無 command/sha256 行；`executors.yaml` 讀不到或無效 → `  name:    <executor> (executors.yaml cannot be read: <CODE>)`；`command[0]` 無法檢查 → `  command: <設定路徑> (cannot be inspected: <CODE>)`，無 sha256 行（CODE = errno 字串或 `NOT_REGULAR`）。執行器區的問題**不改變**結束碼（5a 不執行；5b approve 會另行拒絕）。
- 空 payload：payload 區為頁首 `[payload, complete content] empty (0 bytes)`，無列，結尾 `└ end of payload (0 bytes)`。
- payload 不以 LF 結尾：結尾行為 `└ end of payload (<bytes> bytes, no final newline)`。
- denied：payload 行為 `  payload:  none (denied: <reason>)`（`scan_limit` 加 `, <ignored_count> entries ignored`）；無 `same payload` 行；executor 為 null 時 `  name:    -`；payload 區為 `(no payload)`。
- 狀態損毀：`  status:   corrupted (<CODE>)`，其餘照印；stderr `Approval <id>: state is corrupted (<CODE>): <path>. Every transition is refused.`；結束 1。
- record 讀不到：stdout 空；stderr `Approval <id>: record.json cannot be read (<CODE>): <path>. Every transition is refused.`；結束 1。
- 正常結束 0。C0 錯誤同上。

### C3 — `approvals audit <id>`

**磁碟：** 嚴格唯讀；只在最後的 `current:` 需要 `executing` 證據時 probe。

**stdout：**

```
Approval <id>
record.json
  disposition: <pending|denied>[ (<reason>)]
  source:      <kind> <source_id>  slot <slot>  seq <seq>[  file <filename>]
  origin:      <proposer>  dir <project_dir>
  writable:    <dir 或 file 路徑>（每個一行，第一行之後以 13 個空格對齊；集合為空時 `(none)`）
  proposer:    role <role>  slot <slot>
  executor:    <executor 或 ->
  summary:     <summary 或 (none) 或 (withheld: fails the request allow-list)>
  payload:     <bytes> bytes  sha256 <64 hex>     （denied：none）
  created:     <created_at>
  expires:     <expires_at>
  qualification: <64 hex 或 none>
  premise:     <check> <ok|failed> <code>（每個一行）
state events
  #<n>  <updated_at>  <status>  by <user>  tty <tty 或 ->  pid <pid>  started <pid_started 或 ->
        <依狀態的細節行，見下>
current: <label>
```

細節行（每個值經 D3 消毒；多行文字逐行 `│ ` 前綴，以 8 空格縮排）：`rejected` → `reason: <reason 或 (none)>`；`expired` → 無；`unknown` → `reason: <creator_dead|interrupted>` 與 `detail:` 區塊；`executing` → `owner pid <pid> started <pid_started>  timeout <s>s  viewed <bytes> bytes sha256 <64hex>  command sha256 <64hex>`；`executed|failed` 執行器 → `exit <code 或 ->  signal <sig 或 ->  failure <failure 或 ->  error <error_code 或 ->`，再接 `stdout:`／`stderr:` 區塊（空字串印 `(empty)`，截斷加 `(truncated at 65536 bytes)`）；`executed|failed` 人工 → `conclusion:` 區塊；`tampered` → `observed sha256 <64hex>`。

- 沒有狀態檔：`state events` 下一行 `  none (status comes from record.json)`。
- 依數字讀 `1..max`；某個 `n` 讀不到或損毀：印 `  #<n>  corrupted (<CODE>)  <path>`，繼續讀其他 n；`current:` 印 `corrupted (<CODE>)`；stderr 同 C2 損毀句；結束 1。非數字檔名（temp）不列出。別名檔名（`01.json`）→ `readCurrent` 損毀規則，`current:` 損毀。
- record 讀不到：同 C2。正常結束 0。

### C4 — `approvals reject <id> [--reason <text>]`

**檢查順序**（任一失敗即停止，**不寫任何檔案**，結束 1）：(1) id 語法（C0）；(2) `--reason`（C5）；(3) TTY；(4) 前綴解析（C0）；(5) actor（D6）；(6) `transition()`。

**磁碟：** 只在 `committed` 時建立 `approvals/<id>/state/<n+1>.json`（`status: rejected`，`reason`，actor），可能附帶建立 `state/` 目錄。

| 結果 | 輸出 | 結束碼 |
|---|---|---|
| `committed` | stdout `Approval <id>: rejected.` | 0 |
| 非 TTY（stdin 或 stdout），或 `CONFIRMATION_REQUIRED` | stderr `approvals reject needs an interactive terminal (stdin and stdout must be a TTY); nothing was changed.` | 1 |
| `ALREADY_HANDLED`（終態含 denied） | stderr `Approval <id>: not rejected; it is already <status>.` | 1 |
| `NOT_APPLICABLE`（executing、unknown） | stderr `Approval <id>: not rejected; only a pending request can be rejected (current: <status>).` | 1 |
| `SEQUENCE_OVERFLOW` | stderr `Approval <id>: not rejected; the state sequence cannot grow (SEQUENCE_OVERFLOW).` | 1 |
| `contended`（32 次衝突） | stderr `Approval <id>: not rejected; the state kept changing. Run approvals show <id>, then retry.` | 1 |
| 損毀（D8） | stderr `Approval <id>: not rejected; state is corrupted (<CODE>): <path>. Every transition is refused.`（record 損毀用 `record.json cannot be read (<CODE>): <path>.`） | 1 |
| 寫入錯誤（`IO_ERROR`、`UNSUPPORTED_LINK`、`UNSAFE_PATH`） | stderr `Approval <id>: not rejected; state cannot be written (<CODE>): <path>.` | 1 |

`<status>` 是 persisted 狀態字。逾期但未記錄的 `pending` 仍可 `reject`（spec §4.5 該列前置條件「—」，`decideTransition` 對 reject 不看逾期）。時鐘早於 `created_at` 也可 `reject`（同理；`updated_at` 照實記錄）。

### C5 — `--reason` 拒絕訊息（stderr，結束 1，不寫檔）

- 空字串：`--reason must not be empty; nothing was changed.`
- 超過 300 code point：`--reason must be at most 300 characters; nothing was changed.`
- 含 LF、TAB 或 `visible()` 拒絕的字元：`--reason must be one line of visible text (no control, format or invisible characters); nothing was changed.`

## Module signatures / 模組與介面

### S1 `src/approval-text.ts`（新，純）

```ts
export const CR_MARK = '⏎';
export const REASON_LIMIT = 300;
export function sanitizeExternal(text: string): string;               // D3 步驟 1-7，冪等，線性時間
export function blockLines(text: string, prefix?: string): string[];  // sanitize 後依 LF 切、每行加 prefix（預設 '│ '）；'' → []
export function passesAllowList(text: string): boolean;               // = visible(text)，重用 approval-request.ts
export type ReasonCheck = { readonly ok: true; readonly reason: string | null } | { readonly ok: false; readonly message: string };
export function checkReason(raw: string | undefined): ReasonCheck;    // C5 的三個 message 字串（不含 "; nothing was changed." 以外的變化）
export function clipArg(raw: string): string;                          // sanitize + 64 code point + '…'
```

### S1 `src/approval-screen.ts`（新，純）

```ts
export const PAGE_BYTES = 4096;
export interface PayloadPage { readonly index: number; readonly start: number; readonly end: number }
export function paginatePayload(payload: Buffer, pageBytes?: number): PayloadPage[];
export function cellWidth(codePoint: number): 1 | 2 | 8;
export function renderPayloadPage(payload: Buffer, page: PayloadPage, columns: number): string[];
export function uniquePrefixLength(ids: readonly string[]): number;
export function statusLabel(s: { readonly display: Display; readonly reason: DeniedReason | null } | { readonly corrupted: ApprovalErrorCode }): string;
export function proposerLabel(origin: Origin): string;

export interface ListRowModel { readonly kind: 'request'; readonly id: string; readonly label: string; readonly executor: string | null;
  readonly origin: Origin; readonly created_at: IsoTime; readonly expires_at: IsoTime; readonly note: 'recorded' | { readonly failed: ApprovalErrorCode } | null }
export interface ListProblemModel { readonly kind: 'problem'; readonly id: string; readonly code: ApprovalErrorCode; readonly path: string }
export interface ListModel { readonly all: boolean; readonly rows: readonly ListRowModel[]; readonly problems: readonly ListProblemModel[];
  readonly hidden: number; readonly prefixLength: number }
export function renderList(m: ListModel): string;                     // C1 人類輸出，排序在此完成，結尾 LF

export type ExecutorView = { readonly kind: 'ok'; readonly name: string; readonly real: string; readonly sha256: string }
  | { readonly kind: 'unregistered'; readonly name: string } | { readonly kind: 'config_error'; readonly name: string; readonly code: string }
  | { readonly kind: 'uninspectable'; readonly name: string; readonly configured: string; readonly code: string } | { readonly kind: 'none' };
export type PayloadView = { readonly kind: 'bytes'; readonly bytes: Buffer; readonly observed_sha256: string }
  | { readonly kind: 'unreadable'; readonly code: ApprovalErrorCode } | { readonly kind: 'none' };
export interface ShowModel { readonly record: ApprovalRecord; readonly label: string; readonly payload: PayloadView;
  readonly executor: ExecutorView; readonly same: readonly { readonly id: string; readonly label: string }[]; readonly prefixLength: number }
export function renderShow(m: ShowModel, columns: number): { readonly stdout: string; readonly withheld: boolean; readonly mismatch: boolean };

export type AuditEvent = { readonly n: number; readonly state: ApprovalState } | { readonly n: number; readonly code: ApprovalErrorCode; readonly path: string };
export interface AuditModel { readonly record: ApprovalRecord; readonly events: readonly AuditEvent[]; readonly current: string }
export function renderAudit(m: AuditModel): string;
```

renderer 不讀檔、不讀時鐘、不 probe；所有外部文字在 renderer 內經 `sanitizeExternal`／`blockLines`（呼叫者不必先消毒，renderer 是唯一出口）。型別只 import 既有 `approval-types`、`approval-display`、`approval-error`。

S1 對既有檔案的唯一修改：`src/approval-request.ts:29` `function visible` → `export function visible`。

### S2 `src/approval-query.ts`（新，讀取；`--all` 經 `transition` 寫入）

```ts
export type PrefixResult = { readonly kind: 'ok'; readonly id: ApprovalId } | { readonly kind: 'invalid' }
  | { readonly kind: 'not_found' } | { readonly kind: 'ambiguous'; readonly count: number };
export function committedIdNames(home: string, io?: ApprovalIo): ApprovalId[];       // D2 候選集合；ENOENT → []；不安全根 throw ApprovalError
export function resolveIdPrefix(home: string, arg: string, io?: ApprovalIo): PrefixResult;

export interface QueryClock { readonly now: () => number }
export interface Entry { readonly id: ApprovalId; readonly current: Current; readonly display: Display | null } // null = executing 未探測（只在預設 list）
export interface Listing { readonly entries: readonly Entry[]; readonly problems: readonly ApprovalListProblem[] }
export function readEntries(home: string, o: { readonly nowMs: number; readonly probe: CreatorProbe; readonly probeExecuting: boolean },
  io?: ApprovalIo): Listing;                                                          // 唯讀
export type LazyOutcome = { readonly id: ApprovalId; readonly kind: 'committed' | 'unchanged' | 'contended' }
  | { readonly id: ApprovalId; readonly kind: 'failed'; readonly code: ApprovalErrorCode; readonly path: string };
export function recordLazyStates(home: string, ids: readonly ApprovalId[], o: { readonly clock: QueryClock;
  readonly probe: CreatorProbe; readonly actor: () => Actor; readonly store?: StoreDeps;
  readonly maxConflicts?: number /* 預設 DEFAULT_MAX_CONFLICTS = 32，src/approval-state.ts:16 */ }): LazyOutcome[];
export interface ListResult { readonly entries: readonly Entry[]; readonly problems: readonly ApprovalListProblem[];
  readonly lazy: readonly LazyOutcome[]; readonly hidden: number; readonly prefixLength: number }
export function listRequests(home: string, o: { readonly all: boolean; readonly clock: QueryClock; readonly probe: CreatorProbe;
  readonly actor: () => Actor; readonly store?: StoreDeps; readonly io?: ApprovalIo }): ListResult;  // D1/D7；all=false 時不呼叫 actor()
export function toListItem(e: Entry): ApprovalListItemV1;                            // display 非 null 時

export interface RequestView { readonly id: ApprovalId; readonly record: ApprovalRecord;
  readonly current: { readonly kind: 'ok'; readonly display: Display } | { readonly kind: 'corrupt'; readonly code: ApprovalErrorCode; readonly path: string };
  readonly payload: PayloadRead; readonly same: readonly { readonly id: ApprovalId; readonly display: Display | null; readonly reason: DeniedReason | null; readonly code: ApprovalErrorCode | null }[] }
export type PayloadRead = { readonly kind: 'bytes'; readonly bytes: Buffer; readonly observed_sha256: string }
  | { readonly kind: 'unreadable'; readonly code: ApprovalErrorCode; readonly path: string } | { readonly kind: 'none' };
export function readRequestView(home: string, id: ApprovalId, o: { readonly nowMs: number; readonly probe: CreatorProbe }, io?: ApprovalIo): RequestView; // record 讀不到 throw ApprovalError

export interface AuditData { readonly record: ApprovalRecord; readonly events: readonly AuditEvent[];
  readonly current: { readonly kind: 'ok'; readonly display: Display } | { readonly kind: 'corrupt'; readonly code: ApprovalErrorCode; readonly path: string } }
export function readAudit(home: string, id: ApprovalId, o: { readonly nowMs: number; readonly probe: CreatorProbe }, io?: ApprovalIo): AuditData;

export type ExecutorFacts = { readonly kind: 'ok'; readonly name: string; readonly real: string; readonly sha256: string }
  | { readonly kind: 'unregistered'; readonly name: string } | { readonly kind: 'config_error'; readonly name: string; readonly code: string }
  | { readonly kind: 'uninspectable'; readonly name: string; readonly configured: string; readonly code: string }
  | { readonly kind: 'none' };   // 與 S1 ExecutorView 結構相同；name 為 null（denied）→ 'none'
export function executorFacts(home: string, name: string | null, o: { readonly userHome: string; readonly io?: ApprovalIo;
  readonly fs?: Pick<typeof fs, 'realpathSync' | 'openSync' | 'fstatSync' | 'readSync' | 'closeSync'> }): ExecutorFacts;
```

- `AuditEvent` 在 S2 內自行宣告與 S1 同形（兩片並行、互不 import）；S3a 一律 import S1 的 `AuditEvent`（review F6），S2 的宣告保持結構相容。
- `readAudit` 對每個數字名用既有 `parseApprovalState` 的讀法（同 `readState`：cap 1 MiB、`readApprovalFile`、`n` 須等於檔名）；因 `readState` 為私有，S2 以相同四行自行實作，**不改** `approval-state.ts`。
- `executorFacts`：`loadExecutors(home, userHome)`（缺檔 → `unregistered`；throw → `config_error` + `ApprovalError.code`）；`realpathSync.native(command[0])`；以 `O_RDONLY|O_NOFOLLOW|O_NONBLOCK` 開真實路徑、`fstat` 須為一般檔（否則 `NOT_REGULAR`），64 KiB 分塊串流算 sha256，不設大小上限（執行檔可大於 payload 上限），讀完 close；任何 errno → `uninspectable` + `code`。不執行、不檢查 world-writable（那是 doctor/5b 的責任）。
- 預設 `ioGuard` 測試：`readEntries`、`readRequestView`、`readAudit`、`committedIdNames`、`resolveIdPrefix`、`executorFacts` 在注入「寫入即 throw」的 io/fs 下必須成功。

### S2 `src/approval-actor.ts`（新）

```ts
export interface ActorDeps { readonly platform: NodeJS.Platform; readonly pid: number; readonly isTTY: (fd: number) => boolean;
  readonly username: () => string; readonly uid: () => number | undefined; readonly pidStart: (pid: number) => string | undefined;
  readonly readlink: (p: string) => string; readonly fstatRdev: (fd: number) => number;
  readonly readdir: (dir: string) => string[]; readonly lstat: (p: string) => { isCharacterDevice(): boolean; rdev: number } }
export const defaultActorDeps: ActorDeps;
export function ttyName(fd: number, deps: ActorDeps): string | null;   // D6；非 TTY → null；找不到 → 'rdev:<n>'
export function actorIdentity(deps?: ActorDeps): Actor;
export function terminalIsInteractive(deps?: Pick<ActorDeps, 'isTTY'>): boolean; // isTTY(0) && isTTY(1)
```

### S3 `src/approvals-cli.ts`（新）與 `src/cli.ts`

```ts
export interface ApprovalsCliDeps { readonly home: string /* canonical */; readonly out: (text: string) => void; readonly err: (line: string) => void;
  readonly clock: QueryClock; readonly probe: CreatorProbe; readonly actorDeps: ActorDeps; readonly columns: number; readonly userHome: string;
  readonly store?: StoreDeps; readonly io?: ApprovalIo }
export function defaultApprovalsCliDeps(home: string): ApprovalsCliDeps;
export function approvalsList(o: { readonly all: boolean; readonly json: boolean }, d: ApprovalsCliDeps): number;   // 回傳結束碼
export function approvalsShow(arg: string, d: ApprovalsCliDeps): number;
export function approvalsAudit(arg: string, d: ApprovalsCliDeps): number;
export function approvalsReject(arg: string, o: { readonly reason?: string }, d: ApprovalsCliDeps): number;
```

handler 不呼叫 `process.exit`；`cli.ts` 的 action 只做 `process.exitCode = approvalsX(..., defaultApprovalsCliDeps(canonicalPath(home())))`，未預期的非 `ApprovalError` 例外沿用 `fail((e as Error).message)`。`cli.ts` 改寫為 `const approvals = program.command("approvals").description(...)`，既有 `collect` 掛到 `approvals.command("collect")`，字串與 action 逐字不變，再加 `list`（`--all`、`--json`）、`show <id>`、`audit <id>`、`reject <id>`（`--reason <text>`）。

## Slices / 實作切片

### S1 — sanitiser + screen/pager（node-engineer；可與 S2 並行）

**Allowed:** 新增 `src/approval-text.ts`、`src/approval-screen.ts`、`test/approval-text.test.ts`、`test/approval-screen.test.ts`；`src/approval-request.ts` 只加 `export`。**Must not touch:** S2 檔案、`src/cli.ts`、其他 approval 模組、schema、fixture、docs、dist、lockfile。

- [ ] 先寫下表 S1 named tests（red），再實作（green）。
- [ ] Acceptance：renderer 純函式；可還原性質測試通過；所有 C1–C3 精確字串在 S1 測試中以字面值斷言。
- [ ] Review 增補（F2–F4）：`sanitizeExternal strips ...` 加 U+2028/U+2029 → `⏎` 案例；新測試 `sanitizeExternal is linear on unterminated introducers`（64 KiB 的 `ESC ]` 與 64 KiB 的 `\x9d`，各 < 200 ms，且輸出不含 ESC/C1）；新測試 `uniquePrefixLength covers hidden and problem ids`（至少 8、跨 hidden 與 problem id 仍唯一）。
- [ ] Verify：`npx vitest run test/approval-text.test.ts test/approval-screen.test.ts test/approval-request.test.ts --configLoader runner`

### S2a — query reads（node-engineer；可與 S1 並行）（review F1 重切）

**Allowed:** 新增 `src/approval-query.ts`（只含 `committedIdNames`、`resolveIdPrefix`、`readEntries`、`readRequestView`、`readAudit`、`executorFacts` 與其型別）、`test/approval-query.test.ts`、`test/approval-store-fixture.ts`（`seedPending`、`seedDenied`、`seedState`、`snapshotTree`、`writeTrapIo`）。**Must not touch:** S1 檔案、`src/cli.ts`、stage 1–4 模組、schema、fixture、docs。

- [ ] 先寫 S2a named tests（red），再實作。含 review F2 新測試 `resolveIdPrefix and committedIdNames choose candidates by record.json`：損毀 `record.json` 仍是候選；無 `record.json` 的目錄不是；非 24-hex 名稱忽略；ENOENT → 空；`approvals/` 是 symlink → `UNSAFE_PATH`。
- [ ] Acceptance：唯讀函式在 trap io 下成功、樹快照不變；`read-only queries make no mutating io call`；`default list show and audit never record expired or unknown` 與 `corrupt highest or missing predecessor state ...` 的唯讀部分（`readEntries`／`readRequestView`／`readAudit`）。
- [ ] Verify：`npx vitest run test/approval-query.test.ts test/approval-state.test.ts test/approval-display.test.ts --configLoader runner`

### S2b — lazy writes + actor（node-engineer；S2a 合併後）

**Allowed:** 在 `src/approval-query.ts` **新增** `recordLazyStates`、`listRequests`、`toListItem`、`LazyOutcome`、`ListResult`（不改 S2a 已審查函式的行為）；新增 `src/approval-actor.ts`、`test/approval-query-lazy.test.ts`、`test/approval-query-race.test.ts`、`test/approval-actor.test.ts`；`test/approval-store-fixture.ts` 只可新增 helper。**Must not touch:** S1 檔案、`src/cli.ts`、stage 1–4 模組、schema、fixture、docs。

- [ ] 先寫 S2b named tests（red）：§4.5 表的 `list --all ...` 各列、`clock rollback ...`、`list --all leaves terminal ...`、併發與崩潰表的 S2 各列、`ttyName ...`、`actorIdentity ...`。
- [ ] Acceptance：`--all` 競態只有一個寫入者、fault 後重跑恰寫一次、contended 不算 problem、actor 不 spawn（注入 deps 計數）、`listRequests(all=false)` 不呼叫 `actor()`。
- [ ] Verify：`npx vitest run test/approval-query.test.ts test/approval-query-lazy.test.ts test/approval-query-race.test.ts test/approval-actor.test.ts test/approval-state.test.ts --configLoader runner`

### S3a — CLI read-only commands（node-engineer；S1、S2b 合併後）

**Allowed:** 新增 `src/approvals-cli.ts`（`ApprovalsCliDeps`、`defaultApprovalsCliDeps`、`approvalsList`、`approvalsShow`、`approvalsAudit`）、`test/approvals-cli.test.ts`；修改 `src/cli.ts`（只限 `approvals` 群組：改寫為變數、加 `list`/`show`/`audit`，`collect` 字串與 action 逐字不變）。**Must not touch:** S1/S2 模組行為、stage 1–4、schema、web、fixture、docs。

- [ ] 先寫 S3a named tests（red）：C1–C3 精確字串、`show`／`audit` 的 C0 字串（review F2）、`list show and audit print no control characters from external text`、`show audit and default list leave the home tree byte-identical`、`show works without executors.yaml ...`、`list --json prints the v1 envelope ...`、`show prints the three zones and the payload verbatim`、`corrupt state is marked in list show and audit ...` 的 list/show/audit 部分。web 測試只沿用 `test/approval-call-cli.test.ts:396-404` 的 `argv.toString()` 斷言，或不加（既有測試已涵蓋）（review F6）。
- [ ] Verify：`npx vitest run test/approvals-cli.test.ts test/approval-call-cli.test.ts --configLoader runner`（`approval-call-cli` 用 tsx 子行程，沙盒內可能 `listen EPERM`；列出原始錯誤，不宣稱 green）。

### S3b — reject（node-engineer；S3a 合併後）

**Allowed:** 在 `src/approvals-cli.ts` 新增 `approvalsReject`；`src/cli.ts` 只加 `reject <id>`（`--reason <text>`）；新增 `test/approvals-reject.test.ts`、`test/approvals-cli-process.test.ts`；延伸 `test/approval-compat.test.ts`（只新增 `it`）。**Must not touch:** S1/S2/S3a 已審查行為、stage 1–4、schema、web、fixture、docs。

- [ ] 先寫 S3b named tests（red）：C4、C5、§4.5 表 S3 的 reject 各列、併發與崩潰表 S3 各列、相容表、process 層。
- [ ] Acceptance：C4–C5 每個字串與結束碼有測試；compat 新增測試與既有 compat 全綠；`approvals collect` 既有測試不改且通過。
- [ ] Verify：`npx vitest run test/approvals-reject.test.ts test/approvals-cli.test.ts test/approvals-cli-process.test.ts test/approval-compat.test.ts --configLoader runner`（process 測試沙盒內可能 `listen EPERM`；列出原始錯誤）。

整合（lead 另一封 mail，不屬於任何 slice）：`npm run lint && npm run typecheck && npm test && npm run check:docs`。

## Test map / 測試對應

精確 test title；同一測試可含 table cases。時間一律注入（`clock.now`），probe 注入（`signal0`/`start`/`compare` 回固定值），actor deps 注入（計數 `pidStart` 與 `readdir` 呼叫），temp home 由 `makeEnv()`（`test/helpers.ts:17`）後 `fs.realpathSync`，不讀真實 `~/agent-lyceum-config`、不啟 claude/codex。record 用真 `publishRecord`、state 用真 `transition` 或 `publishExclusive` 寫入合法 JSON。

### §4.5 轉換表

| 列 | slice、test title、必斷言 |
|---|---|
| `pending` + `reject` → `rejected` | S3 `reject commits rejected for a pending request from a terminal`：`state/1.json` status rejected、reason、actor.tty 為注入名、`previous: 0`；stdout 精確；exit 0 |
| `reject` 對非 pending 拒絕 | S3 `reject refuses every non-pending state without writing`：denied、executing、unknown、executed、failed、rejected、expired、tampered 各一；精確 stderr（ALREADY_HANDLED／NOT_APPLICABLE）；state 目錄樹不變 |
| `pending` + `list --all`，`now > expires_at` → `expired` | S2 `list --all records expired only strictly after expires_at`：`now == expires_at` 無寫入；`+1ms` 恰一個 `expired`；重讀 display persisted = expired |
| `executing` + `list --all`，建立者已死 → `unknown` | S2 `list --all records unknown only for an executing request whose creator is dead`：missing_pid、start_mismatch、unverifiable_elapsed 寫入 `reason: creator_dead`；matching_start、unverifiable_grace 不寫 |
| 懶惰寫入只由 `list --all` | S2 `default list show and audit never record expired or unknown`：同一組逾期與死建立者資料，三個唯讀函式後 trap io 未觸發、樹快照相同 |
| 終態不再轉換 | S2 `list --all leaves terminal and unknown states unchanged`：terminal 與 persisted unknown 不呼叫 transition（spy），無新檔 |
| 最大 n 損毀 fail-closed | S2 `corrupt highest or missing predecessor state is a problem in every listing and refuses lazy writes`：最大 n 非 JSON、n-1 缺、`01.json` 別名；預設與 `--all` 皆有 problem、無新檔。S3 `corrupt state is marked in list show and audit and reject is refused`：C1 problem 列、C2 status 行與 stderr、C3 `#n corrupted`、C4 stderr，皆 exit 1 |
| 時鐘回撥 | S2 `clock rollback neither expires nor kills and keeps lazy writes off`：`now < created_at` pending 仍 pending、`now < executing time` 的 unverifiable 在寬限內；S3 `reject under clock rollback still rejects and records the earlier time` |

### §9 顯示、唯讀、web

| §9 bullet | slice、test title、必斷言 |
|---|---|
| 顯示：ESC、`\r`、Cf、偽造框線 | S1 `sanitizeExternal strips escape sequences C0 C1 and Cf and marks carriage returns`：CSI、8-bit CSI、OSC（BEL 與 ST 終止）、DCS、未終止 OSC（只刪引導）、`ESC ( B`、DEL、U+0085、U+202E、U+200B、U+FEFF、`\r\n`→`⏎\n`、TAB→空格、孤立代理→U+FFFD；冪等。S1 `forged box drawing in external text never starts a line`：`blockLines('│ fake\n└ end')` 每列以 `│ ` 開頭。S3 `list show and audit print no control characters from external text`：state 含 ESC/`\r`/Cf 的 stdout、stderr、detail、reason、conclusion，及含 ESC 的 problem 路徑；三命令 stdout+stderr 用 `/[\p{Cc}\p{Cf}]/u` 檢查（LF 除外）為無 |
| 顯示：payload 逐字、每行前綴 | S1 `payload rows reconstruct the exact bytes and every row is prefixed`：ASCII、CJK、emoji、TAB、空行、無結尾 LF；S3 `show prints the three zones and the payload verbatim`：C2 全文字面比對 |
| 分頁邊界 | S1 `paginatePayload cuts at most 4096 bytes on character boundaries`：0、1、4095、4096、4097、65536 位元組；S1 `a multi-byte character straddling the page boundary moves to the next page`：在 4095 起 3 位元組字元、4094 起 4 位元組 emoji；S1 `a line over 4096 bytes spans pages and wraps on character boundaries`：單行 10000 位元組 ASCII 與 CJK，續列 `┆ `，還原相等；S1 `wrap width follows columns with a 20 column floor` |
| `show`／`audit`／預設 `list` 嚴格唯讀 | S2 `read-only queries make no mutating io call`（trap io）；S3 `show audit and default list leave the home tree byte-identical`：`snapshotTree` 比對路徑、型態、位元組、mode、mtimeMs（含目錄）前後相同，含 pending、逾期、死建立者 executing、denied、損毀各一 |
| `show` 不寫狀態、無 executors.yaml 也可用 | S3 `show works without executors.yaml and marks the executor not registered` |
| web `COMMANDS` 不含 `approvals.*` | S3 `web console COMMANDS has no approvals.* entry for list show audit or reject`：`Object.keys(COMMANDS)` 無 `approvals.` 開頭；每個 `def.argv` 以空 body 呼叫（throw 視為無）不以 `approvals` 開頭；沿用 `test/approval-call-cli.test.ts:396-404` 的模式，不改該既有測試 |
| `list --json` 帶 `schema_version` | S3 `list --json prints the v1 envelope with only pending by default`：`JSON.parse` 後 `schema_version: 1`、只含計算 pending、problems 含損毀；`--all --json` 含全部、lazy 後 display persisted = computed |
| 核可者身分（reject） | S3 `reject refuses a non-TTY invocation and a wrong or ambiguous prefix without writing`：stdin 非 TTY、stdout 非 TTY、7 碼、大寫、25 碼、非 hex、未知、兩 id 共前綴；精確 stderr；樹不變。S2 `ttyName resolves a device name without spawning and falls back to rdev`；S2 `actorIdentity records user tty pid and pid_started from injected facts` |

### 併發與崩潰

| 情境 | slice、test title、必斷言 |
|---|---|
| 並行 `list --all` 寫同一請求 | S2 `concurrent list --all writers produce exactly one expired state`：注入 io 的 `linkSync` 在 A 連結前先跑完 B 的 `listRequests`（沿用 `test/approval-state.test.ts:82` 的 `hookedIo` 手法）；結果只有 `state/1.json`、一個 committed、一個 unchanged；B 先 A 後兩種順序 |
| 並行 `list --all` 寫同一 executing 為 unknown | S2 `concurrent list --all writers produce exactly one unknown state` |
| `reject` vs lazy expire | S3 `reject and lazy expiry race has one winner`：hook 讓 lazy 先贏 → reject stderr `already expired`；reject 先贏 → lazy unchanged；各只有一個 n=1 檔 |
| `reject` vs approve 事件 | S3 `reject and an approve transition race has one winner`：hook 內以 `transition()` + 合法 approve proof（同 `test/approval-state.test.ts:60` `proof()`）先寫 executing → reject stderr `only a pending request can be rejected (current: executing)`；反序 → approve unchanged ALREADY_HANDLED |
| `reject` vs `reject` | S3 `two rejects race and the second reports already rejected` |
| reject 發布中崩潰 | S3 `reject crash before link leaves pending and a rerun rejects`：`store.fault` 在 `temp_written`、`temp_synced` throw；之後無數字檔、`readCurrent` 為 pending、重跑 exit 0 恰一個 `1.json`。S3 `reject crash after link leaves rejected and a rerun reports it`：`linked`、`temp_removed`；`1.json` rejected，重跑 exit 1 `already rejected`，無 `2.json` |
| `list --all` 發布中崩潰 | S2 `lazy publication crash leaves the state and the next list --all records once`：四個 fault 點；前二者重跑恰寫一次，後二者重跑不再寫 |
| contended | S2 `list --all treats a contended write as no problem`：`recordLazyStates(..., { maxConflicts: 1 })`；hook 在本方 `linkSync` 前讓對手對**同一 id** 寫入 `state/1.json`（另一次 `recordLazyStates`，寫 `expired`）；本方 EEXIST 後次數用盡 → `kind: 'contended'`（不再重判）；外層結果無 problem、該列顯示重讀後的 `expired`、`state/` 只有 `1.json` |

### 相容（不重生 fixture）

| 情境 | slice、test title |
|---|---|
| 沒有 executors.yaml 的新命令 | S3（compat 檔新增）`approvals read-only commands create nothing without executors.yaml`：`makeEnv()` home，handler 跑 `list`、`list --json`、`list --all`、`show deadbeef`、`audit deadbeef`、`reject deadbeef`（非 TTY 與 TTY 各一）；精確輸出（`No pending approval requests.`、`{"schema_version":1,"requests":[],"problems":[]}`+LF、`No approval requests.`、C0 not_found ×3、C4 非 TTY 句）；`approvals/`、`requests/` 不存在；樹快照不變 |
| 既有 compat 不改 | `test/approval-compat.test.ts:62,130,209` 原樣通過；fixture 目錄 `git diff --stat test/fixtures` 為空 |
| process 層 | S3 `approvals help lists list show audit reject and collect`；`reject from a pipe is refused without writing`（tsx 子行程，stdin 非 TTY）；`list in an empty home prints the empty sentence and exits 0` |

上表 contended 列的 `maxConflicts` 選填欄位是 `recordLazyStates` 的新參數（S2 新函式，非既有簽名）；`reject` 的 handler 不暴露它。

**Test seams:** 時間 `clock.now`；PID `CreatorProbe`（`src/approval-liveness.ts:9-13`）；身分 `ActorDeps`；檔案 `ApprovalIo`（trap 與 hook）；崩潰 `StoreDeps.fault`；隨機 temp 名 `StoreDeps.token` 遞增計數；終端寬度 `columns`。process 測試只驗非 TTY 與 help，TTY 行為全在 in-process handler 測試（沙盒無 PTY，見 project memory `skill-sandbox-no-ps-pty`）。

## Documentation contract / docs-writer 同步更新

docs-writer 另收 lead task；node-engineer 不改雙語文案。每個新失敗路徑都有對應句；docs-reviewer 對照 C0–C5 精確字串。`docs/commands.md` 與 `docs/commands.zh-TW.md` 標題、連結成對（`npm run check:docs`）。

`docs/commands.md` / `docs/commands.zh-TW.md`：
- 新增同層 `## approvals list`、`## approvals show`、`## approvals audit`、`## approvals reject`（與既有 `## approvals collect` 並列），各含 **Usage**。
- 刪除／替換「`approvals list`, `show` and `approve` are not implemented」（`docs/commands.md:71,95` 與 zh-TW 對應處）為「`approve` is not implemented; `list`, `show`, `audit` and `reject` are described below.」；§`call` 中「The list screen is a later stage」改為指向 `approvals list`。
- list：「`approvals list` shows only requests that are pending and not past their expiry. It writes nothing and starts no process.」「`--all` lists every state. For a pending request past its expiry, or an executing request whose creator process is gone, it records `expired` or `unknown` and marks the row `[recorded now]`; when two commands race, exactly one records it.」「`--json` prints `{"schema_version":1,"requests":[...],"problems":[...]}`; it is independent of `status --json`.」「A row `corrupted (<CODE>)` or `unreadable (<CODE>)` is always listed, also without `--all`, and the command then exits `1`.」「Without `executors.yaml` or `approvals/`, it prints `No pending approval requests.` and creates nothing.」「`<k> more request(s) not pending; approvals list --all shows every state.`」
- show：「`approvals show <id>` is read-only: it never records expiry or a dead creator; it shows the computed state, for example `expired (not yet recorded)`.」三區描述（agent statement unverified／executor real path and sha256／complete payload）；「Every payload row starts with `│ `; a row that continues a wrapped or page-split line starts with `┆ `.」「Pages hold at most 4096 bytes of payload and are cut on character boundaries; all pages are printed in order.」「The payload is shown exactly as collected. If it or the summary fails the request allow-list it is withheld and the command exits `1`; do not approve such a request.」「`MISMATCH` means the payload changed after collection; the command exits `1`.」「The executor section needs `executors.yaml`; without it the executor shows `(not registered)` and the exit code is unchanged.」以及 C2 每個 stderr 句。
- audit：「`approvals audit <id>` is read-only and prints the facts in `record.json` and every `state/<n>.json` event in sequence order, with the actor (user, terminal, pid, start time).」「Executor output, reasons and conclusions are shown with control characters removed and `\r` shown as `⏎`.」損毀句。
- reject：「`approvals reject <id> [--reason <text>]` needs a terminal on stdin and stdout, and an id prefix of 8 to 24 lowercase hex characters that matches exactly one request.」「Only a pending request can be rejected; a request past its expiry that is not yet recorded can still be rejected.」「`rejected` is final.」「`--reason` is one line of at most 300 visible characters.」C4、C5 全部 stderr 句與結束碼；「If two commands change the same request at once, exactly one succeeds; the other reports the state it found.」
- Review 增補（F5、checklist 8）：reject／audit 段加「The terminal is recorded by name when one can be found, otherwise as `rdev:<n>`, which is a device number only. The terminal check (stdin and stdout are terminals) is an aid, not a security boundary; terminal name lookup has not been verified on a real Linux or macOS terminal.」；list 段加「On an error before listing (exit `1`), `--json` prints nothing on stdout; check the exit code before parsing.」
- 共用：C0 四句；「The id may be any unique prefix of at least 8 characters as printed by `approvals list`.」「These commands do not need `executors.yaml`; after removing it (rollback), use `approvals list` and `approvals reject` for requests still pending.」「The web console does not offer these commands.」Exit codes 節加一句「`approvals list`, `show`, `audit` and `reject` exit `0` or `1`」。

`docs/approval-store-api.md`：
- 標題改為 stages 1–5a；模組表新增 `text`、`screen`、`query`、`actor`，與 `approvals-cli`（模組名與上方簽名一致）。
- 替換「`approvals list` is not implemented」（`docs/approval-store-api.md:186-187`）：說明 `list --json` 已實作、serializer 由 `approvals-cli` 呼叫、problem 固定 hint 四句（D8）。
- 新節「Read-only commands and lazy writes (stage 5a, not releasable)」：D1、D7（只有 `list --all` 寫 `expired`／`unknown`，經 `transition`；`show`／`audit`／預設 list 不寫、不 probe 除非 executing）、D8 結束碼、D2 前綴與候選集合、D6 actor 與 `rdev:<n>` 後備、D3 消毒規則與適用欄位、`visible()` withheld、D5 分頁與還原規則（標明 stage 5b approve 重用）。
- 明說：「Not releasable: step 0 unverified」；Linux 與真實沙盒未驗證；`approve`、執行器、`resolve`、gc、回饋未實作。

## Spec vs code / 矛盾與歧義

1. **user-task 第 1 項 vs spec §4.6 末句（歧義，非程式碼矛盾）**：user-task「a request past `expires_at` or whose creator is dead is shown with a computed state ... and nothing is written」可讀成預設 `list` 也顯示；spec `docs/superpowers/specs/2026-11-13-approval-gate-design.md:228`「`list` 預設只列 `pending` 且未過期者」。採 D1（預設不列；計算標籤在 show/audit/`--all`），預設清單以尾行數量提示。需使用者確認時只改 S2 過濾與 S3 尾行。
2. **spec §4.5「最大 n 的狀態檔若無法解析」vs `readCurrent` 更嚴格**：spec `:189` 只說最大 n；程式 `src/approval-state.ts:74-77` 另要求 n-1 可讀、`:44` 別名檔名 fail-closed。不是衝突（程式更保守）；本計畫把三者都當「損毀」（D8），文件照程式寫。
3. **spec §4.6 消毒範圍 vs user-task／lead 範圍**：spec `:228` 只列「執行器的 stdout/stderr 與錯誤訊息」；user-task 第 5 項與 lead AC 加上 problem hints、reject reasons、manual conclusions。是擴充不是矛盾；D3 採較大範圍，payload/summary/檔名照 spec 不改寫。
4. **spec §4.6「完整瀏覽」頁大小 vs `max_payload_bytes`**：無矛盾；記錄 `src/approval-json.ts:58` 的 `payload_bytes.max(65536)` 與分頁上限一致（65536 → 16 頁）。
5. **spec §3「輸入請求 id 前 8 碼確認」vs `decideTransition` 的布林 `prefix_confirmed`**（`src/approval-transition.ts:20,44`）：程式只收布林，確認方式由 CLI 定。採 D2（參數本身即確認），非矛盾。
6. **docs 與現況**：`docs/approval-store-api.md:186-187` 與 `docs/commands.md:71,95` 寫「list/show not implemented」，本階段後過時，列入 docs 契約。

沒有發現需要改 schema 或 stage 1–4 簽名的矛盾。

## Dimension coverage

| Dimension | Handling |
|---|---|
| Compatibility & Format / 相容與格式 | 不改 record/state/list v1/executors schema；只寫既有 `rejected`/`expired`/`unknown` 狀態（舊 binary 的 `parseApprovalState` 已認得，`src/approval-schema.ts:156-160`）。舊 binary 遇新子命令：commander 未知命令錯誤（現況 `approvals` 只有 `collect`）。help 文字改變、無 fixture。compat 新增測試不重生 fixture |
| File & Process Safety / 檔案與行程安全 | 寫入只有 `transition`→`publishExclusive`（O_EXCL temp 0400、fsync、`linkSync`，`src/approval-io.ts:165-233`）；讀取 `readApprovalFile`（nofollow、nonblock、ancestor lstat、cap）；執行檔 sha256 用 O_NOFOLLOW|O_NONBLOCK 真實路徑；canonical home。終端注入以 D3 消毒 + 前綴防範；payload/summary 以 `visible()` 檢查後才顯示。不 spawn 執行器；`ps` 只經既有 `pidStart`。TTY/前綴只是輔助防線（spec §3），強制力仍靠第 0 步 (a)：同 UID 的 agent 若能取得 TTY 就能 reject，這不是本片能防的（記為限制） |
| Concurrency & Recovery / 並發與復原 | 無鎖；序號檔 + link 獨佔（D7）；EEXIST 重讀重判；fault 四點的崩潰：link 前 → 仍 pending、可重跑；link 後 → 已提交、重跑報 already；temp 殘檔不影響讀取（`highestN` 忽略）。Ctrl-C 在同步路徑中等同 link 前或後兩種之一。無郵件、無 run、無 resume 影響 |
| Platform & Operability / 平台與可維運 | macOS/Linux；TTY 名稱 Linux `/proc/self/fd/0`、其他掃 `/dev`，後備 `rdev:`；Windows 不新增支援。無新依賴。不在 wake loop 內，無效能影響；`list` O(請求數)，數量受 `max_total_pending` 與 retention 限制。每個錯誤句含 id、CODE 與檔案路徑 |
| Testability & Maintainability / 可測試與可維護 | S1 純函式；S2 以注入 io/probe/clock/actor 測；S3 handler 回結束碼不 exit，in-process 測 TTY 路徑；不讀真實 home、不啟 runtime；重用既有 transition/display/json，不新抽象 |
| Observability & Diagnosability / 可觀測與可診斷 | `audit` 是事件檢視器；`--all` 的寫入以 `[recorded now]` 可見；problem 永遠列出且 exit 1（D8）；錯誤句指名檔案與 CODE；不寫 `log.jsonl`、`state.json`、mail 或 violations（這些命令不在 run 內）；`status --json` 不變 |
| Terminal safety / 終端安全（本任務新增） | 外部文字消毒（D3）、行首前綴與 `┆ ` 續列（D5）、payload 不改寫但不通過白名單則 withheld；使用者參數回顯也消毒與截斷 |

## Open items

| Item | Owner | Default |
|---|---|---|
| 本計畫的獨立審查 | lead → cli-architect-reviewer | 未核准前不實作 |
| D1 預設 list 範圍是否符合使用者原意（Spec vs code 1） | lead → 使用者（可選） | 採 D1；改動只影響 S2 過濾與 S3 尾行 |
| TAB 在外部文字中換成空格而非刪除（D3 步驟 4） | lead | 採換空格；reviewer 若要求 spec 字面，改為刪除，只動 S1 一行與其測試 |
| 使用者 clean worktree 全套驗證、Linux、真實 TTY 上的 `reject` | lead / 使用者 | 本任務不宣稱；沙盒無 PTY，TTY 路徑只有注入測試 |
| 實作發現 spec/code 真矛盾或須改 stage 1–4 簽名/schema/fixture | node-engineer → lead → 使用者 | 停止該片 |

沒有未決的實作產品選擇；上表是審查與驗證關卡。

**設計審查結果（cli-architect-reviewer，mail 6a43dad2）與 lead 裁定：** F1（major，切片過大）採納：S2→S2a/S2b、S3→S3a/S3b（見 Slices）。F2–F6（minor/nit）全部併入：F2 前綴解析與 `uniquePrefixLength` 測試、`show`／`audit` C0 字串；F3 U+2028/2029→`⏎`（D3 步驟 7）、`record.executor`／`source_key.filename` 經消毒器；F4 線性時間消毒與 64 KiB 計時測試；F5 `rdev:<n>` 與 TTY 檢查的文件誠實句；F6 寬度註解、`AuditEvent` 由 S1 匯出、web 測試不另寫或只沿用 `argv.toString()`。D1、D2、TAB→空格、`export visible`、D8 exit 1 維持（reviewer 同意或未重開）。

## Verification / 設計檢查

- 逐讀 user-task、spec §3、§4.5、§4.6、§4.8、§4.10、§5、§6、§9、§10、§11、`docs/approval-store-api.md`、stage 4 plan，及「Current evidence」表列出的每個原始碼位置（皆為本次讀到的行號）。
- 每個 §4.5 中涉及 reject/expired/lazy unknown 的列、每個 §9 顯示／唯讀／web bullet 都對應到 named test；每個 C0–C5 錯誤句都有 docs 句。
- 沒有執行產品測試；本文件不是測試通過聲明。

## Risks / Decisions made for the lead

- D1：預設 list 不列逾期未記錄者（拒絕：預設也列）。依 spec §4.6；與 user-task 文字可能不一致，已列 Spec vs code 1。
- D2：前綴即確認、無 y/N（拒絕：y/N 提示）；候選集合以 `record.json` 存在為準（拒絕：用 `listCommittedIds`，會讓損毀 record 無法 show）；大寫前綴拒絕而不轉小寫（拒絕：自動轉換，避免 id 規則有兩種寫法）。
- D3：TAB → 空格（拒絕：照 spec 字面刪除）；未終止 OSC 只刪引導（拒絕：刪到字串尾）；payload/summary 不通過白名單時 withheld 並 exit 1（拒絕：照印或消毒後印，前者可注入終端、後者違反「顯示即內容」）。
- D5：續列與跨頁續行用 `┆ `（拒絕：一律 `│ `）；寬度用固定寬字表與 80 欄預設（拒絕：wcwidth 依賴、依終端自動換行）；不偏好在 LF 切頁（拒絕：LF 優先）。
- D6：TTY 名稱掃 `/dev`、後備 `rdev:<n>`（拒絕：spawn `tty`、讀環境變數、找不到就拒絕）；actor 只在要寫入時計算，避免唯讀命令 spawn `ps`。
- D7：`contended` 與 `unchanged` 不算 problem（拒絕：當錯誤）；lazy 失敗不終止整個 `--all`。
- D8：有任何 problem/損毀/withheld/MISMATCH 就 exit 1 且 stdout 完整（拒絕：exit 0 與「不輸出」兩種）。對以 exit code 判斷的腳本是行為選擇，`--json` 消費者需容忍 exit 1 時 stdout 仍為合法 JSON。
- 逾期但未記錄的 pending 仍可 reject、時鐘回撥時仍可 reject（依 spec §4.5 該列「—」與 `decideTransition` 現況；拒絕：另加檢查，會改 stage 1 行為）。
- 執行器區的問題不改 `show` 結束碼（拒絕：exit 1；5a 不執行，5b approve 會再檢查）。執行檔 sha256 不設大小上限（拒絕：沿用 payload 上限，執行檔常大於 64 KiB）。
- `recordLazyStates` 新增選填 `maxConflicts` 只為測試 contended（新函式參數，非既有簽名）。
- `readAudit` 複製 `readState` 的四行讀法而不匯出私有函式（拒絕：改 `approval-state.ts`，屬 stage 1 檔案）；`visible` 則選擇加 `export`（lead D3 明確要求重用白名單；只加關鍵字、行為不變）。若 reviewer 認為 `export` 也算禁止的 stage 3 變更，替代方案是在 `approval-text.ts` 複製 `HIDDEN` 正規式並加一個比對兩者的等價測試。
- 同 UID 程序若取得一個 TTY（例如 `script(1)`）就能通過 reject 的 TTY 檢查；spec §3 已將 TTY 定為輔助防線，本片不加強；真正屏障是第 0 步 (a)（未在本任務驗證）。
- 信任本次讀到的 repo 程式碼與 spec 行號；未在真實終端、Linux 或真實沙盒驗證任何行為。
