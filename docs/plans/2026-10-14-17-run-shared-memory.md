# task 接續用的共享 memory 實作計畫

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 每個 run 有一個交接資料夾：lead 在送 `done` 前把決定、狀態與下一步寫進去，run 被 `resume "追加要求"` 重開後，lead 與所有成員的每次喚醒都帶著它的索引。

**Architecture:** 資料夾放在 `task-memory/<run-id>/_shared/`（`clear` 本來就整個 `task-memory/<run-id>` 一起刪）。`src/policy.ts` 新增 `sharedDir`／`sharedIndex` 與 `WritePolicy.readDirs`：lead 的 `allowDirs` 含它，其他 agent 對它唯讀（`deny` + Claude 的 `--add-dir`）。`ProtectedGuard` 多保護 `_shared/MEMORY.md`（Codex 沒有 OS 沙箱時的事後還原）。`src/prompt.ts` 告訴 lead 結束前要寫、重開後的每次喚醒把索引放進 user prompt。`src/run-session.ts` 建立資料夾、在重開的 task mail 指出它、並在 lead 沒更新就 `done` 時記一筆 note。

**Tech Stack:** TypeScript ESM、Node `fs`、Vitest、Biome。不新增依賴。

**Spec:** `docs/specs/17-run-shared-memory.md`（決議 1–8）。與 spec 的兩處差異見下方 Global Constraints，Task 3 會同步改 spec。

## Global Constraints

- Node >=20，macOS 與 Linux；不新增依賴。
- 預設行為不變：沒有重開過的 run、舊 run（沒有 `_shared/`）、`call`（沒有 run）的 prompt 與 `state.json` 完全照舊，除了 lead 的 system prompt 多一段、以及 lead 沒更新就 `done` 時多一則 note。
- 只有 lead 寫（`agent.name === project.lead`，`run --agent` 的單獨 agent 就是它那一人團隊的 lead）。成員唯讀。不新增 `can_write_shared`、不新增 mail 類型。程式、prompt、文件與測試不得寫死任何 agent 名稱。
- 資料夾名稱是 `_shared`，不是 spec 17 原寫的 `shared`：agent 名稱必須符合 `NAME_RE`（`/^[A-Za-z0-9][A-Za-z0-9_-]*$/`，開頭是英數），所以 `_shared` 不可能和某個 agent 的 `task-memory/<run-id>/<agent>` 撞名，而 `shared` 可能。
- 索引上限 `HANDOFF_LIMIT = COMMON_LIMIT`（8 KB），超過截斷並提示。只有 `MEMORY.md` 會放進 prompt，其他檔案按需讀。
- 沙箱設定不改：Claude `allowUnsandboxedCommands: false`、Codex `-s workspace-write`；`_shared` 對成員只是不加入可寫清單、加入 `deny`。
- lead 沒更新就 `done` 不阻擋結束，只記 note `shared-not-updated`。
- 破壞相容性或新增行為時，同步更新 `README.md`、`README.zh-TW.md`、`docs/commands.md`、`docs/commands.zh-TW.md`，並通過 `npm run check:docs`（中英標題結構必須一致）。
- 每個 Task 結束時 `npm run typecheck`、`npm test`、`npm run lint` 都要通過。
- Commit 訊息結尾加：`Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`（執行時若系統提示給了別的 attribution，以系統提示為準）。發版不在這份計畫內。

## File Structure

| 檔案 | 責任 |
|---|---|
| `src/policy.ts` | `SHARED_DIR`、`sharedDir`、`sharedIndex`；`WritePolicy.readDirs`；`writePolicy` 與 `enforcementFor` 的 `shared` 規則 |
| `src/adapters/claude.ts` | `--add-dir` 加入 `readDirs`（成員可讀不可寫） |
| `src/guard.ts` | `protectedFiles` 加 `_shared/MEMORY.md` |
| `src/mailbox.ts` | `ensureProjectDirs` 建立 `_shared` |
| `src/validate.ts` | strict 檢查與 `formatEnforcement` 的 `shared` 欄 |
| `src/prompt.ts` | `HANDOFF_LIMIT`、`handoffRule`、lead／單獨 agent 的 system prompt、`buildUserPrompt` 的交接區塊 |
| `src/run-session.ts` | 重開後把交接旗標傳給 `buildUserPrompt`；`Upstream` 指向索引；`shared-not-updated` |
| `test/shared-memory.test.ts`（新增） | 本計畫全部新測試 |
| `test/run-cleanup.test.ts` | `clear` 一併刪 `_shared` |
| `README*.md`、`docs/commands*.md`、`docs/specs/17-*.md`、`docs/specs/README.md` | 文件與狀態 |

