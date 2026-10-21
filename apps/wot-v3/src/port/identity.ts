// Identity commands of the app port (architecture §2.4, §4.2).
//
// The identity flows run before the data key exists, so they have no intent journal; resume
// markers without secrets carry them over a process loss (§4.2 "Wiederanlaufmarker"). The flows are
// pure state machines whose transition tables name one effect per row (`onb.marker`, `onb.ks`,
// `onb.vault`, …). Each such effect is one command here, so a machine state such as
// `keyBeforeVault` or `writingVault` exists because the port really stops between the two steps.
// Deviation from §2.4 (recorded there): `create`, `restore`, `unlock`, `changeProtection`,
// `deleteIdentity` and `resetLegacy` are replaced by these step groups.

import type { Brand } from './ids'
import type { Mnemonic, Result, Secret, WipeReport } from './commands'
import type { BiometricKind, ProtectionMode } from './models'

/** Opaque namespace of one identity on this device (architecture §3.1 "Speicher"). Not secret, never shown. */
export type IdentityNs = Brand<string, 'IdentityNs'>

export type Protection =
  | { readonly mode: 'biometric-only' }
  | { readonly mode: 'passphrase'; readonly passphrase: Secret<string> }
  | { readonly mode: 'passphrase+biometric'; readonly passphrase: Secret<string> }

/** Localized texts of the system biometric prompt. */
export interface BiometricPromptText {
  readonly title: string
  readonly subtitle: string
  readonly cancel: string
}

export type KeystoreOutcome = { readonly ok: true } | { readonly ok: false; readonly code: 'cancelled' | 'failed' }

export type BiometricUnlockOutcome =
  | { readonly ok: true }
  /** vault-mismatch: the keystore returned a secret, the vault does not open with it (N8) */
  | { readonly ok: false; readonly code: 'cancelled' | 'failed' | 'invalidated' | 'missing' | 'vault-mismatch' }

export type VerifyOutcome = { readonly ok: true } | { readonly ok: false; readonly survivors: readonly string[] }

/** Onboarding (flow 'setup') and recovery (flow 'restore'), architecture §4.2. */
export interface SetupSteps {
  /** onb.marker / rec.marker: mint a new namespace. Writes marker setup/keystore (biometric-only) or
   *  restore/staging (always, with the active namespace as nsOld); the passphrase setup writes its
   *  marker together with the vault. */
  reserve(flow: 'setup' | 'restore', mode: ProtectionMode): Promise<Result<{ ns: IdentityNs }>>
  /** onb.ks / rec.ks before the vault (biometric-only): 32 random bytes into the keystore */
  keystoreFirst(ns: IdentityNs, prompt: BiometricPromptText): Promise<KeystoreOutcome>
  /** onb.ksUndo: remove the keystore entry, delete the marker; orphan = the entry could not be removed */
  undoKeystore(ns: IdentityNs): Promise<{ readonly orphan: boolean }>
  /** onb.vault / rec.vault: one transaction with vault record, sealed initialization inputs and marker */
  writeVault(
    ns: IdentityNs,
    input: {
      readonly mnemonic: Secret<Mnemonic>
      readonly protection: Protection
      /** onboarding: the profile; recovery: null (keys-only, the profile comes later) */
      readonly profile: { readonly name: string; readonly image?: string } | null
      /** version of the accepted content rules; null = a valid consent exists */
      readonly termsVersion: string | null
    },
  ): Promise<Result>
  /** onb.vaultUndo: remove the keystore entry (biometric-only) and the marker */
  undoVault(ns: IdentityNs): Promise<{ readonly orphan: boolean }>
  /** onb.ks after the vault (passphrase+biometric): the passphrase into the keystore */
  keystoreAfter(ns: IdentityNs, prompt: BiometricPromptText): Promise<KeystoreOutcome>
  /** onb.bioUnusable: hint field only, the head stays (N8) */
  markBioUnusable(ns: IdentityNs): Promise<void>
  /** onb.init / rec.init: open or create holder store and app db, run setProfile/acceptTerms with
   *  the actIds from the sealed initialization inputs (idempotent per actId) */
  initHolder(ns: IdentityNs | null): Promise<Result>
  /** onb.activate: one transaction meta.active = ns, init deleted, marker deleted.
   *  ns null (here and in initHolder) = the namespace being unlocked after an interrupted setup */
  activate(ns: IdentityNs | null): Promise<Result>
  /** rec.quiesce + rec.switch: quiesce the old session, then meta.active = ns, marker restore/switched */
  switchTo(ns: IdentityNs): Promise<Result>
  /** rec.wipeOld: wipeNamespace(nsOld) (N6), never the whole identity */
  wipeOld(): Promise<Result>
  /** verifyingOld: verifyNamespaceWiped(nsOld) */
  verifyOld(): Promise<VerifyOutcome>
  /** rec.done: the restored identity in use, then the marker deleted; a failed deletion is an error
   *  (the flow shows "almost done" with a retry), never a finished restore */
  finishRestore(): Promise<Result>
}

