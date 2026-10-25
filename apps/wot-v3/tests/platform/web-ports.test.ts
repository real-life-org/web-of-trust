// Web implementations of the platform ports (architecture §5): scanner (html5-qrcode behind a seam),
// clipboard (sensitive copies overwritten after 60 s only while they are still there), screen cover,
// back over the history, deep links that leave no fragment behind, storage space.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SENSITIVE_CLIPBOARD_MS } from '../../src/platform/ports'
import { virtualClock } from '../../src/platform/fake'
import { fakeClipboard, fakeDevice } from '../../src/platform/fake'
import { backHandlers, isCardLink, scanFailure, storageSpace, webClipboard, webDeepLinks, webLifecycle, webScanner, webScreenProtection, type QrEngine } from '../../src/platform/web'

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
  await new Promise((r) => setTimeout(r, 0))
}

describe('ScannerPort web (html5-qrcode)', () => {
  function engine(start: (onText: (t: string) => void) => Promise<void>) {
    const calls = { stop: 0, ids: [] as string[] }
    const factory = async (id: string): Promise<QrEngine> => {
      calls.ids.push(id)
      return { start, stop: async () => void calls.stop++ }
    }
    return { factory, calls }
  }

  it('renders into the target and resolves with the text; the camera is released', async () => {
    const { factory, calls } = engine(async (onText) => void setTimeout(() => onText('https://web-of-trust.de/c#card'), 0))
    const target = document.createElement('div')
    const r = await webScanner(factory).scan({ target, signal: new AbortController().signal })
    expect(r).toEqual({ kind: 'ok', text: 'https://web-of-trust.de/c#card' })
    expect(target.id).toMatch(/^wot-scan-/)
    expect(calls.ids).toEqual([target.id])
    expect(calls.stop).toBe(1)
  })

  it('an abort resolves cancelled and releases the camera, also when the camera was still starting', async () => {
    let started!: () => void
    const { factory, calls } = engine(() => new Promise<void>((r) => (started = r)))
    const ctl = new AbortController()
    const p = webScanner(factory).scan({ target: document.createElement('div'), signal: ctl.signal })
    await flush()
    ctl.abort()
    expect(await p).toEqual({ kind: 'cancelled' })
    expect(calls.stop).toBe(0)
    started()
    await flush()
    expect(calls.stop).toBe(1)
  })

  it('maps camera failures to the port classes, never a raw exception', async () => {
    const cases: [unknown, unknown][] = [
      [new DOMException('Permission denied', 'NotAllowedError'), { kind: 'permission-denied' }],
      [new DOMException('Requested device not found', 'NotFoundError'), { kind: 'error', message: 'camera-unavailable' }],
      [new DOMException('Could not start video source', 'NotReadableError'), { kind: 'error', message: 'camera-busy' }],
      ['NotAllowedError: Permission dismissed', { kind: 'permission-denied' }],
      [new Error('something odd'), { kind: 'error', message: 'camera-failed' }],
    ]
    for (const [e, want] of cases) {
      expect(scanFailure(e)).toEqual(want)
      const { factory } = engine(() => Promise.reject(e))
      expect(await webScanner(factory).scan({ target: document.createElement('div'), signal: new AbortController().signal })).toEqual(want)
    }
  })

  it('an abort while the library is still loading ends the scan; the late engine never starts (review 432 R1-4)', async () => {
    let arrive!: (e: QrEngine) => void
    const started = vi.fn(async () => undefined)
    const ctl = new AbortController()
    const p = webScanner(() => new Promise<QrEngine>((r) => (arrive = r))).scan({ target: document.createElement('div'), signal: ctl.signal })
    await flush()
    ctl.abort()
    expect(await p).toEqual({ kind: 'cancelled' })
    arrive({ start: started, stop: async () => undefined })
    await flush()
    expect(started).not.toHaveBeenCalled()
  })

  it('without a target or with a library that does not load: an error result', async () => {
    const { factory } = engine(async () => undefined)
    expect(await webScanner(factory).scan({ target: null, signal: new AbortController().signal })).toEqual({ kind: 'error', message: 'scanner-no-target' })
    const broken = async (): Promise<QrEngine> => {
      throw new Error('chunk failed')
    }
    expect(await webScanner(broken).scan({ target: document.createElement('div'), signal: new AbortController().signal })).toEqual({ kind: 'error', message: 'scanner-load-failed' })
  })

  it('availability: no mediaDevices is unsupported, no video input is no-camera', async () => {
    const md = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices')
    try {
      Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: undefined })
      expect(await webScanner().availability()).toBe('unsupported')
      Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: () => undefined, enumerateDevices: async () => [{ kind: 'audioinput' }] } })
      expect(await webScanner().availability()).toBe('no-camera')
      Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: () => undefined, enumerateDevices: async () => [{ kind: 'videoinput' }] } })
      expect(await webScanner().availability()).toBe('available')
    } finally {
      if (md) Object.defineProperty(navigator, 'mediaDevices', md)
      else delete (navigator as { mediaDevices?: unknown }).mediaDevices
    }
  })
})

