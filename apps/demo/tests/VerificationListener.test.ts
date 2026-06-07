/**
 * Tests for the Trust 002 in-person Verification-Attestation relay flow.
 *
 * The app listener should receive verification attestations through the normal
 * attestation envelope path, verify/decode the VC-JWS, require this device as
 * the recipient, accept only nonce-bound in-person credentials, and open the
 * incoming verification confirmation dialog without also opening the generic
 * attestation dialog.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import type { Attestation, MessageEnvelope } from '@web_of_trust/core/types'
import { createResourceRef } from '@web_of_trust/core/types'

const ALICE_DID = 'did:key:z6MkAlice'
const BOB_DID = 'did:key:z6MkBob'
const CAROL_DID = 'did:key:z6MkCarol'
const CHALLENGE_NONCE = '550e8400-e29b-41d4-a716-446655440000'
const VERIFICATION_CLAIM = 'in-person verifiziert'

type VerifiedPayload = {
  id?: string
  type: string[]
  issuer: string
  validFrom: string
  iss: string
  sub: string
  jti?: string
  inResponseTo?: string
  credentialSubject: {
    id: string
    claim: string
  }
}

type AcceptanceDecision =
  | { decision: 'accept-in-person'; nonce: string }
  | { decision: 'remote-unbound'; reason: string }
  | { decision: 'reject'; reason: string }

function makeVerificationAttestation(input: {
  from?: string
  to?: string
  id?: string
  claim?: string
  inResponseTo?: string
} = {}): Attestation {
  const from = input.from ?? BOB_DID
  const to = input.to ?? ALICE_DID
  const id = input.id ?? `urn:uuid:${CHALLENGE_NONCE}`
  return {
    id,
    from,
    to,
    claim: input.claim ?? VERIFICATION_CLAIM,
    ...(input.inResponseTo ? { inResponseTo: input.inResponseTo } : {}),
    createdAt: '2026-05-22T10:00:00Z',
    vcJws: `header.${Buffer.from(JSON.stringify({
      id,
      type: ['VerifiableCredential', 'WotAttestation'],
      issuer: from,
      validFrom: '2026-05-22T10:00:00Z',
      iss: from,
      sub: to,
      jti: id,
      ...(input.inResponseTo ? { inResponseTo: input.inResponseTo } : {}),
      credentialSubject: {
        id: to,
        claim: input.claim ?? VERIFICATION_CLAIM,
      },
    })).toString('base64url')}.signature`,
  }
}

function makeAttestationEnvelope(attestation: Attestation): MessageEnvelope {
  return {
    v: 1,
    id: attestation.id,
    type: 'attestation',
    fromDid: attestation.from,
    toDid: attestation.to,
    createdAt: attestation.createdAt,
    encoding: 'json',
    payload: JSON.stringify(attestation),
    signature: '',
    ref: createResourceRef('attestation', attestation.id),
  }
}

/**
 * Simulates the intended Trust 002 listener contract from App.tsx.
 */
function createTrust002Listener(deps: {
  myDid: string
  decodeVcJws: (vcJws: string) => Promise<VerifiedPayload>
  acceptVerified: (payload: VerifiedPayload) => AcceptanceDecision | Promise<AcceptanceDecision>
  saveAttestation: (attestation: Attestation) => Promise<void>
  setPendingIncoming: (pending: { attestation: Attestation; fromDid: string } | null) => void
  triggerAttestationDialog: (info: unknown) => void
}) {
  return async (envelope: MessageEnvelope) => {
    if (envelope.type !== 'attestation') return

    let attestation: Attestation
    try {
      attestation = JSON.parse(envelope.payload)
    } catch {
      return
    }

    if (!attestation.id || !attestation.from || !attestation.to || !attestation.claim || !attestation.vcJws) return

    let payload: VerifiedPayload
    try {
      payload = await deps.decodeVcJws(attestation.vcJws)
    } catch {
      return
    }

    const payloadClaimsVerification =
      payload.type.includes('VerifiableCredential') &&
      payload.type.includes('WotAttestation') &&
      payload.credentialSubject.claim === VERIFICATION_CLAIM
    const wrapperClaimsVerification = attestation.claim === VERIFICATION_CLAIM

    if (payloadClaimsVerification || wrapperClaimsVerification) {
      if (!payloadClaimsVerification || !wrapperClaimsVerification) return
      if (!payloadMatchesAttestation(payload, attestation)) return
    } else {
      await deps.saveAttestation(attestation)
      deps.triggerAttestationDialog({
        attestationId: attestation.id,
        senderDid: attestation.from,
        claim: attestation.claim,
      })
      return
    }

    if (attestation.to !== deps.myDid || payload.sub !== deps.myDid || payload.credentialSubject.id !== deps.myDid) return

    const decision = await deps.acceptVerified(payload)
    if (decision.decision !== 'accept-in-person') return

    await deps.saveAttestation(attestation)
    deps.setPendingIncoming({ attestation, fromDid: attestation.from })
  }
}

