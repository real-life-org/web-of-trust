// @vitest-environment node
// The real adapter against the real library (architecture §3.3, §7.4 "Lib-Konformität"): two
// devices on an in-memory carrier meet through the port; every state comes from holder acts.
import { describe, expect, it } from 'vitest'
import type { ContactId, Conversation, EncounterOutcome, Loadable, ReadStore } from '../../src/port'
import { virtualClock } from '../../src/platform/fake'
import { LOOPBACK_PHRASES, loopbackDevice, memoryCarrier, type LoopbackDevice } from '../../harness/loopback'

const T0 = Date.parse('2026-10-15T13:30:00-07:00')

async function pair() {
  const carrier = memoryCarrier()
  const clock = virtualClock(T0, 'America/Los_Angeles')
  const A = await loopbackDevice({ carrier, id: 'A', name: 'Al', words: LOOPBACK_PHRASES[0], clock, seed: 11 })
  const B = await loopbackDevice({ carrier, id: 'B', name: 'Bea', words: LOOPBACK_PHRASES[1], clock, seed: 22 })
  const settle = async () => {
    for (let i = 0; i < 4; i++) {
      await carrier.settled()
      await A.port.session()?.idle()
      await B.port.session()?.idle()
    }
  }
  return { carrier, clock, A, B, settle }
}

const value = <T>(s: ReadStore<Loadable<T>>): T => {
  const v = s.get()
  if (v.status !== 'ready') throw new Error(`store ${v.status}`)
  return v.value
}
const contacts = (d: LoopbackDevice) => value(d.port.stores.contacts)
const conversation = (d: LoopbackDevice, key: string): Conversation => value(d.port.stores.conversation(key as Conversation['key']))

