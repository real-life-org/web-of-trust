import { describe, expect, it } from 'vitest'
import { IdentityWorkflow, VerificationWorkflow } from '../src/application'
import { decodeBase64Url } from '../src/protocol'
import { WebCryptoProtocolCryptoAdapter } from '../src/protocol-adapters'
import type { AttestationVcPayload } from '../src/protocol'

const cryptoAdapter = new WebCryptoProtocolCryptoAdapter()

async function createTestIdentity(passphrase: string) {
  const workflow = new IdentityWorkflow({ crypto: cryptoAdapter })
  return (await workflow.createIdentity({ passphrase, storeSeed: false })).identity
}

function verificationAttestationPayload(localDid: string, nonce: string, overrides: Partial<AttestationVcPayload> = {}): AttestationVcPayload {
  return {
    '@context': ['https://www.w3.org/ns/credentials/v2', 'https://web-of-trust.de/vocab/v1'],
    type: ['VerifiableCredential', 'WotAttestation'],
    issuer: 'did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH',
    credentialSubject: {
      id: localDid,
      claim: 'in-person verifiziert',
    },
    validFrom: '2026-04-28T08:01:00Z',
    iss: 'did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH',
    sub: localDid,
    nbf: Math.floor(Date.parse('2026-04-28T08:01:00Z') / 1000),
    jti: `urn:uuid:verification-${nonce}-ben`,
    ...overrides,
  }
}

