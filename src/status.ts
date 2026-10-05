import fs from "node:fs";
import path from "node:path";
import { RESULT_FILE, type RunState, type WakeTopic } from "./dispatcher.js";
import type { ResolvedProject } from "./config.js";
import type { Step } from "./format.js";
import { listUnread, type Message } from "./mailbox.js";
import { enforcementFor } from "./policy.js";

export function latestRun(project: ResolvedProject): { dir: string; state: RunState } | undefined {
  const root = project.paths.runs;
  if (!fs.existsSync(root)) return undefined;
  const dirs = fs
    .readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
    .reverse();
  for (const d of dirs) {
    const f = path.join(root, d, "state.json");
    if (!fs.existsSync(f)) continue;
    try {
      return { dir: path.join(root, d), state: JSON.parse(fs.readFileSync(f, "utf8")) as RunState };
    } catch {
      /* skip unreadable */
    }
  }
  return undefined;
}

export function listRuns(project: ResolvedProject, limit: number): { dir: string; state: RunState }[] {
  const root = project.paths.runs;
  if (!fs.existsSync(root)) return [];
  const out: { dir: string; state: RunState }[] = [];
  const dirs = fs
    .readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
    .reverse();
  for (const d of dirs) {
    if (out.length >= limit) break;
    try {
      out.push({ dir: path.join(root, d), state: JSON.parse(fs.readFileSync(path.join(root, d, "state.json"), "utf8")) as RunState });
    } catch {
      /* skip unreadable */
    }
  }
  return out;
}

export function runIsAlive(s: { pid?: number }): boolean {
  return alive(s.pid);
}

function alive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function runStateLabel(s: RunState): string {
  if (s.end_reason) return `已結束：${s.end_reason === "done" ? "完成" : s.end_reason}`;
  return alive(s.pid) ? "執行中" : "已中斷";
}

/** ANSI styling; `paint(false)` returns identity functions so output stays plain for pipes and tests. */
export interface Paint {
  bold: (t: string) => string;
  dim: (t: string) => string;
  red: (t: string) => string;
  green: (t: string) => string;
  yellow: (t: string) => string;
  cyan: (t: string) => string;
}

export function paint(on: boolean): Paint {
  const wrap = (code: string) => (t: string) => (on ? `\x1b[${code}m${t}\x1b[0m` : t);
  return { bold: wrap("1"), dim: wrap("2"), red: wrap("31"), green: wrap("32"), yellow: wrap("33"), cyan: wrap("36") };
}

/** Color a run-state label: running green, interrupted yellow, ended done green / otherwise red. */
function stateColor(c: Paint, label: string): string {
  if (label === "執行中" || label === "已結束：完成") return c.green(label);
  return label === "已中斷" ? c.yellow(label) : c.red(label);
}

const okText = (c: Paint, ok: boolean) => (ok ? c.green("成功") : c.red("失敗"));
const LEVEL_ZH: Record<string, string> = {
  os: "系統強制",
  "tool-rules": "工具規則",
  "post-hoc": "事後偵測",
  "prompt-only": "僅提示",
  "n/a": "不適用",
};

/** Terminal columns: CJK characters take two. */
const cols = (t: string) => [...t].reduce((n, ch) => n + ((ch.codePointAt(0) ?? 0) >= 0x2e80 ? 2 : 1), 0);
const padCols = (t: string, n: number) => t + " ".repeat(Math.max(0, n - cols(t)));

const clip = (t: string, n: number) => (t.length > n ? t.slice(0, n - 1) + "…" : t);
const tokens = (n: number | undefined) => (n ? n.toLocaleString("en-US") : "0");

