import { describe, expect, it } from 'vitest'
import {
  createPersonalDocCapabilityJws,
  decodeJws,
  derivePersonalDocFromSeedHex,
  deriveProtocolIdentityFromSeedHex,
  verifyPersonalDocCapabilityJws,
} from '../src/protocol'
import { WebCryptoProtocolCryptoAdapter } from '../src/protocol-adapters'

const cryptoAdapter = new WebCryptoProtocolCryptoAdapter()

const ALICE_BIP39_SEED_HEX =
  '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f' +
  '202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f'
const BOB_BIP39_SEED_HEX =
  '404142434445464748494a4b4c4d4e4f505152535455565758595a5b5c5d5e5f' +
  '606162636465666768696a6b6c6d6e6f707172737475767778797a7b7c7d7e7f'

describe('personal document capability JWS', () => {
  it('accepts self-issued identity-key capabilities for a Personal Doc ID and rejects foreign audiences', async () => {
    const alice = await deriveProtocolIdentityFromSeedHex(ALICE_BIP39_SEED_HEX, cryptoAdapter)
    const bob = await deriveProtocolIdentityFromSeedHex(BOB_BIP39_SEED_HEX, cryptoAdapter)
    const personalDoc = await derivePersonalDocFromSeedHex(ALICE_BIP39_SEED_HEX, cryptoAdapter)
    const payload = {
      type: 'capability',
      personalDocId: personalDoc.docId,
      audience: alice.did,
      permissions: ['read', 'write'],
      generation: 0,
      issuedAt: '2026-06-03T12:00:00Z',
      validUntil: '2026-06-04T12:00:00Z',
    } as const

    const acceptedJws = await createPersonalDocCapabilityJws({
      payload,
      signingSeed: alice.ed25519Seed,
    })

    expect(decodeJws(acceptedJws).header).toMatchObject({
      kid: `wot:personal-doc:${personalDoc.docId}#cap-0`,
      typ: 'wot-capability+jwt',
    })
    await expect(
      verifyPersonalDocCapabilityJws(acceptedJws, {
        crypto: cryptoAdapter,
        publicKey: alice.ed25519PublicKey,
        expectedPersonalDocId: personalDoc.docId,
        now: new Date('2026-06-03T12:30:00Z'),
      }),
    ).resolves.toEqual(payload)

    const rejectedJws = await createPersonalDocCapabilityJws({
      payload: { ...payload, audience: bob.did },
      signingSeed: alice.ed25519Seed,
    })

    await expect(
      verifyPersonalDocCapabilityJws(rejectedJws, {
        crypto: cryptoAdapter,
        publicKey: alice.ed25519PublicKey,
        expectedPersonalDocId: personalDoc.docId,
        now: new Date('2026-06-03T12:30:00Z'),
      }),
    ).rejects.toThrow('Personal Doc capability audience must match signing DID')
  })
})
