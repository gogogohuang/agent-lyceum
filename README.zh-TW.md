# agent-team

[![npm version](https://img.shields.io/npm/v/@gogogohuang/agent-team)](https://www.npmjs.com/package/@gogogohuang/agent-team)

[English](README.md) | **繁體中文**

設定並執行一個由多個 **agent**（Claude Code 和／或 Codex）組成的團隊。agent 之間透過檔案信箱互相溝通，每個 agent 都有自己的人設（`AGENT.md`）與長期記憶資料夾。寫入權限有範圍限制：agent 只能修改自己的記憶與寄件匣（outbox），不能改動其他 agent 的 context，也不能改自己的人設。

此工具**絕不會寫入你的 repo**。所有內容都放在一個看得到的資料夾 `~/agent-team-config/`（可用 `AGENT_TEAM_HOME` 或 `--home` 覆寫）。

```bash
npx @gogogohuang/agent-team init                     # 建立 home 與全域 agent 庫
npx @gogogohuang/agent-team project add web --dir ~/code/web-app
npx @gogogohuang/agent-team validate --project web   # 檢查設定並顯示各項防護等級
npx @gogogohuang/agent-team run --task-file spec.md  # 在 repo 內執行時會自動偵測專案
npx @gogogohuang/agent-team status
```

安裝後的執行檔名稱為 `agent-team`。若要直接跑 GitHub 上尚未發佈的最新程式碼，可改用 `npx github:gogogohuang/agent-team <command>`。

需求：Node 20+，以及 `PATH` 中有 `claude` 和／或 `codex`（且已登入）。支援 macOS 與 Linux（Linux 需要 `bwrap` 才有 OS 沙箱）；Windows 只會顯示警告。

## 指令

| 指令 | 功能 |
|---|---|
| `init [-y]` | 建立 home 與全域 agent 庫（`lead`、`fe-member`、`qa-member`）。建立預設路徑前會先詢問。 |
| `project add <name> --dir <repo>` | 註冊專案：建立 `projects/<name>/project.yaml`、共用資料夾與 `COMMON.md`。 |
| `project list` / `project remove <name> [--purge]` | 列出專案／取消註冊（除非加 `--purge`，否則保留 context）。 |
| `validate [-p name] [--task-file f]` | 驗證合併後的設定，並印出每個 agent 的防護等級。有錯誤時 exit 1。 |
| `run ["task"] [--task-file f] [-p name]` | 把任務交給 lead，並執行 dispatcher 直到完成。任務文字與 `--task-file` 擇一提供。 |
| `resume [run-id] [-p name]` | 接續被中斷或失敗的 run（每次 `run` 都是獨立任務；不指定 id 時接續最新一個尚未結束且未在執行的 run，指定 id 則接續該任務）：沿用同一個 run 目錄、session 與輪數，不會重送任務，未讀信件會重新處理。run 仍在執行或已完成時會拒絕。 |
| `status [-p name] [--monitor]` | 顯示 agent、未讀信件、目前正在執行的 agent（耗時、處理中的信件）、上次執行（任務來源、輪數、結束原因、output token 數）。不帶 `--monitor` 時會一併印出最新 run 的完整 wake 紀錄；`--monitor` 會常駐並持續更新，每個 run 只顯示最新三筆 wake。`--task-id <id>` 印出單一任務的完整內容（每次 wake、結果、log 目錄）。`--task-list [project]` 列出專案所有任務（run）的 id、狀態、輪數與任務內容，id 可直接給 `resume` 使用。 |
| `clear <run-id> [-p name]` | 依 id 刪除一個任務（run）；仍在執行中會拒絕。id 可用 `status --task-list` 查。 |

未指定 `--project` 時，會選用 `dir` 為目前目錄最長前綴的已註冊專案；若沒有符合的專案，指令會列出已註冊專案後停止。

## 目錄結構

```
~/agent-team-config/
├── team.yaml                         # 全域 agent 庫
├── agents/<agent>/{AGENT.md, memory/}  # 全域人設 + 跨專案記憶
└── projects/<project>/
    ├── project.yaml                  # 團隊、repo 路徑、覆寫設定
    ├── agents/<agent>/{AGENT.md?, memory/}   # 專案層人設（選用）+ 專案記憶
    ├── shared/{common/COMMON.md, inbox/<agent>/, outbox/<agent>/}
    ├── task-memory/<run-id>/<agent>/   # 任務記憶：每次 run 獨立，不與其他任務共用
    └── runs/<run-id>/{task.md, log.jsonl, state.json, snapshots/, agents/}
```

`team.yaml` 定義可重複使用的 agent；`project.yaml` 選擇團隊並覆寫欄位。物件會逐欄位合併，陣列（`can_message`、`owns`）則整個取代。相對路徑以寫入該路徑的檔案所在資料夾為基準；允許使用 `~`。

```yaml
# project.yaml
dir: ~/code/web-app
team: { lead: lead }
dispatcher: { max_rounds: 30, max_parallel: 1, wake_timeout_sec: 600, retry: 1, strict: false }
agents:
  lead:      { resume: true, can_message: all, can_edit_agent_md: true }
  fe-member: { runtime: codex, can_message: [lead], owns: ["src/web/**"] }
  qa-member: { can_message: [lead], owns: ["tests/**"] }
```

Agent 欄位：`runtime`（`claude-code`|`codex`；若 `model` 可辨識則可省略：`opus`/`sonnet`/`haiku`/`claude-*` → Claude Code，`gpt-*`/`o3`/`*codex*` → Codex；優先順序：專案 runtime > 專案 model > 全域 runtime > 全域 model）、`model`、`effort`（Claude Code：`low`|`medium`|`high`|`xhigh`|`max`，經 `--effort`；Codex：`minimal`|`low`|`medium`|`high`|`xhigh`，經 `model_reasoning_effort`；未設則用 CLI 預設）、`agent_md`、`memory.global` / `memory.project`、`resume`、`can_message`（`all` 或清單；預設 `[lead]`，lead 預設 `all`）、`can_edit_agent_md`（預設只有 lead）、`owns`（repo glob）。

`validate` 檢查的規則：至少 3 個 agent、lead 在 agent 清單內、每個 agent 都有 runtime（明設或由 `model` 推斷）且 `AGENT.md` 存在、`effort` 對該 runtime 合法（若 `runtime` 與可辨識的 `model` 矛盾則警告）、`can_message` 的目標存在、記憶資料夾互不重疊，且當 `max_parallel > 1` 時，每個非 lead 的 agent 都必須有互不重疊的 `owns`。

## 一次執行如何運作

1. 任務（文字，或 `--task-file` 的唯讀副本 `runs/<id>/task.md`）會成為寄給 lead 的第一封信。≤ 16 KB 的任務直接內嵌，更大的改以引用方式傳遞。超過 1 MB 的檔案會被拒絕。
2. dispatcher 用 `claude -p` 或 `codex exec`（headless）喚醒有未讀信件的 agent。除非設定 `resume: true`，否則每次喚醒都是全新的 session。
3. 每次喚醒的 prompt 都包含：該 agent 的 `AGENT.md`、團隊協定、`COMMON.md`（唯讀，≤ 8 KB）、每個記憶資料夾的 `MEMORY.md` 索引、**最舊**一封未讀信件全文（每次喚醒只處理一封；lead 例外，會一次拿到連續最多 5 封 `reply`/`failure` 並一併決策），以及排隊中信件的標題；排隊的信維持未讀，等各自的喚醒再處理。
4. agent 寄信的方式，是在**自己的** `outbox/` 寫一個含 frontmatter（`to`、`type`、`subject`）的 Markdown 檔。dispatcher 會檢查 `can_message`、蓋上真正的寄件者，並移到收件者的 `inbox/`。處理完的信件移至 `inbox/<agent>/read/`。
   每封 `task` 和 `reply` 的內文應包含固定的 `##` 標題（會注入每個 agent 的 prompt）：`task` → `Goal`、`Acceptance criteria`、`Scope`、`Upstream`；`reply` → `Changes`、`Verification`、`Open items`、`Risks`（沒內容就寫 `None`；`done` 免檢）。缺標題的信仍會送達，但開頭會加上警告說明，run log 也會記一筆 `format-warning`。
5. 結束條件：lead 寄出 `type: done`、所有信箱都空了，或喚醒次數達到 `max_rounds`。喚醒失敗會重試一次，之後以失敗訊息通知 lead（若 lead 本身失敗，則整個 run 中止）。

平行執行（`max_parallel > 1`）只會同時跑 `owns` 互不相交的 agent，且絕不與 lead 同時執行。

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
