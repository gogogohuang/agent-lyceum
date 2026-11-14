# 核可佇列（Approval Gate）設計

日期：2026-11-14　狀態：第 12 版（第 11 版審查的嚴重項已納入：執行器 `command` 只能一個元素、`sandbox.failIfUnavailable`、user 層設定的處理；其餘為第 11 版內容：第 10 版審查的嚴重項已納入：列入的 Claude agent 加 `--setting-sources user`；其餘為第 10 版內容：第 9 版審查的嚴重項已納入：wake 前殘留輸出先收走再 park、快照只雜湊靜態可寫範圍；其餘為第 9 版內容：確定性請求 id、`record.json` 以 `link` 獨佔、gc 不復活、回饋改記逐請求送達序號、`show` 嚴格唯讀、origin 綁定；第 8 版審查的嚴重項已納入）

## 1. 背景與目標

使用者希望 agent-lyceum 能讓 agent 代為處理日常事務，並在對外動作之前經過人的核可，且兼顧安全。日常工作隨時可能中斷，或需要補充 context 後重做，所以 `run`、`resume`、重做、`call` 都必須支援。

- *領域規則歸 agent 與執行器*：什麼算可疑、動作怎麼做、結果怎麼驗證、哪些欄位要檢查等，寫在 `AGENT.md`、團隊組成與執行器裡，框架不認得任何領域概念。
- *強制力歸框架*：agent 的輸入不可信（prompt injection），所以「等人核可」「稽核」「至多一次」不能由 agent 自己執行。
- 框架唯一新增的能力：*人類核可佇列加使用者註冊的執行器*。排程、通知、手機回覆、連接器都在框架外。

### 1.1 框架保證與不保證

*框架保證*（且只保證這些）：

1. 這串位元組被一個人*完整看過並同意*，且核可的就是被執行的那一份。
2. 同意後至多一次交給你指定的程式，在沙盒外、乾淨環境下執行，並留下可讀的稽核。
3. 沒有經過上述流程，列入的 agent 無法透過框架已知的通道對外做事（前提見第 3 節，且僅限已知通道；`open_pr`〔lead 的 `done` 郵件欄位〕是例外，只警告，見前提 7）。

*框架不保證、也不檢查*：payload 的內容是否合理或安全（內容是否被 injection 扭曲、動作的對象是否正確）；執行器本身是否正確、是否冪等；憑證是否被 agent 讀到（沒有讀取隔離）；agent 在 `sandbox.write` 範圍內的破壞。核可畫面是「讓人看見內容」，*不是*安全檢查。這些是領域與使用者的責任（見第 5 節）。

| 項目 | 框架 | 領域（agent／執行器／使用者） |
|---|---|---|
| 請求通道、複本為真相、完整顯示、核可、至多一次、稽核 | 負責 | 無 |
| 列入 agent 的能力封鎖與環境白名單 | 負責 | 無 |
| 設定與資格的重驗與快照 | 負責 | 無 |
| payload 的格式與語意、動作是否安全 | 不解讀、不檢查 | 負責（使用者讀 payload 核可，執行器自行驗證） |
| 冪等、失敗重試、部分完成的處理 | 提供 `APPROVAL_ID` | 負責 |
| 憑證取得與保管 | 不以環境變數傳給 agent，只傳給執行器 | 執行器負責；檔案層級的隔離不在框架內 |
| 通知、排程、手機回覆 | 不做（run 結束只印出待核可數） | 框架外 |

## 2. 非目標

- 不內建動作型別、分級表、連接器、排程、通知。
- 不重用 `ask`（它讓 run 停在 `waiting`，且 `call` 與 `run --agent` 不能用）。
- 不修改既有郵件類型、run 狀態與既有設定檔 schema。
- *不提供讀取隔離*，也*不攔截 agent 以其他途徑直接做事*（見 5）。
- 第一版不做：執行器預覽（`describe`）、web console 核可、Windows、列入角色的多實例並行、稽核 hash 鏈。

## 3. 安全前提

*「列入」的定義*：一組（專案或 `call`、角色基底名）出現在任一執行器的 `allow` 中，該組合的 agent 就是「列入」。逐組判定：同名但沒出現在 `allow` 的專案裡的 agent *不是*列入，行為完全不變（`doctor` 對這種同名情況發警告）。實例名 `name--k` 以 `roleOfName` 還原為基底名；第一版列入角色的有效實例上限強制為 1（落點是 `instanceCap` 對列入角色回傳 1，並讓 `doctor` 警告專案層 `dispatcher.max_instances` 與之不符）。

核可關卡只有在下列條件全部成立時才有強制力。`doctor` 檢查，*並且在 `approve` 與每次執行前重新檢查*。不成立時拒絕收請求與拒絕執行；*列入的 agent 每次 wake 前也重驗，失敗就不喚醒該 agent 的 slot*，並在 `status` 顯示原因（前提恢復後下次 wake 自動重試）。run 層級沿用 `run-session.ts` 約 966 行的先例：通知 lead，本 run 不再喚醒該 slot（重用既有的 `refused` 機制，在本 run 內持續；下次 `run` 或 `resume` 才重驗並重試，前述「下次 wake 自動重試」即指此）。

0. *第 0 步實驗（見 8）*：子行程繼承 OS 沙盒、agent 無法自己 `approve`、預設網路被擋。實驗失敗，*整個功能不上線，不是降級*。
1. *OS 沙盒可用*（macOS，或 Linux 且有 `bwrap`）。無 OS 沙盒時，Claude 只剩 Edit 規則（Bash 可繞過），Codex 為 prompt-only（`policy.ts` 的 `enforcementFor`、`write-scope.md`），agent 可直接改寫 `approvals/`。
2. *containment*：`approvals/`、`requests/`、`executors.yaml`，以及每個執行器的 `command[0]`、其真實路徑、所在目錄與 shebang 直譯器（*第一版 `command` 只能恰有一個元素*：不允許 `["/usr/bin/python3", "<repo 內腳本>"]` 這種把 agent 可改寫的腳本藏在參數裡的寫法；需要參數或腳本時，用位於 containment 之內的包裝程式），*除了「該 agent 自己的 `proposals/`」（見 4.1）外*，都不得位於任何 agent 可寫範圍之內；祖先目錄的可寫權限也不得涵蓋其他 slot 的 `proposals/` 或 `approvals/`。可寫範圍包含：`writePolicy` 的 `allowDirs`、專案目錄（含 `dir: ~` 這類涵蓋 home 的設定）、worktree、`sandbox.write`。全部用 `canonicalPath` 真實路徑比對。（現況只有 `call` 檢查「`--dir` 不得在 home 之內或之上」，一般 run 沒有，所以這項要新增。）
3. *列入的 agent 不得設* `sandbox.unix_sockets`、`sandbox.network`、`sandbox.local_binding`，*也不得設* `allow_web: search|fetch`（對外通道）。另外要*驗證預設網路確實被擋*（見 8），而不只是檢查「沒有設定」。
4. *列入的 agent 不得有 MCP*：Claude 於建構呼叫時加 `--strict-mcp-config` 並給空設定（不事後偵測，因為使用者 MCP 在 `~/.claude.json`、專案 `.mcp.json` 在 agent 可寫的 repo 內）。旗標集中加在 `buildClaudeInvocation`（`adapters/claude.ts` 約 63–93 行）；fallback 與 tier 只換 runtime 與 model（`fallback.ts:51-56`），所以只要以「列入」標記為依據就會一致套用。*實作需新增*：`ResolvedAgent` 與 `WakeInput` 的「列入」欄位，並確認 solo 與 `call` 的 wake 也套用。*前提重驗不可掛在 `invokeWithSandboxChecks`*：它對沒有 `sandbox` 設定的 agent 與帶 `policy` 的 wake 直接放行（`sandbox-invocation.ts` 約 170 行），需另設進入點。Codex 沒有已知的對應旗標，也不能事後偵測，所以*列入的 agent 不得使用 Codex*，包含 `fallback` 候選中含 Codex 的情況，`doctor` 必須擋。前提 3 的禁用以每個候選的有效設定判斷，不只看 primary。同時禁止 `--dangerously-bypass-approvals-and-sandbox` 與 `danger-full-access`。*另外，Claude 對列入的 agent 必須加 `--setting-sources user`*（`claude --help` 列有此旗標，值為 user、project、local；`--bare` 只讀 API key、不讀 OAuth，不適用）：現況 `adapters/claude.ts` 只傳 `--settings`、沒有任何來源隔離，agent 可寫的 repo 內 `.claude/settings.json` 與 `.claude/settings.local.json`（`policy.ts` 只保護 `CLAUDE.md`／`AGENTS.md`）會被合併，其中 `apiKeyHelper`、`statusLine`、`env`、`sandbox.excludedCommands`、`permissions.allow` 等由 Claude 本體處理、不在 OS 沙盒內，等於又一條沙盒外執行的通道。縱深防禦：同時把這兩個檔案加進列入 agent 的 `deny`。*沙盒必須是硬性的*：對列入的 Claude agent 在 `--settings` 加 `sandbox.failIfUnavailable: true`（現況 `buildClaudeSettings` 只設 `enabled: true` 與 `allowUnsandboxedCommands: false`；`claude` 的預設是沙盒後端起不來時讓 shell *無沙盒*執行，訊息為「a missing backend would run the shell unconfined」，所以前提 1 只探測 `bwrap` 存在是不夠的）。*user 層設定也會被合併*：`~/.claude/settings.json` 的 `sandbox.excludedCommands`（例如 `git`、`docker`，被排除的命令在沙盒外執行，agent 可借 `git -c alias.x='!…'` 之類執行任意指令）、不帶路徑的 `permissions.allow`（Edit 工具在 Claude 行程內，不受 OS 沙盒管）、`additionalDirectories`、`sandbox.filesystem.allowWrite` 都可能擴大權限。因此：(i) 優先驗證 `--setting-sources ""`（空來源）是否仍能以 OAuth 登入，可行就改用空來源（第 0 步 (f)）；(ii) 否則 `doctor` 與每次 wake 前對 user 層的 `sandbox.*` 與 `permissions.*` 整個命名空間做*白名單*檢查（涵蓋 `sandbox.network.*`、`permissions.allow` 內的 `WebFetch`／`WebSearch` 等，不逐鍵列舉），不在白名單內就拒絕；(iii) 無論如何，把 `approvals/`、`executors.yaml`、各執行器檔案，以及*其他 slot 的*請求目錄以*逐項*方式加進列入 agent 的 `deny`（不可對 `requests/` 整個加 deny，否則會蓋掉自己 `proposals/` 的 allow；仿 `runDenyPaths` 逐項列）。
5. *列入的 agent 只收到白名單環境變數*：adapter 現況以 `...process.env` 啟動 agent（`adapters/claude.ts:98`、`adapters/codex.ts:91`）。對列入的 agent 改為只傳 runtime 運作所需的白名單（`PATH`、`HOME`、`LANG`、`TERM`、`TMPDIR`；第一版*不猜*登入所需的其他變數，Claude 在此白名單下能否登入與運作列為*人工發布證據*，於第 0 步一併在真機驗證，不通過就不上線該 runtime）。其他 agent 不變。（`AGENT_LYCEUM_AGENT` 也會消失；正式程式碼沒有其他處讀它；`test/fixtures/runtime/fake-claude.mjs` 與 `test/adapters.test.ts` 會用，測列入的 agent 時要改用別的方式傳身分。）
6. 平台不是 Windows。
7. *dispatcher 在沙盒外執行的 repo 內指令*：`project.verify.commands`（`verify.ts` 以 `sh -c` 在 agent 可寫的 repo 或 worktree 內執行，環境為完整的 `process.env`，由 `settle()` 在 done 時觸發）屬於「agent 可改寫其內容、卻在沙盒外執行」的通道，會完全繞過核可關卡。*列入的 agent 所在的專案若設有非空的 `verify.commands`，`doctor` 報錯、拒收請求*（agent 的可寫範圍涵蓋專案目錄，所以這兩者不能並存；要用 `verify` 的專案，請用沒有列入的團隊成員）。`open_pr` *不是專案設定*，而是 lead 在 `done` 郵件中帶的欄位（`run-session.ts` 約 1085 行）：dispatcher 推送 agent 寫的分支並開 PR，不執行 agent 的程式碼，但會把內容送出去。所以 `doctor` 對*任何列入 agent 所在的專案*警告「lead 可請求 `open_pr`」；run 中 `done` 真的帶 `open_pr` 時，在 run log 與結束輸出再警告一次（只警告，不阻擋）。dispatcher 對 agent worktree 的 git 呼叫已關閉 hooks、fsmonitor 等（`write-scope.md`），不另列。
8. *帶 `policy` 的 wake*（tidy、verify、format 等）雖不配置 `proposals/`（4.1），但對列入的 agent 仍必須套用 `--strict-mcp-config` 與環境白名單（第 3 節 4、5）；`invokeWithSandboxChecks` 對這類 wake 直接放行，所以需明確套用。

