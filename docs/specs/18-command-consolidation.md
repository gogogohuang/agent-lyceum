# 18 合併頂層指令（10 → 6）

狀態：設計定案，review 第 1 輪修訂；lead 已併入第 2 輪複審 55c1d0dc 的 M1、M2 修正，設計定案（實作切分見 18.11）。

## 18.1 問題

- 0.17.x 有 10 個頂層指令：`init`、`project`、`run`、`resume`、`call`、`status`、`doctor`、`clear`、`tidy`、`demo`。其中四組做的是同一件事的不同面向：
  - `run` 開始一個 run，`resume` 繼續、回答或重開一個 run，都是「讓一個 run 動起來」。
  - `status` 看狀態，`doctor` 檢查設定，都是「不叫醒任何 agent，只回報」。
  - `clear` 刪 run 與鎖，`tidy` 整理記憶，都是「維護、清理」。
  - `init` 建 home，`demo` 建一個沙盒 home 加範例 repo，都是「準備一個 home」。
- 使用者決定（01de42ac）：`resume`→`run`、`doctor`→`status`、`tidy`→`clear`、`demo`→`init`；`call` 保留；舊名稱直接移除、不留別名；版本 **0.18.0**。
- 12 號 spec 曾以「互斥旗標組合讓總複雜度不降」為由不合併 `resume`、`doctor`。這次使用者已決定合併，所以本 spec 的重點是把互斥規則寫死、每個錯誤組合都有一行說明，讓「指令從參數判斷要做什麼」不會猜錯。

結果：`init`、`project`、`run`、`call`、`status`、`clear`。

## 18.2 總則

| # | 決議 |
|---|---|
| 1 | 這是 CLI 介面的改動。`doctor.ts`、`memory-tidy.ts`、`demo.ts`、`run-session.ts` 等模組保留，只改 `src/cli.ts` 的指令定義與各處印給人看的字串。不新增依賴。 |
| 2 | 設定檔、`state.json`、run 目錄、mailbox、`.archive/`、`.tidy-state.json` 的格式都不變；舊 run 與舊 `project.yaml` 照常載入。舊版程式讀新資料不受影響（沒有格式變動）。 |
| 3 | 每個指令的「模式」由旗標與參數決定。模式之間互斥：給了屬於另一個模式的旗標就以 exit 1 結束，訊息一行說明哪個旗標屬於哪個模式，並在**取鎖、叫醒 agent、寫任何檔案之前**報錯。 |
| 4 | 只看參數就能判斷的衝突（例如 `--tidy-memory` 配 `--lock`），在載入專案之前就報錯；需要查 run 清單才能判斷的（例如 `run fix-login` 是不是 run），在載入專案後、preflight 之前報錯。 |
| 5 | 每個模式的 exit code 與合併前相同（18.8）。 |
| 6 | `status --json`（一般、`--task-list`、`--task-id`）的輸出在相同的磁碟狀態下逐位元組不變（18.5.3）。 |

## 18.3 被移除的指令

| # | 決議 |
|---|---|
| 1 | `resume`、`doctor`、`tidy`、`demo` 不再是指令，不留別名。 |
| 2 | 但每個舊名稱註冊一個**隱藏的 stub**（`program.command(name, { hidden: true })`，`allowUnknownOption()`、`allowExcessArguments()`、`helpOption(false)`），不出現在 `--help`；被呼叫時（含帶任何參數或 `--help`）印一行指向新寫法的錯誤到 stderr，exit 1。不執行任何其他動作、不載入專案。 |
| 3 | 訊息（逐字）：<br>`resume`：`"resume" was removed in 0.18.0; use: agent-lyceum run [<exact-run-name-or-id>] ["<follow-up>"] [--answer]`<br>`doctor`：`"doctor" was removed in 0.18.0; use: agent-lyceum status --check (or status --resolved)`<br>`tidy`：`"tidy" was removed in 0.18.0; use: agent-lyceum clear --tidy-memory [--agent <name>] [--undo <stamp>]`<br>`demo`：`"demo" was removed in 0.18.0; use: agent-lyceum init --demo` |
| 4 | `--help` 分層改為：Project＝`init`、`project`；Diagnose＝`status`；Run＝`run`、`call`、`clear`。「Try it」層移除，`init` 的說明裡寫出 `--demo`。 |
| 5 | `agent-lyceum help <name>`（`resume`、`doctor`、`tidy`、`demo`） 也印同一行、exit 1。commander 14 的 `help <name>` 走 `_dispatchHelpCommand` → 直接呼叫該指令的 `help()`（印出 stub 的空說明、exit 0），不會進 stub 的 action。所以 stub 用 `Command` 的子類別建立（`program.addCommand(new RemovedCommand(name), { hidden: true })`），覆寫 `help()` 與 `outputHelp()` 為「印那一行到 stderr、exit 1」；action 也呼叫同一個函式。不改 commander 內部、不自己掃 argv。 |

**捨棄的做法**

- commander 預設的 unknown command（12 號 spec 的做法）：只印 `error: unknown command 'resume'`，可能附上不相干的「Did you mean」，使用者不知道去哪裡。這次舊名稱都是常用指令（`resume` 出現在每次中斷、失敗的提示裡），一定要有指路。
- 在 `parseAsync` 前自己掃 `process.argv`：要處理 `--home <dir>` 這種帶值的全域選項才找得到第一個指令名，容易出錯；隱藏 stub 讓 commander 自己解析。
- 保留可用的別名：使用者已決定不留。

## 18.4 `run`

### 18.4.1 用法

```
agent-lyceum run "<task>"                        開新 run（文字）
agent-lyceum run --task-file <path>              開新 run（檔案）
agent-lyceum run                                 繼續最新一個未完成的 run（原 resume）
agent-lyceum run <run>                           繼續該 run；已 done 的只印結果（原 resume <run>）
agent-lyceum run <run> --answer [--no-edit]      回答等待中的 run 後繼續（原 resume <run> --answer）
agent-lyceum run <run> "<follow-up>"             重開已 done 的 run（原 resume <run> "<text>"）
agent-lyceum run <run> --task-file <path>        重開已 done 的 run，追加內容來自檔案
```

`<run>` 必須是**完整的** run id 或 run 名稱。前綴不會繼續或重開任何 run（18.4.3 決議 5a）。`clear <run>`／`clear --lock <run>` 同樣要完整 id／名稱（決議 5b）；只有唯讀的 `status --task-id` 仍接受唯一前綴（16 號 spec 決議 2，`resolveRun`），理由見 18.4.3。

### 18.4.2 選項