---

### Task 1: 交接資料夾、寫入規則、guard 與強制層級

**Files:**
- Modify: `src/policy.ts`、`src/adapters/claude.ts`、`src/guard.ts`、`src/mailbox.ts`、`src/validate.ts`
- Test: `test/shared-memory.test.ts`（新增）

**Interfaces:**
- Produces（Task 2 依賴這些名稱與形狀）：
  - `export const SHARED_DIR = "_shared"`
  - `export function sharedDir(project: ResolvedProject): string | undefined` — 綁定到 run 且不是 `call` 時為 `<taskMemory>/<run-id>/_shared`，否則 `undefined`
  - `export function sharedIndex(project: ResolvedProject): string | undefined` — `sharedDir` 下的 `MEMORY.md`
  - `WritePolicy.readDirs: string[]`
  - `AgentEnforcement.shared: Level`

- [ ] **Step 1: 寫失敗測試**

建立 `test/shared-memory.test.ts`：

```ts
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildClaudeInvocation, buildClaudeSettings } from "../src/adapters/claude.js";
import { codexWritableRoots } from "../src/adapters/codex.js";
import { ProtectedGuard } from "../src/guard.js";
import { enforcementFor, sharedDir, sharedIndex, writePolicy } from "../src/policy.js";
import { bindRunProject } from "../src/run-store.js";
import { makeEnv, write, type ClaudeSettingsView, type TestEnv } from "./helpers.js";

let env: TestEnv;
afterEach(() => env?.cleanup());

const bound = () => bindRunProject(env.project(), path.join(env.root, "run-1"), "run");

describe("the handoff folder: where it is and who may write it", () => {
  it("sits in the run's task memory under a name no agent can have, and only for a run", () => {
    env = makeEnv();
    const p = bound();
    expect(sharedDir(p)).toBe(path.join(p.paths.taskMemory, "run-1", "_shared"));
    expect(sharedIndex(p)).toBe(path.join(sharedDir(p) as string, "MEMORY.md"));
    expect(sharedDir(env.project())).toBeUndefined(); // not bound to a run
    expect(sharedDir({ ...p, solo: "call" })).toBeUndefined();
  });

  it("only the lead may write it; everyone else may read it but is denied", () => {
    env = makeEnv();
    const p = bound();
    const dir = sharedDir(p) as string;
    const lead = writePolicy(p, p.agents.lead);
    expect(lead.allowDirs).toContain(dir);
    expect(lead.allowFiles).toContain(sharedIndex(p));
    expect(lead.deny).not.toContain(dir);
    expect(lead.readDirs).not.toContain(dir);
    const member = writePolicy(p, p.agents["fe-member"]);
    expect(member.allowDirs).not.toContain(dir);
    expect(member.allowFiles).not.toContain(sharedIndex(p));
    expect(member.deny).toContain(dir);
    expect(member.readDirs).toEqual([dir]);
  });

  it("policies outside a run are exactly what they were", () => {
    env = makeEnv();
    const p = env.project();
    expect(writePolicy(p, p.agents["fe-member"]).readDirs).toEqual([]);
    expect(writePolicy(p, p.agents.lead).allowDirs.some((d) => d.endsWith("_shared"))).toBe(false);
  });

  it("Claude: a member can read the folder (--add-dir) but the sandbox does not let it write there; the lead can write", () => {
    env = makeEnv();
    const p = bound();
    const dir = sharedDir(p) as string;
    const member = buildClaudeSettings(p, p.agents["fe-member"]) as unknown as ClaudeSettingsView;
    expect(member.sandbox.filesystem.allowWrite).not.toContain(dir);
    expect(member.sandbox.filesystem.denyWrite).toContain(dir);
    const lead = buildClaudeSettings(p, p.agents.lead) as unknown as ClaudeSettingsView;
    expect(lead.sandbox.filesystem.allowWrite).toContain(dir);

    const dirsOf = (agent: string) => {
      const inv = buildClaudeInvocation({ project: p, agent: p.agents[agent], workDir: path.join(env.root, `work-${agent}`), systemPrompt: "s", userPrompt: "u", timeoutSec: 60 });
      return inv.args.flatMap((x, i) => (x === "--add-dir" ? [inv.args[i + 1]] : []));
    };
    expect(dirsOf("fe-member")).toContain(dir);
    expect(dirsOf("lead")).toContain(dir);
  });

  it("Codex: the folder is a writable root for the lead only", () => {
    env = makeEnv();
    const p = bound();
    const dir = sharedDir(p) as string;
    const roots = (agent: string) => codexWritableRoots({ project: p, agent: p.agents[agent], workDir: env.root, systemPrompt: "s", userPrompt: "u", timeoutSec: 60 });
    expect(roots("lead")).toContain(dir);
    expect(roots("fe-member")).not.toContain(dir);
  });

  it("the guard puts back a member's edit of the handoff index and lets the lead write it", () => {
    env = makeEnv();
    const p = bound();
    const idx = sharedIndex(p) as string;
    const g = new ProtectedGuard(p);
    write(idx, "a member was here\n");
    expect(g.check([p.agents["fe-member"]])).toMatchObject([{ file: idx, action: "removed", suspects: ["fe-member"] }]);
    expect(fs.existsSync(idx)).toBe(false);
    g.rebase();
    write(idx, "- decisions: see decisions.md\n");
    expect(g.check([p.agents.lead])).toEqual([]);
    expect(fs.readFileSync(idx, "utf8")).toContain("decisions");
  });

  it("reports a shared level: n/a for the lead, a real level for members", () => {
    env = makeEnv();
    const p = bound();
    expect(enforcementFor(p, p.agents.lead).shared).toBe("n/a");
    const m = enforcementFor(p, p.agents["fe-member"]);
    expect(["os", "tool-rules", "post-hoc"]).toContain(m.shared);
  });
});
```