function since(iso: string, now: number): string {
  const sec = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  return sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m${String(sec % 60).padStart(2, "0")}s`;
}

function handlingText(h: WakeTopic[]): string {
  if (!h.length) return "（無訊息）";
  return h
    .map((m) => `來自 ${m.from} 的 ${m.type}：「${clip(m.subject, 60)}」${m.brief ? ` — ${clip(m.brief, 80)}` : ""}`)
    .join("; ");
}

const sentText = (sent: { to: string; type: string; subject: string }[] | undefined): string =>
  sent?.length
    ? sent.map((m) => (m.to === "(done)" ? `完成：「${clip(m.subject, 50)}」` : `${m.to} ← ${m.type}「${clip(m.subject, 50)}」`)).join("; ")
    : "未寄出信件";

export function progressBar(done: number, total: number, width = 10, c: Paint = paint(false)): string {
  const n = total ? Math.round((done / total) * width) : 0;
  return c.green("█".repeat(n)) + c.dim("░".repeat(width - n));
}

function stepsLine(steps: Step[] | undefined, c: Paint, finished = false): string | undefined {
  if (!steps?.length) return undefined;
  const done = steps.filter((x) => x.done).length;
  const cur = steps.find((x) => !x.done);
  const tail = !cur
    ? " — 全部完成"
    : finished
      ? ` — ${c.yellow(`⚠ lead 宣告完成，但仍有 ${steps.length - done} 項未勾選（如：${clip(cur.text, 60)}）`)}`
      : ` — 下一步：${clip(cur.text, 60)}`;
  return `${progressBar(done, steps.length, 10, c)} ${done}/${steps.length} 步驟${tail}`;
}

/** Agents in wake order, newest last; the ones working now are bracketed. */
function flowLine(s: RunState, live: boolean, c: Paint): string {
  const names = (s.wakes ?? []).map((w) => w.agent);
  const shown = names.slice(-7);
  const parts = shown.map((n) => c.cyan(n));
  const activeNames = live ? Object.keys(s.active ?? {}) : [];
  const out = (names.length > shown.length ? "… → " : "") + parts.join(" → ");
  if (!activeNames.length) return out || "（尚無）";
  return `${out}${out ? " → " : ""}${c.green(`[${activeNames.join(", ")}]`)}`;
}

/** Order the dispatcher will wake agents: the lead first, otherwise the oldest mail. */
function queuedNext(project: ResolvedProject): { agent: string; msg: Message }[] {
  const rows = Object.values(project.agents)
    .map((a) => ({ agent: a.name, msg: listUnread(project, a.name)[0] }))
    .filter((r): r is { agent: string; msg: Message } => !!r.msg);
  rows.sort((x, y) => {
    if ((x.agent === project.lead) !== (y.agent === project.lead)) return x.agent === project.lead ? -1 : 1;
    return path.basename(x.msg.file).localeCompare(path.basename(y.msg.file));
  });
  return rows;
}

const mailText = (m: Message) => `來自 ${m.meta.from} 的 ${m.meta.type}：「${clip(m.meta.subject, 60)}」`;

/** The readable top block: what is happening, what is next, how far along the task is. */
function summaryBlock(project: ResolvedProject, run: { dir?: string; state: RunState } | undefined, now: number, c: Paint): string[] {
  const L = (label: string) => c.bold(c.cyan(label)) + " ".repeat(Math.max(1, 10 - cols(label)));
  if (!run) return [`${L("現在：")}${c.dim("閒置（尚無執行紀錄）")}`];
  const s = run.state;
  const live = alive(s.pid) && !s.end_reason;
  const lines = [
    `${c.bold("執行 " + s.run_id)}  [${stateColor(c, runStateLabel(s))}]  第 ${s.rounds}/${s.max_rounds} 輪`,
    `${L("任務：")}${s.task_summary ?? (s.task_source === "file" ? `檔案 ${s.task_path}` : "文字")}`,
  ];

  const steps = stepsLine(s.steps, c, s.end_reason === "done");
  lines.push(`${L("進度：")}${steps ?? `無清單；已用 ${s.rounds}/${s.max_rounds} 輪（lead 可在信中加入 "## Steps" 清單）`}`);

  const active = Object.entries(s.active ?? {});
  if (active.length) {
    active.forEach(([agent, a], i) =>
      lines.push(
        `${i === 0 ? L("現在：") : "          "}${c.cyan(agent)} ${live ? c.green(`工作中 ${since(a.since, now)}`) : c.yellow("曾在工作（已中斷）")}，處理 ${handlingText(a.handling)}`,
      ),
    );
  } else lines.push(`${L("現在：")}${c.dim(`閒置${s.end_reason ? `（執行已結束：${s.end_reason}）` : live ? "" : "（執行未在運作）"}`)}`);

  const queue = live || !s.end_reason ? queuedNext(project) : [];
  if (queue.length) {
    queue.slice(0, 3).forEach((q, i) => lines.push(`${i === 0 ? L("下一個：") : "          "}${c.cyan(q.agent)} ← ${mailText(q.msg)}`));
    if (queue.length > 3) lines.push(c.dim(`          … 還有 ${queue.length - 3} 筆`));
  } else if (active.length && live) lines.push(`${L("下一個：")}${c.dim("等工作中的 agent 完成後，再轉送其信件")}`);
  else lines.push(`${L("下一個：")}${c.dim(s.end_reason === "done" ? "無 — lead 已完成任務" : "無待處理")}`);

  const result = run.dir ? path.join(run.dir, RESULT_FILE) : "";
  if (s.end_reason === "done" && result && fs.existsSync(result)) {
    const head = fs.readFileSync(result, "utf8").split("\n").filter((l) => l.trim()).slice(0, 4).map((l) => clip(l, 80));
    lines.push(`${L("結果：")}${result}`, ...head.map((l) => c.dim("          " + l)));
  }
  const lastWake = (s.wakes ?? []).at(-1);
  if (lastWake) lines.push(`${L("上一次：")}#${lastWake.round} ${c.cyan(lastWake.agent)} ${okText(c, lastWake.ok)} → ${sentText(lastWake.sent)}`);
  lines.push(`${L("流程：")}${flowLine(s, live, c)}`);
  return lines;
}

