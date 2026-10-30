// The trust switch of a contact row (Anton 30.10.: a switch under the time): outside the row's button,
// it asks the same question as the detail's switch (TrustSheet) and gives or withdraws trust through
// the port; the switch itself follows the contact's state.
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { createNavStore } from '../src/app/nav'
import { AppContextProvider } from '../src/hooks'
import { LanguageProvider } from '../src/i18n'
import { composeScenario } from '../harness/boot'
import { iiw } from '../harness/scenarios'
import { ContactListScreen } from '../src/screens/contacts/ContactListScreen'
import type { AppPort, Result } from '../src/port'

const done = (r: Result) => ({ actId: 'x' as never, done: Promise.resolve(r) })

function list(lang: 'en' | 'de', acts: Partial<Pick<AppPort['trust'], 'giveTrust' | 'withdrawTrust'>>) {
  const comp = composeScenario(iiw)
  const port: AppPort = { ...comp.port, trust: { ...comp.port.trust, ...acts } }
  render(
    <LanguageProvider lang={lang}>
      <AppContextProvider value={{ port, platform: comp.platform, nav: createNavStore() }}>
        <ContactListScreen />
      </AppContextProvider>
    </LanguageProvider>,
  )
}

describe('the trust switch of a row', () => {
  it('an untrusted contact: the switch asks, confirming gives trust; the row itself still opens the chat', async () => {
    const giveTrust = vi.fn(() => done({ ok: true, value: undefined }))
    list('en', { giveTrust })
    const btn = await screen.findByRole('switch', { name: 'Trust Marcus Chen' })
    expect(btn).toHaveAttribute('aria-checked', 'false')
    fireEvent.click(btn)
    await screen.findByRole('dialog', { name: 'Trust Marcus Chen?' })
    fireEvent.click(screen.getByRole('button', { name: 'Trust' }))
    await waitFor(() => expect(giveTrust).toHaveBeenCalledWith('marcus'))
  })

  it('a trusted contact: the switch is on and asks to withdraw (German)', async () => {
    const withdrawTrust = vi.fn(() => done({ ok: true, value: undefined }))
    list('de', { withdrawTrust })
    const btn = await screen.findByRole('switch', { name: 'Vertrauen zu Tarek Aydin zurückziehen' })
    expect(btn).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(btn)
    await screen.findByRole('dialog', { name: 'Vertrauen zurückziehen?' })
    fireEvent.click(screen.getByRole('button', { name: 'Zurückziehen' }))
    await waitFor(() => expect(withdrawTrust).toHaveBeenCalledWith('tarek'))
  })
})