| 選項 | 新 run | 繼續 | 重開 | 來源 |
|---|---|---|---|---|
| `-p, --project <name>` | ✓ | ✓ | ✓ | run、resume |
| `--task-file <path>` | 任務 | ✗ | 追加內容 | run、resume |
| `--name <name>` | ✓ | ✗ | ✗ | run |
| `--agent <name>` | ✓ | ✗ | ✗ | run |
| `--assume-defaults` | ✓ | ✓ | ✓ | run、resume |
| `--answer` | ✗ | ✓ | ✗ | resume |
| `--no-edit` | ✗ | 須配 `--answer` | ✗ | resume |

舊 → 新：`resume` → `run`；`resume <run>` → `run <run>`；`resume <run> "<text>"` → `run <run> "<text>"`；`resume <run> --task-file f` → `run <run> --task-file f`；`resume [<run>] --answer [--no-edit]` → `run [<run>] --answer [--no-edit]`；`resume --assume-defaults` → `run --assume-defaults`。**唯一不能逐字換的：`resume "<text>"`（沒給 run 的追加要求）**，見 18.4.4。

### 18.4.3 判斷規則

以 `A`、`B` 表示位置參數。所謂「像 run 參照」＝`A` 符合 `NAME_RE`（`/^[A-Za-z0-9][A-Za-z0-9_-]*$/`：一個字、沒有空白、只含英數 `_` `-`）。run 名稱（slug）與 run id 一定像 run 參照；含空白或其他字元的文字一定不是。

依序判斷，第一條成立就決定模式：

| # | 條件 | 模式 |
|---|---|---|
| 1 | 有 `A`、`B` | **重開** `A`。`A` 用 `findRunExact`（決議 5a）解析：不是完整 id／名稱就報錯（不退回成新任務）。`B` 是追加內容。 |
| 2 | 有 `A`，有 `--task-file` | **重開** `A`，追加內容讀檔。`A` 同樣必須是完整 id／名稱。 |
| 3 | 沒有 `A`，有 `--task-file` | **新 run**，任務讀檔。 |
| 4 | 有 `A`，`A` 不像 run 參照 | **新 run**，`A` 是任務文字。 |
| 5 | 有 `A`，`A` 像 run 參照 | 以 `findRunExact` 查：完整命中 → **繼續** 該 run；只有前綴命中或沒有命中 → 報錯（決議 5a、5b）。**不會**變成新任務。 |
| 6 | 沒有參數也沒有 `--task-file` | **繼續**最新一個未完成（非 done、非執行中）的 run（`latestUnfinishedRun`）。沒有就報錯：`No unfinished run to continue. Start one with: agent-lyceum run "<task>"`。 |

**決議 5a：`run` 只認完整 id 或名稱**

`run` 會叫醒 agent、花額度，所以決議 1、2、5 的 `A` 只在**完全等於**某個 run 的 `run_id` 或 `name` 時才算命中。新增 `cli.ts` 的 `findRunExact(pr, query)`（不改 `resolveRun`）：

1. 空字串、不合 `NAME_RE`：與 `findRun` 相同的錯誤。
2. `run_id === A` 或 `name === A` 剛好一個 → 回傳它。（兩個以上：與 `findRun` 的歧義訊息相同；正常資料不會發生。）
3. 否則用 `resolveRun` 的前綴規則算候選，**不提示、即使在 TTY 也不問**，不叫醒任何 agent、不取鎖、不寫任何檔，exit 1：
   - 剛好一個前綴候選，一行：<br>`"fix-login" is only the start of run fix-login-mobile (<run-id>); run needs the exact name or id: agent-lyceum run fix-login-mobile`<br>建議的指令依使用者的模式組出：繼續 → `agent-lyceum run <full>`；有 `--answer` → 加 ` --answer`（有 `--no-edit` 再加）；重開文字 → `agent-lyceum run <full> "<follow-up>"`（字面的佔位字，不回顯使用者的文字，可能很長或多行）；重開檔案 → `agent-lyceum run <full> --task-file <使用者給的 path>`；有 `-p` 時加 ` -p <p>`。`<full>` 是名稱，舊 run 沒有名稱時用 id。
   - 多個前綴候選：`"fix" matches several runs only by prefix:`，下面每行一個候選（格式同 `findRun`），最後一行 `Give the exact name or id: agent-lyceum run <name-or-id>`。
   - 沒有候選：決議 1、2 印 `findRun` 的 not found 訊息；決議 5 印下面的訊息。

**決議 5b：會動東西的要完整名稱，只讀的可用前綴**

- `status --task-id <prefix>`：唯讀，維持唯一前綴（`resolveRun` / `findRun`）。
- `clear <run>`、`clear --lock <run>`：**收緊為完整 id／名稱**，用同一個 `findRunExact`，前綴命中時的訊息把 `run` 換成 `clear`（例：`... clear needs the exact name or id: agent-lyceum clear fix-login-mobile`，有 `--dry-run`／`--keep-worktrees`／`--lock`／`--force` 時照樣附上）。理由：`clear <run>` 不經確認就刪 run 目錄、任務記憶與 worktree，無法復原，比誤叫醒團隊更糟；`clear --lock --force` 會解除別人的鎖。規則因此只有一條：叫醒、刪除、解鎖要完整名稱；只看的可用前綴。代價：0.17 的 `clear <prefix>` 會變成 exit 1 並給出完整指令，列入升級說明（18.9）。
- `clear --lock <run>` 的查找順序（lead 依 review 55c1d0dc M2 決定）：先拿 `<run>` 與 `locks/` 下的鎖檔 id **完全比對**（含讀不出內容的鎖檔、沒有可讀 run state 的鎖），命中就照現有 `unlockProject` 的流程處理；沒有命中時才用 `findRunExact` 以 run state 的完整名稱／id 解析出 run id 再找它的鎖。只是前綴的一律照 5a 拒絕。legacy 專案層 `lock.json`、`--force` 與不給 run 時的既有行為不變。這樣崩潰後 state 未建立／已壞掉的鎖仍能用 `clear --lock <完整 lock id> --force` 解除。
- 捨棄「`clear` 維持前綴」：刪除是這幾個動作裡唯一不可逆的，留著前綴而只收緊 `run`，規則反而要逐一記。

捨棄：「前綴唯一時在 TTY 問 `Continue fix-login-mobile? [y/N]`」。互動確認在非 TTY（agent、腳本）裡沒有安全的預設，而且使用者習慣一路按 y；直接拒絕並給出可複製的完整指令，多一步但不會誤叫醒團隊。

