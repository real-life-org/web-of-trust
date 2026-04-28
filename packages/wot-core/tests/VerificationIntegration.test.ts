import { describe, expect, it } from 'vitest'
import { IdentityWorkflow, VerificationWorkflow, type IdentitySeedVault } from '../src/application'
import { WebCryptoProtocolCryptoAdapter } from '../src/protocol-adapters'

class MemoryIdentitySeedVault implements IdentitySeedVault {
  private seed: Uint8Array | null = null

  async saveSeed(seed: Uint8Array): Promise<void> {
    this.seed = new Uint8Array(seed)
  }

  async loadSeed(): Promise<Uint8Array | null> {
    return this.seed ? new Uint8Array(this.seed) : null
  }

  async deleteSeed(): Promise<void> {
    this.seed = null
  }

  async hasSeed(): Promise<boolean> {
    return this.seed !== null
  }
}

const cryptoAdapter = new WebCryptoProtocolCryptoAdapter()

async function createTestIdentity(passphrase: string) {
  const workflow = new IdentityWorkflow({ crypto: cryptoAdapter, vault: new MemoryIdentitySeedVault() })
  return (await workflow.createIdentity({ passphrase, storeSeed: false })).identity
}

describe('VerificationWorkflow integration', () => {
  it('completes a mutual verification flow between identity sessions', async () => {
    const anna = await createTestIdentity('anna')
    const ben = await createTestIdentity('ben')
    const workflow = new VerificationWorkflow({ crypto: cryptoAdapter })

    const challenge = await workflow.createChallenge(anna, 'Anna')
    const response = await workflow.createResponse(challenge.code, ben, 'Ben')
    const annaVerifiesBen = await workflow.completeVerification(response.code, anna, challenge.challenge.nonce)
    const benVerifiesAnna = await workflow.createVerificationFor(ben, anna.getDid(), challenge.challenge.nonce)

    expect(annaVerifiesBen.id).toContain(challenge.challenge.nonce)
    expect(annaVerifiesBen.from).toBe(anna.getDid())
    expect(annaVerifiesBen.to).toBe(ben.getDid())
    expect(benVerifiesAnna.from).toBe(ben.getDid())
    expect(benVerifiesAnna.to).toBe(anna.getDid())
    expect(annaVerifiesBen.id).not.toBe(benVerifiesAnna.id)
    expect(await workflow.verifySignature(annaVerifiesBen)).toBe(true)
    expect(await workflow.verifySignature(benVerifiesAnna)).toBe(true)
  })

  it('uses the response nonce when local challenge state is lost', async () => {
    const anna = await createTestIdentity('anna')
    const ben = await createTestIdentity('ben')
    const workflow = new VerificationWorkflow({ crypto: cryptoAdapter })

    const challenge = await workflow.createChallenge(anna, 'Anna')
    const response = await workflow.createResponse(challenge.code, ben, 'Ben')
    const decodedResponse = workflow.decodeResponse(response.code)
    const verification = await workflow.completeVerification(response.code, anna, decodedResponse.nonce)

    expect(decodedResponse.nonce).toBe(challenge.challenge.nonce)
    expect(verification.from).toBe(anna.getDid())
    expect(verification.to).toBe(ben.getDid())
    expect(await workflow.verifySignature(verification)).toBe(true)
  })

  it('rejects nonce mismatches and tampered verification directions', async () => {
    const anna = await createTestIdentity('anna')
    const ben = await createTestIdentity('ben')
    const workflow = new VerificationWorkflow({ crypto: cryptoAdapter })

    const challenge = await workflow.createChallenge(anna, 'Anna')
    const response = await workflow.createResponse(challenge.code, ben, 'Ben')
    await expect(workflow.completeVerification(response.code, anna, 'wrong-nonce')).rejects.toThrow('Nonce mismatch')

    const verification = await workflow.completeVerification(response.code, anna, challenge.challenge.nonce)
    verification.from = ben.getDid()

    expect(await workflow.verifySignature(verification)).toBe(false)
  })
})