注意：`ClaudeSettingsView` 的實際欄位以 `test/helpers.ts` 為準；若沒有 `sandbox.filesystem`，改成 `buildClaudeSettings` 回傳物件的實際路徑（`src/adapters/claude.ts` 的 `sandbox.filesystem.allowWrite`／`denyWrite`），不要改被測程式。`WakeInput`／`Invocation` 的欄位以 `src/adapters/types.ts` 為準。

- [ ] **Step 2: 確認測試失敗**

Run: `npx vitest run test/shared-memory.test.ts`
Expected: FAIL（`sharedDir`、`readDirs`、`shared` 不存在）

- [ ] **Step 3: 實作**

`src/policy.ts`：

1. `AgentEnforcement` 加一行（`otherContext: Level;` 之後）：`shared: Level;`
2. `WritePolicy` 加一個欄位（`allowDirs` 之後）：

```ts
  /** Directories the agent may read besides the repo and its writable ones, but must not write (the run's handoff notes, for everyone but the lead). */
  readDirs: string[];
```

3. 在 `memoryDirs` 之後加：

```ts
/** Folder name of a run's handoff notes inside `task-memory/<run-id>/`. Agent names start with a letter or digit, so it cannot be an agent's own folder. */
export const SHARED_DIR = "_shared";

/** The run's handoff folder: read by every agent, written only by the lead. Undefined outside a run and for `call`. */
export function sharedDir(project: ResolvedProject): string | undefined {
  if (!project.run || project.solo === "call") return undefined;
  return path.join(project.paths.taskMemory, project.run.id, SHARED_DIR);
}

/** The index of the handoff notes: the one file shown in prompts, and the one the guard watches. */
export function sharedIndex(project: ResolvedProject): string | undefined {
  const dir = sharedDir(project);
  return dir ? path.join(dir, "MEMORY.md") : undefined;
}
```

4. `writePolicy`：把

```ts
  const allowDirs = [...memoryDirs(agent), ...(project.solo === "call" ? [] : [outboxDir(project, agent.name)]), ...(ws ? [ws.gitDir] : [])];
  const allowFiles: string[] = [];
  if (isLead) allowFiles.push(commonFile(project));
```

換成

```ts
  const shared = sharedDir(project);
  const sharedIdx = sharedIndex(project);
  const mayWriteShared = !!shared && agent.name === project.lead;
  const allowDirs = [
    ...memoryDirs(agent),
    ...(project.solo === "call" ? [] : [outboxDir(project, agent.name)]),
    ...(ws ? [ws.gitDir] : []),
    ...(shared && mayWriteShared ? [shared] : []),
  ];
  const allowFiles: string[] = [];
  if (isLead) allowFiles.push(commonFile(project));
  if (mayWriteShared && sharedIdx) allowFiles.push(sharedIdx);
```

在 `deny.push(...runDenyPaths(project), project.paths.config, ...)` 那行之前加：

```ts
  if (shared && !mayWriteShared) deny.push(shared);
```

回傳物件加 `readDirs: shared && !mayWriteShared ? [shared] : [],`（放在 `allowDirs,` 之後）。

