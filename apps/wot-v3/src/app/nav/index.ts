// Navigation as a pure machine over { tab, stack, sheet } (architecture §4.1). No router.
// Back: close sheet → pop stack → tab "contacts" → leave the app (Android backButton, web popstate).
// Routes so far: chat, contact (details behind the chat head, messenger pattern), verify, report, interop (developer area),
// and the groups: a group's details, founding one, inviting a contact into one. The remaining routes and
// sheets of the prototype join with their screens.

import type { ContactId, ConversationKey, GroupId, ReadStore } from '../../port'
import { writableStore } from '../../port'

/** contacts, groups, graph, profile (Anton 22.11.: groups get a menu entry of their own) */
export type Tab = 'contacts' | 'groups' | 'graph' | 'profile'
export type Route =
  | { readonly kind: 'chat'; readonly key: ConversationKey }
  | { readonly kind: 'contact'; readonly id: ContactId }
  | { readonly kind: 'verify' }
  | { readonly kind: 'report'; readonly id: ContactId }
  /** a group's details: its members and what the person can do in it. A group has no conversation
   *  yet, so the list opens the details; a conversation will slide in front of them later */
  | { readonly kind: 'group'; readonly id: GroupId }
  /** found a group */
  | { readonly kind: 'group-found' }
  /** invite a contact into a group */
  | { readonly kind: 'group-invite'; readonly id: GroupId }
  /** the own name, from the profile tab */
  | { readonly kind: 'profile-name' }
  /** the interop probe of the developer area (only in a build that has one) */
  | { readonly kind: 'interop' }
  /** the diagnostic entries of this unlock (app/error-report.tsx) */
  | { readonly kind: 'diagnostics' }
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
  /** a new identity begins (onboarding or restore finished): the app starts at the contacts */
  | { readonly type: 'reset' }

export const INITIAL_NAV: NavState = { tab: 'contacts', stack: [], sheet: null }

const isGroupRoute = (r: Route): boolean => r.kind === 'group' || r.kind === 'group-found' || r.kind === 'group-invite'

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
      // a group's routes belong to the groups, every other route to the contacts (the graph tab has
      // no routes of its own)
      return { state: { tab: isGroupRoute(event.route) ? 'groups' : 'contacts', stack: [event.route], sheet: null }, exit: false }
    case 'reset':
      return { state: INITIAL_NAV, exit: false }
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
