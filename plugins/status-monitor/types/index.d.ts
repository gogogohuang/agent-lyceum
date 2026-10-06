export type Step = { text: string; done: boolean }
export type Mail = { from: string; type: string; subject: string; brief?: string }
export type Sent = { to: string; type: string; subject: string }
export type Wake = {
  round: number
  agent: string
  ok: boolean
  duration_ms: number
  error?: string
  output_tokens?: number
  handling?: Mail[]
  sent?: Sent[]
}
export type Run = {
  run_id: string
  started_at?: string
  live?: boolean
  task_source?: string
  state: 'running' | 'interrupted' | 'ended'
  end_reason?: string
  outcome?: string
  outcome_verified: boolean
  rounds: number
  max_rounds: number
  output_tokens: number
  task_summary: string
  steps?: Step[]
  current_step?: string | null
  active: Record<string, { since: string; round?: number; handling?: Mail[] }>
  queue: { agent: string; from: string; type: string; subject: string }[]
  wakes: Wake[]
  notes?: unknown[]
  blocked_integrations?: unknown[]
  result_head?: unknown[]
}
export type Agent = { name: string; lead: boolean; unread: number; runtime?: string; last_wake?: { at: string; ok: boolean } }
export type Report = { project: { name: string; lead: string }; agents: Agent[]; run?: Run }
export type History = { run_id: string; state: Run['state']; outcome?: string; outcome_verified: boolean; end_reason?: string; rounds: number; max_rounds: number; output_tokens: number; task_summary: string; started_at?: string }
export type Snapshot = { report: Report | null; error: string | null; history?: History[] }
/** One Snapshot per watched project, keyed by the configured name ('' = inferred from the session directory). */
export type Snapshots = Record<string, Snapshot>

declare module 'claude-code' {
  interface PluginState {
    'status-monitor': { snapshot: Snapshots; tab: string }
  }
}
