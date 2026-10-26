// Identity runtime under the port (architecture §4.2, §5, §5.1, §5.2), shared by both adapters:
// boot reconciliation after the boot matrix, the setup and restore steps, unlock with its repairs,
// protection change, delete (S1 to S6 with the wipe inventory) and the Gen-2 reset. Each port step
// is one effect of a flow table and one transition of the coordinator (lifecycle.ts); everything it
// holds belongs to a lease of the register (resources.ts). LIFECYCLE.md states the contract. Words
// and passphrases come in as Secret and are revealed only to derive bytes.
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
import type { HolderHandle, HolderHost, HolderKeys } from './host'
import { bootMatrix } from './boot-matrix'
import { createInventory, nsPrefs } from './inventory'
import { createLifecycle, type Ticket, type TransitionKind } from './lifecycle'
import { checkWords, generateWords, rootIkmFromWords } from './mnemonic'
import { createResources, type Lease } from './resources'
import { openInit, sealInit, type InitInputs } from './sealed-init'

/** Version of the content rules a consent refers to (architecture §10, Frage 10: text still open). */
export const TERMS_VERSION = '2026-10-draft'

const OK: Result = Object.freeze({ ok: true, value: undefined })
const fail = (error: Extract<Result, { ok: false }>['error']): Result<never> => ({ ok: false, error })
const refused = (code: 'passphrase-wrong' | 'last-access' | 'mnemonic-invalid' | 'mnemonic-checksum') =>
  fail({ kind: 'refused', code })
const LOCKED = fail({ kind: 'locked' })
/** another transition holds the lane (LIFECYCLE.md "Coordinator") */
const BUSY = fail({ kind: 'unavailable', reason: 'in-flight' })
const bug = (message: string) => fail({ kind: 'bug', message })
const storageError = () => fail({ kind: 'infra', code: 'storage', retryable: true })
const GONE = Symbol('gone')
const NO = Object.freeze({ ok: false, code: 'failed' } as const)
const RESULT = { busy: BUSY, stale: LOCKED }
const OUTCOME = { busy: NO, stale: NO }
const NOTHING = { busy: undefined, stale: undefined }
/** steps without a secret argument: a second request while one runs gets the same promise */
const JOINABLE = new Set(['setup.activate', 'setup.switchTo', 'setup.finishRestore', 'unlock.open', 'delete.quiesce', 'delete.deregister', 'delete.seal', 'delete.close', 'delete.wipe'])
const SURVIVORS_UNKNOWN = { busy: { ok: false, survivors: ['in-flight'] }, stale: { ok: false, survivors: ['in-flight'] } } as const
/** transitions a lock joins instead of ending them: they leave no session behind */
const BOOTS = new Set(['boot', 'legacy.mark'])

const utf8 = new TextEncoder()
const passphraseBytes = (p: string) => utf8.encode(p.normalize('NFC'))
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('')
const wipeKeys = (k: HolderKeys | null | undefined) => {
  k?.rootIkm.fill(0)
  k?.dek.fill(0)
}

interface Pending {
  readonly flow: 'setup' | 'restore'
  readonly ns: string
  readonly mode: ProtectionMode
  readonly nsOld: string | null
  /** owns the bytes below and the holder initHolder staged, until activate or switchTo hand them over */
  readonly lease: Lease
  ksSecret: Uint8Array | null
  keys: HolderKeys | null
  password: Uint8Array | null
}

interface Session {
  readonly ns: string
  /** owns keys, proven and the opening of the holder */
  readonly lease: Lease
  readonly keys: HolderKeys
  /** the vault password proven in this session (passphrase bytes or the keystore secret) */
  proven: Uint8Array
  provenBy: 'passphrase' | 'keystore'
  recovered: 'full' | 'keys-only' | null
  /** delete S1: this session publishes nothing any more */
  frozen: boolean
}

/** one holder opening of the register (diagnostics and the interleaving test) */
export interface InventoryEntry {
  readonly ns: string
  readonly state: 'active' | 'closing' | 'closed'
  readonly owner: 'session' | 'pending' | null
  readonly handle: HolderHandle
}

export interface IdentityRuntime extends IdentityCommands {
  readonly state: ReadStore<IdentityState>
  /** the boot reconciliation (architecture §4.2 boot matrix); idempotent */
  boot(): Promise<IdentityState>
  /** layers that survived the last namespace verification (diagnostics in tests and the harness) */
  lastSurvivors(): readonly string[]
  /** the openings of the register that are not closed yet */
  inventory(): readonly InventoryEntry[]
}

