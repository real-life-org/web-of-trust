import { useState, useEffect, useRef } from 'react'
import type { Subscribable } from '@web_of_trust/core/ports'

/**
 * React hook that subscribes to a Subscribable<T> and re-renders on changes.
 *
 * Uses useState + useEffect instead of useSyncExternalStore because
 * subscribe() callbacks may trigger async snapshot changes that violate
 * useSyncExternalStore's contract (getSnapshot must return cached/stable values).
 */
export function useSubscribable<T>(subscribable: Subscribable<T>): T {
  const [value, setValue] = useState(() => subscribable.getValue())
  const subscribableRef = useRef(subscribable)

  useEffect(() => {
    subscribableRef.current = subscribable

    // Sync initial value in case subscribable changed
    setValue(subscribable.getValue())

    const unsub = subscribable.subscribe((next: T) => {
      // Guard against stale callbacks from a previous subscribable
      if (subscribableRef.current === subscribable) {
        setValue(next)
      }
    })

    return unsub
  }, [subscribable])

  return value
}
