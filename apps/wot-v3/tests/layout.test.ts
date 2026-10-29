// The three frames of the desktop (canvas "WoT v3 Desktop-Layout", Anton 29.10.): the one decision in
// app/layout.ts. App: the sidebar always, two content columns only where there is content (the chat);
// page: a flow in the content column with the sidebar, without it only while the app is locked;
// dialog: one question over whatever is shown (counter-verification, success), never a pane.
import { describe, expect, it } from 'vitest'
import { identityFrame, isPageRoute, shellPanes } from '../src/app/layout'
import type { Route } from '../src/app/nav'
import type { ContactId } from '../src/port'

const chat: Route = { kind: 'chat', key: 'c:priya' }
const group: Route = { kind: 'chat', key: 'g:wg' }
const contact: Route = { kind: 'contact', id: 'priya' as ContactId }
const verify: Route = { kind: 'verify' }
const report: Route = { kind: 'report', id: 'priya' as ContactId }
const interop: Route = { kind: 'interop' }

const contacts = { tab: 'contacts' as const, empty: false }
const noContacts = { tab: 'contacts' as const, empty: true }
const groups = { tab: 'groups' as const, empty: true }
const profile = { tab: 'profile' as const, empty: true }

describe('pages', () => {
  it('verify and report are pages; chat, contact and the interop probe are details', () => {
    expect([verify, report].map(isPageRoute)).toEqual([true, true])
    expect([chat, contact, interop].map(isPageRoute)).toEqual([false, false, false])
  })
})

describe('shell panes: without content no second column', () => {
  it('contacts with content: the list and the detail column, which asks to pick one', () => {
    expect(shellPanes([], contacts)).toEqual({ mode: 'columns', detail: null, page: null, listHidden: false })
  })

  it('an empty contact list is one column with its empty state, never list + “pick a conversation”', () => {
    expect(shellPanes([], noContacts)).toEqual({ mode: 'single', detail: null, page: null, listHidden: false })
  })

  it('the groups placeholder is one column', () => {
    expect(shellPanes([], groups)).toEqual({ mode: 'single', detail: null, page: null, listHidden: false })
  })

  it('the profile is one column', () => {
    expect(shellPanes([], profile)).toEqual({ mode: 'single', detail: null, page: null, listHidden: false })
  })

  it('an open detail is content: list and detail, also where the list is empty or a placeholder', () => {
    expect(shellPanes([chat], contacts)).toEqual({ mode: 'columns', detail: chat, page: null, listHidden: true })
    expect(shellPanes([chat, contact], noContacts)).toEqual({ mode: 'columns', detail: contact, page: null, listHidden: true })
    expect(shellPanes([group], groups)).toEqual({ mode: 'columns', detail: group, page: null, listHidden: true })
    expect(shellPanes([interop], profile)).toEqual({ mode: 'columns', detail: interop, page: null, listHidden: true })
  })
})

describe('shell panes: the ceremony is a page in the content column, with the sidebar', () => {
  it('a page on top replaces the columns: no list, no detail', () => {
    expect(shellPanes([verify], contacts)).toEqual({ mode: 'page', detail: null, page: verify, listHidden: true })
    expect(shellPanes([verify], noContacts)).toEqual({ mode: 'page', detail: null, page: verify, listHidden: true })
    expect(shellPanes([chat, verify], contacts)).toEqual({ mode: 'page', detail: null, page: verify, listHidden: true })
    expect(shellPanes([chat, contact, report], contacts)).toEqual({ mode: 'page', detail: null, page: report, listHidden: true })
  })

  it('a page below the top is not a detail: the detail is the newest route that is not a page', () => {
    expect(shellPanes([chat, verify, contact], contacts)).toEqual({ mode: 'columns', detail: contact, page: null, listHidden: true })
    expect(shellPanes([chat, report, verify], contacts)).toEqual({ mode: 'page', detail: null, page: verify, listHidden: true })
  })

  it('the panes do not depend on the viewport: nothing remounts when a window crosses the breakpoint', () => {
    expect(shellPanes.length).toBe(2)
  })
})

describe('identity flows: without navigation only while the app is locked', () => {
  it('unlock, setup and restore are a whole page without navigation', () => {
    for (const unlocked of [false, true]) {
      expect(identityFrame('unlock', unlocked)).toBe('standalone')
      expect(identityFrame('onboarding', unlocked)).toBe('standalone')
      expect(identityFrame('recovery', unlocked)).toBe('standalone')
    }
    expect(identityFrame('legacy', false)).toBe('standalone')
  })

  it('protection and delete from the open app are pages with the sidebar', () => {
    expect(identityFrame('protection', true)).toBe('app')
    expect(identityFrame('delete', true)).toBe('app')
  })

  it('a delete without an open identity (resumed, after the wipe) has no navigation', () => {
    expect(identityFrame('delete', false)).toBe('standalone')
  })
})
