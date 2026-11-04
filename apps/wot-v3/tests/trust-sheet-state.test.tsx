// Review 504: the trust question starts from the classes as they are stored, and writes only what the
// person changed, in both directions; a stored "off" shows off, switched on it goes back to following
// the trust ("default"). A class left untouched keeps its stored policy. After a failed trust the next
// try compares with the store again. And a star class switched off before the list was reduced stays
// reachable in the details' advanced settings, so the person can undo it.
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createRef } from 'react'
import { describe, expect, it } from 'vitest'
import { createNavStore } from '../src/app/nav'
import { AppContextProvider } from '../src/hooks'
import { LanguageProvider } from '../src/i18n'
import { composeScenario } from '../harness/boot'
import { iiw } from '../harness/scenarios'
import { TrustSheet } from '../src/screens/contacts/TrustSheet'
import { ContactDetailScreen } from '../src/screens/contacts/ContactDetailScreen'
import { writableStore } from '../src/port/store'
import type { AppPort, ClassSetting, ContactDetail, ContactId, Loadable, Result, TrustClass } from '../src/port'

const MARCUS = 'marcus' as ContactId

function setup(stored: Partial<Record<TrustClass, ClassSetting>>, opts: { given?: boolean; giveFails?: number } = {}) {
  const comp = composeScenario(iiw)
  const base = comp.port.stores.contact(MARCUS).get()
  if (base.status !== 'ready' || !base.value) throw new Error('scenario')
  const given = opts.given ?? false
  const cls = (k: TrustClass) => {
    const setting = stored[k] ?? 'default'
    return { setting, on: setting === 'on' || (setting === 'default' && (given || k === 'star' || k === 'groupStar')) }
  }
  const detail = (): ContactDetail => ({
    ...base.value!,
    trust: { ...base.value!.trust, given },
    classes: { anchorMapping: cls('anchorMapping'), profile: cls('profile'), star: cls('star'), groupStar: cls('groupStar'), sealedGroupStar: cls('sealedGroupStar') },
    actions: { ...base.value!.actions, giveTrust: given ? { ok: false, reason: 'already-done' } : { ok: true }, withdrawTrust: given ? { ok: true } : { ok: false, reason: 'already-done' } },
  })
  const store = writableStore<Loadable<ContactDetail | null>>({ ...base, value: detail() })
  const calls: string[] = []
  let fails = opts.giveFails ?? 0
  const done = (r: Result) => ({ actId: 'x' as never, done: Promise.resolve(r) })
  const port: AppPort = {
    ...comp.port,
    trust: {
      ...comp.port.trust,
      giveTrust: () => {
        calls.push('give')
        return done(fails-- > 0 ? { ok: false, error: { kind: 'failed' } as never } : { ok: true, value: undefined })
      },
      setClass: (_id, k, setting) => {
        calls.push(`class ${k} ${setting}`)
        stored[k] = setting
        store.set({ ...base, value: detail() })
        return done({ ok: true, value: undefined })
      },
    },
    stores: { ...comp.port.stores, contact: () => store },
  }
  return { comp, port, calls }
}

function sheet(port: AppPort, comp: ReturnType<typeof composeScenario>) {
  const focus = createRef<HTMLElement>()
  render(
    <LanguageProvider lang="en">
      <AppContextProvider value={{ port, platform: comp.platform, nav: createNavStore() }}>
        <TrustSheet contactId={MARCUS} name="Marcus" mode="on" open onClose={() => undefined} fallbackFocus={focus} />
      </AppContextProvider>
    </LanguageProvider>,
  )
}

const advanced = async () => {
  fireEvent.click(await screen.findByRole('button', { name: 'Advanced settings' }))
  return screen.getByRole('list', { name: 'Advanced settings' })
}

describe('the trust question starts from the stored classes', () => {
  it('a stored profile=off shows off; confirming unchanged writes no class, only the trust', async () => {
    const { comp, port, calls } = setup({ profile: 'off' })
    sheet(port, comp)
    const list = await advanced()
    expect(within(list).getByRole('switch', { name: 'Profile' })).toHaveAttribute('aria-checked', 'false')
    expect(within(list).getByRole('switch', { name: 'Group identities' })).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(screen.getByRole('button', { name: /^Trust$/ }))
    await waitFor(() => expect(calls).toEqual(['give']))
  })

  it('a stored profile=off switched on goes back to following the trust (default), before the trust', async () => {
    const { comp, port, calls } = setup({ profile: 'off' })
    sheet(port, comp)
    const list = await advanced()
    fireEvent.click(within(list).getByRole('switch', { name: 'Profile' }))
    fireEvent.click(screen.getByRole('button', { name: /^Trust$/ }))
    await waitFor(() => expect(calls).toEqual(['class profile default', 'give']))
  })

  it('after a failed trust, switched on again: the next try compares with the store and restores it', async () => {
    const { comp, port, calls } = setup({}, { giveFails: 1 })
    sheet(port, comp)
    const list = await advanced()
    fireEvent.click(within(list).getByRole('switch', { name: 'Profile' }))
    fireEvent.click(screen.getByRole('button', { name: /^Trust$/ }))
    await screen.findByRole('alert')
    expect(calls).toEqual(['class profile off', 'give'])
    fireEvent.click(within(list).getByRole('switch', { name: 'Profile' }))
    expect(within(list).getByRole('switch', { name: 'Profile' })).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(screen.getByRole('button', { name: /^Trust$/ }))
    await waitFor(() => expect(calls).toEqual(['class profile off', 'give', 'class profile default', 'give']))
  })
})

describe('a star class switched off earlier stays reachable in the details', () => {
  function details(stored: Partial<Record<TrustClass, ClassSetting>>) {
    const { comp, port, calls } = setup(stored, { given: true })
    render(
      <LanguageProvider lang="en">
        <AppContextProvider value={{ port, platform: comp.platform, nav: createNavStore() }}>
          <ContactDetailScreen contactId={MARCUS} />
        </AppContextProvider>
      </LanguageProvider>,
    )
    return calls
  }

  it('stored star=off: the Contacts switch is listed, off; switching it on is a direct act', async () => {
    const calls = details({ star: 'off' })
    const list = await advanced()
    const sw = within(list).getByRole('switch', { name: 'Contacts' })
    expect(sw).toHaveAttribute('aria-checked', 'false')
    expect(within(list).queryByRole('switch', { name: 'Groups' })).toBeNull()
    fireEvent.click(sw)
    await waitFor(() => expect(calls).toEqual(['class star on']))
  })

  it('nothing stored for the stars: the three classes only', async () => {
    details({})
    const list = await advanced()
    expect(within(list).getAllByRole('switch')).toHaveLength(3)
  })
})
