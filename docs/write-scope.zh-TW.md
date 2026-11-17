# 寫入範圍

預設規則（repo 內其餘部分不受限制）：

| 目標 | 規則 |
|---|---|
| 自己的記憶資料夾、自己的 `outbox/` | 可寫入 |
| 自己的 `agents/<自己>/`，含在那裡建立的專案 `AGENT.md` | 該成員可寫。這個檔在下一次執行會成為這個專案的人設，並取代全域那份。全域檔仍唯讀 |
| `shared/common/`（`COMMON.md`、`records/`） | lead 可寫；其他 agent 唯讀 |
| 別人的 `AGENT.md`、全域 `AGENT.md`、repo 的 `CLAUDE.md`/`AGENTS.md` | 唯讀；lead（`can_edit_agent_md`）可編輯 |
| run 的交接筆記 `task-memory/<run-id>/_shared/` | lead 可寫；其他 agent 唯讀 |
| 其他 agent 的記憶／inbox／outbox、`runs/`、設定檔 | 不可寫入 |

由於沒有單一機制是完整的，防護採分層設計：

- **Claude Code**：每次執行帶入 `--settings`，內含 `Edit(...)` 規則，**加上** OS 沙箱（`allowWrite`/`denyWrite`、`allowUnsandboxedCommands: false`）。沒有沙箱時，`python -c` 之類的做法能繞過 Edit 規則，因此 `os` 等級必須啟用沙箱。
- **Codex**：`-s workspace-write` 搭配 `-c sandbox_workspace_write.writable_roots=[...]`（由 OS 強制）。Codex 無法禁止 repo 內的單一檔案，所以 repo 的 `CLAUDE.md`/`AGENTS.md` 只能靠**事後偵測**保護。
- **Cursor**：以 `agent` 搭配 `--sandbox enabled`，並在每次 wake 的 `workDir` 寫入經 `CURSOR_CONFIG_DIR` 讀取的 `cli-config.json`（`permissions.allow`／`deny` **只**來自 write policy——**不會**合併使用者自己的 `permissions.allow`，因此家目錄裡的 `Shell(*)` 無法放寬 agent）。這是 **tool-rules** 層級，不是 Claude／Codex 那種 OS 路徑級 `denyWrite`；repo 的 `CLAUDE.md`／`AGENTS.md` 與 Codex 一樣依賴**事後偵測**。`auth.json` 會從你的 Cursor 設定目錄以 symlink（失敗時改複製）放進以 run 為範圍的 `workDir`，讓登入在 `CURSOR_CONFIG_DIR` 覆寫後仍可用；wake 結束後不需要它繼續留在那裡。`--workspace` 之外的可寫路徑（記憶、outbox）也會以 `--add-dir` 傳入。`resume` 傳入已存的 `session_id`；Cursor 的 session 可能以設定目錄（`CURSOR_CONFIG_DIR` 即每次 run 的 `workDir`）為範圍，所以跨 run 的 resume **尚未驗證**。
- **所有 runtime**：執行前會對受保護檔案做雜湊；每次喚醒後，未經授權的變更會被還原、記錄，並通報 lead；被寫入的內容會先留存在 `runs/<run-id>/violations/`。

