# 分析報告：agent-lyceum 是否需要更強的 agent 間 context 共享

本報告只做分析與建議，不改程式。依據：

- 現況機制：`docs/analysis-agent-context-and-mail.md`。
- 17 個過去 run 的證據：code-explorer 的回覆 `d4a922cf`，存於 `task-memory/20261023T040459812Z-…/_shared/evidence-context-gaps.md`。下文的事件編號 a1、c1、e1、f1… 都沿用該檔。
- HEAD（`55ae335`；`src/` 與 `eb6201f` 相同，`git diff eb6201f HEAD -- src` 無差異）的 `src/`。

程式碼引用格式為 `路徑:行號`。每項陳述標示為 **觀察**（有檔案或指令輸出可查）、**推論**（未驗證，含因果歸因）或 **未知**。run 以 run id 的最後 6 碼表示；mail 路徑相對於 `~/agent-lyceum-config/projects/agent-lyceum/runs/<run>/`。

## 結論（先讀這段）

- **不需要做廣泛的共享功能。** 讓成員寫 `_shared`、引用自動展開、dispatcher 決策摘要、依角色選擇 prompt 內容，這幾種即使只做最小的有界版本（第 3 節），都沒有已觀察到的需求可以支撐成本。17 個 run 只找到 12 件事件。15 次 `request-changes` 中，可歸因於缺 context 的：**1 次有觀察支持**（0a2b9f，e1 + a2 造成的 docs 那一輪），**1 次是推論**（6e01a3，c2）。「A 的發現 B 看不到」那類事件，原因是程式碼還在平行撰寫（a2），不是缺共享通道。lead 轉述決策與理由每次都有效（觀察，`d4a922cf` 的反證段）。
- **主要損失在「同一個 agent 重新喚醒時遺失自己的進度」**：
  - c1 有觀察支持：失敗嘗試已寫好驗證結果，重做的回覆卻寫「None of these were run」。
  - c2 的因果是推論。
  - c3 只能算推論：同一類錯誤在兩次 wake 間沒有被沿用。兩封 mail 修的是不同 fixture。
  - 成員預設全新 session（`src/config.ts:236`）。失敗嘗試的 mail 被移開，重試只被告知「Its mail was discarded」（`src/run-session.ts:44-45,497-504`）。成員也很少寫 task memory：node-engineer 被喚醒過的 8 個 run 中，只有 1 個 run 留下 task memory（觀察，見第 1 節）。
- **最小可行方案（MVP）**有兩項：
  - **G：讓成員邊做邊把進度寫進 task memory**，並讓重試通知指向 task memory。只改提示文字。
  - **F：把失敗嘗試移開的 outbox 草稿帶進重做的 prompt**，標成「未驗證草稿」，總長有上限，讀取契約與復原規則見第 4 節。F 只承諾帶回 c1 這類「草稿已寫在 outbox」的資訊；它不消除測試不足，也不消除所有重工。
  - 兩者都不改權限模型，也不改任何檔案格式。成本：F 沒有草稿時，prompt 增加 0 byte。G 讓每次成員 wake 的 system prompt 固定增加約 175 B，重試時的 user prompt 再增加約 30 B（第 4 節）。
- 環境重複探索（f1）與 lead 轉述錯誤（e1–e5）用流程處理即可：環境作法寫成 lessons record；lead 在 task 中標明哪些內容沒對過程式碼。這兩項不必寫程式。
- 第 4 節列出何時要重新評估廣泛共享。

## 1. 現況夠用嗎：逐類證據

