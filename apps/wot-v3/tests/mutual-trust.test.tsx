// After the mutual verification (Anton 04.11.): the success sheet offers "Trust {name}" and "Not now";
// either way the chat opens afterwards. The trust question carries "Advanced settings", reduced to
// what a person can see and decide on: the anchor (that is the trust itself, no switch), the profile
// and the group identities. A class switched off there is set before the trust is given, so it never
// goes out; a class left on keeps following the trust.
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { createNavStore } from '../src/app/nav'
import { AppContextProvider } from '../src/hooks'
import { LanguageProvider } from '../src/i18n'
import { composeScenario } from '../harness/boot'
import { iiw } from '../harness/scenarios'
import { MutualSheet } from '../src/screens/verify/MutualSheet'
import type { ContactId } from '../src/port'

function setup() {
  const comp = composeScenario(iiw)
  const calls: string[] = []
  // the acts as the port answers them: committed (what the library does is covered elsewhere)
  const done = () => ({ actId: 'x' as never, done: Promise.resolve({ ok: true as const, value: undefined }) })
  Object.assign(comp.port.trust, {
    giveTrust: (id: ContactId) => (calls.push(`give ${id}`), done()),
    setClass: (_id: ContactId, cls: string, setting: string) => (calls.push(`class ${cls} ${setting}`), done()),
  })
  const contacts = comp.port.stores.contacts.get()
  const target = contacts.status === 'ready' ? contacts.value.find((c) => !c.trust.given) : undefined
  if (!target) throw new Error('scenario: no contact without trust')
  const openChat = vi.fn()
  render(
    <LanguageProvider lang="en">
      <AppContextProvider value={{ port: comp.port, platform: comp.platform, nav: createNavStore() }}>
        <MutualSheet contactId={target.id} name="Jonas Weber" onOpenChat={openChat} onClose={() => undefined} />
      </AppContextProvider>
    </LanguageProvider>,
  )
  return { calls, openChat, id: target.id }
}

describe('the success sheet after the mutual verification', () => {
  it('two buttons: "Trust Jonas" and "Not now"; "Not now" opens the chat and gives nothing', async () => {
    const { calls, openChat } = setup()
    await screen.findByRole('button', { name: 'Trust Jonas' })
    expect(screen.queryByRole('button', { name: 'Open chat' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }))
    expect(openChat).toHaveBeenCalledTimes(1)
    expect(calls).toEqual([])
  })

  it('"Trust Jonas", the question, "Trust": the trust is given and the chat opens', async () => {
    const { calls, openChat, id } = setup()
    fireEvent.click(await screen.findByRole('button', { name: 'Trust Jonas' }))
    fireEvent.click(await screen.findByRole('button', { name: /^Trust$/ }))
    await waitFor(() => expect(openChat).toHaveBeenCalledTimes(1))
    expect(calls).toEqual([`give ${id}`])
  })

  it('advanced settings: the anchor, the profile, the group identities, nothing else; the profile switched off is set before the trust', async () => {
    const { calls, openChat, id } = setup()
    fireEvent.click(await screen.findByRole('button', { name: 'Trust Jonas' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Advanced settings' }))
    const list = await screen.findByRole('list', { name: 'Advanced settings' })
    expect(list.textContent).toContain('Anchor')
    expect(list.textContent).toContain('Profile')
    expect(list.textContent).toContain('Group identities')
    expect(list.textContent).not.toContain('Contacts')
    // the anchor is the trust itself: no switch
    expect(screen.getAllByRole('switch')).toHaveLength(2)
    const profile = screen.getByRole('switch', { name: 'Profile' })
    expect(profile).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(profile)
    expect(profile).toHaveAttribute('aria-checked', 'false')
    fireEvent.click(screen.getByRole('button', { name: /^Trust$/ }))
    await waitFor(() => expect(openChat).toHaveBeenCalledTimes(1))
    expect(calls).toEqual(['class profile off', `give ${id}`])
  })
})
