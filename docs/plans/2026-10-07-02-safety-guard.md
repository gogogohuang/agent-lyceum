# Guard 違規內容留存 實作計畫

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `ProtectedGuard` 還原或刪除受保護檔案之前，先把違規版本存進 run 目錄，並在 log 與給 lead 的訊息中指出位置與 sha256。

**Architecture:** `Violation` 增加 `saved`／`sha256`／`truncated` 三個選用欄位。`ProtectedGuard` 從已綁定 run 的 `project.run.dir` 推得 `violations/` 目錄；未綁定 run 時（舊測試的用法）只算 sha256、不寫檔，行為與現況相同。dispatcher 原本就把整個 `Violation` 寫進 log，所以只需改給 lead 的訊息。

**Tech Stack:** TypeScript ESM、`node:crypto`、Vitest。

**Spec:** `docs/specs/02-safety-guard.md`

## Global Constraints

- `guard.check(running)` 簽章與回傳型別名稱不變。
- 單檔留存上限 1 MiB，超過只存前 1 MiB 並標記 `truncated: true`。
- 檔案被違規者刪除（`now === null`）時不留存內容，也沒有 sha256。
- 既有測試 `expect(v).toEqual([{ file, action: "removed", suspects: [...] }])` 必須不改動就通過（未綁定 run 時不得新增有值的欄位；`toEqual` 會忽略 `undefined`，但不可寫入 `sha256`，故未綁定 run 時也不計算 sha256）。

---

### Task 1: 在 guard 內留存違規版本

**Files:**
- Modify: `src/guard.ts`
- Test: `test/dispatcher.test.ts`（既有的 `describe("guard", ...)` 區塊，約第 380 行）

**Interfaces:**
- Produces:
  - `export const MAX_KEEP_BYTES = 1024 * 1024`
  - `Violation` 新增 `saved?: string; sha256?: string; truncated?: boolean`
  - 有綁定 run 時，違規版本存到 `<run.dir>/violations/<NNN>-<安全檔名>`，`NNN` 為該目錄現有檔數加一、補零到三位。

- [ ] **Step 1: 寫失敗的測試**

在 `test/dispatcher.test.ts` 的 `describe("guard", ...)` 區塊內、既有 `it` 之後加入。檔案頂端若尚無，補上 `import { createHash } from "node:crypto";` 與 `import { bindRunProject } from "../src/run-store.js";`、`import { MAX_KEEP_BYTES } from "../src/guard.js";`（`ProtectedGuard` 已 import，併入同一行）。

```ts
  const bound = () => {
    const runDir = path.join(env.root, "run-1");
    return { runDir, p: bindRunProject(env.project(), runDir, "run") };
  };

  it("keeps the rejected version of a protected file before restoring it", () => {
    env = makeEnv();
    const { runDir, p } = bound();
    const g = new ProtectedGuard(p);
    const md = p.agents["fe-member"].agentMd;
    const original = fs.readFileSync(md, "utf8");
    fs.writeFileSync(md, "rewritten persona");
    const [v] = g.check([p.agents["fe-member"]]);
    expect(v.action).toBe("restored");
    expect(fs.readFileSync(md, "utf8")).toBe(original);
    expect(path.dirname(v.saved!)).toBe(path.join(runDir, "violations"));
    expect(path.basename(v.saved!)).toMatch(/^001-/);
    expect(fs.readFileSync(v.saved!, "utf8")).toBe("rewritten persona");
    expect(v.sha256).toBe(createHash("sha256").update("rewritten persona").digest("hex"));
  });

  it("keeps a protected file that an unauthorized agent created, then removes it", () => {
    env = makeEnv();
    const { p } = bound();
    const g = new ProtectedGuard(p);
    const f = path.join(env.repo, "AGENTS.md");
    fs.writeFileSync(f, "new");
    const [v] = g.check([p.agents["fe-member"]]);
    expect(v.action).toBe("removed");
    expect(fs.existsSync(f)).toBe(false);
    expect(fs.readFileSync(v.saved!, "utf8")).toBe("new");
  });

  it("records no content when an agent deleted a protected file", () => {
    env = makeEnv();
    const { p } = bound();
    const g = new ProtectedGuard(p);
    const md = p.agents["fe-member"].agentMd;
    fs.rmSync(md);
    const [v] = g.check([p.agents["fe-member"]]);
    expect(v.action).toBe("restored");
    expect(fs.existsSync(md)).toBe(true);
    expect(v.saved).toBeUndefined();
    expect(v.sha256).toBeUndefined();
  });

  it("numbers kept versions across guards so a resumed run does not overwrite earlier ones", () => {
    env = makeEnv();
    const { p } = bound();
    const md = p.agents["fe-member"].agentMd;
    fs.writeFileSync(md, "first"); // baseline of guard a
    const a = new ProtectedGuard(p);
    fs.writeFileSync(md, "second");
    const [v1] = a.check([p.agents["fe-member"]]);
    fs.writeFileSync(md, "third"); // baseline of guard b (a resumed run builds a new guard)
    const b = new ProtectedGuard(p);
    fs.writeFileSync(md, "fourth");
    const [v2] = b.check([p.agents["fe-member"]]);
    expect(path.basename(v1.saved!)).toMatch(/^001-/);
    expect(path.basename(v2.saved!)).toMatch(/^002-/);
    expect(fs.readFileSync(v1.saved!, "utf8")).toBe("second");
  });

  it("keeps at most MAX_KEEP_BYTES of a huge rejected file and says so", () => {
    env = makeEnv();
    const { p } = bound();
    const g = new ProtectedGuard(p);
    const md = p.agents["fe-member"].agentMd;
    fs.writeFileSync(md, Buffer.alloc(MAX_KEEP_BYTES + 10, "x"));
    const [v] = g.check([p.agents["fe-member"]]);
    expect(v.truncated).toBe(true);
    expect(fs.statSync(v.saved!).size).toBe(MAX_KEEP_BYTES);
  });
```

