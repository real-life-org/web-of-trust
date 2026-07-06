import { Capacitor } from '@capacitor/core'
import { Clipboard } from '@capacitor/clipboard'

/**
 * Copy text to the clipboard, returning whether it actually worked — and never
 * throwing.
 *
 * Two problems this solves (#235):
 *  1. `navigator.clipboard.writeText` is denied on some native WebViews (old
 *     Android WebView, the emulator's clipboard bridge, non-secure contexts). On
 *     native platforms we go through the Capacitor Clipboard plugin first, which
 *     uses Android's native ClipboardManager and works where the web API doesn't.
 *  2. A rejected write must never bubble up as an unhandled rejection — the global
 *     handler in main.tsx turns that into a full-screen crash overlay, worst of
 *     all on the mnemonic step. Every path is caught; callers get a boolean and
 *     show a visible fallback ("copy failed, write it down") on false.
 *
 * @returns true if the write succeeded, false otherwise.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  if (Capacitor.isNativePlatform()) {
    try {
      await Clipboard.write({ string: text })
      return true
    } catch {
      // Fall through to the web API as a last resort.
    }
  }
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}
