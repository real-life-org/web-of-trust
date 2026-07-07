import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const testDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(testDir, '..', '..', '..')

function readRepoFile(file: string): string {
  return fs.readFileSync(path.resolve(repoRoot, file), 'utf8')
}

function repoFileExists(file: string): boolean {
  return fs.existsSync(path.resolve(repoRoot, file))
}

describe('demo legacy VerificationService removal source guard', () => {
  it('does not keep the unused VerificationService file, barrel export, or AdapterContext provider surface', () => {
    const adapterContext = readRepoFile('apps/demo/src/context/AdapterContext.tsx')
    const servicesBarrel = readRepoFile('apps/demo/src/services/index.ts')

    expect(repoFileExists('apps/demo/src/services/VerificationService.ts')).toBe(false)
    expect(servicesBarrel).not.toContain('VerificationService')
    expect(adapterContext).not.toContain('VerificationService')
    expect(adapterContext).not.toContain('verificationService')
  })

  it('keeps the active Trust 002 verification flow routed through verificationWorkflow and attestations', () => {
    const useVerification = readRepoFile('apps/demo/src/hooks/useVerification.ts')
    const verificationWorkflow = readRepoFile('apps/demo/src/services/verificationWorkflow.ts')

    expect(useVerification).toContain("from '../services/verificationWorkflow'")
    expect(useVerification).toContain('verificationWorkflow.createOnlineQrChallenge')
    expect(useVerification).toContain('verificationWorkflow.createVerificationAttestation')
    expect(useVerification).toContain('verificationWorkflow.createCounterVerificationAttestation')
    expect(useVerification).toContain('storage.saveAttestation')
    // Inbox-Wire-Migration (K2): Versand läuft über inbox/1.0 statt
    // Old-World-Envelopes mit type 'attestation'.
    expect(useVerification).toContain('attestationService.sendAttestation')
    expect(useVerification).not.toContain("type: 'attestation'")
    expect(useVerification).not.toContain('VerificationService')
    expect(verificationWorkflow).toContain("export { verificationWorkflow } from '../runtime/appRuntime'")
  })
})