`approve` / `reject` / `resolve` 的輔助防線（僅輔助，不可單靠）：要求互動式 TTY；要求輸入請求 id 前 8 碼確認（id 可由 agent 事先算出，所以這只防誤操作，真正的屏障是第 0 步 (a)）；稽核記錄本機使用者名稱與 TTY。

*資格快照與 origin*：收走時把「前提檢查結果」與下列欄位的 sha256 寫進 `record.json`：該 agent 解析後設定中的 runtime 候選清單（不含 model、tier、session 等執行期變動欄位）、`sandbox`、`allow_web`、*靜態*可寫範圍（定義為 `writePolicy` 的 `allowDirs` 與 `allowFiles` 扣除每個 run 才有的項目，*不逐項列舉*；包含 `sandbox.write`〔canonical〕、`grantOwnDir`、`memory.global` 與 `memory.project`、lead 的 `recordsDir` 與共用檔、`canEditAgentMd` 的 `AGENT.md`；*扣除*：task memory（`memory.task`，`clear` 時刪除）、outbox、worktree 的 `gitDir`、`proposals/`——`policy.ts` 的 `allowDirs` 含 `outboxDir` 與 `ws.gitDir`，原 run 被 `clear` 後必然不同，納入雜湊會讓 `clear` 之後所有請求都無法核可）、專案目錄（canonical）、`executors.yaml` 中該執行器的條目。`command[0]` 的檔案 sha256 *不*進快照（只在畫面與稽核顯示，以免升級執行器使所有 pending 失效；每次執行前仍檢查它是否可寫）。另在 `record.json` 存不含機密的 `origin`：（`project` 名稱或 `call`、canonical 專案路徑、角色基底名、run-id 或 call-id、收走當時的完整可寫集合〔canonical 路徑清單，*只供顯示與稽核，不參與比對*〕）。`approve` 透過小型 resolver `resolveOrigin(origin)` 重新解析設定，回傳 `{ ok: true, resolved }` 或 `{ ok: false, code, hint }`。它*只依專案設定與 `origin`*，不需要原 run 的任何檔案，所以原 run 被 `clear` 之後仍可 `approve`。專案設定不存在、canonical 路徑與 `origin` 不符、agent 不存在、或任一快照欄位不符時，拒絕核可並印出可執行的說明（請求維持 `pending`；可 `reject`，或修復設定後再核可，要重做就請 agent 重新提出）。resolver 的簽名與錯誤碼於第一個實作任務定稿（§10）。

## 4. 設計

### 4.1 目錄配置與輪替

貼合既有 outbox 的做法（每個 agent 在每個 run 有一個固定的 outbox，失敗嘗試的輸出被 park 走），但*以整個目錄的 `rename` 輪替*，不逐檔搬移：

~~~
<home>/
  executors.yaml
  requests/
    projects/<project>/<run-id>/<slot>/
      proposals/            ← agent 唯一可寫位置（每個 run、每個 slot 一個，總是空的開始）
      collected/<seq>/      ← 成功的 wake 結束後，proposals/ 被輪替到這裡，等待處理
      collected/<seq>.done  ← 該目錄已處理完畢的標記（dispatcher 寫）
      parked/<attempt-id>/  ← 失敗或被中斷的嘗試的 proposals/，永不收走
    calls/<call-id>/
      proposals/、collected/、parked/（同上）
      ok.json               ← dispatcher 在 call 成功時寫入
  approvals/
    <id>/                   ← agent 不可寫
    .trash/                 ← gc 先 rename 到這裡再刪除
    .feedback/<project>/<role>.json   ← 每個請求「已送達的最大狀態序號」（4.9）
    .denied-count/
~~~

*輪替 `rotate(slot, dest)`*（`dest` 是 `collected/<seq>` 或 `parked/<attempt-id>`）：
1. 以 `lstat` 確認 `<slot>/` 與 `<slot>/proposals` 都是真目錄、非 symlink。`proposals` 不存在（ENOENT，例如崩潰在輪替的 `rename` 之後、`mkdir` 之前）時重建，不算異常；是 symlink、檔案或其他型態才算異常：該 slot 的收走暫停並記錄（不影響其他 slot），*且該 slot 不被喚醒*（無法確保 `proposals/` 為空，成功後會把失敗嘗試的殘檔一併收走），`status` 顯示原因；使用者清除異常後下次 wake 自動恢復。
2. `renameSync(<slot>/proposals, <slot>/<dest>)`。dispatcher 在自己擁有的父目錄下操作；若 `proposals` 被換成 symlink，被搬走的是連結本身，不穿越到目錄外。這比逐檔搬移更安全，並讓「重做看到空目錄」自然成立。
3. 重建空的 `proposals/`（`mkdir`，0700），再 `lstat` 確認。

`seq` = max(slot 目錄下高水位檔 `collected.seq` 的值, `collected/` 內所有數字目錄名與 `<n>.done` 的 n) 加一，比較以數字、不以字典序。高水位檔在每次輪替成功後以暫存檔加 `rename` 更新，且只增不減；因為取的是「高水位與現存目錄名」的最大值，*輪替的 `rename` 之後、更新高水位之前崩潰，也不會重用序號*。高水位檔不存在視為 0（全新 slot）；*存在但無法解析時，該 slot fail-closed*（暫停收走、不喚醒，`status` 顯示原因），不猜測。`requests gc` 刪除目錄前先對齊高水位（4.8），所以 gc 不會讓 `seq` 回頭（否則同檔名同內容會得到相同的來源鍵與 id，被當成舊請求）。每個 wake 開始前，dispatcher 先處理 slot 內可能殘留的輸出：*`proposals/` 非空時，先判定它屬於誰*——若 slot 最近一次 attempt 所屬的 claim 為 `output_ready` 或 `committed`（*以 claim 狀態判定*；attempt 為 `output_ready` 但 claim 已 `abandoned` 是情況 (b)，應 park，不收走）（成功的 wake，但收走尚未完成，例如前提暫時不成立、`rotate` 丟例外），*先走收走流程*（`rotate` 到 `collected/<seq>` 並處理）；只有屬於失敗、中斷或 `abandoned` 的嘗試才 `rotate` 到 `parked/`；無法判定（缺 attempt 記錄等）或收走本身失敗時，*不喚醒該 slot* 並在 `status` 顯示原因（不得為了喚醒而丟棄請求）。確認 `proposals/` 存在且為空之後，才把 canonical 路徑加入該 agent 的 `allowDirs`、在 prompt 告知路徑。（`ensureAgentDirs` 目前只在建專案與開實例時被呼叫，不在每次 wake 前；「每次 wake 前確保」是新增。）

- *只有走 claim 的一般 wake（含單 agent 模式）與 `call` 有 `proposals/`*。tidy、verify、format 這類帶 `policy` 的 wake 不配置，列入的 agent 在這些 wake 裡沒有可寫的請求位置。
- 位置在 home 下、與 run 的 task memory 無關，所以不隨 `clear` 或 task memory 清理而消失。
- `<slot>` 為 `name` 或 `name--k`；名稱皆以 `assertName` 驗證。

### 4.2 設定：獨立的 `executors.yaml`

不修改 `team.yaml`、`project.yaml` 與任何 `.strict()` schema。舊版不認得此檔，直接忽略。範例使用中性名稱。

~~~yaml
executors:
  exec-a:
    command: ["/abs/path/to/exec-a"]             # 絕對路徑，恰一個元素
    allow:                                       # 必填；(專案, agent) 配對，無「預設全部」
      - { project: proj-a, agent: agent-a }
      - { call: agent-b }
    timeout_sec: 60
    env: { TOKEN_FILE: "~/.secrets/token-a" }    # 只做 ~ 展開，不展開 $VAR
    expires_days: 7                              # 預設 7
    max_pending: 10                              # 每個（專案或 call、角色基底名、執行器）的 pending+executing+unknown 上限，預設 10
    max_payload_bytes: 4096                      # 預設 4096；上限 65536；見 4.6
limits:
  max_total_pending: 50
  max_scan_entries: 200                          # 每個 collected/<seq> 最多處理的直接子項數
  retention_days: 90                             # 終態記錄的保留天數（供 gc）
~~~

沒有 `executors.yaml` 或 `allow` 為空，功能完全不啟動。

### 4.3 請求檔

