import { describe, expect, it } from 'vitest'
import { INITIAL_NAV, createNavStore, navTransition } from '../src/app/nav'

describe('navigation machine', () => {
  it('opens a conversation on the tab of its kind', () => {
    const s = navTransition(INITIAL_NAV, { type: 'open', route: { kind: 'chat', key: 'g:circle' } }).state
    expect(s).toEqual({ tab: 'groups', stack: [{ kind: 'chat', key: 'g:circle' }], sheet: null })
  })

  it('back: stack, then tab contacts, then exit', () => {
    const nav = createNavStore({ tab: 'groups', stack: [{ kind: 'chat', key: 'g:hof' }], sheet: null })
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
