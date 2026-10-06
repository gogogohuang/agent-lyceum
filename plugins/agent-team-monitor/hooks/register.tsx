import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { History, Report, Snapshots } from '../types'
import { agentStats, runtimeTokens, clip, elapsed, line, overviewLine, parseProjects, progress, runLabel, tagToast, transition } from './summary'

const PANE = 'agent-team'
const snapshot = atom({ plugin: 'agent-team-monitor', key: 'snapshot' } as const, {} as Snapshots)

type Target = { key: string; status: string[]; tasks: string[] }

const last = new Map<string, Report>()
const polling = new Set<string>()
const ticks = new Map<string, number>()
let several = false

/** Latest report of every watched project, in configured order. */
async function publish($: EngineInterface, targets: Target[]) {
  const snap = await read($, snapshot)
  const reports = targets.map(t => snap[t.key]?.report).filter((r): r is Report => !!r)
  $.ui.status(overviewLine(reports))
}

async function poll($: EngineInterface, t: Target, targets: Target[]) {
  if (polling.has(t.key)) return
  polling.add(t.key)
  try {
    const res = await $.process.run(t.status, { timeoutMs: 15000 })
    if (res.exitCode !== 0) throw new Error(res.stderr.trim().split('\n')[0] || `exit ${res.exitCode}`)
    const report = JSON.parse(res.stdout) as Report
    const note = tagToast(transition(last.get(t.key) ?? null, report), report.project.name, several)
    if (note) $.ui.toast(note)
    last.set(t.key, report)
    await update($, snapshot, s => ({ ...s, [t.key]: { ...s[t.key], report, error: null } }))
    const n = ticks.get(t.key) ?? 0
    ticks.set(t.key, n + 1)
    if (n % 10 === 0) await pollHistory($, t)
  } catch (err) {
    await update($, snapshot, s => ({ ...s, [t.key]: { report: s[t.key]?.report ?? null, history: s[t.key]?.history, error: err instanceof Error ? err.message : String(err) } }))
  } finally {
    polling.delete(t.key)
  }
  await publish($, targets)
}

function pollAll($: EngineInterface, targets: Target[]) {
  for (const t of targets) void poll($, t, targets)
}

async function pollHistory($: EngineInterface, t: Target) {
  try {
    const res = await $.process.run(t.tasks, { timeoutMs: 15000 })
    if (res.exitCode !== 0) return
    const runs = (JSON.parse(res.stdout) as { runs?: History[] }).runs ?? []
    await update($, snapshot, s => ({ ...s, [t.key]: { report: s[t.key]?.report ?? null, error: s[t.key]?.error ?? null, history: runs } }))
  } catch {}
}