describe('encounter over the real adapter (loopback)', () => {
  it('B shows, A scans, B confirms: both mutual, with system lines and the decision card', async () => {
    const { A, B, settle } = await pair()
    expect(A.port.stores.identity.get().status).toBe('unlocked')
    const shown = await B.port.trust.showCard().done
    expect(shown.ok).toBe(true)
    if (!shown.ok) return
    expect(shown.value.qr).toMatch(/^https:\/\/web-of-trust\.de\/c#3:[A-Z2-7]+$/)
    expect(shown.value.expiresAt).toBe(T0 + 5 * 60_000)

    const preview = await A.port.trust.previewCard(shown.value.qr)
    expect(preview).toEqual({ ok: true, value: { role: 'displayed', name: 'Bea', knownContact: null, self: false } })
    const scanned = await A.port.trust.confirmCard(shown.value.qr).done
    expect(scanned.ok && scanned.value.kind).toBe('scanned')
    const aContact = (scanned.ok ? (scanned.value as Extract<EncounterOutcome, { kind: 'scanned' }>).contactId : '') as ContactId
    expect(contacts(A)).toMatchObject([{ id: aContact, name: 'Bea', verification: 'outgoing' }])

    await settle()
    const [bc] = contacts(B)
    expect(bc).toMatchObject({ name: 'Al', verification: 'incoming' })
    const decisions = value(B.port.stores.decisions)
    expect(decisions).toMatchObject([{ kind: 'encounter-confirm', contactId: bc?.id, state: 'open' }])
    const bConv = conversation(B, `c:${bc?.id}`)
    expect(bConv.items.filter((i) => i.kind !== 'day').map((i) => i.kind)).toEqual(['system', 'decision'])
    expect(value(B.port.stores.contact(bc!.id))?.actions.counterVerify).toEqual({ ok: true })

    const counter = await B.port.trust.counterVerify(bc!.id).done
    expect(counter.ok).toBe(true)
    await settle()
    expect(contacts(B)[0]?.verification).toBe('mutual')
    expect(contacts(A)[0]?.verification).toBe('mutual')
    expect(value(B.port.stores.decisions)).toEqual([])
    const resolved = conversation(B, `c:${bc?.id}`).items.find((i) => i.kind === 'decision')
    expect(resolved).toMatchObject({ resolution: { choice: 'accept', by: 'this-device', basis: 'own-act' } })
    const aLines = conversation(A, `c:${aContact}`).items.flatMap((i) => (i.kind === 'system' ? [i.system] : []))
    expect(aLines).toEqual(['outgoing', 'nowMutual'])
    const detail = value(A.port.stores.contact(aContact))
    expect(detail?.metAt).toBe(T0)
  })

  it('refuses the own code and garbage; an expired displayed code is refused before confirming', async () => {
    const { A, B, clock } = await pair()
    const shown = await B.port.trust.showCard().done
    if (!shown.ok) throw new Error('show')
    expect(await B.port.trust.previewCard(shown.value.qr)).toMatchObject({ ok: true, value: { self: true } })
    expect(await A.port.trust.previewCard('hello')).toEqual({ ok: false, error: { kind: 'refused', code: 'card-invalid' } })
    expect((await A.port.trust.confirmCard('https://web-of-trust.de/c#e30').done).ok).toBe(false)
    clock.advance(6 * 60_000)
    expect(await A.port.trust.previewCard(shown.value.qr)).toEqual({ ok: false, error: { kind: 'refused', code: 'code-expired' } })
  })

  it('optical return path: the scanner is offline, the displayer captures the sent card and counters', async () => {
    const { A, B, carrier, settle } = await pair()
    carrier.setOnline('A', false)
    const shown = await B.port.trust.showCard().done
    if (!shown.ok) throw new Error('show')
    const scanned = await A.port.trust.confirmCard(shown.value.qr).done
    if (!scanned.ok) throw new Error('scan')
    await settle()
    expect(contacts(B)).toEqual([])
    const sent = await A.port.trust.sentCardFor(scanned.value.contactId!)
    if (!sent.ok) throw new Error('sent card')
    expect(await B.port.trust.previewCard(sent.value.qr)).toMatchObject({ ok: true, value: { role: 'sent', name: 'Al' } })
    const captured = await B.port.trust.confirmCard(sent.value.qr).done
    expect(captured.ok && captured.value.kind).toBe('captured')
    // a second capture of the same card: already captured, no second decision (N9)
    const again = await B.port.trust.confirmCard(sent.value.qr).done
    expect(again.ok && again.value.kind).toBe('already-captured')
    expect(value(B.port.stores.decisions)).toHaveLength(1)
    const bId = contacts(B)[0]!.id
    expect((await B.port.trust.counterVerify(bId).done).ok).toBe(true)
    // B's own credential is issued; A's arrives with the bundle once A is online (Encounter 5.8)
    expect(contacts(B)[0]?.verification).toBe('outgoing')
    expect(contacts(A)[0]?.verification).toBe('outgoing')
    carrier.setOnline('A', true)
    await settle()
    expect(contacts(A)[0]?.verification).toBe('mutual')
    expect(contacts(B)[0]?.verification).toBe('mutual')
    expect(contacts(B)).toHaveLength(1)
  })

  it('locking empties the stores; unlocking brings back the same contacts', async () => {
    const { A, B, settle } = await pair()
    const shown = await B.port.trust.showCard().done
    if (!shown.ok) throw new Error('show')
    await A.port.trust.confirmCard(shown.value.qr).done
    await settle()
    await A.port.runtime.lock('user')
    expect(A.port.stores.contacts.get().status).toBe('loading')
    const { secret } = await import('../../src/port')
    expect((await A.port.runtime.unlock.passphrase(secret('harness passphrase'))).ok).toBe(true)
    expect((await A.port.runtime.unlock.open()).ok).toBe(true)
    expect(contacts(A)).toMatchObject([{ name: 'Bea', verification: 'outgoing' }])
  })
  it('a confirm journaled before a process loss is never run on its own: needs-confirmation, then confirm or discard (§3.4, N3)', async () => {
    const { A, B, settle } = await pair()
    const { secret } = await import('../../src/port')
    const shown = await B.port.trust.showCard().done
    if (!shown.ok) throw new Error('show')
    A.faults.killAt = 'after-journal'
    const lost = await A.port.trust.confirmCard(shown.value.qr).done
    expect(lost.ok).toBe(false)
    await A.port.runtime.lock('user')
    await A.port.runtime.unlock.passphrase(secret('harness passphrase'))
    await A.port.runtime.unlock.open()
    await A.port.session()?.idle()
    const [pending] = A.port.stores.intents.get()
    expect(pending).toMatchObject({ command: 'confirmCard', state: 'needs-confirmation', confirm: { kind: 'card', preview: { role: 'displayed', name: 'Bea' } } })
    expect(contacts(A)).toEqual([])
    const confirmed = await A.port.intents.confirmIntent(pending!.actId).done
    expect(confirmed.ok).toBe(true)
    expect(A.port.stores.intents.get()).toEqual([])
    expect(contacts(A)).toMatchObject([{ name: 'Bea', verification: 'outgoing' }])
    await settle()
    expect(contacts(B)).toHaveLength(1)

    // a showCard lost the same way is dropped, never shown again by itself
    A.faults.killAt = 'after-journal'
    await A.port.trust.showCard().done
    await A.port.runtime.lock('user')
    await A.port.runtime.unlock.passphrase(secret('harness passphrase'))
    await A.port.runtime.unlock.open()
    await A.port.session()?.idle()
    expect(A.port.stores.intents.get()).toEqual([])
    expect(contacts(A)).toHaveLength(1)
  })

  it('a pending confirm can be discarded', async () => {
    const { A, B } = await pair()
    const { secret } = await import('../../src/port')
    const shown = await B.port.trust.showCard().done
    if (!shown.ok) throw new Error('show')
    A.faults.killAt = 'after-journal'
    await A.port.trust.confirmCard(shown.value.qr).done
    await A.port.runtime.lock('user')
    await A.port.runtime.unlock.passphrase(secret('harness passphrase'))
    await A.port.runtime.unlock.open()
    await A.port.session()?.idle()
    const [pending] = A.port.stores.intents.get()
    expect((await A.port.intents.discardIntent(pending!.actId)).ok).toBe(true)
    expect(A.port.stores.intents.get()).toEqual([])
    expect(contacts(A)).toEqual([])
  })
})
