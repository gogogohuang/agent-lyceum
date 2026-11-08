// Test doubles shared by web-server.test.ts and reconcile.test.ts: a fake clock, a fake fetch, a fake spawn.
import type { SpawnedWeb, WebDeps, WebState } from './web-server'
import { createWebServer } from './web-server'

// The CI tsconfig has no lib for timers (types: []); vitest runs this under Node.
declare const setTimeout: (fn: () => void, ms: number) => unknown

export const flush = () => new Promise<void>(r => setTimeout(r, 0))

export function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** A clock that only moves when `advance` says so; timers and sleeps fire in time order. */
export function fakeClock() {
  let now = 0
  let seq = 0
  const pending = new Map<number, { at: number; fire: () => void }>()
  const clock = {
    now: () => now,
    after(ms: number, fn: () => void) {
      const id = ++seq
      pending.set(id, { at: now + ms, fire: fn })
      return { cancel: () => void pending.delete(id) }
    },
    sleep(ms: number, o?: { signal?: AbortSignal }) {
      return new Promise<void>((resolve, reject) => {
        const id = ++seq
        pending.set(id, { at: now + ms, fire: resolve })
        o?.signal?.addEventListener('abort', () => {
          pending.delete(id)
          reject(new Error('aborted'))
        })
      })
    },
    pending: () => pending.size,
    async advance(ms: number) {
      const target = now + ms
      for (;;) {
        await flush()
        const due = [...pending.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0]
        if (!due) break
        pending.delete(due[0])
        now = Math.max(now, due[1].at)
        due[1].fire()
      }
      now = target
      await flush()
    },
  }
  return clock
}

export type FetchStep = 'none' | 'ours' | 'foreign' | 'hang' | 'reject' | ReturnType<typeof deferred<{ status: number; text: string }>>

const OURS = { status: 200, text: JSON.stringify({ app: 'agent-lyceum-web', pid: 4242, home: '/h' }) }

/** Scripted fetch: each call takes the next step; once the script runs out the last step repeats. */
export function fakeFetch(...script: FetchStep[]) {
  const calls: string[] = []
  const fn = (url: string): Promise<{ status: number; text: string }> => {
    calls.push(url)
    const step = script[Math.min(calls.length - 1, script.length - 1)] ?? 'none'
    if (typeof step !== 'string') return step.promise
    if (step === 'hang') return new Promise(() => {})
    if (step === 'none' || step === 'reject') return Promise.reject(new Error('ECONNREFUSED'))
    if (step === 'ours') return Promise.resolve(OURS)
    return Promise.resolve({ status: 200, text: '<!doctype html>' })
  }
  return { fn, calls }
}

export type FakeChild = SpawnedWeb & {
  argv: string[]
  stop: ReturnType<typeof import('vitest').vi.fn>
  out(text: string): void
  err(text: string): void
  end(code: number | null, signal?: string | null): void
}

export function fakeSpawner(vi: typeof import('vitest').vi, o: { endOnStop?: boolean } = {}) {
  const children: FakeChild[] = []
  const spawn: WebDeps['spawn'] = (argv, io) => {
    const d = deferred<{ code: number | null; signal: string | null }>()
    const child: FakeChild = {
      argv,
      ended: d.promise,
      stop: vi.fn(() => {
        if (o.endOnStop) d.resolve({ code: null, signal: 'SIGTERM' })
      }),
      out: t => io.onStdout(t),
      err: t => io.onStderr(t),
      end: (code, signal = null) => d.resolve({ code, signal }),
    }
    children.push(child)
    return child
  }
  return { spawn, children }
}

export function makeWeb(vi: typeof import('vitest').vi, o: { fetch?: FetchStep[]; endOnStop?: boolean; port?: unknown; command?: string[] } = {}) {
  const clock = fakeClock()
  const f = fakeFetch(...(o.fetch ?? ['none']))
  const sp = fakeSpawner(vi, { endOnStop: o.endOnStop })
  const life = { epoch: 0, ended: false }
  const logs: string[] = []
  const states: WebState[] = []
  const ws = createWebServer({
    life,
    command: o.command ?? ['agent-lyceum'],
    port: 'port' in o ? o.port : 8787,
    fetch: f.fn,
    spawn: sp.spawn,
    after: clock.after,
    sleep: clock.sleep,
    now: clock.now,
    log: l => logs.push(l),
    publish: s => states.push(s),
  })
  return { ws, clock, life, logs, states, fetch: f, spawner: sp, children: sp.children }
}
