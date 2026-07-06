import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'

// Mock the two Capacitor modules the helper imports so the test runs in jsdom.
vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: vi.fn(() => false) },
}))
vi.mock('@capacitor/clipboard', () => ({
  Clipboard: { write: vi.fn() },
}))

import { copyToClipboard } from './clipboard'
import { Capacitor } from '@capacitor/core'
import { Clipboard } from '@capacitor/clipboard'

const isNative = Capacitor.isNativePlatform as unknown as ReturnType<typeof vi.fn>
const nativeWrite = Clipboard.write as unknown as ReturnType<typeof vi.fn>

/**
 * #235 — copyToClipboard must (a) actually copy on native WebViews via the
 * Capacitor plugin (where navigator.clipboard is denied), and (b) never throw:
 * a rejected write would bubble to the global unhandledrejection handler in
 * main.tsx and become a full-screen crash overlay, worst on the mnemonic step.
 */
describe('copyToClipboard (#235 — native + web, never throws)', () => {
  beforeEach(() => {
    isNative.mockReturnValue(false)
    nativeWrite.mockReset()
  })
  afterEach(() => { vi.unstubAllGlobals() })

  it('web: returns true when navigator.clipboard succeeds', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    await expect(copyToClipboard('hello')).resolves.toBe(true)
    expect(writeText).toHaveBeenCalledWith('hello')
  })

  it('web: returns false instead of rejecting when the write is denied (the crash we fixed)', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('Write permission denied'))
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    await expect(copyToClipboard('recovery words')).resolves.toBe(false)
  })

  it('web: returns false when the Clipboard API is entirely unavailable (old WebView)', async () => {
    vi.stubGlobal('navigator', {})
    await expect(copyToClipboard('x')).resolves.toBe(false)
  })

  it('native: uses the Capacitor Clipboard plugin and returns true', async () => {
    isNative.mockReturnValue(true)
    nativeWrite.mockResolvedValue(undefined)
    await expect(copyToClipboard('hello')).resolves.toBe(true)
    expect(nativeWrite).toHaveBeenCalledWith({ string: 'hello' })
  })

  it('native: falls back to the web API when the native plugin throws, still never rejecting', async () => {
    isNative.mockReturnValue(true)
    nativeWrite.mockRejectedValue(new Error('plugin unavailable'))
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    await expect(copyToClipboard('x')).resolves.toBe(true)
    expect(writeText).toHaveBeenCalledWith('x')
  })

  it('native: returns false when both native and web fail', async () => {
    isNative.mockReturnValue(true)
    nativeWrite.mockRejectedValue(new Error('no native'))
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockRejectedValue(new Error('no web')) } })
    await expect(copyToClipboard('x')).resolves.toBe(false)
  })
})
