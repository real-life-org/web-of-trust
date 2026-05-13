import { describe, expect, it } from 'vitest'
import { IdentityWorkflow, VerificationWorkflow } from '../src/application'
import { decodeBase64Url, verifyAttestationVcJws } from '../src/protocol'
import { WebCryptoProtocolCryptoAdapter } from '../src/protocol-adapters'
import type { AttestationVcPayload } from '../src/protocol'
import type { PendingCounterVerification } from '../src/application/verification'

const cryptoAdapter = new WebCryptoProtocolCryptoAdapter()

class TestVerificationStateStore {
  readonly consumedNonces = new Map<string, string>()
  readonly pendingCounterVerifications = new Map<string, PendingCounterVerification>()

  async recordConsumedNonce(nonce: string, consumedAt: string): Promise<void> {
    this.consumedNonces.set(nonce.toLowerCase(), consumedAt)
  }

  async tryConsumeNonce(nonce: string, consumedAt: string): Promise<boolean> {
    const normalizedNonce = nonce.toLowerCase()
    if (this.consumedNonces.has(normalizedNonce)) return false
    this.consumedNonces.set(normalizedNonce, consumedAt)
    return true
  }

  async hasConsumedNonce(nonce: string): Promise<boolean> {
    return this.consumedNonces.has(nonce.toLowerCase())
  }

  async pruneConsumedNonces(olderThan: string): Promise<void> {
    const cutoff = Date.parse(olderThan)
    for (const [nonce, consumedAt] of this.consumedNonces) {
      if (Date.parse(consumedAt) < cutoff) this.consumedNonces.delete(nonce)
    }
  }

  async recordPendingCounterVerification(pending: PendingCounterVerification): Promise<void> {
    this.pendingCounterVerifications.set(pending.originalVerificationId, { ...pending })
  }

  async getPendingCounterVerification(originalVerificationId: string): Promise<PendingCounterVerification | null> {
    const pending = this.pendingCounterVerifications.get(originalVerificationId)
    return pending === undefined ? null : { ...pending }
  }

  async getPendingCounterVerifications(): Promise<PendingCounterVerification[]> {
    return Array.from(this.pendingCounterVerifications.values(), (pending) => ({ ...pending }))
  }

  async deletePendingCounterVerification(originalVerificationId: string): Promise<void> {
    this.pendingCounterVerifications.delete(originalVerificationId)
  }

  async consumePendingCounterVerification(
    originalVerificationId: string,
    counterpartyDid: string,
    now: string,
  ): Promise<'consumed' | 'missing' | 'expired' | 'wrong-counterparty'> {
    const pending = this.pendingCounterVerifications.get(originalVerificationId)
    if (pending === undefined) return 'missing'
    if (Date.parse(pending.expiresAt) <= Date.parse(now)) {
      this.pendingCounterVerifications.delete(originalVerificationId)
      return 'expired'
    }
    if (pending.counterpartyDid !== counterpartyDid) return 'wrong-counterparty'
    this.pendingCounterVerifications.delete(originalVerificationId)
    return 'consumed'
  }

