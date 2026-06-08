import * as ed25519 from '@noble/ed25519'
import { describe, expect, it } from 'vitest'
import {
  createAdminAddMessage,
  createAdminRemoveMessage,
  createBrokerAdminMessageSignature,
  createSpaceRotateMessage,
  deriveSpaceAdminKeyFromSeedHex,
  encodeBase64Url,
  parseAdminAddMessage,
  parseAdminRemoveMessage,
  parseSpaceRotateMessage,
  type ProtocolCryptoAdapter,
  verifyBrokerAdminMessageSignature,
} from '../src/protocol'
import { WebCryptoProtocolCryptoAdapter } from '../src/adapters/protocol-crypto'

const SPACE_ID = '7f3a2b10-4c5d-4e6f-8a7b-9c0d1e2f3a4b'
const OTHER_SPACE_ID = '11111111-2222-4333-8444-555555555555'
const NEW_PUBLIC_KEY = 'z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH'
const NEW_ADMIN_DID = 'did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH'
const REMOVED_ADMIN_DID = 'did:key:z6Mko3ZEjKJWQAM5nDXKoZ9jErvvxbWbYgS8KJXYpC5Hbu8a'
const SEED_HEX = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f'
  + '202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f'
const OTHER_SEED_HEX = 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'
  + 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'

const cryptoAdapter = new WebCryptoProtocolCryptoAdapter()

function cryptoWithVerify(
  verifyEd25519: ProtocolCryptoAdapter['verifyEd25519'],
): ProtocolCryptoAdapter {
  return {
    verifyEd25519,
    sha256: cryptoAdapter.sha256.bind(cryptoAdapter),
    hkdfSha256: cryptoAdapter.hkdfSha256.bind(cryptoAdapter),
    x25519PublicFromSeed: cryptoAdapter.x25519PublicFromSeed.bind(cryptoAdapter),
    x25519SharedSecret: cryptoAdapter.x25519SharedSecret.bind(cryptoAdapter),
    aes256GcmEncrypt: cryptoAdapter.aes256GcmEncrypt.bind(cryptoAdapter),
    aes256GcmDecrypt: cryptoAdapter.aes256GcmDecrypt.bind(cryptoAdapter),
    randomBytes: cryptoAdapter.randomBytes.bind(cryptoAdapter),
  }
}

