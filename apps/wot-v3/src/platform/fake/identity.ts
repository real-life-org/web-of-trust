// Fake identity platform for Vitest and the harness (architecture §5 "Fake / Test"): in-memory
// keystore, vault, databases, notifications and legacy data with fault switches (§3.2
// FaultSwitches: biometric, storage, crypto, clipboard, legacyGen2, wipeSurvivor). The backing
// state lives in `FakeDevice` and outlives a runtime, so tests can "restart the process" over it.

import { createSeedVault, memoryVaultBackend, type MemoryVaultBackend } from '../seed-vault'
import { SENSITIVE_CLIPBOARD_MS } from '../ports'
import type {
  BiometricKind,
  BiometricPort,
  ClipboardPort,
  ClockPort,
  DatabasesPort,
  EntropyPort,
  IdentityPlatform,
  LegacyGen2Port,
  NotificationPort,
  PrefsPort,
  ScreenProtectionPort,
  SessionLayersPort,
  StorageGuardPort,
} from '../ports'

export interface IdentityFaults {
  /** availability and behaviour of the keystore prompt */
  biometric: 'ok' | 'cancel' | 'fail' | 'invalidated' | 'unavailable' | 'not-enrolled'
  storage: 'ok' | 'blocked'
  crypto: 'ok' | 'unavailable'
  clipboard: 'ok' | 'fails'
  /** free space for the databases (StorageGuardPort.space); 'low' is the harness switch "storage full" */
  space: 'ok' | 'low'
  /** a layer name that survives every delete (database, vault namespace, keystore, prefs, notification) */
  wipeSurvivor: string | null
}

/** The persistent part of a simulated device: survives a runtime restart. */
export interface FakeDevice {
  readonly vault: MemoryVaultBackend
  readonly keystore: Map<string, Uint8Array>
  /** entries made invalid by new biometric enrolment (Android KeyPermanentlyInvalidatedException) */
  readonly invalidated: Set<string>
  readonly databases: Set<string>
  readonly prefs: Map<string, string>
  readonly notifications: Map<string, { ns: string | null; state: 'scheduled' | 'delivered' }>
  readonly legacy: { databases: Set<string>; localStorage: Set<string>; keystore: boolean }
  readonly session: Set<string>
  readonly clipboard: { text: string | null; byApp: boolean }
  readonly faults: IdentityFaults
  biometricKind: BiometricKind
  /** names of every operation, in order (inspection, no secrets) */
  readonly log: string[]
}

export function fakeDevice(faults: Partial<IdentityFaults> = {}): FakeDevice {
  return {
    vault: memoryVaultBackend(),
    keystore: new Map(),
    invalidated: new Set(),
    databases: new Set(),
    prefs: new Map(),
    notifications: new Map(),
    legacy: { databases: new Set(), localStorage: new Set(), keystore: false },
    session: new Set(),
    clipboard: { text: null, byApp: false },
    faults: { biometric: 'ok', storage: 'ok', crypto: 'ok', clipboard: 'ok', space: 'ok', wipeSurvivor: null, ...faults },
    biometricKind: 'fingerprint',
    log: [],
  }
}

/** Gen-2 data as an old install leaves it (names from apps/demo durableStoreWipe.ts). */
export function seedLegacyGen2(device: FakeDevice): void {
  for (const n of ['wot-identity', 'wot-personal-doc', 'web-of-trust', 'wot-doc-log:did:key:z6MkOld']) device.legacy.databases.add(n)
  device.legacy.localStorage.add('wot-active-did')
  device.legacy.localStorage.add('wot-device-id:did:key:z6MkOld')
  device.legacy.keystore = true
}

const survives = (d: FakeDevice, name: string) => d.faults.wipeSurvivor !== null && name.includes(d.faults.wipeSurvivor)

