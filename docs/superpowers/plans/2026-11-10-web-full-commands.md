# Web console: every CLI command from the browser — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the `status --web` page run every CLI command (run, resume, call, clear, tidy, doctor, demo, init, project add/remove, clear --lock), with dangerous ones gated by server-enforced confirmation.

**Architecture:** The web server (package `web/`, built separately from `src/`) gets a pure command table (`web/src/commands.ts`, shared with the page) that validates a JSON body and builds an argv array. A runner spawns the real CLI as a child process, never through a shell: short commands return their output, long ones start detached with an `out.log` and a job record. Everything that needs `src/` (project dirs, the ask-reply file) is injected from `cli.ts` as `console` deps, because `web/` cannot import `src/` (its tsconfig has `rootDir: src`). Writes are guarded by Host + same-origin + per-start CSRF token and are refused when the server is bound to a non-loopback address.

**Tech Stack:** TypeScript (NodeNext), Node `http`/`child_process`, vitest (root), React 19 + Tailwind 4 + Vite (`web/`), pnpm for `web/`.

**Spec:** `docs/superpowers/specs/2026-11-10-web-full-commands-design.md`

## Global Constraints

- Local single-user only; never exposed to the internet. The write API (`POST /api/*`) answers 403 when `--host` is not loopback. There is no flag to enable it.
- Commands are spawned as `process.execPath` + argv **array**, never a shell string. Free-text values (task, follow-up, prompts) go after a `--` so they can never be read as flags.
- Body size limit 256 KB (`BODY_LIMIT = 256 * 1024`). Short commands time out after 120 s.
- Tiers are enforced on the server: `confirm` needs `confirm: true`, `typed` needs `confirmText` equal to the target; otherwise HTTP 428.
- `POST /api/*` needs: valid Host, a present same-origin `Origin`, and header `X-Lyceum-Token` equal to the token injected into `index.html`. `POST /quota` keeps its current behaviour (Origin optional).
- UI text is Traditional Chinese (the existing page is). Reuse the tokens in `web/src/client/styles.css`; add no new palette or fonts. Every control has a visible label and a visible focus ring, touch targets are at least 44 px (`min-h-11`), dialogs use native `<dialog>`, and the submit button disables while a request is in flight.
- Do **not** use git worktrees. Work on a branch: `git switch -c feat/web-console`.
- No version bump, no changelog. Commits only when the user has asked for execution of this plan; each task ends with a commit step.
- Code style: double quotes, semicolons, `.js` extension on relative imports in server and root-test code, no extension in `web/src/client` imports (bundler resolution). `npm run lint` (biome) must pass.

## Clarifications to the spec (decided while planning)

1. `web/` cannot import `src/`, so ask-reply reading/writing and project lookup live in a new `src/web-console.ts` and are injected into `startWebServer` as `console` deps (same pattern as `factory.quota`).
2. Job exit codes are recorded by a tiny inline `node -e` wrapper (no extra file to locate at runtime), so they survive a server restart.
3. Tier and mode are functions of the body (for example `clear` with `dryRun` is `normal`, `tidy` with `dryRun` is `short`), not constants.

## File Structure

| File | Responsibility |
| --- | --- |
| `web/src/commands.ts` (new) | Pure command table: fields, tier, mode, target, `argv(body)` validation. Shared by server and page. |
| `web/src/server/guard.ts` (modify) | Add API write checks (Origin required, token, non-loopback refusal). |
| `web/src/server/runner.ts` (new) | `runShort`, `startJob`, `listJobs`, `readJob`. Spawns the CLI. |
| `web/src/server/api.ts` (new) | `handleApi`: `/api/cmd/:id`, `/api/jobs`, `/api/ask`, `/api/ask/answers`; tier enforcement. |
| `web/src/server/http.ts` (modify) | `serveStatic` injects the CSRF token into `index.html`. |
| `web/src/start.ts` (modify) | Generates the token, passes it to guard and static, routes `/api/*`. |
| `web/index.html` (modify) | `<meta name="lyceum-token" content="__LYCEUM_TOKEN__">`. |
| `src/web-console.ts` (new) | `createConsoleDeps(home, cliFile)`: launcher, project dir lookup, ask read/save. |
| `src/cli.ts` (modify) | Pass `console` deps to `startWebServer`. |
| `web/src/client/api.ts` (new) | `postCommand`, jobs and ask fetchers; sends the token. |
| `web/src/client/dialog-state.ts`, `exit-info.ts` (new) | Pure state machine and exit-code wording (unit tested). |
| `web/src/client/Modal.tsx`, `CommandDialog.tsx`, `AnswerDialog.tsx` (new) | Dialog UI. |
| `web/src/client/RunActions.tsx`, `ToolsPage.tsx`, `JobsPage.tsx` (new) | Entry points. |
| `web/src/client/ProjectView.tsx`, `App.tsx` (modify) | Mount the actions and the two new views. |
| `test/web-commands.test.ts`, `web-guard-api.test.ts`, `web-runner.test.ts`, `web-api.test.ts`, `web-console-start.test.ts`, `web-console.test.ts`, `web-dialog-state.test.ts`, `web-console-coverage.test.ts` (new) | Tests. |
| `docs/web-console.md`, `docs/web-console.zh-TW.md` (new); `docs/commands*.md`, `README*.md`, `scripts/check-docs.mjs` (modify) | Docs. |

---

### Task 1: Command table (`web/src/commands.ts`)

**Files:**
- Create: `web/src/commands.ts`
- Modify: `web/tsconfig.json` (add `"src/commands.ts"` to `include`), `web/tsconfig.client.json` (same)
- Test: `test/web-commands.test.ts`

**Interfaces:**
- Produces:
  - `type Tier = "normal" | "confirm" | "typed"`, `type Mode = "short" | "detached"`
  - `type CommandId = "init" | "project.list" | "project.add" | "project.remove" | "run" | "call" | "resume" | "clear" | "clear.lock" | "doctor" | "tidy" | "demo"`
  - `type Body = Record<string, unknown>`
  - `type Field = { name: string; label: string; kind: "text" | "textarea" | "checkbox" | "select"; required?: boolean; options?: readonly string[]; help?: string }`
  - `class ArgError extends Error { readonly field: string }`
  - `type CommandDef = { id; label: string; scope: "project" | "home"; fields: readonly Field[]; mode(body): Mode; tier(body): Tier; target(body): string; argv(body): string[] }`
  - `const COMMANDS: Record<CommandId, CommandDef>`, `const COMMAND_IDS: CommandId[]`, `const TEXT_LIMIT = 200_000`

- [ ] **Step 1: Write the failing test**

Create `test/web-commands.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { ArgError, COMMANDS, type Body, type CommandId } from "../web/src/commands.js";

const argv = (id: CommandId, body: Body) => COMMANDS[id].argv(body);
const badField = (id: CommandId, body: Body): string | undefined => {
  try {
    COMMANDS[id].argv(body);
  } catch (e) {
    return e instanceof ArgError ? e.field : "not-an-ArgError";
  }
  return undefined;
};

describe("argv", () => {
  it("run: flags first, the task after `--` as one element", () => {
    expect(argv("run", { project: "web", task: "fix it", name: "fix-it", agent: "fe-member", assumeDefaults: true })).toEqual([
      "run", "-p", "web", "--name", "fix-it", "--agent", "fe-member", "--assume-defaults", "--", "fix it",
    ]);
    expect(argv("run", { project: "web", task: "x" })).toEqual(["run", "-p", "web", "--", "x"]);
  });
  it("run: hostile values stay one argv element", () => {
    const task = "--help; rm -rf / && \"quoted\" $(x)";
    const out = argv("run", { project: "web", task });
    expect(out.at(-1)).toBe(task);
    expect(out.at(-2)).toBe("--");
  });
  it("run: rejects bad input with the field name", () => {
    expect(badField("run", { project: "web" })).toBe("task");
    expect(badField("run", { project: "web", task: "x", name: "Bad Name" })).toBe("name");
    expect(badField("run", { project: "../x", task: "x" })).toBe("project");
    expect(badField("run", { project: "web", task: "a\u0000b" })).toBe("task");
    expect(badField("run", { project: "web", task: "x", assumeDefaults: "yes" })).toBe("assumeDefaults");
    expect(badField("run", { project: "web", task: "x".repeat(200_001) })).toBe("task");
  });
  it("resume", () => {
    expect(argv("resume", { project: "web", run: "r1" })).toEqual(["resume", "-p", "web", "--", "r1"]);
    expect(argv("resume", { project: "web", run: "r1", followup: "also do y" })).toEqual(["resume", "-p", "web", "--", "r1", "also do y"]);
    expect(argv("resume", { project: "web", run: "r1", answer: true, assumeDefaults: true })).toEqual([
      "resume", "-p", "web", "--assume-defaults", "--answer", "--no-edit", "--", "r1",
    ]);
    expect(badField("resume", { project: "web", run: "r1", answer: true, followup: "x" })).toBe("followup");
    expect(badField("resume", { project: "web" })).toBe("run");
    expect(badField("resume", { project: "web", run: "-rf" })).toBe("run");
  });
  it("clear and clear.lock", () => {
    expect(argv("clear", { project: "web", run: "r1", dryRun: true, keepWorktrees: true })).toEqual([
      "clear", "-p", "web", "--dry-run", "--keep-worktrees", "--", "r1",
    ]);
    expect(badField("clear", { project: "web" })).toBe("run");
    expect(argv("clear.lock", { project: "web" })).toEqual(["clear", "-p", "web", "--lock", "--force"]);
    expect(argv("clear.lock", { project: "web", run: "r1" })).toEqual(["clear", "-p", "web", "--lock", "--force", "--", "r1"]);
  });
  it("doctor, init, project.*", () => {
    expect(argv("doctor", { project: "web", resolved: true })).toEqual(["doctor", "-p", "web", "--resolved"]);
    expect(argv("init", {})).toEqual(["init", "-y"]);
    expect(argv("project.list", {})).toEqual(["project"]);
    expect(argv("project.add", { name: "web", dir: "/tmp/repo" })).toEqual(["project", "add", "web", "--dir", "/tmp/repo"]);
    expect(badField("project.add", { name: "web", dir: "relative/dir" })).toBe("dir");
    expect(badField("project.add", { name: "-x", dir: "/tmp/r" })).toBe("name");
    expect(argv("project.remove", { name: "web", purge: true })).toEqual(["project", "remove", "web", "--purge"]);
  });
  it("call", () => {
    expect(argv("call", { agent: "qa-member", dir: "/tmp/repo", task: "review" })).toEqual(["call", "qa-member", "--dir", "/tmp/repo", "--", "review"]);
    expect(badField("call", { agent: "qa-member", task: "review" })).toBe("dir");
  });
  it("tidy", () => {
    expect(argv("tidy", { project: "web", agent: "pm", layer: "global", dryRun: true })).toEqual(["tidy", "-p", "web", "--agent", "pm", "--layer", "global", "--dry-run"]);
    expect(argv("tidy", { project: "web", agent: "pm", undo: "20261110T010203" })).toEqual(["tidy", "-p", "web", "--agent", "pm", "--undo", "20261110T010203"]);
    expect(badField("tidy", { project: "web", undo: "s1" })).toBe("agent");
    expect(badField("tidy", { project: "web", agent: "pm", undo: "s1", dryRun: true })).toBe("undo");
    expect(badField("tidy", { project: "web", layer: "other" })).toBe("layer");
  });
  it("demo", () => {
    expect(argv("demo", { runtime: "codex", setupOnly: true })).toEqual(["demo", "-y", "--runtime", "codex", "--setup-only"]);
    expect(badField("demo", { runtime: "gpt" })).toBe("runtime");
  });
});

describe("tier, target, mode", () => {
  const tier = (id: CommandId, body: Body) => COMMANDS[id].tier(body);
  const mode = (id: CommandId, body: Body) => COMMANDS[id].mode(body);
  it("tiers", () => {
    expect(tier("run", {})).toBe("normal");
    expect(tier("clear", { dryRun: true })).toBe("normal");
    expect(tier("clear", {})).toBe("confirm");
    expect(tier("tidy", { dryRun: true })).toBe("normal");
    expect(tier("tidy", {})).toBe("confirm");
    expect(tier("project.remove", {})).toBe("confirm");
    expect(tier("project.remove", { purge: true })).toBe("typed");
    expect(tier("clear.lock", {})).toBe("typed");
  });
  it("typed targets", () => {
    expect(COMMANDS["project.remove"].target({ name: "web", purge: true })).toBe("web");
    expect(COMMANDS["clear.lock"].target({ project: "web", run: "r1" })).toBe("r1");
    expect(COMMANDS["clear.lock"].target({ project: "web" })).toBe("web");
  });
  it("modes", () => {
    for (const id of ["run", "resume", "call"] as const) expect(mode(id, {})).toBe("detached");
    for (const id of ["doctor", "init", "project.list", "project.add", "project.remove", "clear", "clear.lock"] as const) expect(mode(id, {})).toBe("short");
    expect(mode("tidy", {})).toBe("detached");
    expect(mode("tidy", { dryRun: true })).toBe("short");
    expect(mode("tidy", { undo: "s" })).toBe("short");
    expect(mode("demo", {})).toBe("detached");
    expect(mode("demo", { setupOnly: true })).toBe("short");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/web-commands.test.ts`
Expected: FAIL (cannot resolve `../web/src/commands.js`).

- [ ] **Step 3: Write the implementation**

Create `web/src/commands.ts`:

