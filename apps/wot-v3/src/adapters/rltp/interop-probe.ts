// The interop probe of the developer area (TRANSPORT.md "Interop probe"; Delivery 0.85 §4.6, VTI
// Mediator Adapter Profile 0.29 §3b, §5). One sealed envelope goes to the TSP identifier of a foreign
// Trust Task agent through the build's mediator, carried as a `sealed-envelope/0.1` document in the
// registry's TSP binding envelope, exactly as the carrier sends every document (the library's adapter
// over the app's wire). The agent dispatches by `type` without opening the seal and answers the
// authenticated sender: `trust-task-error` `unsupportedType` fails the submission
// (`rejected-by-receiver`), `trust-task-next-step` makes it `accepted` and held. The line shows it.
//
//  - No contact, no relationship, no holder data: a throwaway root and carrier nonce per probe, so a
//    throwaway connection DID; nothing is stored, a new probe or leaving the page ends it.
//  - The seal is the seal-only sample of the Delivery Contract's seal vector (`seal-vector-sample/0.1`,
//    never a wire type), sealed to that vector's public test key, whose private key is published with
//    the vector: no reader can take anything from it.
//  - The submission is filed as a custody entry would be (reconcile, its gate starts the deposit at
//    once), so its answer binds by the carried document's id and travels in the collection; the probe
//    concludes every collection at once (there is no holder to record a report).
//  - Built only behind VITE_INTEROP_PROBE in a web build (app/compose.ts, dynamic import): no store
//    build carries this module (scripts/check-build.mjs).

import { seal, type TransportView } from '@real-life/trust-protocol'
import { MediatorCarrierAdapter, type SubmissionState } from '@real-life/trust-protocol/adapters/vti-mediator'
import type { DeliveryItemView } from '@real-life/trust-protocol'
import { writableStore, type DeliveryState, type InteropProbe, type InteropProbeState } from '../../port'
import type { NetworkPort } from '../../platform/ports'
import { deliveryOf } from './ingest'
import type { DeviceTimers } from './transport'
import { createVtiWire, type VtiWire, type WireConfig } from './wire'

/** how often (device time) the probe advances its adapter and concludes what it collected */
export const PROBE_TICK_MS = 1000

/** The seal-only sample document of vectors/seal.json (Delivery Contract §5): the reserved sample type,
 *  never processed as a delivery document. */
export const PROBE_DOCUMENT = {
  id: '11111111-2222-4333-8444-555555555555',
  issuedAt: '2026-08-10T12:00:00Z',
  issuer: 'did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK',
  payload: { meaning: 'received', ref: 'uEiANDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ' },
  recipient: 'did:key:z6MkjchhfUsD6mmvni8mCdXHw216Xrm9bQe2mBH1P5RDjVJG',
  threadId: '99999999-8888-4777-a666-555555555555',
  type: 'https://real-life.org/trust-tasks/spec/seal-vector-sample/0.1',
} as const
/** the seal vector's public test key (its private key is published with the vector) */
export const PROBE_RKID = 'z6LStLK2kxribiLHz6U4vpGfzMtmgc4q5WjR4mvhS6KG1W16'
const DIGEST = 'interop-probe'
const DAY = 86_400_000

/** an Ed25519 did:key as RLTP-VTI-1210 names it (the wire resolves its keys offline) */
const DID_KEY = /^did:key:z6Mk[1-9A-HJ-NP-Za-km-z]{44}$/

export interface InteropProbeConfig {
  /** C, exactly as configured for this build */
  readonly mediatorDid: string
  readonly clock: DeviceTimers
  readonly network?: NetworkPort
  /** the network below the wire (tests: the mediator double) */
  readonly net?: WireConfig['net']
  /** tests: the throwaway root IKM (64 bytes) and carrier nonce (32 bytes) */
  readonly random?: (n: number) => Uint8Array
}

/** The submission's state as the delivery line of a message shows it (ingest.ts deliveryOf). */
export function probeDelivery(st: SubmissionState | null): DeliveryState | null {
  if (st === null) return { phase: 'submitted' }
  const base = { digest: DIGEST, type: '', threadId: '', contactId: '', attempt: 1, submittedAt: 0, updatedAt: 0 }
  const view: DeliveryItemView =
    st.state === 'awaiting-transport'
      ? { ...base, status: 'submitted', awaiting: st.reason }
      : st.state === 'accepted'
        ? { ...base, status: 'accepted', ...(st.held === true ? { held: true as const } : {}) }
        : st.state === 'failed'
          ? { ...base, status: 'failed', reason: st.reason, ...(st.reason === 'rejected-by-receiver' ? { code: st.code } : {}) }
          : { ...base, status: 'delivered', ...(st.late === true ? { late: true } : {}) }
  return deliveryOf([view])
}

