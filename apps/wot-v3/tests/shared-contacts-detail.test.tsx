// Contacts in common in the contact details (Trust §5, lib 0.12 sharedContacts): the names the
// contact's star hit, with the note that it is the contact's statement. No section while none is named
// (no star yet, or a star that hit nobody this device knows).
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { createNavStore } from '../src/app/nav'
import { AppContextProvider } from '../src/hooks'
import { LanguageProvider } from '../src/i18n'
import { composeScenario } from '../harness/boot'
import { iiw } from '../harness/scenarios'
import { ContactDetailScreen } from '../src/screens/contacts/ContactDetailScreen'
import { writableStore } from '../src/port/store'
import type { AppPort, ContactDetail, ContactId, Loadable } from '../src/port'

const MARCUS = 'marcus' as ContactId

function details(lang: 'en' | 'de', sharedContacts: ContactDetail['sharedContacts']) {
  const comp = composeScenario(iiw)
  const base = comp.port.stores.contact(MARCUS).get()
  if (base.status !== 'ready' || !base.value) throw new Error('scenario')
  const store = writableStore<Loadable<ContactDetail | null>>({ ...base, value: { ...base.value, sharedContacts } })
  const port: AppPort = { ...comp.port, stores: { ...comp.port.stores, contact: () => store } }
  render(
    <LanguageProvider lang={lang}>
      <AppContextProvider value={{ port, platform: comp.platform, nav: createNavStore() }}>
        <ContactDetailScreen contactId={MARCUS} />
      </AppContextProvider>
    </LanguageProvider>,
  )
  return base.value.name ?? ''
}

describe('contacts in common in the details', () => {
  it('names them, and says whose statement it is', async () => {
    const name = details('en', [
      { id: 'lea' as ContactId, name: 'Lea Brandt' },
      { id: 'sam' as ContactId, name: 'Sam Okafor' },
    ])
    expect(await screen.findByRole('heading', { name: 'Contacts in common' })).toBeInTheDocument()
    expect(screen.getByText('Lea Brandt, Sam Okafor')).toBeInTheDocument()
    expect(screen.getByText(`As ${name} states it; nothing is proven by it.`)).toBeInTheDocument()
  })

  it('German', async () => {
    details('de', [{ id: 'lea' as ContactId, name: 'Lea Brandt' }])
    expect(await screen.findByRole('heading', { name: 'Gemeinsame Kontakte' })).toBeInTheDocument()
  })

  it('no section without a name: unknown (null) and an empty list alike', async () => {
    details('en', null)
    await screen.findByRole('heading', { name: 'Trust' })
    expect(screen.queryByRole('heading', { name: 'Contacts in common' })).toBeNull()
  })

  it('an empty list shows nothing either', async () => {
    details('en', [])
    await screen.findByRole('heading', { name: 'Trust' })
    expect(screen.queryByRole('heading', { name: 'Contacts in common' })).toBeNull()
  })
})