describe('ClipboardPort: sensitive copies (§5.3)', () => {
  /** a clipboard whose `board` another app may overwrite; `read` 'board' reads it, 'unknown' cannot */
  function setup(read: 'board' | 'unknown') {
    const clock = virtualClock(0, 'UTC')
    const state = { board: '', writes: [] as string[] }
    const port = webClipboard(
      clock,
      async (t) => {
        state.board = t
        state.writes.push(t)
        return true
      },
      async () => (read === 'board' ? state.board : null),
    )
    return { clock, port, state }
  }

  it('overwrites a sensitive copy after 60 s while the clipboard still holds it', async () => {
    const { clock, port, state } = setup('board')
    await port.copy('abandon ability able', { sensitive: true })
    clock.advance(SENSITIVE_CLIPBOARD_MS - 1)
    await flush()
    expect(state.writes).toEqual(['abandon ability able'])
    clock.advance(1)
    // the timer path awaits a real SHA-256 (thread pool in Node): wait for its outcome, not for turns
    await vi.waitFor(() => expect(port.holdsAppCopy()).toBe(false))
    expect(state.writes).toEqual(['abandon ability able', ''])
  })

  it('leaves what another app copied meanwhile, and no longer claims the copy', async () => {
    const { clock, port, state } = setup('board')
    await port.copy('abandon ability able', { sensitive: true })
    expect(port.holdsAppCopy()).toBe(true)
    state.board = 'from another app'
    clock.advance(SENSITIVE_CLIPBOARD_MS)
    // ownership goes only after the digest comparison ran
    await vi.waitFor(() => expect(port.holdsAppCopy()).toBe(false))
    expect(state.writes).toEqual(['abandon ability able'])
    expect(state.board).toBe('from another app')
  })

  it('overwrites when the platform cannot tell what the clipboard holds (web without read permission)', async () => {
    const { clock, port, state } = setup('unknown')
    await port.copy('abandon ability able', { sensitive: true })
    clock.advance(SENSITIVE_CLIPBOARD_MS)
    await vi.waitFor(() => expect(state.writes.at(-1)).toBe(''))
    expect(port.holdsAppCopy()).toBe(false)
  })

  it('a later copy cancels the timer of an earlier one; a plain copy is never overwritten', async () => {
    const { clock, port, state } = setup('board')
    await port.copy('abandon ability able', { sensitive: true })
    await port.copy('a card')
    clock.advance(SENSITIVE_CLIPBOARD_MS * 2)
    await flush()
    expect(state.writes).toEqual(['abandon ability able', 'a card'])
    expect(port.holdsAppCopy()).toBe(true)
  })

  it('a failed later copy keeps the earlier sensitive copy, its ownership and its deadline (review 432 R1-1)', async () => {
    const clock = virtualClock(0, 'UTC')
    let fail = false
    const state = { board: '', writes: [] as string[] }
    const port = webClipboard(
      clock,
      async (t) => {
        if (fail) return false
        state.board = t
        state.writes.push(t)
        return true
      },
      async () => state.board,
    )
    await port.copy('abandon ability able', { sensitive: true })
    fail = true
    expect(await port.copy('a card')).toBe(false)
    expect(port.holdsAppCopy()).toBe(true)
    fail = false
    clock.advance(SENSITIVE_CLIPBOARD_MS)
    await vi.waitFor(() => expect(port.holdsAppCopy()).toBe(false))
    expect(state.board).toBe('')
  })

  it('a sensitive copy still computing its digest never lands after a later plain copy (review 432 CodeRabbit)', async () => {
    const { clock, port, state } = setup('board')
    const a = port.copy('abandon ability able', { sensitive: true })
    const b = port.copy('a card')
    await Promise.all([a, b])
    expect(state.writes).toEqual(['abandon ability able', 'a card'])
    expect(state.board).toBe('a card')
    clock.advance(SENSITIVE_CLIPBOARD_MS)
    await flush()
    expect(state.writes).toEqual(['abandon ability able', 'a card'])
  })

  it('a deadline that waited behind a running copy never clears that newer copy (review 432 R2-1)', async () => {
    const clock = virtualClock(0, 'UTC')
    const state = { board: '', writes: [] as string[] }
    let hold: (() => void) | null = null
    const port = webClipboard(
      clock,
      async (t) => {
        if (t === 'a card') await new Promise<void>((r) => (hold = r))
        state.board = t
        state.writes.push(t)
        return true
      },
      async () => state.board,
    )
    await port.copy('abandon ability able', { sensitive: true })
    const b = port.copy('a card')
    await flush()
    clock.advance(SENSITIVE_CLIPBOARD_MS)
    await vi.waitFor(() => expect(hold).not.toBeNull())
    await new Promise((r) => setTimeout(r, 20))
    hold!()
    await b
    await new Promise((r) => setTimeout(r, 50))
    expect(state.board).toBe('a card')
    expect(port.holdsAppCopy()).toBe(true)
  })

  it('the execCommand fallback never leaves the text in the DOM, also when it throws (review 432 R5-1)', async () => {
    const write = vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('denied'))
    const exec = vi.fn(() => {
      throw new Error('blocked')
    })
    const had = (document as { execCommand?: unknown }).execCommand
    ;(document as unknown as { execCommand: unknown }).execCommand = exec
    try {
      const port = webClipboard(virtualClock(0, 'UTC'), undefined, async () => null)
      expect(await port.copy('abandon ability able', { sensitive: true })).toBe(false)
      expect(document.querySelector('textarea')).toBeNull()
    } finally {
      ;(document as unknown as { execCommand: unknown }).execCommand = had
      write.mockRestore()
    }
  })

  it('a write that fails reports false and never throws', async () => {
    const port = webClipboard(virtualClock(0, 'UTC'), async () => false, async () => null)
    expect(await port.copy('x', { sensitive: true })).toBe(false)
    expect(port.holdsAppCopy()).toBe(false)
  })

  it('the fake device follows the same rule', async () => {
    const clock = virtualClock(0, 'UTC')
    const d = fakeDevice()
    const port = fakeClipboard(d, clock)
    await port.copy('words', { sensitive: true })
    clock.advance(SENSITIVE_CLIPBOARD_MS)
    await flush()
    expect(d.clipboard).toEqual({ text: '', byApp: false })
    await port.copy('words', { sensitive: true })
    d.clipboard.text = 'another app'
    clock.advance(SENSITIVE_CLIPBOARD_MS)
    await flush()
    expect(d.clipboard).toEqual({ text: 'another app', byApp: false })
  })
})

