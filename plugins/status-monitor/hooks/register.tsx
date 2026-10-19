import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Report, Snapshots } from '../types'
import { agentStats, runtimeTokens, clip, elapsed, line, newestFirst, parseProjects, progress, roundsLabel, runLabel, tagToast, transition } from './summary'
import { bar, paneWidth } from './graph'
import { graphView } from './graph-view'

const PANE = 'agent-lyceum'
const snapshot = atom({ plugin: 'status-monitor', key: 'snapshot' } as const, {} as Snapshots)
/** Id of the tab the pane shows ('' = the first). */
const tab = atom({ plugin: 'status-monitor', key: 'tab' } as const, '')
/** 'graph' draws one block per agent; 'text' is the plain list. `v` switches. */
const view = atom({ plugin: 'status-monitor', key: 'view' } as const, 'graph' as 'graph' | 'text')

/** Collapsed (false) shows each mail's point and the current step only; `e` expands everything. */
const expanded = atom({ plugin: 'status-monitor', key: 'expanded' } as const, false)

type Target = { key: string; status: string[] }

const last = new Map<string, Report>()
const polling = new Set<string>()
let several = false

async function fetchReport($: EngineInterface, args: string[]): Promise<Report> {
  const res = await $.process.run(args, { timeoutMs: 15000 })
  if (res.exitCode !== 0) throw new Error(res.stderr.trim().split('\n')[0] || `exit ${res.exitCode}`)
  return JSON.parse(res.stdout) as Report
}

async function poll($: EngineInterface, t: Target) {
  if (polling.has(t.key)) return
  polling.add(t.key)
  try {
    // `status --json` shows one run (the newest running). Concurrent runs need one report each: list the tasks, then fetch every running one.
    const report = await fetchReport($, t.status)
    const list = JSON.parse((await $.process.run([...t.status, '--task-list'], { timeoutMs: 15000 })).stdout) as { runs: { run_id: string; state: string }[] }
    const tracked = [...last.keys()].filter(k => k.startsWith(`${t.key}|`)).map(k => k.slice(t.key.length + 1))
    const ids = new Set([...list.runs.filter(r => r.state === 'running').map(r => r.run_id), ...tracked])
    const runs: Record<string, Report> = {}
    for (const id of ids) {
      const r = await fetchReport($, [...t.status, '--task-id', id])
      const key = `${t.key}|${id}`
      const note = tagToast(transition(last.get(key) ?? null, r), r.project.name, several)
      if (note) $.ui.toast(note)
      if (r.run?.state === 'running') {
        last.set(key, r)
        runs[id] = r
      } else {
        last.delete(key) // finished: toast once, then stop tracking
      }
    }
    await update($, snapshot, s => ({ ...s, [t.key]: { ...s[t.key], report, runs, error: null } }))
  } catch (err) {
    await update($, snapshot, s => ({ ...s, [t.key]: { report: s[t.key]?.report ?? null, runs: s[t.key]?.runs, error: err instanceof Error ? err.message : String(err) } }))
  } finally {
    polling.delete(t.key)
  }
}

function pollAll($: EngineInterface, targets: Target[]) {
  for (const t of targets) void poll($, t)
}