| 類別 | 證據（run／mail） | 判斷 |
| --- | --- | --- |
| a. A 的發現 B 看不到 | a1：0a2b9f `mail/inbox/tech-lead/read/20261021T165031233Z-qa-reviewer-c3fcc8fb.md`，qa 的 probe 只放在自己的 `$TMPDIR`，reviewer 從 attempt log 挖回來（觀察）。a2：3d9300／a1af25／0a2b9f／e469fc 的 docs-writer 回覆 `29caae66`、`f10664c0`、`672e6f7b`、`86bc0722`：「code is still being written in parallel」「not visible in my worktree」（觀察） | 部分成立，代價小。a1 只多花一次 review wake 內的時間，沒有多一輪（觀察）。a2 的根因是派工順序：文件和程式平行撰寫，docs-writer 本來就沒有定稿可以讀，加共享通道也解決不了（推論）。只有在 0a2b9f 造成多一輪，而且是和 e1 一起造成的（觀察）。architect → engineer 的鏈：**無證據**。 |
| b. reviewer 缺 writer 的理由 | — | **無證據**。15 次 `request-changes` 全查過；lead 轉述「do not reopen」的 4 封 mail，reviewer 都遵守（觀察，`d4a922cf` 類別 b）。 |
| c. resume／重試／follow-up 遺失中間結論 | c1：d041c8 `mail/attempts/mvhugdgk-node-engineer-299931-a1/outbox/rev1-reply.md`（被 interrupted 的嘗試已寫好 probe、targeted test 與 audit 結果），對照重做後的回覆 `mail/inbox/tech-lead/read/20261021T141641467Z-node-engineer-7c9cd858.md`：「None of these were run」（觀察；attempt JSON：`error: "interrupted"`、`parked: ["rev1-reply.md"]`）。c2：6e01a3 `…/20261016T022735482Z-node-engineer-71125d9c.md`：「I did not reread the refusal … assertions」，cli-reviewer `11de4034` M1 指的正是這些斷言（文字為觀察；「是重新喚醒造成」為推論）。c3：6e01a3 `ae69757f` 修 golden baselines 的 fixture，`15cec1cf` 修 bare-run test 的 fixture，兩者是同一類 schema 錯誤（文字為觀察；「同一結論沒被沿用」為推論，沒有前後 attempt 的直接證據） | **成立，是主要缺口，但有觀察支持的只有 c1。** follow-up（`_shared` 交接）路徑：**無證據**，因為沒有任何 run 有 `followups/`（觀察）。 |
| d. 備援模型切換 | — | **無證據**。沒有任何 `state.json` 有 `<agent>@<runtime>/<model>` session key，`log.jsonl` 也沒有 `fallback_from`（觀察，`d4a922cf` 類別 d）。 |
| e. lead 轉述內容不正確 | e1：0a2b9f lead `cf563b22` 把錯誤的保證傳給 docs-writer → docs-reviewer `5d6e7b96`「promises automatic separation that the code does not provide」（觀察，已核對檔案）。e2：0a2b9f `8e36c797`→`1ce1665b`→`1b5f37db`。e3：a1af25 `176f88af`。e4：3d9300 `589c5e33`。e5：d041c8 `c35baf30`→`2cb8c162`（皆為觀察） | 成立，但這不是共享不足：lead 已經把資訊傳過去，傳的內容本身是錯的。「lead 漏傳上游內容」：**無證據**（觀察，`d4a922cf` 類別 e）。 |
| f. 環境／過期 context | f1：13 個 run 的 61 封成員回覆中有 36 封重新探索 node_modules、EPERM、registry 的繞法，例如 d041c8 `7c9cd858`、`2cb8c162`，3c12c4 `a3ce89da`（觀察）。f2：跨 run 的 review 修正由使用者手動帶入（觀察，運作正常） | f1 成立。COMMON 或 records 過期而誤導 agent：**無證據**。 |
| 其他：COMMON.md 自身過期 | 本次 prompt 的 `COMMON.md` 仍把已完成的 task 寫成進行中。HEAD 已有成員同 thread 批次（`src/prompt.ts:244`）與格式退回（`src/format-rejections.ts`）（觀察） | 證明即使只有 lead 一人寫，共享檔仍會過期；目前**無證據**顯示造成傷害。 |

**重新喚醒的規模**（觀察，用 `python3 -I` 統計所有 `mail/attempts/*.json`；reviewer 獨立重算相同）：