- 檔名須符合 `^[A-Za-z0-9._-]{1,64}\.req$`，且不以 `.` 開頭；其餘一律忽略（不是請求，不產生任何記錄）。agent 以先寫 `.<name>.tmp` 再 `rename` 的方式原子寫入。
- 格式*不使用 YAML*：檔頭至多 2 行 `key: value`（`executor`、`summary`），空行後為 payload 原樣。檔頭總長至多 2048 位元組；`summary` 至多 300 字元。
- *內容白名單*（整個檔案含 `summary`）：必須是合法 UTF-8；控制字元只允許 `\n` 與 `\t`；*拒收*：ESC、`\r`、其他 C0/C1 控制字元、所有 Unicode `Cf` 類（含 bidi 控制、零寬字元、U+FEFF、U+2060、tag 字元）、除一般空格 U+0020 與全形空白 U+3000 外的 `Zs`、`Zl`、`Zp`（含 U+00A0、U+2028、U+2029；U+3000 在 CJK 文字中常見且有可見寬度，放行。ZWJ／ZWNJ 屬 `Cf`，仍拒收，這會讓部分 emoji 序列與波斯文被拒，屬已知限制）、variation selector、以 Unicode `Default_Ignorable_Code_Point` 整類拒收（涵蓋 U+034F、U+17B4、U+17B5、U+180B–U+180F 等）、以及外觀為空白的 U+115F、U+1160、U+3164、U+FFA0、U+2800。目的是讓「顯示的就是內容」：框架不改寫 payload，只拒收看不見或會改變顯示的位元組。這是位元組與字元類別層級的格式規則，不涉及語意。

### 4.4 收走規則

*時機（鏡射 outbox 路由）*：`routeOutboxes`（`mailbox.ts` 約 324 行）掃描所有 agent 的 outbox、不依賴批次參數、有 `RouteJournal` 來源鍵，註解寫明「崩潰後可安全重跑」。收走請求比照它，放在 `settle()`（`run-session.ts` 約 975 行）裡 `routeOutboxes` 之後，同樣不依賴批次參數：

1. *先完成未處理的目錄*：對每個列入 slot，處理所有沒有 `.done` 的 `collected/<seq>/`（涵蓋崩潰後重入）。
2. *再輪替本次成功的輸出*：對 `proposals/` 非空的列入 slot，`rotate(slot, collected/<seq>)`，處理它，再寫 `collected/<seq>.done`。

*失敗與中斷的嘗試（park）*：
- 嘗試失敗或被取消時（`run-session.ts` 約 825、831 行，`parkOutbox` 的呼叫處），對該 slot `rotate(slot, parked/<attempt-id>)`。這需要*新函式*（`parkOutbox` 的目的地固定為 `mail/attempts/<id>/outbox`，`message-store.ts:339`，且逐檔搬移會穿過 symlink，不適用）。
- 崩潰時，`recoverRunMail`（`message-store.ts` 約 362–366 行，目前只有 `outboxOf` 鉤子）需要*第二個鉤子*（例如 `proposalsOf`），涵蓋兩種情況：(a) 狀態為 `started` 的被中斷嘗試；(b) *attempt 已 `output_ready`、但 claim 還是 `claimed` 而被標為 `abandoned`* 的視窗（`finishAttempt("output_ready")` 與 `markOutputReady` 之間崩潰；該 wake 會被重做，所以它的請求也要 park，否則使用者會看到同一件事被提兩次）。之後 `recover()` 呼叫的 `settle([], [])` 才會收走仍屬於 `output_ready` 或已 `committed` claim 的輸出。*順序與範圍*：情況 (b) 必須「先 park `proposals/`，再把 claim 存為 `abandoned`」（反過來在兩者之間崩潰，下次 recover 只看到 `abandoned`，舊輸出不會被 park，會被當一般輸出收走而重複提出）；且只針對*本次 recover 剛從 `claimed` 轉成 `abandoned`* 的 claim 動作，不得對所有 `abandoned` 且 attempt 為 `output_ready` 的 claim 重複 park（否則每次 `resume` 都會誤 park 之後成功 wake 的輸出）。
- 被 park 的檔案*永不收走*，也不會成為 `redoContext` 的重做草稿（現有 `collectDrafts` 只讀 `attempts/<id>/outbox`；這個取捨寫進文件）。

*`call`*：每個 fallback 候選嘗試前確保 `proposals/` 為空，失敗的候選結束後 `rotate(…, parked/<n>)`；最終成功時*先寫 `ok.json`（早於寫 `result.md`，避免「結果已寫、成功標記未寫」的崩潰窗口讓請求永久遺失）*，在 `guard.check` 之後、`lease.release()` 之前（`call.ts` 約 209 與 217 行之間）輪替並處理（若崩潰在 `ok.json` 之後、`result.md` 之前：請求仍可被 `collect --call` 收走，但這次 call 沒有 `result.md`；接受並寫進文件，使用者從 `approvals list` 取得請求，要不要重跑 call 由使用者決定）。`call` 沒有 resume，若收走中途崩潰，使用者執行冪等的 `approvals collect --call <call-id>`：只在存在 `ok.json` 時，處理未 `.done` 的 `collected/` 並輪替 `proposals/`。失敗的 `call`（無 `ok.json`）其輸出永不收走。

收走*與郵件是否被接受無關*：wake 成功即收走，即使該 wake 的郵件之後因格式問題被退回、lead 要求重做，已收走的請求仍在佇列（`pending`），由使用者決定核可或拒絕。收走過程丟出例外（`EACCES`、`ENOSPC` 等）時，記錄並繼續，*不得阻擋 `commitClaim`*；未 `.done` 的目錄下次 `settle` 重試。

*follow-up 重開已完成的 run*：run-id 沿用（`runDir` 沿用），`proposals/` 沿用，`seq` 接續，來源鍵含 `seq`，所以重開前後互不干擾。

*不依賴「沒有存活行程」*：程式碼無法證明（`process-runner.ts:53` 自承可能漏掉逃逸的子行程），所以安全性來自下列幾項：

1. *以 `approvals/` 內的複本為唯一真相*：使用者核可、執行器收到的都是複本。
2. 讀取只用 `readRegularFileCappedNoFollow`（`fs-util.ts` 約 103 行；它回傳的 buf 已截到上限，要以 `truncated` 與 `size` 判斷超過全域上限；它不回傳 inode，所以步驟 4 的 inode 比對需擴充該 API 回傳 fstat 的 `ino`；`O_NOFOLLOW`、`O_NONBLOCK`、fstat 為一般檔）。讀取上限是*全域上限* 65536 加檔頭上限 2048；讀完、解析出 `executor` 之後，才套用該執行器的 `max_payload_bytes`。symlink、FIFO、超過全域上限一律 `denied`。
3. *hash 與複製來自同一份已讀入的 Buffer*；內容白名單（4.3）在這份 Buffer 上檢查。
4. 讀取每個檔案後再 `lstat` 一次並比對 inode，不符就丟棄該筆。只處理 `collected/<seq>/` 的直接子檔，依（mtime, 檔名）排序，超過 `max_scan_entries` 的忽略，並為該目錄建立*一筆*聚合的 `denied`（原因 `scan_limit`，含被忽略的數量）。
5. *去重與冪等（確定性 id）*：請求 id 由來源鍵*確定*：`id = sha256(來源鍵)` 的前 24 碼 hex，來源鍵為（`run` 或 `call`、run-id 或 call-id、`slot`、`seq`、檔名、payload sha256）以固定分隔與長度前綴編碼的字串。id 只由來源決定，所以重入（崩潰後 `resume`、並行的收走者、`collect --call` 重跑）一定得到同一個 id，*不需要任何標記檔*，去重就是 `mkdir` 的 EEXIST。順序如下，任一步崩潰都可重入且不遺失、不重複：
   1. 計算 id；`mkdir approvals/<id>`，已存在（EEXIST）就續用。
   2. *若 `record.json` 已存在，跳過以下所有寫入*（它不可變，絕不覆寫已推進的狀態；配額也不重複計入）。
   3. 寫 payload：同目錄暫存檔（模式 0400）後以 `linkSync` 建立 `payload`（原子、獨佔）。EEXIST 時比對既有 `payload` 與手上 Buffer 的位元組：相同則續用；不同則該項 fail-closed（記錄到 run log，不建立 `record.json`，不覆寫）。
   4. 寫 `record.json`：同目錄暫存檔後以 `linkSync` 建立（獨佔，第一個贏，不再用 `rename`，所以並行收走者不會互相覆寫）。EEXIST 表示另一個收走者已提交，核心欄位（來源鍵、payload hash）由同一來源鍵決定而一致，時間與快照欄位可能略有差異，以先提交者為準，直接採用既有者。*`record.json` 是提交點*：沒有它的 id 目錄視為未完成，重入時補完；`approvals gc` 會清掉長期未完成者。
   列舉請求時一律排除以 `.` 開頭的目錄（`.feedback`、`.denied-count`、`.trash`）。
   *復活問題與 gc 規則*：id 確定，所以只要來源 `collected/<seq>` 還沒 `.done`，重入就會重建同一個 id；若其終態記錄已被 gc 刪掉，重建會得到全新的 `pending`。因此 `approvals gc` 只能刪除「來源 `collected/<seq>` 已 `.done`，或其 run 已不存在」的記錄（見 4.8）。
   同一個 slot 在後續 wake 重提相同內容會得到新的 `seq`，因此是新的請求（不會被永久擋住）；核可畫面與回饋會標示「與 <id>（狀態）相同」，由使用者判斷。
6. *收走結局表*（同一張表決定是否建立 `denied`）：

   | 情況 | 結局 | 原因代碼 |
   |---|---|---|
   | 檔名不符 `.req` 規則、dotfile、`.tmp` | 忽略，不建立任何記錄 | — |
   | 非一般檔（symlink、FIFO、目錄） | `denied`（來源鍵用（檔名、原因）） | `not_regular` |
   | 超過全域讀取上限 | `denied`（來源鍵用（檔名、原因、size）） | `too_large` |
   | 內容白名單不符 | `denied` | `bad_content` |
   | 缺 `executor` 或未註冊 | `denied` | `bad_executor` |
   | 檔頭格式不符（缺空行、超過 2 行、未知或重複的 key） | `denied` | `bad_header` |
   | `(專案或 call, 角色)` 不在其 `allow` | `denied` | `not_allowed` |
   | 超過該執行器的 `max_payload_bytes` | `denied` | `too_large` |
   | 超過 `max_pending` 或 `max_total_pending` | `denied` | `quota` |
   | 超過 `max_scan_entries` | 該目錄一筆聚合 `denied` | `scan_limit` |
   | 目錄層異常（4.1 輪替步驟 1） | 該 slot 暫停收走，寫入 run log 與 `status` | — |
   | 前提不成立（第 3 節） | 不 `rotate`、不寫 `.done`、*不建立 `denied`*；輸出留在 `proposals/`，該 slot 不被喚醒並在 `status` 顯示原因；列入的是 lead 本身時沿用 `refuseMember` 先例（lead 被拒則 run 停止，`run-session.ts` 約 1411 行） | — |
   | 通過 | 建立 `pending` 記錄（無狀態檔即為 `pending`）與資格快照 | — |

   配額是近似的*軟限制*：不上鎖，且只能在收走時檢查、無法阻止 agent 在 `proposals/` 內寫入；並行 run 同時收走可略微超額，由 `max_total_pending` 兜底，兩者都不是硬上限。`denied` 前 100 筆（每個專案或 call 與角色）保留完整記錄，其後只累計次數（`approvals/.denied-count/`；沒有 `record.json`，崩潰重入可能重複計數，屬近似值，測試不假設精確）。`denied` 記錄與其他記錄一樣是 `record.json`（內含不可變的 `disposition: denied` 與原因代碼），*不建立狀態檔*。

