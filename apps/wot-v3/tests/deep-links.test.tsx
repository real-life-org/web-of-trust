// Card links the app is opened with (#489): consumed by the shell once the holder is in use. A link
// that is no card leaves the app where it is with "This code can't be used"; a verification past its
// own card is not interrupted; otherwise the verify page opens and takes the card as the step a camera
// read would take.
import { act, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { App } from '../src/app/App'
import type { ActId, CardPreview } from '../src/port'
import { linkTakes } from '../src/hooks'
import type { VerifyState } from '../src/hooks'
import { composeScenario } from '../harness/boot'
import { iiw } from '../harness/scenarios'

const LINK = 'https://web-of-trust.de/c#1:ZELDAPROBE'
const flush = () => act(async () => new Promise((r) => setTimeout(r, 20)))

/** the sim port with an own card and a card preview that answer (the simulation itself shows neither):
 *  the link is a displayed card of "Zelda Probe" */
function withPreview(comp: ReturnType<typeof composeScenario>) {
  const preview: CardPreview = { role: 'displayed', name: 'Zelda Probe', knownContact: null, self: false }
  const shown = { qr: 'https://web-of-trust.de/c#1:OWNCARD', expiresAt: comp.clock.now() + 600_000, card: null }
  const port = {
    ...comp.port,
    trust: {
      ...comp.port.trust,
      showCard: () => ({ actId: 'show' as ActId, done: Promise.resolve({ ok: true as const, value: shown }), journaled: Promise.resolve(true) }),
      previewCard: async () => ({ ok: true as const, value: preview }),
    },
  }
  return { ...comp, port }
}

describe('deep links (#489)', () => {
  it('linkTakes: the verify page takes a link before anything was captured, not past its own card', () => {
    const base = { run: 1, card: null, mutual: [] }
    expect(linkTakes(null)).toBe(true)
    expect(linkTakes({ ...base, name: 'showing', error: false } as VerifyState)).toBe(true)
    expect(linkTakes({ ...base, name: 'ready', hint: null } as VerifyState)).toBe(true)
    expect(linkTakes({ ...base, name: 'scanning' } as VerifyState)).toBe(false)
    expect(linkTakes({ ...base, name: 'waiting', contactId: 'c1', name2: null, waitLong: false } as unknown as VerifyState)).toBe(false)
  })

  it('a link that is no card: "This code can\'t be used", the app stays where it is (warm start)', async () => {
    const comp = composeScenario(iiw)
    render(<App composition={comp} />)
    await flush()
    act(() => comp.fake.deepLinks.open(LINK))
    await flush()
    expect(await screen.findByText('This code can’t be used.')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Verify in person' })).toBeNull()
  })

  it('a cold start with a link: the launch URL is read once the shell is up', async () => {
    const comp = composeScenario(iiw)
    comp.fake.deepLinks.launch = LINK
    render(<App composition={comp} />)
    await flush()
    expect(await screen.findByText('This code can’t be used.')).toBeInTheDocument()
    expect(comp.fake.deepLinks.launch).toBeNull()
  })

  it('a card link opens the verification with the card as its step; a second link during it is refused with a message', async () => {
    const comp = withPreview(composeScenario(iiw))
    render(<App composition={comp} />)
    await flush()
    act(() => comp.fake.deepLinks.open(LINK))
    await flush()
    // the question the scanner asks, for the person of the link
    expect(await screen.findByText(/Zelda Probe/)).toBeInTheDocument()
    act(() => comp.fake.deepLinks.open(LINK))
    await flush()
    expect(await screen.findByText('Finish the current verification first.')).toBeInTheDocument()
  })
})
