// Web implementations of the identity platform (architecture §5): IndexedDB vault, no biometrics,
// database inventory, Gen-2 detection and wipe, storage probe, clipboard, screen cover.
// Capacitor reuses all of these except biometrics, clipboard and screen protection.

import { createSeedVault, idbVaultBackend } from '../seed-vault'
import type {
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

// ── Gen-2 legacy names (apps/demo src/services/durableStoreWipe.ts, localStorageSchemaMigration.ts).
// tests/identity/legacy-gen2.test.ts reads the legacy source and fails when these drift.
export const LEGACY_DB_NAMES = [
  'wot-space-metadata',
  'automerge-repo',
  'wot-local-cache',
  'wot-space-compact-store',
  'wot-space-sync-states',
  'wot-yjs-compact-store',
  'wot-personal-doc',
  'automerge-personal',
  'web-of-trust',
] as const
export const DURABLE_STORE_PREFIXES = [
  'wot-doc-log:',
  'wot-key-management:',
  'wot-member-update-pending:',
  'wot-message-id-history:',
] as const
export const LEGACY_SEED_VAULT_DB_NAME = 'wot-identity'
export const LEGACY_DEVICE_ID_PREFIX = 'wot-device-id:'
export const LEGACY_ACTIVE_DID_KEY = 'wot-active-did'
export const LEGACY_SCHEMA_VERSION_KEY = 'wot-storage-schema-version'
/** databases whose presence signals an old dataset (localStorageSchemaMigration.ts WOT_DATA_DBS) */
export const LEGACY_DATA_DBS = ['wot-identity', 'wot-personal-doc', 'web-of-trust', 'automerge-personal', 'wot-local-cache'] as const

// ── IndexedDB inventory ─────────────────────────────────────────────────────

export function webDatabases(factory: IDBFactory = indexedDB): DatabasesPort {
  return {
    async list() {
      if (typeof factory.databases !== 'function') return null
      try {
        return (await factory.databases()).map((d) => d.name).filter((n): n is string => typeof n === 'string')
      } catch {
        return null
      }
    },
    exists(name) {
      // Opening without a version creates an empty database when it was absent; an absent one has
      // version 1 and no stores right after the upgrade, which we treat as "not there" and remove.
      return new Promise((resolve) => {
        try {
          let created = false
          const r = factory.open(name)
          r.onupgradeneeded = () => {
            created = true
          }
          r.onsuccess = () => {
            const db = r.result
            const empty = db.objectStoreNames.length === 0
            db.close()
            if (created) factory.deleteDatabase(name)
            resolve(!created && !empty)
          }
          r.onerror = () => resolve(true)
          r.onblocked = () => resolve(true)
        } catch {
          resolve(true)
        }
      })
    },
    remove(name) {
      return new Promise((resolve) => {
        try {
          const r = factory.deleteDatabase(name)
          r.onsuccess = () => resolve(true)
          r.onerror = () => resolve(false)
          r.onblocked = () => resolve(false)
        } catch {
          resolve(false)
        }
      })
    },
  }
}

// ── Gen-2 legacy data ───────────────────────────────────────────────────────

function localStorageKeys(): string[] {
  try {
    const out: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (k !== null) out.push(k)
    }
    return out
  } catch {
    return []
  }
}

function legacyLocalKeys(): string[] {
  return localStorageKeys().filter(
    (k) => k === LEGACY_ACTIVE_DID_KEY || k === LEGACY_SCHEMA_VERSION_KEY || k.startsWith(LEGACY_DEVICE_ID_PREFIX),
  )
}

function isLegacyDb(name: string): boolean {
  return (
    (LEGACY_DB_NAMES as readonly string[]).includes(name) ||
    name === LEGACY_SEED_VAULT_DB_NAME ||
    DURABLE_STORE_PREFIXES.some((p) => name.startsWith(p))
  )
}

