# 文件整理 實作計畫

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 README 指令表裡過長的儲存格搬到獨立的指令文件、更新過時的計畫狀態，並讓 CI 檢查中英文結構一致與連結有效。

**Architecture:** 用一支一次性腳本機械式搬移文字（不改寫內容），避免手工搬運出錯；之後用常駐的 `scripts/check-docs.mjs` 防止兩份 README 與指令文件漂移。

**Tech Stack:** Node 腳本（不新增依賴）、GitHub Actions。

**Spec:** `docs/specs/06-documentation.md`

## 已確認的 README 結構（2026-10-07）

- `README.md` 與 `README.zh-TW.md` 的指令表都是第 25 行表頭、第 27–37 行共 11 列；表後依序是三個各佔一行的段落（中止 run、退出碼、未指定 `--project` 時的專案判斷），之後是 `## Monitor mod (Claude Code)`／`## 監控 mod（Claude Code）`。
- 兩份 README 的 `##` 標題都是 5 個，順序相同；`# project.yaml` 是程式碼區塊內的註解，檢查時必須略過。

## Global Constraints

- 只搬移與縮短文字，不改寫既有說明內容，也不改變任何指令行為。
- 退出碼的完整說明只留一份（`docs/commands*.md`），README 只放摘要與連結。
- 中英文文件結構（標題層級與數量）必須一致，內容不要求逐字對應。
- 不新增依賴。

---

### Task 1: 更新計畫文件的狀態

**Files:**
- Modify: `docs/plans/2026-10-06-agent-lyceum-improvements.md`

- [ ] **Step 1: 確認要改的句子存在**

Run: `grep -n "此階段僅建立文件，尚未實作或驗證下列功能" docs/plans/2026-10-06-agent-lyceum-improvements.md`
Expected: 命中 1 行（在 `**Spec:**` 那一行的結尾）

- [ ] **Step 2: 取代**

把該句 `此階段僅建立文件，尚未實作或驗證下列功能。` 換成：

`狀態：已實作並發佈（0.4.x）；本文件保留為設計紀錄，升級說明見 [docs/upgrading-run-v2.md](../upgrading-run-v2.md)。`

- [ ] **Step 3: Commit**

```bash
git add docs/plans/2026-10-06-agent-lyceum-improvements.md
git commit -m "docs: mark the 2026-10-06 plan as implemented"
```

---

### Task 2: 把指令表搬到 `docs/commands*.md`

**Files:**
- Create（一次性，完成後刪除、不 commit）: `scripts/.split-readme-commands.mjs`
- Create: `docs/commands.md`、`docs/commands.zh-TW.md`
- Modify: `README.md`、`README.zh-TW.md`

**Interfaces:**
- Produces: 兩份指令文件，每個指令一個 `##` 標題，並各有「Stopping a run／中止 run」「Exit codes／退出碼」「Choosing the project／選擇專案」三節；README 表格每列只剩用法加一句話與連結。錨點規則 = 標題小寫、空格換 `-`、去掉標點。

- [ ] **Step 1: 建立一次性腳本**

`scripts/.split-readme-commands.mjs`：