5. `enforcementFor`：在 `let e: Omit<...>` 之前加 `const isLeadAgent = agent.name === project.lead;`；claude 分支的 `e = {...}` 加 `shared: isLeadAgent ? "n/a" : lvl,`；codex 分支加 `shared: isLeadAgent ? "n/a" : os ? "os" : "post-hoc",`，並在 codex 分支的 `notes.push(...)` 之後加：

```ts
    if (!isLeadAgent && !os) notes.push("Without the OS sandbox only the handoff index (_shared/MEMORY.md) is checked after each wake-up; other files in _shared are not protected.");
```

`src/adapters/claude.ts`：`addDirs` 那行改成

```ts
  const addDirs = [...pol.allowDirs, ...pol.readDirs, ...pol.allowFiles.map((f) => path.dirname(f))].filter((d) => !(d === repo || d.startsWith(repo + path.sep)));
```

`src/guard.ts`：import 加 `sharedIndex`（`import { commonFile, mayEditProtected, repoInstructionFiles, sharedIndex } from "./policy.js";`），`protectedFiles` 的 `for (const f of repoInstructionFiles(project)) files.add(f);` 之後加：

```ts
    const handoff = sharedIndex(project);
    if (handoff) files.add(handoff);
```

`src/mailbox.ts`：import `sharedDir`（和 `inboxDir`、`outboxDir` 同一行的 import），`ensureProjectDirs` 的 `fs.mkdirSync(path.join(project.paths.shared, "common"), ...)` 之後加：

```ts
  const handoff = sharedDir(project);
  if (handoff) fs.mkdirSync(handoff, { recursive: true });
```

`src/validate.ts`：strict 迴圈改成

```ts
      for (const k of ["memory", "agentMd", "otherContext", "shared"] as const) {
        if (e[k] !== "os" && !(k === "shared" && e[k] === "n/a")) err(`strict: agent "${e.agent}" ${k} protection is "${e[k]}", not OS-enforced.`);
      }
```

`formatEnforcement`：`header` 在 `"others' ctx"` 之後加 `"handoff"`，`rows.push([...])` 在 `e.otherContext` 之後加 `e.shared`。

- [ ] **Step 4: 確認測試通過**

Run: `npx vitest run test/shared-memory.test.ts test/adapters.test.ts test/dispatcher.test.ts test/validate.test.ts test/doctor.test.ts && npm run typecheck`
Expected: PASS。若既有測試斷言 doctor 的欄位表頭，改成含 `handoff` 欄的新表頭（只改期望，不改行為）。

- [ ] **Step 5: Commit**

```bash
git add src test
git commit -m "feat(memory): a per-run handoff folder only the lead can write, guarded and reported by doctor"
```

---

### Task 2: prompt 與 run 流程

**Files:**
- Modify: `src/prompt.ts`、`src/run-session.ts`
- Test: `test/shared-memory.test.ts`

**Interfaces:**
- Consumes: `sharedDir`、`sharedIndex`（Task 1）
- Produces:
  - `export const HANDOFF_LIMIT: number`（= `COMMON_LIMIT`）
  - `buildUserPrompt(project, agent, unread, handleCount = 1, handoff = false)`：`handoff` 為 `true` 且索引存在且非空白時，在 COMMON.md 區塊之後加 `# Handoff notes from earlier segments of this task (<path>)`

- [ ] **Step 1: 寫失敗測試**

在 `test/shared-memory.test.ts` 的 import 補：

```ts
import type { Invoker, WakeInput, WakeResult } from "../src/adapters/index.js";
import { runTeam } from "../src/dispatcher.js";
import { HANDOFF_LIMIT, buildSystemPrompt, buildUserPrompt } from "../src/prompt.js";
import { outboxDir } from "../src/policy.js";
import { loadRunState } from "../src/run-store.js";
import { soloProject } from "../src/solo.js";
import { prepareTask } from "../src/task.js";
import { FULL_DONE } from "./helpers.js";
```

（`outboxDir` 併進既有的 `../src/policy.js` import；`loadRunState` 併進 `../src/run-store.js` import；`FULL_DONE` 併進 `./helpers.js` import。）檔尾加：

