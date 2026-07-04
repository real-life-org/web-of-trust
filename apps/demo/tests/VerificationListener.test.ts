/**
 * Tests for the Trust 002 in-person Verification-Attestation flow over the
 * inbox/1.0 event path (VE-9).
 *
 * Getestet wird der ECHTE App-Listener (createAttestationListener aus
 * services/attestationListener.ts, M-A-Extraktion) — keine Reimplementierung.
 * Er konsumiert das typed onAttestation-Event des InboxReceptionHost
 * ({vcJws, senderDid, outerId}), verifiziert/dekodiert den VC-JWS, leitet die
 * Attestation-View aus dem VC-Payload ab (K2 — kein Wire-Wrapper mehr),
 * verlangt dieses Gerät als Empfänger, akzeptiert nur nonce-gebundene
 * In-Person-Credentials und öffnet den Bestätigungs-Dialog ohne den
 * generischen Attestation-Dialog.
 *
 * Fehlerdisziplin (M-A): Duplikate (DuplicateAttestationError) sind konklusiv
 * und enden normal; transiente Persist-Fehler werden durchgeworfen, damit der
 * Host processing-incomplete klassifiziert (kein ack, kein record).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import type { Attestation, IdentitySession } from '@web_of_trust/core/types'
import type { AttestationVcPayload } from '@web_of_trust/core/protocol'
import {
  createAttestationListener,
  type AttestationListenerDeps,
} from '../src/services/attestationListener'
import { DuplicateAttestationError } from '../src/services/AttestationService'

const ALICE_DID = 'did:key:z6MkAlice'
const BOB_DID = 'did:key:z6MkBob'
const CAROL_DID = 'did:key:z6MkCarol'
const CHALLENGE_NONCE = '550e8400-e29b-41d4-a716-446655440000'
const VERIFICATION_CLAIM = 'in-person verifiziert'

interface IncomingAttestationDelivery {
  vcJws: string
  senderDid: string
  outerId: string
}

function makeVcJws(input: {
  from?: string
  to?: string
  id?: string
  claim?: string
  inResponseTo?: string
  /** Explicit WotVerification marker override, decoupled from the claim text so
   *  divergence cases (matching claim, NO marker) can be represented. Defaults
   *  to claim-derived. (CodeRabbit #198) */
  isVerification?: boolean
} = {}): string {
  const from = input.from ?? BOB_DID
  const to = input.to ?? ALICE_DID
  const id = input.id ?? `urn:uuid:${CHALLENGE_NONCE}`
  const claim = input.claim ?? VERIFICATION_CLAIM
  // VE-7: verification-attestations carry the WotVerification type marker
  // (Trust 002 / wot-spec #101); the listener discriminates on it, not the claim.
  const isVerification = input.isVerification ?? (claim === VERIFICATION_CLAIM)
  const type = isVerification
    ? ['VerifiableCredential', 'WotAttestation', 'WotVerification']
    : ['VerifiableCredential', 'WotAttestation']
  return `header.${Buffer.from(JSON.stringify({
    id,
    type,
    issuer: from,
    validFrom: '2026-05-22T10:00:00Z',
    iss: from,
    sub: to,
    jti: id,
    ...(input.inResponseTo ? { inResponseTo: input.inResponseTo } : {}),
    credentialSubject: {
      id: to,
      claim,
    },
  })).toString('base64url')}.signature`
}

function makeDelivery(vcJws: string, senderDid: string = BOB_DID): IncomingAttestationDelivery {
  return { vcJws, senderDid, outerId: '550e8400-e29b-41d4-a716-446655440099' }
}

/**
 * Stub für decodeIncomingAttestation: simuliert eine erfolgreiche
 * VC-Verifikation und die K2-Ableitung der Attestation-View aus dem
 * VC-Payload (jti/iss/sub/credentialSubject) — nie aus Wire-Feldern.
 */
async function decodeStub(vcJws: string): Promise<{ attestation: Attestation; payload: AttestationVcPayload }> {
  const [, payloadPart] = vcJws.split('.')
  const payload = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8')) as AttestationVcPayload
  const attestation: Attestation = {
    id: typeof payload.jti === 'string' ? payload.jti : (payload.id as string),
    from: payload.issuer,
    to: payload.credentialSubject.id,
    claim: payload.credentialSubject.claim,
    ...(typeof payload.inResponseTo === 'string' ? { inResponseTo: payload.inResponseTo } : {}),
    createdAt: payload.validFrom,
    vcJws,
  }
  return { attestation, payload }
}

