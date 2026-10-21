// Native platform implementations on Capacitor (architecture §5). The only place in src/ that may
// import @capacitor/* and native plugins (enforced by .dependency-cruiser.cjs and ESLint).
//
// The native shell (android/, ios/) moves in with the cutover PR (architecture §8.3), together with
// the native code of the own plugins (BiometricKeystore, ScreenProtection, AppSettings). Plugins of the
// old app (apps/demo): @capacitor/app, @capacitor/clipboard, @capawesome/capacitor-live-update,
// @real-life-org/capacitor-zxing-scanner. New: @capacitor/share with @capacitor/filesystem,
// @capacitor/local-notifications, capacitor-email-composer.

import { Capacitor, registerPlugin } from '@capacitor/core'
import { Clipboard } from '@capacitor/clipboard'
import type { ClipboardPort, ClockPort, IdentityPlatform, LiveUpdatePort, Platform, ScreenProtectionPort } from '../ports'
import { createWebIdentityPlatform, liveUpdateOff, webClipboard, webClock, webEntropy, webLanguage, webPrefs, webScreenProtection } from '../web'
import { capacitorBiometric } from './biometric'
import { capacitorDeepLinks, capacitorLifecycle } from './lifecycle'
import { capacitorNotifications } from './notifications'
import { capacitorScanner } from './scanner'
import { capacitorMail, capacitorShare, sharedSurvivors, sweepShared } from './share'

export { capacitorBiometric, aliasOf, type BiometricKeystorePlugin } from './biometric'
export { capacitorNotifications, type LocalNotificationsApi } from './notifications'
export { nativeScanFailure } from './scanner'

/** @capacitor/clipboard first (works where the WebView denies navigator.clipboard), then the web API. */
export function capacitorClipboard(clock: ClockPort): ClipboardPort {
  return webClipboard(
    clock,
    async (text) => {
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
    },
    // native reads need no prompt (Android 12+ shows a short system toast)
    async () => {
      try {
        return (await Clipboard.read()).value
      } catch {
        return null
      }
    },
  )
}

/** Native screen protection (architecture §5 table): Android FLAG_SECURE while sensitive, iOS cover
 *  view and screenshot notification. A small plugin next to BiometricKeystore; its native code comes
 *  with the plugin PR. Until it is registered natively, the web cover is used. */
interface ScreenProtectionPlugin {
  setSecure(options: { secure: boolean }): Promise<void>
  /** Android FLAG_SECURE and the iOS cover view whenever the app goes to the background (app switcher) */
  setCoverInBackground(options: { on: boolean }): Promise<void>
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
    coverInBackground(on) {
      fallback.coverInBackground(on)
      void plugin.setCoverInBackground({ on }).catch(() => {})
    },
    onCaptured(cb) {
      const handle = plugin.addListener('screenshotTaken', cb)
      return () => void handle.then((h) => h.remove()).catch(() => {})
    },
  }
}

export function createCapacitorPlatform(opts: { liveUpdate?: LiveUpdatePort; scanInstructions?: () => string } = {}): Platform {
  const prefs = webPrefs()
  return {
    clock: webClock,
    entropy: webEntropy,
    language: webLanguage(prefs),
    prefs,
    clipboard: capacitorClipboard(webClock),
    screen: capacitorScreenProtection(),
    scanner: capacitorScanner(prefs, opts.scanInstructions),
    mail: capacitorMail,
    share: capacitorShare,
    lifecycle: capacitorLifecycle(),
    deepLinks: capacitorDeepLinks(),
    liveUpdate: opts.liveUpdate ?? liveUpdateOff,
  }
}

export function createCapacitorIdentityPlatform(platform: Platform): IdentityPlatform {
  const web = createWebIdentityPlatform({
    clock: platform.clock,
    entropy: platform.entropy,
    prefs: platform.prefs,
    clipboard: platform.clipboard,
    biometric: capacitorBiometric(),
  })
  return {
    ...web,
    notifications: capacitorNotifications(platform.prefs),
    // the session layers of a delete also hold the hand-over folder of shared files (a report text a
    // crash left between writing and removing it)
    session: {
      async wipe() {
        await web.session.wipe()
        await sweepShared()
      },
      survivors: async () => [...(await web.session.survivors()), ...(await sharedSurvivors())],
    },
  }
}