```ts
describe("prompts", () => {
  it("the lead is told to write handoff notes before done; a member is not", () => {
    env = makeEnv();
    const p = bound();
    const lead = buildSystemPrompt(p, p.agents.lead);
    expect(lead).toContain("Handoff for follow-ups");
    expect(lead).toContain(sharedDir(p) as string);
    expect(buildSystemPrompt(p, p.agents["fe-member"])).not.toContain("Handoff for follow-ups");
  });

  it("a solo run agent is told too; a call is not", () => {
    env = makeEnv();
    const sp = bindRunProject(soloProject(env.project(), "fe-member"), path.join(env.root, "run-1"), "run");
    expect(buildSystemPrompt(sp, sp.agents["fe-member"])).toContain("Handoff for follow-ups");
    expect(buildSystemPrompt({ ...sp, solo: "call" }, sp.agents["fe-member"])).not.toContain("Handoff for follow-ups");
  });

  it("the user prompt carries the index only when asked to, only when it has text, and caps it", () => {
    env = makeEnv();
    const p = bound();
    const idx = sharedIndex(p) as string;
    write(idx, "- decided: sessions, not JWT\n");
    expect(buildUserPrompt(p, p.agents.lead, [], 1)).not.toContain("Handoff notes");
    const withNotes = buildUserPrompt(p, p.agents["fe-member"], [], 1, true);
    expect(withNotes).toContain(`# Handoff notes from earlier segments of this task (${idx})`);
    expect(withNotes).toContain("decided: sessions, not JWT");

    write(idx, "   \n");
    expect(buildUserPrompt(p, p.agents.lead, [], 1, true)).not.toContain("Handoff notes");

    write(idx, "x".repeat(HANDOFF_LIMIT + 100));
    expect(buildUserPrompt(p, p.agents.lead, [], 1, true)).toContain(`truncated at ${HANDOFF_LIMIT} bytes`);
  });
});

const OK: WakeResult = { ok: true, text: "", exitCode: 0, timedOut: false };
const send = (i: WakeInput, to: string, type: string, subject: string) =>
  write(
    path.join(outboxDir(i.project, i.agent.name), `${Date.now()}-${Math.random()}.md`),
    `---\nto: ${to}\ntype: ${type}\nsubject: ${subject}\n${type === "done" ? "outcome: completed\n" : ""}---\n\n${type === "done" ? FULL_DONE.replace("Shipped.", subject) : `body of ${subject}`}\n`,
  );
const firstSegment = async (invoker: Invoker) => {
  const project = env.project();
  const runDir = path.join(project.paths.runs, "run-1");
  const task = prepareTask({ text: "Build login", cwd: env.root, runDir });
  const summary = await runTeam({ project, task, runDir, log: () => {}, invoker });
  return { project, runDir, summary };
};
/** The lead writes handoff notes, then reports done. */
const leadWritesNotes: Invoker = async (i) => {
  write(path.join(sharedDir(i.project) as string, "MEMORY.md"), "- decided: sessions, not JWT\n");
  send(i, i.agent.name, "done", "first result");
  return OK;
};