describe('Trust 002 verification attestation listener (real listener code)', () => {
  let decodeIncomingAttestation: ReturnType<typeof vi.fn>
  let saveIncomingAttestation: ReturnType<typeof vi.fn>
  let acceptVerifiedVerificationAttestation: ReturnType<typeof vi.fn>
  let acceptVerifiedCounterVerification: ReturnType<typeof vi.fn>
  let setPendingIncoming: ReturnType<typeof vi.fn>
  let setChallengeNonce: ReturnType<typeof vi.fn>
  let triggerAttestationDialog: ReturnType<typeof vi.fn>

  beforeEach(() => {
    decodeIncomingAttestation = vi.fn(decodeStub)
    saveIncomingAttestation = vi.fn(async (attestation: Attestation) => attestation)
    acceptVerifiedVerificationAttestation = vi.fn()
      .mockResolvedValue({ decision: 'accept-in-person', nonce: CHALLENGE_NONCE })
    acceptVerifiedCounterVerification = vi.fn()
      .mockResolvedValue({ decision: 'accept-mutual-in-person', originalVerificationId: `urn:uuid:${CHALLENGE_NONCE}` })
    setPendingIncoming = vi.fn()
    setChallengeNonce = vi.fn()
    triggerAttestationDialog = vi.fn()
  })

  function buildListener(overrides: Partial<AttestationListenerDeps> = {}) {
    const deps: AttestationListenerDeps = {
      attestationService: {
        decodeIncomingAttestation: decodeIncomingAttestation as unknown as AttestationListenerDeps['attestationService']['decodeIncomingAttestation'],
        saveIncomingAttestation: saveIncomingAttestation as unknown as AttestationListenerDeps['attestationService']['saveIncomingAttestation'],
      },
      verificationWorkflow: {
        acceptVerifiedVerificationAttestation: acceptVerifiedVerificationAttestation as unknown as AttestationListenerDeps['verificationWorkflow']['acceptVerifiedVerificationAttestation'],
        acceptVerifiedCounterVerification: acceptVerifiedCounterVerification as unknown as AttestationListenerDeps['verificationWorkflow']['acceptVerifiedCounterVerification'],
      },
      getLocalDid: () => ALICE_DID,
      getLocalIdentity: () => ({ getDid: () => ALICE_DID } as unknown as IdentitySession),
      findContactName: () => undefined,
      setChallengeNonce,
      setPendingIncoming,
      triggerAttestationDialog,
      ...overrides,
    }
    return createAttestationListener(deps)
  }

  it('accepts nonce-bound Trust 002 Verification-Attestations via inbox deliveries', async () => {
    const handler = buildListener()
    const vcJws = makeVcJws()

    await handler(makeDelivery(vcJws))

    expect(decodeIncomingAttestation).toHaveBeenCalledWith(vcJws)
    expect(acceptVerifiedVerificationAttestation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        iss: BOB_DID,
        sub: ALICE_DID,
        jti: `urn:uuid:${CHALLENGE_NONCE}`,
      }),
    )
    expect(saveIncomingAttestation).toHaveBeenCalledWith(expect.objectContaining({
      id: `urn:uuid:${CHALLENGE_NONCE}`,
      from: BOB_DID,
      to: ALICE_DID,
      claim: VERIFICATION_CLAIM,
      vcJws,
    }))
    expect(setChallengeNonce).toHaveBeenCalledWith(null)
    expect(setPendingIncoming).toHaveBeenCalledWith({
      attestation: expect.objectContaining({ from: BOB_DID, vcJws }),
      fromDid: BOB_DID,
    })
    expect(triggerAttestationDialog).not.toHaveBeenCalled()
  })

  it('rejects remote or unbound Verification-Attestations without saving or prompting', async () => {
    acceptVerifiedVerificationAttestation.mockResolvedValue({ decision: 'remote-unbound', reason: 'missing-jti-nonce' })
    const handler = buildListener()

    await handler(makeDelivery(makeVcJws({ id: 'urn:uuid:remote-proof' })))

    expect(saveIncomingAttestation).not.toHaveBeenCalled()
    expect(setPendingIncoming).not.toHaveBeenCalled()
    expect(triggerAttestationDialog).not.toHaveBeenCalled()
  })

  it('rejects wrong-recipient Verification-Attestations before acceptance', async () => {
    const handler = buildListener()

    await handler(makeDelivery(makeVcJws({ to: CAROL_DID })))

    expect(acceptVerifiedVerificationAttestation).not.toHaveBeenCalled()
    expect(saveIncomingAttestation).not.toHaveBeenCalled()
    expect(setPendingIncoming).not.toHaveBeenCalled()
  })

  // K2: einen manipulierbaren Wire-Wrapper gibt es nicht mehr — alle lokalen
  // Felder stammen aus dem VERIFIZIERTEN VC-Payload. Ein ungültiger VC-JWS
  // wird vom Decode-Schritt abgewiesen — deterministisch, also konklusiv
  // (der Listener endet normal, der Host ackt).
  it('drops deliveries whose VC-JWS fails verification without throwing', async () => {
    decodeIncomingAttestation.mockRejectedValue(new Error('Invalid JWS signature'))
    const handler = buildListener()

    await expect(handler(makeDelivery(makeVcJws()))).resolves.toBeUndefined()

    expect(acceptVerifiedVerificationAttestation).not.toHaveBeenCalled()
    expect(saveIncomingAttestation).not.toHaveBeenCalled()
    expect(setPendingIncoming).not.toHaveBeenCalled()
    expect(triggerAttestationDialog).not.toHaveBeenCalled()
  })

  it('does not depend on legacy nonce placement in document identifiers', async () => {
    const handler = buildListener()

    await handler(makeDelivery(makeVcJws({ id: `urn:uuid:${CHALLENGE_NONCE}` })))

    expect(acceptVerifiedVerificationAttestation).toHaveBeenCalledTimes(1)
    expect(saveIncomingAttestation).toHaveBeenCalledTimes(1)
  })

  it('keeps ordinary incoming attestations on the generic attestation path', async () => {
    const handler = buildListener()

    await handler(makeDelivery(makeVcJws({
      id: 'urn:uuid:ordinary-attestation',
      claim: 'Knows TypeScript',
    })))

    expect(acceptVerifiedVerificationAttestation).not.toHaveBeenCalled()
    expect(saveIncomingAttestation).toHaveBeenCalledWith(expect.objectContaining({
      id: 'urn:uuid:ordinary-attestation',
      claim: 'Knows TypeScript',
    }))
    expect(triggerAttestationDialog).toHaveBeenCalledWith(expect.objectContaining({
      attestationId: 'urn:uuid:ordinary-attestation',
      senderDid: BOB_DID,
      claim: 'Knows TypeScript',
    }))
    expect(setPendingIncoming).not.toHaveBeenCalled()
  })

  // --- M-C: senderDid ↔ VC-iss-Bindung (Sync 003 Z.460-464, wot-spec#98) ---

  it('M-C: rejects deliveries whose VC issuer does not match the authenticated senderDid', async () => {
    const handler = buildListener()

    // Bobs öffentlich abrufbarer VC, von Carol mit EIGENEM gültigem Inner-JWS
    // eingeliefert — Verstoß ist deterministisch → konklusiv, kein Throw.
    await expect(handler(makeDelivery(makeVcJws(), CAROL_DID))).resolves.toBeUndefined()

    expect(acceptVerifiedVerificationAttestation).not.toHaveBeenCalled()
    expect(saveIncomingAttestation).not.toHaveBeenCalled()
    expect(setPendingIncoming).not.toHaveBeenCalled()
    expect(triggerAttestationDialog).not.toHaveBeenCalled()
  })

  it('M-C: rejects generic attestations addressed to a third party (to !== ownDid)', async () => {
    const handler = buildListener()

    await expect(handler(makeDelivery(makeVcJws({
      to: CAROL_DID,
      id: 'urn:uuid:third-party-attestation',
      claim: 'Knows TypeScript',
    })))).resolves.toBeUndefined()

    expect(saveIncomingAttestation).not.toHaveBeenCalled()
    expect(triggerAttestationDialog).not.toHaveBeenCalled()
  })

  // --- M-A: Fehlerdisziplin (Sync 003 Z.466 + Z.620-622) ---

  it('M-A: rethrows transient storage errors so the host classifies processing-incomplete', async () => {
    saveIncomingAttestation.mockRejectedValue(new Error('storage offline'))
    const handler = buildListener()

    await expect(
      handler(makeDelivery(makeVcJws({ id: 'urn:uuid:ordinary-attestation', claim: 'Knows TypeScript' }))),
    ).rejects.toThrow('storage offline')

    expect(triggerAttestationDialog).not.toHaveBeenCalled()
  })

  it('M-A: rethrows transient storage errors on the accepted verification path', async () => {
    saveIncomingAttestation.mockRejectedValue(new Error('storage offline'))
    const handler = buildListener()

    await expect(handler(makeDelivery(makeVcJws()))).rejects.toThrow('storage offline')

    expect(setPendingIncoming).not.toHaveBeenCalled()
  })

  it('M-A: treats DuplicateAttestationError as conclusive (no throw, dialog still triggers)', async () => {
    saveIncomingAttestation.mockRejectedValue(new DuplicateAttestationError('urn:uuid:ordinary-attestation'))
    const handler = buildListener()

    await expect(
      handler(makeDelivery(makeVcJws({ id: 'urn:uuid:ordinary-attestation', claim: 'Knows TypeScript' }))),
    ).resolves.toBeUndefined()

    // TC6 (generischer Dialog-Lifecycle): der Trigger hängt NICHT mehr an
    // isNew — ein Sibling-Device kann die Attestation via Personal-Doc-Sync
    // schon gespeichert haben, bevor die eigene Inbox-Delivery ankommt.
    // Aufgelöstes unterdrückt der OPEN-Gate (¬resolved) im Provider.
    expect(triggerAttestationDialog).toHaveBeenCalledWith(expect.objectContaining({
      attestationId: 'urn:uuid:ordinary-attestation',
    }))
  })

  it('M-A: duplicate accepted verification clears the challenge nonce, dialog still triggers (OPEN-Gate entscheidet)', async () => {
    saveIncomingAttestation.mockRejectedValue(new DuplicateAttestationError(`urn:uuid:${CHALLENGE_NONCE}`))
    const handler = buildListener()

    await expect(handler(makeDelivery(makeVcJws()))).resolves.toBeUndefined()

    expect(setChallengeNonce).toHaveBeenCalledWith(null)
    // TC6: Sibling-Sync-Duplikat darf den Verifications-Dialog nicht mehr
    // verschlucken — resolved-Filterung passiert im Provider-Gate.
    expect(setPendingIncoming).toHaveBeenCalledWith(expect.objectContaining({
      fromDid: expect.any(String),
    }))
  })
})

