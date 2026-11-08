import { describe, expect, it, vi } from 'vitest'
import { deferred, flush, makeWeb } from './web-test-kit'
import { describeWeb, parseWebPort } from './web-server'

const IN_USE = 'status --web: port 8787 in use by agent-lyceum-web pid 99 home /home/x\n'
const NOT_BUILT = 'The web monitor is not built.\nFrom the repo: pnpm --dir web install && pnpm --dir web build\nExpected /x/web/dist/start.js\n'

describe('setDesired', () => {
  it('spawns once for repeated setDesired(true) with the contract argv', async () => {
    const t = makeWeb(vi, { command: ['node', '/x/cli.js'], port: 9100 })
    t.ws.setDesired(true)
    t.ws.setDesired(true)
    t.ws.setDesired(true)
    await flush()
    expect(t.children).toHaveLength(1)
    expect(t.children[0]?.argv).toEqual(['node', '/x/cli.js', 'status', '--web', '--no-open', '--exit-with-parent', '--host', '127.0.0.1', '--port', '9100'])
    expect(t.fetch.calls).toEqual(['http://127.0.0.1:9100/health'])
  })

  it('becomes owner on the first non-empty stdout line (the URL)', async () => {
    const t = makeWeb(vi)
    t.ws.setDesired(true)
    await flush()
    expect(t.ws.state().phase).toBe('starting')
    t.children[0]?.out('\n  \nhttp://127.0.0.1:8787/\nsecond\n')
    expect(t.ws.state()).toMatchObject({ phase: 'owner', url: 'http://127.0.0.1:8787/' })
    expect(t.states.at(-1)).toMatchObject({ phase: 'owner' })
  })

  it('discards a probe that returns after setDesired(false): nothing is spawned', async () => {
    const p = deferred<{ status: number; text: string }>()
    const t = makeWeb(vi, { fetch: [p] })
    t.ws.setDesired(true)
    await flush()
    t.ws.setDesired(false)
    p.reject(new Error('ECONNREFUSED'))
    await t.clock.advance(5000)
    expect(t.children).toHaveLength(0)
    expect(t.ws.state().phase).toBe('idle')
  })

  it('a probe that never resolves times out after 2 s and spawns; three of them degrade to spawn mode and leave no timer behind', async () => {
    const t = makeWeb(vi, { fetch: ['hang'] })
    t.ws.setDesired(true)
    await t.clock.advance(1999)
    expect(t.children).toHaveLength(0)
    await t.clock.advance(1)
    expect(t.children).toHaveLength(1)
    t.children[0]?.err(IN_USE)
    t.children[0]?.end(1)
    await flush()
    expect(t.ws.state().phase).toBe('follower')
    await t.clock.advance(10_000) // re-probe 2
    await t.clock.advance(2000)
    expect(t.children).toHaveLength(2)
    t.children[1]?.err(IN_USE)
    t.children[1]?.end(1)
    await t.clock.advance(10_000) // re-probe 3
    await t.clock.advance(2000)
    expect(t.children).toHaveLength(3)
    expect(t.fetch.calls).toHaveLength(3)
    expect(t.ws.probeState().abandoned.size).toBe(3)
    expect(t.ws.probeState().mode).toBe('spawn')
    expect(t.ws.state().degraded).toBe(true)
    t.children[2]?.err(IN_USE)
    t.children[2]?.end(1)
    await flush()
    // spawn mode: the follower tries to spawn every 30 s and never fetches again
    await t.clock.advance(30_000)
    expect(t.children).toHaveLength(4)
    expect(t.fetch.calls).toHaveLength(3)
    t.ws.setDesired(false)
    expect(t.ws.timers.size).toBe(0)
  })

  it('a probe result that arrives after its deadline changes nothing', async () => {
    const p = deferred<{ status: number; text: string }>()
    const t = makeWeb(vi, { fetch: [p] })
    t.ws.setDesired(true)
    await t.clock.advance(2000)
    expect(t.children).toHaveLength(1)
    t.children[0]?.out('http://127.0.0.1:8787/\n')
    p.resolve({ status: 200, text: JSON.stringify({ app: 'agent-lyceum-web' }) })
    await flush()
    expect(t.ws.state().phase).toBe('owner')
    expect(t.children).toHaveLength(1)
    expect(t.ws.probeState().abandoned.size).toBe(0)
    expect(t.logs.some(l => l.includes('late probe result discarded'))).toBe(true)
  })

  it('releases inFlight at the deadline, keeps the abandoned token, and a late A never touches probe B', async () => {
    const a = deferred<{ status: number; text: string }>()
    const b = deferred<{ status: number; text: string }>()
    const t = makeWeb(vi, { fetch: [a, b], endOnStop: true })
    t.ws.setDesired(true)
    await flush()
    const tokenA = t.ws.probeState().inFlight
    expect(tokenA).toBeDefined()
    await t.clock.advance(2000)
    expect(t.ws.probeState().inFlight).toBeUndefined()
    expect([...t.ws.probeState().abandoned]).toEqual([tokenA])
    expect(t.children).toHaveLength(1)
    // new generation: the old child is stopped, then a fresh fetch (not A's) is made
    t.ws.setDesired(false)
    t.ws.setDesired(true)
    await flush()
    expect(t.children[0]?.stop).toHaveBeenCalledTimes(1)
    expect(t.fetch.calls).toHaveLength(2)
    const tokenB = t.ws.probeState().inFlight
    expect(tokenB).toBeDefined()
    expect(tokenB).not.toBe(tokenA)
    const phase = t.ws.state().phase
    a.resolve({ status: 200, text: JSON.stringify({ app: 'agent-lyceum-web' }) })
    await flush()
    expect(t.ws.probeState().inFlight).toBe(tokenB)
    expect(t.ws.probeState().abandoned.size).toBe(0)
    expect(t.ws.state().phase).toBe(phase)
    // another generation inside B's deadline shares B instead of fetching again
    t.ws.setDesired(false)
    t.ws.setDesired(true)
    await flush()
    expect(t.fetch.calls).toHaveLength(2)
    b.reject(new Error('refused'))
    await flush()
    expect(t.children).toHaveLength(2)
  })
})

