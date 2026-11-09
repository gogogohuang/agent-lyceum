// The status-monitor mod's handle on `agent-lyceum status --web`: a cancellable state machine.
// Pure: every effect (fetch, spawn, timers, clock, log, publish) is injected, because the mod runtime has no Node.
// What it guarantees is the mod's own ordering (a stale await never spawns, probes or retries); when the child really stops is the engine's business.

import type { Phase, WebState } from '../types'
export type { Phase, WebState }

/** Shared by the reconciler and the state machine; `ended` only ever goes false -> true. */
export interface Life {
  epoch: number
  ended: boolean
}

export interface Timer {
  cancel(): void
}

export interface End {
  code: number | null
  signal: string | null
  error?: string
}

export interface SpawnedWeb {
  /** Asks the child to stop; does not wait and does not promise when it does. */
  stop(): void
  ended: Promise<End>
}

export interface WebDeps {
  life: Life
  /** The agent-lyceum command, already split (`['node', 'cli.js']`). */
  command: string[]
  /** The `webPort` option as given; validated here. */
  port: unknown
  fetch(url: string): Promise<{ status: number; text: string }>
  spawn(argv: string[], io: { onStdout(text: string): void; onStderr(text: string): void }): SpawnedWeb
  after(ms: number, fn: () => void): Timer
  sleep(ms: number, o?: { signal?: AbortSignal }): Promise<void>
  /** Monotonic milliseconds. */
  now(): number
  log(line: string): void
  publish(state: WebState): void
}

export const DEFAULT_WEB_PORT = 8787
export const PROBE_DEADLINE_MS = 2000
export const OLD_CHILD_WAIT_MS = 3000
export const FOLLOWER_REPROBE_MS = 10_000
export const FOLLOWER_SPAWN_MS = 30_000
export const BACKOFF_MS = 30_000
export const RETRY_DELAY_MS = 1000
export const MAX_RESTARTS = 5
export const RESTART_WINDOW_MS = 60_000
export const MAX_ABANDONED = 3
const STDERR_KEEP = 2048
const NOT_BUILT = 'The web monitor is not built.'
const CODE_CHANGED = 'status --web: agent-lyceum code changed on disk'

/** 1-65535 as an integer (a digit string is accepted too); undefined means the default; anything else is null. */
export function parseWebPort(raw: unknown): number | null {
  if (raw === undefined || raw === null || raw === '') return DEFAULT_WEB_PORT
  const n = typeof raw === 'string' && /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : raw
  return typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= 65535 ? n : null
}

type ProbeResult = { kind: 'ours'; pid?: number; home?: string } | { kind: 'foreign' } | { kind: 'none' } | { kind: 'timeout' }

function classifyResponse(r: { status: number; text: string }): ProbeResult {
  try {
    const j = JSON.parse(r.text) as { app?: unknown; pid?: unknown; home?: unknown }
    if (r.status === 200 && j.app === 'agent-lyceum-web') return { kind: 'ours', pid: typeof j.pid === 'number' ? j.pid : undefined, home: typeof j.home === 'string' ? j.home : undefined }
  } catch {
    // not JSON: someone else's page
  }
  return { kind: 'foreign' }
}

interface Handle {
  gen: number
  stopping: boolean
  done: boolean
  stop(): void
  ended: Promise<End>
}