describe("a reopened run starts from the handoff notes", () => {
  it("the lead and a member both see them after the reopen, and the first segment's prompts do not", async () => {
    env = makeEnv();
    const first: string[] = [];
    const { project, runDir } = await firstSegment(async (i) => {
      first.push(i.userPrompt);
      return leadWritesNotes(i);
    });
    expect(first.join("\n")).not.toContain("Handoff notes");
    expect((loadRunState(runDir).notes ?? []).some((n) => n.includes("shared-not-updated"))).toBe(false);

    const prompts: Record<string, string[]> = {};
    await runTeam({
      project,
      resume: loadRunState(runDir),
      runDir,
      log: () => {},
      followup: { text: "Also add rate limiting" },
      invoker: async (i) => {
        const seen = (prompts[i.agent.name] ??= []);
        seen.push(i.userPrompt);
        if (i.agent.name !== "lead") send(i, "lead", "reply", "limiter done");
        else if (seen.length === 1) send(i, "fe-member", "task", "do the limiter");
        else send(i, i.agent.name, "done", "second result");
        return OK;
      },
    });
    const idx = path.join(project.paths.taskMemory, "run-1", "_shared", "MEMORY.md");
    for (const who of ["lead", "fe-member"]) {
      const text = (prompts[who] as string[]).join("\n");
      expect(text).toContain("decided: sessions, not JWT");
      expect(text).toContain("# Handoff notes from earlier segments of this task");
    }
    expect((prompts.lead as string[])[0]).toContain(`handoff notes written for follow-ups are in \`${idx}\``);
  });

  it("a lead that does not update the notes before done is noted, not blocked; the run can still be reopened", async () => {
    env = makeEnv();
    const { project, runDir, summary } = await firstSegment(async (i) => {
      send(i, i.agent.name, "done", "first result");
      return OK;
    });
    expect(summary.endReason).toBe("done");
    expect((loadRunState(runDir).notes ?? []).some((n) => n.includes("shared-not-updated"))).toBe(true);

    let seen = "";
    const second = await runTeam({
      project,
      resume: loadRunState(runDir),
      runDir,
      log: () => {},
      followup: { text: "More please" },
      invoker: async (i) => {
        seen = i.userPrompt;
        send(i, i.agent.name, "done", "second result");
        return OK;
      },
    });
    expect(second.endReason).toBe("done");
    expect(seen).not.toContain("Handoff notes");
    expect(seen).not.toContain("handoff notes written for follow-ups");
  });

  it("a run from before the folder existed reopens fine, and the folder is created", async () => {
    env = makeEnv();
    const { project, runDir } = await firstSegment(leadWritesNotes);
    fs.rmSync(path.join(project.paths.taskMemory, "run-1", "_shared"), { recursive: true, force: true });
    const second = await runTeam({
      project,
      resume: loadRunState(runDir),
      runDir,
      log: () => {},
      followup: { text: "More please" },
      invoker: async (i) => {
        send(i, i.agent.name, "done", "second result");
        return OK;
      },
    });
    expect(second.endReason).toBe("done");
    expect(fs.existsSync(path.join(project.paths.taskMemory, "run-1", "_shared"))).toBe(true);
  });
});
```

- [ ] **Step 2: 確認測試失敗**

Run: `npx vitest run test/shared-memory.test.ts`
Expected: FAIL（`HANDOFF_LIMIT`、`Handoff for follow-ups`、`shared-not-updated` 等不存在）

- [ ] **Step 3: 實作**

`src/prompt.ts`：

1. import 改成 `import { commonFile, memoryDirs, outboxDir, repoDirFor, sharedDir, sharedIndex } from "./policy.js";`
2. 在 `MEMORY_INDEX_LIMIT` 那行之後加 `export const HANDOFF_LIMIT = COMMON_LIMIT;`
3. 在 `readPersona` 之後加：

```ts
/** What the lead (or a solo agent) is told about the handoff notes: they are what a reopened task starts from. */
function handoffRule(dir: string): string[] {
  return [
    "",
    "## Handoff for follow-ups",
    `This task may be reopened later with a follow-up request, and the agents woken then start with fresh sessions. Before you send \`done\`, write what they need to carry on into \`${dir}\`: keep a \`MEMORY.md\` index there (one line per entry, pointing at a file) and record the decisions made and why, the interfaces agreed, the current state, what is left and what to do next, and the pitfalls met. Your teammates can read this folder but cannot write it; if a report from a teammate holds something worth keeping, add it yourself. Only the index is shown in prompts, and only the first ${HANDOFF_LIMIT / 1024} KB of it, so keep it short. These notes are about this task only; lessons that outlive it belong in your project or global memory.`,
  ];
}
```

4. `buildSoloSystemPrompt`：在 `lines.push("", "## Memory");` 之前加

```ts
  const shared = sharedDir(project);
  if (!isCall && shared) lines.push(...handoffRule(shared));
```

5. `buildSystemPrompt`：把

```ts
          "(e.g. build, app start, commit) unticked and say so in the mail instead of reporting them as finished.",
        ]
      : []),
    "",
    "## Memory",
  );
```

換成

```ts
          "(e.g. build, app start, commit) unticked and say so in the mail instead of reporting them as finished.",
        ]
      : []),
    ...(isLead && sharedDir(project) ? handoffRule(sharedDir(project) as string) : []),
    "",
    "## Memory",
  );
