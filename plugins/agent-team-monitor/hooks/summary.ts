import type { Agent, Report, Run, Wake } from '../types'

const OUTCOME: Record<string, string> = { completed: '完成', partial: '部分完成', blocked: '受阻', failed: '失敗', cancelled: '已取消' }

export function runLabel(r: Run): string {
  if (r.state === 'running') return '執行中'
  if (r.state === 'interrupted') return '已中斷'
  if (!r.outcome_verified) return r.end_reason === 'done' ? '完成（未驗證）' : `結束：${r.end_reason ?? '?'}`
  return OUTCOME[r.outcome ?? ''] ?? r.outcome ?? '結束'
}

export function progress(r: Run): string {
  const steps = r.steps ?? []
  return steps.length ? `${steps.filter(s => s.done).length}/${steps.length} 步` : `${r.rounds}/${r.max_rounds} 輪`
}

export function clip(t: string, n: number): string {
  return t.length > n ? t.slice(0, n - 1) + '…' : t
}

/** "26s" / "3m05s" since an ISO time; empty when the time is unusable. */
export function elapsed(since: string, now: number): string {
  const ms = now - Date.parse(since)
  if (!Number.isFinite(ms) || ms < 0) return ''
  const s = Math.floor(ms / 1000)
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`
}

/** 96328 -> "96.3k", 1500000 -> "1.5M". */
export function tokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}

/** Output tokens per runtime (the LLM CLI an agent runs on), largest first. */
export function runtimeTokens(wakes: Wake[], agents: Agent[]): { runtime: string; tokens: number }[] {
  const of = new Map(agents.map(a => [a.name, a.runtime ?? '?']))
  const by = new Map<string, number>()
  for (const w of wakes) {
    const rt = of.get(w.agent) ?? '?'
    by.set(rt, (by.get(rt) ?? 0) + (w.output_tokens ?? 0))
  }
  return [...by].map(([runtime, tokens]) => ({ runtime, tokens })).sort((a, b) => b.tokens - a.tokens)
}

/** "claude-code 80.1k · codex 16.2k". */
export function runtimeTokensLabel(wakes: Wake[], agents: Agent[]): string {
  return runtimeTokens(wakes, agents).map(r => `${r.runtime} ${tokens(r.tokens)}`).join(' · ')
}

/** One line for the status line; undefined clears it. */
export function statusLine(report: Report | null): string | undefined {
  const run = report?.run
  if (!run) return undefined
  const unread = report.agents.reduce((n, a) => n + a.unread, 0)
  const active = Object.keys(run.active)
  const who = run.state === 'running' && active.length ? ` [${active.join(',')}]` : ''
  const step = run.state === 'running' && run.current_step ? ` · ${clip(run.current_step, 24)}` : ''
  return `team ${runLabel(run)} ${progress(run)} · ${runtimeTokensLabel(run.wakes, report.agents) || `${tokens(run.output_tokens)} tok`}${who}${step}${unread ? ` · ${unread} 未讀` : ''}`
}

/** The toast for a change between two polls, if any. */
export function transition(prev: Report | null, next: Report | null): string | undefined {
  const a = prev?.run
  const b = next?.run
  if (!b) return undefined
  if (a && a.run_id === b.run_id) {
    if (a.state === 'running' && b.state === 'interrupted') return `agent-team 執行 ${b.run_id} 已中斷`
    if (a.state === 'running' && b.state === 'ended') return `agent-team 執行 ${b.run_id}：${runLabel(b)}`
    const seen = a.wakes.length
    const bad = b.wakes.slice(seen).find(w => !w.ok)
    if (bad) return `${bad.agent} 第 ${bad.round} 輪失敗${bad.error ? `：${bad.error.slice(0, 80)}` : ''}`
  }
  return undefined
}

export type AgentStat = { agent: string; wakes: number; failed: number; tokens: number; avgSeconds: number }

/** Per-agent wake count, failures, output tokens and mean wake length. */
export function agentStats(wakes: Wake[]): AgentStat[] {
  const by = new Map<string, Wake[]>()
  for (const w of wakes) by.set(w.agent, [...(by.get(w.agent) ?? []), w])
  return [...by].map(([agent, ws]) => ({
    agent,
    wakes: ws.length,
    failed: ws.filter(w => !w.ok).length,
    tokens: ws.reduce((n, w) => n + (w.output_tokens ?? 0), 0),
    avgSeconds: Math.round(ws.reduce((n, w) => n + w.duration_ms, 0) / ws.length / 1000),
  }))
}

/** A note / result line of unknown shape as one line of text. */
export function line(x: unknown): string {
  return typeof x === 'string' ? x : JSON.stringify(x)
}

/** Status line for several projects at once; a single report keeps the one-project format. */
export function overviewLine(reports: Report[]): string | undefined {
  const withRun = reports.filter(r => r.run)
  if (reports.length <= 1) return statusLine(reports[0] ?? null)
  if (!withRun.length) return undefined
  const running = withRun.filter(r => r.run?.state === 'running').length
  const unread = withRun.reduce((n, r) => n + r.agents.reduce((m, a) => m + a.unread, 0), 0)
  const parts = withRun.map(r => `${r.project.name} ${runLabel(r.run as Run)} ${progress(r.run as Run)}`)
  return `team ${running}/${reports.length} 執行中 · ${parts.join(' | ')}${unread ? ` · ${unread} 未讀` : ''}`
}

/** A toast tagged with the project it came from, when several are watched. */
export function tagToast(note: string | undefined, project: string, several: boolean): string | undefined {
  return note && several ? `[${project}] ${note}` : note
}

/** The configured project names: comma separated, blanks dropped, duplicates removed; [''] when none (infer). */
export function parseProjects(raw: unknown): string[] {
  const names = [...new Set(String(raw ?? '').split(',').map(s => s.trim()).filter(Boolean))]
  return names.length ? names : ['']
}