```js
import assert from 'node:assert/strict'
import fs from 'node:fs'

const CMDS = [
  { prefix: 'init', heading: 'init', en: 'Create the home and the global agent library.', zh: '建立 home 與全域 agent 庫。' },
  { prefix: 'project add', heading: 'project add', en: 'Register a project.', zh: '註冊專案。' },
  { prefix: 'project list', heading: 'project list and remove', en: 'List or unregister projects.', zh: '列出或取消註冊專案。' },
  { prefix: 'validate', heading: 'validate', en: 'Validate the merged config and show each agent\'s enforcement level.', zh: '驗證設定並顯示每個 agent 的防護等級。' },
  { prefix: 'run', heading: 'run', en: 'Give the task to the lead and run until done.', zh: '把任務交給 lead 並執行到結束。' },
  { prefix: 'resume', heading: 'resume', en: 'Continue an interrupted or failed run.', zh: '接續被中斷或失敗的 run。' },
  { prefix: 'status', heading: 'status', en: 'Show agents, mail, the current wake-up and past runs (`--json`, `--monitor`).', zh: '顯示 agent、信件、目前執行與歷次 run（支援 `--json`、`--monitor`）。' },
  { prefix: 'clear', heading: 'clear', en: 'Delete a run with its task memory and worktrees.', zh: '刪除 run 與其任務記憶、worktree。' },
  { prefix: 'config show', heading: 'config show', en: 'Print every effective setting and where it came from.', zh: '印出每項生效設定與其來源。' },
  { prefix: 'doctor', heading: 'doctor', en: 'Check config, git, the lock and runtime CLIs without running agents.', zh: '不執行 agent，檢查設定、git、鎖與 runtime CLI。' },
  { prefix: 'unlock', heading: 'unlock', en: 'Remove the project lock a crashed run left behind.', zh: '移除當機 run 留下的專案鎖。' },
]

const LOCALES = {
  en: {
    readme: 'README.md',
    out: 'docs/commands.md',
    link: 'docs/commands.md',
    header: /^\| Command \|/,
    more: 'details',
    title: '# Commands\n\nFull reference for every command. The [README](../README.md) has the short version.',
    sections: ['Stopping a run', 'Exit codes', 'Choosing the project'],
    summary: (l) =>
      `Ctrl-C cancels a run cleanly and it can be continued with \`resume\` ([Stopping a run](${l}#stopping-a-run)). \`run\` and \`resume\` exit \`0\` only when the lead reported \`completed\`, \`2\` for partial or blocked, \`1\` for failed, \`130\` for cancelled ([Exit codes](${l}#exit-codes)). Without \`-p\`, the project is inferred from the current directory ([Choosing the project](${l}#choosing-the-project)).`,
  },
  zh: {
    readme: 'README.zh-TW.md',
    out: 'docs/commands.zh-TW.md',
    link: 'docs/commands.zh-TW.md',
    header: /^\| 指令 \|/,
    more: '詳細',
    title: '# 指令\n\n每個指令的完整說明。[README](../README.zh-TW.md) 只放簡短版本。',
    sections: ['中止 run', '退出碼', '選擇專案'],
    summary: (l) =>
      `Ctrl-C 會乾淨地取消 run，之後可用 \`resume\` 接續（[中止 run](${l}#中止-run)）。\`run\`／\`resume\` 只有在 lead 回報 \`completed\` 時才 exit \`0\`；\`partial\`／\`blocked\` 為 \`2\`，\`failed\` 為 \`1\`，取消為 \`130\`（[退出碼](${l}#退出碼)）。未指定 \`-p\` 時，專案由目前目錄推斷（[選擇專案](${l}#選擇專案)）。`,
  },
}

const slug = (h) => h.trim().toLowerCase().replace(/[^\p{L}\p{N} _-]/gu, '').replace(/ /g, '-')

