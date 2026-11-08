import { describe, expect, it, vi } from 'vitest'
import { createReconciler, wanted, type Mode } from './reconcile'
import { deferred, flush, makeWeb } from './web-test-kit'

/** A reconciler wired to a real web-server state machine (fake fetch/spawn/clock) and a surface the test moves. */
function setup(o: { mode?: Mode; interactive?: boolean } = {}) {
  const t = makeWeb(vi)
  const surface = { pane: false, band: false }
  const gate: { current?: ReturnType<typeof deferred<void>> } = {}
  let reads = 0
  const calls: { v: boolean; ended: boolean; epoch: number; pendingTimers: number }[] = []
  const setDesired = (v: boolean) => {
    calls.push({ v, ended: t.life.ended, epoch: t.life.epoch, pendingTimers: t.clock.pending() })
    t.ws.setDesired(v)
  }
  const rec = createReconciler({
    life: t.life,
    mode: o.mode ?? 'pane',
    interactive: o.interactive ?? true,
    surfaces: async () => {
      reads++
      const snap = { paneOpen: surface.pane, bandShown: surface.band }
      if (gate.current) await gate.current.promise
      return gate.current ? { paneOpen: surface.pane, bandShown: surface.band } : snap
    },
    setDesired,
    after: t.ws.after,
    log: () => {},
  })
  return { ...t, rec, surface, gate, calls, reads: () => reads, falses: () => calls.filter(c => !c.v).length }
}

describe('wanted', () => {
  const modes: Mode[] = ['off', 'pane', 'session']
  for (const mode of modes)
    for (const interactive of [true, false])
      for (const paneOpen of [true, false])
        for (const bandShown of [true, false]) {
          const want = mode === 'off' || !interactive ? false : mode === 'session' ? true : paneOpen || bandShown
          it(`${mode} interactive=${interactive} pane=${paneOpen} band=${bandShown} -> ${want}`, () => {
            expect(wanted({ mode, interactive, paneOpen, bandShown })).toBe(want)
          })
        }
})

describe('reconcile', () => {
  it('opens the server when a surface is shown', async () => {
    const s = setup()
    s.surface.pane = true
    await s.rec.reconcile()
    expect(s.calls.map(c => c.v)).toEqual([true])
    await flush()
    expect(s.children).toHaveLength(1)
  })

  it('pane -> band never stops the server (band is set before the pane closes)', async () => {
    const s = setup()
    s.surface.pane = true
    await s.rec.reconcile()
    s.surface.band = true
    s.surface.pane = false
    await s.rec.reconcile()
    await s.clock.advance(10_000)
    expect(s.falses()).toBe(0)
    expect(s.children[0]?.stop).not.toHaveBeenCalled()
  })

  it('band -> pane within the 1 s grace never stops the server', async () => {
    const s = setup()
    s.surface.band = true
    await s.rec.reconcile()
    s.surface.band = false
    await s.rec.reconcile() // neither shown: grace starts
    await s.clock.advance(999)
    s.surface.pane = true
    await s.rec.reconcile()
    await s.clock.advance(10_000)
    expect(s.falses()).toBe(0)
    expect(s.children[0]?.stop).not.toHaveBeenCalled()
  })

  it('stops 1 s after the last surface closed, not before; reopening in the grace keeps it', async () => {
    const s = setup()
    s.surface.pane = true
    await s.rec.reconcile()
    await flush()
    s.surface.pane = false
    await s.rec.reconcile()
    await s.clock.advance(999)
    expect(s.falses()).toBe(0)
    await s.clock.advance(1)
    expect(s.falses()).toBe(1)
    expect(s.children[0]?.stop).toHaveBeenCalledTimes(1)

    const k = setup()
    k.surface.pane = true
    await k.rec.reconcile()
    k.surface.pane = false
    await k.rec.reconcile()
    await k.clock.advance(500)
    k.surface.pane = true
    await k.rec.reconcile()
    await k.clock.advance(5000)
    expect(k.falses()).toBe(0)
    expect(k.children[0]?.stop).not.toHaveBeenCalled()
  })

  it('a close another hook answered (pane still there) does not stop the server', async () => {
    const s = setup()
    s.surface.pane = true
    await s.rec.reconcile()
    // $.ui.close settled, but panes() still lists the pane
    await s.rec.reconcile()
    await s.clock.advance(10_000)
    expect(s.falses()).toBe(0)
  })

  it('runs one at a time and re-runs once when called meanwhile', async () => {
    const s = setup()
    s.surface.pane = true
    s.gate.current = deferred<void>()
    const a = s.rec.reconcile()
    void s.rec.reconcile()
    void s.rec.reconcile()
    await flush()
    expect(s.reads()).toBe(1)
    s.gate.current.resolve()
    await a
    await flush()
    expect(s.reads()).toBe(2)
    expect(s.calls.map(c => c.v)).toEqual([true, true])
  })

  it('does nothing with mode off or when not interactive', async () => {
    for (const o of [{ mode: 'off' as Mode }, { interactive: false }]) {
      const s = setup(o)
      s.surface.pane = true
      await s.rec.reconcile()
      await s.clock.advance(5000)
      expect(s.children).toHaveLength(0)
      expect(s.fetch.calls).toHaveLength(0)
      expect(s.calls.filter(c => c.v)).toHaveLength(0)
    }
  })

  it('session mode wants the server whatever is shown', async () => {
    const s = setup({ mode: 'session' })
    await s.rec.reconcile()
    expect(s.calls.map(c => c.v)).toEqual([true])
  })
})

