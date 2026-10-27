# 獨立複審：`docs/fixes-for-analysis-reports.md`（Codex 審查）

> **寫於 2026-10-23，對應 commit `088a180`。** 文中的 `檔案:行號` 都是那個 commit 上的行號；之後 main 已有多次改動（至 2026-10-27 約 55 個 commit），其中多數行號已位移，請先用 `git show 088a180:<檔案>` 對照，不要直接套用到現在的檔案。

**總判斷：需小修，修完才可採用。** 文件的骨架、統計（成立 22／部分成立 9、被推翻 21 條、43 條執行順序）和語料數字都被獨立重算確認。但有 12 處必修（1 個 blocker、11 個 major）：A 類 4 處（含一個錯誤反例）、B 類 3 處、基準驗收方法 1 處，以及 C 類 4 條的修法照字面做會出事（C-03、C-06、C-11、C-14）。
**發現數**：共 59 條，高 6、中 27、低 26（嚴重度由各審查者自評，見〈發現表〉）。其中必修 12 條（blocker 1、major 11），其餘為記錄性 minor／nit。
**被推翻項目重驗**：21 條全部重驗（其中 9 條另由第二位審查者獨立重驗）。第一位審查者的結果：維持推翻 11、部分 9、**應恢復為成立 1（#7）**。兩人對同一條判定不一致的有 4 條（#6、#7、#9、#12），原樣保留。
**抽查數**：引用、指令、數字的「確認無誤」清單共 105 處（34＋22＋15 條 B 主抽查＋34），另加 59 條發現，A、B、C 三類都有涵蓋。
**用不用改**：文件本身的骨幹可信。採用前請先修第 2 節列出的 12 條必修；C 類任何一條要實作前，先讀本文第 2 節、第 3.2 節（C 類逐條的可行性與限定）和第 4 節的修正。

被審查版本：`c458e9b:docs/fixes-for-analysis-reports.md`（816 行，下文行號都指這一版）。行號基準：`088a180`。審查者的 worktree HEAD 是 run snapshot `75a5a47`，`git diff --quiet 088a180 75a5a47` 回傳 0，tracked tree 完全相同。

## 1. 怎麼審的

四位 runtime 為 Codex（`gpt-6.1-sol`）的成員，各審一個範圍，各自獨立完成；四人都自述沒有參考其他審查者的結論，也沒有讀先前 Claude 驗證者的筆記（這是自述，不是存取限制：檔案系統並沒有擋住互讀）。lead（Claude）只負責分派與彙整，沒有先下結論。

| 代號前綴 | 審查者 | 範圍 |
|---|---|---|
| RD- | runtime-debugger-reviewer | 〈被推翻的項目〉全部 21 條；A-01…A-12 的事實 |
| CA- | cli-architect-reviewer | C-01…C-16 的事實與可行性；另獨立重驗被推翻 #2、#3、#6、#7、#8、#9、#10、#12、#14 |
| DR- | docs-reviewer | B-01…B-15；全文對新手（AI 小白）的可讀性 |
| QR- | qa-reviewer | 可照抄指令實跑、數字重算、前後一致性與執行順序 |

所有人都沒有改 repo、沒有呼叫付費模型、沒有起 server。實驗只在 `$TMPDIR` 用 fake runtime（假執行環境）跑。限制：worktree 沒有 `node_modules`，`npm run typecheck`、`node --import tsx src/cli.ts` 都無法執行（TS2688／ERR_MODULE_NOT_FOUND）。CA 改把 `src/*.ts` 原樣複製到暫存目錄（逐份比對 SHA-256 相同），連結既有套件後跑 probe。

彙整時 lead 自行抽查了 RD-01 的關鍵證據：2d1b53 的 `log.jsonl` 第 3、5、10 行是三次 timeout，第 12 行才是第一次成功，與 RD-01 所述一致。也確認了 DR-01（`src/memory-tidy.ts:367,373`）和 CA-09（`src/prompt.ts:253-260`）的原文。

## 2. 必修項（blocker／major）

| 編號 | 一句話 |
|---|---|
| RD-01（blocker） | A-05／被推翻 #7 用 2d1b53 當反例是錯的：那次失敗前沒有任何成功的 wake，sessionId 仍是 undefined，原規則反而會准許注入 |
| RD-02 | A-07／#12 把評估報告沒講過的「R2:165 呼叫點寫錯」當成被推翻的論點 |
| RD-03 | A-06／#10 說原提案「把任務放在 Rules 之上」不忠於原文 |
| RD-04 | A-10／#21 用另一組詞表算出 31／47／48，推翻不了原報告依它自己詞表算出的 35–40 |
| CA-03 | C-03「失敗者回傳了 id 就略過注入」仍會錯關 F（resume:false、切換候選模型時），也沒有欄位能記錄 |
| CA-06 | C-06 修法的方向「另一個 run 的 lead 活躍時就跳過」會放過真正越權的寫入 |
| CA-11 | C-11 想從會輪替的 `log.jsonl` 推出「尚未處理的拒信」，這不可靠 |
| CA-14 | C-14 只刪 dirname roots，會拿掉 `can_edit_agent_md` 承諾的寫入能力；須先做設計決策 |
| DR-01 | B-04 把「tidy 不自動注入 COMMON」寫成「看不到 COMMON」；tidy 仍可讀 |
| DR-02 | B-05 的「改前」不是 R1 原文，R1:94 本來就寫對了；真正寫錯的是 `prompt.ts:47` |
| DR-03 | B-10／小字典說「clear 後 commit 就找不到」是過度保證 |
| QR-01 | A-09／B-10 用 `git cat-file -t` 來確認，會放行不在 main 上的 snapshot |

## 3. 發現表

