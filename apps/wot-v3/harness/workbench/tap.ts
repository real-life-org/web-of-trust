// The workbench's wire, watched on the phones (architecture §7.4): what each device hands its carrier
// and what each device takes from it, whatever the carrier is (the in-memory carrier, the VTI mediator
// double, a live mediator). A document and its arrival are matched by the nonce of the sealed envelope,
// which the sender and the receiver see alike (Delivery §5: one seal, one nonce). Watching never
// changes a delivery: a watcher that throws is dropped.

import type { MediatorCarrier } from '../../src/adapters/rltp/carrier-mediator'
import type { CustodyLease, Transport, TransportHandlers } from '../../src/adapters/rltp/transport'

export type DeviceEvent =
  | { readonly kind: 'submitted'; readonly from: string; readonly key: string; readonly digest: string; readonly type: string; readonly attempt: number }
  | { readonly kind: 'received'; readonly to: string; readonly key: string; readonly answer: 'taken' | 'later' }

/** the nonce of a sealed envelope, or null for anything else */
export function envelopeKey(env: unknown): string | null {
  const n = (env as { nonce?: unknown } | null)?.nonce
  return typeof n === 'string' ? n : null
}

function watchHandlers(id: string, h: TransportHandlers, tell: (e: DeviceEvent) => void): TransportHandlers {
  return {
    ...h,
    async envelope(env) {
      const answer = await h.envelope(env)
      const key = envelopeKey(env)
      if (key && answer !== 'not-mine') tell({ kind: 'received', to: id, key, answer })
      return answer
    },
  }
}

/** a device's carrier as the adapter sees it, watched: an in-memory endpoint or a mediator carrier */
export function tapDevice<T extends Transport | MediatorCarrier>(id: string, carrier: T, watch: (e: DeviceEvent) => void): T {
  const tell = (e: DeviceEvent) => {
    try {
      watch(e)
    } catch {
      /* a broken watcher never touches a delivery */
    }
  }
  if ('kind' in carrier && carrier.kind === 'mediator') {
    const m = carrier as MediatorCarrier
    const seen = new Set<string>()
    return {
      ...m,
      lease(): CustodyLease {
        const l = m.lease()
        return {
          ...l,
          // a bound relationship delivers through the handlers; a displayed card's instance before its
          // binding delivers the scanner's bundle through the opening (receiveAtCard)
          start: (h, opening) =>
            l.start(watchHandlers(id, h, tell), {
              ...opening,
              async receiveAtCard(env, card) {
                const r = await opening.receiveAtCard(env, card)
                const key = envelopeKey(env)
                if (key && r.answer !== 'not-mine') tell({ kind: 'received', to: id, key, answer: r.answer })
                return r
              },
            }),
          reconcile(view) {
            // the holder's custody view lists what is out on the carrier: each envelope once
            for (const e of view.entries) {
              const key = envelopeKey(e.envelope)
              if (!key || seen.has(key)) continue
              seen.add(key)
              tell({ kind: 'submitted', from: id, key, digest: e.digest, type: e.type, attempt: e.attempt })
            }
            l.reconcile(view)
          },
        }
      },
    } as T
  }
  const t = carrier as Transport
  return {
    ...t,
    start: (h) => t.start(watchHandlers(id, h, tell)),
    submit(out) {
      for (const o of out) {
        const key = envelopeKey(o.envelope)
        if (key) tell({ kind: 'submitted', from: id, key, digest: o.digest, type: o.type, attempt: o.attempt })
      }
      t.submit(out)
    },
  } as T
}
