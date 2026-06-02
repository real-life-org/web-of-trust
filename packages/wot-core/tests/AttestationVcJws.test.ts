import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  createAttestationVcJws,
  verifyAttestationVcJws,
} from '../src/protocol'
import { WebCryptoProtocolCryptoAdapter } from '../src/protocol-adapters'
import type { AttestationVcPayload, DidDocument, DidResolver } from '../src/protocol'

const testDir = dirname(fileURLToPath(import.meta.url))
const phase1 = JSON.parse(readFileSync(join(testDir, 'fixtures/wot-spec/phase-1-interop.json'), 'utf8'))
const cryptoAdapter = new WebCryptoProtocolCryptoAdapter()
const signingSeed = hexToBytes(phase1.identity.ed25519_seed_hex)
const issuerDid = phase1.identity.did
const subjectDid = 'did:key:z6Mko3ZEjKJWQAM5nDXKoZ9jErvvxbWbYgS8KJXYpC5Hbu8a'
const now = new Date('2026-04-22T10:00:00Z')

describe('attestation VC-JWS DID purpose binding', () => {
  it('requires the JWS kid to be in assertionMethod of the resolved DID document', async () => {
    const payload = validAttestationPayload()
    const didResolver = assertionMethodResolver()
    const validJws = await signedAttestation(`${issuerDid}#sig-0`, payload)
    const wrongPurposeJws = await signedAttestation(`${issuerDid}#enc-0`, payload)

    await expect(
      verifyAttestationVcJws(validJws, { crypto: cryptoAdapter, didResolver, now }),
    ).resolves.toEqual(payload)
    await expect(
      verifyAttestationVcJws(wrongPurposeJws, { crypto: cryptoAdapter, didResolver, now }),
    ).rejects.toThrow('Attestation kid is not authorized for assertionMethod')
  })
})

async function signedAttestation(kid: string, payload: AttestationVcPayload): Promise<string> {
  return createAttestationVcJws({ payload, kid, signingSeed })
}

function validAttestationPayload(): AttestationVcPayload {
  return {
    '@context': ['https://www.w3.org/ns/credentials/v2', 'https://web-of-trust.de/vocab/v1'],
    type: ['VerifiableCredential', 'WotAttestation'],
    issuer: issuerDid,
    credentialSubject: {
      id: subjectDid,
      claim: 'hat Alice offline verifiziert',
    },
    validFrom: '2026-04-21T10:00:00Z',
    iss: issuerDid,
    sub: subjectDid,
    nbf: 1776765600,
    iat: 1776765600,
  }
}

function assertionMethodResolver(): DidResolver {
  const didDocument: DidDocument = {
    id: issuerDid,
    verificationMethod: [
      {
        id: '#sig-0',
        type: 'Ed25519VerificationKey2020',
        controller: issuerDid,
        publicKeyMultibase: phase1.did_resolution.did_document.verificationMethod[0].publicKeyMultibase,
      },
      {
        id: '#enc-0',
        type: 'Ed25519VerificationKey2020',
        controller: issuerDid,
        publicKeyMultibase: phase1.did_resolution.did_document.verificationMethod[0].publicKeyMultibase,
      },
    ],
    authentication: ['#sig-0'],
    assertionMethod: ['#sig-0'],
    keyAgreement: [],
  }

  return {
    async resolve(did: string): Promise<DidDocument | null> {
      return did === issuerDid ? didDocument : null
    },
  }
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error('Invalid hex string')
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i++) bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return bytes
}
