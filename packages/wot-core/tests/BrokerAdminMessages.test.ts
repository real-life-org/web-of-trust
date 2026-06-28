import * as ed25519 from '@noble/ed25519'
import { describe, expect, it } from 'vitest'
import {
  createAdminAddMessage,
  createAdminRemoveMessage,
  createJcsEd25519Jws,
  createSpaceRegisterMessage,
  createSpaceRotateMessage,
  decodeJws,
  deriveSpaceAdminKeyFromSeedHex,
  parseAdminAddMessage,
  parseAdminRemoveMessage,
  parseBrokerAdminMessage,
  parseSpaceRegisterMessage,
  parseSpaceRotateMessage,
  type ProtocolCryptoAdapter,
  verifyAdminAddMessage,
  verifyAdminRemoveMessage,
  verifySpaceRegisterMessage,
  verifySpaceRotateMessage,
} from '../src/protocol'
import { WebCryptoProtocolCryptoAdapter } from '../src/adapters/protocol-crypto'

const SPACE_ID = '7f3a2b10-4c5d-4e6f-8a7b-9c0d1e2f3a4b'
const OTHER_SPACE_ID = '11111111-2222-4333-8444-555555555555'
const NEW_VERIFICATION_KEY = 'kQ5n8mWf0aZ2bX3cYd4eRfGhIjKlMnOpQrStUvWxYz0'
const NEW_ADMIN_DID = 'did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH'
const REMOVED_ADMIN_DID = 'did:key:z6Mko3ZEjKJWQAM5nDXKoZ9jErvvxbWbYgS8KJXYpC5Hbu8a'
const SEED_HEX = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f'
  + '202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f'
const OTHER_SEED_HEX = 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'
  + 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'

const cryptoAdapter = new WebCryptoProtocolCryptoAdapter()

async function adminKeys(seedHex: string, spaceId: string) {
  const key = await deriveSpaceAdminKeyFromSeedHex(seedHex, spaceId, cryptoAdapter)
  return { ...key, kid: `${key.did}#sig-0` }
}

