import { describe, expect, it, vi } from 'vitest'
import {
  RemovalPendingNotEnforcedError,
  GenerationGapSplitBrainError,
  recoverPendingRemovals,
  runTwoPhaseRemoval,
  type SecureRemovalDeps,
} from '../src/application/sync/secure-removal-workflow'
import { createSpaceKey } from '../src/application/sync/group-key-workflow'
import { InMemoryKeyManagementAdapter } from '../src/adapters/key-management/InMemoryKeyManagementAdapter'
import { InMemoryDocLogStore } from '../src/adapters/storage/InMemoryDocLogStore'
import type { PendingRemoval } from '../src/ports/DocLogStore'
import { WebCryptoProtocolCryptoAdapter } from '../src/adapters/protocol-crypto'
import { ControlFrameRejectedError, type ControlFrame } from '../src/protocol'

// Slice SR / VE-C1 + VE-C3 — engine-neutral two-phase secure member-removal.
// These exercise the orchestration directly (real crypto + real in-memory key /
// doc-log stores + a controllable sendSpaceRotate) so every safety invariant has
// teeth independent of the Yjs/Automerge wiring:
//   stage != commit · enforced <=> all home brokers confirmed · no pre-confirm side
//   effects · durable pending (RemovalPendingNotEnforcedError) · hard reject
//   propagates · multi-broker hard-gate · idempotent re-run (no double rotate) ·
//   crash-recovery (resume, AUTH_INVALID convergence without unsafe commit, still-pending, skip).

const crypto = new WebCryptoProtocolCryptoAdapter()
const SPACE = '33333333-3333-4333-8333-333333333333'
const OWNER = 'did:key:z6MkOwnerSecureRemoval'
const REMOVED = 'did:key:z6MkRemovedMemberXYZ'
const BROKER = 'wss://home-broker.example'
const BROKER_2 = 'wss://second-broker.example'

function hex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
}

