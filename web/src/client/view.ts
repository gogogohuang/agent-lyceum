import type { Agent, Run, StatusReport, Wake, WatchFrame } from "../types";

const OUTCOME: Record<string, string> = {
  completed: "完成",
  partial: "部分完成",
  blocked: "受阻",
  failed: "失敗",
  waiting: "等待回答",
  cancelled: "已取消",
};

export function tokenText(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** Same branches as the terminal monitor's `runLabel`. */
export function runLabel(run: Run): string {
  if (run.state === "running") return "執行中";
  if (run.state === "interrupted") return "已中斷";
  if (!run.outcome_verified) return run.end_reason === "done" ? "完成（未驗證）" : `結束：${run.end_reason === "waiting" ? "等待回答" : (run.end_reason ?? "?")}`;
  return OUTCOME[run.outcome ?? ""] ?? run.outcome ?? "結束";
}

/** A task stays listed until it completed. */
export function isOpen(run: Run): boolean {
  return !(run.state === "ended" && run.outcome === "completed");
}

export function roundsLabel(rounds: number, limit: number): string {
  return limit > 0 ? `${rounds}/${limit}` : String(rounds);
}

export function progress(run: Run): string {
  const steps = run.steps ?? [];
  return steps.length ? `${steps.filter((step) => step.done).length}/${steps.length} 步` : `${roundsLabel(run.rounds, run.max_rounds)} 輪`;
}

export function agentLabel(agent: Agent): string {
  return agent.instance !== undefined && agent.instance >= 2 && agent.role ? `${agent.role} #${agent.instance}` : agent.name;
}

/** Every task on the page, newest first, including ones that already finished. */
export function openReports(frame: WatchFrame): StatusReport[] {
  const list = Object.values(frame.runs ?? {});
  const reports = (list.length > 0 ? list : frame.report ? [frame.report] : []).filter((report) => report.run);
  return reports.sort((a, b) => started(b) - started(a));
}

/** The task to show first: one that is running, otherwise one that is not finished, otherwise the newest. */
export function focusReport(frame: WatchFrame): StatusReport | undefined {
  const reports = openReports(frame);
  return reports.find((report) => report.run?.state === "running") ?? reports.find((report) => report.run && isOpen(report.run)) ?? reports[0];
}

function started(report: StatusReport): number {
  const ms = Date.parse(report.run?.started_at ?? "");
  return Number.isFinite(ms) ? ms : -Infinity;
}

export function cacheText(read: number, write: number): string {
  const total = read + write;
  if (total <= 0) return "";
  return `快取 讀 ${tokenText(read)} 寫 ${tokenText(write)} 命中 ${Math.round((100 * read) / total)}%`;
}

export function elapsed(since: string, now: number): string {
  const ms = now - Date.parse(since);
  if (!Number.isFinite(ms) || ms < 0) return "";
  const s = Math.floor(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
}

/** A running run counts up to `now`. Anything else freezes at `ended_at`, else the latest wake, else 0s. */
export function runElapsed(run: Run, now: number): string {
  if (run.state === "running") return elapsed(run.started_at, now) || "0s";
  const end = stoppedAt(run);
  if (end === undefined) return "0s";
  return elapsed(run.started_at, end) || "0s";
}

function stoppedAt(run: Run): number | undefined {
  const ended = Date.parse(run.ended_at ?? "");
  if (Number.isFinite(ended)) return ended;
  let latest = Number.NEGATIVE_INFINITY;
  for (const wake of run.wakes ?? []) {
    const at = Date.parse(wake.at);
    if (Number.isFinite(at) && at > latest) latest = at;
  }
  return latest === Number.NEGATIVE_INFINITY ? undefined : latest;
}

export function clock(ms: number): string {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export type LaneBar = { x: number; width: number; ok: boolean; live: boolean; title: string };
export type Lane = { agent: string; bars: LaneBar[] };

export function timeline(run: Run | undefined, agents: Agent[], now: number): { start: number; end: number; lanes: Lane[] } | null {
  if (!run) return null;
  const points: { agent: string; start: number; end: number; ok: boolean; live: boolean; title: string }[] = [];
  for (const wake of run.wakes) {
    const start = Date.parse(wake.at);
    if (!Number.isFinite(start)) continue;
    const end = start + Math.max(0, wake.duration_ms);
    points.push({
      agent: wake.agent,
      start,
      end,
      ok: wake.ok,
      live: false,
      title: wakeTitle(wake),
    });
  }
  if (run.state === "running") {
    for (const [agent, active] of Object.entries(run.active)) {
      const start = Date.parse(active.since);
      if (!Number.isFinite(start)) continue;
      points.push({
        agent,
        start,
        end: Math.max(now, start),
        ok: true,
        live: true,
        title: `${agent} 第 ${active.round ?? "?"} 輪，進行中 ${elapsed(active.since, now)}`,
      });
    }
  }
  if (!points.length) return null;
  const start = Math.min(...points.map((p) => p.start));
  const end = Math.max(...points.map((p) => p.end), start + 1);
  const span = end - start;
  const names = [...new Set([...agents.map((a) => a.name), ...points.map((p) => p.agent)])];
  const lead = new Set(agents.filter((a) => a.lead).map((a) => a.name));
  names.sort((a, b) => Number(lead.has(b)) - Number(lead.has(a)) || a.localeCompare(b));
  const lanes = names
    .map((agent) => ({
      agent,
      bars: points
        .filter((p) => p.agent === agent)
        .map((p) => ({
          x: ((p.start - start) / span) * 1000,
          width: Math.max(4, ((p.end - p.start) / span) * 1000),
          ok: p.ok,
          live: p.live,
          title: p.title,
        })),
    }))
    .filter((lane) => lane.bars.length > 0);
  return { start, end, lanes };
}

function wakeTitle(wake: Wake): string {
  const tokens = wake.output_tokens ? `，${tokenText(wake.output_tokens)} token` : "";
  const model = wake.model ? `，${wake.runtime ?? ""}/${wake.model}` : "";
  const error = wake.error ? `，${wake.error}` : "";
  return `${wake.agent} 第 ${wake.round} 輪，${wake.ok ? "成功" : "失敗"}，${Math.round(wake.duration_ms / 1000)}s${tokens}${model}${error}`;
}

export type RecentMail = { from: string; to: string; type: string; subject: string };

export function recentMail(run: Run | undefined, limit = 6): RecentMail[] {
  const rows: RecentMail[] = [];
  for (const wake of [...(run?.wakes ?? [])].reverse()) {
    for (const sent of [...(wake.sent ?? [])].reverse()) {
      rows.push({ from: wake.agent, to: sent.to, type: sent.type, subject: sent.subject });
      if (rows.length >= limit) return rows;
    }
  }
  return rows;
}

export type TokenRow = { agent: string; output: number; cacheRead: number; cacheWrite: number; failed: number };

export function tokenRows(run?: Run): TokenRow[] {
  const by = new Map<string, TokenRow>();
  for (const wake of run?.wakes ?? []) {
    const row = by.get(wake.agent) ?? { agent: wake.agent, output: 0, cacheRead: 0, cacheWrite: 0, failed: 0 };
    row.output += wake.output_tokens ?? 0;
    row.cacheRead += wake.cache_read_tokens ?? 0;
    row.cacheWrite += wake.cache_write_tokens ?? 0;
    if (!wake.ok) row.failed += 1;
    by.set(wake.agent, row);
  }
  return [...by.values()].sort((a, b) => b.output - a.output);
}

export type Dot = "active" | "queued" | "failed" | "idle";

/** Same rule as the terminal monitor: only a running run has anyone working, failed or queued. */
export function agentDot(agent: Agent, run?: Run): Dot {
  if (run?.state !== "running") return "idle";
  if (run.active[agent.name]) return "active";
  if (agent.last_wake?.ok === false) return "failed";
  if ((run.queue ?? []).some((item) => item.agent === agent.name)) return "queued";
  return "idle";
}

const DOT_RANK: Record<Dot, number> = { active: 0, failed: 1, queued: 2, idle: 3 };

export function orderedAgents(agents: Agent[], run?: Run): Agent[] {
  const lead = agents.filter((agent) => agent.lead);
  const rest = agents.filter((agent) => !agent.lead).sort((a, b) => DOT_RANK[agentDot(a, run)] - DOT_RANK[agentDot(b, run)]);
  return [...lead, ...rest];
}

/** Agents in `run.active`, newest start first. Empty unless the run is still running. */
export function workingAgents(agents: Agent[], run?: Run): Agent[] {
  if (run?.state !== "running") return [];
  return agents
    .filter((agent) => agentDot(agent, run) === "active")
    .sort((a, b) => (run.active[b.name]?.since ?? "").localeCompare(run.active[a.name]?.since ?? "") || a.name.localeCompare(b.name));
}

export function activeLine(agent: Agent, run: Run, now: number): string {
  const active = run.active[agent.name];
  const round = active?.round ? ` #${active.round}` : "";
  const time = active ? ` ${elapsed(active.since, now)}` : "";
  return `進行中${round}${time}`.trim();
}

/** The most recent hand-off between two agents. A `done` goes to nobody. */
export function latestEdge(run?: Run): { from: string; to: string } | undefined {
  for (const wake of [...(run?.wakes ?? [])].reverse()) {
    const to = [...(wake.sent ?? [])].reverse().find((item) => item.to !== "(done)")?.to;
    if (to) return { from: wake.agent, to };
  }
  return undefined;
}

/** Who may write between the lead and one member. Hot when that pair is the latest hand-off. */
export function memberLink(lead: Agent, member: Agent, edge?: { from: string; to: string }): { glyph: "▼" | "▲" | "↕"; hot: boolean } | undefined {
  const down = (lead.can_message ?? []).includes(member.name);
  const up = (member.can_message ?? []).includes(lead.name);
  if (!down && !up) return undefined;
  const hot = !!edge && ((edge.from === lead.name && edge.to === member.name) || (edge.from === member.name && edge.to === lead.name));
  return { glyph: down && up ? "↕" : down ? "▼" : "▲", hot };
}

export function agentJobs(agent: Agent, run?: Run): string[] {
  const dot = agentDot(agent, run);
  if (dot === "active") return (run?.active[agent.name]?.handling ?? []).map(workText);
  if (dot === "queued") return (run?.queue ?? []).filter((item) => item.agent === agent.name).map(workText);
  if (dot === "failed" && agent.last_wake?.error) return [agent.last_wake.error];
  return [];
}

function workText(mail: { from?: string; subject: string; held?: true; type: string; digest?: { label: string; lines: string[] }[]; brief?: string }): string {
  const point = mailPoint(mail);
  const held = mail.held ? "（等待空閒實例）" : "";
  const who = mail.from ? `來自 ${mail.from} 的 ${mail.type}：` : "";
  const head = `${who}${mail.subject}${held}`;
  return point ? `${head}。${point}` : head;
}
const POINT: Record<string, string> = { task: "目標", reply: "變更", done: "結果" };
const ATTENTION = new Set(["待辦", "風險", "未完成"]);
const NOTHING = /^(none|n\/a|無|沒有)[.。]?$/i;

export function mailPoint(mail: { type: string; digest?: { label: string; lines: string[] }[]; brief?: string }): string {
  const sections = mail.digest ?? [];
  const point = sections.find((section) => section.label === POINT[mail.type]) ?? sections[0];
  const head = point?.lines[0] ?? mail.brief ?? "";
  const extra = sections
    .filter((section) => section !== point && ATTENTION.has(section.label))
    .flatMap((section) => section.lines.filter((line) => !NOTHING.test(line.trim())).slice(0, 1));
  return [head, ...extra].filter(Boolean).join(" ");
}
