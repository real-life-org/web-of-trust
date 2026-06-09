import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { PublicIdentitySession } from '../../wot-core/src/application/identity'
import { createTestIdentity } from '../../wot-core/tests/helpers/identity-session'
import { InMemoryMessagingAdapter, InMemoryKeyManagementAdapter } from '@web_of_trust/core/adapters'
import { assertSpaceInviteBody, assertKeyRotationBody } from '@web_of_trust/core/protocol'
import { createSpaceKey, rotateSpaceKey, buildKeyRotationBody, buildSpaceInviteBody } from '@web_of_trust/core/application'
import { WebCryptoProtocolCryptoAdapter } from '@web_of_trust/core/protocol-adapters'
import { signEnvelope } from '@web_of_trust/core/crypto'
import { YjsReplicationAdapter } from '../src/YjsReplicationAdapter'
import type { MessageEnvelope, IncomingSpaceInvite } from '@web_of_trust/core/types'

// 1.B.3-key-rotation wire-form guarantees (Sync 003 ECIES container P1 + Sync 005 removal).
// C6: key material never travels plaintext; the whole spec body is ECIES-wrapped.
// C5/S2: removeMember sends key-rotation ONLY to remaining members, member-update to
// remaining + the removed member.

const wait = (ms = 300) => new Promise((r) => setTimeout(r, ms))
interface TestDoc { items: Record<string, { title: string }> }

const protocolCrypto = new WebCryptoProtocolCryptoAdapter()
const KEY_MATERIAL_MARKERS = ['spaceContentKey', 'spaceContentKeys', 'spaceCapabilitySigningKey', 'capability']

function inbox(messaging: InMemoryMessagingAdapter): MessageEnvelope[] {
  const captured: MessageEnvelope[] = []
  // Subscribe a capture-only listener (these recipients have no adapter of their own).
  messaging.onMessage((envelope) => {
    captured.push(envelope)
  })
  return captured
}

