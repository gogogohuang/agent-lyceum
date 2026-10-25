import { expect, test } from 'claude-code/testing'
import { bar, blockLines, blocks, leadLink, pointSections, treeGroups, treeLines, wrapRows, clipCells } from './graph'
import type { Report, Run } from '../types'

const NOW = Date.parse('2026-01-01T00:01:05Z')
const run = (o: Partial<Run> = {}): Run => ({
  run_id: 'r1', state: 'running', outcome_verified: false, rounds: 3, max_rounds: 30, output_tokens: 0,
  task_summary: 't', active: {}, queue: [], wakes: [], ...o,
})
const report = (r?: Run): Report => ({
  project: { name: 'p', lead: 'lead' },
  agents: [
    { name: 'fe', lead: false, unread: 0, runtime: 'codex', can_message: ['lead'] },
    { name: 'lead', lead: true, unread: 0, runtime: 'claude-code', can_message: ['fe', 'qa'] },
    { name: 'qa', lead: false, unread: 1, runtime: 'claude-code', can_message: ['fe'] },
  ],
  run: r,
})

test('blocks put the lead first and carry what each agent is doing', () => {
  const r = run({
    active: { lead: { since: '2026-01-01T00:00:00Z', round: 3, handling: [{ from: 'fe', type: 'reply', subject: 'UI done', digest: [{ label: '變更', lines: ['新增 login.tsx'] }] }] } },
    queue: [{ agent: 'qa', from: 'lead', type: 'task', subject: 'write tests', digest: [{ label: '目標', lines: ['為登入頁寫測試', '第二行'] }, { label: '驗收', lines: ['x'] }] }],
    wakes: [{ round: 1, agent: 'fe', ok: true, duration_ms: 4000, output_tokens: 1200 }],
  })
  const bs = blocks(report(r), NOW)
  // Members are ordered by who needs a look first: qa is waiting, fe is idle.
  expect(bs.map(b => b.name)).toEqual(['lead', 'qa', 'fe'])
  const lead = bs[0]!
  expect(lead.dot).toBe('active')
  expect(lead.working).toEqual({ round: 3, elapsed: '1m05s' })
  expect(lead.handling[0]!.head).toBe('來自 fe 的 reply：UI done')
  const qa = bs[1]!
  expect(qa.dot).toBe('queued')
  expect(qa.queued[0]!.sections).toEqual([{ label: '目標', lines: ['為登入頁寫測試', '第二行'] }, { label: '驗收', lines: ['x'] }])
  expect(bs[2]!.wakes).toBe(1)
  expect(bs[2]!.tokens).toBe(1200)
})

test('a failed last wake shows red, an ended run shows everyone idle', () => {
  const failed = report(run())
  failed.agents[0]!.last_wake = { at: 't', ok: false }
  expect(blocks(failed, NOW).find(b => b.name === 'fe')!.dot).toBe('failed')
  const ended = run({ state: 'ended', active: { lead: { since: '2026-01-01T00:00:00Z' } }, queue: [{ agent: 'qa', from: 'lead', type: 'task', subject: 's' }] })
  expect(blocks(report(ended), NOW).map(b => b.dot)).toEqual(['idle', 'idle', 'idle'])
})

test('mail falls back from digest to brief to the subject alone', () => {
  const r = run({ active: { lead: { since: '2026-01-01T00:00:00Z', handling: [
    { from: 'a', type: 'task', subject: 's1', brief: 'one line' },
    { from: 'b', type: 'task', subject: 's2' },
  ] } } })
  const h = blocks(report(r), NOW)[0]!.handling
  expect(h[0]!.sections).toEqual([{ label: '摘要', lines: ['one line'] }])
  expect(h[1]!.sections).toEqual([])
})

test('the latest hand-off marks its edge hot', () => {
  const r = run({ wakes: [
    { round: 1, agent: 'lead', ok: true, duration_ms: 1, sent: [{ to: 'fe', type: 'task', subject: 's' }] },
    { round: 2, agent: 'fe', ok: true, duration_ms: 1, sent: [{ to: 'lead', type: 'reply', subject: 's' }] },
  ] })
  const bs = blocks(report(r), NOW)
  expect(bs.find(b => b.name === 'fe')!.targets).toEqual([{ name: 'lead', hot: true }])
  expect(bs.find(b => b.name === 'lead')!.targets.every(t => !t.hot)).toBe(true)
  const done = run({ wakes: [{ round: 1, agent: 'lead', ok: true, duration_ms: 1, sent: [{ to: '(done)', type: 'done', subject: 's' }] }] })
  expect(blocks(report(done), NOW).flatMap(b => b.targets).every(t => !t.hot)).toBe(true)
})

