// The shared simulated transport of the player (architecture §7.3): every phone is its own holder
// with its own world; messages between them pass here. Up: delivered at once. Down ("transport
// gone"): queued in order and delivered when it is up again. A delivery whose phone is not shown
// stays queued until flush() finds it attached. Payloads are plain data, so they cross the
// iframe realms of the phones unchanged.

export interface Delivery {
  readonly id: number
  readonly from: number
  readonly to: number
  readonly text: string
  /** virtual time of the send */
  readonly sentAt: number
}

export interface TransportState {
  readonly state: 'up' | 'down'
  readonly queued: readonly Delivery[]
  readonly delivered: number
}

export interface SimTransport {
  get(): TransportState
  send(from: number, to: number, text: string, at: number): Delivery
  setState(state: 'up' | 'down'): void
  /** retry the queue (after a phone attached) */
  flush(): void
  subscribe(cb: () => void): () => void
}

/** `deliver` returns false when the target phone is not there; the delivery then stays queued. */
export function createSimTransport(deliver: (d: Delivery) => boolean): SimTransport {
  let state: TransportState = { state: 'up', queued: [], delivered: 0 }
  let seq = 0
  const listeners = new Set<() => void>()
  const set = (next: TransportState) => {
    state = next
    for (const l of [...listeners]) l()
  }
  const flush = () => {
    if (state.state === 'down' || state.queued.length === 0) return
    const left: Delivery[] = []
    let delivered = state.delivered
    for (const d of state.queued) {
      if (deliver(d)) delivered++
      else left.push(d)
    }
    set({ ...state, queued: left, delivered })
  }
  return {
    get: () => state,
    send(from, to, text, at) {
      const d: Delivery = { id: ++seq, from, to, text, sentAt: at }
      set({ ...state, queued: [...state.queued, d] })
      flush()
      return d
    },
    setState(next) {
      if (next === state.state) return
      set({ ...state, state: next })
      flush()
    },
    flush,
    subscribe(cb) {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
  }
}