決議 5 沒有命中時的訊息：

```
"fix-login" is not a run of project <p>, and a one-word task looks like a run name.
To start a new task, write more than one word or use --task-file; list runs with: agent-lyceum status --task-list
```

模式決定後的檢查與合併前相同：繼續模式下 done 的 run 只印結果並以其 outcome 的 exit code 結束；`max_rounds` 用完報錯；執行中的 run 拒絕；重開時 run 必須是 done，否則 `Run <x> is not finished (<reason>); continue it first: agent-lyceum run <x>`；`--answer` 時 run 必須是 waiting。

**`run fix-login` 的行為**

- `fix-login` 是現有 run 的完整名稱或 id：繼續它（done 的只印結果）。
- 只是某個 run 的前綴（例如只有 `fix-login-mobile`）：exit 1，印出完整名稱與 `agent-lyceum run fix-login-mobile`，不叫醒、不改任何狀態（決議 5a）。
- 都不是：報錯（上面的訊息），exit 1，不開新 run。

理由：0.17 的 `run fix-login` 會開一個任務叫「fix-login」的新 run，`resume fix-login` 會報 not found。合併後同一個字串要嘛是 run 要嘛是任務；把打錯的 run 名稱當成新任務會叫醒整個團隊、花額度做錯的事，而一個字的任務幾乎不是真正的任務。這沿用 `resume` 既有的「打錯的 run 名稱不能悄悄變成任務」（`src/cli.ts` resume 的註解）。一個字的任務要開新 run：多寫一個字、加標點（`fix-login.` 不符合 `NAME_RE`）或用 `--task-file`。

**為什麼 bare `run` 繼續最新的未完成 run**

- 它是舊 `resume` 唯一不帶參數的形式，Ctrl-C、`failed`、`waiting` 之後最常用；改成報錯會讓這條流程多一步。
- 在 0.17 的 `run` 裡，不帶參數只會報「沒有任務」，沒有別的意義可以佔用，所以不會讓舊用法悄悄改變行為。
- 它只碰使用者自己開過、還沒完成的 run，先印 `Resuming run <name> (...)`；沒有這種 run 時的錯誤訊息同時是開新 run 的用法。

- 「最新」指 run id（建立時間）最新，不是最近有活動：`latestUnfinishedRun` 依 run 目錄名（id 以時間開頭）由新到舊取第一個非 done、且不是執行中的 run。一個舊 run 剛剛被繼續、停下來，不會讓它變成「最新」。與 0.17 的 `resume` 相同，`run` 開始時印出的 `Resuming run <name> (...)` 讓人看到選了哪個。

捨棄：bare `run` 報錯並列出未完成的 run。比較保守，但每次中斷後都要多打名稱，而且舊 `resume` 使用者的習慣直接失效。

### 18.4.4 `resume "<text>"`（沒指定 run 的追加要求）移除

- 在 `run` 裡，一個不像 run 參照的參數就是新任務（決議 4），這是 `run` 的主要用法，不能讓給「追加要求」。
- 所以追加要求一定要寫出 run：`run <run> "<text>"`。`pickReopenRun`（自動挑、或在終端機裡讓人選要重開哪個 done 的 run）不再有入口，刪除；`reopenCandidates` 若無其他使用者也一併刪除。
- 這是這次唯一「舊寫法換名後意思不同」的情況：`resume "再補 X"` 換成 `run "再補 X"` 會開新 run，而不是重開。docs 的升級說明（18.9）要明寫，CHANGELOG／release note 也要。

捨棄：「一個不像 run 參照的參數，若存在 done 的 run 就當追加要求」。同一行指令會因為專案裡有沒有 done 的 run 而一下開新 run、一下重開舊 run，最容易出錯。

### 18.4.5 不合法的組合

全部 exit 1，在叫醒任何 agent 之前報錯。

| 組合 | 訊息 |
|---|---|
| `A`、`B` 加 `--task-file` | `Give the follow-up either as text or with --task-file, not both.` |
| `--name` 搭配繼續／重開 | `--name only names a new run; run <x> is already named "<name>".`（舊 run 沒名稱時印 id） |
| `--agent` 搭配繼續／重開 | `--agent only starts a new solo run; a continued run keeps the agents it started with.` |
| `--answer` 搭配新 run（決議 3、4） | `--answer continues a run that waits for answers: agent-lyceum run <run> --answer` |
| `--answer` 搭配重開（決議 1、2） | `--answer cannot be combined with a follow-up: answer first (run <run> --answer), then follow up.` |
| `--no-edit` 沒有 `--answer` | `--no-edit only goes with --answer.` |
| 文字或檔案內容為空（`run ""`、`run x "  "`） | 新 run：`The task is empty.`；重開：`The follow-up text is empty.` |
| `--name` 不合規或已存在 | 與 0.17 相同 |
| `A` 只有前綴命中（一個或多個） | 見 18.4.3 決議 5a；不提示 |
| 決議 5 沒命中 | 見 18.4.3 |

`--assume-defaults` 搭配 `--agent` 仍只是警告（與 0.17 相同）。`--no-edit` 是 commander 的否定旗標，以 `opts.edit === false` 判斷。

## 18.5 `status`

### 18.5.1 用法與選項

```
agent-lyceum status [-p <p>] [--json]                      一般（不變）
agent-lyceum status --task-list [<p>] [--json]             列出 run（不變）
agent-lyceum status --task-id <run> [-p <p>] [--json]      單一 run（不變）
agent-lyceum status --monitor [--interval <sec>] [-p <p>]  持續刷新（不變）
agent-lyceum status --check [--task-file <path>] [-p <p>] [--json]   原 doctor
agent-lyceum status --resolved [-p <p>] [--json]           原 doctor --resolved
```

| 舊 | 新 |
|---|---|
| `doctor [-p]` | `status --check [-p]` |
| `doctor --task-file <path>` | `status --check --task-file <path>` |
| `doctor --json` | `status --check --json` |
| `doctor --resolved [--json]` | `status --resolved [--json]` |

### 18.5.2 互斥

模式旗標：`--check`、`--resolved`、`--task-list`、`--task-id`、`--monitor`，最多一個；都沒有＝一般模式。

| 組合 | 訊息 |
|---|---|
| 兩個以上模式旗標 | `Use only one of --check, --resolved, --task-list, --task-id, --monitor.` |
| `--task-file` 沒有 `--check` | `--task-file only goes with --check (it checks a task file).` |
| `--json` 搭配 `--monitor` | `--json cannot be combined with --monitor.`（不變） |

