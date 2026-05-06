import { decodeBase64Url, encodeBase64Url } from '../crypto/encoding'
import type { JsonValue } from '../crypto/jcs'
import { canonicalizeToBytes } from '../crypto/jcs'
import type { ProtocolCryptoAdapter } from '../crypto/ports'
import { decodeJws, verifyJwsWithPublicKey } from '../crypto/jws'
import { didKeyToPublicKeyBytes, didOrKidToDid } from '../identity/did-key'

export interface VerifiedSdJwtVc {
  issuerPayload: Record<string, unknown>
  disclosures: JsonValue[]
  disclosureDigests: string[]
}

export interface VerifySdJwtVcOptions {
  crypto: ProtocolCryptoAdapter
}

export interface VerifyHmcTrustListSdJwtVcOptions extends VerifySdJwtVcOptions {
  expectedVct: string
  now: Date
}

export function encodeSdJwtDisclosure(disclosure: JsonValue): string {
  return encodeBase64Url(canonicalizeToBytes(disclosure))
}

export async function digestSdJwtDisclosure(
  encodedDisclosure: string,
  cryptoAdapter: ProtocolCryptoAdapter,
): Promise<string> {
  return encodeBase64Url(await cryptoAdapter.sha256(new TextEncoder().encode(encodedDisclosure)))
}

export function createSdJwtVcCompact(issuerSignedJwt: string, disclosures: JsonValue[]): string {
  return `${issuerSignedJwt}~${disclosures.map(encodeSdJwtDisclosure).join('~')}~`
}

export async function verifySdJwtVc(
  sdJwtCompact: string,
  options: VerifySdJwtVcOptions,
): Promise<VerifiedSdJwtVc> {
  const parts = sdJwtCompact.split('~')
  if (parts.length < 2 || parts[parts.length - 1] !== '') throw new Error('Invalid SD-JWT compact serialization')
  const issuerSignedJwt = parts[0]
  const encodedDisclosures = parts.slice(1, -1)
  const decodedJws = decodeJws<{ kid?: string }, Record<string, unknown>>(issuerSignedJwt)
  if (!decodedJws.header.kid) throw new Error('Missing SD-JWT issuer kid')

  const verifiedJws = await verifyJwsWithPublicKey(issuerSignedJwt, {
    publicKey: didKeyToPublicKeyBytes(decodedJws.header.kid),
    crypto: options.crypto,
  })

  const disclosureDigests = await Promise.all(
    encodedDisclosures.map((encodedDisclosure) => digestSdJwtDisclosure(encodedDisclosure, options.crypto)),
  )
  assertDisclosureDigestsPresent(verifiedJws.payload as Record<string, unknown>, disclosureDigests)

  return {
    issuerPayload: verifiedJws.payload as Record<string, unknown>,
    disclosures: encodedDisclosures.map(decodeDisclosure),
    disclosureDigests,
  }
}

export async function verifyHmcTrustListSdJwtVc(
  sdJwtCompact: string,
  options: VerifyHmcTrustListSdJwtVcOptions,
): Promise<VerifiedSdJwtVc> {
  const issuerKid = readIssuerKid(sdJwtCompact)
  const verified = await verifySdJwtVc(sdJwtCompact, options)
  const { issuerPayload } = verified

  if (issuerPayload.iss !== didOrKidToDid(issuerKid)) throw new Error('Invalid HMC Trust List issuer')
  if (issuerPayload._sd_alg !== 'sha-256') throw new Error('Invalid HMC Trust List _sd_alg')
  if (issuerPayload.vct !== options.expectedVct) throw new Error('Invalid HMC Trust List vct')

  const verificationTimeSeconds = readVerificationTimeSeconds(options.now)
  const exp = readNumericDate(issuerPayload.exp, 'exp')
  if (exp <= verificationTimeSeconds) throw new Error('Expired HMC Trust List exp')

  const iat = readNumericDate(issuerPayload.iat, 'iat')
  if (iat > verificationTimeSeconds) throw new Error('Future HMC Trust List iat')

  return verified
}

function decodeDisclosure(encodedDisclosure: string): JsonValue {
  return JSON.parse(new TextDecoder().decode(decodeBase64Url(encodedDisclosure))) as JsonValue
}

function readIssuerKid(sdJwtCompact: string): string {
  const issuerSignedJwt = sdJwtCompact.split('~', 1)[0]
  const decodedJws = decodeJws<{ kid?: string }, Record<string, unknown>>(issuerSignedJwt)
  if (!decodedJws.header.kid) throw new Error('Missing SD-JWT issuer kid')
  return decodedJws.header.kid
}

function assertDisclosureDigestsPresent(payload: Record<string, unknown>, disclosureDigests: string[]): void {
  const serializedPayload = JSON.stringify(payload)
  for (const disclosureDigest of disclosureDigests) {
    if (!serializedPayload.includes(`"${disclosureDigest}"`)) throw new Error('SD-JWT disclosure digest not present')
  }
}

function readNumericDate(value: unknown, claimName: 'exp' | 'iat'): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Missing HMC Trust List ${claimName}`)
  }
  return value
}

function readVerificationTimeSeconds(now: Date): number {
  const seconds = now.getTime() / 1000
  if (!Number.isFinite(seconds)) throw new Error('Invalid HMC Trust List verification time')
  return seconds
}
