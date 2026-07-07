import { Capacitor } from "@capacitor/core"
import { LiveUpdate } from "@capawesome/capacitor-live-update"

const LAST_UPDATE_KEY = "ota_last_updated_at"

/**
 * Checks for OTA updates on app startup.
 * Only runs on native platforms (iOS/Android), no-op in browser.
 *
 * Channel URLs:
 *   https://web-of-trust.de/updates/ios/latest.json
 *   https://web-of-trust.de/updates/android/latest.json
 *   https://web-of-trust.de/updates/android-foss/latest.json
 */
export async function checkForLiveUpdate(): Promise<void> {
  if (!Capacitor.isNativePlatform()) return

  // #238: hard kill-switch. A downloaded OTA bundle shadows the APK's built-in bundle
  // (Capawesome only reverts to built-in on a versionCode change), so a side-loaded
  // test/debug build must be able to pin itself to its shipped bundle instead of silently
  // fetching the production OTA bundle on first launch. Set VITE_DISABLE_LIVE_UPDATE=true
  // in the build mode (.env.staging-debug) to never fetch/apply an OTA bundle. Prod builds
  // leave it unset → OTA behaves as before.
  if (import.meta.env.VITE_DISABLE_LIVE_UPDATE === 'true') return

  const serverUrl = import.meta.env.VITE_UPDATE_SERVER_URL ?? 'https://web-of-trust.de'

  const channel =
    import.meta.env.VITE_UPDATE_CHANNEL || Capacitor.getPlatform()

  try {
    const response = await fetch(`${serverUrl}/updates/${channel}/latest.json`)
    if (!response.ok) return

    const { bundleId, url } = (await response.json()) as {
      bundleId: string
      url: string
    }

    const { bundleId: currentBundleId } = await LiveUpdate.getCurrentBundle()
    if (currentBundleId === bundleId) return

    await LiveUpdate.downloadBundle({ bundleId, url })
    await LiveUpdate.setNextBundle({ bundleId })
    localStorage.setItem(LAST_UPDATE_KEY, new Date().toISOString())
    await LiveUpdate.reload()
  } catch (err) {
    console.warn("[LiveUpdate] Update check failed:", err)
  }
}

/** Returns the current bundle ID, or null in browser. */
export async function getCurrentBundleId(): Promise<string | null> {
  if (!Capacitor.isNativePlatform()) return null
  try {
    const { bundleId } = await LiveUpdate.getCurrentBundle()
    return bundleId
  } catch {
    return null
  }
}

/** Returns ISO string of when the last OTA update was applied, or null. */
export function getLastUpdatedAt(): string | null {
  return localStorage.getItem(LAST_UPDATE_KEY)
}
