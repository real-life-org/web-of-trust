// The holder host of the real adapter (architecture §3.1, adapters/identity/host.ts): the identity
// runtime opens, initializes and shuts down holders through it; each opening is one Session with its
// own generation. The shutdown phases map to §2.1 rule 9: quiesce = S1 + S2, seal = S4, close = S5.

import type { HolderHandle, HolderHost, HolderKeys } from '../identity/host'
import type { AppEvent } from '../../port'
import type { DiagnosticEntry, DiagnosticStore } from '../../port/diagnostics'
import type { ClockPort, EntropyPort } from '../../platform/ports'
import type { RetryPolicy } from '@real-life/trust-protocol'
import type { ReadModels } from './projection'
import { appDbName, holderDbName, openSession, UnclosedOpeningError, type RltpFaults, type Session } from './session'
import type { SingleWriter } from './single-writer'
import { shareTransport, type Transport } from './transport'

export interface RltpHostDeps {
  readonly idb: IDBFactory
  readonly clock: ClockPort
  readonly entropy: EntropyPort
  readonly transport: Transport
  readonly writer: SingleWriter
  readonly retry?: Partial<RetryPolicy>
  readonly subtle?: SubtleCrypto
  readonly faults?: RltpFaults
  /** where the adapter records what it met (codes only, architecture §2.6) */
  readonly diagnostics?: Pick<DiagnosticStore, 'record'>
  readonly lifecycle?: { onState(cb: (s: 'active' | 'background') => void): () => void }
  /** the current session's models, null when no session is current (stores to LOADING, S5) */
  publish(models: ReadModels | null): void
  emit(e: AppEvent): void
  onCurrent(session: Session | null): void
}

interface Opening {
  readonly handle: HolderHandle
  /** null for a failed build whose holder did not close: registered only to be closed again */
  readonly session: Session | null
  /** ends the opening: the session's close, or the retry of a failed build's holder close */
  readonly close: () => Promise<void>
  /** its transport lease: receives envelopes only while the opening is the current one */
  readonly lease: { activate(): void; deactivate(): void }
  /** opened by a delete only to deregister: never the identity in use (review 420 R5-2) */
  readonly deregOnly: boolean
  closed: boolean
  /** what the opening recorded for the diagnostic store before it was in use: handed over when it
   *  becomes the one in use, dropped with an opening a lock overtook (review 422 R8-1) */
  diagnosed: Omit<DiagnosticEntry, 'id'>[]
  /** the running close; null before it, and again after a failed one (the next close retries) */
  shut: Promise<void> | null
}

/** A short display form of the own identity for "Details" (§2.2): never a key, never a full anchor.
 *  A fresh holder has no community anchor yet, so the form is a fingerprint of the root IKM. */
async function anchorShortOf(rootIkm: Uint8Array, subtle: SubtleCrypto): Promise<string> {
  const label = new TextEncoder().encode('wot-v3/anchor-short/')
  const data = new Uint8Array(label.length + rootIkm.length)
  data.set(label)
  data.set(rootIkm, label.length)
  const h = new Uint8Array(await subtle.digest('SHA-256', data))
  return `id…${[...h.slice(0, 3)].map((b) => b.toString(16).padStart(2, '0')).join('')}`
}

