import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const testDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(testDir, '..', '..', '..')
const demoSrcRoot = path.resolve(repoRoot, 'apps/demo/src')
const legacyMessageTypes = 'apps/demo/src/types/verification-messages.ts'

const legacyPayloadSurface = [
  'verification-messages',
  'VerificationPayload',
  'VerificationResponsePayload',
  'VerificationCompletePayload',
]

function readRepoFile(file: string): string {
  return fs.readFileSync(path.resolve(repoRoot, file), 'utf8')
}

function repoFileExists(file: string): boolean {
  return fs.existsSync(path.resolve(repoRoot, file))
}

function collectSourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const absolutePath = path.join(dir, entry.name)
    if (entry.isDirectory()) return collectSourceFiles(absolutePath)
    if (!/\.[jt]sx?$/.test(entry.name)) return []
    return [absolutePath]
  })
}

function toRepoPath(absolutePath: string): string {
  return path.relative(repoRoot, absolutePath).split(path.sep).join('/')
}

describe('demo legacy verification message payload type removal source guard', () => {
  it('removes the unused legacy verification response/complete payload surface from demo source', () => {
    const hits: string[] = []

    if (repoFileExists(legacyMessageTypes)) {
      hits.push(`${legacyMessageTypes} exists`)
    }

    for (const absolutePath of collectSourceFiles(demoSrcRoot)) {
      const repoPath = toRepoPath(absolutePath)
      if (repoPath === legacyMessageTypes) continue

      const text = fs.readFileSync(absolutePath, 'utf8')
      for (const needle of legacyPayloadSurface) {
        if (text.includes(needle)) hits.push(`${repoPath} contains ${needle}`)
      }
    }

    expect(hits).toEqual([])
  })

  // Inbox-Wire-Migration (Direktive 1.7): die Old-World-Envelopes mit
  // type 'attestation' sind tot — Versand läuft über attestationService.
  // sendAttestation (inbox/1.0, K2), Empfang über das typed
  // inboxReception.onAttestation-Event (VE-9) statt envelope.type-Parsing.
  it('keeps the active Trust 002 verification flow on attestation deliveries', () => {
    const useVerification = readRepoFile('apps/demo/src/hooks/useVerification.ts')
    const verificationWorkflow = readRepoFile('apps/demo/src/services/verificationWorkflow.ts')
    const app = readRepoFile('apps/demo/src/App.tsx')
    // M-A: die Listener-Logik ist aus App.tsx nach services/attestationListener.ts
    // extrahiert, damit Tests den produktiven Code treffen.
    const attestationListener = readRepoFile('apps/demo/src/services/attestationListener.ts')

    expect(useVerification).toMatch(/from\s+['"]\.\.\/services\/verificationWorkflow['"]/)
    expect(useVerification).toContain('verificationWorkflow.createVerificationAttestation')
    expect(useVerification).toContain('verificationWorkflow.createCounterVerificationAttestation')
    expect(useVerification).toContain('storage.saveAttestation')
    const attestationDeliveries = useVerification.match(/attestationService\.sendAttestation\(/g) ?? []
    expect(attestationDeliveries.length).toBeGreaterThanOrEqual(2)
    expect(useVerification).not.toMatch(/type:\s*['"]attestation['"]/)
    expect(verificationWorkflow).toContain("export { verificationWorkflow } from '../runtime/appRuntime'")
    expect(app).toContain('inboxReception.onAttestation')
    expect(app).not.toContain('envelope.type')
    expect(app).toContain('createAttestationListener')
    expect(attestationListener).not.toContain('envelope.type')
    expect(attestationListener).toContain('setPendingIncoming({ attestation, fromDid: attestation.from })')
  })
})
