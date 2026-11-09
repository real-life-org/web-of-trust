// @vitest-environment node
// The shared-connect wire (src/adapters/rltp/shared-connect-wire.ts) over the mediator double: two
// did:peer:2 identities whose keys come from the library's KeyProvider, documents both ways in both
// forms, an XRFI answered with XRFA while the link lives, frames of strangers after the expiry dropped,
// a counterpart check on the responder's side, and the reconnect after the socket closed.
import { describe, expect, it, vi } from 'vitest'
import { packInvite, pack as tspPack } from '@openvtc/vti-tsp-js'
import { BINDING_ENVELOPE, openSharedConnectWire, sharedConnectKeys, type SharedConnectWire } from '../../src/adapters/rltp/shared-connect-wire'
import type { WireRefusal } from '../../src/adapters/rltp/wire'
import { mediatorDouble, type MediatorDouble } from '../../harness/mediator-double'
import { virtualClock, type VirtualClock } from '../../src/platform/fake'

// the library itself (the lint rule keeps src/ outside adapters/rltp away from it; a test of the wire needs its keys and forms)
type Lib = {
  seedKeys(seed: Uint8Array): Parameters<typeof sharedConnectKeys>[0]
  sharedConnect: {
    partyFromSeeds(msgSeed: Uint8Array, pairSeed: Uint8Array, relays: { kind: string; address: string }[]): Promise<{ messaging: { did: string } }>
    parsePeer(did: string): Promise<{ x: Uint8Array } | null>
    TASK_PROPOSE: string
    TASK_ISSUE: string
    CLOCK_TOLERANCE_S: number
  }
}
const { seedKeys, sharedConnect: sc } = await vi.importActual<Lib>('@real-life/trust-protocol')

const rand = (n: number) => crypto.getRandomValues(new Uint8Array(n))
// a session reads a frame in steps of its own before the wire counts it: a real millisecond per turn
const turn = () => new Promise((r) => setTimeout(r, 1))
const te = new TextEncoder()

/** one side: a KeyProvider over a random root, the enactment nonce, the did:peer:2 the holder would write */
async function side(med: MediatorDouble) {
  const keys = seedKeys(rand(64))
  const nonce = rand(16)
  const { messaging, pair } = await keys.sharedConnectSeeds!(nonce)
  const party = await sc.partyFromSeeds(messaging, pair, [{ kind: 'tsp-mediator', address: med.did }])
  const did = party.messaging.did
  return { keys, nonce, did, wire: await sharedConnectKeys(keys, nonce, did) }
}

async function flush(med: MediatorDouble, ...wires: SharedConnectWire[]) {
  for (let calm = 0; calm < 5; ) {
    await med.settled()
    await turn()
    calm = wires.reduce((n, w) => n + w.busy(), 0) === 0 ? calm + 1 : 0
  }
}

