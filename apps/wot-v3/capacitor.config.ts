import type { CapacitorConfig } from '@capacitor/cli'

// Native shell of the v3 app (architecture §8.2, §8.3). One configuration per native target, chosen by
// VITE_TARGET when `cap sync` runs (scripts/build-debug-apk.sh, scripts/build-android.sh); there is no
// default target, as in vite.config.ts.
//
// - every target: the live-update plugin (signed web bundles, src/platform/capacitor/live-update.ts)
//   with the public key the plugin verifies every bundle against (ota/live-update-public.pem; the
//   private key is held by the signing service) and a nonzero readyTimeout (a bundle that never
//   reaches LiveUpdate.ready() is rolled back). Checked on the APK/AAB/IPA by
//   scripts/check-native-artifact.sh ota.
// - every target: the keyboard plugin resizes the iOS web view to the space above the keyboard.
//
// The web assets come from the target's own build directory (`pnpm build:<target>`).

const NATIVE_TARGETS = ['fdroid', 'play', 'appstore'] as const
type NativeTarget = (typeof NATIVE_TARGETS)[number]

/** every native plugin the app uses besides live update (src/platform/capacitor) */
export const PLUGINS = [
  '@capacitor/app',
  '@capacitor/clipboard',
  '@capacitor/filesystem',
  '@capacitor/keyboard',
  '@capacitor/local-notifications',
  '@capacitor/share',
  '@real-life-org/capacitor-zxing-scanner',
  'capacitor-email-composer',
] as const
export const LIVE_UPDATE_PLUGIN = '@capawesome/capacitor-live-update'

function target(): NativeTarget {
  const raw = process.env.VITE_TARGET
  if (!raw || !(NATIVE_TARGETS as readonly string[]).includes(raw)) {
    throw new Error(`capacitor.config.ts: VITE_TARGET must be one of ${NATIVE_TARGETS.join(', ')} (got ${raw === undefined ? 'nothing' : JSON.stringify(raw)})`)
  }
  return raw as NativeTarget
}

const t = target()
const config: CapacitorConfig = {
  appId: 'org.reallife.weboftrust',
  appName: 'Web of Trust',
  webDir: `dist-${t}`,
  includePlugins: [...PLUGINS, LIVE_UPDATE_PLUGIN],
  plugins: {
    // iOS: the web view shrinks to the space above the keyboard (otherwise iOS pushes the whole page up
    // and the header of a conversation leaves the screen; Tillmann's device test of #494). The plugin
    // resizes after the keyboard animation, a short delay. Android resizes by itself.
    Keyboard: { resize: 'native' },
    // No publicKey here, on purpose (#526): with one set, the plugin checks only the zip's signature and
    // skips the checksum, so any validly signed zip (the other platform's, an older one) would pass
    // under a valid envelope. Without it the plugin checks the SHA-256 checksum, which the app takes
    // from the envelope it verified against ota/live-update-public.pem (src/platform/capacitor/live-update.ts).
    LiveUpdate: { appId: 'org.reallife.weboftrust', readyTimeout: 10000 },
  },
}

export default config
