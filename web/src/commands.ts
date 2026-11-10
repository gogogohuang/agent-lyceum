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
      if (dir.startsWith("~")) throw new ArgError("dir", "路徑請用絕對路徑，不支援 ~。");
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
