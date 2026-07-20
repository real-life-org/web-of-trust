import type { ProtocolCryptoAdapter } from '../../protocol/crypto/ports'
import type { KeyManagementPort } from '../../ports/key-management'
import type { DocLogStore, PendingRemoval, StagedRemovalKeyMaterial } from '../../ports/DocLogStore'
import type { ControlFrame } from '../../protocol/sync/control-frame-transport'
import { ControlFrameRejectedError } from '../../protocol/sync/control-frame-transport'
import { classifyRejectDisposition } from '../../protocol/sync/log-sync-coordinator'
import { commitStagedRotation, stageRotateSpaceKey, type StagedRotationMaterial } from './group-key-workflow'

/**
 * Slice SR / VE-C1 + VE-C3 — engine-neutral two-phase secure member-removal
 * orchestration (wot-spec #110, 005-gruppen.md Removal-Enforcement-Semantik).
 *
 * The Yjs and Automerge replication adapters share this module unchanged; the
 * genuinely engine-specific work (writing the membership CRDT event, distributing
 * the key-rotation / member-update inbox messages, pushing the re-encrypted
 * snapshot) is injected as the {@link SecureRemovalDeps.commitRemoval} callback and
 * runs ONLY after enforcement is complete.
 *
 * ── The two-phase invariant (MUSS) ──────────────────────────────────────────
 *  1. STAGE: durably record the removal intent + freshly generated next-generation
 *     key material in the {@link DocLogStore} pending-removal staging area. NOTHING
 *     is committed: no CRDT membership op, no Sync-002 log entry, no key activation,
 *     no key-rotation / member-update distribution. `getCurrentGeneration` is
 *     UNCHANGED after a stage.
 *  2. ENFORCE: send a `space-rotate` to EVERY authoritative home broker (the set is
 *     FIXED at removal start) and await each confirmation. While any broker is
 *     unconfirmed the removal stays pending in the retryable staging record and the
 *     flow STOPS — no commit, no distribution.
 *  3. COMMIT: only once every home broker has confirmed, activate the staged
 *     generation (`commitStagedRotation`) and run the engine-specific
 *     {@link SecureRemovalDeps.commitRemoval}, then delete the staging record.
 *
 * `removeMember` resolves IFF the removal was enforced + committed. If staging
 * succeeded but enforcement did not complete (a broker is offline / a transient
 * space-rotate reject), the caller throws {@link RemovalPendingNotEnforcedError} —
 * the staging is durable, so VE-C3 crash-recovery retries it later. Only an
 * idempotent success for the exact staged material authorizes committing it.
 */

/**
 * Signals that a member removal was durably STAGED but is NOT yet enforced: not
 * every home broker has confirmed the `space-rotate`, so the removal was neither
 * committed nor distributed. This is NOT a data-loss error — the staging record
 * persists and VE-C3 crash-recovery (or a later retry) will complete it. The
 * caller MUST NOT treat the removal as effective until it resolves without this
 * error.
 */
export class RemovalPendingNotEnforcedError extends Error {
  readonly spaceId: string
  readonly removedDid: string
  /** The generation the removal rotates to once enforced. */
  readonly targetGeneration: number
  /** Always true — a stable discriminator for callers matching the pending case. */
  readonly pending: true
  constructor(spaceId: string, removedDid: string, targetGeneration: number) {
    super(
      `Removal of ${removedDid} from space ${spaceId} is staged but NOT yet enforced ` +
        `(target generation ${targetGeneration}); not all home brokers confirmed the space-rotate. ` +
        'The staging is durable and will be retried (VE-C3 crash-recovery).',
    )
    this.name = 'RemovalPendingNotEnforcedError'
    this.spaceId = spaceId
    this.removedDid = removedDid
    this.targetGeneration = targetGeneration
    this.pending = true
  }
}

/** The local key state is ahead of the broker state reported in GENERATION_GAP. */
export class GenerationGapSplitBrainError extends Error {
  readonly spaceId: string
  readonly localGeneration: number
  readonly brokerGeneration: number
  constructor(spaceId: string, localGeneration: number, brokerGeneration: number) {
    super(`GENERATION_GAP split-brain for ${spaceId}: local generation ${localGeneration} is ahead of broker generation ${brokerGeneration}`)
    this.name = 'GenerationGapSplitBrainError'
    this.spaceId = spaceId
    this.localGeneration = localGeneration
    this.brokerGeneration = brokerGeneration
  }
}

