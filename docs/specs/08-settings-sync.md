# 08 `project add`／`remove` 同步 status-monitor 的專案清單

狀態：設計，待 `cli-architect-reviewer` 審查，尚未實作。來源：使用者任務 1b4661。

## 8.1 問題與解讀

使用者原話：「跑完 add，應該要自動在 `~/.claude/settings.json` 裡面更新 mod 的列表」。

- 這裡的「mod 的列表」指 status-monitor 的 `pluginConfigs."status-monitor@inline".options.project`。它是以逗號分隔的已註冊專案名稱，由 `plugins/status-monitor/hooks/summary.ts` 的 `parseProjects` 解析：先 trim、去掉空白項並去重；結果為空時回傳 `['']`，意思是「從 session 的工作目錄推斷」。
- `project add <name>` 會把名稱加進清單。`project remove <name>` 要對稱地移除，否則 mod 會一直輪詢不存在的專案並顯示 `無法取得狀態`。
- 曾考慮另一種解讀：「mod 列表」指 `enabledPlugins` 或 `--plugin-dir`。不採用：status-monitor 用 `--plugin-dir`／`CLAUDE_CODE_PLUGIN_DIRS` 載入，不寫進 settings.json；而 `project add` 唯一影響得到的 mod 設定只有 `project`。
- settings.json 是使用者自己的檔案，同時也由 Claude Code 寫入。所以設計原則是：**只在使用者已明確維護一份清單時才動它**，而且只動 `project` 這一個值。

## 8.2 決議

