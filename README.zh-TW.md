# agent-lyceum

[![npm version](https://img.shields.io/npm/v/agent-lyceum)](https://www.npmjs.com/package/agent-lyceum)

[English](README.md) | **繁體中文**

設定並執行一個由多個 **agent**（Claude Code 和／或 Codex）組成的團隊。agent 之間透過檔案信箱互相溝通，每個 agent 都有自己的人設（`AGENT.md`）與長期記憶資料夾。寫入權限有範圍限制：agent 只能修改自己的記憶與寄件匣（outbox），不能改動其他 agent 的 context，也不能改自己的人設。

此工具**不會把自己的資料放進你的 repo**：設定、信箱、log、任務記憶與 agent 的 worktree 都放在一個看得到的資料夾 `~/agent-lyceum-config/`（可用 `AGENT_LYCEUM_HOME` 或 `--home` 覆寫）。但 agent *產出的成果*是另一回事：agent 會修改你的 repo（序列執行時直接修改；平行執行時在各自的 git worktree 修改，再把變更整合進你的工作目錄）。agent-lyceum 自己在你的 repository 內唯一新增的是 git 的管理資料：平行 run 存在期間，`.git` 下會有 `refs/agent-lyceum/<run-id>/*` 快照 ref、`agent-lyceum/<run-id>/<agent>` branch 與 worktree 登記，`agent-lyceum clear` 會把它們移除。從舊版升級請見 [docs/upgrading-run-v2.md](docs/upgrading-run-v2.md)。

```bash
npx agent-lyceum init                     # 建立 home 與全域 agent 庫
npx agent-lyceum project add web --dir ~/code/web-app
npx agent-lyceum validate --project web   # 檢查設定並顯示各項防護等級
npx agent-lyceum run --task-file spec.md  # 在 repo 內執行時會自動偵測專案
npx agent-lyceum status
```

安裝後的執行檔名稱為 `agent-lyceum`。若要直接跑 GitHub 上尚未發佈的最新程式碼，可改用 `npx github:gogogohuang/agent-lyceum <command>`。

需求：Node 20+，以及 `PATH` 中有 `claude` 和／或 `codex`（且已登入）。支援 macOS 與 Linux（Linux 需要 `bwrap` 才有 OS 沙箱）；Windows 只會顯示警告。

## 指令

| 指令 | 功能 |
|---|---|
| `init [-y]` | 建立 home 與全域 agent 庫。 [詳細](docs/commands.zh-TW.md#init) |
| `project add <name> --dir <repo>` | 註冊專案。 [詳細](docs/commands.zh-TW.md#project-add) |
| `project list` / `project remove <name> [--purge]` | 列出或取消註冊專案。 [詳細](docs/commands.zh-TW.md#project-list-and-remove) |
| `validate [-p name] [--task-file f]` | 驗證設定並顯示每個 agent 的防護等級。 [詳細](docs/commands.zh-TW.md#validate) |
| `run ["task"] [--task-file f] [--agent a] [-p name]` | 把任務交給 lead 並執行到結束；加 `--agent` 則只交給某個成員單獨做。 [詳細](docs/commands.zh-TW.md#run) |
| `call <agent> ["task"] [--task-file f] [--dir d]` | 單獨呼叫一個 global agent（不需專案），印出它的回答。 [詳細](docs/commands.zh-TW.md#call) |
| `resume [run-id] [-p name]` | 接續被中斷或失敗的 run。 [詳細](docs/commands.zh-TW.md#resume) |
| `answer <run-id> [--no-edit] [-p name]` | 回答等待中的 run 提出的問題，並接續執行。 [詳細](docs/commands.zh-TW.md#answer) |
| `status [-p name] [--monitor]` | 顯示 agent、信件、目前執行與歷次 run（支援 `--json`、`--monitor`）。 [詳細](docs/commands.zh-TW.md#status) |
| `clear <run-id> [-p name] [--dry-run] [--keep-worktrees]` | 刪除 run 與其任務記憶、worktree。 [詳細](docs/commands.zh-TW.md#clear) |
| `config show --resolved [-p name] [--json]` | 印出每項生效設定與其來源。 [詳細](docs/commands.zh-TW.md#config-show) |
| `doctor [-p name] [--json]` | 不執行 agent，檢查設定、git、鎖與 runtime CLI。 [詳細](docs/commands.zh-TW.md#doctor) |
| `memory tidy [-p name] [--agent a] [--layer project\|global] [--dry-run]` | 讓 agent 整理自己的記憶（只能手動觸發；封存而非刪除）。 [詳細](docs/commands.zh-TW.md#memory-tidy) |
| `memory restore <時間戳> -p name --agent a` | 還原一次整理：把封存的檔案搬回。 [詳細](docs/commands.zh-TW.md#memory-restore) |
| `unlock [-p name] --force` | 移除當機 run 留下的專案鎖。 [詳細](docs/commands.zh-TW.md#unlock) |

Ctrl-C 會乾淨地取消 run，之後可用 `resume` 接續（[中止 run](docs/commands.zh-TW.md#中止-run)）。`run`／`resume` 只有在 lead 回報 `completed` 時才 exit `0`；`partial`／`blocked` 為 `2`，`failed` 為 `1`，等待你回答時為 `3`，取消為 `130`（[退出碼](docs/commands.zh-TW.md#退出碼)）。未指定 `-p` 時，專案由目前目錄推斷（[選擇專案](docs/commands.zh-TW.md#選擇專案)）。

## 單獨呼叫一個 agent

有兩種方式把任務只交給單一 agent，而不是整個團隊。該 agent 獨自工作：不能寄信給隊友、不能向你提問、不能修改任何 `AGENT.md`。

```bash
npx agent-lyceum run "整理表單" --agent fe-member -p web   # 專案裡的一個成員，當作一般 run
npx agent-lyceum call pm "這個需求可以開工了嗎？" --dir ~/code/web-app   # global agent，不屬於任何專案
```

`run --agent` 有 run id 與專案鎖、會出現在 `status`、可以 `resume`；agent 用自己寄出的 `done` 結束 run。`call` 完全不需要專案：agent 取自 `team.yaml`，在 `--dir`（預設是目前目錄，且不可位於 agent-lyceum home 之內或之上）工作，stdout 只印它的最終回答，並在 `<home>/calls/<call-id>/` 留下 `task.md`、`log/` 與 `result.md`。細節見 [run](docs/commands.zh-TW.md#run) 與 [call](docs/commands.zh-TW.md#call)。

## 監控 mod（Claude Code）

`plugins/status-monitor` 是 Claude Code **mod**，不是一般的 plugin：它依 Claude Code 的 mod hooks API 撰寫（`import type { Register } from 'claude-code'`），在 Claude Code session 內執行，提供狀態列、通知與 `/status-monitor` 面板，並輪詢 `agent-lyceum status --json`。需要支援 mod 的 Claude Code 版本；不會改變 agent-lyceum 本身的運作。會顯示一個或多個專案的即時執行狀態。

**載入。** 先 build（`npm run build`；mod 會執行 `dist/cli.js`），再用下面的指令啟動 session：

```
claude --plugin-dir /path/to/agent-lyceum/plugins/status-monitor
```

`--plugin-dir` 只在 session 啟動時生效，已開著的 session 要重開（`claude --resume --plugin-dir ...` 可保留對話）。想每次都載入，就在 shell rc 加 `alias claude='claude --plugin-dir /path/to/agent-lyceum/plugins/status-monitor'`；無法帶參數的環境（桌面 app、SDK）則把 `CLAUDE_CODE_PLUGIN_DIRS` 設成 mod 資料夾。session 執行中儲存 mod 資料夾內的檔案會自動 hot reload。

**操作。**
- **狀態列：** 載入後常駐（第一次輪詢前顯示 `team 讀取中…`，CLI 跑不起來時顯示 `team 無法取得狀態：…`），顯示執行狀態、輪數 `n/max`、output tokens、目前步驟與未讀信件。監看多個專案時顯示一行總覽（`team 1/3 執行中 · a ... | b ...`）。
- **通知：** 執行完成、被中斷或某個 agent 喚醒失敗時會跳出訊息（監看多個專案時前面加 `[專案名]`），不需要任何操作。
- **`/status-monitor`：** 輸入即開啟面板（已開著則關閉）。session 啟動時預設不開，除非設定 `autoOpen`。在 **fullscreen 版面**（`~/.claude/settings.json` 設 `"tui": "fullscreen"` 後重開 session；`/tui fullscreen` 效果相同）且終端寬度 110 欄以上時，面板會靠右 dock 在終端寬度的一半，分頁與 **關閉** 都可以用滑鼠點。否則顯示在輸入框上方；版面在 session 啟動時就固定，從主畫面啟動的 session 不會變。鍵盤操作兩種版面都能用：`x` 關閉，`1`-`9` 或 Tab/Enter 切換任務，Esc 回到輸入框，再執行一次指令也會關閉。每個專案顯示：執行 id 與狀態、任務、進度與清單、正在工作的 agent 與排隊中的信件、受阻的整合、備註與結果摘要、各 runtime 的 output tokens、各 agent 的喚醒統計、最近 8 次喚醒。每個執行中的任務是一個分頁，最新的排最前面；已結束或已中斷的不列出。面板開著時會依輪詢間隔自動更新。

**設定。** 在 `~/.claude/settings.json` 的 `pluginConfigs."status-monitor@inline"`（`options`）：

| 選項 | 說明 | 預設 |
|---|---|---|
| `command` | 要執行的 CLI，以空白分隔，例如 `node /path/to/agent-lyceum/dist/cli.js` | `agent-lyceum` |
| `project` | 已註冊的專案名稱（`-p`）；用逗號分隔可同時監看多個；留空則依 session 所在目錄推斷 | 空 |
| `intervalSeconds` | 輪詢狀態的間隔（秒） | `1` |
| `autoOpen` | session 啟動時自動開啟面板（未經操作開啟時，終端需 144 欄以上才會顯示） | `false` |

設定變更要等下次啟動 session 才生效。面板若顯示 `無法取得狀態：...`，通常是 `command` 跑不起來（多半是還沒 build `dist/cli.js`），或專案名稱沒有註冊。

## 目錄結構

```
~/agent-lyceum-config/
├── team.yaml                         # 全域 agent 庫
├── agents/<agent>/{AGENT.md, memory/}  # 全域人設 + 跨專案記憶
├── calls/<call-id>/{task.md, log/, result.md}   # 每次 `call`（不屬於任何專案）一個資料夾，另有 .lock-<agent>
└── projects/<project>/
    ├── project.yaml                  # 團隊、repo 路徑、覆寫設定
    ├── agents/<agent>/{AGENT.md?, memory/}   # 專案層人設（選用）+ 專案記憶
    ├── shared/common/COMMON.md
    ├── lock.json                     # run 執行期間持有：同一專案同時只能有一個 run
    ├── task-memory/<run-id>/<agent>/   # 任務記憶：每次 run 獨立，不與其他任務共用
    └── runs/<run-id>/{task.md, log.jsonl, state.json, snapshots/, agents/, mail/{inbox,outbox}/<agent>/}
```

`team.yaml` 定義可重複使用的 agent；`project.yaml` 選擇團隊並覆寫欄位。物件會逐欄位合併，陣列（`can_message`、`owns`）則整個取代。相對路徑以寫入該路徑的檔案所在資料夾為基準；允許使用 `~`。

```yaml
# project.yaml
dir: ~/code/web-app
team: { lead: lead }
dispatcher: { max_rounds: 30, max_parallel: 1, wake_timeout_sec: 600, retry: 1, strict: false, workspace_mode: auto, log_max_bytes: 8388608 }
agents:
  lead:      { resume: true, can_message: all, can_edit_agent_md: true }
  fe-member: { runtime: codex, can_message: [lead], owns: ["src/web/**"] }
  qa-member: { can_message: [lead], owns: ["tests/**"] }
  pm:        { can_message: [lead], allow_web: fetch }   # pm 可以搜尋並讀網頁；其他人沒有網路工具
```

Agent 欄位：`runtime`（`claude-code`|`codex`；若 `model` 可辨識則可省略：`opus`/`sonnet`/`haiku`/`claude-*` → Claude Code，`gpt-*`/`o3`/`*codex*` → Codex；優先順序：專案 runtime > 專案 model > 全域 runtime > 全域 model）、`model`、`effort`（Claude Code：`low`|`medium`|`high`|`xhigh`|`max`，經 `--effort`；Codex：`minimal`|`low`|`medium`|`high`|`xhigh`，經 `model_reasoning_effort`；未設則用 CLI 預設）、`agent_md`、`memory.global` / `memory.project`、`resume`、`can_message`（`all` 或清單；預設 `[lead]`，lead 預設 `all`）、`can_edit_agent_md`（預設只有 lead）、`can_ask_user`（可用 `type: ask` 信件向你提問並暫停 run 等待回答；預設只有 lead）、`allow_web`（`none`|`search`|`fetch`：agent 可以使用多少網路；不設時 Claude Code 沒有網路工具、Codex 維持它自己的預設；`search` = `WebSearch`／Codex `web_search="cached"`，`fetch` = `WebSearch` 加 `WebFetch`／Codex `web_search="live"`，`none` = 不給網路工具／Codex `disabled`；`fetch` 會把整個網頁放進 agent 的上下文，只建議給很少改檔的角色，例如需求或研究角色）、`owns`（repo glob）。

`validate` 檢查的規則：至少 2 個 agent（lead 加一位成員；範本預設是三位）、lead 在 agent 清單內、每個 agent 都有 runtime（明設或由 `model` 推斷）且 `AGENT.md` 存在、`effort` 對該 runtime 合法（若 `runtime` 與可辨識的 `model` 矛盾則警告）、`can_message` 的目標存在、記憶資料夾互不重疊，且當 `max_parallel > 1` 時，每個非 lead 的 agent 都必須有互不重疊的 `owns`，repo 也必須是 git repository。

## 一次執行如何運作

1. 任務（文字，或 `--task-file` 的唯讀副本 `runs/<id>/task.md`）會成為寄給 lead 的第一封信。≤ 16 KB 的任務直接內嵌，更大的改以引用方式傳遞。超過 1 MB 的檔案會被拒絕。
2. dispatcher 用 `claude -p` 或 `codex exec`（headless）喚醒有未讀信件的 agent。除非設定 `resume: true`，否則每次喚醒都是全新的 session。
3. 每次喚醒的 prompt 都包含：該 agent 的 `AGENT.md`、團隊協定、`COMMON.md`（唯讀，≤ 8 KB）、每個記憶資料夾的 `MEMORY.md` 索引、**最舊**一封未讀信件全文（每次喚醒只處理一封；lead 例外，會一次拿到連續最多 5 封 `reply`/`failure` 並一併決策），以及排隊中信件的標題；排隊的信維持未讀，等各自的喚醒再處理。
4. agent 寄信的方式，是在**自己的** `outbox/` 寫一個含 frontmatter（`to`、`type`、`subject`）的 Markdown 檔。dispatcher 會檢查 `can_message`、蓋上真正的寄件者，並移到收件者的 `inbox/`。處理完的信件移至 `inbox/<agent>/read/`。信箱屬於單一 run（`runs/<run-id>/mail/`），信件不會跨 run。舊版本啟動的 run 繼續使用共用的 `shared/{inbox,outbox}/` 信箱（信件不會被搬移），接續這類 run 時會沿用舊版配置。
   每封 `task` 和 `reply` 的內文應包含固定的 `##` 標題（會注入每個 agent 的 prompt）：`task` → `Goal`、`Acceptance criteria`、`Scope`、`Upstream`；`reply` → `Changes`、`Verification`、`Open items`、`Risks`（沒內容就寫 `None`；`done` 免檢）。缺標題的信仍會送達，但開頭會加上警告說明，run log 也會記一筆 `format-warning`。
5. 結束條件：lead 寄出 `type: done`、所有信箱都空了，或喚醒次數達到 `max_rounds`。`done` 的 frontmatter 必須有 `outcome: completed|partial|blocked|failed`，內文要有 `## Result`、`## Files`、`## Verification`、`## Not done`；`completed` 還要求 `## Steps` 全部勾選。不符合的 `done` 會退回給 lead（最多兩次，之後以 `partial` 收下）。agent-lyceum 不會驗證 lead 回報的內容是否屬實。喚醒失敗會重試一次，之後以失敗訊息通知 lead（若 lead 本身失敗，則整個 run 中止）。

平行執行（`max_parallel > 1`）只會同時跑 `owns` 互不相交的 agent，且絕不與 lead 同時執行。此時每個非 lead 的 agent 都在**自己的 git worktree**（`projects/<name>/worktrees/<run-id>/<agent>`，branch `agent-lyceum/<run-id>/<agent>`）工作；worktree 是從喚醒當下 repo 的快照（`refs/agent-lyceum/<run-id>/base-<n>`，包含 lead 尚未提交的修改與新增、未被 ignore 的檔案）切出來的，你的 HEAD、branch 與工作目錄都不會被動到。`dispatcher.workspace_mode` 可設為 `auto`（`max_parallel > 1` 時用 worktree）、`worktree` 或 `shared`；`shared` 不能與平行 agent 並用。平行 run 在 repo 有你自己未提交的修改時，或 repo 不是 git repository 時，會拒絕啟動（請改為序列執行）。成員完成後，dispatcher 會提交它 worktree 中的修改，並在 lead 讀到該成員的信之前，把變更套用到你的工作目錄（不動你的 index 與 HEAD）。每個被改動的路徑都會先檢查：必須在該成員的 `owns` 內（rename 與刪除也算）、不得是 `CLAUDE.md`／`AGENTS.md`，symlink 不得指向專案或該成員 `owns` 之外。若同一檔案在成員的快照之後又在你的 repo 被改過、檢查未通過，或 `git apply` 失敗，就一個檔案都不套用：成果保留在它的 branch 與 worktree，報告與 patch 寫到 `runs/<run-id>/integration/`，並通知 lead，且這個 run 不能以 `completed` 結束（會以 `blocked` 結束）。worktree 只隔離檔案，無法隔離對外部服務、資料庫或網路的副作用。

## 寫入範圍

預設規則（repo 內其餘部分不受限制）：

| 目標 | 規則 |
|---|---|
| 自己的記憶資料夾、自己的 `outbox/` | 可寫入 |
| 任何 `AGENT.md`、`COMMON.md`、repo 的 `CLAUDE.md`/`AGENTS.md` | 唯讀；lead（`can_edit_agent_md`）可編輯 |
| 其他 agent 的記憶／inbox／outbox、`runs/`、設定檔 | 不可寫入 |

由於沒有單一機制是完整的，防護採分層設計：

- **Claude Code**：每次執行帶入 `--settings`，內含 `Edit(...)` 規則，**加上** OS 沙箱（`allowWrite`/`denyWrite`、`allowUnsandboxedCommands: false`）。沒有沙箱時，`python -c` 之類的做法能繞過 Edit 規則，因此 `os` 等級必須啟用沙箱。
- **Codex**：`-s workspace-write` 搭配 `-c sandbox_workspace_write.writable_roots=[...]`（由 OS 強制）。Codex 無法禁止 repo 內的單一檔案，所以 repo 的 `CLAUDE.md`/`AGENTS.md` 只能靠**事後偵測**保護。
- **所有 runtime**：執行前會對受保護檔案做雜湊；每次喚醒後，未經授權的變更會被還原、記錄，並通報 lead；被寫入的內容會先留存在 `runs/<run-id>/violations/`。

`validate` 與 `run` 會依類別（`os`、`tool-rules`、`post-hoc`、`prompt-only`）印出每個 agent 的防護等級，以及它能寫入 repo 之外的哪些路徑。設定 `dispatcher.strict: true` 時，除非記憶、`AGENT.md` 與其他 agent 的 context 都由 OS 強制保護，否則拒絕執行。

已知缺口：Claude Code 內建的 Edit/Write 工具不在沙箱內（由 `Edit` 規則涵蓋）；Codex 的 MCP 工具與 hooks 在其沙箱之外執行；`--dangerously-bypass-approvals-and-sandbox` / `danger-full-access` 會停用所有防護。啟用 `can_edit_agent_md` 時，Codex lead 的可寫根目錄會擴大到整個 agent 目錄。
