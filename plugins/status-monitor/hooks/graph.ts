import type { DigestSection, Report, Run } from '../types'
import { agentStats, elapsed, tokens } from './summary'

export type Dot = 'active' | 'queued' | 'failed' | 'idle'
export type Tone = 'bold' | 'dim' | 'ok' | 'warn' | 'bad'
/** `lead` is the tree branch drawn before `text` (in `leadTone`); the text wraps beside it. */
export type Line = { text: string; tone?: Tone; lead?: string; leadTone?: Tone }
export type MailView = { head: string; type: string; sections: DigestSection[] }
export type Target = { name: string; hot: boolean }
export type Block = {
  name: string
  runtime: string
  lead: boolean
  /** True while the agent's latest wake ran on a backup model. */
  backup?: boolean
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

/** One message as a head line plus all its readable sections (digest, else brief, else nothing). What is shown of them is decided by `mailLines`. */
export function mailView(m: MailLike): MailView {
  const head = `來自 ${m.from} 的 ${m.type}：${m.subject}`
  const sections: DigestSection[] = m.digest?.length ? m.digest : m.brief ? [{ label: '摘要', lines: [m.brief] }] : []
  return { head, type: m.type, sections }
}

/** The section that says what a message is about, per type; the first section when the type is not known. */
const POINT: Record<string, string> = { task: '目標', reply: '變更', done: '結果' }
/** Sections that need the reader's attention whenever they hold something. */
const ATTENTION = new Set(['待辦', '風險', '未完成'])
const NOTHING = /^(none|n\/a|無|沒有)[.。]?$/i

/**
 * The few lines worth reading without opening the mail: its point (the first line of the section that says what it is about),
 * then any open item or risk it reports. Not a cut of the start of the text: the rest is one key press away.
 */
export function pointSections(m: MailView): DigestSection[] {
  const first = (s: DigestSection): DigestSection => ({ label: s.label, lines: s.lines.slice(0, 1) })
  const point = m.sections.find(s => s.label === POINT[m.type]) ?? m.sections[0]
  if (!point) return []
  const attention = m.sections.filter(s => s !== point && ATTENTION.has(s.label) && s.lines.some(l => !NOTHING.test(l.trim())))
  return [point, ...attention].map(first)
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
    const queued = live ? (run?.queue ?? []).filter(q => q.agent === a.name).map(q => mailView(q)) : []
    const st = stats.get(a.name)
    const dot: Dot = act ? 'active' : live && a.last_wake?.ok === false ? 'failed' : queued.length ? 'queued' : 'idle'
    return {
      name: a.name,
      runtime: a.runtime ?? '?',
      lead: a.lead,
      ...(a.fallback ? { backup: true } : {}),
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
  // Members in the order of who needs a look first: working, failed, waiting, then idle (the setup order within each).
  const rank: Record<Dot, number> = { active: 0, failed: 1, queued: 2, idle: 3 }
  return [...all.filter(b => b.lead), ...all.filter(b => !b.lead).sort((a, b) => rank[a.dot] - rank[b.dot])]
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

function mailLines(m: MailView, headTone: Tone | undefined, indent: string, expanded: boolean): Line[] {
  const out: Line[] = [{ text: `${indent}${m.head}`, tone: headTone }]
  for (const s of expanded ? m.sections : pointSections(m)) {
    const pad = ' '.repeat(indent.length + 2)
    s.lines.forEach((l, i) => out.push({ text: i === 0 ? `${pad}${s.label}  ${l}` : `${pad}${' '.repeat(s.label.length * 2 + 2)}${l}` }))
  }
  return out
}

/** The text of one block, line by line, with a tone the view turns into a colour. Collapsed, a mail shows its point only; `expanded` shows all of it. */
export function blockLines(b: Block, expanded = false, maxTokens = 0): Line[] {
  const status: Line =
    b.dot === 'active' ? { text: `進行中${b.working?.round ? ` #${b.working.round}` : ''} ${b.working?.elapsed ?? ''}`.trimEnd(), tone: 'ok' }
    : b.dot === 'failed' ? { text: '上次喚醒失敗', tone: 'bad' }
    : b.dot === 'queued' ? { text: `排隊 ${b.queued.length} 封`, tone: 'warn' }
    : { text: '閒置', tone: 'dim' }
  // Collapsed, the glyph already says idle / waiting / working: only what it cannot say stays (the round and time, the count, the failure).
  const brief = b.dot === 'idle' ? '' : b.dot === 'active' ? `${b.working?.round ? `#${b.working.round}` : ''} ${b.working?.elapsed ?? ''}`.trim() : b.dot === 'queued' ? `${b.queued.length} 封` : '失敗'
  const title = `${DOT[b.dot]} ${b.name}${b.lead ? ' ★' : ''} · ${b.runtime}${b.backup ? ' · 備援中' : ''}`
  // Collapsed, the status shares the title's line (and its colour); the wake count and the hand-off targets wait for `e`.
  const lines: Line[] = expanded ? [{ text: title, tone: 'bold' }, status] : [{ text: brief ? `${title} · ${brief}` : title, tone: status.tone }]
  for (const m of b.handling) lines.push(...mailLines(m, 'bold', '', expanded))
  for (const m of b.queued) lines.push(...mailLines({ ...m, head: `排隊：${m.head}` }, 'dim', '  ', expanded))
  if (expanded || b.failed) lines.push({ text: `喚醒 ${b.wakes} 次${b.failed ? `（失敗 ${b.failed}）` : ''} · ${tokens(b.tokens)} tok${maxTokens > 0 ? ` ${bar(b.tokens, maxTokens, 6)}` : ''}`, tone: b.failed ? 'bad' : 'dim' })
  if (expanded && b.targets.length) lines.push({ text: `→ ${b.targets.map(t => (t.hot ? `${t.name} ●` : t.name)).join(', ')}`, tone: 'dim' })
  return lines
}

/** ▓▓░░░░ for done/total, clamped. */
export function bar(done: number, total: number, width = 10): string {
  const filled = total > 0 ? Math.min(width, Math.max(0, Math.round((done / total) * width))) : 0
  return '▓'.repeat(filled) + '░'.repeat(width - filled)
}

/**
 * The agents as a tree: the lead on top, each member on a branch below it. The glyph on a branch says who may write to whom
 * (▼ the lead to the member, ▲ the member to the lead, ↕ both; ─ when neither); yellow while it is the latest hand-off.
 */
export function treeLines(bs: Block[], expanded = false): Line[] {
  const lead = bs.find(b => b.lead)
  const members = bs.filter(b => !b.lead)
  const maxTokens = Math.max(0, ...bs.map(b => b.tokens))
  const failed = bs.filter(b => b.dot === 'failed')
  // Many idle members would only repeat "idle": collapsed, they share one line (`e` lists them).
  const idle = members.filter(b => b.dot === 'idle')
  const folded = !expanded && idle.length >= 3
  const shown = folded ? members.filter(b => b.dot !== 'idle') : members
  const out: Line[] = []
  if (failed.length) out.push({ text: `✖ ${failed.length} 個 agent 上次喚醒失敗：${failed.map(b => b.name).join('、')}`, tone: 'bad' })
  if (lead) out.push(...blockLines(lead, expanded, maxTokens))
  shown.forEach((b, i) => {
    const last = i === shown.length - 1 && !folded
    const link = leadLink(bs, b)
    const leadTone: Tone = link?.hot ? 'warn' : 'dim'
    blockLines(b, expanded, maxTokens).forEach((l, j) => {
      out.push({ ...l, lead: j === 0 ? `${last ? '└─' : '├─'}${link?.glyph ?? '─'} ` : `${last ? ' ' : '│'}   `, leadTone })
    })
  })
  if (folded) out.push({ text: `○ 另有 ${idle.length} 個閒置：${idle.map(b => b.name).join('、')}`, tone: 'dim', lead: '└── ', leadTone: 'dim' })
  return out
}
