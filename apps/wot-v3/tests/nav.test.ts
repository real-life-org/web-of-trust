import { describe, expect, it } from 'vitest'
import { INITIAL_NAV, createNavStore, navTransition } from '../src/app/nav'

describe('navigation machine', () => {
  it('opens a conversation on the contacts tab (the graph tab has no routes of its own)', () => {
    const s = navTransition({ ...INITIAL_NAV, tab: 'graph' }, { type: 'open', route: { kind: 'chat', key: 'c:priya' } }).state
    expect(s).toEqual({ tab: 'contacts', stack: [{ kind: 'chat', key: 'c:priya' }], sheet: null })
  })

  it('back: stack, then tab contacts, then exit', () => {
    const nav = createNavStore({ tab: 'graph', stack: [{ kind: 'contact', id: 'priya' as never }], sheet: null })
    expect(nav.send({ type: 'back' })).toBe(false)
    expect(nav.get().stack).toEqual([])
    expect(nav.send({ type: 'back' })).toBe(false)
    expect(nav.get().tab).toBe('contacts')
    expect(nav.send({ type: 'back' })).toBe(true)
  })

  it('selecting a tab clears the stack', () => {
    const s = navTransition({ tab: 'contacts', stack: [{ kind: 'chat', key: 'c:priya' }], sheet: null }, { type: 'selectTab', tab: 'profile' })
    expect(s.state).toEqual({ tab: 'profile', stack: [], sheet: null })
  })
})

describe('reset', () => {
  it('a new identity: back to the contacts with nothing open', () => {
    const s = navTransition({ tab: 'profile', stack: [{ kind: 'verify' }], sheet: null }, { type: 'reset' })
    expect(s).toEqual({ state: INITIAL_NAV, exit: false })
  })
})