嚴重度（高／中／低）沿用各審查者自評；括號裡是審查者標的 blocker／major／minor／nit。把握：已驗證＝有指令輸出或 `檔案:行號`；推論＝依判斷，未實測。

### 3.1 A 類與被推翻項目（RD）

| 編號 | 位置 | 問題 | 證據 | 建議修法 | 嚴重度 | 把握 | 發現者 |
|---|---|---|---|---|---|---|---|
| RD-01 | A-05:150–156；#7:765 | 「完全替 lead 關掉 F」說過頭；「連 2d1b53 都排除」有反證：resume:true 只會查既有 id，不會憑空生出 id，而該 run 在帶 done.md 草稿的那次失敗前，沒有任何成功的 wake | `run-store.ts:215–216,231` 新 run 的 sessions 是空的；`run-session.ts:429,449`；`process-runner.ts:217` timeout 不回 id；2d1b53 `log.jsonl:3,5,10,12` 依序是 timeout×3 後才第一次成功；`mvhnuubh-tech-lead-53ff72-a1.json:9–11` | 撤回 2d1b53 反例與「完全」二字，改成「已有 session id 的 lead 會跳過注入」；要否決原方案，須拿出「已有舊 id 卻仍需要 F」的證據 | 高（blocker） | 已驗證 | runtime-debugger-reviewer |
| RD-02 | A-07:182,186；#12:770 | 把評估報告沒說的「R2:165 的呼叫點寫錯」當成被推翻的論點 | `review-analysis-reports.md:106,135` 說的是 base.userPrompt 只算一次、要在每次 invoke／beginAttempt 前重選 | 刪掉這個虛構的原論點，只保留「不一定要在 beginAttempt 前」這個修正 | 中（major） | 已驗證 | runtime-debugger-reviewer |
| RD-03 | A-06:167,171；#10:768 | 「把任務放在 Rules 之上」不忠於原文：原提案的順序沒有列 Rules；「順序由 lead 決定」也不必然是邏輯矛盾 | `review-analysis-reports.md:156`；`prompt.ts:218–223` | 改成「沒說明 Rules／persona／runtime 指示和這個順序的關係，應補上」 | 中（major） | 已驗證 | runtime-debugger-reviewer |
| RD-04 | A-10:241,245,250；#21:779 | 換了詞表算出 31／47／48，反證不了原報告用自己的詞表算出的 35–40（原報告本來就寫「依詞表」）；目前只能確認原腳本沒進 repo | 重算確實得 31／47／48；`review-analysis-reports.md:72,161`；`rg --files -g f1.sh -g rc.sh` 無輸出 | 保留「原 grep 無法重現」；31／47／48 標成新詞表的重算結果；撤回「35–40 已被推翻」 | 中（major） | 已驗證 | runtime-debugger-reviewer |
| RD-05 | A-02:114,118；A-06:165–173；#6、#8–9、#19 | 多處是有代價的設計取捨或排序判斷，不是被證據推翻的事實；原報告本來就列了替代方案（I-19 改提示文字、I-20 prompt 截斷、I-21 只補文件），轉述時被拿掉了 | `review-analysis-reports.md:152–154`；`run-session.ts:273–278,423,429`；`solo.ts:17–19` | 保留風險分析，寫成「不採用的方案／取捨」，並保留原報告的替代選項 | 低（minor） | 已驗證 | runtime-debugger-reviewer |
| RD-06 | A-09:222,231；#15:773 | 「clear 後 commit 就找不到」太強：刪 ref 不等於立刻刪 object；`keepWorktrees` 時不清；cat-file 能解析也不代表在 main 的祖先鏈上 | `run-cleanup.ts:89–90,139`；`worktree.ts:781–782` 只執行 `update-ref -d`；`git for-each-ref --contains f41a39c` 仍列出 refs | 改成「清理會移除保留它的 ref，之後可能被 GC 回收」 | 低（minor） | 已驗證 | runtime-debugger-reviewer |
| RD-07 | A-01:101,104 | 「逾時／取消重試接的是上一次成功 wake 的 session」不精確：也可能接到之前帶回 id 的失敗結果，或者根本沒有 id | `run-session.ts:449` 沒有 `result.ok` 條件；`:429` | 改成「使用先前已記錄的 session id，沒記錄過就是 fresh」 | 低（minor） | 已驗證 | runtime-debugger-reviewer |
| RD-08 | A-11:268；#18:776 | I-11 原本引用 tidy／clear 兩件事，不能把 tidy 的引用全當錯引 | `review-analysis-reports.md:144`；`cli.ts:633,643,666` 確實是 tidy；`:468` 是 clear | 分開列：保留 tidy 引用，clear 部分另補 | 低（minor） | 已驗證 | runtime-debugger-reviewer |

### 3.2 C 類（CA）

