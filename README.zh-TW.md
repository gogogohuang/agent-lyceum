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
| `init [-y]` | 建立 home 與全域 agent 庫（`lead`、`fe-member`、`qa-member`）。建立預設路徑前會先詢問。 |
| `project add <name> --dir <repo>` | 註冊專案：建立 `projects/<name>/project.yaml`、共用資料夾與 `COMMON.md`。 |
| `project list` / `project remove <name> [--purge]` | 列出專案／取消註冊（除非加 `--purge`，否則保留 context）。 |
| `validate [-p name] [--task-file f]` | 驗證合併後的設定，並印出每個 agent 的防護等級。有錯誤時 exit 1。 |
| `run ["task"] [--task-file f] [-p name]` | 把任務交給 lead，並執行 dispatcher 直到完成。任務文字與 `--task-file` 擇一提供。 |
| `resume [run-id] [-p name]` | 接續被中斷或失敗的 run（每次 `run` 都是獨立任務；不指定 id 時接續最新一個尚未結束且未在執行的 run，指定 id 則接續該任務）：沿用同一個 run 目錄、session 與輪數，不會重送任務，未讀信件會重新處理。run 仍在執行時會拒絕。對已完成（done）的 run 不會繼續任何工作：只印出已記錄的結果狀態與內容，並以該結果對應的碼結束（`0` completed、`2` partial／blocked、`1` failed；在記錄結果狀態之前就結束的舊 run 視為未驗證的 `partial`，回傳 `2`）。因閒置或達 `max_rounds` 而結束的 run，除非補上新信件，否則已沒有未讀信件，接續後會再次以閒置結束（回傳 `2`）。 |
| `status [-p name] [--monitor]` | 顯示 agent、未讀信件、目前正在執行的 agent（耗時、處理中的信件）、上次執行（任務來源、輪數、結束原因、output token 數）。不帶 `--monitor` 時會一併印出最新 run 的完整 wake 紀錄；`--monitor` 會常駐並持續更新，每個 run 只顯示最新三筆 wake。`--task-id <id>` 印出單一任務的完整內容（每次 wake、結果、log 目錄）。`--task-list [project]` 列出專案所有任務（run）的 id、狀態、輪數與任務內容，id 可直接給 `resume` 使用。加上 `--json` 會把同一份報告以 JSON 輸出（`schema_version: 1`、無顏色，stdout 只有 JSON；錯誤走 stderr 並以非零 exit code 結束），可搭配 `--task-list`、`--task-id`。文字與 JSON 由同一份報告產生。 |
| `clear <run-id> [-p name] [--dry-run] [--keep-worktrees]` | 依 id 刪除一個任務（run）：它的 run 目錄（狀態、log、結果、信箱）、**任務記憶**，以及各 agent 的 git worktree、branch 與快照 ref。全域與專案層（長期）記憶一律不會動。run 仍在執行，或有 worktree 內的成果不在你的 repo 裡（未提交，或已提交但尚未整合進來）時會拒絕且什麼都不刪，並列出那些成果。`--keep-worktrees` 會保留 worktree 與 branch，其餘照樣清除。`--dry-run` 只列出會刪除與會保留的項目。絕不會順著 symlink 刪到專案 home 之外。進度會記在 `projects/<name>/cleanup/` 的 journal，所以中斷後重跑同一個指令即可完成。id 可用 `status --task-list` 查。 |
| `config show --resolved [-p name] [--json]` | 印出每一項生效的設定（全域 agent 庫、專案檔與預設值合併後的結果）與它的來源：檔案與 key、`default`，或在 runtime 是由 `model` 辨識出來時顯示 `inferred from <model 的 key>`。專案的值覆蓋全域；清單（`can_message`、`owns`）是整個取代而非合併；相對路徑以寫它的那個檔案為基準解析。 |
| `doctor [-p name] [--json]` | 在不執行任何 agent 的前提下檢查環境：設定、git（平行 run 需要）、專案鎖，以及各 runtime CLI 支援什麼（從 `--version` 與 `--help` 讀取：JSON 輸出、resume、sandbox 設定、effort，每項都是 `yes`、`no` 或 `unknown`）。只要團隊需要的功能被明確判定不支援就 exit 1。它不讀取憑證，登入狀態會回報為 unknown。`run` 與 `resume` 啟動前會先做同樣的能力檢查：明確 `no` 就拒絕啟動，`unknown` 則警告。要對真實 CLI 做端到端驗證（跑一個很小的任務）會花 token，刻意保留為手動。 |
| `unlock [-p name] --force` | 移除當機的 run 留下的專案鎖（同一專案同時只能有一個 run）。不加 `--force` 只會顯示鎖的持有者。 |

