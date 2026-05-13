import type { IdentitySession } from '../identity'
import type { Attestation } from '../../types/attestation'
import type { Verification, VerificationChallenge, VerificationResponse } from '../../types/verification'
import type {
  AttestationVcPayload,
  ProtocolCryptoAdapter,
  QrChallenge,
  VerificationAttestationAcceptanceDecision,
} from '../../protocol'
import {
  createAttestationVcJwsWithSigner,
  decodeBase64Url,
  decideVerificationAttestationAcceptance,
  didKeyToPublicKeyBytes,
  ed25519MultibaseToPublicKeyBytes,
  encodeBase64Url,
  parseQrChallenge,
} from '../../protocol'

const CONSUMED_NONCE_RETENTION_MS = 24 * 60 * 60 * 1000
const PENDING_COUNTER_VERIFICATION_MAX_AGE_MS = 24 * 60 * 60 * 1000
const VERIFICATION_ATTESTATION_CLAIM = 'in-person verifiziert'

export interface VerificationWorkflowOptions {
  crypto: ProtocolCryptoAdapter
  randomId?: () => string
  now?: () => Date
}

export interface CreateChallengeResult {
  challenge: VerificationChallenge
  code: string
}

export interface CreateResponseResult {
  response: VerificationResponse
  code: string
}

export interface CreateOnlineQrChallengeOptions {
  broker?: string
}

export interface CreateOnlineQrChallengeResult {
  challenge: QrChallenge
  rawJson: string
}

export interface CreateVerificationAttestationInput {
  issuer: IdentitySession
  subjectDid: string
  challengeNonce: string
}

export interface CreateCounterVerificationAttestationInput {
  issuer: IdentitySession
  subjectDid: string
  /** The `jti` of the original nonce-bound Verification-Attestation this response answers. */
  inResponseTo: string
}

export interface PendingCounterVerification {
  counterpartyDid: string
  /** The `jti` of the original in-person Verification-Attestation this counter-verification answers. */
  originalVerificationId: string
  createdAt: string
  expiresAt: string
}

export interface RecordPendingCounterVerificationOptions {
  counterpartyDid: string
  /** The `jti` of the original in-person Verification-Attestation this counter-verification answers. */
  originalVerificationId: string
}

export type CounterVerificationAcceptanceDecision =
  | { decision: 'accept-mutual-in-person'; originalVerificationId: string }
  | { decision: 'remote-unbound'; reason: 'missing-in-response-to' | 'no-pending-counter-verification' | 'pending-counter-expired' }
  | { decision: 'reject'; reason: 'wrong-subject' | 'wrong-issuer' | 'not-verification-attestation' }

export class VerificationWorkflow {
  private readonly crypto: ProtocolCryptoAdapter
  private readonly randomId: () => string
  private readonly now: () => Date
  private activeQrChallenge: QrChallenge | null = null
  private readonly consumedNonces = new Map<string, number>()
  private readonly pendingCounterVerifications = new Map<string, PendingCounterVerification>()

  constructor(options: VerificationWorkflowOptions) {
    this.crypto = options.crypto
    this.randomId = options.randomId ?? (() => crypto.randomUUID())
    this.now = options.now ?? (() => new Date())
  }

  async createChallenge(identity: IdentitySession, name: string): Promise<CreateChallengeResult> {
    const challenge: VerificationChallenge = {
      nonce: this.randomId(),
      timestamp: this.now().toISOString(),
      fromDid: identity.getDid(),
      fromPublicKey: await identity.getPublicKeyMultibase(),
      fromName: name,
    }
    return { challenge, code: encodeJson(challenge) }
  }

  async createOnlineQrChallenge(
    identity: IdentitySession,
    name: string,
    options: CreateOnlineQrChallengeOptions = {},
  ): Promise<CreateOnlineQrChallengeResult> {
    const challenge: QrChallenge = {
      did: identity.getDid(),
      name,
      enc: encodeBase64Url(await identity.getEncryptionPublicKeyBytes()),
      nonce: this.randomId(),
      ts: this.now().toISOString(),
    }
    if (options.broker !== undefined) challenge.broker = options.broker

    const parsedChallenge = parseQrChallenge(JSON.stringify(challenge))
    // Store and return the normalized Trust 002 JSON form that passed protocol validation.
    const rawJson = JSON.stringify(parsedChallenge)
    this.activeQrChallenge = { ...parsedChallenge }
    return { challenge: { ...parsedChallenge }, rawJson }
  }