```ts
/** The command table shared by the server (validates a body, builds argv) and the page (draws the forms). Pure: no node imports. */

export type Tier = "normal" | "confirm" | "typed";
export type Mode = "short" | "detached";
export type CommandId = "init" | "project.list" | "project.add" | "project.remove" | "run" | "call" | "resume" | "clear" | "clear.lock" | "doctor" | "tidy" | "demo";
export type Body = Record<string, unknown>;

export type Field = {
  name: string;
  label: string;
  kind: "text" | "textarea" | "checkbox" | "select";
  required?: boolean;
  options?: readonly string[];
  help?: string;
};

export class ArgError extends Error {
  readonly field: string;
  constructor(field: string, message: string) {
    super(message);
    this.field = field;
  }
}

export type CommandDef = {
  id: CommandId;
  label: string;
  /** "project": the child runs in the registered project's repo and `body.project` is required. "home": it runs in the agent-lyceum home. */
  scope: "project" | "home";
  fields: readonly Field[];
  mode: (body: Body) => Mode;
  tier: (body: Body) => Tier;
  /** What the user must type to confirm a `typed` action. */
  target: (body: Body) => string;
  argv: (body: Body) => string[];
};

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const RUN_NAME_RE = /^[a-z0-9-]{1,30}$/;
const PATH_RE = /^(\/|~\/|[A-Za-z]:[\\/])/;
const RUNTIMES = ["claude-code", "codex"] as const;
const LAYERS = ["project", "global"] as const;
export const TEXT_LIMIT = 200_000;

function text(body: Body, name: string, o: { required?: boolean; re?: RegExp; what: string; max?: number }): string | undefined {
  const raw = body[name];
  const empty = raw === undefined || raw === null || (typeof raw === "string" && raw.trim() === "");
  if (empty) {
    if (o.required) throw new ArgError(name, `${o.what}必填。`);
    return undefined;
  }
  if (typeof raw !== "string") throw new ArgError(name, `${o.what}格式不對。`);
  const value = raw.trim();
  if (value.includes("\u0000")) throw new ArgError(name, `${o.what}含有不能用的字元。`);
  if (value.length > (o.max ?? 256)) throw new ArgError(name, `${o.what}太長。`);
  if (o.re && !o.re.test(value)) throw new ArgError(name, `${o.what}格式不對。`);
  return value;
}

function flag(body: Body, name: string): boolean {
  const raw = body[name];
  if (raw === undefined || raw === null || raw === false) return false;
  if (raw !== true) throw new ArgError(name, "這個選項只能是勾選或不勾選。");
  return true;
}

const need = (value: string | undefined): string => value as string;
const project = (b: Body): string => need(text(b, "project", { required: true, re: NAME_RE, what: "專案" }));
const oneOf = (b: Body, name: string, allowed: readonly string[], what: string): string | undefined => {
  const v = text(b, name, { what });
  if (v !== undefined && !allowed.includes(v)) throw new ArgError(name, `${what}只能是 ${allowed.join("、")}。`);
  return v;
};

const PROJECT_FIELD: Field = { name: "project", label: "專案", kind: "text", required: true };
const always = (m: Mode) => () => m;
const normal = (): Tier => "normal";
const noTarget = (): string => "";

export const COMMANDS: Record<CommandId, CommandDef> = {
  init: {
    id: "init",
    label: "初始化 home",
    scope: "home",
    fields: [],
    mode: always("short"),
    tier: normal,
    target: noTarget,
    argv: () => ["init", "-y"],
  },
  "project.list": {
    id: "project.list",
    label: "列出專案",
    scope: "home",
    fields: [],
    mode: always("short"),
    tier: normal,
    target: noTarget,
    argv: () => ["project"],
  },
  "project.add": {
    id: "project.add",
    label: "註冊專案",
    scope: "home",
    fields: [
      { name: "name", label: "專案名稱", kind: "text", required: true },
      { name: "dir", label: "repo 的絕對路徑", kind: "text", required: true, help: "agent 會在這個資料夾工作。" },
    ],
    mode: always("short"),
    tier: normal,
    target: noTarget,
    argv: (b) => {
      const name = need(text(b, "name", { required: true, re: NAME_RE, what: "專案名稱" }));
      const dir = need(text(b, "dir", { required: true, re: PATH_RE, what: "路徑", max: 1024 }));
      return ["project", "add", name, "--dir", dir];
    },
  },
  "project.remove": {
    id: "project.remove",
    label: "移除專案",
    scope: "home",
    fields: [
      { name: "name", label: "專案名稱", kind: "text", required: true },
      { name: "purge", label: "連這個專案的所有 context 一起刪除", kind: "checkbox" },
    ],
    mode: always("short"),
    tier: (b) => (b.purge === true ? "typed" : "confirm"),
    target: (b) => String(b.name ?? ""),
    argv: (b) => {
      const name = need(text(b, "name", { required: true, re: NAME_RE, what: "專案名稱" }));
      return ["project", "remove", name, ...(flag(b, "purge") ? ["--purge"] : [])];
    },
  },
  run: {
    id: "run",
    label: "新任務",
    scope: "project",
    fields: [
      PROJECT_FIELD,
      { name: "task", label: "任務", kind: "textarea", required: true },
      { name: "name", label: "任務名稱（可留空）", kind: "text", help: "小寫英數與 -，最多 30 字。" },
      { name: "agent", label: "只交給這一位 agent（可留空）", kind: "text" },
      { name: "assumeDefaults", label: "有建議值的問題直接採用，不暫停", kind: "checkbox" },
    ],
    mode: always("detached"),
    tier: normal,
    target: noTarget,
    argv: (b) => {
      const out = ["run", "-p", project(b)];
      const name = text(b, "name", { re: RUN_NAME_RE, what: "任務名稱" });
      if (name) out.push("--name", name);
      const agent = text(b, "agent", { re: NAME_RE, what: "agent" });
      if (agent) out.push("--agent", agent);
      if (flag(b, "assumeDefaults")) out.push("--assume-defaults");
      out.push("--", need(text(b, "task", { required: true, what: "任務", max: TEXT_LIMIT })));
      return out;
    },
  },
  call: {
    id: "call",
    label: "呼叫單一 agent",
    scope: "home",
    fields: [
      { name: "agent", label: "agent（全域 library 裡的名稱）", kind: "text", required: true },
      { name: "dir", label: "工作目錄（絕對路徑）", kind: "text", required: true },
      { name: "task", label: "任務", kind: "textarea", required: true },
    ],
    mode: always("detached"),
    tier: normal,
    target: noTarget,
    argv: (b) => {
      const agent = need(text(b, "agent", { required: true, re: NAME_RE, what: "agent" }));
      const dir = need(text(b, "dir", { required: true, re: PATH_RE, what: "工作目錄", max: 1024 }));
      return ["call", agent, "--dir", dir, "--", need(text(b, "task", { required: true, what: "任務", max: TEXT_LIMIT }))];
    },
  },
  resume: {
    id: "resume",
    label: "續跑／追問",
    scope: "project",
    fields: [
      PROJECT_FIELD,
      { name: "run", label: "任務 id", kind: "text", required: true },
      { name: "followup", label: "追問（只用在已完成的任務，可留空）", kind: "textarea" },
      { name: "assumeDefaults", label: "有建議值的問題直接採用", kind: "checkbox" },
    ],
    mode: always("detached"),
    tier: normal,
    target: noTarget,
    argv: (b) => {
      const p = project(b);
      const run = need(text(b, "run", { required: true, re: NAME_RE, what: "任務 id", max: 120 }));
      const answer = flag(b, "answer");
      const followup = text(b, "followup", { what: "追問", max: TEXT_LIMIT });
      if (answer && followup) throw new ArgError("followup", "回答問題時不能同時追問。");
      const out = ["resume", "-p", p];
      if (flag(b, "assumeDefaults")) out.push("--assume-defaults");
      if (answer) out.push("--answer", "--no-edit");
      out.push("--", run);
      if (followup) out.push(followup);
      return out;
    },
  },
  clear: {
    id: "clear",
    label: "刪除任務",
    scope: "project",
    fields: [
      PROJECT_FIELD,
      { name: "run", label: "任務 id", kind: "text", required: true },
      { name: "dryRun", label: "只預覽，不刪除", kind: "checkbox" },
      { name: "keepWorktrees", label: "保留 agent 的 worktree 與分支", kind: "checkbox" },
    ],
    mode: always("short"),
    tier: (b) => (b.dryRun === true ? "normal" : "confirm"),
    target: noTarget,
    argv: (b) => {
      const p = project(b);
      const run = need(text(b, "run", { required: true, re: NAME_RE, what: "任務 id", max: 120 }));
      return ["clear", "-p", p, ...(flag(b, "dryRun") ? ["--dry-run"] : []), ...(flag(b, "keepWorktrees") ? ["--keep-worktrees"] : []), "--", run];
    },
  },
  "clear.lock": {
    id: "clear.lock",
    label: "清除殘留的 run lock",
    scope: "project",
    fields: [PROJECT_FIELD, { name: "run", label: "任務 id（只有一個 lock 時可留空）", kind: "text" }],
    mode: always("short"),
    tier: () => "typed",
    target: (b) => (typeof b.run === "string" && b.run.trim() ? b.run.trim() : String(b.project ?? "")),
    argv: (b) => {
      const p = project(b);
      const run = text(b, "run", { re: NAME_RE, what: "任務 id", max: 120 });
      return ["clear", "-p", p, "--lock", "--force", ...(run ? ["--", run] : [])];
    },
  },
  doctor: {
    id: "doctor",
    label: "檢查設定",
    scope: "project",
    fields: [PROJECT_FIELD, { name: "resolved", label: "顯示合併後的設定與來源", kind: "checkbox" }],
    mode: always("short"),
    tier: normal,
    target: noTarget,
    argv: (b) => ["doctor", "-p", project(b), ...(flag(b, "resolved") ? ["--resolved"] : [])],
  },
  tidy: {
    id: "tidy",
    label: "整理記憶",
    scope: "project",
    fields: [
      PROJECT_FIELD,
      { name: "agent", label: "只整理這一位 agent（可留空）", kind: "text" },
      { name: "layer", label: "層級", kind: "select", options: LAYERS },
      { name: "dryRun", label: "只預覽，不整理", kind: "checkbox" },
      { name: "undo", label: "還原某次整理（填時間戳，需指定 agent）", kind: "text" },
    ],
    mode: (b) => (b.dryRun === true || (typeof b.undo === "string" && b.undo.trim() !== "") ? "short" : "detached"),
    tier: (b) => (b.dryRun === true ? "normal" : "confirm"),
    target: noTarget,
    argv: (b) => {
      const p = project(b);
      const agent = text(b, "agent", { re: NAME_RE, what: "agent" });
      const layer = oneOf(b, "layer", LAYERS, "層級");
      const dryRun = flag(b, "dryRun");
      const undo = text(b, "undo", { re: NAME_RE, what: "時間戳", max: 64 });
      if (undo !== undefined) {
        if (dryRun) throw new ArgError("undo", "還原不能和預覽一起用。");
        if (!agent) throw new ArgError("agent", "還原要指定是哪一位 agent。");
      }
      const out = ["tidy", "-p", p];
      if (agent) out.push("--agent", agent);
      if (layer) out.push("--layer", layer);
      if (dryRun) out.push("--dry-run");
      if (undo !== undefined) out.push("--undo", undo);
      return out;
    },
  },
  demo: {
    id: "demo",
    label: "示範",
    scope: "home",
    fields: [
      { name: "runtime", label: "執行環境（可留空，自動偵測）", kind: "select", options: RUNTIMES },
      { name: "setupOnly", label: "只建立沙盒，不跑 agent", kind: "checkbox" },
    ],
    mode: (b) => (b.setupOnly === true ? "short" : "detached"),
    tier: normal,
    target: noTarget,
    argv: (b) => {
      const runtime = oneOf(b, "runtime", RUNTIMES, "執行環境");
      return ["demo", "-y", ...(runtime ? ["--runtime", runtime] : []), ...(flag(b, "setupOnly") ? ["--setup-only"] : [])];
    },
  },
};

export const COMMAND_IDS = Object.keys(COMMANDS) as CommandId[];
```

Then edit `web/tsconfig.json`: `"include": ["src/start.ts", "src/server/**/*.ts", "src/types.ts", "src/commands.ts"]`, and `web/tsconfig.client.json`: `"include": ["src/client", "src/types.ts", "src/commands.ts"]`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/web-commands.test.ts && pnpm --dir web typecheck`
Expected: all PASS, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git switch -c feat/web-console
git add web/src/commands.ts web/tsconfig.json web/tsconfig.client.json test/web-commands.test.ts
git commit -m "feat(web): command table that validates a body and builds argv"
```

---

### Task 2: Guard the write API (`web/src/server/guard.ts`)

**Files:**
- Modify: `web/src/server/guard.ts`
- Test: `test/web-guard-api.test.ts` (new); existing `test/web-guard.test.ts` must stay green

**Interfaces:**
- Consumes: existing `checkRequest(req, opts)`.
- Produces: `GuardRequest` gains `token?: string | undefined`; `GuardOptions` gains `token?: string`. For `POST` on a path starting `/api/`: non-loopback bind → 403; Origin missing or not same-origin → 403; token missing or different → 403.

- [ ] **Step 1: Write the failing test**

Create `test/web-guard-api.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { checkRequest } from "../web/src/server/guard.js";

const opts = { port: 8787, bindHost: "127.0.0.1", allowHosts: [] as string[], token: "tok-123" };
const post = (over: Record<string, unknown> = {}, o = opts) =>
  checkRequest({ method: "POST", pathname: "/api/cmd/run", host: "127.0.0.1:8787", origin: "http://127.0.0.1:8787", token: "tok-123", ...over } as Parameters<typeof checkRequest>[0], o);

describe("POST /api/*", () => {
  it("passes with Host, same-origin Origin and the token", () => expect(post()).toBeUndefined());
  it("a missing Origin is refused (unlike /quota)", () => expect(post({ origin: undefined })).toBe(403));
  it("a cross-site or opaque Origin is refused", () => {
    expect(post({ origin: "http://evil.example" })).toBe(403);
    expect(post({ origin: "null" })).toBe(403);
    expect(post({ origin: "http://127.0.0.1:9999" })).toBe(403);
  });
  it("a missing or wrong token is refused", () => {
    expect(post({ token: undefined })).toBe(403);
    expect(post({ token: "tok-124" })).toBe(403);
    expect(post({ token: "tok" })).toBe(403);
  });
  it("no server token configured refuses everything", () => expect(post({}, { ...opts, token: undefined } as typeof opts)).toBe(403));
  it("an unknown Host still gets the Host answer first", () => {
    expect(post({ host: "evil.example" })).toBe(403);
    expect(post({ host: undefined })).toBe(400);
  });
  it("a non-loopback bind disables the write API outright", () => {
    expect(post({ host: "0.0.0.0:8787" }, { ...opts, bindHost: "0.0.0.0" })).toBe(403);
  });
  it("GET /api/* only needs the Host check", () => {
    expect(checkRequest({ method: "GET", pathname: "/api/jobs", host: "127.0.0.1:8787" }, opts)).toBeUndefined();
  });
  it("POST /quota keeps its old rules: Origin optional", () => {
    expect(checkRequest({ method: "POST", pathname: "/quota", host: "127.0.0.1:8787" }, opts)).toBeUndefined();
    expect(checkRequest({ method: "POST", pathname: "/quota", host: "127.0.0.1:8787", origin: "http://evil.example" }, opts)).toBe(403);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/web-guard-api.test.ts`
Expected: FAIL (a missing Origin on `/api/cmd/run` currently passes).

- [ ] **Step 3: Implement**

In `web/src/server/guard.ts`:
1. Add `token?: string;` to `GuardOptions` (doc: "The CSRF token every `POST /api/*` must send.") and `token?: string | undefined;` to `GuardRequest`.
2. Add the two helpers below `allowed`:

```ts
function sameOrigin(origin: string, names: Set<string>, port: number): boolean {
  if (origin === "null") return false;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== "http:") return false;
  const name = normalizeHost(url.hostname);
  if (!name || !names.has(name)) return false;
  return Number(url.port || 80) === port;
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
```
3. Replace the body of `checkRequest` with:

