import { describe, it, expect, vi, afterEach } from 'vitest'
import { copyToClipboard } from './clipboard'

/**
 * #235 — a rejected clipboard write must never bubble up as an unhandled rejection
 * (which the global handler in main.tsx turns into a full-screen crash overlay,
 * worst of all on the mnemonic step). copyToClipboard resolves to a boolean instead.
 */
describe('copyToClipboard (#235 — never throws)', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it('returns true when the clipboard write succeeds', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    await expect(copyToClipboard('hello')).resolves.toBe(true)
    expect(writeText).toHaveBeenCalledWith('hello')
  })

  it('returns false instead of rejecting when the write is denied (the crash we fixed)', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('Write permission denied'))
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    await expect(copyToClipboard('recovery words')).resolves.toBe(false)
  })

  it('returns false when the Clipboard API is entirely unavailable (old WebView)', async () => {
    vi.stubGlobal('navigator', {})
    await expect(copyToClipboard('x')).resolves.toBe(false)
  })
})
