# Web console

Run every agent-lyceum command from the `status --web` page. Local use only; see [Security](#security).

## Where each command is

| CLI | In the page |
| --- | --- |
| `run` | A project page, **新任務** |
| `resume` (follow-up, continue) | A project page, **續跑／追問** on a run that is not running |
| `resume --answer` | A project page, **回答問題** on a run that is waiting |
| `clear` | A project page, **刪除這次任務** |
| `tidy` | A project page, **整理記憶** |
| `doctor` | A project page, **檢查設定** |
| `project`, `project add`, `project remove` | **工具** (`#!tools`) |
| `call`, `demo`, `init` | **工具** (`#!tools`) |
| `clear --lock --force` | **工具** (`#!tools`) |
| `status` | The page itself |

Commands that can run for a long time (`run`, `resume`, `call`, `tidy`, `demo`) start as background jobs and keep running if you close the page or stop `status --web`. Each job has a directory `<home>/web-jobs/<id>/` with `out.log` and, once it ends, `exit.json`. Their output is under **任務輸出** (`#!jobs`). `tidy --dry-run` and `tidy --undo`, and `demo --setup-only`, are short and return their output directly.

## Confirmation

The server enforces the tier; the page only asks first. The tier can depend on the request, and `web/src/commands.ts` is the source of truth.

- Normal: runs at once. This includes `run`, `resume`, `call`, `doctor`, `init`, `project add`, `demo`, and the dry-run forms of `clear` and `tidy`.
- Confirm: `clear`, `tidy` and `project remove`, except `clear --dry-run` and `tidy --dry-run`. The page first shows a dry run where there is one, then asks. The server answers HTTP 428 until the request carries `confirm: true`.
- Type to confirm: `project remove --purge` and `clear --lock --force`. You type the project name or run id; the server answers HTTP 428 until `confirmText` equals it exactly.

## Security

- **Restriction:** the whole `/api/*` surface, reads and writes, is local-only. When `--host` is not a loopback address, every method on `/api/*` answers HTTP 403 and no command can run. There is no flag to turn it on; exposing the console to a network is not supported. Before this change, a non-loopback `--host` switched the write-route checks off.
- `POST /api/*` needs a valid `Host`, a same-origin `Origin` (it must be present) and the per-start token in `X-Lyceum-Token`. The token is random on every server start and is injected into `index.html` as `<meta name="lyceum-token">`. An `Origin` or token header that is repeated is rejected. `POST /quota` keeps its old rule (`Origin` optional).
- Every command is started as `process.execPath` plus an argument array, never through a shell. Free text such as the task is passed after `--`, so it cannot be read as an option.
- A 500 response is generic; the detail goes to the server's console.

## Limits

- A request body is at most 256 KB; a short command is stopped after 120 seconds and its output so far is returned.
- If the server was restarted while the page was open, the next action is refused and the page asks you to refresh (the token changed).
- A job's exit code is kept in `exit.json`. If the job's process is gone and it never wrote one, the page shows "已結束（結束碼不明）".
