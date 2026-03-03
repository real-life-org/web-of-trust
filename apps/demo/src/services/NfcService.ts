import { Capacitor } from '@capacitor/core'
import { CapacitorNfc } from '@capgo/capacitor-nfc'

export type NfcStatus = 'available' | 'disabled' | 'not-supported' | 'web'

export async function getNfcStatus(): Promise<NfcStatus> {
  if (!Capacitor.isNativePlatform()) {
    return 'web'
  }

  try {
    const { supported } = await CapacitorNfc.isSupported()
    if (!supported) return 'not-supported'

    const { status } = await CapacitorNfc.getStatus()
    if (status === 'NFC_OK') return 'available'
    if (status === 'NFC_DISABLED') return 'disabled'
    return 'not-supported'
  } catch {
    return 'not-supported'
  }
}

export async function openNfcSettings(): Promise<void> {
  if (Capacitor.isNativePlatform()) {
    await CapacitorNfc.showSettings()
  }
}

export async function requestNfcPermission(): Promise<boolean> {
  if (!Capacitor.isNativePlatform()) return false

  try {
    const status = await getNfcStatus()
    if (status !== 'available') return false

    // On iOS, starting a scan triggers the system NFC permission dialog.
    // On Android, NFC permission is granted at install time via manifest.
    if (Capacitor.getPlatform() === 'ios') {
      await CapacitorNfc.startScanning()
      await CapacitorNfc.stopScanning()
    }
    return true
  } catch {
    return false
  }
}