/**
 * Dependencies the adapter injects for one space's two-phase removal. Everything
 * here is engine-neutral EXCEPT {@link commitRemoval}, which the adapter implements
 * over its concrete CRDT.
 */
export interface SecureRemovalDeps {
  crypto: ProtocolCryptoAdapter
  keyPort: KeyManagementPort
  docLogStore: DocLogStore
  spaceId: string
  /** Audience of the owner's self-capability minted at commit (the local admin DID). */
  ownerDid: string
  /** Capability validity window for the committed generation (Sync 003 Z.249). */
  validityDurationMs?: number
  now?: () => Date
  /**
   * The authoritative home brokers, captured at removal start and FIXED for the
   * lifetime of the removal. A single-element set is the festival/single-home-broker
   * path; size > 1 is hard-gated (see {@link runTwoPhaseRemoval}).
   */
  homeBrokerSet: readonly string[]
  /**
   * Build the admin-signed `space-rotate` control frame for the new generation.
   * The payload MUST be exactly `{ type:'space-rotate', spaceId,
   * newSpaceCapabilityVerificationKey, newGeneration }` (Sync 003), signed by the
   * local admin (kid = adminDid).
   */
  createRotateFrame: (
    newGeneration: number,
    newCapVerificationKey: Uint8Array,
  ) => Promise<ControlFrame>
  /**
   * Send a `space-rotate` to one home broker and await its receipt. MUST throw a
   * {@link ControlFrameRejectedError} on a broker reject (so the workflow can tell a
   * hard reject from a transient one) and any other Error on a transport failure.
   * For the single-home-broker path the adapter routes this through the space
   * coordinator's serialized control tail (receipt.messageId == docId).
   */
  sendSpaceRotate: (brokerUrl: string, frame: ControlFrame) => Promise<void>
  /** Trigger and await Sync-002 catch-up after a GENERATION_GAP. */
  catchUpGeneration?: () => Promise<boolean | { complete: boolean }>
  /** Build/send the self-signed admin-remove after commit + distribution. */
  createSelfAdminRemoveFrame?: () => Promise<ControlFrame>
  sendAdminRemove?: (brokerUrl: string, frame: ControlFrame) => Promise<void>
  /** Runs only after every home broker acknowledged the self admin-remove. */
  finalizeSelfLeave?: (newGeneration: number) => Promise<void>
  /**
   * Engine-specific COMMIT side effects, run ONLY after the staged generation has
   * been activated and enforcement is complete: write the `removed@newGeneration`
   * membership CRDT event (+ Sync-002 log entry), distribute the key-rotation to
   * the remaining members and the member-update to remaining + removed members,
   * and push the re-encrypted snapshot. Receives the committed `newGeneration`.
   */
  commitRemoval: (removedDid: string, newGeneration: number, activityEntry?: Record<string, unknown>) => Promise<void>
}

/**
 * VE-C1 — run (or resume) the two-phase removal of `removedDid` from the space.
 *
 * Idempotent on re-invocation: if a staging record already exists for
 * (spaceId, removedDid) it is REUSED (no new key material, no new generation) and
 * the flow merely drives the outstanding confirmations + commit forward — never a
 * double rotate.
 *
 * @throws RemovalPendingNotEnforcedError if staging succeeded but not every home
 *   broker confirmed (durable — retried by VE-C3).
 * @throws Error (hard) on a `multi-broker` guard violation or a non-retryable
 *   `space-rotate` reject.
 */