export const register: Register = (on, options) => {
  const base = String(options.command ?? 'agent-lyceum').trim().split(/\s+/)
  const names = parseProjects(options.project)
  several = names.length > 1
  const targets: Target[] = names.map(name => {
    const p = name ? ['-p', name] : []
    return { key: name, status: [...base, 'status', '--json', ...p] }
  })
  const every = Math.max(1, Number(options.intervalSeconds ?? 1)) * 1000

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'status-monitor', description: 'Show the agent-lyceum run status in a pane' })
    pollAll($, targets)
    $.clock.every(every, () => pollAll($, targets))
    if (options.autoOpen === true) void $.ui.open({ id: PANE, title: 'agent-lyceum', columns: 60, rows: 16 })
    return next(e)
  })

  on('command.run', { command: 'status-monitor' }, async ($, e) => {
    const { isFullscreen, columns } = e.presentation
    // No closeOnEscape: Esc must not touch the pane. Running the command again closes it.
    if ((await $.ui.panes()).some(x => x.id === PANE && x.isPlaced)) {
      await $.ui.close({ id: PANE })
      return { text: 'agent-lyceum pane closed.' }
    }
    // Dock at half the terminal's width (a request: a width the person dragged the dock to wins).
    const opened = await $.ui.open({ id: PANE, title: 'agent-lyceum', columns: Math.max(40, Math.floor(columns / 2)), rows: 16, focus: true })
    pollAll($, targets)
    if (!opened.isPlaced) return { text: `agent-lyceum pane not shown: ${opened.reason}` }
    // The host docks a pane on the right of the transcript (mouse-clickable) only in the fullscreen layout from 110 columns.
    const where = isFullscreen && columns >= 110 ? 'docked on the right' : `shown above the prompt (right-side dock needs the fullscreen layout and 110+ columns; now ${isFullscreen ? 'fullscreen' : 'not fullscreen'}, ${columns} columns. The layout is fixed when the session starts: set "tui": "fullscreen" in ~/.claude/settings.json and restart the session)`
    return { text: `agent-lyceum pane opened, ${where}. Mouse clicks are only reported in the fullscreen terminal; here use the keyboard: x closes, v switches graph/text, e expands or collapses the details, 1-9 (or Tab/Enter) switch task, Esc returns to the prompt, /status-monitor again also closes.` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const snap = await read($, snapshot)
    const now = await $.clock.now()
    const mode = await read($, view)
    const open = await read($, expanded)
    const width = paneWidth(e.props.bodyColumns)

    const section = (t: Target, shown?: Report) => {
      const { report: base, error } = snap[t.key] ?? { report: null, error: null }
      const report = shown ?? base
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
              執行 {run.run_id} [{runLabel(run)}] 第 {roundsLabel(run.rounds, run.max_rounds)} 輪 · {run.output_tokens.toLocaleString('en-US')} tokens
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
            <Text>
              進度：{mode === 'graph' && (run.steps?.length || run.max_rounds > 0) ? `${bar(run.steps?.length ? run.steps.filter(s => s.done).length : run.rounds, run.steps?.length || run.max_rounds)} ` : ''}
              {progress(run)}
            </Text>
            {run.current_step && <Text>目前：{run.current_step}</Text>}
            {(open ? (run.steps ?? []) : []).map(s => (
              <Text dimColor={s.done}>
                {s.done ? '[x]' : '[ ]'} {s.text}
              </Text>
            ))}
            {mode === 'graph' ? graphView($.ui.resolve(e), report, now, width, open) : (
              <Box flexDirection="column">
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
              </Box>
            )}
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
            {mode === 'text' && (
              <Box flexDirection="column">
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
          </Box>
        )}
        </Box>
      )
    }

    // One tab per running task, newest first. Finished and interrupted runs are not listed.
    const tabs = newestFirst(
      targets.flatMap(t =>
        Object.values(snap[t.key]?.runs ?? {}).flatMap(r => {
          const run = r.run
          if (run?.state !== 'running') return []
          const label = t.key || r.project.name || '目前'
          return [{ id: `${t.key}|${run.run_id}`, startedAt: run.started_at, label: `${several ? `${label}：` : ''}${clip(run.task_summary, 12)}`, body: () => section(t, r) }]
        }),
      ),
      x => x.startedAt,
    )
    const wanted = await read($, tab)
    const active = tabs.find(x => x.id === wanted) ?? tabs[0]
    if (!active) {
      const errors = targets.map(t => snap[t.key]?.error).filter((m): m is string => !!m)
      return <Text dimColor>{errors.length && !targets.some(t => snap[t.key]?.report) ? `無法取得狀態：${errors[0]}` : '沒有執行中的任務'}</Text>
    }

    return (
      <Box flexDirection="column">
        <Box>
          <Text bold>agent-lyceum </Text>
          <Button key="close" label="關閉 (x)" hotkey="x" role="dismiss" variant="primary" onPress={() => $.ui.close({ id: PANE })} />
          <Button key="expand" label={open ? '收合 (e)' : '展開 (e)'} hotkey="e" variant="secondary" onPress={() => update($, expanded, x => !x)} />
          <Button key="view" label={mode === 'graph' ? '文字版 (v)' : '圖形版 (v)'} hotkey="v" variant="secondary" onPress={() => update($, view, m => (m === 'graph' ? 'text' : 'graph'))} />
        </Box>
        <Box>
          {tabs.map((x, i) => (
            <Button key={x.id} label={`${i + 1} ${x.label}`} hotkey={i < 9 ? String(i + 1) : undefined} variant={x.id === active.id ? 'primary' : 'secondary'} onPress={() => update($, tab, () => x.id)} />
          ))}
        </Box>
        {active.body()}
      </Box>
    )
  })
}