function reject(code: ControlFrameRejectedError['code'], currentGeneration?: number): ControlFrameRejectedError {
  return new ControlFrameRejectedError({ code, message: `simulated ${code}`, currentGeneration })
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
  ownerDid?: string
} = {}): Promise<Harness> {
  const keyPort = new InMemoryKeyManagementAdapter()
  const docLogStore = new InMemoryDocLogStore()
  await docLogStore.init()
  const ownerDid = opts.ownerDid ?? OWNER
  await createSpaceKey({ crypto, keyPort, spaceId: SPACE, ownerDid }) // gen 0

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
    ownerDid,
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

  it('an AUTH_INVALID never commits or replaces staged material, leaving it for retry', async () => {
    let authInvalid = false
    const h = await makeHarness({
      sendSpaceRotate: async () => {
        if (authInvalid) throw reject('AUTH_INVALID')
        throw new Error('offline before retry')
      },
    })

    await expect(runTwoPhaseRemoval(h.deps, REMOVED)).rejects.toBeInstanceOf(RemovalPendingNotEnforcedError)
    const before = await h.docLogStore.getPendingRemoval(SPACE, REMOVED)
    authInvalid = true
    const err = await runTwoPhaseRemoval(h.deps, REMOVED).catch((e) => e)
    expect(err).toBeInstanceOf(RemovalPendingNotEnforcedError)
    expect(h.commitRemoval).not.toHaveBeenCalled()
    expect(await h.keyPort.getCurrentGeneration(SPACE)).toBe(0)
    // AUTH_INVALID is an actual signature/authorization failure, not a winner proof.
    const after = await h.docLogStore.getPendingRemoval(SPACE, REMOVED)
    expect(after).not.toBeNull()
    expect(hex(after!.stagedKeyMaterial.contentKey)).toBe(hex(before!.stagedKeyMaterial.contentKey))
  })

  it.each(['CAPABILITY_GENERATION_STALE', 'KEY_GENERATION_STALE'] as const)('%s never proves staged material won', async (code) => {
    const h = await makeHarness({
      sendSpaceRotate: async () => {
        throw reject(code)
      },
    })
    await expect(runTwoPhaseRemoval(h.deps, REMOVED)).rejects.toBeInstanceOf(RemovalPendingNotEnforcedError)
    expect(h.commitRemoval).not.toHaveBeenCalled()
    expect(await h.keyPort.getCurrentGeneration(SPACE)).toBe(0)
    expect(await h.docLogStore.getPendingRemoval(SPACE, REMOVED)).not.toBeNull()
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
  it.each([
    ['staged→broker-confirmed', 'broker-confirmed'],
    ['broker-confirmed→committed', 'committed'],
    ['committed→admin-removed', 'admin-removed'],
    ['admin-removed→local-cleanup', 'local-cleanup'],
    ['local-cleanup→complete', 'complete'],
  ] as const)('fault injection directly after %s persists no successor; recovery converges without duplicate durable effects', async (_transition, failPhase) => {
    const h = await makeHarness({ ownerDid: REMOVED })
    const keyWrites = vi.spyOn(h.keyPort, 'saveKey')
    const personalDocEntries = new Map<string, number>()
    const finalizeSelfLeave = vi.fn(async (generation: number) => {
      // Models the real stable PersonalDoc event identity: retry can call the
      // hook again, but it can never create a second personal removal entry.
      personalDocEntries.set(`${SPACE}:${REMOVED}:${generation}`, generation)
    })
    const sendAdminRemove = vi.fn(async () => {})
    h.deps.createSelfAdminRemoveFrame = async () => ({ type: 'admin-remove' })
    h.deps.sendAdminRemove = sendAdminRemove
    h.deps.finalizeSelfLeave = finalizeSelfLeave

    const realPut = h.docLogStore.putPendingRemoval.bind(h.docLogStore)
    let armed = true
    ;(h.docLogStore as unknown as { putPendingRemoval: typeof h.docLogStore.putPendingRemoval }).putPendingRemoval = (async (removal) => {
      if (armed && removal.phase === failPhase) {
        armed = false
        throw new Error(`injected after effect before ${failPhase} persistence`)
      }
      await realPut(removal)
    }) as typeof h.docLogStore.putPendingRemoval

    await expect(runTwoPhaseRemoval(h.deps, REMOVED)).rejects.toThrow(`before ${failPhase} persistence`)
    expect((await h.docLogStore.getPendingRemoval(SPACE, REMOVED))!.phase).not.toBe(failPhase)

    await recoverPendingRemovals(h.docLogStore, async () => h.deps)

    expect(await h.docLogStore.getPendingRemoval(SPACE, REMOVED)).toBeNull()
    expect(h.sendSpaceRotate).toHaveBeenCalledTimes(1) // confirmation is durable before the phase write
    expect(sendAdminRemove).toHaveBeenCalledTimes(1) // same for admin-remove confirmation
    expect(keyWrites).toHaveBeenCalledTimes(1) // commitStagedRotation is a true no-op on retry
    expect(personalDocEntries).toHaveLength(1)
  })

  it('after a crash while awaiting admin-remove, recovery runs the durable finalizer once before deleting the pending removal', async () => {
    let adminRemoveOnline = false
    const h = await makeHarness({ ownerDid: REMOVED })
    const finalizeSelfLeave = vi.fn(async () => {})
    h.deps.createSelfAdminRemoveFrame = async () => ({ type: 'admin-remove' })
    h.deps.sendAdminRemove = async () => {
      if (!adminRemoveOnline) throw new Error('app died while awaiting admin-remove')
    }
    h.deps.finalizeSelfLeave = finalizeSelfLeave

    await expect(runTwoPhaseRemoval(h.deps, REMOVED)).rejects.toBeInstanceOf(RemovalPendingNotEnforcedError)
    expect(finalizeSelfLeave).not.toHaveBeenCalled()
    expect(await h.docLogStore.getPendingRemoval(SPACE, REMOVED)).not.toBeNull()

    adminRemoveOnline = true
    expect(await recoverPendingRemovals(h.docLogStore, async () => h.deps)).toBe(1)
    expect(finalizeSelfLeave).toHaveBeenCalledTimes(1)
    expect(finalizeSelfLeave).toHaveBeenCalledWith(1)
    expect(await h.docLogStore.getPendingRemoval(SPACE, REMOVED)).toBeNull()

    expect(await recoverPendingRemovals(h.docLogStore, async () => h.deps)).toBe(0)
    expect(finalizeSelfLeave).toHaveBeenCalledTimes(1)
  })

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

  it('lost confirmation: identical retry proves its material won and commits it', async () => {
    // Shared broker durable state: the first frame installs Key A, then only its
    // confirmation is lost. The retry sees the same Key A and succeeds idempotently.
    let installedKey: Uint8Array | null = null
    let firstAttempt = true
    const h = await makeHarness({
      sendSpaceRotate: async (_broker, frame) => {
        const key = (frame as unknown as { __capKey: Uint8Array }).__capKey
        if (installedKey === null) {
          installedKey = key.slice()
          throw new Error('confirmation lost')
        }
        if (hex(key) !== hex(installedKey)) throw reject('GENERATION_TAKEN')
      },
    })
    await expect(runTwoPhaseRemoval(h.deps, REMOVED)).rejects.toBeInstanceOf(RemovalPendingNotEnforcedError)
    firstAttempt = false
    h.commitRemoval.mockClear()

    const committed = await recoverPendingRemovals(h.docLogStore, async () => h.deps)

    expect(committed).toBe(1)
    expect(h.commitRemoval).toHaveBeenCalledTimes(1)
    expect(hex((await h.keyPort.getCapabilityVerificationKey(SPACE, 1))!)).toBe(hex(installedKey!))
    expect(await h.docLogStore.getPendingRemoval(SPACE, REMOVED)).toBeNull()
  })

  it('two independent admin stores never commit the loser material; canonical rotation converges after the winner arrives', async () => {
    let brokerGeneration = 0
    const winner = await makeHarness({
      ownerDid: 'did:key:z6MkAdminA',
      sendSpaceRotate: async () => { brokerGeneration = 1 },
    })
    const loser = await makeHarness({
      ownerDid: 'did:key:z6MkAdminB',
      sendSpaceRotate: async () => {
        if (brokerGeneration >= 1) throw reject('GENERATION_TAKEN')
      },
    })

    await runTwoPhaseRemoval(winner.deps, REMOVED, {
      kind: 'canonical-self-removal-rotation', targetGeneration: 1,
    })
    await expect(runTwoPhaseRemoval(loser.deps, REMOVED, {
      kind: 'canonical-self-removal-rotation', targetGeneration: 1,
    })).rejects.toBeInstanceOf(RemovalPendingNotEnforcedError)

    expect(loser.commitRemoval).not.toHaveBeenCalled()
    expect(await loser.keyPort.getCurrentGeneration(SPACE)).toBe(0)
    expect(await loser.docLogStore.getPendingRemoval(SPACE, REMOVED)).not.toBeNull()

    // The winner's key-rotation reaches the losing admin. Its own staged material
    // is discarded; recovery observes the fulfilled declared generation and no-ops.
    const winnerKey = (await winner.keyPort.getKeyByGeneration(SPACE, 1))!
    await loser.keyPort.saveKey(SPACE, 1, winnerKey)
    const committed = await recoverPendingRemovals(loser.docLogStore, async () => loser.deps)

    expect(committed).toBe(0)
    expect(loser.commitRemoval).not.toHaveBeenCalled()
    expect(await loser.docLogStore.getPendingRemoval(SPACE, REMOVED)).toBeNull()
    expect(hex((await loser.keyPort.getKeyByGeneration(SPACE, 1))!)).toBe(hex(winnerKey))
  })

  it('GENERATION_TAKEN restages a regular pending removal with fresh material only after winner convergence', async () => {
    let brokerGeneration = 1
    const h = await makeHarness({
      sendSpaceRotate: async () => {
        if (brokerGeneration >= 1) throw reject('GENERATION_TAKEN')
      },
    })
    await expect(runTwoPhaseRemoval(h.deps, REMOVED)).rejects.toBeInstanceOf(RemovalPendingNotEnforcedError)
    const before = await h.docLogStore.getPendingRemoval(SPACE, REMOVED)
    expect(before!.newGeneration).toBe(1)

    // The winning key-rotation reaches this admin. Only this proved-taken path may
    // replace material, and it must now target the next generation.
    await h.keyPort.saveKey(SPACE, 1, new Uint8Array(32).fill(7))
    const committed = await recoverPendingRemovals(h.docLogStore, async () => h.deps)
    const after = await h.docLogStore.getPendingRemoval(SPACE, REMOVED)

    expect(committed).toBe(0)
    expect(h.commitRemoval).not.toHaveBeenCalled()
    expect(after!.newGeneration).toBe(2)
    expect(hex(after!.stagedKeyMaterial.contentKey)).not.toBe(hex(before!.stagedKeyMaterial.contentKey))
  })

  it('GENERATION_GAP uses the broker generation: catch-up then restage current+1 and commit against stateful broker', async () => {
    let brokerGeneration = 0
    let attempts = 0
    const h = await makeHarness({
      sendSpaceRotate: async (_broker, frame) => {
        attempts += 1
        const generation = (frame as unknown as { __newGeneration: number }).__newGeneration
        if (generation > brokerGeneration + 1) throw reject('GENERATION_GAP', brokerGeneration)
        expect(generation).toBe(brokerGeneration + 1)
        brokerGeneration = generation
      },
    })
    // The client had durably staged 2 while its loaded key state is still at 0;
    // the broker's authoritative currentGeneration is 0.
    await h.docLogStore.putPendingRemoval({
      spaceId: SPACE, removedDid: REMOVED, homeBrokerSet: [BROKER], confirmedBrokerUrls: [], newGeneration: 2,
      stagedKeyMaterial: { contentKey: new Uint8Array(32).fill(9), capSigningSeed: new Uint8Array(32).fill(8), capVerificationKey: new Uint8Array(32).fill(7) },
      createdAt: Date.now(),
    })
    const catchUp = vi.fn(async () => {
      return { complete: true }
    })
    h.deps.catchUpGeneration = catchUp

    await runTwoPhaseRemoval(h.deps, REMOVED)
    expect(catchUp).toHaveBeenCalledTimes(1)
    expect(attempts).toBe(2)
    expect(h.createRotateFrame.mock.calls.map(call => call[0])).toEqual([2, 1])
    expect(brokerGeneration).toBe(1)
    expect(h.commitRemoval).toHaveBeenCalledWith(REMOVED, 1)
    expect(await h.docLogStore.getPendingRemoval(SPACE, REMOVED)).toBeNull()
  })

  it('GENERATION_GAP never resolves successfully when catch-up is incomplete', async () => {
    const h = await makeHarness({ sendSpaceRotate: async () => { throw reject('GENERATION_GAP', 0) } })
    h.deps.catchUpGeneration = async () => ({ complete: false })

    await expect(runTwoPhaseRemoval(h.deps, REMOVED)).rejects.toBeInstanceOf(RemovalPendingNotEnforcedError)
    expect(h.commitRemoval).not.toHaveBeenCalled()
    expect((await h.docLogStore.getPendingRemoval(SPACE, REMOVED))!.newGeneration).toBe(1)
  })

  it.each([
    ['reports incomplete', async () => ({ complete: false })],
    ['throws while producing catch-up material', async () => { throw new Error('catch-up material unavailable') }],
  ])('GENERATION_GAP catch-up that %s preserves the original durable staging byte-for-byte and never signals success', async (_case, catchUpGeneration) => {
    const h = await makeHarness({ sendSpaceRotate: async () => { throw reject('GENERATION_GAP', 0) } })
    const original = {
      phase: 'staged' as const,
      spaceId: SPACE,
      removedDid: REMOVED,
      homeBrokerSet: [BROKER],
      confirmedBrokerUrls: [],
      newGeneration: 2,
      stagedKeyMaterial: {
        contentKey: Uint8Array.from({ length: 32 }, (_, i) => i),
        capSigningSeed: Uint8Array.from({ length: 32 }, (_, i) => 255 - i),
        capVerificationKey: Uint8Array.from({ length: 32 }, (_, i) => (i * 17) & 0xff),
      },
      createdAt: 1_700_000_000_001,
    }
    await h.docLogStore.putPendingRemoval(original)
    const before = await h.docLogStore.getPendingRemoval(SPACE, REMOVED)
    h.deps.catchUpGeneration = catchUpGeneration

    await expect(runTwoPhaseRemoval(h.deps, REMOVED)).rejects.toThrow()

    // This is deliberately a full record snapshot, including every staged-key byte:
    // failed gap convergence must not silently replace durable recovery material.
    expect(await h.docLogStore.getPendingRemoval(SPACE, REMOVED)).toEqual(before)
    expect(h.commitRemoval).not.toHaveBeenCalled()
  })

  it('GENERATION_GAP with local generation ahead of broker surfaces split-brain without send/restage and retains staging', async () => {
    const h = await makeHarness()
    await h.keyPort.saveKey(SPACE, 1, new Uint8Array(32).fill(3))
    await h.keyPort.saveKey(SPACE, 2, new Uint8Array(32).fill(4))
    const staged = {
      spaceId: SPACE, removedDid: REMOVED, homeBrokerSet: [BROKER], confirmedBrokerUrls: [], newGeneration: 3,
      stagedKeyMaterial: { contentKey: new Uint8Array(32).fill(9), capSigningSeed: new Uint8Array(32).fill(8), capVerificationKey: new Uint8Array(32).fill(7) },
      createdAt: Date.now(),
    }
    await h.docLogStore.putPendingRemoval({ ...staged, phase: 'staged' })
    h.deps.sendSpaceRotate = h.sendSpaceRotate.mockImplementation(async () => { throw reject('GENERATION_GAP', 0) })

    await expect(runTwoPhaseRemoval(h.deps, REMOVED)).rejects.toBeInstanceOf(GenerationGapSplitBrainError)
    expect(h.sendSpaceRotate).toHaveBeenCalledTimes(1) // the rejected original only; no restaged frame
    expect(await h.docLogStore.getPendingRemoval(SPACE, REMOVED)).toMatchObject({ ...staged, phase: 'staged' })
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

  it.each([
    ['staged', false, false, 'staged'],
    ['broker-confirmed', true, false, 'broker-confirmed'],
    ['committed', false, true, 'committed'],
  ] as const)('migrates a legacy phase-less record (%s) at load and drives it through recovery', async (_name, hasConfirmation, committed, expectedPhase) => {
    const h = await makeHarness()
    const staged = await (async () => {
      await expect(runTwoPhaseRemoval({ ...h.deps, sendSpaceRotate: async () => { throw new Error('offline') } }, REMOVED))
        .rejects.toBeInstanceOf(RemovalPendingNotEnforcedError)
      return (await h.docLogStore.getPendingRemoval(SPACE, REMOVED))!
    })()
    // Simulate an at-rest v3/v4 record: `phase` did not exist yet. Both stores
    // perform this compatibility inference on load, before recovery consumes it.
    await h.docLogStore.putPendingRemoval({
      ...staged,
      phase: undefined as unknown as PendingRemoval['phase'],
      confirmedBrokerUrls: hasConfirmation ? [BROKER] : [],
      committed,
    })

    expect((await h.docLogStore.getPendingRemoval(SPACE, REMOVED))!.phase).toBe(expectedPhase)
    await recoverPendingRemovals(h.docLogStore, async () => h.deps)
    expect(await h.docLogStore.getPendingRemoval(SPACE, REMOVED)).toBeNull()
  })
})
