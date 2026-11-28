// Waits of a flow effect bound to the lifetime the runner gives it (flow-runner.ts): a timer or a
// listener goes when that signal aborts, and none is set for one already aborted. Both end as
// `cancelled`, a result the runner drops (it belongs to a lifetime that ended).

import type { Platform } from '../platform/ports'
import type { EffectResult } from '../flows/machine'

const CANCELLED: EffectResult = { ok: false, code: 'cancelled' }

/** Until `at` on the device clock, for an effect whose lifetime is `signal` (the runner's): the timer goes
 *  when the signal aborts, and none is set for one already aborted; both end as `cancelled` */
export function untilTime(clock: Platform['clock'], at: number, signal: AbortSignal): Promise<EffectResult> {
  if (signal.aborted) return Promise.resolve(CANCELLED)
  return new Promise((resolve) => {
    const onAbort = () => {
      off()
      resolve(CANCELLED)
    }
    const off = clock.setTimer(at, () => {
      signal.removeEventListener('abort', onAbort)
      resolve({ ok: true })
    })
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/** Until the app is in front again, for an effect whose lifetime is `signal`: the listener goes when the
 *  signal aborts, and none is set for one already aborted; both end as `cancelled` */
export function untilFront(life: Platform['lifecycle'], signal: AbortSignal): Promise<EffectResult> {
  if (signal.aborted) return Promise.resolve(CANCELLED)
  return new Promise((resolve) => {
    const onAbort = () => {
      off()
      resolve(CANCELLED)
    }
    const off = life.onState((st) => {
      if (st !== 'active') return
      off()
      signal.removeEventListener('abort', onAbort)
      resolve({ ok: true })
    })
    signal.addEventListener('abort', onAbort, { once: true })
  })
}
