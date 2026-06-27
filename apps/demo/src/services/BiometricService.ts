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
    // W4 — web-build-safe: no Capacitor plugin on web, so guard like isEnrolled /
    // isAvailable. A no-op on web lets the cross-tier wipe orchestrator call this
    // without the web platform being a throw site (native runtime errors are still
    // tolerated with .catch at the call site).
    if (!this.isSupported()) return
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

  /**
   * Strict enrollment check for SECURITY verification (W5 fail-closed). Unlike
   * isEnrolled() — a UI convenience that swallows native errors to false so the
   * unlock screen degrades safely — this PROPAGATES native errors: a keystore check
   * that fails or cannot be verified must NOT be mistaken for "no enrollment / clean".
   * No-op safe on web (isSupported guard, returns false without a native call).
   */
  static async isEnrolledStrict(): Promise<boolean> {
    if (!this.isSupported()) return false
    const { stored } = await BiometricKeystore.hasStoredPassphrase()
    return stored
  }
}
