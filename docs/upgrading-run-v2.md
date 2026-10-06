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

**Old runs keep working.** A run started by an older version is read as `schema_version: 1` with the *legacy* mailbox layout: it keeps using the shared `shared/{inbox,outbox}/` folders, and its mail is never moved (mail that cannot be attributed to a run stays where it is). Resuming it works as before. Its `done` has no recorded outcome, so it shows as `完成（未驗證）` and counts as `partial` (exit code 2): agent-team will not present a result nobody checked as a success.

### Exit codes (this can break scripts)

`run` / `resume`: `0` = `completed`; `2` = `partial` or `blocked` (this now includes a run that went **idle** without a `done`, and a run stopped at `max_rounds`); `1` = `failed` (this now includes a failed **lead**, which used to be `2`); `130` = cancelled with Ctrl-C/SIGTERM. Before, `idle` exited `0` and a failed lead exited `2`. If a script treated `0` as "the run ended", it must now treat it as "the work was completed". `resume` on an already finished run prints its outcome and exits with the matching code.

### The completion contract

A lead's `done` mail must carry `outcome: completed|partial|blocked|failed` in its frontmatter and the headings `## Result`, `## Files`, `## Verification`, `## Not done`. `completed` also needs every `## Steps` checklist item ticked. Otherwise the mail goes back to the lead (at most twice) and is then kept as `partial`. If your lead's `AGENT.md` contains its own `done` template, update it. agent-team records what the lead *says* it verified; it does not run the verification itself.

### Parallel runs and worktrees

- `max_parallel > 1` now means: each non-lead agent works in its **own git worktree**, and the repo must be a git repository (otherwise run sequentially).
- A parallel run **refuses to start while your repo has uncommitted changes**. Commit or stash them first. (The lead's own uncommitted changes *during* a run are fine: they are part of the snapshot the members start from.)
- After a member finishes, its changes are brought into your working tree (not the index, not HEAD). If a file also changed in your repo since the snapshot, if the change breaks `owns`/protected-file/symlink rules, or if `git apply` fails, **nothing is applied**: the work stays on branch `agent-team/<run-id>/<agent>` and in its worktree, `runs/<run-id>/integration/` has a report and a patch, the lead is told, and the run ends `blocked`, never `completed`.
- A worktree isolates files only. It cannot isolate side effects on external services, databases or the network.
- New setting `dispatcher.workspace_mode: auto | shared | worktree`. `shared` cannot be combined with parallel agents.
- agent-team adds git bookkeeping inside your repository while a parallel run exists (`refs/agent-team/...`, `agent-team/...` branches, worktree entries). `agent-team clear` removes them.

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

The test suite uses scripted stand-ins for `claude`. To check against the real CLIs, run `agent-team doctor` (free). A full end-to-end trial with a tiny task spends tokens and is deliberately manual.

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

**舊的 run 仍然可用。** 舊版本啟動的 run 會被視為 `schema_version: 1`，使用*舊版*信箱配置：繼續用共用的 `shared/{inbox,outbox}/`，信件不會被搬移（無法判定屬於哪個 run 的信也留在原處）。接續方式與以前相同。它的 `done` 沒有記錄結果狀態，所以會顯示為「完成（未驗證）」並視為 `partial`（exit code 2）：agent-team 不會把沒有人檢查過的結果當成成功。

### Exit code（可能影響你的腳本）

`run`／`resume`：`0` = `completed`；`2` = `partial` 或 `blocked`（現在也包含**閒置**結束而沒有 `done`，以及停在 `max_rounds` 的 run）；`1` = `failed`（現在也包含 **lead** 失敗，以前是 `2`）；`130` = 以 Ctrl-C／SIGTERM 取消。以前 `idle` 回傳 `0`、lead 失敗回傳 `2`。如果你的腳本把 `0` 當成「run 結束了」，現在 `0` 的意思是「工作確實完成」。對已經結束的 run 執行 `resume` 會印出它的結果狀態，並回傳對應的碼。

### 完成契約

lead 的 `done` 信 frontmatter 必須有 `outcome: completed|partial|blocked|failed`，內文要有 `## Result`、`## Files`、`## Verification`、`## Not done`；`completed` 還要求 `## Steps` 全部勾選。不符合的信會退回給 lead（最多兩次），之後以 `partial` 收下。如果你 lead 的 `AGENT.md` 自己寫了 `done` 範本，請一併更新。agent-team 記錄的是 lead *宣稱*自己驗證了什麼，它本身不會執行驗證。

### 平行執行與 worktree

- `max_parallel > 1` 現在表示：每個非 lead 的 agent 在**自己的 git worktree** 工作，而且 repo 必須是 git repository（否則請序列執行）。
- 平行 run **在你的 repo 有未提交修改時會拒絕啟動**，請先提交或 stash。（run 進行*期間* lead 自己的未提交修改沒問題：它們屬於成員出發用的快照。）
- 成員完成後，它的變更會被整合進你的工作目錄（不動 index、不動 HEAD）。若同一檔案在快照之後又在你的 repo 被改過、變更違反 `owns`／受保護檔案／symlink 規則，或 `git apply` 失敗，就**一個檔案都不套用**：成果留在 branch `agent-team/<run-id>/<agent>` 與它的 worktree，`runs/<run-id>/integration/` 有報告與 patch，並通知 lead，這個 run 會以 `blocked` 結束，絕不會是 `completed`。
- worktree 只隔離檔案，無法隔離對外部服務、資料庫或網路的副作用。
- 新設定 `dispatcher.workspace_mode: auto | shared | worktree`。`shared` 不能與平行 agent 並用。
- 平行 run 存在期間，agent-team 會在你的 repository 內加入 git 管理資料（`refs/agent-team/...`、`agent-team/...` branch、worktree 登記），`agent-team clear` 會移除。

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

測試套件使用腳本化的 `claude` 替身。要對真實 CLI 檢查，請執行 `agent-team doctor`（免費）。用很小的任務做完整的端到端試跑會花 token，刻意保留為手動。
