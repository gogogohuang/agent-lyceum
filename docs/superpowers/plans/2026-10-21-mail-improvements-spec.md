# 信件改善計畫（無程式碼版）

> 本計畫只描述要達成的行為、介面與驗收條件，不含程式碼。實作細節由執行的 agent 對照現有程式碼自行決定。

**目標：** 讓 agent 之間的信件少流失資訊：成員能一次處理同一 thread 的回信；漏掉必要 `##` 標題的信先被退回，而不只是加警告；並更新文件。

**做法概要：** 兩個小而獨立的改動，各自一個 commit，再加一個文件 commit。

## 全域限制

- Node 20+；ESM 的 import 路徑結尾用 `.js`。
- 每個 task 完成後，`npm test`、`npm run lint`、`npm run build` 都必須通過。
- 信件不跨 run；沒有 `project.run` 的舊版佈局，行為完全維持不變。
- `done` 和 `failure` 信維持免檢查必要標題（見 `src/format.ts` 的 `REQUIRED_SECTIONS`）。
- 每個使用者看得到的行為改動，都要寫進 `docs/how-it-works.md` 和 `docs/how-it-works.zh-TW.md`。
- 先寫會失敗的測試，確認失敗原因正確，再實作。

## Task 1：成員批次處理同 thread 的回信

**涉及檔案：** `src/prompt.ts`（`pickMessages`）、新增 `test/pick-messages.test.ts`。

**目前行為：** 只有 lead 會一次取一串連續的 `reply`/`failure`（上限 `LEAD_BATCH_LIMIT`）；其他 agent 每次喚醒只取一封。

**要達成的行為：**

- 非 lead 的 agent：最舊的未讀信若是 `reply` 或 `failure`，就連同其後「同樣是 `reply`/`failure` 且 thread 相同」的連續信一起取，最多 `LEAD_BATCH_LIMIT` 封。
- 遇到類型不同或 thread 不同的信就停止。
- lead 的規則不變（不看 thread）。
- `task` 和 `ask` 永不批次。
- `pickMessages` 的函式簽名不變；上方說明註解要同步更新。

**驗收測試：**

- 成員的信序為「同 thread 的兩封 reply、再一封不同 thread 的 reply」時，取前兩封。
- 成員最舊的是 `task` 時只取一封，即使後面有同 thread 的 reply。
- 成員最舊的兩封 reply 但 thread 不同時只取一封。
- 既有固定「成員每次一封」舊行為的測試，改成新規則，並在 commit 訊息說明。

**Commit：** `feat: members handle same-thread replies in one wake-up`

## Task 2：退回缺必要標題的信（有次數上限）

**涉及檔案：** 新增 `src/format-rejections.ts`、修改 `src/mailbox.ts`（`routeOutboxes`）、新增 `test/format-rejections.test.ts`、修改 `test/mailbox.test.ts`。

**計數器模組要提供：**

- 一個常數，上限為 2 次（`MAX_FORMAT_REJECTIONS`）。
- 產生計數鍵的函式：由寄件人、信件類型、主旨組成；主旨去除前後空白並轉小寫，讓大小寫不同的同主旨視為同一個。
- 讀取目前計數的函式。
- 計數加一並回傳新值的函式。
- 計數存在該 run 目錄下的 `format-rejections.json`，用既有的原子寫入工具（`src/fs-util.ts`）寫入。
- 檔案不存在、內容損壞、或不是物件時，一律當作空計數，不可丟錯。

**路由的行為：**

- 只在 run 內生效（`project.run` 有值）。沒有 run 的舊版佈局維持現行「加警告後送達」。
- 缺必要標題的 `task` 或 `reply`：若該鍵的計數小於上限，就退回給寄件人，並把計數加一；退回原因要列出缺少的標題、提醒「空的段落寫 `None`」、並說明這是第幾次、共幾次，之後會改為加警告後送達。
- 計數達到上限後，回到現行行為：加警告後送達，並保留 run 紀錄裡的 `format-warning`。
- 被退回的信不會進收件人的 inbox。
- `done`、`failure` 不受影響。

**驗收測試：**

- 計數器：不同鍵各自計數；重新載入後計數仍在；損壞的檔案視為空。
- 路由：同一寄件人、類型、主旨的缺標題 reply，前兩次被退回且原因提到缺少的標題；第三次內文不同的同主旨信被送達，且有一則警告。
- 既有測試若在綁定 run 的 project 送沒有標題的 `reply`/`task`，現在會被退回；逐一把那些信件內文改成帶四個必要標題（可用 `test/mailbox.test.ts` 的 `REPLY_BODY`），不要放寬規則。

**Commit：** `feat: send back mail missing required sections, at most twice per subject`

## Task 3：更新文件

**涉及檔案：** `docs/how-it-works.md`、`docs/how-it-works.zh-TW.md`。

**要寫進去的兩件事：**

1. 「每次喚醒一封」那一步：補上 lead 之外的 agent 也可以一次取最多 5 封同 thread、連續的 `reply`/`failure`，一起做決定。
2. 「格式標題」那一步：缺標題的 `task` 或 `reply` 會先退回寄件人（`failure` 信會指出缺哪些標題），每個「寄件人＋類型＋主旨」在一個 run 內最多退回兩次；之後才加警告送達並記 `format-warning`。舊版佈局一律加警告送達。

英文檔用英文，zh-TW 檔先讀既有用語再用繁體中文表達同樣意思。

**驗收：** `npm test` 與 `npm run lint` 通過。

**Commit：** `docs: member batching and format rejection`

## 不在範圍內

- 檢查 `done` 的內容：需先決定檢查如何設定、由誰執行、失敗時對結果的影響，要先有 spec。
- 更聰明的重複信偵測、並行喚醒上限、單一成員失敗時 run 是否繼續、`COMMON.md` 跨 run 覆蓋：各自是獨立的設計問題。

## 執行前請確認

- 行號與符號名稱以實際程式碼為準；本計畫刻意不寫行號。
- 退回與批次兩件事互相獨立，可分開合併。
