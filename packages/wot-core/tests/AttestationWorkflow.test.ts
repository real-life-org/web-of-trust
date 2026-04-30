import { describe, expect, it } from 'vitest'
import { AttestationWorkflow, IdentityWorkflow } from '../src/application'
import { decodeBase64Url, encodeBase64Url } from '../src/protocol'
import { WebCryptoProtocolCryptoAdapter } from '../src/protocol-adapters'

const cryptoAdapter = new WebCryptoProtocolCryptoAdapter()

async function createTestIdentity(passphrase: string) {
  const workflow = new IdentityWorkflow({ crypto: cryptoAdapter })
  return (await workflow.createIdentity({ passphrase, storeSeed: false })).identity
}

describe('AttestationWorkflow', () => {
  it('creates a signed attestation with a protocol VC-JWS', async () => {
    const anna = await createTestIdentity('anna')
    const ben = await createTestIdentity('ben')
    const workflow = new AttestationWorkflow({
      crypto: cryptoAdapter,
      randomId: () => 'att-1',
      now: () => new Date('2026-04-28T08:00:00Z'),
    })

    const attestation = await workflow.createAttestation({
      issuer: anna,
      subjectDid: ben.getDid(),
      claim: 'Ben hilft zuverlässig im Garten',
      tags: ['garten', 'hilfe'],
    })

    expect(attestation).toMatchObject({
      id: 'urn:uuid:att-1',
      from: anna.getDid(),
      to: ben.getDid(),
      claim: 'Ben hilft zuverlässig im Garten',
      tags: ['garten', 'hilfe'],
      createdAt: '2026-04-28T08:00:00.000Z',
      proof: {
        type: 'Ed25519Signature2020',
        verificationMethod: `${anna.getDid()}#key-1`,
        proofPurpose: 'assertionMethod',
      },
    })
    expect(attestation.vcJws).toMatch(/^[^.]+\.[^.]+\.[^.]+$/)
    await expect(workflow.verifyAttestation(attestation)).resolves.toBe(true)
    await expect(workflow.verifyAttestationVcJws(attestation.vcJws!)).resolves.toMatchObject({
      issuer: anna.getDid(),
      sub: ben.getDid(),
      credentialSubject: { id: ben.getDid(), claim: 'Ben hilft zuverlässig im Garten' },
    })
  })

  it('rejects tampered legacy fields and VC-JWS payloads', async () => {
    const anna = await createTestIdentity('anna')
    const ben = await createTestIdentity('ben')
    const workflow = new AttestationWorkflow({ crypto: cryptoAdapter, randomId: () => 'att-2' })
    const attestation = await workflow.createAttestation({ issuer: anna, subjectDid: ben.getDid(), claim: 'Kann gut kochen' })
    const [header, payload, signature] = attestation.vcJws!.split('.')
    const tamperedPayload = JSON.parse(new TextDecoder().decode(decodeBase64Url(payload)))
    tamperedPayload.credentialSubject.claim = 'Kann schlecht kochen'
    const tamperedJws = `${header}.${encodeBase64Url(new TextEncoder().encode(JSON.stringify(tamperedPayload)))}.${signature}`

    await expect(workflow.verifyAttestation({ ...attestation, claim: 'Kann schlecht kochen' })).resolves.toBe(false)
    await expect(workflow.verifyAttestation({ ...attestation, vcJws: tamperedJws })).resolves.toBe(false)
  })

  it('exports and imports encoded attestations', async () => {
    const anna = await createTestIdentity('anna')
    const ben = await createTestIdentity('ben')
    const workflow = new AttestationWorkflow({ crypto: cryptoAdapter, randomId: () => 'att-3' })
    const attestation = await workflow.createAttestation({ issuer: anna, subjectDid: ben.getDid(), claim: 'Hat Werkzeug geteilt' })

    const encoded = workflow.exportAttestation(attestation)
    const imported = await workflow.importAttestation(encoded)

    expect(imported).toEqual(attestation)
    await expect(workflow.importAttestation('not-base64-json')).rejects.toThrow('Invalid attestation format')
  })

  it('requires complete attestations before import', async () => {
    const workflow = new AttestationWorkflow({ crypto: cryptoAdapter })
    const encoded = btoa(JSON.stringify({ id: 'missing-fields' }))

    await expect(workflow.importAttestation(encoded)).rejects.toThrow('Incomplete attestation')
  })
})
