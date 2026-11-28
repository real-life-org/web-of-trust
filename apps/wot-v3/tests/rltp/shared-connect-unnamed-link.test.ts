// @vitest-environment node
// A name that does not fit into the shown link beside the card is left out, the card stays: the code is
// read as unnamed, and its back-code opens the contact without a carrier as for any code shown in person.
import { describe, expect, it } from 'vitest'
import type { Loadable, ReadStore } from '../../src/port'
import { virtualClock } from '../../src/platform/fake'
import { NAME_MAX } from '../../src/screens/identity/ProfileNameScreen'
import { LOOPBACK_PHRASES, loopbackDevice } from '../../harness/loopback'
import { mediatorDouble, phoneNet } from '../../harness/mediator-double'

const value = <T>(s: ReadStore<Loadable<T>>): T => {
  const v = s.get()
  if (v.status !== 'ready') throw new Error(`store ${v.status}`)
  return v.value
}

describe('a shown code whose name does not fit beside the card', () => {
  it('carries the card without the name: read as unnamed, the back-code opens the contact offline, the confirmation names the responder', async () => {
    const med = mediatorDouble()
    const clock = virtualClock(Date.parse('2026-11-20T10:00:00Z'), 'UTC')
    const netA = phoneNet(med.net), netB = phoneNet(med.net)
    // the longest name the profile screen takes, in characters of three bytes each
    const long = '名'.repeat(NAME_MAX)
    const A = await loopbackDevice({ carrier: { mediator: { did: med.did, net: netA.net } }, id: 'A', name: 'Al', words: LOOPBACK_PHRASES[0], clock, seed: 61, ceremony: 'shared-connect' })
    const B = await loopbackDevice({ carrier: { mediator: { did: med.did, net: netB.net } }, id: 'B', name: long, words: LOOPBACK_PHRASES[1], clock, seed: 67, ceremony: 'shared-connect' })
    for (const [d, n] of [[A, netA], [B, netB]] as const) {
      n.setOnline(false)
      d.platform.network.set('offline')
    }
    const settle = async () => {
      for (let i = 0; i < 20; i++) {
        await med.settled()
        await A.port.session()?.idle()
        await B.port.session()?.idle()
        await new Promise((r) => setTimeout(r, 0))
      }
    }
    await settle()
    const shown = await B.port.trust.showCard().done
    if (!shown.ok) throw new Error('show')
    const link = decodeURIComponent(shown.value.qr)
    expect(link).toContain('&csig=')
    expect(link).not.toContain(long)
    expect(await A.port.trust.previewCard(shown.value.qr)).toEqual({ ok: true, value: { role: 'displayed', name: null, knownContact: null, self: false } })
    const proposed = await A.port.trust.confirmCard(shown.value.qr, 'camera').done
    if (!proposed.ok || proposed.value.kind !== 'proposed') throw new Error('propose')
    await settle()
    expect(value(A.port.stores.connections)).toMatchObject([{ role: 'responder', status: 'open', name: null }])
    const back = await A.port.trust.showBackCode(proposed.value.connection).done
    if (!back.ok || back.value.kind !== 'shown') throw new Error('back ' + JSON.stringify(back))
    await settle()
    const [cA] = value(A.port.stores.contacts)
    expect(value(A.port.stores.connections)).toMatchObject([{ status: 'open', contactId: cA!.id, backShown: true }])
    expect(await B.port.trust.readBackCode(back.value.qr)).toEqual({ ok: true, value: { kind: 'taken', connection: shown.value.card } })
    await settle()
    expect(value(B.port.stores.decisions)).toMatchObject([{ kind: 'connect-confirm', name: 'Al', state: 'open' }])
  })
})