- `--json` 可搭配一般、`--task-list`、`--task-id`、`--check`、`--resolved`。
- `--interval` 照舊只在 `--monitor` 有作用，其他模式忽略（commander 預設值 `"2"` 無法分辨是否有給，不新增檢查）。
- `--task-file` 不會自動帶出 `--check`：`status` 預設是不花時間的唯讀檢視，`--check` 要問各 runtime CLI 的 `--version`／`--help`，要明確要求。
- 0.17 的 `status --task-list --task-id x` 會悄悄以 `--task-list` 為準，改成報錯。這只改不合理組合的結果，不影響任何合法用法的輸出。status-monitor 只呼叫 `status --json [-p <p>]`（`plugins/status-monitor/hooks/register.tsx`），不受影響。

### 18.5.3 `--json` 相容性

- 一般、`--task-list`、`--task-id` 的 `--json`：**程式碼路徑與輸出都不改**（`buildStatusReport`、`buildTaskListReport`、`JSON.stringify(report, null, 2)`）。這些 report 的字串欄位只來自磁碟狀態或不含指令名的文字：`outcome_note`、`notes` 讀自 `state.json`；`memory_advice` 是 `tidyAdvice` 的 `reason`（不含指令名）。所以相同的磁碟狀態得到逐位元組相同的輸出。
- 新的 run 存進 `state.json` 的 `outcome_note` 會帶新的指令文字（`run-outcome.ts` 改字，18.9）。這是新資料的內容，不是格式；舊 run 的 note 保持原文（不改寫舊 state）。
- `status --check --json`：輸出 doctor 原本的 JSON（`{ schema_version: 1, ...report }`），結構不變；`checks[].message` 裡的指令名改成新寫法。
- `status --resolved --json`：與 `doctor --resolved --json` 相同。

## 18.6 `clear`

### 18.6.1 用法與選項

```
agent-lyceum clear <run> [--dry-run] [--keep-worktrees] [-p <p>]                       刪除 run（不變）
agent-lyceum clear --lock [<run>] [--force] [-p <p>]                                   移除殘留的 run 鎖（不變）
agent-lyceum clear --tidy-memory [--agent <name>] [--layer project|global] [--dry-run] [-p <p>]   原 tidy
agent-lyceum clear --tidy-memory --undo <stamp> --agent <name> [--layer ...] [-p <p>]       原 tidy --undo
```

| 舊 | 新 |
|---|---|
| `tidy [-p] [--agent] [--layer] [--dry-run]` | `clear --tidy-memory [-p] [--agent] [--layer] [--dry-run]` |
| `tidy --undo <stamp> --agent <n> [--layer]` | `clear --tidy-memory --undo <stamp> --agent <n> [--layer]` |

`--tidy-memory` 的說明文字明寫：`have agents tidy their own long-term memory (merge, fix, archive; never deletes)`。

### 18.6.2 互斥（刪 run 與整理記憶不能互相誤觸）

三個模式：刪 run（預設）、`--lock`、`--tidy-memory`。

| 組合 | 訊息 |
|---|---|
| `--tidy-memory` 加位置參數 `<run>` | `--tidy-memory takes no run: it tidies the agents' long-term memory. To delete run <x>: agent-lyceum clear <x>` |
| `--tidy-memory` 加 `--lock` | `Use either --tidy-memory or --lock, not both.` |
| `--tidy-memory` 加 `--force` 或 `--keep-worktrees` | `--force / --keep-worktrees do not go with --tidy-memory.`（逐一點名有給的那個） |
| 沒有 `--tidy-memory` 卻給了 `--agent`、`--layer` 或 `--undo` | `--agent / --layer / --undo only go with --tidy-memory (memory tidy).`（點名有給的那個） |
| `--undo` 加 `--dry-run` | `--undo cannot be combined with --dry-run.`（不變） |
| `--undo` 沒有 `--agent` | 不變 |
| `--force` 沒有 `--lock` | `--force only goes with --lock.`（不變） |
| `--lock` 加 `--dry-run` 或 `--keep-worktrees` | `--dry-run / --keep-worktrees do not go with --lock (without --force it only shows the lock).` |
| 沒有 `--tidy-memory`、`--lock`，也沒有 `<run>` | `Give the run to delete (see agent-lyceum status --task-list), or use --lock or --tidy-memory.` |

- `--dry-run` 兩個模式都接受，意思都是「什麼都不改」：刪 run 時只列出會刪什麼，`--tidy-memory` 時只印記憶大小、不叫醒任何人。
- 刪 run 一定要給 `<run>`，`--tidy-memory` 一定不能給 `<run>`：少打或多打一個參數都只會得到錯誤，不會跑到另一個模式。整理記憶本身不刪檔（只封存，可用 `--undo` 還原），但會叫醒 agent、花額度，所以同樣要求明確的 `--tidy-memory`。

**捨棄的旗標名稱**

- `--tidy`：容易讀成「整理 run」。
- `--memory`（初稿用的名字，也是使用者的例子）：`clear --memory` 容易讀成「清空記憶」，而這個模式從不刪記憶（只合併、修正、封存）。review 後改為 `--tidy-memory`，與舊指令名 `tidy` 對得上。

## 18.7 `init`

### 18.7.1 用法與選項

```
agent-lyceum init [-y]                                                            建立 home（不變）
agent-lyceum init --demo [--dir <path>] [--runtime claude-code|codex] [--setup-only] [-y]   原 demo
```

| 舊 | 新 |
|---|---|
| `demo` | `init --demo` |
| `demo --dir <path>` | `init --demo --dir <path>` |
| `demo --runtime <rt>` | `init --demo --runtime <rt>` |
| `demo --setup-only` | `init --demo --setup-only` |
| `demo -y` | `init --demo -y` |

`-y` 兩個模式都有：`init` 時不確認 home 路徑；`init --demo` 時不確認要跑真的 agent。

### 18.7.2 規則

| 組合 | 結果 |
|---|---|
| `--dir`、`--runtime`、`--setup-only` 沒有 `--demo` | `--dir / --runtime / --setup-only only go with --demo.`（點名有給的那個），exit 1 |
| `--demo` 加全域 `--home` | `--home does not apply to --demo: the demo builds its own home inside its sandbox (--dir).`，exit 1 |
| 沙盒根目錄與一般 home 重疊 | `--dir <dir> overlaps the agent-lyceum home <home>; choose a sandbox outside it.`，exit 1 |

