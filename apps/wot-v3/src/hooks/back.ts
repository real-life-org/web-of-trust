// System back (architecture §4.1 navigation, §5 LifecyclePort.onBack): one dispatcher per platform
// registers once with the lifecycle port and asks the app's handlers in order of rank, newest first.
// A running flow (onboarding, recovery, verify, report, delete, protection, legacy reset) outranks the
// navigation: Android back and browser back go one step back inside the flow, and never leave the app
// in the middle of one (a flow handler always reports "handled", also where its machine has no way
// back). Only the navigation at its root lets the app be left.

import { useEffect, useRef } from 'react'
import type { LifecyclePort } from '../platform/ports'
import { usePlatform } from './context'

export type BackRank = 'nav' | 'flow'
const RANK: Record<BackRank, number> = { nav: 0, flow: 1 }

interface Entry {
  readonly rank: number
  readonly seq: number
  readonly cb: () => boolean
}

export interface BackDispatcher {
  add(rank: BackRank, cb: () => boolean): () => void
  /** what a system back does now: true = an app handler took it */
  dispatch(): boolean
}

const dispatchers = new WeakMap<LifecyclePort, BackDispatcher>()

export function backDispatcher(lifecycle: LifecyclePort): BackDispatcher {
  const known = dispatchers.get(lifecycle)
  if (known) return known
  const entries: Entry[] = []
  let seq = 0
  let off: (() => void) | null = null
  const d: BackDispatcher = {
    add(rank, cb) {
      const e: Entry = { rank: RANK[rank], seq: ++seq, cb }
      entries.push(e)
      off ??= lifecycle.onBack(() => d.dispatch())
      return () => {
        const i = entries.indexOf(e)
        if (i >= 0) entries.splice(i, 1)
        if (entries.length === 0 && off) {
          off()
          off = null
        }
      }
    },
    dispatch() {
      const order = [...entries].sort((a, b) => b.rank - a.rank || b.seq - a.seq)
      for (const e of order) if (e.cb()) return true
      return false
    },
  }
  dispatchers.set(lifecycle, d)
  return d
}

/** A system-back handler while `active`; true = handled. */
export function useSystemBack(cb: () => boolean, rank: BackRank, active = true): void {
  const platform = usePlatform()
  const ref = useRef(cb)
  useEffect(() => {
    ref.current = cb
  })
  useEffect(() => (active ? backDispatcher(platform.lifecycle).add(rank, () => ref.current()) : undefined), [platform, rank, active])
}

/** Inside a flow: back is one step back of the flow (legacy 6061c484), never out of the app. */
export function useBackInFlow(onBack: () => void, active = true): void {
  useSystemBack(
    () => {
      onBack()
      return true
    },
    'flow',
    active,
  )
}