/** Unlock, architecture §4.2 "Entsperren". The passphrase or keystore secret proven in this session
 *  stays inside the adapter; repair steps check their guards there again. */
export interface UnlockSteps {
  /** unl.bio + unl.vault */
  biometric(prompt: BiometricPromptText): Promise<BiometricUnlockOutcome>
  /** unl.vault with a passphrase; refused/passphrase-wrong */
  passphrase(passphrase: Secret<string>): Promise<Result>
  /** unl.bioUnusable: hint field outside the authenticated head; nothing written at the vault */
  markBioUnusable(): Promise<void>
  /** unl.holder: new generation, open the holder, first bundle; refused when another tab holds it */
  open(): Promise<Result<void, { otherWriter: true }>>
  /** unl.reprotect + unl.ksRemove: only after retrieve reported invalidated/missing in this session */
  reprotect(): Promise<Result>
  /** unl.ksRestore: only after retrieve returned a secret the vault rejected and the passphrase opened */
  restoreKeystore(prompt: BiometricPromptText): Promise<KeystoreOutcome>
  /** offerBiometric "enable": keystore first, then head passphrase+biometric (protection table row 1) */
  enableBiometric(prompt: BiometricPromptText): Promise<KeystoreOutcome>
  /** offerBiometric "not now": remembered per identity */
  dismissBiometricOffer(): Promise<void>
}

/** Change protection, architecture §4.2 "Schutz ändern". */
export interface ProtectionSteps {
  /** prove the current access in this session (open the vault with it) */
  prove(current: { readonly passphrase: Secret<string> } | { readonly biometric: BiometricPromptText }): Promise<Result>
  /** prt.ks: the proven passphrase into the keystore */
  keystoreStore(prompt: BiometricPromptText): Promise<KeystoreOutcome>
  /** prt.head: re-encrypt with the proven passphrase, new salt and IV, new head */
  setHead(mode: 'passphrase' | 'passphrase+biometric'): Promise<Result>
  /** prt.rewrap: vault under a new passphrase (from biometric-only), head passphrase+biometric */
  rewrap(passphrase: Secret<string>): Promise<Result>
  /** prt.ksRemove */
  keystoreRemove(): Promise<Result>
}

/** Delete the identity, architecture §4.2 "Identität löschen" (phases S1 to S6). */
export interface DeleteSteps {
  /** del.marker + del.quiesce (S1, S2) */
  quiesce(): Promise<Result>
  /** del.dereg (S3): deregistration per relationship while keys exist; skip = "delete without deregistration" */
  deregister(mode: 'run' | 'skip'): Promise<{ readonly done: number; readonly failed: number }>
  /** del.seal (S4) */
  seal(): Promise<Result>
  /** del.close (S5) */
  close(): Promise<Result>
  /** del.wipe (S6): wipeNamespace(ns), then the global layers */
  wipe(): Promise<Result>
  /** verifying */
  verify(): Promise<VerifyOutcome>
  /** del.done: delete the marker last, release the lock; the report separates local and remote */
  finish(): Promise<WipeReport>
}

/** Gen-2 reset, architecture §4.2 "Gen-2-Reset". */
export interface LegacySteps {
  /** marker legacy-wipe, then the Gen-2 databases, vault, keystore alias and keys */
  wipe(): Promise<Result>
  verify(): Promise<VerifyOutcome>
  /** marker deleted only after a verified wipe */
  mark(): Promise<void>
}

export interface IdentityCommands {
  /** twelve words, nothing stored */
  generate(): Promise<Result<Secret<Mnemonic>>>
  /** check a word list (lengths 12, 15, 18, 21, 24; checksum) without doing anything */
  checkMnemonic(words: readonly string[]): Result<{ length: number }>
  /** kind of biometrics usable now (protect step guard), null if none */
  biometricAvailability(): Promise<BiometricKind | null>
  /** the current content-rules version and whether a valid consent exists on this device */
  termsConsent(): { readonly current: string; readonly valid: boolean }
  acceptTerms(version: string): Promise<Result>
  /** re-run the boot reconciliation (after a flow changed the stored identity) */
  refresh(): Promise<void>
  lock(reason: 'user' | 'background-timeout'): Promise<void>
  readonly setup: SetupSteps
  readonly unlock: UnlockSteps
  readonly protection: ProtectionSteps
  readonly delete: DeleteSteps
  readonly legacy: LegacySteps
}