- `init --demo` 的分支在呼叫 `home()`、`initHome()` 之前就分出去，從不建立、讀取或載入使用者 home 的任何設定；它對 home 只做一件事：**計算路徑**做下面的重疊檢查（`resolveHome()` 只讀環境變數與 `os.homedir()`；`canonicalPath` 只對路徑做 `existsSync`／`realpath`；都不讀任何檔案內容、不載入 home 的設定）。demo 用沙盒裡自己的 home，子程序用 `--home <sandbox>/home` 呼叫 `run`。

**沙盒與 home 重疊檢查**（在任何 mkdir、寫檔、runtime 設定之前，也在 `prepareDemo` 既有的「目錄非空」檢查之前）

- 一般 home ＝ `resolveHome()`：`$AGENT_LYCEUM_HOME`，沒設時 `~/agent-lyceum-config`（`--home` 已在上一列被拒）。
- 沙盒根 ＝ `--dir`（`path.resolve`）；沒給 `--dir` 時見下。
- 兩者都轉成**標準路徑**再比：`canonicalPath(p)` ＝ 從 `path.resolve(p)` 往上找到最近一個存在的祖先，取它的 `fs.realpathSync.native`，再接回其餘（還不存在的）段。這樣 symlink 別名（`/tmp` → `/private/tmp`、使用者自己的連結）與還不存在的路徑都抓得到。
- 重疊 ＝ 相等、沙盒是 home 的祖先、或沙盒在 home 裡面：`rel = path.relative(a, b)`，兩個方向任一個 `rel === ""`，或 `rel` 不是絕對路徑且既不等於 `..` 也不以 `..` + `path.sep` 開頭（只看完整路徑段：`..demo` 這種合法子目錄名要算在裡面，lead 依 review 55c1d0dc M1 修正）。macOS 上比較前先轉小寫（預設 APFS 不分大小寫；在分大小寫的磁碟上只會多拒絕，不會漏）。
- 兩個純函式放 `src/paths.ts`：`canonicalPath(p)`、`pathsOverlap(a, b)`；`cli.ts` 的 `init --demo` 分支呼叫，重疊就 `fail`。
- 沒給 `--dir`：`defaultDemoDir()` 的 `mkdtemp` 之前，先檢查 `os.tmpdir()` 是否等於 home 或在 home 裡面（此時任何新建的 temp 子目錄都會在 home 裡），是就報錯（訊息把 `--dir <dir>` 換成 `the temp dir <tmpdir>`，並提示用 `--dir`）。`mkdtemp` 建出的是全新的唯一目錄，不可能是既有 home 的祖先；它之後再跑一次完整檢查，失敗時只 `rmdir` 這個剛建、仍是空的目錄。
- 捨棄「只比 `path.resolve` 的字串」：`/tmp/x` 與 `/private/tmp/x`、或 home 本身是 symlink 時都會漏掉。捨棄「只拒絕相等」：`--dir ~` 會把 demo 的 repo 和 `home/` 建在真 home 的上層，`--dir ~/agent-lyceum-config/x` 會在真 home 裡面建出 git repo 與第二個 home。
- 選 `--home` 報錯而不是忽略：使用者明確給了 home 卻被默默略過，會以為 demo 動到了那個 home。
- `demo.ts` 裡子程序呼叫的 `run "<DEMO_TASK>" -p demo --name demo-slugify`：`DEMO_TASK` 是多行文字，不像 run 參照，依 18.4.3 決議 4 是新 run，不受影響。`--setup-only` 印出的 `run -p demo --task-file ...` 依決議 3 是新 run。
- exit code 不變：`init` 0／1；`init --demo` 回傳子程序 `run` 的 exit code，`--setup-only` 為 0。

## 18.8 Exit code

| 模式 | exit code（與合併前相同） |
|---|---|
| `run`（三種模式） | 0 completed、1 failed 或用法錯誤、2 其他未完成（例如用完 rounds）、3 等你回答、130 取消（`exitCodeForOutcome`）。繼續模式遇到 done 的 run：該 run outcome 的 code。 |
| `status` 一般／`--task-list`／`--task-id`／`--resolved` | 0；設定或參數錯誤 1 |
| `status --check` | 0 全部通過；1 有 error（原 doctor） |
| `status --monitor` | 持續執行；Ctrl-C 結束 |
| `clear <run>`、`clear --lock` | 0；拒絕、失敗或未加 `--force` 1 |
| `clear --tidy-memory` | 0；任一 agent `failed` 1 |
| `init`、`init --demo` | 見 18.7.2 |
| 已移除的指令 | 1 |

## 18.9 要改的字串（依檔案）

`docs/specs`、`docs/plans` 裡舊的 spec／plan 是歷史紀錄，**不改**。

**src/cli.ts**

- `project add` 完成訊息：`agent-lyceum doctor --project <n>` → `agent-lyceum status --check -p <n>`。
- `preflight` 的 `see \`agent-lyceum doctor\``，以及 run／resume／tidy 的 `Configuration is invalid ... (see \`agent-lyceum doctor\`)`（三處）→ `agent-lyceum status --check`。
- `printWaiting`：`resume <id> --answer`、`resume <id>` → `run <id> --answer`、`run <id>`。
- `pickReopenRun`：整段刪除（18.4.4）。
- bare 繼續找不到 run：`No unfinished run to resume` → `No unfinished run to continue`（18.4.3 決議 6）。
- 繼續已 done 的 run（目前 371、373 行）：`already finished (done); nothing to resume.` → `already finished (done); nothing to continue (follow up with: agent-lyceum run <x> "<follow-up>").`（373 行其後的 `Outcome: ... Result: ...` 不變）。
- 新增 `findRunExact` 的訊息（18.4.3 決議 5a）；`clear <run>`／`clear --lock <run>` 改用它（決議 5b）。
- 重開未完成的 run：`resume it without text first` → `continue it first: agent-lyceum run <x>`。
- `unlockProject`：兩處 `Resume the run with: agent-lyceum resume <id>` → `Continue the run with: agent-lyceum run <id>`；`List the locks with: agent-lyceum doctor` → `agent-lyceum status --check`。
- `layerOpt`：`` `clear` deletes it `` → `` `clear <run>` deletes it ``。
- tidy 完成的還原提示：`agent-lyceum tidy --undo <stamp> -p <p> --agent <a>` → `agent-lyceum clear --tidy-memory --undo <stamp> -p <p> --agent <a>`（global 層加 `--layer global`）。
- tidy 沒有記憶時的提示 `(or use --layer global)`、`(or tidy global memory with --layer global)` → `(or clear --tidy-memory --layer global)`。
- `HELP_LAYERS`（18.3 決議 4）；各指令的 `summary`／`description`。
- `printResolved` 的註解 `doctor --resolved` → `status --resolved`。

