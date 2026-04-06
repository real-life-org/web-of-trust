import { Capacitor } from '@capacitor/core'
import {
  CapacitorBarcodeScanner,
  CapacitorBarcodeScannerTypeHint,
  CapacitorBarcodeScannerAndroidScanningLibrary,
  CapacitorBarcodeScannerCameraDirection,
} from '@capacitor/barcode-scanner'

export function isNativeScannerAvailable(): boolean {
  return Capacitor.isNativePlatform()
}

export type ScanResult =
  | { status: 'ok'; data: string }
  | { status: 'cancelled' }
  | { status: 'permission_denied' }
  | { status: 'error'; message: string }

export async function scanQrCodeNative(scanInstructions: string): Promise<ScanResult> {
  try {
    const result = await CapacitorBarcodeScanner.scanBarcode({
      hint: CapacitorBarcodeScannerTypeHint.QR_CODE,
      cameraDirection: CapacitorBarcodeScannerCameraDirection.BACK,
      scanInstructions,
      scanButton: false,
      android: {
        scanningLibrary: CapacitorBarcodeScannerAndroidScanningLibrary.ZXING,
      },
    })

    if (result.ScanResult) {
      return { status: 'ok', data: result.ScanResult }
    }
    return { status: 'cancelled' }
  } catch (err) {
    if (err instanceof Error) {
      const msg = err.message.toLowerCase()
      if (msg.includes('permission') || msg.includes('denied') || msg.includes('not granted')) {
        return { status: 'permission_denied' }
      }
      if (msg.includes('cancel')) {
        return { status: 'cancelled' }
      }
      console.warn('[BarcodeScannerService]', err.message)
      return { status: 'error', message: err.message }
    }
    return { status: 'error', message: String(err) }
  }
}