export function fakeBiometric(d: FakeDevice): BiometricPort {
  return {
    async availability() {
      if (d.faults.biometric === 'unavailable') return { kind: 'unavailable' }
      if (d.faults.biometric === 'not-enrolled') return { kind: 'not-enrolled' }
      return { kind: 'available', type: d.biometricKind }
    },
    async hasEntry(ns) {
      return d.keystore.has(ns)
    },
    async store(ns, secret) {
      d.log.push(`ks.store:${ns}`)
      if (d.faults.biometric === 'cancel') return { ok: false, code: 'cancelled' }
      if (d.faults.biometric === 'fail' || d.faults.biometric === 'unavailable') return { ok: false, code: 'failed' }
      d.keystore.set(ns, secret.slice())
      d.invalidated.delete(ns)
      return { ok: true }
    },
    async retrieve(ns) {
      d.log.push(`ks.retrieve:${ns}`)
      if (d.faults.biometric === 'cancel') return { ok: false, code: 'cancelled' }
      if (d.faults.biometric === 'fail' || d.faults.biometric === 'unavailable') return { ok: false, code: 'failed' }
      if (d.faults.biometric === 'invalidated' || d.invalidated.has(ns)) return { ok: false, code: 'invalidated' }
      const s = d.keystore.get(ns)
      return s ? { ok: true, secret: s.slice() } : { ok: false, code: 'missing' }
    },
    async remove(ns) {
      d.log.push(`ks.remove:${ns}`)
      if (survives(d, `keystore:${ns}`)) return { ok: false }
      d.keystore.delete(ns)
      d.invalidated.delete(ns)
      return { ok: true }
    },
    hasLegacy: async () => d.legacy.keystore,
    async removeLegacy() {
      d.log.push('ks.removeLegacy')
      if (survives(d, 'keystore:wot_biometric_key')) return { ok: false }
      d.legacy.keystore = false
      return { ok: true }
    },
  }
}

export function fakeDatabases(d: FakeDevice): DatabasesPort {
  return {
    list: async () => [...d.databases, ...d.legacy.databases].sort(),
    exists: async (name) => d.databases.has(name) || d.legacy.databases.has(name),
    async remove(name) {
      d.log.push(`db.remove:${name}`)
      if (survives(d, name)) return false
      d.databases.delete(name)
      return true
    },
  }
}

export function fakeNotifications(d: FakeDevice): NotificationPort {
  const remaining = (ns: string | 'all') =>
    [...d.notifications].filter(([, n]) => ns === 'all' || n.ns === ns).map(([id]) => id)
  const drop = (ns: string | 'all', state: 'scheduled' | 'delivered') => {
    for (const [id, n] of [...d.notifications]) {
      if ((ns === 'all' || n.ns === ns) && n.state === state && !survives(d, id)) d.notifications.delete(id)
    }
  }
  return {
    permission: async () => 'granted',
    request: async () => 'granted',
    async notify(n) {
      d.notifications.set(`${n.ns}:${n.id}`, { ns: n.ns, state: 'delivered' })
    },
    onOpen: () => () => {},
    list: async () => [...d.notifications].map(([id, n]) => ({ id, ns: n.ns, state: n.state })),
    async cancelNamespace(ns) {
      drop(ns, 'scheduled')
      const left = remaining(ns).filter((id) => d.notifications.get(id)?.state === 'scheduled')
      return { ok: left.length === 0, remaining: left }
    },
    async removeDelivered(ns) {
      drop(ns, 'delivered')
      const left = remaining(ns).filter((id) => d.notifications.get(id)?.state === 'delivered')
      return { ok: left.length === 0, remaining: left }
    },
    // like the native port: a notification without a namespace never verifies as gone (review 432 R5-3)
    verifyNone: async (ns) => remaining(ns).length === 0 && (ns === 'all' || [...d.notifications.values()].every((n) => n.ns !== null)),
  }
}

export function fakeLegacy(d: FakeDevice): LegacyGen2Port {
  return {
    detect: async () => d.legacy.databases.size > 0 || d.legacy.localStorage.size > 0,
    async wipe() {
      d.log.push('legacy.wipe')
      for (const n of [...d.legacy.databases]) if (!survives(d, n)) d.legacy.databases.delete(n)
      for (const n of [...d.legacy.localStorage]) if (!survives(d, n)) d.legacy.localStorage.delete(n)
    },
    survivors: async () => [
      ...[...d.legacy.databases].map((n) => `indexeddb:${n}`),
      ...[...d.legacy.localStorage].map((n) => `localStorage:${n}`),
    ],
  }
}

