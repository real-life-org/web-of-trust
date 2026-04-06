import { Capacitor, registerPlugin } from '@capacitor/core'

interface BiometricKeystorePlugin {
  isAvailable(): Promise<{ available: boolean; biometryType: string }>
  storePassphrase(options: { passphrase: string }): Promise<void>
  unlockPassphrase(): Promise<{ passphrase: string }>
  deletePassphrase(): Promise<void>
  hasStoredPassphrase(): Promise<{ stored: boolean }>
}

const BiometricKeystore = registerPlugin<BiometricKeystorePlugin>('BiometricKeystore')

export class BiometricService {
  static isSupported(): boolean {
    return Capacitor.isNativePlatform()
  }

  static async isAvailable(): Promise<boolean> {
    if (!this.isSupported()) return false
    try {
      const { available } = await BiometricKeystore.isAvailable()
      return available
    } catch {
      return false
    }
  }

  static async enroll(passphrase: string): Promise<void> {
    await BiometricKeystore.storePassphrase({ passphrase })
  }

  static async authenticate(): Promise<string> {
    const { passphrase } = await BiometricKeystore.unlockPassphrase()
    return passphrase
  }

  static async unenroll(): Promise<void> {
    await BiometricKeystore.deletePassphrase()
  }

  static async isEnrolled(): Promise<boolean> {
    if (!this.isSupported()) return false
    try {
      const { stored } = await BiometricKeystore.hasStoredPassphrase()
      return stored
    } catch {
      return false
    }
  }
}
