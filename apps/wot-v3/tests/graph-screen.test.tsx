// The graph tab (Anton 04.11.): you and your contacts as nodes, a tap opens a contact into a card in
// place, "Open" leads to its details; with no contacts, the way into the network is the encounter.
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { createNavStore } from '../src/app/nav'
import { AppContextProvider } from '../src/hooks'
import { LanguageProvider } from '../src/i18n'
import { composeScenario } from '../harness/boot'
import { iiw, SCENARIOS } from '../harness/scenarios'
import { GraphScreen } from '../src/screens/graph/GraphScreen'

if (typeof globalThis.ResizeObserver === 'undefined') {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
}

function show(scenario = iiw, lang: 'en' | 'de' = 'en') {
  const comp = composeScenario(scenario)
  const nav = createNavStore({ tab: 'graph', stack: [], sheet: null })
  render(
    <LanguageProvider lang={lang}>
      <AppContextProvider value={{ port: comp.port, platform: comp.platform, nav }}>
        <GraphScreen />
      </AppContextProvider>
    </LanguageProvider>,
  )
  return { comp, nav }
}

describe('the graph tab', () => {
  it('you and every contact as a node; the count says what the device knows', async () => {
    const { comp } = show()
    const v = comp.port.stores.contacts.get()
    const n = v.status === 'ready' ? v.value.length : 0
    expect(await screen.findByRole('heading', { name: 'Graph' })).toBeInTheDocument()
    expect(screen.getByText(`${n} contacts · what your device knows`)).toBeInTheDocument()
    await waitFor(() => expect(document.querySelectorAll('[data-node]').length).toBe(n + 1))
    expect(document.querySelector('[data-node="me"]')).not.toBeNull()
  })

  it('in the middle your own avatar (Anton 05.11.): your initials, labelled "You"', async () => {
    show()
    await waitFor(() => expect(document.querySelector('[data-node="me"]')).not.toBeNull())
    const me = document.querySelector('[data-node="me"]') as HTMLElement
    // Jonas Weber in the IIW scenario
    expect(within(me).getByText('JW')).toBeInTheDocument()
    expect(within(me).getByText('You')).toBeInTheDocument()
  })

  it('a tap opens the contact into a card; "Open" leads to its details', async () => {
    const { nav } = show()
    await waitFor(() => expect(document.querySelector('[data-node="priya"]')).not.toBeNull())
    const node = document.querySelector('[data-node="priya"]') as HTMLElement
    fireEvent.pointerDown(node, { clientX: 10, clientY: 10 })
    fireEvent.pointerUp(window)
    const card = await screen.findByRole('dialog')
    fireEvent.click(within(card).getByRole('button', { name: 'Open' }))
    expect(nav.get().stack).toEqual([{ kind: 'contact', id: 'priya' }])
  })

  it('review 510: "Open" with a real pointer sequence (down, up, click) leads to the details; the card does not close first', async () => {
    const { nav } = show()
    await waitFor(() => expect(document.querySelector('[data-node="priya"]')).not.toBeNull())
    const node = document.querySelector('[data-node="priya"]') as HTMLElement
    fireEvent.pointerDown(node, { clientX: 10, clientY: 10 })
    fireEvent.pointerUp(window)
    const card = await screen.findByRole('dialog')
    const open = within(card).getByRole('button', { name: 'Open' })
    fireEvent.pointerDown(open, { clientX: 20, clientY: 20 })
    fireEvent.pointerUp(window)
    fireEvent.click(open)
    expect(nav.get().stack).toEqual([{ kind: 'contact', id: 'priya' }])
  })

  it('the keyboard: Enter on a node (a click without a pointer) opens its card', async () => {
    show()
    await waitFor(() => expect(document.querySelector('[data-node="priya"]')).not.toBeNull())
    fireEvent.click(document.querySelector('[data-node="priya"]') as HTMLElement, { detail: 0 })
    expect(await screen.findByRole('dialog')).toBeInTheDocument()
  })

  it('the groups you are in are hubs (Anton 22.11.): a tap opens the group into a card, "Open" leads to its details', async () => {
    const { comp, nav } = show()
    const v = comp.port.stores.groups.get()
    const groups = v.status === 'ready' ? v.value : []
    expect(groups.length).toBeGreaterThan(0)
    await waitFor(() => expect(document.querySelectorAll('[data-hub]').length).toBe(groups.length))
    const first = groups[0]!
    // the device holds none of its members as a contact: one dashed line, to you, and dots at the hub
    expect(document.querySelectorAll(`[data-edge^="member:g:${first.id}|"]`).length).toBe(1)
    expect(document.querySelectorAll(`[data-dot="g:${first.id}"]`).length).toBeGreaterThan(0)
    const hub = document.querySelector(`[data-hub="${first.id}"]`) as HTMLElement
    fireEvent.pointerDown(hub, { clientX: 10, clientY: 10 })
    fireEvent.pointerUp(window)
    const card = await screen.findByRole('dialog', { name: first.name })
    expect(within(card).getByText(`${first.knownMembers} members`)).toBeInTheDocument()
    fireEvent.click(within(card).getByRole('button', { name: 'Open' }))
    expect(nav.get().stack).toEqual([{ kind: 'group', id: first.id }])
  })

  it('the lines in colour at rest (Anton 22.11.): the ground by the verification, the trust on it; a tap changes no colour', async () => {
    const { comp } = show()
    const v = comp.port.stores.contacts.get()
    const contacts = v.status === 'ready' ? v.value : []
    await waitFor(() => expect(document.querySelectorAll('[data-edge^="me:"]').length).toBe(contacts.length))
    const strokes = () => [...document.querySelectorAll('[data-edge^="me:"], [data-edge^="trust:"]')].map((l) => `${l.getAttribute('data-edge')} ${l.getAttribute('stroke')} ${l.getAttribute('stroke-dasharray') ?? 'solid'}`)
    for (const c of contacts) {
      const ground = document.querySelector(`[data-edge="me:${c.id}"]`)!
      const oneSided = c.verification !== 'mutual'
      expect(ground.getAttribute('stroke')).toBe('var(--primary)')
      expect(ground.hasAttribute('stroke-dasharray')).toBe(oneSided)
      const trust = document.querySelector(`[data-edge="trust:${c.id}"]`)
      expect(trust !== null).toBe(c.trust.given || c.trust.received)
      if (trust) {
        expect(trust.getAttribute('stroke')).toBe('var(--success)')
        expect(trust.hasAttribute('stroke-dasharray')).toBe(!(c.trust.given && c.trust.received))
      }
    }
    const before = strokes()
    fireEvent.pointerDown(document.querySelector('[data-node="priya"]') as HTMLElement, { clientX: 10, clientY: 10 })
    fireEvent.pointerUp(window)
    await screen.findByRole('dialog')
    expect(strokes()).toEqual(before)
  })

  it('no contacts: you alone, and the way in is the encounter', async () => {
    const empty = SCENARIOS.empty
    if (!empty) throw new Error('scenario empty')
    const { nav } = show(empty, 'de')
    expect(await screen.findByText('Noch niemand')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Persönlich verifizieren' }))
    expect(nav.get().stack).toEqual([{ kind: 'verify' }])
  })
})
