# 21 啟動器（wrapper）消失時取消 run／resume／call／tidy

狀態：設計，第 2 版（f75ca2，接續 c4a59b；依設計審查 a0c5760c 修訂：拿掉 15 秒保底、tidy 的結束方式、npm script 內的逃生口）。不發版。

## 21.1 問題

- 使用者（f75ca2）：透過 wrapper（`node_modules/.bin/tsx`、`npx`／`npm exec`）啟動 CLI，關掉終端機時 wrapper 先死。wrapper 不轉送 SIGHUP（tsx 只轉 SIGINT/SIGTERM，npm exec 都不轉），真正的 CLI 收不到訊號，被收養後繼續跑。
- `status --monitor` 已修好（`src/monitor-lifecycle.ts`：每個 tick 比對 `process.ppid`，變了就 exit 129）。
- `run`、`resume`、`call`、`tidy` 共用 `src/cli.ts` 的 `cancelOnSignals()`：第一個 SIGINT/SIGTERM/SIGHUP 呼叫 `ac.abort()`（run／resume／call：停 agent、保留未讀信、釋放鎖、exit 130；tidy：還原快照、exit 1），第二個 `process.exit(130)`。wrapper 一死，這條路完全不會被觸發。

探測結果（2026-10-19，本機 Node 22.22.2，sandbox 內）：

| 探測 | 結果 | 影響 |
|---|---|---|
| `nohup node …` 後送 SIGHUP | 程序以 129 結束 | Node 啟動時把 SIGHUP 重設為預設，`nohup` 的 SIG_IGN 看不到，「啟動時 SIGHUP 被忽略就不啟用」無法實作。`cancelOnSignals()` 本來就會掛 SIGHUP handler，所以 `nohup agent-lyceum run` 收到 HUP 今天就會被取消（既有行為，本設計不改）。 |
| `console.log` 寫到已關閉的 pipe | 未處理的 `'error'`（EPIPE），exit 1 | stdout 死掉今天就會讓 run 崩潰；`process.on("exit")` 的 hook 仍會 SIGKILL runtime、釋放鎖，所以不會留下程序。 |
| tsx 4.23.15 wrapper 的子程序參數 | `node --require <tsx>/dist/preflight.cjs --import <tsx>/dist/loader.mjs …`，env 只多 `TSX_*`（選用） | 可由 `process.execArgv` 認出 tsx wrapper。 |
| `ps`（sandbox 內） | `spawnSync ps EPERM` | 用 `ps` 查父程序身分在 sandbox 裡無法運作，也無法測試。 |
| 開 PTY 模擬關終端機 | `out of pty devices`（sandbox） | 真實終端機關閉的路徑未驗證，見 21.8。 |

## 21.2 決議

| # | 決議 |
|---|---|
| 1 | **偵測：** 父程序 pid 與「程序啟動時」記下的值不同，就視為啟動器消失。比的是起始值，不是檢查是否等於 1（Linux 可能由 subreaper 收養）。用 `unref()` 的 `setInterval`，每 **1000 ms** 讀一次 `process.ppid`（`getppid()`，成本可忽略），武裝時也立刻檢查一次。 |
| 2 | **只在由已知、不轉送 SIGHUP 的啟動器啟動時武裝**（21.4）：`process.env.npm_execpath` 有值（npm／npx／`npm exec`／`npm run`、pnpm、yarn 都會設），或 `process.execArgv` 有一項以 `/tsx/dist/preflight.cjs` 結尾（Windows 分隔符也接受）。其餘情況（直接執行安裝好的 `agent-lyceum`、`node dist/cli.js`）不武裝，行為與今天完全相同。沒有新的環境變數開關。 |
| 3 | **偵測到之後：** 走與第一個訊號相同的路：`seen` 加一、寫一行到 stderr、`ac.abort()`。所以接下來的取消都是既有程式碼：run／resume／call 保留未讀信、釋放鎖、exit 130；`tidy` 照既有行為還原快照、回報 failed、exit 1（`src/memory-tidy.ts`、`src/cli.ts` tidy 段落），本設計不改。之後再來任何訊號仍是 `process.exit(130)`。 |
| 4 | **不加保底 timer：** 偵測到啟動器消失與「CLI 直接收到第一個 SIGHUP」完全相同，之後由既有的乾淨取消跑完，不強制 `process.exit`。理由（審查 a0c5760c 實測）：取消時每個 agent 的 `killTree` 都會同步呼叫 `processTable`，agent 越多越久（6 個慢 agent 約 26 秒、8 個約 37 秒），任何固定秒數的保底都可能在乾淨取消完成前觸發，跳過 run 結算、guard 檢查與最終 state 寫入；agent 數量沒有上限，所以也證明不了哪個秒數安全。取捨：若取消本身卡死（今天直接 SIGHUP 也一樣），程序會留著直到卡住的步驟結束；這與既有訊號路徑相同，不是新的回歸。若已先偵測到啟動器消失，之後任何訊號仍立即 `process.exit(130)`。 |
| 5 | **stderr 訊息：** `\nLauncher exited (parent process gone): stopping (running agents are being stopped; unread mail is kept).\n`，用 `try { fs.writeSync(2, msg) } catch {}` 寫。不可用 `console.error`：stderr 可能已是死掉的 tty／pipe，`console.*` 會丟出未處理的 EPIPE/EIO 而讓程序以 1 崩潰。訊息可能送不到任何人，這是預期的。 |
| 6 | **stdout／stderr 的 EPIPE／EIO 不算偵測訊號**（本次不處理）。理由：wrapper 被單獨殺掉時終端機往往還活著，EPIPE 不會發生；而輸出死掉今天已經會讓程序崩潰並由 exit hook 清乾淨，不會留下程序。把它變成乾淨的 130 是另一個改善（21.8）。 |
| 7 | **不讀 stdin：** `run`／`init` 用 `readline` 讀 stdin 回答問題，不照抄 monitor 的 stdin EOF 做法。 |
| 8 | **`status --monitor` 不改：** 它無條件比對 ppid。兩邊規則刻意不同：monitor 只是畫面，沒有工作會遺失，與父程序分離後的 monitor 也沒有用處，所以一律結束；run 有進行中的工作，脫離父程序可能是使用者有意的（21.4），所以只在 wrapper 底下武裝。 |