| 編號 | 位置 | 問題 | 證據 | 建議修法 | 嚴重度 | 把握 | 發現者 |
|---|---|---|---|---|---|---|---|
| CA-01 | C-01:521–543 | 可照做；但要和 C-02 共用「每次 invoke 都重新選候選」；沒有草稿也應觸發 G | `fallback.ts:204`；`run-session.ts:440`；d041c8 log:22 的 attempt 0、兩個 claim 的 message_ids 相同 | 把讀取 prior 放進 invoke，和 C-02 一起做 | 低（記錄） | 已驗證 | cli-architect-reviewer |
| CA-02 | C-02:545–555 | 可照做；每次 invoke 重選就看得到剛 park 的草稿 | `run-session.ts:373–380,426,440,493–499`；`message-store.ts:218`；8e32b2 docs-reviewer a1／a2 | 固定在 invoke 中加入 F，補「沒有草稿時 prompt 不變」的測試 | 低（記錄） | 已驗證 | cli-architect-reviewer |
| CA-03 | C-03:557–567 | 需修改：「失敗者自己回傳 id 就略過」仍會錯關 F（resume:false 的成員不接續；換候選模型的下一次也接不上）；attempt 記錄沒有 runtime／candidate／session id 欄位 | `run-session.ts:423,429,449`；`message-store.ts:174–186,223–226`；fake probe：resume:false 兩次輸入 sessionId 都是 null；Claude→Codex 切換後也是 null | 優先採「符合條件的草稿一律有界注入，接受可能重複」；若一定要抑制，須確認下一次 invoke 確實 resume 同一個 runtime／candidate／session，並設計 metadata 與舊 run 的預設行為 | 高（major） | 已驗證（反例）；runtime turns 為推論 | cli-architect-reviewer |
| CA-04 | C-04:569–579 | 可照做；「discarded」和 F 不是邏輯上互斥，只是容易被誤會成內容已刪 | `run-session.ts:45,493–499`；`message-store.ts:229–240` | 保留「檢查 repo 副作用、重新寄信」的要求 | 低（nit） | 已驗證 | cli-architect-reviewer |
| CA-05 | C-05:581–592 | 需修改：驗收把 R2 的口徑（被喚醒 ≥2 次的成員有沒有 task memory）換成了「有 memory 的 wake／所有 wake」；檔案存在後即使完全不更新也能達標 | `prompt.ts:213–215,90–91`；R2:145 | 保留原口徑，另外量「這次 wake 有沒有更新 checkpoint」 | 中（minor） | 已驗證（口徑）；效果為推論 | cli-architect-reviewer |
| CA-06 | C-06:594–613 | 缺陷成立，修法須另做安全設計：只觀察到「另一個 run 的 lead 正在活動」，分不出這次寫入是 lead 還是沒沙箱的 member 寫的，照此跳過 guard 會放過越權寫入；「跨 run 鎖＋rebase」沒說鎖的範圍、持有者、崩潰後怎麼恢復 | `guard.ts:87,112–119`；`project-lock.ts:299–305`；`run-session.ts:593,926`；**兩個真 git worktree 的 fake run 重現**：B 的 lead 寫了 COMMON／b.md，A 的 member 結束後 COMMON 被 restored、b.md 被 removed，suspects=['fe-member'] | 明寫「不得以另一個 lead 在活動當作授權證據」；交 architect 設計寫入協定或跨 run 協調；QA 必測「B 在活動時，A 的 member 越權仍會被抓到」 | 高（major） | 已驗證（缺陷）；修法風險為推論 | cli-architect-reviewer |
| CA-07 | C-07:615–626 | 驗收要改：notes 本來就是 JSON 的一部分，「`status --json` 逐字相同」不可能成立 | `status.ts:330,488`；`rg 'fresh session' test` exit 1 | 改成「JSON schema／欄位不變，只允許那一筆 note 的值不同」 | 低（minor） | 已驗證 | cli-architect-reviewer |
| CA-08 | C-08:628–640 | 可照做，但要寫清楚上限管的是什麼：prompt 端截斷不解決 route／hash／摘要讀全文的記憶體與 I/O；`task.ts` 是「改成指標＋前十行」，不是現成的截斷 helper | `prompt.ts:304`；`mailbox.ts:149,174,281`；`message-store.ts:88–94`；probe 送 20,013 B 的信，尾端仍進了 prompt；p95＝10,841 B 吻合 | 定義每封與整批的預算、UTF-8 邊界；資源保護另開任務 | 低（minor） | 已驗證 | cli-architect-reviewer |
| CA-09 | C-09:642–652 | 需修文案：「agent 不知道被截斷」不成立，prompt 已有截斷提醒；`done` 之後沒有下一次 wake，寄信給 lead 提醒不等於使用者看得到 | `prompt.ts:253–260`（9,000 B probe 可見提醒）；`run-session.ts:677–688` | 寫明警告顯示在 CLI／result／status 的哪裡 | 低（minor） | 已驗證 | cli-architect-reviewer |
| CA-10 | C-10:654–668 | 可照做；但預設沒有 `max_rounds` 可「用完」（`schema.ts:122` 預設 0＝無上限）。**單人鎖死已用 fake 重現**（原文件列為未解答） | route probe：done=false、records 7017 B、recordsDenied=true；runTeam 設 max_rounds:2 → endReason=max_rounds | 敘述改成「沒有外部修正就一直被拒；設了有限的 max_rounds 才會停」 | 中（minor） | 已驗證 | cli-architect-reviewer |
| CA-11 | C-11:670–681 | 需修改：log 會輪替並覆蓋舊備份；rejected 記錄只有 from／file／reason，沒有穩定的配對鍵；同名檔可能被覆蓋 | `mailbox.ts:194,264–276,343–350`；`run-log.ts:4–17`；probe：currentHasRejected=false、oldHasRejected=true | MVP 只報「這段期間曾有拒收（可能已重寄）」；要做到 unresolved，得先設計 identity／resolve 規則 | 中（major） | 已驗證 | cli-architect-reviewer |
| CA-12 | C-12:683–694 | 需修措辭：app 的 Rules 只能排定 harness 注入內容之間的先後，不能宣稱比 runtime 的系統政策「永遠更高」；也沒說衝突時沒有新 lead 指示該怎麼辦 | `prompt.ts:218–230`；`claude.ts:76–77`；`codex.ts:84` | 限定為「harness 內容之間，寫入限制不可被 task／COMMON／records／memory 覆蓋」；無法判定時回報衝突 | 中（minor） | 已驗證；效果為推論 | cli-architect-reviewer |
| CA-13 | C-13:696–711 | 可照做；但範例 `rg` 的單引號裡寫了兩個反斜線，會漏抓真正的 `paths.common`，所以「沒有輸出」不可靠 | 用已知輸入測：雙反斜線 exit 1、單反斜線 exit 0 | 改成單引號內只有一個反斜線的 `'paths\.common'`；再跑 typecheck | 低（nit） | 已驗證 | cli-architect-reviewer |
| CA-14 | C-14:713–724 | 需先做設計：只刪 dirname roots 會拿掉 `can_edit_agent_md` 的能力；Codex 介面只有目錄 roots，無法同時做到兩件事；也要考慮更上層的 root／cwd 覆蓋 | `policy.ts:136–138,203`；`codex.ts:7–11,65–78`；probe 的 roots 確實包含 lead-checkout 與其他 agent 目錄 | architect 先選：不支援並報錯／改由 dispatcher 套用／接受擴權並完整揭露 | 中（major） | 已驗證（設定）；OS 實際行為待驗 | cli-architect-reviewer |
| CA-15 | C-15:726–739 | 可照做；碰撞已實跑證實（不只是推論）；要補檔名解析的邊界 | `message-store.ts:200–219`；probe：a1 損毀後回傳舊 a2 的 id，原紀錄被覆蓋 | 在同一個 claim 範圍內解析完整的 aN 檔名 | 低（minor） | 已驗證 | cli-architect-reviewer |
| CA-16 | C-16:741–751 | 標題與「永遠」要改：help 寫的是「直到對話被 compact」；未實測的推論不能升格成「lead 永遠看不到」 | `claude --help`（2.1.309）：until the conversation is compacted；`claude.ts:68–82` | 標題改為「…可能沿用舊系統提示（依 help，待實測）」；實驗要涵蓋 compact 前後 | 中（minor） | 已驗證（help）；runtime 未測 | cli-architect-reviewer |
| CA-17 | 被推翻 #2:760 | 維持推翻：只有帶 id 的結果而且 resume 開啟才會寫回 | `process-runner.ts:174,214,216–217,218–221`；`run-session.ts:449` | 維持更正，補上 resume:false 的條件；timeout 後既有 session 是否含失敗的 turns 另列未知 | 低（記錄） | 已驗證 | cli-architect-reviewer |
| CA-18 | 被推翻 #3:761 | 維持推翻：要看即將切入的候選模型自己有沒有 session | `fallback.ts:224–228`；`run-session.ts:423,429` | 維持「備援自己有 session＋resume:true」的限定；JSON 驗收另見 CA-07 | 低（記錄） | 已驗證 | cli-architect-reviewer |
| CA-19 | 被推翻 #6:764 | 維持推翻；這是有代價的取捨，不是程式做不到 | `fallback.ts:82–86`；`run-session.ts:423,429,449` | 修 note 的改動比移除既有能力小；若要一律 fresh，須明確接受失去連續性並改規格 | 低（記錄） | 已驗證（程式）；連續性的價值屬設計取捨 | cli-architect-reviewer |
| CA-20 | 被推翻 #7:765 | 維持推翻，但替代判準也要修：既有 sessionId 不代表這次 timeout 的成果在可接續的對話裡；`=== undefined` 會排除帶著舊的成功 session 的 lead | `config.ts:236`；`run-session.ts:429,449`；2d1b53 a1 timeout、parked=['done.md']，state.sessions 有 id（屬最終狀態） | 拒絕原本的全面判準，改採 CA-03 方案；那份歷史 state 證明不了下一次確實接續了失敗的 turns | 中（記錄） | 已驗證（反駁）；turns 未驗證 | cli-architect-reviewer |
| CA-21 | 被推翻 #8:766 | 部分：prompt 截斷較小、route reject 有額外成本屬實，但 route 上限仍是可行的政策，不能說已被推翻 | `task.ts:69–77`；`mailbox.ts:264–276`；`run-session.ts:430–432`；評估報告:153 | 改成「本 MVP 選 prompt 截斷，route 上限另有它的用途與代價」 | 低（minor） | 已驗證（路徑）；優劣取決於需求 | cli-architect-reviewer |
| CA-22 | 被推翻 #9:767 | 維持推翻，但只限「沒排除 solo、也沒規劃升級」的硬擋；solo 無權縮減 COMMON 屬實 | `solo.ts:18`；`policy.ts:120,134,152`；records 的同型鎖死已重現 | 保留這個假設性風險；也可以採只限 team 的硬擋，但須使用者決策並附升級說明 | 中（記錄） | 已驗證（權限）；COMMON 硬擋的後果為推論 | cli-architect-reviewer |
| CA-23 | 被推翻 #10:768 | 部分：缺其他指示來源的批評成立；「預設順序＋lead 可調整」不必然自相矛盾 | 評估報告:156；`prompt.ts:218–230`；`claude.ts:76–77`；`codex.ts:84` | 分開「內容不可覆蓋的 harness 安全限制」與「lead 可調整的工作優先序」 | 中（minor） | 已驗證；模型效果為推論 | cli-architect-reviewer |
| CA-24 | 被推翻 #12:770 | 維持推翻：R2 沒指定錯誤的呼叫點；新 attempt 是 started，篩 failed 時不會選到自己 | R2:108,165；`message-store.ts:218`；`run-session.ts:426,440,493–499` | 保留「原規格沒把呼叫點講清楚」的批評，撤回「寫錯／必須在 beginAttempt 前」 | 低（記錄） | 已驗證 | cli-architect-reviewer |
| CA-25 | 被推翻 #14:772 | 維持推翻：「存什麼」與「何時 checkpoint、重做時先讀」有重疊，但不相同 | `prompt.ts:213–215` 對照 R2:102–103 | 保留差異；成效依 CA-05 的方式量測 | 低（記錄） | 已驗證 | cli-architect-reviewer |