```ts
export function checkRequest(req: GuardRequest, opts: GuardOptions): 400 | 403 | undefined {
  const apiWrite = req.method === "POST" && req.pathname.startsWith("/api/");
  if (!isLoopbackHost(opts.bindHost)) return apiWrite ? 403 : undefined;
  const names = allowed(opts);
  const host = normalizeHost(req.host);
  if (!host) return 400;
  if (!names.has(host)) return 403;
  if (apiWrite) {
    if (req.origin === undefined || !sameOrigin(req.origin, names, opts.port)) return 403;
    if (!opts.token || !req.token || !safeEqual(req.token, opts.token)) return 403;
    return undefined;
  }
  if (req.method === "POST" && req.pathname === "/quota" && req.origin !== undefined) {
    if (!sameOrigin(req.origin, names, opts.port)) return 403;
  }
  return undefined;
}
```
Update the file's header comment to "Host and Origin checks against DNS rebinding and cross-site writes."

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/web-guard-api.test.ts test/web-guard.test.ts`
Expected: all PASS (old guard tests unchanged).

- [ ] **Step 5: Commit**

```bash
git add web/src/server/guard.ts test/web-guard-api.test.ts
git commit -m "feat(web): require same-origin and a token for POST /api, refuse it off loopback"
```

---

### Task 3: Runner (`web/src/server/runner.ts`)

**Files:**
- Create: `web/src/server/runner.ts`
- Test: `test/web-runner.test.ts`

**Interfaces:**
- Produces:
  - `type CliLauncher = { execPath: string; args: readonly string[] }` — the child is `execPath [...args, "--home", home, ...argv]`.
  - `runShort(cli, home, argv, opts: { cwd: string; timeoutMs: number }): Promise<ShortResult>` with `ShortResult = { exit: number | null; signal: string | null; stdout: string; stderr: string; timedOut: boolean; truncated: boolean }`
  - `startJob(cli, home, jobsDir, command: string, argv: string[], cwd: string): JobRecord`
  - `listJobs(jobsDir, limit?): JobView[]`, `readJob(jobsDir, id): (JobView & { tail: string }) | undefined`
  - `JobView = { id; command; argv; cwd; started_at; pid; state: "running" | "ended" | "lost"; exit?: number | null; signal?: string | null; ended_at?: string }`

- [ ] **Step 1: Write the failing test**

Create `test/web-runner.test.ts`:

```ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listJobs, readJob, runShort, startJob, type CliLauncher } from "../web/src/server/runner.js";

let dir: string;
let cli: CliLauncher;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "lyceum-runner-"));
  const fake = path.join(dir, "fake-cli.mjs");
  fs.writeFileSync(
    fake,
    [
      "const args = process.argv.slice(2);",
      "if (args.includes('SLOW')) await new Promise((r) => setTimeout(r, 300));",
      "if (args.includes('HANG')) await new Promise((r) => setTimeout(r, 60000));",
      "process.stdout.write(JSON.stringify({ args, cwd: process.cwd() }));",
      "process.stderr.write('err-line');",
      "if (args.includes('FAIL')) process.exit(3);",
    ].join("\n"),
  );
  cli = { execPath: process.execPath, args: [fake] };
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const until = async (fn: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("timed out waiting");
};

describe("runShort", () => {
  it("passes --home first and argv verbatim, in the given cwd", async () => {
    const r = await runShort(cli, "/h", ["run", "--", "a b; c"], { cwd: dir, timeoutMs: 5000 });
    expect(r.exit).toBe(0);
    const out = JSON.parse(r.stdout) as { args: string[]; cwd: string };
    expect(out.args).toEqual(["--home", "/h", "run", "--", "a b; c"]);
    expect(fs.realpathSync(out.cwd)).toBe(fs.realpathSync(dir));
    expect(r.stderr).toBe("err-line");
  });
  it("reports the exit code", async () => {
    expect((await runShort(cli, "/h", ["FAIL"], { cwd: dir, timeoutMs: 5000 })).exit).toBe(3);
  });
  it("kills a command that runs too long", async () => {
    const r = await runShort(cli, "/h", ["HANG"], { cwd: dir, timeoutMs: 200 });
    expect(r.timedOut).toBe(true);
    expect(r.exit).not.toBe(0);
  });
  it("a missing executable is a result, not a throw", async () => {
    const r = await runShort({ execPath: path.join(dir, "nope"), args: [] }, "/h", [], { cwd: dir, timeoutMs: 1000 });
    expect(r.exit).toBeNull();
    expect(r.stderr).not.toBe("");
  });
});