## 21.3 程式位置

新增 `src/parent-watch.ts`（純函式、可注入，沒有新依賴）：

```ts
/** 程序啟動時的父 pid（模組載入時讀，早於 config 載入與 preflight）。 */
export const LAUNCH_PPID: number = process.ppid;

/** 由不會轉送 SIGHUP 的啟動器啟動：npm/npx/pnpm/yarn（設 npm_execpath），或 tsx CLI（子程序帶 --require …/tsx/dist/preflight.cjs）。 */
export function startedByWrapper(env?: NodeJS.ProcessEnv, execArgv?: readonly string[]): boolean;

/** 父 pid 與 startPpid 不同時呼叫 onGone 一次：武裝時同步檢查一次，之後每 intervalMs（預設 1000）在 unref 的 timer 上檢查。回傳停止函式。 */
export function watchParent(onGone: () => void, opts: { startPpid: number; ppid?: () => number; intervalMs?: number }): () => void;
```

`src/cli.ts` 的 `cancelOnSignals()`：

- 把現有 handler 內「第一次」的分支抽成 `trigger(message)`，訊號與父程序消失共用；`seen` 計數共用。
- `const stopWatch = startedByWrapper() ? watchParent(onParentGone, { startPpid: LAUNCH_PPID }) : () => {};`
- `onParentGone`：用 `fs.writeSync(2, …)` 安全地寫訊息；`seen === 0` 時 `seen = 1` 並 `ac.abort()`；`seen > 0`（已在取消中）時什麼都不做。不開任何保底 timer。
- `dispose()` 另外呼叫 `stopWatch()`。
- 用 `LAUNCH_PPID` 而不是武裝當下的 ppid：wrapper 若在 CLI 載入 config、跑 preflight 的幾秒內就死了，武裝時的同步檢查會立刻 abort，`runTeam` 對已 abort 的 signal 不喚醒任何人（`test/cancel.test.ts` 已覆蓋）。

`runMonitor` 與 `test/monitor-lifecycle.test.ts` 都不動。`driveRun` 迴圈裡多次呼叫 `continueRun` 時，每次都武裝再 `dispose`，不會累積 listener 或 timer。

## 21.4 合法的重新收養（相容性）

