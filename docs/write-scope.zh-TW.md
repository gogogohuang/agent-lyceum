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
- **所有 runtime**：執行前會對受保護檔案做雜湊；每次喚醒後，未經授權的變更會被還原、記錄，並通報 lead；被寫入的內容會先留存在 `runs/<run-id>/violations/`。

**guard 無法歸屬的變更。** `COMMON.md`、紀錄目錄 `shared/common/records/` 與團隊的 `AGENT.md` 由專案的所有 run 共用。若一批喚醒中沒有任何 agent 可編輯某個這類檔案，而同專案的另一個 run 在該批開始或結束時仍存活（它的 run lock 被存活的行程持有），這個檔案的變更就無法歸屬到本 run。此時 guard 不還原、不在 `violations/` 留副本、也不寄信給 lead；該變更成為新的基準，run 日誌會記一筆 `protected-change-unattributed` 事件（另印一行主控台訊息）。原因：另一個 run 的 lead 本來就會合法編輯這些檔案，還原它們只會白白喚醒本 run 的 lead。這只略過 guard 無法歸屬的部分：本 run 自己的 agent 在該時段內的違規也不會被還原，那時只剩上述 runtime／OS 沙箱擋得住。每個 run 專屬的檔案（run 的交接筆記、repo 的 `CLAUDE.md`/`AGENTS.md`），以及沒有其他 run 存活時的任何變更，仍照原樣還原並通報。見[同時多個 run](how-it-works.zh-TW.md#同時執行多個-task)。

`doctor` 與 `run` 會依類別（`os`、`tool-rules`、`post-hoc`、`prompt-only`）印出每個 agent 的防護等級，以及它能寫入 repo 之外的哪些路徑。設定 `dispatcher.strict: true` 時，除非記憶、`AGENT.md`、其他 agent 的 context 與（非 lead 的 agent 的）交接筆記都由 OS 強制保護，否則拒絕執行。

agent worktree 內的 git:agent 能寫它 worktree 的 `.git` 指標檔與私有 git 目錄,可能讓 git 去讀 agent 埋的設定或 hook。因此 dispatcher 對 agent worktree 的每一次 git 呼叫,都釘住 worktree 建立當下記錄的 git dir、common dir 與 work tree,關閉 hook、fsmonitor、external diff 與 textconv,並拒絕使用 git 檔案被改向或連到別處、HEAD 不是它自己的分支、或內含巢狀 repository 的 worktree。Claude 另外不得寫那幾個指標檔(`denyWrite`);Codex 無法禁止單一檔案,只靠釘住。殘留風險列在 [spec 15](specs/15-worktree-git-isolation.md#156-殘留風險)。這**不**表示 dispatcher 絕不會執行 agent 埋下的程式碼。使用 `reftable` ref 後端的 repository 在 worktree 模式下會被拒絕。

已知缺口：Claude Code 內建的 Edit/Write 工具不在沙箱內（由 `Edit` 規則涵蓋）；Codex 的 MCP 工具與 hooks 在其沙箱之外執行；`--dangerously-bypass-approvals-and-sandbox` / `danger-full-access` 會停用所有防護。啟用 `can_edit_agent_md` 時，Codex lead 的可寫根目錄會擴大到整個 agent 目錄。

## Sandbox 放寬

agent 的 `sandbox`（`write`、`network`、`local_binding`、`unix_sockets`；欄位說明見 [設定](configuration.zh-TW.md#sandbox-放寬)，設計見 [spec 25](specs/25-sandbox-allowances.md)）只在有設定時，才只對該 agent 放寬 OS sandbox。這已在 0.28.0 實作；各鍵在真實喚醒中的端到端效果**未驗證**。

- **`write`** 把目錄加進該 agent 的寫入範圍，就是給 Claude `Edit` 規則、`allowWrite`、`--add-dir`，以及給 Codex `writable_roots` 的同一份清單。受保護路徑永遠不能加，例如：設定資料夾或 repo 內的任何位置、所有 `AGENT.md`、記憶資料夾、inbox 與 outbox、`COMMON.md`、紀錄資料夾、該 run 的資料、其他 agent 的 worktree 與 git 目錄、git common dir、worktrees 根目錄、repo 的 `CLAUDE.md`／`AGENTS.md`、`~/.claude`、`~/.codex`，以及它們的祖先。完整清單見[設定](configuration.zh-TW.md#sandbox-放寬)；被拒絕的 invocation 會記為 `sandbox-refused`，不重試。
- **`unix_sockets`** 允許所列路徑下的 Unix socket **bind 與 connect**，不只是測試裡的 listen。該資料夾內的服務都連得到，所以不要把 Docker、ssh-agent 之類的 socket 放進去。只有 Claude Code 有作用；Codex 什麼都不會得到，`doctor` 會警告。
- **`local_binding`**（只有 Claude Code）允許在**任何本機 IP**（不只 loopback）bind 與接受連入連線，以及連出到 localhost 上的服務。它不是「只在 localhost 提供服務」。依 Claude Code 文件，它在 Linux 上無效果（[sandboxing](https://code.claude.com/docs/en/sandboxing)）。它不涵蓋 Unix socket。
- **`network`**：Claude Code 逐網域；Codex 全有全無（列任何網域就開放所有主機）。
- **不變：** `allowUnsandboxedCommands` 維持 `false`，Codex 維持 `workspace-write`，沒有任何鍵能讓任何 agent（含 lead）在 sandbox 外執行。非 lead 的 agent 永遠不會在 sandbox 外執行。（lead 的 `done` 被接受且要求時，推分支與開 PR 的是 dispatcher，不是 agent。）
- **是寫入範圍，不是讀取隔離：** 這些鍵放寬的是 agent 可寫入或可連線的範圍，不限制讀取，也不會讓某個 agent 無法讀其他 agent 的記憶。
- **沒有 OS sandbox：** Claude 的 `write` 只擴大 `Edit` 工具規則（Bash 可繞過），其他鍵無作用；Codex 只靠提示。路徑在每次 invocation 前檢查，但檢查與 spawn 之間被換掉的路徑無法防禦；邊界是 OS sandbox。

**會啟動子行程的測試。** 在 Claude 的 sandbox 下，`tsx` 子行程開不了 IPC socket 時 `npm test` 會失敗（`listen EPERM .../tsx-<uid>/*.pipe`）；診斷見 [Sandbox 阻擋](sandbox-blocks.md)。`unix_sockets: [<你的 $TMPDIR>/tsx-<uid>]`（請自行解出 `$TMPDIR`，不會自動展開）是預期的修法，但端到端**未驗證**，且有 Claude Code 2.1.89 的回報指出限定路徑的 Unix 放行只涵蓋 connect（[claude-code#41817](https://github.com/anthropics/claude-code/issues/41817)）。已知的替代做法仍是用 `NODE_OPTIONS="--import stub.mjs"` 的 stub，讓 `*.pipe` 路徑的 `net.Server.listen` 變成 no-op。

## 核准閘門登錄的 agent（階段 2b-1，尚非可運作的核准閘門）

這是核准閘門（[store API](approval-store-api.md)、[設計](superpowers/specs/2026-11-13-approval-gate-design.md)）的第一部分；階段 2b-1 加固「已登錄」agent 的啟動方式。階段 3 現已授權請求目錄並收走請求；核准與執行仍未實作（見下方階段 3）。

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

**階段 2b-1 尚未實作：** 每次喚醒重新檢查登錄並拒絕喚醒某個 slot、`status` 的原因顯示、`proposals/` 寫入權限、收集請求、核准 CLI、executor 執行器。上述為歷史切片範圍；後續已加入每次喚醒的關卡、status 診斷與階段 3 請求收走：見[核准請求收走](#核准請求收走階段-3非可發布)。已登錄 `call` 的收走見 [call 的核准請求](#call-的核准請求階段-4非可發布)。真實 Claude CLI 是否接受新旗標、真實 sandbox 的效果、Linux 皆**未驗證**；macOS 第 0 步的量測見 spec 第 8 節。

## 核准請求收走（階段 3，非可發布）

**非可發布：第 0 步未驗證**（English: not releasable, step 0 unverified）。下列三項**未驗證**，並阻擋發布：F3（使用者設定層：`--setting-sources user` 仍會對已登錄的 agent 載入 `~/.claude/settings.json`，`src/adapters/claude.ts:13`）、Linux、真實 OS sandbox 的強制效果。以下只描述程式實際做的事，不是安全的證據。細節與 API 見[核准儲存 API](approval-store-api.md#request-collection-stage-3-not-releasable)（英文）。

### 請求檔

- **位置。** 已登錄的 agent 把純文字請求寫進自己 slot 的 `proposals/`：`<home>/requests/projects/<project>/<run-id>/<slot>/proposals/`（`src/approval-paths.ts:57,62`）。該目錄多給一個可寫目錄，路徑寫在 system 與 user prompt（`src/prompt.ts:209-222,400-402`）。
- **誰拿得到。** 只有已登錄 agent 的 claim wake：第一次呼叫、每次重試與每個 fallback，含 solo。包含已登錄的 lead；判斷依據是登錄，不是 lead 身分。tidy、verify、format 沒有該目錄、授權與 prompt 文字（`src/run-session.ts:784-787,1064-1072,1153-1159`）。已登錄的 `call` 另見 [call 的核准請求](#call-的核准請求階段-4非可發布)。
- **檔名。**（`REQUEST_FILENAME_RE`，`src/approval-id.ts:19`）：不以 `.` 開頭，接著 1 到 64 個 `A-Za-z0-9._-`，再以 `.req` 結尾。其他檔名被忽略。
- **內容。** 標頭、一個空行、payload。標頭最多兩行：`executor: <名稱>`（必填，須為已註冊的 executor）與 `summary: <文字>`（選填，最多 300 個碼點），含空行最多 2048 bytes。payload 受該 executor 的 `max_payload_bytes` 限制（預設 4096、上限 65536）；超過 67584 bytes 的檔案在解析前就被拒。整個檔案必須是 UTF-8 文字，除 LF 與 TAB 外不得有控制字元，不得有格式、分隔或不可見字元（允許 U+3000）；絕不清理內容，壞檔只會被記為 denied（`src/approval-request.ts:9-70`、`src/approval-executors.ts:32-34`）。
- **不是指令。** 收走的請求只是存起來等人審核；agent 寫了檔並不會執行任何東西。

### dispatcher 做什麼

- **收走。** wake 的輸出路由之後，`collectApprovals` 走訪每個已登錄且未被隔離的 slot（`src/run-session.ts:898-936`）。本批 attempt 為 `output_ready` 的 slot 依該 hint 收走：整個 `proposals/` 重新命名到 `collected/<seq>/`，再建立空的 `proposals/`，請求成為 `<home>/approvals/` 下的記錄。序號只增不減（`collected.seq`）；空目錄不會被重新命名，所以不佔序號。`resume` 以沒有 wake hint 的方式呼叫同一函式（`settle([], [])`，`src/run-session.ts:1810`）。沒有 hint 時，非空的 `proposals/` 在最新 attempt 的 claim 為 `output_ready` 或 `committed` 時被收走，在該 attempt 為 `failed` 或其 claim 為 `abandoned` 時被 park，其餘留在原地且該 slot 不被喚醒（`src/run-session.ts:815-855`）。恢復流程會在這次 resume 之前 park `started` 的 attempt（`src/message-store.ts:494-501`）。失敗會以固定原因擋住該 slot 並通知 lead；slot 本身就是 lead 時不寄信給它。非預期例外或讀不到新的設定檢視時，輸出留在原地（`retainedOutput`）。其他 slot 繼續（`src/run-session.ts:939-993`）。
- **記錄的提交點。** 請求在其 `record.json` 被 link 到位時才算存在，且不會被覆寫。`collected/<seq>.done` 最後才寫，所以在它之前崩潰只會重做；同一請求得到同一個 id（`src/approval-collect.ts:20-26`）。
- **失敗或取消的 attempt。** 在該 attempt 標為結束之前，slot 的 `proposals/` 先搬到 `parked/<attempt-id>/`。被 park 的請求不會被收走，也不會成為重做草稿（`src/approval-rotation.ts` 的 `Park`；spec 4.4）；agent 必須重新提出。失敗 attempt 的 parking 若失敗，只有該 slot 得到 `config` 失敗、不重試也不 fallback；請求與未讀輸入保留，該 slot 被擋並通知 lead（不寄信給自己），其他 slot 繼續。後續 dispatch pass 或 `resume` 會重驗原因；沒有背景重試，也不保證自動修復（`src/run-session.ts:1253-1286,949-993`）。取消的 wake 也會嘗試這次 parking。若 parking 拋出錯誤，失敗會記 log 然後被忽略：attempt 仍結束為 `failed`、錯誤為 `cancelled`，claim 被放棄，未讀輸入留給 resume，這條路徑不走 `config` 停止（`src/run-session.ts:1245-1251`；`src/fallback.ts:236`；`src/run-session.ts:1288-1294`）。
- **崩潰後的 resume。** `resume` 先 park 已開始的 attempt 的目錄再標為失敗；對剛轉為 `abandoned` 的 claim，先 park 再存該狀態。恢復時 park 失敗，該 slot 的 attempt 與 claim 保持未完成，並在本程序內隔離，不喚醒也不收走。park 失敗會記 log；關卡評估該隔離 slot 時，以 `UNDETERMINABLE` 寫原因檔、顯示終端文字並通知 lead（不寄信給自己），不保證下次恢復能修好（`src/run-session.ts:754-757,949-993,1770-1788`；`src/message-store.ts:476-527`）。
- **`full_writable`。** 記錄的 `origin.full_writable` 是*收走那一刻* slot 擁有的可寫路徑集合。崩潰後由 resume 收走時，記的是較晚那次收走的授權，不是原 wake 的。它只供顯示，不拿來比對。
- **拒收與配額。** 超限、格式錯誤或不被允許的請求成為 `denied` 記錄，原因為固定代碼（`bad_content`、`bad_header`、`bad_executor`、`too_large`、`not_allowed`、`quota`、`not_regular`、`scan_limit`）。每個 project（或 call）與 role 的小計數檔統計拒收發布／彙總事件，不是被拒來源檔數：一個 `scan_limit` 事件攜帶 `ignored_count`。低於 100 時事件保留完整記錄，之後只增加計數。既有記錄會在計數遞增前返回。超過上限後沒有記錄：已有 `.done` 的目錄不會再掃描，該次重播不改變計數；未完成的目錄若再處理會再次遞增。記錄已發布但計數尚未遞增時崩潰可能少計。無鎖的讀加寫也可能遺失並行更新（`src/approval-collect.ts:252-268,385-389`）。待處理配額（每個 executor 的 `max_pending`、`max_total_pending`）是軟限制：每個 slot pass 只計一次，不同 slot 的 pass 可能一起超過。每個目錄最多讀 `max_scan_entries`（預設 200）個檔，最舊的先；其餘合計成一筆 `scan_limit` 記錄（`src/approval-collect.ts:61,320-385`）。

### 操作者處置

每個收走問題都以 `approval_collect` 寫入 `log.jsonl`，欄位固定（`slot`、`op`、`class`，另有選填的 `seq`、`id`、`count`）；不記錄路徑、錯誤文字、檔名或 payload（`src/approval-collect.ts:34-38`）。該 slot 在這一輪不被喚醒，其他 slot 照常。`skipped` 會在之後的 dispatch pass 或 `resume` 重驗；`refused` 在本 run 內維持不喚醒。這裡沒有安排修復。人類可讀的目前 run `status` 顯示觀察時間與原因；移除登錄後仍可能保留，不代表目前仍被擋。`DIR_ANOMALY` 的 status 原文是：`request directory needs repair, see the "approval_collect" class in log.jsonl (symlink or not_directory: make proposals and collected plain directories; corrupt: fix collected.seq; held: stop all runs, then remove a stale .coord directory; unsupported: use a filesystem with hard links)`（`src/approval-wake-gate.ts:59-61`）。

`approval-gate.json` 可讀時，目前 run 的人類狀態顯示 `已收走的核可請求（已提交紀錄）：N`；計數失敗或超過預算則顯示 `無法讀取（未知，非 0）`。N 計算此 project/run 已提交的記錄，包含 denied 與後續狀態；只有 payload 的目錄不計。這不是待處理配額、拒收事件計數或來源檔數。沒有關卡檔就隱藏此區段；檔案不可讀則顯示警告。`status --json` 不變，也不讀此檔或收走儲存區（`src/status.ts:672-690`；`src/approval-collect.ts:468-494`）。

啟用登錄時，`doctor` 也會在 `approvals/`、`requests/` 中第一個普通目錄（否則為 home）建立一個暫時的獨占檔與指向它的 hard link，然後只 unlink 這兩個名稱。若其中一個 unlink 失敗，探測回報 `IO_ERROR`，該名稱可能留下。沒有 `executors.yaml` 或所有 `allow` 皆空時，在探測前就返回（次數為零）。失敗使用固定 `UNSUPPORTED_LINK`、`UNSAFE_PATH`、`IO_ERROR` 文字；這是診斷，不是強制執行（`src/doctor-approval.ts:23-38,53-67`；`src/approval-link-check.ts:43-77`）。

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

**工作預算。** 一次 pass 對一個 slot 最多花 65536 單位：每次計費呼叫與每個返回的目錄項各一單位（`src/approval-budget.ts:5-12,20,60-106`）。關閉目錄、讀到目錄結尾與不計費的鎖操作排除；關閉檔案先執行再計費。單位不是檔案系統呼叫的精確次數。一個合法的檔案花目錄項加一次 `lstat`；檔名不合法的只花一單位、不 stat。溢出會停止後續工作，不回滾。先前的 rename 與發布保留供恢復：`proposals/` 可能已搬走，尚未重建或更新高水位；較早的目錄也可能已有 `.done` 或 `scan_limit` 記錄。尚未到達這些發布點的處理不會建立它們；已提交記錄重入時沿用（`src/approval-rotation.ts:139-144`；`src/approval-collect.ts:385-389,394-453`）。該 slot 不被喚醒（`RESIDUAL_OUTPUT`；若是在計算 store 既有記錄時溢出則為 `UNDETERMINABLE`）。預算限制的是工作量不是時間：掛住的檔案系統上單一呼叫仍可能無限期阻塞。**飢餓：** 某個 `collected/<seq>` 總是超過預算或持續被改動時，該 slot 會被擋到你處理為止：停掉該專案所有 run、檢查該 slot 的 `collected/<seq>/`、把不要的檔搬到 approval home 以外，再 `resume`。若 store 的記錄多到光計算配額就超過預算，所有已登錄 slot 都會被擋；階段 3 沒有任何功能移除記錄（`gc` 未建）。

### 殘留風險、未實作、未驗證

- **殘留程序或檔案描述符（spec 4.4）。** agent 設法留下的背景程序可在搬移之後寫入新的 `proposals/`；下個 pass 才看得到，且只能新增請求（受配額限制）。它持有的已搬移檔案的描述符仍可改動 `collected/` 內的該檔；收走程式只檢查檔案在讀取期間 device 與 inode 沒變，不保證內容沒變。已存進 `approvals/` 的複本不受影響。硬連結數大於 1 的請求檔會被接受：有上限的讀取以 `O_NOFOLLOW` 開啟，只拒絕 symlink，收走時比對 device 與 inode，不比對連結數（`src/fs-util.ts:121-135`、`src/approval-collect.ts:365-383`）；收走的 payload 是從該 buffer 另寫的不可變複本（`src/approval-request.ts:67`、`src/approval-io.ts:157-198`），之後改動原檔不會改變它。
- **寫入範圍不是讀取隔離。** 授權 `proposals/` 只管寫入。本頁沒有任何機制阻止 agent 讀其他 agent 的檔案或請求；不要把請求當機密（見本頁開頭）。
- **未實作：** 核可、執行、回饋、`requests gc`／`approvals gc`。實例（`<role>--N`）目前也不收走。已登錄 `call` 的收走見 [call 的核准請求](#call-的核准請求階段-4非可發布)。
- **未驗證：** F3、Linux、真實 sandbox 的強制效果，以及真實 Claude CLI 對 `proposals/` 授權的處理。除了用完即丟的 home，不要啟用 `executors.yaml`。

## call 的核准請求（階段 4，非可發布）

**非可發布：第 0 步未驗證**（English: not releasable, step 0 unverified）。Linux、Codex 與真實 sandbox **未驗證**。本節是已登錄 `call` 的階段 4 契約。上面的 run slot 規則仍適用於 claim wake。帶 policy 的 wake（tidy、verify、format）仍然沒有 `proposals/`。`approvals list`、`show`、`approve` 尚未實作。指令文字見 [call](commands.zh-TW.md#call) 與 [approvals collect](commands.zh-TW.md#approvals-collect)。

### 授權與空目錄

授權路徑只有 `requests/calls/<call-id>/proposals/`。`requests/` 根目錄不在授權內，`ok.json`、`collected/`、`parked/`、核准儲存區與其他 agent 的 `proposals/` 也不在。`<call-id>` 是這次 call 的 id。同 UID 競態、逃逸的子行程，以及沒有讀取隔離，仍如[殘留風險](#殘留風險未實作未驗證)所述：授權只管寫入，其他 agent 仍可讀這些檔案。

runtime 啟動前，該 `proposals/` 必須是真實且為空的目錄。無法確認為空時，runtime 不啟動，也不試下一個候選。stderr 為 `Approval call not started: proposals could not be confirmed empty. Run agent-lyceum doctor; inspect requests/calls/<call-id>.` 已在目錄裡的檔案留在原地，不收走、不刪除。執行 `agent-lyceum doctor`、修好目錄後，重新開始一次 call。這一行寫得進去時，會附加到 `<home>/calls/<call-id>/log.jsonl`。

### park，以及收走失敗仍保留 call 成功

失敗或取消的候選會 park 到 `parked/<n>`，永不收走。`ok.json` 寫出之前崩潰留下的部分 `proposals/` 也永不收走。park 失敗就停止 fallback。stderr 為 `Approval call stopped: failed-attempt proposals could not be parked. Inspect requests/calls/<call-id>.` 檔案留在原地，不混進下一個候選，也不刪除。修好目錄後，若仍要這份工作，就重新開始一次 call。附加成功時，同一份 log 會留下這一行。

成功的 call 在收走失敗時仍算成功：exit code 與 `result.md` 保持不變，請求留在磁碟上。修好設定或執行 `agent-lyceum doctor` 後，再執行 `approvals collect --call <call-id>`。診斷行在 `<home>/calls/<call-id>/log.jsonl`。修好之後可以重試。重試不保證一定收得走。call 不把核准結果餵回 agent。

### 仍然成立的限制

同 UID 的行程仍可能改動收走程式已經搬走的檔，範圍同階段 3 的殘留清單。agent 留下的子行程仍可能在輪替之後寫入新的 `proposals/`。本頁沒有機制阻止 agent 讀取其他 agent 的請求。把請求檔當成可寫的工作檔，而不是機密通道。

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
