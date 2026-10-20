// Platform ports (architecture §5). Pure interfaces: this file imports nothing, not even port/.
// Types with the same name as in port/ are deliberately separate declarations.
// Implementations: platform/capacitor (native), platform/web, platform/fake (tests and harness).

export type BiometricKind = 'face' | 'fingerprint' | 'iris' | 'device-credential'
export type ProtectionMode = 'biometric-only' | 'passphrase' | 'passphrase+biometric'

/** Resume marker without secrets (architecture §4.2). */
export interface ResumeMarker {
  flow: 'setup' | 'restore' | 'wipe' | 'legacy-wipe'
  step: string
  ns: string
  nsOld?: string
  mode?: ProtectionMode
  startedAt: number
}

/** Initialization inputs, encrypted by the adapter under the DEK; opaque to the port. */
export interface SealedInit {
  iv: string
  ct: string
}

/** Vault head (architecture §5.2). Unencrypted but bound as AAD (JCS of the head). */
export interface VaultHead {
  format: 'wot-v3-vault'
  v: 1
  ns: string
  protection: ProtectionMode
  kdf: { alg: 'PBKDF2-SHA-256'; iterations: number; salt: string }
  aead: 'AES-256-GCM'
  createdAt: number
  updatedAt: number
}

export interface ScannerPort {
  availability(): Promise<'available' | 'no-camera' | 'unsupported'>
  permission(): Promise<'granted' | 'denied' | 'prompt'>
  /** web: renders into target; native: full screen, target ignored */
  scan(opts: { target: HTMLElement | null; signal: AbortSignal }): Promise<
    | { kind: 'ok'; text: string }
    | { kind: 'cancelled' }
    | { kind: 'permission-denied' }
    | { kind: 'error'; message: string }
  >
  openSettings(): Promise<void>
}

/** One keystore entry per identity namespace (alias `wot_v3_<ns>`). */
export interface BiometricPort {
  availability(): Promise<{ kind: 'available'; type: BiometricKind } | { kind: 'not-enrolled' } | { kind: 'unavailable' }>
  hasEntry(ns: string): Promise<boolean>
  store(
    ns: string,
    secret: Uint8Array,
    prompt?: { title: string; subtitle: string; cancel: string },
  ): Promise<{ ok: true } | { ok: false; code: 'cancelled' | 'failed' }>
  retrieve(
    ns: string,
    prompt: { title: string; subtitle: string; cancel: string },
  ): Promise<{ ok: true; secret: Uint8Array } | { ok: false; code: 'cancelled' | 'invalidated' | 'missing' | 'failed' }>
  remove(ns: string): Promise<{ ok: boolean }>
  /** Gen-2 entry under the alias `wot_biometric_key`; strict like hasEntry */
  hasLegacy(): Promise<boolean>
  /** alias `wot_biometric_key` (Gen-2 reset) */
  removeLegacy(): Promise<{ ok: boolean }>
}

/** Vault after architecture §5.2. */
export interface SeedVaultPort {
  exists(ns: string): Promise<'none' | 'v3' | 'unsupported'>
  head(ns: string): Promise<VaultHead | null>
  create(
    ns: string,
    payload: { rootIkm: Uint8Array; dek: Uint8Array },
    password: Uint8Array,
    protection: ProtectionMode,
    init: SealedInit,
    marker: ResumeMarker,
  ): Promise<void>
  /** null = wrong password */
  open(ns: string, password: Uint8Array): Promise<{ rootIkm: Uint8Array; dek: Uint8Array } | null>
  rewrap(ns: string, oldPassword: Uint8Array, newPassword: Uint8Array, protection: ProtectionMode): Promise<boolean>
  setProtection(ns: string, protection: ProtectionMode, password: Uint8Array): Promise<boolean>
  init(ns: string): Promise<SealedInit | null>
  bioUnusable(ns: string): Promise<boolean>
  setBioUnusable(ns: string, v: boolean): Promise<void>
  active(): Promise<string | null>
  activate(ns: string, marker: ResumeMarker | null): Promise<void>
  resume(): Promise<ResumeMarker | null>
  setResume(m: ResumeMarker | null): Promise<void>
  wipe(ns: string): Promise<void>
  verifyWiped(ns: string): Promise<boolean>
  namespaces(): Promise<readonly string[]>
}

export interface ScreenProtectionPort {
  set(level: 'normal' | 'sensitive'): void
  onCaptured(cb: () => void): () => void
}

