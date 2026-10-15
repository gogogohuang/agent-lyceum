# agent-lyceum

[![npm version](https://img.shields.io/npm/v/agent-lyceum)](https://www.npmjs.com/package/agent-lyceum)

[English](README.md) | **繁體中文**

設定並執行一個由多個 **agent**（Claude Code 和／或 Codex）組成的團隊。agent 之間透過檔案信箱互相溝通，每個 agent 都有自己的人設（`AGENT.md`）與長期記憶資料夾。寫入權限有範圍限制：agent 只能修改自己的記憶與寄件匣（outbox），不能改動其他 agent 的 context，也不能改自己的人設。

此工具**不會把自己的資料放進你的 repo**：設定、信箱、log、任務記憶與 agent 的 worktree 都放在一個看得到的資料夾 `~/agent-lyceum-config/`（可用 `AGENT_LYCEUM_HOME` 或 `--home` 覆寫）。但 agent *產出的成果*是另一回事：agent 會修改你的 repo（序列執行時直接修改；平行執行時在各自的 git worktree 修改，再把變更整合進你的工作目錄）。agent-lyceum 自己在你的 repository 內唯一新增的是 git 的管理資料：平行 run 存在期間，`.git` 下會有 `refs/agent-lyceum/<run-id>/*` 快照 ref、`agent-lyceum/<run-id>/<agent>` branch 與 worktree 登記，`agent-lyceum clear` 會把它們移除。從舊版升級請見 [docs/upgrading-run-v2.md](docs/upgrading-run-v2.md)。

```bash
npx agent-lyceum init                     # 建立 home 與全域 agent 庫
npx agent-lyceum project add web --dir ~/code/web-app
npx agent-lyceum doctor --project web   # 檢查設定並顯示各項防護等級
npx agent-lyceum run --task-file spec.md  # 在 repo 內執行時會自動偵測專案
npx agent-lyceum status
```

安裝後的執行檔名稱為 `agent-lyceum`。若要直接跑 GitHub 上尚未發佈的最新程式碼，可改用 `npx github:gogogohuang/agent-lyceum <command>`。

需求：Node 20+，以及 `PATH` 中有 `claude` 和／或 `codex`（且已登入）。支援 macOS 與 Linux（Linux 需要 `bwrap` 才有 OS 沙箱）；Windows 只會顯示警告。

## 指令

| 層 | 指令 | 功能 |
|---|---|---|
| 專案 | `init [-y]` | 建立 home 與全域 agent 庫。 [詳細](docs/commands.zh-TW.md#init) |
| 專案 | `project add <name> --dir <repo>` | 註冊專案。 [詳細](docs/commands.zh-TW.md#project-add) |
| 專案 | `project` / `project remove <name> [--purge]` | 列出或取消註冊專案。 [詳細](docs/commands.zh-TW.md#project-and-project-remove) |
| 診斷 | `doctor [-p name] [--task-file f] [--resolved] [--json]` | 不執行 agent，檢查設定（含防護等級）、git、鎖與 runtime CLI；`--resolved` 印出每項生效設定與其來源。 [詳細](docs/commands.zh-TW.md#doctor) |
| 診斷 | `status [-p name] [--monitor]` | 顯示 agent、信件、目前執行與歷次 run（支援 `--json`、`--monitor`）；`--task-id` 接受 id、名稱或唯一前綴。 [詳細](docs/commands.zh-TW.md#status) |
| 執行 | `run ["task"] [--task-file f] [--name n] [--agent a] [-p name]` | 把任務交給 lead 並執行到結束；`--name` 為 run 命名；加 `--agent` 則只交給某個成員單獨做。 [詳細](docs/commands.zh-TW.md#run) |
| 執行 | `resume [run] ["追加要求"] [--task-file f] [--answer] [-p name]` | 接續被中斷或失敗的 run，或用追加要求重開已完成的 run；`--answer` 會先回答它等待中的問題。 [詳細](docs/commands.zh-TW.md#resume) |
| 執行 | `clear <run> [-p name] [--dry-run] [--keep-worktrees]` / `clear --lock [run-id] --force` | 刪除 run（id、名稱或唯一前綴）與其任務記憶、worktree；或移除當機 run 留下的專案鎖。 [詳細](docs/commands.zh-TW.md#clear) |
| 執行 | `call <agent> ["task"] [--task-file f] [--dir d]` | 單獨呼叫一個 global agent（不需專案），印出它的回答。 [詳細](docs/commands.zh-TW.md#call) |
| 執行 | `tidy [-p name] [--agent a] [--layer project\|global] [--dry-run]` | 讓 agent 整理自己的記憶（只能手動觸發；封存而非刪除）。 [詳細](docs/commands.zh-TW.md#tidy) |
| 執行 | `tidy --undo <時間戳> -p name --agent a` | 還原一次整理：把封存的檔案搬回。 [詳細](docs/commands.zh-TW.md#tidy) |

`agent-lyceum --help` 只列出每個指令的一行簡述；`agent-lyceum <指令> --help` 會印出該指令的完整說明與選項。

Ctrl-C 會乾淨地取消 run，之後可用 `resume` 接續（[中止 run](docs/commands.zh-TW.md#中止-run)）。`run`／`resume` 只有在 lead 回報 `completed` 時才 exit `0`；`partial`／`blocked` 為 `2`，`failed` 為 `1`，等待你回答時為 `3`，取消為 `130`（[退出碼](docs/commands.zh-TW.md#退出碼)）。未指定 `-p` 時，專案由目前目錄推斷（[選擇專案](docs/commands.zh-TW.md#選擇專案)）。

## 單獨呼叫一個 agent

有兩種方式把任務只交給單一 agent，而不是整個團隊。該 agent 獨自工作：不能寄信給隊友、不能向你提問、不能修改任何 `AGENT.md`。

```bash
npx agent-lyceum run "整理表單" --agent fe-member -p web   # 專案裡的一個成員，當作一般 run
npx agent-lyceum call pm "這個需求可以開工了嗎？" --dir ~/code/web-app   # global agent，不屬於任何專案
```

`run --agent` 有 run id 與專案鎖、會出現在 `status`、可以 `resume`；agent 用自己寄出的 `done` 結束 run。`call` 完全不需要專案：agent 取自 `team.yaml`，在 `--dir`（預設是目前目錄，且不可位於 agent-lyceum home 之內或之上）工作，stdout 只印它的最終回答，並在 `<home>/calls/<call-id>/` 留下 `task.md`、`log/` 與 `result.md`。細節見 [run](docs/commands.zh-TW.md#run) 與 [call](docs/commands.zh-TW.md#call)。

## 監控 mod（Claude Code）

`plugins/status-monitor` 是 Claude Code **mod**，不是一般的 plugin：它依 Claude Code 的 mod hooks API 撰寫（`import type { Register } from 'claude-code'`），在 Claude Code session 內執行，提供通知與 `/status-monitor` 面板，並輪詢 `agent-lyceum status --json`。需要支援 mod 的 Claude Code 版本；不會改變 agent-lyceum 本身的運作。會顯示一個或多個專案的即時執行狀態。

**載入。** 先 build（`npm run build`；mod 會執行 `dist/cli.js`），再用下面的指令啟動 session：

```
claude --plugin-dir /path/to/agent-lyceum/plugins/status-monitor
```

`--plugin-dir` 只在 session 啟動時生效，已開著的 session 要重開（`claude --resume --plugin-dir ...` 可保留對話）。想每次都載入，就在 shell rc 加 `alias claude='claude --plugin-dir /path/to/agent-lyceum/plugins/status-monitor'`；無法帶參數的環境（桌面 app、SDK）則把 `CLAUDE_CODE_PLUGIN_DIRS` 設成 mod 資料夾。session 執行中儲存 mod 資料夾內的檔案會自動 hot reload。

**操作。**
- **通知：** 執行完成、被中斷或某個 agent 喚醒失敗時會跳出訊息（監看多個專案時前面加 `[專案名]`），不需要任何操作。
- **`/status-monitor`：** 輸入即開啟面板（已開著則關閉）。session 啟動時預設不開，除非設定 `autoOpen`。在 **fullscreen 版面**（`~/.claude/settings.json` 設 `"tui": "fullscreen"` 後重開 session；`/tui fullscreen` 效果相同）且終端寬度 110 欄以上時，面板會靠右 dock 在終端寬度的一半，分頁與 **關閉** 都可以用滑鼠點。否則顯示在輸入框上方；版面在 session 啟動時就固定，從主畫面啟動的 session 不會變。鍵盤操作兩種版面都能用：`x` 關閉，`v` 切換圖形／文字，`1`-`9` 或 Tab/Enter 切換任務，Esc 回到輸入框，再執行一次指令也會關閉。面板為每個 agent 畫一個區塊，並依 `can_message` 在 lead 與各成員之間畫出連結（`▼` lead 可寄給成員、`▲` 成員可寄給 lead、`↕` 雙向；黃色表示最近一次寄信的那條邊）。每個區塊顯示該 agent 現在在做什麼、正在處理與排隊中的信（依信種整理成可讀的重點：task 看目標與驗收，reply 看變更、驗證、待辦與風險，done 看結果與未完成），以及喚醒次數與輸出 token。正在運作的 agent 會被放大：它的區塊獨佔一整列、使用全寬，文字自動換行而不截斷，正在處理的那封信完整顯示（每個段落的每一行）；閒置與排隊中的區塊維持精簡。圖形上方是執行 id 與狀態、任務、進度條與清單；下方是受阻的整合、備註與結果摘要。按 `v` 切換成純文字清單（各 runtime 的 token、各 agent 統計、最近 8 次喚醒）。每個區塊以「→」一行列出它可以寄信的對象，最近一次寄信的對象標 「●」（成員之間的對象也在此，不畫符號）。當圖形區域寬度少於 70 欄（以面板本身的寬度比較，由 host 回報），區塊改成單欄堆疊，不畫連結符號。每個執行中的任務是一個分頁，最新的排最前面；已結束或已中斷的不列出。面板開著時會依輪詢間隔自動更新。

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
    ├── locks/<run-id>.json           # 該 run 執行期間持有（同時最多 dispatcher.max_concurrent_runs 個）
    ├── task-memory/<run-id>/{<agent>/, _shared/}   # 任務記憶：每次 run 獨立，不與其他任務共用；_shared 是 lead 為追加要求寫的交接筆記
    └── runs/<run-id>/{task.md, log.jsonl, state.json, result.md, done-<n>.md, followups/<n>.md, snapshots/, agents/, mail/{inbox,outbox}/<agent>/}
```

`team.yaml` 定義可重複使用的 agent；`project.yaml` 選擇團隊並覆寫欄位。物件會逐欄位合併，陣列（`can_message`、`owns`）則整個取代。相對路徑以寫入該路徑的檔案所在資料夾為基準；允許使用 `~`。

```yaml
# project.yaml
dir: ~/code/web-app
team: { lead: lead }
dispatcher: { max_rounds: 30, max_parallel: 1, max_concurrent_runs: 1, wake_timeout_sec: 600, retry: 1, strict: false, workspace_mode: auto, log_max_bytes: 8388608 }
agents:
  lead:      { resume: true, can_message: all, can_edit_agent_md: true }
  fe-member: { runtime: codex, can_message: [lead], owns: ["src/web/**"] }
  qa-member: { can_message: [lead], owns: ["tests/**"] }
  pm:        { can_message: [lead], allow_web: fetch }   # pm 可以搜尋並讀網頁；其他人沒有網路工具
```

Agent 欄位：`runtime`（`claude-code`|`codex`；若 `model` 可辨識則可省略：`opus`/`sonnet`/`haiku`/`claude-*` → Claude Code，`gpt-*`/`o3`/`*codex*` → Codex；優先順序：專案 runtime > 專案 model > 全域 runtime > 全域 model）、`model`、`effort`（Claude Code：`low`|`medium`|`high`|`xhigh`|`max`，經 `--effort`；Codex：`minimal`|`low`|`medium`|`high`|`xhigh`，經 `model_reasoning_effort`；未設則用 CLI 預設）、`agent_md`、`memory.global` / `memory.project`、`resume`、`can_message`（`all` 或清單；預設 `[lead]`，lead 預設 `all`）、`can_edit_agent_md`（預設只有 lead）、`can_ask_user`（可用 `type: ask` 信件向你提問並暫停 run 等待回答；預設只有 lead）、`allow_web`（`none`|`search`|`fetch`：agent 可以使用多少網路，不設就是不開；見下方「網路存取」）、`owns`（repo glob）。

`doctor` 檢查的規則：至少 2 個 agent（lead 加一位成員；範本預設是三位）、lead 在 agent 清單內、每個 agent 都有 runtime（明設或由 `model` 推斷）且 `AGENT.md` 存在、`effort` 對該 runtime 合法（若 `runtime` 與可辨識的 `model` 矛盾則警告）、`can_message` 的目標存在、記憶資料夾互不重疊，且當 `max_parallel > 1` 時，每個非 lead 的 agent 都必須有互不重疊的 `owns`，repo 也必須是 git repository；而 `max_concurrent_runs > 1` 時，repo 必須是 git repository，且 `workspace_mode` 不能是 `shared`。

## 一次執行如何運作

1. 任務（文字，或 `--task-file` 的唯讀副本 `runs/<id>/task.md`）會成為寄給 lead 的第一封信。≤ 16 KB 的任務直接內嵌，更大的改以引用方式傳遞。超過 1 MB 的檔案會被拒絕。
2. dispatcher 用 `claude -p` 或 `codex exec`（headless）喚醒有未讀信件的 agent。除非設定 `resume: true`，否則每次喚醒都是全新的 session。
3. 每次喚醒的 prompt 都包含：該 agent 的 `AGENT.md`、團隊協定、`COMMON.md`（唯讀，≤ 8 KB）、每個記憶資料夾的 `MEMORY.md` 索引、**最舊**一封未讀信件全文（每次喚醒只處理一封；lead 例外，會一次拿到連續最多 5 封 `reply`/`failure` 並一併決策），以及排隊中信件的標題；排隊的信維持未讀，等各自的喚醒再處理。
4. agent 寄信的方式，是在**自己的** `outbox/` 寫一個含 frontmatter（`to`、`type`、`subject`）的 Markdown 檔。dispatcher 會檢查 `can_message`、蓋上真正的寄件者，並移到收件者的 `inbox/`。處理完的信件移至 `inbox/<agent>/read/`。信箱屬於單一 run（`runs/<run-id>/mail/`），信件不會跨 run。舊版本啟動的 run 繼續使用共用的 `shared/{inbox,outbox}/` 信箱（信件不會被搬移），接續這類 run 時會沿用舊版配置。
   每封 `task` 和 `reply` 的內文應包含固定的 `##` 標題（會注入每個 agent 的 prompt）：`task` → `Goal`、`Acceptance criteria`、`Scope`、`Upstream`；`reply` → `Changes`、`Verification`、`Open items`、`Risks`（沒內容就寫 `None`；`done` 免檢）。缺標題的信仍會送達，但開頭會加上警告說明，run log 也會記一筆 `format-warning`。
5. 結束條件：lead 寄出 `type: done`、所有信箱都空了，或喚醒次數達到 `max_rounds`。`done` 的 frontmatter 必須有 `outcome: completed|partial|blocked|failed`，內文要有 `## Result`、`## Files`、`## Verification`、`## Not done`；`completed` 還要求 `## Steps` 全部勾選。不符合的 `done` 會退回給 lead（最多兩次，之後以 `partial` 收下）。agent-lyceum 不會驗證 lead 回報的內容是否屬實。喚醒失敗會重試一次，之後以失敗訊息通知 lead（若 lead 本身失敗，則整個 run 中止）。

平行執行（`max_parallel > 1`）只會同時跑 `owns` 互不相交的 agent，且絕不與 lead 同時執行。此時每個非 lead 的 agent 都在**自己的 git worktree**（`projects/<name>/worktrees/<run-id>/<agent>`，branch `agent-lyceum/<run-id>/<agent>`）工作；worktree 是從喚醒當下 repo 的快照（`refs/agent-lyceum/<run-id>/base-<n>`，包含 lead 尚未提交的修改與新增、未被 ignore 的檔案）切出來的，你的 HEAD、branch 與工作目錄都不會被動到。`dispatcher.workspace_mode` 可設為 `auto`（`max_parallel > 1` 時用 worktree）、`worktree` 或 `shared`；`shared` 不能與平行 agent 並用。平行 run 在 repo 有你自己未提交的修改時，或 repo 不是 git repository 時，會拒絕啟動（請改為序列執行）。成員完成後，dispatcher 會提交它 worktree 中的修改，並在 lead 讀到該成員的信之前，把變更套用到你的工作目錄（不動你的 index 與 HEAD）。每個被改動的路徑都會先檢查：必須在該成員的 `owns` 內（rename 與刪除也算）、不得是 `CLAUDE.md`／`AGENTS.md`，symlink 不得指向專案或該成員 `owns` 之外。若同一檔案在成員的快照之後又在你的 repo 被改過、檢查未通過，或 `git apply` 失敗，就一個檔案都不套用：成果保留在它的 branch 與 worktree，報告與 patch 寫到 `runs/<run-id>/integration/`，並通知 lead，且這個 run 不能以 `completed` 結束（會以 `blocked` 結束）。worktree 只隔離檔案，無法隔離對外部服務、資料庫或網路的副作用。

### 同時執行多個 task

預設一個專案一次只跑一個 task。設定 `dispatcher.max_concurrent_runs: N`（N > 1，需要 git repository）後，同一專案最多可有 N 個 run 同時進行；再多開一個會被拒絕，並列出擋住的 run。此模式下**每個** run（包括沒有平行成員的 run，以及單獨的 `run --agent <name>`）都在自己的 git worktree 工作：lead 在 `projects/<name>/worktrees/<run-id>/<lead>`、branch 為 `agent-lyceum/<run-id>/<lead>`，成員的 worktree 則從 lead 的內容分出。run 從你 repo 的 `HEAD` 起跑，所以允許你有未提交的修改，但這些修改**不會**在其中（啟動訊息會寫出有幾個檔案）。你的工作目錄、index 與 HEAD 一律不會被動到。

- **結束：** run 結束時（done、cancelled、failed、idle 或達到輪數上限），lead 的成果會一次提交在它的 branch 上，並寫成 `runs/<run-id>/lead.patch`，run 會印出 `git merge <branch>`。停下來向你提問（`waiting`）的 run 還沒結束：不會提交、也不會印 merge 提示；成果留在 lead 的 worktree，`resume` 會在同一個 worktree 繼續。
- **啟動時決定：** run 會在狀態中記錄 lead 是否在 worktree 工作（`lead_workspace`）。`resume` 沿用 run 啟動時的方式，而不是看目前的設定：以併發模式啟動的 run，即使你之後調低 `max_concurrent_runs`，仍會在它的 worktree 接續；以非併發模式啟動的 run，即使你之後調高，仍以非併發方式接續。這個設定只決定同時可有幾個 run，以及新的 run 怎麼做。
- **`tidy`：** `tidy` 與 `tidy --undo` 需要獨占專案：有任何 run 在執行時會拒絕，執行期間也不能啟動任何 run，與 `max_concurrent_runs` 的值無關。
- **`clear`：** lead 的 branch 尚未合併時，`clear <run-id>` 會拒絕（用 `--keep-worktrees` 可保留它）。當機 run 留下的鎖用 `clear --lock [run-id] [-p name] --force` 移除；有多把鎖時要指定是哪個 run。

已知限制：

- agent 程序數量最多可達 `max_concurrent_runs × max_parallel`，沒有全域上限。
- `can_edit_agent_md: true` 的 lead 修改的是它自己 worktree 裡的 `CLAUDE.md`／`AGENTS.md`；這些修改要等你合併它的 branch 才會進到你的 repo。
- `COMMON.md` 與各 `AGENT.md` 由專案的所有 run 共用。每個 run 的防護只判斷它自己的 agent 工作期間發生的修改，所以某個 run 的修改會被保留；但若兩個 run 的喚醒時間重疊，一個 run 在另一個 run 的 agent 工作期間所做的修改，可能被另一個 run 還原。
- 兩個 run 修改同一個檔案時，要由你在合併時自行整合；agent-lyceum 從不自動合併。

### 接續已完成的 run

每個 run 都有**名稱**：由 task 第一行產生（小寫字母、數字與 `-`，最多 30 字元；沒有可用字元時用 `task`；重複時加 `-2`、`-3`），或用 `run --name <name>` 指定（字元與長度限制相同；名稱已被使用會拒絕）。`resume`、`clear` 與 `status --task-id` 接受完整 run id、名稱，或兩者之一的唯一前綴；前綴有歧義時會列出候選並以 `1` 結束，空字串會被拒絕。`status` 會在 id 旁顯示名稱。

已完成（`done`）的 run 可以用追加要求重開：`agent-lyceum resume [run] "<追加要求>"`（或 `--task-file f`）。lead 會把這段文字當成新的 `task` 收到，run 沿用同一個 run 目錄、任務記憶、session 與 lead 的 worktree 繼續。

- **哪些 run：** 只有已完成的 run 能重開。仍在執行的 run 會拒絕；尚未完成的 run 若帶文字也會拒絕（先不帶文字 resume 它）。不帶文字時行為不變：已完成的 run 只印出結果。沒指定 run 時，候選是已完成的 run，由新到舊：剛好一個就用它，沒有就報錯，有多個就列出（在終端機可用編號或名稱選；非互動環境則報錯並列出候選）。只有一個參數時，只有在它不可能是 run 參照（含空白，或含 run 名稱不能用的字元）才會被當成追加要求；單一個詞的追加要求要寫成 `resume <run> "<text>"` 或用 `--task-file`。
- **保留什麼：** 追加要求存成 `runs/<run-id>/followups/<n>.md`。每份 `done` 報告保留為 `done-<n>.md`，`result.md` 永遠是最新一份。`state.json` 新增 `name`、`reopened`、`round_floor`、`step_base`（都是選填，舊的 run 照樣能讀）。進度（`## Steps`）會接續：重開時的清單保留，lead 為追加要求列的步驟接在後面（再次列出的舊步驟只更新勾選狀態）；追加要求的 `completed` 只要求它自己的步驟全部勾選。未解決的 blocked integration 會保留；每段重開的 done 規範提醒重新計算。
- **輪數上限：** `max_rounds` 從重開時起算：`rounds` 持續累加，上限是重開當下的輪數加 `max_rounds`。
- **lead 的 branch**（lead 有 worktree 的 run）：若該 branch 已合併進你的 `HEAD`，且 lead 的 worktree 乾淨、自 run 結束後沒被動過，worktree 與 branch（同名，`agent-lyceum/<run-id>/<lead>`）會從你目前的 `HEAD` 重新切出，並印一行說明。否則沿用原本的 worktree 與 branch。若已記錄 PR（`pr_url`）且 branch 沒有重切，新的 `open_pr: true` 只會 push（「pull request updated」），而且只在該 PR 仍開啟時；若它已被合併（含 squash merge）或關閉，就改開一個新的 PR；若 branch 重切了，已記錄的 `pr_url` 會被清掉（舊網址留在 run 的 notes），要求時再開一個新的 PR。agent-lyceum 仍然從不合併。
- **交接筆記：** lead 在送 `done` 之前，把追加要求會用到的內容寫進 agent-lyceum home 裡的 `task-memory/<run-id>/_shared/`（`MEMORY.md` 為索引）：做過的決定與理由、介面約定、目前狀態、剩下的事與下一步、踩過的坑。成員可讀不可寫（用 `run --agent` 啟動的 run 只有一個 agent，它就是自己的 lead，所以可寫；`call` 沒有這個資料夾）。run 重開後，每個 agent 的每次喚醒都在 prompt 裡拿到 `MEMORY.md`（前 8 KB，較長的索引會被截斷並標示），重開的 `task` 信的 `Upstream` 也會指向它；第一段的 prompt 不含它。若 lead 在該段沒有更動 `MEMORY.md` 就送出 `done`，run 不會被擋，只會在 run 的 notes 加一筆 `shared-not-updated`。`clear` 會連同任務記憶一併刪除；`tidy` 不會動它。只放這個 task 的筆記，跨 task 的教訓仍放 project 或 global memory。

### 開 PR

當你的 task 要求開 PR 時，lead 會在它的 `done` 報告的 frontmatter 加上 `open_pr: true`。如果 run 之後以 `completed` 結束，且 lead 的 branch 有變更，就由 agent-lyceum（不是 agent）把 `agent-lyceum/<run-id>/<lead>` 推到 `origin`，並對 repo 的預設分支執行 `gh pr create`，以 lead 的報告作為描述（結尾為 `🤖 Opened by agent-lyceum`）。run 的結果會印出 PR 網址，`state.json` 也會把它記為 `pr_url`。只有 lead 能提出要求：其他人都不能送出 `done`，也沒有任何 agent 的沙箱被放寬——`git push` 與 `gh` 在沙箱外以你自己的憑證執行。

- 它需要 lead 的 branch，所以只有在 run 有自己的 worktree 時（`dispatcher.max_concurrent_runs` 為 2 或以上）才有作用。否則這個要求會被回報並略過。
- 無法照辦的要求（run 沒有完成、沒有變更、沒有 `gh`、沒有 `origin`、push 或 `gh` 失敗）絕不會改變 run 的結果。run 會說明沒有開的原因並保留 branch；push 或 `gh pr create` 失敗時，還會印出可手動完成的指令。
- 開 PR 會把 lead 的 branch 與報告發布到 `origin`。因此，提出要求（`open_pr: true`）的 agent 能把它在沙箱內讀得到的任何東西送上遠端，所以只有在可以接受這件事時，才在 task 裡要求開 PR。push 與 `gh pr create` 從你的主 repo 執行，絕不在 agent 的 worktree 裡執行，因為 agent 能寫入那個目錄。
- agent-lyceum 從不合併，也不等待 CI 或審查。`max_concurrent_runs` 為 2 以上時，`doctor` 會告訴你有沒有 `gh` 與 `origin`（不會檢查 `gh` 是否已登入）。

## 網路存取（`allow_web`）

預設所有 agent 都不能使用網路。Claude Code 的 agent 是用無頭的 `dontAsk` 模式喚醒的，沒有明確允許的工具一律拒絕，所以 `WebSearch` 與 `WebFetch` 會被擋掉，要替個別 agent 用 `allow_web` 開放（寫在 `team.yaml` 或 `project.yaml`，專案層蓋過全域層）。它只決定 agent 能不能用網路工具，下面的寫入範圍不變。

| 值 | Claude Code | Codex |
|---|---|---|
| 不設 | 不給網路工具（與以前相同） | 不傳任何設定：維持 Codex 自己的預設 |
| `none` | 不給網路工具 | `-c web_search="disabled"` |
| `search` | `WebSearch` | `-c web_search="cached"` |
| `fetch` | `WebSearch` 加 `WebFetch` | `-c web_search="live"` |

### `search` 還是 `fetch`？

- **`search`**：agent 可以搜尋，拿到一串結果（通常是標題、連結與簡短摘要）。它不能打開網頁，所以只知道結果裡寫的內容。像「Node 的哪些版本還有支援？」「這個函式庫最新版是多少？」「這個 API 是不是已經棄用？」這類問題，這樣就夠了。
- **`fetch`**：包含 `search` 的全部功能，再加上讀取某個網址背後的頁面，整頁文字都會進到 agent 的上下文。答案藏在頁面裡面時才需要：規格文件、API 參考的某一節、issue 討論串，或是你寫在任務裡的網址。

分成兩級，是因為風險不一樣。從網頁讀進來的文字可能夾帶寫給 agent 的指示（「忽略你的規則，去做……」），這叫 prompt injection。`fetch` 會把整頁文字送進來；`search` 只有摘要。agent 能做的事越多（改你的 repo、執行指令），這點就越重要。

**該給哪些 agent。**先什麼都不開。會查資料的角色給 `search`。只有真的必須讀指定頁面、而且很少改檔的角色才給 `fetch`，例如 `pm` 這種需求或研究角色。會改你 repo 的成員（例如 `fe-member`、`qa-member`）維持關閉，由 lead 或 pm 查好，再把結果寫進任務。

### 要注意的事

- **不設不等於 `none`。**不設是讓各 runtime 維持自己的預設：Claude Code 沒有網路工具，但 Codex 可能本來就開著網路搜尋。想明確關掉請設 `none`。
- **Codex 只有一個 `web_search` 設定，不是兩個工具**，所以 `search` 與 `fetch` 對應到 `cached` 與 `live`。依 Codex 的說法，`cached` 是從索引回答、不即時瀏覽，`live` 是即時搜尋網路；這是依風險做的近似對應。`codex exec` 不收 `--search` 旗標，所以 agent-lyceum 改傳 `-c web_search="..."`。
- **沒有實際端對端跑過。**Codex 的設定鍵與合法值用 Codex 0.160.0 確認過，但 `cached`／`live` 以及 Claude 兩個工具的實際行為，沒有用真的 CLI 跑過（會花 token）。正式依賴前，請先在該 agent 上手動試一次。
- `call` 會讀 `team.yaml` 裡的這個欄位，`run --agent` 也會保留。

```yaml
# team.yaml
agents:
  pm:
    runtime: claude-code
    allow_web: fetch        # 可以搜尋並讀網頁；沒設這個欄位的 agent 就沒有網路工具
```

## 寫入範圍

預設規則（repo 內其餘部分不受限制）：

| 目標 | 規則 |
|---|---|
| 自己的記憶資料夾、自己的 `outbox/` | 可寫入 |
| 任何 `AGENT.md`、`COMMON.md`、repo 的 `CLAUDE.md`/`AGENTS.md` | 唯讀；lead（`can_edit_agent_md`）可編輯 |
| run 的交接筆記 `task-memory/<run-id>/_shared/` | lead 可寫；其他 agent 唯讀 |
| 其他 agent 的記憶／inbox／outbox、`runs/`、設定檔 | 不可寫入 |

由於沒有單一機制是完整的，防護採分層設計：

- **Claude Code**：每次執行帶入 `--settings`，內含 `Edit(...)` 規則，**加上** OS 沙箱（`allowWrite`/`denyWrite`、`allowUnsandboxedCommands: false`）。沒有沙箱時，`python -c` 之類的做法能繞過 Edit 規則，因此 `os` 等級必須啟用沙箱。
- **Codex**：`-s workspace-write` 搭配 `-c sandbox_workspace_write.writable_roots=[...]`（由 OS 強制）。Codex 無法禁止 repo 內的單一檔案，所以 repo 的 `CLAUDE.md`/`AGENTS.md` 只能靠**事後偵測**保護。
- **所有 runtime**：執行前會對受保護檔案做雜湊；每次喚醒後，未經授權的變更會被還原、記錄，並通報 lead；被寫入的內容會先留存在 `runs/<run-id>/violations/`。

`doctor` 與 `run` 會依類別（`os`、`tool-rules`、`post-hoc`、`prompt-only`）印出每個 agent 的防護等級，以及它能寫入 repo 之外的哪些路徑。設定 `dispatcher.strict: true` 時，除非記憶、`AGENT.md`、其他 agent 的 context 與（非 lead 的 agent 的）交接筆記都由 OS 強制保護，否則拒絕執行。

agent worktree 內的 git:agent 能寫它 worktree 的 `.git` 指標檔與私有 git 目錄,可能讓 git 去讀 agent 埋的設定或 hook。因此 dispatcher 對 agent worktree 的每一次 git 呼叫,都釘住 worktree 建立當下記錄的 git dir、common dir 與 work tree,關閉 hook、fsmonitor、external diff 與 textconv,並拒絕使用 git 檔案被改向或連到別處、HEAD 不是它自己的分支、或內含巢狀 repository 的 worktree。Claude 另外不得寫那幾個指標檔(`denyWrite`);Codex 無法禁止單一檔案,只靠釘住。殘留風險列在 [spec 15](docs/specs/15-worktree-git-isolation.md#156-殘留風險)。這**不**表示 dispatcher 絕不會執行 agent 埋下的程式碼。使用 `reftable` ref 後端的 repository 在 worktree 模式下會被拒絕。

已知缺口：Claude Code 內建的 Edit/Write 工具不在沙箱內（由 `Edit` 規則涵蓋）；Codex 的 MCP 工具與 hooks 在其沙箱之外執行；`--dangerously-bypass-approvals-and-sandbox` / `danger-full-access` 會停用所有防護。啟用 `can_edit_agent_md` 時，Codex lead 的可寫根目錄會擴大到整個 agent 目錄。