  getActiveQrChallenge(): QrChallenge | null {
    return this.activeQrChallenge === null ? null : { ...this.activeQrChallenge }
  }

  resetActiveQrChallenge(): void {
    this.activeQrChallenge = null
  }

  async createVerificationAttestation(input: CreateVerificationAttestationInput): Promise<Attestation> {
    const subjectDid = input.subjectDid.trim()
    const challengeNonce = input.challengeNonce.trim()
    if (subjectDid.length === 0) throw new Error('Missing subject DID')
    if (challengeNonce.length === 0) throw new Error('Missing challenge nonce')
    return this.createSignedVerificationAttestation({
      issuer: input.issuer,
      subjectDid,
      id: `urn:uuid:ver-${challengeNonce}-${this.randomId()}`,
    })
  }

  async createCounterVerificationAttestation(input: CreateCounterVerificationAttestationInput): Promise<Attestation> {
    const subjectDid = input.subjectDid.trim()
    const inResponseTo = input.inResponseTo.trim()
    if (subjectDid.length === 0) throw new Error('Missing subject DID')
    if (inResponseTo.length === 0) throw new Error('Missing inResponseTo')
    return this.createSignedVerificationAttestation({
      issuer: input.issuer,
      subjectDid,
      id: `urn:uuid:ver-${this.randomId()}`,
      inResponseTo,
    })
  }

  acceptVerifiedVerificationAttestation(
    identity: IdentitySession,
    payload: AttestationVcPayload,
  ): VerificationAttestationAcceptanceDecision {
    const now = this.now()
    this.pruneConsumedNonces(now)

    const decision = decideVerificationAttestationAcceptance({
      payload,
      localDid: identity.getDid(),
      activeChallenge: this.activeQrChallenge ?? undefined,
      now,
      consumedNonces: new Set(this.consumedNonces.keys()),
    })
    const consumedNonce = this.findConsumedNonce(payload.jti)
    // Preserve primary protocol rejections to avoid leaking nonce-history membership.
    // Only a remote/unbound result can be upgraded into the local replay classification.
    if (decision.decision === 'remote-unbound' && consumedNonce) {
      return { decision: 'reject', reason: 'nonce-consumed' }
    }
    if (decision.decision === 'accept-in-person') {
      this.consumedNonces.set(decision.nonce.toLowerCase(), now.getTime())
      this.activeQrChallenge = null
      // accept-in-person guarantees jti exists; missing jti would have produced missing-jti-nonce.
      this.recordPendingCounterVerification({
        counterpartyDid: payload.iss,
        originalVerificationId: payload.jti!,
      })
    }
    return decision
  }

