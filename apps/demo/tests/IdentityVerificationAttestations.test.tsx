import { describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Attestation } from '@web_of_trust/core/types'

vi.mock('../src/context', () => ({
  useAdapters: () => ({
    reactiveStorage: {
      watchAllAttestations: () => ({ subscribe: () => () => {}, getSnapshot: () => [] }),
    },
  }),
  useIdentity: () => ({ did: null }),
}))

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

  it('splits accepted received attestations disjointly into /v and /a (Step 6)', () => {
    const text = readRepoFile('apps/demo/src/hooks/useProfileSync.ts')

    // No legacy Verification record types — the split runs on Trust 002 attestations.
    expect(text).not.toContain('getReceivedVerifications')
    expect(text).not.toContain('watchReceivedVerifications')

    expect(text).toContain('getReceivedAttestations')
    expect(text).toContain('getAttestationMetadata')
    // Disjoint publish split (Sync 004 Z.24-32): both resources are published.
    expect(text).toContain('splitAcceptedAttestations')
    expect(text).toContain('publishVerifications')
    expect(text).toContain('publishAttestations')
    expect(text).toContain('uploadAttestationsSafely')
  })

  it('exposes attestation-only profile sync publication API naming', () => {
    const files = [
      'apps/demo/src/hooks/useProfileSync.ts',
      'apps/demo/src/App.tsx',
      'apps/demo/src/pages/Identity.tsx',
      'apps/demo/src/components/attestation/AttestationList.tsx',
      'apps/demo/tests/AppRoutes.test.tsx',
      'apps/demo/tests/IdentityVerificationAttestations.test.tsx',
    ]
    const oldName = 'upload' + 'Verifications' + 'And' + 'Attestations'
    const hits = files.flatMap((file) => {
      const text = readRepoFile(file)
      return text.includes(oldName) ? [`${file} still contains ${oldName}`] : []
    })

    expect(hits).toEqual([])
    expect(readRepoFile('apps/demo/src/hooks/useProfileSync.ts')).toContain('uploadAttestations')
  })
})
