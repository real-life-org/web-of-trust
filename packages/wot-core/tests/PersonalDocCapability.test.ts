import { describe, expect, it } from 'vitest'
import {
  createJcsEd25519Jws,
  createPersonalDocCapabilityJws,
  deriveProtocolIdentityFromMnemonic,
  derivePersonalDocFromSeedHex,
  deriveBip39SeedFromMnemonic,
  type PersonalDocCapabilityPayload,
  verifyPersonalDocCapabilityJws,
  verifySpaceCapabilityJws,
} from '../src/protocol'
import { WebCryptoProtocolCryptoAdapter } from '../src/adapters/protocol-crypto'
import { createTestIdentity } from './helpers/identity-session'

const cryptoAdapter = new WebCryptoProtocolCryptoAdapter()

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

function futureIso(hours: number): string {
  return new Date(Date.now() + hours * 3600_000).toISOString()
}

function pastIso(hours: number): string {
  return new Date(Date.now() - hours * 3600_000).toISOString()
}

async function ownerIdentity(passphrase: string) {
  const { mnemonic } = await createTestIdentity(passphrase)
  const id = await deriveProtocolIdentityFromMnemonic(mnemonic, cryptoAdapter)
  const seedHex = bytesToHex(await deriveBip39SeedFromMnemonic(mnemonic))
  const personalDoc = await derivePersonalDocFromSeedHex(seedHex, cryptoAdapter)
  return { ...id, docId: personalDoc.docId }
}

function personalDocPayload(
  overrides: Partial<PersonalDocCapabilityPayload> & Pick<PersonalDocCapabilityPayload, 'spaceId' | 'audience'>,
): PersonalDocCapabilityPayload {
  return {
    type: 'capability',
    permissions: ['read', 'write'],
    generation: 0,
    issuedAt: pastIso(1),
    validUntil: futureIso(24 * 365),
    ...overrides,
  }
}