export async function runTwoPhaseRemoval(
  deps: SecureRemovalDeps,
  removedDid: string,
  opts?: { activityEntry?: Record<string, unknown>, kind?: 'canonical-self-removal-rotation', targetGeneration?: number },
): Promise<void> {
  // ── MULTI-BROKER GUARD (MUSS): no silent half-enforcement ──────────────────
  // A real multi-broker space-rotate transport (broadcast to several authoritative
  // brokers + per-broker confirmation transport) is a dedicated follow-up slice.
  // Until then we hard-refuse rather than enforce against only one of several
  // brokers (which would leave the removed member able to write via the others).
  if (deps.homeBrokerSet.length > 1) {
    throw new Error('multi-broker removal not yet supported')
  }
  if (deps.homeBrokerSet.length === 0) {
    throw new Error('removeMember requires a non-empty homeBrokerSet')
  }

  const { spaceId } = deps

  // ── IDEMPOTENCY: reuse an existing staging record (no second rotate) ────────
  const existing = await deps.docLogStore.getPendingRemoval(spaceId, removedDid)
  const removal = existing ?? (await stageRemoval(deps, removedDid, opts?.activityEntry, opts?.kind, opts?.targetGeneration))

  await driveRemovalToCompletion(deps, removal)
}

/**
 * VE-C3 — crash-recovery entrypoint: resume every open pending removal in the
 * durable store (e.g. at app start / on reconnect). For each, retry the missing
 * `space-rotate` confirmations and commit once complete. A removal whose
 * enforcement is still incomplete (broker offline) is left durably staged for the
 * next attempt — recovery NEVER throws on a still-pending removal.
 *
 * The per-removal `commitRemoval` / `createRotateFrame` / `sendSpaceRotate` /
 * `homeBrokerSet` are resolved by the adapter for that removal's spaceId via
 * {@link resolveDeps}; a removal whose space the adapter can no longer resolve is
 * skipped (not deleted — the space may re-appear).
 *
 * @returns the number of removals that reached COMMIT during this recovery pass.
 */
export async function recoverPendingRemovals(
  docLogStore: DocLogStore,
  resolveDeps: (removal: PendingRemoval) => Promise<SecureRemovalDeps | null>,
): Promise<number> {
  const open = await docLogStore.listPendingRemovals()
  let committed = 0
  for (const removal of open) {
    let deps: SecureRemovalDeps | null
    try {
      deps = await resolveDeps(removal)
    } catch {
      deps = null
    }
    if (!deps) continue
    try {
      // A canonical self-removal can converge on another admin's rotation without
      // committing this device's staged material. Count only an actual local COMMIT.
      if (await driveRemovalToCompletion(deps, removal)) committed += 1
    } catch (err) {
      // RemovalPendingNotEnforcedError = still waiting on a broker → keep staged,
      // try again next recovery pass. A hard error (admin bug) is logged but does
      // not abort recovery of the OTHER removals.
      if (!(err instanceof RemovalPendingNotEnforcedError)) {
        console.error(
          `[secure-removal] recovery of ${removal.removedDid} in space ${removal.spaceId} failed hard:`,
          err,
        )
      }
    }
  }
  return committed
}

// ───────────────────────────────────────────────────────────────────────────
// Internals
// ───────────────────────────────────────────────────────────────────────────

/** STAGE: generate next-gen material (NOT persisted to the key store) + durably stage the intent. */
async function stageRemoval(
  deps: SecureRemovalDeps,
  removedDid: string,
  activityEntry?: Record<string, unknown>,
  kind?: 'canonical-self-removal-rotation',
  targetGeneration?: number,
): Promise<PendingRemoval> {
  const staged: StagedRotationMaterial = await stageRotateSpaceKey({
    crypto: deps.crypto,
    keyPort: deps.keyPort,
    spaceId: deps.spaceId,
    ownerDid: deps.ownerDid,
    validityDurationMs: deps.validityDurationMs,
    now: deps.now,
  })
  const stagedKeyMaterial: StagedRemovalKeyMaterial = {
    contentKey: staged.contentKey,
    capSigningSeed: staged.capabilitySigningSeed,
    capVerificationKey: staged.capabilityVerificationKey,
  }
  if (targetGeneration !== undefined && staged.newGeneration < targetGeneration) {
    throw new Error(`cannot enforce canonical self-removal at generation ${targetGeneration} while local generation is behind (${staged.newGeneration - 1})`)
  }
  const removal: PendingRemoval = {
    phase: 'staged',
    spaceId: deps.spaceId,
    removedDid,
    homeBrokerSet: [...deps.homeBrokerSet],
    confirmedBrokerUrls: [],
    newGeneration: staged.newGeneration,
    stagedKeyMaterial,
    createdAt: (deps.now ?? (() => new Date()))().getTime(),
    activityEntry,
    kind,
  }
  // Durable BEFORE any space-rotate send: a crash after this point recovers the
  // intent + key material and retries (VE-C3); a crash before it leaves no trace
  // (and no generation was advanced, so a re-run re-stages cleanly).
  await deps.docLogStore.putPendingRemoval(removal)
  return removal
}