| 情境 | 規則下的結果 | 與今天相比 |
|---|---|---|
| 安裝好的 `agent-lyceum run … &` 由腳本啟動，腳本結束 | 父程序是 shell，不武裝；繼續跑 | 相同 |
| 安裝好的 binary 搭 `disown`、`setsid`、`nohup`、process supervisor | 不武裝 | 相同（`nohup` 收到 HUP 仍會被取消，這是既有行為，見 21.1） |
| `npx agent-lyceum run … & disown`，之後關終端機 | 父程序 `npx` 還活著（也被 disown），ppid 不變；繼續跑 | 相同 |
| Node 程式用 `spawn(…, { detached: true })` 啟動安裝好的 binary 後離開 | 父程序是 node，但 env 沒有 `npm_execpath`、execArgv 沒有 tsx，不武裝 | 相同 |
| `npm run <script>`／`npm test` 內啟動（含直接執行安裝好的 binary），背景執行後 npm 結束 | `npm_execpath` 會被繼承，武裝；**被取消** | **改變**（罕見；在 npm script 裡直接執行 binary 也躲不掉，要用 `env -u npm_execpath agent-lyceum …`，且不能經過 tsx wrapper） |
| `npx`／`npm exec`／`.bin/tsx` 啟動，wrapper 被殺 | 武裝；下一個 1000 ms tick 偵測，開始乾淨取消，結束時 exit 130（取消本身沒有固定上限，見 21.5） | 修正目標 |
| wrapper 鏈（`npx tsx src/cli.ts`），外層 `npx` 死、`tsx` 還活著 | ppid（tsx）不變，不偵測 | 相同（限制，21.8） |

放棄的做法：

- **無條件武裝（與 monitor 相同）：** 腳本背景啟動、`setsid`、detached spawn 的使用者，run 會在父程序結束時被取消，是直接的回歸。
- **只在 stdin／stdout 是 TTY 時武裝：** `run > log 2>&1 & disown`（stdin 仍是 TTY）或腳本背景啟動但輸出到終端機時會被誤取消；而且 wrapper 在非 TTY 情境被殺（CI runner、外掛）時抓不到。更關鍵的是 sandbox 不能開 PTY，武裝路徑無法用程序測試驗證。
- **啟動時 SIGHUP 是否被忽略（nohup）：** Node 啟動時重設訊號處置（21.1 探測），看不到。
- **用 `ps`／`/proc` 查父程序是不是 node：** macOS 要 spawn `ps`，sandbox 內 EPERM（探測），測試無法跑；`process.title` 會改 Linux 的 `comm`（npm 會設成 `npm …`）；每次啟動多一次 spawn。
- **tsx 的 IPC `disconnect` 事件：** 只有 tsx 有 IPC channel，npm exec 沒有；而且依賴 tsx 的 preflight 內部行為。
- **環境變數 opt-out（例如 `AGENT_LYCEUM_…=0`）：** 多一個中英文都要寫文件的公開介面；在 21.2#2 的規則下，需要它的情境只剩「npm script 裡背景啟動」，用直接執行 binary 或 `env -u npm_execpath` 就能避開。

## 21.5 延遲

- 偵測：武裝時立即檢查一次，之後在下一個可執行的 1000 ms tick（同步工作會延後 timer）偵測到後開始取消。
- 乾淨取消：與今天直接收到 SIGHUP 相同，沒有固定上限。每個 agent：SIGTERM，5 秒後 SIGKILL（`killGraceMs`），等 pipe 1 秒（`settleWaitMs`）、log 2 秒（`endStream`）；但每次 `killTree` 會同步呼叫 `processTable`（最多 2 秒），在 abort 時會在 agent 之間串行化，所以總時間隨 agent 數增加（審查實測 6 個慢 agent 約 26 秒）。fake runtime 通常 1～2 秒內結束。
- 不宣稱「wrapper 死後 N 秒內一定消失」的硬上限。

## 21.6 測試計畫

單元（新增 `test/parent-watch.test.ts`）：

1. `startedByWrapper`：`{ npm_execpath: "/x/npm-cli.js" }` → true；execArgv 含 `…/node_modules/tsx/dist/preflight.cjs` → true；空 env 搭 `[]`、`["--import", "tsx"]` → false。
2. `watchParent`（`vi.useFakeTimers()`、注入 `ppid`）：ppid 不變時不呼叫；改變後下一個 tick 呼叫一次，之後再變也不再呼叫；武裝時 ppid 已不同 → 同步呼叫；停止函式呼叫後不再呼叫；timer 是 unref 的（`hasRef() === false`）。

程序（`test/parent-watch.test.ts`，沿用 `cliRunDirect`、fake runtime、`until`、`alive`）：