describe('failed and retry', () => {
  it('not built: failed, no retry; only false->true (or retry) leaves it and resets the restart budget', async () => {
    const t = makeWeb(vi)
    t.ws.setDesired(true)
    await flush()
    t.children[0]?.err(NOT_BUILT)
    t.children[0]?.end(1)
    await flush()
    expect(t.ws.state().phase).toBe('failed')
    t.ws.setDesired(true) // no-op
    await t.clock.advance(120_000)
    expect(t.children).toHaveLength(1)

    t.ws.setDesired(false)
    t.ws.setDesired(true)
    await flush()
    expect(t.children).toHaveLength(2)
    // the budget is fresh: five restarts are allowed, the sixth failure is final
    for (let i = 0; i < 5; i++) {
      t.children[1 + i]?.end(1)
      await t.clock.advance(1000)
      expect(t.children).toHaveLength(3 + i)
    }
    t.children[6]?.end(1)
    await t.clock.advance(60_000)
    expect(t.children).toHaveLength(7)
    expect(t.ws.state().phase).toBe('failed')
  })

  it('retry() leaves failed with one spawn; after the session ended it does nothing', async () => {
    const t = makeWeb(vi)
    t.ws.setDesired(true)
    await flush()
    t.children[0]?.err('unknown option --web\n')
    t.children[0]?.end(1)
    await flush()
    expect(t.ws.state().phase).toBe('failed')
    t.ws.retry()
    await flush()
    expect(t.children).toHaveLength(2)
    t.children[1]?.err('unknown option --web\n')
    t.children[1]?.end(1)
    await flush()
    expect(t.ws.state().phase).toBe('failed')
    t.life.ended = true
    t.ws.retry()
    await flush()
    expect(t.children).toHaveLength(2)
    expect(t.fetch.calls).toHaveLength(2)
  })

  it('ignores setDesired(true) once the session ended, but setDesired(false) still stops', async () => {
    const t = makeWeb(vi)
    t.ws.setDesired(true)
    await flush()
    t.life.ended = true
    t.ws.setDesired(false)
    expect(t.children[0]?.stop).toHaveBeenCalledTimes(1)
    t.ws.setDesired(true)
    await flush()
    expect(t.children).toHaveLength(1)
    expect(t.fetch.calls).toHaveLength(1)
    expect(t.logs.some(l => l.includes('ignored: session ended'))).toBe(true)
  })
})