| # | 項目 | 決議 |
|---|---|---|
| 1 | 程式位置 | 新增模組 `src/claude-settings.ts`，只由 `src/cli.ts` 的 `project add`／`project remove` action 呼叫。`scaffold.ts` 的 `addProject`／`removeProject` **不改**：測試 helper（`test/helpers.ts` `makeEnv`）直接呼叫 `addProject`，同步邏輯若放在那裡，所有測試都會去碰使用者的設定檔。 |
| 2 | 路徑 | `claudeSettingsPath(env)`：`env.CLAUDE_CONFIG_DIR` 有值（非空）時用 `<expandHome(CLAUDE_CONFIG_DIR)>/settings.json`，否則用 `<os.homedir()>/.claude/settings.json`。CLI 傳入 `process.env`。測試注入方式：單元測試直接把暫存檔路徑傳給 `syncMonitorProjects`；CLI 測試在子程序 env 設定 `CLAUDE_CONFIG_DIR=<tmp>`（見 #9 的防護）。 |
| 3 | 檔案或欄位不存在 | 一律**略過且不輸出**，不建立任何東西。條件依序為：檔案不存在、`pluginConfigs` 不存在、`"status-monitor@inline"` 不存在、`options` 不存在。沒裝 mod 的使用者不會看到多出來的設定，也不會每次 add 都看到一行雜訊。只看「檔案是否存在」不夠：幾乎每個 Claude Code 使用者都有 settings.json。只認 `status-monitor@inline` 這個 key（README 記載的唯一安裝方式）；其他 `status-monitor@<marketplace>` 不在範圍內。 |
| 4 | 空清單＝推斷 | `project` 不存在、不是字串，或 `parseProjects` 後為空（推斷模式）時，`add` **不修改**，但印一行說明（使用者有裝 mod，這行有用）：`status-monitor: project list in <path> is empty (inferred from the session directory); left unchanged. Add "<name>" there to watch it from any directory.` 理由：加入一個名稱會把推斷模式改成「只看清單」，使用者在其他 repo 開的 session 會就此看不到狀態，這是破壞性的隱性變更。`remove` 在推斷模式下沒有可移除的東西，不輸出。`remove` 移除最後一個名稱時寫入 `""`（回到推斷模式，這樣比留下失效名稱好），並在更新訊息後加上 ` The list is now empty: the mod infers the project from the session directory.` |
| 5 | 安全寫入 | 讀檔 → `JSON.parse` → 只改 `options.project` → `JSON.stringify(obj, null, 2) + "\n"` → 原子寫入。<br>• JSON 無效（含 JSONC 註解）或型別不符（頂層、`pluginConfigs`、entry、`options` 任一不是 plain object；或 `project` 存在但不是字串）：不寫入，stderr 印 `warn   status-monitor: <path>: <原因>; not updated.`，指令仍 exit 0。<br>• 原子寫入：先 `fs.realpathSync`（settings.json 可能是 dotfiles 管理的 symlink；直接 rename 會把 symlink 換成一般檔案），在目標檔所在目錄寫 tmp，`chmodSync(tmp, 原檔 mode)`（避免 0600 被 umask 放寬成 0644），再 rename。擴充 `src/fs-util.ts` 的 `atomicWrite(file, content, mode?)` 加上可選 `mode` 參數，在 rename 前 chmod；不傳 `mode` 時行為不變。<br>• 讀、寫或 rename 失敗（EACCES、EROFS、sandbox）：stderr warn 一行，盡力刪除 tmp，exit 0。專案註冊本身已完成，不回滾。<br>• 格式：其他 key 的值與順序都保留（JSON 物件的字串 key 依插入順序；整數形式的 key 會被排到前面，Claude Code 的設定沒有這種 key，可接受）。縮排一律改成 2 格，與 Claude Code 自己寫出的格式一致。 |
| 6 | 冪等與輸出 | 用 `parseProjects` 同樣的規則（trim、去空白項、去重）解析，再以 `names.join(",")` 重建。`add` 時名稱已存在，或 `remove` 時名稱不存在：不寫檔、不輸出。名稱比對區分大小寫（`NAME_RE` 本來就區分）。重建會把 `"a, b,,a"` 正規化成 `"a,b"`，只在有實際增減時才發生。有更新時 stdout 印一行：<br>`status-monitor: added "<name>" to the watched projects in <path> (applies to new Claude Code sessions).`<br>`status-monitor: removed "<name>" from the watched projects in <path> (applies to new Claude Code sessions).` |
| 7 | 停用 | `project add` 與 `project remove` 都加上 `--no-claude-settings`（commander 的否定選項會產生 `opts.claudeSettings`，預設 `true`）。加上後完全不讀設定檔。不加環境變數：沒裝 mod 或使用推斷模式的使用者，依 #3、#4 本來就不會被改動，一個 flag 已經夠用。 |
| 8 | 相容性 | 不新增依賴，只用 `node:fs`、`node:os`、`node:path` 與 `JSON`。不碰 `project.yaml`、run 目錄或 `state.json`。舊版 binary 不認得這個行為，只是不同步，沒有資料格式變更，也不需要遷移。`project add` 的錯誤路徑（名稱重複、`--dir` 無效）在同步之前就 `fail`，所以註冊失敗不會動到 settings.json。 |
| 9 | 測試 | 見 8.4。CLI 測試一律把 `CLAUDE_CONFIG_DIR` 指向暫存目錄。 |

## 8.3 介面（`src/claude-settings.ts`）

```ts
export type SyncOp = "add" | "remove";

export type SyncResult =
  | { kind: "updated"; path: string; projects: string[] }   // wrote the file; projects = new list
  | { kind: "unchanged"; path: string }                     // already present / absent: no write, no output
  | { kind: "absent"; path: string }                        // file, pluginConfigs, entry or options missing: no output
  | { kind: "inferring"; path: string }                     // empty list, op = add: info line, no write
  | { kind: "invalid"; path: string; reason: string };      // bad JSON / wrong type / IO error: warn, no write

/** <CLAUDE_CONFIG_DIR>/settings.json, else ~/.claude/settings.json. */
export function claudeSettingsPath(env: NodeJS.ProcessEnv): string;

/** Pure: new settings text, or why it is left alone. No IO. */
export function editMonitorProjects(
  text: string, name: string, op: SyncOp,
): { kind: "updated"; text: string; projects: string[] } | { kind: "unchanged" | "absent" | "inferring" } | { kind: "invalid"; reason: string };

/** IO wrapper: read (missing file -> absent), edit, atomic write preserving mode, through symlinks. Never throws. */
export function syncMonitorProjects(file: string, name: string, op: SyncOp): SyncResult;

/** The console line for a result, or undefined when nothing should be printed. */
export function describeSync(r: SyncResult, name: string, op: SyncOp): { stream: "stdout" | "stderr"; text: string } | undefined;
```