- 共 18 次失敗嘗試：6 次 interrupted、6 次 timeout（5×1200 s、1×600 s）、6 次 runtime 錯誤。
- 只有 2 次在 metadata 的 `parked` 留下輸出：d041c8 node-engineer 的 `rev1-reply.md`、2d1b53 tech-lead 的 `done.md`。metadata 可能漏記（第 4 節 F-2），實際目錄未逐一核對（未知）。
- timeout 的嘗試幾乎都沒留下 mail，因為 mail 通常最後才寫（推論）。

**task memory 的使用率**（觀察，用 `find task-memory/<run>/<agent> -type f` 統計）：

- node-engineer 被喚醒過的 8 個 run 中，只有 0a2b9f 一個 run 有 task memory。c1 發生時也沒有（`d041c8` 的 node-engineer 目錄是空的）。
- 正例（不是對照實驗）：2d1b53 的 lead 有 task memory。它連續 3 次 timeout，第 4 次嘗試讀了筆記（「Previous attempt left notes. Let me read them.」，`mail/attempts/mvhnuubh-tech-lead-53ff72-a2/log/stdout.log`，觀察），120 s 就完成。耗時下降是否因為筆記：推論。

## 2. 共享的代價

**Prompt 長度。** 每次 wake 都會固定注入以下內容（觀察）：

| 內容 | 上限 | 依據 |
| --- | --- | --- |
| `COMMON.md` | 8 KB | `src/prompt.ts:16,253` |
| records | 每種（decisions／lessons）6 KB；放不下的另以一行標題附在預算外 | `src/records.ts:12,120-139`，`src/prompt.ts:20,263-269` |
| memory 索引 | 3 層各 4 KB | `src/prompt.ts:17,279-288` |
| `_shared` 交接索引 | 8 KB，只在重開後注入 | `src/prompt.ts:18,271-277` |

- 合計上限約 40 KB，再加上溢出的標題清單。以 3–4 bytes/token 粗估，約 10–13k token（推論，未實測）。
- 目前實際大小：`COMMON.md` 5,912 B，records 1,195 B + 1,741 B（觀察，`wc -c`）。本 run 的 system prompt 為 10.4–18.6 KB（觀察，`runs/<本 run>/agents/*/system-prompt.md`）。
- 有記錄 cache_read 的 28 次 wake，中位數為 343,591 token（觀察，`state.json` 的 `wakes[]`）。所以多加幾 KB 在 token 費用上不是主要代價。
- 真正的代價有兩個：一是注意力被稀釋；二是成員每次全新 session（`src/config.ts:236`），每次 wake 都要重付這段固定內容（17 個 run 共 141 次 wake）（推論）。
- 目前 mail 內文沒有長度上限，原樣進 prompt（`src/prompt.ts:293-306`）。任何新的注入功能都要自己定上限，不能沿用 mail 的做法；F 就是有上限的例子。

**過期。** 共享內容一旦寫入，就會在每次 wake 重複出現。即使只有 lead 一人維護，`COMMON.md` 也已經過期（第 1 節「其他」列，觀察）。寫的人越多，清理越沒人負責：`tidy` 只處理個人 memory 與 records，`_shared` 不在範圍內（`docs/how-it-works.md:43`）。

**錨定，削弱獨立審查。** 本語料中有價值的 review 都來自 reviewer 自己去讀程式碼：e1 是 reviewer 對照程式碼抓到的，c2 是 reviewer 重跑才抓到的（觀察）。如果把 writer 的理由或中間結論預先放進 reviewer 的 prompt，reviewer 可能往 writer 的結論靠（推論；語料中沒有錨定事件，因為目前沒有這種通道）。

**prompt 可見性 ≠ 機密性。** 寫入範圍不等於讀取隔離（專案 lesson `write-scope-is-not-read-isolation`）：

