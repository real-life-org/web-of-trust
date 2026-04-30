import { describe, expect, it } from 'vitest'
import { IdentityWorkflow, VerificationWorkflow } from '../src/application'
import { WebCryptoProtocolCryptoAdapter } from '../src/protocol-adapters'

const cryptoAdapter = new WebCryptoProtocolCryptoAdapter()

async function createTestIdentity(passphrase: string) {
  const workflow = new IdentityWorkflow({ crypto: cryptoAdapter })
  return (await workflow.createIdentity({ passphrase, storeSeed: false })).identity
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
})