**中止 run：** Ctrl-C（或 SIGTERM）會乾淨地取消 run：執行中的 agent 先收到 SIGTERM，5 秒後 SIGKILL（連同整個子程序樹），未讀信件保留、專案鎖釋放，exit code 為 `130`；之後可用 `agent-lyceum resume` 接續。再按一次 Ctrl-C 會立刻結束。超過 `wake_timeout_sec` 的喚醒也以同樣方式停止，並算作一次失敗的嘗試。每次嘗試完整的 stdout／stderr 都寫在 `runs/<run-id>/mail/attempts/<attempt>/log/`，記憶體中每個串流只保留最後 64 KiB。

**`run`／`resume` 的 exit code：** `0` 只代表 lead 回報 `outcome: completed`；`2` 代表 `partial` 或 `blocked`（run 閒置或達到 `max_rounds` 而沒有 done 也算）；`1` 代表 `failed`（lead 本身失敗也算）；`130` 代表 `cancelled`。*升級注意：* 舊版 `idle` 結束會回傳 `0`、lead 失敗回傳 `2`；原本把 `0` 當成「run 結束了」的腳本，現在 `0` 的意思是「工作確實完成」。在記錄結果狀態之前就結束的舊 run 會顯示為「未驗證」（`partial`），不會被當成成功。

未指定 `--project` 時，會選用 `dir` 為目前目錄最長前綴的已註冊專案；若沒有符合的專案，指令會列出已註冊專案後停止。

## 監控 mod（Claude Code）

`plugins/status-monitor` 是 Claude Code **mod**，不是一般的 plugin：它依 Claude Code 的 mod hooks API 撰寫（`import type { Register } from 'claude-code'`），在 Claude Code session 內執行，提供狀態列、通知與 `/team-monitor` 面板，並輪詢 `agent-lyceum status --json`。需要支援 mod 的 Claude Code 版本；不會改變 agent-lyceum 本身的運作。會顯示一個或多個專案的即時執行狀態。

**載入。** 先 build（`npm run build`；mod 會執行 `dist/cli.js`），再用下面的指令啟動 session：

```
claude --plugin-dir /path/to/agent-lyceum/plugins/status-monitor
```

`--plugin-dir` 只在 session 啟動時生效，已開著的 session 要重開（`claude --resume --plugin-dir ...` 可保留對話）。想每次都載入，就在 shell rc 加 `alias claude='claude --plugin-dir /path/to/agent-lyceum/plugins/status-monitor'`；無法帶參數的環境（桌面 app、SDK）則把 `CLAUDE_CODE_PLUGIN_DIRS` 設成 mod 資料夾。session 執行中儲存 mod 資料夾內的檔案會自動 hot reload。