  /**
   * Public for composition code that imports an already accepted in-person Verification-Attestation.
   */
  recordPendingCounterVerification(options: RecordPendingCounterVerificationOptions): PendingCounterVerification {
    const now = this.now()
    const pending: PendingCounterVerification = {
      counterpartyDid: options.counterpartyDid,
      originalVerificationId: options.originalVerificationId,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + PENDING_COUNTER_VERIFICATION_MAX_AGE_MS).toISOString(),
    }
    this.pendingCounterVerifications.set(pending.originalVerificationId, pending)
    return { ...pending }
  }

  getPendingCounterVerification(originalVerificationId: string): PendingCounterVerification | null {
    this.prunePendingCounterVerifications(this.now())
    const pending = this.pendingCounterVerifications.get(originalVerificationId)
    return pending === undefined ? null : { ...pending }
  }

  getPendingCounterVerifications(): PendingCounterVerification[] {
    this.prunePendingCounterVerifications(this.now())
    return Array.from(this.pendingCounterVerifications.values(), (pending) => ({ ...pending }))
  }

  acceptVerifiedCounterVerification(
    identity: IdentitySession,
    payload: AttestationVcPayload,
  ): CounterVerificationAcceptanceDecision {
    const now = this.now()
    const localDid = identity.getDid()
    if (payload.sub !== localDid || payload.credentialSubject?.id !== localDid) {
      return { decision: 'reject', reason: 'wrong-subject' }
    }
    if (!isVerificationAttestationPayload(payload)) {
      return { decision: 'reject', reason: 'not-verification-attestation' }
    }
    const inResponseTo = typeof payload.inResponseTo === 'string' && payload.inResponseTo.length > 0
      ? payload.inResponseTo
      : null
    if (!inResponseTo) return { decision: 'remote-unbound', reason: 'missing-in-response-to' }

    const pending = this.pendingCounterVerifications.get(inResponseTo)
    if (!pending) return { decision: 'remote-unbound', reason: 'no-pending-counter-verification' }
    if (Date.parse(pending.expiresAt) <= now.getTime()) {
      this.pendingCounterVerifications.delete(inResponseTo)
      return { decision: 'remote-unbound', reason: 'pending-counter-expired' }
    }
    if (payload.iss !== pending.counterpartyDid || payload.issuer !== pending.counterpartyDid) {
      return { decision: 'reject', reason: 'wrong-issuer' }
    }

    this.pendingCounterVerifications.delete(inResponseTo)
    return { decision: 'accept-mutual-in-person', originalVerificationId: inResponseTo }
  }

  decodeChallenge(code: string): VerificationChallenge {
    return decodeJson<VerificationChallenge>(code)
  }

  prepareChallenge(code: string, localDid?: string): VerificationChallenge {
    const challenge = this.decodeChallenge(code)
    if (localDid && challenge.fromDid === localDid) throw new Error('Cannot verify own identity')
    return challenge
  }

  async createResponse(challengeCode: string, identity: IdentitySession, name: string): Promise<CreateResponseResult> {
    const challenge = this.prepareChallenge(challengeCode, identity.getDid())
    const response: VerificationResponse = {
      nonce: challenge.nonce,
      timestamp: this.now().toISOString(),
      toDid: identity.getDid(),
      toPublicKey: await identity.getPublicKeyMultibase(),
      toName: name,
      fromDid: challenge.fromDid,
      fromPublicKey: challenge.fromPublicKey,
      fromName: challenge.fromName,
    }
    return { response, code: encodeJson(response) }
  }

  decodeResponse(code: string): VerificationResponse {
    return decodeJson<VerificationResponse>(code)
  }

  async completeVerification(responseCode: string, identity: IdentitySession, expectedNonce: string): Promise<Verification> {
    const response = this.decodeResponse(responseCode)
    if (response.nonce !== expectedNonce) throw new Error('Nonce mismatch')
    return this.createSignedVerification({
      identity,
      toDid: response.toDid,
      nonce: response.nonce,
      timestamp: response.timestamp,
      id: `urn:uuid:ver-${response.nonce}`,
      proofCreated: this.now().toISOString(),
    })
  }

  async createVerificationFor(identity: IdentitySession, toDid: string, nonce: string): Promise<Verification> {
    const timestamp = this.now().toISOString()
    return this.createSignedVerification({
      identity,
      toDid,
      nonce,
      timestamp,
      id: `urn:uuid:ver-${nonce}-${identity.getDid().slice(-8)}`,
      proofCreated: timestamp,
    })
  }

  async verifySignature(verification: Verification): Promise<boolean> {
    try {
      const verificationData = JSON.stringify({
        from: verification.from,
        to: verification.to,
        timestamp: verification.timestamp,
      })
      return this.crypto.verifyEd25519(
        new TextEncoder().encode(verificationData),
        decodeBase64Url(verification.proof.proofValue),
        didKeyToPublicKeyBytes(verification.from),
      )
    } catch {
      return false
    }
  }

  publicKeyFromDid(did: string): string {
    if (!did.startsWith('did:key:')) throw new Error('Invalid did:key format')
    return did.slice(8)
  }

  multibaseToBytes(multibase: string): Uint8Array {
    return ed25519MultibaseToPublicKeyBytes(multibase)
  }

  base64UrlToBytes(base64url: string): Uint8Array {
    return decodeBase64Url(base64url)
  }

  private async createSignedVerification(input: {
    identity: IdentitySession
    toDid: string
    nonce: string
    timestamp: string
    id: string
    proofCreated: string
  }): Promise<Verification> {
    const from = input.identity.getDid()
    const verificationData = JSON.stringify({ from, to: input.toDid, timestamp: input.timestamp })
    const signature = await input.identity.sign(verificationData)
    return {
      id: input.id,
      from,
      to: input.toDid,
      timestamp: input.timestamp,
      proof: {
        type: 'Ed25519Signature2020',
        verificationMethod: `${from}#key-1`,
        created: input.proofCreated,
        proofPurpose: 'authentication',
        proofValue: signature,
      },
    }
  }

  private async createSignedVerificationAttestation(input: {
    issuer: IdentitySession
    subjectDid: string
    id: string
    inResponseTo?: string
  }): Promise<Attestation> {
    const createdAt = new Date(Math.floor(this.now().getTime() / 1000) * 1000).toISOString()
    const from = input.issuer.getDid()
    const payload = createVerificationAttestationVcPayload({
      id: input.id,
      from,
      to: input.subjectDid,
      createdAt,
      inResponseTo: input.inResponseTo,
    })
    const vcJws = await createAttestationVcJwsWithSigner({
      kid: `${from}#sig-0`,
      payload,
      sign: async (signingInput) => decodeBase64Url(await input.issuer.sign(new TextDecoder().decode(signingInput))),
    })

    return {
      id: input.id,
      from,
      to: input.subjectDid,
      claim: VERIFICATION_ATTESTATION_CLAIM,
      ...(input.inResponseTo ? { inResponseTo: input.inResponseTo } : {}),
      createdAt,
      vcJws,
    }
  }

  private pruneConsumedNonces(now: Date): void {
    const nowMs = now.getTime()
    for (const [nonce, consumedAtMs] of this.consumedNonces) {
      if (nowMs - consumedAtMs > CONSUMED_NONCE_RETENTION_MS) this.consumedNonces.delete(nonce)
    }
  }

  private prunePendingCounterVerifications(now: Date): void {
    const nowMs = now.getTime()
    for (const [originalVerificationId, pending] of this.pendingCounterVerifications) {
      if (Date.parse(pending.expiresAt) <= nowMs) this.pendingCounterVerifications.delete(originalVerificationId)
    }
  }

  private findConsumedNonce(jti: string | undefined): string | null {
    if (!jti) return null
    for (const nonce of parseVerificationJtiNonces(jti)) {
      if (this.consumedNonces.has(nonce)) return nonce
    }
    return null
  }
}