- Claude 的 deny 只針對 Edit，Read 是允許的（`src/adapters/claude.ts:11-20,29`）；sandbox 也只有 `denyWrite`（`src/adapters/claude.ts:48-49`）。Codex 只設定 writable roots（`src/adapters/codex.ts:7-11,62-78`）。
- 所以「不放進某人的 prompt」只能做到 **prompt 可見性**：減少注意力和錨定，但對方仍可自己讀檔。「讓某人讀不到」是 **機密性**，現有機制做不到。下文分開討論兩者。
- dispatcher 不在 sandbox 內。凡是由 dispatcher 依 mail 內容代讀檔案的設計，都要限制來源，否則寄件者可以讓 dispatcher 把任意檔案放進別人的 prompt（confused deputy，推論）。

**平行 wake。** worktree 模式下，所有待處理的成員會同時被喚醒（`src/run-session.ts:353-359`）。多人寫**同一個**共享檔才會衝突。guard 只比對交接索引一個檔，而且只要這批 wake 中有任何人有權寫就接受（`src/guard.ts:52-53,87-91`），分不出寫入者。分檔（每人一個目錄）可以避開這個衝突。

## 3. 候選方案（各取最小的有界版本比較）

「需改 policy」是指要改 `WritePolicy`／guard 的授權。「破壞安全保證」是指讓某人能寫原本不能寫的地方，或讓 dispatcher 讀進不受控的來源。目前沒有任何讀取機密性保證可以被破壞。

| 方案（最小版本） | 解決的事件 | 代價 | 需改 policy？破壞保證？ | 判斷 |
| --- | --- | --- | --- | --- |
| **A 現況**（lead 轉述 + mail） | b 類無事件；決策轉述有效（`d4a922cf` 反證段） | 0 | 否／否 | 保留。lead 是瓶頸與錯誤源（e1–e5），由 I 處理。 |
| **B 每人一個 `_shared/<agent>/`**，只有本人能寫，lead 維護索引，按需讀取，不自動注入 | 理論上可改善 a1、f1 | 每個成員多一個可寫目錄；`tidy` 要擴大範圍，否則沒人清理；平行寫入不衝突 | 需改：`src/policy.ts:125,130,135` 加成員自己的子目錄，guard 要能逐人授權（現在是逐批授權，`src/guard.ts:87`）／不破壞：只開放本人目錄 | **不建議。** 它和成員的 task memory 幾乎重疊：task memory 已經是每人一個、可寫、索引會進 prompt（`src/policy.ts:127`，`src/prompt.ts:279-288`），而且別人本來就讀得到。缺的只是「別人知道路徑」，在 mail 裡寫出路徑即可。何況成員連 task memory 都很少寫（第 1 節）。 |
| **C mail 加引用欄位**：只接受寄件者 worktree／outbox／task memory 內的檔案；route 時以 no-follow 有界讀取做 snapshot（每檔 4 KB、每封 8 KB）存在 run 內；收件者 prompt 只放 snapshot | a1（`$TMPDIR` 的 probe 會在 route 時保存下來） | mail metadata 多一個選用欄位（`src/mailbox.ts:19-29`）、snapshot 目錄、有界讀取器與測試；舊 binary 讀到含新欄位的 mail 時，應該會忽略引用（推論，未驗證 frontmatter 解析） | 否（dispatcher 寫 run 目錄）／來源受控就不破壞 | **不建議。** 只有 a1 受益，而且 a1 只多花一次 review wake 內的時間。在協定寫明「要交給別人的產出放 mail 內文或 task memory，不放 `$TMPDIR`」就能解決，不必改格式。 |
| **D 有界決策摘要**：dispatcher 從 lead 的 task mail 擷取標題與 Goal 首行，最新優先，上限 2 KB，只注入成員；從現有 mail 即時計算，不新增檔案 | 無已觀察事件：b 類無事件；c 類失敗嘗試的 mail 不會被投遞（`src/run-session.ts:497-499`），摘要不到 | 每次成員 wake 固定 ≤2 KB；擷取規則需要維護 | 否／否 | **不建議。** e1–e5 是 lead 轉述的內容本身錯誤，摘要會把錯誤用語擴散給所有成員；也會讓 reviewer 錨定。 |
| **E 依角色選擇 prompt 內容**（例如 reviewer 不注入交接索引或 writer 的草稿），不加 OS 讀取限制 | 無事件（b 類無證據，也沒有錨定事件） | `src/prompt.ts` 加角色判斷；角色要從名稱或新 config 欄位得知 | 否／否；只控制 prompt 可見性，不提供機密性，文件必須寫明 | **現在不需要。** 目前注入給 reviewer 的只有 lead 寫的交接索引和 mail，lead 已經在篩選；F 的草稿只給本人。等 B／C／D 之類的注入出現時再考慮。真正的讀取隔離需要新的 read deny（Codex 目前做不到），不在本次範圍。 |
| **F 失敗嘗試的 outbox 草稿帶進重做的 prompt** | c1（觀察）；2d1b53 lead 的 `done.md`（已有 task memory，效益小）。依 metadata 是 18 次失敗中的 2 次 | 只有重試或重做的 wake 會增加，上限 4 KB；沒有草稿時 0 | 否／否：只把 agent 自己寫過的檔案交還給它自己，不投遞 | **做**，規格見第 4 節。 |
| **G 成員 task memory 檢查點提示** | c1、c2（timeout 時通常沒有 mail，只能靠 memory；推論）；正例 2d1b53 | 每次成員 wake 的 system prompt 約 +175 B；重試時 user prompt 約 +30 B | 否／否：task memory 原本就在 `allowDirs`（`src/policy.ts:127`） | **做**；只靠 prompt，模型可能不照做。 |
| **H 環境作法寫成 lessons record**（流程） | f1 | lessons 預算 6 KB 內 | 否／否：records 只有 lead 可寫（`src/policy.ts:131`） | 做，不寫程式。先例：`sandbox-pipe-stub-for-cli-tests` 已是 lesson。 |
| **I lead 轉述時標示「未對過程式碼」**（流程） | e1–e5 | 0 | 否／否 | 做，由使用者決定改哪些 `AGENT.md`。正例：3c12c4 的 task 寫「Behavior, verified by me in the code」，docs 第一輪就通過（觀察）。 |

