// Native QR scanner (architecture §5 table): @real-life-org/capacitor-zxing-scanner, the plugin of the
// old app (ZXing on Android, no Play Services, F-Droid), full screen. Never throws.
//
// The plugin has no permission query and no cancel: the permission is remembered from the last scan
// (prefs `camera.permission`; unknown → 'prompt', so the app explains before the system asks), and an
// aborted scan resolves `cancelled` at once while a late result of the native screen is dropped.

import { Capacitor, registerPlugin } from '@capacitor/core'
import {
  CapacitorBarcodeScanner,
  CapacitorBarcodeScannerAndroidScanningLibrary,
  CapacitorBarcodeScannerCameraDirection,
  CapacitorBarcodeScannerTypeHint,
} from '@real-life-org/capacitor-zxing-scanner'
import type { PrefsPort, ScannerPort } from '../ports'

type ScanResult = Awaited<ReturnType<ScannerPort['scan']>>
const PERMISSION_PREF = 'camera.permission'

/** The native scanner's errors as port results (legacy BarcodeScannerService.ts). */
export function nativeScanFailure(e: unknown): ScanResult {
  const msg = (e instanceof Error ? e.message : String(e)).toLowerCase()
  if (msg.includes('permission') || msg.includes('denied') || msg.includes('not granted')) return { kind: 'permission-denied' }
  if (msg.includes('cancel')) return { kind: 'cancelled' }
  if (msg.includes('camera') && (msg.includes('unavailable') || msg.includes('no camera') || msg.includes('not available'))) return { kind: 'error', message: 'camera-unavailable' }
  return { kind: 'error', message: 'camera-failed' }
}

/** A small own plugin next to BiometricKeystore (native code with the cutover PR): the app's page in the
 *  system settings. Until it is registered, iOS uses `app-settings:`, Android cannot open it. */
interface AppSettingsPlugin {
  open(): Promise<void>
}

export async function openAppSettings(): Promise<void> {
  try {
    if (Capacitor.isPluginAvailable('AppSettings')) {
      await registerPlugin<AppSettingsPlugin>('AppSettings').open()
      return
    }
    if (Capacitor.getPlatform() === 'ios') window.location.href = 'app-settings:'
  } catch {
    // nothing to open: the screen keeps its hint where to look
  }
}

export function capacitorScanner(prefs: PrefsPort, instructions: () => string = () => ''): ScannerPort {
  return {
    availability: async () => (Capacitor.isNativePlatform() ? 'available' : 'unsupported'),
    async permission() {
      // only a grant is remembered: a denial would never be asked again (the flow does not scan after
      // 'denied'), also after the person allowed the camera in the settings; unknown → 'prompt', and the
      // scan itself reports a denial
      return prefs.get(PERMISSION_PREF) === 'granted' ? 'granted' : 'prompt'
    },
    async scan({ signal }) {
      if (signal.aborted) return { kind: 'cancelled' }
      const aborted = new Promise<ScanResult>((resolve) => signal.addEventListener('abort', () => resolve({ kind: 'cancelled' }), { once: true }))
      const scanned = (async (): Promise<ScanResult> => {
        // the plugin has no cancel: an aborted scan's native screen stays until the person closes it,
        // and its late result changes nothing (not even the remembered permission)
        try {
          const r = await CapacitorBarcodeScanner.scanBarcode({
            hint: CapacitorBarcodeScannerTypeHint.QR_CODE,
            cameraDirection: CapacitorBarcodeScannerCameraDirection.BACK,
            scanInstructions: instructions(),
            scanButton: false,
            android: { scanningLibrary: CapacitorBarcodeScannerAndroidScanningLibrary.ZXING },
          })
          if (!signal.aborted) prefs.set(PERMISSION_PREF, 'granted')
          return r.ScanResult ? { kind: 'ok', text: r.ScanResult } : { kind: 'cancelled' }
        } catch (e) {
          const out = nativeScanFailure(e)
          if (out.kind === 'permission-denied' && !signal.aborted) prefs.remove(PERMISSION_PREF)
          return out
        }
      })()
      return await Promise.race([scanned, aborted])
    },
    openSettings: () => openAppSettings(),
  }
}