describe("startJob", () => {
  it("returns at once, writes out.log and exit.json, and is listed", async () => {
    const jobsDir = path.join(dir, "web-jobs");
    const t0 = Date.now();
    const job = startJob(cli, "/h", jobsDir, "run", ["run", "SLOW"], dir);
    expect(Date.now() - t0).toBeLessThan(250);
    expect(job.pid).toBeGreaterThan(0);
    await until(() => readJob(jobsDir, job.id)?.state === "ended");
    const view = readJob(jobsDir, job.id);
    expect(view?.exit).toBe(0);
    expect(view?.command).toBe("run");
    expect(view?.tail).toContain('"SLOW"');
    expect(listJobs(jobsDir).map((j) => j.id)).toEqual([job.id]);
  });
  it("records a failing exit code", async () => {
    const jobsDir = path.join(dir, "web-jobs");
    const job = startJob(cli, "/h", jobsDir, "run", ["FAIL"], dir);
    await until(() => readJob(jobsDir, job.id)?.state === "ended");
    expect(readJob(jobsDir, job.id)?.exit).toBe(3);
  });
  it("a job whose process is gone and left no exit record is lost", () => {
    const jobsDir = path.join(dir, "web-jobs");
    fs.mkdirSync(path.join(jobsDir, "old-1"), { recursive: true });
    fs.writeFileSync(path.join(jobsDir, "old-1", "job.json"), JSON.stringify({ id: "old-1", command: "run", argv: [], cwd: dir, started_at: "2026-11-10T00:00:00.000Z", pid: 2147483646 }));
    expect(readJob(jobsDir, "old-1")?.state).toBe("lost");
  });
  it("rejects ids that could leave the jobs directory", () => {
    expect(readJob(path.join(dir, "web-jobs"), "../x")).toBeUndefined();
    expect(readJob(path.join(dir, "web-jobs"), "a/b")).toBeUndefined();
  });
  it("lists newest first and caps the list", () => {
    const jobsDir = path.join(dir, "web-jobs");
    for (const [id, at] of [["a1", "2026-11-10T00:00:01.000Z"], ["b2", "2026-11-10T00:00:03.000Z"], ["c3", "2026-11-10T00:00:02.000Z"]] as const) {
      fs.mkdirSync(path.join(jobsDir, id), { recursive: true });
      fs.writeFileSync(path.join(jobsDir, id, "job.json"), JSON.stringify({ id, command: "run", argv: [], cwd: dir, started_at: at, pid: 0 }));
    }
    expect(listJobs(jobsDir).map((j) => j.id)).toEqual(["b2", "c3", "a1"]);
    expect(listJobs(jobsDir, 2).map((j) => j.id)).toEqual(["b2", "c3"]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/web-runner.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

Create `web/src/server/runner.ts`:

```ts
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** How to start the CLI: `execPath [...args, "--home", home, ...argv]`. `args` carries the script and any loader flags (tsx in dev). */
export type CliLauncher = { execPath: string; args: readonly string[] };

export type ShortResult = { exit: number | null; signal: string | null; stdout: string; stderr: string; timedOut: boolean; truncated: boolean };

const OUT_CAP = 1_000_000;
const TAIL_BYTES = 20_000;
const ID_RE = /^[a-z0-9][a-z0-9-]*$/;

export function runShort(cli: CliLauncher, home: string, argv: string[], opts: { cwd: string; timeoutMs: number }): Promise<ShortResult> {
  return new Promise((resolve) => {
    const child = spawn(cli.execPath, [...cli.args, "--home", home, ...argv], { cwd: opts.cwd, stdio: ["ignore", "pipe", "pipe"], env: process.env });
    let stdout = "";
    let stderr = "";
    let truncated = false;
    let timedOut = false;
    const take = (current: string, chunk: Buffer): string => {
      const next = current + chunk.toString("utf8");
      if (next.length <= OUT_CAP) return next;
      truncated = true;
      return next.slice(0, OUT_CAP);
    };
    child.stdout.on("data", (c: Buffer) => {
      stdout = take(stdout, c);
    });
    child.stderr.on("data", (c: Buffer) => {
      stderr = take(stderr, c);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, opts.timeoutMs);
    let done = false;
    const finish = (exit: number | null, signal: string | null, extra = "") => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ exit, signal, stdout, stderr: stderr + extra, timedOut, truncated });
    };
    child.on("error", (e) => finish(null, null, e.message));
    child.on("close", (code, signal) => finish(code, signal));
  });
}

export type JobRecord = { id: string; command: string; argv: string[]; cwd: string; started_at: string; pid: number };
export type JobView = JobRecord & { state: "running" | "ended" | "lost"; exit?: number | null; signal?: string | null; ended_at?: string };

/** Runs the real command and writes `exit.json` when it ends. Passed to `node -e`, so no extra file has to be found at runtime. */
const WRAPPER = `
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const dir = process.argv[1];
const spec = JSON.parse(fs.readFileSync(path.join(dir, "spec.json"), "utf8"));
const done = (exit, signal) => fs.writeFileSync(path.join(dir, "exit.json"), JSON.stringify({ exit, signal, ended_at: new Date().toISOString() }));
const child = spawn(spec.execPath, spec.args, { cwd: spec.cwd, stdio: "inherit" });
child.on("error", (e) => { fs.appendFileSync(path.join(dir, "out.log"), String(e.message) + "\\n"); done(127, null); });
child.on("exit", (code, signal) => done(code, signal));
`;

export function startJob(cli: CliLauncher, home: string, jobsDir: string, command: string, argv: string[], cwd: string): JobRecord {
  const id = `${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
  const dir = path.join(jobsDir, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "spec.json"), JSON.stringify({ execPath: cli.execPath, args: [...cli.args, "--home", home, ...argv], cwd }));
  const log = fs.openSync(path.join(dir, "out.log"), "a");
  const child = spawn(process.execPath, ["-e", WRAPPER, dir], { cwd, detached: true, stdio: ["ignore", log, log], env: process.env });
  fs.closeSync(log);
  child.on("error", (e) => {
    fs.appendFileSync(path.join(dir, "out.log"), `${e.message}\n`);
    fs.writeFileSync(path.join(dir, "exit.json"), JSON.stringify({ exit: 127, signal: null, ended_at: new Date().toISOString() }));
  });
  child.unref();
  const record: JobRecord = { id, command, argv, cwd, started_at: new Date().toISOString(), pid: child.pid ?? 0 };
  fs.writeFileSync(path.join(dir, "job.json"), JSON.stringify(record));
  return record;
}

function alive(pid: number): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

function view(dir: string): JobView | undefined {
  let record: JobRecord;
  try {
    record = JSON.parse(fs.readFileSync(path.join(dir, "job.json"), "utf8")) as JobRecord;
  } catch {
    return undefined;
  }
  try {
    const ended = JSON.parse(fs.readFileSync(path.join(dir, "exit.json"), "utf8")) as { exit: number | null; signal: string | null; ended_at: string };
    return { ...record, state: "ended", exit: ended.exit, signal: ended.signal, ended_at: ended.ended_at };
  } catch {
    return { ...record, state: alive(record.pid) ? "running" : "lost" };
  }
}

export function listJobs(jobsDir: string, limit = 50): JobView[] {
  let names: string[];
  try {
    names = fs.readdirSync(jobsDir);
  } catch {
    return [];
  }
  const jobs = names.filter((n) => ID_RE.test(n)).flatMap((n) => view(path.join(jobsDir, n)) ?? []);
  return jobs.sort((a, b) => b.started_at.localeCompare(a.started_at)).slice(0, limit);
}

export function readJob(jobsDir: string, id: string): (JobView & { tail: string }) | undefined {
  if (!ID_RE.test(id)) return undefined;
  const dir = path.join(jobsDir, id);
  const found = view(dir);
  if (!found) return undefined;
  return { ...found, tail: tailOf(path.join(dir, "out.log")) };
}

function tailOf(file: string): string {
  try {
    const size = fs.statSync(file).size;
    const start = Math.max(0, size - TAIL_BYTES);
    const fd = fs.openSync(file, "r");
    try {
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      return buf.toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return "";
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/web-runner.test.ts && pnpm --dir web typecheck`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/server/runner.ts test/web-runner.test.ts
git commit -m "feat(web): runner that spawns the CLI as a short call or a detached job"
```

---

### Task 4: HTTP API (`web/src/server/api.ts`)

**Files:**
- Create: `web/src/server/api.ts`
- Test: `test/web-api.test.ts`

**Interfaces:**
- Consumes: `COMMANDS`, `ArgError`, `Body`, `CommandId` (Task 1); `runShort`, `startJob`, `listJobs`, `readJob`, `CliLauncher` (Task 3).
- Produces:
  - `type AskQuestionView = { id: string; text: string; asker: string; options?: string[]; suggested?: { value: string; reason?: string }; answer?: string; delivered: boolean }`
  - `type AskView = { status: "pending" | "answered"; questions: AskQuestionView[] }`
  - `type ConsoleDeps = { home: string; cli: CliLauncher; projectDir(name: string): string | undefined; readAsk(project: string, runId: string): AskView | undefined; saveAnswers(project: string, runId: string, answers: Record<string, string>, assumeDefaults: boolean): { complete: boolean; problems: string[] }; shortTimeoutMs?: number }`
  - `handleApi(req: IncomingMessage, res: ServerResponse, url: URL, deps: ConsoleDeps): Promise<boolean>` — true when the path was under `/api/`.
  - Responses: `POST /api/cmd/:id` → 200 `{ mode:"short", exit, signal, stdout, stderr, timedOut, truncated }`, 202 `{ mode:"detached", jobId, pid }`, 400 `{ error, field? }`, 404, 413, 428 `{ need:"confirm" }` or `{ need:"typed", target }`. `GET /api/jobs` → `{ jobs }`. `GET /api/jobs/:id` → job view with `tail`. `GET /api/ask?project&run` → `AskView`. `POST /api/ask/answers` body `{ project, run, answers, assumeDefaults? }` → `{ complete, problems }`.

- [ ] **Step 1: Write the failing test**

Create `test/web-api.test.ts`:

```ts
import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handleApi, type ConsoleDeps } from "../web/src/server/api.js";
import { readJob } from "../web/src/server/runner.js";

let root: string;
let repo: string;
let deps: ConsoleDeps;
const saved: { args?: unknown[] } = {};

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "lyceum-api-"));
  repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  const fake = path.join(root, "fake-cli.mjs");
  fs.writeFileSync(
    fake,
    [
      "const args = process.argv.slice(2);",
      "if (args.includes('FAIL')) process.exit(3);",
      "process.stdout.write(JSON.stringify({ args, cwd: process.cwd() }));",
    ].join("\n"),
  );
  deps = {
    home: path.join(root, "home"),
    cli: { execPath: process.execPath, args: [fake] },
    projectDir: (name) => (name === "web" ? repo : undefined),
    readAsk: (p, r) => (p === "web" && r === "r1" ? { status: "pending", questions: [{ id: "q1", text: "A or B?", asker: "lead", options: ["A", "B"], delivered: false }] } : undefined),
    saveAnswers: (p, r, a, d) => {
      saved.args = [p, r, a, d];
      return { complete: true, problems: [] };
    },
    shortTimeoutMs: 5000,
  };
  fs.mkdirSync(deps.home, { recursive: true });
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function call(method: string, url: string, body?: unknown, raw?: Buffer) {
  const payload = raw ?? (body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body)));
  const req = Object.assign(Readable.from(payload.length ? [payload] : []), { method, url, headers: {} }) as unknown as IncomingMessage;
  const out: { status: number; body: string } = { status: 0, body: "" };
  const res = {
    headersSent: false,
    writeHead(status: number) {
      out.status = status;
      this.headersSent = true;
    },
    end(chunk?: string) {
      out.body += chunk ?? "";
    },
  } as unknown as ServerResponse;
  return handleApi(req, res, new URL(url, "http://127.0.0.1:8787"), deps).then((handled) => ({ handled, status: out.status, json: out.body ? (JSON.parse(out.body) as Record<string, any>) : {} }));
}

describe("POST /api/cmd/:id", () => {
  it("a short command returns its output, run in the project's repo", async () => {
    const r = await call("POST", "/api/cmd/doctor", { project: "web", resolved: true });
    expect(r.status).toBe(200);
    expect(r.json.mode).toBe("short");
    expect(r.json.exit).toBe(0);
    const out = JSON.parse(r.json.stdout as string) as { args: string[]; cwd: string };
    expect(out.args).toEqual(["--home", deps.home, "doctor", "-p", "web", "--resolved"]);
    expect(fs.realpathSync(out.cwd)).toBe(fs.realpathSync(repo));
  });
  it("a detached command answers 202 with a job that finishes", async () => {
    const r = await call("POST", "/api/cmd/run", { project: "web", task: "build it" });
    expect(r.status).toBe(202);
    expect(r.json.mode).toBe("detached");
    const jobsDir = path.join(deps.home, "web-jobs");
    const end = Date.now() + 5000;
    while (readJob(jobsDir, r.json.jobId as string)?.state !== "ended" && Date.now() < end) await new Promise((x) => setTimeout(x, 25));
    expect(readJob(jobsDir, r.json.jobId as string)?.exit).toBe(0);
  });
  it("home-scoped commands run in the home", async () => {
    const r = await call("POST", "/api/cmd/project.list", {});
    expect(fs.realpathSync((JSON.parse(r.json.stdout as string) as { cwd: string }).cwd)).toBe(fs.realpathSync(deps.home));
  });
  it("unknown command 404, unknown project 404", async () => {
    expect((await call("POST", "/api/cmd/nope", {})).status).toBe(404);
    expect((await call("POST", "/api/cmd/__proto__", {})).status).toBe(404);
    expect((await call("POST", "/api/cmd/doctor", { project: "other" })).status).toBe(404);
  });
  it("a bad body is 400 with the field", async () => {
    const r = await call("POST", "/api/cmd/run", { project: "web" });
    expect(r.status).toBe(400);
    expect(r.json.field).toBe("task");
    expect((await call("POST", "/api/cmd/run", undefined, Buffer.from("{not json"))).status).toBe(400);
    expect((await call("POST", "/api/cmd/run", undefined, Buffer.from("[1]"))).status).toBe(400);
  });
  it("a body over 256 KB is 413", async () => {
    const r = await call("POST", "/api/cmd/run", undefined, Buffer.from(JSON.stringify({ project: "web", task: "x".repeat(300 * 1024) })));
    expect(r.status).toBe(413);
  });
  it("confirm tier: 428 until confirm is true", async () => {
    const body = { project: "web", run: "r1" };
    const first = await call("POST", "/api/cmd/clear", body);
    expect(first.status).toBe(428);
    expect(first.json.need).toBe("confirm");
    expect((await call("POST", "/api/cmd/clear", { ...body, confirm: "true" })).status).toBe(428);
    expect((await call("POST", "/api/cmd/clear", { ...body, confirm: true })).status).toBe(200);
  });
  it("a dry run needs no confirmation", async () => {
    expect((await call("POST", "/api/cmd/clear", { project: "web", run: "r1", dryRun: true })).status).toBe(200);
  });
  it("typed tier: 428 with the target until confirmText matches", async () => {
    const body = { name: "web", purge: true };
    const first = await call("POST", "/api/cmd/project.remove", body);
    expect(first.status).toBe(428);
    expect(first.json).toEqual({ need: "typed", target: "web" });
    expect((await call("POST", "/api/cmd/project.remove", { ...body, confirmText: "wrong" })).status).toBe(428);
    expect((await call("POST", "/api/cmd/project.remove", { ...body, confirmText: "web" })).status).toBe(200);
  });
  it("validation comes before the confirmation question", async () => {
    expect((await call("POST", "/api/cmd/clear", { project: "web" })).status).toBe(400);
  });
  it("a failing command is still a 200 with its exit code", async () => {
    const r = await call("POST", "/api/cmd/doctor", { project: "web" });
    expect(r.status).toBe(200);
    const bad = await call("POST", "/api/cmd/clear", { project: "web", run: "FAIL", confirm: true });
    expect(bad.json.exit).toBe(3);
  });
});

describe("jobs", () => {
  it("lists and reads jobs", async () => {
    const started = await call("POST", "/api/cmd/run", { project: "web", task: "t" });
    const list = await call("GET", "/api/jobs");
    expect((list.json.jobs as { id: string }[]).map((j) => j.id)).toContain(started.json.jobId);
    const one = await call("GET", `/api/jobs/${started.json.jobId as string}`);
    expect(one.status).toBe(200);
    expect(one.json.command).toBe("run");
    expect((await call("GET", "/api/jobs/..%2Fx")).status).toBe(404);
  });
});

describe("ask", () => {
  it("reads questions", async () => {
    const r = await call("GET", "/api/ask?project=web&run=r1");
    expect(r.status).toBe(200);
    expect((r.json.questions as { id: string }[])[0]?.id).toBe("q1");
    expect((await call("GET", "/api/ask?project=web&run=nope")).status).toBe(404);
    expect((await call("GET", "/api/ask?project=..&run=r1")).status).toBe(400);
  });
  it("saves answers through the dep", async () => {
    const r = await call("POST", "/api/ask/answers", { project: "web", run: "r1", answers: { q1: "A" }, assumeDefaults: true });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ complete: true, problems: [] });
    expect(saved.args).toEqual(["web", "r1", { q1: "A" }, true]);
    expect((await call("POST", "/api/ask/answers", { project: "web", run: "r1", answers: { q1: 5 } })).status).toBe(400);
  });
});

describe("routing", () => {
  it("only claims /api/ paths", async () => {
    expect((await call("GET", "/events")).handled).toBe(false);
    expect((await call("GET", "/api/zzz")).status).toBe(404);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/web-api.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

Create `web/src/server/api.ts`:

```ts
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { ArgError, COMMANDS, type Body, type CommandId } from "../commands.js";
import { listJobs, readJob, runShort, startJob, type CliLauncher } from "./runner.js";

export type AskQuestionView = { id: string; text: string; asker: string; options?: string[]; suggested?: { value: string; reason?: string }; answer?: string; delivered: boolean };
export type AskView = { status: "pending" | "answered"; questions: AskQuestionView[] };

export type ConsoleDeps = {
  home: string;
  cli: CliLauncher;
  /** The repo of a registered project, or undefined when the name is not registered. */
  projectDir: (name: string) => string | undefined;
  readAsk: (project: string, runId: string) => AskView | undefined;
  saveAnswers: (project: string, runId: string, answers: Record<string, string>, assumeDefaults: boolean) => { complete: boolean; problems: string[] };
  shortTimeoutMs?: number;
};

const BODY_LIMIT = 256 * 1024;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/;
const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };

class BodyTooLarge extends Error {}
class BadBody extends Error {}

function send(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) return;
  res.writeHead(status, JSON_HEADERS);
  res.end(JSON.stringify(body));
}

function readJson(req: IncomingMessage): Promise<Body> {
  return new Promise((resolve, reject) => {
    let size = 0;
    let settled = false;
    const chunks: Buffer[] = [];
    const fail = (e: Error) => {
      if (settled) return;
      settled = true;
      reject(e);
    };
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > BODY_LIMIT) {
        fail(new BodyTooLarge());
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      try {
        const value: unknown = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
        if (!value || typeof value !== "object" || Array.isArray(value)) reject(new BadBody());
        else resolve(value as Body);
      } catch {
        reject(new BadBody());
      }
    });
    req.on("error", fail);
  });
}

async function body(req: IncomingMessage, res: ServerResponse): Promise<Body | undefined> {
  try {
    return await readJson(req);
  } catch (e) {
    if (e instanceof BodyTooLarge) send(res, 413, { error: "請求太大。" });
    else send(res, 400, { error: "請求格式不對。" });
    return undefined;
  }
}

async function runCommand(req: IncomingMessage, res: ServerResponse, deps: ConsoleDeps, id: string): Promise<void> {
  if (!Object.hasOwn(COMMANDS, id)) return send(res, 404, { error: "沒有這個指令。" });
  const def = COMMANDS[id as CommandId];
  const b = await body(req, res);
  if (!b) return;
  let argv: string[];
  try {
    argv = def.argv(b);
  } catch (e) {
    if (e instanceof ArgError) return send(res, 400, { error: e.message, field: e.field });
    throw e;
  }
  const tier = def.tier(b);
  if (tier === "confirm" && b.confirm !== true) return send(res, 428, { need: "confirm" });
  if (tier === "typed") {
    const target = def.target(b);
    if (b.confirmText !== target) return send(res, 428, { need: "typed", target });
  }
  let cwd = deps.home;
  if (def.scope === "project") {
    const dir = deps.projectDir(String(b.project));
    if (!dir) return send(res, 404, { error: "沒有這個專案。" });
    cwd = dir;
  }
  if (def.mode(b) === "short") {
    const result = await runShort(deps.cli, deps.home, argv, { cwd, timeoutMs: deps.shortTimeoutMs ?? 120_000 });
    return send(res, 200, { mode: "short", ...result });
  }
  const job = startJob(deps.cli, deps.home, path.join(deps.home, "web-jobs"), id, argv, cwd);
  send(res, 202, { mode: "detached", jobId: job.id, pid: job.pid });
}

function answersOf(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 50) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of entries) {
    if (typeof v !== "string" || v.length > 20_000 || !NAME_RE.test(k)) return undefined;
    out[k] = v;
  }
  return out;
}

export async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL, deps: ConsoleDeps): Promise<boolean> {
  const p = url.pathname;
  if (!p.startsWith("/api/")) return false;
  const jobsDir = path.join(deps.home, "web-jobs");
  try {
    if (req.method === "POST" && p.startsWith("/api/cmd/")) {
      await runCommand(req, res, deps, p.slice("/api/cmd/".length));
    } else if (req.method === "GET" && p === "/api/jobs") {
      send(res, 200, { jobs: listJobs(jobsDir) });
    } else if (req.method === "GET" && p.startsWith("/api/jobs/")) {
      const job = readJob(jobsDir, p.slice("/api/jobs/".length));
      if (job) send(res, 200, job);
      else send(res, 404, { error: "找不到這個任務。" });
    } else if (req.method === "GET" && p === "/api/ask") {
      const project = url.searchParams.get("project") ?? "";
      const run = url.searchParams.get("run") ?? "";
      if (!NAME_RE.test(project) || !NAME_RE.test(run)) {
        send(res, 400, { error: "請求格式不對。" });
        return true;
      }
      const ask = deps.readAsk(project, run);
      if (ask) send(res, 200, ask);
      else send(res, 404, { error: "這次任務沒有待回答的問題。" });
    } else if (req.method === "POST" && p === "/api/ask/answers") {
      const b = await body(req, res);
      if (!b) return true;
      const project = typeof b.project === "string" ? b.project : "";
      const run = typeof b.run === "string" ? b.run : "";
      const answers = answersOf(b.answers);
      if (!NAME_RE.test(project) || !NAME_RE.test(run) || !answers || (b.assumeDefaults !== undefined && typeof b.assumeDefaults !== "boolean")) {
        send(res, 400, { error: "請求格式不對。" });
        return true;
      }
      send(res, 200, deps.saveAnswers(project, run, answers, b.assumeDefaults === true));
    } else {
      send(res, 404, { error: "沒有這個 API。" });
    }
  } catch (e) {
    send(res, 500, { error: (e as Error).message || "伺服器出錯。" });
  }
  return true;
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/web-api.test.ts && pnpm --dir web typecheck`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/server/api.ts test/web-api.test.ts
git commit -m "feat(web): /api/cmd, /api/jobs and /api/ask with server-enforced confirmation tiers"
```

---

### Task 5: Wire it into the server (`start.ts`, `http.ts`, `index.html`)

**Files:**
- Modify: `web/src/server/http.ts` (`serveStatic` token injection), `web/src/start.ts`, `web/index.html`
- Test: `test/web-console-start.test.ts` (new)

**Interfaces:**
- Consumes: `handleApi`, `ConsoleDeps` (Task 4); `checkRequest` with `token` (Task 2).
- Produces:
  - `StartWebOptions.console?: ConsoleDeps`.
  - `serveStatic(staticDir, req, res, token?: string)`: when `token` is given, `index.html` is served with `__LYCEUM_TOKEN__` replaced.
  - `index.html` contains `<meta name="lyceum-token" content="__LYCEUM_TOKEN__" />`.

- [ ] **Step 1: Write the failing test**

Create `test/web-console-start.test.ts`:

```ts
import fs from "node:fs";
import type http from "node:http";
import type { Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startWebServer, type StartWebOptions } from "../web/src/start.js";

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "lyceum-start-"));
  fs.mkdirSync(path.join(root, "public"));
  fs.writeFileSync(path.join(root, "public", "index.html"), '<html><head><meta name="lyceum-token" content="__LYCEUM_TOKEN__" /></head></html>');
  fs.writeFileSync(path.join(root, "fake-cli.mjs"), "process.stdout.write(JSON.stringify(process.argv.slice(2)));");
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function boot(over: Partial<StartWebOptions> = {}) {
  const state: { handler?: http.RequestListener } = {};
  const server = { address: () => ({ port: 8787, address: "127.0.0.1", family: "IPv4" }), close: (cb?: () => void) => cb?.() };
  const listen: NonNullable<StartWebOptions["listen"]> = async (_p, _h, handler) => {
    state.handler = handler;
    return { server: server as unknown as http.Server, sockets: new Set<Socket>() };
  };
  const opts: StartWebOptions = {
    port: 8787,
    host: "127.0.0.1",
    open: false,
    staticDir: path.join(root, "public"),
    factory: { list: () => [], watch: vi.fn() },
    console: {
      home: path.join(root, "home"),
      cli: { execPath: process.execPath, args: [path.join(root, "fake-cli.mjs")] },
      projectDir: () => undefined,
      readAsk: () => undefined,
      saveAnswers: () => ({ complete: true, problems: [] }),
    },
    listen,
    ...over,
  };
  fs.mkdirSync(path.join(root, "home"), { recursive: true });
  return { opts, state };
}

function request(handler: http.RequestListener, method: string, url: string, headers: Record<string, string> = {}, body?: unknown) {
  const out: { status?: number; body: string } = { body: "" };
  const done = new Promise<void>((resolve) => {
    const res = {
      headersSent: false,
      writeHead(status: number) {
        out.status = status;
        this.headersSent = true;
      },
      end(chunk?: string) {
        out.body += chunk ?? "";
        resolve();
      },
      write() {},
      on() {},
    };
    const payload = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
    const req = Object.assign(Readable.from(payload), { method, url, headers });
    handler(req as unknown as http.IncomingMessage, res as unknown as http.ServerResponse);
  });
  return { out, done };
}

const goodHeaders = (token: string) => ({ host: "127.0.0.1:8787", origin: "http://127.0.0.1:8787", "x-lyceum-token": token });

describe("write API through the real handler", () => {
  it("serves index.html with the token and accepts a command that carries it", async () => {
    const { opts, state } = boot();
    const page = await startWebServer(opts);
    try {
      const home = request(state.handler as http.RequestListener, "GET", "/", { host: "127.0.0.1:8787" });
      await home.done;
      const token = /content="([0-9a-f]{48})"/.exec(home.out.body)?.[1];
      expect(token).toBeTruthy();

      const ok = request(state.handler as http.RequestListener, "POST", "/api/cmd/init", goodHeaders(token as string), {});
      await ok.done;
      expect(ok.out.status).toBe(200);
      expect(JSON.parse((JSON.parse(ok.out.body) as { stdout: string }).stdout)).toEqual(["--home", path.join(root, "home"), "init", "-y"]);

      for (const headers of [
        { host: "127.0.0.1:8787", "x-lyceum-token": token as string },
        { host: "127.0.0.1:8787", origin: "http://127.0.0.1:8787" },
        { ...goodHeaders("0".repeat(48)) },
        { ...goodHeaders(token as string), origin: "http://evil.example" },
      ]) {
        const bad = request(state.handler as http.RequestListener, "POST", "/api/cmd/init", headers, {});
        await bad.done;
        expect(bad.out.status).toBe(403);
      }
    } finally {
      await page.close();
    }
  });

  it("a non-loopback bind refuses the write API even with a valid token", async () => {
    const { opts, state } = boot({ host: "0.0.0.0" });
    const page = await startWebServer(opts);
    try {
      const home = request(state.handler as http.RequestListener, "GET", "/", { host: "x" });
      await home.done;
      const token = /content="([0-9a-f]{48})"/.exec(home.out.body)?.[1] as string;
      const r = request(state.handler as http.RequestListener, "POST", "/api/cmd/init", { host: "x", origin: "http://x", "x-lyceum-token": token }, {});
      await r.done;
      expect(r.out.status).toBe(403);
    } finally {
      await page.close();
    }
  });

  it("without console deps /api is 404", async () => {
    const { opts, state } = boot();
    const { console: _omit, ...rest } = opts;
    const page = await startWebServer(rest);
    try {
      const r = request(state.handler as http.RequestListener, "GET", "/api/jobs", { host: "127.0.0.1:8787" });
      await r.done;
      expect(r.out.status).toBe(404);
    } finally {
      await page.close();
    }
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/web-console-start.test.ts`
Expected: FAIL (`console` option unknown / no token in html).

- [ ] **Step 3: Implement**

1. `web/index.html`: add inside `<head>`, after the viewport meta: `<meta name="lyceum-token" content="__LYCEUM_TOKEN__" />`.

2. `web/src/server/http.ts`: change `sendFile` and `serveStatic`:

```ts
function sendFile(res: http.ServerResponse, file: string, token?: string): void {
  const ext = path.extname(file);
  if (ext === ".html" && token !== undefined) {
    const html = fs.readFileSync(file, "utf8").replaceAll("__LYCEUM_TOKEN__", token);
    res.writeHead(200, { "Content-Type": MIME[".html"] as string, "Cache-Control": "no-cache" });
    res.end(html);
    return;
  }
  res.writeHead(200, {
    "Content-Type": MIME[ext] ?? "application/octet-stream",
    "Cache-Control": ext === ".html" ? "no-cache" : "public, max-age=3600",
  });
  fs.createReadStream(file).pipe(res);
}

export function serveStatic(staticDir: string, req: http.IncomingMessage, res: http.ServerResponse, token?: string): void {
```
and pass `token` to both `sendFile(res, requested, token)` and `sendFile(res, index, token)` calls.

3. `web/src/start.ts`:
   - imports: `import { randomBytes } from "node:crypto";`, `import { handleApi, type ConsoleDeps } from "./server/api.js";`
   - `StartWebOptions`: add `/** The command console (the write API). Without it `/api/*` is 404. */ console?: ConsoleDeps;`
   - Before `listen`: `const token = randomBytes(24).toString("hex");`
   - In the `checkRequest` call add `token: firstHeader(req.headers["x-lyceum-token"])` to the request and `token` to the options object. Add helper `const firstHeader = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);` at module level and use it for `origin` too (replace the inline `Array.isArray(origin) ? origin[0] : origin`).
   - After the `/quota` route block and before the `req.method !== "GET"` check, insert:

```ts
    if (pathname.startsWith("/api/")) {
      if (!opts.console) {
        res.writeHead(404, JSON_HEADERS);
        res.end(JSON.stringify({ error: "沒有這個 API。" }));
        return;
      }
      void handleApi(req, res, new URL(req.url ?? "/", "http://127.0.0.1"), opts.console);
      return;
    }
