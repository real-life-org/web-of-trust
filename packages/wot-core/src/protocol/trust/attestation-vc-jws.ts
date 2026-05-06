import type { ProtocolCryptoAdapter } from '../crypto/ports'
import { didKeyToPublicKeyBytes, didOrKidToDid } from '../identity/did-key'
import type { JcsEd25519SignFn } from '../crypto/jws'
import { createJcsEd25519Jws, createJcsEd25519JwsWithSigner, decodeJws } from '../crypto/jws'
import type { JsonValue } from '../crypto/jcs'

const VC_CONTEXT = 'https://www.w3.org/ns/credentials/v2'
const WOT_CONTEXT = 'https://web-of-trust.de/vocab/v1'
const VERIFIABLE_CREDENTIAL_TYPE = 'VerifiableCredential'
const WOT_ATTESTATION_TYPE = 'WotAttestation'
const RFC3339_DATE_TIME_WITH_ZONE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|([+-])(\d{2}):(\d{2}))$/

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
  return createJcsEd25519Jws(
    { alg: 'EdDSA', kid: options.kid, typ: 'vc+jwt' },
    options.payload as unknown as JsonValue,
    options.signingSeed,
  )
}

export async function createAttestationVcJwsWithSigner(
  options: CreateAttestationVcJwsWithSignerOptions,
): Promise<string> {
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
  const decoded = decodeJws(jws)
  assertRecord(decoded.header, 'Invalid JWS header')
  if (decoded.header.alg !== 'EdDSA') throw new Error('Unsupported JWS alg')
  assertNonEmptyKid(decoded.header.kid)
  const kid = decoded.header.kid
  const valid = await options.crypto.verifyEd25519(
    decoded.signingInput,
    decoded.signature,
    didKeyToPublicKeyBytes(kid),
  )
  if (!valid) throw new Error('Invalid JWS signature')
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

  // Trust 001 "Pflichtfelder" requires both the W3C VC 2.0 context and the WoT vocab context.
  assertStringArray(payload['@context'], 'Invalid attestation @context')
  if (!payload['@context'].includes(VC_CONTEXT)) throw new Error('Missing VC context')
  if (!payload['@context'].includes(WOT_CONTEXT)) throw new Error('Missing WoT context')

  // Trust 001 "Pflichtfelder" requires VerifiableCredential plus WotAttestation type membership.
  assertStringArray(payload.type, 'Invalid attestation type')
  if (!payload.type.includes(VERIFIABLE_CREDENTIAL_TYPE)) throw new Error('Missing VerifiableCredential type')
  if (!payload.type.includes(WOT_ATTESTATION_TYPE)) throw new Error('Missing WotAttestation type')

  // Trust 001 "Verifikation" requires issuer/iss consistency and binds iss to the protected-header kid DID.
  if (typeof payload.issuer !== 'string' || payload.issuer.length === 0) {
    throw new Error('Missing attestation issuer')
  }
  if (typeof payload.iss !== 'string' || payload.iss.length === 0) throw new Error('Missing attestation iss')
  if (payload.issuer !== payload.iss) throw new Error('Attestation issuer and iss differ')
  if (payload.iss !== didOrKidToDid(kid)) throw new Error('Attestation iss does not match kid DID')

  // Trust 001 "Pflichtfelder" and JWT mapping require credentialSubject.id/sub consistency plus a claim.
  assertRecord(payload.credentialSubject, 'Invalid attestation credentialSubject')
  if (typeof payload.credentialSubject.id !== 'string' || payload.credentialSubject.id.length === 0) {
    throw new Error('Missing credentialSubject id')
  }
  if (typeof payload.credentialSubject.claim !== 'string' || payload.credentialSubject.claim.length === 0) {
    throw new Error('Missing credentialSubject claim')
  }
  if (typeof payload.sub !== 'string' || payload.sub.length === 0) throw new Error('Missing attestation sub')
  if (payload.credentialSubject.id !== payload.sub) throw new Error('Attestation subject mismatch')

  // Trust 001 maps validFrom to integer-second nbf; validFrom must include an explicit zone.
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
  // Manual parsing keeps naive datetimes out and rejects calendar dates that Date.parse normalizes.
  const match = RFC3339_DATE_TIME_WITH_ZONE.exec(value)
  if (!match) throw new Error(message)
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, zone, sign, offsetHourText, offsetMinuteText] = match
  const year = Number(yearText)
  const month = Number(monthText)
  const day = Number(dayText)
  const hour = Number(hourText)
  const minute = Number(minuteText)
  const second = Number(secondText)
  const offsetHour = offsetHourText === undefined ? 0 : Number(offsetHourText)
  const offsetMinute = offsetMinuteText === undefined ? 0 : Number(offsetMinuteText)

  if (hour > 23 || minute > 59 || second > 59 || offsetHour > 23 || offsetMinute > 59) {
    throw new Error(message)
  }

  const localTime = Date.UTC(year, month - 1, day, hour, minute, second)
  const localDate = new Date(localTime)
  if (
    localDate.getUTCFullYear() !== year ||
    localDate.getUTCMonth() !== month - 1 ||
    localDate.getUTCDate() !== day ||
    localDate.getUTCHours() !== hour ||
    localDate.getUTCMinutes() !== minute ||
    localDate.getUTCSeconds() !== second
  ) {
    throw new Error(message)
  }

  const offsetMinutes = zone === 'Z' ? 0 : (sign === '+' ? 1 : -1) * (offsetHour * 60 + offsetMinute)
  const time = localTime - offsetMinutes * 60_000
  if (!Number.isFinite(time)) throw new Error(message)
  // JWT NumericDate is integer seconds, so fractional validFrom seconds intentionally map to their second.
  return time / 1000
}
