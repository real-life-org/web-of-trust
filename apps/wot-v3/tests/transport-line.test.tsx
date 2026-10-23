// The transport line (ui/components/TransportLine.tsx): network, carrier, the queue and what waits for an
// answer, as the connectivity store says; only the queue is a live region. The carriage of one contact
// in its details, with the actual reason when it is not carried. Only what is.
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { LanguageProvider } from '../src/i18n'
import { CarriageLine, TransportLine } from '../src/ui/components'
import type { Connectivity } from '../src/port'

const base: Connectivity = { network: 'online', carrier: 'connected', queued: 0, open: 0, carriage: {}, lastReceiveAt: null, projection: 'current', clock: 'ok' }
const line = (c: Partial<Connectivity>, lang: 'en' | 'de' = 'en') => {
  const { container, unmount } = render(
    <LanguageProvider lang={lang}>
      <TransportLine connectivity={{ ...base, ...c }} />
    </LanguageProvider>,
  )
  const text = container.textContent
  const live = screen.getByRole('status').textContent
  unmount()
  return [text, live]
}

describe('transport line', () => {
  it('says the network, the carrier and the queue, nothing more; only the queue is read out', () => {
    expect(line({})).toEqual(['Online · Mediator connected', ''])
    expect(line({ network: 'offline', carrier: 'unreachable', queued: 2 })).toEqual(['Offline · Mediator not reachable · 2 waiting to be sent', '2 waiting to be sent'])
    expect(line({ carrier: 'connecting', open: 1, queued: 3 })).toEqual(['Online · Connecting to the mediator · 3 waiting to be sent · 1 sent, no answer yet', '3 waiting to be sent · 1 sent, no answer yet'])
    expect(line({ network: 'unknown', carrier: 'idle' })).toEqual(['Mediator set up', ''])
    expect(line({ carrier: 'not-configured', queued: 1 })[0]).toBe('Online · No mediator · 1 waiting to be sent')
    expect(line({ network: 'offline', carrier: 'unreachable', queued: 2 }, 'de')[0]).toBe('Offline · Vermittler nicht erreichbar · 2 warten auf den Versand')
  })
  it('the carriage of a contact names the actual reason when it is not carried', () => {
    const one = (mode: Connectivity['carriage'][string] | undefined, notConfigured = false) => {
      const { container, unmount } = render(
        <LanguageProvider lang="en">
          <CarriageLine mode={mode} notConfigured={notConfigured} />
        </LanguageProvider>,
      )
      const text = container.textContent
      unmount()
      return text
    }
    expect(one('routed')).toBe('Through the mediator')
    expect(one('egress-session')).toBe('Through the mediator, in its fallback form')
    expect(one('starting')).toBe('Connecting to the mediator')
    expect(one('no-hint')).toBe('Not through the mediator: the card of your encounter named no address for it. Messages stay on this device.')
    expect(one('hint-unreadable')).toBe('Not through the mediator: the card of your encounter named no address this app can use. Messages stay on this device.')
    expect(one('ack-state-refused')).toBe('Not through the mediator: its delivery state on this device could not be read. Messages stay on this device.')
    expect(one('not-carried')).toBe('Not carried. Messages stay on this device.')
    expect(one(undefined, true)).toBe('Not carried: this app has no mediator. Messages stay on this device.')
    expect(one(undefined)).toBe('')
  })
})