test('older CLI without can_message: no targets, no link', () => {
  const old = report(run())
  for (const a of old.agents) delete a.can_message
  const bs = blocks(old, NOW)
  expect(bs.every(b => b.targets.length === 0)).toBe(true)
  expect(leadLink(bs, bs[1]!)).toBeUndefined()
})

test('treeLines: the lead on top, a branch per member with the link glyph', () => {
  const bs = blocks(report(run()), NOW)
  expect(treeLines(bs).map(l => (l.lead ?? '') + l.text)).toEqual([
    '○ lead ★ · claude-code',
    '├─↕ ○ fe · codex',
    '└─▼ ○ qa · claude-code',
  ])
})

test('treeLines: a member\'s details hang under its branch; the last branch has no bar', () => {
  const r = run({ queue: [{ agent: 'fe', from: 'lead', type: 'task', subject: 'write ui', digest: [{ label: '目標', lines: ['做登入頁'] }] }] })
  const lines = treeLines(blocks(report(r), NOW))
  expect(lines.map(l => (l.lead ?? '') + l.text)).toEqual([
    '○ lead ★ · claude-code',
    '├─↕ ◐ fe · codex · 1 封',
    '│     排隊：來自 lead 的 task：write ui',
    '│       目標  做登入頁',
    '└─▼ ○ qa · claude-code',
  ])
})

test('treeLines: the latest hand-off is yellow on its branch', () => {
  const r = run({ wakes: [{ round: 1, agent: 'lead', ok: true, duration_ms: 1, output_tokens: 1, sent: [{ to: 'fe', type: 'task', subject: 's' }] }] })
  const lines = treeLines(blocks(report(r), NOW))
  expect(lines.find(l => l.text.includes('fe'))!.leadTone).toBe('warn')
  expect(lines.find(l => l.text.includes('qa'))!.leadTone).toBe('dim')
})

test('leadLink shows the direction between the lead and a member', () => {
  const bs = blocks(report(run()), NOW)
  expect(leadLink(bs, bs.find(b => b.name === 'fe')!)).toEqual({ glyph: '↕', hot: false })
  expect(leadLink(bs, bs.find(b => b.name === 'qa')!)).toEqual({ glyph: '▼', hot: false })
  expect(leadLink(bs, bs[0]!)).toBeUndefined()
})

test('blockLines tell what the agent is doing and what it received', () => {
  const r = run({
    active: { lead: { since: '2026-01-01T00:00:00Z', round: 3, handling: [{ from: 'fe', type: 'reply', subject: 'UI done', digest: [{ label: '變更', lines: ['新增 login.tsx', '改 auth.ts'] }, { label: '驗證', lines: ['tsc 通過'] }] }] } },
    wakes: [{ round: 1, agent: 'lead', ok: true, duration_ms: 1, output_tokens: 12300, sent: [{ to: 'fe', type: 'task', subject: 's' }] }],
  })
  const lead = blocks(report(r), NOW)[0]!
  expect(blockLines(lead, true).map(l => l.text)).toEqual([
    '● lead ★ · claude-code',
    '進行中 #3 1m05s',
    '來自 fe 的 reply：UI done',
    '  變更  新增 login.tsx',
    '        改 auth.ts',
    '  驗證  tsc 通過',
    '喚醒 1 次 · 12.3k tok',
    '→ fe ●, qa',
  ])
  expect(blockLines(lead)[0]!.tone).toBe('ok')
})

test('an idle block with nothing to say is short', () => {
  const fe = blocks(report(run()), NOW).find(b => b.name === 'fe')!
  expect(blockLines(fe).map(l => l.text)).toEqual(['○ fe · codex'])
  expect(blockLines(fe, true).map(l => l.text)).toEqual(['○ fe · codex', '閒置', '喚醒 0 次 · 0 tok', '→ lead'])
})