/**
 * ENFORCE + COMMIT for a single staged removal: drive the outstanding
 * `space-rotate` confirmations, then (once every home broker is confirmed) activate
 * the staged generation and run the engine-specific commit + delete the record.
 */
async function driveRemovalToCompletion(
  deps: SecureRemovalDeps,
  removal: PendingRemoval,
): Promise<boolean> {
  // Cleanup recovery intentionally has no loaded CRDT-space dependency.  Once
  // admin-remove is durable, only the stable PersonalDoc event and idempotent
  // local artifact cleanup remain.
  if (removal.phase === 'admin-removed') {
    await deps.finalizeSelfLeave?.(removal.newGeneration)
    removal = { ...removal, phase: 'local-cleanup' }
    await deps.docLogStore.putPendingRemoval(removal)
  }
  if (removal.phase === 'local-cleanup') {
    removal = { ...removal, phase: 'complete' }
    await deps.docLogStore.putPendingRemoval(removal)
    await deps.docLogStore.deletePendingRemoval(deps.spaceId, removal.removedDid)
    return true
  }
  // The home-broker set is FIXED in the durable record (captured at stage time).
  // Use it, not deps.homeBrokerSet, so a config change mid-flight cannot move the
  // enforcement goalposts for an in-progress removal.
  const homeBrokerSet = removal.homeBrokerSet

  // Every branch below is driven exclusively by `removal.phase` and durable
  // fields. Effects precede the single successor write; replaying an old phase
  // is therefore required to be idempotent.
  const frame = await deps.createRotateFrame(
    removal.newGeneration,
    removal.stagedKeyMaterial.capVerificationKey,
  )

  let confirmed = new Set(removal.confirmedBrokerUrls)
  for (const brokerUrl of homeBrokerSet) {
    if (confirmed.has(brokerUrl)) continue
    try {
      await deps.sendSpaceRotate(brokerUrl, frame)
      await deps.docLogStore.markBrokerConfirmed(deps.spaceId, removal.removedDid, brokerUrl)
      confirmed.add(brokerUrl)
    } catch (err) {
      if (err instanceof ControlFrameRejectedError && err.code === 'GENERATION_GAP') {
        const restaged = await handleGenerationGap(deps, removal, err.currentGeneration)
        if (restaged) return driveRemovalToCompletion(deps, restaged)
        throw new RemovalPendingNotEnforcedError(deps.spaceId, removal.removedDid, removal.newGeneration)
      }
      if (err instanceof ControlFrameRejectedError && err.code === 'GENERATION_TAKEN') {
        if (await handleGenerationTaken(deps, removal)) return false
        throw new RemovalPendingNotEnforcedError(deps.spaceId, removal.removedDid, removal.newGeneration)
      }
      if (err instanceof ControlFrameRejectedError && isHardSpaceRotateReject(err.code)) {
        // A non-retryable broker reject must surface — it is not a pending condition.
        throw err
      }
      // Otherwise (a transient broker reject such as RATE_LIMITED / INTERNAL_ERROR,
      // OR a transport failure like broker offline / timeout): stop here. The
      // staging is durable; VE-C3 retries. Do NOT commit or distribute.
      throw new RemovalPendingNotEnforcedError(deps.spaceId, removal.removedDid, removal.newGeneration)
    }
  }

  // ── ENFORCEMENT GATE: every home broker must be confirmed before COMMIT ─────
  const enforced = homeBrokerSet.every((url) => confirmed.has(url))
  if (!enforced) {
    throw new RemovalPendingNotEnforcedError(deps.spaceId, removal.removedDid, removal.newGeneration)
  }

  if (removal.phase === 'staged' || removal.phase === 'broker-confirmed') {
    // `markBrokerConfirmed` persists each acknowledgement before this successor
    // phase write. Carry that monotonic durable set forward as well: otherwise a
    // crash/fault between the effect and the phase write would overwrite the
    // confirmation with this stale in-memory snapshot and re-send the rotate.
    removal = { ...removal, confirmedBrokerUrls: [...confirmed], phase: 'broker-confirmed' }
    await deps.docLogStore.putPendingRemoval(removal)
  }

  // ── COMMIT (only now): activate the staged generation, then run the
  //    engine-specific membership-event + distribution, then drop the record. ──
  if (removal.phase === 'broker-confirmed') await commitStagedRotation({
    crypto: deps.crypto,
    keyPort: deps.keyPort,
    spaceId: deps.spaceId,
    ownerDid: deps.ownerDid,
    validityDurationMs: deps.validityDurationMs,
    now: deps.now,
    staged: {
      newGeneration: removal.newGeneration,
      contentKey: removal.stagedKeyMaterial.contentKey,
      capabilitySigningSeed: removal.stagedKeyMaterial.capSigningSeed,
      capabilityVerificationKey: removal.stagedKeyMaterial.capVerificationKey,
    },
  })
  if (removal.phase === 'broker-confirmed') {
    if (removal.activityEntry === undefined) await deps.commitRemoval(removal.removedDid, removal.newGeneration)
    else await deps.commitRemoval(removal.removedDid, removal.newGeneration, removal.activityEntry)
    removal = { ...removal, committed: true, phase: removal.removedDid === deps.ownerDid ? 'committed' : 'local-cleanup' }
    await deps.docLogStore.putPendingRemoval(removal)
  }
  // Sync 005 Self-Leave: the departing admin remains durably staged after
  // commit/distribution until its own broker authority is removed everywhere.
  if (removal.removedDid === deps.ownerDid && removal.phase === 'committed') {
    if (!deps.createSelfAdminRemoveFrame || !deps.sendAdminRemove || !deps.finalizeSelfLeave) {
      throw new Error('admin self-leave requires durable admin-remove dependencies')
    }
    const adminFrame = await deps.createSelfAdminRemoveFrame()
    const adminConfirmed = new Set(removal.adminRemoveConfirmedBrokerUrls ?? [])
    for (const brokerUrl of homeBrokerSet) {
      if (adminConfirmed.has(brokerUrl)) continue
      try {
        await deps.sendAdminRemove(brokerUrl, adminFrame)
      } catch {
        throw new RemovalPendingNotEnforcedError(deps.spaceId, removal.removedDid, removal.newGeneration)
      }
      adminConfirmed.add(brokerUrl)
      removal = { ...removal, adminRemoveConfirmedBrokerUrls: [...adminConfirmed] }
      await deps.docLogStore.putPendingRemoval(removal)
    }
    removal = { ...removal, phase: 'admin-removed' }
    await deps.docLogStore.putPendingRemoval(removal)
  }
  if (removal.removedDid === deps.ownerDid && removal.phase === 'admin-removed') {
    // `finalizeSelfLeave` is independently idempotent (stable PersonalDoc event
    // identity plus idempotent artifact deletes). A failed cleanup leaves this
    // exact durable phase for recovery, even when the Yjs space was unloaded.
    await deps.finalizeSelfLeave!(removal.newGeneration)
    removal = { ...removal, phase: 'local-cleanup' }
    await deps.docLogStore.putPendingRemoval(removal)
  }
  if (removal.phase === 'local-cleanup') {
    removal = { ...removal, phase: 'complete' }
    await deps.docLogStore.putPendingRemoval(removal)
  }
  await deps.docLogStore.deletePendingRemoval(deps.spaceId, removal.removedDid)
  return true
}

