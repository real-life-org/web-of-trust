// Coordinator of the identity runtime (LIFECYCLE.md): one epoch, one lane. Every port step runs as
// a transition in the lane; a second request with the same joinable key joins the running one, any
// other is refused as busy. lock and boot end the epoch synchronously: a running session
// transition loses the lane and reports `stale`, whatever its body returns.

export interface Ticket {
  readonly epoch: number
}

/** session: may install, open or publish a session, ends with the epoch. storage: runs to its end. */
export type TransitionKind = 'session' | 'storage'

export interface TransitionSpec {
  readonly key: string
  readonly kind: TransitionKind
  /** a request with the same key while this one runs gets the same promise */
  readonly join?: boolean
  /** wait for a running storage transition instead of refusing (boot) */
  readonly queue?: boolean
}

interface Lane {
  readonly spec: TransitionSpec
  readonly epoch: number
  promise: Promise<unknown>
}

export interface Lifecycle {
  live(t: Ticket): boolean
  /** S1 of lock and boot: ends the epoch; the lane of a session transition is free from here on */
  preempt(): void
  /** key of the transition holding the lane, null if it is free */
  running(): string | null
  /** promise of the running transition with this key, null if none */
  joinable(key: string): Promise<unknown> | null
  run<R>(spec: TransitionSpec, refuse: { busy: R; stale: R }, body: (t: Ticket) => Promise<R>): Promise<R>
}

export function createLifecycle(): Lifecycle {
  let epoch = 0
  let lane: Lane | null = null

  const holder = (): Lane | null => {
    if (lane && lane.spec.kind === 'session' && lane.epoch !== epoch) lane = null
    return lane
  }

  const run = <R>(spec: TransitionSpec, refuse: { busy: R; stale: R }, body: (t: Ticket) => Promise<R>): Promise<R> => {
    const l = holder()
    if (l) {
      if (spec.join && l.spec.key === spec.key) return l.promise as Promise<R>
      if (spec.queue && l.spec.kind === 'storage') return l.promise.then(noop, noop).then(() => run(spec, refuse, body))
      return Promise.resolve(refuse.busy)
    }
    const t: Ticket = { epoch }
    const mine: Lane = { spec, epoch, promise: Promise.resolve() }
    lane = mine
    mine.promise = (async () => {
      try {
        const r = await body(t)
        return spec.kind === 'session' && t.epoch !== epoch ? refuse.stale : r
      } finally {
        if (lane === mine) lane = null
      }
    })()
    return mine.promise as Promise<R>
  }

  return {
    live: (t) => t.epoch === epoch,
    preempt() {
      epoch++
      holder()
    },
    running: () => holder()?.spec.key ?? null,
    joinable: (key) => {
      const l = holder()
      return l && l.spec.key === key ? l.promise : null
    },
    run,
  }
}

const noop = () => {}