殘留風險（寫進文件）：逃逸的背景程序可在輪替之後寫入新的 `proposals/`，下次 pass 才會被看到，它只能新增請求（受配額限制），不能改變已收走的複本；若它持有已輪替檔案的 fd，也只能改動 `collected/` 內的檔案，而複本已在 `approvals/`。「沙盒下 agent 無法替換 `proposals/` 本身」的假設（8.0 (c)）不成立時，輪替步驟 1 的 `lstat` 檢查是第一道防線；`rename` 目錄不穿越 symlink 是第二道。

### 4.5 id 與狀態機（序號狀態檔，無鎖）

id：`sha256(來源鍵)` 的前 24 碼 hex（確定性，見 4.4-5）；顯示用至少 8 碼的唯一前綴。既有 `newId` 只有 3 bytes，不重用。

*為什麼不用鎖*：現有程式沒有「接管死鎖」的原子實作（`lockAgent` 是 `rmSync` 後重試，`.admit` 是 `wx` 加 mtime 清理），照搬會有雙持鎖。改為*序號狀態檔*，手法與 `project-lock.ts` 的 `tryCreate`（同目錄暫存檔、`linkSync`、`finally rmSync`）相同，是現成先例：

- `record.json` 在提交後*不可變*（來源鍵、`origin`、快照、提出者、`created_at`、`expires_at`、`disposition`）。
- *無狀態檔時*，目前狀態由 `record.json` 的 `disposition` 決定：`denied`（含原因代碼，終態，*不需要狀態檔*）或 `pending`（其 `updated_at` 為 `record.created_at`）。之後狀態存於 `approvals/<id>/state/<n>.json`（n 從 1 起）。目前狀態是*數字最大*的 n（以數字排序，`10` 大於 `2`）。每一次轉換都是建立 `state/<n+1>.json`：先在同目錄寫暫存檔（檔名不得符合 `^\d+\.json$`）並 `fsync`，再以 `linkSync` 建立（*獨佔*：同一個 n+1 只有一個行程能成功，其餘得到 EEXIST），最後刪暫存檔。EEXIST 的一方重新讀取最新狀態，再判斷操作是否仍適用，不適用就回報「已被處理」。
- 最大 n 的狀態檔若無法解析，*fail-closed*：拒絕一切轉換，並在 `show` 與 `list` 標示「記錄損毀」。
- 每個狀態檔含：狀態、前一個 n、時間（即 `updated_at`）、動作者（本機使用者、TTY、pid 與行程啟動時間）、與該轉換有關的資料（例如退出碼、截斷輸出、`resolve` 的結論）。狀態檔就是稽核事件列表（見 4.8）。狀態檔一經建立不可改。
- 磁碟滿時，暫存檔寫不成就不 `link`，是安全的；若 `executed` 或 `failed` 寫不進去，請求停在 `executing`，之後依下表落到 `unknown`。

| 目前狀態 | 事件 | 前置條件 | 新狀態檔 |
|---|---|---|---|
| （收走） | 驗證不通過 | 4.4-6 | 不建立狀態檔；`record.json` 的 `disposition` 為 `denied`（終態，含原因代碼） |
| `pending` | `reject` | — | `rejected`（終態） |
| `pending` | `list --all`、`approve`、收走時的懶惰檢查 | `now > expires_at` | `expired`（終態） |
| `pending` | `approve` | 未過期、`now ≥ created_at`、第 3 節前提與資格快照重驗通過、`executor` 仍註冊且 `allow` 仍成立、輔助防線通過、能取得本行程的 `pid_started`、*已完整瀏覽 payload 並由使用者確認*（瀏覽的位元組數與 sha256 寫在這個狀態檔內）、重算 payload hash 與記錄相符 | `executing`（含 pid 與 `pid_started`） |
| `pending` | `approve` 發現 payload hash 不符 | — | `tampered`（終態） |
| `pending` | `approve` 發現 `now < created_at` 或資格快照不符 | — | （不建立；拒絕並說明原因，維持 `pending`） |
| `executing` | 執行器退出碼 0 | 建立者行程 | `executed`（終態） |
| `executing` | 退出碼非 0、逾時、spawn 失敗（ENOENT／EACCES） | 建立者行程 | `failed`（終態） |
| `executing` | `approve` 行程被 Ctrl-C／SIGTERM | 終止執行器行程群組（同逾時），因結果無法確定 | `unknown` |
| `executing` | `list --all`、`approve`、收走時發現建立者已死（見下） | 判定為死亡 | `unknown` |
| `unknown` | `resolve executed\|failed` | 輔助防線通過 | `executed` 或 `failed`（記為人工判定） |

- *建立者存活判定*（不直接使用 `lockHolderAlive`：它在 `pid_started` 缺值或 `ps` 讀不到時回傳 `true`，是 fail-open，會讓死掉的 `executing` 永遠不轉）：新增嚴格版函式，需匯出 `project-lock.ts` 目前私有的 `pidStart()`。`kill(pid, 0)` 回 ESRCH 為已死；pid 存在且 `pid_started` 相符為存活（回報「處理中」）；pid 存在但 `pid_started` 無法驗證時，在 `executing` 建立時間起算 `timeout_sec` 加 60 秒寬限之前視為存活，之後視為已死。所以不需要另開 `resolve` 路徑：任何卡住的 `executing` 最終都會變成 `unknown`，再由 `resolve` 處理。
- 「`approve` 在建立 `executing` 之前崩潰」不需要任何接管：沒有鎖、沒有狀態檔，請求仍是 `pending`。
- *至多一次*：只有成功建立 `executing` 狀態檔的行程才會 spawn 執行器。崩潰可能發生在 spawn 前或 spawn 後（執行器成為孤兒仍在跑），兩者無法分辨，都是 `unknown`，不自動重試。
- executed、failed、rejected、expired、tampered、denied 為終態；`approve` 對非 `pending` 一律拒絕。
- *配額*：`pending`、`executing`、`unknown` 都計入 `max_pending`（`unknown` 不會過期，須由使用者 `resolve` 才釋放）。
- `failed` 不重試。限制（寫進文件）：`resolve failed` 之後若 agent 重新提出，可能重複已部分完成的外部動作，是否安全由執行器負責（例如以 `APPROVAL_ID` 當冪等鍵）。
- 過期與 `unknown` 為懶惰評估（沒有常駐程序）：*只有* `list --all`、`approve` 與收走（對該（專案或 call、角色）的 `pending`、`executing`）會寫入 `expired` 或 `unknown`，以上述獨佔建立寫入，與並行 `approve` 競爭時只有一方成功。*`show`、`audit` 與預設的 `list` 嚴格唯讀*：對已逾期或建立者已死的請求，只顯示計算出的狀態（例如「已逾期（尚未記錄）」「處理中，建立者已死（尚未記錄）」），不寫檔。
- `call` 沒有專案，`approve` 與狀態轉換都只靠 `approvals/` 內的檔案，不需要 `call` 的 per-agent lease。

### 4.6 核可畫面

*顯示就是內容*：因為 4.3 已拒收看不見或會改變顯示的位元組，框架*不改寫* payload，只在每行前加 `│ ` 前綴（讓 payload 內偽造的框線不會從行首開始）。畫面分三區：

1. `[agent 自述，未經驗證]`：`summary`。
2. `[執行器]`：執行器名稱、`command[0]` 的真實路徑與 sha256。（第一版無 `describe` 預覽。）
3. `[payload，完整內容]`：以分頁顯示，*以字元邊界每頁至多 4096 位元組切段*（單行過長時在字元邊界換行顯示，不改變內容）。

*完整瀏覽才能核可，且看到的就是被執行的*：`approve` 在同一個行程內讀入 `approvals/<id>/payload` 到記憶體 Buffer，驗證 hash 與記錄相符，分頁顯示該 Buffer，使用者翻到最後一頁並確認後，才建立 `executing` 狀態檔（含已瀏覽的位元組數與 sha256，必須等於 payload 大小與 hash）。建立成功後，*把這份已看過的 Buffer* 寫成 `approvals/<id>/work/payload`（0400），`APPROVAL_PAYLOAD_FILE` 指向它；執行器讀的是這份複本，不是核可前後可能被改動的其他檔案。`show` 不寫任何狀態。`max_payload_bytes` 是每個執行器的設定（預設 4096、上限 65536）；「完整瀏覽」是原則，上限值只是預設，不屬於原則本身。

另顯示：id、提出者（專案或 call、agent、run id）、時間、到期時間、payload sha256 前 16 碼（與 `approve` 時重算值並列），以及「相同 payload hash 的其他請求（id、狀態）」。

*消毒的範圍縮小*：payload、`summary`、檔名已在收走時以白名單拒收異常字元，所以顯示不再改寫它們；*只有執行器的 stdout/stderr 與錯誤訊息*（框架無法事先拒收的外部輸出）在顯示前剝除 ESC 序列、C0/C1 控制字元（保留換行）、`Cf` 類字元，並把 `\r` 轉成 `⏎`。`list`、`show`、`audit` 使用同一個函式。`list` 預設只列 `pending` 且未過期者。

### 4.7 執行器執行環境

- 沙盒外、使用者身分、工作目錄為 `approvals/<id>/work/`（新建空目錄），payload 檔為其中的 `payload`（見 4.6）。
- `command[0]` 必須是絕對路徑、一般檔、非 world-writable，所在目錄也非 world-writable；`doctor` 與每次執行前都檢查。稽核記錄該檔的 sha256。
- 環境變數*不繼承*，只傳 `PATH`（固定安全預設）、`HOME`、`LANG`、`env` 列出的項目、`APPROVAL_ID`、`APPROVAL_PAYLOAD_FILE`。（`open-pr.ts` 繼承完整環境，只是「dispatcher 在沙盒外執行外部程式」的先例，不是同類先例。）
- id 與 executor 名稱以 `assertName` 驗證。
- 以 `execFile`（無 shell）啟動；逾時殺整個行程群組（SIGTERM，5 秒後 SIGKILL）。stdout/stderr 各截斷在 64 KiB 後寫入狀態檔。

