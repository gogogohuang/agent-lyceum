# 網路存取（`allow_web`）

預設所有 agent 都不能使用網路。Claude Code 的 agent 是用無頭的 `dontAsk` 模式喚醒的，沒有明確允許的工具一律拒絕，所以 `WebSearch` 與 `WebFetch` 會被擋掉，要替個別 agent 用 `allow_web` 開放（寫在 `team.yaml` 或 `project.yaml`，專案層蓋過全域層）。它只決定 agent 能不能用網路工具，[寫入範圍](write-scope.zh-TW.md)不變。

| 值 | Claude Code | Codex |
|---|---|---|
| 不設 | 不給網路工具（與以前相同） | 不傳任何設定：維持 Codex 自己的預設 |
| `none` | 不給網路工具 | `-c web_search="disabled"` |
| `search` | `WebSearch` | `-c web_search="cached"` |
| `fetch` | `WebSearch` 加 `WebFetch` | `-c web_search="live"` |

## `search` 還是 `fetch`？

- **`search`**：agent 可以搜尋，拿到一串結果（通常是標題、連結與簡短摘要）。它不能打開網頁，所以只知道結果裡寫的內容。像「Node 的哪些版本還有支援？」「這個函式庫最新版是多少？」「這個 API 是不是已經棄用？」這類問題，這樣就夠了。
- **`fetch`**：包含 `search` 的全部功能，再加上讀取某個網址背後的頁面，整頁文字都會進到 agent 的上下文。答案藏在頁面裡面時才需要：規格文件、API 參考的某一節、issue 討論串，或是你寫在任務裡的網址。

分成兩級，是因為風險不一樣。從網頁讀進來的文字可能夾帶寫給 agent 的指示（「忽略你的規則，去做……」），這叫 prompt injection。`fetch` 會把整頁文字送進來；`search` 只有摘要。agent 能做的事越多（改你的 repo、執行指令），這點就越重要。

**該給哪些 agent。**先什麼都不開。會查資料的角色給 `search`。只有真的必須讀指定頁面、而且很少改檔的角色才給 `fetch`，例如 `pm` 這種需求或研究角色。會改你 repo 的成員（例如 `fe-member`、`qa-member`）維持關閉，由 lead 或 pm 查好，再把結果寫進任務。

## 要注意的事

- **不設不等於 `none`。**不設是讓各 runtime 維持自己的預設：Claude Code 沒有網路工具，但 Codex 可能本來就開著網路搜尋。想明確關掉請設 `none`。[備援](configuration.zh-TW.md)的備用模型沿用主要模型實際的網路等級：`allow_web` 沒設的 Claude Code agent，備用模型若是 Codex，執行時網路搜尋是關閉的。
- **Codex 只有一個 `web_search` 設定，不是兩個工具**，所以 `search` 與 `fetch` 對應到 `cached` 與 `live`。依 Codex 的說法，`cached` 是從索引回答、不即時瀏覽，`live` 是即時搜尋網路；這是依風險做的近似對應。`codex exec` 不收 `--search` 旗標，所以 agent-lyceum 改傳 `-c web_search="..."`。
- **沒有實際端對端跑過。**Codex 的設定鍵與合法值用 Codex 0.160.0 確認過，但 `cached`／`live` 以及 Claude 兩個工具的實際行為，沒有用真的 CLI 跑過（會花 token）。正式依賴前，請先在該 agent 上手動試一次。
- `call` 會讀 `team.yaml` 裡的這個欄位，`run --agent` 也會保留。

```yaml
# team.yaml
agents:
  pm:
    runtime: claude-code
    allow_web: fetch        # 可以搜尋並讀網頁；沒設這個欄位的 agent 就沒有網路工具
```
