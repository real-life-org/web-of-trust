// The app on the device (architecture §5 "Automatisches Sperren und Verdecken"): an open identity is
// covered in the app switcher at once when the app goes to the background, whatever the delay; after
// the background lasted longer than the delay (prefs, default 5 min, §9 question 8) the identity is
// locked through the coordinator's own lock('background-timeout') (§2.1 rule 9). The delay is measured
// on the device clock twice: a timer while in the background (a process that keeps running), and the
// elapsed time on return (a process the system paused).

import { useEffect, useRef } from 'react'
import { BACKGROUND_LOCK_DEFAULT_MS, BACKGROUND_LOCK_PREF, type PrefsPort } from '../platform/ports'
import { usePlatform, usePort } from './context'

/** The delay from prefs; a missing, negative or unreadable value is the default. 0 locks on background. */
export function backgroundLockDelay(prefs: Pick<PrefsPort, 'get'>): number {
  const raw = prefs.get(BACKGROUND_LOCK_PREF)
  const ms = raw === null || raw.trim() === '' ? Number.NaN : Number(raw)
  return Number.isFinite(ms) && ms >= 0 ? ms : BACKGROUND_LOCK_DEFAULT_MS
}

/** Locks after the background delay; `onLocked` runs after a lock this hook started. */
export function useBackgroundLock(onLocked: () => void): void {
  const port = usePort()
  const platform = usePlatform()
  const ref = useRef(onLocked)
  useEffect(() => {
    ref.current = onLocked
  })
  useEffect(() => {
    const { clock, prefs, lifecycle } = platform
    let since: number | null = null
    let cancel: (() => void) | null = null
    let ended = false
    const unlocked = () => port.stores.identity.get().status === 'unlocked'
    const stop = () => {
      cancel?.()
      cancel = null
    }
    const lockNow = () => {
      stop()
      if (ended || !unlocked()) return
      void port.identity.lock('background-timeout').then(
        () => {
          if (!ended) ref.current()
        },
        () => undefined,
      )
    }
    /** in the background with an open identity: the lock is due at since + delay (an unlock that
     *  finished in the background counts from the background start, review 432 R1-6) */
    const arm = () => {
      if (since === null || cancel || !unlocked()) return
      const due = since + backgroundLockDelay(prefs)
      if (clock.now() >= due) lockNow()
      else cancel = clock.setTimer(due, lockNow)
    }
    const offIdentity = port.stores.identity.subscribe(arm)
    // a background that began before this hook (during the start) counts from now on (review 432 R3-2)
    if (lifecycle.current() === 'background') {
      since = clock.now()
      arm()
    }
    const off = lifecycle.onState((s) => {
      if (s === 'background') {
        if (since !== null) return
        since = clock.now()
        arm()
        return
      }
      stop()
      const was = since
      since = null
      // a paused process: its timer did not run, the elapsed device time decides
      if (was !== null && clock.now() - was >= backgroundLockDelay(prefs)) lockNow()
    })
    return () => {
      ended = true
      off()
      offIdentity()
      stop()
    }
  }, [port, platform])
}

/** While an identity is open, the app-switcher image is covered (ScreenProtectionPort.coverInBackground). */
export function useScreenCover(): void {
  const port = usePort()
  const platform = usePlatform()
  useEffect(() => {
    const store = port.stores.identity
    let last: boolean | null = null
    const apply = () => {
      const open = store.get().status === 'unlocked'
      if (open !== last) {
        last = open
        platform.screen.coverInBackground(open)
      }
    }
    apply()
    const off = store.subscribe(apply)
    return () => {
      off()
      platform.screen.coverInBackground(false)
    }
  }, [port, platform])
}
