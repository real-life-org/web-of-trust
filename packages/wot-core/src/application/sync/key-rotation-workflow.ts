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
  knownAdminDids: readonly string[]  // C1: SPEC-APPROX [createdBy] vom Adapter (Alt-Space-Fallback members[0], VE-2)
}

/**
 * I-CAP (duplicate-path capability import) outcome:
 *  - 'imported'        : the capability signing material was persisted (was missing, content-bound).
 *  - 'already-present' : identical write material already stored → strict no-op (no store write).
 *  - 'conflict'        : divergent content key OR divergent existing capability material →
 *                        strict no-op + log, NEVER overwrite (poison-resistant).
 *  - 'not-applicable'  : not the current write-relevant generation (stale duplicate) / no content
 *                        key to bind to → import does not apply.
 */
export type CapabilityImportOutcome = 'imported' | 'already-present' | 'conflict' | 'not-applicable'

export type ApplyKeyRotationBodyResult =
  | { decision: 'apply' | 'future-buffer' }
  | { decision: 'ignore-stale-or-duplicate'; capabilityImport: CapabilityImportOutcome }
  | { decision: 'reject'; reason: 'unauthorized-sender' | 'invalid-capability' }

/** Receiver path: classify + persist an incoming key-rotation, with Admin authority + capability checks. */
export async function applyKeyRotationBody(options: ApplyKeyRotationBodyOptions): Promise<ApplyKeyRotationBodyResult> {
  // Defense-in-depth schema validation (the adapter also asserts before calling).
  assertKeyRotationBody(options.body)

  // C1 (Sync 005 Z.230 MUSS): rotation requires Admin authority. The sender MUST be in the
  // locally known admin snapshot. The capability self-verifying only proves the sender held
  // the previous spaceCapabilitySigningKey — NOT that they were authorized to rotate (a removed
  // member who learned a past signing key could otherwise craft a "valid" body).
  // SPEC-APPROX: knownAdminDids = [createdBy] (Alt-Space-Fallback members[0],
  // VE-2) bis 1.B.3-admin-management.
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
    return { decision: 'apply' }
  }

  if (disposition === 'ignore-stale-or-duplicate') {
    // I-CAP: the content key can legitimately overtake the key-rotation message on a 2nd device
    // (fast PersonalDoc/Vault sync of the content key vs. the slower inbox), so this rotation
    // classifies as a duplicate — but the capability SIGNING SEED travels ONLY in this message
    // (the content channel carries no capability material). Without importing it here the device
    // can READ the new generation but not WRITE ("No capability signing seed"). Import it —
    // content-bound + never-overwrite — even though we don't re-apply the content key.
    const capabilityImport = await importDuplicateCapabilityMaterial(options, newSigningSeed, newVerificationKey, newContentKey)
    return { decision: 'ignore-stale-or-duplicate', capabilityImport }
  }

  return { decision: disposition } // future-buffer: imports nothing; the later replay re-classifies.
}

/**
 * I-CAP gate (runs ONLY after the full apply-grade Authority + capability verification): import
 * the capability signing material for a `ignore-stale-or-duplicate` rotation iff ALL hold —
 *  1. `body.generation === currentGeneration` — only the current gen is write-relevant (the write
 *     path mints only current; the relay rejects stale caps). A stale gen < current → 'not-applicable'.
 *  2. Content-binding — the LOCALLY stored content key for this gen exists and is byte-identical to
 *     `body.spaceContentKey`. The import hangs off the already-trusted content key, not just the gen
 *     number; a divergent content key → 'conflict' (a forged rotation must not poison write material).
 *  3. Never overwrite — if capability signing material already exists for this gen it MUST be
 *     byte-identical (→ 'already-present', no store write); divergent → 'conflict' + log. Both key
 *     stores overwrite blindly, so the guard lives HERE (read + compare before write).
 */
async function importDuplicateCapabilityMaterial(
  options: ApplyKeyRotationBodyOptions,
  newSigningSeed: Uint8Array,
  newVerificationKey: Uint8Array,
  newContentKey: Uint8Array,
): Promise<CapabilityImportOutcome> {
  const spaceId = options.body.spaceId
  const generation = options.body.generation

  const currentGeneration = await options.keyPort.getCurrentGeneration(spaceId)
  if (generation !== currentGeneration) return 'not-applicable'

  const storedContentKey = await options.keyPort.getKeyByGeneration(spaceId, generation)
  if (!storedContentKey) return 'not-applicable'
  if (!bytesEqual(storedContentKey, newContentKey)) return 'conflict'

  const existingSeed = await options.keyPort.getCapabilitySigningSeed(spaceId, generation)
  if (existingSeed !== null) {
    // Identical signing seed = the write ability is already present → no-op (the self-capability
    // JWS may differ only in issuedAt/validUntil, which is benign — do NOT re-write it).
    if (bytesEqual(existingSeed, newSigningSeed)) return 'already-present'
    console.warn(
      `[applyKeyRotationBody] I-CAP conflict for space ${spaceId.slice(0, 8)} gen ${generation}: an ` +
        'incoming duplicate carries DIVERGENT capability signing material — refusing to overwrite (strict no-op).',
    )
    return 'conflict'
  }

  // Trust boundary: the imported seed's AUTHENTICITY rests solely on the admin-authority gate
  // above (same as the apply branch). A malicious admin could supply a self-consistent body with
  // an attacker-chosen seed — but that only self-DoSes the victim (its writes verify against a
  // divergent VK and the relay/peers reject them), no forgery/escalation, and never-overwrite
  // protects an already-present legit seed. Inherent to the admin model, not introduced here.
  await options.keyPort.saveCapabilityKeyPair(spaceId, generation, newSigningSeed, newVerificationKey)
  await options.keyPort.saveOwnCapability(spaceId, generation, options.body.capability)
  return 'imported'
}

/** Constant-length-independent byte equality (content/capability keys are public/symmetric — no timing secret). */
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i]
  return diff === 0
}