- [ ] **Step 2: 確認失敗**

Run: `npx vitest run test/dispatcher.test.ts -t guard`
Expected: FAIL（`MAX_KEEP_BYTES` 不是匯出、或 `v.saved` 為 undefined）

- [ ] **Step 3: 實作 `src/guard.ts`**

(a) 檔頭 import 加 `import crypto from "node:crypto";`。

(b) 取代 `Violation` 介面：

```ts
export interface Violation {
  file: string;
  action: "restored" | "removed";
  suspects: string[];
  /** Where the rejected version was kept (only for a project bound to a run, and when the file still existed). */
  saved?: string;
  sha256?: string;
  /** The kept copy is cut to MAX_KEEP_BYTES. */
  truncated?: boolean;
}

export const MAX_KEEP_BYTES = 1024 * 1024;

function safeName(file: string): string {
  return file.replace(/[\\/:]/g, "_").replace(/^_+/, "");
}
```

(c) `saveSnapshot` 內的 `const safe = file.replace(/[\\/:]/g, "_").replace(/^_+/, "");` 改為 `const safe = safeName(file);`。

(d) 在 `check` 方法之前加入私有方法：

```ts
  /** Keep what an agent wrote into a protected file before it is reverted. Nothing is written without a bound run. */
  private keep(file: string, content: Buffer | null): Pick<Violation, "saved" | "sha256" | "truncated"> {
    const run = this.project.run;
    if (!content || !run) return {};
    const sha256 = crypto.createHash("sha256").update(content).digest("hex");
    const dir = path.join(run.dir, "violations");
    fs.mkdirSync(dir, { recursive: true });
    const n = String(fs.readdirSync(dir).length + 1).padStart(3, "0");
    const saved = path.join(dir, `${n}-${safeName(file)}`);
    const truncated = content.length > MAX_KEEP_BYTES;
    fs.writeFileSync(saved, truncated ? content.subarray(0, MAX_KEEP_BYTES) : content);
    return { saved, sha256, ...(truncated ? { truncated } : {}) };
  }
```

(e) 在 `check` 內：

```ts
      if (before === null) {
        const kept = this.keep(file, now);
        fs.rmSync(file, { force: true });
        violations.push({ file, action: "removed", suspects: running.map((a) => a.name), ...kept });
      } else {
        const kept = this.keep(file, now);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, before);
        violations.push({ file, action: "restored", suspects: running.map((a) => a.name), ...kept });
      }
```

（取代原本的兩個分支，其餘不變。）

- [ ] **Step 4: 確認通過**

Run: `npx vitest run test/dispatcher.test.ts`
Expected: 全 PASS，包含未改動的舊 guard 測試 `removes a protected file that an unauthorized agent created`

