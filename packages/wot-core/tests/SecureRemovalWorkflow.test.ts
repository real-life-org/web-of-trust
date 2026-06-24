import { describe, expect, it, vi } from 'vitest'
import {
  RemovalPendingNotEnforcedError,
  recoverPendingRemovals,
  runTwoPhaseRemoval,
  type SecureRemovalDeps,
} from '../src/application/sync/secure-removal-workflow'
import { createSpaceKey } from '../src/application/sync/group-key-workflow'
import { InMemoryKeyManagementAdapter } from '../src/adapters/key-management/InMemoryKeyManagementAdapter'
import { InMemoryDocLogStore } from '../src/adapters/storage/InMemoryDocLogStore'
import { WebCryptoProtocolCryptoAdapter } from '../src/adapters/protocol-crypto'
import { ControlFrameRejectedError, type ControlFrame } from '../src/protocol'

// Slice SR / VE-C1 + VE-C3 — engine-neutral two-phase secure member-removal.
// These exercise the orchestration directly (real crypto + real in-memory key /
// doc-log stores + a controllable sendSpaceRotate) so every safety invariant has
// teeth independent of the Yjs/Automerge wiring:
//   stage != commit · enforced <=> all home brokers confirmed · no pre-confirm side
//   effects · durable pending (RemovalPendingNotEnforcedError) · hard reject
//   propagates · multi-broker hard-gate · idempotent re-run (no double rotate) ·
//   crash-recovery (resume, AUTH_INVALID-as-already-enforced, still-pending, skip).

const crypto = new WebCryptoProtocolCryptoAdapter()
const SPACE = '33333333-3333-4333-8333-333333333333'
const OWNER = 'did:key:z6MkOwnerSecureRemoval'
const REMOVED = 'did:key:z6MkRemovedMemberXYZ'
const BROKER = 'wss://home-broker.example'
const BROKER_2 = 'wss://second-broker.example'

function hex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
}

function reject(code: ControlFrameRejectedError['code']): ControlFrameRejectedError {
  return new ControlFrameRejectedError({ code, message: `simulated ${code}` })
}

interface Harness {
  keyPort: InMemoryKeyManagementAdapter
  docLogStore: InMemoryDocLogStore
  deps: SecureRemovalDeps
  createRotateFrame: ReturnType<typeof vi.fn>
  sendSpaceRotate: ReturnType<typeof vi.fn>
  commitRemoval: ReturnType<typeof vi.fn>
}

async function makeHarness(opts: {
  homeBrokerSet?: readonly string[]
  sendSpaceRotate?: (brokerUrl: string, frame: ControlFrame) => Promise<void>
} = {}): Promise<Harness> {
  const keyPort = new InMemoryKeyManagementAdapter()
  const docLogStore = new InMemoryDocLogStore()
  await docLogStore.init()
  await createSpaceKey({ crypto, keyPort, spaceId: SPACE, ownerDid: OWNER }) // gen 0

  const createRotateFrame = vi.fn(
    async (newGeneration: number, capKey: Uint8Array): Promise<ControlFrame> => ({
      type: 'space-rotate',
      // carry the args so a test can assert the staged material flows into the frame
      ...({ __newGeneration: newGeneration, __capKey: capKey } as object),
    }),
  )
  const sendSpaceRotate = vi.fn(opts.sendSpaceRotate ?? (async () => {}))
  const commitRemoval = vi.fn(async () => {})

  const deps: SecureRemovalDeps = {
    crypto,
    keyPort,
    docLogStore,
    spaceId: SPACE,
    ownerDid: OWNER,
    homeBrokerSet: opts.homeBrokerSet ?? [BROKER],
    createRotateFrame,
    sendSpaceRotate,
    commitRemoval,
  }
  return { keyPort, docLogStore, deps, createRotateFrame, sendSpaceRotate, commitRemoval }
}

