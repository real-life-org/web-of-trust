import type { IdentitySession } from '../identity'
import type { Verification, VerificationChallenge, VerificationResponse } from '../../types/verification'
import type {
  AttestationVcPayload,
  ProtocolCryptoAdapter,
  QrChallenge,
  VerificationAttestationAcceptanceDecision,
} from '../../protocol'
import {
  decodeBase64Url,
  decideVerificationAttestationAcceptance,
  didKeyToPublicKeyBytes,
  ed25519MultibaseToPublicKeyBytes,
  encodeBase64Url,
  parseQrChallenge,
} from '../../protocol'

const CONSUMED_NONCE_RETENTION_MS = 24 * 60 * 60 * 1000

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

export class VerificationWorkflow {
  private readonly crypto: ProtocolCryptoAdapter
  private readonly randomId: () => string
  private readonly now: () => Date
  private activeQrChallenge: QrChallenge | null = null
  private readonly consumedNonces = new Map<string, number>()

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
    if (decision.decision === 'remote-unbound' && consumedNonce) {
      return { decision: 'reject', reason: 'nonce-consumed' }
    }
    if (decision.decision === 'accept-in-person') {
      this.consumedNonces.set(decision.nonce.toLowerCase(), now.getTime())
      this.activeQrChallenge = null
    }
    return decision
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

  private pruneConsumedNonces(now: Date): void {
    const nowMs = now.getTime()
    for (const [nonce, consumedAtMs] of this.consumedNonces) {
      if (nowMs - consumedAtMs > CONSUMED_NONCE_RETENTION_MS) this.consumedNonces.delete(nonce)
    }
  }

  private findConsumedNonce(jti: string | undefined): string | null {
    if (!jti) return null
    const nonce = parseVerificationJtiNonce(jti)
    return nonce && this.consumedNonces.has(nonce) ? nonce : null
  }
}

function parseVerificationJtiNonce(jti: string): string | null {
  const match = /^urn:uuid:(?:ver|verification)-([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})(?:-.+)?$/i.exec(jti)
  return match?.[1].toLowerCase() ?? null
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
