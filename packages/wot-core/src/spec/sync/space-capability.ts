import type { SpecCryptoAdapter } from '../crypto/ports'
import type { JsonValue } from '../crypto/jcs'
import { createJcsEd25519Jws, decodeJws, verifyJwsWithPublicKey } from '../crypto/jws'

export type SpaceCapabilityPermission = 'read' | 'write'

export interface SpaceCapabilityPayload {
  type: 'capability'
  spaceId: string
  audience: string
  permissions: SpaceCapabilityPermission[]
  generation: number
  issuedAt: string
  validUntil: string
}

export interface CreateSpaceCapabilityJwsOptions {
  payload: SpaceCapabilityPayload
  signingSeed: Uint8Array
}

export interface VerifySpaceCapabilityJwsOptions {
  crypto: SpecCryptoAdapter
  publicKey: Uint8Array
  expectedSpaceId?: string
  expectedAudience?: string
  expectedGeneration?: number
  now?: Date
}

export async function createSpaceCapabilityJws(options: CreateSpaceCapabilityJwsOptions): Promise<string> {
  return createJcsEd25519Jws(
    { alg: 'EdDSA', kid: capabilityKid(options.payload), typ: 'wot-capability+jwt' },
    options.payload as unknown as JsonValue,
    options.signingSeed,
  )
}

export async function verifySpaceCapabilityJws(
  jws: string,
  options: VerifySpaceCapabilityJwsOptions,
): Promise<SpaceCapabilityPayload> {
  const { header, payload } = decodeJws<{ alg?: string; kid?: string; typ?: string }, SpaceCapabilityPayload>(jws)
  if (header.alg !== 'EdDSA') throw new Error('Invalid capability alg')
  if (header.typ !== 'wot-capability+jwt') throw new Error('Invalid capability typ')
  if (header.kid !== capabilityKid(payload)) throw new Error('Capability kid mismatch')

  await verifyJwsWithPublicKey(jws, {
    publicKey: options.publicKey,
    crypto: options.crypto,
  })
  assertSpaceCapabilityPayload(payload, options)
  return payload
}

function capabilityKid(payload: SpaceCapabilityPayload): string {
  return `wot:space:${payload.spaceId}#cap-${payload.generation}`
}

function assertSpaceCapabilityPayload(payload: SpaceCapabilityPayload, options: VerifySpaceCapabilityJwsOptions): void {
  if (payload.type !== 'capability') throw new Error('Invalid capability type')
  if (!payload.spaceId) throw new Error('Missing capability spaceId')
  if (!payload.audience) throw new Error('Missing capability audience')
  if (!Array.isArray(payload.permissions) || payload.permissions.length === 0) {
    throw new Error('Missing capability permissions')
  }
  if (!Number.isInteger(payload.generation) || payload.generation < 0) throw new Error('Invalid capability generation')
  if (Number.isNaN(Date.parse(payload.issuedAt))) throw new Error('Invalid capability issuedAt')
  if (Number.isNaN(Date.parse(payload.validUntil))) throw new Error('Invalid capability validUntil')
  if (options.expectedSpaceId !== undefined && payload.spaceId !== options.expectedSpaceId) {
    throw new Error('Capability spaceId mismatch')
  }
  if (options.expectedAudience !== undefined && payload.audience !== options.expectedAudience) {
    throw new Error('Capability audience mismatch')
  }
  if (options.expectedGeneration !== undefined && payload.generation !== options.expectedGeneration) {
    throw new Error('Capability generation mismatch')
  }
  if (options.now && options.now.getTime() >= Date.parse(payload.validUntil)) throw new Error('Capability expired')
}
