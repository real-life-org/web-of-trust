// Register of what the identity runtime holds (LIFECYCLE.md): holder openings and secret bytes,
// each owned by one lease. An opening is active, closing or closed; it leaves the register only
// after the host closed it. A failed close leaves it closing, registered and reachable by retry,
// and it never becomes part of a session again. The bytes of a lease are overwritten when the lease
// is released, after the close was attempted, whatever the host did.

import type { HolderHandle, HolderHost } from './host'

export type OpeningState = 'active' | 'closing' | 'closed'
export type LeaseRole = 'session' | 'pending' | 'call'

export interface Opening {
  readonly handle: HolderHandle
  readonly lease: Lease
  state: OpeningState
  /** phases already done on this opening (delete S2 and S4 run them one by one) */
  readonly done: Set<'quiesce' | 'seal'>
}

export interface Lease {
  readonly ns: string
  readonly role: LeaseRole
  readonly holder: Opening | null
  readonly released: boolean
}

interface LeaseRecord extends Lease {
  holder: OpeningRecord | null
  released: boolean
  readonly secrets: Set<Uint8Array>
}

interface OpeningRecord extends Opening {
  lease: LeaseRecord
  /** serializes every host call on this opening */
  tail: Promise<unknown>
  /** the close attempt running now, if any */
  closing: Promise<boolean> | null
}

export interface Resources {
  lease(ns: string, role: LeaseRole): Lease
  /** takes bytes into the lease; a released lease overwrites them at once (false) */
  keep(lease: Lease, ...bytes: (Uint8Array | null | undefined)[]): boolean
  /** overwrites bytes of the lease and forgets them */
  drop(lease: Lease, bytes: Uint8Array | null | undefined): void
  /** registers a fresh opening; into a released lease it goes straight to closing (null) */
  adopt(lease: Lease, handle: HolderHandle): Opening | null
  /** handover: opening and bytes of `from` go to `to`; false if `to` was released (from keeps them) */
  move(from: Lease, to: Lease): boolean
  /** one host call on an active opening, after every earlier call on it */
  use<T>(o: Opening, call: (h: HolderHandle) => Promise<T>): Promise<T>
  /** quiesce or seal an active opening once; false if the host failed */
  phase(o: Opening, phase: 'quiesce' | 'seal'): Promise<boolean>
  /** synchronously active → closing, then the remaining phases and close; true when closed */
  release(lease: Lease): Promise<boolean>
  /** closes every closing opening (of ns) again; true when none is left */
  retry(ns?: string): Promise<boolean>
  /** waits for the close attempts running for ns */
  settled(ns: string): Promise<void>
  /** active and closing openings */
  openings(ns?: string): readonly Opening[]
}

export function createResources(host: HolderHost): Resources {
  const openings = new Set<OpeningRecord>()
  const rec = (l: Lease) => l as LeaseRecord
  const wipe = (l: LeaseRecord) => {
    for (const b of l.secrets) b.fill(0)
    l.secrets.clear()
  }

  const serial = <T>(o: OpeningRecord, call: () => Promise<T>): Promise<T> => {
    const next = o.tail.then(call, call)
    o.tail = next.catch(() => {})
    return next
  }
  const attempt = async (call: () => Promise<unknown>): Promise<boolean> => {
    try {
      await call()
      return true
    } catch {
      return false
    }
  }

  /** remaining phases, then close; closed and forgotten only after close returned */
  const close = (o: OpeningRecord): Promise<boolean> => {
    if (o.state === 'closed') return Promise.resolve(true)
    if (o.closing) return o.closing
    const run = (async () => {
      for (const ph of ['quiesce', 'seal'] as const) {
        if (o.done.has(ph)) continue
        if (await attempt(() => serial(o, () => host[ph](o.handle)))) o.done.add(ph)
      }
      const ok = await attempt(() => serial(o, () => host.close(o.handle)))
      if (ok) {
        o.state = 'closed'
        openings.delete(o)
      }
      return ok
    })()
    o.closing = run
    void run.finally(() => {
      if (o.closing === run) o.closing = null
    })
    return run
  }

  const toClosing = (o: OpeningRecord) => {
    if (o.state === 'active') o.state = 'closing'
  }

  return {
    lease: (ns, role): Lease => ({ ns, role, holder: null, released: false, secrets: new Set() }) as LeaseRecord,

    keep(lease, ...bytes) {
      const l = rec(lease)
      for (const b of bytes) if (b) l.secrets.add(b)
      if (!l.released) return true
      wipe(l)
      return false
    },

    drop(lease, bytes) {
      if (!bytes) return
      bytes.fill(0)
      rec(lease).secrets.delete(bytes)
    },

    adopt(lease, handle) {
      const l = rec(lease)
      const o: OpeningRecord = { handle, lease: l, state: 'active', done: new Set(), tail: Promise.resolve(), closing: null }
      openings.add(o)
      if (l.released || l.holder) {
        toClosing(o)
        void close(o)
        return null
      }
      l.holder = o
      return o
    },

    move(fromLease, toLease) {
      const from = rec(fromLease)
      const to = rec(toLease)
      if (to.released) return false
      if (from.holder && !to.holder) {
        to.holder = from.holder
        to.holder.lease = to
        from.holder = null
      }
      for (const b of from.secrets) to.secrets.add(b)
      from.secrets.clear()
      return true
    },

    use(o, call) {
      const r = o as OpeningRecord
      if (r.state !== 'active') return Promise.reject(new Error('opening is not active'))
      return serial(r, () => call(r.handle))
    },

    async phase(o, ph) {
      const r = o as OpeningRecord
      if (r.state !== 'active') return r.state === 'closed'
      const ok = await attempt(() => serial(r, () => host[ph](r.handle)))
      if (ok) r.done.add(ph)
      return ok
    },

    release(lease) {
      const l = rec(lease)
      l.released = true
      const o = l.holder
      l.holder = null
      if (!o) {
        wipe(l)
        return Promise.resolve(true)
      }
      toClosing(o)
      return close(o).finally(() => wipe(l))
    },

    async retry(ns) {
      const left = [...openings].filter((o) => o.state === 'closing' && (ns === undefined || o.handle.ns === ns))
      const results = await Promise.all(left.map(close))
      return results.every(Boolean)
    },

    async settled(ns) {
      await Promise.all([...openings].filter((o) => o.handle.ns === ns && o.closing).map((o) => o.closing))
    },

    openings: (ns) => [...openings].filter((o) => ns === undefined || o.handle.ns === ns),
  }
}