### 4.8 稽核

`approvals/<id>/`：`payload`、不可變的 `record.json`（提出者、來源鍵、時間、資格快照）、依序號的 `state/<n>.json`（狀態、動作者、已瀏覽位元組與 hash、執行器退出碼、截斷輸出、`command[0]` sha256）。狀態檔的序號與前一個 n 的引用就是稽核順序（第一版不做 hash 鏈：它不是預防手段，預防靠第 3 節；需要防竄改時列為後續）。

*保留與回收*（兩者皆由使用者手動執行，不自動刪；`pending`、`executing`、`unknown` 不會被 gc）：
- `approvals gc`：刪除超過 `retention_days` 的終態記錄（連同 `payload`、`state/`、`work/`），*但只有在該記錄的來源 `collected/<seq>` 已有 `.done`、或該目錄已不存在且 `seq` 不大於該 slot 的高水位（已被 `requests gc` 回收）、或其 run 已不存在（call 則為 `requests/calls/<call-id>` 不存在，*不是* `<home>/calls/`）時*才可刪，否則保留（避免 4.4-5 的復活問題）。刪除前先 `rename` 到 `approvals/.trash/` 再刪，崩潰不會留下半個記錄。另清掉長期未完成（無 `record.json`）的 id 目錄、狀態檔殘留的暫存檔，以及已無對應記錄的 `.feedback` 條目。
- `requests gc`：先把每個 slot 的 `collected.seq` 高水位對齊到「高水位與現存數字目錄名（含 `.done`）的最大值」，才刪除已 `.done` 且超過保留期的 `collected/<seq>`：*順序固定為先把目錄 `rename` 到 `<slot>/.trash/` 並刪除，最後才刪 `.done`*（反過來在中間崩潰，`resume` 會把沒有 `.done` 的目錄重新收走，而 `approvals gc` 可能已刪了終態記錄）；以及超過保留期的 `parked/`。*run 已不存在時*（不會再有 `resume`），其 `collected/` 下沒有 `.done` 的目錄視為已放棄，超過保留期後一併刪除；`call` 的未 `.done` 目錄超過保留期同樣視為放棄。最後*只在 run 已不存在時*才移除其請求目錄（run 仍在時保留 `collected.seq` 高水位檔，否則 `seq` 從 1 重來，相同檔名與內容會得到舊 id 而被靜默吞掉）。
- 兩個 gc 的先後不影響正確性：已處理的檔案不在 `proposals/`，`approvals gc` 不刪來源仍可重入的記錄，`requests gc` 不讓序號回頭，所以任意先後都不會讓已處理的請求復活。

### 4.9 agent 的回饋

dispatcher 在列入 agent *下次被喚醒*時，於 user prompt 末尾附「請求狀態」區塊。內容只有 dispatcher 的詞彙：id 前綴、檔名（已受 4.3 的檔名規則限制）、狀態、`denied` 的原因代碼；不含執行器輸出與 agent 自述。

- *範圍與送達記錄（與時間無關）*：以（專案, 角色）為單位。dispatcher 為每個請求記錄「已送達的最大狀態序號」（`approvals/.feedback/<project>/<role>.json`：`{ <id>: <n> }`，`n` 為呈現給 agent 時該請求的目前狀態序號，無狀態檔為 0）。選擇條件是「目前狀態序號大於已送達序號（從未送達者視為 -1）」，依（`updated_at`, id）由舊到新取至多 20 筆；`updated_at` 只用來*排序呈現*，不參與選擇，所以收走者暫停後才發布的請求、時鐘回撥都不會讓請求被永久漏掉。只在該 wake *成功*之後才寫回（失敗的 wake 不算已送達）；寫回時重讀檔案、逐 id 取最大值合併，再以暫存檔加 `rename` 原子寫入（並行 run 之間最壞是重送一次，不會漏）。超過 20 筆的部分下次繼續呈現。`approvals gc` 清掉已無對應記錄的條目。
- 同一請求被重複提出時（相同 payload hash），回饋標示「與 <id>（狀態）相同」，讓 agent 不必盲目重送。
- *`call` 沒有回饋*：每次 `call` 都是新的 call-id、一次性執行，沒有「下次喚醒」；`call` 的使用者從 `approvals list` 取得結果。
- system prompt（`prompt.ts` 的 `writeScopeRules` 一帶）對列入的 agent 說明 `proposals/` 路徑、檔名規則與格式。
- *run 結束時*：輸出一行「待核可請求 N 個」（只在 `executors.yaml` 存在時）。人類可讀的 `status` 同樣顯示。*`status --json`（StatusReport）的格式不變*，不加待核可欄位（避免破壞既有消費者）；機器讀取請用 `approvals list --json`（自有版本號，見 4.10）。框架不主動通知；通知是框架外的責任。

限制（寫進文件）：agent 只有在有未讀郵件時才會被喚醒（`run-session.ts:654-655`），run 結束後核可的結果要等該角色下一次被喚醒才看得到。

### 4.10 CLI

`approvals list [--all]`、`show <id>`、`approve <id>`、`reject <id> [--reason]`、`resolve <id> executed|failed`（僅限 `unknown`）、`audit <id>`、`gc`、`collect --call <call-id>`；`requests gc`。`approvals list --json` 輸出自有版本號（`schema_version`）的格式，與 `status --json` 無關。web console 以白名單 `COMMANDS`（`web/src/commands.ts`，`web/src/server/api.ts` 約 82 行以 `Object.hasOwn` 查表）自動排除；驗收以靜態測試斷言 `COMMANDS` 不含 `approvals.*`。

## 5. 已知限制（要寫進文件）

- *沒有讀取隔離*：框架只限制寫入（`write-scope.md`）。agent 讀得到 `approvals/` 內容與使用者帳號可讀的任何檔案。請求 payload 不得放機密（這是對領域的守則，框架不檢查）；憑證請由執行器從可信來源取得，並自行確認 agent 讀不到。
- *關卡只管經由它的動作*：第 3 節 3、4 以建構時禁用處理已知的對外通道，但框架無法列舉所有通道，也不保證「agent 沒有其他途徑」。
- 框架擋不住 agent 在 `sandbox.write` 範圍內的破壞（如刪檔）。
- 第一版沒有執行器預覽：使用者看到的是原始 payload 與 agent 自述。
- 同時讀取不可信內容又提出請求的 agent，其 payload 可能被 injection 影響，這是角色設計問題（把兩者拆成不同 agent）。
- 列入 agent 的環境變數白名單（第 3 節 5）可能讓某些仰賴 shell 環境的工作流程失效，屬預期的取捨。
- 回饋有延遲（4.9），`call` 沒有回饋。
- 一個 run 若被放棄、未 `resume`，其已成功但尚未收走的請求要等 `resume` 才會被收走（與郵件的路由行為一致）；run 被 `clear` 之後則永遠不會被收走。
- 被 park 的請求不會成為重做草稿（4.4）；重做的 agent 需要重新提出。
- 對 attempt 已 `output_ready` 而 claim 被 `abandoned` 的視窗，請求被 park，但同一 attempt 的 outbox 郵件依既有行為不被 park（郵件仍路由）：兩者在這個視窗不一致，屬已知限制。
- 同一內容重新提出會得到不同的 `APPROVAL_ID`（新 `seq` 得新 id），所以「以 `APPROVAL_ID` 當冪等鍵」擋不住重複提出造成的重複執行；只能靠核可畫面的「與 <id> 相同」提示與使用者判斷，*執行器必須自行以業務鍵去重*（第 11 節）。
- dispatcher 在沙盒外執行的 repo 指令（`verify`、`open_pr`）見第 3 節前提 7：`verify` 與列入的 agent 不能並存；`open_pr` 是 lead 在 `done` 郵件帶的欄位，只警告（`doctor` 一次、實際 `done` 時一次）。
- 「顯示完整內容」不等於「內容安全」：使用者仍要自己判斷（1.1）。
- `can_edit_agent_md` 的 agent 能改寫自己或其他 agent 的 `AGENT.md`（`policy.ts` 約 199–202 行）：不繞過關卡，但可作為 injection 的持久化路徑；列入的 agent 不應同時擁有此權限（建議 `doctor` 警告）。
- 持久性只保證行程崩潰（process crash）；`fsync` 不保證斷電或作業系統當機後的一致。配額（`max_pending`、`max_total_pending`）是軟限制。

## 6. 對既有行為的影響

預設不啟用：沒有 `executors.yaml`，不建立 `requests/` 與 `approvals/`、不收請求、不改任何輸出。

1. *設定相容*：不改 `team.yaml`、`project.yaml`、`GlobalConfig`、`AgentPartial`；舊版忽略新增的檔與目錄。
2. *寫入範圍（條件式）*：只對列入的 agent，`writePolicy` 多加 `proposals/`（canonical 路徑）；每個 wake 前新增「確保 `proposals/` 存在且為空」。其他 agent 的 `writePolicy`、`enforcementFor`、`protectedPathsFor`、`doctor` 輸出須與升級前相等。
3. *呼叫參數（條件式）*：只對列入的 Claude agent 加 `--strict-mcp-config`、空 MCP 設定與 `--setting-sources user`（以及 `--settings` 內的 `sandbox.failIfUnavailable: true`）；其他 agent 的 CLI 參數逐字相同。
4. *環境變數（條件式）*：只對列入的 agent 改為白名單；其他 agent 的環境逐字相同。
5. *prompt（條件式）*：只對列入的 agent，system prompt 多一段規則、user prompt 多一個狀態區塊；`buildCallUserPrompt` 簽名需加 project 資訊。其他 agent 的 prompt 逐字相同。
6. *失敗與恢復路徑（條件式）*：新增 `rotate` 與 park 新函式，`recoverRunMail` 新增第二個鉤子 `proposalsOf`，涵蓋 attempt 已 `output_ready` 而 claim 被 `abandoned` 的視窗；既有 `parkOutbox` 與 `outboxOf` 的行為不變。
7. *`settle()`*：在 `routeOutboxes` 之後多一個收走步驟，沒有列入的 slot 時為空操作；收走例外不得阻擋 `commitClaim`。
8. *`call.ts`*：每個候選前確保空目錄、失敗候選輪替到 `parked/`、成功時寫 `ok.json` 並收走；沒有列入的 agent 時為空操作。
9. *新增載入與檢查*：載入 `executors.yaml`、第 3 節新增的 containment 與 `doctor` 檢查、`ResolvedAgent` 與 `WakeInput` 的「列入」欄位，皆只在 `executors.yaml` 存在時作用。
10. *不動 run state*，不碰 outbox 與郵件路由。
11. *輸出*：`doctor`、`status`（人類可讀）、run 結束輸出只在 `executors.yaml` 存在時多顯示；`status --json`（StatusReport）永遠不變。
12. 「相等」的比對沿用 `test/instances-compat.test.ts` 已有的做法（基準位元組 fixture，約 18–26、59–68 行）：fixture 以功能前的修訂 `f4936b0`（尚無任何本功能程式碼）生成並提交（現有 `test/fixtures/instances` 是另一個功能的基準，不沿用，需新生成），新程式在沒有 `executors.yaml` 時須逐位元組相同。
13. 既有測試不修改即通過。
14. 舊版執行已有這些目錄的 home：已查到 `listProjects` 只讀 `projects/`、`status.ts` 只讀特定子目錄、`clear` 的刪除限制在 `project.paths.root` 內（`run-cleanup.ts`），沒有列舉未知頂層目錄之處；仍以測試證實。