export const register: Register = (on, options) => {
  const base = String(options.command ?? 'agent-team').trim().split(/\s+/)
  const names = parseProjects(options.project)
  several = names.length > 1
  const targets: Target[] = names.map(name => {
    const p = name ? ['-p', name] : []
    return { key: name, status: [...base, 'status', '--json', ...p], tasks: [...base, 'status', '--task-list', '--json', ...p] }
  })
  const every = Math.max(1, Number(options.intervalSeconds ?? 3)) * 1000

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'team-monitor', description: 'Show the agent-team run status in a pane' })
    pollAll($, targets)
    $.clock.every(every, () => pollAll($, targets))
    return next(e)
  })

  on('command.run', { command: 'team-monitor' }, async $ => {
    await $.ui.open({ id: PANE, title: 'agent-team' })
    pollAll($, targets)
    return { text: 'agent-team pane opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const snap = await read($, snapshot)
    const now = await $.clock.now()

    const section = (t: Target) => {
      const { report, error, history } = snap[t.key] ?? { report: null, error: null }
      if (!report) return <Text dimColor>{t.key ? `${t.key}：` : ''}{error ? `無法取得狀態：${error}` : '讀取中…'}</Text>
      const run = report.run
      return (
        <Box flexDirection="column">
          <Text bold>
            {report.project.name} · lead {report.project.lead}
          </Text>
        {error && <Text color="yellow">更新失敗（顯示舊資料）：{error}</Text>}
        {!run && <Text dimColor>閒置（尚無執行紀錄）</Text>}
        {run && (
          <Box flexDirection="column">
            <Text>
              執行 {run.run_id} [{runLabel(run)}] 第 {run.rounds}/{run.max_rounds} 輪 · {run.output_tokens.toLocaleString('en-US')} tokens
            </Text>
            <Text>
              任務：{run.task_summary}
              {run.task_source ? `（來源 ${run.task_source}）` : ''}
            </Text>
            {run.started_at && (
              <Text dimColor>
                開始 {new Date(run.started_at).toLocaleTimeString()} · 已經過 {elapsed(run.started_at, now)}
                {run.live === false && run.state === 'running' ? ' · 程序已不存在' : ''}
              </Text>
            )}
            <Text>進度：{progress(run)}</Text>
            {run.current_step && <Text>目前：{run.current_step}</Text>}
            {(run.steps ?? []).map(s => (
              <Text dimColor={s.done}>
                {s.done ? '[x]' : '[ ]'} {s.text}
              </Text>
            ))}
            {Object.entries(run.active).map(([name, w]) => (
              <Box flexDirection="column">
                <Text color="green">
                  進行中：{name} {w.round ? `#${w.round} ` : ''}
                  {elapsed(w.since, now)}
                </Text>
                {(w.handling ?? []).map(m => (
                  <Text dimColor>
                    {'  '}處理 {m.from}→{m.type}：{clip(m.subject, 60)}
                  </Text>
                ))}
              </Box>
            ))}
            {run.queue.length > 0 && <Text bold>排隊</Text>}
            {run.queue.map(q => (
              <Text dimColor>
                {q.agent} ← {q.from} {q.type}：{clip(q.subject, 60)}
              </Text>
            ))}
            {(run.blocked_integrations ?? []).length > 0 && (
              <Text color="yellow">受阻整合：{(run.blocked_integrations ?? []).map(line).join('；')}</Text>
            )}
            {(run.notes ?? []).length > 0 && <Text bold>備註</Text>}
            {(run.notes ?? []).map(n => (
              <Text dimColor>{clip(line(n), 100)}</Text>
            ))}
            {(run.result_head ?? []).length > 0 && <Text bold>結果摘要</Text>}
            {(run.result_head ?? []).map(n => (
              <Text>{clip(line(n), 100)}</Text>
            ))}
            <Text bold>各 LLM output tokens</Text>
            {runtimeTokens(run.wakes, report.agents).map(x => (
              <Text>
                {x.runtime} {x.tokens.toLocaleString('en-US')} tok
              </Text>
            ))}
            <Text bold>各 agent 統計</Text>
            {agentStats(run.wakes).map(a => (
              <Text color={a.failed ? 'red' : undefined}>
                {a.agent} [{report.agents.find(x => x.name === a.agent)?.runtime ?? '?'}] 喚醒 {a.wakes} 次{a.failed ? `（失敗 ${a.failed}）` : ''} · {a.tokens.toLocaleString('en-US')} tok · 平均 {a.avgSeconds}s
              </Text>
            ))}
            <Text bold>最近喚醒</Text>
            {run.wakes.slice(-8).map(w => (
              <Text color={w.ok ? undefined : 'red'}>
                #{w.round} {w.agent} {w.ok ? 'ok' : `失敗 ${w.error ?? ''}`} {Math.round(w.duration_ms / 1000)}s
                {w.output_tokens ? ` · ${w.output_tokens.toLocaleString('en-US')} tok` : ''}
                {(w.sent ?? []).length ? ` → ${(w.sent ?? []).map(s => `${s.to}(${s.type})`).join(', ')}` : ''}
              </Text>
            ))}
          </Box>
        )}
        {(history ?? []).length > 1 && <Text bold>歷史執行</Text>}
        {(history ?? []).length > 1 &&
          (history ?? []).slice(-5).map(h => (
            <Text dimColor={h.run_id !== run?.run_id}>
              {h.run_id} {runLabel(h as never)} {h.rounds}/{h.max_rounds} 輪 · {h.output_tokens.toLocaleString('en-US')} tok · {clip(h.task_summary, 40)}
            </Text>
          ))}
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        <Box>
          <Text bold>agent-team {several ? `（${targets.length} 個專案）` : ''}</Text>
          <Button key="close" label="關閉" onPress={() => $.ui.close({ id: PANE })} />
        </Box>
        {targets.map(section)}
      </Box>
    )
  })
}
