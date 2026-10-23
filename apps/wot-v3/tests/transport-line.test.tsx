// The transport line (ui/components/TransportLine.tsx): network, carrier, the queue and what waits for an
// answer, as the connectivity store says; the carriage of one contact in its details. Only what is.
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { LanguageProvider } from '../src/i18n'
import { CarriageLine, TransportLine } from '../src/ui/components'
import type { Connectivity } from '../src/port'

const base: Connectivity = { network: 'online', carrier: 'connected', queued: 0, open: 0, carriage: {}, lastReceiveAt: null, projection: 'current', clock: 'ok' }
const line = (c: Partial<Connectivity>, lang: 'en' | 'de' = 'en') => {
  const { unmount } = render(
    <LanguageProvider lang={lang}>
      <TransportLine connectivity={{ ...base, ...c }} />
    </LanguageProvider>,
  )
  const text = screen.getByRole('status').textContent
  unmount()
  return text
}

describe('transport line', () => {
  it('says the network, the carrier and the queue, nothing more', () => {
    expect(line({})).toBe('Online · Mediator connected')
    expect(line({ network: 'offline', carrier: 'unreachable', queued: 2 })).toBe('Offline · Mediator not reachable · 2 waiting to be sent')
    expect(line({ carrier: 'connecting', open: 1 })).toBe('Online · Connecting to the mediator · 1 sent, no answer yet')
    expect(line({ network: 'unknown', carrier: 'idle' })).toBe('Mediator ready')
    expect(line({ carrier: 'not-configured', queued: 1 })).toBe('Online · No mediator · 1 waiting to be sent')
    expect(line({ network: 'offline', carrier: 'unreachable', queued: 2 }, 'de')).toBe('Offline · Vermittler nicht erreichbar · 2 warten auf den Versand')
  })
  it('the carriage of a contact: routed, fallback, starting, not carried; nothing without an entry', () => {
    const one = (mode: Connectivity['carriage'][string] | undefined) => {
      const { container, unmount } = render(
        <LanguageProvider lang="en">
          <CarriageLine mode={mode} />
        </LanguageProvider>,
      )
      const text = container.textContent
      unmount()
      return text
    }
    expect(one('routed')).toBe('Through the mediator')
    expect(one('egress-session')).toBe('Through the mediator, in its fallback form')
    expect(one('starting')).toBe('Connecting to the mediator')
    expect(one('not-carried')).toBe('Not through the mediator: the card of your encounter named no address for it. Messages stay on this device.')
    expect(one(undefined)).toBe('')
  })
})