## 7. 設計取捨記錄

- 請求位置曾考慮放 task memory：`call` 沒有 task memory，且每 run 一份、會被清除，捨棄。
- 曾設計「靜止點收走」、`quarantine`、每次嘗試一個請求目錄加 `.ok`／`.collected` 標記：這些是在重造既有 outbox 的 park、claim 與 journal。改為貼合它們：固定的 `proposals/`、收走放在 `settle()` 並與 `routeOutboxes` 並排，crash 與 `resume` 由既有機制涵蓋。
- 曾比較三種處理已收走檔案的做法：(a) 照抄 outbox「逐檔搬進 `sent/`」（dispatcher 寫入 agent 可寫目錄，且逐檔 `rename` 會穿過 symlink）；(b) 維持唯讀加索引去重（`proposals/` 永不清空，重做時看到舊檔、掃描上限被舊檔佔滿、gc 後可能復活）；(c) 整個目錄 `rename` 輪替（採用）：在 dispatcher 擁有的父目錄操作、不穿越 symlink、每個 wake 從空目錄開始。
- 曾以「顯示前消毒」處理異常字元：使用者看到的與執行器收到的不同，改為收走時白名單拒收。
- 曾以鎖（mkdir 或 link 取得、接管死鎖）序列化狀態轉換：現有程式沒有原子的接管實作，會雙持鎖。改為序號狀態檔加 `linkSync` 獨佔建立，沒有鎖也沒有接管。
- `lockHolderAlive` 在 `pid_started` 缺值時 fail-open，不適用於 `executing`；改用嚴格版並匯出 `pidStart()`。
- 執行器讀取的 payload 曾直接指向 `approvals/<id>/payload`：核可到執行之間可被改動。改為寫出使用者看過的那份 Buffer 到 `work/payload`。
- `describe` 預覽延後：它對不可信 payload 在沙盒外跑使用者程式，新增攻擊面。
- 曾把 `max_payload_bytes` 設為全域 4 KiB：那是框架的限制變成領域的限制。改為每個執行器可設，並以分頁完整瀏覽維持「核可等於看過」。
- 曾列「偵測 `AGENT_LYCEUM_AGENT` 環境變數」當輔助防線：agent 可 `unset`，無實質價值，刪除。
- 請求 id 曾為隨機值加 `.src` 標記檔去重：標記檔與 `record.json` 之間有崩潰窗口，且 `approvals gc` 刪掉終態記錄與標記後，`resume` 重新處理未完成的 `collected/` 目錄，會把已執行的請求復活成新的 `pending`；`record.json` 以 `rename` 寫入也會被並行收走者覆寫。改為 id = 來源鍵雜湊（去重即 `mkdir` EEXIST）、`payload` 與 `record.json` 以 `link` 獨佔寫入，並限制 `approvals gc` 只能刪來源已 `.done` 或 run 已不存在的記錄。
- 回饋曾用時間戳水位：收走者取 `created_at` 後暫停、較晚的請求先送達並推進水位，前者發布後被永久漏掉；時鐘回撥同理。改為逐請求記錄已送達的最大狀態序號，與時間無關。
- `show` 曾「順手寫 `expired`」，與嚴格唯讀矛盾。改為只有 `list --all`、`approve`、收走會寫入，`show` 只顯示計算狀態。
- `denied` 曾需要 `state/1.json`：改為 `record.json` 內不可變的 `disposition`，少一個崩潰窗口。

## 8. 實作前待驗證

*第 0 步（失敗即不上線）*：

0. 真機沙盒驗證：(a) OS 沙盒下，agent 的子行程（含 pty）啟動 `agent-lyceum approvals approve` 寫不進 home、無法核可；(b) 預設網路確實被擋（含迴圈 TCP、unix socket，以及 macOS 的 `open`、`osascript`、`launchctl`）；(c) agent 對自己的 `proposals/` 做 `rename`、`rmdir`、換成 symlink 的結果，並確認 dispatcher 對「已被換成 symlink 的 `proposals/`」做目錄 `rename`，搬的是連結本身、不會動到目錄外的檔案（macOS APFS 與 Linux 各驗）；(d) 兩個 runtime 對 symlink 的處理（`policy.ts` 註明未驗證）；(e) `rename` 到沙盒允許目錄內、並行同名 `rename` 的實際行為；(f) 列入 agent 加 `--setting-sources user` 之後，repo 內 `.claude/settings.json` 與 `.claude/settings.local.json` *整體*不生效：以 `hooks`、`apiKeyHelper`、`statusLine`、`env`、`sandbox.excludedCommands`、`permissions.allow` 各放一個會寫標記檔的設定，確認都不執行（這些在沙盒外以使用者身分執行，生效就是完整繞過核可關卡的通道）；同時確認 `disableAllHooks`（`adapters/claude.ts` 約 49 行）仍擋住 user 層與外掛的 hooks；在 user 層放 `sandbox.excludedCommands` 與不帶路徑的 `Edit` allow，確認不生效或已被 `doctor` 擋下；驗證 `--setting-sources ""` 是否仍可登入；確認專案 `.claude/agents`、`skills`、`commands`、`output-styles` 的 frontmatter（`hooks`、`mcpServers`）在新旗標下是否仍載入，並記錄專案 `CLAUDE.md` 是否仍被讀（行為差異）；另驗證 `failIfUnavailable: true` 在沙盒後端不可用時確實拒絕啟動而不是無沙盒執行。(a)、(b) 或 (f) 失敗，整個功能不上線。

*其餘*：

1. *序號狀態檔、`payload` 與 `record.json` 的 `linkSync` 獨佔寫入、確定性 id 原型*：在 macOS 與 Linux 上驗證對已存在目標必定 EEXIST、並行建立同一個 n+1（或同一個 `record.json`）只有一個成功、暫存檔與目標需同目錄同檔案系統；驗證 `executing` 建立者崩潰後，其他行程能以嚴格存活判定寫入 `unknown`。這是新設計的組合，最先做原型。
2. Codex 是否有關閉 MCP 的旗標（目前假設沒有，列入者不可用 Codex）。（`disableAllHooks` 已升為第 0 步 (f)。）
3. 兩個 runtime 在白名單環境（`PATH`、`HOME`、`LANG`、`TERM`、`TMPDIR`）下是否仍能登入與運作（真機，列為人工發布證據）；不通過就不上線該 runtime，不用猜測補變數。
4. 收走步驟放在 `settle()` 的位置，與 `routeOutboxes`、`integrateMember`、`commitClaim` 的順序（4.4）；以故障注入（`fault(...)`，`message-store.ts` 既有）覆蓋輪替的每一步之後、`.done` 之前、`commitClaim` 之前的崩潰。
5. （程式碼面已答）把 home 下目錄加入 `allowDirs` 不被 `overlapsForeign`、`sandboxPathConflicts`、`instance-containment`、`deny`、`sandboxCaps` 拒絕；需新做的是每個 wake 前確保空 `proposals/`、canonical 化。
6. 最後做第 6 節的逐字比對測試（`doctor`、prompt、CLI 參數、環境變數）。
7. 舊版忽略 home 下未知目錄與 `executors.yaml`（見 6.14）。

## 9. 驗收條件

