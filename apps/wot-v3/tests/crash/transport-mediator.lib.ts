// The library's side of the VTI mediator matrix (transport-mediator.harness.ts): switchable faults on
// real holders, by the device whose holder is created next (`tag`). A's receive can fail once (a throw,
// or the library's transient rate-limited answer); A's contact view can show the relationship of one
// contact (a later enactment) chained into the first relationship of another (the chaining of
// RLTP-VTI-1230, which the library's flows do not produce before continuity); every counterpart of A
// (B, and F, whose displayed card's instance takes A's bundle) records what it answered for.
export const mlib = {
  /** the device whose holder is created next */
  tag: null as string | null,
  /** one-shot: A's next receive throws, or answers rate-limited */
  failReceive: null as null | 'throws' | 'rate-limited',
  /** A's contacts() shows the relationship of contact `from` chained into the first one of `into` */
  chain: null as null | { readonly into: string; readonly from: string },
  /** the one-shot faults that fired */
  fired: [] as string[],
  /** digests A's counterparts' holders answered with a final disposition */
  received: new Set<string>(),
  /** called right after A's holder committed a receive, before its result returns (a kill point) */
  afterReceive: null as null | ((r: { disposition?: string; events?: { type: string; status?: string }[] }) => void),
  reset() {
    mlib.failReceive = null
    mlib.fired = []
  },
}

interface Rel {
  id: string
  chainedFrom: string[]
  [k: string]: unknown
}
interface HolderLike {
  readonly closed: boolean
  receive(env: unknown, when: number): Promise<unknown>
  contacts(): Promise<{ id: string; relationships: Rel[] }[]>
}

/** the factory of vi.mock('@real-life/trust-protocol') */
export async function mockLib(importOriginal: <T>() => Promise<T>) {
  const real = await importOriginal<{ createHolder: (...args: unknown[]) => Promise<HolderLike>; InfraError: new (code: string, message: string) => Error }>()
  return {
    ...real,
    createHolder: async (...args: unknown[]) => {
      const h = await real.createHolder(...args)
      const tag = mlib.tag
      return {
        ...h,
        get closed() {
          return h.closed
        },
        receive: (env: unknown, when: number) => {
          if (tag === 'A' && mlib.failReceive) {
            const f = mlib.failReceive
            mlib.failReceive = null
            mlib.fired.push(`receive/${f}`)
            if (f === 'throws') return Promise.reject(new real.InfraError('storage', 'injected receive failure'))
            return Promise.resolve({ disposition: 'failed', reason: 'rate-limited', stage: 8 })
          }
          return h.receive(env, when).then((r) => {
            const x = r as { digest?: string; disposition?: string; reason?: string; events?: { type: string; status?: string }[] }
            if (tag !== 'A' && x.digest && !(x.disposition === 'failed' && x.reason === 'rate-limited')) mlib.received.add(x.digest)
            if (tag === 'A') mlib.afterReceive?.(x)
            return r
          })
        },
        contacts: async () => {
          const cs = await h.contacts()
          const chain = tag === 'A' ? mlib.chain : null
          if (!chain) return cs
          const later = cs.find((c) => c.id === chain.from)?.relationships.map((r) => r.id) ?? []
          return cs.map((c) =>
            c.id === chain.from
              ? { ...c, relationships: [] }
              : c.id === chain.into
                ? { ...c, relationships: c.relationships.map((r, i) => (i === 0 ? { ...r, chainedFrom: [...r.chainedFrom, ...later] } : r)) }
                : c,
          )
        },
      }
    },
  }
}