```
   - Change the final `serveStatic(opts.staticDir, req, res);` to `serveStatic(opts.staticDir, req, res, token);`.

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/web-console-start.test.ts test/web-start.test.ts test/web-guard.test.ts test/web-guard-api.test.ts && pnpm --dir web typecheck`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add web/index.html web/src/start.ts web/src/server/http.ts test/web-console-start.test.ts
git commit -m "feat(web): route /api through the guard and inject the CSRF token into index.html"
```

---

### Task 6: CLI-side deps (`src/web-console.ts`) and `cli.ts` wiring

**Files:**
- Create: `src/web-console.ts`
- Modify: `src/cli.ts` (import, the `startWebServer` option type, `startOptions`)
- Test: `test/web-console.test.ts`

**Interfaces:**
- Consumes: `listProjects`, `projectPaths`, `readAskReply`, `writeAskReply`, `prepareAnswers`.
- Produces: `createConsoleDeps(home: string, cliFile: string)` returning an object structurally equal to `ConsoleDeps` from Task 4:
  `{ home, cli: { execPath: process.execPath, args: [...process.execArgv, cliFile] }, projectDir, readAsk, saveAnswers }`.

- [ ] **Step 1: Write the failing test**

Create `test/web-console.test.ts`:

```ts
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readAskReply, writeAskReply } from "../src/ask-reply.js";
import { createConsoleDeps } from "../src/web-console.js";
import { makeEnv, type TestEnv } from "./helpers.js";

let env: TestEnv;
afterEach(() => env?.cleanup());

function seedAsk(runId = "r1") {
  const runDir = path.join(env.home, "projects", "demo", "runs", runId);
  fs.mkdirSync(path.join(runDir, "mail"), { recursive: true });
  writeAskReply(runDir, {
    status: "pending",
    askedBy: "lead",
    round: 3,
    questions: [
      { id: "q1", text: "Session or JWT?", asker: "lead", options: ["session", "jwt"], suggested: { value: "session", reason: "cookies exist" } },
      { id: "q2", text: "Name it?", asker: "lead" },
    ],
  });
  return runDir;
}

