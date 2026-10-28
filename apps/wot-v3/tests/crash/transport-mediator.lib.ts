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
  /** A's receive of an envelope sealed to `rkid` waits until `until` resolves (a collection held open) */
  holdReceive: null as null | { readonly rkid: string; readonly until: Promise<void>; entered: boolean },
  /** A's contacts() shows the relationship of contact `from` chained into the first one of `into` */
  chain: null as null | { readonly into: string; readonly from: string },
  /** the one-shot faults that fired */
  fired: [] as string[],
  /** digests A's counterparts' holders answered with a final disposition */
  received: new Set<string>(),
  /** called right after A's holder committed a receive, before its result returns (a kill point) */
  afterReceive: null as null | ((r: { disposition?: string; events?: { type: string; status?: string }[] }) => void),
  /** A's reports of a counterpart's answer (a refusal, a held document) throw while set */
  failAnswerReports: false,
  /** called right after A's holder recorded a report of a counterpart's answer (a kill point) */
  afterAnswerReport: null as null | ((r: { digest: string; status: string }) => void),
  /** the holders by device tag (the matrix reads the counterpart's relationships) */
  holders: new Map<string, HolderLike>(),
  reset() {
    mlib.failAnswerReports = false
    mlib.afterAnswerReport = null
    mlib.failReceive = null
    mlib.fired = []
  },
}

interface Rel {
  id: string
  chainedFrom: string[]
  [k: string]: unknown
}
export interface HolderLike {
  readonly closed: boolean
  receive(env: unknown, when: number): Promise<unknown>
  report(r: unknown, when: number): Promise<unknown>
  contacts(): Promise<{ id: string; relationships: Rel[] }[]>
}
/** a report of a counterpart's answer: a refusal (rejected-by-receiver) or a held document */
const isAnswer = (r: unknown): r is { digest: string; status: string } => {
  const x = r as { status?: string; reason?: string; held?: boolean } | null
  return x !== null && typeof x === 'object' && ((x.status === 'failed' && x.reason === 'rejected-by-receiver') || (x.status === 'accepted' && x.held === true))
}

/** the factory of vi.mock('@real-life/trust-protocol') */
export async function mockLib(importOriginal: <T>() => Promise<T>) {
  const real = await importOriginal<{ createHolder: (...args: unknown[]) => Promise<HolderLike>; InfraError: new (code: string, message: string) => Error }>()
  return {
    ...real,
    createHolder: async (...args: unknown[]) => {
      const h = await real.createHolder(...args)
      const tag = mlib.tag
      const wrapped: HolderLike = {
        ...h,
        get closed() {
          return h.closed
        },
        receive: async (env: unknown, when: number): Promise<unknown> => {
          const held = mlib.holdReceive
          if (tag === 'A' && held && (env as { rkid?: unknown } | null)?.rkid === held.rkid) {
            held.entered = true
            await held.until
          }
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
        report: async (r: unknown, when: number): Promise<unknown> => {
          if (tag === 'A' && isAnswer(r) && mlib.failAnswerReports) {
            mlib.fired.push('answer/report-throws')
            return Promise.reject(new real.InfraError('storage', 'injected report failure'))
          }
          const out = await h.report(r, when)
          if (tag === 'A' && isAnswer(r)) mlib.afterAnswerReport?.(r)
          return out
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
      if (tag) mlib.holders.set(tag, wrapped)
      return wrapped
    },
  }
}