**src/status.ts**

- 419 行：`agent-lyceum resume ${s.run_id}` → `agent-lyceum run ${s.run_id}`（`clear ${s.run_id}` 不變）。
- 422 行：`agent-lyceum resume ${s.run_id} --answer` → `agent-lyceum run ${s.run_id} --answer`。
- 520 行：`接續中斷的任務：agent-lyceum resume <ID>` → `agent-lyceum run <ID>`。
- 552 行：`agent-lyceum tidy -p` → `agent-lyceum clear --tidy-memory -p`。
- 註解（196、235、309 行）的 `resume`／`tidy` → `run`／`clear --tidy-memory`。
- 以上都在文字格式化函式裡，不進 JSON（18.5.3）。

**src/doctor.ts**

- 150 行註解：`agent-lyceum doctor` → `agent-lyceum status --check`。
- 200 行：`Consider: agent-lyceum tidy -p <p> --agent <a> (doctor only suggests; it never tidies).` → `Consider: agent-lyceum clear --tidy-memory -p <p> --agent <a> (status --check only suggests; it never tidies).`

**src/run-outcome.ts**

- 42 行：`` `agent-lyceum resume <run-id> --answer` ``、`` `agent-lyceum resume` `` → `` `agent-lyceum run <run-id> --answer` ``、`` `agent-lyceum run <run-id>` ``。
- 44 行：`` continue with `agent-lyceum resume` `` → `` continue with `agent-lyceum run` ``。
- 59 行：`agent-lyceum doctor -p` → `agent-lyceum status --check -p`。
- 61 行：`agent-lyceum resume ${run} -p ${project}` → `agent-lyceum run ${run} -p ${project}`。

**src/scaffold.ts**

- 102 行，`project.yaml` 範本裡 `retry` 的註解：`(resume it after fixing the cause)` → `(continue it with agent-lyceum run <run> after fixing the cause)`。只影響之後新建的 `project.yaml`；既有檔案不改寫。

**註解**：`src/run-store.ts`（109 行，`resume`）、`src/run-session.ts`（82 行，`resume`）、`src/memory-tidy.ts`（329 行，`agent-lyceum tidy`）。

**不需改**：`src/prompt.ts`（只有 memory-tidy 的維護 prompt，沒有指令名）、`src/demo.ts`（`demo` 是專案名與 git 作者名，不是指令）、`plugins/status-monitor`（只呼叫 `status --json`，提示文字不含舊指令）。

**改名搜尋明確排除**（看到也不要改）：

- 設定欄位 `resume: true`（`schema.ts`、範本、`docs/configuration*.md`）：agent 的 session 保留設定，不是指令。
- runtime CLI 的寫法：`codex exec resume`、`claude --resume` 與 adapters 裡相關的程式與註解。
- demo 的專案名與 run 名：`demo`（`DEMO_PROJECT`、`-p demo`）、`demo-slugify`、git 作者名。

實作完成時以 `grep -rnE "agent-lyceum (resume|doctor|tidy|demo)\b|\`(resume|doctor|tidy|demo)\`|nothing to resume|resume it" src plugins --include='*.ts'` 確認只剩 stub 訊息、測試與上面排除的項目。

**文件（`docs-writer`）**

- `README.md`／`README.zh-TW.md`：指令表改成 6 個；快速開始的 `demo` → `init --demo`；`doctor` → `status --check`；`resume` → `run <run>`。
- `docs/commands.md`／`docs/commands.zh-TW.md`：`## resume` 併入 `## run`（含 18.4.3 判斷表與 18.4.5 錯誤表的使用者版）；`## doctor` 併入 `## status`；`## tidy` 併入 `## clear`；`## demo` 併入 `## init`；`## Answering questions` 改用 `run <run> --answer`；修正指向舊錨點（`#resume`、`#doctor`、`#tidy`、`#demo`）的連結。兩份標題結構一致（`npm run check:docs`）。
- 新增一節「Upgrading to 0.18」（兩份 commands 文件，或 README 的對應段落，由 docs-writer 決定位置，但兩語一致）：舊 → 新對照表，並特別標出：`resume "<text>"` 現在要寫 `run <run> "<text>"`（18.4.4）；`run <one-word>` 不再開新 run（18.4.3）；`run` 與 `clear` 不再接受前綴，要完整名稱或 id（決議 5a、5b），`status --task-id` 照舊；`tidy` 現在是 `clear --tidy-memory`。
- `docs/how-it-works.md` 32–34 行與 `docs/how-it-works.zh-TW.md` 對應段落（30–34 行，「Continuing a finished run」）：**依新語意重寫**，不是換字。要點：30 行「`resume`、`clear`、`status --task-id` 接受前綴」改為「`run` 與 `clear` 要完整 id 或名稱（只給前綴會報錯並給出完整指令），`status --task-id` 接受唯一前綴」；32 行重開一定寫出 run：`agent-lyceum run <run> "<follow-up>"`（或 `--task-file f`）；34 行刪掉「沒指定 run 時從 done 的 run 挑候選、終端機裡選號」與「一個參數只在不像 run 參照時才算追加要求」兩句，改為「追加要求一定要指定 run；只有一個參數時，不像 run 參照就開新 run，像 run 參照就必須是完整的 run 名稱或 id」，以及「未完成的 run 帶文字會拒絕（先用 `run <run>` 繼續它）」。
- `docs/configuration*.md`、`docs/how-it-works*.md` 其他段落、`docs/write-scope*.md`、`docs/upgrading-run-v2.md`：把 `resume`／`doctor`／`tidy`／`demo` 換成新寫法（排除項同上）。

## 18.10 測試計畫（`qa` 驗證、`node-engineer` 撰寫）

**既有測試要改寫成新指令**（以 `["resume"|"doctor"|"tidy"|"demo", ...]` 呼叫 CLI 的地方）：

- `test/resume-followup-cli.test.ts`（16 處）：改用 `run`；「一個參數的追加要求、沒有 run」的案例改成斷言新行為（不像 run 參照 → 開新 run；`pickReopenRun` 的互動／非互動挑選案例刪除）。
- `test/ask-flow.test.ts`（6）、`test/cli.test.ts`（8）、`test/memory-tidy-cli.test.ts`（12）、`test/cancel.test.ts`、`test/run-lifecycle.test.ts`、`test/solo-cli.test.ts`（各 1）。
- `test/demo.test.ts`、`test/doctor.test.ts`、`test/status.test.ts`、`test/run-outcome.test.ts`：比對提示文字的斷言。

**新增**

