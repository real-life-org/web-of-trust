// Card links the app is opened with (#489): consumed by the shell once the holder is in use. A link
// that is no card leaves the app where it is with "This code can't be used"; a verification past its
// own card is not interrupted; otherwise the verify page opens and takes the card as the step a camera
// read would take.
import { act, fireEvent, render, screen } from '@testing-library/react'
import { StrictMode } from 'react'
import { describe, expect, it } from 'vitest'
import { App } from '../src/app/App'
import type { ActId, CardPreview } from '../src/port'
import { linkTakes } from '../src/hooks'
import type { VerifyState } from '../src/hooks'
import { composeIdentityScenario, composeScenario, HARNESS_PASSPHRASE } from '../harness/boot'
import { iiw, locked } from '../harness/scenarios'

const LINK = 'https://web-of-trust.de/c#1:ZELDAPROBE'
const flush = () => act(async () => new Promise((r) => setTimeout(r, 20)))

/** the sim port with an own card and a card preview that answer (the simulation itself shows neither):
 *  the link is a displayed card of "Zelda Probe"; `previews` counts the preview calls */
function withPreview<C extends ReturnType<typeof composeScenario> | Awaited<ReturnType<typeof composeIdentityScenario>>>(comp: C) {
  const preview: CardPreview = { role: 'displayed', name: 'Zelda Probe', knownContact: null, self: false }
  const shown = { qr: 'https://web-of-trust.de/c#1:OWNCARD', expiresAt: comp.clock.now() + 600_000, card: null }
  const previews: string[] = []
  const port = {
    ...comp.port,
    trust: {
      ...comp.port.trust,
      showCard: () => ({ actId: 'show' as ActId, done: Promise.resolve({ ok: true as const, value: shown }), journaled: Promise.resolve(true) }),
      previewCard: async (raw: string) => {
        previews.push(raw)
        return { ok: true as const, value: preview }
      },
    },
  }
  return { ...comp, port, previews }
}

/** the locked app: password, Unlock, "Not now" for biometrics, the contacts */
async function unlock() {
  fireEvent.change(await screen.findByLabelText('Password'), { target: { value: HARNESS_PASSPHRASE } })
  fireEvent.click(screen.getByRole('button', { name: 'Unlock' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Not now' }))
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

  it('#491: a link that opens the locked app waits for the unlock, then opens the verification', async () => {
    const comp = withPreview(await composeIdentityScenario(locked))
    render(<App composition={comp} />)
    await screen.findByLabelText('Password')
    act(() => comp.fake.deepLinks.open(LINK))
    await flush()
    // nothing while locked: no preview, no toast
    expect(comp.previews).toEqual([])
    await unlock()
    await flush()
    expect(await screen.findByText(/Zelda Probe/)).toBeInTheDocument()
    // the shell's check, then the flow's own preview: the one link, nothing lost, nothing doubled
    expect(comp.previews).toEqual([LINK, LINK])
  })

  it('#491: two links during the lock: the first opens the verification, the second is refused with the message', async () => {
    const comp = withPreview(await composeIdentityScenario(locked))
    render(<App composition={comp} />)
    await screen.findByLabelText('Password')
    act(() => comp.fake.deepLinks.open(LINK))
    act(() => comp.fake.deepLinks.open(LINK + 'B'))
    await unlock()
    await flush()
    expect(await screen.findByText(/Zelda Probe/)).toBeInTheDocument()
    expect(await screen.findByText('Finish the current verification first.')).toBeInTheDocument()
    // the second link is never previewed
    expect(comp.previews).toEqual([LINK, LINK])
  })

  it('StrictMode replays the effects: the launch URL is consumed once, not lost', async () => {
    const comp = withPreview(composeScenario(iiw))
    comp.fake.deepLinks.launch = LINK
    render(
      <StrictMode>
        <App composition={comp} />
      </StrictMode>,
    )
    await flush()
    expect(await screen.findByText(/Zelda Probe/)).toBeInTheDocument()
    expect(comp.previews).toEqual([LINK, LINK])
  })

  it('#492: closing the verification during the link check: the late result opens nothing', async () => {
    const comp = withPreview(composeScenario(iiw))
    // the first preview answers only when told; the flow's own preview later answers at once
    let release: (() => void) | null = null
    const preview = comp.port.trust.previewCard
    let first = true
    comp.port.trust.previewCard = (raw: string) => {
      if (!first) return preview(raw)
      first = false
      return new Promise((resolve) => {
        release = () => void preview(raw).then(resolve)
      })
    }
    render(<App composition={{ ...comp, initialNav: { tab: 'contacts', stack: [{ kind: 'verify' }], sheet: null } }} />)
    expect(await screen.findByRole('heading', { name: 'Verify in person' })).toBeInTheDocument()
    await flush()
    act(() => comp.fake.deepLinks.open(LINK))
    await flush()
    expect(release).not.toBeNull()
    // closed while the check is in flight
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    await flush()
    expect(screen.queryByRole('heading', { name: 'Verify in person' })).toBeNull()
    act(() => release!())
    await flush()
    await flush()
    expect(screen.queryByRole('heading', { name: 'Verify in person' })).toBeNull()
    expect(screen.queryByText(/Zelda Probe/)).toBeNull()
  })
})
