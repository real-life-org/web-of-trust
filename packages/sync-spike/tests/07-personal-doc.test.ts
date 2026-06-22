import { describe, it, expect } from 'vitest'
import { SimRelay } from '../src/sim-relay.js'
import { SimClient } from '../src/sim-client.js'
import { makeAuthorFromLabel, newUuid, crypto } from '../src/identity.js'
import { derivePersonalDocFromSeedHex, bytesToHex, compareSyncHeads } from '@web_of_trust/core/protocol'

/**
 * Personal doc: single-writer (one identity), multi-device, on durable-log. Same
 * reliability (catch-up converges across the user's own devices) AND explicitly
 * loop-free (no echo on the personal-doc path).
 *
 * The personal doc derives BOTH its docId and content key from the user's seed
 * (derivePersonalDocFromSeedHex) — gen 0. Each device has its OWN deviceId/seq
 * space; the single writer is the only identity that signs.
 */

describe('07 personal doc', () => {
  it('multi-device personal doc: catch-up converges and is loop-free', async () => {
    const relay = new SimRelay('durable-log')
    const author = await makeAuthorFromLabel('personal-owner')

    // Derive the personal doc material from a (fixed) bip39 seed hex.
    // A BIP39 seed is 64 bytes (128 hex chars); build one deterministically.
    const half1 = await crypto.sha256(new TextEncoder().encode('personal-doc-seed/1'))
    const half2 = await crypto.sha256(new TextEncoder().encode('personal-doc-seed/2'))
    const seedHex = bytesToHex(half1) + bytesToHex(half2)
    const material = await derivePersonalDocFromSeedHex(seedHex, crypto)
    const docId = material.docId
    const members = [author.did] // single-writer: only the owner

    // Two devices of the SAME user. Both seed the personal content key as gen 0.
    const phone = new SimClient({ author, deviceId: newUuid(), docId, relay, members, availableKeyGenerations: [] })
    const laptop = new SimClient({ author, deviceId: newUuid(), docId, relay, members, availableKeyGenerations: [] })
    await phone.importKeyGeneration(0, material.key)
    await laptop.importKeyGeneration(0, material.key)
    phone.connect(); laptop.connect()

    // Phone writes; laptop sees it live (loop-free, single append per write).
    await phone.localWrite('display-name', 'Anton')
    expect(relay.totalAppendCalls).toBe(1) // no echo
    expect(await laptop.hash()).toBe(await phone.hash())

    // Laptop writes back; still loop-free.
    await laptop.localWrite('status', 'at the festival')
    expect(relay.totalAppendCalls).toBe(2) // exactly one more
    expect(await phone.hash()).toBe(await laptop.hash())

    // Laptop goes offline, phone writes several entries, laptop catches up.
    laptop.goOffline()
    for (let i = 0; i < 5; i++) await phone.localWrite(`note-${i}`, `n${i}`)
    laptop.connect()
    const result = await laptop.catchUp()
    expect(result.appliedCount).toBe(5)
    expect(compareSyncHeads(laptop.localHeads(), relay.brokerHeads(docId))).toBe('consistent')
    expect(await laptop.hash()).toBe(await phone.hash())

    // A brand-new third device reconstructs the whole personal doc cold.
    const tablet = new SimClient({ author, deviceId: newUuid(), docId, relay, members, availableKeyGenerations: [] })
    await tablet.importKeyGeneration(0, material.key)
    await tablet.catchUp()
    expect(await tablet.hash()).toBe(await phone.hash())
    expect(tablet.snapshot()['display-name']).toBe('Anton')
    expect(tablet.snapshot()['status']).toBe('at the festival')

    // Per-device seq spaces are independent for the single writer.
    const seqKeys = relay.seqKeys(docId)
    const devices = new Set(seqKeys.map((k) => k.slice(0, k.lastIndexOf('|'))))
    expect(devices.has(phone.deviceId)).toBe(true)
    expect(devices.has(laptop.deviceId)).toBe(true)
  })
})
