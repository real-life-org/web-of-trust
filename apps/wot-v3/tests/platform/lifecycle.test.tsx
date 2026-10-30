// The app on the device (architecture §5 "Automatisches Sperren und Verdecken", §4.1 back): background
// lock after the delay through the coordinator's lock, the cover while an identity is open, and the
// system back through flow and navigation, never out of the app in the middle of a flow.
import { act, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { App } from '../../src/app/App'
import { backDispatcher, backgroundLockDelay } from '../../src/hooks'
import { BACKGROUND_LOCK_DEFAULT_MS, BACKGROUND_LOCK_PREF } from '../../src/platform/ports'
import { fakeLifecycle } from '../../src/platform/fake'
import { secret } from '../../src/port'
import { composeIdentityScenario, composeScenario, HARNESS_PASSPHRASE } from '../../harness/boot'
import { iiw, locked } from '../../harness/scenarios'

async function unlockedApp(prefs: Record<string, string> = {}) {
  const c = await composeIdentityScenario(locked)
  for (const [k, v] of Object.entries(prefs)) c.platform.prefs.set(k, v)
  expect((await c.runtime.unlock.passphrase(secret(HARNESS_PASSPHRASE))).ok).toBe(true)
  expect((await c.runtime.unlock.open()).ok).toBe(true)
  render(<App composition={c} />)
  await screen.findByRole('heading', { name: 'Contacts' })
  return c
}

const status = (c: Awaited<ReturnType<typeof unlockedApp>>) => c.port.stores.identity.get().status

describe('background lock (§5, §9 question 8)', () => {
  it('reads the delay from prefs; default 5 minutes, invalid values fall back', () => {
    const prefs = (v: string | null) => ({ get: (k: string) => (k === BACKGROUND_LOCK_PREF ? v : null) })
    expect(BACKGROUND_LOCK_DEFAULT_MS).toBe(300_000)
    expect(backgroundLockDelay(prefs(null))).toBe(300_000)
    expect(backgroundLockDelay(prefs('60000'))).toBe(60_000)
    expect(backgroundLockDelay(prefs('0'))).toBe(0)
    expect(backgroundLockDelay(prefs('-1'))).toBe(300_000)
    expect(backgroundLockDelay(prefs('soon'))).toBe(300_000)
    expect(backgroundLockDelay(prefs(''))).toBe(300_000)
  })

  it('locks through lock(background-timeout) once the background lasted the delay, and says so', async () => {
    const c = await unlockedApp()
    await act(async () => {
      c.fake.lifecycle.emit('background')
      c.clock.advance(BACKGROUND_LOCK_DEFAULT_MS - 1)
    })
    expect(status(c)).toBe('unlocked')
    await act(async () => {
      c.clock.advance(1)
    })
    await screen.findByText('Locked because the app was in the background.')
    expect(status(c)).toBe('locked')
    // the notice goes with the next unlock
    await act(async () => {
      c.fake.lifecycle.emit('active')
      await c.runtime.unlock.passphrase(secret(HARNESS_PASSPHRASE))
      await c.runtime.unlock.open()
    })
    expect(status(c)).toBe('unlocked')
    expect(screen.queryByText('Locked because the app was in the background.')).toBeNull()
  })

  it('a return before the delay keeps the identity open and cancels the timer', async () => {
    const c = await unlockedApp()
    await act(async () => {
      c.fake.lifecycle.emit('background')
      c.clock.advance(60_000)
      c.fake.lifecycle.emit('active')
      c.clock.advance(BACKGROUND_LOCK_DEFAULT_MS)
    })
    expect(status(c)).toBe('unlocked')
  })

  it('a process the system paused locks on return by the elapsed device time', async () => {
    const c = await unlockedApp({ [BACKGROUND_LOCK_PREF]: '60000' })
    await act(async () => {
      c.fake.lifecycle.emit('background')
    })
    // a paused process runs no timer: the device time moves on without the clock firing anything
    const now = c.clock.now
    const resumed = now() + 61_000
    c.clock.now = () => resumed
    try {
      await act(async () => {
        c.fake.lifecycle.emit('active')
      })
    } finally {
      c.clock.now = now
    }
    await screen.findByText('Locked because the app was in the background.')
    expect(status(c)).toBe('locked')
  })

  it('an unlock that finishes in the background is locked by the same deadline (review 432 R1-6)', async () => {
    const c = await composeIdentityScenario(locked)
    render(<App composition={c} />)
    await act(async () => {
      c.fake.lifecycle.emit('background')
      await c.runtime.unlock.passphrase(secret(HARNESS_PASSPHRASE))
      await c.runtime.unlock.open()
    })
    expect(status(c as never)).toBe('unlocked')
    await act(async () => {
      c.clock.advance(BACKGROUND_LOCK_DEFAULT_MS)
    })
    expect(status(c as never)).toBe('locked')
  })

  it('a lock during the protection change ends it and shows the unlock (review 432 R1-8)', async () => {
    const c = await unlockedApp()
    await act(async () => {
      screen.getAllByRole('button', { name: 'Profile' })[0]!.click()
    })
    const change = await screen.findByRole('button', { name: /^Protection/ })
    await act(async () => change.click())
    // a page in the shell's column (the open app keeps its sidebar): a region of its main
    await screen.findByRole('region', { name: 'Protection' })
    await act(async () => {
      await c.runtime.lock('user')
    })
    await screen.findByRole('button', { name: 'Unlock' })
  })

  it('covers the app-switcher image exactly while an identity is open', async () => {
    const c = await unlockedApp()
    expect(c.fake.screen.covers.at(-1)).toBe(true)
    await act(async () => {
      await c.runtime.lock('user')
    })
    expect(c.fake.screen.covers.at(-1)).toBe(false)
  })

  it('hands the cover its words from the app language (E2: the platform has no texts)', async () => {
    const c = await unlockedApp()
    expect(c.fake.screen.words).toEqual({
      name: 'Web of Trust',
      sensitive: 'Your words stay covered while the app is in the background.',
      background: 'The app is in the background.',
    })
  })
})

describe('system back (§4.1)', () => {
  it('ranks flows over the navigation, newest first; a back nobody takes leaves the app', () => {
    const l = fakeLifecycle()
    const d = backDispatcher(l)
    const calls: string[] = []
    const offNav = d.add('nav', () => (calls.push('nav'), false))
    const offFlow = d.add('flow', () => (calls.push('flow'), true))
    expect(l.back()).toBe(true)
    expect(calls).toEqual(['flow'])
    offFlow()
    expect(l.back()).toBe(false)
    expect(calls).toEqual(['flow', 'nav'])
    expect(l.exits).toBe(1)
    offNav()
    // nothing registered: the dispatcher let go of the platform
    expect(l.back()).toBe(false)
    expect(l.exits).toBe(2)
  })

  it('navigation: back closes the conversation, then goes to contacts, then leaves the app', async () => {
    const c = composeScenario(iiw)
    render(<App composition={{ ...c, initialNav: { tab: 'groups', stack: [{ kind: 'chat', key: 'c:marcus' }], sheet: null } }} />)
    await screen.findByRole('button', { name: /Details/ })
    let handled = false
    act(() => {
      handled = c.fake.lifecycle.back()
    })
    expect(handled).toBe(true)
    await waitFor(() => expect(screen.queryByRole('button', { name: /Details/ })).toBeNull())
    act(() => {
      handled = c.fake.lifecycle.back()
    })
    expect(handled).toBe(true)
    await screen.findByRole('heading', { name: 'Contacts' })
    act(() => {
      handled = c.fake.lifecycle.back()
    })
    expect(handled).toBe(false)
    expect(c.fake.lifecycle.exits).toBe(1)
  })

  it('at the unlock entry back leaves the app (review 432 R2-7)', async () => {
    const c = await composeIdentityScenario(locked)
    render(<App composition={c} />)
    await screen.findByRole('button', { name: 'Unlock' })
    let handled = true
    act(() => {
      handled = c.fake.lifecycle.back()
    })
    expect(handled).toBe(false)
    expect(c.fake.lifecycle.exits).toBe(1)
  })

  it('in the verify flow back is the flow’s back, never past it', async () => {
    const c = composeScenario(iiw)
    render(<App composition={{ ...c, initialNav: { tab: 'contacts', stack: [{ kind: 'verify' }], sheet: null } }} />)
    await screen.findByRole('region', { name: 'Verify in person' })
    let handled = false
    act(() => {
      handled = c.fake.lifecycle.back()
    })
    // the flow took it and closed itself; the app is still open on the contacts
    expect(handled).toBe(true)
    expect(c.fake.lifecycle.exits).toBe(0)
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Verify in person' })).toBeNull())
  })
})