- 中間程序：`node -e` spawn `process.execPath --import tsx src/cli.ts --home … <cmd>`，CLI 的 stdout／stderr 導向**檔案**（不能是 pipe，否則中間程序死後 CLI 會因 EPIPE 崩潰，測到的是別的路徑），等 fake runtime 寫出 marker 後印出 CLI pid。不用 `.bin/tsx`（sandbox 內 IPC `listen` EPERM）。每個測試在 `finally` SIGKILL 中間程序、CLI、marker 裡的 pid。
- 武裝的 env：明確設 `npm_execpath`（例如 `/fake/npm-cli.js`）；不武裝的 env：刪掉所有 `npm_*` 鍵（`npm test` 會帶入）。

| # | 情境 | 斷言 |
|---|---|---|
| P1 | `run "do it" -p demo`，武裝，`FAKE_MODE=sleep`；對中間程序送 SIGHUP | 10 秒內：CLI pid 不在、runtime 與 grandchild 不在、`listRunLocks` 為空、該 run 的 `state.json` `end_reason === "cancelled"`（證明走乾淨路徑，不是崩潰）、stderr 檔含 `Launcher exited` |
| P2 | `call pm "go"`（只在全域 library 的 agent），武裝，同上 | CLI、runtime 不在；`<home>/calls/.lock-pm` 不在 |
| P3 | 同 P1 但不武裝 | 中間程序死後 3 秒（3 個 interval）CLI 與 runtime 仍活著；再手動 SIGKILL 清掉 |

| P4 | P1 的流程，runtime 忽略 SIGTERM（`FAKE_IGNORE_TERM=1`，乾淨取消要等 5 秒 grace）；偵測到啟動器消失後再對 CLI 送 SIGINT | CLI 在 2.5 秒內以 130 結束（走既有的 `process.exit(130)`；exit hook 仍會清 runtime） |
| P5 | 反向：先對 CLI 送 SIGINT（runtime 忽略 SIGTERM），取消進行中再殺中間程序 | 2 秒後 CLI 仍在乾淨取消中、stderr 沒有 `Launcher exited`；之後乾淨結束，exit 130、`end_reason === "cancelled"` |

CLI 的 exit code 由 `--import` 的 preload 在 `exit` 事件寫入檔案（中間程序已死，沒有人能收 exit code）。

`resume` 不另寫程序測試：它經由 `continueRun` 走同一個 `cancelOnSignals()`，和 `run` 一樣是 `ProjectLease`。`tidy` 的觸發也是同一個 helper，但結束方式不同（還原快照、exit 1），本次不改它；若成本可接受，加一個 tidy 在父程序消失後還原快照的斷言，否則在報告中註明未以程序測試驗證。`call` 的鎖與結束路徑不同，所以單獨測。reviewer 確認四個呼叫點都還是 `cancelOnSignals()`。

回歸：`test/cancel.test.ts` 既有的 SIGINT（130，之後 resume 成功）與直接 SIGHUP（130）測試照樣通過；`test/monitor-lifecycle.test.ts` 不變且通過。Mutation 檢查：把 `watchParent` 的比較改成永遠相等，P1、P2 應失敗；拿掉 `startedByWrapper` 判斷（一律武裝），P3 應失敗。

## 21.7 影響範圍與文件

- 程式：新增 `src/parent-watch.ts`，改 `src/cli.ts` 的 `cancelOnSignals()`。不改 config、run state、mail 格式、`status --json`。沒有新依賴。
- 文件（docs-writer）：`docs/commands.md` 的 **Stopping a run** 段落與 `docs/commands.zh-TW.md` 的 **中止 run** 段落各加一句，大意：「透過 `npx`／`npm exec`／`tsx` 啟動時，若啟動器結束（例如關掉終端機），run 會像按 Ctrl-C 一樣被取消（exit 130）；要讓 run 在啟動器結束後繼續，直接執行安裝好的 `agent-lyceum`；在 npm script 裡要用 `env -u npm_execpath agent-lyceum …`。」`call` 段落不必另寫。README 不用改。

## 21.8 已知限制與後續

- 真實關閉終端機的路徑未驗證（sandbox 沒有 PTY）。shell 收到 HUP 時通常會對整個前景 job 的 process group 送 HUP，那時 CLI 會直接收到 SIGHUP；本設計是 wrapper 單獨被殺（pid 指定的 kill、IDE、CI、外掛）時的保底。
- 既有問題（不在本次範圍）：取消路徑上的 `console.error`／`console.log` 寫到已關閉的 tty／pipe 會以 exit 1 崩潰而不是 130；程序仍會被 exit hook 清乾淨。可另開一項：在取消期間讓 stdout／stderr 的 EPIPE／EIO 變成靜默。
- wrapper 鏈只偵測直接的父程序（21.4 最後一列）。
- bunx、deno、volta shim 未涵蓋或未驗證。