- 沒有 `executors.yaml` 時：行為與升級前相同（6.2、6.3、6.4、6.5、6.6、6.7、6.8、6.9、6.11 的比對測試，加既有測試全數通過）。
- 前提：第 3 節各項各有測試（無 OS 沙盒、containment 失敗含 `dir: ~`、請求目錄例外只涵蓋該 agent 自己的 `proposals/`、`unix_sockets`／`network`／`local_binding`／`allow_web`、MCP、`--setting-sources`、`failIfUnavailable`、`command` 多元素與危險旗標、`fallback` 含 Codex 時 `doctor` 擋下、環境白名單、`max_instances=1`、Windows），`doctor` 報告並拒收；`approve` 前重驗與資格快照比對有獨立測試（核可前改動專案設定，`approve` 拒絕並維持 `pending`；專案被移除，`approve` 拒絕）。
- `open_pr`：`doctor` 對任何列入的專案警告；run 中 `done` 帶 `open_pr` 時再警告一次，不阻擋。
- 「列入」逐組判定：同名但未列入專案的 agent，`writePolicy`、CLI 參數、環境、prompt 與升級前逐字相同。
- 輪替：每個 wake 開始時 `proposals/` 為空；`proposals/` 被換成 symlink 或非目錄時，輪替只暫停該 slot、不影響其他 slot，且不會動到目錄外的檔案；崩潰於輪替各步（`rename` 後 `mkdir` 前、`mkdir` 後處理前、處理中、處理後 `.done` 前）重入後不遺失、不重複；`seq` = max(高水位, 現存目錄名) 加一並以數字排序，`rename` 後、更新高水位前崩潰不重用序號；高水位檔損毀時該 slot fail-closed。
- 失敗與恢復：失敗或被取消的嘗試其 `proposals/` 被輪替到 `parked/` 且永不收走；同一 claim 第 1 次失敗、第 2 次成功時只收第 2 次的輸出；crash 後 `resume` 由 `settle([], [])` 補收；attempt 已 `output_ready`、claim 為 `claimed` 時崩潰（輸出已完成但 claim 尚未提交的視窗），該 wake 被重做，其舊輸出被 park，不會出現重複請求；wake 成功後郵件被退回，已收走的請求仍存在；收走丟例外時 `commitClaim` 不受阻。
- wake 前殘留：成功 wake 後收走失敗（前提暫時不成立、`rotate` 丟例外），下次 wake 前 `proposals/` 的輸出被收走而不是 park；失敗、中斷、`abandoned` 的輸出才 park；無法判定時不喚醒該 slot；情況 (b) 的 park 先於 `abandoned`，且 `resume` 多次不重複 park。
- 快照：原 run 被 `clear`（worktree 與 outbox 消失）後，同一專案設定下 `resolveOrigin` 的靜態快照仍相符；改動 `sandbox.write` 則不符。
- `call`：fallback 鏈中失敗候選的輸出被 park 且不收走；僅成功的候選有 `ok.json`；`approvals collect --call` 冪等，且對失敗的 call 不收走任何東西。
- follow-up 重開已完成的 run：run-id 與 `proposals/` 沿用、`seq` 接續，不會把舊請求復活成 `pending`。*復活路徑測試*：收走時 `record.json` 已提交但 `.done` 未寫就崩潰 → 使用者核可並執行 → 過保留期後 `approvals gc` → `resume`，不得出現新的 `pending`（`approvals gc` 因來源未 `.done` 而保留該記錄）；`requests gc` 與 `approvals gc` 任意先後都不造成已處理檔案被重新收走；run 已不存在時，gc 才可刪除。
- 收走結局：4.4-6 表的每一列各有測試（含「忽略」不產生記錄、各原因代碼、`scan_limit` 只產生一筆聚合記錄、`denied` 的 100 筆上限與計數）。禁止字元各類（ESC、`\r`、`Cf`、`Zs`/`Zl`/`Zp`、Hangul 填充、U+2800、非 UTF-8）皆被拒。
- 確定性與重入不覆寫：同一來源鍵一定得到同一個 id；兩個並行收走者寫同一個 `record.json`，只有一個 `link` 成功、內容一致；`record.json` 提交後崩潰、使用者核可並執行之後再重入，狀態不被改回 `pending`（兩個崩潰點各一個測試）；`payload` 重入時位元組比對，不符則 fail-closed 且不覆寫。
- gc 順序：`requests gc` 先刪目錄、最後才刪 `.done`，在兩者之間崩潰後 `resume` 不會復活請求；`approvals gc` 在來源目錄已被回收（不存在且 `seq` 不大於高水位）時可刪記錄。
- 完整瀏覽與執行同一份：未翻到最後一頁不可 `approve`；已瀏覽位元組數與 hash 不符時不可核可；payload 剛好等於該執行器上限時可完整瀏覽；單行超過 4096 位元組時分頁仍完整；上限因執行器而異；執行器讀到的 `work/payload` 內容等於使用者瀏覽的那份（核可後改動 `approvals/<id>/payload` 不影響執行）。
- 綁定：收走後修改 `collected/` 內原檔，不影響已收走的 payload；修改 `approvals/<id>/payload` 後 `approve` 得 `tampered`（兩個獨立測試）。
- 狀態機：依 4.5 轉換表逐列測試，另加：無狀態檔即 `pending`（`denied` 由 `record.json` 的 `disposition` 決定，沒有狀態檔）；`show`、`audit`、預設 `list` 嚴格唯讀（逾期與建立者已死只顯示計算狀態），`expired` 與 `unknown` 只由 `list --all`、`approve`、收走寫入；並行 `approve`（第二者得「已被處理」、只有一個 `executing`）；`approve` 與過期競態只有一方成功；`approve` 在建立 `executing` 之前崩潰仍為 `pending`；時鐘回撥（拒絕核可但維持 `pending`）；`executing` 時行程被殺或 Ctrl-C（`unknown`、不自動重試）；`pid_started` 無法驗證時在寬限期內為「處理中」、之後為 `unknown`；取不到本行程 `pid_started` 時拒絕 `approve`；spawn 失敗為 `failed`；`failed` 不重試；`resolve` 只接受 `unknown`；`unknown` 計入配額；兩個指令同時為死掉的 `executing` 寫入 `unknown` 只有一個成功；最大 n 的狀態檔損毀時 fail-closed；`executed` 寫不進去時最終落到 `unknown`。
- 執行：至多一次；環境只含 4.7 所列；逾時殺整個行程群組；stdout/stderr 在 64 KiB 截斷；`command[0]` 為 world-writable 時拒絕執行。
- 顯示：執行器輸出含 ESC、`\r`、`Cf` 字元與偽造框線時，在 `list`、`show`、`audit` 皆無控制字元；payload 顯示逐字等於內容，每行有前綴；`show` 不寫任何狀態。
- 配額：`max_pending` 以（專案或 call、角色基底名、執行器）計數，含 `pending`、`executing`、`unknown`；`expires_days` 與 `retention_days` 生效。
- 回饋：選擇條件是「目前狀態序號大於已送達序號」、至多 20 筆，與時間無關；超過 20 筆時下次繼續呈現；失敗的 wake 不更新送達記錄；*延遲發布*（收走者 A 取 `created_at` 後暫停、B 的請求先送達，A 之後才發布）與*時鐘回撥*的請求仍會被送達；並行寫回以逐 id 取最大值合併；`denied` 有原因代碼；重複提出會標示相同請求；不含執行器輸出與 agent 自述；`call` 不提供回饋。
- run 結束與人類可讀的 `status` 顯示待核可數（僅在 `executors.yaml` 存在時）；`status --json` 的輸出在有無 `executors.yaml` 時逐字相同；`approvals list --json` 帶 `schema_version`。
- 核可者身分：非 TTY、id 前綴輸入錯誤，`approve` 拒絕。
- origin：原 run 被 `clear` 後仍可 `approve`；專案設定被移除或 canonical 路徑與 `origin` 不符時，`approve` 拒絕並印出可執行的說明，請求維持 `pending`。
- web console：`COMMANDS` 不含 `approvals.*`。
- 真實沙盒下惡意 agent 寫不進 `approvals/` 與別人的 `proposals/`：以*手動或標記的整合測試*進行，*不在 CI 內*，與 `write-scope.md` 對同類主張標為 unverified 的作法一致。

## 10. 實作順序與共用介面

*第 0 步實驗是人在真機上做的「發布關卡」*（agent 團隊的沙盒做不了）：它決定能不能*發布*，不決定能不能*實作*。階段 2–6 可在「預設關閉（沒有 `executors.yaml` 就不作用）」之下實作並交付，PR 與 CHANGELOG 標示「非可發布：第 0 步未驗證」；(a)、(b) 或 (f) 失敗，整個功能不上線（已交付的程式碼維持預設關閉）；(c)、(d)、(e) 失敗只需調整輪替策略。第 0 步與 Claude 登入搭配環境白名單的相容性（3.5）結果，是第 11 節啟用條件的一部分。

*實作注意事項（審查已知，於任務內處理，不改設計）*：
- wake 前檢查要放在 `claimMessages` 之前，或拒絕喚醒時呼叫 `abandonClaim`；情況 (b) 的 park 條件寫死為「本次 recover 剛轉成 `abandoned`，且該 claim 有 `output_ready` 的 attempt」，否則先前已 `committed` 但收走失敗的請求會被誤 park。
- 「slot 最近一次 attempt」以 `AttemptRecord.n`（數字）與 `started_at` 判斷，不依檔名排序（`a10` 會排在 `a2` 之前）；現有 `listAttempts` 會靜默略過損毀 JSON，需嚴格版讀取，損毀即視為「無法判定」而不喚醒。
- `recoverRunMail` 的 `proposalsOf` 鉤子與 wake 前檢查都以 slot 為單位 try/catch，單一 slot 的目錄異常不得讓 `resume` 或整批 `Promise.all` 失敗。
- `rotate` 一律先判斷 `proposals/` 非空才動作（park 也一樣），讓「`rename` 之後、`finishAttempt` 之前」崩潰的重入冪等，不會對已存在的 `parked/<attempt-id>` 得到 `ENOTEMPTY`。
- 處理 `collected/<seq>` 之前先 `lstat` 確認它是真目錄（輪替的 `lstat` 與 `rename` 之間有 TOCTOU 空窗，被換成 symlink 時搬走的是連結本身，`readdir` 不得穿過它）。
- `doctor` 的 containment 要跨所有專案與 `call` 掃描（其他專案若設 `sandbox.write: <home>/requests`，要被偵測到；`write-scope.md` 已禁止 `sandbox.write` 放在 config home 內，可引用）。
- `linkSync` 在不支援硬連結的檔案系統會失敗：一律 fail-closed（該功能對該 home 不啟動並由 `doctor` 報錯），不退回 `rename`。
- 掃描 `collected/<seq>` 用 `opendirSync` 逐項計數，達 `max_scan_entries` 就停，不先 `readdir` 全讀；agent 可用 `utimes` 操縱 mtime 讓垃圾檔排前面，只是 DoS，由 `scan_limit` 聚合記錄與回饋涵蓋。
- 回饋與配額計數使用「計算狀態」：已逾期但尚未寫入 `expired` 的 `pending` 視為 `expired` 呈現與計數，不等有人觸發寫入。*例外*：回饋以「狀態序號」選取，計算出的 `expired` 沒有新序號，所以 agent 要等 `list --all`、`approve` 或收走把它寫成狀態檔後才收到逾期通知；接受此延遲並寫進文件。
- `--setting-sources` 最終取 `user` 或空來源，由第 0 步 (f) 決定；決定後 §3 前提 4、§6.3、§9 一併改。
- 各種「不喚醒」的路徑要逐一寫明：前提不成立走既有 `refused` 機制（本 run 內持續，下次 `run`／`resume` 重驗）；目錄異常或殘留輸出無法判定則在 `claimMessages` 之前略過該 slot（否則 `wake()` 回傳失敗會讓整個 run 以 `agent_failed` 結束，或空轉到 `max_rounds`）。第 87 行的「下次 wake 自動恢復」指後者。
- 內容白名單的控制字元一律以 Unicode `Cc` 類表述（含 DEL）；`Default_Ignorable_Code_Point` 整類拒收會連帶拒絕 emoji 的 VS16（U+FE0F），與 ZWJ 一併列為已知限制。
- 第 0 步 (f) 另驗：user 層啟用的外掛（`enabledPlugins`）所帶的 MCP 伺服器是否被 `--strict-mcp-config` 擋住，外掛帶的 agents／skills 的 hooks 是否被 `disableAllHooks` 涵蓋；user 層 `sandbox.network` 與 `WebFetch` allow 是否生效。
- 行號以實作時重新定位為準（`parkOutbox` 約 336、`buildClaudeInvocation` 約 54–103、「有未讀才喚醒」約 647）。

建議任務順序：

