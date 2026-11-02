# 28 verify 重複失敗偵測（同樣的失敗、工作區沒變就提早停）

狀態：**已實作**（2026-11-01；文件：[設定](../configuration.zh-TW.md#驗證verify)、[怎麼運作](../how-it-works.zh-TW.md#驗證-completed-的-done)）。對應「Harness, Loops, Graphs」的 L4，範圍只有 `docs/evaluations/loops-harness-graphs.md` §6.2 第 1 項；第 2 項不做（28.13）。依賴 [spec 27](27-dispatcher-verify.md) 的紀錄（27.7），不改 spec 27 已決定的行為。

行號以 `dc54b10` 為準。本文的 `D-xx` 是本 spec 的決議；spec 27 的決議一律寫成「27 D-xx」。真實 `claude`／`codex` 的行為本 spec 不依賴。

## 28.1 問題

- verify 失敗時，lead 收到退回信（27 D-07）。它可能什麼都沒改就再送一次 `done`。dispatcher 照樣重跑、照樣退回，直到 `max_rejections` 用完才降為 `partial`（27 D-08）。這幾次喚醒沒有進展，每次都有成本（一次喚醒約 300k context，decision `lead-wake-economy-prompt-rules`）。
- lead 有改東西但結果一模一樣時，退回信和第一次長得一樣，看不出「剛才的修改沒有影響這個結果」。
- **價值有限：** 預設 `max_rejections` 2 時，最多省 1 次喚醒（§6.2）。一般而言最多省 `max_rejections - 1` 次，因為第一次失敗沒有比較對象。實際會不會重複目前沒有資料，所以第一版要小，並且要加量測（D-14）。

## 28.2 目標與非目標

**目標：** lead 的 `done` 驗證失敗時，和同一個 segment 裡**上一次被退回的 `done`**比較：

| 指紋 | 工作區 hash | 動作 |
|---|---|---|
| 相同 | 相同 | 很可能沒有進展（啟發式判斷）：不再退回，走 27 D-08 的路徑降為 `partial`，note 寫明原因；不消耗退回次數 |
| 相同 | 不同 | 照常退回；退回信開頭標明「和上次同樣的失敗」 |
| 相同 | 不知道（沒有 worktree、hash 取不到） | 照常退回；退回信標明同樣的失敗，但不說工作區有沒有變；上限只靠次數 |
| 不同 | 任何 | 照常退回，內容與現在相同 |

**非目標：**

- 不省驗證時間。指令一定會重跑，比對發生在跑完之後（不動 27 D-05、D-06；跳過指令屬於 29）。
- 不新增 `EndReason`（會出現在 `status --json`，`src/status.ts:347`）。
- 不新增設定鍵。沒有 `verify` 的專案完全不受影響（D-02）。
- 不解析測試框架的輸出（27.2、評估 §7）。
- 不比「上上次」或整段歷史，只比上一次。
- 不改成功路徑：全部通過的 `done` 不算指紋、紀錄內容不變。
- §6.2 第 2 項（跨 wake 訊號只記錄）不做（28.13）。

## 28.3 決議總表

| # | 決議 | 理由 |
|---|---|---|
| D-01 | 比較對象是 `state.verify` 中**由後往前第一筆**同時滿足「`source` 不等於目前的 `source`」與「`source` 在 `state.verify_rejected` 裡」的紀錄。這是 segment 內上一次被退回的 `done`（若那個 `done` 因重播有多筆紀錄，取最新一筆） | `state.verify` 每次驗證都追加（`src/run-session.ts:1133-1134`），重播時最後一筆就是自己；比「最後一筆」會自己比自己而誤停。`verify_rejected` 在 reopen 歸零（`:299-300`）但 `state.verify` 保留，用它過濾就同時解決 segment 問題（27 D-13）。不必另存「segment 編號」 |
| D-02 | 整個機制只存在於 `verifyDone` 的失敗路徑。沒有 `verify` 的專案永遠走不到（閘門在 `:1022`）；全部通過也走不到（`:1135`）。第一次失敗沒有比較對象，退回信與現在逐字相同 | 相容；不改 spec 27 的既有結果 |
| D-03 | 指紋存在 `VerifyCommandRecord.fingerprint?: string`，只放在失敗的那一條指令上。`state.verify` 的 schema 是 `z.array(z.any())`（`src/run-store.ts:232`），不改 schema、不升 `schema_version`。沒有 `fingerprint` 的舊紀錄永遠不相符 | 尾端輸出只在記憶體（`src/verify.ts:150,162`），27.7 的紀錄沒有這項資訊；放在指令層，紀錄本身就說得出是哪條指令失敗。舊 run 照常載入，舊 binary 讀到多的欄位也不會失敗（`z.any`、`src/status.ts` 只讀已知欄位） |
| D-04 | 指紋 = `sha256(name \0 status \0 normalizeOutput(尾端))` 取前 16 個 hex 字元（長度同 `sourceIdOf`，`src/message-store.ts:175-183`）。`status` 依 `describeFailure`（`src/verify.ts:173-177`）同樣的優先序：有 `error` → `error:<正規化後的 error>`；`timed_out` → `timeout`；`exit === null` → `signal`；其他 → `exit:<code>` | 使用者定義的「name + exit code + 尾端 hash」，再補上三種沒有 exit code 的情況。逾時不放 exit：SIGTERM 處理與否會讓 `exit` 在 `null` 與某個 code 之間變動（`src/verify.ts:112-115`）。無法啟動時輸出是空的、`exit` 是 `null`，靠 `error` 文字區分；文字含 cwd（`:109`），所以也要正規化 |
| D-05 | 尾端用**最後 100 行**，不用 byte 尾端也不用全部輸出。步驟見 28.4：先取原始輸出最後 256 KiB（`tailText`），去 ANSI、處理換行後切行，**切好行之後**才替換時間與路徑 | 原始 4 KB byte 尾端的起點會隨前面的行長度移動，同樣的失敗切出來不同；也不能先替換再切 byte。全部輸出則太容易被前面的進度、時間、平行順序影響（只造成假陰性，但會讓功能幾乎不觸發），且可達 2 MiB。100 行約等於退回信 4 KB 的量級，足以涵蓋常見的失敗細節與總結。假陰性是安全方向（28.6），所以取大一點比取小好：只取最後幾行會只看到 `Tests 1 failed` 而分不出失敗的是哪個測試 |
| D-06 | 空輸出是合法情況：尾端是空字串，指紋由 name 與 status 決定。兩次都沒輸出、同樣 exit code，就是同樣的失敗 | 靜默失敗本來就可能重複 |
| D-07 | 工作區 hash 直接用 27.7 已有的 `record.diff_hash`（`workingTreeHash`，`src/worktree.ts:335-360`，指令執行前取，`src/run-session.ts:1122`）。不新增 git 呼叫，不新增第二條 hash 路徑 | 範圍見 28.5。該函式已是有界、可取消、沒有 hook 的版本，測試齊全（`test/verify.test.ts:644-684`） |
| D-08 | 「走釘住的 git」這項要求視為**已滿足**，不改成字面上呼叫 `agentGit`。worktree 路徑用的是 `assertWorkspaceIntact` + `pinnedArgs` + `pinnedEnv` 經由 `boundedGit`（`src/worktree.ts:341,345`），與 `agentGit`（`:179-182`）釘的東西相同，差別只在非同步且有 deadline、可取消 | `agentGit` 是同步的 `execFileSync`，會卡住事件迴圈、clean filter 掛住時無法設上限，也收不到 Ctrl-C；`test/verify.test.ts:644-684` 測過的邊界會全部失效。§6.2 寫 `agentGit` 時，它自己也註明 hash 的範圍尚未定義；這裡要守的是「不信任 agent 能改的 git 檔案」，釘住的參數與環境已做到 |
| D-09 | **沒有 lead worktree 時，比對不看 hash**：`this.leadSpace` 為 `undefined` 就當作 `no-worktree`，即使 `record.diff_hash` 有值。27.7 的紀錄照舊寫，不改。判斷條件用 `this.leadSpace`，不用 `workspace_mode`（舊 run 可能是 `worktree` 模式但 lead 在 checkout，`src/worktree.ts:279`） | **更正需求的前提：** §6.2 與需求說「沒有 worktree 取不到 hash」，實際上 `workingTreeHash(project, undefined)` 在 git repo 裡**會回傳 hash**（`test/verify.test.ts:656-657`），git repo 尚無 commit 時就是這種情況（`src/worktree.ts:254`）。那條路徑沒有釘住 git（`:341`），`project.dir` 又是使用者實際的工作目錄，內容可能因使用者而變；要滿足「沒有 worktree 不靠 hash、只靠次數」，必須明確忽略它 |
| D-10 | hash 只要有一邊是 `undefined`（巢狀 repo、30 秒預算用完、git 失敗、worktree 被動過）就是 `unknown`，**絕不**算相同，兩邊都 `undefined` 也一樣。指紋相同時退回信仍標明同樣的失敗（28.8） | 不知道不等於沒變 |
| D-11 | 優先序（`repeatAction`，28.7）：已計數的 source 一律留在退回路徑，**不可能**停；同一 segment 內已判定停止的 source（D-13）再次失敗時維持停止；次數用完時走 27 D-08，note **與現在逐字相同**；還有次數且指紋、hash 都相同才是本 spec 的停止 | 重播既不重算也不改判（28.7）。次數已用完時本來就沒有喚醒可省，沿用舊文字可讓 spec 27 的結果與測試不變。`max_rejections: 0` 與 `1` 因此永遠不會觸發本 spec 的停止 |
| D-12 | 停止**不消耗**退回次數：`verify_rejections`、`verify_rejected` 都不動。note 由 `verifyDone` 產生，放進現有的 `{ kind: "exhausted", record, cwd, failure: { note } }`，經 `settle` 傳給 `resolveDoneOutcome` 的 `verifyFailure`（`src/run-session.ts:1078`）。`resolveDoneOutcome` **邏輯不改**：`completed` 降為 `partial`，`blocked` 維持 `blocked` 且兩段 note 相接（`src/run-outcome.ts:27-31`） | 沒有退回就不該計數；沿用現有路徑讓 `open_pr`、`result.md`、`done-<n>.md` 全部不用改。`open_pr` 只認 `completed`，不會開 PR |
| D-13 | `VerifyRecord.repeat_stop_segment?: number` 記下停止的判定與它所屬的 segment，值是當時的 `state.reopened?.length ?? 0`（第一段是 `0`，比較一律用 `===`）。在 `verifyDone` 內 `saveState()` 後才 `fault("verify:stopped")`。`stoppedInSegment(records, source, segment)` 只在**同一 `source` 且同一 segment** 有標記時為真；這時指令又失敗就直接再停，不重新比對。重播時指令通過，則與所有重播一樣以通過收下。reopen 之前寫下的標記**不能決定 reopen 之後的任何事** | 指令可能產生未被 ignore 的檔案，重播時 pre-command hash 會變，不記下就可能把「停」改判成「退回」並多計一次。這和 27 的計數冪等（`:1145`）是同一個作法。必須限定 segment：已結束 segment 的 `done` 檔可能留在 outbox，以同一個 `source` 進入 follow-up（28.7 reopen）。`reopened` 只在 reopen 時追加（`src/run-session.ts:294`，唯一的寫入點），與計數器歸零一起在 `:362` 存檔，也是 `done-<n>` 的編號依據（`:1089`）；不需要新的歸零位置，舊 binary 續跑 reopen 時也仍然正確 |
| D-14 | 每次驗證失敗（含重播、含第一次）寫一筆 `verify-repeat` log（欄位見 28.9） | §6.2 要求先量測；要有分母才看得出觸發率 |
| D-15 | 所有 dispatcher 文字維持英文（`src/verify.ts:190`），措辭固定於 28.8。退回信的 `subject` 不變 | 既有慣例；`subject` 被文件與測試引用 |
| D-16 | `fail_fast`（27 D-05）下每次驗證只有一條失敗指令，只比那一條。不同指令失敗，name 不同，指紋就不同，視為有進展。A 失敗→B 失敗→A 再失敗時，第三次只和 B 比，不標同樣的失敗 | 需求只比「上一次」；比整段歷史沒有對應的證據，也會增加狀態 |
| D-17 | 不告訴 lead「不改就重送會提早結束」。第一封退回信逐字不變；有標籤的那封也只陳述事實 | 第一封不變是 D-02 的相容要求；另外預告也沒有實益：lead 可以靠無關緊要的修改繞過停止，而繞過後仍有次數上限 |
| D-18 | 已結束 segment 留在 outbox 的舊 `done`（28.7 reopen）**本 spec 不處理**，當作既有問題記在 28.13。本 spec 只保證：舊 `done` 的停止標記不影響新 segment，舊 `done` 在新 segment 被當成一次全新的驗證，後續結果與 `dc54b10` 的 spec 27 流程相同 | 28 的保證靠 D-13 就成立，不需要收掉舊檔。這個問題與 verify 無關（沒有 `verify` 也重現），修它會改變沒有 `verify` 的專案，違反 D-02 與「不改 spec 27 行為」的要求 |

### 不採用的做法

| 做法 | 為什麼不採用 |
|---|---|
| 比較 `state.verify` 的最後一筆 | 重播時會比到自己；reopen 後會比到上一段（D-01） |
| 全部輸出或 byte 尾端算 hash | D-05 |
| 從 `verify/<n>-<name>.log` 讀回輸出算指紋 | 多一個讀檔失敗的情況，內容與記憶體的原始輸出相同，還多了截斷標頭；該檔案也可被指令改寫（27.5） |
| 新的頂層 state 欄位（如 `verify_fingerprints`） | 要和 `state.verify` 保持同步；放在紀錄內沒有這個問題 |
| 字面上改用 `agentGit`，或為 28 另寫一個 hash | D-08 |
| 沒有 worktree 時也用 hash | D-09 |
| 新的 `EndReason` 或 `outcome` | 會改 `status --json` 的值域，需求明確排除 |
| `verify.repeat_detect: false` 開關 | 最差結果只是提早 `partial`，不會誤報成功；加鍵會讓舊 binary 拒絕 `project.yaml`（27.4）。真實資料顯示有問題再加 |
| 次數用完時改用「重複」的 note | 改動 spec 27 的既有文字，換不到任何省下的喚醒 |
| 停止標記放在頂層 `verify_stopped`，reopen 時與 `verify_rejected` 一起歸零 | 多一個要記得歸零的位置；舊 binary 做 reopen 時不會歸零，之後回到新版就可能讀到過期標記。紀錄上的 segment 編號沒有這兩個問題（D-13） |
| 在本 spec 裡，於 reopen 時把舊 `done` 移進 `read/` | 28 的保證不需要；會改變沒有 `verify` 的專案（D-18） |

## 28.4 指紋與正規化

新檔 `src/repeat-detect.ts`，只依賴 `node:crypto`、`node:fs`、`node:os`、`node:util` 與 `run-store` 的型別，**不 import `verify.ts`**（`verify.ts` 會 import 它）。以下除 `fingerprintPaths` 外都是純函式。

```ts
export const FINGERPRINT_WINDOW_BYTES = 256 * 1024;
export const FINGERPRINT_LINES = 100;
export type PathRule = [literal: string, replacement: string];
export function fingerprintPaths(cwd: string, runDir: string): PathRule[];
export function normalizeOutput(text: string, paths: PathRule[]): string;
export function failureFingerprint(c: Pick<VerifyCommandRecord, "name" | "exit" | "timed_out" | "error">, tail: string, paths: PathRule[]): string;
```

**呼叫點：** `runVerify` 在 `src/verify.ts:160` 建好 `rec` 之後、`hooks.end` 之前：

```ts
if (!commandPassed(rec)) rec.fingerprint = failureFingerprint(rec, tailText(r.output, FINGERPRINT_WINDOW_BYTES), fingerprintPaths(opts.cwd, runDir));
```

**`normalizeOutput` 的步驟（順序固定）：**

1. `util.stripVTControlCharacters(text)`：去掉 ANSI（CSI、OSC 超連結都涵蓋，已實測）。不自己寫 regex。
2. 以 `\n` 切行。每行去掉尾端連續的 `\r`（CRLF，以及輸出在 `\r` 上結束的情況），再只留最後一個 `\r` 之後的內容（進度列覆寫同一行），再 `trimEnd()`。
3. 去掉結尾的空行，取最後 `FINGERPRINT_LINES` 行。**之後的替換都不影響切行。**
4. 每行依序替換：
   - **本 run 的路徑：** `paths` 依長度由長到短，字面比對，後面不可緊接 `[\w.-]`（`/w/x` 不會吃掉 `/w/x2`、`/w/x.bak`）。
   - **暫存路徑** → `<tmp>`：`TMP`
   - **完整時間戳** → `<time>`：`STAMP`
   - **時鐘時間** → `<time>`：`CLOCK`
   - **耗時** → `<duration>`：`DUR`
5. 以 `\n` 接回。

```ts
const TMP = /(?<![\w.\/-])(?:\/private)?(?:\/tmp|\/var\/tmp|\/var\/folders\/[^\s\/]+\/[^\s\/]+\/T)(?:\/[^\s:'"`()\[\]<>,;]*)?/g;
const STAMP = /(?<![\w.:-])\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}(?::?\d{2})?)?(?![\w:])/g;
const CLOCK = /(?<![\w.:-])\d{1,2}:\d{2}:\d{2}(?:[.,]\d+)?(?![\w:])/g;
const DUR = /(?<![\w.\/-])(?:\d+h\s?)?(?:\d+m\s?)?\d+(?:\.\d+)?(?:ms|µs|ns|s|secs?|seconds?|mins?|minutes?)(?![\w\/-]|\.\w)/g;
```

**`fingerprintPaths`：** `cwd`、`runDir` 各自連同 `fs.realpathSync.native` 的結果對應 `<cwd>`、`<run-dir>`；`os.tmpdir()` 與其 realpath 對應 `/tmp`，讓自訂 `TMPDIR` 接著被 `TMP` 整段吃掉（連隨機子目錄）。realpath 失敗就略過該項。

同一個 run 內 `cwd` 與 run dir 本來就不變，這兩條替換對比對通常沒有作用；因為需求列了、成本極低，而且 macOS 上 `/tmp` 與 `/private/tmp` 的差異會讓輸出裡出現兩種寫法，仍然保留。

**範例（以上 regex 已用 Node 22 實跑，這張表是實際輸出）：**

| 輸入 | 輸出 |
|---|---|
| `\x1b[31mFAIL\x1b[0m  test/a.test.ts > parses` | `FAIL  test/a.test.ts > parses` |
| ` Duration  3.21s (transform 100ms, setup 0ms, tests 2.9s)` | ` Duration  <duration> (transform <duration>, setup <duration>, tests <duration>)` |
| `   Start at  12:00:01` | `   Start at  <time>` |
| `2026-11-01T15:18:23.051Z ERROR boom` | `<time> ERROR boom` |
| `2026-11-01 15:18:23,051 ERROR boom` | `<time> ERROR boom` |
| `finished in 1m 3.2s`、`finished in 2m30s` | `finished in <duration>` |
| `Checked 1 file in 3ms. No fixes applied.`（Biome 的輸出；`9ms.` 結果相同） | `Checked 1 file in <duration>. No fixes applied.` |
| `at parse (/tmp/vitest-abc123/foo.ts:12:3)` | `at parse (<tmp>:12:3)` |
| `cannot open /var/folders/ab/cd12/T/x-1/y.txt: ENOENT` | `cannot open <tmp>: ENOENT` |
| `progress 10%\rprogress 100%\rdone\r\n` | `done` |

**一定要留下的（不可被替換，寫成單元測試）：**

| 輸入 | 為什麼要留 |
|---|---|
| `AssertionError: expected 500 to equal 200` | 斷言文字就是失敗本身 |
| `Tests  1 failed \| 11 passed (12)` | 數量變了就是有變化 |
| `at parse (src/tmp/foo.ts:12:3)` | 相對路徑與行號；`src/tmp/` 不是暫存目錄 |
| `date only 2026-11-01 stays` | 單獨的日期常是測試的期望值 |
| `expected 5 s to be 3 s` | 數字與單位之間有空格的單字母單位不當耗時 |
| `retry-3s stays and a/5s stays` | 識別字或路徑的一部分 |
| `see v1.2.3s and sha 12s3` | 版本號、hex |
| `wrote 3s.log and 5ms.json` | 單位後面接 `.` 加文字是檔名，不是句尾標點 |
| `ratio 3:45 stays; port :8080; line 10:30 stays` | 不是 `hh:mm:ss` |

**已知的取捨（寫明，不是缺陷）：** 引號內或獨立的時間字樣也會被換掉：`expected '5s' to be '3s'` 變成 `expected '<duration>' to be '<duration>'`；測試名稱 `parses 10:30:00 > keeps 5s timeout` 變成 `parses <time> > keeps <duration> timeout`。兩個失敗只差在這裡時會被視為相同。要造成停止，工作區還必須完全沒變，而工作區沒變時只差在時間字樣的輸出，幾乎就是時間本身在變，可以接受。

**刻意不去掉：** epoch 毫秒、PID、port、記憶體位址、隨機檔名（暫存目錄外）。這些變動只造成假陰性，由次數保底；去掉它們有誤傷值的風險。

**效能：** 只有失敗的指令才算，每次驗證至多一次。256 KiB 的刻意構造輸入（連續數字、`/tmp/` 重複、`1m ` 重複、`\x1b[` 重複、`\r` 重複等）實測每種不超過 3 ms（Node 22，macOS，全步驟不含 sha256），沒有回溯爆炸。輸出來自 agent 寫的程式，所以這要有測試（28.10）。

## 28.5 工作區 hash 的範圍

`workingTreeHash` 在一個拋棄式 index 上做 `read-tree HEAD`、`add -A`、`write-tree`，**只改寫暫存 index，不動 HEAD、分支、真正的 index 與工作樹**（會把 blob 與 tree 物件寫進物件庫，沒有 ref 指向）。以釘住的環境實測（git 2.50.1）：

| 變動 | hash |
|---|---|
| 什麼都沒變 | 相同 |
| 改已追蹤的檔案內容 | **不同** |
| 新增未追蹤、未被 ignore 的檔案 | **不同** |
| 檔案 mode 改變 | **不同** |
| 把內容 commit 起來，內容不變 | 相同（比的是內容，不是 commit） |
| 改了又改回去 | 相同 |
| 被 ignore 的檔案 | 相同（不在範圍內） |
| 空目錄 | 相同（git 不記錄） |

**由此產生的後果（都接受）：**

- **指令自己寫檔：** hash 在指令執行**之前**取。指令若產生未被 ignore 的檔案，第一次的 hash 沒有那個檔案、第二次有，即使沒人動過，前兩次也會不同，於是落回標籤與次數；內容穩定時第三次才可能相同。預設 `max_rejections` 2 時這種專案實際上不會提早停。無害，只是沒省到。內容每次不同（含時間戳的報告）則永遠不相同。
- **範圍外的東西變了：** 被 ignore 的相依（`node_modules`）、環境變數、外部服務都不在 hash 內。lead 重裝相依後又以完全相同的方式失敗時會停止。**錯誤的停止只會得到 `partial`，不會誤報成功。** 而且指令是真的又跑了一次、真的又失敗了；若環境的修復已經有效，指令就通過了，根本走不到比對。
- **`undefined`：** 巢狀 repo（`assertNoNestedRepos`）、30 秒預算（`HASH_BUDGET_MS`）、git 失敗、`assertWorkspaceIntact` 不過（都在 `src/worktree.ts:342-355` 的 try 裡）。一律 `unknown`（D-10）。

**clean filter（`src/worktree.ts:339` 的註解）：** 這段註解**也適用於釘住的路徑**。`PINNED_CONFIG`（`:69-76`）沒有 filter 相關項目，實測：common config 定義 `filter.x.clean`、worktree 的 `.gitattributes` 指定它，以釘住的參數與環境跑 `add -A`，filter **會執行**。對 28 的影響：

- 28 不新增任何 git 呼叫，所以沒有增加暴露；deadline 仍是唯一的邊界（27 已如此）。
- filter 輸出不穩定時 hash 永遠不同（假陰性，安全）。
- filter 把不同內容清成相同時會算「相同」，要造成這點，filter 必須在 repo 的 config 裡、由使用者（或 27.5 的 verify 指令）定義；最差結果仍是 `partial`。

## 28.6 錯誤方向

| 錯誤 | 情境 | 後果 |
|---|---|---|
| 假陰性（該停沒停） | flaky、亂數、平行輸出順序、指令寫檔 | 多一次退回；`max_rejections` 是保底 |
| 假陽性（不該停卻停） | 範圍外的東西變了但失敗文字完全相同；只差在被正規化掉的字樣 | 少一次退回，降為 `partial`，note 說明原因；使用者可 `resume <run> "<follow-up>"` 續做（新 segment 重新計算） |

兩個方向都不會造成 `completed`。本 spec 不會讓失敗變成成功：只有 `passed` 分支（`src/run-session.ts:1135`，在比對之前）會接受 `completed`。

## 28.7 流程

改動點只在 `verifyDone`（`src/run-session.ts:1136-1163`）。`:1117-1135` 不動。

```ts
const failed = must(out.failed, "failed verify command");
const spec = must(verify.commands.find((c) => c.name === failed.name), "verify command");
const counted = state.verify_rejected?.includes(source) ?? false;
const used = state.verify_rejections ?? 0;
const cmp = compareWithLastRejection({ source, fingerprint: must(failed.fingerprint, "failure fingerprint"), hash: diffHash, worktree: this.leadSpace !== undefined, records: state.verify, rejected: state.verify_rejected });
const segment = state.reopened?.length ?? 0;
const stoppedBefore = stoppedInSegment(state.verify, source, segment);
const left = verify.max_rejections - used;
const action = repeatAction(cmp, { counted, stoppedBefore, left });
log("verify-repeat", { source, name: failed.name, fingerprint: failed.fingerprint, previous: cmp.previous ?? null, same_fingerprint: cmp.sameFingerprint, hash: cmp.hash, action, rejections_left: left });
if (action === "limit") { /* :1141-1143，逐字不變 */ }
if (action === "stop") {
  record.repeat_stop_segment = segment;
  const note = repeatStopNote(failed.name, spec.run, describeFailure(failed, spec.timeout_sec), failed.log, used, verify.max_rejections);
  this.saveState();
  fault("verify:stopped");
  log("verify-failed", { name: failed.name, exit: failed.exit, repeat: true });
  say(`  done report not sent back: ${failed.name} failed the same way as last time and the workspace has not changed; accepted as partial`);
  return { kind: "exhausted", record, cwd, failure: { note } };
}
// :1145-1163 不變，只有信件內文改成：
//   body: withRepeatLabel(action, cmp.hash, rejectionMessage(...))
```

`record` 與 `state.verify` 最後一筆是同一個物件（`:1134`），所以 `record.repeat_stop_segment = segment` 會一起存下。

```ts
export function stoppedInSegment(records: VerifyRecord[], source: string, segment: number): boolean {
  return records.some((r) => r.source === source && r.repeat_stop_segment === segment);
}
export type HashRelation = "same" | "changed" | "unknown" | "no-worktree";
export type RepeatAction = "none" | "label" | "stop" | "limit";
export interface RepeatComparison { previous?: string; sameFingerprint: boolean; hash: HashRelation }
```

**`compareWithLastRejection`：** 依 D-01 找 `last`。`previous = last?.source`。`sameFingerprint`：`last` 裡第一條 `typeof fingerprint === "string"` 的指令，其值等於目前指紋；沒有（舊紀錄、通過的紀錄）就是 `false`。`hash`：`!worktree` → `no-worktree`；`hash` 或 `last?.diff_hash` 為 `undefined` → `unknown`；相等 → `same`；否則 `changed`。

**`repeatAction` 的完整真值表（單元測試照表逐列測）：**

| `counted` | `stoppedBefore` | `left` | `sameFingerprint` | `hash` | action | 說明 |
|---|---|---|---|---|---|---|
| 是 | — | — | 是 | 任何 | `label` | 重播已計數的 source：留在退回路徑，不可能停 |
| 是 | — | — | 否 | 任何 | `none` | 同上 |
| 否 | 是 | — | — | — | `stop` | 重播本 segment 已判定停止的 source（`stoppedBefore` 不看舊 segment 的標記，D-13） |
| 否 | 否 | ≤ 0 | — | — | `limit` | 27 D-08，含 `max_rejections: 0` |
| 否 | 否 | > 0 | 是 | `same` | `stop` | 本 spec 的停止 |
| 否 | 否 | > 0 | 是 | 其他 | `label` | |
| 否 | 否 | > 0 | 否 | 任何 | `none` | 退回信與現在相同 |

### 重播

| 崩潰點 | 當時已存的 state | 重播時 | 結果 |
|---|---|---|---|
| `verify:counted`（`:1151`） | 紀錄 R1（source S）、`verify_rejections` 已加、S 在 `verify_rejected` | 指令重跑，追加 R2（也是 S）。`counted` 為真 | 不重算、不會停；信送出一次 |
| `verify:sent`（`:1159`） | 同上，且 journal 已有信 | 同上；`deliverOnce` 沿用同一個 id 與檔名 | 不重算、不會停、不多一封信 |
| `verify:stopped`（新） | 紀錄有 `repeat_stop_segment`（等於目前 segment）；次數未動 | 不帶 follow-up 的 `resume`：指令重跑；又失敗 → `stoppedBefore` → `stop`，不管這次的指紋與 hash；通過 → 以通過收下。`end_reason` 還沒寫，所以 follow-up 會被拒絕（`src/run-session.ts:232`、`src/cli.ts:379-380`） | 不計數、不多信、判定不變 |
| `run:ended`（新，`:1429` 的 `saveState` 與 `:1430` 的 `finishDone` 之間） | `end_reason: done` 已存；`done` 檔還在 outbox | 不帶 follow-up 的 `resume`：`src/cli.ts:381` 回「already finished」，不重播。帶 follow-up：見下面的 reopen | 依 D-18 |
| `saveState` 之前 | 這次的紀錄未存 | 視為全新的一次驗證 | 外界還沒看到任何判定，重新判定沒有問題 |
| 重播中指令通過 | 任何 | `:1135` 先於比對 | 與 spec 27 現況相同（已計數的那次留在計數裡） |

比對時自己的紀錄被 D-01 排除，所以 R1、R2 不會互比。之後 lead 送出新的 `done`（S'）時，比對的是 S 最新的紀錄 R2。

**更正：`deliverOnce` 不是「第一封內文優先」。** 同一個 key 重送時，只要信還沒被讀且內容不同，檔案會被**新內文覆寫**（`src/mailbox.ts:163`）；已讀才不再寫。所以 `verify:sent` 之後的重播若輸出或標籤不同，未讀的那封信內容會更新成重播這次的結果，id、檔名、封數不變。內文一定對應實際跑出來的結果，不需要額外處理；次數沿用已存的值，所以「第幾次」的文字不變。

### reopen

`verify_rejected`、`verify_rejections` 在 `resume <run> "<follow-up>"` 時歸零（`src/run-session.ts:299-300`），`state.verify` 保留。新 segment 第一次失敗找不到比較對象（D-01），`action` 是 `none`，舊紀錄不會觸發停止，也不會標籤。舊紀錄上的 `repeat_stop_segment` 與新 segment 的編號不同，不會有作用（D-13）。不帶 follow-up 的 `resume` 不歸零，segment 也不變，比對照常。

**例外：舊 `done` 進入新 segment。** 崩潰發生在 `end_reason` 存檔之後、`finishDone` 之前（`src/run-session.ts:1429-1430`；開 PR 的路徑是 `:1423-1424`）時，被接受的 `done` 檔留在 outbox。follow-up 可以進來（`:232`、`src/cli.ts:379`），`:299-300` 只歸零計數器，`recover()` 呼叫 `settle([], [])`（`:1321`），`routeOutboxes` 再次回傳這個 `done`（`src/mailbox.ts:382-400`），`source` 不變。

這條路徑在 `dc54b10`（**沒有 spec 28**）的實際行為，用 `git archive dc54b10` 的副本與假 invoker 實跑（把第一段結束後的 `done` 從 `read/` 搬回 outbox，mtime 不變，等同那個崩潰狀態）：

| 第一段結果 | reopen 時舊 `done` 的處理 | follow-up 這次有沒有被處理 |
|---|---|---|
| 沒有 `verify`，`completed` | 不驗證，直接再次接受；`done-2.md` 與 `done-1.md` 內容相同 | **沒有**：lead 沒被喚醒就結束（`end_reason: done`、`completed`） |
| `verify` 通過 | 重新驗證（`state.verify` 2 筆，同一個 source），通過，接受 | **沒有**：同上 |
| `verify` 失敗，`max_rejections: 0` | 重新驗證，走 `limit`，`partial` | **沒有**：同上 |
| `verify` 失敗，`max_rejections: 1` | 重新驗證，新 segment 的次數已歸零，所以退回（`verify_rejections` 1） | **有**：lead 被喚醒，prompt 同時有 follow-up 與退回信 |

follow-up 信不會消失，它留在 lead 的 inbox 未讀；但 run 已回報結束，不帶文字的 `resume` 只會說 already finished（`src/cli.ts:381`），只有再下一個 follow-up 才會讓 lead 同時讀到兩封（實跑確認）。**這是既有問題，與 spec 28 無關，也與 `verify` 無關。**

**加上 spec 28 之後（依 D-13、D-18）：** 舊 `done` 來自第一段的 `stop` 時，`stoppedBefore` 為假（標記是舊 segment 的）、`counted` 為假、`left` 是完整的次數、比較對象不存在（`verify_rejected` 已空），所以：

- **又失敗：** `action` 是 `none`。照常退回、計 1 次、信沒有標籤（`verify-reject:<source>` 從未送過，所以會真的送出）；lead 被喚醒，同時看到 follow-up 與退回信。這是新 segment 第一次失敗的一般結果，**不會停**。
- **這次通過：** 以 `completed` 接受，lead 不被喚醒，follow-up 留在 inbox，與上表相同。
- **lead 接著送的新 `done`（S'）：** 比較對象是舊 `done` 在新 segment 的那筆紀錄。同指紋、同 hash 而且還有次數 → `stop`（note 寫 `1 of 2`），標記記為新 segment；工作區有變 → 標籤與次數。舊 `done` 用掉新 segment 一次退回，這點與 `dc54b10` 相同。

舊 `done` 也可能來自 `limit` 或通過的路徑（`max_rejections` 0、1 時只會是這兩種，D-11）；那些情況沒有停止標記，28 不多做任何事，結果就是上表。

## 28.8 文字（逐字）

**退回信的標籤**，放在 `rejectionMessage` 結果的最前面，中間一個空行。`rejectionMessage` 本身不改。

`action === "label"`：

```
**Same failure as your last rejected `done`** (same command, same exit status, same last lines of output; times and paths ignored).
```

`action === "label"` 且 `cmp.hash === "changed"`，同一行後面再接：

```
 The workspace changed since then, but this result did not.
```

其他 `hash`（`no-worktree`、`unknown`，以及重播才會遇到的 `same`）不加這句：標籤不宣稱工作區的狀態。`action === "none"` 時內文與現在逐字相同。

**停止的 note**（`repeatStopNote`；`<failure>` 是 `describeFailure` 的結果）：

```
Verification stopped early: `<name>` (`<run>`) <failure>; this is the same failure as the last rejected attempt and the workspace has not changed since, so no progress is likely and the `done` was not sent back again (<used> of <max> rejection(s) used); see <log>. Reported as partial; the lead's report is kept as written.
```

例：``Verification stopped early: `test` (`npm test`) exited with code 1; this is the same failure as the last rejected attempt and the workspace has not changed since, so no progress is likely and the `done` was not sent back again (1 of 2 rejection(s) used); see verify/2-test.log. Reported as partial; the lead's report is kept as written.``

有工作未整合時 outcome 維持 `blocked`，`resolveDoneOutcome` 把 `Not completed: work of ... was never brought into the repo; ...` 接在這段 note 前面（`src/run-outcome.ts:30`）。

## 28.9 量測

事件 `verify-repeat`，寫入 `log.jsonl`，每次驗證失敗一筆：

```json
{"event":"verify-repeat","source":"<16 hex>","name":"test","fingerprint":"<16 hex>","previous":"<16 hex>|null","same_fingerprint":true,"hash":"same|changed|unknown|no-worktree","action":"stop|label|none|limit","rejections_left":1}
```

- 重播會多一筆，`source` 相同；統計時依 `source` 去重。
- 分母：失敗次數。觸發：`action: "stop"`。**省下的喚醒上限：** 這些 `stop` 的 `rejections_left` 總和（lead 也可能本來就改報 `partial`，所以是上限）。
- `action: "limit"` 且 `same_fingerprint: true`、`hash: "same"` 表示次數用完時才發生重複，沒省到。

```bash
grep -h '"verify-repeat"' ~/agent-lyceum-config/projects/*/runs/*/log.jsonl | jq -r '[.action, .hash, .rejections_left] | @tsv' | sort | uniq -c
```

事件內沒有輸出文字，只有指令的 `name` 與 hash。原始輸出仍在 `verify/<n>-<name>.log`（27 D-11）。

## 28.10 測試與驗證

全部用假指令，不呼叫真實 `claude`／`codex`，不進網路，不碰真實 `~/agent-lyceum-config`。worktree 模式的測試用 `initGitRepo(env.repo)`；沒有它的 `makeEnv()` 就是非 worktree 模式。

**單元（新檔 `test/repeat-detect.test.ts`）：**

- `normalizeOutput`：28.4 兩張表每一列；ANSI；CRLF；結尾 `\r`；`\r` 覆寫；空輸出與只有空行；超過 100 行只看最後 100 行；**前面的行變長、最後 100 行相同時結果相同**（byte 尾端做不到的那一點）；路徑邊界（`/w/x` 不吃 `/w/x2`、`/w/x.bak`）；自訂 `TMPDIR`。
- `failureFingerprint`：name 不同、exit 不同 → 不同；只差時間 → 相同；只差斷言文字 → 不同；`timed_out` 不受 `exit` 影響；`signal`；`error` 文字含 cwd 時正規化；空輸出穩定；長度 16。
- `compareWithLastRejection`：沒有比較對象；只有自己的紀錄；同 source 多筆取最新；不在 `verify_rejected` 的紀錄被跳過；舊紀錄沒有 `fingerprint`；`worktree: false` 時即使 `diff_hash` 相同也是 `no-worktree`；任一邊 `undefined` 是 `unknown`，兩邊都 `undefined` 也是。
- `repeatAction`：28.7 真值表每一列。
- `stoppedInSegment`：標記 `0` 且 segment `0` 為真（不可用 truthy 判斷）；標記 `0` 且 segment `1` 為假；別的 source 為假；沒有標記為假。
- 效能：256 KiB 刻意構造輸入（28.4 所列）每種在寬鬆上限內（如 500 ms）完成。

**整合（加進 `test/verify.test.ts`，用既有的 `leadDones`、`crashAt` 手法）：**

| # | 情境 | 期望 |
|---|---|---|
| 1 | 同指紋 + 同 hash：worktree，`max_rejections: 2`，`echo nope; exit 1`，lead 不改東西 | 喚醒 2 次；`partial`；note 含 `Verification stopped early`；`verify_rejections` 1；`verify_rejected` 長度 1；退回信 1 封；`verify-repeat` 依序 `none`、`stop`（`rejections_left: 1`）；`open_pr: true` 不開 PR；`result.md` 含 `NOT all commands passed` |
| 2 | 同指紋 + 不同 hash：lead 每次寫一個新檔（比照 `:334`） | 喚醒 3 次；第二封信以標籤開頭且含 `The workspace changed`；最後是 27 的 note（`Verification failed after 2 rejection(s)`） |
| 3 | 不同指紋：輸出或 exit 隨 flag 變 | 沒有標籤；走次數 |
| 4 | fail-fast：第一次 `a` 失敗，修好後 `b` 失敗 | 不同指紋；第二封沒有標籤 |
| 5 | 沒有 worktree：`makeEnv()`（非 git）與 `git init` 但沒有 commit（**這時 `diff_hash` 有值**，要 assert），工作區不變 | 兩者都不停；喚醒 3 次；第二封有標籤但沒有 `The workspace changed`；`verify-repeat` 的 `hash` 為 `no-worktree`；27 的 note |
| 6 | worktree 但 hash 取不到：lead 第一次喚醒在 worktree 內建巢狀 repo | `diff_hash` 不存在；不停；標籤無 `The workspace changed`；`hash` 為 `unknown` |
| 7 | 崩潰重播 `verify:counted`、`verify:sent`（`it.each`，**worktree 模式**，`max_rejections: 2`）：第一個 `done` 崩潰後重播，lead 再送一個不改東西的 `done` | 重播本身不停（第二次喚醒有退回信，`result.md` 不存在，`verify_rejections` 1）；退回信 1 封；新的 `done` 才停；`verify` 3 筆 |
| 8 | 崩潰重播 `verify:stopped`：測試在崩潰後、resume 前設 flag，讓指令這次的輸出不同 | 仍 `stop`；`verify_rejections` 仍 1；退回信仍 1 封；另一案：重播時指令通過 → `completed` |
| 9 | reopen：第一段以 `stop` 結束；follow-up 同樣失敗且工作區不變 | 第一次失敗是退回（無標籤），次數從 1 起算；再一次才 `stop`；`state.verify` 保留舊紀錄 |
| 10 | 舊紀錄：崩潰後手動從 `state.json` 刪掉 `fingerprint` 再 resume | 載入成功；新 `done` 不停、無標籤 |
| 11 | `max_rejections: 0`、`1`（worktree、工作區不變） | 走 27 的 note，逐字不變；`action: "limit"`；`1` 時第二次也是 `limit` |
| 12 | `blocked`（比照 `:448`）+ 重複停止 | `blocked`；note 同時含未整合與 `Verification stopped early` |
| 13 | 沒有 `verify`（擴充 `:213`） | 沒有 `verify-repeat`；state 沒有 `verify` |
| 14 | 全部通過（擴充 `:223`） | 沒有 `verify-repeat`；紀錄沒有 `fingerprint`、`repeat_stop_segment` |
| 15 | `status --json`（擴充 `:612`）：紀錄含 `fingerprint`、`repeat_stop_segment` | 輸出與沒有這些欄位時相同（`state.verify` 不進 `RunReport`，`src/status.ts:379-380`） |
| 16 | 舊 `done` 進入新 segment：worktree，`max_rejections: 2`，`echo nope; exit 1`。第一段 S1 退回、S2 `stop`（`repeat_stop_segment: 0`），在 `run:ended` 崩潰；state 已是 `end_reason: done`，S2 還在 outbox。接著 `resume` 帶 follow-up，lead 不改東西再送 S3 | **follow-up 後的第一次失敗（S2 重驗）不停：** 第三次喚醒的 prompt 同時有 follow-up 文字與 `failed verification`，當下 `verify_rejections` 1、`verify_rejected` 只有 S2，第二封信無標籤。**S3 才停：** `partial`，note 含 `Verification stopped early` 與 `1 of 2`；喚醒共 3 次；退回信共 2 封；`verify` 4 筆（S1、S2、S2、S3），`repeat_stop_segment` 依序無、`0`、無、`1`；`verify-repeat` 依序 `none`、`stop`、`none`、`stop`。另一案：lead 在該次喚醒寫一個新檔 → S3 退回且有 `The workspace changed`，再下一個是 27 的 note `Verification failed after 2 rejection(s)` |

**既有測試不應變動（讀碼確認，實作時以實跑為準）：** 會多次失敗的既有測試不是非 worktree 模式（`makeEnv()` 沒有 `initGitRepo`，例如 `:559`），就是 `max_rejections: 1` 且每次寫新檔（`:315-346`），都走不到 `stop`。`:278` 的第二次是通過。

**未驗證：** 真實 runtime；真實專案的輸出是否真的穩定到會命中；Linux 上的 regex 與 git 行為（本文實測在 macOS，邏輯不依賴平台）；實際能省多少喚醒（要靠 28.9 累積）。

Definition of Done：`npm run typecheck && npm run lint && npm test`，文件改動另跑 `npm run check:docs`。在 agent sandbox 內跑 `npm test` 的基準失敗見 lesson `agent-sandbox-cannot-test-sandbox-widening`。

## 28.11 影響的檔案

**程式（`node-engineer`）：**

- 新檔 `src/repeat-detect.ts`：28.4、28.7、28.8 的函式與文字。
- `src/verify.ts`：`runVerify` 在 `:160` 之後加一行（28.4）；`:6` 型別不變。**這個檔案不在需求原本列的清單裡**，但原始輸出只在這裡（`:162`），要算指紋就得動它（不採用的做法見 28.3）。`rejectionMessage`、`describeFailure`、`commandPassed` 不改。
- `src/run-session.ts`：`verifyDone` 的 `:1136-1163`（28.7），新 import。`:1117` 的回傳型別不變。`:1429` 與 `:1430` 之間加一行 `fault("run:ended");`（沒有設 hook 時不做任何事，`src/message-store.ts:11-13`；只供 28.10 #16 使用）。`:1423-1424`、`:1430` 的 `finishDone` 順序不動。
- `src/run-store.ts`：`VerifyCommandRecord.fingerprint?: string`（`:92`，註解 `spec 28`）、`VerifyRecord.repeat_stop_segment?: number`（`:103`，註解：`spec 28: this done was stopped as a repeat, in this segment (state.reopened length)`）。**zod schema 不改**（`:232` 是 `z.any()`），`schema_version` 不動。
- `src/run-outcome.ts`：**只改註解**（`:17`，改成 `Spec 27/28: a verify command failed and no rejections were left, or the same failure repeated on an unchanged workspace; note says which and how.`）。邏輯不需要改（D-12）。
- `src/worktree.ts`：**只改註解**（`:362`，`spec 27.7 record only` 改成 `spec 27.7 record, spec 28 comparison`）。
- 不改：`src/status.ts`、`src/doctor.ts`（「up to N rejection(s)」仍然正確）、`src/schema.ts`、`src/config.ts`、`plugins/`。

**測試（`node-engineer` 寫，`qa` 驗）：** `test/repeat-detect.test.ts`（新）、`test/verify.test.ts`。

**文件（`docs-writer`，成對）：** 不新增標題，`check:docs` 的成對檢查不受影響。`README*.md` 不改（沒有新鍵，Downgrading 不受影響）。

`docs/configuration.md:201`，`max_rejections` 那一項結尾加上：

> The limit can end early: when a `done` fails exactly as the previously rejected one did and the lead's worktree has not changed, it is accepted as `partial` without using another rejection (see [How a run works](how-it-works.md#verifying-a-completed-done)). (Spec 28)

`docs/configuration.zh-TW.md:203`，同一項結尾加上：

> 次數可能提早結束：若 `done` 的失敗與上一次被退回的完全相同，且 lead 的 worktree 沒有變動，就不再退回、不消耗次數，直接以 `partial` 收下（見[怎麼運作](how-it-works.zh-TW.md#驗證-completed-的-done)）。（spec 28）

`docs/how-it-works.md:77` 之後新增一項：

> - **The same failure again:** a failure is compared with the previously rejected `done` of the same segment, by a fingerprint of the failing command's name, its exit status and its last 100 lines of output (with ANSI codes, clock times, durations, temp paths and the run's own paths removed). Same fingerprint and the same tree in the lead's worktree (tracked changes and untracked, non-ignored files; ignored files are not looked at): no progress is likely, so the `done` is not sent back again. It is accepted as `partial` with a note saying why, and no rejection is used. This is a heuristic: ignored dependencies, environment variables and external services are not compared, so a retry that might have passed can be cut short, but it can never report success. Same fingerprint with a changed tree: the `done` is sent back as usual and the mail starts by saying it is the same failure. Without a lead worktree (a run working in `project.dir`), or when the tree hash could not be taken, the tree is not compared: the run does not stop early, the mail still says it is the same failure, and `max_rejections` is the only limit. Each failed verification writes a `verify-repeat` event to the run log. (Spec 28)

`docs/how-it-works.zh-TW.md:77` 之後新增一項：

> - **同樣的失敗再次發生：** 每次失敗都會和同一段落內上一次被退回的 `done` 比較，依據是失敗指令的名稱、結束狀態與輸出最後 100 行的指紋（已去除 ANSI 控制碼、時鐘時間、耗時、暫存路徑與本 run 自己的路徑）。指紋相同，且 lead 的 worktree 內容也相同（已追蹤的變更，加上未追蹤且未被 ignore 的檔案；被 ignore 的檔案不看）：很可能沒有進展，所以不再退回，以 `partial` 收下並附上原因，不消耗退回次數。這是啟發式判斷：被 ignore 的相依、環境變數與外部服務都沒有比較，所以原本可能通過的重試可能被提早結束，但絕不會回報成功。指紋相同但內容有變：照常退回，信件開頭會說明是同樣的失敗。沒有 lead 的 worktree（run 直接在 `project.dir` 工作），或取不到內容 hash 時，不比較內容：不會提早停止，信件仍會說明是同樣的失敗，上限只有 `max_rejections`。每次驗證失敗都會在 run log 寫一筆 `verify-repeat`。（spec 28）

**索引：** `docs/specs/README.md` 加一列（本 spec 一併完成）。`docs/specs/27-dispatcher-verify.md` 不改：它的狀態行與 27.2 已經指向 28，行為也沒變。實作完成後把本文狀態行改成已實作並加文件連結。

## 28.12 評估範圍（Dimension coverage）

| 面向 | 狀況 |
|---|---|
| 相容與格式 | 只加兩個選填的紀錄欄位，`state.verify` 是 `z.any()`，不升版、不改 schema、沒有新設定鍵。舊 run：沒有 `fingerprint` 的紀錄不相符（28.10 #10）。舊 binary 遇到新 run：多的欄位被忽略、照常載入；舊 binary 續跑時不做比對，新 `done` 只走次數。沒有 `verify` 的專案、全部通過的驗證、第一次失敗的信，都與現在逐字相同。`status --json` 欄位不變（`state.verify` 不進 `RunReport`）；`outcome_note` 是既有欄位，只是多了一種文字 |
| 檔案與行程安全 | 不新增任何子行程與 git 呼叫；hash 沿用釘住路徑（D-08），clean filter 的暴露與 27 相同（28.5）。指紋是雜湊，輸出文字不進 state、log 與標籤，沒有注入面。note 只含使用者寫的 `name`、`run` 與既有的 `describeFailure`，與 27 的 note 相同。verify 指令可以改寫磁碟上的 `state.json`（27.5），藉此影響 resume 後的比對，最多造成提早停或不停，結果仍是 `partial` 或次數上限；這個機制本身不會讓失敗變成 `completed`（27.5 的其他風險不變，例如腳本改成 `exit 0`） |
| 並發與復原 | 比對在 `verifyDone` 內同步完成，沒有新的鎖。崩潰與重播見 28.7（`verify:counted`、`verify:sent`，新增 `verify:stopped`、`run:ended`）；舊 `done` 進入新 segment 是既有問題（D-18、28.13），28 只保證停止標記不跨 segment。Ctrl-C：取消時 `out.cancelled` 先返回（`:1128`），沒有紀錄也沒有比對。逾時、無法啟動、空輸出都有定義（D-04、D-06）。多個 run 各有自己的 `state.verify`，互不影響；共用機器資源造成的輸出差異只是假陰性 |
| 平台與可維運 | macOS／Linux；Windows 不支援（與 27 相同）。regex 涵蓋兩者的暫存路徑；Linux 未實測。Claude、Codex 無差異：機制在 dispatcher，與 runtime 無關，lead 看到的只是信件文字。喚醒迴圈：每次失敗的驗證多幾毫秒（28.4）。沒有新依賴（`stripVTControlCharacters` 是 Node 內建，`engines` 為 >=20）。note 與標籤都說明原因 |
| 測試與可維護 | 純函式加真值表；假指令加既有的 fault seam；不依賴真實設定或 runtime。只新增一個模組；沒有新抽象 |
| 可觀測與可診斷 | `verify-repeat`（28.9）說明每次比對的結果與動作；`state.verify` 留有指紋、`diff_hash`、`repeat_stop_segment`；`outcome_note`、`result.md`、`done-<n>.md` 含 note；原始輸出在 `verify/`。`status`、`doctor` 不必改：`status` 文字顯示的 `outcome_note` 超過 200 字元會被截（`src/status.ts:543`），note 的重點在前段，全文在 `result.md` |
| 誤判後果（本功能特有） | 28.6：兩個方向都不會誤報成功 |

**分工：** `node-engineer` 實作 28.11 的程式與測試；`cli-reviewer` 審；`qa` 依 28.10 驗證，特別是 #5、#7、#8、#16（這四項對應四個最容易錯的前提）；`docs-writer` 依 28.11 的文字更新四個文件，`docs-reviewer` 審。

## 28.13 待決與後續

沒有擋住實作的問題；以下都是後續事項。

0. **實作後的註記：** `status --json` 的鍵不變；但 `wakes[].handling[].brief`／`digest` 本來就取自信件文字（`src/status.ts:284-285`），所以帶標示的退回信，這兩個值會以標示開頭，`brief` 裡的 `**` 也會照原樣出現。外掛只把它們當文字顯示（`plugins/status-monitor/hooks/graph.ts:28-33`）。

1. **§6.2 第 2 項不做：** 跨 wake 的訊號（同一 agent 連續失敗的錯誤文字、一個 thread 的來回次數）只記錄不停止，另案；它不依賴 spec 27。
2. **看 28.9 的資料再決定：** 100 行與 256 KiB 是否合適；正規化要不要多去掉 PID、位址（目前都是假陰性）；要不要開關。沒有資料之前不改。
3. **指令寫檔造成 hash 不穩：** 若資料顯示這是主要的未命中原因，可考慮另外在指令執行**之後**取一次 hash 作比較；這會多一次 git 成本，也要重新定義「沒變」，第一版不做。
4. **第 29 號 spec** 若要用 `diff_hash` 或指紋做跳過或快取，方向相反（誤放比誤擋嚴重，評估 §6.3），不能直接沿用本文「錯了只是 `partial`」的論據。
5. **既有問題：舊 `done` 讓 follow-up 當次沒被處理（與 28、與 `verify` 都無關，28.7 reopen 有實跑結果）。** 窗口很窄（`src/run-session.ts:1429-1430`、`:1423-1424` 都是相鄰的兩行），後果是使用者的 follow-up 留在 inbox 未讀、run 卻回報結束，`done-<n>` 是舊報告的副本。建議另開 issue。方向（未實作、未驗證）：reopen 時 lead 不在執行，outbox 裡的 `type: done` 只可能是上一段留下的，可在 `recover()` 之前用 `finishDone` 收掉。開 PR 的路徑上舊 `done` 重新被接受時會不會再開一次 PR，本文**未驗證**。