  async prunePendingCounterVerifications(now: string): Promise<void> {
    const nowMs = Date.parse(now)
    for (const [originalVerificationId, pending] of this.pendingCounterVerifications) {
      if (Date.parse(pending.expiresAt) <= nowMs) this.pendingCounterVerifications.delete(originalVerificationId)
    }
  }
}

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
      jti: `urn:uuid:other-${nonce}-ben`,
    })).toEqual({
      decision: 'reject',
      reason: 'nonce-consumed',
    })
    expect(workflow.acceptVerifiedVerificationAttestation(anna, {
      ...payload,
      jti: `urn:uuid:verification-123e4567-e89b-42d3-a456-426614174000-${nonce}-ben`,
    })).toEqual({
      decision: 'reject',
      reason: 'nonce-consumed',
    })
    expect(workflow.acceptVerifiedVerificationAttestation(anna, {
      ...payload,
      jti: 'urn:uuid:verification-123e4567-e89b-42d3-a456-426614174000-ben',
    })).toEqual({
      decision: 'remote-unbound',
      reason: 'no-active-matching-nonce',
    })
  })

  it('keeps replay classification after active QR challenge state is gone', async () => {
    const anna = await createTestIdentity('anna')
    const consumedNonce = '550e8400-e29b-41d4-a716-446655440000'
    const replacementNonce = '123e4567-e89b-42d3-a456-426614174000'
    let nextNonce = consumedNonce
    let now = new Date('2026-04-28T08:00:00Z')
    const workflow = new VerificationWorkflow({
      crypto: cryptoAdapter,
      randomId: () => nextNonce,
      now: () => now,
    })

    await workflow.createOnlineQrChallenge(anna, 'Anna')
    now = new Date('2026-04-28T08:04:59Z')
    expect(workflow.acceptVerifiedVerificationAttestation(
      anna,
      verificationAttestationPayload(anna.getDid(), consumedNonce),
    )).toEqual({
      decision: 'accept-in-person',
      nonce: consumedNonce,
    })

    nextNonce = replacementNonce
    await workflow.createOnlineQrChallenge(anna, 'Anna')
    workflow.resetActiveQrChallenge()

    expect(workflow.acceptVerifiedVerificationAttestation(anna, {
      ...verificationAttestationPayload(anna.getDid(), replacementNonce),
      jti: `urn:uuid:verification-${consumedNonce}-ben`,
    })).toEqual({
      decision: 'reject',
      reason: 'nonce-consumed',
    })
  })

  it('records pending counter-verification state for nonce-bound incoming verifications', async () => {
    const anna = await createTestIdentity('anna')
    const ben = await createTestIdentity('ben')
    const nonce = '550e8400-e29b-41d4-a716-446655440000'
    let now = new Date('2026-04-28T08:00:00Z')
    const workflow = new VerificationWorkflow({
      crypto: cryptoAdapter,
      randomId: () => nonce,
      now: () => now,
    })
    await workflow.createOnlineQrChallenge(anna, 'Anna')
    now = new Date('2026-04-28T08:04:59Z')

    const payload = verificationAttestationPayload(anna.getDid(), nonce, {
      issuer: ben.getDid(),
      iss: ben.getDid(),
    })

    expect(workflow.acceptVerifiedVerificationAttestation(anna, payload)).toEqual({
      decision: 'accept-in-person',
      nonce,
    })
    expect(workflow.getPendingCounterVerification(payload.jti!)).toEqual({
      counterpartyDid: ben.getDid(),
      originalVerificationId: payload.jti,
      createdAt: '2026-04-28T08:04:59Z',
      expiresAt: '2026-04-29T08:04:59Z',
    })
  })

  it('creates nonce-bound Trust 002 Verification-Attestations as verifiable VC-JWS artifacts', async () => {
    const anna = await createTestIdentity('anna')
    const ben = await createTestIdentity('ben')
    const nonce = '550e8400-e29b-41d4-a716-446655440000'
    let now = new Date('2026-04-28T08:00:00Z')
    const annaWorkflow = new VerificationWorkflow({
      crypto: cryptoAdapter,
      randomId: () => nonce,
      now: () => now,
    })
    let benNow = new Date('2026-04-28T08:01:00.789Z')
    const benWorkflow = new VerificationWorkflow({
      crypto: cryptoAdapter,
      randomId: () => '123e4567-e89b-42d3-a456-426614174000',
      now: () => benNow,
    })

    await annaWorkflow.createOnlineQrChallenge(anna, 'Anna')

    const verification = await benWorkflow.createVerificationAttestation({
      issuer: ben,
      subjectDid: anna.getDid(),
      challengeNonce: nonce,
    })
    const payload = await verifyAttestationVcJws(verification.vcJws, {
      crypto: cryptoAdapter,
      now: new Date('2026-04-28T08:01:01Z'),
    })

    expect(verification).toMatchObject({
      id: payload.jti,
      from: ben.getDid(),
      to: anna.getDid(),
      claim: 'in-person verifiziert',
      createdAt: '2026-04-28T08:01:00Z',
    })
    expect(payload).toMatchObject({
      id: verification.id,
      issuer: ben.getDid(),
      iss: ben.getDid(),
      sub: anna.getDid(),
      jti: verification.id,
      credentialSubject: {
        id: anna.getDid(),
        claim: 'in-person verifiziert',
      },
    })
    expect(payload.jti).toContain(nonce)
    expect(payload.validFrom).toBe('2026-04-28T08:01:00Z')
    expect(payload.nbf).toBe(Math.floor(Date.parse(payload.validFrom) / 1000))
    expect(payload.iat).toBe(payload.nbf)
    expect(benWorkflow.getPendingCounterVerification(verification.id)).toEqual({
      counterpartyDid: anna.getDid(),
      originalVerificationId: verification.id,
      createdAt: '2026-04-28T08:01:00Z',
      expiresAt: '2026-04-29T08:01:00Z',
    })

    now = new Date('2026-04-28T08:04:59Z')
    expect(annaWorkflow.acceptVerifiedVerificationAttestation(anna, payload)).toEqual({
      decision: 'accept-in-person',
      nonce,
    })
    expect(annaWorkflow.getPendingCounterVerification(payload.jti!)).toEqual({
      counterpartyDid: ben.getDid(),
      originalVerificationId: payload.jti,
      createdAt: '2026-04-28T08:04:59Z',
      expiresAt: '2026-04-29T08:04:59Z',
    })

    const counterVerification = await annaWorkflow.createCounterVerificationAttestation({
      issuer: anna,
      subjectDid: ben.getDid(),
      inResponseTo: verification.id,
    })
    const counterPayload = await verifyAttestationVcJws(counterVerification.vcJws, {
      crypto: cryptoAdapter,
      now: new Date('2026-04-28T08:05:00Z'),
    })
    benNow = new Date('2026-04-28T08:05:00Z')

    expect(benWorkflow.acceptVerifiedCounterVerification(ben, counterPayload)).toEqual({
      decision: 'accept-mutual-in-person',
      originalVerificationId: verification.id,
    })
    expect(benWorkflow.getPendingCounterVerification(verification.id)).toBeNull()
  })

  it('trims and rejects blank Verification-Attestation creation inputs', async () => {
    const anna = await createTestIdentity('anna')
    const ben = await createTestIdentity('ben')
    const nonce = '550e8400-e29b-41d4-a716-446655440000'
    const workflow = new VerificationWorkflow({
      crypto: cryptoAdapter,
      randomId: () => '123e4567-e89b-42d3-a456-426614174000',
      now: () => new Date('2026-04-28T08:01:00Z'),
    })

    await expect(workflow.createVerificationAttestation({
      issuer: ben,
      subjectDid: '   ',
      challengeNonce: nonce,
    })).rejects.toThrow('Missing subject DID')
    await expect(workflow.createVerificationAttestation({
      issuer: ben,
      subjectDid: anna.getDid(),
      challengeNonce: '   ',
    })).rejects.toThrow('Missing challenge nonce')

    const verification = await workflow.createVerificationAttestation({
      issuer: ben,
      subjectDid: ` ${anna.getDid()} `,
      challengeNonce: ` ${nonce} `,
    })
    const payload = await verifyAttestationVcJws(verification.vcJws, {
      crypto: cryptoAdapter,
      now: new Date('2026-04-28T08:01:01Z'),
    })

    expect(verification.to).toBe(anna.getDid())
    expect(payload.sub).toBe(anna.getDid())
    expect(payload.credentialSubject.id).toBe(anna.getDid())
    expect(payload.jti).toContain(nonce)
    expect(payload.jti).not.toContain(` ${nonce} `)
  })

  it('creates signed Counter-Verification-Attestations bound to matching pending counter state', async () => {
    const anna = await createTestIdentity('anna')
    const ben = await createTestIdentity('ben')
    const originalVerificationId = 'urn:uuid:verification-550e8400-e29b-41d4-a716-446655440000-ben'
    const workflow = new VerificationWorkflow({
      crypto: cryptoAdapter,
      randomId: () => '123e4567-e89b-42d3-a456-426614174000',
      now: () => new Date('2026-04-28T08:10:00.999Z'),
    })
    workflow.recordPendingCounterVerification({
      counterpartyDid: anna.getDid(),
      originalVerificationId,
    })

    const counterVerification = await workflow.createCounterVerificationAttestation({
      issuer: anna,
      subjectDid: ben.getDid(),
      inResponseTo: originalVerificationId,
    })
    const payload = await verifyAttestationVcJws(counterVerification.vcJws, {
      crypto: cryptoAdapter,
      now: new Date('2026-04-28T08:10:01Z'),
    })

    expect(counterVerification.inResponseTo).toBe(originalVerificationId)
    expect(payload).toMatchObject({
      id: counterVerification.id,
      issuer: anna.getDid(),
      iss: anna.getDid(),
      sub: ben.getDid(),
      jti: counterVerification.id,
      inResponseTo: originalVerificationId,
      credentialSubject: {
        id: ben.getDid(),
        claim: 'in-person verifiziert',
      },
    })
    expect(payload.inResponseTo).toBe(originalVerificationId)
    expect(payload.validFrom).toBe('2026-04-28T08:10:00Z')
    expect(payload.nbf).toBe(Math.floor(Date.parse(payload.validFrom) / 1000))
    expect(payload.iat).toBe(payload.nbf)
    expect(workflow.acceptVerifiedCounterVerification(ben, payload)).toEqual({
      decision: 'accept-mutual-in-person',
      originalVerificationId,
    })

    let expiredWorkflowNow = new Date('2026-04-28T08:10:00Z')
    const expiredWorkflow = new VerificationWorkflow({
      crypto: cryptoAdapter,
      now: () => expiredWorkflowNow,
    })
    expiredWorkflow.recordPendingCounterVerification({
      counterpartyDid: anna.getDid(),
      originalVerificationId,
    })
    expiredWorkflowNow = new Date('2026-04-30T08:10:01Z')
    expect(expiredWorkflow.acceptVerifiedCounterVerification(ben, payload)).toEqual({
      decision: 'remote-unbound',
      reason: 'pending-counter-expired',
    })

    const wrongIssuerWorkflow = new VerificationWorkflow({
      crypto: cryptoAdapter,
      now: () => new Date('2026-04-28T08:10:01Z'),
    })
    wrongIssuerWorkflow.recordPendingCounterVerification({
      counterpartyDid: ben.getDid(),
      originalVerificationId,
    })
    expect(wrongIssuerWorkflow.acceptVerifiedCounterVerification(ben, payload)).toEqual({
      decision: 'reject',
      reason: 'wrong-issuer',
    })
  })

  it('trims and rejects blank Counter-Verification-Attestation creation inputs', async () => {
    const anna = await createTestIdentity('anna')
    const ben = await createTestIdentity('ben')
    const originalVerificationId = 'urn:uuid:verification-550e8400-e29b-41d4-a716-446655440000-ben'
    const workflow = new VerificationWorkflow({
      crypto: cryptoAdapter,
      randomId: () => '123e4567-e89b-42d3-a456-426614174000',
      now: () => new Date('2026-04-28T08:10:00Z'),
    })

    await expect(workflow.createCounterVerificationAttestation({
      issuer: anna,
      subjectDid: '   ',
      inResponseTo: originalVerificationId,
    })).rejects.toThrow('Missing subject DID')
    await expect(workflow.createCounterVerificationAttestation({
      issuer: anna,
      subjectDid: ben.getDid(),
      inResponseTo: '   ',
    })).rejects.toThrow('Missing inResponseTo')

    const counterVerification = await workflow.createCounterVerificationAttestation({
      issuer: anna,
      subjectDid: ` ${ben.getDid()} `,
      inResponseTo: ` ${originalVerificationId} `,
    })
    const payload = await verifyAttestationVcJws(counterVerification.vcJws, {
      crypto: cryptoAdapter,
      now: new Date('2026-04-28T08:10:01Z'),
    })

    expect(counterVerification.to).toBe(ben.getDid())
    expect(counterVerification.inResponseTo).toBe(originalVerificationId)
    expect(payload.sub).toBe(ben.getDid())
    expect(payload.credentialSubject.id).toBe(ben.getDid())
    expect(payload.inResponseTo).toBe(originalVerificationId)
  })

  it('accepts verified counter-verifications only with matching pending counter state', async () => {
    const anna = await createTestIdentity('anna')
    const ben = await createTestIdentity('ben')
    const originalVerificationId = 'urn:uuid:verification-550e8400-e29b-41d4-a716-446655440000-ben'
    const workflow = new VerificationWorkflow({
      crypto: cryptoAdapter,
      now: () => new Date('2026-04-28T08:10:00Z'),
    })
    workflow.recordPendingCounterVerification({
      counterpartyDid: anna.getDid(),
      originalVerificationId,
    })

    const counterPayload = verificationAttestationPayload(ben.getDid(), '123e4567-e89b-42d3-a456-426614174000', {
      issuer: anna.getDid(),
      iss: anna.getDid(),
      inResponseTo: originalVerificationId,
    })

    expect(workflow.acceptVerifiedCounterVerification(ben, counterPayload)).toEqual({
      decision: 'accept-mutual-in-person',
      originalVerificationId,
    })
    expect(workflow.acceptVerifiedCounterVerification(ben, counterPayload)).toEqual({
      decision: 'remote-unbound',
      reason: 'no-pending-counter-verification',
    })
  })

  it('does not classify unbound or expired counter-verifications as mutual in-person', async () => {
    const anna = await createTestIdentity('anna')
    const ben = await createTestIdentity('ben')
    const originalVerificationId = 'urn:uuid:verification-550e8400-e29b-41d4-a716-446655440000-ben'
    let now = new Date('2026-04-28T08:10:00Z')
    const workflow = new VerificationWorkflow({
      crypto: cryptoAdapter,
      now: () => now,
    })
    workflow.recordPendingCounterVerification({
      counterpartyDid: anna.getDid(),
      originalVerificationId,
    })

    const validCounterPayload = verificationAttestationPayload(
      ben.getDid(),
      '123e4567-e89b-42d3-a456-426614174000',
      {
        issuer: anna.getDid(),
        iss: anna.getDid(),
        inResponseTo: originalVerificationId,
      },
    )

    expect(workflow.acceptVerifiedCounterVerification(ben, {
      ...validCounterPayload,
      inResponseTo: undefined,
    })).toEqual({
      decision: 'remote-unbound',
      reason: 'missing-in-response-to',
    })
    expect(workflow.acceptVerifiedCounterVerification(ben, {
      ...validCounterPayload,
      issuer: 'did:key:z6Mkeve',
      iss: 'did:key:z6Mkeve',
    })).toEqual({
      decision: 'reject',
      reason: 'wrong-issuer',
    })

    now = new Date('2026-04-29T08:10:00Z')
    expect(workflow.acceptVerifiedCounterVerification(ben, validCounterPayload)).toEqual({
      decision: 'remote-unbound',
      reason: 'pending-counter-expired',
    })
  })

  it('preserves primary protocol decisions when a jti also contains a consumed nonce', async () => {
    const anna = await createTestIdentity('anna')
    const ben = await createTestIdentity('ben')
    const consumedNonce = '123e4567-e89b-42d3-a456-426614174000'
    const activeNonce = '550e8400-e29b-41d4-a716-446655440000'
    let nextNonce = consumedNonce
    let now = new Date('2026-04-28T08:00:00Z')
    const workflow = new VerificationWorkflow({
      crypto: cryptoAdapter,
      randomId: () => nextNonce,
      now: () => now,
    })

    await workflow.createOnlineQrChallenge(anna, 'Anna')
    now = new Date('2026-04-28T08:04:59Z')
    expect(workflow.acceptVerifiedVerificationAttestation(anna, verificationAttestationPayload(anna.getDid(), consumedNonce))).toEqual({
      decision: 'accept-in-person',
      nonce: consumedNonce,
    })

    nextNonce = activeNonce
    await workflow.createOnlineQrChallenge(anna, 'Anna')
    expect(workflow.acceptVerifiedVerificationAttestation(anna, {
      ...verificationAttestationPayload(anna.getDid(), activeNonce),
      jti: `urn:uuid:verification-${consumedNonce}-${activeNonce}-ben`,
    })).toEqual({
      decision: 'accept-in-person',
      nonce: activeNonce,
    })

    expect(workflow.acceptVerifiedVerificationAttestation(anna, verificationAttestationPayload(ben.getDid(), consumedNonce))).toEqual({
      decision: 'reject',
      reason: 'wrong-subject',
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

    now = new Date('2026-04-29T08:04:59Z')
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

  it('uses an injected verification state store to reject consumed nonce replay after workflow restart', async () => {
    const anna = await createTestIdentity('anna')
    const nonce = '550e8400-e29b-41d4-a716-446655440000'
    const store = new TestVerificationStateStore()
    let now = new Date('2026-04-28T08:00:00Z')
    const firstWorkflow = new VerificationWorkflow({
      crypto: cryptoAdapter,
      randomId: () => nonce,
      now: () => now,
      stateStore: store,
    })

    await firstWorkflow.createOnlineQrChallenge(anna, 'Anna')
    now = new Date('2026-04-28T08:04:59Z')
    const payload = verificationAttestationPayload(anna.getDid(), nonce)

    expect(await firstWorkflow.acceptVerifiedVerificationAttestation(anna, payload)).toEqual({
      decision: 'accept-in-person',
      nonce,
    })

    const restartedWorkflow = new VerificationWorkflow({
      crypto: cryptoAdapter,
      now: () => new Date('2026-04-28T08:05:01Z'),
      stateStore: store,
    })

    expect(await restartedWorkflow.acceptVerifiedVerificationAttestation(anna, payload)).toEqual({
      decision: 'reject',
      reason: 'nonce-consumed',
    })
  })

  it('uses an injected verification state store to accept matching pending counter-verifications after workflow restart', async () => {
    const anna = await createTestIdentity('anna')
    const ben = await createTestIdentity('ben')
    const store = new TestVerificationStateStore()
    const benWorkflowBeforeRestart = new VerificationWorkflow({
      crypto: cryptoAdapter,
      randomId: () => '123e4567-e89b-42d3-a456-426614174000',
      now: () => new Date('2026-04-28T08:01:00Z'),
      stateStore: store,
    })

    const verification = await benWorkflowBeforeRestart.createVerificationAttestation({
      issuer: ben,
      subjectDid: anna.getDid(),
      challengeNonce: '550e8400-e29b-41d4-a716-446655440000',
    })
    const counterPayload = verificationAttestationPayload(
      ben.getDid(),
      '123e4567-e89b-42d3-a456-426614174000',
      {
        issuer: anna.getDid(),
        iss: anna.getDid(),
        inResponseTo: verification.id,
      },
    )

    const benWorkflowAfterRestart = new VerificationWorkflow({
      crypto: cryptoAdapter,
      now: () => new Date('2026-04-28T08:05:00Z'),
      stateStore: store,
    })

    expect(await benWorkflowAfterRestart.getPendingCounterVerification(verification.id)).toEqual({
      counterpartyDid: anna.getDid(),
      originalVerificationId: verification.id,
      createdAt: '2026-04-28T08:01:00Z',
      expiresAt: '2026-04-29T08:01:00Z',
    })
    expect(await benWorkflowAfterRestart.acceptVerifiedCounterVerification(ben, counterPayload)).toEqual({
      decision: 'accept-mutual-in-person',
      originalVerificationId: verification.id,
    })
    expect(await benWorkflowAfterRestart.getPendingCounterVerification(verification.id)).toBeNull()
  })

  it('uses an injected verification state store to reject expired pending counter-verifications after workflow restart', async () => {
    const anna = await createTestIdentity('anna')
    const ben = await createTestIdentity('ben')
    const store = new TestVerificationStateStore()
    const originalVerificationId = 'urn:uuid:verification-550e8400-e29b-41d4-a716-446655440000-ben'
    const beforeRestart = new VerificationWorkflow({
      crypto: cryptoAdapter,
      now: () => new Date('2026-04-28T08:10:00Z'),
      stateStore: store,
    })
    await beforeRestart.recordPendingCounterVerification({
      counterpartyDid: anna.getDid(),
      originalVerificationId,
    })

    const counterPayload = verificationAttestationPayload(
      ben.getDid(),
      '123e4567-e89b-42d3-a456-426614174000',
      {
        issuer: anna.getDid(),
        iss: anna.getDid(),
        inResponseTo: originalVerificationId,
      },
    )
    const afterRestart = new VerificationWorkflow({
      crypto: cryptoAdapter,
      now: () => new Date('2026-04-29T08:10:00Z'),
      stateStore: store,
    })

    expect(await afterRestart.acceptVerifiedCounterVerification(ben, counterPayload)).toEqual({
      decision: 'remote-unbound',
      reason: 'pending-counter-expired',
    })
    expect(await afterRestart.getPendingCounterVerification(originalVerificationId)).toBeNull()
  })
})