/** Gen-2 detection and wipe. The keystore alias `wot_biometric_key` is removed by the runtime over
 *  BiometricPort.removeLegacy, so this port stays free of native code. */
export function webLegacyGen2(databases: DatabasesPort): LegacyGen2Port {
  const legacyDbs = async (): Promise<string[]> => {
    const all = await databases.list()
    if (all) return all.filter(isLegacyDb)
    // without databases(): probe the known names (durable stores need the DID, which is in localStorage)
    const known = [...LEGACY_DB_NAMES, LEGACY_SEED_VAULT_DB_NAME]
    const out: string[] = []
    for (const n of known) if (await databases.exists(n)) out.push(n)
    return out
  }
  return {
    async detect() {
      if (legacyLocalKeys().some((k) => k !== LEGACY_SCHEMA_VERSION_KEY)) return true
      const dbs = await legacyDbs()
      return dbs.some((n) => (LEGACY_DATA_DBS as readonly string[]).includes(n) || DURABLE_STORE_PREFIXES.some((p) => n.startsWith(p)))
    },
    async wipe() {
      for (const n of await legacyDbs()) await databases.remove(n)
      let activeDid: string | null = null
      try {
        activeDid = localStorage.getItem(LEGACY_ACTIVE_DID_KEY)
      } catch {
        activeDid = null
      }
      if (activeDid) for (const p of DURABLE_STORE_PREFIXES) await databases.remove(`${p}${activeDid}`)
      for (const k of legacyLocalKeys()) {
        try {
          localStorage.removeItem(k)
        } catch {
          // blocked storage: reported by survivors()
        }
      }
    },
    async survivors() {
      return [...(await legacyDbs()).map((n) => `indexeddb:${n}`), ...legacyLocalKeys().map((k) => `localStorage:${k}`)]
    },
  }
}

// ── storage probe, session layers, notifications (none on the web without a service worker) ──

export function webStorageGuard(factory: IDBFactory | undefined = globalThis.indexedDB): StorageGuardPort {
  return {
    probe() {
      if (!factory) return Promise.resolve('blocked')
      return new Promise((resolve) => {
        let settled = false
        const done = (v: 'ok' | 'blocked') => {
          if (!settled) {
            settled = true
            resolve(v)
          }
        }
        const timer = setTimeout(() => done('blocked'), 4000)
        try {
          const r = factory.open('wot-v3-storage-probe')
          r.onsuccess = () => {
            clearTimeout(timer)
            try {
              r.result.close()
              factory.deleteDatabase('wot-v3-storage-probe')
            } catch {
              // best effort
            }
            done('ok')
          }
          r.onerror = () => done('blocked')
          r.onblocked = () => done('blocked')
        } catch {
          done('blocked')
        }
      })
    },
    cryptoMissing() {
      const missing: string[] = []
      if (!globalThis.crypto?.subtle) missing.push('crypto.subtle')
      if (typeof globalThis.crypto?.getRandomValues !== 'function') missing.push('crypto.getRandomValues')
      return missing
    },
  }
}

export function webSessionLayers(): SessionLayersPort {
  return {
    async wipe() {
      try {
        sessionStorage.clear()
      } catch {
        // blocked: reported by survivors()
      }
      try {
        if (typeof caches !== 'undefined') for (const k of await caches.keys()) await caches.delete(k)
      } catch {
        // no Cache Storage
      }
    },
    async survivors() {
      const out: string[] = []
      try {
        if (sessionStorage.length > 0) out.push('sessionStorage')
      } catch {
        // ignore
      }
      try {
        if (typeof caches !== 'undefined') for (const k of await caches.keys()) out.push(`cache:${k}`)
      } catch {
        // ignore
      }
      return out
    },
  }
}