export function interopProbe(cfg: InteropProbeConfig): InteropProbe {
  const { clock } = cfg
  const random = cfg.random ?? ((n: number) => crypto.getRandomValues(new Uint8Array(n)))
  const state = writableStore<InteropProbeState>({ phase: 'idle' })
  /** the running probe; a newer `send` or `stop` ends it, and its late steps act no more */
  let run: { adapter: MediatorCarrierAdapter | null; wire: VtiWire | null; timer: (() => void) | null; ended: boolean } | null = null

  const end = () => {
    const r = run
    run = null
    if (!r) return
    r.ended = true
    r.timer?.()
    r.adapter?.close()
    r.wire?.close()
  }

  const start = async (counterpart: string, r: NonNullable<typeof run>) => {
    const rootIkm = random(64)
    const nonce = random(32)
    let wire: VtiWire
    let adapter: MediatorCarrierAdapter
    try {
      wire = await createVtiWire({
        rootIkm,
        mediatorDid: cfg.mediatorDid,
        nonce,
        peerDid: counterpart,
        clock,
        network: () => cfg.network?.current() ?? 'unknown',
        ...(cfg.net ? { net: cfg.net } : {}),
      })
      r.wire = wire
      if (r.ended) return wire.close()
      adapter = await MediatorCarrierAdapter.create(rootIkm, cfg.mediatorDid, nonce, wire)
      r.adapter = adapter
      // overtaken while the adapter was made: only this run's own adapter closes (its wire closed with
      // the end of the run), never the newer run that `end()` would name
      if (r.ended) return adapter.close()
      adapter.register([], clock.now())
      await adapter.settle()
      if (r.ended) return
    } catch {
      if (!r.ended) state.set({ phase: 'unreachable' })
      return
    }
    const since = clock.now()
    let refs
    try {
      const envelope = await seal(PROBE_DOCUMENT, PROBE_RKID)
      if (r.ended) return
      const view: TransportView = {
        ok: true,
        commitSeq: '0',
        at: since,
        entries: [
          {
            digest: DIGEST,
            kind: 'document',
            envelope,
            type: PROBE_DOCUMENT.type,
            threadId: PROBE_DOCUMENT.threadId,
            recipient: { contactId: 'interop-probe', rkid: PROBE_RKID, keyAgreement: PROBE_RKID },
            attempt: 0,
            since,
            notAfter: since + DAY,
          },
        ],
        answerable: [],
      }
      refs = adapter.reconcile(view, { handOver: async (_e, _w, go) => go() }, since)
    } catch {
      if (!r.ended) state.set({ phase: 'unreachable' })
      return
    }
    const id = refs[0]?.submissionId
    if (id === undefined) return
    const show = () => {
      if (r.ended) return
      const frames = wire.sentFrames()
      state.set({ phase: 'running', counterpart, mode: frames.at(-1)?.mode ?? null, delivery: probeDelivery(adapter.status(id)) })
    }
    /** ticks since the line became final (failed or delivered) */
    let afterFinal = 0
    const step = () => {
      r.timer = null
      if (r.ended) return
      try {
        adapter.advance(clock.now())
        // no holder records a report here: what the adapter bound and applied is acknowledged at once
        adapter.conclude(adapter.collect(clock.now()), clock.now())
      } catch {
        // retired meanwhile
      }
      show()
      // a final line changes no more: one tick after it (its advance sends the acknowledgement of the
      // concluded answer), the probe stops ticking; held is not final (an ack or a refusal may follow)
      let st: SubmissionState | null = null
      try {
        st = adapter.status(id)
      } catch {
        // retired meanwhile
      }
      if (st !== null && (st.state === 'failed' || st.state === 'delivered') && afterFinal++ >= 1) return
      r.timer = clock.setTimer(clock.now() + PROBE_TICK_MS, step)
    }
    show()
    r.timer = clock.setTimer(clock.now() + PROBE_TICK_MS, step)
  }

  return {
    mediator: cfg.mediatorDid,
    state,
    send(counterpart) {
      end()
      const did = counterpart.trim()
      if (!DID_KEY.test(did)) {
        state.set({ phase: 'invalid' })
        return
      }
      const r = { adapter: null, wire: null, timer: null, ended: false }
      run = r
      state.set({ phase: 'running', counterpart: did, mode: null, delivery: { phase: 'committing' } })
      void start(did, r).catch(() => {
        if (!r.ended) state.set({ phase: 'unreachable' })
      })
    },
    stop() {
      end()
      state.set({ phase: 'idle' })
    },
  }
}