`cli.ts`：`project add` 在 `addProject` 成功並印出原本訊息後，若 `opts.claudeSettings !== false`，執行 `syncMonitorProjects(claudeSettingsPath(process.env), name, "add")` 並印出 `describeSync` 的結果。`project remove` 在 `removeProject` 成功後做同樣的事（`--purge` 與否都同步）。清單解析共用 `parseProjects` 的規則，但不從 `plugins/` import（`plugins/` 不在 `src` 的建置範圍內），在模組內寫一個等價的 `splitProjects`，並由測試保證兩者結果一致。

## 8.4 驗收與測試（node-engineer 撰寫，先寫失敗測試）

新增 `test/claude-settings.test.ts`。所有檔案都在 `fs.mkdtempSync(os.tmpdir())` 底下。

`editMonitorProjects`（純函式）：
1. `project: "a"` 執行 add `b` → `"a,b"`，其他 key（`theme`、`env`、`pluginConfigs` 底下的其他 plugin、`options.command`）原值保留、順序不變，輸出結尾有 `\n` 並採 2 格縮排。
2. add 已存在的名稱 → `unchanged`；`" a , b "` 執行 add `a` → `unchanged`（trim 後比對）。
3. `"a,,b, a"` 執行 add `c` → `"a,b,c"`（正規化）。
4. `project: ""`、`"  , "`、缺少 `project` key：add → `inferring`，remove → `unchanged`。
5. remove `b`，原為 `"a,b"` → `"a"`；remove 唯一的名稱 → `""` 且 `projects: []`；remove 不存在的名稱 → `unchanged`。
6. 缺少 `pluginConfigs`、缺少 `status-monitor@inline`、缺少 `options`，或只有 `status-monitor@other` → `absent`。
7. 無效 JSON、含 `//` 註解、頂層是陣列、`options` 是字串、`project` 是數字 → `invalid`，且帶有 reason。
8. 名稱比對區分大小寫：`"Web"` 執行 add `web` → `"Web,web"`。
9. 與 `parseProjects` 一致：一組輸入（空字串、空白、重複、前後逗號）讓 `splitProjects` 與 `parseProjects` 得到相同的名稱（`['']` 對應 `[]`）。

`syncMonitorProjects`（IO）：
10. 檔案不存在 → `absent`，且目錄內沒有新增任何檔案。
11. 無效 JSON → `invalid`，檔案內容逐 byte 不變。
12. 更新後 mode 保留：先 `chmod 0600`，更新後仍是 `0600`。
13. symlink：`settings.json -> real/settings.json`，更新後 link 仍是 symlink，且目標內容已更新。
14. 寫入失敗（目錄設為 `0500`；以 root 執行時 skip）→ `invalid`、不 throw、原檔不變、沒有殘留 `.settings.json.*.tmp`。
15. `claudeSettingsPath`：有 `CLAUDE_CONFIG_DIR` 時用它（含 `~` 展開）；空字串或未設定時用 `os.homedir()/.claude/settings.json`。只測回傳的字串，不讀檔。