describe('Sync 003 broker admin management messages', () => {
  it('constructs and parses only the exact management message fields with lowercase UUIDv4 spaceId', () => {
    const rotate = createSpaceRotateMessage({
      spaceId: SPACE_ID,
      newPublicKey: NEW_PUBLIC_KEY,
      newGeneration: 2,
    })
    const adminAdd = createAdminAddMessage({
      spaceId: SPACE_ID,
      newAdminDid: NEW_ADMIN_DID,
    })
    const adminRemove = createAdminRemoveMessage({
      spaceId: SPACE_ID,
      removedAdminDid: REMOVED_ADMIN_DID,
    })

    expect(rotate).toEqual({
      type: 'space-rotate',
      spaceId: SPACE_ID,
      newPublicKey: NEW_PUBLIC_KEY,
      newGeneration: 2,
    })
    expect(adminAdd).toEqual({
      type: 'admin-add',
      spaceId: SPACE_ID,
      newAdminDid: NEW_ADMIN_DID,
    })
    expect(adminRemove).toEqual({
      type: 'admin-remove',
      spaceId: SPACE_ID,
      removedAdminDid: REMOVED_ADMIN_DID,
    })

    expect(parseSpaceRotateMessage(rotate)).toEqual(rotate)
    expect(parseAdminAddMessage(adminAdd)).toEqual(adminAdd)
    expect(parseAdminRemoveMessage(adminRemove)).toEqual(adminRemove)

    expect(() => parseSpaceRotateMessage({ ...rotate, extra: true })).toThrow()
    expect(() => parseAdminAddMessage({ ...adminAdd, extra: true })).toThrow()
    expect(() => parseAdminRemoveMessage({ ...adminRemove, extra: true })).toThrow()
    expect(() => parseSpaceRotateMessage({ ...rotate, spaceId: SPACE_ID.toUpperCase() })).toThrow()
    expect(() => parseAdminAddMessage({ ...adminAdd, spaceId: '7f3a2b10-4c5d-5e6f-8a7b-9c0d1e2f3a4b' })).toThrow()
    expect(() => parseAdminRemoveMessage({ ...adminRemove, spaceId: 'not-a-uuid' })).toThrow()
  })

  it('verifies admin signatures only with the space-specific derived admin key', async () => {
    const message = createSpaceRotateMessage({
      spaceId: SPACE_ID,
      newPublicKey: NEW_PUBLIC_KEY,
      newGeneration: 2,
    })
    const adminKey = await deriveSpaceAdminKeyFromSeedHex(SEED_HEX, SPACE_ID, cryptoAdapter)
    const otherSeedAdminKey = await deriveSpaceAdminKeyFromSeedHex(OTHER_SEED_HEX, SPACE_ID, cryptoAdapter)
    const otherSpaceAdminKey = await deriveSpaceAdminKeyFromSeedHex(SEED_HEX, OTHER_SPACE_ID, cryptoAdapter)
    const signature = await createBrokerAdminMessageSignature(message, adminKey.ed25519Seed)
    const foreignSignature = encodeBase64Url(await ed25519.signAsync(
      new TextEncoder().encode('not the broker admin canonical payload'),
      otherSeedAdminKey.ed25519Seed,
    ))

    await expect(verifyBrokerAdminMessageSignature({
      message,
      signature,
      adminPublicKey: adminKey.ed25519PublicKey,
      crypto: cryptoAdapter,
    })).resolves.toMatchObject({ disposition: 'accepted' })

    await expect(verifyBrokerAdminMessageSignature({
      message,
      signature,
      adminPublicKey: otherSeedAdminKey.ed25519PublicKey,
      crypto: cryptoAdapter,
    })).resolves.toEqual({ disposition: 'rejected', errorCode: 'AUTH_INVALID' })
    await expect(verifyBrokerAdminMessageSignature({
      message,
      signature,
      adminPublicKey: otherSpaceAdminKey.ed25519PublicKey,
      crypto: cryptoAdapter,
    })).resolves.toEqual({ disposition: 'rejected', errorCode: 'AUTH_INVALID' })
    await expect(verifyBrokerAdminMessageSignature({
      message,
      signature: foreignSignature,
      adminPublicKey: adminKey.ed25519PublicKey,
      crypto: cryptoAdapter,
    })).resolves.toEqual({ disposition: 'rejected', errorCode: 'AUTH_INVALID' })
  })

  it('verifies the canonical bytes for the parsed admin message', async () => {
    const message = createAdminAddMessage({
      spaceId: SPACE_ID,
      newAdminDid: NEW_ADMIN_DID,
    })
    const adminKey = await deriveSpaceAdminKeyFromSeedHex(SEED_HEX, SPACE_ID, cryptoAdapter)
    const signature = await createBrokerAdminMessageSignature(message, adminKey.ed25519Seed)
    let observedInput: Uint8Array | undefined
    const crypto = cryptoWithVerify(async (input) => {
      observedInput = input
      return true
    })

    await expect(verifyBrokerAdminMessageSignature({
      message,
      signature,
      adminPublicKey: adminKey.ed25519PublicKey,
      crypto,
    })).resolves.toMatchObject({ disposition: 'accepted' })

    expect(new TextDecoder().decode(observedInput)).toBe(
      '{"newAdminDid":"did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH","spaceId":"7f3a2b10-4c5d-4e6f-8a7b-9c0d1e2f3a4b","type":"admin-add"}',
    )
  })
})
