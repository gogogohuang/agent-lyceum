// Decides whether the status web server is wanted from what is on screen, and keeps that decision honest across awaits.
// Pure like web-server.ts: surfaces, setDesired and timers are injected.
import type { Life, Timer } from './web-server'

export type Mode = 'off' | 'pane' | 'session'

export const GRACE_MS = 1000

export function wanted(s: { mode: Mode; interactive: boolean; paneOpen: boolean; bandShown: boolean }): boolean {
  if (s.mode === 'off' || !s.interactive) return false
  if (s.mode === 'session') return true
  return s.paneOpen || s.bandShown
}

export interface ReconcileDeps {
  life: Life
  mode: Mode
  interactive: boolean
  /** Reads the engine's pane list and the band atom. */
  surfaces(): Promise<{ paneOpen: boolean; bandShown: boolean }>
  setDesired(v: boolean): void
  /** A timer the web-server can cancel (`WebServer.after`). */
  after(ms: number, fn: () => void): Timer
  log(line: string): void
}

export function createReconciler(d: ReconcileDeps) {
  const life = d.life
  let running = false
  let again = false
  let grace: Timer | undefined
  let graceDue = false

  const cancelGrace = () => {
    grace?.cancel()
    grace = undefined
    graceDue = false
  }

  async function pass() {
    const e = life.epoch
    const final = graceDue
    graceDue = false
    const s = await d.surfaces()
    // The session may have ended while we waited: then nothing below may run.
    if (life.epoch !== e || life.ended) return d.log('reconcile dropped: session ended')
    if (wanted({ mode: d.mode, interactive: d.interactive, paneOpen: s.paneOpen, bandShown: s.bandShown })) {
      cancelGrace()
      d.setDesired(true)
    } else if (final) {
      grace = undefined
      d.setDesired(false)
    } else if (!grace) {
      grace = d.after(GRACE_MS, () => {
        grace = undefined
        graceDue = true
        void reconcile()
      })
    }
  }

  /** One at a time; a call made meanwhile makes it run once more afterwards. */
  async function reconcile(): Promise<void> {
    if (life.ended) return
    if (running) {
      again = true
      return
    }
    running = true
    try {
      do {
        again = false
        await pass()
      } while (again && !life.ended)
    } finally {
      running = false
    }
  }

  /** Session end other than clear/resume: latch first, then clear what is pending, then ask the server to stop. */
  function endSession() {
    life.epoch++
    life.ended = true
    again = false
    cancelGrace()
    d.setDesired(false)
  }

  function sessionEnd(reason: string) {
    if (reason === 'clear' || reason === 'resume') return
    endSession()
  }

  /** `session.start`: reconcile only once autoOpen's open has settled, and not at all if the session ended meanwhile. */
  async function onStart(autoOpen: (() => Promise<unknown>) | undefined) {
    const e = life.epoch
    if (autoOpen) {
      try {
        await autoOpen()
      } catch (err) {
        d.log(`autoOpen failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    if (life.epoch !== e || life.ended) return
    await reconcile()
  }

  return { reconcile, endSession, sessionEnd, onStart }
}

export type Reconciler = ReturnType<typeof createReconciler>