### 3.3 B 類與可讀性（DR）

| 編號 | 位置 | 問題 | 證據 | 建議修法 | 嚴重度 | 把握 | 發現者 |
|---|---|---|---|---|---|---|---|
| DR-01 | B-04:354,357–359 | 把「tidy 不自動注入 COMMON」寫成「看不到 COMMON」，混淆了自動載入和讀取權限；grep 沒命中證明不了「不能讀」 | `memory-tidy.ts:367`（註解：read what it could read before）、`:373` 把原本的 readDirs 加回去；`policy.ts:134`；`claude.ts:66,82`；`prompt.ts:389–430` | 改成「tidy 的提示不自動附 COMMON、也不授權寫它，但原本可讀的仍可讀」；表格分成「自動載入／可讀／可寫」三欄 | 高（major） | 已驗證 | docs-reviewer |
| DR-02 | B-05:365–369 | 「改前：follow-up 時 agent 都從新 session 開始」不是 R1 原文；R1:94 本來就寫「沿用 sessions」。真正寫 fresh sessions 的是 `prompt.ts:47` | R1:94；R2:32,58,154；`prompt.ts:47`；`run-session.ts:209,222–235,429` | 改前逐字引用 `prompt.ts:47`，並明寫「R1:94 是對的」 | 高（major） | 已驗證 | docs-reviewer |
| DR-03 | B-10:438,441；小字典:36 | 「clear 後 commit 就消失」是過度保證；`--keep-worktrees` 會保留；刪 ref 和刪 object 是兩回事 | `run-cleanup.ts:76–90,139`；`git for-each-ref --contains 55ae335` 列出 snapshot ref 和 run branch；`worktree.ts:295–300` | 改成「不保證長期保留，未被其他 ref 指著的 object 可能日後被回收」 | 高（major） | 已驗證 | docs-reviewer |
| DR-04 | B-12:466,470–473 | 把評估報告的「35–40」當成 R2 的改前；R2 寫的是 36／61。另外 R2:151–157 的觸發條件本來就用絕對數，不必再改 | R2:35,149,151–157；重算 31／47／48 | 改前引用 36／61；刪掉「改用絕對數」這條待辦 | 中（minor） | 已驗證 | docs-reviewer |
| DR-05 | B-01:310,312,320 | 把 G 說成「所有 agent 都要先讀」，但 R2 的 G 只改成員的提示，lead 不變 | R2:102–103；R1:7 | 分開寫「R1 概括了所有模式」和「G 只限成員」 | 低（minor） | 已驗證 | docs-reviewer |
| DR-06 | B-08:413–416 | 範例不能直接跑：有 `<別人的 worktree>` 這類占位符；寫入探測成功會留下檔案；預期的 hash 是寫死的 | 審查者的 HEAD 是 75a5a47；沒有清理步驟 | 改用變數；寫入探測只在臨時專案做並清理；預期改成「讀得到內容」 | 中（minor） | 已驗證；殘留為推論 | docs-reviewer |
| DR-07 | B-09:429 | 「開放／成立／部分」是問題判定，「待辦／部分實作／已有／拒絕」是實作狀態，混成一欄新手無法填 | 第 429 行；R1:164–176 | 分成兩欄 | 中（minor） | 已驗證 | docs-reviewer |
| DR-08 | B-13:480–484 | 理由說「R1 用觀察／推論／未知」，卻又要求 R1 改用這套，自相矛盾 | `rg -c 觀察` R1 無輸出；R2:9 才定義這套標籤 | 改成「R1 和 R2 的慣例不同，統一成 R2 的三標籤」 | 低（minor） | 已驗證 | docs-reviewer |
| DR-09 | B-15:505,508 | 前面說髒窗口「只在沒有 OS 沙箱時」，後面又補 Codex repo 指示檔的例外，新手不知道以哪句為準 | `policy.ts:200–201` | 505 同步寫出例外 | 中（minor） | 已驗證 | docs-reviewer |
| DR-10 | 小字典:3,16–24,28,38 | 沒定義 agent、run、CLI、repo、git；session／resume 同時指模型對話和恢復 run，容易混 | 沒有 run 的定義；第 525 行用了「run resume」 | 補基本詞；把「恢復中斷的 run／接續模型 session／run 完成後追加 follow-up」分開講 | 中（minor） | 推論 | docs-reviewer |
| DR-11 | 小字典:25,30 | guard 的定義會讓人以為它認得出實際是誰寫的；sandbox 的定義把本專案的寫入政策講成所有 OS 沙箱的通則 | `guard.ts:38–40,82,87` 只判斷該批 agent 有沒有人有權改；`policy.ts:21–29` | 改寫兩個定義（見審查者原信） | 中（minor） | 已驗證（定義） | docs-reviewer |
| DR-12 | 小字典／統計:27,39,47,57–89 | I／A／B／C 編號、base commit、metadata、stdout、spawn、KiB／KB、token 沒有在第一次出現前解釋；短 run 代號沒有對照 | 表 59–89 | 表前先說明編號體系；補單位說明與完整 run id | 中（minor） | 推論 | docs-reviewer |
| DR-13 | A 類:99–155,165–171 | session key／id、turns、JSON、spawn、`can_edit_agent_md`、notes、post-hoc、writable roots 沒有就近解釋 | 小字典只定義了 session | 各補一句短註 | 中（minor） | 推論 | docs-reviewer |
| DR-14 | B 類:308–401 | team／solo／N/A、by:default、seed mail、auto-memory、flag、symlink 需要程式背景；模式表少了「載入哪些 context」那一列；把函式名 ask-reply 寫成寄信的主體 | 表 314–319；`run-session.ts:708–720` | 補指令範例與 context 列；寫成「dispatcher 寄回提問者」 | 中（minor） | 已驗證（原文）；理解難度為推論 | docs-reviewer |
| DR-15 | C 類:524–737 | invoke、candidate、fixture、snapshot test、reconciliation、atomicWrite 等沒解釋；「snapshot」從 Git 快照變成輸出比對測試，新手會以為是同一個東西 | 小字典:36；第 577 行 | 每條先給結論；補名詞；工程驗證標成「交給工程師執行」 | 中（minor） | 推論 | docs-reviewer |
| DR-16 | 被推翻項目:755–779 | 一格塞了原說法、程式分支、計數、結論，新手分不出推翻的是整個 I 項還是一句話；「:413」這類簡稱沒寫檔名 | 第 755 行說是子論點，但總表沒有「不成立」 | 表前加例句；每列先給白話結論；補全檔名 | 中（minor） | 推論 | docs-reviewer |
| DR-17 | 執行順序:783–792 | 第 11 行說「每條都能單獨讀」，但順序表要追多層相依；第 8 步一次塞 17 條，沒有完成的標誌 | 第 11 行、785–792 行 | 拆成「文件修訂路徑」和「另案實作清單」；每步寫產出與完成條件 | 中（minor） | 推論 | docs-reviewer |
| DR-18 | 還沒解答:796–807 | F1、turns、violations、max_rounds、bwrap、tokenizer 沒解釋；看不出哪些要花錢 | 798–805 行 | 每題寫「驗什麼／用什麼環境／是否付費／影響哪一項」 | 中（minor） | 推論 | docs-reviewer |
| DR-19 | 限制:811–816 | 沒寫原驗證的日期與證據範圍 | 811、815、816 行 | 補日期／版本；寫明「同模型」是原驗證當時的限制 | 低（minor） | 推論 | docs-reviewer |
| DR-20 | 全文驗證步驟（106、321、333、358、371、445–446、460、485、537–538） | 有些指令有未替換的占位符、缺 cwd、只寫「用 python3 -I 掃描」卻沒附腳本；`npm run check:docs` 不涵蓋這三份分析文件 | `scripts/check-docs.mjs:5–14`；B-11:460 | 把「核對事實」和「驗收文件修訂」分開；所有指令交代 cwd 與變數 | 中（minor） | 已驗證（範例）；可操作性為推論 | docs-reviewer |

