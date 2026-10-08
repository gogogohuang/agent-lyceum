import { expect, test } from 'claude-code/testing'
import { agentStats, newestFirst, overviewLine, parseProjects, runtimeTokens, elapsed, statusLine, tagToast, tokens, transition } from './summary'
import type { Report, Run } from '../types'

const run = (o: Partial<Run> = {}): Run => ({
  run_id: 'r1', state: 'running', outcome_verified: false, rounds: 2, max_rounds: 10, output_tokens: 0,
  task_summary: 't', active: { dev: { since: '2026-01-01T00:00:00Z' } }, queue: [], wakes: [], ...o,
})
const rep = (r?: Run): Report => ({ project: { name: 'p', lead: 'lead' }, agents: [{ name: 'dev', lead: false, unread: 2 }], run: r })

test('status line shows state, progress, active and unread', () => {
  expect(statusLine(rep(run()))).toBe('team 執行中 2/10 輪 · 0 tok [dev] · 2 未讀')
  expect(statusLine(rep())).toBe(undefined)
})

test('toast on finish and on a failed wake', () => {
  expect(transition(rep(run()), rep(run({ state: 'ended', end_reason: 'done', outcome: 'completed', outcome_verified: true })))).toContain('完成')
  const bad = run({ wakes: [{ round: 1, agent: 'dev', ok: false, duration_ms: 1, error: 'boom' }] })
  expect(transition(rep(run()), rep(bad))).toContain('dev 第 1 輪失敗')
  expect(transition(rep(bad), rep(bad))).toBe(undefined)
})

test('status line carries the current step; elapsed formats', () => {
  expect(statusLine(rep(run({ current_step: '撰寫評估文件' })))).toBe('team 執行中 2/10 輪 · 0 tok [dev] · 撰寫評估文件 · 2 未讀')
  expect(elapsed('2026-01-01T00:00:00Z', Date.parse('2026-01-01T00:00:26Z'))).toBe('26s')
  expect(elapsed('2026-01-01T00:00:00Z', Date.parse('2026-01-01T00:03:05Z'))).toBe('3m05s')
  expect(elapsed('bad', 0)).toBe('')
})

test('agentStats totals wakes, failures, tokens and mean length per agent', () => {
  const w = (agent: string, ok: boolean, ms: number, tok: number) => ({ round: 1, agent, ok, duration_ms: ms, output_tokens: tok })
  expect(agentStats([w('a', true, 10000, 5), w('a', false, 20000, 7), w('b', true, 4000, 1)])).toEqual([
    { agent: 'a', wakes: 2, failed: 1, tokens: 12, avgSeconds: 15 },
    { agent: 'b', wakes: 1, failed: 0, tokens: 1, avgSeconds: 4 },
  ])
})

test('tokens abbreviates large counts', () => {
  expect([tokens(950), tokens(96328), tokens(1_500_000)]).toEqual(['950', '96.3k', '1.5M'])
})

test('runtimeTokens splits output tokens by the runtime of the agent', () => {
  const w = (agent: string, tok: number) => ({ round: 1, agent, ok: true, duration_ms: 1, output_tokens: tok })
  const agents = [{ name: 'a', lead: true, unread: 0, runtime: 'claude-code' }, { name: 'b', lead: false, unread: 0, runtime: 'codex' }]
  expect(runtimeTokens([w('a', 5), w('b', 9), w('a', 1)], agents)).toEqual([{ runtime: 'codex', tokens: 9 }, { runtime: 'claude-code', tokens: 6 }])
})

test('parseProjects splits, trims and dedupes; empty means infer', () => {
  expect(parseProjects(' a, b ,a,,')).toEqual(['a', 'b'])
  expect(parseProjects('')).toEqual([''])
  expect(parseProjects(undefined)).toEqual([''])
})

test('overviewLine keeps the single format and summarises several projects', () => {
  const named = (name: string, r?: Run): Report => ({ ...rep(r), project: { name, lead: 'lead' } })
  expect(overviewLine([rep(run())])).toBe(statusLine(rep(run())))
  const done = run({ state: 'ended', end_reason: 'done', outcome: 'completed', outcome_verified: true })
  expect(overviewLine([named('a', run()), named('b', done), named('c')])).toBe('team 1/3 執行中 · a 執行中 2/10 輪 · 2 未讀')
  expect(overviewLine([named('b', done), named('c')])).toBe(undefined)
  expect(overviewLine([named('a'), named('b')])).toBe(undefined)
})

test('tagToast prefixes the project only when several are watched', () => {
  expect(tagToast('x', 'a', true)).toBe('[a] x')
  expect(tagToast('x', 'a', false)).toBe('x')
  expect(tagToast(undefined, 'a', true)).toBe(undefined)
})

test('newestFirst orders by start time, undated last, ties stable', () => {
  const xs = [{ n: 'old', t: '2026-01-01T00:00:00Z' }, { n: 'none' }, { n: 'new', t: '2026-01-02T00:00:00Z' }, { n: 'none2', t: 'bad' }] as { n: string; t?: string }[]
  expect(newestFirst(xs, x => x.t).map(x => x.n)).toEqual(['new', 'old', 'none', 'none2'])
})
