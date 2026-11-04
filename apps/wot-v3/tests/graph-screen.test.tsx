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

  it('no contacts: you alone, and the way in is the encounter', async () => {
    const empty = SCENARIOS.empty
    if (!empty) throw new Error('scenario empty')
    const { nav } = show(empty, 'de')
    expect(await screen.findByText('Noch niemand')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Persönlich verifizieren' }))
    expect(nav.get().stack).toEqual([{ kind: 'verify' }])
  })
})
