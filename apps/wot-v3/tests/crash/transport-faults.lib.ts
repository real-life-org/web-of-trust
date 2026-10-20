// The library's side of three transport callbacks (receive, answer, close) for transport-faults:
// switchable faults on a real holder. Shared by the mock factory of each batch and the harness.
export const lib = {
  /** digests the holder answered for with a final disposition (not a transient failure) */
  received: new Set<string>(),
  /** one-shot faults: a rejected call, or for receive a resolved transient answer */
  failReceive: null as null | 'throws' | 'rate-limited',
  failReport: false,
  failHandOver: false,
  failPending: false,
  /** 'after': the holder closed, the call rejects; 'before': it rejects and the holder stays open */
  failClose: null as null | 'before' | 'after',
  closeHold: null as null | Promise<void>,
  /** a receive whose answer is computed but held: `computed` fires, the answer leaves at `receiveHold` */
  receiveHold: null as null | Promise<void>,
  computed: null as null | (() => void),
  reset() {
    lib.receiveHold = null
    lib.computed = null
    lib.failReceive = null
    lib.failReport = lib.failHandOver = lib.failPending = false
    lib.failClose = null
    lib.closeHold = null
  },
}

interface HolderLike {
  readonly closed: boolean
  receive(env: unknown, when: number): Promise<unknown>
  report(r: unknown, when: number): Promise<unknown>
  pendingTransport(when: number): Promise<unknown>
  handOver(entry: unknown, when: number, start: () => boolean): Promise<boolean>
  close(): Promise<void>
}

/** the factory of vi.mock('@real-life/trust-protocol') */
export async function mockLib(importOriginal: <T>() => Promise<T>) {
  const real = await importOriginal<{ createHolder: (...args: unknown[]) => Promise<HolderLike>; InfraError: new (code: string, message: string) => Error }>()
  return {
    ...real,
    createHolder: async (...args: unknown[]) => {
      const h = await real.createHolder(...args)
      return {
        ...h,
        get closed() {
          return h.closed
        },
        receive: (env: unknown, when: number) => {
          const f = lib.failReceive
          lib.failReceive = null
          if (f === 'throws') return Promise.reject(new real.InfraError('storage', 'injected receive failure'))
          // transient by the library's own answer (Delivery RLTP-DEL-5820): nothing committed
          if (f === 'rate-limited') return Promise.resolve({ disposition: 'failed', reason: 'rate-limited', stage: 8 })
          // what the holder answered for: the digest of every final disposition
          return h.receive(env, when).then(async (r) => {
            const x = r as { digest?: string; disposition?: string; reason?: string }
            if (x.digest && !(x.disposition === 'failed' && x.reason === 'rate-limited')) lib.received.add(x.digest)
            const hold = lib.receiveHold
            lib.computed?.()
            if (hold) await hold
            return r
          })
        },
        report: (r: unknown, when: number) => {
          if (!lib.failReport) return h.report(r, when)
          lib.failReport = false
          return Promise.reject(new real.InfraError('storage', 'injected report failure'))
        },
        pendingTransport: (when: number) => {
          if (!lib.failPending) return h.pendingTransport(when)
          lib.failPending = false
          return Promise.reject(new real.InfraError('storage', 'injected pendingTransport failure'))
        },
        handOver: (entry: unknown, when: number, start: () => boolean) => {
          if (!lib.failHandOver) return h.handOver(entry, when, start)
          lib.failHandOver = false
          return Promise.reject(new real.InfraError('storage', 'injected handOver failure'))
        },
        close: async () => {
          const f = lib.failClose
          lib.failClose = null
          if (f === 'before') throw new real.InfraError('storage', 'injected close failure, holder still open')
          await h.close()
          if (f === 'after') throw new real.InfraError('storage', 'injected close failure')
          if (lib.closeHold) await lib.closeHold
        },
      }
    },
  }
}
