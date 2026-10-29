// Incoming confirmations and the success moment (handshake UX 2.6, 2.7; architecture §4.1): the
// `incoming` machine over the port's `decisions` and the mutual watch over `contacts`, both for the
// shell. The verify flow tells the shell what it asks for itself, so nothing is asked twice.

import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { AppPort, CardRef, ContactId, Result } from '../port'
import type { Platform } from '../platform/ports'
import type { EffectResult } from '../flows/machine'
import { incoming, incomingPosition, incomingStart, type IncomingEffect, type IncomingEntry, type IncomingEvent, type IncomingState } from '../flows/incoming'
import { MUTUAL_WATCH, watchMutual, type MutualWatch } from '../flows/mutual'
import type { VerifyState } from '../flows/verify'
import { createFlowRunner, type FlowRunner } from './flow-runner'
import { usePlatform, usePort } from './context'

export type { IncomingState, IncomingEvent, IncomingEntry } from '../flows/incoming'

const fromResult = (r: Result<unknown>): EffectResult => (r.ok ? { ok: true, value: r.value } : { ok: false, code: 'code' in r.error ? String(r.error.code) : r.error.kind })

/** The open encounter-confirm decisions that answer an own card (E9), with the contact's name; the card
 *  the verify flow shows right now is its own to ask for (2.4). Null while a store loads. */
export function incomingEntries(port: AppPort, shownByFlow: CardRef | null): IncomingEntry[] | null {
  const decisions = port.stores.decisions.get()
  const contacts = port.stores.contacts.get()
  if (decisions.status !== 'ready' || contacts.status !== 'ready') return null
  const names = new Map(contacts.value.map((c) => [c.id as string, c.name] as const))
  return decisions.value.flatMap((d) =>
    d.kind === 'encounter-confirm' && d.state === 'open' && d.answers !== null && d.answers.card !== shownByFlow
      ? [{ id: d.id, contactId: d.contactId, name: names.get(d.contactId) ?? null, openedAt: d.openedAt, validUntil: d.answers.validUntil }]
      : [],
  )
}

export function incomingExecutor(port: AppPort, platform: Pick<Platform, 'clock'>) {
  return async (e: IncomingEffect): Promise<EffectResult> => {
    switch (e.id) {
      case 'inc.counter':
        return fromResult(await port.trust.counterVerify(e.contactId).done)
      case 'inc.expire':
        await new Promise<void>((resolve) => platform.clock.setTimer(e.at, resolve))
        return { ok: true, value: { now: platform.clock.now() } }
    }
  }
}

/** The verify flow asks for a person itself in every state but the shown code (2.4): the queue waits. */
export function flowAsks(v: VerifyState | null): boolean {
  return v !== null && v.name !== 'showing' && v.name !== 'ready'
}

/** The verify flow shows the success for this contact itself (2.7: not twice). */
export function flowCovers(v: VerifyState | null, contactId: ContactId): boolean {
  return v !== null && 'contactId' in v && v.contactId === contactId && v.name !== 'exit'
}

export interface IncomingQueue {
  readonly state: IncomingState
  readonly send: (e: IncomingEvent) => void
  readonly position: { readonly n: number; readonly m: number } | null
}

export function useIncoming(verify: VerifyState | null, hold: boolean): IncomingQueue {
  const port = usePort()
  const platform = usePlatform()
  const [runner, setRunner] = useState<FlowRunner<IncomingState, IncomingEvent> | null>(null)
  const shown = verify?.name === 'ready' || verify?.name === 'showing' ? (verify.card?.card ?? null) : null
  const shownRef = useRef(shown)
  useEffect(() => {
    shownRef.current = shown
  })
  const [first] = useState(() => incomingStart(platform.clock.now()))
  useEffect(() => {
    const r = createFlowRunner(incoming, first, incomingExecutor(port, platform), platform)
    const push = () => {
      const entries = incomingEntries(port, shownRef.current)
      if (entries) r.send({ type: 'decisions', entries, now: platform.clock.now() })
    }
    const offD = port.stores.decisions.subscribe(push)
    const offC = port.stores.contacts.subscribe(push)
    push()
    setRunner(r)
    return () => {
      offD()
      offC()
      r.dispose()
    }
    // the queue lives as long as the shell
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  // the card the flow shows changed: judge again without it
  useEffect(() => {
    if (!runner) return
    const entries = incomingEntries(port, shown)
    if (entries) runner.send({ type: 'decisions', entries, now: platform.clock.now() })
  }, [runner, shown, port, platform])
  useEffect(() => {
    runner?.send({ type: 'hold', on: hold })
  }, [runner, hold])
  const subscribe = runner ? runner.subscribe : noSubscribe
  const get = runner ? runner.get : () => first
  const state = useSyncExternalStore(subscribe, get, get)
  return { state, send: runner ? runner.send : noop, position: incomingPosition(state) }
}

export interface MutualMoment {
  readonly contactId: ContactId
  readonly name: string | null
}

/** The success moments of this session (E7), in the order they came; `covered` says whether the verify
 *  flow shows one itself (asked at the moment it comes). */
export function useMutualMoments(covered: (contactId: ContactId) => boolean): { readonly current: MutualMoment | null; dismiss(): void } {
  const port = usePort()
  const [queue, setQueue] = useState<readonly MutualMoment[]>([])
  const coveredRef = useRef(covered)
  useEffect(() => {
    coveredRef.current = covered
  })
  useEffect(() => {
    let watch: MutualWatch = MUTUAL_WATCH
    const look = () => {
      const contacts = port.stores.contacts.get()
      if (contacts.status !== 'ready') return
      const out = watchMutual(watch, contacts.value)
      watch = out.watch
      const names = new Map(contacts.value.map((c) => [c.id as string, c.name] as const))
      const add = out.fresh.filter((id) => !coveredRef.current(id)).map((id) => ({ contactId: id, name: names.get(id) ?? null }))
      if (add.length > 0) setQueue((q) => [...q, ...add])
    }
    const off = port.stores.contacts.subscribe(look)
    look()
    return off
  }, [port])
  return { current: queue[0] ?? null, dismiss: () => setQueue((q) => q.slice(1)) }
}

const noSubscribe = () => () => {}
const noop = () => {}
