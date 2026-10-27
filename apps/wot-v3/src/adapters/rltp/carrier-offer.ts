// The carrier offer of an encounter act (since lib 0.8.0 `show`/`scan` option `carrier`; VTI Mediator Adapter
// Profile 0.28 §1b, Identity §7a.3): the relationship's carrier nonce N, 32 bytes drawn fresh by the
// app at the gesture and journaled with the act (a repeat under the same actId gives the same card),
// and this side's delivery hint for C, built at the act from (root, C, N) as the adapter's factory
// derives its identities. N appears in no card and on no wire; only the identities derived from it do.

import type { CarrierOffer } from '@real-life/trust-protocol'
import { deliveryHint } from '@real-life/trust-protocol/adapters/vti-mediator'

/** what the intent journal keeps of an offer: C and N (base64url), nothing derived */
export interface JournaledOffer {
  readonly c: string
  readonly nonce: string
}

const b64u = (u8: Uint8Array) => {
  let bin = ''
  for (const b of u8) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
const unb64u = (s: string): Uint8Array => {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4))
  return Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad), (c) => c.charCodeAt(0))
}

export function journaledOffer(c: string, nonce: Uint8Array): JournaledOffer {
  if (nonce.length !== 32) throw new RangeError('the carrier nonce is 32 bytes')
  return { c, nonce: b64u(nonce) }
}

/** The library's offer from a journaled one; undefined when the act input carries none. */
export async function carrierOffer(rootIkm: Uint8Array, raw: unknown): Promise<CarrierOffer | undefined> {
  if (raw === undefined) return undefined
  const o = raw as Partial<JournaledOffer> | null
  if (o === null || typeof o !== 'object' || typeof o.c !== 'string' || typeof o.nonce !== 'string') throw new Error('act input carrier malformed')
  const nonce = unb64u(o.nonce)
  return { nonce, deliveryHints: [await deliveryHint(rootIkm, o.c, nonce)] }
}
