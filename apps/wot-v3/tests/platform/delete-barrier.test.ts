// Issue #433 and review 432 round 6: a full delete is a barrier for the clipboard lane (copies that
// wait or run when it begins never land unconfirmed after it) and cancels the scheduled notifications
// of every known namespace (architecture N12).
import { describe, expect, it, vi } from 'vitest'

const native = vi.hoisted(() => ({ hold: null as (() => void) | null, holdNext: false, board: '' }))
vi.mock('@capacitor/clipboard', () => ({
  Clipboard: {
    async write({ string }: { string: string }) {
      if (native.holdNext && string !== '') {
        native.holdNext = false
        await new Promise<void>((r) => (native.hold = r))
      }
      native.board = string
    },
    read: async () => ({ value: native.board }),
  },
}))

import { createInventory } from '../../src/adapters/identity/inventory'
import type { HolderHost } from '../../src/adapters/identity'
import { fakeDevice, fakeEntropy, fakeIdentityPlatform, virtualClock } from '../../src/platform/fake'
import { webClipboard } from '../../src/platform/web'
import { capacitorClipboard } from '../../src/platform/capacitor'
import { CLIPBOARD_SETTLE_MS, SENSITIVE_CLIPBOARD_MS, type ClipboardPort, type IdentityPlatform } from '../../src/platform/ports'

const host = { forget: () => undefined, databaseNames: () => [] } as unknown as HolderHost

/** the real web clipboard on a fake device; the first sensitive write waits until released */
function setup(make?: (clock: ReturnType<typeof virtualClock>) => { port: ClipboardPort; board: () => string; held: () => (() => void) | null }) {
  const clock = virtualClock(0, 'UTC')
  const d = fakeDevice()
  const base = fakeIdentityPlatform(d, { clock, entropy: fakeEntropy(7) })
  const state = { board: '', hold: null as (() => void) | null, holdNext: true }
  const web = () => ({
    port: webClipboard(
      clock,
      async (t) => {
        if (state.holdNext && t !== '') {
          state.holdNext = false
          await new Promise<void>((r) => (state.hold = r))
        }
        state.board = t
        return true
      },
      async () => state.board,
    ),
    board: () => state.board,
    held: () => state.hold,
  })
  const c = (make ?? web)(clock)
  const p: IdentityPlatform = { ...base, clipboard: c.port }
  return { clock, d, p, inv: createInventory(p, host), c }
}

/** runs `work` while driving the device clock, as the harness does; never waits real time */
async function driven<T>(clock: ReturnType<typeof virtualClock>, work: Promise<T>): Promise<T> {
  let done = false
  const out = work.finally(() => (done = true))
  await vi.waitFor(() => {
    if (!done) clock.advance(CLIPBOARD_SETTLE_MS)
    expect(done).toBe(true)
  })
  return out
}

