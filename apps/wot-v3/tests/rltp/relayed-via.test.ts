// @vitest-environment node
// Whether a ceremony's link names a relay (projection.ts `relayedVia`): the library's full resolution of the
// messaging identity, did:peer:2 and the long form of did:peer:4; an identity it cannot resolve is unknown.
import { describe, expect, it } from 'vitest'
import { sharedConnect as sc } from '../../src/adapters/rltp/testing'
import { relayedVia } from '../../src/adapters/rltp/projection'

const key = (n: number) => new Uint8Array(32).fill(n)
const MED = { kind: 'tsp-mediator', address: 'did:example:mediator' }

describe('relayedVia', () => {
  it('reads did:peer:2 and the long form of did:peer:4, with and without a relay; unknown is null', async () => {
    expect(await relayedVia(sc.peer2Of(key(1), key(2), []))).toBe(false)
    expect(await relayedVia(sc.peer2Of(key(1), key(2), [MED]))).toBe(true)
    const p4 = await sc.peer4Of(key(3), key(4), [])
    expect(p4.startsWith('did:peer:4')).toBe(true)
    expect(await relayedVia(p4)).toBe(false)
    expect(await relayedVia(await sc.peer4Of(key(3), key(4), [MED]))).toBe(true)
    expect(await relayedVia('did:example:nothing')).toBeNull()
  })
})
