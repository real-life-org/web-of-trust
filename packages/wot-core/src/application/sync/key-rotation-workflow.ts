import type { ProtocolCryptoAdapter } from '../../protocol/crypto/ports'
import type { KeyManagementPort } from '../../ports/key-management'
import { encodeBase64Url, decodeBase64Url } from '../../protocol/crypto/encoding'
import { createSpaceCapabilityJws, verifySpaceCapabilityJws } from '../../protocol/sync/space-capability'
import { assertKeyRotationBody, type KeyRotationBody } from '../../protocol/sync/membership-messages'
import { applyKeyRotation, resolveCapabilityValidityMs } from './group-key-workflow'

export interface BuildKeyRotationBodyOptions {
  keyPort: KeyManagementPort
  spaceId: string
  newGeneration: number
  recipientDid: string
  now?: () => Date
  validityDurationMs?: number
}

/** Sender path: build a spec-conformant key-rotation body for one remaining member (Sync 005 Z.264-285). */
export async function buildKeyRotationBody(options: BuildKeyRotationBodyOptions): Promise<KeyRotationBody> {
  const contentKey = await options.keyPort.getKeyByGeneration(options.spaceId, options.newGeneration)
  if (!contentKey) throw new Error(`No content key at generation ${options.newGeneration}`)
  const signingSeed = await options.keyPort.getCapabilitySigningSeed(options.spaceId, options.newGeneration)
  if (!signingSeed) throw new Error(`No capability signing seed at generation ${options.newGeneration}`)

  const now = (options.now ?? (() => new Date()))()
  const capability = await createSpaceCapabilityJws({
    payload: {
      type: 'capability',
      spaceId: options.spaceId,
      audience: options.recipientDid,
      permissions: ['read', 'write'],
      generation: options.newGeneration,
      issuedAt: now.toISOString(),
      validUntil: new Date(now.getTime() + resolveCapabilityValidityMs(options.validityDurationMs)).toISOString(),
    },
    signingSeed,
  })

  return {
    spaceId: options.spaceId,
    generation: options.newGeneration,
    spaceContentKey: encodeBase64Url(contentKey),
    spaceCapabilitySigningKey: encodeBase64Url(signingSeed),
    capability,
  }
}

export interface ApplyKeyRotationBodyOptions {
  crypto: ProtocolCryptoAdapter
  keyPort: KeyManagementPort
  body: KeyRotationBody
  recipientDid: string         // capability audience check
  senderDid: string            // verifizierter Inner-JWS-from (Sync 003 Z.460-464)
  knownAdminDids: readonly string[]  // C1: SPEC-APPROX [state.info.members[0]] from the adapter
}

export type ApplyKeyRotationBodyResult =
  | { decision: 'apply' | 'future-buffer' | 'ignore-stale-or-duplicate' }
  | { decision: 'reject'; reason: 'unauthorized-sender' | 'invalid-capability' }

/** Receiver path: classify + persist an incoming key-rotation, with Admin authority + capability checks. */
export async function applyKeyRotationBody(options: ApplyKeyRotationBodyOptions): Promise<ApplyKeyRotationBodyResult> {
  // Defense-in-depth schema validation (the adapter also asserts before calling).
  assertKeyRotationBody(options.body)

  // C1 (Sync 005 Z.230 MUSS): rotation requires Admin authority. The sender MUST be in the
  // locally known admin snapshot. The capability self-verifying only proves the sender held
  // the previous spaceCapabilitySigningKey — NOT that they were authorized to rotate (a removed
  // member who learned a past signing key could otherwise craft a "valid" body).
  // SPEC-APPROX: knownAdminDids = [state.info.members[0]] until 1.B.3-admin-management.
  // senderDid ist der per Inner-JWS authentifizierte Absender (Sync 003
  // Z.460-464, `from` === JWS-Signierer) — kein Envelope-Routing. Die Adapter
  // reichen receiveInboxMessage.senderDid durch (#189-SPEC-DEFERRED S1 ist
  // mit diesem Slice aufgelöst).
  if (!options.knownAdminDids.includes(options.senderDid)) {
    return { decision: 'reject', reason: 'unauthorized-sender' }
  }

  const newContentKey = decodeBase64Url(options.body.spaceContentKey)
  const newSigningSeed = decodeBase64Url(options.body.spaceCapabilitySigningKey)
  const newVerificationKey = await options.crypto.ed25519PublicKeyFromSeed(newSigningSeed)

  // Sync 003 Z.234 + Sync 005 Z.279-280: verify the capability against the included signing key,
  // bound to recipient (audience) and body.generation.
  try {
    await verifySpaceCapabilityJws(options.body.capability, {
      crypto: options.crypto,
      publicKey: newVerificationKey,
      expectedSpaceId: options.body.spaceId,
      expectedAudience: options.recipientDid,
      expectedGeneration: options.body.generation,
    })
  } catch {
    return { decision: 'reject', reason: 'invalid-capability' }
  }

  const disposition = await applyKeyRotation({
    keyPort: options.keyPort,
    spaceId: options.body.spaceId,
    incomingGeneration: options.body.generation,
    incomingKey: newContentKey,
  })

  if (disposition === 'apply') {
    await options.keyPort.saveCapabilityKeyPair(options.body.spaceId, options.body.generation, newSigningSeed, newVerificationKey)
    await options.keyPort.saveOwnCapability(options.body.spaceId, options.body.generation, options.body.capability)
  }
  return { decision: disposition }
}
