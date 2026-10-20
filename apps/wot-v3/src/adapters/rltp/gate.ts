// The write gate (architecture §3.1 "Schreibtor", N2): the only way to the holder's methods. A call is
// taken only for the current generation while the gate is open; it counts running calls, and drain()
// resolves when none runs. Results reach transport and ingest only if their generation still holds
// when they return.

export class GateClosedError extends Error {
  constructor() {
    super('write gate closed')
    this.name = 'GateClosedError'
  }
}

export interface Gate<H> {
  readonly generation: number
  isOpen(): boolean
  /** runs fn on the holder if the gate is open; rejects with GateClosedError otherwise */
  run<R>(fn: (h: H) => Promise<R>): Promise<R>
  /** S1: no new call is taken */
  close(): void
  /** S2: resolves when no call runs, at the latest after `ms` */
  drain(ms: number, timer: (ms: number) => Promise<void>): Promise<void>
}

export function createGate<H>(holder: H, generation: number): Gate<H> {
  let open = true
  let running = 0
  let waiters: (() => void)[] = []
  const settle = () => {
    if (running > 0) return
    const w = waiters
    waiters = []
    for (const r of w) r()
  }
  return {
    generation,
    isOpen: () => open,
    async run(fn) {
      if (!open) throw new GateClosedError()
      running++
      try {
        return await fn(holder)
      } finally {
        running--
        settle()
      }
    },
    close() {
      open = false
    },
    drain(ms, timer) {
      if (running === 0) return Promise.resolve()
      return Promise.race([new Promise<void>((r) => waiters.push(r)), timer(ms)])
    },
  }
}
