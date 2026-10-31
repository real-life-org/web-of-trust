// The contact list shows the profile picture of a contact, like the conversation and the details do
// (Anton 31.10.: pictures appeared in the chat and the details only). Radix' avatar renders the image
// once `window.Image` reported a load, which jsdom never does: the test gives it one that loads at once.
import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createNavStore } from '../src/app/nav'
import { AppContextProvider } from '../src/hooks'
import { LanguageProvider } from '../src/i18n'
import { composeScenario } from '../harness/boot'
import { iiw } from '../harness/scenarios'
import { ContactListScreen } from '../src/screens/contacts/ContactListScreen'
import { ConversationRow } from '../src/ui/components'
import type { AppPort, ContactListItem, Loadable } from '../src/port'

const PICTURE = 'data:image/webp;base64,UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAwA0JaQAA3AA/vuUAAA='

/** an Image that counts as loaded the moment a src is set (Radix reads `complete` and `naturalWidth`
 *  right after assigning `src`, and listens for load and error) */
class LoadingImage {
  complete = false
  naturalWidth = 0
  crossOrigin: string | null = null
  referrerPolicy = ''
  addEventListener() {}
  removeEventListener() {}
  set src(_v: string) {
    this.complete = true
    this.naturalWidth = 1
  }
}
vi.stubGlobal('Image', LoadingImage)
afterEach(() => vi.unstubAllGlobals())

const picture = () => document.querySelector(`img[src="${PICTURE}"]`)

describe('the profile picture in the contact list', () => {
  it('the row draws the picture it is given', async () => {
    render(
      <LanguageProvider lang="en">
        <ConversationRow kind="contact" name="Marcus Chen" image={PICTURE} time="" preview="" pending={false} unread={0} />
      </LanguageProvider>,
    )
    await screen.findByText('Marcus Chen')
    await vi.waitFor(() => expect(picture()).not.toBeNull())
  })

  it('the list passes each contact\'s picture to its row', async () => {
    const comp = composeScenario(iiw)
    const source = comp.port.stores.contacts
    // every contact with the picture, the store's identity rules kept (one value per source value)
    let last: { from: Loadable<readonly ContactListItem[]>; to: Loadable<readonly ContactListItem[]> } | null = null
    const contacts = {
      subscribe: source.subscribe,
      get: () => {
        const from = source.get()
        if (last?.from === from) return last.to
        const to = from.status === 'ready' ? { ...from, value: from.value.map((c) => ({ ...c, image: PICTURE })) } : from
        last = { from, to }
        return to
      },
    }
    const port: AppPort = { ...comp.port, stores: { ...comp.port.stores, contacts } }
    render(
      <LanguageProvider lang="en">
        <AppContextProvider value={{ port, platform: comp.platform, nav: createNavStore() }}>
          <ContactListScreen />
        </AppContextProvider>
      </LanguageProvider>,
    )
    await screen.findByText('Marcus Chen')
    await vi.waitFor(() => expect(document.querySelectorAll(`img[src="${PICTURE}"]`).length).toBeGreaterThan(1))
  })
})