export interface NotificationPort {
  permission(): Promise<'granted' | 'denied' | 'prompt'>
  request(): Promise<'granted' | 'denied'>
  notify(n: { ns: string; id: string; title: string; body: string; route: string }): Promise<void>
  onOpen(cb: (route: string) => void): () => void
  list(): Promise<readonly { id: string; ns: string | null; state: 'scheduled' | 'delivered' }[]>
  cancelNamespace(ns: string): Promise<{ ok: boolean; remaining: readonly string[] }>
  removeDelivered(ns: string | 'all'): Promise<{ ok: boolean; remaining: readonly string[] }>
  verifyNone(ns: string | 'all'): Promise<boolean>
}

/** Never throws (legacy `lib/clipboard.ts`, #235): a denied write must not end on the crash screen. */
export interface ClipboardPort {
  /** false when the write failed. sensitive: overwritten after 60 s where the platform allows it (§5.3) */
  copy(text: string, opts?: { sensitive?: boolean }): Promise<boolean>
  /** overwrite what the app copied, where the platform allows it (delete inventory 12) */
  clear(): Promise<boolean>
  /** the last clipboard write came from this app and was not overwritten yet */
  holdsAppCopy(): boolean
}
export interface SharePort {
  share(x: { text: string; url?: string }): Promise<'shared' | 'cancelled' | 'unsupported'>
}
export interface DeepLinkPort {
  initial(): Promise<string | null>
  subscribe(cb: (url: string) => void): () => void
}
export interface LifecyclePort {
  onState(cb: (s: 'active' | 'background') => void): () => void
  /** true = handled */
  onBack(cb: () => boolean): () => void
  exit(): void
}
export type Language = 'en' | 'de'
export interface LanguagePort {
  system(): readonly string[]
  current(): Language
  /** web: yes, native: no (the system per-app language is the source) */
  readonly inAppChoice: boolean
  /** web only */
  set(lang: Language): void
  /** native */
  openSystemSettings(): Promise<boolean>
  subscribe(cb: () => void): () => void
}
export interface ClockPort {
  now(): number
  setTimer(at: number, cb: () => void): () => void
  timeZone(): string
}
export interface EntropyPort {
  uuid(): string
  bytes(n: number): Uint8Array
}
/** try/catch inside; never throws. Keys are given without the app prefix. */
export interface PrefsPort {
  get(k: string): string | null
  set(k: string, v: string): void
  remove(k: string): void
  /** keys (without the app prefix) that start with `prefix` */
  keys(prefix?: string): readonly string[]
  /** removes every key of the app */
  wipe(): void
}
/** no-op when disabled */
export interface LiveUpdatePort {
  check(): Promise<void>
}
export interface StorageGuardPort {
  probe(): Promise<'ok' | 'blocked'>
  /** WebCrypto pieces the vault needs that are missing (empty = all there) */
  cryptoMissing(): readonly string[]
}

/** The app's own IndexedDB databases, by name (wipe inventory and its verification, architecture §4.2). */
export interface DatabasesPort {
  /** all database names of the origin; null when the platform cannot enumerate (then `exists` per name) */
  list(): Promise<readonly string[] | null>
  exists(name: string): Promise<boolean>
  /** resolves when deleted; false when blocked or failed */
  remove(name: string): Promise<boolean>
}

/** Gen-2 legacy data of the old app (architecture §4.2 "Gen-2-Reset"). Names come from apps/demo
 *  `durableStoreWipe.ts`, checked by a test against those constants. */
export interface LegacyGen2Port {
  detect(): Promise<boolean>
  /** best effort over every layer; never throws */
  wipe(): Promise<void>
  /** what is still there after a wipe (names), empty = clean */
  survivors(): Promise<readonly string[]>
}

/** Remaining global layers of a full delete (architecture §4.2 inventory 9 to 12). */
export interface SessionLayersPort {
  /** sessionStorage, Cache Storage and service-worker caches of the app */
  wipe(): Promise<void>
  survivors(): Promise<readonly string[]>
}

/** What the identity runtime under the port needs from the platform (architecture §5). */
export interface IdentityPlatform {
  readonly vault: SeedVaultPort
  readonly biometric: BiometricPort
  readonly storage: StorageGuardPort
  readonly databases: DatabasesPort
  readonly notifications: NotificationPort
  readonly legacy: LegacyGen2Port
  readonly session: SessionLayersPort
  readonly clipboard: ClipboardPort
  readonly clock: ClockPort
  readonly entropy: EntropyPort
  readonly prefs: PrefsPort
}

/** The platform services the React layer may use. Composed in app/compose.ts. */
export interface Platform {
  readonly clock: ClockPort
  readonly entropy: EntropyPort
  readonly language: LanguagePort
  readonly prefs: PrefsPort
  readonly clipboard: ClipboardPort
  readonly screen: ScreenProtectionPort
  readonly scanner: ScannerPort
}

/** Theme request of a composition; 'system' follows prefers-color-scheme. */
export type ThemeChoice = 'system' | 'light' | 'dark'