describe('Yjs key-rotation + invite wire form (C5/C6/S2)', () => {
  let alice: PublicIdentitySession, bob: PublicIdentitySession, carol: PublicIdentitySession
  let aliceMsg: InMemoryMessagingAdapter, bobMsg: InMemoryMessagingAdapter, carolMsg: InMemoryMessagingAdapter
  let aliceAdapter: YjsReplicationAdapter
  let bobAdapter: YjsReplicationAdapter | null = null
  let bobInbox: MessageEnvelope[], carolInbox: MessageEnvelope[]

  async function startBobAdapter(): Promise<{ adapter: YjsReplicationAdapter; keyPort: InMemoryKeyManagementAdapter }> {
    const keyPort = new InMemoryKeyManagementAdapter()
    bobAdapter = new YjsReplicationAdapter({
      identity: bob,
      messaging: bobMsg,
      brokerUrls: ['wss://broker.example.com'],
      keyManagement: keyPort,
    })
    await bobAdapter.start()
    return { adapter: bobAdapter, keyPort }
  }

  beforeEach(async () => {
    InMemoryMessagingAdapter.resetAll()
    alice = (await createTestIdentity('alice-pass')).identity
    bob = (await createTestIdentity('bob-pass')).identity
    carol = (await createTestIdentity('carol-pass')).identity
    aliceMsg = new InMemoryMessagingAdapter()
    bobMsg = new InMemoryMessagingAdapter()
    carolMsg = new InMemoryMessagingAdapter()
    await aliceMsg.connect(alice.getDid())
    await bobMsg.connect(bob.getDid())
    await carolMsg.connect(carol.getDid())
    bobInbox = inbox(bobMsg)
    carolInbox = inbox(carolMsg)
    aliceAdapter = new YjsReplicationAdapter({
      identity: alice,
      messaging: aliceMsg,
      brokerUrls: ['wss://broker.example.com'],
      keyManagement: new InMemoryKeyManagementAdapter(),
    })
    await aliceAdapter.start()
  })
  afterEach(async () => {
    await aliceAdapter.stop()
    if (bobAdapter) { await bobAdapter.stop(); bobAdapter = null }
    InMemoryMessagingAdapter.resetAll()
    for (const id of [alice, bob, carol]) { try { await id.deleteStoredIdentity() } catch {} }
  })

  it('C6: space-invite payload is the ECIES container with no plaintext key material; body decrypts + validates', async () => {
    const space = await aliceAdapter.createSpace<TestDoc>('shared', { items: {} }, { name: 'S', members: [alice.getDid()] })
    await aliceAdapter.addMember(space.id, bob.getDid(), await bob.getEncryptionPublicKeyBytes())
    await wait()

    const invite = bobInbox.find((m) => m.type === 'space-invite')!
    expect(invite).toBeTruthy()
    // P1 container form: only ecies + optional encryptedDocSnapshot, no plaintext body.
    const container = JSON.parse(invite.payload)
    expect(Object.keys(container).sort()).toEqual(['ecies', 'encryptedDocSnapshot'])
    expect(container.ecies.ephemeralPublicKey).toBeTruthy()
    for (const marker of KEY_MATERIAL_MARKERS) expect(invite.payload).not.toContain(marker)

    // decrypt → spec body validates
    const bytes = await bob.decryptForMe({
      ciphertext: new Uint8Array(container.ecies.ciphertext),
      nonce: new Uint8Array(container.ecies.nonce),
      ephemeralPublicKey: new Uint8Array(container.ecies.ephemeralPublicKey),
    })
    const body = JSON.parse(new TextDecoder().decode(bytes))
    expect(() => assertSpaceInviteBody(body)).not.toThrow()
    expect(body.spaceId).toBe(space.id)
    expect(body.brokerUrls).toEqual(['wss://broker.example.com'])
  })

  it('C5 + S2 + C6: removeMember rotates to remaining only, member-updates everyone; key-rotation body is encrypted + valid', async () => {
    const space = await aliceAdapter.createSpace<TestDoc>('shared', { items: {} }, { name: 'S', members: [alice.getDid()] })
    await aliceAdapter.addMember(space.id, bob.getDid(), await bob.getEncryptionPublicKeyBytes())
    await aliceAdapter.addMember(space.id, carol.getDid(), await carol.getEncryptionPublicKeyBytes())
    await wait()
    bobInbox.length = 0
    carolInbox.length = 0

    await aliceAdapter.removeMember(space.id, carol.getDid())
    await wait()

    // C5: key-rotation reaches the remaining member (bob), NOT the removed member (carol).
    expect(bobInbox.some((m) => m.type === 'key-rotation')).toBe(true)
    expect(carolInbox.some((m) => m.type === 'key-rotation')).toBe(false)
    // S2: member-update reaches BOTH the remaining member and the removed member.
    expect(bobInbox.some((m) => m.type === 'member-update')).toBe(true)
    expect(carolInbox.some((m) => m.type === 'member-update')).toBe(true)

    // C6: the key-rotation payload to bob is the ECIES container, no plaintext key material.
    const rotation = bobInbox.find((m) => m.type === 'key-rotation')!
    const container = JSON.parse(rotation.payload)
    expect(Object.keys(container)).toEqual(['ecies'])
    for (const marker of KEY_MATERIAL_MARKERS) expect(rotation.payload).not.toContain(marker)

    const bytes = await bob.decryptForMe({
      ciphertext: new Uint8Array(container.ecies.ciphertext),
      nonce: new Uint8Array(container.ecies.nonce),
      ephemeralPublicKey: new Uint8Array(container.ecies.ephemeralPublicKey),
    })
    const body = JSON.parse(new TextDecoder().decode(bytes))
    expect(() => assertKeyRotationBody(body)).not.toThrow()
    expect(body.spaceId).toBe(space.id)
    expect(body.generation).toBe(1)
  })

  it('B1/S2: emits a decoded onSpaceInvite event; receiver inherits name + appTag from _meta', async () => {
    const { adapter: receiver } = await startBobAdapter()
    const events: IncomingSpaceInvite[] = []
    receiver.onSpaceInvite((invite) => events.push(invite))

    const space = await aliceAdapter.createSpace<TestDoc>(
      'shared', { items: {} }, { name: 'Garten', appTag: 'rls', members: [alice.getDid()] },
    )
    await aliceAdapter.addMember(space.id, bob.getDid(), await bob.getEncryptionPublicKeyBytes())
    await wait()

    expect(events).toHaveLength(1)
    expect(events[0]).toEqual({ spaceId: space.id, spaceName: 'Garten', fromDid: alice.getDid() })
    const bobSpace = await receiver.getSpace(space.id)
    expect(bobSpace?.name).toBe('Garten')
    expect(bobSpace?.appTag).toBe('rls') // S2: cross-app isolation survives the invite
  })

  it('S3/C5 adapter-level: a self-consistent rotation from a non-admin sender is rejected; the same shape from the admin applies', async () => {
    const { adapter: receiver, keyPort: bobKeys } = await startBobAdapter()
    const space = await aliceAdapter.createSpace<TestDoc>('shared', { items: {} }, { name: 'S', members: [alice.getDid()] })
    await aliceAdapter.addMember(space.id, bob.getDid(), await bob.getEncryptionPublicKeyBytes())
    await wait()
    expect(await bobKeys.getCurrentGeneration(space.id)).toBe(0) // invite applied
    const bobEncKey = await bob.getEncryptionPublicKeyBytes()

    async function craftedRotation(sender: PublicIdentitySession): Promise<MessageEnvelope> {
      // Fully self-consistent gen-1 body from the sender's OWN key material: the capability
      // verifies against the included signing key — only the C1 authority check can stop it.
      const port = new InMemoryKeyManagementAdapter()
      await createSpaceKey({ crypto: protocolCrypto, keyPort: port, spaceId: space.id, ownerDid: sender.getDid() })
      await rotateSpaceKey({ crypto: protocolCrypto, keyPort: port, spaceId: space.id, ownerDid: sender.getDid() })
      const body = await buildKeyRotationBody({ keyPort: port, spaceId: space.id, newGeneration: 1, recipientDid: bob.getDid() })
      const ecies = await sender.encryptForRecipient(new TextEncoder().encode(JSON.stringify(body)), bobEncKey)
      const envelope: MessageEnvelope = {
        v: 1, id: crypto.randomUUID(), type: 'key-rotation',
        fromDid: sender.getDid(), toDid: bob.getDid(),
        createdAt: new Date().toISOString(), encoding: 'json',
        payload: JSON.stringify({
          ecies: {
            ciphertext: Array.from(ecies.ciphertext),
            nonce: Array.from(ecies.nonce),
            ephemeralPublicKey: Array.from(ecies.ephemeralPublicKey!),
          },
        }),
        signature: '',
      }
      return signEnvelope(envelope, (data) => sender.sign(data))
    }

    // carol is NOT members[0] (= alice) → C1 must reject, nothing persisted
    await carolMsg.send(await craftedRotation(carol))
    await wait()
    expect(await bobKeys.getCurrentGeneration(space.id)).toBe(0)
    expect(await bobKeys.getCapabilitySigningSeed(space.id, 1)).toBeNull()

    // positive control: the IDENTICAL shape from the admin (alice) applies — proving the
    // rejection above was the authority check, not a container/shape artifact
    await aliceMsg.send(await craftedRotation(alice))
    await wait()
    expect(await bobKeys.getCurrentGeneration(space.id)).toBe(1)
    expect(await bobKeys.getCapabilitySigningSeed(space.id, 1)).not.toBeNull()
  })

  it('S4: applies a spec-conformant invite WITHOUT encryptedDocSnapshot (keys persisted, space registered)', async () => {
    const { adapter: receiver, keyPort: bobKeys } = await startBobAdapter()
    const events: IncomingSpaceInvite[] = []
    receiver.onSpaceInvite((invite) => events.push(invite))

    const spaceId = crypto.randomUUID()
    const senderPort = new InMemoryKeyManagementAdapter()
    await createSpaceKey({ crypto: protocolCrypto, keyPort: senderPort, spaceId, ownerDid: alice.getDid() })
    const body = await buildSpaceInviteBody({
      keyPort: senderPort, spaceId, recipientDid: bob.getDid(),
      brokerUrls: ['wss://broker.example.com'], adminDids: [alice.getDid()],
    })
    const ecies = await alice.encryptForRecipient(new TextEncoder().encode(JSON.stringify(body)), await bob.getEncryptionPublicKeyBytes())
    const envelope: MessageEnvelope = {
      v: 1, id: crypto.randomUUID(), type: 'space-invite',
      fromDid: alice.getDid(), toDid: bob.getDid(),
      createdAt: new Date().toISOString(), encoding: 'json',
      payload: JSON.stringify({
        ecies: {
          ciphertext: Array.from(ecies.ciphertext),
          nonce: Array.from(ecies.nonce),
          ephemeralPublicKey: Array.from(ecies.ephemeralPublicKey!),
        },
        // NO encryptedDocSnapshot — pure spec invite, doc arrives via regular sync
      }),
      signature: '',
    }
    await aliceMsg.send(await signEnvelope(envelope, (data) => alice.sign(data)))
    await wait()

    expect(await bobKeys.getKeyByGeneration(spaceId, 0)).not.toBeNull()
    expect(await bobKeys.getCapabilityVerificationKey(spaceId, 0)).not.toBeNull()
    expect(await receiver.getSpace(spaceId)).not.toBeNull()
    expect(events.some((e) => e.spaceId === spaceId && e.fromDid === alice.getDid())).toBe(true)
  })
})
