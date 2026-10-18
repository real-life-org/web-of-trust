// The React bridge: hooks read port stores through useSyncExternalStore and follow changes.
import { act, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { createNavStore } from '../src/app/nav'
import { App } from '../src/app/App'
import { AppContextProvider, useContacts, useConversation } from '../src/hooks'
import { LanguageProvider } from '../src/i18n'
import { composeScenario } from '../harness/boot'
import { empty, iiw } from '../harness/scenarios'

function Probe({ open }: { open: 'c:marcus' | null }) {
  const contacts = useContacts()
  return (
    <ul>
      {contacts.status === 'ready'
        ? contacts.value.map((c) => (
            <li key={c.id} data-testid={c.id}>
              {c.name}:{c.conversation.unread}
            </li>
          ))
        : null}
      {open ? <Conversation k={open} /> : null}
    </ul>
  )
}

function Conversation({ k }: { k: 'c:marcus' }) {
  const c = useConversation(k)
  return <li data-testid="conversation">{c.status === 'ready' ? c.value.items.length : c.status}</li>
}

function mount(open: 'c:marcus' | null) {
  const comp = composeScenario(iiw)
  render(
    <LanguageProvider lang="en">
      <AppContextProvider value={{ port: comp.port, platform: comp.platform, nav: createNavStore() }}>
        <Probe open={open} />
      </AppContextProvider>
    </LanguageProvider>,
  )
  return comp
}

describe('hooks', () => {
  it('useContacts renders the list and follows a received message', async () => {
    const { world } = mount(null)
    expect(screen.getByTestId('priya').textContent).toBe('Priya Raman:0')
    await act(async () => {
      world.apply({ type: 'receive', key: 'c:priya', from: 'priya', text: 'Perfect, thanks!' })
    })
    expect(screen.getByTestId('priya').textContent).toBe('Priya Raman:1')
  })

  it('useConversation reads the conversation and marks it read', async () => {
    mount('c:marcus')
    expect(screen.getByTestId('conversation').textContent).toBe('4')
    await act(async () => {})
    expect(screen.getByTestId('marcus').textContent).toBe('Marcus Chen:0')
  })
})

describe('app on the simulation', () => {
  it('renders the contact list of the IIW scenario', async () => {
    render(<App composition={composeScenario(iiw)} />)
    expect(await screen.findByRole('heading', { name: 'Contacts' })).toBeInTheDocument()
    expect(screen.getAllByText('Priya Raman').length).toBeGreaterThan(0)
    expect(screen.getByText('Invitation: Key Recovery WG')).toBeInTheDocument()
  })

  it('renders the empty state', async () => {
    render(<App composition={composeScenario(empty)} />)
    expect(await screen.findByText('No contacts yet')).toBeInTheDocument()
  })

  it('renders a conversation in German', async () => {
    render(<App composition={composeScenario(iiw, { lang: 'de', open: 'c:priya' })} />)
    expect(await screen.findByText('Ihr vertraut einander')).toBeInTheDocument()
    expect(screen.getByText('Gestern')).toBeInTheDocument()
    expect(screen.getByText('15:52 · Angekommen ✓✓')).toBeInTheDocument()
  })
})
