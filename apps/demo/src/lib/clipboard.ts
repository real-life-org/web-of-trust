/**
 * Copy text to the clipboard without ever throwing.
 *
 * `navigator.clipboard.writeText` rejects on some WebViews / contexts (permission
 * denied on old WebViews, non-secure context, missing user gesture, the Android
 * emulator's clipboard bridge). An unhandled rejection would bubble up to the
 * global `unhandledrejection` handler in main.tsx and replace the whole screen
 * with the crash overlay — especially bad on the mnemonic step, where it can cost
 * the user their recovery words. Callers get a boolean and decide the UX (show a
 * "Copied!" state on success, leave it untouched on failure so the user copies by
 * hand). See #235.
 *
 * @returns true if the write succeeded, false otherwise.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}
