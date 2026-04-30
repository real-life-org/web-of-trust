/**
 * Integration test: Verification flow over Relay (Messaging)
 *
 * Tests the complete relay-assisted verification:
 * 1. Alice creates challenge (QR code)
 * 2. Bob scans challenge, sends response via relay
 * 3. Alice receives response, completes verification, sends complete via relay
 * 4. Bob receives complete message with valid verification
 *
 * Also tests profile resolution during verification.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { WotIdentity } from '../src/identity/WotIdentity'
import { VerificationWorkflow } from '../src/application'
import { WebCryptoProtocolCryptoAdapter } from '../src/protocol-adapters'
import { InMemoryMessagingAdapter } from '../src/adapters/messaging/InMemoryMessagingAdapter'
import { ProfileService } from '../src/services/ProfileService'
import type { MessageEnvelope, PublicProfile } from '../src'

const verificationWorkflow = new VerificationWorkflow({ crypto: new WebCryptoProtocolCryptoAdapter() })

async function createChallengeCode(identity: WotIdentity, name: string): Promise<string> {
  return (await verificationWorkflow.createChallenge(identity, name)).code
}

async function createResponseCode(challengeCode: string, identity: WotIdentity, name: string): Promise<string> {
  return (await verificationWorkflow.createResponse(challengeCode, identity, name)).code
}

describe('Verification over Relay', () => {
  let alice: WotIdentity
  let bob: WotIdentity
  let aliceDid: string
  let bobDid: string
  let aliceMessaging: InMemoryMessagingAdapter
  let bobMessaging: InMemoryMessagingAdapter

  beforeEach(async () => {
    InMemoryMessagingAdapter.resetAll()

    alice = new WotIdentity()
    const aliceResult = await alice.create('alice-test-passphrase', false)
    aliceDid = aliceResult.did

    bob = new WotIdentity()
    const bobResult = await bob.create('bob-test-passphrase', false)
    bobDid = bobResult.did

    aliceMessaging = new InMemoryMessagingAdapter()
    bobMessaging = new InMemoryMessagingAdapter()
    await aliceMessaging.connect(aliceDid)
    await bobMessaging.connect(bobDid)
  })

  afterEach(async () => {
    await aliceMessaging.disconnect()
    await bobMessaging.disconnect()
    InMemoryMessagingAdapter.resetAll()
    await alice.lock()
    await bob.lock()
  })

  it('should complete full relay-assisted verification flow', async () => {
    // Step 1: Alice creates challenge
    const challengeCode = await createChallengeCode(alice, 'Alice')
    const challenge = JSON.parse(atob(challengeCode))

    // Step 2: Bob scans challenge and sends response via relay
    const responseCode = await createResponseCode(challengeCode, bob, 'Bob')

    const responsePayload = {
      action: 'response' as const,
      responseCode,
    }
    const responseEnvelope: MessageEnvelope = {
      v: 1,
      id: `ver-${crypto.randomUUID()}`,
      type: 'verification',
      fromDid: bobDid,
      toDid: aliceDid,
      createdAt: new Date().toISOString(),
      encoding: 'json',
      payload: JSON.stringify(responsePayload),
      signature: '',
    }

    // Alice listens for response
    const aliceReceived: MessageEnvelope[] = []
    aliceMessaging.onMessage((env) => aliceReceived.push(env))

    await bobMessaging.send(responseEnvelope)

    // Alice should receive Bob's response
    expect(aliceReceived).toHaveLength(1)
    expect(aliceReceived[0].type).toBe('verification')

    const receivedPayload = JSON.parse(aliceReceived[0].payload)
    expect(receivedPayload.action).toBe('response')

    // Step 3: Alice validates nonce and completes verification
    const decoded = JSON.parse(atob(receivedPayload.responseCode))
    expect(decoded.nonce).toBe(challenge.nonce)

    const verification = await verificationWorkflow.completeVerification(
      receivedPayload.responseCode,
      alice,
      challenge.nonce,
    )
    expect(verification.from).toBe(aliceDid)
    expect(verification.to).toBe(bobDid)

    // Step 4: Alice sends complete message to Bob via relay
    const completePayload = {
      action: 'complete' as const,
      verification,
    }
    const completeEnvelope: MessageEnvelope = {
      v: 1,
      id: verification.id,
      type: 'verification',
      fromDid: aliceDid,
      toDid: bobDid,
      createdAt: new Date().toISOString(),
      encoding: 'json',
      payload: JSON.stringify(completePayload),
      signature: verification.proof.proofValue,
    }

    const bobReceived: MessageEnvelope[] = []
    bobMessaging.onMessage((env) => bobReceived.push(env))

    await aliceMessaging.send(completeEnvelope)

    // Bob should receive Alice's complete message
    expect(bobReceived).toHaveLength(1)
    expect(bobReceived[0].type).toBe('verification')

    const completeReceived = JSON.parse(bobReceived[0].payload)
    expect(completeReceived.action).toBe('complete')
    expect(completeReceived.verification).toBeDefined()

    // Bob verifies Alice's signature
    const isValid = await verificationWorkflow.verifySignature(completeReceived.verification)
    expect(isValid).toBe(true)
    expect(completeReceived.verification.from).toBe(aliceDid)
    expect(completeReceived.verification.to).toBe(bobDid)
  })

  it('should deliver complete message even if Bob reconnects', async () => {
    // Simulate: Bob sends response, then disconnects briefly
    const challengeCode = await createChallengeCode(alice, 'Alice')
    const challenge = JSON.parse(atob(challengeCode))
    const responseCode = await createResponseCode(challengeCode, bob, 'Bob')

    // Bob disconnects before Alice sends complete
    await bobMessaging.disconnect()

    // Alice completes verification
    const verification = await verificationWorkflow.completeVerification(
      responseCode,
      alice,
      challenge.nonce,
    )

    // Alice sends complete — goes to offline queue
    const completeEnvelope: MessageEnvelope = {
      v: 1,
      id: verification.id,
      type: 'verification',
      fromDid: aliceDid,
      toDid: bobDid,
      createdAt: new Date().toISOString(),
      encoding: 'json',
      payload: JSON.stringify({ action: 'complete', verification }),
      signature: verification.proof.proofValue,
    }
    await aliceMessaging.send(completeEnvelope)

    // Bob reconnects and registers listener
    const bobReceived: MessageEnvelope[] = []
    bobMessaging.onMessage((env) => bobReceived.push(env))
    await bobMessaging.connect(bobDid)

    // Bob should receive the queued complete message
    expect(bobReceived).toHaveLength(1)
    const payload = JSON.parse(bobReceived[0].payload)
    expect(payload.action).toBe('complete')
    expect(await verificationWorkflow.verifySignature(payload.verification)).toBe(true)
  })
})

describe('Profile resolution during verification', () => {
  let alice: WotIdentity
  let aliceDid: string

  beforeEach(async () => {
    alice = new WotIdentity()
    const result = await alice.create('alice-profile-test', false)
    aliceDid = result.did
  })

  afterEach(async () => {
    await alice.lock()
  })

  it('should sign and verify profile with avatar', async () => {
    const profile: PublicProfile = {
      did: aliceDid,
      name: 'Alice',
      bio: 'Testing avatar',
      avatar: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      updatedAt: new Date().toISOString(),
    }

    // Sign as JWS
    const jws = await alice.signJws(profile)
    expect(jws).toBeDefined()
    expect(jws.split('.')).toHaveLength(3)

    // Verify and extract — avatar must survive the round-trip
    const result = await ProfileService.verifyProfile(jws)
    expect(result.valid).toBe(true)
    expect(result.profile).toBeDefined()
    expect(result.profile!.name).toBe('Alice')
    expect(result.profile!.avatar).toBe(profile.avatar)
    expect(result.profile!.bio).toBe('Testing avatar')
  })

  it('should preserve large avatar through JWS sign/verify', async () => {
    // Simulate a realistic avatar (~50KB base64)
    const largeData = 'A'.repeat(50_000)
    const profile: PublicProfile = {
      did: aliceDid,
      name: 'Alice',
      avatar: `data:image/png;base64,${largeData}`,
      updatedAt: new Date().toISOString(),
    }

    const jws = await alice.signJws(profile)
    const result = await ProfileService.verifyProfile(jws)

    expect(result.valid).toBe(true)
    expect(result.profile!.avatar).toBe(profile.avatar)
  })
})
