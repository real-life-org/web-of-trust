import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Repo } from '@automerge/automerge-repo'
import type { PublicIdentitySession } from '../../wot-core/src/application/identity'
import { createTestIdentity } from '../../wot-core/tests/helpers/identity-session'
import { InMemoryMessagingAdapter, InMemoryKeyManagementAdapter } from '@web_of_trust/core/adapters'
import {
  assertSpaceInviteBody, assertKeyRotationBody, assertEncryptedInboxEnvelope,
  decodeBase64Url, encryptOneShot, isDidcommMessage,
  SPACE_INVITE_MESSAGE_TYPE, KEY_ROTATION_MESSAGE_TYPE, MEMBER_UPDATE_MESSAGE_TYPE, ACK_MESSAGE_TYPE,
} from '@web_of_trust/core/protocol'
import type { EciesMessage } from '@web_of_trust/core/protocol'
import { createSpaceKey, rotateSpaceKey, buildKeyRotationBody, buildSpaceInviteBody, deliverInboxMessage } from '@web_of_trust/core/application'
import { WebCryptoProtocolCryptoAdapter } from '@web_of_trust/core/protocol-adapters'
import { AutomergeReplicationAdapter } from '../src/AutomergeReplicationAdapter'
import { encodeSpaceInviteSnapshotPayload } from '../src/space-invite-snapshot'
import type { WireMessage } from '@web_of_trust/core/ports'
import type { DidcommPlaintextMessage } from '@web_of_trust/core/protocol'
import type { IncomingSpaceInvite } from '@web_of_trust/core/types'

// Inbox-Wire-Form (Sync 003 Z.343-470), Automerge-Variante: die 3 Membership-Typen
// reisen als DIDComm-Plaintext-Envelope, Body = ECIES-Container {epk, nonce, ciphertext},
// Klartext-Body im Inner-JWS-Payload. Der Invite trägt zusätzlich das Extension-Feld
// `documentUrl` (automerge-repo doc id — Routing-Metadatum, KEIN Key-Material).
// C6: Key-Material nie im Klartext auf dem Wire. C5/S2: removeMember rotiert nur an
// Remaining, member-updated alle. ACK-Ownership (K1): ack/1.0 kommt vom Reception-Host
// nach Apply/durabler Pufferung — fehlgeschlagene Verarbeitung sendet KEIN ack.

const wait = (ms = 300) => new Promise((r) => setTimeout(r, ms))
interface TestDoc { items: Record<string, { title: string }> }

const protocolCrypto = new WebCryptoProtocolCryptoAdapter()
const KEY_MATERIAL_MARKERS = ['spaceContentKey', 'spaceContentKeys', 'spaceCapabilitySigningKey', 'capability']

function inbox(messaging: InMemoryMessagingAdapter): DidcommPlaintextMessage[] {
  const captured: DidcommPlaintextMessage[] = []
  // Subscribe a capture-only listener (these recipients have no adapter of their own).
  messaging.onMessage((message: WireMessage) => {
    if (isDidcommMessage(message)) captured.push(message)
  })
  return captured
}

/** Beobachtet abgehende ack/1.0-Envelopes eines Messaging-Adapters. */
function captureAcks(messaging: InMemoryMessagingAdapter): DidcommPlaintextMessage[] {
  const acks: DidcommPlaintextMessage[] = []
  const originalSend = messaging.send.bind(messaging)
  messaging.send = async (envelope: WireMessage) => {
    if (isDidcommMessage(envelope) && envelope.type === ACK_MESSAGE_TYPE) acks.push(envelope)
    return originalSend(envelope)
  }
  return acks
}

function decryptFor(identity: PublicIdentitySession) {
  return (message: EciesMessage) =>
    identity.decryptForMe({
      ephemeralPublicKey: decodeBase64Url(message.epk),
      nonce: decodeBase64Url(message.nonce),
      ciphertext: decodeBase64Url(message.ciphertext),
    })
}