**guard 無法歸屬的變更。** `COMMON.md`、紀錄目錄 `shared/common/records/` 與團隊的 `AGENT.md` 由專案的所有 run 共用。若一批喚醒中沒有任何 agent 可編輯某個這類檔案，而同專案的另一個 run 在該批開始或結束時仍存活（它的 run lock 被存活的行程持有），這個檔案的變更就無法歸屬到本 run。此時 guard 不還原、不在 `violations/` 留副本、也不寄信給 lead；該變更成為新的基準，run 日誌會記一筆 `protected-change-unattributed` 事件（另印一行主控台訊息）。原因：另一個 run 的 lead 本來就會合法編輯這些檔案，還原它們只會白白喚醒本 run 的 lead。這只略過 guard 無法歸屬的部分：本 run 自己的 agent 在該時段內的違規也不會被還原，那時只剩上述 runtime／OS 沙箱擋得住。每個 run 專屬的檔案（run 的交接筆記、repo 的 `CLAUDE.md`/`AGENTS.md`），以及沒有其他 run 存活時的任何變更，仍照原樣還原並通報。見[同時多個 run](how-it-works.zh-TW.md#同時執行多個-task)。

`doctor` 與 `run` 會依類別（`os`、`tool-rules`、`post-hoc`、`prompt-only`）印出每個 agent 的防護等級，以及它能寫入 repo 之外的哪些路徑。設定 `dispatcher.strict: true` 時，除非記憶、`AGENT.md`、其他 agent 的 context 與（非 lead 的 agent 的）交接筆記都由 OS 強制保護，否則拒絕執行。

agent worktree 內的 git:agent 能寫它 worktree 的 `.git` 指標檔與私有 git 目錄,可能讓 git 去讀 agent 埋的設定或 hook。因此 dispatcher 對 agent worktree 的每一次 git 呼叫,都釘住 worktree 建立當下記錄的 git dir、common dir 與 work tree,關閉 hook、fsmonitor、external diff 與 textconv,並拒絕使用 git 檔案被改向或連到別處、HEAD 不是它自己的分支、或內含巢狀 repository 的 worktree。Claude 另外不得寫那幾個指標檔(`denyWrite`);Codex 無法禁止單一檔案,只靠釘住。殘留風險列在 [spec 15](specs/15-worktree-git-isolation.md#156-殘留風險)。這**不**表示 dispatcher 絕不會執行 agent 埋下的程式碼。使用 `reftable` ref 後端的 repository 在 worktree 模式下會被拒絕。

已知缺口：Claude Code 內建的 Edit/Write 工具不在沙箱內（由 `Edit` 規則涵蓋）；Codex 的 MCP 工具與 hooks 在其沙箱之外執行；`--dangerously-bypass-approvals-and-sandbox` / `danger-full-access` 會停用所有防護。啟用 `can_edit_agent_md` 時，Codex lead 的可寫根目錄會擴大到整個 agent 目錄。

## Sandbox 放寬

agent 的 `sandbox`（`write`、`network`、`local_binding`、`unix_sockets`；欄位說明見 [設定](configuration.zh-TW.md#sandbox-放寬)，設計見 [spec 25](specs/25-sandbox-allowances.md)）只在有設定時，才只對該 agent 放寬 OS sandbox。這已在 0.28.0 實作；各鍵在真實喚醒中的端到端效果**未驗證**。

- **`write`** 把目錄加進該 agent 的寫入範圍，就是給 Claude `Edit` 規則、`allowWrite`、`--add-dir`、給 Codex `writable_roots`、以及給 Cursor `cli-config.json` 內 `Write(...)` 規則（`--workspace` 之外的路徑另加 `--add-dir`）的同一份清單。受保護路徑永遠不能加，例如：設定資料夾或 repo 內的任何位置、所有 `AGENT.md`、記憶資料夾、inbox 與 outbox、`COMMON.md`、紀錄資料夾、該 run 的資料、其他 agent 的 worktree 與 git 目錄、git common dir、worktrees 根目錄、repo 的 `CLAUDE.md`／`AGENTS.md`、`~/.claude`、`~/.codex`，以及它們的祖先。完整清單見[設定](configuration.zh-TW.md#sandbox-放寬)；被拒絕的 invocation 會記為 `sandbox-refused`，不重試。
- **`unix_sockets`** 允許所列路徑下的 Unix socket **bind 與 connect**，不只是測試裡的 listen。該資料夾內的服務都連得到，所以不要把 Docker、ssh-agent 之類的 socket 放進去。只有 Claude Code 有作用；Codex 與 Cursor 什麼都不會得到，`doctor` 會警告。
- **`local_binding`**（只有 Claude Code）允許在**任何本機 IP**（不只 loopback）bind 與接受連入連線，以及連出到 localhost 上的服務。它不是「只在 localhost 提供服務」。依 Claude Code 文件，它在 Linux 上無效果（[sandboxing](https://code.claude.com/docs/en/sandboxing)）。它不涵蓋 Unix socket。
- **`network`**：Claude Code 逐網域；Codex 全有全無（列任何網域就開放所有主機）；Cursor **未套用**（目前不會送出任何網路設定，所以什麼都不會開放；`doctor` 顯示「not applied by cursor」）。
- **Cursor 上的 `allow_web`**：`allow_web: fetch` 會加入 `WebFetch(*)` allow 規則；`none` 或未設則 deny。`allow_web: search` 目前沒有對應的 Cursor permission token，`WebFetch` 仍會被拒絕，除非改設 `fetch`（見[網路存取](web-access.zh-TW.md)）。
- **不變：** `allowUnsandboxedCommands` 維持 `false`，Codex 維持 `workspace-write`，沒有任何鍵能讓任何 agent（含 lead）在 sandbox 外執行。非 lead 的 agent 永遠不會在 sandbox 外執行。（lead 的 `done` 被接受且要求時，推分支與開 PR 的是 dispatcher，不是 agent。）
- **是寫入範圍，不是讀取隔離：** 這些鍵放寬的是 agent 可寫入或可連線的範圍，不限制讀取，也不會讓某個 agent 無法讀其他 agent 的記憶。
- **沒有 OS sandbox：** Claude 的 `write` 只擴大 `Edit` 工具規則（Bash 可繞過），其他鍵無作用；Codex 只靠提示。路徑在每次 invocation 前檢查，但檢查與 spawn 之間被換掉的路徑無法防禦；邊界是 OS sandbox。

**會啟動子行程的測試。** 在 Claude 的 sandbox 下，`tsx` 子行程開不了 IPC socket 時 `npm test` 會失敗（`listen EPERM .../tsx-<uid>/*.pipe`）；診斷見 [Sandbox 阻擋](sandbox-blocks.md)。`unix_sockets: [<你的 $TMPDIR>/tsx-<uid>]`（請自行解出 `$TMPDIR`，不會自動展開）是預期的修法，但端到端**未驗證**，且有 Claude Code 2.1.89 的回報指出限定路徑的 Unix 放行只涵蓋 connect（[claude-code#41817](https://github.com/anthropics/claude-code/issues/41817)）。已知的替代做法仍是用 `NODE_OPTIONS="--import stub.mjs"` 的 stub，讓 `*.pipe` 路徑的 `net.Server.listen` 變成 no-op。

## 核准閘門登錄的 agent（階段 2b-1，尚非可運作的核准閘門）

這是核准閘門（[store API](approval-store-api.md)、[設計](superpowers/specs/2026-11-13-approval-gate-design.md)）的第一部分，只加固「已登錄」agent 的啟動方式。目前 agent 還不能提出核准請求，也沒有人能核准。

- **預設關閉。** 沒有 `<home>/executors.yaml`，或所有 `allow` 清單皆為空時，沒有 agent 被登錄，參數、`--settings`、環境變數與寫入範圍都不變（`src/approval-runtime.ts:21`；`src/adapters/env.ts:11`）。
- **誰被登錄。** 角色列在某個 executor 的 `allow`（針對該專案或 `call`）的 agent（`src/approval-enrollment.ts:12-14`）。`run`、`resume`、`run --agent`、`call` 在檔案存在時載入它（`src/config.ts:166`、`src/call.ts:56`）。fallback 與 tier 候選都沿用該 agent 的登錄（`src/fallback.ts:53-55` 以 `...agent` 複製 agent）。
- **`executors.yaml` 無法讀取。** 檔案存在但讀不到或解析失敗時，`run`、`resume`、`run --agent`、`call`、`tidy`（`tidy --dry-run` 與 `--undo` 除外）會在啟動任何 agent 前停止，錯誤訊息指出檔名與固定的原因文字（`src/approval-runtime.ts:56-63`；`src/cli.ts:272,349,652`；`src/call.ts:57`）。原因不會引用檔案內容。`status`、`doctor`、`clear`、`project` 不會拒絕啟動；`doctor` 會載入此檔並回報錯誤（`src/doctor-approval.ts:33-41`）。
- **Claude，僅限已登錄**（`src/adapters/claude.ts`）：
  - `--strict-mcp-config` 搭配空的 MCP 設定，使用者 MCP 與專案 `.mcp.json` 都不載入（`:14,100`）。
  - `--setting-sources user`，專案的 `.claude/settings*.json` 不載入（`:12,100`）。
  - `--settings` 內加入 `sandbox.failIfUnavailable: true`，與 `enabled`、`allowUnsandboxedCommands: false` 並列（`:63`）。hook 仍維持停用（`disableAllHooks`）。
  - 自帶寫入政策的喚醒（如 tidy）與 solo/`call` 喚醒同樣適用，因為這寫在 invocation 建構裡，而不是 `invokeWithSandboxChecks`（`:35-37,76-77`）。
- **環境變數，僅限已登錄，兩種 runtime：** 只有 `PATH`、`HOME`、`LANG`、`TERM`、`TMPDIR`、`USER`，而且只含有設定的那些。因此沒有 `AGENT_LYCEUM_AGENT`（`src/adapters/env.ts:4,10-14`）。macOS 登入需要 `USER`（spec 第 8 節）。其他 agent 保持完整環境。
- **寫入禁止，僅限已登錄**（`src/approval-policy.ts:21-30`、`src/policy.ts:229-230`）：`approvals/`、`executors.yaml`、每個 executor 的 `command[0]`、專案與該 agent worktree 的 `.claude/settings.json`、`.claude/settings.local.json`，以及每個*其他* slot 的請求目錄，逐項列出（不會整個禁止 `requests/`，也不含該 agent 自己的 slot）。每一項都先照原樣輸出，若 canonical 形式不同則再輸出一次，所以以 symlink 指向的 executor command 也會以真實目標被禁止（`src/approval-policy.ts:22-34`）。
- **請求目錄不安全時喚醒失敗。** 列舉請求目錄時遇到 symlink、非預期項目或超過掃描上限，已登錄的喚醒會失敗，而不是帶著不完整的清單執行（`src/approval-policy.ts:48-98,129-133`；`src/adapters/claude.ts:76-77`）。
- **Codex 被拒絕：** 已登錄 agent 不能用 Codex（含作為 fallback runtime），在 Codex invocation 寫入任何檔案或啟動 Codex 之前就拒絕（`src/adapters/codex.ts:63-66`）；對 `call` 而言，該 call 的 log、`task.md` 與 memory 資料夾此時已建立，失敗的 `result.md` 仍會寫入（`src/call.ts:165-167,216`）。`doctor` 已將此列為錯誤。

**已知限制：** 即使用 `--setting-sources user`，使用者層級的 `~/.claude/settings.json` 仍會套用到已登錄的 agent；對此的檢查（spec 第 3 節前提 4 (ii)）尚未實作。`doctor` 可能印出無效 `executors.yaml` 的欄位名稱（`src/approval-executors.ts:60`、`src/doctor-approval.ts:40`）。

**階段 2b-1 尚未實作：** 每次喚醒重新檢查登錄並拒絕喚醒某個 slot、`status` 的原因顯示、`proposals/` 寫入權限、收集請求、核准 CLI、executor 執行器。階段 3 加入請求收走：見[核准請求收走](#核准請求收走階段-3非可發布)。真實 Claude CLI 是否接受新旗標、真實 sandbox 的效果、Linux 皆**未驗證**；macOS 第 0 步的量測見 spec 第 8 節。

## 核准請求收走（階段 3，非可發布）

**非可發布：第 0 步未驗證**（English: not releasable, step 0 unverified）。下列三項**未驗證**，並阻擋發布：F3（使用者設定層：`--setting-sources user` 仍會對已登錄的 agent 載入 `~/.claude/settings.json`，`src/adapters/claude.ts:13`）、Linux、真實 OS sandbox 的強制效果。以下只描述程式實際做的事，不是安全的證據。細節與 API 見[核准儲存 API](approval-store-api.md#request-collection-stage-3-not-releasable)（英文）。

### 請求檔

- **位置。** 已登錄的 agent 把純文字請求寫進自己 slot 的 `proposals/`：`<home>/requests/projects/<project>/<run-id>/<slot>/proposals/`（`src/approval-paths.ts:57,62`）。該目錄多給一個可寫目錄，路徑寫在 system 與 user prompt（`src/prompt.ts` 的 `approvalRequestsBlock`）。 <!-- S3-dependent -->
- **誰拿得到。** 只有已登錄 agent 的 claim wake：第一次呼叫、每次重試與每個 fallback，含 solo。lead、tidy、verify、format、`call` 的 wake 一律沒有該目錄、沒有授權、prompt 也沒有相關文字。 <!-- S3-dependent -->
- **檔名。** `^(?!\.)[A-Za-z0-9._-]{1,64}\.req$`（`src/approval-id.ts:19`）。其他檔名被忽略。
- **內容。** 標頭、一個空行、payload。標頭最多兩行：`executor: <名稱>`（必填，須為已註冊的 executor）與 `summary: <文字>`（選填，最多 300 個碼點），含空行最多 2048 bytes。payload 受該 executor 的 `max_payload_bytes` 限制（預設 4096、上限 65536）；超過 67584 bytes 的檔案在解析前就被拒。整個檔案必須是 UTF-8 文字，除 LF 與 TAB 外不得有控制字元，不得有格式、分隔或不可見字元（允許 U+3000）；絕不清理內容，壞檔只會被記為 denied（`src/approval-request.ts:9-70`、`src/approval-executors.ts:32-34`）。
- **不是指令。** 收走的請求只是存起來等人審核；agent 寫了檔並不會執行任何東西。

### dispatcher 做什麼

- **收走。** wake 的輸出路由之後，每個已登錄 slot 的 `proposals/` 整個搬到 `collected/<seq>/`，原處換成新的空目錄；其中的請求成為 `<home>/approvals/` 下的記錄。序號只增不減（高水位檔 `collected.seq`）；空目錄不會被搬，所以不佔序號。`resume` 會收走被中斷的 run 遺留的內容。 <!-- S3-dependent -->
- **記錄的提交點。** 請求在其 `record.json` 被 link 到位時才算存在，且不會被覆寫。`collected/<seq>.done` 最後才寫，所以在它之前崩潰只會重做；同一請求得到同一個 id（`src/approval-collect.ts:20-26`）。
- **失敗或取消的 attempt。** 在該 attempt 標為結束之前，slot 的 `proposals/` 先搬到 `parked/<attempt-id>/`。被 park 的請求不會被收走，也不會成為重做草稿（`src/approval-rotation.ts` 的 `Park`；spec 4.4）；agent 必須重新提出。若無法移開，該 slot 在這個 run 內不再被呼叫（run 以 `agent_failed` 結束），殘留物在下次 `resume` 時被 park。 <!-- S3-dependent -->
- **崩潰後的 resume。** `resume` 先 park 已開始的 attempt 的目錄再標為失敗；對剛轉為 `abandoned` 的 claim，先 park 再存該狀態。這一步失敗的 slot 維持原狀、不被喚醒。 <!-- S3-dependent -->
- **`full_writable`。** 記錄的 `origin.full_writable` 是*收走那一刻* slot 擁有的可寫路徑集合。崩潰後由 resume 收走時，記的是較晚那次收走的授權，不是原 wake 的。它只供顯示，不拿來比對。 <!-- S3-dependent -->
- **拒收與配額。** 超限、格式錯誤或不被允許的請求成為 `denied` 記錄，原因為固定代碼（`bad_content`、`bad_header`、`bad_executor`、`too_large`、`not_allowed`、`quota`、`not_regular`、`scan_limit`）。每個 project（或 call）與 role 有一個小計數檔統計被拒請求；計數低於 100 時每筆仍保留完整記錄，之後只計數。計數是近似值（讀、加一、重寫，跨 pass 無鎖）。待處理配額（每個 executor 的 `max_pending`、`max_total_pending`）是軟限制：每個 slot pass 只計一次，不同 slot 的 pass 可能一起超過。每個目錄最多讀 `max_scan_entries`（預設 200）個檔，最舊的先；其餘合計成一筆 `scan_limit` 記錄（`src/approval-collect.ts:61,320-385`）。

### 操作者處置

每個收走問題都以 `approval_collect` 寫入 `log.jsonl`，欄位固定（`slot`、`op`、`class`，另有選填的 `seq`、`id`、`count`）；不記錄路徑、錯誤文字、檔名或 payload（`src/approval-collect.ts:34-38`）。該 slot 在修好之前不被喚醒，其他 slot 照常。人類可讀的 `status` 為被略過的 slot 顯示固定原因（目前是「request directory is unsafe」或「earlier approval output is waiting」，`src/approval-wake-gate.ts:59-60`；階段 3 計畫會改寫前者並加入收走計數，建好之前此處不描述）。

| `class` | 意思 | 處置 |
|---|---|---|
| `held` | `<slot>/.coord` 已存在：別的 run 持有該 slot，或崩潰遺留。永不接管 | 停掉該專案**所有** run，用 `agent-lyceum status` 確認沒有存活的 run（也沒有 `requests gc`；它尚不存在），再手動移除殘留的 `.coord` 目錄 |
| `not_directory`、`symlink` | `proposals/`、`collected/` 或上層是連結、檔案或其他非目錄 | 改回普通目錄；不要跟隨連結 |
| `missing` | 記錄型別有宣告，但此版 `src/approval-collect.ts` 沒有任何路徑回傳它（缺少的 `proposals/` 會直接重建） | 無須處置 |
| `corrupt` | `collected.seq`、被拒計數或記錄無法解析 | 手動修復或還原該檔；在那之前該 slot 持續被擋 |
| `unsupported` | 檔案系統不支援 hard link（link 時 `ENOTSUP`、`EOPNOTSUPP`、`EXDEV`、`ENOSYS`、`EPERM`） | 設定目錄改用支援 hard link 的檔案系統 |
| `permission` | 其他呼叫出現 `EACCES` 或 `EPERM` | 修正 approval home 的擁有者與權限 |
| `race` | 檔案或目錄在讀取期間改變或消失 | 下個 pass 重試；若反覆發生，找出是誰在改動該目錄 |
| `mismatch` | 同一請求已存的記錄 payload 不同 | 不要編輯；保留檔案並回報 |
| `budget` | 見下 | 見下 |
| `cancelled` | run 在收走此 slot 之前被取消 | `resume` |
| `io` | 其他錯誤 | 檢查磁碟與權限後 `resume` |

**工作預算。** 一次 pass 對一個 slot 最多花 65536 單位：每次檔案系統呼叫一單位、每個目錄項一單位（`SCAN_WORK_BUDGET`，`src/approval-budget.ts:19`）。一個合法的檔案花目錄項加一次 `lstat`；檔名不合法的只花一單位、不 stat。溢出時 pass 立即停止：不寫 `.done`、不寫 `scan_limit` 記錄、不刪不搬任何東西；已發布的記錄保留，下次直接沿用。該 slot 不被喚醒（`RESIDUAL_OUTPUT`；若是在計算 store 既有記錄時溢出則為 `UNDETERMINABLE`）。預算限制的是工作量不是時間：掛住的檔案系統上單一呼叫仍可能無限期阻塞。**飢餓：** 某個 `collected/<seq>` 總是超過預算或持續被改動時，該 slot 會被擋到你處理為止：停掉該專案所有 run、檢查該 slot 的 `collected/<seq>/`、把不要的檔搬到 approval home 以外，再 `resume`。若 store 的記錄多到光計算配額就超過預算，所有已登錄 slot 都會被擋；階段 3 沒有任何功能移除記錄（`gc` 未建）。

### 殘留風險、未實作、未驗證

- **殘留程序或檔案描述符（spec 4.4）。** agent 設法留下的背景程序可在搬移之後寫入新的 `proposals/`；下個 pass 才看得到，且只能新增請求（受配額限制）。它持有的已搬移檔案的描述符仍可改動 `collected/` 內的該檔；收走程式只檢查檔案在讀取期間 device 與 inode 沒變，不保證內容沒變。已存進 `approvals/` 的複本不受影響。
- **寫入範圍不是讀取隔離。** 授權 `proposals/` 只管寫入。本頁沒有任何機制阻止 agent 讀其他 agent 的檔案或請求；不要把請求當機密（見本頁開頭）。
- **未實作：** 核可、執行、回饋、`requests gc`／`approvals gc`，以及 `call` 的收走。實例（`<role>--N`）目前也不收走。 <!-- S3-dependent -->
- **未驗證：** F3、Linux、真實 sandbox 的強制效果，以及真實 Claude CLI 對 `proposals/` 授權的處理。除了用完即丟的 home，不要啟用 `executors.yaml`。

## 平行實例的共用記憶

當一位成員以多個實例執行（見[同一成員的平行實例](how-it-works.zh-TW.md#同一成員的平行實例)），只有實例 1（成員本名）會寫該成員的共用記憶（`memory.global`、`memory.project`）。編號 2 以上的實例把那份記憶當唯讀的背景資料，只寫自己的 task memory（`task-memory/<run-id>/<member>--2`）與 outbox；提示會要求它們把值得保留的教訓寫在給 lead 的回信裡。編號 2 以上的實例 `can_edit_agent_md` 一律是 `false`。（規格 23.11、23.12）

這是寫入範圍，不是讀取隔離：其他實例仍讀得到共用記憶，這裡的任何機制也都不阻止 agent 讀別的 agent 的記憶。

**包含檢查。** 上述規則成立的前提是：額外實例能寫的資料夾（task memory、outbox、worktree 與 git dir）都不在成員的共用記憶之內，也不包含它。agent-lyceum 以真實路徑檢查（解開 symlink；macOS 上不分大小寫比較），時機為：成員第一個平行 task 之前、實例的資料夾建好之後、喚醒實例之前，以及 `resume` 時。檢查不通過時，額外實例不會被開啟或喚醒，或 `resume` 被拒絕，訊息會寫出兩個路徑；檢查失敗時一律封閉（不放行）。記憶路徑包含或位於 run 資料資料夾之內時，`doctor` 會提早警告。worktree 內指向共用記憶的 symlink 不在這項檢查的範圍。（23.11）

**編號 2 以上的實例被擋在共用記憶之外的強度**（僅在包含檢查通過時適用）：

| runtime／平台 | 實例 2+ 寫共用記憶 |
|---|---|
| Claude Code 加 OS sandbox（macOS；Linux 需有 `bwrap`） | 由 OS 拒絕（`denyWrite`） |
| Claude Code 無 OS sandbox | 只有 `Edit` 工具規則；Bash 可繞過 |
| Codex 加 OS sandbox | 共用記憶不在可寫根目錄內 |
| Codex 無 OS sandbox（Linux 沒有 `bwrap`） | **只靠提示**：只是告訴實例不要寫 |

以上是 policy 交給各 runtime 的路徑；真實 CLI 與 sandbox 是否照做尚未驗證。guard 不保護記憶，所以寫進去的內容不會被還原：以最後寫入者為準。單一寫者只在同一個 run 內成立：`memory.project` 跨 run 共用，同時進行的兩個 run 的實例 1 仍可能同時寫入，和以往的並行 run 相同。（23.11）

**提案（spec 30）。** 單獨執行的 agent（`run --agent`、`call -p`）可以寫專案資料夾裡 `proposals/` 下的提案；它不在 records 之下，所以 records 的 deny 不涵蓋它。guard 現在把這個 agent 當成它實際的身分：即使它是一人團隊的 lead，寫 records 也會被**還原**（以前會放行；這是 `run --agent` 的行為變更）。在 `proposals/` 裡它只能新增與修改 `<它的短 id>-<slug>.md`，而且只在檔案仍是 `proposed` 時；別的前綴、`.archive/`、刪除、已決議的提案都會被還原。與 records 一樣，若同專案另一個 run 仍存活，或在監看期間開始又結束，改動無法歸屬，會被保留；這是盡力而為，不是保證。一般 run 的其他成員只靠 write policy 唯讀。