describe('stopping', () => {
  it('a requested stop that ends with SIGTERM is not retried', async () => {
    const t = makeWeb(vi)
    t.ws.setDesired(true)
    await flush()
    t.children[0]?.out('http://127.0.0.1:8787/\n')
    t.ws.setDesired(false)
    expect(t.children[0]?.stop).toHaveBeenCalledTimes(1)
    t.children[0]?.end(null, 'SIGTERM')
    await t.clock.advance(120_000)
    expect(t.children).toHaveLength(1)
    expect(t.ws.state().phase).toBe('idle')
  })

  it('reopening waits for the old child to end; the old end does not disturb the new state', async () => {
    const t = makeWeb(vi)
    t.ws.setDesired(true)
    await flush()
    t.children[0]?.out('http://127.0.0.1:8787/\n')
    t.ws.setDesired(false)
    t.ws.setDesired(true)
    await flush()
    expect(t.ws.state().phase).toBe('waiting-old')
    expect(t.children).toHaveLength(1)
    t.children[0]?.end(null, 'SIGTERM')
    await flush()
    expect(t.children).toHaveLength(2)
    expect(t.ws.state().phase).toBe('starting')
  })

  it('reopening goes on after 3 s when the old child has not ended', async () => {
    const t = makeWeb(vi)
    t.ws.setDesired(true)
    await flush()
    t.children[0]?.out('http://127.0.0.1:8787/\n')
    t.ws.setDesired(false)
    t.ws.setDesired(true)
    await t.clock.advance(2999)
    expect(t.children).toHaveLength(1)
    await t.clock.advance(1)
    expect(t.children).toHaveLength(2)
  })

  it('no timer survives setDesired(false) during backoff', async () => {
    const t = makeWeb(vi)
    t.ws.setDesired(true)
    await flush()
    t.children[0]?.err('status --web: port 8787 in use by another program\n')
    t.children[0]?.end(1)
    await flush()
    expect(t.ws.state().phase).toBe('backoff')
    t.ws.setDesired(false)
    await t.clock.advance(30_000)
    expect(t.children).toHaveLength(1)
    expect(t.ws.timers.size).toBe(0)
  })
})

describe('stderr classification', () => {
  const start = async (err: string, code = 1) => {
    const t = makeWeb(vi)
    t.ws.setDesired(true)
    await flush()
    t.children[0]?.err(err)
    t.children[0]?.end(code)
    await flush()
    return t
  }

  it('in use by agent-lyceum-web: follower with the owner pid and home', async () => {
    const t = await start(IN_USE)
    expect(t.ws.state()).toMatchObject({ phase: 'follower', pid: 99, home: '/home/x', url: 'http://127.0.0.1:8787/' })
  })

  it.each([
    ['another program', 'status --web: port 8787 in use by another program\n'],
    ['no answer', 'status --web: port 8787 in use, no answer in 1 s\n'],
  ])('%s: backoff for 30 s then a new attempt', async (_n, err) => {
    const t = await start(err)
    expect(t.ws.state().phase).toBe('backoff')
    await t.clock.advance(29_999)
    expect(t.fetch.calls).toHaveLength(1)
    await t.clock.advance(1)
    expect(t.fetch.calls).toHaveLength(2)
    expect(t.children).toHaveLength(2)
  })

  it('not built: failed with reason and two hint lines, never retried', async () => {
    const t = await start(NOT_BUILT)
    expect(t.ws.state()).toMatchObject({ phase: 'failed', reason: 'The web monitor is not built.' })
    expect(t.ws.state().hint).toContain('pnpm --dir web build')
    expect(t.ws.state().hint).toContain('Expected /x/web/dist/start.js')
    await t.clock.advance(300_000)
    expect(t.children).toHaveLength(1)
  })

  it('unknown option: failed with an upgrade hint', async () => {
    const t = await start("error: unknown option '--exit-with-parent'\n")
    expect(t.ws.state().phase).toBe('failed')
    expect(t.ws.state().hint).toMatch(/newer|upgrade|升級/)
    await t.clock.advance(300_000)
    expect(t.children).toHaveLength(1)
  })

  it('code changed on disk: restarts at most 5 times in 60 s', async () => {
    const t = makeWeb(vi)
    t.ws.setDesired(true)
    await flush()
    for (let i = 0; i < 5; i++) {
      t.children[i]?.err('status --web: agent-lyceum code changed on disk; restart to load it\n')
      t.children[i]?.end(75)
      await t.clock.advance(1000)
      expect(t.children).toHaveLength(i + 2)
    }
    t.children[5]?.err('status --web: agent-lyceum code changed on disk; restart to load it\n')
    t.children[5]?.end(75)
    await t.clock.advance(5000)
    expect(t.children).toHaveLength(6)
    expect(t.ws.state().phase).toBe('failed')
  })

  it('any other exit is retried', async () => {
    const t = await start('boom\n', 2)
    expect(t.ws.state().phase).toBe('backoff')
    await t.clock.advance(1000)
    expect(t.children).toHaveLength(2)
  })
})

