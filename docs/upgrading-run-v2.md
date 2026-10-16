# Upgrading to run format v2 / 升級到 run v2

English first, 繁體中文在後面。

## English

### What changed for a run

| | before (v1) | now (v2) |
|---|---|---|
| Run id | `20261006T101530Z` (second resolution) | `20261006T101530123Z-<32 hex>`: millisecond time plus 128 random bits; sorts by start time, cannot collide |
| `state.json` | free-form, cast without checks | `schema_version: 2`, validated; v1 files are still read (missing fields are filled in) |
| Mailboxes | shared by every run of the project: `shared/{inbox,outbox}/` | one set per run: `runs/<run-id>/mail/{inbox,outbox}/<agent>/`; every message carries `run_id`, mail never crosses runs |
| Running at the same time | a recorded pid only | one run per project, enforced by `projects/<name>/lock.json` (heartbeat, pid + start time) |
| Stop reason vs. result | `idle` and `done` both looked like success | `end_reason` (why it stopped) and `outcome` (how it went) are separate; only `completed` is success |

**Old runs keep working.** A run started by an older version is read as `schema_version: 1` with the *legacy* mailbox layout: it keeps using the shared `shared/{inbox,outbox}/` folders, and its mail is never moved (mail that cannot be attributed to a run stays where it is). Resuming it works as before. Its `done` has no recorded outcome, so it shows as `完成（未驗證）` and counts as `partial` (exit code 2): agent-lyceum will not present a result nobody checked as a success.

### Exit codes (this can break scripts)

`run` / `resume`: `0` = `completed`; `2` = `partial` or `blocked` (this now includes a run that went **idle** without a `done`, and a run stopped at `max_rounds`); `1` = `failed` (this now includes a failed **lead**, which used to be `2`); `130` = cancelled with Ctrl-C/SIGTERM. Before, `idle` exited `0` and a failed lead exited `2`. If a script treated `0` as "the run ended", it must now treat it as "the work was completed". `resume` on an already finished run prints its outcome and exits with the matching code.

### The completion contract

A lead's `done` mail must carry `outcome: completed|partial|blocked|failed` in its frontmatter and the headings `## Result`, `## Files`, `## Verification`, `## Not done`. `completed` also needs every `## Steps` checklist item ticked. Otherwise the mail goes back to the lead (at most twice) and is then kept as `partial`. If your lead's `AGENT.md` contains its own `done` template, update it. agent-lyceum records what the lead *says* it verified; it does not run the verification itself.

### Parallel runs and worktrees

