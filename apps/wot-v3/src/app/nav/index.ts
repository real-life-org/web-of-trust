// Navigation as a pure machine over { tab, stack, sheet } (architecture §4.1). No router.
// Back: close sheet → pop stack → tab "contacts" → leave the app (Android backButton, web popstate).
// Routes so far: chat, contact (details behind the chat head, messenger pattern), verify, report. The
// remaining routes and sheets of the prototype join with their screens.

import type { ContactId, ConversationKey, ReadStore } from '../../port'
import { writableStore } from '../../port'

export type Tab = 'contacts' | 'groups' | 'profile'
export type Route =
  | { readonly kind: 'chat'; readonly key: ConversationKey }
  | { readonly kind: 'contact'; readonly id: ContactId }
  | { readonly kind: 'verify' }
  | { readonly kind: 'report'; readonly id: ContactId }
export type Sheet = never

export interface NavState {
  readonly tab: Tab
  readonly stack: readonly Route[]
  readonly sheet: Sheet | null
}

export type NavEvent =
  | { readonly type: 'selectTab'; readonly tab: Tab }
  | { readonly type: 'push'; readonly route: Route }
  | { readonly type: 'pop' }
  /** deep link or list tap: the route becomes the only stack entry, the tab follows the route */
  | { readonly type: 'open'; readonly route: Route }
  | { readonly type: 'back' }

export const INITIAL_NAV: NavState = { tab: 'contacts', stack: [], sheet: null }

function tabOf(route: Route): Tab {
  return route.kind === 'chat' && route.key.startsWith('g:') ? 'groups' : 'contacts'
}

/** Pure transition. `exit` is true when back has nothing left to close. */
export function navTransition(state: NavState, event: NavEvent): { state: NavState; exit: boolean } {
  switch (event.type) {
    case 'selectTab':
      return { state: { tab: event.tab, stack: [], sheet: null }, exit: false }
    case 'push':
      return { state: { ...state, stack: [...state.stack, event.route] }, exit: false }
    case 'pop':
      return { state: { ...state, stack: state.stack.slice(0, -1) }, exit: false }
    case 'open':
      return { state: { tab: tabOf(event.route), stack: [event.route], sheet: null }, exit: false }
    case 'back':
      if (state.sheet !== null) return { state: { ...state, sheet: null }, exit: false }
      if (state.stack.length > 0) return { state: { ...state, stack: state.stack.slice(0, -1) }, exit: false }
      if (state.tab !== 'contacts') return { state: { ...state, tab: 'contacts' }, exit: false }
      return { state, exit: true }
  }
}

export interface NavStore extends ReadStore<NavState> {
  send(event: NavEvent): boolean
}

/** Holds the nav state; send() returns `exit` of the transition. */
export function createNavStore(initial: NavState = INITIAL_NAV): NavStore {
  const store = writableStore(initial)
  return {
    get: store.get,
    subscribe: store.subscribe,
    send(event) {
      const { state, exit } = navTransition(store.get(), event)
      store.set(state)
      return exit
    },
  }
}
