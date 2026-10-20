// Native platform implementations on Capacitor (architecture §5). The only place in src/ that may
// import @capacitor/* and native plugins (enforced by .dependency-cruiser.cjs and ESLint).
//
// The native shell (android/, ios/) moves in with the cutover PR (architecture §8.3), together with
// the native code of the plugins. Taken over from apps/demo so far: biometrics (plugin interface,
// extended by an alias per namespace), clipboard. New: screen protection (plugin interface only).
// Still to come: scanner (stub until the platform step), lifecycle, live update, notifications, share, language.

import { Capacitor, registerPlugin } from '@capacitor/core'
import { Clipboard } from '@capacitor/clipboard'
import type { ClipboardPort, ClockPort, Platform, ScreenProtectionPort } from '../ports'
import { createWebIdentityPlatform, webClipboard, webClock, webEntropy, webLanguage, webPrefs, webScannerUnavailable, webScreenProtection } from '../web'
import { capacitorBiometric } from './biometric'

export { capacitorBiometric, aliasOf, type BiometricKeystorePlugin } from './biometric'

/** @capacitor/clipboard first (works where the WebView denies navigator.clipboard), then the web API. */
export function capacitorClipboard(clock: ClockPort): ClipboardPort {
  return webClipboard(clock, async (text) => {
    try {
      await Clipboard.write({ string: text })
      return true
    } catch {
      try {
        await navigator.clipboard.writeText(text)
        return true
      } catch {
        return false
      }
    }
  })
}

/** Native screen protection (architecture §5 table): Android FLAG_SECURE while sensitive, iOS cover
 *  view and screenshot notification. A small plugin next to BiometricKeystore; its native code comes
 *  with the plugin PR. Until it is registered natively, the web cover is used. */
interface ScreenProtectionPlugin {
  setSecure(options: { secure: boolean }): Promise<void>
  addListener(event: 'screenshotTaken', cb: () => void): Promise<{ remove: () => Promise<void> }>
}

export function capacitorScreenProtection(): ScreenProtectionPort {
  const fallback = webScreenProtection()
  if (!Capacitor.isPluginAvailable('ScreenProtection')) return fallback
  const plugin = registerPlugin<ScreenProtectionPlugin>('ScreenProtection')
  return {
    set(level) {
      fallback.set(level)
      void plugin.setSecure({ secure: level === 'sensitive' }).catch(() => {})
    },
    onCaptured(cb) {
      const handle = plugin.addListener('screenshotTaken', cb)
      return () => void handle.then((h) => h.remove()).catch(() => {})
    },
  }
}

export function createCapacitorPlatform(): Platform {
  const prefs = webPrefs()
  return {
    clock: webClock,
    entropy: webEntropy,
    language: webLanguage(prefs),
    prefs,
    clipboard: capacitorClipboard(webClock),
    screen: capacitorScreenProtection(),
    // native ZXing scanner (@real-life-org/capacitor-zxing-scanner) joins with the platform step
    scanner: webScannerUnavailable,
  }
}

export function createCapacitorIdentityPlatform(platform: Platform) {
  return createWebIdentityPlatform({
    clock: platform.clock,
    entropy: platform.entropy,
    prefs: platform.prefs,
    clipboard: platform.clipboard,
    biometric: capacitorBiometric(),
  })
}
