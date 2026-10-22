// Review 432 round 3: the web camera stops before its first frame, a background that began before the
// app mounted counts, and the prefs of a namespace stay until its notifications are confirmed gone.
import { act, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

const lib = vi.hoisted(() => ({ stopped: 0, clearThrows: true }))
vi.mock('html5-qrcode', () => ({
  Html5Qrcode: class {
    isScanning = false
    constructor(readonly id: string) {}
    async start() {
      // the stream is bound to the element, the first frame has not played yet
      const v = document.createElement('video')
      const track = { stop: () => void lib.stopped++ }
      Object.defineProperty(v, 'srcObject', { configurable: true, writable: true, value: { getTracks: () => [track] } })
      document.getElementById(this.id)?.appendChild(v)
    }
    async stop() {
      throw new Error('Cannot stop, scanner is not running or paused.')
    }
    clear() {
      if (lib.clearThrows) throw new Error('Cannot clear while scan is ongoing')
    }
  },
}))

import { webDeepLinks, webLifecycle, webScanner } from '../../src/platform/web'
import { createInventory } from '../../src/adapters/identity/inventory'
import { fakeDevice, fakeEntropy, fakeIdentityPlatform, virtualClock } from '../../src/platform/fake'
import { App } from '../../src/app/App'
import { secret } from '../../src/port'
import { composeIdentityScenario, HARNESS_PASSPHRASE } from '../../harness/boot'
import { locked } from '../../harness/scenarios'
import { BACKGROUND_LOCK_DEFAULT_MS } from '../../src/platform/ports'
import type { HolderHost } from '../../src/adapters/identity'

describe('review 432 round 3', () => {
  it('an abort before the first frame ends every track of the camera (R3-1)', async () => {
    const target = document.createElement('div')
    document.body.appendChild(target)
    const ctl = new AbortController()
    const p = webScanner().scan({ target, signal: ctl.signal })
    await vi.waitFor(() => expect(target.querySelector('video')).not.toBeNull())
    ctl.abort()
    expect(await p).toEqual({ kind: 'cancelled' })
    await vi.waitFor(() => expect(lib.stopped).toBe(1))
    target.remove()
  })

  it('a background that began before the app mounted counts (R3-2)', async () => {
    const c = await composeIdentityScenario(locked)
    c.fake.lifecycle.emit('background')
    render(<App composition={c} />)
    await screen.findByRole('button', { name: 'Unlock' })
    await act(async () => {
      await c.runtime.unlock.passphrase(secret(HARNESS_PASSPHRASE))
      await c.runtime.unlock.open()
    })
    expect(c.port.stores.identity.get().status).toBe('unlocked')
    await act(async () => {
      c.clock.advance(BACKGROUND_LOCK_DEFAULT_MS)
    })
    expect(c.port.stores.identity.get().status).toBe('locked')
  })

  it('the prefs of a namespace stay while one of its notifications survives (R3-3)', async () => {
    const d = fakeDevice({ wipeSurvivor: 'old:n1' })
    const clock = virtualClock(0, 'UTC')
    const p = fakeIdentityPlatform(d, { clock, entropy: fakeEntropy(1) })
    const host = { forget: () => undefined, databaseNames: () => [] } as unknown as HolderHost
    const inv = createInventory(p, host)
    await p.notifications.notify({ ns: 'old', id: 'n1', title: 't', body: '', route: 'c:x' })
    p.prefs.set('old:notify.ids', '{"n1":1}')
    await inv.wipeNamespace('old')
    expect(p.prefs.keys('old:')).toEqual(['old:notify.ids'])
    expect(await inv.verifyNamespace('old')).toEqual(expect.arrayContaining(['notifications:old', 'prefs:old:notify.ids']))
    // the full delete keeps them too, and reports what is left (R4-2)
    await inv.wipeGlobal('old')
    expect(p.prefs.keys('old:')).toEqual(['old:notify.ids'])
    expect(await inv.verifyAll('old')).toEqual(expect.arrayContaining(['notifications', 'prefs:old:notify.ids']))
  })

  it('a copy the app could not overwrite is a survivor of the delete (R4-4)', async () => {
    const d = fakeDevice()
    const p = fakeIdentityPlatform(d, { clock: virtualClock(0, 'UTC'), entropy: fakeEntropy(2) })
    const inv = createInventory(p, { forget: () => undefined, databaseNames: () => [] } as unknown as HolderHost)
    await p.clipboard.copy('abandon ability able', { sensitive: true })
    d.faults.clipboard = 'fails'
    await inv.wipeGlobal('x')
    expect(await inv.verifyAll('x')).toContain('clipboard')
  })

  it('a card link leaves the address bar when the platform is built, before any back guard (R4-3)', async () => {
    window.history.replaceState(null, '', '/c#eyJjYXJkIjoyfQ')
    const links = webDeepLinks()
    expect(window.location.hash).toBe('')
    const l = webLifecycle()
    l.onBack(() => true)
    expect(window.location.hash).toBe('')
    expect(await links.initial()).toMatch(/\/c#eyJjYXJkIjoyfQ$/)
    window.history.replaceState(null, '', '/')
  })
})
