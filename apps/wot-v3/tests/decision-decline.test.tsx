// "Decline" on the decision card in the conversation (handshake UX, Anton 29.10., A2): a quiet second
// action beside "Respond", with one sentence that the other person learns nothing. It closes the open
// encounter-confirm through the port (decide 'decline'); it never opens the confirmation sheet, and a
// failure stays visible on the card.
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
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
        <ConversationScreen conversationKey={'c:marcus' as ConversationKey} />
      </AppContextProvider>
    </LanguageProvider>,
  )
}

const done = (r: Result) => ({ actId: 'x' as never, done: Promise.resolve(r) })

describe('decline on the decision card', () => {
  it('a quiet action described by the sentence that Marcus learns nothing; it declines the open confirmation and opens no sheet', async () => {
    const decide = vi.fn(() => done({ ok: true, value: undefined }))
    conversation('en', decide)
    const decline = await screen.findByRole('button', { name: 'Decline' })
    expect(decline).toHaveAccessibleDescription('Marcus will not be told.')
    expect(screen.getByRole('button', { name: 'Respond' })).toBeInTheDocument()
    fireEvent.click(decline)
    await waitFor(() => expect(decide).toHaveBeenCalledWith('p1', 'decline'))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('German: "Ablehnen", "Marcus erfährt davon nichts."', async () => {
    conversation('de', vi.fn(() => done({ ok: true, value: undefined })))
    const decline = await screen.findByRole('button', { name: 'Ablehnen' })
    expect(decline).toHaveAccessibleDescription('Marcus erfährt davon nichts.')
  })

  it('a failed decline says so on the card; the confirmation stays open', async () => {
    conversation('en', vi.fn(() => done({ ok: false, error: { kind: 'infra', code: 'transport', retryable: true } })))
    fireEvent.click(await screen.findByRole('button', { name: 'Decline' }))
    expect(await screen.findByText('Declining did not go through. Please try again.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Decline' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Respond' })).toBeInTheDocument()
  })

  it('while the decline runs, neither action can be taken again', async () => {
    let finish: (r: Result) => void = () => undefined
    const decide = vi.fn(() => ({ actId: 'x' as never, done: new Promise<Result>((r) => (finish = r)) }))
    conversation('en', decide)
    fireEvent.click(await screen.findByRole('button', { name: 'Decline' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Decline' })).toBeDisabled())
    expect(screen.getByRole('button', { name: 'Respond' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Decline' }))
    expect(decide).toHaveBeenCalledTimes(1)
    finish({ ok: true, value: undefined })
  })
})
