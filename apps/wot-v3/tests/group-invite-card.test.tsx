// An invitation into a group on its card in the conversation with the inviter (Anton 22.11.): accept or
// decline on the card itself. Both go through the port's decide; declining tells the inviter nothing,
// and a failure stays visible on the card.
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { createNavStore } from '../src/app/nav'
import { AppContextProvider } from '../src/hooks'
import { LanguageProvider } from '../src/i18n'
import { composeScenario } from '../harness/boot'
import { iiw } from '../harness/scenarios'
import { ConversationScreen } from '../src/screens/chat/ConversationScreen'
import type { AppPort, ConversationKey, Result } from '../src/port'

function conversation(lang: 'en' | 'de', decide: AppPort['trust']['decide']) {
  const comp = composeScenario(iiw)
  const port: AppPort = { ...comp.port, trust: { ...comp.port.trust, decide } }
  return render(
    <LanguageProvider lang={lang}>
      <AppContextProvider value={{ port, platform: comp.platform, nav: createNavStore() }}>
        <ConversationScreen conversationKey={'c:priya' as ConversationKey} />
      </AppContextProvider>
    </LanguageProvider>,
  )
}

const done = (r: Result) => ({ actId: 'x' as never, done: Promise.resolve(r) })
/** the invitation's card: the element that holds the group's name and both actions */
const card = async () => {
  const title = await screen.findByText('Key Recovery WG')
  const el = title.parentElement
  if (!el) throw new Error('no card')
  return within(el)
}

describe('an invitation into a group on its card', () => {
  it('Accept answers the invitation with accept and opens no sheet', async () => {
    const decide = vi.fn(() => done({ ok: true, value: undefined }))
    conversation('en', decide)
    const c = await card()
    expect(c.getByText('Priya Raman invites you')).toBeInTheDocument()
    fireEvent.click(c.getByRole('button', { name: 'Accept' }))
    await waitFor(() => expect(decide).toHaveBeenCalledWith('p3', 'accept'))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('Decline answers with decline, described by the sentence that the inviter is not told', async () => {
    const decide = vi.fn(() => done({ ok: true, value: undefined }))
    conversation('en', decide)
    const decline = (await card()).getByRole('button', { name: 'Decline' })
    expect(decline).toHaveAccessibleDescription('If you decline, Priya is not told.')
    fireEvent.click(decline)
    await waitFor(() => expect(decide).toHaveBeenCalledWith('p3', 'decline'))
  })

  it('German: "Annehmen", "Ablehnen", "Wenn du ablehnst, erfährt Priya davon nichts."', async () => {
    conversation('de', vi.fn(() => done({ ok: true, value: undefined })))
    const c = await card()
    expect(c.getByRole('button', { name: 'Annehmen' })).toBeInTheDocument()
    expect(c.getByRole('button', { name: 'Ablehnen' })).toHaveAccessibleDescription('Wenn du ablehnst, erfährt Priya davon nichts.')
    expect(c.getByText('Priya Raman lädt dich ein')).toBeInTheDocument()
  })

  it('a failed answer says so on the card, and both actions can be taken again', async () => {
    conversation('en', vi.fn(() => done({ ok: false, error: { kind: 'infra', code: 'transport', retryable: true } })))
    const c = await card()
    fireEvent.click(c.getByRole('button', { name: 'Accept' }))
    expect(await c.findByText('That did not go through. Please try again.')).toBeInTheDocument()
    expect(c.getByRole('button', { name: 'Accept' })).toBeEnabled()
    expect(c.getByRole('button', { name: 'Decline' })).toBeEnabled()
  })

  it('while an answer runs, neither action can be taken again', async () => {
    let finish: (r: Result) => void = () => undefined
    const decide = vi.fn(() => ({ actId: 'x' as never, done: new Promise<Result>((r) => (finish = r)) }))
    conversation('en', decide)
    const c = await card()
    fireEvent.click(c.getByRole('button', { name: 'Accept' }))
    await waitFor(() => expect(c.getByRole('button', { name: 'Accept' })).toBeDisabled())
    expect(c.getByRole('button', { name: 'Decline' })).toBeDisabled()
    fireEvent.click(c.getByRole('button', { name: 'Decline' }))
    expect(decide).toHaveBeenCalledTimes(1)
    finish({ ok: true, value: undefined })
  })
})