**操作。**
- **狀態列：** 載入後常駐（第一次輪詢前顯示 `team 讀取中…`，CLI 跑不起來時顯示 `team 無法取得狀態：…`），顯示執行狀態、輪數 `n/max`、output tokens、目前步驟與未讀信件。監看多個專案時顯示一行總覽（`team 1/3 執行中 · a ... | b ...`）。
- **通知：** 執行完成、被中斷或某個 agent 喚醒失敗時會跳出訊息（監看多個專案時前面加 `[專案名]`），不需要任何操作。
- **`/team-monitor`（別名 `/status-monitor`）：** session 啟動時面板會自動開啟（終端寬度需 144 欄以上才會顯示，狀態列不受影響）；也可輸入任一指令在任何寬度開啟。每個專案顯示：執行 id 與狀態、任務、進度與清單、正在工作的 agent 與排隊中的信件、受阻的整合、備註與結果摘要、各 runtime 的 output tokens、各 agent 的喚醒統計、最近 8 次喚醒。每個任務（專案目前的執行與最近 3 次過往執行）是一個分頁，點分頁即可切換。面板開著時會依輪詢間隔自動更新，只能點 **關閉** 收起（Esc 不會關閉）。

**設定。** 在 `~/.claude/settings.json` 的 `pluginConfigs."status-monitor@inline"`（`options`）：

| 選項 | 說明 | 預設 |
|---|---|---|
| `command` | 要執行的 CLI，以空白分隔，例如 `node /path/to/agent-lyceum/dist/cli.js` | `agent-lyceum` |
| `project` | 已註冊的專案名稱（`-p`）；用逗號分隔可同時監看多個；留空則依 session 所在目錄推斷 | 空 |
| `intervalSeconds` | 輪詢狀態的間隔（秒） | `1` |

設定變更要等下次啟動 session 才生效。面板若顯示 `無法取得狀態：...`，通常是 `command` 跑不起來（多半是還沒 build `dist/cli.js`），或專案名稱沒有註冊。

## 目錄結構

```
~/agent-lyceum-config/
├── team.yaml                         # 全域 agent 庫
├── agents/<agent>/{AGENT.md, memory/}  # 全域人設 + 跨專案記憶
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
dispatcher: { max_rounds: 30, max_parallel: 1, wake_timeout_sec: 600, retry: 1, strict: false, workspace_mode: auto }
agents:
  lead:      { resume: true, can_message: all, can_edit_agent_md: true }
  fe-member: { runtime: codex, can_message: [lead], owns: ["src/web/**"] }
  qa-member: { can_message: [lead], owns: ["tests/**"] }
```

Agent 欄位：`runtime`（`claude-code`|`codex`；若 `model` 可辨識則可省略：`opus`/`sonnet`/`haiku`/`claude-*` → Claude Code，`gpt-*`/`o3`/`*codex*` → Codex；優先順序：專案 runtime > 專案 model > 全域 runtime > 全域 model）、`model`、`effort`（Claude Code：`low`|`medium`|`high`|`xhigh`|`max`，經 `--effort`；Codex：`minimal`|`low`|`medium`|`high`|`xhigh`，經 `model_reasoning_effort`；未設則用 CLI 預設）、`agent_md`、`memory.global` / `memory.project`、`resume`、`can_message`（`all` 或清單；預設 `[lead]`，lead 預設 `all`）、`can_edit_agent_md`（預設只有 lead）、`owns`（repo glob）。

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
- **所有 runtime**：執行前會對受保護檔案做雜湊；每次喚醒後，未經授權的變更會被還原、記錄，並通報 lead。

`validate` 與 `run` 會依類別（`os`、`tool-rules`、`post-hoc`、`prompt-only`）印出每個 agent 的防護等級，以及它能寫入 repo 之外的哪些路徑。設定 `dispatcher.strict: true` 時，除非記憶、`AGENT.md` 與其他 agent 的 context 都由 OS 強制保護，否則拒絕執行。

已知缺口：Claude Code 內建的 Edit/Write 工具不在沙箱內（由 `Edit` 規則涵蓋）；Codex 的 MCP 工具與 hooks 在其沙箱之外執行；`--dangerously-bypass-approvals-and-sandbox` / `danger-full-access` 會停用所有防護。啟用 `can_edit_agent_md` 時，Codex lead 的可寫根目錄會擴大到整個 agent 目錄。