describe('runTwoPhaseRemoval — VE-C1 two-phase secure removal', () => {
  it('happy path (single home broker): stage → confirm → commit; generation advances, frame carries the activated key, staging is cleared', async () => {
    const h = await makeHarness()
    const markSpy = vi.spyOn(h.docLogStore, 'markBrokerConfirmed')

    await runTwoPhaseRemoval(h.deps, REMOVED)

    // committed: generation advanced to 1, commitRemoval ran once with that generation
    expect(await h.keyPort.getCurrentGeneration(SPACE)).toBe(1)
    expect(h.commitRemoval).toHaveBeenCalledTimes(1)
    expect(h.commitRemoval).toHaveBeenCalledWith(REMOVED, 1)
    // exactly one space-rotate to the one home broker; the broker was confirmed
    expect(h.sendSpaceRotate).toHaveBeenCalledTimes(1)
    expect(h.sendSpaceRotate.mock.calls[0][0]).toBe(BROKER)
    expect(markSpy).toHaveBeenCalledWith(SPACE, REMOVED, BROKER)
    // the rotate frame was built for generation 1 with the capability key that the
    // commit then ACTIVATED at generation 1 (broker key == admin-activated key)
    expect(h.createRotateFrame).toHaveBeenCalledTimes(1)
    expect(h.createRotateFrame.mock.calls[0][0]).toBe(1)
    expect(hex(h.createRotateFrame.mock.calls[0][1])).toBe(
      hex((await h.keyPort.getCapabilityVerificationKey(SPACE, 1))!),
    )
    // staging record is gone (removal complete)
    expect(await h.docLogStore.getPendingRemoval(SPACE, REMOVED)).toBeNull()
  })

  it('enforcement gate: the broker is confirmed BEFORE any commit side effect runs', async () => {
    const h = await makeHarness()
    const markSpy = vi.spyOn(h.docLogStore, 'markBrokerConfirmed')
    const commitRotationSpy = vi.spyOn(h.keyPort, 'saveKey') // commitStagedRotation activates the key here

    await runTwoPhaseRemoval(h.deps, REMOVED)

    // ordering: markBrokerConfirmed (enforce) precedes key activation AND commitRemoval
    const markOrder = markSpy.mock.invocationCallOrder[0]
    const activateOrder = commitRotationSpy.mock.invocationCallOrder.at(-1)!
    const commitOrder = h.commitRemoval.mock.invocationCallOrder[0]
    expect(markOrder).toBeLessThan(activateOrder)
    expect(activateOrder).toBeLessThan(commitOrder)
  })

  it('multi-broker is hard-gated: throws, with NO staging, NO rotate, NO generation change', async () => {
    const h = await makeHarness({ homeBrokerSet: [BROKER, BROKER_2] })
    await expect(runTwoPhaseRemoval(h.deps, REMOVED)).rejects.toThrow('multi-broker removal not yet supported')
    expect(await h.keyPort.getCurrentGeneration(SPACE)).toBe(0)
    expect(await h.docLogStore.getPendingRemoval(SPACE, REMOVED)).toBeNull()
    expect(h.sendSpaceRotate).not.toHaveBeenCalled()
    expect(h.commitRemoval).not.toHaveBeenCalled()
  })

  it('an empty home-broker set is rejected before any side effect', async () => {
    const h = await makeHarness({ homeBrokerSet: [] })
    await expect(runTwoPhaseRemoval(h.deps, REMOVED)).rejects.toThrow(/non-empty homeBrokerSet/)
    expect(await h.docLogStore.getPendingRemoval(SPACE, REMOVED)).toBeNull()
    expect(h.commitRemoval).not.toHaveBeenCalled()
  })

  it('a transient transport failure leaves the removal durably STAGED but not committed (RemovalPendingNotEnforcedError)', async () => {
    const h = await makeHarness({
      sendSpaceRotate: async () => {
        throw new Error('broker offline')
      },
    })

    await expect(runTwoPhaseRemoval(h.deps, REMOVED)).rejects.toBeInstanceOf(RemovalPendingNotEnforcedError)

    // NOTHING committed: generation unchanged, no key at gen 1, commit never ran
    expect(await h.keyPort.getCurrentGeneration(SPACE)).toBe(0)
    expect(await h.keyPort.getKeyByGeneration(SPACE, 1)).toBeNull()
    expect(h.commitRemoval).not.toHaveBeenCalled()
    // ...but the staging record persists for VE-C3 retry, with no broker confirmed
    const staged = await h.docLogStore.getPendingRemoval(SPACE, REMOVED)
    expect(staged).not.toBeNull()
    expect(staged!.newGeneration).toBe(1)
    expect(staged!.confirmedBrokerUrls).toEqual([])
    expect(staged!.homeBrokerSet).toEqual([BROKER])
  })

  it('a transient BROKER reject (INTERNAL_ERROR) is pending, not hard', async () => {
    const h = await makeHarness({
      sendSpaceRotate: async () => {
        throw reject('INTERNAL_ERROR')
      },
    })
    await expect(runTwoPhaseRemoval(h.deps, REMOVED)).rejects.toBeInstanceOf(RemovalPendingNotEnforcedError)
    expect(h.commitRemoval).not.toHaveBeenCalled()
    expect(await h.docLogStore.getPendingRemoval(SPACE, REMOVED)).not.toBeNull()
  })

  it('a HARD space-rotate reject (AUTH_INVALID on a first attempt) PROPAGATES raw — not a pending removal', async () => {
    // Regression guard: AUTH_INVALID must be classified hard for a space-rotate, even
    // though the log-entry VE-4 disposition table maps it to `unknown`. A first-attempt
    // AUTH_INVALID is a real admin-authority/sequencing bug, never a "retry later".
    const h = await makeHarness({
      sendSpaceRotate: async () => {
        throw reject('AUTH_INVALID')
      },
    })

    const err = await runTwoPhaseRemoval(h.deps, REMOVED).catch((e) => e)
    expect(err).toBeInstanceOf(ControlFrameRejectedError)
    expect(err).not.toBeInstanceOf(RemovalPendingNotEnforcedError)
    expect((err as ControlFrameRejectedError).code).toBe('AUTH_INVALID')
    expect(h.commitRemoval).not.toHaveBeenCalled()
    expect(await h.keyPort.getCurrentGeneration(SPACE)).toBe(0)
    // the staging persists (durable); a hard reject is an admin bug to fix, not data loss
    expect(await h.docLogStore.getPendingRemoval(SPACE, REMOVED)).not.toBeNull()
  })

  it('a CAPABILITY_GENERATION_STALE reject means the broker is already at/past this generation → commit (catch up locally)', async () => {
    const h = await makeHarness({
      sendSpaceRotate: async () => {
        throw reject('CAPABILITY_GENERATION_STALE')
      },
    })
    await runTwoPhaseRemoval(h.deps, REMOVED)
    expect(h.commitRemoval).toHaveBeenCalledTimes(1)
    expect(await h.keyPort.getCurrentGeneration(SPACE)).toBe(1)
    expect(await h.docLogStore.getPendingRemoval(SPACE, REMOVED)).toBeNull()
  })

  it('idempotent re-run reuses the staged record (same generation + material, no double rotate)', async () => {
    // First attempt fails transiently → durable staging at generation 1.
    let online = false
    const h = await makeHarness({
      sendSpaceRotate: async () => {
        if (!online) throw new Error('broker offline')
      },
    })
    await expect(runTwoPhaseRemoval(h.deps, REMOVED)).rejects.toBeInstanceOf(RemovalPendingNotEnforcedError)
    const staged = await h.docLogStore.getPendingRemoval(SPACE, REMOVED)
    const stagedContentKey = hex(staged!.stagedKeyMaterial.contentKey)

    // Second attempt (broker now reachable) reuses the SAME staging record.
    online = true
    await runTwoPhaseRemoval(h.deps, REMOVED)

    // generation advanced by EXACTLY one, and the committed key is the ORIGINALLY
    // staged material (not freshly generated) — proving no second stage / double rotate
    expect(await h.keyPort.getCurrentGeneration(SPACE)).toBe(1)
    expect(hex((await h.keyPort.getKeyByGeneration(SPACE, 1))!)).toBe(stagedContentKey)
    expect(h.commitRemoval).toHaveBeenCalledTimes(1)
    // both rotate frames targeted the same generation with the same capability key
    expect(h.createRotateFrame.mock.calls.map((c) => c[0])).toEqual([1, 1])
    expect(hex(h.createRotateFrame.mock.calls[0][1])).toBe(hex(h.createRotateFrame.mock.calls[1][1]))
    expect(await h.docLogStore.getPendingRemoval(SPACE, REMOVED)).toBeNull()
  })
})