for (const [key, L] of Object.entries(LOCALES)) {
  const lines = fs.readFileSync(L.readme, 'utf8').split('\n')
  const h = lines.findIndex((l) => L.header.test(l))
  assert(h >= 0, `${L.readme}: table header not found`)
  const rowsAt = h + 2 // skip the |---| separator
  const rows = []
  for (let i = rowsAt; lines[i]?.startsWith('| '); i++) rows.push(lines[i])
  assert.equal(rows.length, CMDS.length, `${L.readme}: expected ${CMDS.length} rows, got ${rows.length}`)

  const cells = rows.map((r, i) => {
    const m = r.match(/^\| (.+?) \| (.+) \|$/)
    assert(m, `${L.readme}: row ${i} does not split into two cells`)
    assert(m[1].startsWith('`' + CMDS[i].prefix), `${L.readme}: row ${i} is not "${CMDS[i].prefix}"`)
    return { usage: m[1], text: m[2] }
  })

  // The three one-line paragraphs after the table.
  let at = rowsAt + rows.length
  const paras = []
  while (paras.length < 3) {
    at++
    if (lines[at] === undefined) assert.fail(`${L.readme}: fewer than 3 paragraphs after the table`)
    if (lines[at].trim()) paras.push(lines[at])
  }
  const next = lines.findIndex((l, i) => i > at && l.trim())
  assert(lines[next].startsWith('## '), `${L.readme}: expected a ## heading after the three paragraphs, got: ${lines[next]}`)

  // docs/commands*.md
  const doc = [L.title, '']
  CMDS.forEach((c, i) => doc.push(`## ${c.heading}`, '', `**${key === 'zh' ? '用法' : 'Usage'}:** ${cells[i].usage}`, '', cells[i].text, ''))
  L.sections.forEach((name, i) => doc.push(`## ${name}`, '', paras[i], ''))
  fs.writeFileSync(L.out, doc.join('\n'))

  // README: short rows and one summary paragraph
  const shortRows = CMDS.map((c, i) => `| ${cells[i].usage} | ${c[key]} [${L.more}](${L.link}#${slug(c.heading)}) |`)
  const out = [...lines.slice(0, rowsAt), ...shortRows, '', L.summary(L.link), '', ...lines.slice(next)]
  fs.writeFileSync(L.readme, out.join('\n'))

  // Nothing was lost: every moved cell and paragraph is in the new document.
  const written = fs.readFileSync(L.out, 'utf8')
  for (const c of cells) assert(written.includes(c.text), `${L.out} lost text of ${c.usage}`)
  for (const p of paras) assert(written.includes(p), `${L.out} lost a paragraph`)
  console.log(`${key}: moved ${cells.length} commands and ${paras.length} paragraphs to ${L.out}`)
}
```

- [ ] **Step 2: 執行**

Run: `node scripts/.split-readme-commands.mjs`
Expected:
```
en: moved 11 commands and 3 paragraphs to docs/commands.md
zh: moved 11 commands and 3 paragraphs to docs/commands.zh-TW.md
```
任何斷言失敗（列數、前綴、段落數不符）代表 README 的結構與「已確認的結構」不同：不要硬改腳本，先對照 README 現況回報差異。

- [ ] **Step 3: 檢視結果**

Run: `git diff --stat README.md README.zh-TW.md && sed -n 23,40p README.md | cut -c1-150`
Expected: 表格每列只剩一行短說明加 `[details](docs/commands.md#…)`，表後只有一個摘要段落；README 的 `##` 標題數量不變（5 個）。

- [ ] **Step 4: 刪除一次性腳本並 commit**

```bash
rm scripts/.split-readme-commands.mjs
git add docs/commands.md docs/commands.zh-TW.md README.md README.zh-TW.md
git commit -m "docs: move the command reference out of the README tables"
```

---

### Task 3: `scripts/check-docs.mjs`（中英結構一致與連結有效）

**Files:**
- Create: `scripts/check-docs.mjs`
- Modify: `package.json`（scripts）
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Produces: `npm run check:docs`；通過時印 `docs ok`，失敗時列出每個問題並 exit 1。檢查兩件事：(1) `README.md`／`README.zh-TW.md` 與 `docs/commands.md`／`docs/commands.zh-TW.md` 兩兩的標題層級序列相同（略過程式碼區塊）；(2) 這四份加上 `docs/upgrading-run-v2.md` 內所有相對連結的目標檔案存在，且帶 `#錨點` 的連結在目標檔案中有對應標題。

- [ ] **Step 1: 建立腳本**

`scripts/check-docs.mjs`：

```js
// Fails when the English and Chinese docs drift apart in structure, or a relative link or anchor is broken.
import fs from 'node:fs'
import path from 'node:path'

const PAIRS = [
  ['README.md', 'README.zh-TW.md'],
  ['docs/commands.md', 'docs/commands.zh-TW.md'],
]
const LINKED = [...PAIRS.flat(), 'docs/upgrading-run-v2.md']
const errors = []

const slug = (h) => h.trim().toLowerCase().replace(/[^\p{L}\p{N} _-]/gu, '').replace(/ /g, '-')

/** Headings outside fenced code blocks. */
function headings(file) {
  const out = []
  let fence = false
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (/^```/.test(line)) {
      fence = !fence
      continue
    }
    const m = !fence && line.match(/^(#{1,6}) +(.+?) *$/)
    if (m) out.push({ level: m[1].length, text: m[2] })
  }
  return out
}

