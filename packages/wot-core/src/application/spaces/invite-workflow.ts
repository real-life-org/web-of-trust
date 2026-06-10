import type { ProtocolCryptoAdapter } from '../../protocol/crypto/ports'
import type { KeyManagementPort } from '../../ports/key-management'
import { encodeBase64Url, decodeBase64Url } from '../../protocol/crypto/encoding'
import { createSpaceCapabilityJws, verifySpaceCapabilityJws } from '../../protocol/sync/space-capability'
import { assertSpaceInviteBody, type SpaceInviteBody, type SpaceContentKeyMaterial } from '../../protocol/sync/membership-messages'
import { resolveCapabilityValidityMs } from '../sync/group-key-workflow'

export interface BuildSpaceInviteBodyOptions {
  keyPort: KeyManagementPort
  spaceId: string
  recipientDid: string
  brokerUrls: readonly string[]   // from runtime config (VE-C)
  adminDids: readonly string[]    // SPEC-APPROX [members[0]] (VE-D)
  now?: () => Date
  validityDurationMs?: number
}

/** Sender path: build a spec-conformant space-invite body for one recipient (Sync 005 Z.62-103). */
export async function buildSpaceInviteBody(options: BuildSpaceInviteBodyOptions): Promise<SpaceInviteBody> {
  if (options.brokerUrls.length === 0) {
    // Sync 005 Z.42: brokerUrls MUST be non-empty. Fail clearly here rather than deep
    // inside assertSpaceInviteBody/assertUriArray on the receiver side.
    throw new Error('buildSpaceInviteBody requires non-empty brokerUrls (Sync 005 Z.42)')
  }
  const currentGen = await options.keyPort.getCurrentGeneration(options.spaceId)
  if (currentGen < 0) throw new Error(`No space key for ${options.spaceId}`)
  const signingSeed = await options.keyPort.getCapabilitySigningSeed(options.spaceId, currentGen)
  if (!signingSeed) throw new Error(`No capability signing seed at generation ${currentGen}`)

  // VE-E: include all generations 0..currentGen so the recipient can decrypt the full
  // history (Sync 005 Z.100). A snapshot subset is a later adapter optimization.
  const spaceContentKeys: SpaceContentKeyMaterial[] = []
  for (let gen = 0; gen <= currentGen; gen++) {
    const key = await options.keyPort.getKeyByGeneration(options.spaceId, gen)
    if (key) spaceContentKeys.push({ generation: gen, key: encodeBase64Url(key) })
  }

  const now = (options.now ?? (() => new Date()))()
  const capability = await createSpaceCapabilityJws({
    payload: {
      type: 'capability',
      spaceId: options.spaceId,
      audience: options.recipientDid,
      permissions: ['read', 'write'],
      generation: currentGen,
      issuedAt: now.toISOString(),
      validUntil: new Date(now.getTime() + resolveCapabilityValidityMs(options.validityDurationMs)).toISOString(),
    },
    signingSeed,
  })

  return {
    spaceId: options.spaceId,
    brokerUrls: [...options.brokerUrls],
    currentKeyGeneration: currentGen,
    spaceContentKeys,
    spaceCapabilitySigningKey: encodeBase64Url(signingSeed),
    adminDids: [...options.adminDids],
    capability,
  }
}

export interface ApplySpaceInviteBodyOptions {
  crypto: ProtocolCryptoAdapter
  keyPort: KeyManagementPort
  body: SpaceInviteBody
  recipientDid: string
  senderDid: string  // C1 carry: from envelope.fromDid (Old-World) — see SPEC-DEFERRED note
}

export type ApplySpaceInviteBodyResult =
  | { decision: 'apply' }
  | { decision: 'reject'; reason: 'invalid-capability' }

/** Receiver path: verify + persist an incoming space-invite. */
export async function applySpaceInviteBody(options: ApplySpaceInviteBodyOptions): Promise<ApplySpaceInviteBodyResult> {
  // Sync 005 Z.62: every member MAY invite — Admin authority is NOT required for invites,
  // so senderDid is NOT checked against an admin snapshot (on an initial invite the recipient
  // does not yet know the member list). Authority comes from the included
  // spaceCapabilitySigningKey: a self-verifying capability proves the sender held the key
  // (i.e. was a member).
  // SPEC-DEFERRED (S1, Sync 003 Z.388-396): senderDid is envelope.fromDid (routing metadata),
  // not an Inner-JWS iss; full Inbox conformance follows in the W3 Adapter-Audit slice.
  assertSpaceInviteBody(options.body)

  const signingSeed = decodeBase64Url(options.body.spaceCapabilitySigningKey)
  const verificationKey = await options.crypto.ed25519PublicKeyFromSeed(signingSeed)

  try {
    await verifySpaceCapabilityJws(options.body.capability, {
      crypto: options.crypto,
      publicKey: verificationKey,
      expectedSpaceId: options.body.spaceId,
      expectedAudience: options.recipientDid,
      expectedGeneration: options.body.currentKeyGeneration,
    })
  } catch {
    return { decision: 'reject', reason: 'invalid-capability' }
  }

  // Persist all generations + capability key pair @ currentKeyGeneration + own capability.
  for (const { generation, key } of options.body.spaceContentKeys) {
    await options.keyPort.saveKey(options.body.spaceId, generation, decodeBase64Url(key))
  }
  await options.keyPort.saveCapabilityKeyPair(options.body.spaceId, options.body.currentKeyGeneration, signingSeed, verificationKey)
  await options.keyPort.saveOwnCapability(options.body.spaceId, options.body.currentKeyGeneration, options.body.capability)
  return { decision: 'apply' }
}