describe('recoverPendingRemovals — VE-C3 crash-recovery (single home broker)', () => {
  it('resumes a staged removal once the broker is reachable and drives it to commit', async () => {
    let online = false
    const h = await makeHarness({
      sendSpaceRotate: async () => {
        if (!online) throw new Error('broker offline')
      },
    })
    // crash window: stage then fail (durable record left behind)
    await expect(runTwoPhaseRemoval(h.deps, REMOVED)).rejects.toBeInstanceOf(RemovalPendingNotEnforcedError)
    h.commitRemoval.mockClear()

    online = true
    const committed = await recoverPendingRemovals(h.docLogStore, async () => h.deps)

    expect(committed).toBe(1)
    expect(h.commitRemoval).toHaveBeenCalledTimes(1)
    expect(await h.keyPort.getCurrentGeneration(SPACE)).toBe(1)
    expect(await h.docLogStore.getPendingRemoval(SPACE, REMOVED)).toBeNull()
  })

  it('treats AUTH_INVALID during recovery as already-enforced (the broker rotated on a lost-confirmation earlier attempt) → commit', async () => {
    // First attempt: stage, then the rotate is APPLIED at the broker but its
    // confirmation is lost (modelled as a transient transport failure so the local
    // record stays pending).
    let firstAttempt = true
    const h = await makeHarness({
      sendSpaceRotate: async () => {
        if (firstAttempt) throw new Error('confirmation lost')
        // recovery re-send of an already-applied generation → relay AUTH_INVALID
        throw reject('AUTH_INVALID')
      },
    })
    await expect(runTwoPhaseRemoval(h.deps, REMOVED)).rejects.toBeInstanceOf(RemovalPendingNotEnforcedError)
    firstAttempt = false
    h.commitRemoval.mockClear()

    const committed = await recoverPendingRemovals(h.docLogStore, async () => h.deps)

    expect(committed).toBe(1)
    expect(h.commitRemoval).toHaveBeenCalledTimes(1)
    expect(await h.docLogStore.getPendingRemoval(SPACE, REMOVED)).toBeNull()
  })

  it('a still-unreachable broker leaves the removal staged and recovery never throws (returns 0)', async () => {
    const h = await makeHarness({
      sendSpaceRotate: async () => {
        throw new Error('still offline')
      },
    })
    await expect(runTwoPhaseRemoval(h.deps, REMOVED)).rejects.toBeInstanceOf(RemovalPendingNotEnforcedError)
    h.commitRemoval.mockClear()

    const committed = await recoverPendingRemovals(h.docLogStore, async () => h.deps)

    expect(committed).toBe(0)
    expect(h.commitRemoval).not.toHaveBeenCalled()
    expect(await h.docLogStore.getPendingRemoval(SPACE, REMOVED)).not.toBeNull()
  })

  it('skips a removal whose space the adapter can no longer resolve (deps = null) without deleting it', async () => {
    const h = await makeHarness({
      sendSpaceRotate: async () => {
        throw new Error('offline')
      },
    })
    await expect(runTwoPhaseRemoval(h.deps, REMOVED)).rejects.toBeInstanceOf(RemovalPendingNotEnforcedError)

    const committed = await recoverPendingRemovals(h.docLogStore, async () => null)

    expect(committed).toBe(0)
    // record preserved — the space may re-appear on a later pass
    expect(await h.docLogStore.getPendingRemoval(SPACE, REMOVED)).not.toBeNull()
  })

  it('a hard error during recovery does not abort recovery of the OTHER removals', async () => {
    // one space resolves to a deps whose rotate hard-rejects; recovery logs + moves on
    const h = await makeHarness({
      sendSpaceRotate: async () => {
        throw reject('AUTH_INVALID') // first-attempt-style hard reject during recovery resolveDeps
      },
    })
    // stage a pending removal via a transient first attempt
    let hard = false
    h.sendSpaceRotate.mockImplementation(async () => {
      if (hard) throw reject('AUTHOR_MISMATCH') // a genuinely hard, non-already-enforced reject
      throw new Error('offline')
    })
    await expect(runTwoPhaseRemoval(h.deps, REMOVED)).rejects.toBeInstanceOf(RemovalPendingNotEnforcedError)
    hard = true

    // recovery must not throw even though this removal hard-fails
    const committed = await recoverPendingRemovals(h.docLogStore, async () => h.deps)
    expect(committed).toBe(0)
    // AUTHOR_MISMATCH is a hard stop, not already-enforced → not committed, record kept
    expect(await h.docLogStore.getPendingRemoval(SPACE, REMOVED)).not.toBeNull()
  })
})
