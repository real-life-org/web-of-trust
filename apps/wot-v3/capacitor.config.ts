import type { CapacitorConfig } from '@capacitor/cli'

// Native shell of the v3 app (architecture §8.2, §8.3). One configuration per native target, chosen by
// VITE_TARGET when `cap sync` runs (scripts/build-debug-apk.sh, scripts/build-android.sh); there is no
// default target, as in vite.config.ts.
//
// - play, appstore: no over-the-air update. `includePlugins` names every native plugin and leaves out
//   @capawesome/capacitor-live-update, so its native code is not in the artifact (§8.2 step 3; checked
//   on the APK/AAB by scripts/check-native-artifact.sh).
// - fdroid: with the live-update plugin and a nonzero readyTimeout (a bundle that never reaches
//   LiveUpdate.ready() is rolled back, src/platform/capacitor/live-update.ts).
//
// The web assets come from the target's own build directory (`pnpm build:<target>`).

const NATIVE_TARGETS = ['fdroid', 'play', 'appstore'] as const
type NativeTarget = (typeof NATIVE_TARGETS)[number]

/** every native plugin the app uses, except live update (src/platform/capacitor) */
export const PLUGINS = [
  '@capacitor/app',
  '@capacitor/clipboard',
  '@capacitor/filesystem',
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
const ota = t === 'fdroid'

const config: CapacitorConfig = {
  appId: 'org.reallife.weboftrust',
  appName: 'Web of Trust',
  webDir: `dist-${t}`,
  includePlugins: ota ? [...PLUGINS, LIVE_UPDATE_PLUGIN] : [...PLUGINS],
  plugins: ota ? { LiveUpdate: { appId: 'org.reallife.weboftrust', readyTimeout: 10000 } } : {},
}

export default config
