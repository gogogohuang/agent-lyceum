# 17 run 級共享 memory

狀態：草案（尚無 plan）。

## 17.1 問題

- 現在的 task memory 是每個 agent 私有的（`task-memory/<run-id>/<agent>`，`src/run-store.ts` 組出 `memory.task`；`src/policy.ts` 禁止寫別人的 memory）。同一個 run 的成員 A 的發現，成員 B 與 lead 看不到。
- 共享只能靠 mail 正文，或 lead 寫 `COMMON.md`（run 中只有 lead 能改，且多個 run 並行時可能互相覆蓋，見 README Known limits）。
- 目標：同一個 task 的 agent 有一個共同可讀、可追加的上下文，讓設計決策、踩過的坑不必每次由 lead 轉述；與 16 搭配，重開的 run 也保有它。

## 17.2 決議

| # | 決議 |
|---|---|
| 1 | 新增 run 級共享目錄 `task-memory/<run-id>/shared/`：run 內所有 agent 可讀；`MEMORY.md` 索引每次喚醒都放進 prompt（與現有 memory 索引同樣方式，大小上限同 `COMMON.md` 的 8 KB，超過截斷並提示）。 |
| 2 | 寫入權限：預設只有 lead 可寫；成員要寫需在 `project.yaml` 該 agent 設 `can_write_shared: true`。依設定判斷，程式與 prompt 不寫死 agent 名稱。理由：多個 agent 同時寫同一個索引會互相覆蓋。 |
| 3 | 成員不能寫時的替代路徑：在 `reply` 加 `## Shared notes` 小節，lead 決定是否收進 shared。不新增 mail 類型。 |
| 4 | 有 `can_write_shared` 的成員只能在 `shared/<agent>/` 子目錄寫（各寫各的），`MEMORY.md` 與頂層檔案只有 lead 可寫。這樣並行成員不會互相覆蓋，索引仍由單一寫者維護。 |
| 5 | 不影響既有的 private task memory、project memory、global memory；shared 不跨 run、`clear <run>` 時一併刪除；16 的重開沿用同一個 shared。 |
| 6 | write guard 與沙箱：Claude 的 `allowWrite`／`denyWrite`、Codex 的 `writable_roots`、post-hoc 還原都把 `shared/` 納入（可寫者加入 allow，其他人在 deny 或唯讀；Codex 以 post-hoc 偵測還原）；`doctor` 的強制層級輸出多一類 `shared`。`dispatcher.strict: true` 時 shared 的保護也必須是 OS 層。 |
| 7 | prompt 說明：shared 放「這個 task 內大家都該知道的決定、介面約定、發現」，不放 task 以外的長期教訓（那些仍放 project／global memory）。 |
| 8 | 預設行為不變：沒有任何 agent 設 `can_write_shared` 時，只有 lead 寫 shared；shared 為空時 prompt 不多出區塊。舊 run 沒有 `shared/` 目錄也可讀（缺目錄視為空，lead 首次寫時建立）。 |

## 17.3 與其他 spec 的關係

- 02 safety guard、15 git 隔離：shared 在 run 目錄，不在 worktree，不增加 agent 可寫的 git 狀態。
- 10 memory tidy：tidy 只整理 global／project memory，shared 不納入（它只活在單一 run）。
- 16：重開保留 shared。

## 17.4 影響的檔案

- `src/run-store.ts`、`src/paths.ts`：`shared` 路徑。
- `src/policy.ts`、`src/guard.ts`、`src/adapters/claude.ts`、`src/adapters/codex.ts`：寫入規則與還原。
- `src/prompt.ts`：shared 索引與說明；`reply` 的 `## Shared notes`；`src/format.ts` 的標題檢查（缺少時不警告，因為可省略）。
- `src/config.ts`：`can_write_shared`。
- `src/doctor.ts`、`src/run-cleanup.ts`。
- `README.md`、`README.zh-TW.md`、`docs/commands.md`（含 zh-TW）。

## 17.5 驗收

先寫失敗測試再實作：

1. lead 寫入 `shared/` 的檔案與 `MEMORY.md`；之後任何成員喚醒時 prompt 含該索引。
2. 未設 `can_write_shared` 的成員寫 `shared/` 被擋並還原、回報 lead；設了的成員只能寫 `shared/<自己>/`，寫別人子目錄或頂層被擋。
3. 兩個並行成員各寫自己的子目錄，互不覆蓋。
4. 索引超過 8 KB 時截斷並提示。
5. Claude 與 Codex 的強制層級輸出含 `shared`；`strict` 下層級不足時拒絕開始。
6. 沒有 shared 目錄的舊 run 可 resume；`clear <run>` 會刪掉 shared。
7. 其他 memory（private task、project、global）的行為與測試不變。

## 17.6 範圍外

跨 run 共享（那是 project memory 的工作）、即時同步、成員之間直接通訊（仍走 mail）、自動從 reply 萃取 shared。