function createVerificationAttestationVcPayload(input: {
  id: string
  from: string
  to: string
  createdAt: string
  inResponseTo?: string
}): AttestationVcPayload {
  const timestampSeconds = Math.floor(new Date(input.createdAt).getTime() / 1000)
  return {
    '@context': ['https://www.w3.org/ns/credentials/v2', 'https://web-of-trust.de/vocab/v1'],
    id: input.id,
    type: ['VerifiableCredential', 'WotAttestation'],
    issuer: input.from,
    credentialSubject: {
      id: input.to,
      claim: VERIFICATION_ATTESTATION_CLAIM,
    },
    validFrom: input.createdAt,
    iss: input.from,
    sub: input.to,
    nbf: timestampSeconds,
    jti: input.id,
    ...(input.inResponseTo ? { inResponseTo: input.inResponseTo } : {}),
    iat: timestampSeconds,
  }
}

function isVerificationAttestationPayload(payload: AttestationVcPayload): boolean {
  return (
    payload.type.includes('VerifiableCredential') &&
    payload.type.includes('WotAttestation') &&
    payload.credentialSubject.claim === VERIFICATION_ATTESTATION_CLAIM
  )
}

function parseVerificationJtiNonces(jti: string): string[] {
  const uuidPattern = /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/ig
  return Array.from(jti.matchAll(uuidPattern), (match) => match[0].toLowerCase())
}

function encodeJson(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value))
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function decodeJson<T>(code: string): T {
  const binary = atob(code)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return JSON.parse(new TextDecoder().decode(bytes)) as T
}