test('collapsed, a mail shows its point, not the start of its text', () => {
  const r = run({
    active: { lead: { since: '2026-01-01T00:00:00Z', round: 3, handling: [{ from: 'fe', type: 'reply', subject: 'UI done', digest: [
      { label: '變更', lines: ['新增 login.tsx', '改 auth.ts'] }, { label: '驗證', lines: ['tsc 通過'] },
      { label: '待辦', lines: ['尚未接真實 API'] }, { label: '風險', lines: ['None'] },
    ] }] } },
  })
  const lead = blocks(report(r), NOW)[0]!
  expect(blockLines(lead).map(l => l.text)).toEqual([
    '● lead ★ · claude-code · #3 1m05s',
    '來自 fe 的 reply：UI done',
    '  變更  新增 login.tsx',
    '  待辦  尚未接真實 API',
  ])
  expect(blockLines(lead, true).map(l => l.text)).toContain('  驗證  tsc 通過')
})

test('the point of a mail depends on its type; a missing point section falls back to the first', () => {
  const sec = (label: string, ...lines: string[]) => ({ label, lines })
  const view = (type: string, sections: ReturnType<typeof sec>[]) => ({ head: 'h', type, sections })
  expect(pointSections(view('task', [sec('驗收', 'a'), sec('目標', 'g1', 'g2')]))).toEqual([sec('目標', 'g1')])
  expect(pointSections(view('done', [sec('結果', 'ok'), sec('未完成', '未接 API', '未做 e2e')]))).toEqual([sec('結果', 'ok'), sec('未完成', '未接 API')])
  expect(pointSections(view('done', [sec('結果', 'ok'), sec('未完成', 'None')]))).toEqual([sec('結果', 'ok')])
  expect(pointSections(view('failure', [sec('訊息', 'boom', 'more')]))).toEqual([sec('訊息', 'boom')])
  expect(pointSections(view('task', []))).toEqual([])
})

test('queued mail shows its point collapsed and everything expanded', () => {
  const r = run({ queue: [{ agent: 'qa', from: 'lead', type: 'task', subject: 'write tests', digest: [{ label: '目標', lines: ['為登入頁寫測試', '第二行'] }, { label: '驗收', lines: ['x'] }] }] })
  const qa = blocks(report(r), NOW).find(b => b.name === 'qa')!
  expect(blockLines(qa).map(l => l.text)).toContain('  排隊：來自 lead 的 task：write tests')
  expect(blockLines(qa).map(l => l.text)).toContain('    目標  為登入頁寫測試')
  expect(blockLines(qa).map(l => l.text)).not.toContain('    驗收  x')
  expect(blockLines(qa, true).map(l => l.text)).toContain('    驗收  x')
})

test('bar fills in proportion', () => {
  expect(bar(1, 4, 8)).toBe('▓▓░░░░░░')
  expect(bar(0, 0, 4)).toBe('░░░░')
  expect(bar(9, 4, 4)).toBe('▓▓▓▓')
})

test('a report with no run shows everyone idle', () => {
  expect(blocks(report(undefined), NOW).map(b => b.dot)).toEqual(['idle', 'idle', 'idle'])
})

test('a member-to-member target appears in the → line', () => {
  const qa = blocks(report(run()), NOW).find(b => b.name === 'qa')!
  expect(blockLines(qa, true).some(l => l.text.startsWith('→') && l.text.includes('fe'))).toBe(true)
})

test('failed takes precedence over queued', () => {
  const rep = report(run({ queue: [{ agent: 'fe', from: 'lead', type: 'task', subject: 's' }] }))
  rep.agents[0]!.last_wake = { at: 't', ok: false }
  expect(blocks(rep, NOW).find(b => b.name === 'fe')!.dot).toBe('failed')
})

test('a badge marks an agent that is running on a backup, and nothing else changes', () => {
  const plain = blocks(report(run()), NOW).find(b => b.name === 'fe')!
  const before = blockLines(plain, true)
  const rep = report(run())
  rep.agents[0]!.fallback = { from: 'codex/gpt-5', kind: 'rate_limit' }
  const fb = blocks(rep, NOW).find(b => b.name === 'fe')!
  const lines = blockLines(fb, true)
  expect(lines[0]!.text).toBe(before[0]!.text + ' · 備援中')
  expect(lines.slice(1)).toEqual(before.slice(1))
  expect(blockLines(plain, true)).toEqual(before)
})