/** No service worker yet, so no notifications on the web (architecture §5 NotificationPort). */
export function webNotifications(): NotificationPort {
  return {
    permission: async () => 'denied',
    request: async () => 'denied',
    notify: async () => {},
    onOpen: () => () => {},
    list: async () => [],
    cancelNamespace: async () => ({ ok: true, remaining: [] }),
    removeDelivered: async () => ({ ok: true, remaining: [] }),
    verifyNone: async () => true,
  }
}

/** The web has no keystore behind biometrics. */
export const webBiometric: BiometricPort = {
  availability: async () => ({ kind: 'unavailable' }),
  hasEntry: async () => false,
  store: async () => ({ ok: false, code: 'failed' }),
  retrieve: async () => ({ ok: false, code: 'missing' }),
  remove: async () => ({ ok: true }),
  hasLegacy: async () => false,
  removeLegacy: async () => ({ ok: true }),
}

// ── clipboard and screen ─────────────────────────────────────────────────────

const SENSITIVE_CLEAR_MS = 60_000

/** navigator.clipboard with execCommand fallback; never throws (legacy lib/clipboard.ts). */
export function webClipboard(clock: ClockPort, write?: (text: string) => Promise<boolean>): ClipboardPort {
  let byApp = false
  let cancelClear: (() => void) | null = null
  const raw =
    write ??
    (async (text: string) => {
      try {
        await navigator.clipboard.writeText(text)
        return true
      } catch {
        try {
          const ta = document.createElement('textarea')
          ta.value = text
          ta.setAttribute('readonly', '')
          ta.style.position = 'fixed'
          ta.style.opacity = '0'
          document.body.appendChild(ta)
          ta.select()
          const ok = document.execCommand('copy')
          ta.remove()
          return ok
        } catch {
          return false
        }
      }
    })
  const port: ClipboardPort = {
    async copy(text, opts) {
      const ok = await raw(text)
      byApp = ok
      cancelClear?.()
      cancelClear = null
      if (ok && opts?.sensitive) cancelClear = clock.setTimer(clock.now() + SENSITIVE_CLEAR_MS, () => void port.clear())
      return ok
    },
    async clear() {
      cancelClear?.()
      cancelClear = null
      const ok = await raw('')
      if (ok) byApp = false
      return ok
    },
    holdsAppCopy: () => byApp,
  }
  return port
}

/** Covers the page while hidden (app switcher, tab overview) when anything sensitive is shown or an
 *  identity is open; screenshots cannot be prevented on the web (architecture §5 table). */
export function webScreenProtection(): ScreenProtectionPort {
  let level: 'normal' | 'sensitive' = 'normal'
  let cover: HTMLElement | null = null
  const show = () => {
    if (level !== 'sensitive' || cover || typeof document === 'undefined') return
    cover = document.createElement('div')
    cover.setAttribute('aria-hidden', 'true')
    cover.setAttribute('data-screen-cover', '')
    cover.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:var(--background,#fff)'
    document.body.appendChild(cover)
  }
  const hide = () => {
    cover?.remove()
    cover = null
  }
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => (document.visibilityState === 'hidden' ? show() : hide()))
    window.addEventListener('blur', show)
    window.addEventListener('focus', hide)
  }
  return {
    set(next) {
      level = next
      if (next === 'normal') hide()
    },
    onCaptured: () => () => {},
  }
}

export function createWebIdentityPlatform(deps: {
  clock: ClockPort
  entropy: EntropyPort
  prefs: PrefsPort
  clipboard: ClipboardPort
  biometric?: BiometricPort
}): IdentityPlatform {
  const databases = webDatabases()
  return {
    vault: createSeedVault(idbVaultBackend(), { clock: deps.clock, entropy: deps.entropy }),
    biometric: deps.biometric ?? webBiometric,
    storage: webStorageGuard(),
    databases,
    notifications: webNotifications(),
    legacy: webLegacyGen2(databases),
    session: webSessionLayers(),
    clipboard: deps.clipboard,
    clock: deps.clock,
    entropy: deps.entropy,
    prefs: deps.prefs,
  }
}