function payloadMatchesAttestation(payload: VerifiedPayload, attestation: Attestation): boolean {
  return (
    payload.issuer === attestation.from &&
    payload.iss === attestation.from &&
    payload.sub === attestation.to &&
    payload.credentialSubject.id === attestation.to &&
    payload.credentialSubject.claim === attestation.claim &&
    payload.validFrom === attestation.createdAt &&
    (payload.inResponseTo == null ? attestation.inResponseTo == null : payload.inResponseTo === attestation.inResponseTo) &&
    (payload.jti == null || payload.jti === attestation.id) &&
    (payload.id == null || payload.id === attestation.id)
  )
}

describe('Trust 002 verification attestation listener', () => {
  let decodeVcJws: ReturnType<typeof vi.fn>
  let acceptVerified: ReturnType<typeof vi.fn>
  let saveAttestation: ReturnType<typeof vi.fn>
  let setPendingIncoming: ReturnType<typeof vi.fn>
  let triggerAttestationDialog: ReturnType<typeof vi.fn>

  beforeEach(() => {
    decodeVcJws = vi.fn(async (vcJws: string) => {
      const [, payload] = vcJws.split('.')
      return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as VerifiedPayload
    })
    acceptVerified = vi.fn().mockReturnValue({ decision: 'accept-in-person', nonce: CHALLENGE_NONCE })
    saveAttestation = vi.fn().mockResolvedValue(undefined)
    setPendingIncoming = vi.fn()
    triggerAttestationDialog = vi.fn()
  })

  function defaultDeps(overrides?: Partial<Parameters<typeof createTrust002Listener>[0]>) {
    return {
      myDid: ALICE_DID,
      decodeVcJws,
      acceptVerified,
      saveAttestation,
      setPendingIncoming,
      triggerAttestationDialog,
      ...overrides,
    }
  }

  it('accepts nonce-bound Trust 002 Verification-Attestations via attestation envelopes', async () => {
    const handler = createTrust002Listener(defaultDeps())
    const attestation = makeVerificationAttestation()

    await handler(makeAttestationEnvelope(attestation))

    expect(decodeVcJws).toHaveBeenCalledWith(attestation.vcJws)
    expect(acceptVerified).toHaveBeenCalledWith(expect.objectContaining({
      iss: BOB_DID,
      sub: ALICE_DID,
      jti: `urn:uuid:${CHALLENGE_NONCE}`,
    }))
    expect(saveAttestation).toHaveBeenCalledWith(attestation)
    expect(setPendingIncoming).toHaveBeenCalledWith({ attestation, fromDid: BOB_DID })
    expect(triggerAttestationDialog).not.toHaveBeenCalled()
  })

  it('rejects remote or unbound Verification-Attestations without saving or prompting', async () => {
    acceptVerified.mockReturnValue({ decision: 'remote-unbound', reason: 'missing-jti-nonce' })
    const handler = createTrust002Listener(defaultDeps())
    const attestation = makeVerificationAttestation({ id: 'urn:uuid:remote-proof' })

    await handler(makeAttestationEnvelope(attestation))

    expect(saveAttestation).not.toHaveBeenCalled()
    expect(setPendingIncoming).not.toHaveBeenCalled()
    expect(triggerAttestationDialog).not.toHaveBeenCalled()
  })

  it('rejects wrong-recipient Verification-Attestations before acceptance', async () => {
    const handler = createTrust002Listener(defaultDeps())
    const attestation = makeVerificationAttestation({ to: CAROL_DID })

    await handler(makeAttestationEnvelope(attestation))

    expect(acceptVerified).not.toHaveBeenCalled()
    expect(saveAttestation).not.toHaveBeenCalled()
    expect(setPendingIncoming).not.toHaveBeenCalled()
  })

  it('rejects tampered Verification-Attestation wrappers before nonce acceptance', async () => {
    const handler = createTrust002Listener(defaultDeps())
    const signedForBob = makeVerificationAttestation()
    const tamperedWrapper = {
      ...signedForBob,
      from: CAROL_DID,
      createdAt: '2026-05-22T10:00:01Z',
    }

    await handler(makeAttestationEnvelope(tamperedWrapper))

    expect(acceptVerified).not.toHaveBeenCalled()
    expect(saveAttestation).not.toHaveBeenCalled()
    expect(setPendingIncoming).not.toHaveBeenCalled()
    expect(triggerAttestationDialog).not.toHaveBeenCalled()
  })

  it('does not depend on legacy nonce placement in document identifiers', async () => {
    const handler = createTrust002Listener(defaultDeps())
    const attestation = makeVerificationAttestation({
      id: `urn:uuid:${CHALLENGE_NONCE}`,
    })

    await handler(makeAttestationEnvelope(attestation))

    expect(acceptVerified).toHaveBeenCalledTimes(1)
    expect(saveAttestation).toHaveBeenCalledWith(attestation)
  })

  it('keeps ordinary incoming attestations on the generic attestation path', async () => {
    const handler = createTrust002Listener(defaultDeps())
    const attestation = makeVerificationAttestation({
      id: 'urn:uuid:ordinary-attestation',
      claim: 'Knows TypeScript',
    })

    await handler(makeAttestationEnvelope(attestation))

    expect(acceptVerified).not.toHaveBeenCalled()
    expect(saveAttestation).toHaveBeenCalledWith(attestation)
    expect(triggerAttestationDialog).toHaveBeenCalledWith(expect.objectContaining({
      attestationId: attestation.id,
      senderDid: BOB_DID,
      claim: 'Knows TypeScript',
    }))
    expect(setPendingIncoming).not.toHaveBeenCalled()
  })
})