export function createWebServer(d: WebDeps) {
  const life = d.life
  let desired = false
  let gen = 0
  let st: WebState = { phase: 'idle' }
  let handle: Handle | undefined
  const timers = new Set<Timer>()
  const abandoned = new Set<number>()
  let inFlight: { token: number; promise: Promise<ProbeResult> } | undefined
  let tokenSeq = 0
  let mode: 'fetch' | 'spawn' = 'fetch'
  let lastProbe: ProbeResult['kind'] | undefined
  let noneInUse = 0
  let restarts: number[] = []

  const alive = (g: number) => g === gen && desired && !life.ended
  const state = (): WebState => (mode === 'spawn' ? { ...st, degraded: true } : { ...st })
  const set = (next: WebState, why: string) => {
    st = next
    d.log(`${next.phase}（${why}）`)
    d.publish(state())
  }

  /** Every timer goes through here so setDesired can cancel them all. */
  const after = (ms: number, fn: () => void): Timer => {
    const t: Timer = d.after(ms, () => {
      timers.delete(t)
      fn()
    })
    timers.add(t)
    return t
  }
  const cancelTimers = () => {
    for (const t of timers) t.cancel()
    timers.clear()
  }
  /** A timer that does nothing when its generation is gone. */
  const later = (g: number, ms: number, fn: () => void) => after(ms, () => (alive(g) ? fn() : d.log('timer dropped (stale generation)')))
  const reattempt = () => void attempt(++gen)

  function setDesired(v: boolean) {
    if (life.ended && v) {
      d.log('ignored: session ended')
      return
    }
    if (v === desired) return
    desired = v
    gen++
    cancelTimers()
    if (!v) {
      if (handle && !handle.done) {
        handle.stopping = true
        handle.stop()
        set({ phase: 'waiting-old' }, 'stop requested')
      } else set({ phase: 'idle' }, 'not wanted')
      return
    }
    restarts = []
    void attempt(gen)
  }

  /** The pane's retry button: the same as closing and reopening, minus the grace. */
  function retry() {
    if (st.phase !== 'failed' || life.ended) return
    setDesired(false)
    setDesired(true)
  }

  function fail(reason: string, hint?: string) {
    set({ phase: 'failed', reason, hint }, reason)
  }

  function backoff(g: number, reason: string, ms: number) {
    set({ phase: 'backoff', reason, retryAt: d.now() + ms }, `${reason}; retry in ${ms / 1000} s`)
    later(g, ms, reattempt)
  }

  function follower(g: number, info: { pid?: number; home?: string }, port: number) {
    set({ phase: 'follower', url: `http://127.0.0.1:${port}/`, pid: info.pid, home: info.home }, 'another agent-lyceum web server owns the port')
    later(g, mode === 'spawn' ? FOLLOWER_SPAWN_MS : FOLLOWER_REPROBE_MS, reattempt)
  }

  async function attempt(g: number) {
    const old = handle
    if (old && !old.done) {
      set({ phase: 'waiting-old' }, 'waiting for the previous child to end')
      await new Promise<void>(res => {
        after(OLD_CHILD_WAIT_MS, res)
        void old.ended.then(() => res())
      })
      if (!alive(g)) return
    }
    const port = parseWebPort(d.port)
    if (port === null) return fail(`webPort 必須是 1–65535 的整數（目前：${String(d.port)}）`, '改好設定後重新載入 mod，再按 retry')
    if (mode === 'fetch') {
      set({ phase: 'probing' }, `GET /health on port ${port}`)
      const r = await probeOnce(port)
      if (!alive(g)) return d.log('probe result discarded (stale generation)')
      lastProbe = r.kind
      if (r.kind === 'ours') {
        noneInUse = 0
        return follower(g, r, port)
      }
      if (r.kind === 'foreign') {
        noneInUse = 0
        return backoff(g, `port ${port} 被其他程式占用（可能是手動啟動的舊版 status --web）`, BACKOFF_MS)
      }
    } else lastProbe = undefined
    spawnIt(g, port)
  }

  /** One logical probe at a time, 2 s deadline; a probe past its deadline is abandoned and its late result is only counted. */
  function probeOnce(port: number): Promise<ProbeResult> {
    if (inFlight) return inFlight.promise
    const token = ++tokenSeq
    const ac = new AbortController()
    let settled = false
    const promise = new Promise<ProbeResult>(resolve => {
      d.fetch(`http://127.0.0.1:${port}/health`).then(
        r => finish(classifyResponse(r)),
        () => finish({ kind: 'none' }),
      )
      d.sleep(PROBE_DEADLINE_MS, { signal: ac.signal }).then(
        () => {
          if (settled) return
          settled = true
          if (inFlight?.token === token) inFlight = undefined
          abandoned.add(token)
          if (abandoned.size >= MAX_ABANDONED && mode === 'fetch') {
            mode = 'spawn'
            d.log(`probing degraded to spawn mode（${abandoned.size} fetches never answered）`)
          }
          resolve({ kind: 'timeout' })
        },
        () => {},
      )
      function finish(r: ProbeResult) {
        if (settled) {
          abandoned.delete(token)
          d.log('late probe result discarded')
          return
        }
        settled = true
        ac.abort()
        if (inFlight?.token === token) inFlight = undefined
        resolve(r)
      }
    })
    inFlight = { token, promise }
    return promise
  }

  function spawnIt(g: number, port: number) {
    set({ phase: 'starting' }, 'spawning status --web')
    const argv = [...d.command, 'status', '--web', '--no-open', '--exit-with-parent', '--host', '127.0.0.1', '--port', String(port)]
    let out = ''
    let err = ''
    let sp: SpawnedWeb
    try {
      sp = d.spawn(argv, {
        onStdout: text => {
          if (st.phase !== 'starting' || handle !== h || h.stopping || !alive(g)) return
          out += text
          const lines = out.split('\n').slice(0, -1)
          const url = lines.map(l => l.trim()).find(Boolean)
          if (url) set({ phase: 'owner', url }, 'listening')
        },
        onStderr: text => {
          err = (err + text).slice(-STDERR_KEEP)
        },
      })
    } catch (e) {
      sp = { stop: () => {}, ended: Promise.resolve({ code: null, signal: null, error: e instanceof Error ? e.message : String(e) }) }
    }
    const h: Handle = {
      gen: g,
      stopping: false,
      done: false,
      stop: () => {
        try {
          sp.stop()
        } catch {
          // stopping is a request; nothing to do when it throws
        }
      },
      ended: sp.ended.catch((e): End => ({ code: null, signal: null, error: e instanceof Error ? e.message : String(e) })),
    }
    handle = h
    void h.ended.then(end => onEnded(h, end, err, port))
  }

  function onEnded(h: Handle, end: End, err: string, port: number) {
    h.done = true
    if (handle === h) handle = undefined
    if (h.stopping) {
      d.log(`stopped（code ${end.code}, signal ${end.signal}）`)
      if (!desired && !handle && st.phase === 'waiting-old') set({ phase: 'idle' }, 'stopped')
      return
    }
    if (h.gen !== gen || !desired || life.ended) return d.log('previous generation ended; ignored')
    const g = h.gen
    const lines = err.split('\n').map(l => l.trim()).filter(Boolean)
    const used = lines.map(l => /^status --web: port \d+ in use by agent-lyceum-web(?: pid (\d+))?(?: home (.+))?$/.exec(l)).find(m => m)
    if (used) {
      noneInUse = lastProbe === 'none' ? noneInUse + 1 : 0
      if (noneInUse >= 2 && mode === 'fetch') {
        mode = 'spawn'
        d.log('probing degraded to spawn mode（fetch cannot reach a server the child can）')
      }
      return follower(g, { pid: used[1] ? Number(used[1]) : undefined, home: used[2] }, port)
    }
    if (lines.some(l => /^status --web: port \d+ in use by another program$/.test(l))) return backoff(g, `port ${port} 被其他程式占用`, BACKOFF_MS)
    if (lines.some(l => /^status --web: port \d+ in use, no answer in 1 s$/.test(l))) return backoff(g, `port ${port} 被占用，但 1 秒內沒有回應`, BACKOFF_MS)
    const notBuilt = lines.indexOf(NOT_BUILT)
    if (notBuilt >= 0) return fail(NOT_BUILT, lines.slice(notBuilt + 1, notBuilt + 4).join('\n').slice(0, 300))
    if (/unknown option/i.test(err)) return fail(lines.find(l => /unknown option/i.test(l)) ?? 'unknown option', 'agent-lyceum 版本太舊，請升級到支援 status --web --exit-with-parent 的版本（需要較新的 CLI），再按 retry')
    const codeChanged = lines.some(l => l.startsWith(CODE_CHANGED))
    const why = end.error ?? lines.at(-1) ?? `exit code ${end.code ?? end.signal}`
    const t = d.now()
    while (restarts.length && t - restarts[0]! > RESTART_WINDOW_MS) restarts.shift()
    if (restarts.length >= MAX_RESTARTS) return fail(`重試次數已達上限（${RESTART_WINDOW_MS / 1000} 秒內 ${MAX_RESTARTS} 次）：${why}`, lines.slice(-3).join('\n').slice(0, 300))
    restarts.push(t)
    backoff(g, `${codeChanged ? 'agent-lyceum 程式已更新，重新啟動' : `status --web 結束：${why}`}（${restarts.length}/${MAX_RESTARTS}）`, RETRY_DELAY_MS)
  }

  return {
    setDesired,
    retry,
    state,
    timers,
    after,
    probeState: () => ({ inFlight: inFlight?.token, abandoned, mode }),
  }
}

export type WebServer = ReturnType<typeof createWebServer>

/** The pane's lines for a state (nothing while idle). */
export function describeWeb(s: WebState, now: number): string[] {
  const lines: string[] = []
  switch (s.phase) {
    case 'owner':
      lines.push(`網頁：${s.url}`)
      break
    case 'follower':
      lines.push(`網頁（共用）：${s.url}${s.pid ? ` · pid ${s.pid}` : ''}${s.home ? ` · home ${s.home}` : ''}`)
      break
    case 'failed':
      lines.push(`網頁啟動失敗：${s.reason ?? ''}`, ...(s.hint ? s.hint.split('\n') : []))
      break
    case 'backoff':
      lines.push(`網頁：${s.reason ?? ''}，將於 ${Math.max(0, Math.ceil(((s.retryAt ?? now) - now) / 1000))} 秒後再試`)
      break
    case 'idle':
      return []
    default:
      lines.push('網頁：啟動中…')
  }
  if (s.degraded) lines.push('網頁探測已降級：改以啟動子程序判斷（fetch 無法使用）')
  return lines
}
