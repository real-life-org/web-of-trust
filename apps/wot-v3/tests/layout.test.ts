// Where a flow appears (handshake UX round 2.3, E5): the one decision in app/layout.ts.
import { describe, expect, it } from 'vitest'
import { flowPresentation, isFlowRoute, shellPanes } from '../src/app/layout'
import type { Route } from '../src/app/nav'
import type { ContactId } from '../src/port'

const chat: Route = { kind: 'chat', key: 'c:priya' }
const contact: Route = { kind: 'contact', id: 'priya' as ContactId }
const verify: Route = { kind: 'verify' }
const report: Route = { kind: 'report', id: 'priya' as ContactId }
const interop: Route = { kind: 'interop' }

describe('flow presentation', () => {
  it('verify and report are flows; chat, contact and the interop probe are details', () => {
    expect([verify, report].map(isFlowRoute)).toEqual([true, true])
    expect([chat, contact, interop].map(isFlowRoute)).toEqual([false, false, false])
  })

  it('a flow is the screen on the phone and a sheet from the column breakpoint', () => {
    expect(flowPresentation(false)).toBe('screen')
    expect(flowPresentation(true)).toBe('sheet')
  })
})

describe('shell panes', () => {
  it('nothing open: the list, no detail, no flow', () => {
    expect(shellPanes([], true)).toEqual({ detail: null, flow: null, listHidden: false })
    expect(shellPanes([], false)).toEqual({ detail: null, flow: null, listHidden: false })
  })

  it('a detail route takes the detail column (phone: the screen)', () => {
    expect(shellPanes([chat], true)).toEqual({ detail: chat, flow: null, listHidden: true })
    expect(shellPanes([chat, contact], false)).toEqual({ detail: contact, flow: null, listHidden: true })
  })

  it('desktop: a flow on top is a sheet and the detail column keeps what was there', () => {
    expect(shellPanes([chat, verify], true)).toEqual({ detail: chat, flow: { route: verify, as: 'sheet' }, listHidden: true })
    expect(shellPanes([chat, contact, report], true)).toEqual({ detail: contact, flow: { route: report, as: 'sheet' }, listHidden: true })
    expect(shellPanes([verify], true)).toEqual({ detail: null, flow: { route: verify, as: 'sheet' }, listHidden: true })
  })

  it('phone: a flow on top is the screen, the detail below is not rendered', () => {
    expect(shellPanes([chat, verify], false)).toEqual({ detail: null, flow: { route: verify, as: 'screen' }, listHidden: true })
    expect(shellPanes([verify], false)).toEqual({ detail: null, flow: { route: verify, as: 'screen' }, listHidden: true })
  })

  it('a flow below the top is not a detail: the detail is the newest non-flow route', () => {
    expect(shellPanes([chat, verify, contact], true)).toEqual({ detail: contact, flow: null, listHidden: true })
    expect(shellPanes([chat, report, verify], true)).toEqual({ detail: chat, flow: { route: verify, as: 'sheet' }, listHidden: true })
  })
})
