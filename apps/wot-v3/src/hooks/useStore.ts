import { useSyncExternalStore } from 'react'
import type { ReadStore } from '../port'

/** Reads a port store. Relies on the port rules: get() is synchronous and referentially stable
 *  between notifications (architecture §2.1 rules 1, 2), which useSyncExternalStore requires. */
export function useStore<T>(store: ReadStore<T>): T {
  return useSyncExternalStore(store.subscribe, store.get, store.get)
}