export function fakeSessionLayers(d: FakeDevice): SessionLayersPort {
  return {
    async wipe() {
      for (const n of [...d.session]) if (!survives(d, n)) d.session.delete(n)
    },
    survivors: async () => [...d.session],
  }
}

export function fakeStorageGuard(d: FakeDevice): StorageGuardPort {
  return {
    probe: async () => d.faults.storage,
    cryptoMissing: () => (d.faults.crypto === 'unavailable' ? ['crypto.subtle'] : []),
    space: async () => d.faults.space,
  }
}

export function fakeDevicePrefs(d: FakeDevice): PrefsPort {
  return {
    get: (k) => d.prefs.get(k) ?? null,
    set: (k, v) => void d.prefs.set(k, v),
    remove: (k) => {
      if (!survives(d, `prefs:${k}`)) d.prefs.delete(k)
    },
    keys: (prefix = '') => [...d.prefs.keys()].filter((k) => k.startsWith(prefix)),
    wipe: () => {
      for (const k of [...d.prefs.keys()]) if (!survives(d, `prefs:${k}`)) d.prefs.delete(k)
    },
  }
}

/** The clipboard of the simulated device. With a clock, a sensitive copy is overwritten after
 *  SENSITIVE_CLIPBOARD_MS if the clipboard still holds it (another app's copy: `d.clipboard.text` set
 *  from outside with `byApp` false). */
export function fakeClipboard(d: FakeDevice, clock?: ClockPort): ClipboardPort {
  let cancel: (() => void) | null = null
  const port: ClipboardPort = {
    async copy(text, opts) {
      if (d.faults.clipboard === 'fails') return false
      cancel?.()
      cancel = null
      d.clipboard.text = text
      d.clipboard.byApp = true
      d.log.push(opts?.sensitive ? 'clipboard.copy(sensitive)' : 'clipboard.copy')
      if (opts?.sensitive && clock) {
        cancel = clock.setTimer(clock.now() + SENSITIVE_CLIPBOARD_MS, () => {
          cancel = null
          if (d.clipboard.text === text) void port.clear()
          else d.clipboard.byApp = false
        })
      }
      return true
    },
    async clear() {
      if (d.faults.clipboard === 'fails') return false
      cancel?.()
      cancel = null
      d.clipboard.text = ''
      d.clipboard.byApp = false
      d.log.push('clipboard.clear')
      return true
    },
    holdsAppCopy: () => d.clipboard.byApp,
    // writes are synchronous on the fake device: nothing is ever left running
    unsettled: () => false,
  }
  return port
}

export interface FakeScreen extends ScreenProtectionPort {
  readonly levels: ('normal' | 'sensitive')[]
  /** coverInBackground calls, in order */
  readonly covers: boolean[]
  current(): 'normal' | 'sensitive'
  /** simulate an iOS screenshot notification */
  capture(): void
}

export function fakeScreen(): FakeScreen {
  const levels: ('normal' | 'sensitive')[] = []
  const covers: boolean[] = []
  const listeners = new Set<() => void>()
  return {
    levels,
    covers,
    set: (level) => void levels.push(level),
    coverInBackground: (on) => void covers.push(on),
    current: () => levels[levels.length - 1] ?? 'normal',
    onCaptured(cb) {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    capture: () => {
      for (const l of [...listeners]) l()
    },
  }
}

export function fakeIdentityPlatform(
  device: FakeDevice,
  /** databases: the inventory of the IndexedDB factory the adapter writes to, where one is used (the
   *  loopback; review 420 R8-3); otherwise the device's simulated databases */
  deps: { clock: ClockPort; entropy: EntropyPort; iterations?: number; databases?: IdentityPlatform['databases'] },
): IdentityPlatform {
  return {
    vault: createSeedVault(device.vault, { clock: deps.clock, entropy: deps.entropy, iterations: deps.iterations ?? 1000 }),
    biometric: fakeBiometric(device),
    storage: fakeStorageGuard(device),
    databases: deps.databases ?? fakeDatabases(device),
    notifications: fakeNotifications(device),
    legacy: fakeLegacy(device),
    session: fakeSessionLayers(device),
    clipboard: fakeClipboard(device, deps.clock),
    clock: deps.clock,
    entropy: deps.entropy,
    prefs: fakeDevicePrefs(device),
  }
}