1. `run` 判斷規則（18.4.3）各一例：兩個參數 → 重開；`<run> --task-file` → 重開；只有 `--task-file` → 新 run；多字文字 → 新 run；一字且是完整 run 名稱 → 繼續；一字且是完整 run id → 繼續；一字且不是 run → exit 1、沒有建立 run 目錄；不帶參數且沒有 → exit 1。
   - **前綴不命中**（fake runtime，專案裡只有 `fix-login-mobile`，狀態 `failed`）：`run fix-login` → exit 1；stderr 一行含 `fix-login-mobile` 與 `agent-lyceum run fix-login-mobile`；fake runtime 的呼叫紀錄為空；run 目錄（含 `state.json`、mailbox、`log.jsonl`）前後逐位元組相同、沒有新的 run 目錄、沒有鎖檔。同一個 fixture 再測 `run fix-login "more"`（重開形式）→ 建議 `agent-lyceum run fix-login-mobile "<follow-up>"`；`run fix-login --answer` → 建議帶 `--answer`；以 `script`/非 TTY 都不出現提示（stdin 不被讀）。
   - **`clear --lock` 只有鎖、沒有可讀 state**（55c1d0dc M2）：`locks/run-z.json` 內容是亂碼、沒有 `runs/run-z`：`clear --lock run-z --force` → 鎖被移除、exit 0；`clear --lock run --force`（前綴）→ exit 1、鎖仍在。再加一例：一個可讀鎖與一個不可讀鎖並存時，不給 run → 照舊列出兩者要求指定；分別以完整 id 指定各自成功。不加 `--force` 時仍只顯示持有者。
   - **前綴有歧義**（`fix-login-mobile`、`fix-login-web`）：`run fix-login` → exit 1，列出兩個候選與 `Give the exact name or id`，沒有叫醒、狀態不變。
   - **bare `run` 選哪個**：四個 run，依 id 由舊到新：`a` failed、`b` waiting、`c` 執行中（存活的 pid 加鎖）、`d` done；另外把 `a` 的 `state.json` mtime／`log.jsonl` 改成最新。`run` 必須繼續 `b`（最新的未完成、非執行中；不是最近有活動的 `a`、不是執行中的 `c`、不是 done 的 `d`），stdout 含 `Resuming run b`。
   - `clear fix-login`（只有 `fix-login-mobile`）→ exit 1，建議 `agent-lyceum clear fix-login-mobile`，run 目錄仍在；`clear --lock fix-login` 同樣 exit 1、鎖檔不變；`status --task-id fix-login` 照舊顯示 `fix-login-mobile`。
2. 18.4.5 每一列各一例：exit 1、沒有新的 run 目錄、沒有叫醒 fake runtime。
3. `status` 18.5.2 每一列；`status --check` 的 exit 0／1；`--check --task-file` 壞檔 exit 1；`--resolved --json` 與舊 `doctor --resolved --json` 相同結構。
4. **`status --json` 黃金測試**（`test/status-json-golden.test.ts`，基準檔在 `test/fixtures/status-golden/`）：
   - **fixture**：測試以程式在 temp 目錄建 home（固定的 `project.yaml`、`team.yaml`，含會產生 `memory_advice` 的大記憶檔），寫入四個代表性 run 的 `state.json`：`done`、`waiting`、`failed`、舊版（沒有 `name`／`reopened`／`round_floor` 等選填欄位的 0.1x state）。所有時間欄位、run id、`pid` 都是寫死的常數；`pid` 用 `2147483646`（超過 macOS 與 Linux 的 pid 上限，`runIsAlive` 一定為假）。JSON 的產生不讀 `Date.now()`（`buildStatusReport`／`buildTaskListReport` 只讀磁碟），所以不需假時鐘。
   - **路徑代換**：輸出裡唯一隨機的是 temp 根目錄。比對前只做一件事：把 `fs.realpathSync(root)` 與 `root` 兩個字串（先長後短）全部換成 `<ROOT>`，其他位元組不動；另斷言代換後的輸出不再含 `os.tmpdir()` 的 realpath（沒有漏網的路徑）。
   - **涵蓋**：(a) 一般 `status --json` 四份，每份讓「目前的 run」（最新的 run）分別是 done、waiting、failed、舊版（依 run id 排序決定；每份只建到該 run 為止，或用四個 home）；(b) `--task-list --json` 一份（四個 run 都在）；(c) `--task-id <id> --json` 四份，每個代表性 run 各一。
   - **基準**：在 0.17.3（commit `0c1516e`）的程式上執行一次產生 `*.json` 並提交，之後**凍結**：測試只讀基準、找不到基準就失敗，不提供 `-u`／自動寫入；基準檔只能在 0.17.3 程式上重新產生，不能拿新程式的輸出覆蓋。這一段必須在動 `cli.ts` 之前完成並通過（18.11 第 1 段）。
5. `clear` 18.6.2 每一列：exit 1，且沒有刪任何檔、沒有取鎖（鎖檔不存在）、沒有叫醒 agent。特別是 `clear <run> --tidy-memory`、`clear --tidy-memory <run>`、`clear --agent x <run>`。
6. `init` 18.7.2：`--dir` 無 `--demo` → exit 1；`init --demo --home X` → exit 1；`AGENT_LYCEUM_HOME=<tmp>` 下 `init --demo --setup-only --dir <tmp2>` 之後 `<tmp>` 不存在。
   - **重疊**（每例 `AGENT_LYCEUM_HOME=<t>/home`，都用 `--setup-only`）：`--dir <t>/home`（相等）、`--dir <t>`（祖先）、`--dir <t>/home/sandbox`（後代）、`--dir <link>`（`<link>` 是指向 `<t>/home` 的 symlink）、`--dir <link>/x`（經 symlink 的後代）。每例 exit 1、stderr 含 `overlaps the agent-lyceum home`；`<t>/home` 存在時其內容前後相同（列出檔案與內容比對），不存在時仍不存在；`--dir` 目標不存在時仍不存在；沒有 runtime 被呼叫。另一例：`AGENT_LYCEUM_HOME` 未設、`HOME=<t>` 時 `--dir <t>/agent-lyceum-config` 也被拒（預設路徑）。`--dir <t>/home/..demo`（名字以 `..` 開頭的後代）也 exit 1 且沒有建出任何東西；對照組 `--dir <t>/home2`、`--dir <t>/sibling`（home 的兄弟）exit 0。`pathsOverlap` 單元測試同時涵蓋 `..demo` 後代、它的祖先方向、`../sibling`。
   - **預設 temp 目錄照常可用**：`TMPDIR=<t>/tmp`、`AGENT_LYCEUM_HOME=<t>/home`，`init --demo --setup-only`（不給 `--dir`）exit 0，沙盒建在 `<t>/tmp/agent-lyceum-demo-*`，`<t>/home` 不存在。`TMPDIR` 設在 home 裡面（`<t>/home/tmp`）時 exit 1 且沒有建出 `agent-lyceum-demo-*`。