### 3.4 指令、數字與一致性（QR）

| 編號 | 位置 | 問題 | 證據 | 建議修法 | 嚴重度 | 把握 | 發現者 |
|---|---|---|---|---|---|---|---|
| QR-01 | A-09:231；B-10:448 | 「怎麼確認修好了」只用 object 能不能解析來判斷，攔不住它要防的錯誤基準 | `git cat-file -t f41a39c`、`55ae335` 都 rc=0（輸出 commit），但兩者的 `git merge-base --is-ancestor <hash> main` 都 rc=1 | 確認條件改用 `git merge-base --is-ancestor <基準> main` 且 rc=0 | 中（major） | 已驗證 | qa-reviewer |
| QR-02 | C-01:525,537–540 | 驗證指令的 `head -3` 把正文要的重做事件截掉了（它在第 22 行）；`<run>` 也沒替換 | 實跑只輸出第 3、6、9 行；`sed -n '22p'` 才看到 attempt 0、463774b6 | 給完整路徑，用 message id 和 agent 篩選 | 低（minor） | 已驗證 | qa-reviewer |
| QR-03 | A-08:197–213 | 附的腳本只統計 status，重現不了同一段升級成「已驗證」的另外三件事（沒有後續 resume、parked 與 outbox 吻合、stdout 0 B）；數字本身吻合 | 腳本只輸出 Counter（committed 128／failed 18／started 7） | 補三個對應的檢查，或把腳本的用途限定為只統計 status | 低（minor） | 已驗證 | qa-reviewer |
| QR-04 | A-11:257–282；#18:776 | 「31 項抽查：25 吻合／5 差／1 不對」沒有列出母體，無法獨立重建 | A-11 只有 10 列修正 | 附上 31 項清單，或把比例改成「無法獨立重現」 | 低（minor） | 已驗證（缺明細） | qa-reviewer |
| QR-05 | #16:774；B-08:413–415 | `ls runs \| sort` 沒交代 cwd（在 repo 根目錄執行會報錯，pipeline 卻仍 rc=0）；B-08 是模板，不是能直接跑的指令 | `ls: runs: No such file or directory` | 用 B-10:446 那個完整路徑的版本 | 低（minor） | 已驗證 | qa-reviewer |
| QR-06 | C-16:745；F1:798 | 先引用「until the conversation is compacted」，接著卻推成「永遠看不到」 | `claude --help` 原文 | 限定在「compact 之前」 | 低（minor） | 已驗證 | qa-reviewer |

