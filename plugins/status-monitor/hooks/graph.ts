import type { DigestSection, Report, Run } from '../types'
import { agentStats, clip, elapsed, tokens } from './summary'

export type Dot = 'active' | 'queued' | 'failed' | 'idle'
export type Tone = 'bold' | 'dim' | 'ok' | 'warn' | 'bad'
export type Line = { text: string; tone?: Tone }
export type MailView = { head: string; sections: DigestSection[] }
export type Target = { name: string; hot: boolean }
export type Block = {
  name: string
  runtime: string
  lead: boolean
  dot: Dot
  working?: { round?: number; elapsed: string }
  handling: MailView[]
  queued: MailView[]
  targets: Target[]
  wakes: number
  failed: number
  tokens: number
}
export type Edge = { from: string; to: string }
type MailLike = { from: string; type: string; subject: string; brief?: string; digest?: DigestSection[] }

/** Below this many columns blocks stack in one column and no link glyphs are drawn. */
export const NARROW = 70
/** The narrowest a member block may get before a row wraps. */
export const MIN_BLOCK = 30
/** The pane's width when it is opened (see register.tsx). */
const OPEN_WIDTH = 56

/** One message as a head line plus its readable sections (digest, else brief, else nothing); `compact` keeps one line. */
export function mailView(m: MailLike, compact = false): MailView {
  const head = `來自 ${m.from} 的 ${m.type}：${clip(m.subject, 40)}`
  const all: DigestSection[] = m.digest?.length ? m.digest : m.brief ? [{ label: '摘要', lines: [m.brief] }] : []
  return { head, sections: compact ? all.slice(0, 1).map(s => ({ label: s.label, lines: s.lines.slice(0, 1) })) : all }
}

/** The most recent hand-off between two agents (a `done` goes to nobody). */
export function latestEdge(run?: Run): Edge | undefined {
  for (const w of [...(run?.wakes ?? [])].reverse()) {
    const to = [...(w.sent ?? [])].reverse().find(s => s.to !== '(done)')?.to
    if (to) return { from: w.agent, to }
  }
  return undefined
}

/** One block per agent, the lead first. Only a running run has agents working or queued. */
export function blocks(report: Report, now: number): Block[] {
  const run = report.run
  const live = run?.state === 'running'
  const stats = new Map(agentStats(run?.wakes ?? []).map(s => [s.agent, s]))
  const edge = latestEdge(run)
  const all = report.agents.map((a): Block => {
    const act = live ? run?.active[a.name] : undefined
    const queued = live ? (run?.queue ?? []).filter(q => q.agent === a.name).map(q => mailView(q, true)) : []
    const st = stats.get(a.name)
    const dot: Dot = act ? 'active' : live && a.last_wake?.ok === false ? 'failed' : queued.length ? 'queued' : 'idle'
    return {
      name: a.name,
      runtime: a.runtime ?? '?',
      lead: a.lead,
      dot,
      working: act ? { round: act.round, elapsed: elapsed(act.since, now) } : undefined,
      handling: (act?.handling ?? []).map(m => mailView(m)),
      queued,
      targets: (a.can_message ?? []).map(name => ({ name, hot: edge?.from === a.name && edge.to === name })),
      wakes: st?.wakes ?? 0,
      failed: st?.failed ?? 0,
      tokens: st?.tokens ?? 0,
    }
  })
  return [...all.filter(b => b.lead), ...all.filter(b => !b.lead)]
}

export type Layout = { narrow: boolean; memberWidth: number; rows: Block[][] }

/** Rows of blocks: the lead alone on top, members below in as many columns as fit. */
export function layout(bs: Block[], width: number): Layout {
  if (width < NARROW) return { narrow: true, memberWidth: width, rows: bs.map(b => [b]) }
  const lead = bs.filter(b => b.lead)
  const rest = bs.filter(b => !b.lead)
  const cols = Math.max(1, Math.min(rest.length || 1, Math.floor(width / MIN_BLOCK)))
  const rows: Block[][] = lead.length ? [lead] : []
  for (let i = 0; i < rest.length; i += cols) rows.push(rest.slice(i, i + cols))
  return { narrow: false, memberWidth: Math.floor(width / cols), rows }
}

/** The glyph between the lead and a member: who may write to whom; hot when it is the latest hand-off. */
export function leadLink(bs: Block[], member: Block): { glyph: '▼' | '▲' | '↕'; hot: boolean } | undefined {
  const lead = bs.find(b => b.lead)
  if (!lead || member.lead) return undefined
  const down = lead.targets.find(t => t.name === member.name)
  const up = member.targets.find(t => t.name === lead.name)
  if (!down && !up) return undefined
  return { glyph: down && up ? '↕' : down ? '▼' : '▲', hot: !!down?.hot || !!up?.hot }
}

const DOT: Record<Dot, string> = { active: '●', queued: '◐', failed: '✖', idle: '○' }

function mailLines(m: MailView, headTone: Tone | undefined, indent: string): Line[] {
  const out: Line[] = [{ text: `${indent}${m.head}`, tone: headTone }]
  for (const s of m.sections) {
    const pad = ' '.repeat(indent.length + 2)
    s.lines.forEach((l, i) => out.push({ text: i === 0 ? `${pad}${s.label}  ${l}` : `${pad}${' '.repeat(s.label.length * 2 + 2)}${l}` }))
  }
  return out
}

/** The text of one block, line by line, with a tone the view turns into a colour. */
export function blockLines(b: Block): Line[] {
  const status: Line =
    b.dot === 'active' ? { text: `進行中${b.working?.round ? ` #${b.working.round}` : ''} ${b.working?.elapsed ?? ''}`.trimEnd(), tone: 'ok' }
    : b.dot === 'failed' ? { text: '上次喚醒失敗', tone: 'bad' }
    : b.dot === 'queued' ? { text: `排隊 ${b.queued.length} 封`, tone: 'warn' }
    : { text: '閒置', tone: 'dim' }
  const lines: Line[] = [{ text: `${DOT[b.dot]} ${b.name}${b.lead ? ' ★' : ''} · ${b.runtime}`, tone: 'bold' }, status]
  for (const m of b.handling) lines.push(...mailLines(m, 'bold', ''))
  for (const m of b.queued) lines.push(...mailLines({ ...m, head: `排隊：${m.head}` }, 'dim', '  '))
  lines.push({ text: `喚醒 ${b.wakes} 次${b.failed ? `（失敗 ${b.failed}）` : ''} · ${tokens(b.tokens)} tok`, tone: b.failed ? 'bad' : 'dim' })
  if (b.targets.length) lines.push({ text: `→ ${b.targets.map(t => (t.hot ? `${t.name} ●` : t.name)).join(', ')}`, tone: 'dim' })
  return lines
}

/** ▓▓░░░░ for done/total, clamped. */
export function bar(done: number, total: number, width = 10): string {
  const filled = total > 0 ? Math.min(width, Math.max(0, Math.round((done / total) * width))) : 0
  return '▓'.repeat(filled) + '░'.repeat(width - filled)
}

/** `s` indented so a one-cell glyph sits in the middle of `width` cells. */
export function padCenter(s: string, width: number): string {
  return ' '.repeat(Math.max(0, Math.floor((width - 1) / 2))) + s
}

/**
 * How many cells the graph may use: the pane's own body width (`props.bodyColumns`), never below 40;
 * 0 or missing (not laid out yet) falls back to the width the pane is opened with.
 */
export function paneWidth(bodyColumns: number | undefined): number {
  return bodyColumns ? Math.max(40, bodyColumns) : OPEN_WIDTH
}
