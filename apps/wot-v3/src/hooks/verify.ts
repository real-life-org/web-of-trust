// Verify in person (architecture §4.1 `useVerify`): the verify machine with its effect runner, bound
// to the port's encounter commands and the scanner port. The hook feeds the machine `bundle` events
// from the published stores (contacts, decisions): success only ever comes from there.

import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { AppPort, ContactId, EncounterOutcome, Result, Verification } from '../port'
import type { Platform } from '../platform/ports'
import type { EffectResult } from '../flows/machine'
import { verify, verifyStart, type CaptureFollow, type VerifyEffect, type VerifyEvent, type VerifyState } from '../flows/verify'
import { createFlowRunner, type FlowRunner } from './flow-runner'
import { usePlatform, usePort } from './context'

export type { VerifyState, VerifyEvent, ScanErrorCode, ShownCard } from '../flows/verify'

const fromResult = (r: Result<unknown>): EffectResult =>
  r.ok ? { ok: true, value: r.value } : { ok: false, code: 'code' in r.error ? String(r.error.code) : r.error.kind }

const timer = (clock: Platform['clock'], at: number) => new Promise<void>((resolve) => clock.setTimer(at, resolve))

/** Where an already-captured card leaves the encounter, read from the published bundle (N9). */
function followOf(port: AppPort, contactId: ContactId | null): { follow: CaptureFollow; decision: string | null } {
  if (contactId === null) return { follow: 'none', decision: null }
  const decisions = port.stores.decisions.get()
  const open = decisions.status === 'ready' ? decisions.value.find((d) => d.kind === 'encounter-confirm' && d.contactId === contactId) : undefined
  if (open) return { follow: 'confirm', decision: open.id }
  const c = port.stores.contact(contactId).get()
  const v = c.status === 'ready' ? c.value?.verification : undefined
  if (v === 'mutual') return { follow: 'mutual', decision: null }
  if (v === 'outgoing') return { follow: 'counter-pending', decision: null }
  // declined (or the request is gone): the question comes again before the counter-step, as at the
  // first scan, while the port offers the counter-step
  if (v === 'incoming' && c.status === 'ready' && c.value?.actions.counterVerify.ok) return { follow: 'counter', decision: null }
  // a known contact with nothing open and no counter-step offered (met: the other credential has not
  // arrived yet)
  if (v !== undefined) return { follow: 'met', decision: null }
  return { follow: 'none', decision: null }
}

/** Where a web camera renders (ScannerPort.scan target): the screen sets it, the scan effect waits for
 *  it, because the effect starts with the transition, before the scanning view is on screen. */
export interface ScanTargetSlot {
  set(el: HTMLElement | null): void
  /** the element once it is on screen; null when the scan was aborted first */
  wait(signal: AbortSignal): Promise<HTMLElement | null>
}

export function scanTargetSlot(): ScanTargetSlot {
  let el: HTMLElement | null = null
  const waiters = new Set<(el: HTMLElement) => void>()
  return {
    set(next) {
      el = next
      if (next) for (const w of [...waiters]) w(next)
    },
    wait(signal) {
      if (el) return Promise.resolve(el)
      return new Promise((resolve) => {
        const done = (v: HTMLElement | null) => {
          waiters.delete(take)
          signal.removeEventListener('abort', onAbort)
          resolve(v)
        }
        const take = (v: HTMLElement) => done(v)
        const onAbort = () => done(null)
        if (signal.aborted) return done(null)
        waiters.add(take)
        signal.addEventListener('abort', onAbort)
      })
    },
  }
}

export function verifyExecutor(
  port: AppPort,
  platform: Pick<Platform, 'scanner' | 'clock'>,
  scans: { current: AbortController | null },
  /** web scanners render into it; without a slot the scan gets no target (native, tests) */
  target: ScanTargetSlot | null = null,
) {
  return async (e: VerifyEffect): Promise<EffectResult> => {
    switch (e.id) {
      case 'ver.show':
        return fromResult(await port.trust.showCard().done)
      case 'ver.expire':
        await timer(platform.clock, e.at)
        return { ok: true }
      case 'ver.wait':
        await timer(platform.clock, platform.clock.now() + e.ms)
        return { ok: true }
      case 'cam.check': {
        const availability = await platform.scanner.availability()
        const permission = availability === 'available' ? await platform.scanner.permission() : 'denied'
        return { ok: true, value: { availability, permission, explain: platform.scanner.explainsBeforeAsking } }
      }
      case 'cam.scan': {
        scans.current?.abort()
        const ctl = new AbortController()
        scans.current = ctl
        const el = target ? await target.wait(ctl.signal) : null
        if (ctl.signal.aborted) return { ok: true, value: { kind: 'cancelled' } }
        return { ok: true, value: await platform.scanner.scan({ target: el, signal: ctl.signal }) }
      }
      case 'cam.settings':
        await platform.scanner.openSettings()
        return { ok: true }
      case 'ver.preview':
        return fromResult(await port.trust.previewCard(e.raw))
      case 'ver.confirm':
        return fromResult(await port.trust.confirmCard(e.raw).done)
      case 'ver.capture': {
        const r = await port.trust.confirmCard(e.raw).done
        if (!r.ok) return fromResult(r)
        const outcome: EncounterOutcome = r.value
        const contactId = outcome.kind === 'already-captured' ? outcome.contactId : null
        return { ok: true, value: { outcome, contactId, ...followOf(port, contactId) } }
      }
      case 'ver.sent':
        return fromResult(await port.trust.sentCardFor(e.contactId))
      case 'ver.counter':
        return fromResult(await port.trust.counterVerify(e.contactId).done)
    }
  }
}

