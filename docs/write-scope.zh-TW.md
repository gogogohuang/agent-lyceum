# 寫入範圍

預設規則（repo 內其餘部分不受限制）：

| 目標 | 規則 |
|---|---|
| 自己的記憶資料夾、自己的 `outbox/` | 可寫入 |
| 自己的 `agents/<自己>/`、`shared/common/`（`COMMON.md`、`records/`） | 每位成員可寫 |
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