describe('ScreenProtectionPort web cover', () => {
  afterEach(() => {
    for (const el of document.querySelectorAll('[data-screen-cover]')) el.remove()
  })
  const hide = (state: 'hidden' | 'visible') => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state })
    document.dispatchEvent(new Event('visibilitychange'))
  }
  const covered = () => document.querySelectorAll('[data-screen-cover]').length

  it('an open identity is covered when the page is hidden, not on a mere blur', () => {
    const screen = webScreenProtection()
    screen.coverInBackground(true)
    window.dispatchEvent(new Event('blur'))
    expect(covered()).toBe(0)
    hide('hidden')
    expect(covered()).toBe(1)
    hide('visible')
    expect(covered()).toBe(0)
    screen.coverInBackground(false)
    hide('hidden')
    expect(covered()).toBe(0)
    hide('visible')
  })

  it('an identity that opens while the page is hidden is covered at once (review 432 R1-6)', () => {
    const screen = webScreenProtection()
    hide('hidden')
    expect(covered()).toBe(0)
    screen.coverInBackground(true)
    expect(covered()).toBe(1)
    hide('visible')
    screen.coverInBackground(false)
  })

  it('sensitive content that appears on a hidden page is covered at once (review 432 R5-2)', () => {
    const screen = webScreenProtection()
    hide('hidden')
    screen.set('sensitive')
    expect(covered()).toBe(1)
    hide('visible')
    screen.set('normal')
  })

  it('sensitive content is covered on blur as well', () => {
    const screen = webScreenProtection()
    screen.set('sensitive')
    window.dispatchEvent(new Event('blur'))
    expect(covered()).toBe(1)
    window.dispatchEvent(new Event('focus'))
    expect(covered()).toBe(0)
    screen.set('normal')
  })
})