describe('Trust 002 verification source guard', () => {
  it('removes legacy verification primitives from the demo runtime listener and hook', () => {
    const demoRoot = existsSync('apps/demo/src') ? 'apps/demo' : '.'
    const paths = [
      `${demoRoot}/src/hooks/useVerification.ts`,
      `${demoRoot}/src/App.tsx`,
      `${demoRoot}/src/services/attestationListener.ts`,
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

  // Inbox-Wire-Migration (Direktive 1.7): die signEnvelope-Sites für den
  // Attestation-Versand sind tot — Authentizität kommt aus dem Inner-JWS
  // (Sync 003 Z.446-466). Alle drei Sends laufen über den K2-Pfad
  // attestationService.sendAttestation (inbox/1.0, Body {vcJws}).
  it('routes outgoing verification-attestations through the inbox/1.0 delivery path', () => {
    const demoRoot = existsSync('apps/demo/src') ? 'apps/demo' : '.'
    const text = readFileSync(`${demoRoot}/src/hooks/useVerification.ts`, 'utf8')

    expect(text).not.toContain('signEnvelope')
    expect(text).not.toContain("type: 'attestation'")
    expect(text).not.toContain('MessageEnvelope')
    expect(text.match(/attestationService\.sendAttestation\(identity, \w+/g)).toHaveLength(3)
    // M-B: kein Silent-Drop — Fehler werden sichtbar behandelt (Status
    // 'failed' im Service + Warn-Log), und der Verification-Flow nutzt den
    // Peer-Key direkt aus dem QR-Challenge-Payload (Trust 002 `enc`).
    expect(text).not.toContain('.catch(() => {})')
    expect(text).toContain('recipientEncryptionKey: verificationWorkflow.base64UrlToBytes(decodedChallenge.enc)')
  })
})
