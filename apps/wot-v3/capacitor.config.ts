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
/** the PEM public key of the OTA signing key (RSA 2048), the same as ota/live-update-public.pem (a
 *  test checks it); inline, because Capacitor loads this file without module imports */
export const LIVE_UPDATE_PUBLIC_KEY = [
  '-----BEGIN PUBLIC KEY-----',
  'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA2Z4h5nO/kpbo+BTCQtrI',
  'InXU8IeEK9HZCvTzGk7X405EC1fr8NV5tzyyUa91XjjmZkI8aedNdyuE2GcB+O5J',
  'xrxXlPr94IWWC8zbSX8Kyo9thWV5WO2Zi6sdKGxfLs9JOpXZ57w5TNoNfLBuVzjP',
  'WsMG07u3VuyYjFPrLakToTGPeAEUYG1iFp98OpPQWfi0zKIWSMYMfmXR/1b9LyvS',
  'dLUkuL0wL6jz3dSQWe5WtkRFbjCS5/rAB9Z4hw5dbfYAjhQT3JLzv8s+hAOZyzOl',
  'ZC6zL3gGfs2lVuukDg0XmomTmFzKanmejGLt4lfz9axUIu4rCf14YJO/3+ZxlcEr',
  'cQIDAQAB',
  '-----END PUBLIC KEY-----',
].join('\n')

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
    LiveUpdate: { appId: 'org.reallife.weboftrust', readyTimeout: 10000, publicKey: LIVE_UPDATE_PUBLIC_KEY },
  },
}

export default config
