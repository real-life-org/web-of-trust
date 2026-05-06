import * as ed25519 from '@noble/ed25519'
import { decodeBase64Url, encodeBase64Url } from './encoding'
import type { ProtocolCryptoAdapter } from './ports'
import type { JsonValue } from './jcs'
import { canonicalizeToBytes } from './jcs'

export interface DecodedJws<Header = Record<string, unknown>, Payload = Record<string, unknown>> {
  header: Header
  payload: Payload
  signingInput: Uint8Array
  signature: Uint8Array
}

export type JcsEd25519SignFn = (signingInput: Uint8Array) => Promise<Uint8Array>

export interface VerifyJwsWithPublicKeyOptions {
  publicKey: Uint8Array
  crypto: ProtocolCryptoAdapter
}

export function decodeJws<Header = Record<string, unknown>, Payload = Record<string, unknown>>(jws: string): DecodedJws<Header, Payload> {
  const parts = jws.split('.')
  if (parts.length !== 3) throw new Error('Invalid JWS compact serialization')
  const [encodedHeader, encodedPayload, encodedSignature] = parts
  if (!encodedHeader || !encodedPayload || !encodedSignature) throw new Error('Invalid JWS compact serialization')
  return {
    header: JSON.parse(new TextDecoder().decode(decodeBase64Url(encodedHeader))) as Header,
    payload: JSON.parse(new TextDecoder().decode(decodeBase64Url(encodedPayload))) as Payload,
    signingInput: new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`),
    signature: decodeBase64Url(encodedSignature),
  }
}

export async function createJcsEd25519Jws(
  header: Record<string, JsonValue>,
  payload: JsonValue,
  signingSeed: Uint8Array,
): Promise<string> {
  if (signingSeed.length !== 32) throw new Error('Expected Ed25519 signing seed')

  return createJcsEd25519JwsWithSigner(header, payload, (signingInput) => ed25519.signAsync(signingInput, signingSeed))
}

export async function createJcsEd25519JwsWithSigner(
  header: Record<string, JsonValue>,
  payload: JsonValue,
  sign: JcsEd25519SignFn,
): Promise<string> {
  if (header.alg !== 'EdDSA') throw new Error('Unsupported JWS alg')
  assertJwsKid(header.kid)

  const encodedHeader = encodeBase64Url(canonicalizeToBytes(header))
  const encodedPayload = encodeBase64Url(canonicalizeToBytes(payload))
  const signingInput = new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`)
  const signature = await sign(signingInput)
  return `${encodedHeader}.${encodedPayload}.${encodeBase64Url(signature)}`
}

export async function verifyJwsWithPublicKey(
  jws: string,
  options: VerifyJwsWithPublicKeyOptions,
): Promise<DecodedJws> {
  const decoded = decodeJws(jws)
  if (decoded.header.alg !== 'EdDSA') throw new Error('Unsupported JWS alg')
  assertJwsKid(decoded.header.kid)
  const valid = await options.crypto.verifyEd25519(decoded.signingInput, decoded.signature, options.publicKey)
  if (!valid) throw new Error('Invalid JWS signature')
  return decoded
}

function assertJwsKid(kid: unknown): asserts kid is string {
  if (typeof kid !== 'string' || kid.length === 0) throw new Error('Missing JWS kid')
}