describe('webPort', () => {
  it.each([[0], [70000], ['x'], [1.5], [-1]])('%s: no fetch, no spawn, failed with the value in the reason', async port => {
    const t = makeWeb(vi, { port })
    t.ws.setDesired(true)
    await flush()
    expect(t.children).toHaveLength(0)
    expect(t.fetch.calls).toHaveLength(0)
    expect(t.ws.state().phase).toBe('failed')
    expect(t.ws.state().reason).toContain(`目前：${String(port)}`)
    expect(t.logs.some(l => l.includes('webPort'))).toBe(true)
  })

  it.each([
    [undefined, 8787],
    [1, 1],
    [65535, 65535],
    ['9000', 9000],
  ])('parseWebPort(%s) = %s', (raw, want) => {
    expect(parseWebPort(raw)).toBe(want)
  })
})

describe('follower', () => {
  it('re-probes every 10 s, spawns when nobody answers, and a closing follower stops nothing', async () => {
    const t = makeWeb(vi, { fetch: ['ours', 'ours', 'none'] })
    t.ws.setDesired(true)
    await flush()
    expect(t.ws.state()).toMatchObject({ phase: 'follower', pid: 4242 })
    expect(t.children).toHaveLength(0)
    await t.clock.advance(9999)
    expect(t.fetch.calls).toHaveLength(1)
    await t.clock.advance(1)
    expect(t.fetch.calls).toHaveLength(2)
    expect(t.children).toHaveLength(0)
    await t.clock.advance(10_000)
    expect(t.fetch.calls).toHaveLength(3)
    expect(t.children).toHaveLength(1)
  })

  it('setDesired(false) as follower calls stop on no child', async () => {
    const t = makeWeb(vi)
    t.ws.setDesired(true)
    await flush()
    t.children[0]?.err(IN_USE)
    t.children[0]?.end(1)
    await flush()
    expect(t.ws.state().phase).toBe('follower')
    t.ws.setDesired(false)
    await t.clock.advance(60_000)
    expect(t.children).toHaveLength(1)
    expect(t.children[0]?.stop).not.toHaveBeenCalled()
    expect(t.ws.timers.size).toBe(0)
  })

  it('a foreign answer to the probe backs off without spawning', async () => {
    const t = makeWeb(vi, { fetch: ['foreign'] })
    t.ws.setDesired(true)
    await flush()
    expect(t.ws.state().phase).toBe('backoff')
    expect(t.children).toHaveLength(0)
  })

  it('two refused fetches whose spawn then says in-use degrade to spawn mode', async () => {
    const t = makeWeb(vi, { fetch: ['none'] })
    t.ws.setDesired(true)
    await flush()
    t.children[0]?.err(IN_USE)
    t.children[0]?.end(1)
    await t.clock.advance(10_000)
    expect(t.fetch.calls).toHaveLength(2)
    t.children[1]?.err(IN_USE)
    t.children[1]?.end(1)
    await flush()
    expect(t.ws.probeState().mode).toBe('spawn')
    await t.clock.advance(30_000)
    expect(t.fetch.calls).toHaveLength(2)
    expect(t.children).toHaveLength(3)
  })
})

describe('describeWeb', () => {
  it('names what the pane shows for each phase', () => {
    expect(describeWeb({ phase: 'owner', url: 'http://127.0.0.1:8787/' }, 0).join('\n')).toContain('http://127.0.0.1:8787/')
    expect(describeWeb({ phase: 'follower', url: 'http://127.0.0.1:8787/', pid: 7, home: '/h' }, 0).join('\n')).toMatch(/7.*\/h/s)
    expect(describeWeb({ phase: 'failed', reason: 'R', hint: 'H1\nH2' }, 0)).toEqual(expect.arrayContaining([expect.stringContaining('R'), 'H1', 'H2']))
    expect(describeWeb({ phase: 'backoff', reason: 'busy', retryAt: 30_000 }, 10_000).join('\n')).toMatch(/20/)
    expect(describeWeb({ phase: 'idle' }, 0)).toEqual([])
  })
})