```

6. `buildUserPrompt` 簽名改成 `export function buildUserPrompt(project: ResolvedProject, agent: ResolvedAgent, unread: Message[], handleCount = 1, handoff = false): string {`，並在 COMMON.md 區塊結束的大括號之後、`for (const dir of memoryDirs(agent)) {` 之前加：

```ts
  const handoffFile = handoff ? sharedIndex(project) : undefined;
  const notes = handoffFile ? readCapped(handoffFile, HANDOFF_LIMIT) : undefined;
  if (handoffFile && notes && notes.text.trim()) {
    parts.push("", `# Handoff notes from earlier segments of this task (${handoffFile})`, notes.text.trim());
    if (notes.truncated) parts.push(`\n[handoff index truncated at ${HANDOFF_LIMIT} bytes — the lead should condense it.]`);
    parts.push("The other files in that folder are there to read on demand.");
  }
```

`src/run-session.ts`：

1. import：`import { sharedIndex } from "./policy.js";` 併進既有的 `./policy.js` import（若沒有就新增）。
2. 在檔案頂部（`retryPrompt` 之前）加：

```ts
/** The text of a file, "" when it is missing, undefined when there is no such file for this run (no handoff folder). */
function readIndex(file: string | undefined): string | undefined {
  if (!file) return undefined;
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}
```

3. class 欄位區（`private readonly resume: RunState | undefined;` 附近）加：

```ts
  /** The handoff index as this segment started; the lead is noted when it is the same at `done`. */
  private readonly sharedAtStart: string | undefined;
```

4. 建構子末尾的 `this.state = state;` 之後加：`this.sharedAtStart = readIndex(sharedIndex(project));`
5. 重開的 task mail：在 `const legacy = ...; if (...) copyFileSync` 之後加

```ts
        const handoffIdx = sharedIndex(project);
        const handoffLine = handoffIdx && fs.existsSync(handoffIdx) ? ` The handoff notes written for follow-ups are in \`${handoffIdx}\`.` : "";
```

並把 body 的 `## Upstream` 那段結尾 `the original task is in \`${path.join(runDir, "task.md")}\`.\n` 改成 `the original task is in \`${path.join(runDir, "task.md")}\`.${handoffLine}\n`。
6. `wake()` 裡 `userPrompt: buildUserPrompt(project, agent, queue, unread.length),` 改成 `userPrompt: buildUserPrompt(project, agent, queue, unread.length, (state.reopened?.length ?? 0) > 0),`
7. `if (route.done) {` 區塊內、`this.doneMessage = ...` 之前加

```ts
      const handoffIdx = sharedIndex(project);
      if (handoffIdx && this.sharedAtStart !== undefined && readIndex(handoffIdx) === this.sharedAtStart) {
        this.note(`shared-not-updated: the lead did not update the handoff notes (${handoffIdx}) before done, so a follow-up on this run will start without them.`);
      }
```

（`sharedDir` 的建立不用另外做：`ensureProjectDirs(project)` 在建構子裡本來就會呼叫，Task 1 已加上。）

- [ ] **Step 4: 確認測試通過**

Run: `npx vitest run test/shared-memory.test.ts test/run-reopen.test.ts test/dispatcher.test.ts test/solo.test.ts test/run-lifecycle.test.ts && npm run typecheck`
Expected: PASS；既有測試不變（沒有重開的 run 其 user prompt 沒有 `Handoff notes`；lead 的 system prompt 多一段不影響既有斷言）。若有既有測試對 lead 的完整 system prompt 做快照，只更新期望。

- [ ] **Step 5: Commit**

```bash
git add src test
git commit -m "feat(memory): the lead writes handoff notes before done; a reopened run's agents start from them"
```

---

### Task 3: clear、文件與 spec 狀態

**Files:**
- Test: `test/run-cleanup.test.ts`
- Modify: `README.md`、`README.zh-TW.md`、`docs/commands.md`、`docs/commands.zh-TW.md`、`docs/specs/17-run-shared-memory.md`、`docs/specs/README.md`

- [ ] **Step 1: 寫失敗測試（clear 一併刪 `_shared`）**

在 `test/run-cleanup.test.ts` 的 `describe("clear: what is deleted", ...)` 裡加（`makeRun`、`exists`、`write` 都是該檔既有的）：

```ts
  it("removes the run's handoff notes together with its task memory", () => {
    env = makeEnv();
    const p = env.project();
    makeRun("run-a");
    write(path.join(p.paths.taskMemory, "run-a", "_shared", "MEMORY.md"), "- decided: sessions\n");
    const plan = planRunCleanup(p, "run-a");
    expect(plan.refusals).toEqual([]);
    executeRunCleanup(plan);
    expect(exists(p.paths.taskMemory, "run-a")).toBe(false);
  });
```

Run: `npx vitest run test/run-cleanup.test.ts`
Expected: PASS（`clear` 本來就刪整個 `task-memory/<run-id>`；這個測試把行為釘住）

- [ ] **Step 2: 文件**

依實作結果寫，中英結構一致（`npm run check:docs` 會檢查標題）。內容：

- `README.md`／`README.zh-TW.md`：在 "Continuing a finished run"（zh-TW 的對應小節）加一小段「Handoff notes」：lead 在送 `done` 前把決定與理由、介面約定、目前狀態、剩下的事與下一步、踩過的坑寫進 `task-memory/<run-id>/_shared/`（`MEMORY.md` 為索引）；成員可讀不可寫；run 被重開後，lead 與成員的每次喚醒都在 prompt 裡拿到索引（上限 8 KB，超過截斷），重開的 `task` mail 的 `Upstream` 也指向它；lead 沒更新就 `done` 不會被擋，只在 run 的 notes 記 `shared-not-updated`；`clear` 一併刪除；只放這個 task 的筆記，跨 task 的教訓仍放 project／global memory。Write scope 表格若有列 memory，補一列 `_shared`：lead 可寫，其他 agent 唯讀。
- `docs/commands.md`／`docs/commands.zh-TW.md`：`resume` 的追加要求說明加一句指向交接資料夾；`doctor` 的強制層級表多一欄 `handoff` 的說明（`n/a` 表示 lead，因為它可寫）；`clear` 段把 task memory 的說明補上「含交接筆記」。
- `docs/specs/17-run-shared-memory.md`：狀態行改成 `已實作（計畫：docs/plans/2026-10-14-17-run-shared-memory.md）`；全文的 `shared/` 路徑改成 `_shared/`，並在決議 1 加一句原因（agent 名稱開頭必為英數，`_shared` 不會和某個 agent 的資料夾撞名）；決議 3 補「`run --agent` 的單獨 agent 就是它那一人團隊的 lead，同樣寫」。
- `docs/specs/README.md`：17 那列的最後一欄 `（草案）` 改成 `[plan](../plans/2026-10-14-17-run-shared-memory.md)`。

- [ ] **Step 3: 驗證**

Run: `npm run check:docs && npm run typecheck && npm test && npm run lint`
Expected: 全部通過。`npm test` 在慢機器上若有逾時，單獨重跑該檔；也要用沒有 `claude` 的 PATH 跑一次（`env PATH="$(dirname $(which node)):/usr/bin:/bin" npx vitest run`），因為 CI 沒有安裝 `claude`。

- [ ] **Step 4: Commit**

```bash
git add test README.md README.zh-TW.md docs
git commit -m "docs: handoff notes for reopened runs (spec 17)"
```

---

## Self-Review（對照 spec 17）

- 決議 1（run 級資料夾、跟 run 同生命週期）→ Task 1（路徑與建立）、Task 3（`clear` 測試）。
- 決議 2（交接內容）→ Task 2 `handoffRule` 的文字。
- 決議 3（只有 lead 寫、成員唯讀、不新增 `can_write_shared`／mail 類型）→ Task 1 `writePolicy`；成員的發現走 reply，由 `handoffRule` 的「add it yourself」說明。
- 決議 4（重開後每次喚醒帶索引、8 KB、第一次執行不放）→ Task 2 `buildUserPrompt(..., handoff)` 與 `wake()`。
- 決議 5（`Upstream` 指向索引與前一次 `done-<n>.md`）→ Task 2 `handoffLine`（`done-<n>.md` 在 spec 16 已有）。
- 決議 6（沒更新不阻擋，記 `shared-not-updated`）→ Task 2 `sharedAtStart` 比對。
- 決議 7（write guard 與沙箱、doctor 多一類、strict）→ Task 1（`deny`／`readDirs`／guard／`enforcementFor`／`validate.ts`）。
- 決議 8（預設行為不變、tidy 不納入）→ Global Constraints；tidy 只走 global／project，沒有改動。
- 驗收 1 → Task 2 第一個 run 測試；2 → Task 1 的 policy／guard 測試；3 → Task 2 prompt 測試（截斷）；4 → Task 2 第二個 run 測試；5 → Task 2 第一個 run 測試的 `Upstream` 斷言；6 → Task 1 的 `enforcementFor` 測試與 strict 迴圈；7 → Task 2 第三個 run 測試與 Task 3 的 `clear` 測試。
- 與 spec 的差異：資料夾名稱 `_shared`（理由見 Global Constraints）；單獨 agent 也有交接資料夾（`call` 沒有）。兩者 Task 3 都同步進 spec。
- 型別一致：`sharedDir`／`sharedIndex`／`readDirs`／`shared`（Level）／`HANDOFF_LIMIT`／`buildUserPrompt` 的第五個參數 `handoff` 在各 Task 的名稱一致；Task 2 只使用 Task 1 產出的名稱。
- 已知取捨：Codex 沒有 OS 沙箱時，只有索引檔被事後還原，`_shared` 其他檔案沒有保護（doctor 的 notes 會說明）；`shared-not-updated` 在每個沒更新就 `done` 的 run 都會出現（含永遠不會被重開的小任務），這是 spec 決議 6 的字面要求。
