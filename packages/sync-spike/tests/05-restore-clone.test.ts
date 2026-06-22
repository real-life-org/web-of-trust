import { describe, it, expect } from 'vitest'
import { SimRelay } from '../src/sim-relay.js'
import { SimClient } from '../src/sim-client.js'
import { makeAuthorFromLabel, newUuid, crypto } from '../src/identity.js'
import {
  classifyLocalBrokerSeqConsistency,
  classifyDeviceRevocationDisposition,
  verifyLogEntryJws,
  decodeBase64Url,
  bytesToHex,
} from '@web_of_trust/core/protocol'

/**
 * Restore-clone hazard.
 *
 * (a) SAME deviceId reused with a rewound localSeq -> rewrites a used seq with
 *     DIFFERENT content -> broker rejects SEQ_COLLISION_DETECTED (clientHint
 *     restore-clone-required); client-side classifyLocalBrokerSeqConsistency flags
 *     restore-clone-required. No nonce reuse is ever committed.
 * (b) NEW deviceId after restore -> no collision -> catch-up + a clean device-revoke
 *     path for the old device -> converges.
 */

describe('05 restore-clone', () => {
  it('(a) same deviceId rewound is rejected with SEQ_COLLISION_DETECTED; no nonce reuse committed', async () => {
    const relay = new SimRelay('durable-log')
    const docId = newUuid()
    const author = await makeAuthorFromLabel('rc-a')
    const deviceId = newUuid()
    const members = [author.did]

    const dev = new SimClient({ author, deviceId, docId, relay, members })
    dev.connect()
    await dev.localWrite('k0', 'original-0')
    await dev.localWrite('k1', 'original-1')

    // Record the broker's committed content for (deviceId, 0).
    const originalEntry = relay.logEntries(docId)[0]
    const originalPayload = await verifyLogEntryJws(originalEntry, { crypto })
    const originalHash = bytesToHex(await crypto.sha256(decodeBase64Url(originalPayload.data)))

    // DISASTER: device restored from an OLD backup -> local cache wiped, localSeq
    // rewound to -1. It does NOT know the broker already has seq 0 and 1.
    dev.clearCache()
    expect(dev.localSeq).toBe(-1)

    // Before writing, a correct client compares local vs broker heads.
    const brokerSeq = relay.brokerHeads(docId)[deviceId]
    const consistency = classifyLocalBrokerSeqConsistency({
      docId,
      deviceId,
      localSeq: 0, // would write seq 0 next (localSeq -1 + 1)
      brokerSeq,
    })
    expect(consistency.disposition).toBe('restore-clone-required')

    // If it naively writes anyway, the broker rejects with a seq collision.
    const result = await dev.localWrite('k0', 'DIFFERENT-content')
    expect(result.appendResult.disposition).toBe('reject-seq-collision')
    expect(result.appendResult.errorCode).toBe('SEQ_COLLISION_DETECTED')
    expect(result.appendResult.clientHint).toBe('restore-clone-required')

    // No nonce reuse committed: the broker still holds the ORIGINAL content at
    // (deviceId, 0); the divergent entry was never stored. The deterministic nonce
    // SHA(deviceId|0) was therefore never used to encrypt two different plaintexts
    // under the same key in the durable log.
    expect(relay.logLength(docId)).toBe(2)
    const stillOriginal = await verifyLogEntryJws(relay.logEntries(docId)[0], { crypto })
    const stillHash = bytesToHex(await crypto.sha256(decodeBase64Url(stillOriginal.data)))
    expect(stillHash).toBe(originalHash)

    // The optimistic local seq reservation was rolled back on rejection.
    expect(dev.localSeq).toBe(-1)
  })

  it('(b) NEW deviceId after restore: no collision, catch-up converges, old device cleanly revoked', async () => {
    const relay = new SimRelay('durable-log')
    const docId = newUuid()
    const author = await makeAuthorFromLabel('rc-b')
    const oldDeviceId = newUuid()
    const members = [author.did]

    const oldDevice = new SimClient({ author, deviceId: oldDeviceId, docId, relay, members })
    oldDevice.connect()
    await oldDevice.localWrite('k0', 'v0')
    await oldDevice.localWrite('k1', 'v1')
    const targetHash = await oldDevice.hash()

    // Restore as a BRAND NEW device id (the correct restore-clone remedy).
    const newDeviceId = newUuid()
    const newDevice = new SimClient({ author, deviceId: newDeviceId, docId, relay, members })

    // New device catches up cleanly (its own seq space is fresh, no collision).
    const result = await newDevice.catchUp()
    expect(result.appliedCount).toBe(2)
    expect(await newDevice.hash()).toBe(targetHash)

    // The new device can write without collision (seq starts at 0 under its OWN id).
    const write = await newDevice.localWrite('k2', 'v2')
    expect(write.appendResult.disposition).toBe('accept-new-entry')

    // Clean device-revoke for the OLD device via the spec classifier.
    const revokedAt = '2026-06-22T11:00:00Z'
    const disposition = classifyDeviceRevocationDisposition({
      revocation: { type: 'device-revoke', did: author.did, deviceId: oldDeviceId, revokedAt },
      knownDevice: { did: author.did, deviceId: oldDeviceId, status: 'active' },
    })
    expect(disposition.disposition).toBe('accepted')
    expect(disposition.actions.map((a) => a.type)).toContain('mark-device-revoked')

    // Idempotent re-revoke is accepted-idempotent (no duplicate side effects).
    const again = classifyDeviceRevocationDisposition({
      revocation: { type: 'device-revoke', did: author.did, deviceId: oldDeviceId, revokedAt },
      knownDevice: { did: author.did, deviceId: oldDeviceId, status: 'revoked', revokedAt },
    })
    expect(again.disposition).toBe('accepted-idempotent')
  })
})