describe('VerificationWorkflow', () => {
  it('creates and decodes verification challenges', async () => {
    const anna = await createTestIdentity('anna')
    const workflow = new VerificationWorkflow({
      crypto: cryptoAdapter,
      randomId: () => 'challenge-nonce',
      now: () => new Date('2026-04-28T08:00:00Z'),
    })

    const result = await workflow.createChallenge(anna, 'Anna')

    expect(result.code).toMatch(/^[A-Za-z0-9+/]+=*$/)
    expect(result.challenge).toEqual({
      nonce: 'challenge-nonce',
      timestamp: '2026-04-28T08:00:00.000Z',
      fromDid: anna.getDid(),
      fromPublicKey: await anna.getPublicKeyMultibase(),
      fromName: 'Anna',
    })
    expect(workflow.decodeChallenge(result.code)).toEqual(result.challenge)
  })

  it('creates responses that preserve challenge context', async () => {
    const anna = await createTestIdentity('anna')
    const ben = await createTestIdentity('ben')
    const workflow = new VerificationWorkflow({
      crypto: cryptoAdapter,
      randomId: () => 'challenge-nonce',
      now: () => new Date('2026-04-28T08:00:00Z'),
    })

    const challenge = await workflow.createChallenge(anna, 'Anna')
    const response = await workflow.createResponse(challenge.code, ben, 'Ben')

    expect(response.response.nonce).toBe(challenge.challenge.nonce)
    expect(response.response.fromDid).toBe(anna.getDid())
    expect(response.response.fromPublicKey).toBe(await anna.getPublicKeyMultibase())
    expect(response.response.toDid).toBe(ben.getDid())
    expect(response.response.toPublicKey).toBe(await ben.getPublicKeyMultibase())
    expect(workflow.decodeResponse(response.code)).toEqual(response.response)
  })

  it('rejects self-verification during challenge preparation and response', async () => {
    const anna = await createTestIdentity('anna')
    const workflow = new VerificationWorkflow({ crypto: cryptoAdapter })
    const challenge = await workflow.createChallenge(anna, 'Anna')

    expect(() => workflow.prepareChallenge(challenge.code, anna.getDid())).toThrow('Cannot verify own identity')
    await expect(workflow.createResponse(challenge.code, anna, 'Anna')).rejects.toThrow('Cannot verify own identity')
  })

  it('completes response verification and rejects nonce mismatches', async () => {
    const anna = await createTestIdentity('anna')
    const ben = await createTestIdentity('ben')
    const workflow = new VerificationWorkflow({ crypto: cryptoAdapter, randomId: () => 'nonce-1' })

    const challenge = await workflow.createChallenge(anna, 'Anna')
    const response = await workflow.createResponse(challenge.code, ben, 'Ben')
    const verification = await workflow.completeVerification(response.code, anna, 'nonce-1')

    expect(verification.from).toBe(anna.getDid())
    expect(verification.to).toBe(ben.getDid())
    expect(await workflow.verifySignature(verification)).toBe(true)
    await expect(workflow.completeVerification(response.code, anna, 'wrong-nonce')).rejects.toThrow('Nonce mismatch')
  })

  it('creates direct counter-verifications', async () => {
    const anna = await createTestIdentity('anna')
    const ben = await createTestIdentity('ben')
    const workflow = new VerificationWorkflow({ crypto: cryptoAdapter })

    const verification = await workflow.createVerificationFor(ben, anna.getDid(), 'nonce-2')

    expect(verification.id).toContain('nonce-2')
    expect(verification.from).toBe(ben.getDid())
    expect(verification.to).toBe(anna.getDid())
    expect(await workflow.verifySignature(verification)).toBe(true)
  })

  it('rejects tampered verification signatures', async () => {
    const anna = await createTestIdentity('anna')
    const ben = await createTestIdentity('ben')
    const workflow = new VerificationWorkflow({ crypto: cryptoAdapter })
    const verification = await workflow.createVerificationFor(anna, ben.getDid(), 'nonce-3')

    verification.to = anna.getDid()

    expect(await workflow.verifySignature(verification)).toBe(false)
  })

  it('extracts Ed25519 public keys from did:key identifiers', async () => {
    const anna = await createTestIdentity('anna')
    const workflow = new VerificationWorkflow({ crypto: cryptoAdapter })

    const publicKey = workflow.publicKeyFromDid(anna.getDid())
    const bytes = workflow.multibaseToBytes(publicKey)

    expect(publicKey).toBe(await anna.getPublicKeyMultibase())
    expect(bytes).toHaveLength(32)
  })

  it('creates Trust 002 raw JSON QR challenges and tracks the active challenge', async () => {
    const anna = await createTestIdentity('anna')
    const nonce = '550e8400-e29b-41d4-a716-446655440000'
    const workflow = new VerificationWorkflow({
      crypto: cryptoAdapter,
      randomId: () => nonce,
      now: () => new Date('2026-04-28T08:00:00Z'),
    })

    const result = await workflow.createOnlineQrChallenge(anna, 'Anna', {
      broker: 'wss://broker.example.com',
    })
    const parsed = JSON.parse(result.rawJson)

    expect(result.rawJson).toBe(JSON.stringify(result.challenge))
    expect(parsed).toEqual({
      did: anna.getDid(),
      name: 'Anna',
      enc: result.challenge.enc,
      nonce,
      ts: '2026-04-28T08:00:00.000Z',
      broker: 'wss://broker.example.com',
    })
    expect(decodeBase64Url(parsed.enc)).toEqual(await anna.getEncryptionPublicKeyBytes())
    expect(result.challenge).toEqual(parsed)
    expect(workflow.getActiveQrChallenge()).toEqual(result.challenge)
  })

  it('does not let returned QR challenge mutations alter active challenge acceptance', async () => {
    const anna = await createTestIdentity('anna')
    const nonce = '550e8400-e29b-41d4-a716-446655440000'
    const workflow = new VerificationWorkflow({
      crypto: cryptoAdapter,
      randomId: () => nonce,
      now: () => new Date('2026-04-28T08:04:59Z'),
    })

    const result = await workflow.createOnlineQrChallenge(anna, 'Anna')
    result.challenge.nonce = '123e4567-e89b-42d3-a456-426614174000'
    result.challenge.ts = '2026-04-28T07:00:00Z'

    expect(workflow.getActiveQrChallenge()).toEqual(JSON.parse(result.rawJson))
    expect(workflow.acceptVerifiedVerificationAttestation(anna, verificationAttestationPayload(anna.getDid(), nonce))).toEqual({
      decision: 'accept-in-person',
      nonce,
    })
  })

  it('omits broker from Trust 002 QR challenge JSON when no broker is supplied', async () => {
    const anna = await createTestIdentity('anna')
    const workflow = new VerificationWorkflow({
      crypto: cryptoAdapter,
      randomId: () => '550e8400-e29b-41d4-a716-446655440000',
      now: () => new Date('2026-04-28T08:00:00Z'),
    })

    const result = await workflow.createOnlineQrChallenge(anna, 'Anna')

    expect(JSON.parse(result.rawJson)).not.toHaveProperty('broker')
    expect(result.challenge).not.toHaveProperty('broker')
  })

  it('accepts an already-verified in-person Verification-Attestation once and consumes the matching nonce', async () => {
    const anna = await createTestIdentity('anna')
    const nonce = '550e8400-e29b-41d4-a716-446655440000'
    let now = new Date('2026-04-28T08:00:00Z')
    const workflow = new VerificationWorkflow({
      crypto: cryptoAdapter,
      randomId: () => nonce,
      now: () => now,
    })
    await workflow.createOnlineQrChallenge(anna, 'Anna')
    now = new Date('2026-04-28T08:04:59Z')

    const payload = verificationAttestationPayload(anna.getDid(), nonce)

    expect(workflow.acceptVerifiedVerificationAttestation(anna, payload)).toEqual({
      decision: 'accept-in-person',
      nonce,
    })
    expect(workflow.getActiveQrChallenge()).toBeNull()
    expect(workflow.acceptVerifiedVerificationAttestation(anna, payload)).toEqual({
      decision: 'reject',
      reason: 'nonce-consumed',
    })
    expect(workflow.acceptVerifiedVerificationAttestation(anna, {
      ...payload,
      jti: `urn:uuid:verification-x${nonce}-ben`,
    })).toEqual({
      decision: 'remote-unbound',
      reason: 'no-active-matching-nonce',
    })
  })

  it('rejects expired active challenges and classifies reset challenges as remote/unbound', async () => {
    const anna = await createTestIdentity('anna')
    const nonce = '550e8400-e29b-41d4-a716-446655440000'
    let now = new Date('2026-04-28T08:00:00Z')
    const workflow = new VerificationWorkflow({
      crypto: cryptoAdapter,
      randomId: () => nonce,
      now: () => now,
    })

    await workflow.createOnlineQrChallenge(anna, 'Anna')
    now = new Date('2026-04-28T08:05:01Z')

    expect(workflow.acceptVerifiedVerificationAttestation(anna, verificationAttestationPayload(anna.getDid(), nonce))).toEqual({
      decision: 'reject',
      reason: 'challenge-expired',
    })

    await workflow.createOnlineQrChallenge(anna, 'Anna')
    workflow.resetActiveQrChallenge()

    expect(workflow.acceptVerifiedVerificationAttestation(anna, verificationAttestationPayload(anna.getDid(), nonce))).toEqual({
      decision: 'remote-unbound',
      reason: 'no-active-matching-nonce',
    })
  })

  it('retains consumed nonces for at least 24 hours and prunes them after the retention window', async () => {
    const anna = await createTestIdentity('anna')
    const nonce = '550e8400-e29b-41d4-a716-446655440000'
    let now = new Date('2026-04-28T08:00:00Z')
    const workflow = new VerificationWorkflow({
      crypto: cryptoAdapter,
      randomId: () => nonce,
      now: () => now,
    })
    const payload = verificationAttestationPayload(anna.getDid(), nonce)

    await workflow.createOnlineQrChallenge(anna, 'Anna')
    now = new Date('2026-04-28T08:04:59Z')
    expect(workflow.acceptVerifiedVerificationAttestation(anna, payload)).toEqual({
      decision: 'accept-in-person',
      nonce,
    })

    now = new Date('2026-04-29T08:04:58Z')
    await workflow.createOnlineQrChallenge(anna, 'Anna')
    expect(workflow.acceptVerifiedVerificationAttestation(anna, payload)).toEqual({
      decision: 'reject',
      reason: 'nonce-consumed',
    })

    now = new Date('2026-04-29T08:05:00Z')
    await workflow.createOnlineQrChallenge(anna, 'Anna')
    expect(workflow.acceptVerifiedVerificationAttestation(anna, payload)).toEqual({
      decision: 'accept-in-person',
      nonce,
    })
  })
})
