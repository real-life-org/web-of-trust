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

/** Vault head (architecture §5.2). Unencrypted but authenticated as AAD. Shape is provisional. */
export interface VaultHead {
  version: number
  protection: ProtectionMode
  kdf: { name: 'PBKDF2-SHA256'; iterations: number; salt: string }
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
  store(ns: string, secret: Uint8Array): Promise<{ ok: true } | { ok: false; code: 'cancelled' | 'failed' }>
  retrieve(
    ns: string,
    prompt: { title: string; subtitle: string; cancel: string },
  ): Promise<{ ok: true; secret: Uint8Array } | { ok: false; code: 'cancelled' | 'invalidated' | 'missing' | 'failed' }>
  remove(ns: string): Promise<{ ok: boolean }>
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

/** never throws */
export interface ClipboardPort {
  copy(text: string): Promise<boolean>
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
/** try/catch inside; never throws */
export interface PrefsPort {
  get(k: string): string | null
  set(k: string, v: string): void
  wipe(): void
}
/** no-op when disabled */
export interface LiveUpdatePort {
  check(): Promise<void>
}
export interface StorageGuardPort {
  probe(): Promise<'ok' | 'blocked'>
}

/** The platform services the React layer may use. Composed in app/compose.ts. */
export interface Platform {
  readonly clock: ClockPort
  readonly entropy: EntropyPort
  readonly language: LanguagePort
  readonly prefs: PrefsPort
}

/** Theme request of a composition; 'system' follows prefers-color-scheme. */
export type ThemeChoice = 'system' | 'light' | 'dark'
