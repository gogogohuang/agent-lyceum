# 17 task 接續用的共享 memory

狀態：已實作（計畫：docs/plans/2026-10-14-17-run-shared-memory.md）。

## 17.1 問題

- 16 讓已 `done` 的 run 可以重開（`resume <name> "追加要求"`）。重開後 lead 與成員是新的 wake-up：沒有 `resume: true` 的 agent 是全新 session，只看得到自己的 private task memory（`task-memory/<run-id>/<agent>`，`src/run-store.ts` 組出 `memory.task`）。
- 上一段做了什麼、為什麼這樣設計、還剩什麼，現在只存在 lead 的 `done` 報告與各 agent 自己的記憶裡。成員 B 沒參與的決定，重開後 B 完全不知道；lead 得在追加的 task mail 裡重講。
- 範圍（使用者 2026-10-14 決定）：共享 memory 是給「接續做的 task」，也就是 16 的重開，不是給 run 進行中的 agent 即時共享。

## 17.2 決議

| # | 決議 |
|---|---|
| 1 | 新增 run 級共享目錄 `task-memory/<run-id>/_shared/`，與 run 同生命週期：重開保留，`clear <run>` 一併刪除。資料夾叫 `_shared`，因為 agent 名稱開頭必為英數，不會和某個 agent 自己的資料夾撞名。不跨 run（跨專案、跨 task 的長期知識仍放 project／global memory）。 |
| 2 | 內容是「接續交接」：已做的決定與理由、介面約定、目前狀態、未完成與下一步、踩過的坑。 |
| 3 | 只有 lead 寫（`run --agent` 的單獨 agent 就是它那一人團隊的 lead，同樣寫；`call` 沒有）。`done` 的契約不變，但 lead 的 prompt 新增一條：結束一段（送 `done`）前，更新 `__shared/MEMORY.md` 與需要的檔案。成員不能寫 shared（沙箱與 write guard 都唯讀）；成員有值得保留的發現就寫在 `reply` 的 `## Open items`／`Changes`，由 lead 決定收不收。不新增 `can_write_shared`、不新增 mail 類型。 |
| 4 | 重開後的每一次 wake-up（lead 與成員）prompt 都帶 `__shared/MEMORY.md`（上限 8 KB，超過截斷並提示，與 `COMMON.md` 相同）；其他檔案按需讀。第一次執行（未重開）時不放進 prompt，避免空區塊。 |
| 5 | 重開時，dispatcher 在寄給 lead 的追加 `task` mail 的 `Upstream` 指向 `__shared/MEMORY.md` 與前一次 `done-<n>.md`（16 決議 5、7）。 |
| 6 | 若 lead 在 `done` 前沒有更新 `_shared/`，不阻擋結束：run 的 `notes` 記一筆 `shared-not-updated`，下次重開的 prompt 仍照常運作（沒有 `_shared/` 視為空）。 |
| 7 | write guard 與沙箱：`_shared/` 對 lead 可寫、對其他 agent 唯讀（Claude 的 `allowWrite`／`denyWrite`、Codex 的 `writable_roots` 與 post-hoc 還原）；`doctor` 的強制層級多一類 `shared`；`dispatcher.strict: true` 時要求 OS 層保護。 |
| 8 | 預設行為不變：沒有重開過的 run 與舊 run（沒有 `_shared/`）完全照舊；memory tidy 不整理 shared。 |

## 17.3 與其他 spec 的關係

- 16：重開機制的前提；`done-<n>.md`、`followups/` 與 `Upstream` 都在 16 定義。
- 02、15：shared 在 run 目錄，不在 worktree，不增加 agent 可寫的 git 狀態。
- 10：tidy 不納入 shared。

## 17.4 影響的檔案

- `src/paths.ts`、`src/run-store.ts`：`_shared` 路徑。
- `src/policy.ts`、`src/guard.ts`、`src/adapters/claude.ts`、`src/adapters/codex.ts`：lead 可寫、其他人唯讀。
- `src/prompt.ts`：lead 的交接指示；重開後各 agent 的 `__shared/MEMORY.md` 索引。
- `src/run-session.ts`：重開時組 `Upstream`；結束時 `shared-not-updated` 提示。
- `src/doctor.ts`、`src/run-cleanup.ts`。
- `README.md`、`README.zh-TW.md`、`docs/commands.md`（含 zh-TW）。

## 17.5 驗收

先寫失敗測試再實作：

1. lead 寫入 `__shared/MEMORY.md`；重開後，lead 與任何成員的 wake-up prompt 都含它，第一次執行的 prompt 不含。
2. 成員寫 `_shared/` 被擋並還原、回報 lead；lead 寫入正常。
3. 索引超過 8 KB 時截斷並提示。
4. lead 沒更新 shared 就 `done`：結束不被擋，`notes` 有 `shared-not-updated`，重開仍能運作。
5. 重開的 `Upstream` 含 `__shared/MEMORY.md` 與前一次 `done-<n>.md` 的路徑。
6. Claude 與 Codex 的強制層級輸出含 `handoff` 欄；`strict` 下層級不足時拒絕開始。
7. 沒有 shared 的舊 run 可 resume 與重開；`clear <run>` 會刪掉 shared；其他 memory 的行為與測試不變。

## 17.6 範圍外

run 進行中成員之間即時共享、成員直接寫 shared、跨 run 的 task 鏈（新 run 接續舊 run）、自動從報告萃取 shared、tidy 整理 shared。