- This section is superseded: parallel agents are no longer configured. See "Zero-config concurrency" below.
- Each non-lead agent still works in its own git worktree where a run has worktrees (see [How a run works](how-it-works.md#several-runs-at-once)).
- After a member finishes, its work stays on its branch `agent-lyceum/<run-id>/<agent>`; if two agents change the same file, the later one's change is refused, its branch is kept and the lead is told.
- A worktree isolates files only. It cannot isolate side effects on external services, databases or the network.
- How the old settings were removed and replaced: see "Zero-config concurrency" below.
- While a run with worktrees exists, agent-lyceum adds git bookkeeping inside your repository (`refs/agent-lyceum/...`, `agent-lyceum/...` branches, worktree entries). `agent-lyceum clear` removes them.

### Zero-config concurrency

- **Old keys:** `owns`, `dispatcher.max_parallel`, `dispatcher.max_concurrent_runs` and `dispatcher.workspace_mode` are removed, and so is `--ignore-limit`. Old keys still load but are ignored with a warning: `<file>: ignoring removed setting(s) <keys>. Concurrency needs no configuration now: in a git repo with a commit every run and every agent gets its own worktree. Delete these lines.` Delete those lines.
- **Git repo with a commit (default `files` ref storage):** every run works in its own worktree and ends on its own branch (`agent-lyceum/<run>/…`); members with pending mail wake in parallel, with no cap and never alongside the lead; any number of runs can be active. The result is not written into your working tree: use `git merge <branch>` or `open_pr`. The run starts from `HEAD` and does not see your uncommitted edits.
- **Non-git folder, repo with no commit, repo using reftable:** the run works directly in the folder, one agent at a time, with an info line instead of an error; only one such run can be active.
- **Conflicts:** if two agents change the same file, the later one's change is refused, its branch is kept and the lead is told. Changes that do not fit together across different files are not detected.
- **Before upgrading:** stop runs started by the old version.
- **Mixing old and new binaries:** while a new run works directly in the checkout, binaries ≥ 0.12.0 refuse everything with a message saying the run "needs the project to itself (a memory tidy or restore)"; that is expected, the wording is inexact but safe. Versions < 0.12.0 do not read `locks/` and are not covered.
- **Known limit:** if the old `max_concurrent_runs` was > 1, two older binaries can still both resume legacy shared runs and write the same checkout; that gap is in the old versions. Keep at most one old shared run during the switch.

### Recovery: what is and is not promised

Mail handling is **at least once**. After a crash or Ctrl-C, mail that was routed is not routed twice (deliveries are journaled), and an input message whose wake-up never finished is handled again. What an agent already did *outside its mailbox* (edited files, ran commands, pushed, called a service) is not undone and can happen again on the redo; the run's notes (`status --task-id`) say when that may have happened. A failed or interrupted attempt's outbox is set aside under `runs/<run-id>/mail/attempts/<attempt>/outbox/` and is never taken for the next attempt's result.

### New and changed commands

- `doctor [-p name] [--json]`: configuration, git, lock, and what each runtime CLI supports, read from `--version`/`--help` only (never runs an agent, never reads credentials). Capabilities are `yes`, `no` or **`unknown`**; `unknown` is a warning, an explicit `no` stops a run from starting. Login status is always reported as unknown.
- `config show --resolved [-p name] [--json]`: every effective setting and where it came from.
- `status --json` (also with `--task-list`, `--task-id`): `schema_version: 1`, no colour, only JSON on stdout, errors on stderr with a non-zero exit.
- `unlock [-p name] --force`: remove the run lock a crashed run left behind.
- `clear <run-id> [--dry-run] [--keep-worktrees]`: also removes the run's task memory and its worktrees, branches and snapshot refs; refuses (deleting nothing) while a worktree holds work that is not in your repo; never touches global or project memory; never follows a symlink out of the project home; an interrupted `clear` is finished by repeating it.
- Ctrl-C / SIGTERM cancel a run cleanly (the agents' whole process tree is stopped, unread mail is kept, the lock is released); `resume` continues it.
- A team now needs **at least 2 agents** (the lead and one member); it used to be 3.

### A real-CLI check

The test suite uses scripted stand-ins for `claude`. To check against the real CLIs, run `agent-lyceum doctor` (free). A full end-to-end trial with a tiny task spends tokens and is deliberately manual.

---

## 繁體中文

### run 的格式有什麼變化

| | 以前（v1） | 現在（v2） |
|---|---|---|
| run id | `20261006T101530Z`（只到秒） | `20261006T101530123Z-<32 位 hex>`：毫秒時間加 128 位元隨機值，依啟動時間排序、不會撞號 |
| `state.json` | 自由格式，不經檢查 | `schema_version: 2` 並驗證；v1 檔案仍可讀（缺的欄位會補上） |
| 信箱 | 同一專案所有 run 共用：`shared/{inbox,outbox}/` | 每個 run 各自一組：`runs/<run-id>/mail/{inbox,outbox}/<agent>/`；每封信帶 `run_id`，信件不會跨 run |
| 同時執行 | 只靠記錄的 pid | 同一專案只能有一個 run，由 `projects/<name>/lock.json` 保證（心跳、pid 加啟動時間） |
| 停止原因與結果 | `idle` 與 `done` 看起來都像成功 | `end_reason`（為何停止）與 `outcome`（結果如何）分開；只有 `completed` 才是成功 |

**舊的 run 仍然可用。** 舊版本啟動的 run 會被視為 `schema_version: 1`，使用*舊版*信箱配置：繼續用共用的 `shared/{inbox,outbox}/`，信件不會被搬移（無法判定屬於哪個 run 的信也留在原處）。接續方式與以前相同。它的 `done` 沒有記錄結果狀態，所以會顯示為「完成（未驗證）」並視為 `partial`（exit code 2）：agent-lyceum 不會把沒有人檢查過的結果當成成功。

### Exit code（可能影響你的腳本）

`run`／`resume`：`0` = `completed`；`2` = `partial` 或 `blocked`（現在也包含**閒置**結束而沒有 `done`，以及停在 `max_rounds` 的 run）；`1` = `failed`（現在也包含 **lead** 失敗，以前是 `2`）；`130` = 以 Ctrl-C／SIGTERM 取消。以前 `idle` 回傳 `0`、lead 失敗回傳 `2`。如果你的腳本把 `0` 當成「run 結束了」，現在 `0` 的意思是「工作確實完成」。對已經結束的 run 執行 `resume` 會印出它的結果狀態，並回傳對應的碼。

### 完成契約

lead 的 `done` 信 frontmatter 必須有 `outcome: completed|partial|blocked|failed`，內文要有 `## Result`、`## Files`、`## Verification`、`## Not done`；`completed` 還要求 `## Steps` 全部勾選。不符合的信會退回給 lead（最多兩次），之後以 `partial` 收下。如果你 lead 的 `AGENT.md` 自己寫了 `done` 範本，請一併更新。agent-lyceum 記錄的是 lead *宣稱*自己驗證了什麼，它本身不會執行驗證。

### 平行執行與 worktree

- 此段已被取代：平行 agent 不再需要設定，見下方「零設定並行」。
- 在有 worktree 的 run 裡，每個非 lead 的 agent 仍在自己的 git worktree 工作（見[一次執行如何運作](how-it-works.zh-TW.md#同時執行多個-task)）。
- 成員完成後，成果留在它的 branch `agent-lyceum/<run-id>/<agent>`；若兩個 agent 改了同一個檔案，後到者的變更會被拒絕、它的 branch 保留，並通知 lead。
- worktree 只隔離檔案，無法隔離對外部服務、資料庫或網路的副作用。
- 設定的移除與替代方式見下方「零設定並行」。
- 有 worktree 的 run 存在期間，agent-lyceum 會在你的 repository 內加入 git 管理資料（`refs/agent-lyceum/...`、`agent-lyceum/...` branch、worktree 登記），`agent-lyceum clear` 會移除。

### 零設定並行

- **舊鍵：** `owns`、`dispatcher.max_parallel`、`dispatcher.max_concurrent_runs`、`dispatcher.workspace_mode` 已移除，`--ignore-limit` 也已移除。舊鍵仍可載入，但會被忽略並警告：`<file>: ignoring removed setting(s) <keys>. Concurrency needs no configuration now: in a git repo with a commit every run and every agent gets its own worktree. Delete these lines.` 請刪掉這幾行。
- **有 commit 的 git repo（預設 `files` ref 儲存）：** 每個 run 在自己的 worktree 工作，結束在自己的 branch（`agent-lyceum/<run>/…`）；有待處理信件的成員會平行喚醒、沒有上限、絕不與 lead 同時；同時可有任意多個 run。結果不會寫進你的工作目錄，請用 `git merge <branch>` 或 `open_pr`。run 從 `HEAD` 起跑，看不到你未提交的修改。
- **非 git 資料夾、沒有 commit 的 repo、使用 reftable 的 repo：** run 直接在該資料夾工作、一次一個 agent，並以一行 info 取代錯誤；同時只能有一個這樣的 run。
- **衝突：** 兩個 agent 改了同一個檔案時，後到者的變更會被拒絕、它的 branch 保留，並通知 lead。不同檔案之間彼此不相容的修改不會被偵測到。
- **升級前：** 先停掉舊版的 run。
- **混用新舊版本：** 新版 run 直接在 checkout 工作期間，≥ 0.12.0 的舊 binary 會拒絕一切操作，訊息說它「needs the project to itself (a memory tidy or restore)」；這是預期行為，原因字樣不準但是安全。< 0.12.0 的版本不看 `locks/`，不在保證內。
- **已知限制：** 若舊設定的 `max_concurrent_runs` > 1，兩個舊 binary 仍可同時續跑舊的共用 run，並同時寫同一個 checkout；這是舊版既有缺口。切換期間舊版的共用 run 至多保留一個。

### 復原：保證什麼、不保證什麼

信件處理是**至少一次**。當機或 Ctrl-C 之後，已經投遞的信不會重複投遞（投遞有 journal），喚醒尚未完成的輸入信會被重新處理。agent 已經在*信箱之外*做過的事（改檔、執行指令、push、呼叫服務）不會被復原，重做時可能再發生一次；run 的備註（`status --task-id`）會說明哪些情況可能已發生。失敗或被中斷的嘗試所留下的 outbox 會被收進 `runs/<run-id>/mail/attempts/<attempt>/outbox/`，絕不會被當成下一次嘗試的成果。

### 新增與變更的指令

- `doctor [-p name] [--json]`：檢查設定、git、專案鎖，以及各 runtime CLI 支援什麼（只讀 `--version`／`--help`，不會執行 agent，也不會讀取憑證）。能力是 `yes`、`no` 或 **`unknown`**；`unknown` 只是警告，明確的 `no` 會讓 run 無法啟動。登入狀態一律回報為 unknown。
- `config show --resolved [-p name] [--json]`：每一項生效的設定與它的來源。
- `status --json`（也可搭配 `--task-list`、`--task-id`）：`schema_version: 1`、無顏色、stdout 只有 JSON，錯誤走 stderr 並以非零 exit code 結束。
- `unlock [-p name] --force`：移除當機的 run 留下的專案鎖。
- `clear <run-id> [--dry-run] [--keep-worktrees]`：連同任務記憶、worktree、branch 與快照 ref 一併清除；有 worktree 內的成果不在你的 repo 時會拒絕（什麼都不刪）；絕不動全域或專案層記憶；絕不順著 symlink 刪到專案 home 之外；中斷的 `clear` 重跑即可完成。
- Ctrl-C／SIGTERM 會乾淨地取消 run（停止 agent 的整個程序樹、保留未讀信件、釋放鎖），之後用 `resume` 接續。
- 團隊現在**至少需要 2 個 agent**（lead 加一位成員），以前是 3 個。

### 對真實 CLI 的檢查

測試套件使用腳本化的 `claude` 替身。要對真實 CLI 檢查，請執行 `agent-lyceum doctor`（免費）。用很小的任務做完整的端到端試跑會花 token，刻意保留為手動。