describe('Sync 003 personal-doc capability (self-issued)', () => {
  it('round-trips a self-issued capability bound to the owner Identity Key + Personal-Doc-ID', async () => {
    const owner = await ownerIdentity('pd-roundtrip')
    const payload = personalDocPayload({ spaceId: owner.docId, audience: owner.did })

    const jws = await createPersonalDocCapabilityJws({
      payload,
      kid: owner.kid,
      signingSeed: owner.ed25519Seed,
    })

    const verified = await verifyPersonalDocCapabilityJws(jws, {
      crypto: cryptoAdapter,
      publicKey: owner.ed25519PublicKey,
      expectedSpaceId: owner.docId,
      expectedAudience: owner.did,
      now: new Date(),
    })
    expect(verified).toEqual(payload)
  })

  it('enforces self-issued: rejects when kid-DID != audience', async () => {
    const owner = await ownerIdentity('pd-self-owner')
    const other = await ownerIdentity('pd-self-other')

    // owner signs (kid = owner) but the payload audiences `other` -> not self-issued.
    const payload = personalDocPayload({ spaceId: owner.docId, audience: other.did })
    const jws = await createJcsEd25519Jws(
      { alg: 'EdDSA', kid: owner.kid, typ: 'wot-capability+jwt' },
      payload,
      owner.ed25519Seed,
    )

    await expect(
      verifyPersonalDocCapabilityJws(jws, {
        crypto: cryptoAdapter,
        // The broker resolves the authenticated DID (owner) to its key.
        publicKey: owner.ed25519PublicKey,
      }),
    ).rejects.toThrow(/self-issued/)
  })

  it('create factory refuses a kid whose DID != audience', async () => {
    const owner = await ownerIdentity('pd-factory-owner')
    const other = await ownerIdentity('pd-factory-other')
    await expect(
      createPersonalDocCapabilityJws({
        payload: personalDocPayload({ spaceId: owner.docId, audience: other.did }),
        kid: owner.kid,
        signingSeed: owner.ed25519Seed,
      }),
    ).rejects.toThrow()
  })

  it('rejects a space-style kid (wot:space:...) for a personal-doc capability', async () => {
    const owner = await ownerIdentity('pd-space-kid')
    const payload = personalDocPayload({ spaceId: owner.docId, audience: owner.did })
    const jws = await createJcsEd25519Jws(
      { alg: 'EdDSA', kid: `wot:space:${owner.docId}#cap-0`, typ: 'wot-capability+jwt' },
      payload,
      owner.ed25519Seed,
    )
    await expect(
      verifyPersonalDocCapabilityJws(jws, { crypto: cryptoAdapter, publicKey: owner.ed25519PublicKey }),
    ).rejects.toThrow()
  })

  it('rejects generation != 0 (personal docs are not rotated)', async () => {
    const owner = await ownerIdentity('pd-generation')
    await expect(
      createPersonalDocCapabilityJws({
        payload: personalDocPayload({ spaceId: owner.docId, audience: owner.did, generation: 1 }),
        kid: owner.kid,
        signingSeed: owner.ed25519Seed,
      }),
    ).rejects.toThrow(/generation/)
  })

  it('rejects an expired capability and a spaceId/audience context mismatch', async () => {
    const owner = await ownerIdentity('pd-context')
    const expired = await createPersonalDocCapabilityJws({
      payload: personalDocPayload({
        spaceId: owner.docId,
        audience: owner.did,
        issuedAt: pastIso(48),
        validUntil: pastIso(1),
      }),
      kid: owner.kid,
      signingSeed: owner.ed25519Seed,
    })
    await expect(
      verifyPersonalDocCapabilityJws(expired, {
        crypto: cryptoAdapter,
        publicKey: owner.ed25519PublicKey,
        now: new Date(),
      }),
    ).rejects.toThrow(/expired/)

    const valid = await createPersonalDocCapabilityJws({
      payload: personalDocPayload({ spaceId: owner.docId, audience: owner.did }),
      kid: owner.kid,
      signingSeed: owner.ed25519Seed,
    })
    await expect(
      verifyPersonalDocCapabilityJws(valid, {
        crypto: cryptoAdapter,
        publicKey: owner.ed25519PublicKey,
        expectedSpaceId: '7f3a2b10-4c5d-4e6f-8a7b-9c0d1e2f3a4b',
      }),
    ).rejects.toThrow(/spaceId mismatch/)
  })

  it('rejects a signature that does not match the resolved Identity Key', async () => {
    const owner = await ownerIdentity('pd-sig-owner')
    const attacker = await ownerIdentity('pd-sig-attacker')
    // owner signs a self-issued capability for itself...
    const jws = await createPersonalDocCapabilityJws({
      payload: personalDocPayload({ spaceId: owner.docId, audience: owner.did }),
      kid: owner.kid,
      signingSeed: owner.ed25519Seed,
    })
    // ...but the broker verifies against the wrong (attacker's) public key.
    await expect(
      verifyPersonalDocCapabilityJws(jws, {
        crypto: cryptoAdapter,
        publicKey: attacker.ed25519PublicKey,
      }),
    ).rejects.toThrow(/signature/i)
  })

  it('shares the exact payload schema with the space capability verifier', async () => {
    // A personal-doc capability payload is structurally a valid Capability
    // payload; verifying it with the space verifier fails only on the kid shape,
    // confirming the payload schema is identical (no separate payload type).
    const owner = await ownerIdentity('pd-shared-schema')
    const jws = await createPersonalDocCapabilityJws({
      payload: personalDocPayload({ spaceId: owner.docId, audience: owner.did }),
      kid: owner.kid,
      signingSeed: owner.ed25519Seed,
    })
    await expect(
      verifySpaceCapabilityJws(jws, { crypto: cryptoAdapter, publicKey: owner.ed25519PublicKey }),
    ).rejects.toThrow(/kid/)
  })
})
