import type { ProtocolCryptoAdapter } from '../crypto/ports'
import { didKeyToPublicKeyBytes, didOrKidToDid } from '../identity/did-key'
import type { JcsEd25519SignFn } from '../crypto/jws'
import { createJcsEd25519Jws, createJcsEd25519JwsWithSigner, verifyJwsWithPublicKey } from '../crypto/jws'
import type { JsonValue } from '../crypto/jcs'
import { decodeBase64Url } from '../crypto/encoding'

const VC_CONTEXT = 'https://www.w3.org/ns/credentials/v2'
const WOT_CONTEXT = 'https://web-of-trust.de/vocab/v1'
const VERIFIABLE_CREDENTIAL_TYPE = 'VerifiableCredential'
const WOT_ATTESTATION_TYPE = 'WotAttestation'

export interface AttestationVcPayload {
  '@context': string[]
  id?: string
  type: string[]
  issuer: string
  credentialSubject: { id: string; claim: string; [key: string]: unknown }
  validFrom: string
  iss: string
  sub: string
  nbf: number
  jti?: string
  iat?: number
  exp?: number
  [key: string]: unknown
}

export interface CreateAttestationVcJwsOptions {
  payload: AttestationVcPayload
  kid: string
  signingSeed: Uint8Array
}

export interface CreateAttestationVcJwsWithSignerOptions {
  payload: AttestationVcPayload
  kid: string
  sign: JcsEd25519SignFn
}

export interface VerifyAttestationVcJwsOptions {
  crypto: ProtocolCryptoAdapter
  now?: Date
}

export async function createAttestationVcJws(options: CreateAttestationVcJwsOptions): Promise<string> {
  assertNonEmptyKid(options.kid)
  return createJcsEd25519Jws(
    { alg: 'EdDSA', kid: options.kid, typ: 'vc+jwt' },
    options.payload as unknown as JsonValue,
    options.signingSeed,
  )
}

export async function createAttestationVcJwsWithSigner(
  options: CreateAttestationVcJwsWithSignerOptions,
): Promise<string> {
  assertNonEmptyKid(options.kid)
  return createJcsEd25519JwsWithSigner(
    { alg: 'EdDSA', kid: options.kid, typ: 'vc+jwt' },
    options.payload as unknown as JsonValue,
    options.sign,
  )
}

export async function verifyAttestationVcJws(
  jws: string,
  options: VerifyAttestationVcJwsOptions,
): Promise<AttestationVcPayload> {
  const kid = extractKid(jws)
  const decoded = await verifyJwsWithPublicKey(jws, {
    publicKey: didKeyToPublicKeyBytes(kid),
    crypto: options.crypto,
  })
  const payload = decoded.payload
  const jwsHeader = decoded.header as { typ?: string }
  if (jwsHeader.typ !== 'vc+jwt') throw new Error('Invalid attestation JWS typ')
  assertAttestationVcPayload(payload, kid, options.now ?? new Date())
  return payload
}

function assertAttestationVcPayload(
  payload: unknown,
  kid: string,
  now: Date,
): asserts payload is AttestationVcPayload {
  assertRecord(payload, 'Invalid attestation payload')
  assertStringArray(payload['@context'], 'Invalid attestation @context')
  if (!payload['@context'].includes(VC_CONTEXT)) throw new Error('Missing VC context')
  if (!payload['@context'].includes(WOT_CONTEXT)) throw new Error('Missing WoT context')

  assertStringArray(payload.type, 'Invalid attestation type')
  if (!payload.type.includes(VERIFIABLE_CREDENTIAL_TYPE)) throw new Error('Missing VerifiableCredential type')
  if (!payload.type.includes(WOT_ATTESTATION_TYPE)) throw new Error('Missing WotAttestation type')

  if (typeof payload.issuer !== 'string' || payload.issuer.length === 0) {
    throw new Error('Missing attestation issuer')
  }
  if (typeof payload.iss !== 'string' || payload.iss.length === 0) throw new Error('Missing attestation iss')
  if (payload.issuer !== payload.iss) throw new Error('Attestation issuer and iss differ')
  if (payload.iss !== didOrKidToDid(kid)) throw new Error('Attestation iss does not match kid DID')

  assertRecord(payload.credentialSubject, 'Invalid attestation credentialSubject')
  if (typeof payload.credentialSubject.id !== 'string' || payload.credentialSubject.id.length === 0) {
    throw new Error('Missing credentialSubject id')
  }
  if (typeof payload.credentialSubject.claim !== 'string' || payload.credentialSubject.claim.length === 0) {
    throw new Error('Missing credentialSubject claim')
  }
  if (typeof payload.sub !== 'string' || payload.sub.length === 0) throw new Error('Missing attestation sub')
  if (payload.credentialSubject.id !== payload.sub) throw new Error('Attestation subject mismatch')

  if (typeof payload.validFrom !== 'string' || payload.validFrom.length === 0) {
    throw new Error('Missing attestation validFrom')
  }
  const validFromSeconds = isoDateTimeSeconds(payload.validFrom, 'Invalid attestation validFrom')
  const nbf = integerSeconds(payload.nbf, 'Invalid attestation nbf')
  if (validFromSeconds !== nbf) throw new Error('Attestation validFrom and nbf differ')

  const nowSeconds = Math.floor(now.getTime() / 1000)
  if (!Number.isFinite(nowSeconds)) throw new Error('Invalid attestation verification time')
  if (nbf > nowSeconds) throw new Error('Attestation not yet valid')
  if (payload.exp !== undefined && integerSeconds(payload.exp, 'Invalid attestation exp') <= nowSeconds) {
    throw new Error('Attestation expired')
  }
}

function extractKid(jws: string): string {
  const headerPart = jws.split('.')[0]
  if (!headerPart) throw new Error('Invalid JWS')
  const header = JSON.parse(new TextDecoder().decode(decodeBase64Url(headerPart))) as { kid?: string }
  assertNonEmptyKid(header.kid)
  return header.kid
}

function assertNonEmptyKid(kid: unknown): asserts kid is string {
  if (typeof kid !== 'string' || kid.length === 0) throw new Error('Missing JWS kid')
}

function assertRecord(value: unknown, message: string): asserts value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(message)
}

function assertStringArray(value: unknown, message: string): asserts value is string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) throw new Error(message)
}

function integerSeconds(value: unknown, message: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) throw new Error(message)
  return value
}

function isoDateTimeSeconds(value: string, message: string): number {
  const time = Date.parse(value)
  if (!Number.isFinite(time)) throw new Error(message)
  return Math.floor(time / 1000)
}