describe('LifecyclePort web back', () => {
  it('handlers newest first; one that throws counts as handled', () => {
    const h = backHandlers()
    const seen: string[] = []
    h.add(() => (seen.push('a'), false))
    const offB = h.add(() => (seen.push('b'), true))
    expect(h.dispatch()).toBe(true)
    expect(seen).toEqual(['b'])
    offB()
    expect(h.dispatch()).toBe(false)
    h.add(() => {
      throw new Error('x')
    })
    expect(h.dispatch()).toBe(true)
  })

  it('a handled popstate pushes the guard entry again; an unhandled one lets the browser go', () => {
    const push = vi.spyOn(window.history, 'pushState')
    const l = webLifecycle()
    let take = true
    l.onBack(() => take)
    expect(push).toHaveBeenCalledTimes(1)
    window.dispatchEvent(new PopStateEvent('popstate'))
    expect(push).toHaveBeenCalledTimes(2)
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => undefined)
    take = false
    window.dispatchEvent(new PopStateEvent('popstate'))
    expect(push).toHaveBeenCalledTimes(2)
    // nobody took it: one more step back, past the page's own entry (review 432 R2-6)
    expect(back).toHaveBeenCalledTimes(1)
    window.dispatchEvent(new PopStateEvent('popstate'))
    expect(back).toHaveBeenCalledTimes(1)
    // once more unhandled, and this time the step back produces no popstate here; the page shows
    // again: back works as before (CodeRabbit)
    take = false
    window.dispatchEvent(new PopStateEvent('popstate'))
    expect(back).toHaveBeenCalledTimes(2)
    window.dispatchEvent(new Event('pageshow'))
    take = true
    window.dispatchEvent(new PopStateEvent('popstate'))
    expect(push).toHaveBeenCalledTimes(3)
    push.mockRestore()
    back.mockRestore()
  })
})

describe('DeepLinkPort web (§5.3)', () => {
  it('takes a card link once and removes the fragment from the address bar', async () => {
    window.history.replaceState(null, '', '/c#eyJjYXJkIjoxfQ')
    const links = webDeepLinks()
    expect(await links.initial()).toMatch(/\/c#eyJjYXJkIjoxfQ$/)
    expect(window.location.hash).toBe('')
    expect(await links.initial()).toBeNull()
    window.history.replaceState(null, '', '/')
  })

  it('takes a card link of the compact form `#1:<BASE32>` the same way', async () => {
    window.history.replaceState(null, '', '/c#1:PMRGG2LSMQRDUMT5')
    const links = webDeepLinks()
    expect(await links.initial()).toMatch(/\/c#1:PMRGG2LSMQRDUMT5$/)
    expect(window.location.hash).toBe('')
    window.history.replaceState(null, '', '/')
  })

  it('only `/c#…` is a deep link of the app', () => {
    expect(isCardLink('https://web-of-trust.de/c#abc')).toBe(true)
    // the compact form of card-link.ts: `#<version>:<BASE32>`
    expect(isCardLink('https://web-of-trust.de/c#1:ABCDEFGH234567')).toBe(true)
    expect(isCardLink('https://web-of-trust.de/c')).toBe(false)
    expect(isCardLink('https://web-of-trust.de/x#abc')).toBe(false)
    expect(isCardLink('not a url')).toBe(false)
  })
})

describe('StorageGuardPort.space', () => {
  it('low below 50 MB or 5 % free, unknown when the platform cannot say', async () => {
    const est = (quota: number | undefined, usage: number | undefined) => ({ estimate: async () => ({ quota, usage }) }) as unknown as StorageManager
    expect(await storageSpace(est(10e9, 1e9))).toBe('ok')
    expect(await storageSpace(est(10e9, 10e9 - 40e6))).toBe('low')
    expect(await storageSpace(est(100e6, 96e6))).toBe('low')
    expect(await storageSpace(est(undefined, 1))).toBe('unknown')
    expect(await storageSpace(undefined)).toBe('unknown')
    expect(await storageSpace({ estimate: () => Promise.reject(new Error('blocked')) } as unknown as StorageManager)).toBe('unknown')
  })
})
