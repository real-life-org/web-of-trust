// The library's side of three transport callbacks (receive, answer, close) for transport-faults:
// switchable faults on a real holder. Shared by the mock factory of each batch and the harness.
export const lib = { received: new Set<string>(), failReceive: false, failReport: false, failClose: false, closeHold: null as null | Promise<void> }

interface HolderLike {
  readonly closed: boolean
  receive(env: unknown, when: number): Promise<unknown>
  report(r: unknown, when: number): Promise<unknown>
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
          // what the holder answered for: the digest of every receive that resolved
          if (!lib.failReceive)
            return h.receive(env, when).then((r) => {
              const d = (r as { digest?: string }).digest
              if (d) lib.received.add(d)
              return r
            })
          lib.failReceive = false
          return Promise.reject(new real.InfraError('storage', 'injected receive failure'))
        },
        report: (r: unknown, when: number) => {
          if (!lib.failReport) return h.report(r, when)
          lib.failReport = false
          return Promise.reject(new real.InfraError('storage', 'injected report failure'))
        },
        close: async () => {
          await h.close()
          if (lib.failClose) {
            lib.failClose = false
            throw new real.InfraError('storage', 'injected close failure')
          }
          if (lib.closeHold) await lib.closeHold
        },
      }
    },
  }
}