CLI（`test/cli.test.ts`，以 spawn 執行）：
16. 防護：`run()` helper 的子程序 env 一律帶入 `CLAUDE_CONFIG_DIR=<env.root>/claude`，呼叫端的 `extraEnv` 可覆寫；這樣就沒有任何 CLI 測試會解析到真的 `~/.claude`。
17. `project add x --dir <repo>`，settings 為 `project: "demo"` → 檔案變成 `"demo,x"`，stdout 含 `added "x"`，exit 0。
18. `project add x --no-claude-settings` → 檔案逐 byte 不變、沒有 `status-monitor:` 輸出。
19. 無效 JSON → exit 0，`project.yaml` 已建立，stderr 含 `warn   status-monitor:`，檔案不變。
20. `project remove x`（含 `--purge`）→ 從清單移除，stdout 含 `removed "x"`。
21. `project add` 失敗（名稱已存在）→ exit 1，settings 不變。
22. 推斷模式 → 檔案不變，stdout 含 `left unchanged`。

DoD：`npm run typecheck && npm run lint && npm test`；文件變更後加跑 `npm run check:docs`。

## 8.5 文件（docs-writer，中英文成對、標題與連結一致）

- `docs/commands.md` `## project add`：用法改為 `project add <name> --dir <repo> [--no-claude-settings]`，補一段說明：若 `<CLAUDE_CONFIG_DIR 或 ~/.claude>/settings.json` 已有非空的 `pluginConfigs."status-monitor@inline".options.project`，就把名稱加進去；空清單（推斷模式）、沒有該 entry 或沒有檔案時不動；JSON 無效時只警告；只對新開的 Claude Code session 生效。
- `docs/commands.md` `## project list and remove`：用法改為 `project remove <name> [--purge] [--no-claude-settings]`，說明會從同一份清單移除名稱，最後一個名稱移除後清單變空，回到推斷模式。
- `docs/commands.zh-TW.md`：以上兩節的對應翻譯。
- `README.md` 與 `README.zh-TW.md`：指令表兩列（第 28、29 行）補上 `[--no-claude-settings]`；「Monitor mod」→「Configure it」的 `project` 列（README.md 第 63 行與中文版對應行）補一句：`project add`／`remove` 會自動維護非空的清單。
- 本 spec 不列入 `docs/specs/README.md` 的優化索引（該表只收 2026-10-07 review 的 01–06）。

## 8.6 不採用的方案

- **放在 `scaffold.ts` 的 `addProject` 裡**：每個呼叫 `makeEnv` 的測試都會寫使用者的 settings.json，而且函式庫層多了副作用。
- **檔案存在但缺少 entry 時自動建立 `status-monitor@inline`**：沒裝 mod 的使用者會被塞進一份設定；就算有裝 mod，從無到有建立清單也會關掉推斷模式（同 #4）。
- **空清單時直接加入並印出提示**：使用者多半不會讀那一行，事後在別的 repo 看不到狀態時也難以追到原因。不修改，並明確告知怎麼做，比較安全。
- **在 Claude Code 寫檔時加鎖**：Claude Code 不遵守我們的鎖。改以「讀、改、寫在同一個同步呼叫內完成」把競爭窗口縮到毫秒級，並列為風險。
- **環境變數 `AGENT_LYCEUM_NO_CLAUDE_SETTINGS`**：需求不足，#3、#4 已涵蓋不想被動到的人。
- **保留原始字串只附加 `,name`**：要處理尾端逗號、空白與重複，邊界情況多；改成正規化重建，而且只在有實際增減時才做。

## 8.7 風險

- 與 Claude Code 同時寫 settings.json 時（例如使用者剛好在 `/config` 存檔），後寫入的一方會覆蓋前者。窗口很小，無法完全消除。
- 縮排會正規化成 2 格。使用者若手動用 4 格縮排，第一次同步後格式會改變（內容不變）。
- 使用暫存或非預設的 `--home`／`AGENT_LYCEUM_HOME` 執行 `project add` 時，名稱仍會寫進真正的清單，但 mod 用自己的環境解析時可能找不到這個專案。可用 `--no-claude-settings` 避開，文件會註明。