1. *共用 `approval-store`*：`record.json`（含 `origin`、`disposition`）與 `state/<n>.json` 的型別與路徑、確定性 id 函式與來源鍵編碼、`link` 獨佔寫入與序號狀態機、`resolveOrigin` 的簽名與錯誤碼、嚴格存活判定（匯出 `pidStart()`）、`approvals list --json` 輸出格式、`ResolvedAgent` 的「列入」欄位、`rotate`／park／`proposalsOf` 的函式簽名。*第一個任務定稿這些跨任務共用的 schema 與簽名*（另含 `executors.yaml` 的 loader 與 schema、資格快照的計算函式，任務 2 與任務 3 都依賴），並做 macOS／Linux 的 `linkSync` 原型（8.1）。
2. 第 3 節前提檢查（`doctor`，含前提 7）、環境白名單、`--strict-mcp-config`、列入 agent 的 wake 前重驗。
3. 目錄輪替、`settle()` 收走、park 新函式、`recoverRunMail` 第二個鉤子，以 `fault()` 逐點注入崩潰測試。
4. `call` 的 `ok.json`、輪替與 `approvals collect --call`。
5. `approvals` CLI、核可畫面、執行器。
6. 回饋、`gc`，以及第 6 節的逐字比對測試。

## 11. 啟用條件（人要做的事）

框架保證的範圍見 1.1。下列事項框架做不到，*啟用前必須由人完成*，否則不應列入任何 agent：

1. *指定操作者與檢查間隔*：誰負責核可、多久看一次 `approvals list`（`pending` 預設 7 天過期；`unknown` 不會過期、會佔配額，須有人 `resolve`）。
2. *先用無害的 canary*：第一個執行器只做可逆、可觀察的動作（例如寫一行到本機檔），完整跑過提出、核可、拒絕、過期、崩潰後 `unknown`、`resolve` 之後，才接真實的對外動作。
3. *執行器自行以業務鍵去重*：不能只靠 `APPROVAL_ID`。同一內容重提會得到新 id（4.4-5）；`unknown` 或 `failed` 後人工 `resolve` 再重提，也可能重複已部分完成的外部動作。部分完成的處理屬執行器責任。
4. *回滾程序*：停用時依序：移除 `executors.yaml`（或清空 `allow`）、停止排程的 wake、確認沒有 `executing`、停掉執行器；已 `pending` 的請求不會自動作廢，需 `reject`。
5. *接受軟限制與保證範圍*：配額是軟限制（4.4）；持久性只保證行程崩潰，不保證斷電或作業系統當機；核可者看懂內容不等於內容正確（1.1）。
6. *核可後 `clear` 原 run*：不影響已收走的請求（3 的 origin 綁定）；但已 `executing` 的請求其執行器仍在跑，`clear` 前先確認沒有 `executing`。
7. *第 0 步與環境白名單相容性的真機結果存檔*（§10），存檔後才可發布。

## 12. 後續（不在本規格內）

`describe` 預覽、讀取隔離（denyRead）、多實例並行、web console 核可頁、稽核 hash 鏈、`failed` 的受控重試、自動回收、排程與通知與手機回覆（框架外腳本）、各領域的 agent 與執行器範例（屬框架之外）。

## 附錄：修訂摘要

- v2–v6：獨立 `executors.yaml`、OS 沙盒前提、no-follow 讀取、複本為唯一真相、白名單拒收異常字元（顯示即內容）、資格快照、`denied` 記錄與回饋水位、每個執行器的 payload 上限與完整瀏覽、環境變數白名單、1.1 責任對照。
- v7：收走機制貼合既有 outbox／claim／journal（固定 `proposals/`、`settle()` 內收走、crash 由 `settle([], [])` 補收）；狀態機改為序號狀態檔加 `linkSync`，取代鎖。
- v8（第 7 版審查：阻擋 1、重要 8、次要 5）：
  - 阻擋：收走後目錄永不清空 → 改為整個目錄 `rename` 輪替（`collected/<seq>`、`parked/<attempt-id>`、`.done`），每個 wake 從空目錄開始。同時解決 park 逐檔搬移會穿過 symlink（I2）、重做看到舊檔、掃描上限被舊檔佔滿、gc 後復活。
  - I1：明寫 park 需要新函式與 `recoverRunMail` 第二個鉤子，被 park 的請求不成為重做草稿。I3：recover 時對「attempt 已 `output_ready`、claim 被 `abandoned`」的視窗也 park。I4：`call` 的 fallback 鏈每個候選輪替、`ok.json` 成功標記、`collect --call` 只收成功的 call。I5：目錄異常只暫停該 slot。
  - I6：執行器讀取使用者看過的那份 Buffer 的 `work/payload` 複本。I7：新增嚴格存活判定、匯出 `pidStart()`、寬限期後轉 `unknown`。I8：無狀態檔即 `pending`。
  - 次要：`linkSync` 細節（同目錄暫存檔、`fsync`、數字排序、損毀 fail-closed、磁碟滿）、收走例外不阻擋 `commitClaim`、重提相同內容以 `seq` 區分並標示重複、§6 與 §9 補齊、領域詞改為通用說法。
- v8 定稿（go/no-go 審查：GO WITH CONDITIONS，嚴重 1 項）：新增第 3 節前提 7（`verify` 與列入的 agent 不能並存，`open_pr` 警告）與前提 8（帶 `policy` 的 wake 仍套用旗標與環境白名單）；列入 agent 每次 wake 前重驗；輪替的 ENOENT 重建與「無法確保空目錄則不喚醒」；`collected.seq` 高水位；`ok.json` 先於 `result.md`；放行 U+3000；§5 補三項已知限制；新增 §10 實作順序與共用介面，並規定第 0 步由人在真機執行。
- v9（第 8 版審查：嚴重 3 組，其餘為規格內矛盾）：
  - 嚴重：(1) `approvals gc` 會讓已執行的請求復活成新的 `pending`（`record.json` 已提交、`.done` 未寫就崩潰，核可並執行後 gc，`resume` 重新處理）→ id 改為來源鍵的確定性雜湊、刪除 `.src` 機制、`payload` 與 `record.json` 以 `link` 獨佔寫入、`denied` 改為 `record.json` 的 `disposition`、`approvals gc` 只刪來源已 `.done` 或 run 已不存在者、gc 先 `rename` 到 `.trash/`。(2) 回饋的時間戳水位會永久漏掉延遲發布的請求與時鐘回撥 → 改記每個請求已送達的最大狀態序號，與時間無關。(3) `seq` 在 `rename` 後、更新高水位前崩潰會重用 → `seq` = max(高水位, 現存目錄名) 加一，高水位損毀則該 slot fail-closed，`requests gc` 先對齊高水位。
  - 矛盾修正：`show` 嚴格唯讀（`expired`、`unknown` 只由 `list --all`、`approve`、收走寫入）；§10 釐清第 0 步是發布關卡、階段 2–6 可預設關閉下交付；前提 7 的 `open_pr` 是 lead 的 `done` 郵件欄位，改為 `doctor` 與 `done` 時各警告一次；§6 改為沿用 `test/instances-compat.test.ts` 的基準位元組 fixture（以 `f4936b0` 生成）。
  - 新增：`record.json` 的 `origin` 與 `resolveOrigin`（原 run 被 `clear` 後仍可核可）；環境白名單先採 PATH、HOME、LANG、TERM、TMPDIR，登入相容性為人工發布證據；配額與持久性的軟限制寫明；`status --json` 不變、`approvals list --json` 自有版本；第 11 節啟用條件。
- v10（第 9 版審查：嚴重 2 項，I1–I10 一併吸收）：
  - 嚴重：(S1) wake 前「`proposals/` 非空就 park」會把成功 wake、收走失敗的請求無聲丟掉 → 改為先判定歸屬：成功的輸出先收走，只有失敗、中斷、`abandoned` 的才 park，無法判定則不喚醒。(S2) 資格快照雜湊含每個 run 專屬的 `allowDirs`（outbox、`gitDir`、`proposals/`），與「`clear` 後仍可核可」矛盾 → 快照只雜湊靜態可寫範圍，完整集合放 `origin` 只供顯示。
  - 實作時處理已納入：`requests gc` 先刪目錄最後才刪 `.done`、`approvals gc` 條件納入「目錄已回收」；`recoverRunMail` 情況 (b) 的順序與範圍；`record.json` 欄位一致性的措辭；`denied` 計數為近似；`call` 的 `ok.json` 與 `result.md` 窗口；前提失敗時 run 層級行為；`readRegularFileCappedNoFollow` 的 `truncated` 與 `ino`；暫存檔 gc；環境白名單去掉 `AGENT_LYCEUM_AGENT`；`disableAllHooks` 升為第 0 步 (f)；`can_edit_agent_md` 警告。
- v11（第 10 版審查：嚴重 1 項）：(S1) 現況 Claude 呼叫沒有設定來源隔離，agent 可寫的 repo 內 `.claude/settings.json`／`settings.local.json` 會被合併，其 `apiKeyHelper`、`statusLine`、`env`、`sandbox.excludedCommands`、`permissions.allow` 在沙盒外執行 → 列入的 Claude agent 加 `--setting-sources user`（`--bare` 不讀 OAuth，不適用）、兩個檔案加進 `deny`、第 0 步 (f) 擴大為驗證整體設定不生效。實作時處理已納入：快照排除 task memory、wake 前檢查與 claim 的先後、attempt 的數字排序與嚴格讀取、slot 層級 try/catch、park 重入冪等、`collected/<seq>` 處理前 `lstat`、`refused` 機制措辭、`requests gc` 保留高水位、1.1 保證 3 標明 `open_pr` 例外、檔頭格式不符的 `bad_header`、文字瑕疵。
- v12（第 11 版審查：嚴重 3 項，皆在第 3 節前提）：(S1) 執行器 containment 只管 `command[0]`，可把 agent 可改寫的腳本放在參數裡 → 第一版 `command` 只能一個元素。(S2) Claude 預設在沙盒後端不可用時無沙盒執行 → 列入的 agent 加 `sandbox.failIfUnavailable: true`（已在本機 `claude 2.1.325` 二進位確認該設定存在）。(S3) `--setting-sources user` 仍合併 user 層的 `sandbox.excludedCommands`、不帶路徑的 `permissions.allow` 等 → 優先驗證空來源、否則 `doctor` 與每次 wake 前檢查、並逐項 `deny` 保護路徑，(f) 擴大驗證。實作時處理已納入：wake 前判定只看 claim 狀態、結局表新增「前提不成立」列、call 的 gc 條件定義、快照以 `writePolicy` 扣除 run 專屬項定義、`Default_Ignorable_Code_Point`、id 前綴確認僅防誤操作、§10 任務 1 補 loader 與快照函式、跨專案 containment 掃描、`linkSync` fail-closed、`opendir` 計數、回饋用計算狀態。
- v12 定稿（第 12 版審查：GO，無嚴重問題）：補 user 層 `sandbox.*`／`permissions.*` 白名單檢查、`instanceCap` 落點、`AGENT_LYCEUM_AGENT` 測試說明、各種不喚醒路徑、回饋對計算狀態的延遲、控制字元 `Cc` 表述、(f) 追加驗證項。
