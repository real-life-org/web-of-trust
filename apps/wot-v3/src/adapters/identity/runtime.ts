// Identity runtime under the port (architecture §4.2, §5, §5.1, §5.2), shared by both adapters:
// boot reconciliation after the boot matrix, the setup and restore steps, unlock with its repairs,
// protection change, delete (S1 to S6 with the wipe inventory) and the Gen-2 reset. Each port step
// is one effect of a flow table. The runtime holds key material only as bytes, overwritten on lock;
// words and passphrases come in as Secret and are revealed only to derive bytes.
//
// Deviation from §1.1 (recorded there): this folder is new. It sits under the port next to the two
// adapters, which both compose it; it imports the port, platform/ports.ts and @scure/bip39.

import type {
  BiometricUnlockOutcome,
  IdentityCommands,
  IdentityNs,
  IdentityState,
  KeystoreOutcome,
  LockInfo,
  Mnemonic,
  ProtectionMode,
  ReadStore,
  Result,
  VerifyOutcome,
  WipeReport,
} from '../../port'
import { secret, writableStore } from '../../port'
import type { IdentityPlatform, ResumeMarker } from '../../platform/ports'
import type { HolderHost, HolderKeys } from './host'
import { checkWords, generateWords, rootIkmFromWords } from './mnemonic'
import { openInit, sealInit, type InitInputs } from './sealed-init'

/** Version of the content rules a consent refers to (architecture §10, Frage 10: text still open). */
export const TERMS_VERSION = '2026-10-draft'

const OK: Result = Object.freeze({ ok: true, value: undefined })
const fail = (error: Extract<Result, { ok: false }>['error']): Result<never> => ({ ok: false, error })
const refused = (code: 'passphrase-wrong' | 'last-access' | 'mnemonic-invalid' | 'mnemonic-checksum') =>
  fail({ kind: 'refused', code })
const LOCKED = fail({ kind: 'locked' })
const bug = (message: string) => fail({ kind: 'bug', message })
const storageError = () => fail({ kind: 'infra', code: 'storage', retryable: true })

const utf8 = new TextEncoder()
const passphraseBytes = (p: string) => utf8.encode(p.normalize('NFC'))
const wipeBytes = (b: Uint8Array | null | undefined) => b?.fill(0)
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('')

interface Pending {
  readonly flow: 'setup' | 'restore'
  readonly ns: string
  readonly mode: ProtectionMode
  readonly nsOld: string | null
  ksSecret: Uint8Array | null
  keys: HolderKeys | null
  password: Uint8Array | null
}

interface Session {
  readonly ns: string
  keys: HolderKeys
  /** the vault password proven in this session (passphrase bytes or the keystore secret) */
  proven: Uint8Array
  provenBy: 'passphrase' | 'keystore'
  open: boolean
  recovered: 'full' | 'keys-only' | null
  /** the generation this session was installed in; installing a session starts a new one */
  readonly gen: number
}

export interface IdentityRuntime extends IdentityCommands {
  readonly state: ReadStore<IdentityState>
  /** the boot reconciliation (architecture §4.2 boot matrix); idempotent */
  boot(): Promise<IdentityState>
  /** layers that survived the last namespace verification (diagnostics in tests and the harness) */
  lastSurvivors(): readonly string[]
}

