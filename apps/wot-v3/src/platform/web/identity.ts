// Web implementations of the identity platform (architecture §5): IndexedDB vault, no biometrics,
// database inventory, Gen-2 detection and wipe, storage probe, clipboard, screen cover.
// Capacitor reuses all of these except biometrics, clipboard and screen protection.

import { createSeedVault, idbVaultBackend } from '../seed-vault'
import { LOW_SPACE_BYTES, SENSITIVE_CLIPBOARD_MS } from '../ports'
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
    space: () => storageSpace(),
  }
}

/** navigator.storage.estimate(): what the origin may still write (a WebView reports the same). */
export async function storageSpace(storage: StorageManager | undefined = globalThis.navigator?.storage): Promise<'ok' | 'low' | 'unknown'> {
  try {
    const est = await storage?.estimate?.()
    if (!est || typeof est.quota !== 'number' || typeof est.usage !== 'number') return 'unknown'
    const free = est.quota - est.usage
    return free < LOW_SPACE_BYTES || free < est.quota * 0.05 ? 'low' : 'ok'
  } catch {
    return 'unknown'
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

/** What the clipboard holds now; null when the platform cannot tell without asking the person. */
export type ClipboardRead = () => Promise<string | null>

/** The web reads the clipboard only where the permission was granted before: never a prompt. */
export const webClipboardRead: ClipboardRead = async () => {
  try {
    const state = await navigator.permissions?.query({ name: 'clipboard-read' as PermissionName })
    if (state?.state !== 'granted') return null
    return await navigator.clipboard.readText()
  } catch {
    return null
  }
}

async function digestOf(text: string): Promise<string | null> {
  try {
    const h = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))
    return [...h].map((b) => b.toString(16).padStart(2, '0')).join('')
  } catch {
    return null
  }
}

/** navigator.clipboard with execCommand fallback; never throws (legacy lib/clipboard.ts).
 *  A sensitive copy is overwritten after SENSITIVE_CLIPBOARD_MS (§5.3) if the clipboard still holds
 *  it. The port keeps only a SHA-256 digest of it, never the text. Where the platform cannot tell what
 *  the clipboard holds (`read` answers null: the web without a granted read permission), it is
 *  overwritten anyway: words left behind weigh more than a later copy of another app. */
export function webClipboard(clock: ClockPort, write?: (text: string) => Promise<boolean>, read: ClipboardRead = webClipboardRead): ClipboardPort {
  let byApp = false
  let cancelClear: (() => void) | null = null
  /** counts successful writes: a timer of an earlier copy never clears a later one */
  let writes = 0
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
  const stop = () => {
    cancelClear?.()
    cancelClear = null
  }
  const port: ClipboardPort = {
    async copy(text, opts) {
      const digest = opts?.sensitive ? await digestOf(text) : null
      const ok = await raw(text)
      // a failed write changed nothing: the earlier copy, its ownership and its deadline stay
      if (!ok) return false
      const n = ++writes
      stop()
      byApp = true
      if (opts?.sensitive) {
        cancelClear = clock.setTimer(clock.now() + SENSITIVE_CLIPBOARD_MS, () => {
          cancelClear = null
          void (async () => {
            const now = await read()
            if (n !== writes) return
            // another app copied meanwhile: its content stays, and the app copy is gone
            if (now !== null && (await digestOf(now)) !== digest) {
              byApp = false
              return
            }
            await port.clear()
          })().catch(() => undefined)
        })
      }
      return true
    },
    async clear() {
      const ok = await raw('')
      if (!ok) return false
      ++writes
      stop()
      byApp = false
      return true
    },
    holdsAppCopy: () => byApp,
  }
  return port
}

/** Covers the page while hidden (app switcher, tab overview) when anything sensitive is shown or an
 *  identity is open; screenshots cannot be prevented on the web (architecture §5 table). */
export function webScreenProtection(): ScreenProtectionPort {
  let level: 'normal' | 'sensitive' = 'normal'
  let identityOpen = false
  let cover: HTMLElement | null = null
  // hidden (tab switch, app switcher): covered while sensitive or while an identity is open; a mere blur
  // (another window gets the focus on a desktop) covers only what is sensitive
  const show = (why: 'hidden' | 'blur') => {
    if (!(level === 'sensitive' || (identityOpen && why === 'hidden')) || cover || typeof document === 'undefined') return
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
    document.addEventListener('visibilitychange', () => (document.visibilityState === 'hidden' ? show('hidden') : hide()))
    window.addEventListener('blur', () => show('blur'))
    window.addEventListener('focus', hide)
  }
  return {
    set(next) {
      level = next
      if (next === 'normal' && !identityOpen) hide()
    },
    coverInBackground(on) {
      identityOpen = on
      if (!on && level === 'normal') hide()
      // an identity that opened while the page is hidden is covered at once
      if (on && typeof document !== 'undefined' && document.visibilityState === 'hidden') show('hidden')
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