describe('Trust 002 verification source guard', () => {
  it('removes legacy verification primitives from the demo runtime listener and hook', () => {
    const demoRoot = existsSync('apps/demo/src') ? 'apps/demo' : '.'
    const paths = [
      `${demoRoot}/src/hooks/useVerification.ts`,
      `${demoRoot}/src/App.tsx`,
      `${demoRoot}/tests/VerificationListener.test.ts`,
    ]
    const blockedTerms = [
      ['create', 'Verification', 'For'].join(''),
      ['verify', 'Signature'].join(''),
      ['type:', ' ', "'verification'"].join(''),
      ['type:', ' ', '"verification"'].join(''),
      ['Verification', 'Challenge'].join(''),
      ['id', '.', 'includes', '('].join(''),
      ['urn:uuid:ver-', '${nonce'].join(''),
    ]

    const matches = paths.flatMap((path) => {
      const text = readFileSync(path, 'utf8')
      return blockedTerms
        .filter((term) => text.includes(term))
        .map((term) => `${path}: ${term}`)
    })

    expect(matches).toEqual([])
  })

  it('signs outgoing verification-attestation envelopes before sending them', () => {
    // Invariant (unchanged): every outgoing verification-delivery is signed
    // before it leaves the device. After the 1.B.2 migration this guarantee is
    // proven via the workflow path, not via inline signEnvelope call sites.
    //
    // signing now happens inside verification-delivery-workflow before send:
    //  - the hook builds NO envelope inline and imports NO signEnvelope helper
    //    (the deprecated legacy envelope-auth import, wot-spec#96, lives in the
    //    runtime factory bindVerificationDelivery, not the hook layer);
    //  - the hook delegates all three deliveries to deliverAttestation;
    //  - the bound signEnvelope port lives in the runtime delivery factory.
    const demoRoot = existsSync('apps/demo/src') ? 'apps/demo' : '.'
    const hook = readFileSync(`${demoRoot}/src/hooks/useVerification.ts`, 'utf8')
    const runtime = readFileSync(`${demoRoot}/src/runtime/appRuntime.ts`, 'utf8')

    // (a) hook no longer imports or uses the deprecated signEnvelope helper.
    expect(hook).not.toContain('signEnvelope')
    expect(hook).not.toContain("from '@web_of_trust/core/crypto'")

    // (b) hook builds no MessageEnvelope inline.
    expect(hook).not.toMatch(/type:\s*['"]attestation['"]/)

    // (c) hook delegates every delivery to the verification-delivery-workflow.
    expect(hook).toMatch(/deliverAttestation/)
    expect(hook).toContain('bindVerificationDelivery')
    expect(hook.match(/deliverAttestation\(/g)).toHaveLength(3)

    // (d) signing lives in the runtime delivery factory: it binds the
    //     deprecated signEnvelope helper into the workflow before send.
    expect(runtime).toContain("import { signEnvelope } from '@web_of_trust/core/crypto'")
    expect(runtime).toContain('createVerificationDeliveryWorkflow')
    expect(runtime).toMatch(/signEnvelope:\s*\(envelope\)\s*=>\s*signEnvelope\(/)
  })
})
