// Card links the app is opened with (#489, #491, #492), through the whole app: the inbox lives as
// long as the app, the shell session owns the check and the hand-over, the verify page the link.
// The matrix: the link before the unlock, during the check a close or a lock, the preview at once or
// deferred, a second link; every case once as the app runs and once under StrictMode, whose effect
// replay ends and begins the session at once and must lose nothing.
import { act, fireEvent, render, screen } from '@testing-library/react'
import { StrictMode, type ReactElement } from 'react'
import { describe, expect, it } from 'vitest'
import { App } from '../src/app/App'
import type { ActId, CardPreview, Result } from '../src/port'
import { linkTakes } from '../src/hooks'
import type { VerifyState } from '../src/hooks'
import { composeIdentityScenario, composeScenario, HARNESS_PASSPHRASE } from '../harness/boot'
import { iiw, locked } from '../harness/scenarios'

const LINK = 'https://web-of-trust.de/c#1:ZELDAPROBE'
const flush = () => act(async () => new Promise((r) => setTimeout(r, 20)))
const UNLOCKED = { ...locked, identity: { state: 'unlocked' as const, protection: 'passphrase' as const } }

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
      previewCard: async (raw: string): Promise<Result<CardPreview>> => {
        previews.push(raw)
        return { ok: true, value: preview }
      },
    },
  }
  return { ...comp, port, previews }
}

/** the first preview answers only when released; later ones answer at once (the flow's own preview) */
function deferFirstPreview(comp: { port: { trust: { previewCard: (raw: string) => Promise<Result<CardPreview>> } } }) {
  const release: { current: (() => void) | null } = { current: null }
  const preview = comp.port.trust.previewCard
  let first = true
  comp.port.trust.previewCard = (raw: string) => {
    if (!first) return preview(raw)
    first = false
    return new Promise<Result<CardPreview>>((resolve) => {
      release.current = () => void preview(raw).then(resolve)
    })
  }
  return release
}

