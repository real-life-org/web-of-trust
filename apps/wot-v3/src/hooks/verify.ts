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
  return { follow: 'none', decision: null }
}

export function verifyExecutor(port: AppPort, platform: Pick<Platform, 'scanner' | 'clock'>, scans: { current: AbortController | null }) {
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
        return { ok: true, value: { availability, permission } }
      }
      case 'cam.scan': {
        scans.current?.abort()
        const ctl = new AbortController()
        scans.current = ctl
        return { ok: true, value: await platform.scanner.scan({ target: null, signal: ctl.signal }) }
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
      case 'ver.decline':
        return fromResult(await port.trust.decide(e.decision, 'decline').done)
    }
  }
}

/** The bundle event: verification per contact and the open encounter-confirm decisions. */
export function bundleEvent(port: AppPort): VerifyEvent | null {
  const contacts = port.stores.contacts.get()
  const decisions = port.stores.decisions.get()
  if (contacts.status !== 'ready' || decisions.status !== 'ready') return null
  const verifications: Record<string, Verification> = {}
  for (const c of contacts.value) verifications[c.id] = c.verification
  return { type: 'bundle', verifications, decisions: decisions.value.filter((d) => d.kind === 'encounter-confirm').map((d) => d.id) }
}

export interface VerifyFlow {
  readonly state: VerifyState
  readonly send: (e: VerifyEvent) => void
}

export function useVerify(onExit: (s: Extract<VerifyState, { name: 'exit' }>) => void, override?: VerifyState | null): VerifyFlow {
  const port = usePort()
  const platform = usePlatform()
  const [first] = useState(verifyStart)
  const [runner, setRunner] = useState<FlowRunner<VerifyState, VerifyEvent> | null>(null)
  useEffect(() => {
    if (override) return
    const scans = { current: null as AbortController | null }
    const r = createFlowRunner(verify, first, verifyExecutor(port, platform, scans), platform)
    const push = () => {
      const e = bundleEvent(port)
      if (e) r.send(e)
    }
    const offContacts = port.stores.contacts.subscribe(push)
    const offDecisions = port.stores.decisions.subscribe(push)
    // a scan runs only while the machine is in `scanning`
    const offScan = r.subscribe(() => {
      if (r.get().name !== 'scanning') scans.current?.abort()
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
  useEffect(() => {
    if (state.name === 'exit') exitRef.current(state)
  }, [state])
  return { state, send: runner ? runner.send : noop }
}

const noSubscribe = () => () => {}
const noop = () => {}
