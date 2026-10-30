// The trust switch in the contact details (handover desktop frames PR 3, Anton 29.10.): one switch,
// a question before each change (TrustSheet) with the sentence of what happens, then the act through
// the port. The switch follows the contact's trust state; it is disabled where the port offers no act.
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { createNavStore } from '../src/app/nav'
import { AppContextProvider } from '../src/hooks'
import { LanguageProvider } from '../src/i18n'
import { composeScenario } from '../harness/boot'
import { iiw } from '../harness/scenarios'
import { ContactDetailScreen } from '../src/screens/contacts/ContactDetailScreen'
import { writableStore } from '../src/port/store'
import type { AppPort, ContactDetail, ContactId, Loadable, Result } from '../src/port'

const MARCUS = 'marcus' as ContactId
const done = (r: Result) => ({ actId: 'x' as never, done: Promise.resolve(r) })

function details(lang: 'en' | 'de', trust: Partial<ContactDetail['trust']>, acts: Partial<Pick<AppPort['trust'], 'giveTrust' | 'withdrawTrust' | 'setClass'>>, available = true) {
  const comp = composeScenario(iiw)
  const base = comp.port.stores.contact(MARCUS).get()
  if (base.status !== 'ready' || !base.value) throw new Error('scenario')
  const given = trust.given ?? base.value.trust.given
  const on = (x: boolean) => ({ setting: x ? ('on' as const) : ('default' as const), on: x })
  const detail: ContactDetail = {
    ...base.value,
    trust: { ...base.value.trust, ...trust },
    classes: { anchorMapping: on(given), profile: { setting: 'default', on: given }, star: { setting: 'default', on: true }, groupStar: { setting: 'default', on: true }, sealedGroupStar: { setting: 'default', on: given } },
    actions: { ...base.value.actions, giveTrust: available && !given ? { ok: true } : { ok: false, reason: 'already-done' }, withdrawTrust: available && given ? { ok: true } : { ok: false, reason: 'already-done' } },
  }
  const store = writableStore<Loadable<ContactDetail | null>>({ ...base, value: detail })
  const port: AppPort = {
    ...comp.port,
    trust: { ...comp.port.trust, ...acts },
    stores: { ...comp.port.stores, contact: () => store },
  }
  render(
    <LanguageProvider lang={lang}>
      <AppContextProvider value={{ port, platform: comp.platform, nav: createNavStore() }}>
        <ContactDetailScreen contactId={MARCUS} />
      </AppContextProvider>
    </LanguageProvider>,
  )
  return { store, detail }
}

describe('the trust switch', () => {
  it('off: the switch asks first, names what is disclosed, and gives trust through the port on confirm', async () => {
    const giveTrust = vi.fn(() => done({ ok: true, value: undefined }))
    details('en', { given: false }, { giveTrust })
    const sw = await screen.findByRole('switch', { name: 'Give trust' })
    expect(sw).toHaveAttribute('aria-checked', 'false')
    fireEvent.click(sw)
    const dialog = await screen.findByRole('dialog', { name: 'Trust Marcus Chen?' })
    expect(dialog).toHaveTextContent('You disclose your anchor to Marcus Chen. Marcus Chen then recognizes you in groups too and sees your profile. What is disclosed stays known, even if you switch it off later.')
    expect(giveTrust).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Trust' }))
    await waitFor(() => expect(giveTrust).toHaveBeenCalledWith(MARCUS))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('on: the switch is checked; switching off asks with the sentence that nothing new is shared, then withdraws', async () => {
    const withdrawTrust = vi.fn(() => done({ ok: true, value: undefined }))
    details('de', { given: true }, { withdrawTrust })
    const sw = await screen.findByRole('switch', { name: 'Vertrauen geben' })
    expect(sw).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(sw)
    const dialog = await screen.findByRole('dialog', { name: 'Vertrauen zurückziehen?' })
    expect(dialog).toHaveTextContent('Du teilst mit Marcus Chen nichts Neues mehr: kein Profil, keine gemeinsamen Gruppen. Was Marcus Chen schon kennt, bleibt.')
    fireEvent.click(screen.getByRole('button', { name: 'Zurückziehen' }))
    await waitFor(() => expect(withdrawTrust).toHaveBeenCalledWith(MARCUS))
  })

  it('cancel changes nothing; a failed act stays visible in the sheet', async () => {
    const giveTrust = vi.fn(() => done({ ok: false, error: { kind: 'infra', code: 'transport', retryable: true } }))
    details('en', { given: false }, { giveTrust })
    fireEvent.click(await screen.findByRole('switch', { name: 'Give trust' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(giveTrust).not.toHaveBeenCalled()
    expect(screen.getByRole('switch', { name: 'Give trust' })).toHaveAttribute('aria-checked', 'false')
    fireEvent.click(screen.getByRole('switch', { name: 'Give trust' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Trust' }))
    expect(await screen.findByText('That did not go through. Please try again.')).toBeInTheDocument()
  })

  it('where the port offers no act (blocked, in flight) the switch is disabled', async () => {
    details('en', { given: false }, {}, false)
    expect(await screen.findByRole('switch', { name: 'Give trust' })).toBeDisabled()
  })

  it('two lines: what the contact disclosed and what you disclosed, each on its own', async () => {
    details('de', { given: true, received: false }, {})
    expect(await screen.findByText('Du vertraust Marcus Chen: dein Anker ist offengelegt.')).toBeInTheDocument()
    expect(screen.getByText('Marcus Chen hat dir den Anker nicht offengelegt.')).toBeInTheDocument()
  })

  it('"Set individually" opens the five classes; a class switch is a direct act (setClass on/off); the default says it follows the trust', async () => {
    const setClass = vi.fn(() => done({ ok: true, value: undefined }))
    details('en', { given: true }, { setClass })
    fireEvent.click(await screen.findByRole('button', { name: 'Set individually' }))
    const list = screen.getByRole('list', { name: 'Set individually' })
    const names = ['Anchor', 'Profile', 'Contacts', 'Groups', 'Group identities']
    for (const n of names) expect(within(list).getByRole('switch', { name: n })).toBeInTheDocument()
    expect(within(list).getByRole('switch', { name: 'Profile' })).toHaveAttribute('aria-checked', 'true')
    expect(within(list).getByText(/Your name and picture\. · follows the trust/)).toBeInTheDocument()
    fireEvent.click(within(list).getByRole('switch', { name: 'Profile' }))
    await waitFor(() => expect(setClass).toHaveBeenCalledWith(MARCUS, 'profile', 'off'))
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