export function createIdentityRuntime(p: IdentityPlatform, host: HolderHost, opts: { subtle?: SubtleCrypto } = {}): IdentityRuntime {
  const subtle = opts.subtle ?? globalThis.crypto.subtle
  const state = writableStore<IdentityState>({ status: 'booting' })
  let pending: Pending | null = null
  let session: Session | null = null
  /** set when retrieve reported invalidated/missing, or returned a secret the vault rejected (N8) */
  let retrieveReport: 'invalidated' | 'missing' | 'mismatch' | null = null
  /** namespace of the identity being unlocked: the active one, or the one of an interrupted setup */
  let target: string | null = null
  let survivors: readonly string[] = []
  let remote = { done: 0, failed: 0 }
  let deleteNs: string | null = null
  /** Session generation (architecture §2.1 rule 7). Raised synchronously by lock, boot, the switch of
   *  a restore, the first delete phase and by installing a session; every operation that awaits and
   *  then installs or opens a session checks it afterwards and drops a result of an older generation
   *  (review #414, finding 2). The publish contract below extends this to every state commit. */
  let gen = 0
  /** Verdicts of the last verification of this run. Success needs a positive verdict, never the
   *  absence of survivors in a variable nobody refreshed (review #414, finding 1). */
  let deleteVerdict: 'unknown' | 'clean' | 'survivors' = 'unknown'
  let oldVerdict: 'unknown' | 'clean' | 'survivors' = 'unknown'
  let legacyVerdict: 'unknown' | 'clean' | 'survivors' = 'unknown'

  const marker = (m: Omit<ResumeMarker, 'startedAt'>): ResumeMarker => ({ ...m, startedAt: p.clock.now() })
  const nsPrefs = (ns: string) => `${ns}:`

  // ── lock info and state ───────────────────────────────────────────────────

  const keystoreHas = async (ns: string): Promise<boolean | null> => {
    try {
      return await p.biometric.hasEntry(ns)
    } catch {
      return null // strict check failed: unknown, never assumed absent
    }
  }

  const lockInfo = async (ns: string): Promise<LockInfo> => {
    const exists = await p.vault.exists(ns)
    const head = exists === 'v3' ? await p.vault.head(ns) : null
    const avail = await p.biometric.availability()
    const biometric = avail.kind === 'available' ? avail.type : null
    const protection: ProtectionMode = head?.protection ?? 'passphrase'
    const k = head && protection !== 'passphrase' ? await keystoreHas(ns) : null
    return {
      protection,
      biometric,
      biometricLost: protection === 'biometric-only' && k === false,
      bioUnusable: head ? await p.vault.bioUnusable(ns) : false,
      unsupported: exists === 'unsupported',
      offerBiometric:
        protection === 'passphrase' && biometric !== null && p.prefs.get(`${nsPrefs(ns)}bio-offer-dismissed`) !== '1',
    }
  }

  // ── publish contract (review #414 at 924ca0b1, P1) ───────────────────────
  // Every state the runtime publishes belongs to the generation it was computed for. The commit
  // happens only if that generation is still current at the commit itself, after the last await;
  // otherwise it is dropped and the caller reports LOCKED, never success. The unlocked state belongs
  // to one session: it commits only while that session is installed and its generation is current.

  /** commits `next` if generation g is still current; the state after the attempt */
  const commit = (g: number, next: IdentityState): IdentityState => {
    if (g === gen) state.set(next)
    return state.get()
  }

  const live = (s: Session): boolean => session === s && s.gen === gen

  const install = (s: Omit<Session, 'gen'>): Session => (session = { ...s, gen: ++gen })

  /** Publishes the session after a step: unlocked if its holder is open. OK only if the session is
   *  still live at the commit; a session closed or superseded meanwhile gives LOCKED. */
  const publishSession = async (s: Session): Promise<Result> => {
    if (!live(s)) return LOCKED
    if (!s.open) return OK
    const head = await p.vault.head(s.ns)
    const avail = await p.biometric.availability()
    if (!live(s)) return LOCKED
    state.set({
      status: 'unlocked',
      anchorShort: host.anchorShort(s.ns) ?? '',
      protection: head?.protection ?? 'passphrase',
      recovered: s.recovered,
      termsAccepted: p.prefs.get('terms') === TERMS_VERSION,
      biometric: avail.kind === 'available' ? avail.type : null,
    })
    return OK
  }

  /** publishes locked for ns under generation g (lock, boot) */
  const setLocked = async (g: number, ns: string): Promise<IdentityState> => {
    const next: IdentityState = { status: 'locked', ...(await lockInfo(ns)) }
    if (g === gen) target = ns
    return commit(g, next)
  }

  // ── wipe inventory (architecture §4.2 "Löschinventar") ────────────────────

  const hostNamespaces = async (): Promise<string[]> => {
    const names = (await p.databases.list()) ?? []
    return names.map((n) => host.namespaceOf(n)).filter((n): n is string => n !== null)
  }

  /** wipeNamespace(ns), layers 1 to 7; touches nothing outside ns (N6) */
  const wipeNamespace = async (ns: string): Promise<void> => {
    if (session?.ns === ns) await closeSession()
    host.forget(ns)
    for (const name of host.databaseNames(ns)) await p.databases.remove(name)
    await p.vault.wipe(ns)
    await p.biometric.remove(ns)
    for (const k of p.prefs.keys(nsPrefs(ns))) p.prefs.remove(k)
    await p.notifications.cancelNamespace(ns)
    await p.notifications.removeDelivered(ns)
  }

  /** verifyNamespaceWiped(ns), layer 8: the names of every surviving layer */
  const verifyNamespace = async (ns: string): Promise<string[]> => {
    const out: string[] = []
    const all = await p.databases.list()
    if (all) for (const n of all) if (n.includes(ns)) out.push(`indexeddb:${n}`)
    if (!all) for (const n of host.databaseNames(ns)) if (await p.databases.exists(n)) out.push(`indexeddb:${n}`)
    if (!(await p.vault.verifyWiped(ns))) out.push(`vault:${ns}`)
    if ((await keystoreHas(ns)) !== false) out.push(`keystore:${ns}`)
    if (!(await p.notifications.verifyNone(ns))) out.push(`notifications:${ns}`)
    for (const k of p.prefs.keys(nsPrefs(ns))) out.push(`prefs:${k}`)
    return out
  }

  /** S1, S2, S4, S5 for the holder of ns, if open */
  const closeHolder = async (ns: string): Promise<void> => {
    if (!host.isOpen(ns)) return
    await host.quiesce(ns)
    await host.seal(ns)
    await host.close(ns)
  }

  const wipeKeys = (k: HolderKeys | null | undefined) => {
    wipeBytes(k?.rootIkm)
    wipeBytes(k?.dek)
  }

  /** The session's own holder and bytes (a staged holder of a restore is the pending inventory). */
  const closeSession = async (): Promise<void> => {
    const s = session
    if (!s) return
    session = null
    await closeHolder(s.ns)
    wipeKeys(s.keys)
    wipeBytes(s.proven)
  }

  /** The pending inventory of a setup or restore: secrets, keys and the holder initHolder staged.
   *  It belongs to the teardown like the session (review #414 at 924ca0b1, CodeRabbit): whoever
   *  drops pending closes its holder, unless the session took the namespace over. */
  const dropPending = async (): Promise<void> => {
    const pd = pending
    if (!pd) return
    pending = null
    const owned = session?.ns === pd.ns
    if (!owned) await closeHolder(pd.ns)
    wipeBytes(pd.ksSecret)
    wipeBytes(pd.password)
    if (!owned) wipeKeys(pd.keys)
  }

  const orphans = async (keep: readonly (string | null | undefined)[]): Promise<void> => {
    const known = new Set([...(await p.vault.namespaces()), ...(await hostNamespaces())])
    for (const ns of known) if (!keep.includes(ns)) await wipeNamespace(ns)
  }

  // ── boot (architecture §4.2 boot matrix) ──────────────────────────────────

  const boot = async (): Promise<IdentityState> => {
    const g = ++gen
    const set = (next: IdentityState) => commit(g, next)
    const locked = (ns: string) => setLocked(g, ns)
    await closeSession()
    await dropPending()
    retrieveReport = null
    set({ status: 'booting' })
    if ((await p.storage.probe()) === 'blocked') return set({ status: 'storage-blocked' })
    const missing = p.storage.cryptoMissing()
    if (missing.length > 0) return set({ status: 'crypto-unavailable', missing })

    const m = await p.vault.resume()
    if (m?.flow === 'wipe') {
      deleteNs = m.ns
      const afterSeal = m.step === 'sealed'
      const lock = afterSeal || (await p.vault.exists(m.ns)) !== 'v3' ? null : await lockInfo(m.ns)
      target = m.ns
      return set({ status: 'resuming', step: 'wipe', phase: afterSeal ? 'after-seal' : 'before-seal', lock })
    }
    if (m?.flow === 'legacy-wipe') return set({ status: 'legacy-gen2', resume: true })
    if (m?.flow === 'restore' && m.step === 'switched') {
      if ((await p.vault.active()) !== m.ns) return set({ status: 'storage-blocked' }) // never destroy on suspicion
      set({ status: 'resuming', step: 'restore-switch' })
      if (m.nsOld) {
        await wipeNamespace(m.nsOld)
        survivors = await verifyNamespace(m.nsOld)
      } else survivors = []
      if (survivors.length === 0) await p.vault.setResume(null) // the marker stays until the old ns is verified gone
      return locked(m.ns)
    }
    if (m?.flow === 'restore') {
      // restore/staging: the new namespace goes, the active pointer (old or null) is untouched
      await wipeNamespace(m.ns)
      await p.vault.setResume(null)
      const active = await p.vault.active()
      return active ? locked(active) : set({ status: 'none', hint: null })
    }
    if (m?.flow === 'setup') {
      const v = await p.vault.exists(m.ns)
      if (v === 'none') {
        // setup/keystore without vault, or setup/holder whose vault is missing: K, I, H go
        await wipeNamespace(m.ns)
        await p.vault.setResume(null)
        return set({ status: 'none', hint: 'setup-interrupted' })
      }
      // setup/holder (or setup/keystore with a vault, which cannot happen: one transaction)
      target = m.ns
      const info = await lockInfo(m.ns)
      if (info.protection === 'passphrase+biometric' && (await keystoreHas(m.ns)) === false) {
        await p.vault.setBioUnusable(m.ns, true)
        return set({ status: 'resuming', step: 'setup', ...info, bioUnusable: true })
      }
      return set({ status: 'resuming', step: 'setup', ...info })
    }

    // no marker
    let legacy = await p.legacy.detect()
    if (!legacy) {
      try {
        legacy = await p.biometric.hasLegacy()
      } catch {
        legacy = false
      }
    }
    if (legacy) return set({ status: 'legacy-gen2', resume: false })
    const active = await p.vault.active()
    if (!active) {
      await orphans([])
      return set({ status: 'none', hint: null })
    }
    const v = await p.vault.exists(active)
    if (v === 'none') return set({ status: 'none', hint: 'access-missing' }) // nothing deleted
    if (v === 'unsupported') {
      target = active
      return set({ status: 'locked', ...(await lockInfo(active)), unsupported: true })
    }
    await orphans([active])
    const head = await p.vault.head(active)
    if (head?.protection === 'passphrase' && (await keystoreHas(active)) === true) await p.biometric.remove(active)
    return locked(active)
  }

  // ── setup and restore ─────────────────────────────────────────────────────

  const needPending = (ns: IdentityNs): Pending | null => (pending?.ns === ns ? pending : null)

  const keysFor = (ns: string): HolderKeys | null => {
    if (pending?.ns === ns && pending.keys) return pending.keys
    if (session?.ns === ns) return session.keys
    return null
  }

  const setup: IdentityCommands['setup'] = {
    async reserve(flow, mode) {
      await dropPending()
      const ns = `n${hex(p.entropy.bytes(8))}`
      const active = await p.vault.active()
      const nsOld = flow === 'restore' ? active : null
      if (flow === 'setup' && mode === 'biometric-only') await p.vault.setResume(marker({ flow: 'setup', step: 'keystore', ns, mode }))
      if (flow === 'restore') await p.vault.setResume(marker({ flow: 'restore', step: 'staging', ns, mode, ...(nsOld ? { nsOld } : {}) }))
      pending = { flow, ns, mode, nsOld, ksSecret: null, keys: null, password: null }
      return { ok: true, value: { ns: ns as IdentityNs } }
    },

    async keystoreFirst(ns, prompt) {
      const pd = needPending(ns)
      if (!pd || pd.mode !== 'biometric-only') return { ok: false, code: 'failed' }
      const random = p.entropy.bytes(32)
      const r = await p.biometric.store(ns, random, prompt)
      if (r.ok) pd.ksSecret = random
      else wipeBytes(random)
      return r
    },

    async undoKeystore(ns) {
      const r = await p.biometric.remove(ns)
      await p.vault.setResume(null)
      if (pending?.ns === ns) await dropPending()
      return { orphan: !r.ok }
    },

    async writeVault(ns, input) {
      const pd = needPending(ns)
      if (!pd) return bug('writeVault without reserve')
      if (input.protection.mode !== pd.mode) return bug('protection mode changed after reserve')
      const words = input.mnemonic.reveal() as readonly string[]
      const check = checkWords(words)
      if (!check.ok) return refused(check.code)
      let password: Uint8Array
      if (input.protection.mode === 'biometric-only') {
        if (!pd.ksSecret) return bug('biometric-only vault before the keystore entry')
        password = pd.ksSecret.slice()
      } else {
        const pass = input.protection.passphrase.reveal()
        if (pass.length < 8) return fail({ kind: 'refused', code: 'passphrase-too-short' })
        password = passphraseBytes(pass)
      }
      const rootIkm = rootIkmFromWords(words)
      const dek = p.entropy.bytes(32)
      const inputs: InitInputs = {
        flow: pd.flow,
        profile: input.profile,
        termsVersion: input.termsVersion,
        actIds: { setProfile: p.entropy.uuid(), acceptTerms: p.entropy.uuid() },
      }
      try {
        const init = await sealInit(subtle, p.entropy, dek, ns, inputs)
        const m =
          pd.flow === 'setup'
            ? marker({ flow: 'setup', step: 'holder', ns, mode: pd.mode })
            : marker({ flow: 'restore', step: 'staging', ns, mode: pd.mode, ...(pd.nsOld ? { nsOld: pd.nsOld } : {}) })
        await p.vault.create(ns, { rootIkm, dek }, password, pd.mode, init, m)
      } catch {
        wipeBytes(rootIkm)
        wipeBytes(dek)
        wipeBytes(password)
        return storageError()
      }
      pd.keys = { rootIkm, dek }
      pd.password = password
      return OK
    },

    async undoVault(ns) {
      const pd = needPending(ns)
      let orphan = false
      if (pd?.mode === 'biometric-only' || (await keystoreHas(ns)) === true) orphan = !(await p.biometric.remove(ns)).ok
      await p.vault.wipe(ns)
      await p.vault.setResume(null)
      await dropPending()
      return { orphan }
    },

    async keystoreAfter(ns, prompt) {
      const pd = needPending(ns)
      if (!pd?.password || pd.mode !== 'passphrase+biometric') return { ok: false, code: 'failed' }
      return p.biometric.store(ns, pd.password, prompt)
    },

    async markBioUnusable(ns) {
      await p.vault.setBioUnusable(ns, true)
    },

    async initHolder(nsOrNull) {
      const ns = nsOrNull ?? target
      if (!ns) return LOCKED
      const keys = keysFor(ns)
      if (!keys) return LOCKED
      const sealed = await p.vault.init(ns)
      if (!sealed) return storageError()
      const inputs = await openInit(subtle, keys.dek, ns, sealed)
      if (!inputs) return storageError()
      const g = gen
      const opened = await host.open(ns, keys)
      if (opened === 'other-writer') {
        commit(g, { status: 'other-writer' })
        return fail({ kind: 'unavailable', reason: 'in-flight' })
      }
      if (g !== gen || keysFor(ns) !== keys) {
        await host.close(ns) // locked or switched meanwhile: this holder belongs to no session
        return LOCKED
      }
      if (session?.ns === ns) session.open = true
      await host.init(ns, inputs)
      if (g !== gen) return LOCKED // lock dropped the staged holder during init (publish contract)
      if (inputs.termsVersion) p.prefs.set('terms', inputs.termsVersion)
      return OK
    },

    async activate(nsOrNull) {
      const ns = nsOrNull ?? target
      if (!ns) return LOCKED
      const keys = keysFor(ns)
      if (!keys) return LOCKED
      const g = gen
      await p.vault.activate(ns, null)
      if (g !== gen || keysFor(ns) !== keys) return LOCKED // locked meanwhile: the keys went with pending
      const s =
        session?.ns === ns
          ? session
          : install({
              ns,
              keys,
              proven: (pending?.password ?? pending?.ksSecret)?.slice() ?? new Uint8Array(0),
              provenBy: pending?.mode === 'biometric-only' ? 'keystore' : 'passphrase',
              open: false,
              recovered: null,
            })
      s.open = host.isOpen(ns)
      if (pending?.ns === ns) {
        pending.keys = null // now owned by the session
        await dropPending()
      }
      target = ns
      return publishSession(s)
    },

    async switchTo(ns) {
      const pd = needPending(ns)
      if (!pd?.keys) return LOCKED
      const g = ++gen // late results of the old session are dropped
      if (session && session.ns !== ns) await closeSession() // rec.quiesce: S1, S2, S4, S5 of the old holder only
      await p.vault.activate(ns, marker({ flow: 'restore', step: 'switched', ns, ...(pd.nsOld ? { nsOld: pd.nsOld } : {}) }))
      if (g !== gen || pending !== pd) return LOCKED // locked meanwhile: lock dropped pd with its holder
      const keys = pd.keys
      if (!keys) return LOCKED
      install({
        ns,
        keys,
        proven: (pd.password ?? pd.ksSecret)?.slice() ?? new Uint8Array(0),
        provenBy: pd.mode === 'biometric-only' ? 'keystore' : 'passphrase',
        open: host.isOpen(ns),
        recovered: 'keys-only',
      })
      pd.keys = null
      await dropPending()
      target = ns
      return OK
    },

    async wipeOld() {
      const m = await p.vault.resume()
      if (m?.flow !== 'restore' || m.step !== 'switched') return bug('wipeOld without marker restore/switched')
      oldVerdict = 'unknown'
      if (m.nsOld) await wipeNamespace(m.nsOld)
      return OK
    },

    async verifyOld(): Promise<VerifyOutcome> {
      const m = await p.vault.resume()
      oldVerdict = 'unknown'
      survivors = m?.nsOld ? await verifyNamespace(m.nsOld) : []
      oldVerdict = survivors.length === 0 ? 'clean' : 'survivors'
      return survivors.length === 0 ? { ok: true } : { ok: false, survivors }
    },

    async finishRestore() {
      if (oldVerdict === 'clean') await p.vault.setResume(null)
      if (session) await publishSession(session)
    },
  }

  // ── unlock ────────────────────────────────────────────────────────────────

  const unlock: IdentityCommands['unlock'] = {
    async biometric(prompt): Promise<BiometricUnlockOutcome> {
      if (!target) return { ok: false, code: 'missing' }
      const g = gen
      const ns = target
      const r = await p.biometric.retrieve(ns, prompt)
      if (g !== gen) {
        if (r.ok) wipeBytes(r.secret)
        return { ok: false, code: 'failed' }
      }
      if (!r.ok) {
        if (r.code === 'invalidated' || r.code === 'missing') retrieveReport = r.code
        return r
      }
      const keys = await p.vault.open(ns, r.secret)
      if (g !== gen) {
        wipeKeys(keys)
        wipeBytes(r.secret)
        return { ok: false, code: 'failed' }
      }
      if (!keys) {
        retrieveReport = 'mismatch'
        wipeBytes(r.secret)
        return { ok: false, code: 'vault-mismatch' }
      }
      await closeSession()
      if (g !== gen) {
        wipeKeys(keys)
        wipeBytes(r.secret)
        return { ok: false, code: 'failed' }
      }
      install({ ns, keys, proven: r.secret, provenBy: 'keystore', open: false, recovered: null })
      return { ok: true }
    },

    async passphrase(pass) {
      if (!target) return LOCKED
      const g = gen
      const ns = target
      const bytes = passphraseBytes(pass.reveal())
      const keys = await p.vault.open(ns, bytes)
      if (g !== gen) {
        wipeKeys(keys)
        wipeBytes(bytes)
        return LOCKED
      }
      if (!keys) {
        wipeBytes(bytes)
        return refused('passphrase-wrong')
      }
      await closeSession()
      if (g !== gen) {
        wipeKeys(keys)
        wipeBytes(bytes)
        return LOCKED
      }
      install({ ns, keys, proven: bytes, provenBy: 'passphrase', open: false, recovered: null })
      return OK
    },

    async markBioUnusable() {
      if (target) await p.vault.setBioUnusable(target, true)
    },

    async open() {
      const s = session
      if (!s) return LOCKED
      const g = gen
      const r = await host.open(s.ns, s.keys)
      if (g !== gen || session !== s) {
        if (r === 'ok') await host.close(s.ns) // lock() ran meanwhile: never back into a session
        return LOCKED
      }
      if (r === 'other-writer') {
        commit(g, { status: 'other-writer' })
        return { ok: false, error: { kind: 'unavailable', reason: 'in-flight', otherWriter: true } }
      }
      s.open = true
      return publishSession(s)
    },

    async reprotect() {
      const s = session
      if (!s || s.provenBy !== 'passphrase') return LOCKED
      // the hint field alone never lowers the protection (N8): only a report of this session counts
      if (retrieveReport !== 'invalidated' && retrieveReport !== 'missing') return bug('reprotect without keystore report')
      if (!(await p.vault.setProtection(s.ns, 'passphrase', s.proven))) return storageError()
      await p.biometric.remove(s.ns)
      await p.vault.setBioUnusable(s.ns, false)
      retrieveReport = null
      return publishSession(s)
    },

    async restoreKeystore(prompt): Promise<KeystoreOutcome> {
      const s = session
      if (!s || s.provenBy !== 'passphrase' || retrieveReport !== 'mismatch') return { ok: false, code: 'failed' }
      const r = await p.biometric.store(s.ns, s.proven, prompt)
      if (r.ok) {
        await p.vault.setBioUnusable(s.ns, false)
        retrieveReport = null
      }
      return r
    },

    async enableBiometric(prompt): Promise<KeystoreOutcome> {
      const s = session
      if (!s || s.provenBy !== 'passphrase') return { ok: false, code: 'failed' }
      const r = await p.biometric.store(s.ns, s.proven, prompt)
      if (!r.ok) return r
      if (!(await p.vault.setProtection(s.ns, 'passphrase+biometric', s.proven))) return { ok: false, code: 'failed' }
      return (await publishSession(s)).ok ? r : { ok: false, code: 'failed' }
    },

    async dismissBiometricOffer() {
      const ns = session?.ns ?? target
      if (ns) p.prefs.set(`${nsPrefs(ns)}bio-offer-dismissed`, '1')
    },
  }

  // ── change protection ─────────────────────────────────────────────────────

  const headMode = async (s: Session): Promise<ProtectionMode | null> => (await p.vault.head(s.ns))?.protection ?? null

  const protection: IdentityCommands['protection'] = {
    async prove(current) {
      if (!session) return LOCKED
      const s = session
      const g = gen
      if ('passphrase' in current) {
        const bytes = passphraseBytes(current.passphrase.reveal())
        const opened = await p.vault.open(s.ns, bytes)
        wipeKeys(opened) // only the proof counts; the keys of the session stay the session's
        if (!opened || g !== gen || session !== s) {
          wipeBytes(bytes)
          return opened ? LOCKED : refused('passphrase-wrong')
        }
        wipeBytes(s.proven)
        s.proven = bytes
        s.provenBy = 'passphrase'
        return OK
      }
      const r = await p.biometric.retrieve(s.ns, current.biometric)
      if (!r.ok) {
        const code = r.code === 'cancelled' ? 'biometric-cancelled' : r.code === 'invalidated' ? 'biometric-invalidated' : 'biometric-unavailable'
        return fail({ kind: 'platform', code })
      }
      const opened = await p.vault.open(s.ns, r.secret)
      wipeKeys(opened)
      if (!opened || g !== gen || session !== s) {
        wipeBytes(r.secret)
        return opened ? LOCKED : refused('passphrase-wrong')
      }
      wipeBytes(s.proven)
      s.proven = r.secret
      s.provenBy = 'keystore'
      return OK
    },

    async keystoreStore(prompt) {
      const s = session
      if (!s) return { ok: false, code: 'failed' }
      if ((await headMode(s)) === 'biometric-only') return { ok: false, code: 'failed' } // rewrap first
      return p.biometric.store(s.ns, s.proven, prompt)
    },

    async setHead(mode) {
      const s = session
      if (!s) return LOCKED
      if ((await headMode(s)) === 'biometric-only') return refused('last-access') // the password is the random secret
      if (!(await p.vault.setProtection(s.ns, mode, s.proven))) return refused('passphrase-wrong')
      return publishSession(s)
    },

    async rewrap(pass) {
      const s = session
      if (!s) return LOCKED
      const raw = pass.reveal()
      if (raw.length < 8) return fail({ kind: 'refused', code: 'passphrase-too-short' })
      const next = passphraseBytes(raw)
      if (!(await p.vault.rewrap(s.ns, s.proven, next, 'passphrase+biometric'))) {
        wipeBytes(next)
        return refused('passphrase-wrong')
      }
      wipeBytes(s.proven)
      s.proven = next
      s.provenBy = 'passphrase'
      return publishSession(s)
    },

    async keystoreRemove() {
      const s = session
      if (!s) return LOCKED
      if ((await headMode(s)) !== 'passphrase') return refused('last-access') // the keystore is still the (or a) way in
      const r = await p.biometric.remove(s.ns)
      return r.ok ? OK : fail({ kind: 'platform', code: 'biometric-unavailable' })
    },
  }

  // ── delete (S1 to S6) ─────────────────────────────────────────────────────

  const delMarker = (step: string) => {
    const ns = deleteNs ?? session?.ns ?? target
    return ns ? p.vault.setResume(marker({ flow: 'wipe', step, ns })) : Promise.resolve()
  }

  const del: IdentityCommands['delete'] = {
    async quiesce() {
      gen++ // S1: no late unlock or open of an older generation lands after this
      deleteNs = deleteNs ?? session?.ns ?? target ?? (await p.vault.active())
      if (!deleteNs) return bug('nothing to delete')
      remote = { done: 0, failed: 0 }
      deleteVerdict = 'unknown'
      await delMarker('quiescing')
      if (host.isOpen(deleteNs)) await host.quiesce(deleteNs)
      return OK
    },
    async deregister(mode) {
      await delMarker('deregistering')
      remote = deleteNs && host.isOpen(deleteNs) ? await host.deregister(deleteNs, mode) : { done: 0, failed: 0 }
      return remote
    },
    async seal() {
      if (deleteNs && host.isOpen(deleteNs)) await host.seal(deleteNs)
      await delMarker('sealed')
      return OK
    },
    async close() {
      if (deleteNs && host.isOpen(deleteNs)) await host.close(deleteNs)
      if (session) {
        wipeBytes(session.keys.rootIkm)
        wipeBytes(session.keys.dek)
        wipeBytes(session.proven)
        session = null
      }
      return OK
    },
    async wipe() {
      const ns = deleteNs
      if (!ns) return bug('delete.wipe without quiesce')
      deleteVerdict = 'unknown'
      await wipeNamespace(ns)
      // global layers, only for a full delete (9 to 13)
      for (const k of p.prefs.keys()) p.prefs.remove(k)
      await p.session.wipe()
      await p.notifications.cancelNamespace(ns)
      for (const n of await p.notifications.list()) if (n.ns !== null) await p.notifications.removeDelivered(n.ns)
      await p.notifications.removeDelivered('all')
      if (p.clipboard.holdsAppCopy()) await p.clipboard.clear()
      await orphans([])
      return OK
    },
    async verify(): Promise<VerifyOutcome> {
      deleteVerdict = 'unknown'
      const ns = deleteNs
      if (!ns) return { ok: false, survivors: ['no identity to verify'] }
      const out = await verifyNamespace(ns)
      for (const k of p.prefs.keys()) out.push(`prefs:${k}`)
      out.push(...(await p.session.survivors()))
      if (!(await p.notifications.verifyNone('all'))) out.push('notifications')
      for (const other of await p.vault.namespaces()) out.push(`vault:${other}`)
      survivors = [...new Set(out)]
      deleteVerdict = survivors.length === 0 ? 'clean' : 'survivors'
      return survivors.length === 0 ? { ok: true } : { ok: false, survivors }
    },
    async finish(): Promise<WipeReport> {
      const local: WipeReport['local'] =
        deleteVerdict === 'clean'
          ? { ok: true }
          : { ok: false, survivors: deleteVerdict === 'survivors' ? survivors : ['verification did not complete'] }
      if (deleteVerdict === 'clean') {
        await p.vault.setResume(null) // the marker is the last write
        deleteNs = null
        target = null
        state.set({ status: 'none', hint: null }) // verified gone: true in every generation
      }
      return { local, remote: { done: remote.done, pending: 0, failed: remote.failed } }
    },
  }

  // ── Gen-2 reset ───────────────────────────────────────────────────────────

  const legacy: IdentityCommands['legacy'] = {
    async wipe() {
      legacyVerdict = 'unknown'
      await p.vault.setResume(marker({ flow: 'legacy-wipe', step: 'wiping', ns: 'gen2' }))
      await p.legacy.wipe()
      await p.biometric.removeLegacy()
      return OK
    },
    async verify() {
      const out = [...(await p.legacy.survivors())]
      try {
        if (await p.biometric.hasLegacy()) out.push('keystore:wot_biometric_key')
      } catch {
        out.push('keystore:wot_biometric_key (not verifiable)')
      }
      survivors = out
      legacyVerdict = out.length === 0 ? 'clean' : 'survivors'
      return out.length === 0 ? { ok: true } : { ok: false, survivors: out }
    },
    async mark() {
      if (legacyVerdict === 'clean') await p.vault.setResume(null)
      await boot()
    },
  }

  return {
    state,
    boot,
    lastSurvivors: () => survivors,
    async generate() {
      return { ok: true, value: secret(generateWords(p.entropy) as unknown as Mnemonic) }
    },
    checkMnemonic(words) {
      const r = checkWords(words)
      return r.ok ? { ok: true, value: { length: r.length } } : refused(r.code)
    },
    async biometricAvailability() {
      const a = await p.biometric.availability()
      return a.kind === 'available' ? a.type : null
    },
    termsConsent: () => ({ current: TERMS_VERSION, valid: p.prefs.get('terms') === TERMS_VERSION }),
    async acceptTerms(version) {
      const s = session
      if (!s?.open) return LOCKED
      await host.acceptTerms(s.ns, version, p.entropy.uuid())
      p.prefs.set('terms', version)
      return publishSession(s)
    },
    async refresh() {
      await boot()
    },
    async lock() {
      const g = ++gen // synchronously: an unlock or open still running belongs to the old generation
      const ns = session?.ns ?? target
      await closeSession()
      await dropPending() // the staged holder of a setup or restore is part of what lock closes
      retrieveReport = null
      if (ns && (await p.vault.active()) === ns) await setLocked(g, ns)
    },
    setup,
    unlock,
    protection,
    delete: del,
    legacy,
  }
}