/** A gap is wire-authoritative: catch up to the reported broker generation, then restage exactly its successor. */
async function handleGenerationGap(
  deps: SecureRemovalDeps,
  removal: PendingRemoval,
  currentGeneration: number | undefined,
): Promise<PendingRemoval | null> {
  if (typeof currentGeneration !== 'number' || !Number.isSafeInteger(currentGeneration) || currentGeneration < 0) return null
  const brokerGeneration = currentGeneration
  const localGeneration = await deps.keyPort.getCurrentGeneration(deps.spaceId)
  if (localGeneration > brokerGeneration) {
    // The broker has lost state or belongs to a different branch. Keep the original
    // durable staging untouched; blindly replacing it would destroy evidence/material.
    throw new GenerationGapSplitBrainError(deps.spaceId, localGeneration, brokerGeneration)
  }
  if (!deps.catchUpGeneration) return null
  const catchUp = await deps.catchUpGeneration()
  if (catchUp === false || (typeof catchUp === 'object' && !catchUp.complete)) return null
  // Generate and validate off-record.  The old staged bytes are untouched until
  // this candidate has demonstrably converged to brokerGeneration + 1.
  const restaged = await stageRemovalCandidate(deps, removal.removedDid, removal.activityEntry, removal.kind)
  if (restaged.newGeneration !== brokerGeneration + 1) {
    // Do not overwrite the original staging when local catch-up did not actually
    // converge to the broker's reported branch.
    throw new Error(`GENERATION_GAP catch-up did not converge to broker generation ${brokerGeneration}`)
  }
  // `putPendingRemoval` overwrites the old record, including confirmations, so the
  // rejected frame can never be retried after successful convergence.
  await deps.docLogStore.putPendingRemoval(restaged)
  return restaged
}