/** the locked app: password, Unlock, "Not now" for biometrics, the contacts */
async function unlock() {
  fireEvent.change(await screen.findByLabelText('Password'), { target: { value: HARNESS_PASSPHRASE } })
  fireEvent.click(screen.getByRole('button', { name: 'Unlock' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Not now' }))
}

const verifyPage = () => screen.queryByRole('heading', { name: 'Verify in person' })
const zelda = () => screen.queryByText(/Zelda Probe/)

describe('deep links', () => {
  it('linkTakes: the verify page takes a link before anything was captured, not past its own card', () => {
    const base = { run: 1, card: null, mutual: [] }
    expect(linkTakes(null)).toBe(true)
    expect(linkTakes({ ...base, name: 'showing', error: false } as VerifyState)).toBe(true)
    expect(linkTakes({ ...base, name: 'ready', hint: null } as VerifyState)).toBe(true)
    expect(linkTakes({ ...base, name: 'scanning' } as VerifyState)).toBe(false)
    expect(linkTakes({ ...base, name: 'waiting', contactId: 'c1', name2: null, waitLong: false } as unknown as VerifyState)).toBe(false)
  })

  describe.each([
    { mode: 'as the app runs', strict: false },
    { mode: 'under StrictMode', strict: true },
  ])('$mode', ({ strict }) => {
    const mount = (ui: ReactElement) => render(strict ? <StrictMode>{ui}</StrictMode> : ui)

    it('a link that is no card: "This code can\'t be used", the app stays where it is', async () => {
      const comp = composeScenario(iiw)
      mount(<App composition={comp} />)
      await flush()
      act(() => comp.fake.deepLinks.open(LINK))
      await flush()
      expect(await screen.findByText('This code can’t be used.')).toBeInTheDocument()
      expect(verifyPage()).toBeNull()
    })

    it('a cold start with a link: the launch URL is consumed once, the verification opens with the card', async () => {
      const comp = withPreview(composeScenario(iiw))
      comp.fake.deepLinks.launch = LINK
      mount(<App composition={comp} />)
      await flush()
      expect(await screen.findByText(/Zelda Probe/)).toBeInTheDocument()
      expect(comp.fake.deepLinks.launch).toBeNull()
      // the flow's own preview is the last; before it exactly the checks of the sessions that ran
      expect(comp.previews.at(-1)).toBe(LINK)
      expect(comp.previews.length).toBeGreaterThanOrEqual(2)
    })

    it('a card link while the app runs: the verification opens with the card; a second link during it is refused with the message', async () => {
      const comp = withPreview(composeScenario(iiw))
      mount(<App composition={comp} />)
      await flush()
      act(() => comp.fake.deepLinks.open(LINK))
      await flush()
      expect(await screen.findByText(/Zelda Probe/)).toBeInTheDocument()
      act(() => comp.fake.deepLinks.open(LINK))
      await flush()
      expect(await screen.findByText('Finish the current verification first.')).toBeInTheDocument()
    })

    it('#491: a link that opens the locked app waits in the inbox for the unlock, then opens the verification', async () => {
      const comp = withPreview(await composeIdentityScenario(locked))
      mount(<App composition={comp} />)
      await screen.findByLabelText('Password')
      act(() => comp.fake.deepLinks.open(LINK))
      await flush()
      expect(comp.previews).toEqual([])
      await unlock()
      await flush()
      expect(await screen.findByText(/Zelda Probe/)).toBeInTheDocument()
    })

    it('#491: two links during the lock: the first opens the verification, the second is refused with the message', async () => {
      const comp = withPreview(await composeIdentityScenario(locked))
      mount(<App composition={comp} />)
      await screen.findByLabelText('Password')
      act(() => comp.fake.deepLinks.open(LINK))
      act(() => comp.fake.deepLinks.open(LINK + 'B'))
      await unlock()
      await flush()
      expect(await screen.findByText(/Zelda Probe/)).toBeInTheDocument()
      expect(await screen.findByText('Finish the current verification first.')).toBeInTheDocument()
      expect(comp.previews).not.toContain(LINK + 'B')
    })

    it('#492: closing the verification during the check: the late result opens nothing', async () => {
      const comp = withPreview(composeScenario(iiw))
      const release = deferFirstPreview(comp)
      mount(<App composition={{ ...comp, initialNav: { tab: 'contacts', stack: [{ kind: 'verify' }], sheet: null } }} />)
      expect(await screen.findByRole('heading', { name: 'Verify in person' })).toBeInTheDocument()
      await flush()
      act(() => comp.fake.deepLinks.open(LINK))
      await flush()
      expect(release.current).not.toBeNull()
      fireEvent.click(screen.getByRole('button', { name: 'Close' }))
      await flush()
      expect(verifyPage()).toBeNull()
      act(() => release.current!())
      await flush()
      await flush()
      expect(verifyPage()).toBeNull()
      expect(zelda()).toBeNull()
    })

    it('#492: locking during the check: the late result reaches no shell; the link waits in the inbox and opens the verification after the unlock', async () => {
      const comp = withPreview(await composeIdentityScenario(UNLOCKED))
      const release = deferFirstPreview(comp)
      mount(<App composition={comp} />)
      expect(await screen.findByRole('heading', { name: 'Contacts' })).toBeInTheDocument()
      await flush()
      act(() => comp.fake.deepLinks.open(LINK))
      await flush()
      expect(release.current).not.toBeNull()
      await act(async () => {
        await comp.runtime.lock('user')
      })
      expect(await screen.findByLabelText('Password')).toBeInTheDocument()
      act(() => release.current!())
      await flush()
      await flush()
      // nothing of the dead check: still the lock screen
      expect(verifyPage()).toBeNull()
      expect(screen.getByLabelText('Password')).toBeInTheDocument()
      await unlock()
      await flush()
      // the link, back in the inbox, is checked by the new session and handed over with its card
      expect(await screen.findByText(/Zelda Probe/)).toBeInTheDocument()
    })

    it('a link after a lock and unlock in the same app: the new session takes it like the first', async () => {
      const comp = withPreview(await composeIdentityScenario(UNLOCKED))
      mount(<App composition={comp} />)
      expect(await screen.findByRole('heading', { name: 'Contacts' })).toBeInTheDocument()
      await act(async () => {
        await comp.runtime.lock('user')
      })
      await unlock()
      await flush()
      act(() => comp.fake.deepLinks.open(LINK))
      await flush()
      expect(await screen.findByText(/Zelda Probe/)).toBeInTheDocument()
    })
  })
})
