import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const testDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(testDir, '..', '..', '..')

function readRepoFile(file: string): string {
  return fs.readFileSync(path.resolve(repoRoot, file), 'utf8')
}

// Step 6 inverts the May-era guard (documented in the directive): the inline
// Recovery/Import block is REPLACED by the application recovery workflow, which
// reconstructs `/p` + `/v` + `/a`, and the publish path is split disjointly.
describe('AdapterContext Sync 004 recovery-workflow + disjoint publish split', () => {
  it('replaces the inline restore with the application recovery workflow', () => {
    const text = readRepoFile('apps/demo/src/context/AdapterContext.tsx')

    // Inline restore is gone (Grep-Gate f).
    expect(text).not.toContain('try to restore')
    expect(text).not.toContain('Recovery/Import')

    // The workflow is wired with the SAME version cache the resolve path writes.
    expect(text).toContain('createProfileRecoveryWorkflow')
    expect(text).toContain('getVersionCache()')
    expect(text).toContain('recoverPublicState')
  })

  it('reconstructs profile, verifications and attestations and imports them accepted', () => {
    const text = readRepoFile('apps/demo/src/context/AdapterContext.tsx')

    expect(text).toContain('result.verifications.value')
    expect(text).toContain('result.attestations.value')
    expect(text).toContain('saveAttestation')
    expect(text).toContain('setAttestationAccepted')
  })

  it('keeps peer-hop + contact reconstruction as private demo runtime, querying /v', () => {
    const text = readRepoFile('apps/demo/src/context/AdapterContext.tsx')

    // Peer-hop now resolves the partner's /v (verifications moved out of /a).
    expect(text).toContain('resolveVerifications(contactDid)')
    expect(text).toContain('contactTimestamps')
    expect(text).toContain('attestation.from')
    expect(text).toContain('attestation.to')
    expect(text).toContain('attestation.createdAt')
  })

  it('splits the publish set disjointly instead of pushing the PublicAttestationsData wire form', () => {
    const text = readRepoFile('apps/demo/src/context/AdapterContext.tsx')

    // PublicAttestationsData as a produktive WIRE type is gone (Grep-Gate c).
    expect(text).not.toContain('PublicAttestationsData')

    // The split + both resources feed syncPending.
    expect(text).toContain('splitAcceptedAttestations')
    expect(text).toContain('result.verifications =')
    expect(text).toContain('result.attestations =')
    expect(text).toContain('getReceivedAttestations')
    expect(text).toContain('getAttestationMetadata')
    expect(text).toMatch(/getReceivedAttestations\(\)[\s\S]*getAttestationMetadata\(att\.id\)[\s\S]*if \(meta\?\.accepted\) accepted\.push\(att\)/)
  })

  it('publishes empty /v and /a lists on offline-retry (consent revocation, Codex review #198)', () => {
    const text = readRepoFile('apps/demo/src/context/AdapterContext.tsx')

    // Regression guard: the offline-retry publish-callback must NOT gate the
    // resource assignment on a non-empty list. An empty list is the valid new
    // public state after consent for the last item was revoked; gating on
    // length would leave the revoked content stale on the server. syncPending
    // itself gates on the dirty set, so unconditional assignment is safe.
    expect(text).not.toMatch(/if\s*\(\s*attestations\.length\s*>\s*0\s*\)/)
    expect(text).not.toMatch(/if\s*\(\s*verifications\.length\s*>\s*0\s*\)/)
  })
})
