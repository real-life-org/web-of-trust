import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { decideVerificationAttestationAcceptance } from '../src/protocol'
import type { AttestationVcPayload } from '../src/protocol'

const phase1 = loadSpecVector('./fixtures/wot-spec/phase-1-interop.json')
const vectors = phase1.trust002_jti_nonce_binding
const LOCAL_DID = 'did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH'

function loadSpecVector(relativePath: string): any {
  return JSON.parse(readFileSync(new URL(relativePath, import.meta.url), 'utf8'))
}

function verificationAttestationPayload(jti: string): AttestationVcPayload {
  return {
    '@context': ['https://www.w3.org/ns/credentials/v2', 'https://web-of-trust.de/vocab/v1'],
    type: ['VerifiableCredential', 'WotAttestation'],
    issuer: 'did:key:z6Mko3ZEjKJWQAM5nDXKoZ9jErvvxbWbYgS8KJXYpC5Hbu8a',
    credentialSubject: {
      id: LOCAL_DID,
      claim: 'in-person verifiziert',
    },
    validFrom: '2026-04-28T08:01:00Z',
    iss: 'did:key:z6Mko3ZEjKJWQAM5nDXKoZ9jErvvxbWbYgS8KJXYpC5Hbu8a',
    sub: LOCAL_DID,
    nbf: Math.floor(Date.parse('2026-04-28T08:01:00Z') / 1000),
    jti,
  }
}

function expectedDecision(disposition: string) {
  if (disposition === 'accept-in-person') {
    return { decision: 'accept-in-person', nonce: vectors.activeNonce }
  }
  if (disposition === 'nonce-consumed') {
    return { decision: 'reject', reason: 'nonce-consumed' }
  }
  return { decision: 'remote-unbound', reason: 'no-active-matching-nonce' }
}

describe('Trust 002 Verification-Attestation jti nonce binding', () => {
  it.each(vectors.cases)('classifies vector case $name', (testCase) => {
    expect(
      decideVerificationAttestationAcceptance({
        payload: verificationAttestationPayload(testCase.jti),
        localDid: LOCAL_DID,
        activeChallenge: {
          nonce: vectors.activeNonce,
          ts: '2026-04-28T08:00:00Z',
        },
        now: new Date('2026-04-28T08:04:59Z'),
        consumedNonces: new Set<string>(vectors.consumedNonces),
      }),
    ).toEqual(expectedDecision(testCase.expectedDisposition))
  })

  it('normalizes uppercase active challenge nonces before comparing full-match jti values', () => {
    expect(
      decideVerificationAttestationAcceptance({
        payload: verificationAttestationPayload(`urn:uuid:${vectors.activeNonce}`),
        localDid: LOCAL_DID,
        activeChallenge: {
          nonce: vectors.activeNonceUppercase,
          ts: '2026-04-28T08:00:00Z',
        },
        now: new Date('2026-04-28T08:04:59Z'),
        consumedNonces: new Set<string>(),
      }),
    ).toEqual({
      decision: 'accept-in-person',
      nonce: vectors.activeNonce,
    })
  })

  it('treats uppercase urn:uuid prefixes as unbound pending spec clarification', () => {
    expect(
      decideVerificationAttestationAcceptance({
        payload: verificationAttestationPayload(`URN:UUID:${vectors.activeNonce}`),
        localDid: LOCAL_DID,
        activeChallenge: {
          nonce: vectors.activeNonce,
          ts: '2026-04-28T08:00:00Z',
        },
        now: new Date('2026-04-28T08:04:59Z'),
        consumedNonces: new Set<string>(),
      }),
    ).toEqual({
      decision: 'remote-unbound',
      reason: 'no-active-matching-nonce',
    })
  })
})