describe('Sync 003 broker admin management Control-Frames (inner-JWS)', () => {
  it('space-register: round-trips the closed outer frame + field-exact inner payload', async () => {
    const admin = await adminKeys(SEED_HEX, SPACE_ID)
    const frame = await createSpaceRegisterMessage({
      spaceId: SPACE_ID,
      spaceCapabilityVerificationKey: NEW_VERIFICATION_KEY,
      adminDids: [admin.did],
      kid: admin.kid,
      signingSeed: admin.ed25519Seed,
    })

    expect(Object.keys(frame).sort()).toEqual(['registrationJws', 'type'])
    expect(frame.type).toBe('space-register')

    const parsed = parseSpaceRegisterMessage(frame)
    expect(parsed.payload).toEqual({
      type: 'space-register',
      spaceId: SPACE_ID,
      spaceCapabilityVerificationKey: NEW_VERIFICATION_KEY,
      adminDids: [admin.did],
    })
    expect(decodeJws(frame.registrationJws).header.kid).toBe(admin.kid)

    await expect(
      verifySpaceRegisterMessage({ frame, crypto: cryptoAdapter }),
    ).resolves.toMatchObject({ disposition: 'accepted', payload: parsed.payload })
  })

  it('space-register: TOFU accepts a kid that is one of adminDids and rejects a non-listed signer', async () => {
    const admin = await adminKeys(SEED_HEX, SPACE_ID)
    const outsider = await adminKeys(OTHER_SEED_HEX, SPACE_ID)

    // kid is admin (listed) but admin set also contains a second DID -> accepted.
    const frame = await createSpaceRegisterMessage({
      spaceId: SPACE_ID,
      spaceCapabilityVerificationKey: NEW_VERIFICATION_KEY,
      adminDids: [admin.did, outsider.did],
      kid: admin.kid,
      signingSeed: admin.ed25519Seed,
    })
    await expect(
      verifySpaceRegisterMessage({ frame, crypto: cryptoAdapter }),
    ).resolves.toMatchObject({ disposition: 'accepted' })

    // Factory refuses a kid whose DID is not in adminDids (self-asserting TOFU).
    await expect(
      createSpaceRegisterMessage({
        spaceId: SPACE_ID,
        spaceCapabilityVerificationKey: NEW_VERIFICATION_KEY,
        adminDids: [outsider.did],
        kid: admin.kid,
        signingSeed: admin.ed25519Seed,
      }),
    ).rejects.toThrow()

    // A frame whose inner-JWS signer (kid-DID) is not among the payload's
    // self-asserted adminDids is rejected at verification with AUTH_INVALID.
    // Build it by signing the payload directly (bypassing the factory guard):
    const payload = {
      type: 'space-register' as const,
      spaceId: SPACE_ID,
      spaceCapabilityVerificationKey: NEW_VERIFICATION_KEY,
      adminDids: [outsider.did],
    }
    const registrationJws = await createJcsEd25519Jws(
      { alg: 'EdDSA', kid: admin.kid },
      payload,
      admin.ed25519Seed,
    )
    const nonListedFrame = { type: 'space-register' as const, registrationJws }
    // Structurally valid (parses fine), but signer kid-DID (admin) is not in
    // adminDids ([outsider]).
    expect(parseSpaceRegisterMessage(nonListedFrame).payload.adminDids).toEqual([outsider.did])
    await expect(
      verifySpaceRegisterMessage({ frame: nonListedFrame, crypto: cryptoAdapter }),
    ).resolves.toEqual({ disposition: 'rejected', errorCode: 'AUTH_INVALID' })
  })

  it('space-register: idempotent (identical) vs divergent recognition at the primitive level', async () => {
    const admin = await adminKeys(SEED_HEX, SPACE_ID)
    const first = parseSpaceRegisterMessage(
      await createSpaceRegisterMessage({
        spaceId: SPACE_ID,
        spaceCapabilityVerificationKey: NEW_VERIFICATION_KEY,
        adminDids: [admin.did],
        kid: admin.kid,
        signingSeed: admin.ed25519Seed,
      }),
    )
    const identical = parseSpaceRegisterMessage(
      await createSpaceRegisterMessage({
        spaceId: SPACE_ID,
        spaceCapabilityVerificationKey: NEW_VERIFICATION_KEY,
        adminDids: [admin.did],
        kid: admin.kid,
        signingSeed: admin.ed25519Seed,
      }),
    )
    const divergentKey = parseSpaceRegisterMessage(
      await createSpaceRegisterMessage({
        spaceId: SPACE_ID,
        spaceCapabilityVerificationKey: 'DIFFERENT0000000000000000000000000000000000',
        adminDids: [admin.did],
        kid: admin.kid,
        signingSeed: admin.ed25519Seed,
      }),
    )

    // Same spaceId; content-equality is decidable from the parsed payload (the
    // broker uses exactly this comparison for first-writer-wins).
    expect(first.payload.spaceId).toBe(identical.payload.spaceId)
    expect(first.payload).toEqual(identical.payload)
    expect(first.payload).not.toEqual(divergentKey.payload)
    expect(first.payload.spaceCapabilityVerificationKey)
      .not.toBe(divergentKey.payload.spaceCapabilityVerificationKey)
  })

  it('space-rotate: round-trips with newSpaceCapabilityVerificationKey + verifies only against the signing admin', async () => {
    const admin = await adminKeys(SEED_HEX, SPACE_ID)
    const otherSeedAdmin = await adminKeys(OTHER_SEED_HEX, SPACE_ID)
    const otherSpaceAdmin = await adminKeys(SEED_HEX, OTHER_SPACE_ID)

    const frame = await createSpaceRotateMessage({
      spaceId: SPACE_ID,
      newSpaceCapabilityVerificationKey: NEW_VERIFICATION_KEY,
      newGeneration: 2,
      kid: admin.kid,
      signingSeed: admin.ed25519Seed,
    })

    expect(Object.keys(frame).sort()).toEqual(['rotationJws', 'type'])
    const parsed = parseSpaceRotateMessage(frame)
    expect(parsed.payload).toEqual({
      type: 'space-rotate',
      spaceId: SPACE_ID,
      newSpaceCapabilityVerificationKey: NEW_VERIFICATION_KEY,
      newGeneration: 2,
    })

    await expect(
      verifySpaceRotateMessage({
        frame,
        adminDid: admin.did,
        adminPublicKey: admin.ed25519PublicKey,
        crypto: cryptoAdapter,
      }),
    ).resolves.toMatchObject({ disposition: 'accepted', payload: parsed.payload })

    // Wrong signer key (different seed, same space) -> AUTH_INVALID.
    await expect(
      verifySpaceRotateMessage({
        frame,
        adminDid: otherSeedAdmin.did,
        adminPublicKey: otherSeedAdmin.ed25519PublicKey,
        crypto: cryptoAdapter,
      }),
    ).resolves.toEqual({ disposition: 'rejected', errorCode: 'AUTH_INVALID' })

    // Right key but caller asserts a different registered admin DID than the
    // kid -> AUTH_INVALID (kid-DID binding).
    await expect(
      verifySpaceRotateMessage({
        frame,
        adminDid: otherSpaceAdmin.did,
        adminPublicKey: admin.ed25519PublicKey,
        crypto: cryptoAdapter,
      }),
    ).resolves.toEqual({ disposition: 'rejected', errorCode: 'AUTH_INVALID' })
  })

  it('admin-add / admin-remove: round-trip + reject on wrong signer', async () => {
    const admin = await adminKeys(SEED_HEX, SPACE_ID)
    const wrongAdmin = await adminKeys(OTHER_SEED_HEX, SPACE_ID)

    const addFrame = await createAdminAddMessage({
      spaceId: SPACE_ID,
      newAdminDid: NEW_ADMIN_DID,
      kid: admin.kid,
      signingSeed: admin.ed25519Seed,
    })
    const removeFrame = await createAdminRemoveMessage({
      spaceId: SPACE_ID,
      removedAdminDid: REMOVED_ADMIN_DID,
      kid: admin.kid,
      signingSeed: admin.ed25519Seed,
    })

    expect(Object.keys(addFrame).sort()).toEqual(['adminChangeJws', 'type'])
    expect(Object.keys(removeFrame).sort()).toEqual(['adminChangeJws', 'type'])
    expect(parseAdminAddMessage(addFrame).payload).toEqual({
      type: 'admin-add',
      spaceId: SPACE_ID,
      newAdminDid: NEW_ADMIN_DID,
    })
    expect(parseAdminRemoveMessage(removeFrame).payload).toEqual({
      type: 'admin-remove',
      spaceId: SPACE_ID,
      removedAdminDid: REMOVED_ADMIN_DID,
    })

    await expect(
      verifyAdminAddMessage({
        frame: addFrame,
        adminDid: admin.did,
        adminPublicKey: admin.ed25519PublicKey,
        crypto: cryptoAdapter,
      }),
    ).resolves.toMatchObject({ disposition: 'accepted' })
    await expect(
      verifyAdminRemoveMessage({
        frame: removeFrame,
        adminDid: admin.did,
        adminPublicKey: admin.ed25519PublicKey,
        crypto: cryptoAdapter,
      }),
    ).resolves.toMatchObject({ disposition: 'accepted' })

    await expect(
      verifyAdminAddMessage({
        frame: addFrame,
        adminDid: wrongAdmin.did,
        adminPublicKey: wrongAdmin.ed25519PublicKey,
        crypto: cryptoAdapter,
      }),
    ).resolves.toEqual({ disposition: 'rejected', errorCode: 'AUTH_INVALID' })
    await expect(
      verifyAdminRemoveMessage({
        frame: removeFrame,
        adminDid: wrongAdmin.did,
        adminPublicKey: wrongAdmin.ed25519PublicKey,
        crypto: cryptoAdapter,
      }),
    ).resolves.toEqual({ disposition: 'rejected', errorCode: 'AUTH_INVALID' })
  })

  it('rejects extra / wrong outer keys and non-canonical / divergent inner fields', async () => {
    const admin = await adminKeys(SEED_HEX, SPACE_ID)
    const rotate = await createSpaceRotateMessage({
      spaceId: SPACE_ID,
      newSpaceCapabilityVerificationKey: NEW_VERIFICATION_KEY,
      newGeneration: 1,
      kid: admin.kid,
      signingSeed: admin.ed25519Seed,
    })

    expect(() => parseSpaceRotateMessage({ ...rotate, extra: true })).toThrow()
    expect(() => parseSpaceRotateMessage({ type: 'space-rotate' })).toThrow()
    expect(() => parseSpaceRotateMessage({ type: 'space-rotate', rotationJws: 'not.a' })).toThrow()
    // Old detached/plaintext shape (newPublicKey + newGeneration as plain JSON)
    // is no longer a valid frame.
    expect(() =>
      parseSpaceRotateMessage({
        type: 'space-rotate',
        spaceId: SPACE_ID,
        newPublicKey: NEW_VERIFICATION_KEY,
        newGeneration: 1,
      }),
    ).toThrow()

    // dispatcher narrows by type and returns the closed outer frame
    expect(parseBrokerAdminMessage(rotate)).toEqual(rotate)
    expect(() => parseBrokerAdminMessage({ type: 'nope' })).toThrow()
  })

  it('malformed inner JWS -> MALFORMED_MESSAGE, never AUTH_INVALID', async () => {
    const admin = await adminKeys(SEED_HEX, SPACE_ID)
    await expect(
      verifySpaceRotateMessage({
        frame: { type: 'space-rotate', rotationJws: 'aaa.bbb.ccc' },
        adminDid: admin.did,
        adminPublicKey: admin.ed25519PublicKey,
        crypto: cryptoAdapter,
      }),
    ).resolves.toEqual({ disposition: 'rejected', errorCode: 'MALFORMED_MESSAGE' })
  })

  it('canonical inner-JWS payload bytes follow JCS field ordering', async () => {
    const admin = await adminKeys(SEED_HEX, SPACE_ID)
    const frame = await createAdminAddMessage({
      spaceId: SPACE_ID,
      newAdminDid: NEW_ADMIN_DID,
      kid: admin.kid,
      signingSeed: admin.ed25519Seed,
    })
    const decoded = decodeJws(frame.adminChangeJws)
    const payloadJson = new TextDecoder().decode(
      Uint8Array.from(Buffer.from(frame.adminChangeJws.split('.')[1], 'base64url')),
    )
    expect(payloadJson).toBe(
      `{"newAdminDid":"${NEW_ADMIN_DID}","spaceId":"${SPACE_ID}","type":"admin-add"}`,
    )
    expect(decoded.header.alg).toBe('EdDSA')

    // Signature actually verifies against the derived admin key (sanity that the
    // inner JWS was signed over the canonical bytes).
    const ok = await ed25519.verifyAsync(decoded.signature, decoded.signingInput, admin.ed25519PublicKey)
    expect(ok).toBe(true)
  })
})