a2 另有一個流程解法：程式碼整合之後才派 docs，或者在 task 中明說「以 `src/` 為準、不以 task 文字為準」（推論，未驗證 docs-writer 的 worktree 能否讀到已整合的程式）。

## 4. 建議與 MVP 規格

**決定：不做廣泛共享（B／C／D／E）。做 G + F 這個最小版本；H、I 用流程處理。** 證據指向「同一個 agent 跨嘗試的連續性」，不是「agent 之間的可見性」。G 與 F 只用現有的寫入範圍，不需要新的檔案格式。

**G**（交給 node-engineer）：

- 在成員的 Memory 段（`src/prompt.ts:209-216`）加一句：「Before a long command and after each verified step, write what you did, its result and what is left into your task memory: a wake-up after an interruption starts from there.」（173 B）。lead 的文字不變。
- 在 `retryPrompt`（`src/run-session.ts:44-45`）加「Read your task memory first.」（29 B）。
- system prompt 在每次 wake 都會重建（`src/run-session.ts:378`），所以 G 的 173 B 是每次成員 wake 都要付的固定成本，不是 0。

**F 選取與復原**（不改 schema，只讀既有的 `mail/claims/*.json`、`mail/attempts/*.json` 與 attempt 目錄）：

1. **候選 attempt**：`status: failed`（任何 error：`cancelled`、`interrupted`、timeout、runtime 錯誤），attempt 的 `agent` 與它所屬 claim 的 `agent` 都等於正在喚醒的 agent，而且 claim 的 `message_ids` 與本次處理的 message id 有交集。同一 wake 內重試時就是同一個 claim 的前幾次 attempt。resume 後重做時，舊 claim 已是 `abandoned`，新 claim 的 id 不同，所以要靠 message id 對應：attempt 只有 `claim_id`（`src/message-store.ts:174-186`），必須再讀 claim（`src/message-store.ts:106-113,121-123`）。
2. **以實際目錄為準（reconciliation）**：草稿清單取自 `attempts/<id>/outbox/` 的實際內容，不取自 metadata 的 `parked`。原因是 park 的每次 rename 和 `finishAttempt` 不是同一個交易（`src/message-store.ts:230-241`，`src/run-session.ts:493-494,498-499`）。reviewer 的 probe 證實：park 後、`finishAttempt` 前崩潰，resume 會把 attempt 記成 `failed`、`parked: []`，草稿卻仍在目錄中（`src/message-store.ts:257-261`）。只搬了一半時，剩下的檔案會在 recovery 時才被搬進來，metadata 只記到後半。兩邊不一致時，以目錄為準，並記一筆 `draft_reconcile`（attempt id、目錄有但 metadata 沒記的檔名、metadata 有但目錄沒有的檔名）。
3. **metadata 損壞**：`listAttempts` 會略過讀不了的 JSON（`src/message-store.ts:200-212`）。這時從目錄名 `<claim id>-a<n>` 推回 claim id，只有 claim 檔存在且 `agent` 相符才採用，否則略過並記錄原因。agent 名稱可能含 `-`，所以不從 claim id 解析 agent。
4. **排序與去重**：attempt 依 `finished_at`（沒有時依 `started_at`，再沒有時依目錄名）由新到舊排列；同一 attempt 內依檔名排序。去重只針對「在讀取上限內完整讀完」的檔案：全文 sha256 相同時只保留最新的一份；被截斷的檔案一律不去重，也不為了計算 hash 多讀任何 byte（上述讀取上限適用於所有前處理）。最多 5 個檔案。
5. **三條失敗路徑**都要涵蓋，而且都只注入 prompt：
   - graceful Ctrl-C：`cancelled`，claim 被 abandon（`src/run-session.ts:491-495,515`）。
   - timeout 或 runtime 錯誤：同一 wake 內重試（`:440`）；重試用完時 run 停下（`:522`），之後 resume。
   - 程序被硬殺：attempt 停在 `started`，resume 時由 `recover` 補 park 與 `failed/interrupted`（`:843-848`）。
