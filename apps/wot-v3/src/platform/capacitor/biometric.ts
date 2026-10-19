// BiometricPort over the native `BiometricKeystore` plugin of apps/demo (Java + Swift, same plugin
// name so v3 can remove the Gen-2 entry). The interface is copied from apps/demo
// `services/BiometricService.ts`; the native code moves with the cutover PR (architecture §8.3).
//
// v3 extends the interface by an optional `alias` per call (`wot_v3_<ns>`, architecture §4.2
// "Wiederherstellen": one entry per identity namespace, so a new entry never overwrites the access
// to the old vault before the switch) and the prompt texts (the legacy plugin hard-codes German).
// Without `alias` the plugin uses its legacy alias `wot_biometric_key`. The native side of both
// extensions is part of the plugin PR; until then only the legacy alias exists natively.

import { registerPlugin } from '@capacitor/core'
import type { BiometricKind, BiometricPort } from '../ports'

interface PromptOptions {
  alias?: string
  title?: string
  subtitle?: string
  cancel?: string
}

export interface BiometricKeystorePlugin {
  isAvailable(): Promise<{ available: boolean; biometryType: string }>
  storePassphrase(options: { passphrase: string } & PromptOptions): Promise<void>
  unlockPassphrase(options?: PromptOptions): Promise<{ passphrase: string }>
  deletePassphrase(options?: { alias?: string }): Promise<void>
  hasStoredPassphrase(options?: { alias?: string }): Promise<{ stored: boolean }>
}

export const aliasOf = (ns: string) => `wot_v3_${ns}`

function kindOf(type: string): BiometricKind {
  if (type === 'face') return 'face'
  if (type === 'optic') return 'iris'
  // Android reports only "available" (BIOMETRIC_STRONG | DEVICE_CREDENTIAL); touch is iOS Touch ID
  return 'fingerprint'
}

function codeOf(e: unknown): string {
  return typeof e === 'object' && e !== null && 'code' in e ? String((e as { code: unknown }).code) : ''
}

function encode(secret: Uint8Array): string {
  let bin = ''
  for (const b of secret) bin += String.fromCharCode(b)
  return btoa(bin)
}

function decode(text: string): Uint8Array {
  const bin = atob(text)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export function capacitorBiometric(
  plugin: BiometricKeystorePlugin = registerPlugin<BiometricKeystorePlugin>('BiometricKeystore'),
): BiometricPort {
  return {
    async availability() {
      try {
        const { available, biometryType } = await plugin.isAvailable()
        if (available) return { kind: 'available', type: kindOf(biometryType) }
        return biometryType === 'not_enrolled' ? { kind: 'not-enrolled' } : { kind: 'unavailable' }
      } catch {
        return { kind: 'unavailable' }
      }
    },
    // strict: native errors propagate (legacy isEnrolledStrict, W5)
    hasEntry: async (ns) => (await plugin.hasStoredPassphrase({ alias: aliasOf(ns) })).stored,
    async store(ns, secret, prompt) {
      try {
        await plugin.storePassphrase({ passphrase: encode(secret), alias: aliasOf(ns), ...prompt })
        return { ok: true }
      } catch (e) {
        return { ok: false, code: codeOf(e) === 'USER_CANCELLED' ? 'cancelled' : 'failed' }
      }
    },
    async retrieve(ns, prompt) {
      try {
        const { passphrase } = await plugin.unlockPassphrase({ alias: aliasOf(ns), ...prompt })
        return { ok: true, secret: decode(passphrase) }
      } catch (e) {
        // iOS reports errSecAuthFailed as USER_CANCELLED (legacy 6bf034dd); the unlock flow therefore
        // never relies on the code alone and offers the passphrase after any failure.
        const code = codeOf(e)
        if (code === 'USER_CANCELLED') return { ok: false, code: 'cancelled' }
        if (code === 'KEY_INVALIDATED') return { ok: false, code: 'invalidated' }
        if (code === 'KEY_NOT_FOUND') return { ok: false, code: 'missing' }
        return { ok: false, code: 'failed' }
      }
    },
    async remove(ns) {
      try {
        await plugin.deletePassphrase({ alias: aliasOf(ns) })
        return { ok: !(await plugin.hasStoredPassphrase({ alias: aliasOf(ns) })).stored }
      } catch {
        return { ok: false }
      }
    },
    hasLegacy: async () => (await plugin.hasStoredPassphrase()).stored,
    async removeLegacy() {
      try {
        await plugin.deletePassphrase()
        return { ok: !(await plugin.hasStoredPassphrase()).stored }
      } catch {
        return { ok: false }
      }
    },
  }
}
