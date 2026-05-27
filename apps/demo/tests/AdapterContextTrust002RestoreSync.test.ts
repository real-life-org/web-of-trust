import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const testDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(testDir, '..', '..', '..')

function readRepoFile(file: string): string {
  return fs.readFileSync(path.resolve(repoRoot, file), 'utf8')
}

describe('AdapterContext Trust 002 restore/sync source guard', () => {
  it('restores discovery data through public attestations, not legacy Verification records', () => {
    const text = readRepoFile('apps/demo/src/context/AdapterContext.tsx')

    expect(text).not.toContain('resolveVerifications')
    expect(text).not.toContain('saveVerification(')

    expect(text).toContain('resolveAttestations')
    expect(text).toContain('saveAttestation')
    expect(text).toContain('setAttestationAccepted')
  })

  it('derives restored verification contacts from Trust 002 attestation wrappers', () => {
    const text = readRepoFile('apps/demo/src/context/AdapterContext.tsx')

    expect(text).not.toContain('v.timestamp')
    expect(text).not.toMatch(/hooks\/useVerificationStatus/)

    expect(text).toContain('isVerificationAttestation')
    expect(text).toContain('attestation.from')
    expect(text).toContain('attestation.to')
    expect(text).toContain('attestation.createdAt')
    expect(text).toContain('contactTimestamps')
  })

  it('syncs profile plus accepted received attestations without legacy public verification publication', () => {
    const text = readRepoFile('apps/demo/src/context/AdapterContext.tsx')

    expect(text).not.toContain('PublicVerificationsData')
    expect(text).not.toContain('getReceivedVerifications')
    expect(text).not.toContain('result.verifications')

    expect(text).toContain('PublicAttestationsData')
    expect(text).toContain('getReceivedAttestations')
    expect(text).toContain('getAttestationMetadata')
    expect(text).toMatch(/getReceivedAttestations\(\)[\s\S]*getAttestationMetadata\(att\.id\)[\s\S]*if \(meta\?\.accepted\) accepted\.push\(att\)/)
  })
})