/** Generate material without writing durable state (used by gap convergence). */
async function stageRemovalCandidate(
  deps: SecureRemovalDeps, removedDid: string, activityEntry?: Record<string, unknown>, kind?: 'canonical-self-removal-rotation',
): Promise<PendingRemoval> {
  const staged = await stageRotateSpaceKey({ crypto: deps.crypto, keyPort: deps.keyPort, spaceId: deps.spaceId, ownerDid: deps.ownerDid, validityDurationMs: deps.validityDurationMs, now: deps.now })
  return {
    phase: 'staged', spaceId: deps.spaceId, removedDid, homeBrokerSet: [...deps.homeBrokerSet], confirmedBrokerUrls: [], newGeneration: staged.newGeneration,
    stagedKeyMaterial: { contentKey: staged.contentKey, capSigningSeed: staged.capabilitySigningSeed, capVerificationKey: staged.capabilityVerificationKey },
    createdAt: (deps.now ?? (() => new Date()))().getTime(), activityEntry, kind,
  }
}

/**
 * GENERATION_TAKEN proves that another admin owns this generation. Never commit
 * this staged material. A canonical self-removal is fulfilled once that winner's
 * key-rotation arrived locally. A regular removal waits for the same local
 * convergence, then stages fresh material for current+1; this is the ONLY path
 * that replaces material. AUTH_INVALID and stale codes deliberately do not enter
 * this path: they are not material-bound proof and cannot authorize replacement.
 */
async function handleGenerationTaken(deps: SecureRemovalDeps, removal: PendingRemoval): Promise<boolean> {
  const current = await deps.keyPort.getCurrentGeneration(deps.spaceId)
  if (removal.kind === 'canonical-self-removal-rotation' && current >= removal.newGeneration) {
    await deps.docLogStore.deletePendingRemoval(deps.spaceId, removal.removedDid)
    return true
  }
  if (removal.kind !== 'canonical-self-removal-rotation' && current >= removal.newGeneration) {
    // A different rotation has arrived locally. Continue this still-uncommitted
    // removal at the actual next generation with new material, never by reusing
    // the foreign winner's slot.
    await stageRemoval(deps, removal.removedDid, removal.activityEntry, removal.kind)
  }
  return false
}

/**
 * A `space-rotate` reject that can NEVER succeed by retrying — it must surface raw
 * rather than be parked as a pending (retryable) removal.
 *
 * AUTHOR_MISMATCH is the coordinator's hard-stop bug class. AUTH_INVALID is a
 * genuine signature/authorization failure and remains retryable here; it never
 * authorizes commit or material replacement.
 *
 * NOTE: this is deliberately NOT {@link classifyRejectDisposition} — that table is
 * the log-entry WRITE-path (VE-4) disposition, where AUTH_INVALID is not even a
 * member; reusing it here mis-classifies AUTH_INVALID as `unknown` (→ retry) and
 * silently downgrades a hard rotate reject to a pending removal.
 */
function isHardSpaceRotateReject(code: ControlFrameRejectedError['code']): boolean {
  return classifyRejectDisposition(code) === 'hard-stop'
}