for (const [a, b] of PAIRS) {
  const la = headings(a).map((h) => h.level).join('')
  const lb = headings(b).map((h) => h.level).join('')
  if (la !== lb) errors.push(`${a} and ${b} have different heading structure (levels ${la} vs ${lb})`)
}

for (const file of LINKED) {
  let inFence = false
  const lines = fs.readFileSync(file, 'utf8').split('\n')
  lines.forEach((line, i) => {
    if (/^```/.test(line)) inFence = !inFence
    if (inFence) return
    for (const m of line.matchAll(/\]\((?!https?:|mailto:)([^)#\s]*)(#[^)\s]*)?\)/g)) {
      const target = m[1] ? path.normalize(path.join(path.dirname(file), m[1])) : file
      if (!fs.existsSync(target)) {
        errors.push(`${file}:${i + 1} links to missing file ${m[1]}`)
        continue
      }
      if (m[2]) {
        const want = decodeURIComponent(m[2].slice(1))
        if (!headings(target).some((h) => slug(h.text) === want)) errors.push(`${file}:${i + 1} links to missing anchor ${m[1]}${m[2]}`)
      }
    }
  })
}

if (errors.length) {
  console.error(errors.map((e) => `  ${e}`).join('\n'))
  process.exit(1)
}
console.log('docs ok')
```

- [ ] **Step 2: 加 script**

`package.json` 的 `scripts` 新增：

```json
    "check:docs": "node scripts/check-docs.mjs",
```

- [ ] **Step 3: 執行（應通過）**

Run: `npm run check:docs`
Expected: `docs ok`。若列出問題，先判斷是文件真的有誤（修文件）還是腳本的規則太嚴（例如 `docs/upgrading-run-v2.md` 內有刻意的範例連結，則把它從 `LINKED` 移除並在註解說明）。

- [ ] **Step 4: 證明它會失敗**

依序各做一次，確認 `npm run check:docs` 失敗（exit 1），然後用 `git checkout` 還原該檔案：
1. 刪除 `README.zh-TW.md` 的任一個 `##` 標題行 → 報 `different heading structure`。
2. 把 `README.md` 某個 `docs/commands.md#clear` 改成 `docs/commands.md#nope` → 報 `missing anchor`。
3. 把 `README.md` 某個 `docs/commands.md` 改成 `docs/nope.md` → 報 `missing file`。

- [ ] **Step 5: 接入 CI**

`.github/workflows/ci.yml` 在 `npm run typecheck` 之前加一行：`- run: npm run check:docs`。

- [ ] **Step 6: Commit**

```bash
git add scripts/check-docs.mjs package.json .github/workflows/ci.yml
git commit -m "ci: check that the English and Chinese docs match in structure and links resolve"
```

---

### Task 4: 標示 spec 狀態

**Files:**
- Modify: `docs/specs/README.md`、`docs/specs/01-…` 到 `06-…`

- [ ] **Step 1: 在每份已完成的 spec 檔頭加狀態**

每份 spec 的第一個標題下方加一行：`狀態：已完成（PR #<編號>，<YYYY-MM-DD>）`。尚未完成的 spec 不加。

- [ ] **Step 2: 更新索引**

`docs/specs/README.md` 的表格新增一欄「Plan」，填入對應的 `docs/plans/2026-10-07-0N-*.md` 連結。

- [ ] **Step 3: 驗證並 commit**

Run: `npm run check:docs`
Expected: `docs ok`

```bash
git add docs/specs
git commit -m "docs(specs): record status and link each spec to its plan"
```

## Self-Review

- Spec 需求 1 → Task 1；2 → Task 2；3 → Task 4；4（標題一致性檢查）→ Task 3；驗收的「README 表格每格不超過兩行」→ Task 2 Step 3；「連結有效」→ Task 3。
- 搬移由腳本完成並內建斷言（列數、前綴、不遺失文字），避免人工搬運的錯誤；腳本是一次性的，所以不進 repo。
- 名稱一致：`check:docs`、`docs/commands.md`、`docs/commands.zh-TW.md` 與錨點規則在 Task 2、3 相同；三個段落標題 `Stopping a run`／`Exit codes`／`Choosing the project` 與其 zh 版在腳本與摘要連結中相同。