describe("createConsoleDeps", () => {
  it("launches the CLI with the current node and the given script", () => {
    env = makeEnv();
    const deps = createConsoleDeps(env.home, "/x/cli.js");
    expect(deps.cli.execPath).toBe(process.execPath);
    expect(deps.cli.args.at(-1)).toBe("/x/cli.js");
    expect(deps.home).toBe(env.home);
  });
  it("projectDir finds a registered project and nothing else", () => {
    env = makeEnv();
    const deps = createConsoleDeps(env.home, "/x/cli.js");
    expect(deps.projectDir("demo")).toBe(env.repo);
    expect(deps.projectDir("nope")).toBeUndefined();
  });
  it("readAsk returns the questions and undefined without a file", () => {
    env = makeEnv();
    const deps = createConsoleDeps(env.home, "/x/cli.js");
    expect(deps.readAsk("demo", "r1")).toBeUndefined();
    seedAsk();
    const view = deps.readAsk("demo", "r1");
    expect(view?.status).toBe("pending");
    expect(view?.questions.map((q) => q.id)).toEqual(["q1", "q2"]);
    expect(view?.questions[0]).toMatchObject({ options: ["session", "jwt"], suggested: { value: "session" }, delivered: false });
    expect(deps.readAsk("demo", "../../etc")).toBeUndefined();
    expect(deps.readAsk("other", "r1")).toBeUndefined();
  });
  it("saveAnswers stores user answers and says what is still missing", () => {
    env = makeEnv();
    const runDir = seedAsk();
    const deps = createConsoleDeps(env.home, "/x/cli.js");
    const partial = deps.saveAnswers("demo", "r1", { q1: "b" }, false);
    expect(partial.complete).toBe(false);
    expect(partial.problems.join(" ")).toContain("q2");
    const saved = readAskReply(runDir);
    expect(saved?.questions[0]?.answer).toEqual({ value: "jwt", by: "user" });
    const done = deps.saveAnswers("demo", "r1", { q2: "Ada" }, false);
    expect(done).toEqual({ complete: true, problems: [] });
  });
  it("saveAnswers with assumeDefaults takes the suggestion", () => {
    env = makeEnv();
    const runDir = seedAsk();
    const deps = createConsoleDeps(env.home, "/x/cli.js");
    const r = deps.saveAnswers("demo", "r1", { q2: "Ada" }, true);
    expect(r.complete).toBe(true);
    expect(readAskReply(runDir)?.questions[0]?.answer).toEqual({ value: "session", by: "default" });
  });
  it("saveAnswers on a run with no questions is not complete", () => {
    env = makeEnv();
    const deps = createConsoleDeps(env.home, "/x/cli.js");
    expect(deps.saveAnswers("demo", "r9", { q1: "a" }, false).complete).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/web-console.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

Create `src/web-console.ts`:

```ts
import fs from "node:fs";
import path from "node:path";
import { prepareAnswers } from "./ask-answer.js";
import { readAskReply, writeAskReply } from "./ask-reply.js";
import { listProjects } from "./config.js";
import { NAME_RE, projectPaths } from "./paths.js";

/** What the web page's command console needs from this side of the package (`web/` cannot import `src/`). Same shape as `ConsoleDeps` in `web/src/server/api.ts`. */
export function createConsoleDeps(home: string, cliFile: string) {
  const projectDir = (name: string): string | undefined => listProjects(home).find((p) => p.name === name)?.dir;

  const runDirOf = (project: string, runId: string): string | undefined => {
    if (!NAME_RE.test(project) || !NAME_RE.test(runId) || !projectDir(project)) return undefined;
    const dir = path.join(projectPaths(home, project).runs, runId);
    return fs.existsSync(dir) ? dir : undefined;
  };

  return {
    home,
    cli: { execPath: process.execPath, args: [...process.execArgv, cliFile] as readonly string[] },
    projectDir,
    readAsk(project: string, runId: string) {
      const dir = runDirOf(project, runId);
      const reply = dir ? readAskReply(dir) : undefined;
      if (!reply) return undefined;
      return {
        status: reply.status,
        questions: reply.questions.map((q) => ({
          id: q.id,
          text: q.text,
          asker: q.asker,
          ...(q.options ? { options: q.options } : {}),
          ...(q.suggested ? { suggested: q.suggested } : {}),
          ...(q.answer ? { answer: q.answer.value } : {}),
          delivered: q.delivered === true,
        })),
      };
    },
    saveAnswers(project: string, runId: string, answers: Record<string, string>, assumeDefaults: boolean): { complete: boolean; problems: string[] } {
      const dir = runDirOf(project, runId);
      const reply = dir ? readAskReply(dir) : undefined;
      if (!dir || !reply) return { complete: false, problems: ["這次任務沒有待回答的問題。"] };
      writeAskReply(dir, {
        ...reply,
        questions: reply.questions.map((q) => {
          const value = answers[q.id]?.trim();
          return q.delivered || !value ? q : { ...q, answer: { value, by: "user" as const } };
        }),
      });
      const checked = prepareAnswers(dir, { assumeDefaults });
      return { complete: checked.complete, problems: checked.problems };
    },
  };
}
```

In `src/cli.ts`:
- add `import { createConsoleDeps } from "./web-console.js";` next to the other imports.
- in the `startWebServer` options type (around line 716) add the member `console?: ReturnType<typeof createConsoleDeps>;` after `allowHosts: string[];`.
- in `startOptions` (around line 733) add after `allowHosts: opts.allowHost,`: `console: createConsoleDeps(home(), fileURLToPath(import.meta.url)),`.

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run test/web-console.test.ts && npm run typecheck`
Expected: PASS, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/web-console.ts src/cli.ts test/web-console.test.ts
git commit -m "feat(web): give the page project lookup, CLI launcher and ask-reply access"
```

---

### Task 7: Page foundations: API client, dialog state, exit wording, Modal

**Files:**
- Create: `web/src/client/api.ts`, `web/src/client/dialog-state.ts`, `web/src/client/exit-info.ts`, `web/src/client/Modal.tsx`
- Test: `test/web-dialog-state.test.ts`

**Interfaces:**
- Produces:
  - `api.ts`: `type CommandResult = { kind: "short"; result: ShortOutcome } | { kind: "job"; job: { jobId: string; pid: number } } | { kind: "need"; need: "confirm" | "typed"; target?: string } | { kind: "invalid"; error: string; field?: string } | { kind: "stale" } | { kind: "error"; message: string }`; `postCommand(id, body): Promise<CommandResult>`; `getJobs(): Promise<JobSummary[]>`; `getJob(id): Promise<JobDetail | undefined>`; `getAsk(project, run): Promise<AskView | undefined>`; `postAnswers(project, run, answers, assumeDefaults): Promise<{ complete: boolean; problems: string[] } | undefined>`.
  - `dialog-state.ts`: `type DialogState`, `initialState`, `reduce(state, action)`, `confirmReady(state)`.
  - `exit-info.ts`: `exitInfo(exit: number | null, timedOut: boolean): { tone: "ok" | "warn" | "fail"; text: string }`.
  - `Modal.tsx`: `<Modal open title onClose>children</Modal>` using native `<dialog>`.

- [ ] **Step 1: Write the failing test**

Create `test/web-dialog-state.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { confirmReady, initialState, reduce } from "../web/src/client/dialog-state.js";
import { exitInfo } from "../web/src/client/exit-info.js";

const short = { kind: "short", result: { mode: "short", exit: 0, signal: null, stdout: "ok", stderr: "", timedOut: false, truncated: false } } as const;

describe("dialog state machine", () => {
  it("form -> running -> done", () => {
    let s = reduce(initialState, { type: "submit" });
    expect(s.phase).toBe("running");
    s = reduce(s, { type: "result", result: short });
    expect(s).toEqual({ phase: "done", result: short });
  });
  it("a 428 upgrades to the confirm view and typed input gates the button", () => {
    let s = reduce(initialState, { type: "submit" });
    s = reduce(s, { type: "result", result: { kind: "need", need: "typed", target: "web" } });
    expect(s).toMatchObject({ phase: "confirm", need: "typed", target: "web", typed: "" });
    expect(confirmReady(s)).toBe(false);
    s = reduce(s, { type: "typed", value: "we" });
    expect(confirmReady(s)).toBe(false);
    s = reduce(s, { type: "typed", value: "web" });
    expect(confirmReady(s)).toBe(true);
  });
  it("a plain confirm needs no typing", () => {
    const s = reduce(reduce(initialState, { type: "submit" }), { type: "result", result: { kind: "need", need: "confirm" } });
    expect(confirmReady(s)).toBe(true);
  });
  it("a 400 returns to the form with the field error", () => {
    const s = reduce(reduce(initialState, { type: "submit" }), { type: "result", result: { kind: "invalid", error: "任務必填。", field: "task" } });
    expect(s).toEqual({ phase: "form", errors: { task: "任務必填。" } });
  });
  it("an invalid answer with no field becomes a notice", () => {
    const s = reduce(reduce(initialState, { type: "submit" }), { type: "result", result: { kind: "invalid", error: "壞了" } });
    expect(s).toEqual({ phase: "form", errors: {}, notice: "壞了" });
  });
  it("a stale token asks for a reload; a network error keeps the form", () => {
    expect(reduce(reduce(initialState, { type: "submit" }), { type: "result", result: { kind: "stale" } })).toMatchObject({ phase: "form", notice: expect.stringContaining("重新整理") });
    expect(reduce(reduce(initialState, { type: "submit" }), { type: "result", result: { kind: "error", message: "連不上" } })).toMatchObject({ phase: "form", notice: "連不上" });
  });
  it("back and reset return to a clean form", () => {
    const s = reduce(reduce(initialState, { type: "submit" }), { type: "result", result: { kind: "need", need: "confirm" } });
    expect(reduce(s, { type: "back" })).toEqual(initialState);
    expect(reduce(s, { type: "reset" })).toEqual(initialState);
  });
  it("a second submit while running is ignored", () => {
    const running = reduce(initialState, { type: "submit" });
    expect(reduce(running, { type: "submit" })).toBe(running);
  });
});

describe("exitInfo", () => {
  it("maps the documented exit codes", () => {
    expect(exitInfo(0, false)).toEqual({ tone: "ok", text: "完成" });
    expect(exitInfo(2, false).tone).toBe("warn");
    expect(exitInfo(3, false)).toEqual({ tone: "warn", text: "正在等你回答問題" });
    expect(exitInfo(1, false)).toEqual({ tone: "fail", text: "失敗（結束碼 1）" });
    expect(exitInfo(null, true)).toEqual({ tone: "fail", text: "等太久，已中止" });
    expect(exitInfo(null, false)).toEqual({ tone: "fail", text: "沒能啟動" });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/web-dialog-state.test.ts`
Expected: FAIL (modules not found).

- [ ] **Step 3: Implement**

`web/src/client/exit-info.ts`:

```ts
export function exitInfo(exit: number | null, timedOut: boolean): { tone: "ok" | "warn" | "fail"; text: string } {
  if (timedOut) return { tone: "fail", text: "等太久，已中止" };
  if (exit === null) return { tone: "fail", text: "沒能啟動" };
  if (exit === 0) return { tone: "ok", text: "完成" };
  if (exit === 2) return { tone: "warn", text: "部分完成，或被擋住（結束碼 2）" };
  if (exit === 3) return { tone: "warn", text: "正在等你回答問題" };
  return { tone: "fail", text: `失敗（結束碼 ${exit}）` };
}
```

`web/src/client/api.ts`:

```ts
import type { Body, CommandId } from "../commands";

export type ShortOutcome = { mode: "short"; exit: number | null; signal: string | null; stdout: string; stderr: string; timedOut: boolean; truncated: boolean };
export type CommandResult =
  | { kind: "short"; result: ShortOutcome }
  | { kind: "job"; job: { jobId: string; pid: number } }
  | { kind: "need"; need: "confirm" | "typed"; target?: string }
  | { kind: "invalid"; error: string; field?: string }
  | { kind: "stale" }
  | { kind: "error"; message: string };

export type JobSummary = { id: string; command: string; argv: string[]; cwd: string; started_at: string; pid: number; state: "running" | "ended" | "lost"; exit?: number | null; ended_at?: string };
export type JobDetail = JobSummary & { tail: string };
export type AskQuestion = { id: string; text: string; asker: string; options?: string[]; suggested?: { value: string; reason?: string }; answer?: string; delivered: boolean };
export type AskView = { status: "pending" | "answered"; questions: AskQuestion[] };

function token(): string {
  return document.querySelector('meta[name="lyceum-token"]')?.getAttribute("content") ?? "";
}

const headers = () => ({ "Content-Type": "application/json", "X-Lyceum-Token": token() });

async function json(res: Response): Promise<Record<string, unknown>> {
  return ((await res.json().catch(() => ({}))) as Record<string, unknown>) ?? {};
}

export async function postCommand(id: CommandId, body: Body): Promise<CommandResult> {
  let res: Response;
  try {
    res = await fetch(`/api/cmd/${id}`, { method: "POST", headers: headers(), body: JSON.stringify(body) });
  } catch {
    return { kind: "error", message: "連不上本機伺服器。" };
  }
  const data = await json(res);
  if (res.status === 403) return { kind: "stale" };
  if (res.status === 428) return { kind: "need", need: data.need === "typed" ? "typed" : "confirm", ...(typeof data.target === "string" ? { target: data.target } : {}) };
  if (res.status === 400) return { kind: "invalid", error: String(data.error ?? "輸入不對。"), ...(typeof data.field === "string" ? { field: data.field } : {}) };
  if (res.status === 202) return { kind: "job", job: { jobId: String(data.jobId), pid: Number(data.pid) } };
  if (res.status === 200) return { kind: "short", result: data as unknown as ShortOutcome };
  return { kind: "error", message: String(data.error ?? `伺服器回了 ${res.status}。`) };
}

export async function getJobs(): Promise<JobSummary[]> {
  try {
    const res = await fetch("/api/jobs");
    return res.ok ? (((await res.json()) as { jobs: JobSummary[] }).jobs ?? []) : [];
  } catch {
    return [];
  }
}

export async function getJob(id: string): Promise<JobDetail | undefined> {
  try {
    const res = await fetch(`/api/jobs/${encodeURIComponent(id)}`);
    return res.ok ? ((await res.json()) as JobDetail) : undefined;
  } catch {
    return undefined;
  }
}

export async function getAsk(project: string, run: string): Promise<AskView | undefined> {
  try {
    const res = await fetch(`/api/ask?project=${encodeURIComponent(project)}&run=${encodeURIComponent(run)}`);
    return res.ok ? ((await res.json()) as AskView) : undefined;
  } catch {
    return undefined;
  }
}

export async function postAnswers(project: string, run: string, answers: Record<string, string>, assumeDefaults: boolean): Promise<{ complete: boolean; problems: string[] } | undefined> {
  try {
    const res = await fetch("/api/ask/answers", { method: "POST", headers: headers(), body: JSON.stringify({ project, run, answers, assumeDefaults }) });
    return res.ok ? ((await res.json()) as { complete: boolean; problems: string[] }) : undefined;
  } catch {
    return undefined;
  }
}
```

`web/src/client/dialog-state.ts`:

```ts
import type { CommandResult } from "./api";

export type DialogState =
  | { phase: "form"; errors: Record<string, string>; notice?: string }
  | { phase: "running" }
  | { phase: "confirm"; need: "confirm" | "typed"; target?: string; typed: string }
  | { phase: "done"; result: CommandResult };

export type DialogAction = { type: "submit" } | { type: "result"; result: CommandResult } | { type: "typed"; value: string } | { type: "back" } | { type: "reset" };

export const initialState: DialogState = { phase: "form", errors: {} };

export function reduce(state: DialogState, action: DialogAction): DialogState {
  switch (action.type) {
    case "submit":
      return state.phase === "running" ? state : { phase: "running" };
    case "typed":
      return state.phase === "confirm" ? { ...state, typed: action.value } : state;
    case "back":
    case "reset":
      return initialState;
    case "result": {
      const r = action.result;
      if (r.kind === "short" || r.kind === "job") return { phase: "done", result: r };
      if (r.kind === "need") return { phase: "confirm", need: r.need, ...(r.target !== undefined ? { target: r.target } : {}), typed: "" };
      if (r.kind === "invalid") return r.field ? { phase: "form", errors: { [r.field]: r.error } } : { phase: "form", errors: {}, notice: r.error };
      if (r.kind === "stale") return { phase: "form", errors: {}, notice: "頁面已過期（伺服器重新啟動過），請重新整理頁面後再試。" };
      return { phase: "form", errors: {}, notice: r.message };
    }
  }
}

export function confirmReady(state: DialogState): boolean {
  return state.phase === "confirm" && (state.need === "confirm" || state.typed === state.target);
}
```

`web/src/client/Modal.tsx`:

```tsx
import { useEffect, useId, useRef, type ReactNode } from "react";

/** A native <dialog>: the browser traps focus, closes on Esc and puts focus back on the button that opened it. */
export function Modal({ open, title, onClose, children }: { open: boolean; title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onClose={onClose}
      className="m-auto w-[min(38rem,calc(100vw-2rem))] max-h-[90dvh] overflow-y-auto rounded-xl border border-line bg-paper p-0 text-ink backdrop:bg-black/40"
    >
      {open && (
        <div className="p-4 sm:p-6">
          <h2 id={titleId} className="text-balance text-xl font-semibold tracking-tight">
            {title}
          </h2>
          {children}
        </div>
      )}
    </dialog>
  );
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run test/web-dialog-state.test.ts && pnpm --dir web typecheck`
Expected: PASS, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add web/src/client/api.ts web/src/client/dialog-state.ts web/src/client/exit-info.ts web/src/client/Modal.tsx test/web-dialog-state.test.ts
git commit -m "feat(web): page API client, dialog state machine, exit wording and Modal"
```

---

### Task 8: `CommandDialog` and `AnswerDialog`

**Files:**
- Create: `web/src/client/CommandDialog.tsx`, `web/src/client/AnswerDialog.tsx`

**Interfaces:**
- Consumes: Task 1 `COMMANDS`; Task 7 `postCommand`, `getAsk`, `postAnswers`, `reduce`, `confirmReady`, `exitInfo`, `Modal`.
- Produces:
  - `<CommandDialog id: CommandId open: boolean title?: string fixed?: Body initial?: Body fieldOptions?: Record<string, readonly string[]> onClose(): void />` — draws the fields of `COMMANDS[id]` except those named in `fixed`; handles form, confirm (with dry-run preview when the command has a `dryRun` field), and result views.
  - `<AnswerDialog project: string runId: string open: boolean onClose(): void />`.

UI is verified by the browser run in Task 11 (no component test library is installed; the logic is covered by the state-machine tests).

- [ ] **Step 1: Write `CommandDialog.tsx`**

```tsx
import { useEffect, useId, useReducer, useState } from "react";
import { COMMANDS, type Body, type CommandDef, type CommandId, type Field } from "../commands";
import { postCommand } from "./api";
import { cn } from "./cn";
import { confirmReady, initialState, reduce } from "./dialog-state";
import { exitInfo } from "./exit-info";
import { Modal } from "./Modal";

const TONE = { ok: "text-signal", warn: "text-warn", fail: "text-failed" } as const;
const MARK = { ok: "✓", warn: "!", fail: "✕" } as const;

const input = "min-h-11 w-full rounded-lg border border-line bg-wall px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal";
const btn = "min-h-11 rounded-lg border border-line px-4 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal disabled:opacity-50";

function canPreview(def: CommandDef, body: Body): boolean {
  return def.fields.some((f) => f.name === "dryRun") && body.dryRun !== true && !body.undo;
}

export function CommandDialog({
  id,
  open,
  title,
  fixed,
  initial,
  fieldOptions,
  onClose,
}: {
  id: CommandId;
  open: boolean;
  title?: string;
  fixed?: Body;
  initial?: Body;
  fieldOptions?: Record<string, readonly string[]>;
  onClose: () => void;
}) {
  const def = COMMANDS[id];
  const [values, setValues] = useState<Body>(initial ?? {});
  const [state, dispatch] = useReducer(reduce, initialState);
  const [preview, setPreview] = useState<string>();
  const [sentBody, setSentBody] = useState<Body>({});

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset only when the dialog (re)opens, not when `initial` is a new object each render.
  useEffect(() => {
    if (!open) return;
    setValues(initial ?? {});
    setPreview(undefined);
    dispatch({ type: "reset" });
  }, [open]);

  const send = async (extra: Body = {}) => {
    const body = { ...values, ...fixed, ...extra };
    setSentBody(body);
    dispatch({ type: "submit" });
    const result = await postCommand(id, body);
    if (result.kind === "need" && canPreview(def, body)) {
      void postCommand(id, { ...body, dryRun: true, confirm: undefined, confirmText: undefined }).then((p) => {
        if (p.kind === "short") setPreview(p.result.stdout || p.result.stderr);
      });
    }
    dispatch({ type: "result", result });
  };

  const shown = def.fields.filter((f) => !(fixed && f.name in fixed));
  const running = state.phase === "running";

  return (
    <Modal open={open} title={title ?? def.label} onClose={onClose}>
      {(state.phase === "form" || state.phase === "running") && (
        <form
          className="mt-4 flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          {shown.map((f, i) => (
            <FieldRow
              key={f.name}
              field={f}
              value={values[f.name]}
              error={state.phase === "form" ? state.errors[f.name] : undefined}
              options={fieldOptions?.[f.name]}
              autoFocus={i === 0}
              onChange={(v) => setValues((prev) => ({ ...prev, [f.name]: v }))}
            />
          ))}
          {state.phase === "form" && state.notice && (
            <p role="alert" className="text-pretty rounded-lg border border-failed/40 bg-failed-soft px-3 py-2 text-sm text-failed">
              {state.notice}
            </p>
          )}
          <div className="flex flex-wrap justify-end gap-2">
            <button type="button" className={btn} onClick={onClose}>
              取消
            </button>
            <button type="submit" disabled={running} className={cn(btn, "bg-ink text-paper")}>
              {running ? "執行中…" : def.label}
            </button>
          </div>
        </form>
      )}

      {state.phase === "confirm" && (
        <div className="mt-4 flex flex-col gap-4">
          <p className="text-pretty text-sm">
            這個動作不能復原。確定要{def.label}
            {typeof sentBody.run === "string" ? `（${sentBody.run}）` : typeof sentBody.name === "string" ? `（${sentBody.name}）` : ""}嗎？
          </p>
          {preview !== undefined && (
            <div>
              <p className="eyebrow">預覽（不會改動任何東西）</p>
              <pre className="mt-1 max-h-60 overflow-auto rounded-lg border border-line bg-wall p-3 font-mono text-xs whitespace-pre-wrap">{preview}</pre>
            </div>
          )}
          {state.need === "typed" && (
            <label className="flex flex-col gap-1 text-sm">
              <span>
                輸入 <strong className="font-mono">{state.target}</strong> 以確認
              </span>
              <input className={input} value={state.typed} autoComplete="off" onChange={(e) => dispatch({ type: "typed", value: e.target.value })} />
            </label>
          )}
          <div className="flex flex-wrap justify-end gap-2">
            {/* Cancel is the default focus: Enter must not delete anything. */}
            <button type="button" autoFocus className={btn} onClick={onClose}>
              取消
            </button>
            <button type="button" className={btn} onClick={() => dispatch({ type: "back" })}>
              回上一步
            </button>
            <button
              type="button"
              disabled={!confirmReady(state)}
              className={cn(btn, "border-failed bg-failed text-paper")}
              onClick={() => void send({ confirm: true, ...(state.need === "typed" ? { confirmText: state.typed } : {}) })}
            >
              確定{def.label}
            </button>
          </div>
        </div>
      )}

      {state.phase === "done" && <Done result={state.result} onClose={onClose} />}
    </Modal>
  );
}

function Done({ result, onClose }: { result: Extract<ReturnType<typeof reduce>, { phase: "done" }>["result"]; onClose: () => void }) {
  if (result.kind === "job") {
    return (
      <div className="mt-4 flex flex-col gap-4">
        <p className="text-sm">
          <span aria-hidden className="mr-1 text-signal">✓</span>已在背景啟動（pid {result.job.pid}）。關掉這個頁面也會繼續跑。
        </p>
        <div className="flex justify-end gap-2">
          <a className={cn(btn, "inline-flex items-center")} href="#!jobs" onClick={onClose}>
            看任務輸出
          </a>
          <button type="button" autoFocus className={cn(btn, "bg-ink text-paper")} onClick={onClose}>
            關閉
          </button>
        </div>
      </div>
    );
  }
  if (result.kind !== "short") return null;
  const info = exitInfo(result.result.exit, result.result.timedOut);
  const text = [result.result.stdout, result.result.stderr].filter(Boolean).join("\n");
  return (
    <div className="mt-4 flex flex-col gap-4">
      <p className={cn("flex items-center gap-2 text-sm font-medium", TONE[info.tone])}>
        <span aria-hidden>{MARK[info.tone]}</span>
        {info.text}
      </p>
      {text && <pre className="max-h-80 overflow-auto rounded-lg border border-line bg-wall p-3 font-mono text-xs whitespace-pre-wrap">{text}</pre>}
      {result.result.truncated && <p className="text-xs text-ink/60">輸出太長，已截斷。</p>}
      <div className="flex justify-end">
        <button type="button" autoFocus className={cn(btn, "bg-ink text-paper")} onClick={onClose}>
          關閉
        </button>
      </div>
    </div>
  );
}

function FieldRow({
  field,
  value,
  error,
  options,
  autoFocus,
  onChange,
}: {
  field: Field;
  value: unknown;
  error: string | undefined;
  options: readonly string[] | undefined;
  autoFocus: boolean;
  onChange: (value: unknown) => void;
}) {
  const uid = useId();
  const errId = `${uid}-err`;
  const common = { id: uid, "aria-invalid": error ? true : undefined, "aria-describedby": error ? errId : undefined, autoFocus };
  const choices = options ?? field.options;
  return (
    <div className="flex flex-col gap-1">
      {field.kind === "checkbox" ? (
        <label className="flex min-h-11 items-center gap-3 text-sm">
          <input type="checkbox" className="size-5" checked={value === true} onChange={(e) => onChange(e.target.checked)} {...common} />
          <span>{field.label}</span>
        </label>
      ) : (
        <>
          <label htmlFor={uid} className="text-sm font-medium">
            {field.label}
            {field.required && <span aria-hidden className="text-failed"> *</span>}
          </label>
          {field.kind === "textarea" ? (
            <textarea className={cn(input, "min-h-32")} value={typeof value === "string" ? value : ""} onChange={(e) => onChange(e.target.value)} {...common} />
          ) : choices ? (
            <select className={input} value={typeof value === "string" ? value : ""} onChange={(e) => onChange(e.target.value)} {...common}>
              <option value="">{field.required ? "請選擇" : "（預設）"}</option>
              {choices.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
          ) : (
            <input className={input} value={typeof value === "string" ? value : ""} autoComplete="off" onChange={(e) => onChange(e.target.value)} {...common} />
          )}
        </>
      )}
      {field.help && !error && <p className="text-xs text-ink/60">{field.help}</p>}
      {error && (
        <p id={errId} role="alert" className="text-sm text-failed">
          {error}
        </p>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Write `AnswerDialog.tsx`**

```tsx
import { useEffect, useId, useState } from "react";
import { getAsk, postAnswers, postCommand, type AskView, type CommandResult } from "./api";
import { cn } from "./cn";
import { exitInfo } from "./exit-info";
import { Modal } from "./Modal";

const input = "min-h-11 w-full rounded-lg border border-line bg-wall px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal";
const btn = "min-h-11 rounded-lg border border-line px-4 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal disabled:opacity-50";

export function AnswerDialog({ project, runId, open, onClose }: { project: string; runId: string; open: boolean; onClose: () => void }) {
  const [ask, setAsk] = useState<AskView | undefined | "missing">();
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [useDefaults, setUseDefaults] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);
  const [result, setResult] = useState<CommandResult>();

  useEffect(() => {
    if (!open) return;
    setAsk(undefined);
    setAnswers({});
    setUseDefaults(false);
    setProblems([]);
    setResult(undefined);
    void getAsk(project, runId).then((view) => {
      setAsk(view ?? "missing");
      if (view) setAnswers(Object.fromEntries(view.questions.filter((q) => !q.delivered && q.answer).map((q) => [q.id, q.answer as string])));
    });
  }, [open, project, runId]);

  const submit = async () => {
    setBusy(true);
    setProblems([]);
    const saved = await postAnswers(project, runId, answers, useDefaults);
    if (!saved) {
      setProblems(["沒能存下答案，請重新整理頁面再試。"]);
    } else if (!saved.complete) {
      setProblems(saved.problems);
    } else {
      setResult(await postCommand("resume", { project, run: runId, answer: true }));
    }
    setBusy(false);
  };

  const pending = ask && ask !== "missing" ? ask.questions.filter((q) => !q.delivered) : [];
  const info = result?.kind === "short" ? exitInfo(result.result.exit, result.result.timedOut) : undefined;

  return (
    <Modal open={open} title="回答問題" onClose={onClose}>
      {ask === undefined && <p className="mt-4 text-sm">讀取中…</p>}
      {ask === "missing" && <p className="mt-4 text-sm">這次任務現在沒有待回答的問題。</p>}
      {result ? (
        <div className="mt-4 flex flex-col gap-3">
          {result.kind === "job" ? (
            <p className="text-sm">
              <span aria-hidden className="mr-1 text-signal">✓</span>答案已送出，任務在背景繼續。
            </p>
          ) : result.kind === "short" ? (
            <>
              <p className={cn("text-sm font-medium", info?.tone === "ok" ? "text-signal" : info?.tone === "warn" ? "text-warn" : "text-failed")}>{info?.text}</p>
              <pre className="max-h-60 overflow-auto rounded-lg border border-line bg-wall p-3 font-mono text-xs whitespace-pre-wrap">{result.result.stdout || result.result.stderr}</pre>
            </>
          ) : (
            <p role="alert" className="text-sm text-failed">
              {result.kind === "error" ? result.message : "沒能繼續任務，請重新整理頁面再試。"}
            </p>
          )}
          <div className="flex justify-end">
            <button type="button" autoFocus className={cn(btn, "bg-ink text-paper")} onClick={onClose}>
              關閉
            </button>
          </div>
        </div>
      ) : (
        pending.length > 0 && (
          <form
            className="mt-4 flex flex-col gap-5"
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            {pending.map((q, i) => (
              <Question key={q.id} q={q} value={answers[q.id] ?? ""} autoFocus={i === 0} onChange={(v) => setAnswers((prev) => ({ ...prev, [q.id]: v }))} />
            ))}
            <label className="flex min-h-11 items-center gap-3 text-sm">
              <input type="checkbox" className="size-5" checked={useDefaults} onChange={(e) => setUseDefaults(e.target.checked)} />
              <span>沒填的問題，有建議值就採用建議值</span>
            </label>
            {problems.length > 0 && (
              <ul role="alert" className="rounded-lg border border-failed/40 bg-failed-soft px-3 py-2 text-sm text-failed">
                {problems.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            )}
            <div className="flex flex-wrap justify-end gap-2">
              <button type="button" className={btn} onClick={onClose}>
                取消
              </button>
              <button type="submit" disabled={busy} className={cn(btn, "bg-ink text-paper")}>
                {busy ? "送出中…" : "送出並繼續任務"}
              </button>
            </div>
          </form>
        )
      )}
    </Modal>
  );
}

function Question({ q, value, autoFocus, onChange }: { q: AskView["questions"][number]; value: string; autoFocus: boolean; onChange: (v: string) => void }) {
  const uid = useId();
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="text-pretty text-sm font-medium">
        {q.text} <span className="font-mono text-xs text-ink/60">（{q.asker}）</span>
      </legend>
      {q.options?.map((o) => (
        <label key={o} className="flex min-h-11 items-center gap-3 text-sm">
          <input type="radio" name={uid} className="size-5" checked={value === o} onChange={() => onChange(o)} />
          <span className="text-pretty">{o}</span>
        </label>
      ))}
      <label htmlFor={`${uid}-text`} className="text-xs text-ink/60">
        {q.options?.length ? "或自己寫" : "你的答案"}
      </label>
      <input id={`${uid}-text`} className={input} value={value} autoFocus={autoFocus} autoComplete="off" onChange={(e) => onChange(e.target.value)} />
      {q.suggested && (
        <button type="button" className="min-h-11 self-start rounded-lg px-1 text-left text-sm underline" onClick={() => onChange(q.suggested?.value ?? "")}>
          採用建議：{q.suggested.value}
          {q.suggested.reason ? `（${q.suggested.reason}）` : ""}
        </button>
      )}
    </fieldset>
  );
}
```

- [ ] **Step 3: Typecheck and lint**

Run: `pnpm --dir web typecheck && npm run lint`
Expected: clean. Fix any biome findings in the new files (keep `autoFocus` only where the plan places it; if biome flags `noAutofocus`, add a `// biome-ignore lint/a11y/noAutofocus: focus moves into the dialog on purpose` comment on those lines).

- [ ] **Step 4: Commit**

```bash
git add web/src/client/CommandDialog.tsx web/src/client/AnswerDialog.tsx
git commit -m "feat(web): generic command dialog with confirm tiers and the answer-questions dialog"
```

---

### Task 9: Entry points: run actions, Tools and Jobs pages

**Files:**
- Create: `web/src/client/RunActions.tsx`, `web/src/client/ToolsPage.tsx`, `web/src/client/JobsPage.tsx`
- Modify: `web/src/client/ProjectView.tsx`, `web/src/client/App.tsx`

**Interfaces:**
- Consumes: `CommandDialog`, `AnswerDialog`, `getJobs`, `getJob`, `exitInfo`.
- Produces:
  - `<RunActions project: string run?: Run />` — toolbar: 新任務, 整理記憶, 檢查設定 always; 續跑／追問, 刪除這次任務 for a non-running run; 回答問題 when `run.ask.unanswered > 0`.
  - `<ToolsPage projects: string[] />`, `<JobsPage />`.
  - Hash views: `#!tools`, `#!jobs`.

- [ ] **Step 1: Write `RunActions.tsx`**

```tsx
import { useState } from "react";
import type { Run } from "../types";
import { AnswerDialog } from "./AnswerDialog";
import { CommandDialog } from "./CommandDialog";
import type { CommandId } from "../commands";

type Open = { id: CommandId; initial?: Record<string, unknown>; title?: string } | "answer" | undefined;

const btn = "min-h-11 rounded-lg border border-line bg-paper px-3 text-sm hover:bg-wall focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal";

export function RunActions({ project, run }: { project: string; run?: Run }) {
  const [open, setOpen] = useState<Open>();
  const close = () => setOpen(undefined);
  const idle = run && run.state !== "running";
  const waiting = !!run?.ask && run.ask.unanswered > 0;
  return (
    <>
      <div role="toolbar" aria-label="操作" className="flex flex-wrap gap-2">
        <button type="button" className={btn} onClick={() => setOpen({ id: "run" })}>
          新任務
        </button>
        {waiting && run && (
          <button type="button" className={`${btn} border-warn/60 bg-warn-soft text-warn`} onClick={() => setOpen("answer")}>
            回答問題（{run.ask?.unanswered}）
          </button>
        )}
        {idle && run && (
          <>
            <button type="button" className={btn} onClick={() => setOpen({ id: "resume", initial: { run: run.run_id } })}>
              續跑／追問
            </button>
            <button type="button" className={btn} onClick={() => setOpen({ id: "clear", initial: { run: run.run_id } })}>
              刪除這次任務
            </button>
          </>
        )}
        <button type="button" className={btn} onClick={() => setOpen({ id: "tidy" })}>
          整理記憶
        </button>
        <button type="button" className={btn} onClick={() => setOpen({ id: "doctor" })}>
          檢查設定
        </button>
      </div>
      {open && open !== "answer" && <CommandDialog id={open.id} open fixed={{ project }} initial={open.initial} onClose={close} />}
      {run && <AnswerDialog project={project} runId={run.run_id} open={open === "answer"} onClose={close} />}
    </>
  );
}
```

Note: `CommandDialog` is mounted only while open so each open starts clean; its `open` prop is therefore always `true` there.

- [ ] **Step 2: Write `ToolsPage.tsx`**

```tsx
import { useState } from "react";
import { COMMANDS, type CommandId } from "../commands";
import { CommandDialog } from "./CommandDialog";

const TOOLS: { id: CommandId; blurb: string }[] = [
  { id: "project.add", blurb: "把一個 repo 註冊成專案。" },
  { id: "project.remove", blurb: "取消註冊；預設保留 context。" },
  { id: "call", blurb: "不開專案，直接請全域 library 的某位 agent 做一件事。" },
  { id: "clear.lock", blurb: "run 當掉後留下的鎖，確認沒人在跑再清。" },
  { id: "demo", blurb: "在沙盒裡跑一次完整示範。" },
  { id: "init", blurb: "建立 home 與預設的全域 agent library。" },
];

export function ToolsPage({ projects }: { projects: string[] }) {
  const [open, setOpen] = useState<CommandId>();
  return (
    <article className="enter animate-in fade-in p-4 duration-200 sm:p-6">
      <h1 className="text-balance text-2xl font-semibold tracking-tight">工具</h1>
      <p className="text-pretty mt-2 text-sm">專案內的操作（新任務、續跑、回答問題…）在各專案頁面上。這裡放不屬於單一專案的。</p>
      <ul className="mt-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {TOOLS.map((t) => (
          <li key={t.id} className="panel flex flex-col gap-3 p-4">
            <h2 className="font-medium">{COMMANDS[t.id].label}</h2>
            <p className="text-pretty text-sm text-ink/70">{t.blurb}</p>
            <button
              type="button"
              className="mt-auto min-h-11 self-start rounded-lg border border-line bg-paper px-4 text-sm hover:bg-wall focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal"
              onClick={() => setOpen(t.id)}
            >
              {COMMANDS[t.id].label}…
            </button>
          </li>
        ))}
      </ul>
      {open && (
        <CommandDialog
          id={open}
          open
          fieldOptions={open === "project.remove" ? { name: projects } : open === "clear.lock" ? { project: projects } : undefined}
          onClose={() => setOpen(undefined)}
        />
      )}
    </article>
  );
}
```

- [ ] **Step 3: Write `JobsPage.tsx`**

```tsx
import { useEffect, useState } from "react";
import { getJob, getJobs, type JobDetail, type JobSummary } from "./api";
import { cn } from "./cn";
import { exitInfo } from "./exit-info";

const STATE = { running: "執行中", ended: "已結束", lost: "已結束（結束碼不明）" } as const;

export function JobsPage() {
  const [jobs, setJobs] = useState<JobSummary[]>([]);
  const [picked, setPicked] = useState<string>();
  const [detail, setDetail] = useState<JobDetail>();

  useEffect(() => {
    let live = true;
    const load = () => void getJobs().then((list) => live && setJobs(list));
    load();
    const timer = window.setInterval(load, 3000);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    if (!picked) return setDetail(undefined);
    let live = true;
    const load = () => void getJob(picked).then((d) => live && setDetail(d));
    load();
    const timer = window.setInterval(load, 2000);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [picked]);

  return (
    <article className="enter animate-in fade-in p-4 duration-200 sm:p-6">
      <h1 className="text-balance text-2xl font-semibold tracking-tight">任務輸出</h1>
      <p className="text-pretty mt-2 text-sm">從網頁啟動的背景指令。它們獨立於這個頁面，關掉頁面也會繼續跑。</p>
      {jobs.length === 0 ? (
        <p className="mt-6 text-sm">還沒有從網頁啟動過的背景指令。</p>
      ) : (
        <ul className="mt-6 flex flex-col gap-2">
          {jobs.map((j) => {
            const info = j.state === "ended" ? exitInfo(j.exit ?? null, false) : undefined;
            return (
              <li key={j.id}>
                <button
                  type="button"
                  aria-pressed={picked === j.id}
                  className={cn("panel flex min-h-11 w-full flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2 text-left text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal", picked === j.id && "border-ink/40")}
                  onClick={() => setPicked(picked === j.id ? undefined : j.id)}
                >
                  <span className="font-mono">{j.command}</span>
                  <span className="text-ink/60">{new Date(j.started_at).toLocaleString()}</span>
                  <span className={cn(j.state === "running" ? "text-signal" : info?.tone === "ok" ? "text-signal" : info?.tone === "warn" ? "text-warn" : j.state === "lost" ? "text-warn" : "text-failed")}>
                    {j.state === "ended" && info ? info.text : STATE[j.state]}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {detail && (
        <section aria-label="輸出" className="mt-6">
          <p className="eyebrow">{detail.argv.join(" ")}</p>
          <pre className="mt-2 max-h-[60dvh] overflow-auto rounded-lg border border-line bg-paper p-3 font-mono text-xs whitespace-pre-wrap">{detail.tail || "（還沒有輸出）"}</pre>
        </section>
      )}
    </article>
  );
}
```

- [ ] **Step 4: Mount in `ProjectView.tsx` and `App.tsx`**

`ProjectView.tsx`:
- add `import { RunActions } from "./RunActions";`
- inside the `<header>` of the main return, directly after the `{run ? <RunHeader .../> : (...)}` block and before `</header>`, add `<div className="mt-4"><RunActions project={name} run={run} /></div>`.
- In the early-return error branch (`frame.error`), leave unchanged (no actions on a broken project).

`App.tsx`:
- imports: `import { JobsPage } from "./JobsPage";` and `import { ToolsPage } from "./ToolsPage";`
- `readHash` return type becomes `{ project?: string; run?: string; view?: "tools" | "jobs" }`, and right after `if (!raw) return {};` add: `if (raw === "!tools" || raw === "!jobs") return { view: raw === "!tools" ? "tools" : "jobs" };`
- In the nav, just before the `{live === "down" && (` button for narrow screens, add two links (they sit in the same flex container, so they scroll with the project buttons on narrow screens and stack on wide ones):

```tsx
        <div className="flex items-center gap-2 md:mt-4 md:flex-col md:items-stretch md:border-t md:border-line md:pt-3">
          {([["tools", "工具"], ["jobs", "任務輸出"]] as const).map(([view, label]) => (
            <a
              key={view}
              href={`#!${view}`}
              aria-current={hash.view === view ? "page" : undefined}
              className={cn(
                "inline-flex min-h-11 min-w-24 shrink-0 items-center rounded-lg border px-3 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal",
                hash.view === view ? "border-line bg-wall" : "border-transparent hover:bg-wall/70",
              )}
            >
              {label}
            </a>
          ))}
        </div>
```
- In `<main>`, replace `{frame && selected ? (...) : (...)}` with a leading branch: `{hash.view === "tools" ? <ToolsPage projects={names} /> : hash.view === "jobs" ? <JobsPage /> : frame && selected ? (<ProjectView .../>) : (<article ...>...</article>)}` (keep the existing `ProjectView` and fallback article JSX unchanged inside the last two branches).
- `const selected = hash.project && ...` stays; when `hash.view` is set, `hash.project` is undefined so `selected` falls back to the first project, which only affects the highlight. Make the highlight honest: change `const on = name === selected;` to `const on = !hash.view && name === selected;`.

- [ ] **Step 5: Typecheck, lint, build**

Run: `pnpm --dir web typecheck && npm run lint && pnpm --dir web build`
Expected: clean build into `web/dist/public`.

- [ ] **Step 6: Commit**

```bash
git add web/src/client
git commit -m "feat(web): run actions on project pages, Tools and Jobs views"
```

---

### Task 10: Coverage guard and docs

**Files:**
- Create: `test/web-console-coverage.test.ts`, `docs/web-console.md`, `docs/web-console.zh-TW.md`
- Modify: `docs/commands.md`, `docs/commands.zh-TW.md`, `README.md`, `README.zh-TW.md`, `scripts/check-docs.mjs`

- [ ] **Step 1: Write the coverage test**

Create `test/web-console-coverage.test.ts`:

```ts
import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { COMMANDS } from "../web/src/commands.js";

const cli = fs.readFileSync(new URL("../src/cli.ts", import.meta.url), "utf8");

/** Commands registered on the CLI: top level (`program\n  .command("x")`) and under `project`. */
function registered(): string[] {
  const top = [...cli.matchAll(/(?:^|\s)program\s*\n\s*\.command\("([a-z-]+)/g)].map((m) => m[1] as string);
  const sub = [...cli.matchAll(/^project\s*\n\s*\.command\("([a-z-]+)/gm)].map((m) => `project ${m[1] as string}`);
  return [...top, ...sub];
}

/** Every CLI command and the web command ids that cover it. */
const COVERED: Record<string, string[]> = {
  init: ["init"],
  project: ["project.list"],
  "project add": ["project.add"],
  "project remove": ["project.remove"],
  run: ["run"],
  call: ["call"],
  resume: ["resume"],
  clear: ["clear", "clear.lock"],
  doctor: ["doctor"],
  tidy: ["tidy"],
  demo: ["demo"],
};

/** Commands the web console deliberately does not run, with the reason. */
const UNSUPPORTED: Record<string, string> = {
  status: "read-only: the live page is the status view, and `status --web` is the server itself",
};

describe("web console covers the CLI", () => {
  it("finds the CLI commands (guards the regex itself)", () => {
    expect(registered()).toEqual(expect.arrayContaining(["init", "run", "resume", "clear", "doctor", "call", "tidy", "status", "demo", "project add", "project remove"]));
  });
  it("every CLI command is covered or explicitly unsupported", () => {
    const missing = registered().filter((c) => !(c in COVERED) && !(c in UNSUPPORTED));
    expect(missing, `CLI commands with no web entry: ${missing.join(", ")}. Add them to web/src/commands.ts, or list them in UNSUPPORTED with a reason.`).toEqual([]);
  });
  it("every covered id exists, and every web id is claimed", () => {
    const claimed = Object.values(COVERED).flat();
    for (const id of claimed) expect(Object.keys(COMMANDS)).toContain(id);
    for (const id of Object.keys(COMMANDS)) expect(claimed).toContain(id);
  });
});
```

Run: `npx vitest run test/web-console-coverage.test.ts`
Expected: PASS. If the "finds the CLI commands" test fails, adjust the two regexes to the real formatting in `src/cli.ts` (the commands are declared as `program\n  .command("init")` and `project\n  .command("add <name>")`).

- [ ] **Step 2: Write the docs**

Create `docs/web-console.md` with exactly these headings (the zh-TW file must have the same heading levels in the same order, which `npm run check:docs` enforces):

```markdown
# Web console

Run every agent-lyceum command from the `status --web` page. Local use only; see [Security](#security).

## Where each command is

| CLI | In the page |
| --- | --- |
| `run` | A project page, **新任務** |
| `resume` (follow-up, continue) | A project page, **續跑／追問** on a run that is not running |
| `resume --answer` | A project page, **回答問題** on a run that is waiting |
| `clear` | A project page, **刪除這次任務** |
| `tidy` | A project page, **整理記憶** |
| `doctor` | A project page, **檢查設定** |
| `project`, `project add`, `project remove` | **工具** |
| `call`, `demo`, `init` | **工具** |
| `clear --lock --force` | **工具** |
| `status` | The page itself |

Commands that can run for a long time (`run`, `resume`, `call`, `tidy`, `demo`) start in the background and keep running if you close the page or stop `status --web`. Their output is under **任務輸出** (`<home>/web-jobs/<id>/out.log`).

## Confirmation

- Normal: runs at once.
- Confirm: `clear`, `tidy`, `project remove`. The page first shows a dry run, then asks. The server refuses the request (HTTP 428) without `confirm: true`.
- Type to confirm: `project remove --purge`, `clear --lock --force`. You type the project name or run id.

## Security

- The write API (`POST /api/*`) needs a matching `Host`, a same-origin `Origin` and the page's per-start token.
- It is **refused when `--host` is not a loopback address**. There is no flag to turn it on; exposing the console to a network is not supported.
- Every command is started as an argument list, never through a shell. Task text is passed after `--`, so it cannot be read as an option.

## Limits

- A request body is at most 256 KB; a command that finishes in the foreground is stopped after 120 seconds.
- If the server was restarted while the page was open, the page asks you to reload (the token changed).
- A background job's exit code is kept in `exit.json`. If the job's process vanished without writing it, the page shows the job as "ended (exit code unknown)".
```

Create `docs/web-console.zh-TW.md` with the same structure in Traditional Chinese (same heading levels: one `#`, then four `##`; the table, bullet lists and the same anchors: the `[Security](#security)` link becomes `[安全](#安全)` and the heading is `## 安全`). Title: `# 網頁操作台`; headings: `## 各指令在哪裡`, `## 確認`, `## 安全`, `## 限制`. Translate every row and bullet from the English file faithfully (keep the page button names such as **新任務** as they are).

- [ ] **Step 3: Update `docs/commands.md` and `.zh-TW.md`**

In the `--web` bullet under `## status`, append (English file) after the sentence ending `...Build the page first: \`pnpm --dir web install && pnpm --dir web build\`.`:

```
 The page can also run every other command; see [Web console](web-console.md). **Breaking:** with `--host` set to a non-loopback address, the write API (`POST /api/*`) is refused with HTTP 403 and cannot be enabled; the read-only page still works.
```

Add the equivalent Chinese sentence (`頁面也能執行其他所有指令，見[網頁操作台](web-console.zh-TW.md)。**重大變更：**`--host` 設成非 loopback 位址時，寫入 API（`POST /api/*`）一律回 HTTP 403，也無法開啟；唯讀的頁面照常可用。`) to the matching bullet in `docs/commands.zh-TW.md`.

In `README.md` and `README.zh-TW.md` add one row to the "Guides" table (the one that contains the `Web access` row around line 90): English `| Running commands from the browser | [Web console](docs/web-console.md) |`, Chinese the equivalent with `docs/web-console.zh-TW.md`.

- [ ] **Step 4: Register the pair in `scripts/check-docs.mjs`**

Add `['docs/web-console.md', 'docs/web-console.zh-TW.md'],` after the `web-access` pair in `PAIRS`.

- [ ] **Step 5: Run checks**

Run: `npm run check:docs && npx vitest run test/web-console-coverage.test.ts`
Expected: both pass. Fix any heading-structure or anchor mismatch the checker reports.

- [ ] **Step 6: Commit**

```bash
git add test/web-console-coverage.test.ts docs/web-console.md docs/web-console.zh-TW.md docs/commands.md docs/commands.zh-TW.md README.md README.zh-TW.md scripts/check-docs.mjs
git commit -m "docs(web): web console guide, coverage test that keeps it complete with the CLI"
```

---

### Task 11: Full verification in a real browser

**Files:** none (verification only; fix defects in the files above and re-run).

- [ ] **Step 1: Full automated suite**

Run: `npm run typecheck && npm test && npm run lint && npm run check:docs && pnpm --dir web typecheck && pnpm --dir web build`
Expected: everything passes. Report any failure with its output; do not claim success otherwise.

- [ ] **Step 2: Start the server against a throwaway home**

Run (background): `AGENT_LYCEUM_HOME=$(mktemp -d) npx tsx src/cli.ts status --web --no-open --port 8799`
Then register a throwaway repo through the API-less CLI so the page has a project: `mkdir -p /tmp/lyceum-demo-repo && git -C /tmp/lyceum-demo-repo init -q && AGENT_LYCEUM_HOME=<same dir> npx tsx src/cli.ts init -y && AGENT_LYCEUM_HOME=<same dir> npx tsx src/cli.ts project add demo --dir /tmp/lyceum-demo-repo`.
Expected: the server prints `http://127.0.0.1:8799/`.

- [ ] **Step 3: Check the security behaviour with curl**

```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://127.0.0.1:8799/api/cmd/project.list -H 'Content-Type: application/json' -d '{}'
# expect 403 (no Origin, no token)
TOKEN=$(curl -s http://127.0.0.1:8799/ | sed -n 's/.*name="lyceum-token" content="\([0-9a-f]*\)".*/\1/p')
curl -s -X POST http://127.0.0.1:8799/api/cmd/project.list -H 'Content-Type: application/json' -H "Origin: http://127.0.0.1:8799" -H "X-Lyceum-Token: $TOKEN" -d '{}'
# expect 200 JSON whose stdout lists "demo"
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://127.0.0.1:8799/api/cmd/clear -H 'Content-Type: application/json' -H "Origin: http://127.0.0.1:8799" -H "X-Lyceum-Token: $TOKEN" -d '{"project":"demo","run":"x"}'
# expect 428
```

- [ ] **Step 4: Walk through the page in a browser**

Open `http://127.0.0.1:8799/` and check, ticking each off:
1. 工具 → 註冊專案 opens a dialog; Esc closes it; focus returns to the button.
2. Submitting an empty 新任務 shows the error beside the 任務 field and focus stays usable by keyboard only.
3. 刪除這次任務 on a finished run shows the dry-run preview first, Cancel has focus, the red button deletes only after click.
4. 移除專案 with 連 context 一起刪除 ticked requires typing the project name before the button enables.
5. 新任務 (use a throwaway task, or `工具 → 示範 → 只建立沙盒`) returns "已在背景啟動"; 任務輸出 lists it with its log; stopping `status --web` and starting it again still lists the job.
6. Dark mode (OS setting): text and the red/amber/green states stay readable; narrow the window to phone width: no horizontal scroll, buttons still 44 px high.
7. Tab through a dialog: every control shows a visible focus ring and the order matches the visual order.
8. Stop the server, start it again, and press a button on the *old* open page: it says the page expired and asks for a reload.

Run the ui-ux-pro-max pre-delivery checks (contrast, focus ring, keyboard path, reduced motion) against what you saw and fix anything that fails.

- [ ] **Step 5: Stop the server and clean up**

Stop the background server, `rm -rf /tmp/lyceum-demo-repo` and the throwaway home. Then report: which of the 8 checks passed, any that were not run, and the full-suite output summary.

- [ ] **Step 6: Commit any fixes**

```bash
git add -A
git commit -m "fix(web): issues found while verifying the console in a browser"
```
(Skip when nothing changed.)