7. 已移除指令：`resume`、`doctor`、`tidy`、`demo`（各帶與不帶參數、加 `--help`）→ exit 1，stderr 是 18.3 的那一行。
8. **help 路由**：`help resume`、`help doctor`、`help tidy`、`help demo` → exit 1，stderr 是同一行 pointer，stdout 為空。`agent-lyceum --help`：逐行檢查，沒有任何一行是這四個名字的指令項目（`/^\s+(resume|doctor|tidy|demo)\b/m` 不命中）；`init` 那一行的說明含 `--demo`。`help run` 等現有指令仍 exit 0。

**qa 的回歸（18.11 第 2 段後）**：run 的 lock、復原、取消、清理與 write-scope 在合併後行為不變，至少驗：

- 有存活的 lock 時 `run <run>` 拒絕（exit 1、不叫醒）；stale lock（pid 已死）照舊被接手並繼續。
- 繼續中的 run 收到 Ctrl-C（SIGINT）→ `cancelled`、exit 130，`state.json` 與鎖已釋放，之後 `run <run>` 能再繼續。
- 以併發模式（`max_concurrent_runs > 1`）開始、在自己 worktree 的舊 run，用 `run <full-name>` 繼續時沿用同一個 worktree 與 branch（`lead_workspace` 不變），結束後清理照舊。
- write-scope：繼續的 run 裡成員寫出 `owns` 之外的檔案仍被還原（沿用既有 guard 測試的 fixture）。

## 18.11 實作切分

`node-engineer` 依序做，每段約 7 分鐘、各自通過 `npm run typecheck && npm run lint && npm test`：

1. **黃金測試**：18.10 第 4 項（先在現有程式上通過）。
2. **run + resume**，分三小段，每小段各自通過 DoD：
   - **2a 抽出處理函式（行為不變）**：把 `run` 與 `resume` 的 action 主體搬成 `cli.ts` 內的 `startNewRun(...)`、`continueRun(...)`、`reopenRun(...)`，兩個指令仍照舊存在、各自呼叫它們。不改任何訊息或判斷；既有測試不改一行就通過。
   - **2b 判斷規則**：`run [run] [text]` 依 18.4.3（含 `findRunExact`）與 18.4.5 的錯誤；只改／新增直接受影響的測試（18.10 第 1、2 項的 `run` 部分、`run` 一字任務的既有案例）。`resume` 指令此時仍在。
   - **2c 移除**：刪 `resume` 指令、`pickReopenRun`、（無其他使用者時）`reopenCandidates`；改寫其餘依賴的測試（`resume-followup-cli`、`ask-flow`、`cancel`、`run-lifecycle`、`solo-cli`、`cli`）。
   - 三小段都**不改**：取鎖與 stale lock 接手（`takeLock`／`project-lock.ts`）、中斷復原、Ctrl-C 取消、結束清理（`run-cleanup.ts`、worktree）、write-scope 的強制與事後還原（`policy.ts`／`guard.ts`）。這些只透過 2a 搬出的函式被呼叫，呼叫順序與參數不變；qa 依 18.10 的回歸清單驗證。
3. **status + doctor**：`--check`、`--resolved`、`--task-file` 併入 `status`，18.5.2 的互斥；刪 `doctor` 指令；測試 18.10 第 3 項；黃金測試必須不動就通過。
4. **clear + tidy**：`--tidy-memory`、`--agent`、`--layer`、`--undo` 併入 `clear`，18.6.2 的互斥；`clear <run>`／`--lock <run>` 改用 `findRunExact`（18.4.3 決議 5b）；刪 `tidy` 指令；改寫 `memory-tidy-cli`；測試第 5 項與第 1 項的 `clear` 前綴案例。
5. **init + demo**：18.7（含 `canonicalPath`／`pathsOverlap` 與其單元測試）；刪 `demo` 指令；測試第 6 項。
6. **stub、help、字串**：18.3 的 `RemovedCommand` stub 與 `HELP_LAYERS`；18.9 的 src 字串與 grep 檢查；測試第 7、8 項；`package.json` 版本 0.18.0 由 lead 在發版時處理。

之後交 `docs-writer`：18.9 的文件清單（含升級說明）。

## 18.12 範圍外

- `call`、`project` 的名稱與選項。
- 設定檔欄位、run 目錄、`state.json`、mailbox 等任何檔案格式。
- 舊名稱的可用別名、`--continue` 之類新的「明確模式」旗標（18.4.3 的規則已能決定所有情況）。
- 改寫舊 run 已存的 `outcome_note`。

## 18.13 已知風險

- **`resume "<text>"` 換成 `run "<text>"` 會開新 run**（18.4.4）。只能靠升級說明與 release note 提醒；stub 的訊息寫的是 `run [<exact-run-name-or-id>] ["<follow-up>"]`，指出要寫 run。
- **一字任務**：`run refactor` 在 0.17 會開新 run，0.18 會報錯（不像會叫醒 agent 的錯，只是多一步）。
- **前綴不再命中**：0.17 的 `resume test` 會繼續唯一的 `test-flaky`；0.18 的 `run test` 與 `clear test` 都 exit 1，印出完整名稱與可直接複製的指令，不叫醒、不刪、不改狀態（18.4.3 決議 5a、5b）。習慣打前綴的人多一步；換來的是一個打錯或打太短的字不會叫醒團隊或刪掉別的 run。`status --task-id` 照舊接受前綴。升級說明要列出這一條。
- **bare `run` 選的是建立時間最新的未完成 run**，不是最近動過的（18.4.3）。有多個未完成 run 時可能不是使用者心裡那個；開始時印出 `Resuming run <name>`，Ctrl-C 後改用 `run <name>`。與 0.17 的 `resume` 相同，不是新風險。
- **demo 重疊檢查的極限**：只比對路徑（含 symlink 與 macOS 大小寫），不偵測 bind mount 或 hard link 的目錄別名；在 Linux 的大小寫不敏感掛載上，只差大小寫的別名也不會被抓到。這些都需要使用者刻意造出來。
- 旗標名 `--tidy-memory` 比 `--memory` 長，但不會被讀成「清空記憶」（18.6.2）。