describe('session start (autoOpen)', () => {
  it('reconciles only after the open resolved', async () => {
    const s = setup()
    const open = deferred<void>()
    const started = s.rec.onStart(() => open.promise)
    await flush()
    expect(s.reads()).toBe(0)
    expect(s.calls).toHaveLength(0)
    s.surface.pane = true
    open.resolve()
    await started
    expect(s.reads()).toBe(1)
    expect(s.calls.map(c => c.v)).toEqual([true])
  })

  it('without autoOpen it reconciles at once', async () => {
    const s = setup({ mode: 'session' })
    await s.rec.onStart(undefined)
    expect(s.calls.map(c => c.v)).toEqual([true])
  })

  it('a session end while the open is pending: nothing is read, probed or spawned', async () => {
    const s = setup()
    const open = deferred<void>()
    const started = s.rec.onStart(() => open.promise)
    await flush()
    s.rec.sessionEnd('prompt_input_exit')
    s.surface.pane = true
    open.resolve()
    await started
    await s.clock.advance(5000)
    expect(s.reads()).toBe(0)
    expect(s.fetch.calls).toHaveLength(0)
    expect(s.children).toHaveLength(0)
    expect(s.calls.filter(c => c.v)).toHaveLength(0)
  })

  it('an open that rejects still reconciles', async () => {
    const s = setup({ mode: 'session' })
    await s.rec.onStart(() => Promise.reject(new Error('no pane')))
    expect(s.calls.map(c => c.v)).toEqual([true])
  })
})

describe('session end', () => {
  it.each(['prompt_input_exit', 'logout', 'other'])('%s stops at once, without the grace', async reason => {
    const s = setup()
    s.surface.pane = true
    await s.rec.reconcile()
    await flush()
    s.rec.sessionEnd(reason)
    expect(s.falses()).toBe(1)
    expect(s.children[0]?.stop).toHaveBeenCalledTimes(1)
    expect(s.life.ended).toBe(true)
    expect(s.life.epoch).toBe(1)
  })

  it.each(['clear', 'resume'])('%s calls nothing and leaves life alone', async reason => {
    const s = setup()
    s.surface.pane = true
    await s.rec.reconcile()
    await flush()
    const before = s.calls.length
    s.rec.sessionEnd(reason)
    expect(s.calls).toHaveLength(before)
    expect(s.life).toEqual({ epoch: 0, ended: false })
    expect(s.children[0]?.stop).not.toHaveBeenCalled()
  })

  it('clear while a reconcile is in flight lets it finish', async () => {
    const s = setup()
    s.surface.pane = true
    s.gate.current = deferred<void>()
    const a = s.rec.reconcile()
    await flush()
    s.rec.sessionEnd('clear')
    s.gate.current.resolve()
    await a
    expect(s.calls.map(c => c.v)).toEqual([true])
  })

  it('invalidates a reconcile stuck on panes(): no setDesired(true), no probe, no spawn, no timer', async () => {
    const s = setup()
    s.surface.pane = true
    s.gate.current = deferred<void>()
    const a = s.rec.reconcile()
    await flush()
    s.rec.sessionEnd('prompt_input_exit')
    s.gate.current.resolve()
    await a
    await s.clock.advance(10_000)
    expect(s.calls.filter(c => c.v)).toHaveLength(0)
    expect(s.fetch.calls).toHaveLength(0)
    expect(s.children).toHaveLength(0)
    expect(s.ws.timers.size).toBe(0)
    expect(s.clock.pending()).toBe(0)
  })

  it('cancels a pending grace timer: setDesired(false) is called exactly once', async () => {
    const s = setup()
    s.surface.pane = true
    await s.rec.reconcile()
    await flush()
    s.surface.pane = false
    await s.rec.reconcile() // grace armed
    expect(s.clock.pending()).toBeGreaterThan(0)
    s.rec.sessionEnd('logout')
    await s.clock.advance(5000)
    expect(s.falses()).toBe(1)
    expect(s.ws.timers.size).toBe(0)
  })

  it('after the end, setDesired(true) and retry are ignored but setDesired(false) is idempotent', async () => {
    const s = setup()
    s.surface.pane = true
    await s.rec.reconcile()
    await flush()
    s.rec.sessionEnd('prompt_input_exit')
    const fetches = s.fetch.calls.length
    const spawns = s.children.length
    s.ws.setDesired(true)
    s.ws.retry()
    await s.clock.advance(10_000)
    expect(s.fetch.calls).toHaveLength(fetches)
    expect(s.children).toHaveLength(spawns)
    s.ws.setDesired(false)
    s.ws.setDesired(false)
    expect(s.children[0]?.stop).toHaveBeenCalledTimes(1)
    await s.rec.reconcile() // also a no-op
    expect(s.calls.filter(c => c.v)).toHaveLength(1)
  })

  it('drops an accumulated again flag: no catch-up run after the end', async () => {
    const s = setup()
    s.surface.pane = true
    s.gate.current = deferred<void>()
    const a = s.rec.reconcile()
    void s.rec.reconcile() // again
    await flush()
    s.rec.sessionEnd('other')
    s.gate.current.resolve()
    await a
    await flush()
    expect(s.reads()).toBe(1)
    expect(s.calls.filter(c => c.v)).toHaveLength(0)
  })

  it('order: latch first, then timers and again are cleared, then setDesired(false)', async () => {
    const s = setup()
    s.surface.pane = true
    await s.rec.reconcile()
    await flush()
    s.surface.pane = false
    await s.rec.reconcile() // grace armed
    s.rec.sessionEnd('prompt_input_exit')
    const stop = s.calls.at(-1)
    expect(stop).toMatchObject({ v: false, ended: true, epoch: 1 })
    // the grace timer was already gone when setDesired(false) ran (only the child's own timers could remain)
    expect(stop?.pendingTimers).toBe(0)
  })
})
