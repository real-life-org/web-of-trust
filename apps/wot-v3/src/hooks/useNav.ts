import type { NavEvent, NavState } from '../app/nav'
import { useNavStore } from './context'
import { useStore } from './useStore'

export function useNav(): { state: NavState; send: (e: NavEvent) => boolean } {
  const nav = useNavStore()
  return { state: useStore(nav), send: nav.send }
}
