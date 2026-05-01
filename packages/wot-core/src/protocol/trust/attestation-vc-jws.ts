import type { ProtocolCryptoAdapter } from '../crypto/ports'
import { didKeyToPublicKeyBytes, didOrKidToDid } from '../identity/did-key'
import type { JcsEd25519SignFn } from '../crypto/jws'
import { createJcsEd25519Jws, createJcsEd25519JwsWithSigner, verifyJwsWithPublicKey } from '../crypto/jws'
import type { JsonValue } from '../crypto/jcs'
import { decodeBase64Url } from '../crypto/encoding'

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
  const header = await verifyJwsWithPublicKey(jws, {
    publicKey: didKeyToPublicKeyBytes(extractKid(jws)),
    crypto: options.crypto,
  })
  const payload = header.payload as AttestationVcPayload
  const jwsHeader = header.header as { typ?: string; kid?: string }
  if (jwsHeader.typ !== 'vc+jwt') throw new Error('Invalid attestation JWS typ')
  if (payload.issuer !== payload.iss) throw new Error('Attestation issuer and iss differ')
  if (payload.iss !== didOrKidToDid(jwsHeader.kid ?? '')) throw new Error('Attestation iss does not match kid DID')
  if (!payload.type.includes('WotAttestation')) throw new Error('Missing WotAttestation type')
  if (payload.credentialSubject.id !== payload.sub) throw new Error('Attestation subject mismatch')
  return payload
}

function extractKid(jws: string): string {
  const headerPart = jws.split('.')[0]
  if (!headerPart) throw new Error('Invalid JWS')
  const header = JSON.parse(new TextDecoder().decode(decodeBase64Url(headerPart))) as { kid?: string }
  if (!header.kid) throw new Error('Missing JWS kid')
  return header.kid
}