test('treeLines: members needing a look come first; a failure gets a banner', () => {
  const rep = report(run({ queue: [{ agent: 'qa', from: 'lead', type: 'task', subject: 's' }] }))
  rep.agents[0]!.last_wake = { at: 't', ok: false }
  const lines = treeLines(blocks(rep, NOW)).map(l => (l.lead ?? '') + l.text)
  expect(lines[0]).toBe('✖ 1 個 agent 上次喚醒失敗：fe')
  expect(lines.filter(l => l.includes('○ lead') || l.includes('✖ fe') || l.includes('◐ qa'))).toEqual(['○ lead ★ · claude-code', '├─↕ ✖ fe · codex · 失敗', '└─▼ ◐ qa · claude-code · 1 封'])
})

test('treeLines: three or more idle members share one line until expanded', () => {
  const rep = report(run())
  rep.agents.push({ name: 'x', lead: false, unread: 0, runtime: 'codex', can_message: [] }, { name: 'y', lead: false, unread: 0, runtime: 'codex', can_message: [] })
  const bs = blocks(rep, NOW)
  expect(treeLines(bs).map(l => (l.lead ?? '') + l.text)).toEqual(['○ lead ★ · claude-code', '└── ○ 另有 4 個閒置：fe、qa、x、y'])
  expect(treeLines(bs, true).filter(l => l.lead?.startsWith('├─') || l.lead?.startsWith('└─')).length).toBe(4)
})

test('expanded, the wake line carries a token bar relative to the busiest agent', () => {
  const r = run({ wakes: [{ round: 1, agent: 'fe', ok: true, duration_ms: 1, output_tokens: 1000 }, { round: 2, agent: 'qa', ok: true, duration_ms: 1, output_tokens: 500 }] })
  const bs = blocks(report(r), NOW)
  const texts = (name: string) => blockLines(bs.find(b => b.name === name)!, true, 1000).map(l => l.text)
  expect(texts('fe')).toContain('喚醒 1 次 · 1.0k tok ▓▓▓▓▓▓')
  expect(texts('qa')).toContain('喚醒 1 次 · 500 tok ▓▓▓░░░')
})

test('treeGroups: one framed group per agent, its state as the dot; notes stay unframed', () => {
  const rep = report(run({ queue: [{ agent: 'qa', from: 'lead', type: 'task', subject: 's' }] }))
  rep.agents[0]!.last_wake = { at: 't', ok: false }
  const gs = treeGroups(blocks(rep, NOW))
  expect(gs.map(g => g.dot)).toEqual([undefined, 'idle', 'failed', 'queued'])
  expect(gs.map(g => g.branch)).toEqual([undefined, undefined, '├─↕ ', '└─▼ '])
  expect(gs.map(g => !!g.last)).toEqual([false, false, false, true])
})

test('treeGroups: the folded idle line is a note with its own branch', () => {
  const rep = report(run())
  rep.agents.push({ name: 'x', lead: false, unread: 0, runtime: 'codex', can_message: [] }, { name: 'y', lead: false, unread: 0, runtime: 'codex', can_message: [] })
  const gs = treeGroups(blocks(rep, NOW))
  expect(gs.map(g => g.dot)).toEqual(['idle', undefined])
  expect(gs[1]!.branch).toBe('└── ')
})

test('wrapRows: counts rows with wide characters and breaks at spaces', () => {
  expect(wrapRows('abc', 10)).toBe(1)
  expect(wrapRows('', 10)).toBe(1)
  expect(wrapRows('中文中文中', 10)).toBe(1)
  expect(wrapRows('中文中文中文', 10)).toBe(2)
  expect(wrapRows('hello world', 8)).toBe(2)
  expect(wrapRows('aaaaaaaaaaaa', 5)).toBe(3)
})

test('clipCells: fits as is, else cut to the cells with an ellipsis', () => {
  expect(clipCells('abc', 5)).toBe('abc')
  expect(clipCells('abcdef', 5)).toBe('abcd…')
  expect(clipCells('中文中文中', 10)).toBe('中文中文中')
  expect(clipCells('中文中文中文', 10)).toBe('中文中文…')
})