**數字重算（QR，另有 RD、DR 部分交叉重算）**，全部吻合：

- 統計表：31 個編號，成立 22、部分成立 9（I-03、06、10、12、14、18、19、25、31），沒有不成立或無法驗證。
- 被推翻表：#1–#21 沒有缺號，每列對應的 A 類都存在，合起來涵蓋 A-01…A-12。
- 43 條：A 12＋B 15＋C 16；八個步驟的主列舉剛好 43 個不重複的 id。沒有發現硬相依倒置。
- 語料：前 17 個 run 共 147 封信（task 82／reply 64／failure 1），最大 15,357 B；前 19 個 run 共 179 封，p95＝10,841 B。
- 成員回覆：61 封分佈在 11 個 run（前 19 個 run：76 封／13 個 run）。request-changes 15 次，0a2b9f 5 次＋6e01a3 3 次＝8/15；前 19 個 run 共 19 次。（DR 用另一種方法計數，也得到 15 次與相同分佈。）
- attempts：committed 128、failed 18、started 7；18 個 failed 的 parked 與 outbox 全部吻合；5 個 timeout 的 stdout 都是 0 B；`"event":"rejected"` 出現 0 次。
- 詞表命中：31／47／48。

## 4. 被推翻的項目重驗

RD 重驗全部 21 條；CA 另外獨立重驗其中 9 條（不知道 RD 的結論）。兩人判定不同的，標 **⚠ 不一致**，兩方意見原樣列出。