/** The bundle event: verification per contact and the open encounter-confirm decisions with the card
 *  each answers (E9) and the contact's name. */
export function bundleEvent(port: AppPort): VerifyEvent | null {
  const contacts = port.stores.contacts.get()
  const decisions = port.stores.decisions.get()
  if (contacts.status !== 'ready' || decisions.status !== 'ready') return null
  const verifications: Record<string, Verification> = {}
  const names = new Map<string, string | null>()
  for (const c of contacts.value) {
    verifications[c.id] = c.verification
    names.set(c.id, c.name)
  }
  const open = decisions.value.flatMap((d) =>
    d.kind === 'encounter-confirm' && d.state === 'open' ? [{ id: d.id, contactId: d.contactId, card: d.answers?.card ?? null, name: names.get(d.contactId) ?? null }] : [],
  )
  return { type: 'bundle', verifications, decisions: open }
}

export interface VerifyFlow {
  readonly state: VerifyState
  readonly send: (e: VerifyEvent) => void
  /** ref callback for the element the web camera renders into */
  readonly scanTarget: (el: HTMLElement | null) => void
}

export function useVerify(
  onExit: (s: Extract<VerifyState, { name: 'exit' }>) => void,
  override?: VerifyState | null,
  /** the flow's state for the shell (null once the flow is gone) */
  onState?: (s: VerifyState | null) => void,
  /** a card link the app was opened with (#489): handed to the machine once it shows the own card
   *  (`ready`), as the step a camera read takes; `onLinkTaken` tells the shell it is consumed */
  link?: string | null,
  onLinkTaken?: () => void,
): VerifyFlow {
  const port = usePort()
  const platform = usePlatform()
  const [first] = useState(verifyStart)
  const [slot] = useState(scanTargetSlot)
  const [runner, setRunner] = useState<FlowRunner<VerifyState, VerifyEvent> | null>(null)
  useEffect(() => {
    if (override) return
    const scans = { current: null as AbortController | null }
    const r = createFlowRunner(verify, first, verifyExecutor(port, platform, scans, slot), platform)
    const push = () => {
      const e = bundleEvent(port)
      if (e) r.send(e)
    }
    const offContacts = port.stores.contacts.subscribe(push)
    const offDecisions = port.stores.decisions.subscribe(push)
    // a scan runs only while the machine is in `scanning`; back at the shown card, the bundle is read
    // again (a bundle that answered the card while the camera was open takes over now)
    let last = r.get().name
    const offScan = r.subscribe(() => {
      const name = r.get().name
      if (name !== 'scanning') scans.current?.abort()
      if (name === 'ready' && last !== 'ready') push()
      last = name
    })
    push()
    setRunner(r)
    return () => {
      offContacts()
      offDecisions()
      offScan()
      scans.current?.abort()
      r.dispose()
    }
    // the runner lives as long as the screen that started the flow
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const subscribe = runner ? runner.subscribe : noSubscribe
  const get = runner ? runner.get : () => override ?? first.state
  const state = useSyncExternalStore(subscribe, get, get)
  const exitRef = useRef(onExit)
  useEffect(() => {
    exitRef.current = onExit
  })
  const stateRef = useRef(onState)
  useEffect(() => {
    stateRef.current = onState
  })
  useEffect(() => {
    if (state.name === 'exit') exitRef.current(state)
    stateRef.current?.(state.name === 'exit' ? null : state)
  }, [state])
  useEffect(() => () => stateRef.current?.(null), [])
  const takenRef = useRef(onLinkTaken)
  useEffect(() => {
    takenRef.current = onLinkTaken
  })
  useEffect(() => {
    if (!runner || !link || state.name !== 'ready') return
    runner.send({ type: 'link', raw: link })
    takenRef.current?.()
  }, [runner, link, state.name])
  return { state, send: runner ? runner.send : noop, scanTarget: slot.set }
}

const noSubscribe = () => () => {}
const noop = () => {}