/** Inner-JWS aus einem empfangenen Inbox-Envelope entschlüsseln → Klartext-Body. */
async function decryptInboxBody(recipient: PublicIdentitySession, envelope: DidcommPlaintextMessage): Promise<Record<string, unknown>> {
  const body = envelope.body as EciesMessage
  const jws = new TextDecoder().decode(await decryptFor(recipient)(body))
  const payloadSegment = jws.split('.')[1]
  const payload = JSON.parse(new TextDecoder().decode(decodeBase64Url(payloadSegment)))
  return payload.body as Record<string, unknown>
}

describe('Automerge inbox wire form (C5/C6/S2 + Inner-JWS + ack/1.0)', () => {
  let alice: PublicIdentitySession, bob: PublicIdentitySession, carol: PublicIdentitySession
  let aliceMsg: InMemoryMessagingAdapter, bobMsg: InMemoryMessagingAdapter, carolMsg: InMemoryMessagingAdapter
  let aliceAdapter: AutomergeReplicationAdapter
  let bobAdapter: AutomergeReplicationAdapter | null = null
  let bobInbox: DidcommPlaintextMessage[], carolInbox: DidcommPlaintextMessage[]

  async function startBobAdapter(): Promise<{ adapter: AutomergeReplicationAdapter; keyPort: InMemoryKeyManagementAdapter }> {
    const keyPort = new InMemoryKeyManagementAdapter()
    bobAdapter = new AutomergeReplicationAdapter({
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
    aliceAdapter = new AutomergeReplicationAdapter({
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

  it('C6: space-invite ist ein encrypted DIDComm-Envelope ohne Klartext-Key-Material; Body dekodiert + validiert', async () => {
    const space = await aliceAdapter.createSpace<TestDoc>('shared', { items: {} }, { name: 'S' })
    await aliceAdapter.addMember(space.id, bob.getDid(), await bob.getEncryptionPublicKeyBytes())
    await wait()

    const invite = bobInbox.find((m) => m.type === SPACE_INVITE_MESSAGE_TYPE)!
    expect(invite).toBeTruthy()
    // K4 encrypted-Outer-Form: ECIES-Container + Snapshot-Extension, kein
    // Klartext-Body. M2: die documentUrl reist IM Group-Key-verschlüsselten
    // Snapshot-Blob — als unauthentifizierte Wire-Extension könnte ein
    // untrusted Broker sie austauschen (Sync 005 Z.68-90 kennt das Feld nicht).
    expect(() => assertEncryptedInboxEnvelope(invite, SPACE_INVITE_MESSAGE_TYPE)).not.toThrow()
    expect(Object.keys(invite.body).sort()).toEqual(['ciphertext', 'encryptedDocSnapshot', 'epk', 'nonce'])
    const wireJson = JSON.stringify(invite)
    expect(wireJson).not.toContain('automerge:')
    for (const marker of KEY_MATERIAL_MARKERS) expect(wireJson).not.toContain(`"${marker}"`)

    // decrypt → Inner-JWS-Payload.body = spec body
    const body = await decryptInboxBody(bob, invite)
    expect(() => assertSpaceInviteBody(body)).not.toThrow()
    expect(body.spaceId).toBe(space.id)
    expect(body.brokerUrls).toEqual(['wss://broker.example.com'])
  })

  it('C5 + S2 + C6: removeMember rotiert nur an Remaining, member-updated alle; key-rotation-Body encrypted + valid', async () => {
    const space = await aliceAdapter.createSpace<TestDoc>('shared', { items: {} }, { name: 'S' })
    await aliceAdapter.addMember(space.id, bob.getDid(), await bob.getEncryptionPublicKeyBytes())
    await aliceAdapter.addMember(space.id, carol.getDid(), await carol.getEncryptionPublicKeyBytes())
    await wait()
    bobInbox.length = 0
    carolInbox.length = 0

    await aliceAdapter.removeMember(space.id, carol.getDid())
    await wait()

    // C5: key-rotation reaches the remaining member (bob), NOT the removed member (carol).
    expect(bobInbox.some((m) => m.type === KEY_ROTATION_MESSAGE_TYPE)).toBe(true)
    expect(carolInbox.some((m) => m.type === KEY_ROTATION_MESSAGE_TYPE)).toBe(false)
    // S2: member-update reaches BOTH the remaining member and the removed member (ECIES je Empfänger).
    expect(bobInbox.some((m) => m.type === MEMBER_UPDATE_MESSAGE_TYPE)).toBe(true)
    expect(carolInbox.some((m) => m.type === MEMBER_UPDATE_MESSAGE_TYPE)).toBe(true)

    // C6: the key-rotation wire form is the encrypted envelope, no plaintext key material.
    const rotation = bobInbox.find((m) => m.type === KEY_ROTATION_MESSAGE_TYPE)!
    expect(() => assertEncryptedInboxEnvelope(rotation, KEY_ROTATION_MESSAGE_TYPE)).not.toThrow()
    expect(Object.keys(rotation.body).sort()).toEqual(['ciphertext', 'epk', 'nonce'])
    const wireJson = JSON.stringify(rotation)
    for (const marker of KEY_MATERIAL_MARKERS) expect(wireJson).not.toContain(`"${marker}"`)

    const body = await decryptInboxBody(bob, rotation)
    expect(() => assertKeyRotationBody(body)).not.toThrow()
    expect(body.spaceId).toBe(space.id)
    expect(body.generation).toBe(1)
  })

  it('B1/S1/S2: emits a decoded onSpaceInvite event; receiver inherits name + appTag from doc _meta', async () => {
    const { adapter: receiver } = await startBobAdapter()
    const events: IncomingSpaceInvite[] = []
    receiver.onSpaceInvite((invite) => events.push(invite))

    const space = await aliceAdapter.createSpace<TestDoc>('shared', { items: {} }, { name: 'Garten', appTag: 'rls' })
    await aliceAdapter.addMember(space.id, bob.getDid(), await bob.getEncryptionPublicKeyBytes())
    await wait()

    expect(events).toHaveLength(1)
    expect(events[0]).toEqual({ spaceId: space.id, spaceName: 'Garten', fromDid: alice.getDid() })
    const bobSpace = await receiver.getSpace(space.id)
    expect(bobSpace?.name).toBe('Garten') // S1: name survives without plaintext spaceInfo
    expect(bobSpace?.appTag).toBe('rls') // S2: cross-app isolation survives the invite
  })

  it('S3/C5/S1: rotation eines Non-Admins wird rejected (kein ack); identische Form vom Admin applied (+ genau EIN ack)', async () => {
    const { adapter: receiver, keyPort: bobKeys } = await startBobAdapter()
    const bobAcks = captureAcks(bobMsg)
    const space = await aliceAdapter.createSpace<TestDoc>('shared', { items: {} }, { name: 'S' })
    await aliceAdapter.addMember(space.id, bob.getDid(), await bob.getEncryptionPublicKeyBytes())
    await wait()
    expect(await bobKeys.getCurrentGeneration(space.id)).toBe(0) // invite applied
    expect(await receiver.getSpace(space.id)).not.toBeNull()
    const bobEncKey = await bob.getEncryptionPublicKeyBytes()
    bobAcks.length = 0

    async function craftedRotation(sender: PublicIdentitySession): Promise<DidcommPlaintextMessage> {
      // Fully self-consistent gen-1 body from the sender's OWN key material: the capability
      // verifies against the included signing key — only the authority check can stop it.
      const port = new InMemoryKeyManagementAdapter()
      await createSpaceKey({ crypto: protocolCrypto, keyPort: port, spaceId: space.id, ownerDid: sender.getDid() })
      await rotateSpaceKey({ crypto: protocolCrypto, keyPort: port, spaceId: space.id, ownerDid: sender.getDid() })
      const body = await buildKeyRotationBody({ keyPort: port, spaceId: space.id, newGeneration: 1, recipientDid: bob.getDid() })
      return deliverInboxMessage({
        type: KEY_ROTATION_MESSAGE_TYPE,
        body: body as unknown as Record<string, unknown>,
        from: sender.getDid(),
        to: bob.getDid(),
        recipientEncryptionPublicKey: bobEncKey,
        sign: (input) => sender.signEd25519(input),
        crypto: protocolCrypto,
      })
    }

    // carol is NOT the creator (createdBy = alice, VE-2) → authority check must reject,
    // nothing persisted, K1: fehlgeschlagene Verarbeitung sendet KEIN ack (Redelivery-Pfad).
    await carolMsg.send(await craftedRotation(carol))
    await wait()
    expect(await bobKeys.getCurrentGeneration(space.id)).toBe(0)
    expect(await bobKeys.getCapabilitySigningSeed(space.id, 1)).toBeNull()
    expect(bobAcks).toHaveLength(0)

    // S1-Beweis (Sync 003 Z.392): gespoofter OUTER from = Admin, Inner-JWS von carol —
    // der authentifizierte Sender ist der Inner-JWS-Signer, also weiterhin reject.
    const spoofed = { ...(await craftedRotation(carol)), from: alice.getDid() }
    await carolMsg.send(spoofed)
    await wait()
    expect(await bobKeys.getCurrentGeneration(space.id)).toBe(0)
    expect(await bobKeys.getCapabilitySigningSeed(space.id, 1)).toBeNull()
    expect(bobAcks).toHaveLength(0)

    // positive control: the IDENTICAL shape from the admin (alice) applies — proving the
    // rejections above were the authority check, not a container/shape artifact.
    // ACK-Ownership: genau EIN ack/1.0 nach Apply, thid = Original-id.
    const adminRotation = await craftedRotation(alice)
    await aliceMsg.send(adminRotation)
    await wait()
    expect(await bobKeys.getCurrentGeneration(space.id)).toBe(1)
    expect(await bobKeys.getCapabilitySigningSeed(space.id, 1)).not.toBeNull()
    expect(bobAcks).toHaveLength(1)
    expect(bobAcks[0].thid).toBe(adminRotation.id)
    expect(bobAcks[0].body).toMatchObject({ messageId: adminRotation.id })
  })

  it('S4: applies a spec-conformant invite WITHOUT doc binary (keys persisted, space registered)', async () => {
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
    // A valid automerge documentUrl for a doc bob's repo has never seen (throwaway repo).
    // M2: die documentUrl reist im Group-Key-verschlüsselten Snapshot-Payload;
    // das docBinary bleibt leer — pure spec invite, doc arrives via regular sync.
    const documentUrl = new Repo({ network: [] }).create({}).url
    const groupKey = (await senderPort.getKeyByGeneration(spaceId, 0))!
    const snapshot = await encryptOneShot({
      crypto: protocolCrypto,
      spaceContentKey: groupKey,
      plaintext: encodeSpaceInviteSnapshotPayload({ documentUrl, docBinary: new Uint8Array(0) }),
    })
    const envelope = await deliverInboxMessage({
      type: SPACE_INVITE_MESSAGE_TYPE,
      body: body as unknown as Record<string, unknown>,
      from: alice.getDid(),
      to: bob.getDid(),
      recipientEncryptionPublicKey: await bob.getEncryptionPublicKeyBytes(),
      sign: (input) => alice.signEd25519(input),
      crypto: protocolCrypto,
      extensionFields: { encryptedDocSnapshot: snapshot.blobBase64Url },
    })
    await aliceMsg.send(envelope)
    await wait()

    expect(await bobKeys.getKeyByGeneration(spaceId, 0)).not.toBeNull()
    expect(await bobKeys.getCapabilityVerificationKey(spaceId, 0)).not.toBeNull()
    expect(await receiver.getSpace(spaceId)).not.toBeNull()
    expect(events.some((e) => e.spaceId === spaceId && e.fromDid === alice.getDid())).toBe(true)
  })

  it('rejects an invite for an unknown space with missing or malformed snapshot payload — no partial key state, kein ack', async () => {
    const { adapter: receiver, keyPort: bobKeys } = await startBobAdapter()
    const bobAcks = captureAcks(bobMsg)
    const spaceId = crypto.randomUUID()
    const senderPort = new InMemoryKeyManagementAdapter()
    await createSpaceKey({ crypto: protocolCrypto, keyPort: senderPort, spaceId, ownerDid: alice.getDid() })
    const body = await buildSpaceInviteBody({
      keyPort: senderPort, spaceId, recipientDid: bob.getDid(),
      brokerUrls: ['wss://broker.example.com'], adminDids: [alice.getDid()],
    })

    // M2: der Snapshot-Payload (Pflicht für unbekannte Spaces) trägt die
    // documentUrl — eine malformed URL steckt jetzt IM verschlüsselten Blob.
    const groupKey = (await senderPort.getKeyByGeneration(spaceId, 0))!
    const malformedUrlSnapshot = await encryptOneShot({
      crypto: protocolCrypto,
      spaceContentKey: groupKey,
      plaintext: encodeSpaceInviteSnapshotPayload({
        documentUrl: 'not-an-automerge-url',
        docBinary: new Uint8Array(0),
      }),
    })

    for (const extensionFields of [
      undefined, // missing snapshot payload
      { encryptedDocSnapshot: malformedUrlSnapshot.blobBase64Url }, // malformed documentUrl im Payload
    ]) {
      const envelope = await deliverInboxMessage({
        type: SPACE_INVITE_MESSAGE_TYPE,
        body: body as unknown as Record<string, unknown>,
        from: alice.getDid(),
        to: bob.getDid(),
        recipientEncryptionPublicKey: await bob.getEncryptionPublicKeyBytes(),
        sign: (input) => alice.signEd25519(input),
        crypto: protocolCrypto,
        extensionFields,
      })
      await aliceMsg.send(envelope)
    }
    await wait()

    // The extension is validated BEFORE applySpaceInviteBody — neither variant may
    // persist ANY key material or register the space (no partial state). K1: die
    // invalid-rejected-Disposition sendet kein ack ('may-ack-invalid-and-drop' ungenutzt).
    expect(await bobKeys.getKeyByGeneration(spaceId, 0)).toBeNull()
    expect(await bobKeys.getCapabilityVerificationKey(spaceId, 0)).toBeNull()
    expect(await receiver.getSpace(spaceId)).toBeNull()
    expect(bobAcks).toHaveLength(0)
  })

  it('Replay: dieselbe Inbox-Nachricht ein zweites Mal → keine zweite Anwendung, aber ack (Sync 003 Z.619)', async () => {
    const { keyPort: bobKeys } = await startBobAdapter()
    const bobAcks = captureAcks(bobMsg)
    const space = await aliceAdapter.createSpace<TestDoc>('shared', { items: {} }, { name: 'S' })
    await aliceAdapter.addMember(space.id, bob.getDid(), await bob.getEncryptionPublicKeyBytes())
    await wait()
    bobAcks.length = 0

    const port = new InMemoryKeyManagementAdapter()
    await createSpaceKey({ crypto: protocolCrypto, keyPort: port, spaceId: space.id, ownerDid: alice.getDid() })
    await rotateSpaceKey({ crypto: protocolCrypto, keyPort: port, spaceId: space.id, ownerDid: alice.getDid() })
    const rotationBody = await buildKeyRotationBody({
      keyPort: port,
      spaceId: space.id,
      newGeneration: 1,
      recipientDid: bob.getDid(),
    })
    const rotation = await deliverInboxMessage({
      type: KEY_ROTATION_MESSAGE_TYPE,
      body: rotationBody as unknown as Record<string, unknown>,
      from: alice.getDid(),
      to: bob.getDid(),
      recipientEncryptionPublicKey: await bob.getEncryptionPublicKeyBytes(),
      sign: (input) => alice.signEd25519(input),
      crypto: protocolCrypto,
    })
    await aliceMsg.send(rotation)
    await wait()
    expect(await bobKeys.getCurrentGeneration(space.id)).toBe(1)
    expect(bobAcks).toHaveLength(1)

    // Relay-Redelivery-Simulation: identische Nachricht erneut → Message-ID-History
    // erkennt das Duplikat; ack trotzdem (sonst Queue-Stau), keine zweite Anwendung.
    await aliceMsg.send(rotation)
    await wait()
    expect(await bobKeys.getCurrentGeneration(space.id)).toBe(1)
    expect(bobAcks).toHaveLength(2)
  })
})
