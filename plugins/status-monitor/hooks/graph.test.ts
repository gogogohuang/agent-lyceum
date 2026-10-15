import { expect, test } from 'claude-code/testing'
import { bar, blockLines, blocks, layout, leadLink, padCenter, paneWidth } from './graph'
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
  expect(bs.map(b => b.name)).toEqual(['lead', 'fe', 'qa'])
  const lead = bs[0]!
  expect(lead.dot).toBe('active')
  expect(lead.working).toEqual({ round: 3, elapsed: '1m05s' })
  expect(lead.handling[0]!.head).toBe('來自 fe 的 reply：UI done')
  const qa = bs[2]!
  expect(qa.dot).toBe('queued')
  expect(qa.queued[0]!.sections).toEqual([{ label: '目標', lines: ['為登入頁寫測試'] }])
  expect(bs[1]!.wakes).toBe(1)
  expect(bs[1]!.tokens).toBe(1200)
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

test('layout: wide puts the lead on top and wraps members; narrow stacks everything', () => {
  const bs = blocks(report(run()), NOW)
  const wide = layout(bs, 90)
  expect(wide.narrow).toBe(false)
  expect(wide.rows.map(r => r.map(b => b.name))).toEqual([['lead'], ['fe', 'qa']])
  expect(wide.memberWidth).toBe(45)
  const tight = layout(bs, 62)
  expect(tight.narrow).toBe(true)
  expect(tight.rows.map(r => r.map(b => b.name))).toEqual([['lead'], ['fe'], ['qa']])
  const many = layout([...bs, { ...bs[1]!, name: 'x' }, { ...bs[1]!, name: 'y' }], 90)
  expect(many.rows.map(r => r.length)).toEqual([1, 3, 1])
})

test('layout: a working member gets a full-width row of its own, right under the lead', () => {
  const r = run({ active: { qa: { since: '2026-01-01T00:00:00Z', round: 2, handling: [{ from: 'lead', type: 'task', subject: 'x'.repeat(60) }] } } })
  const bs = blocks(report(r), NOW)
  const lay = layout(bs, 90)
  expect(lay.rows.map(r => r.map(b => b.name))).toEqual([['lead'], ['qa'], ['fe']])
  expect(lay.widths).toEqual([90, 90, 90])
  expect(bs.find(b => b.name === 'qa')!.handling[0]!.head).toContain('x'.repeat(60))
  const two = layout(blocks(report(run({ active: { qa: { since: '2026-01-01T00:00:00Z' }, fe: { since: '2026-01-01T00:00:00Z' } } })), NOW), 90)
  expect(two.rows.map(r => r.length)).toEqual([1, 1, 1])
  expect(layout(bs, 62).widths).toEqual([62, 62, 62])
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
  expect(blockLines(lead).map(l => l.text)).toEqual([
    '● lead ★ · claude-code',
    '進行中 #3 1m05s',
    '來自 fe 的 reply：UI done',
    '  變更  新增 login.tsx',
    '        改 auth.ts',
    '  驗證  tsc 通過',
    '喚醒 1 次 · 12.3k tok',
    '→ fe ●, qa',
  ])
  expect(blockLines(lead)[1]!.tone).toBe('ok')
})

test('an idle block with nothing to say is short', () => {
  const fe = blocks(report(run()), NOW).find(b => b.name === 'fe')!
  expect(blockLines(fe).map(l => l.text)).toEqual(['○ fe · codex', '閒置', '喚醒 0 次 · 0 tok', '→ lead'])
})

test('queued mail is compact: head plus the first line of the first section', () => {
  const r = run({ queue: [{ agent: 'qa', from: 'lead', type: 'task', subject: 'write tests', digest: [{ label: '目標', lines: ['為登入頁寫測試', '第二行'] }] }] })
  const qa = blocks(report(r), NOW).find(b => b.name === 'qa')!
  expect(blockLines(qa).map(l => l.text)).toContain('  排隊：來自 lead 的 task：write tests')
  expect(blockLines(qa).map(l => l.text)).toContain('    目標  為登入頁寫測試')
})

test('bar, padCenter and paneWidth', () => {
  expect(bar(1, 4, 8)).toBe('▓▓░░░░░░')
  expect(bar(0, 0, 4)).toBe('░░░░')
  expect(bar(9, 4, 4)).toBe('▓▓▓▓')
  expect(padCenter('▼', 9)).toBe('    ▼')
  expect(paneWidth(96)).toBe(96)
  expect(paneWidth(30)).toBe(40)
  expect(paneWidth(0)).toBe(56)
  expect(paneWidth(undefined)).toBe(56)
})

test('layout turns narrow below 70 cells', () => {
  const bs = blocks(report(run()), NOW)
  expect(layout(bs, 69).narrow).toBe(true)
  expect(layout(bs, 70).narrow).toBe(false)
})

test('a report with no run shows everyone idle', () => {
  expect(blocks(report(undefined), NOW).map(b => b.dot)).toEqual(['idle', 'idle', 'idle'])
})

test('a member-to-member target appears in the → line', () => {
  const qa = blocks(report(run()), NOW).find(b => b.name === 'qa')!
  expect(blockLines(qa).some(l => l.text.startsWith('→') && l.text.includes('fe'))).toBe(true)
})

test('failed takes precedence over queued', () => {
  const rep = report(run({ queue: [{ agent: 'fe', from: 'lead', type: 'task', subject: 's' }] }))
  rep.agents[0]!.last_wake = { at: 't', ok: false }
  expect(blocks(rep, NOW).find(b => b.name === 'fe')!.dot).toBe('failed')
})
