// The holder host of the real adapter (architecture §3.1, adapters/identity/host.ts): the identity
// runtime opens, initializes and shuts down holders through it; each opening is one Session with its
// own generation. The shutdown phases map to §2.1 rule 9: quiesce = S1 + S2, seal = S4, close = S5.

import type { HolderHandle, HolderHost, HolderKeys } from '../identity/host'
import type { AppEvent } from '../../port'
import type { ClockPort, EntropyPort } from '../../platform/ports'
import type { RetryPolicy } from '@real-life/trust-protocol'
import type { ReadModels } from './projection'
import { appDbName, holderDbName, openSession, type RltpFaults, type Session } from './session'
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
  /** the current session's models, null when no session is current (stores to LOADING, S5) */
  publish(models: ReadModels | null): void
  emit(e: AppEvent): void
  onCurrent(session: Session | null): void
}

interface Opening {
  readonly handle: HolderHandle
  readonly session: Session
  closed: boolean
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
  let current: Opening | null = null

  // One writer per device (§3.1): the Web Lock belongs to the host, not to one opening, so a staged
  // restore can open beside the old holder (review 420 R1-4). It is released when the last opening
  // is closed; after a delete (deregister ran, S3) only once the runtime verified the wipe (after S6).
  let lock: (() => void) | null = null
  const deleting = new Set<string>()
  /** openings still being built own the lock as much as registered ones (R2 R1-4) */
  let building = 0
  const acquire = async (): Promise<boolean> => {
    if (lock) return true
    lock = await deps.writer.acquire()
    return lock !== null
  }
  const releaseIfIdle = () => {
    if (openings.size > 0 || building > 0 || deleting.size > 0 || !lock) return
    const r = lock
    lock = null
    r()
  }
  const drop = (o: Opening) => {
    o.closed = true
    o.session.close()
    openings.delete(o.handle)
    if (current === o) setCurrent([...openings.values()][0] ?? null)
  }

  const opening = (h: HolderHandle): Opening | null => {
    const o = openings.get(h)
    return o && !o.closed ? o : null
  }
  const setCurrent = (o: Opening | null) => {
    current = o
    deps.onCurrent(o?.session ?? null)
    if (!o) deps.publish(null)
    else {
      const m = o.session.models()
      if (m) deps.publish(m)
    }
  }

  const build = async (ns: string, keys: HolderKeys): Promise<{ kind: 'ok'; holder: HolderHandle }> => {
    const g = ++generation
    const short = await anchorShortOf(keys.rootIkm, subtle)
    shorts.set(ns, short)
    let self: Opening | null = null
    const session = await openSession({
      ns,
      generation: g,
      idb: deps.idb,
      rootIkm: keys.rootIkm,
      dek: keys.dek,
      clock: deps.clock,
      entropy: deps.entropy,
      transport: transport.lease(),
      anchorShort: short,
      ...(deps.retry ? { retry: deps.retry } : {}),
      ...(deps.subtle ? { subtle: deps.subtle } : {}),
      ...(deps.faults ? { faults: deps.faults } : {}),
      publish: (m) => {
        if (self && current === self) deps.publish(m)
      },
      emit: (e) => {
        if (self && current === self) deps.emit(e)
      },
    })
    const handle: HolderHandle = { ns, kind: 'holder-handle' }
    self = { handle, session, closed: false }
    openings.set(handle, self)
    // a staged restore opens beside the current holder and takes over only when that one is closed
    // (rec.switch): commands, projections and events stay with the identity in use (R2-2)
    if (!current) setCurrent(self)
    return { kind: 'ok', holder: handle }
  }

  return {
    current: () => current?.session ?? null,
    databaseNames: (ns) => [holderDbName(ns), appDbName(ns)],
    namespaceOf(name) {
      const m = /^wot-v3-(?:holder|app)-(.+)$/.exec(name)
      return m?.[1] ?? null
    },
    async open(ns, keys) {
      building++
      try {
        if (!(await acquire())) return { kind: 'other-writer' }
        return await build(ns, keys)
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
    async close(holder) {
      const o = opening(holder)
      if (!o) return
      drop(o)
      releaseIfIdle()
    },
    forget(ns) {
      shorts.delete(ns)
      for (const o of [...openings.values()]) if (o.handle.ns === ns) drop(o)
      releaseIfIdle()
    },
    wiped(ns) {
      deleting.delete(ns)
      releaseIfIdle()
    },
  }
}