export function createIdentityRuntime(p: IdentityPlatform, host: HolderHost, opts: { subtle?: SubtleCrypto } = {}): IdentityRuntime {
  const subtle = opts.subtle ?? globalThis.crypto.subtle
  const state = writableStore<IdentityState>({ status: 'booting' })
  const life = createLifecycle()
  const res = createResources(host)
  const inv = createInventory(p, host)
  let pending: Pending | null = null
  let session: Session | null = null
  /** set when retrieve reported invalidated/missing, or returned a secret the vault rejected (N8) */
  let retrieveReport: 'invalidated' | 'missing' | 'mismatch' | null = null
  /** namespace of the identity being unlocked: the active one, or the one of an interrupted setup */
  let target: string | null = null
  let survivors: readonly string[] = []
  let remote = { done: 0, failed: 0 }
  let deleteNs: string | null = null
  /** Verdicts of the last verification of this run. Success needs a positive verdict, never the
   *  absence of survivors in a variable nobody refreshed. */
  let deleteVerdict: 'unknown' | 'clean' | 'survivors' = 'unknown'
  let oldVerdict: 'unknown' | 'clean' | 'survivors' = 'unknown'
  let legacyVerdict: 'unknown' | 'clean' | 'survivors' = 'unknown'
  const lockInfos = new Map<string, LockInfo>()

  const marker = (m: Omit<ResumeMarker, 'startedAt'>): ResumeMarker => ({ ...m, startedAt: p.clock.now() })

  /** one port step as a transition; `own` holds what the step acquires until it hands it over */
  const step = <R>(key: string, kind: TransitionKind, refuse: { busy: R; stale: R }, body: (t: Ticket, own: Lease) => Promise<R>) =>
    life.run({ key, kind, join: JOINABLE.has(key.split(':')[0] ?? '') }, refuse, async (t) => {
      const own = res.lease(key, 'call')
      try {
        return await body(t, own)
      } finally {
        void res.release(own)
      }
    })

  // ── state ─────────────────────────────────────────────────────────────────

  const commit = (t: Ticket, next: IdentityState): IdentityState => {
    if (life.live(t)) state.set(next)
    return state.get()
  }

  const lockInfo = async (ns: string): Promise<LockInfo> => {
    const info = await inv.lockInfo(ns)
    lockInfos.set(ns, info)
    return info
  }

  /** the locked state of ns from what is known now, without an await (lock is synchronous) */
  const lockedNow = (ns: string): IdentityState => {
    const cur = state.get()
    const known = lockInfos.get(ns)
    const protection = cur.status === 'unlocked' ? cur.protection : (known?.protection ?? 'passphrase')
    const biometric = cur.status === 'unlocked' ? cur.biometric : (known?.biometric ?? null)
    return {
      status: 'locked',
      protection,
      biometric,
      biometricLost: known?.biometricLost ?? false,
      bioUnusable: known?.bioUnusable ?? false,
      unsupported: false,
      offerBiometric: inv.offer(ns, protection, biometric),
    }
  }

  /** unlocked (or other-writer) without the open holder of a live session becomes locked at once */
  const lockIfOrphaned = (ns: string | null) => {
    const st = state.get().status
    if (!ns || (st !== 'unlocked' && st !== 'other-writer')) return
    if (st === 'unlocked' && session && !session.frozen && session.lease.holder?.state === 'active') return
    state.set(lockedNow(ns))
  }

  /** Publishes the session after a step: unlocked if it owns an open holder. OK only if the session
   *  is still the live one at the commit, after the last await; otherwise LOCKED, never success. */
  const publish = async (t: Ticket, s: Session): Promise<Result> => {
    const live = () => life.live(t) && session === s && !s.frozen
    if (!live()) return LOCKED
    if (!s.lease.holder) return OK
    const head = await p.vault.head(s.ns)
    const avail = await p.biometric.availability()
    if (!live() || s.lease.holder?.state !== 'active') return LOCKED
    // the identity in use: its opening takes commands, publishes, receives (HolderHost.activate); a
    // delete in progress never activates (dereg-only)
    if (deleteNs !== s.ns && s.lease.holder) host.activate?.(s.lease.holder.handle)
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

  /** A platform write of a session transition (LIFECYCLE.md "Effects"): it starts only while the
   *  ticket is current and the lease it acts for is held. Checked before the write, because a stale
   *  result after it would not take the write back. GONE: not started. */
  const effect = <T>(t: Ticket, lease: Lease | null, write: () => Promise<T>): Promise<T | typeof GONE> =>
    life.live(t) && !lease?.released ? write() : Promise.resolve(GONE)

  /** the write gets a copy of the session's proven bytes, overwritten when it returns; a lock that
   *  wipes the session meanwhile cannot change what the write uses */
  const withProven = async <T>(s: Session, write: (proven: Uint8Array) => Promise<T>): Promise<T> => {
    const b = s.proven.slice()
    try {
      return await write(b)
    } finally {
      b.fill(0)
    }
  }

  // ── ownership ─────────────────────────────────────────────────────────────

  const dropSession = (): Promise<boolean> => {
    const s = session
    session = null
    return s ? res.release(s.lease) : Promise.resolve(true)
  }

  const dropPending = (): Promise<boolean> => {
    const pd = pending
    pending = null
    return pd ? res.release(pd.lease) : Promise.resolve(true)
  }

  /** a step that ends the session outside lock: without delete S1 it is a lock (the state follows);
   *  after S1 the delete owns the screen */
  const endSession = (): Promise<boolean> => {
    const ns = session && !session.frozen ? session.ns : null
    const closing = dropSession()
    lockIfOrphaned(ns)
    return closing
  }

  /** S1 of lock and boot, synchronous: end the epoch, detach session and pending */
  const revoke = (): Promise<boolean>[] => {
    life.preempt()
    retrieveReport = null
    // no opening stays in use past this line: commands, publications and reception end now, only
    // drain and cleanup wait behind running work (review 420 R5-1)
    host.deactivate?.()
    return [dropSession(), dropPending()]
  }

  /** installs a session from what `from` owns; a session it replaces is released */
  const install = (t: Ticket, from: Lease, s: Omit<Session, 'lease' | 'frozen'>): Session | null => {
    if (!life.live(t) || from.released) return null
    const lease = res.lease(s.ns, 'session')
    if (!res.move(from, lease)) return null
    void dropSession()
    session = { ...s, lease, frozen: false }
    lockIfOrphaned(s.ns)
    return session
  }

  /** opens the holder for `lease`; an opening that arrives after the lease was released is closed */
  const openHolder = async (t: Ticket, lease: Lease, keys: HolderKeys): Promise<Result<void, { otherWriter: true }>> => {
    await res.settled(lease.ns)
    if (lease.released) return LOCKED
    // a delete in progress opens the holder only to deregister (§2.1 rule 9 S3, review 420 R5-2)
    const r = await host.open(lease.ns, keys, { mode: deleteNs === lease.ns ? 'dereg-only' : 'normal' })
    if (r.kind === 'other-writer') {
      commit(t, { status: 'other-writer' })
      return { ok: false, error: { kind: 'unavailable', reason: 'in-flight', otherWriter: true } }
    }
    if (r.kind === 'state-unreadable') return fail({ kind: 'state-unreadable', cause: r.cause })
    return res.adopt(lease, r.holder) && life.live(t) ? OK : LOCKED
  }

  // ── wipe inventory ────────────────────────────────────────────────────────

  /** wipeNamespace(ns): its session and openings first, then layers 1 to 7 (N6) */
  const wipeNamespace = async (ns: string): Promise<void> => {
    if (session?.ns === ns) await endSession()
    await res.retry(ns)
    await inv.wipeNamespace(ns)
  }

  const orphans = async (keep: readonly (string | null | undefined)[]): Promise<void> => {
    for (const ns of await inv.known()) if (!keep.includes(ns)) await wipeNamespace(ns)
  }

  // ── boot (architecture §4.2 boot matrix) ──────────────────────────────────

  const reconcile = async (t: Ticket, released: readonly Promise<boolean>[]): Promise<IdentityState> => {
    const set = (next: IdentityState) => commit(t, next)
    const locked = async (ns: string) => {
      const next: IdentityState = { status: 'locked', ...(await lockInfo(ns)) }
      if (life.live(t)) target = ns
      return set(next)
    }
    await Promise.all([...released, res.retry()])
    retrieveReport = null
    set({ status: 'booting' })
    return bootMatrix({
      p,
      inv,
      set,
      locked,
      lockInfo,
      wipeNamespace,
      orphans,
      target: (ns) => void (target = ns),
      resumeDelete: (ns) => void (deleteNs = ns),
      survivors: (out) => void (survivors = out),
    })
  }

  const boot = (): Promise<IdentityState> => {
    const running = life.joinable('boot')
    if (running) return running as Promise<IdentityState>
    const released = revoke()
    state.set({ status: 'booting' })
    const now = { busy: state.get(), stale: state.get() }
    return life.run({ key: 'boot', kind: 'storage', join: true, queue: true }, now, (t) => reconcile(t, released))
  }

  // ── setup and restore ─────────────────────────────────────────────────────

  const needPending = (ns: IdentityNs): Pending | null => (pending?.ns === ns ? pending : null)

  /** who owns the keys (and so the holder) of ns: the pending setup or restore, else the session */
  const ownerOf = (ns: string): Pending | Session | null => {
    if (pending?.ns === ns && pending.keys) return pending
    if (session?.ns === ns) return session
    return null
  }

  /** the session a pending setup or restore becomes; pending is gone afterwards */
  const handOver = (t: Ticket, pd: Pending, recovered: Session['recovered']): Session | null => {
    if (pending === pd) pending = null
    const s = pd.keys
      ? install(t, pd.lease, {
          ns: pd.ns,
          keys: pd.keys,
          proven: pd.password ?? pd.ksSecret ?? new Uint8Array(0),
          provenBy: pd.mode === 'biometric-only' ? 'keystore' : 'passphrase',
          recovered,
        })
      : null
    void res.release(pd.lease) // what was not handed over
    return s
  }

  const setup: IdentityCommands['setup'] = {
    reserve: (flow, mode) =>
      step<Result<{ ns: IdentityNs }>>('setup.reserve', 'storage', RESULT, async () => {
        await dropPending()
        const ns = `n${hex(p.entropy.bytes(8))}`
        const active = await p.vault.active()
        const nsOld = flow === 'restore' ? active : null
        if (flow === 'setup' && mode === 'biometric-only') await p.vault.setResume(marker({ flow: 'setup', step: 'keystore', ns, mode }))
        if (flow === 'restore') await p.vault.setResume(marker({ flow: 'restore', step: 'staging', ns, mode, ...(nsOld ? { nsOld } : {}) }))
        pending = { flow, ns, mode, nsOld, lease: res.lease(ns, 'pending'), ksSecret: null, keys: null, password: null }
        return { ok: true, value: { ns: ns as IdentityNs } }
      }),

    keystoreFirst: (ns, prompt) =>
      step<KeystoreOutcome>('setup.keystoreFirst', 'storage', OUTCOME, async (_t, own) => {
        const pd = needPending(ns)
        if (!pd || pd.mode !== 'biometric-only') return NO
        const random = p.entropy.bytes(32)
        res.keep(own, random)
        const r = await p.biometric.store(ns, random, prompt)
        if (!r.ok) return r
        if (pending !== pd || !res.move(own, pd.lease)) return NO
        pd.ksSecret = random
        return r
      }),

    undoKeystore: (ns) =>
      step('setup.undoKeystore', 'storage', { busy: { orphan: true }, stale: { orphan: true } }, async () => {
        const r = await p.biometric.remove(ns)
        await p.vault.setResume(null)
        if (pending?.ns === ns) await dropPending()
        return { orphan: !r.ok }
      }),

    writeVault: (ns, input) =>
      step('setup.writeVault', 'storage', RESULT, async (_t, own) => {
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
        res.keep(own, password, rootIkm, dek)
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
          return storageError()
        }
        if (pending !== pd || !res.move(own, pd.lease)) return LOCKED
        pd.keys = { rootIkm, dek }
        pd.password = password
        return OK
      }),

    undoVault: (ns) =>
      step('setup.undoVault', 'storage', { busy: { orphan: true }, stale: { orphan: true } }, async () => {
        const pd = needPending(ns)
        let orphan = false
        if (pd?.mode === 'biometric-only' || (await inv.keystoreHas(ns)) === true) orphan = !(await p.biometric.remove(ns)).ok
        await p.vault.wipe(ns)
        await p.vault.setResume(null)
        await dropPending()
        return { orphan }
      }),

    keystoreAfter: (ns, prompt) =>
      step<KeystoreOutcome>('setup.keystoreAfter', 'storage', OUTCOME, async () => {
        const pd = needPending(ns)
        if (!pd?.password || pd.mode !== 'passphrase+biometric') return NO
        return p.biometric.store(ns, pd.password, prompt)
      }),

    markBioUnusable: (ns) => step('setup.markBioUnusable', 'storage', NOTHING, () => p.vault.setBioUnusable(ns, true)),

    initHolder: (nsOrNull) =>
      step('setup.initHolder', 'session', RESULT, async (t) => {
        const ns = nsOrNull ?? target
        const owner = ns ? ownerOf(ns) : null
        const keys = owner?.keys
        if (!ns || !owner || !keys) return LOCKED
        const sealed = await p.vault.init(ns)
        if (!sealed) return storageError()
        const inputs = await openInit(subtle, keys.dek, ns, sealed)
        if (!inputs) return storageError()
        if (!owner.lease.holder) {
          const o = await openHolder(t, owner.lease, keys)
          if (!o.ok) return o.error.kind === 'unavailable' ? fail({ kind: 'unavailable', reason: 'in-flight' }) : o
        }
        const h = owner.lease.holder
        if (!h || !life.live(t)) return LOCKED
        await res.use(h, (x) => host.init(x, inputs))
        if (owner.lease.holder !== h || !life.live(t)) return LOCKED
        if (inputs.termsVersion) p.prefs.set('terms', inputs.termsVersion)
        return OK
      }),

    activate: (nsOrNull) =>
      step(`setup.activate:${nsOrNull ?? ''}`, 'session', RESULT, async (t) => {
        const ns = nsOrNull ?? target
        const pd = ns && pending?.ns === ns && pending.keys ? pending : null
        const owner = pd ?? (session?.ns === ns ? session : null)
        if (!ns || !owner) return LOCKED
        if ((await effect(t, owner.lease, () => p.vault.activate(ns, null))) === GONE) return LOCKED
        const s = session?.ns === ns ? session : pd ? handOver(t, pd, null) : null
        if (pd && pending === pd) void dropPending() // resume of a setup: the session already owns ns
        if (!s) return LOCKED
        target = ns
        return publish(t, s)
      }),

    switchTo: (ns) =>
      step(`setup.switchTo:${ns}`, 'session', RESULT, async (t) => {
        const pd = needPending(ns)
        if (!pd?.keys) return LOCKED
        // rec.quiesce: S1, S2, S4 of the old holder only; S5 right after the switch
        const old = session && session.ns !== ns ? session.lease.holder : null
        if (old && !((await res.phase(old, 'quiesce')) && (await res.phase(old, 'seal')))) return storageError()
        const switched = marker({ flow: 'restore', step: 'switched', ns, ...(pd.nsOld ? { nsOld: pd.nsOld } : {}) })
        if ((await effect(t, pd.lease, () => p.vault.activate(ns, switched))) === GONE) return LOCKED
        if (!life.live(t) || pending !== pd) return LOCKED
        const closing = dropSession()
        const s = handOver(t, pd, 'keys-only')
        if (!s) return LOCKED
        target = ns
        await closing
        return OK
      }),

    wipeOld: () =>
      step('setup.wipeOld', 'storage', RESULT, async () => {
        const m = await p.vault.resume()
        if (m?.flow !== 'restore' || m.step !== 'switched') return bug('wipeOld without marker restore/switched')
        oldVerdict = 'unknown'
        if (m.nsOld) await wipeNamespace(m.nsOld)
        return OK
      }),

    verifyOld: () =>
      step<VerifyOutcome>('setup.verifyOld', 'storage', SURVIVORS_UNKNOWN, async () => {
        const m = await p.vault.resume()
        oldVerdict = 'unknown'
        survivors = m?.nsOld ? await inv.verifyNamespace(m.nsOld) : []
        oldVerdict = survivors.length === 0 ? 'clean' : 'survivors'
        return survivors.length === 0 ? { ok: true } : { ok: false, survivors }
      }),

    finishRestore: () =>
      step('setup.finishRestore', 'session', RESULT, async (t) => {
        // the restored identity is in use first (publish activates its opening); the marker goes only
        // afterwards, so a failed removal leaves a usable identity and a marker the next start
        // finishes again, never a finished flow without an active opening (review 420 R6-2). A failed
        // removal is visible: the flow shows "almost done" with a retry, never "done" (20.10.)
        if (!session) return LOCKED
        const r = await publish(t, session)
        if (!r.ok) return r
        if (oldVerdict !== 'clean') return OK
        try {
          if ((await effect(t, null, () => p.vault.setResume(null))) === GONE) return LOCKED
        } catch {
          return storageError()
        }
        return OK
      }),
  }

  // ── unlock ────────────────────────────────────────────────────────────────

  const unlock: IdentityCommands['unlock'] = {
    biometric: (prompt) =>
      step<BiometricUnlockOutcome>('unlock.biometric', 'session', OUTCOME, async (t, own) => {
        if (!target) return { ok: false, code: 'missing' }
        const ns = target
        const r = await p.biometric.retrieve(ns, prompt)
        if (!r.ok) {
          if (life.live(t) && (r.code === 'invalidated' || r.code === 'missing')) retrieveReport = r.code
          return r
        }
        res.keep(own, r.secret)
        const keys = await p.vault.open(ns, r.secret)
        if (keys) res.keep(own, keys.rootIkm, keys.dek)
        if (!life.live(t)) return NO
        if (!keys) {
          retrieveReport = 'mismatch'
          return { ok: false, code: 'vault-mismatch' }
        }
        return install(t, own, { ns, keys, proven: r.secret, provenBy: 'keystore', recovered: null }) ? { ok: true } : NO
      }),

    passphrase: (pass) =>
      step('unlock.passphrase', 'session', RESULT, async (t, own) => {
        if (!target) return LOCKED
        const ns = target
        const bytes = passphraseBytes(pass.reveal())
        res.keep(own, bytes)
        const keys = await p.vault.open(ns, bytes)
        if (keys) res.keep(own, keys.rootIkm, keys.dek)
        if (!life.live(t)) return LOCKED
        if (!keys) return refused('passphrase-wrong')
        return install(t, own, { ns, keys, proven: bytes, provenBy: 'passphrase', recovered: null }) ? OK : LOCKED
      }),

    markBioUnusable: () => step('unlock.markBioUnusable', 'storage', NOTHING, async () => void (target && (await p.vault.setBioUnusable(target, true)))),

    open: () =>
      step('unlock.open', 'session', RESULT, async (t) => {
        const s = session
        if (!s || s.frozen) return LOCKED
        if (!s.lease.holder) {
          const o = await openHolder(t, s.lease, s.keys)
          if (!o.ok) return o
        }
        return publish(t, s)
      }),

    reprotect: () =>
      step('unlock.reprotect', 'session', RESULT, async (t) => {
        const s = session
        if (!s || s.provenBy !== 'passphrase') return LOCKED
        // the hint field alone never lowers the protection (N8): only a report of this session counts
        if (retrieveReport !== 'invalidated' && retrieveReport !== 'missing') return bug('reprotect without keystore report')
        const set = await effect(t, s.lease, () => withProven(s, (pw) => p.vault.setProtection(s.ns, 'passphrase', pw)))
        if (set === GONE) return LOCKED
        if (!set) return storageError()
        if ((await effect(t, s.lease, () => p.biometric.remove(s.ns))) === GONE) return LOCKED
        if ((await effect(t, s.lease, () => p.vault.setBioUnusable(s.ns, false))) === GONE) return LOCKED
        retrieveReport = null
        return publish(t, s)
      }),

    restoreKeystore: (prompt) =>
      step<KeystoreOutcome>('unlock.restoreKeystore', 'session', OUTCOME, async (t) => {
        const s = session
        if (!s || s.provenBy !== 'passphrase' || retrieveReport !== 'mismatch') return NO
        const r = await effect(t, s.lease, () => withProven(s, (pw) => p.biometric.store(s.ns, pw, prompt)))
        if (r === GONE || !r.ok) return r === GONE ? NO : r
        if ((await effect(t, s.lease, () => p.vault.setBioUnusable(s.ns, false))) === GONE) return NO
        retrieveReport = null
        return r
      }),

    enableBiometric: (prompt) =>
      step<KeystoreOutcome>('unlock.enableBiometric', 'session', OUTCOME, async (t) => {
        const s = session
        if (!s || s.provenBy !== 'passphrase') return NO
        const r = await effect(t, s.lease, () => withProven(s, (pw) => p.biometric.store(s.ns, pw, prompt)))
        if (r === GONE || !r.ok) return r === GONE ? NO : r
        const set = await effect(t, s.lease, () => withProven(s, (pw) => p.vault.setProtection(s.ns, 'passphrase+biometric', pw)))
        if (set === GONE || !set) return NO
        return (await publish(t, s)).ok ? r : NO
      }),

    async dismissBiometricOffer() {
      const ns = session?.ns ?? target
      if (ns) p.prefs.set(`${nsPrefs(ns)}bio-offer-dismissed`, '1')
    },
  }

  // ── change protection ─────────────────────────────────────────────────────

  const headMode = async (s: Session): Promise<ProtectionMode | null> => (await p.vault.head(s.ns))?.protection ?? null

  /** the proof becomes the session's: the old proven bytes are overwritten */
  const proven = (t: Ticket, s: Session, own: Lease, bytes: Uint8Array, by: Session['provenBy']): boolean => {
    if (!life.live(t) || session !== s || !res.move(own, s.lease)) return false
    res.drop(s.lease, s.proven)
    s.proven = bytes
    s.provenBy = by
    return true
  }

  const protection: IdentityCommands['protection'] = {
    prove: (current) =>
      step('protection.prove', 'session', RESULT, async (t, own) => {
        const s = session
        if (!s) return LOCKED
        let bytes: Uint8Array
        let by: Session['provenBy'] = 'passphrase'
        if ('passphrase' in current) bytes = passphraseBytes(current.passphrase.reveal())
        else {
          const r = await p.biometric.retrieve(s.ns, current.biometric)
          if (!r.ok) {
            const code = r.code === 'cancelled' ? 'biometric-cancelled' : r.code === 'invalidated' ? 'biometric-invalidated' : 'biometric-unavailable'
            return fail({ kind: 'platform', code })
          }
          bytes = r.secret
          by = 'keystore'
        }
        res.keep(own, bytes)
        const opened = await p.vault.open(s.ns, bytes)
        wipeKeys(opened) // only the proof counts; the keys of the session stay the session's
        if (!opened) return refused('passphrase-wrong')
        return proven(t, s, own, bytes, by) ? OK : LOCKED
      }),

    keystoreStore: (prompt) =>
      step<KeystoreOutcome>('protection.keystoreStore', 'session', OUTCOME, async (t) => {
        const s = session
        if (!s) return NO
        if ((await headMode(s)) === 'biometric-only') return NO // rewrap first
        const r = await effect(t, s.lease, () => withProven(s, (pw) => p.biometric.store(s.ns, pw, prompt)))
        return r === GONE ? NO : r
      }),

    setHead: (mode) =>
      step('protection.setHead', 'session', RESULT, async (t) => {
        const s = session
        if (!s) return LOCKED
        if ((await headMode(s)) === 'biometric-only') return refused('last-access') // the password is the random secret
        const set = await effect(t, s.lease, () => withProven(s, (pw) => p.vault.setProtection(s.ns, mode, pw)))
        if (set === GONE) return LOCKED
        if (!set) return refused('passphrase-wrong')
        return publish(t, s)
      }),

    rewrap: (pass) =>
      step('protection.rewrap', 'session', RESULT, async (t, own) => {
        const s = session
        if (!s) return LOCKED
        const raw = pass.reveal()
        if (raw.length < 8) return fail({ kind: 'refused', code: 'passphrase-too-short' })
        const next = passphraseBytes(raw)
        res.keep(own, next)
        const done = await effect(t, s.lease, () => withProven(s, (pw) => p.vault.rewrap(s.ns, pw, next, 'passphrase+biometric')))
        if (done === GONE) return LOCKED
        if (!done) return refused('passphrase-wrong')
        return proven(t, s, own, next, 'passphrase') ? publish(t, s) : LOCKED
      }),

    keystoreRemove: () =>
      step('protection.keystoreRemove', 'session', RESULT, async (t) => {
        const s = session
        if (!s) return LOCKED
        if ((await headMode(s)) !== 'passphrase') return refused('last-access') // the keystore is still the (or a) way in
        const r = await effect(t, s.lease, () => p.biometric.remove(s.ns))
        if (r === GONE) return LOCKED
        return r.ok ? OK : fail({ kind: 'platform', code: 'biometric-unavailable' })
      }),
  }

  // ── delete (S1 to S6) ─────────────────────────────────────────────────────

  const delMarker = (step: string) => {
    const ns = deleteNs ?? session?.ns ?? target
    return ns ? p.vault.setResume(marker({ flow: 'wipe', step, ns })) : Promise.resolve()
  }

  /** the opening the delete shuts down in phases: the one the session of deleteNs owns */
  const delHolder = () => (session && session.ns === deleteNs ? session.lease.holder : null)

  const del: IdentityCommands['delete'] = {
    quiesce: () =>
      step('delete.quiesce', 'storage', RESULT, async () => {
        if (session && (deleteNs === null || session.ns === deleteNs)) session.frozen = true // S1
        deleteNs = deleteNs ?? session?.ns ?? target ?? (await p.vault.active())
        if (!deleteNs) return bug('nothing to delete')
        remote = { done: 0, failed: 0 }
        deleteVerdict = 'unknown'
        await delMarker('quiescing')
        const h = delHolder()
        return h && !(await res.phase(h, 'quiesce')) ? storageError() : OK
      }),
    deregister: (mode) =>
      step('delete.deregister', 'storage', { busy: remote, stale: remote }, async () => {
        await delMarker('deregistering')
        const h = delHolder()
        remote = h ? await res.use(h, (x) => host.deregister(x, mode)) : { done: 0, failed: 0 }
        return remote
      }),
    seal: () =>
      step('delete.seal', 'storage', RESULT, async () => {
        const h = delHolder()
        if (h && !(await res.phase(h, 'seal'))) return storageError()
        await delMarker('sealed')
        return OK
      }),
    close: () =>
      step('delete.close', 'storage', RESULT, async () => {
        // S5 of the openings above, and of any opening a failed close left behind
        const closing = [endSession(), dropPending(), res.retry()] // a running close is joined, not repeated
        return (await Promise.all(closing)).every(Boolean) ? OK : storageError()
      }),
    wipe: () =>
      step('delete.wipe', 'storage', RESULT, async () => {
        const ns = deleteNs
        if (!ns) return bug('delete.wipe without quiesce')
        deleteVerdict = 'unknown'
        try {
          await wipeNamespace(ns)
          await inv.wipeGlobal(ns) // only for a full delete
          await orphans([])
        } finally {
          // the clipboard barrier covers the whole step: a throw of an earlier layer must not leave
          // an app copy standing (Anton 21.10., #433)
          await inv.clipboardBarrier()
        }
        return OK
      }),
    verify: () =>
      step<VerifyOutcome>('delete.verify', 'storage', SURVIVORS_UNKNOWN, async () => {
        deleteVerdict = 'unknown'
        const ns = deleteNs
        if (!ns) return { ok: false, survivors: ['no identity to verify'] }
        const out = await inv.verifyAll(ns)
        for (const o of res.openings()) out.push(`holder:${o.handle.ns}`) // registered, not closed yet
        survivors = [...new Set(out)]
        deleteVerdict = survivors.length === 0 ? 'clean' : 'survivors'
        if (deleteVerdict === 'clean') host.wiped?.(ns)
        return survivors.length === 0 ? { ok: true } : { ok: false, survivors }
      }),
    finish: () => {
      const report = (): WipeReport => ({
        local:
          deleteVerdict === 'clean'
            ? { ok: true }
            : { ok: false, survivors: deleteVerdict === 'survivors' ? survivors : ['verification did not complete'] },
        remote: { done: remote.done, pending: 0, failed: remote.failed },
      })
      const busy: WipeReport = { local: { ok: false, survivors: ['in-flight'] }, remote: { done: remote.done, pending: 0, failed: remote.failed } }
      return step('delete.finish', 'storage', { busy, stale: busy }, async () => {
        const r = report()
        if (deleteVerdict === 'clean') {
          await p.vault.setResume(null) // the marker is the last write
          deleteNs = null
          target = null
          state.set({ status: 'none', hint: null }) // verified gone: true in every epoch
        }
        return r
      })
    },
  }

  // ── Gen-2 reset ───────────────────────────────────────────────────────────

  const legacy: IdentityCommands['legacy'] = {
    wipe: () =>
      step('legacy.wipe', 'storage', RESULT, async () => {
        legacyVerdict = 'unknown'
        await p.vault.setResume(marker({ flow: 'legacy-wipe', step: 'wiping', ns: 'gen2' }))
        await p.legacy.wipe()
        await p.biometric.removeLegacy()
        return OK
      }),
    verify: () =>
      step<VerifyOutcome>('legacy.verify', 'storage', SURVIVORS_UNKNOWN, async () => {
        const out = await inv.legacySurvivors()
        survivors = out
        legacyVerdict = out.length === 0 ? 'clean' : 'survivors'
        return out.length === 0 ? { ok: true } : { ok: false, survivors: out }
      }),
    mark: () =>
      step('legacy.mark', 'storage', NOTHING, async (t) => {
        if (legacyVerdict === 'clean') await p.vault.setResume(null)
        await reconcile(t, [dropSession(), dropPending()])
      }),
  }

  // ── lock ──────────────────────────────────────────────────────────────────

  /** Synchronous before the first await (LIFECYCLE.md "Lock"); the cleanup after it never fails the lock. */
  const lock = async (): Promise<void> => {
    const running = life.running()
    if (running && BOOTS.has(running)) {
      await life.joinable(running)?.catch(() => {})
      await res.retry()
      return
    }
    const ns = session?.ns ?? target
    const released = [...revoke(), res.retry()] // a running close is joined, not repeated
    lockIfOrphaned(ns)
    const mine = state.get()
    await Promise.all(released)
    if (!ns || mine.status !== 'locked') return
    try {
      if ((await p.vault.active()) !== ns) return
      const info = await lockInfo(ns)
      if (state.get() !== mine) return // a later step published meanwhile
      target = ns
      state.set({ status: 'locked', ...info })
    } catch {
      // the lock info stays what lock knew; the state is locked either way
    }
  }

  return {
    state,
    boot,
    lastSurvivors: () => survivors,
    inventory: () =>
      res.openings().map((o) => ({ ns: o.handle.ns, state: o.state, owner: o.lease.role === 'call' ? null : o.lease.role, handle: o.handle })),
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
    acceptTerms: (version) =>
      step('acceptTerms', 'session', RESULT, async (t) => {
        const s = session
        const h = s?.lease.holder
        if (!s || !h) return LOCKED
        await res.use(h, (x) => host.acceptTerms(x, version, p.entropy.uuid()))
        if (!life.live(t)) return LOCKED
        p.prefs.set('terms', version)
        return publish(t, s)
      }),
    async refresh() {
      await boot()
    },
    lock,
    setup,
    unlock,
    protection,
    delete: del,
    legacy,
  }
}
