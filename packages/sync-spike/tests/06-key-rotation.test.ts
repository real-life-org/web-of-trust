import { describe, it, expect } from 'vitest'
import { SimRelay } from '../src/sim-relay.js'
import { SimClient } from '../src/sim-client.js'
import { makeAuthorFromLabel, newUuid, deriveSpaceContentKey } from '../src/identity.js'
import { classifyLogEntryKeyDisposition } from '@web_of_trust/core/protocol'

/**
 * Key rotation: entries under keyGeneration 0, then rotate to generation 1 (new
 * Space Content Key). A client lacking the gen-1 key -> classifyLogEntryKeyDisposition
 * -> blocked-by-key -> buffer. After importKeyGeneration(1,key) -> replay buffered
 * -> decrypt -> converge.
 */

describe('06 key rotation', () => {
  it('blocked-by-key entries are buffered then replayed after key import', async () => {
    const relay = new SimRelay('durable-log')
    const docId = newUuid()
    const authorA = await makeAuthorFromLabel('kr-A')
    const authorB = await makeAuthorFromLabel('kr-B')
    const members = [authorA.did, authorB.did]

    // A holds gen 0 and (later) gen 1. B starts with only gen 0.
    const a = new SimClient({
      author: authorA,
      deviceId: newUuid(),
      docId,
      relay,
      members,
      availableKeyGenerations: [0, 1],
      keyGeneration: 0,
    })
    const b = new SimClient({
      author: authorB,
      deviceId: newUuid(),
      docId,
      relay,
      members,
      availableKeyGenerations: [0],
      keyGeneration: 0,
    })
    a.connect(); b.connect()

    // Gen-0 write: both can read.
    await a.localWrite('intro', 'hello-gen0')
    expect(await b.hash()).toBe(await a.hash())

    // Sanity on the classifier itself.
    expect(classifyLogEntryKeyDisposition({ keyGeneration: 1, availableKeyGenerations: [0] })).toBe('blocked-by-key')
    expect(classifyLogEntryKeyDisposition({ keyGeneration: 1, availableKeyGenerations: [0, 1] })).toBe('process-decrypt')

    // ROTATE: A switches to gen 1 and writes. B lacks the gen-1 key.
    a.setActiveKeyGeneration(1)
    const r = await a.localWrite('secret', 'top-secret-gen1')
    expect(r.appendResult.disposition).toBe('accept-new-entry')

    // B received the gen-1 entry but could not decrypt it -> buffered, NOT applied.
    expect(b.snapshot()).toEqual({ intro: 'hello-gen0' })
    expect(await b.hash()).not.toBe(await a.hash())

    // B imports the gen-1 Space Content Key -> buffered entries replay -> converge.
    const gen1Key = await deriveSpaceContentKey(docId, 1)
    await b.importKeyGeneration(1, gen1Key)
    expect(b.snapshot()).toEqual({ intro: 'hello-gen0', secret: 'top-secret-gen1' })
    expect(await b.hash()).toBe(await a.hash())
  })

  it('a cold client with only the new key still catches up old generations once keys are present', async () => {
    const relay = new SimRelay('durable-log')
    const docId = newUuid()
    const authorA = await makeAuthorFromLabel('kr2-A')
    const authorB = await makeAuthorFromLabel('kr2-B')
    const members = [authorA.did, authorB.did]

    const a = new SimClient({
      author: authorA,
      deviceId: newUuid(),
      docId,
      relay,
      members,
      availableKeyGenerations: [0, 1],
    })
    a.connect()
    await a.localWrite('a', 'gen0-a')
    a.setActiveKeyGeneration(1)
    await a.localWrite('b', 'gen1-b')
    const target = await a.hash()

    // Fresh client starts WITHOUT any keys; catch-up buffers everything by key.
    const fresh = new SimClient({
      author: authorB,
      deviceId: newUuid(),
      docId,
      relay,
      members,
      availableKeyGenerations: [],
    })
    const result = await fresh.catchUp()
    expect(result.appliedCount).toBe(0) // all blocked-by-key, buffered
    expect(fresh.snapshot()).toEqual({})

    // Import both keys -> replay -> converge.
    await fresh.importKeyGeneration(0, await deriveSpaceContentKey(docId, 0))
    await fresh.importKeyGeneration(1, await deriveSpaceContentKey(docId, 1))
    expect(await fresh.hash()).toBe(target)
  })
})