describe('shared-connect wire', () => {
  async function setup(opts: { expInSeconds?: number } = {}) {
    const med = mediatorDouble()
    const clock: VirtualClock = virtualClock(Date.parse('2026-11-09T10:00:00Z'), 'UTC')
    const exp = Math.floor(clock.now() / 1000) + (opts.expInSeconds ?? 600)
    const I = await side(med)
    const R = await side(med)
    const atI: { doc: unknown; from: string }[] = []
    const atR: { doc: unknown; from: string }[] = []
    const refusals: WireRefusal[] = []
    const inviter = await openSharedConnectWire({ mediatorDid: med.did, did: I.did, keys: I.wire, exp, clock, net: med.net, onDocument: (doc, from) => void atI.push({ doc, from }), report: (r) => refusals.push(r) })
    const responder = await openSharedConnectWire({ mediatorDid: med.did, did: R.did, keys: R.wire, exp, peerDid: I.did, clock, net: med.net, onDocument: (doc, from) => void atR.push({ doc, from }), report: (r) => refusals.push(r) })
    await flush(med, inviter, responder)
    return { med, clock, exp, I, R, inviter, responder, atI, atR, refusals }
  }

  it('derives the messaging keys from the KeyProvider and checks them against the did:peer:2', async () => {
    const med = mediatorDouble()
    const A = await side(med)
    expect(A.wire.xPublic.length).toBe(32)
    const other = await side(med)
    await expect(sharedConnectKeys(A.keys, A.nonce, other.did)).rejects.toThrow(/does not match/)
    await expect(sharedConnectKeys(A.keys, A.nonce, 'did:key:z6Mk' + 'a'.repeat(44))).rejects.toThrow(/no peer DID/)
  })

  it('carries documents both ways, bare and in the binding envelope, and names the verified sender', async () => {
    const { med, inviter, responder, atI, atR, I, R } = await setup()
    expect(inviter.isOpen() && responder.isOpen()).toBe(true)
    const propose = { type: sc.TASK_PROPOSE, id: 'p-1', payload: { reason: 'Bea' } }
    await responder.send(I.did, [propose])
    await flush(med, inviter, responder)
    expect(atI).toEqual([{ doc: propose, from: R.did }])
    const accept = { type: sc.TASK_PROPOSE + '#response', id: 'a-1' }
    const issue = { type: sc.TASK_ISSUE, id: 'i-1' }
    await inviter.send(R.did, [accept, issue])
    await flush(med, inviter, responder)
    expect(atR.map((x) => x.doc)).toEqual([accept, issue])
    expect(atR.every((x) => x.from === I.did)).toBe(true)
    // a counterpart that wraps its documents in the binding envelope: the inviter reads the inner document
    const wrapped = await tspPack(te.encode(JSON.stringify({ type: BINDING_ENVELOPE, document: { type: sc.TASK_ISSUE + '#response', id: 'r-1' } })), R.did, I.did, { senderSigningKey: R.wire.edSecret, receiverEncryptionKey: (await sc.parsePeer(I.did))!.x })
    med.deliver(I.did, wrapped.bytes)
    await flush(med, inviter, responder)
    expect(atI.at(-1)).toEqual({ doc: { type: sc.TASK_ISSUE + '#response', id: 'r-1' }, from: R.did })
    inviter.close()
    responder.close()
  })

  it('answers an XRFI with XRFA while the link lives; after the expiry a stranger is dropped and the counterpart still heard', async () => {
    const { med, clock, exp, inviter, responder, atI, I, refusals } = await setup({ expInSeconds: 60 })
    // the responder opens the relationship first (as Keyring does): the inviter answers with XRFA
    const S0 = await side(med)
    const inv = await packInvite(S0.did, I.did, { senderSigningKey: S0.wire.edSecret, receiverEncryptionKey: (await sc.parsePeer(I.did))!.x })
    const direct0 = med.direct.length
    med.deliver(I.did, inv.bytes)
    await flush(med, inviter, responder)
    expect(med.direct.filter((d) => d.sender === I.did && d.receiver === S0.did).length).toBe(1)
    await responder.send(I.did, [{ type: sc.TASK_PROPOSE, id: 'p-2' }])
    await flush(med, inviter, responder)
    expect(atI.length).toBe(1)
    // the link expires: a stranger's document is refused, the counterpart's still arrives
    clock.advance((exp + sc.CLOCK_TOLERANCE_S + 5) * 1000 - clock.now())
    const S = await side(med)
    const stranger = await openSharedConnectWire({ mediatorDid: med.did, did: S.did, keys: S.wire, exp: exp + 3600, clock, net: med.net, onDocument: () => {} })
    await flush(med, stranger)
    await stranger.send(I.did, [{ type: sc.TASK_PROPOSE, id: 'p-late' }])
    await responder.send(I.did, [{ type: sc.TASK_ISSUE, id: 'i-late' }])
    await flush(med, inviter, responder, stranger)
    expect(atI.map((x) => (x.doc as { id: string }).id)).toEqual(['p-2', 'i-late'])
    expect(refusals.map((r) => r.detail)).toContain('direct-after-expiry')
    expect(med.direct.length).toBeGreaterThan(direct0)
    // after the expiry a stranger's XRFI gets no answer
    const S2 = await side(med)
    const inv2 = await packInvite(S2.did, I.did, { senderSigningKey: S2.wire.edSecret, receiverEncryptionKey: (await sc.parsePeer(I.did))!.x })
    med.deliver(I.did, inv2.bytes)
    await flush(med, inviter, responder)
    expect(med.direct.filter((d) => d.receiver === S2.did).length).toBe(0)
    expect(refusals.map((r) => r.detail)).toContain('control-after-expiry')
    stranger.close()
    inviter.close()
    responder.close()
  })

  it("the responder's wire refuses frames of anyone but the inviter", async () => {
    const { med, inviter, responder, atR, R, refusals } = await setup()
    const S = await side(med)
    const stranger = await openSharedConnectWire({ mediatorDid: med.did, did: S.did, keys: S.wire, exp: Math.floor(Date.now() / 1000) + 600, clock: virtualClock(Date.now(), 'UTC'), net: med.net, onDocument: () => {} })
    await flush(med, stranger)
    await stranger.send(R.did, [{ type: sc.TASK_ISSUE, id: 'x' }])
    await flush(med, inviter, responder, stranger)
    expect(atR).toEqual([])
    expect(refusals.map((r) => r.detail)).toContain('not-the-counterpart')
    stranger.close()
    inviter.close()
    responder.close()
  })

  it('reconnects after the socket closed and sends again; close ends it for good', async () => {
    const { med, clock, inviter, responder, atI, I } = await setup()
    for (const ws of [...med.sockets.values()]) ws.close()
    await flush(med, inviter, responder)
    // the backoff runs on the device clock
    for (let i = 0; i < 6 && !inviter.isOpen(); i++) {
      clock.advance(1000)
      await flush(med, inviter, responder)
    }
    expect(inviter.isOpen()).toBe(true)
    await responder.send(I.did, [{ type: sc.TASK_PROPOSE, id: 'p-after' }])
    await flush(med, inviter, responder)
    expect(atI.map((x) => (x.doc as { id: string }).id)).toEqual(['p-after'])
    inviter.close()
    expect(inviter.isOpen()).toBe(false)
    await expect(inviter.send(I.did, [{}])).rejects.toThrow(/closed/)
    responder.close()
  })
})