6. **找不到草稿**：prompt 與沒有 F 時逐字相同。如果有候選 attempt 但沒有任何可用草稿，記一筆 `draft_none`（attempt id 與各檔略過原因），讓「為什麼沒帶回來」查得到。

**F 安全讀取契約**（M1；現有 helper 都不夠用：`readRegularFileNoFollow` 只擋最後一層 symlink，而且整檔讀入，`src/fs-util.ts:61-66`；`readFileCapped` 有上限但會跟隨 symlink，`src/fs-util.ts:28-34`。node-engineer 要另寫一個有界、no-follow 的讀取函式）：

- **信任起點是 dispatcher 給的 run 目錄。** `mail`、`mail/attempts`、`attempts/<id>`、`attempts/<id>/outbox` 每一層都要 `lstat`，必須是真目錄，不能是 symlink。任一層不符就略過整個 attempt。
- **名稱不能跳出目錄。** attempt id 必須符合 `^[A-Za-z0-9._-]+$`，不能是 `.` 或 `..`。檔名只取自 `readdir`，不取自 metadata 的 `parked`；含 `/`、以 `.` 開頭、或不是 regular file（依 `lstat`）就略過。一個 outbox 最多掃描 64 個 entry。
- **每個檔案的讀法**：`O_RDONLY|O_NOFOLLOW|O_NONBLOCK` 開檔，`fstat` 必須是 regular file，最多只讀「剩餘預算 + 1」byte。讀到超過預算就截斷（切在 UTF-8 字元邊界），附上 `[truncated: <相對路徑>, <fstat size> B]`。含 NUL byte 的檔案視為非文字並略過。
- **4 KB 是整段的上限**：標題 `# Draft from your failed attempt (unverified, not delivered)`、每個檔案的路徑行（`mail/attempts/<id>/outbox/<name>`，含 attempt 序號與 error）、截斷標記，以及「另有 N 個檔案未顯示」那一行，全部計入。最後那一行的空間要先預留。
- **略過或讀取錯誤**都要寫進 `log.jsonl` 的 `draft_skip`，帶相對路徑與原因：`ancestor_symlink`、`symlink`、`not_regular`、`bad_name`、`binary`、`over_file_cap`、`metadata_unreadable`，或 `open_error:<code>`。實際注入時記 `draft_inject`（檔名、bytes、是否截斷）。
- **殘餘風險**：從 `lstat` 祖先目錄到開檔之間有 race（Node 沒有 `openat`）。後果最多是讀到一個 agent 本來就讀得到的檔案，長度仍受上限限制，所以接受。