describe('#433: a full delete is a barrier for running clipboard copies', () => {
  it('a copy still writing when the delete began never lands after a verified delete (issue 1:1)', async () => {
    const { clock, p, inv, c } = setup()
    const copying = p.clipboard.copy('secret recovery words', { sensitive: true })
    await vi.waitFor(() => expect(c.held()).not.toBeNull())
    await driven(clock, inv.wipeGlobal('x'))
    // the write could not be finished: never a clean verification
    expect(await inv.verifyAll('x')).toContain('clipboard:unverifiable')
    c.held()!()
    await copying
    // the late write is overwritten, confirmed, and only then the delete verifies
    await vi.waitFor(() => expect(p.clipboard.holdsAppCopy()).toBe(false))
    expect(c.board()).toBe('')
    expect(await inv.verifyAll('x')).toEqual([])
  })

  it('a running copy that finishes during the barrier is overwritten before the delete returns', async () => {
    const { p, inv, c } = setup()
    const copying = p.clipboard.copy('secret recovery words', { sensitive: true })
    await vi.waitFor(() => expect(c.held()).not.toBeNull())
    const wiping = inv.wipeGlobal('x')
    await new Promise((r) => setTimeout(r, 0))
    c.held()!()
    await wiping
    expect(await copying).toBe(false)
    expect(c.board()).toBe('')
    expect(await inv.verifyAll('x')).toEqual([])
  })

  it('a copy that waits behind a running one is revoked and never written', async () => {
    const { clock, p, inv, c } = setup()
    const first = p.clipboard.copy('a card')
    const waiting = p.clipboard.copy('secret recovery words', { sensitive: true })
    await vi.waitFor(() => expect(c.held()).not.toBeNull())
    const wiping = driven(clock, inv.wipeGlobal('x'))
    c.held()!()
    await wiping
    expect(await waiting).toBe(false)
    await first
    expect(c.board()).toBe('')
    expect(await inv.verifyAll('x')).toEqual([])
  })

  it('a copy that landed after the barrier keeps its 60 s deadline when the overwrite fails (round 6 R1-1)', async () => {
    const clock = virtualClock(0, 'UTC')
    const s = { board: '', hold: null as (() => void) | null, fail: false }
    const port = webClipboard(
      clock,
      async (t) => {
        if (t !== '' && !s.hold) await new Promise<void>((r) => (s.hold = r))
        // only the overwrite fails, whatever the order of the turns (round 7 R2-2)
        if (s.fail && t === '') return false
        s.board = t
        return true
      },
      async () => s.board,
    )
    const copying = port.copy('WORDS', { sensitive: true })
    await vi.waitFor(() => expect(s.hold).not.toBeNull())
    const clearing = port.clear()
    clock.advance(CLIPBOARD_SETTLE_MS)
    expect(await clearing).toBe(false)
    // the late write lands, the overwrite queued behind it fails
    s.fail = true
    s.hold!()
    await copying
    await new Promise((r) => setTimeout(r, 10))
    expect(s.board).toBe('WORDS')
    s.fail = false
    clock.advance(SENSITIVE_CLIPBOARD_MS)
    await vi.waitFor(() => expect(s.board).toBe(''))
    expect(port.holdsAppCopy()).toBe(false)
  })

  it('a failing read of the known namespaces never skips the clipboard barrier (round 7 R2-1)', async () => {
    const { p, inv, c } = setup()
    p.vault.namespaces = async () => {
      throw new Error('idb gone')
    }
    const copying = p.clipboard.copy('secret recovery words', { sensitive: true })
    await vi.waitFor(() => expect(c.held()).not.toBeNull())
    const wiping = inv.wipeGlobal('x').catch(() => undefined)
    await new Promise((r) => setTimeout(r, 0))
    c.held()!()
    await wiping
    expect(await copying).toBe(false)
    expect(c.board()).toBe('')
  })

  it('holdsAppCopy is true from the start of a sensitive copy', async () => {
    const { p, c } = setup()
    const copying = p.clipboard.copy('secret recovery words', { sensitive: true })
    expect(p.clipboard.holdsAppCopy()).toBe(true)
    await vi.waitFor(() => expect(c.held()).not.toBeNull())
    c.held()!()
    await copying
  })

  it('control: a copy finished before the delete is cleared and the delete verifies', async () => {
    const { p, inv, c } = setup()
    const copying = p.clipboard.copy('secret recovery words', { sensitive: true })
    await vi.waitFor(() => expect(c.held()).not.toBeNull())
    c.held()!()
    await copying
    await inv.wipeGlobal('x')
    expect(c.board()).toBe('')
    expect(await inv.verifyAll('x')).toEqual([])
  })

  it('the Capacitor clipboard follows the same barrier', async () => {
    native.board = ''
    native.hold = null
    native.holdNext = true
    const { clock, p, inv } = setup((clk) => ({ port: capacitorClipboard(clk), board: () => native.board, held: () => native.hold }))
    const copying = p.clipboard.copy('secret recovery words', { sensitive: true })
    await vi.waitFor(() => expect(native.hold).not.toBeNull())
    await driven(clock, inv.wipeGlobal('x'))
    expect(await inv.verifyAll('x')).toContain('clipboard:unverifiable')
    native.hold!()
    await copying
    await vi.waitFor(() => expect(p.clipboard.holdsAppCopy()).toBe(false))
    expect(native.board).toBe('')
    expect(await inv.verifyAll('x')).toEqual([])
  })
})

describe('full delete: scheduled notifications of every known namespace (N12, review 432 CodeRabbit)', () => {
  it('a scheduled notification of an older namespace is cancelled, and the delete verifies', async () => {
    const d = fakeDevice()
    const p = fakeIdentityPlatform(d, { clock: virtualClock(0, 'UTC'), entropy: fakeEntropy(8) })
    const inv = createInventory(p, host)
    d.notifications.set('old:n1', { ns: 'old', state: 'scheduled' })
    d.notifications.set('old:n2', { ns: 'old', state: 'delivered' })
    d.notifications.set('x:n3', { ns: 'x', state: 'scheduled' })
    await inv.wipeGlobal('x')
    expect(d.notifications.size).toBe(0)
    expect(await inv.verifyAll('x')).toEqual([])
  })

  it('a scheduled notification whose namespace cannot be told is cancelled too (round 6 R1-5)', async () => {
    const d = fakeDevice()
    const p = fakeIdentityPlatform(d, { clock: virtualClock(0, 'UTC'), entropy: fakeEntropy(9) })
    const inv = createInventory(p, host)
    d.notifications.set('gen2:7', { ns: null, state: 'scheduled' })
    await inv.wipeGlobal('x')
    expect(d.notifications.size).toBe(0)
    expect(await inv.verifyAll('x')).toEqual([])
  })
})
