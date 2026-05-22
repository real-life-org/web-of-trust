import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Attestation } from '@web_of_trust/core/types'
import { isVerificationAttestation } from '../src/hooks/useVerificationStatus'

const testDir = path.dirname(fileURLToPath(import.meta.url))

function readRepoFile(file: string): string {
  const actualPath = fs.existsSync(file) ? file : path.resolve(testDir, '..', '..', '..', file)
  return fs.readFileSync(actualPath, 'utf8')
}

function makeAttestation(overrides: Partial<Attestation> = {}): Attestation {
  return {
    id: 'att-1',
    from: 'did:wot:issuer',
    to: 'did:wot:holder',
    claim: 'in-person verifiziert',
    createdAt: '2026-05-22T12:00:00.000Z',
    vcJws: 'header.payload.signature',
    ...overrides,
  }
}

describe('Identity Trust 002 verification-attestation source guard', () => {
  it('classifies only signed Trust 002 verification-attestations as local verification entries', () => {
    expect(isVerificationAttestation(makeAttestation())).toBe(true)
    expect(isVerificationAttestation(makeAttestation({ claim: 'helped with setup' }))).toBe(false)
    expect(isVerificationAttestation(makeAttestation({ vcJws: '' }))).toBe(false)
  })

  it('renders local verifications from received verification-attestations with holder-controlled publish metadata', () => {
    const text = readRepoFile('apps/demo/src/pages/Identity.tsx')

    expect(text).not.toContain('watchReceivedVerifications')
    expect(text).not.toContain('v.timestamp')

    expect(text).toContain('isVerificationAttestation')
    expect(text).toContain('getAttestationMetadata')
    expect(text).toContain('setAttestationAccepted')
    expect(text).toContain('aria-pressed={isPublic}')
  })

  it('publishes accepted received attestations without legacy verification publication', () => {
    const text = readRepoFile('apps/demo/src/hooks/useProfileSync.ts')

    expect(text).not.toContain('getReceivedVerifications')
    expect(text).not.toContain('publishVerifications')
    expect(text).not.toContain('watchReceivedVerifications')

    expect(text).toContain('getReceivedAttestations')
    expect(text).toContain('getAttestationMetadata')
    expect(text).toContain('publishAttestations')
    expect(text).toContain('uploadAttestationsSafely')
  })
})