**相容**：不改 `state.json`、mail、claim、attempt 或 config 的格式。`log.jsonl` 只新增事件，舊的讀者會忽略不認得的事件。舊 run 照常載入，新舊 binary 互不影響。

**qa 需涵蓋的測試**（全部用 fake runtime fixture 與暫時的 `AGENT_LYCEUM_HOME`）：

- 正常路徑：第一次嘗試先寫 outbox 再 timeout，第二次的 prompt 含草稿段並標示「unverified」；graceful 取消後 resume，重做的 prompt 含草稿段；硬殺（attempt 停在 `started`）後 resume，同樣含草稿段。
- 故障注入：沿用 `setFaultHook`（`src/message-store.ts:7-13`），在 `parkOutbox` 每次 rename 後、`finishAttempt` 前各加一個 fault 點。要測：搬完第一個檔就崩潰（兩個檔分散在兩處）、搬完最後一個檔才崩潰（`parked: []`，即 reviewer 的 probe）、`finishAttempt` 之前崩潰。三者 resume 後都要帶回全部草稿，並記錄 `draft_reconcile`。
- 讀取安全：leaf symlink、`attempts/<id>` 或 `outbox` 是 symlink、FIFO（讀取放在子程序中跑，外層設 10 s 硬期限，因為 Vitest 的 timeout 中斷不了同步阻塞）、64 MB 的 sparse regular file（斷言實際讀取量 ≤ 4 KB + 1）、attempt JSON 損壞、`id` 或 `parked` 含 `../`。
- 選取：別的 agent、或 message id 沒有交集的草稿不出現；兩個 attempt 的小檔內容相同時只出現一次，而且由新到舊排列；兩個超過預算、前綴相同但尾端不同的大檔都會出現（各自截斷），且實際讀取量仍 ≤ 4 KB + 1，不為 hash 額外讀檔；超過 5 個檔案或 4 KB 時有截斷與「未顯示」那一行。
- 不變性：沒有失敗時，`buildSystemPrompt` + `buildUserPrompt` 的輸出與「只套用 G」時逐字相同（快照）；草稿從不投遞（收件者 inbox 與 route journal 都沒有變化）。

**docs-writer**：在 `docs/how-it-works.md` 與 `.zh-TW.md` 的重試／resume 段落各補一句：重做的 wake 會看到上次的未驗證草稿（有上限，只給本人），以及 G 的提示。

**驗證指標**（基準取自本語料，口徑統一為「觀察 + 推論」）：

| 指標 | 量法 | 基準 | 目標 |
| --- | --- | --- | --- |
| 草稿遺失型重工 | 失敗嘗試留下草稿，成功的回覆卻寫「not run」 | 觀察 1 件（c1） | 0 件 |
| 疑似重新喚醒造成的 review 輪次 | 失敗嘗試之後，下一輪 review 打中該 agent 自承沒做的地方 | 推論 1 件（c2） | 只觀察趨勢；F 不保證消除 |
| 成員 task memory 使用率 | 被喚醒 ≥2 次的成員中，有 task memory 檔的比例（`find`） | node-engineer 8 個 run 中 1 個（觀察） | ≥50% |
| 重試的耗時 | 失敗之後下一次成功 wake 的 `duration_ms` | 2d1b53 有筆記時 120 s（單一正例） | 只觀察趨勢 |
| 可歸因於缺 context 的 request-changes | 人工分類 reviewer 的回覆 | 15 次中觀察 1 次、推論 1 次 | 不增加 |
| 每次 wake 的固定 prompt bytes | system + user prompt 的實際送入長度 | 現值 | 成員 +173 B（G）；F 沒有草稿時 +0 B（由快照測試保證） |
| 因環境而重新探索的成員回覆 | grep 回覆 | 61 封中 36 封（觀察） | 下降（H 生效時） |