| # | 被推翻的說法（摘要） | RD 判定 | CA 判定 | 一致？ | 證據摘要 |
|---|---|---|---|---|---|
| 1 | 「R1／R2 兩份都漏了 lead 重試會 resume」 | 維持推翻 | — | — | R1:41 已經寫了；`run-session.ts:429` |
| 2 | 「失敗也寫回 sessionId」 | 維持推翻 | 維持推翻 | 一致 | `process-runner.ts:174,214,216–217`；`run-session.ts:449`（CA 補充：還有 agent.resume 條件） |
| 3 | 「`:413` 不準是因為同候選會沿用 session」 | 維持推翻 | 維持推翻 | 一致 | `fallback.ts:224–228`；`run-session.ts:423,429` |
| 4 | 「缺 `can_edit_agent_md` 警告」 | 維持推翻 | — | — | `policy.ts:203`；`validate.ts:132`；`cli.ts:557` |
| 5 | 「Codex＋`can_edit_agent_md` 時成立」 | 維持推翻 | — | — | `policy.ts:136–139,200–203`；`guard.ts:87–90`；`worktree.ts:541` |
| 6 | 「備援一律不帶 sessionId」不可取 | 部分 | 維持推翻 | **⚠ 不一致** | RD：確實會失去連續性，但這是方案的成本，原報告另外列了改 note 的選項，不算被證據推翻。CA：維持推翻，屬於有代價的取捨，修 note 的改動比移除既有能力小（`fallback.ts:82–86`） |
| 7 | I-03 修法「只在 `sessionId === undefined` 時注入」 | **應恢復為成立** | 維持推翻（但替代判準也要修） | **⚠ 不一致** | RD：2d1b53 那次失敗前沒有成功的 wake，sessionId 是 undefined，原規則反而會准許注入，所以反例不成立；這不表示原方案就是最佳。CA：既有 sessionId 不代表這次 timeout 的成果在可接續的對話裡；`=== undefined` 會排除帶著舊的成功 session 的 lead；2d1b53 的 state.sessions 有 id，但那是最終狀態。lead 抽查：2d1b53 `log.jsonl:3,5,10` 是 timeout、`:12` 才第一次成功，支持 RD 對「這個反例」的判斷；CA 對「一般情況」的反論仍然成立，兩者不互斥 |
| 8 | I-20「`routeOutboxes` 超長就 reject」較差 | 部分 | 部分 | 一致 | 管不到 dispatcher 直接 deliver 的信、會多一次 wake，這兩點屬實；但「較差」是取捨，不是被證據推翻，原報告也列了 prompt 截斷（`review-analysis-reports.md:153`） |
| 9 | I-21「COMMON 超過 8 KB 就擋 done」有風險 | 部分 | 維持推翻（限定在「沒排除 solo、沒規劃升級」的硬擋） | **⚠ 不一致** | RD：只有靜態依據，沒有實作拒絕器重現鎖死；原報告也允許只補文件。CA：solo 無權縮減 COMMON 是真實情境，records 的同型鎖死已經用 fake 重現；預設採不阻擋的提醒較合適 |
| 10 | I-23 的優先順序提案自相矛盾 | 部分 | 部分 | 一致 | 漏了其他指示來源這點成立；「明示 task 壓過 Rules」與「必然矛盾」沒有原文依據 |
| 11 | I-10「R1 漏寫 COMMON 注入」 | 維持推翻 | — | — | R1:7,22,84 都有；真正的缺口在 R1:96 |
| 12 | I-02「R2:165 呼叫點寫錯」「必須在 beginAttempt 前選」 | 部分 | 維持推翻 | **⚠ 不一致** | 兩人都同意「不一定要在 beginAttempt 前」（新 attempt 是 started，候選條件是 failed）。CA（CA-24）：R2 沒有指定錯誤的呼叫點，只提了兩處；建議撤回「寫錯／必須在 beginAttempt 前」，整條仍判維持推翻。RD（RD-02）：另外指出「R2:165 寫錯」根本不是評估報告提出的指控，被審查文件轉述錯了，所以判部分。兩人為什麼給出不同的總判定，原信沒有說明，未知 |
| 13 | I-05 等「標推論／未驗證」 | 維持推翻 | — | — | 7 個 started 都是各 run 的最後事件；parked 與 outbox 全部吻合；stdout 0 B（QR 也獨立重算吻合） |
| 14 | I-06「Memory 段已有同樣要求」 | 維持推翻 | 維持推翻 | 一致 | `prompt.ts:211–215` 對照 R2:102 |
| 15 | I-25 修法「`src/` 與 HEAD f41a39c 無差異」 | 部分 | — | — | 不是 main 的祖先這點屬實；「clear 後就消失」太強（RD-06、DR-03） |
| 16 | I-26「截至 run 052756 前」 | 維持推翻 | — | — | 第 17 個是 c0594a、第 18 個是 d52bff |
| 17 | 「摘要 9 條、儲存格 >400 字」 | 維持推翻 | — | — | 10 條；386 字（去掉兩側空白是 384；刪掉所有空白則是 361，文件的「去空白」應讀成去兩側空白） |
| 18 | 各處引用行號 | 部分 | — | — | 多數更正正確；I-11 的 tidy 引用本來就有用處（RD-08） |
| 19 | §9 前 5 項漏了 I-20、I-21 | 部分 | — | — | 漏列屬實；要不要放進前五是判斷 |
| 20 | R1、R2 偏差用了同一標準 | 維持推翻 | — | — | `claude.ts:13,20`；R2:72,114 |
| 21 | I-28「grep 35–40」 | 部分 | — | — | 31／47／48 可以重現，但推翻不了另一組詞表的數字（RD-04） |