- [ ] **Step 5: Commit**

```bash
git add src/guard.ts test/dispatcher.test.ts
git commit -m "feat(guard): keep the rejected version of a protected file before reverting it"
```

---

### Task 2: 通知 lead、deny 清單與文件

**Files:**
- Modify: `src/dispatcher.ts`（`settle` 內約 309–318 行）
- Modify: `src/policy.ts:54`
- Modify: `src/run-cleanup.ts:90`
- Modify: `README.md`、`README.zh-TW.md`（`clear` 說明）
- Test: `test/dispatcher.test.ts`（既有測試 `reverts unauthorized edits to protected files and warns the lead`）

**Interfaces:**
- Consumes: Task 1 的 `Violation.saved`／`sha256`。

- [ ] **Step 1: 擴充既有整合測試（先失敗）**

在 `reverts unauthorized edits to protected files and warns the lead` 測試最後（`events(...)` 那行之後）加：

```ts
    expect(leadPrompt).toContain("kept at");
    expect(fs.readdirSync(path.join(s.runDir, "violations"))).toHaveLength(2);
    expect(events(s.runDir).filter((e) => e.event === "violation").every((e) => typeof e.saved === "string" && typeof e.sha256 === "string")).toBe(true);
```

Run: `npx vitest run test/dispatcher.test.ts -t "warns the lead"`
Expected: FAIL（訊息尚未提到 `kept at`）

- [ ] **Step 2: 改 `settle` 內給 lead 的訊息**

把 `body:` 那行換成：

```ts
        body:
          `\`${v.file}\` was changed without permission and has been ${v.action}. Agents active at the time: ${v.suspects.join(", ")}.` +
          (v.saved ? `\n\nWhat was written is kept at \`${v.saved}\` (sha256 ${v.sha256}${v.truncated ? ", truncated to 1 MiB" : ""}). If it is worth keeping, have an agent that may edit this file redo it.` : ""),
```

- [ ] **Step 3: 把 `violations` 加入 agent 不可寫的 run 紀錄**

`src/policy.ts:54`：

```ts
const RUN_ENTRIES = ["state.json", "log.jsonl", "result.md", "task.md", "snapshots", "violations", "agents", "mail"];
```

- [ ] **Step 4: 更新 `clear` 的預覽文字**

`src/run-cleanup.ts:90` 的 label 中 `(state, log, result, snapshots, mailboxes)` 改為 `(state, log, result, snapshots, kept violations, mailboxes)`。

- [ ] **Step 5: README**

`README.md` 的 `clear` 列中 `its run directory (state, log, result, mailboxes)` 改為 `its run directory (state, log, result, kept copies of reverted protected-file edits, mailboxes)`；`README.zh-TW.md` 對應處加上「被還原的受保護檔案修改的留存副本」。另在兩份 README 的「Write scope／寫入範圍」段落末尾加一句：被還原的內容會存到 `runs/<run-id>/violations/`（zh：「被還原的內容會留存在 `runs/<run-id>/violations/`」）。

- [ ] **Step 6: 全部測試**

Run: `npm run typecheck && npm test`
Expected: 全 PASS（含 `test/run-cleanup.test.ts`、`test/adapters.test.ts` 對 deny 清單的斷言；若某測試斷言完整的 RUN_ENTRIES 清單，補上 `violations`，這是預期的更新）

- [ ] **Step 7: Commit**

```bash
git add src/dispatcher.ts src/policy.ts src/run-cleanup.ts README.md README.zh-TW.md test/dispatcher.test.ts
git commit -m "feat(guard): tell the lead where the reverted edit is kept; protect and document violations/"
```

## Self-Review

- Spec 需求 1（留存）→ T1；2（欄位）→ T1；3（log）→ 既有 `log("violation", { ...v })` 已包含新欄位，T2 Step 1 驗證；4（訊息）→ T2；5（簽章不變）→ T1；6（clear）→ T2 Step 4（整個 run 目錄本來就被刪，這裡只更新預覽文字）。
- 已知取捨：未綁定 run 時不寫檔也不算 sha256，以維持舊測試不變。
- 名稱一致：`MAX_KEEP_BYTES`、`saved`、`sha256`、`truncated`、`keep()` 在兩個 Task 相同。