**何時重新評估廣泛共享**（任一條件成立）：

1. 連續 10 個 run 內出現 ≥2 次 b 類（reviewer 重開決策或缺理由），或出現錨定事件。
2. follow-up（`_shared` 交接）路徑開始被使用，而且有 follow-up 遺失資訊的事件。
3. 備援切換實際發生，並遺失 context（d 類）。
4. a 類事件在 10 個 run 內造成 ≥2 次額外 review 輪次，而且根因不是派工順序。（屆時先考慮 B 或 C 的最小版本。）
5. lead 成為轉述瓶頸：lead 的 wake 經常達到批次上限 `LEAD_BATCH_LIMIT`（`src/prompt.ts:21`），或 lead 轉述錯誤（e 類）在 10 個 run 內 ≥3 次且 I 無效。

## 5. 維度檢查（Dimension coverage）

1. **相容與格式**：MVP 不改任何檔案格式，只讀既有的 claim、attempt 與 attempt 目錄；`log.jsonl` 只新增事件。舊 run 照常載入；舊 binary 讀新 run 沒有差異。C 需要新的 mail 欄位，這是它的成本之一。
2. **檔案與行程安全**：F 只把 agent 自己的草稿交還給它自己，不投遞。讀取契約見第 4 節：祖先目錄不可是 symlink、名稱驗證、no-follow／non-block、只讀預算 + 1 byte、檔案數上限。G 只靠 prompt。C、D 若要做，必須限制 dispatcher 的讀取來源。
3. **並發與復原**：選取以 agent + message id 為準，不會混到並行的其他成員。park 與 `finishAttempt` 之間崩潰的情況，以實際目錄為準來處理。graceful Ctrl-C、timeout、硬殺三條路徑分開測試。
4. **平台與可維運**：macOS／Linux 行為相同（`O_NOFOLLOW`、`O_NONBLOCK` 兩者都有）。Claude 與 Codex 的差別只在 prompt 內容，F 和 G 不依賴 runtime 的 session 能力。不需要新依賴。
5. **可測試與可維護**：F 是一個純函式（選取 + reconciliation）加一個有界讀取函式，再加兩處呼叫點；可以用 fake runtime 與 `setFaultHook` 測，不需要真的 `claude`／`codex`。G 只改文字。
6. **可觀測與可診斷**：現有的 `note`（`src/run-session.ts:501-504,844-848`）已記錄 parked 路徑。F 新增 `draft_inject`、`draft_skip`、`draft_reconcile`、`draft_none` 四種事件，都帶路徑與原因，「重工事件」指標可以直接統計。
7. **證據強度**（本題額外加的維度）：語料只有 17 個 run（約 10 個有真正的團隊協作），都來自本專案，多數在會擋 spawn 測試的 sandbox 裡跑，所以 f1 的比例偏高。直接支持 F 的只有 c1 一件觀察；數字只能當方向參考，不具統計意義（`d4a922cf` 的 Risks 段）。

## 6. 未知與限制

- 3d9300、2d1b53 timeout 的嘗試 stdout 都是 0 byte，無法得知它們做了什麼（未知）。
- 18 次失敗嘗試的實際 attempt 目錄沒有逐一和 metadata 核對；metadata 漏記的草稿可能不只 2 個（未知）。
- 被 interrupted 的嘗試，`duration_ms` 包含等待使用者 resume 的時間（例如 c1 從 08:22Z 到 13:56Z），所以失敗嘗試的總耗時不能直接當成浪費的工時（觀察）。
- 在 docs-writer 的 worktree 內能否讀到 lead 已整合的程式碼，未驗證（未知）。
- token 換算（bytes→token）是粗估（推論）。