**統計**：RD（21 條）維持推翻 11、部分 9、應恢復為成立 1。CA（9 條）維持推翻 7、部分 2。兩人都審的 9 條中，一致 5 條（#2、#3、#8、#10、#14），不一致 4 條（#6、#7、#9、#12）。沒有任何一條被兩人一致判為「應恢復為成立」。

## 5. Codex 與先前 Claude 審查的差異

這裡的「Claude 審查」指被審查文件本身（作者與審查者都是 Claude）。

### 5.1 Codex 找到、Claude 沒找到的

- **反例與轉述錯誤**：2d1b53 不是「已有 session 的 lead」的反例（RD-01）；評估報告沒說過「R2:165 寫錯」（RD-02）；「task 放在 Rules 之上」是過度解讀（RD-03）；換詞表推翻不了原數字（RD-04）；原報告列的替代方案在轉述時被拿掉（RD-05）。
- **Git 基準**：「clear 後 commit 消失」說太強（RD-06、DR-03）；確認基準的方法會放行 snapshot（QR-01）。
- **C 類修法的副作用**：C-03 的新規則仍會錯關 F，且有 fake 反例（CA-03）；C-06 的方向會放過越權寫入（CA-06）；「`status --json` 逐字不變」不可能成立（CA-07）；prompt 本來就有 COMMON 截斷提醒（CA-09）；C-11 依賴會輪替的 log（CA-11）；C-13 的 rg 指令會漏抓（CA-13）；C-14 會拿掉授權的能力（CA-14）。
- **B 類事實**：tidy 其實讀得到 COMMON（DR-01）；B-05 的改前不是 R1 原文（DR-02）；R2 的觸發條件本來就是絕對數（DR-04）；G 只限成員（DR-05）；B-13 的理由自相矛盾（DR-08）。
- **可重現性**：C-01 的 `head -3` 截掉了目標事件（QR-02）；A-08 的腳本只驗證了一部分（QR-03）；A-11 的 25／5／1 沒有母體（QR-04）；部分指令缺 cwd（QR-05）。
- **可讀性**：本輪新增了 11 條針對這份修正清單本身的新手可讀性意見（DR-10…DR-20）。原文件已有新手導讀與名詞小字典，所以這些是補充，不是說先前完全沒顧到可讀性。

### 5.2 Claude 列為「未解答」，Codex 用 fake runtime 補上的

- **I-08／C-06 端到端**：兩個真 git worktree 的 fake run 重現了「A 的 guard 還原 B 合法寫入的 COMMON 並刪掉 b.md」（CA-06）。
- **C-10 單人鎖死**：用 route probe 與 runTeam 的假 invoker 重現；並更正「max_rounds 用完」這個說法（預設沒有上限）（CA-10）。
- **C-15 attempt id 碰撞**：實跑確認會覆蓋有效的 a2（CA-15）。
- **C-14**：確認了 Codex 收到的 writable roots 內容；真實 OS 沙箱的行為仍未驗證。

### 5.3 Claude 認定、Codex 不同意的

- **被推翻 #7**：Claude 判為推翻；RD 認為應恢復為成立（CA 維持推翻，見第 4 節）。
- **被推翻 #6、#8、#9、#10、#12、#15、#18、#19、#21**：Claude 列為「被推翻」，RD 或 CA 認為只是部分，或屬設計取捨而非事實錯誤。
- **C-16「lead 永遠看不到新的系統提示」**：CA、QR 都認為 help 只支持「compact 之前」。
- **C-09「agent 不知道 COMMON 被截斷」**：CA 認為不成立。

### 5.4 Claude 與 Codex 一致的

統計 22／9、被推翻 21 條、43 條執行順序、語料數字（147／179／15,357 B／p95）、61 封／11 個 run、request-changes 8／15、attempts 的狀態分佈，都被 Codex 獨立重算確認。多數 `檔案:行號` 引用在 HEAD 成立（確認清單共 105 處）。

## 6. 審查者之間的其他分歧

- **「clear 後 commit 消失」的嚴重度**：RD-06 判低（minor），DR-03 判高（major）。兩人的事實判斷相同。
- **「35–40」的處理**：RD-04 判中（major，從「被推翻」撤回）；DR-04 判中（minor，從 B-12 的改前更正）。兩人看的角度不同（A 類 vs B 類），問題是同一個。

## 7. 未驗證與限制

- 沒有呼叫付費模型：F1（snapshot）、Claude resume 是否包含被殺那次的 turns、Codex 是否載入 `AGENTS.md` 都仍未實測。
- fake runtime 只驗證了 dispatcher／guard 機制，證明不了模型會不會照提示做，也證明不了真實 OS 沙箱的權限。
- 沒有在 Linux 上跑。沒有人執行完整的 `npm test`：這次是純審查，沒有程式修改需要驗收。CA 的 `npm run typecheck` 與 DR 的 `node --import tsx src/cli.ts …` 因為 worktree 缺 `node_modules`（TS2688／ERR_MODULE_NOT_FOUND）而無法驗證。
- B-07／B-08 的歷史實驗（user 層級 CLAUDE.md、能不能讀他人 memory）這次沒有重現，只核對了程式與標籤。
- 可讀性意見是審查者以新手角度推論的，沒有找真正的新手實際閱讀。
- 本文只彙整四位 Codex 審查者的結論；lead 只抽查了 RD-01、DR-01、CA-09 的原始證據。