/** What a run is doing / did, one line per wake. */
function describeRun(s: RunState, now: number, c: Paint): string[] {
  const lines = [
    `${c.bold("執行 " + s.run_id)}  [${stateColor(c, runStateLabel(s))}]  輪次 ${s.rounds}/${s.max_rounds}  輸出 tokens ${tokens(s.output_tokens)}`,
    `  任務：${s.task_summary ?? (s.task_source === "file" ? `檔案 ${s.task_path}` : "文字")}`,
  ];
  const steps = stepsLine(s.steps, c);
  if (steps) lines.push(`  進度：${steps}`);
  for (const w of s.wakes ?? []) {
    lines.push(
      `  #${w.round} ${c.cyan(w.agent)} ${okText(c, w.ok)} (${Math.round(w.duration_ms / 1000)}s, ${tokens(w.output_tokens)} tok) — ${handlingText(w.handling)}`,
      `      → ${sentText(w.sent)}`,
    );
  }
  for (const [agent, a] of Object.entries(s.active ?? {})) {
    lines.push(`  #${a.round} ${c.cyan(agent)} ${c.green(`工作中 ${since(a.since, now)}`)} — ${handlingText(a.handling)}`);
  }
  return lines;
}

/** Live view: summary and agent table, plus the most recent runs wake by wake. */
export function formatMonitor(project: ResolvedProject, runLimit = 3, now = Date.now(), color = false): string {
  const c = paint(color);
  const runs = listRuns(project, runLimit);
  const out = [formatStatus(project, now, color), "", c.bold("執行紀錄（新到舊）：")];
  if (runs.length === 0) out.push("  無");
  for (const r of runs) out.push("", ...describeRun(r.state, now, c));
  return out.join("\n");
}

export function formatStatus(project: ResolvedProject, now = Date.now(), color = false): string {
  const c = paint(color);
  const run = latestRun(project);
  const rows = [["成員", "執行環境", "未讀", "防護", "上次喚醒"]];
  for (const a of Object.values(project.agents)) {
    const e = enforcementFor(project, a);
    const lw = run?.state.last_wake[a.name];
    const levels = [...new Set([e.memory, e.agentMd, e.otherContext, e.repoInstructions])].map((l) => LEVEL_ZH[l] ?? l).join("/");
    rows.push([
      a.name + (a.name === project.lead ? " (lead)" : ""),
      a.runtime ?? "?",
      String(listUnread(project, a.name).length),
      levels,
      lw ? `${lw.ok ? "成功" : "失敗"} ${lw.at}` : "-",
    ]);
  }
  const w = rows[0].map((_, i) => Math.max(...rows.map((r) => cols(r[i]))));
  // Pad on the plain text first so ANSI codes never skew the column widths.
  const cell = (r: string[], ri: number, i: number): string => {
    const t = i === r.length - 1 ? r[i] : padCols(r[i], w[i]); // no trailing padding, as in plain output
    if (ri === 0) return c.bold(t);
    if (i === 0) return r[0].endsWith("(lead)") ? c.cyan(t) : t;
    if (i === 2) return r[2] === "0" ? c.dim(t) : c.yellow(t);
    if (i === 4) return r[4].startsWith("失敗") ? c.red(t) : r[4].startsWith("成功") ? c.green(t) : c.dim(t);
    return t;
  };
  const table = rows.map((r, ri) => r.map((_, i) => cell(r, ri, i)).join("  ").trimEnd());
  table.splice(1, 0, c.dim(w.map((n) => "-".repeat(n)).join("  ")));

  const lines = [`${c.bold("專案：")}${project.name}  ${c.dim(`（repo：${project.dir}）`)}`, "", ...summaryBlock(project, run, now, c), "", ...table];
  if (run) lines.push("", `輸出 tokens：${tokens(run.state.output_tokens)}`);
  return lines.join("\n");
}