export function rltpHolderHost(deps: RltpHostDeps): HolderHost & { current(): Session | null } {
  const subtle = deps.subtle ?? globalThis.crypto.subtle
  const transport = shareTransport(deps.transport)
  const openings = new Map<HolderHandle, Opening>()
  const shorts = new Map<string, string>()
  let generation = 0
  type Live = Opening & { readonly session: Session }
  let current: Live | null = null

  // One writer per device (§3.1): the Web Lock belongs to the host, not to one opening, so a staged
  // restore can open beside the old holder (review 420 R1-4). It is released when the last opening
  // is closed; after a delete (deregister ran, S3) only once the runtime verified the wipe (after S6).
  let lock: (() => void) | null = null
  const deleting = new Set<string>()
  /** openings still being built own the lock as much as registered ones (R2 R1-4) */
  let building = 0
  // one acquisition at a time, shared by every opening asking meanwhile; a failed one never overwrites
  // a lock that is held (review 420 R3-1)
  let acquiring: Promise<boolean> | null = null
  const acquire = (): Promise<boolean> => {
    if (lock) return Promise.resolve(true)
    acquiring ??= deps.writer.acquire().then(
      (r) => {
        acquiring = null
        if (r && !lock) lock = r
        return lock !== null
      },
      (e: unknown) => {
        acquiring = null
        throw e
      },
    )
    return acquiring
  }
  /** An opening stays registered until its holder closed (lib 0.6.0: the next opening of the store,
   *  and the writer lock, only after `await holder.close()`); a failed close leaves it registered,
   *  closed for use, and the next close or open of its namespace tries again (review 420 R12-2). */
  const releaseIfIdle = () => {
    if (openings.size > 0 || building > 0 || deleting.size > 0 || !lock) return
    const r = lock
    lock = null
    r()
  }
  const drop = (o: Opening): Promise<void> => {
    o.closed = true
    // closing never promotes another opening: only the restore switch does (activate, R3 R2-2)
    if (current === o) setCurrent(null)
    if (o.shut) return o.shut
    const ns = o.handle.ns
    const p = o.close().then(
      () => {
        openings.delete(o.handle)
      },
      (e: unknown) => {
        o.shut = null
        throw e
      },
    )
    o.shut = p
    void p
      .catch(() => undefined)
      .finally(() => {
        dropped(ns)
        releaseIfIdle()
      })
    return p
  }
  const of = (ns: string) => [...openings.values()].filter((o) => o.handle.ns === ns)
  /** openings of a namespace still being built (lib 0.6.0: one opening per store, review 420 R11-3) */
  const builds = new Map<string, Promise<unknown>>()
  /** waiters for the next end of a build or a close of a namespace */
  const waiters = new Map<string, Set<() => void>>()
  const dropped = (ns: string) => {
    const w = waiters.get(ns)
    waiters.delete(ns)
    for (const r of w ?? []) r()
  }
  /** Before a namespace opens: no build of it runs and every earlier opening of it is closed (a failed
   *  close is tried again here; if it fails again, the open fails). A late opening of a lock is closed
   *  by the identity runtime's register at once, so waiting for it ends. */
  const alone = async (ns: string) => {
    const b = builds.get(ns)
    if (b) {
      await b.catch(() => undefined)
      return
    }
    for (const o of of(ns)) {
      if (o.shut) await o.shut.catch(() => undefined)
      else if (o.closed) await drop(o)
      else
        await new Promise<void>((r) => {
          const w = waiters.get(ns) ?? new Set<() => void>()
          w.add(r)
          waiters.set(ns, w)
        })
      return
    }
  }
  const opening = (h: HolderHandle): Live | null => {
    const o = openings.get(h)
    return o && !o.closed && o.session ? (o as Live) : null
  }
  const setCurrent = (o: Live | null) => {
    current = o
    o?.lease.activate()
    // the opening in use hands over what its holder keeps for transport
    o?.session.offer()
    deps.onCurrent(o?.session ?? null)
    for (const e of o?.diagnosed.splice(0) ?? []) deps.diagnostics?.record(e)
    if (!o) deps.publish(null)
    else {
      const m = o.session.models()
      if (m) deps.publish(m)
    }
  }

  const build = async (ns: string, keys: HolderKeys, deregOnly: boolean): Promise<{ kind: 'ok'; holder: HolderHandle }> => {
    const g = ++generation
    const short = await anchorShortOf(keys.rootIkm, subtle)
    shorts.set(ns, short)
    let self: Opening | null = null
    const diagnosed: Omit<DiagnosticEntry, 'id'>[] = []
    const lease = transport.lease()
    const session = await openSession({
      ns,
      generation: g,
      idb: deps.idb,
      rootIkm: keys.rootIkm,
      dek: keys.dek,
      clock: deps.clock,
      entropy: deps.entropy,
      transport: lease,
      anchorShort: short,
      mode: deregOnly ? 'dereg-only' : 'normal',
      ...(deps.retry ? { retry: deps.retry } : {}),
      ...(deps.subtle ? { subtle: deps.subtle } : {}),
      ...(deps.faults ? { faults: deps.faults } : {}),
      diagnose: (e) => {
        if (self && current === self) deps.diagnostics?.record(e)
        else diagnosed.push(e)
      },
      ...(deps.lifecycle ? { lifecycle: deps.lifecycle } : {}),
      publish: (m) => {
        if (self && current === self) deps.publish(m)
      },
      emit: (e) => {
        if (self && current === self) deps.emit(e)
      },
    }).catch((e: unknown) => {
      // the holder of a failed build stays registered until it closed: the lock and the namespace stay
      // taken, the next close or open of the namespace tries again (TRANSPORT.md rule 4)
      if (e instanceof UnclosedOpeningError) {
        const orphan: HolderHandle = { ns, kind: 'holder-handle' }
        openings.set(orphan, { handle: orphan, session: null, close: e.closeAgain, lease, deregOnly, closed: true, diagnosed: [], shut: null })
        throw e.reason
      }
      throw e
    })
    const handle: HolderHandle = { ns, kind: 'holder-handle' }
    self = { handle, session, close: () => session.close(), lease, deregOnly, closed: false, diagnosed, shut: null }
    openings.set(handle, self)
    // an opening starts inactive: only the identity runtime makes it the one in use (activate, after
    // it installed the session or after rec.switch); an empty current is no permission (R4 R2-2)
    return { kind: 'ok', holder: handle }
  }

  return {
    current: () => current?.session ?? null,
    databaseNames: (ns) => [holderDbName(ns), appDbName(ns)],
    namespaceOf(name) {
      const m = /^wot-v3-(?:holder|app)-(.+)$/.exec(name)
      return m?.[1] ?? null
    },
    async open(ns, keys, opts) {
      building++
      try {
        if (!(await acquire())) return { kind: 'other-writer' }
        // never two openings over one store: no other of this namespace is built, open or closing
        // checked again right before the claim, with no await between: two callers never both pass
        while (builds.has(ns) || of(ns).length > 0) await alone(ns)
        const b = build(ns, keys, opts?.mode === 'dereg-only')
        builds.set(ns, b)
        try {
          return await b
        } finally {
          if (builds.get(ns) === b) builds.delete(ns)
          dropped(ns)
        }
      } finally {
        building--
        releaseIfIdle()
      }
    },
    async init(holder, inputs) {
      const o = opening(holder)
      if (!o) return
      if (inputs.profile) await o.session.setProfile(inputs.profile, inputs.actIds.setProfile)
    },
    async acceptTerms() {
      // the identity runtime records the consent itself (prefs `terms`); the library has no terms act
    },
    anchorShort: (ns) => shorts.get(ns) ?? null,
    async quiesce(holder) {
      await opening(holder)?.session.quiesce()
    },
    async deregister(holder, mode) {
      // called only by a delete (S3): the lock stays until the namespace is wiped and forgotten
      if (opening(holder)) deleting.add(holder.ns)
      void mode
      // no carrier registration exists before the TSP transport package (handover step 8)
      return { done: 0, failed: 0 }
    },
    async seal(holder) {
      opening(holder)?.session.seal()
    },
    activate(holder) {
      const o = opening(holder)
      if (o && !o.deregOnly && current !== o) setCurrent(o)
    },
    deactivate() {
      // synchronous at lock and boot: commands, publications and reception end here, before any
      // drain (review 420 R5-1)
      if (!current) return
      current.lease.deactivate()
      setCurrent(null)
    },
    async close(holder) {
      // also an opening whose earlier close failed: it is tried again
      const o = openings.get(holder)
      if (!o) return
      await drop(o)
    },
    forget(ns) {
      shorts.delete(ns)
      for (const o of [...openings.values()]) if (o.handle.ns === ns) void drop(o).catch(() => undefined)
      releaseIfIdle()
    },
    wiped(ns) {
      deleting.delete(ns)
      releaseIfIdle()
    },
  }
}
