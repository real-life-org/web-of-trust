import { describe, it, expect } from 'vitest'
import {
  createCapability,
  verifyCapability,
  delegateCapability,
  extractCapability,
} from '../src/crypto/capabilities'
import { createResourceRef } from '../src/types/resource-ref'
import { WotIdentity } from '../src/identity/WotIdentity'

function futureDate(hours: number): string {
  return new Date(Date.now() + hours * 60 * 60 * 1000).toISOString()
}

function pastDate(hours: number): string {
  return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString()
}

/** Create a sign function from a WotIdentity */
function signFn(identity: WotIdentity) {
  return (payload: unknown) => identity.signJws(payload)
}

describe('Capability Primitives', () => {
  let alice: WotIdentity
  let bob: WotIdentity
  let carl: WotIdentity

  const spaceResource = createResourceRef('space', 'test-space-123')

  const setup = async () => {
    if (alice) return
    alice = new WotIdentity()
    await alice.create('alice-pass', false)
    bob = new WotIdentity()
    await bob.create('bob-pass', false)
    carl = new WotIdentity()
    await carl.create('carl-pass', false)
  }

  describe('createCapability', () => {
    it('should create a signed capability', async () => {
      await setup()

      const jws = await createCapability(
        {
          issuer: alice.getDid(),
          audience: bob.getDid(),
          resource: spaceResource,
          permissions: ['read', 'write'],
          expiration: futureDate(24),
        },
        signFn(alice),
      )

      expect(typeof jws).toBe('string')
      expect(jws.split('.')).toHaveLength(3)

      const cap = extractCapability(jws)
      expect(cap).not.toBeNull()
      expect(cap!.issuer).toBe(alice.getDid())
      expect(cap!.audience).toBe(bob.getDid())
      expect(cap!.resource).toBe(spaceResource)
      expect(cap!.permissions).toEqual(['read', 'write'])
    })

    it('should sort permissions', async () => {
      await setup()

      const jws = await createCapability(
        {
          issuer: alice.getDid(),
          audience: bob.getDid(),
          resource: spaceResource,
          permissions: ['write', 'delegate', 'read'],
          expiration: futureDate(24),
        },
        signFn(alice),
      )

      const cap = extractCapability(jws)
      expect(cap!.permissions).toEqual(['delegate', 'read', 'write'])
    })

    it('should generate unique IDs', async () => {
      await setup()

      const params = {
        issuer: alice.getDid(),
        audience: bob.getDid(),
        resource: spaceResource,
        permissions: ['read'] as const,
        expiration: futureDate(24),
      }

      const jws1 = await createCapability(params, signFn(alice))
      const jws2 = await createCapability(params, signFn(alice))

      expect(extractCapability(jws1)!.id).not.toBe(extractCapability(jws2)!.id)
    })
  })

  describe('verifyCapability', () => {
    it('should verify a valid capability', async () => {
      await setup()

      const jws = await createCapability(
        {
          issuer: alice.getDid(),
          audience: bob.getDid(),
          resource: spaceResource,
          permissions: ['read', 'write'],
          expiration: futureDate(24),
        },
        signFn(alice),
      )

      const result = await verifyCapability(jws)
      expect(result.valid).toBe(true)
      if (result.valid) {
        expect(result.capability.issuer).toBe(alice.getDid())
        expect(result.capability.audience).toBe(bob.getDid())
        expect(result.chain).toHaveLength(0)
      }
    })

    it('should reject expired capability', async () => {
      await setup()

      const jws = await createCapability(
        {
          issuer: alice.getDid(),
          audience: bob.getDid(),
          resource: spaceResource,
          permissions: ['read'],
          expiration: pastDate(1),
        },
        signFn(alice),
      )

      const result = await verifyCapability(jws)
      expect(result.valid).toBe(false)
      if (!result.valid) {
        expect(result.error).toContain('expired')
      }
    })

    it('should reject tampered capability', async () => {
      await setup()

      const jws = await createCapability(
        {
          issuer: alice.getDid(),
          audience: bob.getDid(),
          resource: spaceResource,
          permissions: ['read'],
          expiration: futureDate(24),
        },
        signFn(alice),
      )

      // Tamper with the payload
      const parts = jws.split('.')
      const tamperedPayload = parts[1].slice(0, -2) + 'XX'
      const tampered = `${parts[0]}.${tamperedPayload}.${parts[2]}`

      const result = await verifyCapability(tampered)
      expect(result.valid).toBe(false)
    })

    it('should reject capability signed by wrong key', async () => {
      await setup()

      // Create capability claiming Bob as issuer but signed by Alice
      const jws = await createCapability(
        {
          issuer: bob.getDid(),
          audience: carl.getDid(),
          resource: spaceResource,
          permissions: ['read'],
          expiration: futureDate(24),
        },
        signFn(alice), // Wrong signer!
      )

      const result = await verifyCapability(jws)
      expect(result.valid).toBe(false)
      if (!result.valid) {
        expect(result.error).toContain('signature')
      }
    })
  })

  describe('delegateCapability', () => {
    it('should delegate with attenuation', async () => {
      await setup()

      // Alice grants Bob read+write+delegate
      const aliceToBob = await createCapability(
        {
          issuer: alice.getDid(),
          audience: bob.getDid(),
          resource: spaceResource,
          permissions: ['read', 'write', 'delegate'],
          expiration: futureDate(24),
        },
        signFn(alice),
      )

      // Bob delegates read-only to Carl
      const bobToCarl = await delegateCapability(
        aliceToBob,
        {
          audience: carl.getDid(),
          permissions: ['read'],
          expiration: futureDate(12),
        },
        signFn(bob),
      )

      const result = await verifyCapability(bobToCarl)
      expect(result.valid).toBe(true)
      if (result.valid) {
        expect(result.capability.issuer).toBe(bob.getDid())
        expect(result.capability.audience).toBe(carl.getDid())
        expect(result.capability.permissions).toEqual(['read'])
        expect(result.capability.resource).toBe(spaceResource)
        // Chain contains Alice's original
        expect(result.chain).toHaveLength(1)
        expect(result.chain[0].issuer).toBe(alice.getDid())
      }
    })

    it('should reject permission escalation', async () => {
      await setup()

      // Alice grants Bob read-only (no delegate)
      const aliceToBob = await createCapability(
        {
          issuer: alice.getDid(),
          audience: bob.getDid(),
          resource: spaceResource,
          permissions: ['read'],
          expiration: futureDate(24),
        },
        signFn(alice),
      )

      // Bob tries to delegate write — should fail (no delegate permission)
      await expect(
        delegateCapability(
          aliceToBob,
          {
            audience: carl.getDid(),
            permissions: ['read', 'write'],
            expiration: futureDate(12),
          },
          signFn(bob),
        ),
      ).rejects.toThrow('delegate')
    })

    it('should reject delegation without delegate permission', async () => {
      await setup()

      const aliceToBob = await createCapability(
        {
          issuer: alice.getDid(),
          audience: bob.getDid(),
          resource: spaceResource,
          permissions: ['read', 'write'],
          expiration: futureDate(24),
        },
        signFn(alice),
      )

      await expect(
        delegateCapability(
          aliceToBob,
          {
            audience: carl.getDid(),
            permissions: ['read'],
            expiration: futureDate(12),
          },
          signFn(bob),
        ),
      ).rejects.toThrow('delegate')
    })

    it('should reject delegation with later expiration', async () => {
      await setup()

      const aliceToBob = await createCapability(
        {
          issuer: alice.getDid(),
          audience: bob.getDid(),
          resource: spaceResource,
          permissions: ['read', 'delegate'],
          expiration: futureDate(12),
        },
        signFn(alice),
      )

      await expect(
        delegateCapability(
          aliceToBob,
          {
            audience: carl.getDid(),
            permissions: ['read'],
            expiration: futureDate(48),
          },
          signFn(bob),
        ),
      ).rejects.toThrow('expire')
    })

    it('should support multi-level delegation chains', async () => {
      await setup()
      const dave = new WotIdentity()
      await dave.create('dave-pass', false)

      // Alice → Bob → Carl → Dave
      const aliceToBob = await createCapability(
        {
          issuer: alice.getDid(),
          audience: bob.getDid(),
          resource: spaceResource,
          permissions: ['read', 'write', 'delegate'],
          expiration: futureDate(24),
        },
        signFn(alice),
      )

      const bobToCarl = await delegateCapability(
        aliceToBob,
        {
          audience: carl.getDid(),
          permissions: ['read', 'write', 'delegate'],
          expiration: futureDate(20),
        },
        signFn(bob),
      )

      const carlToDave = await delegateCapability(
        bobToCarl,
        {
          audience: dave.getDid(),
          permissions: ['read'],
          expiration: futureDate(16),
        },
        signFn(carl),
      )

      const result = await verifyCapability(carlToDave)
      expect(result.valid).toBe(true)
      if (result.valid) {
        expect(result.capability.audience).toBe(dave.getDid())
        expect(result.capability.permissions).toEqual(['read'])
        // Chain: [Alice's cap, Bob's cap]
        expect(result.chain).toHaveLength(2)
        expect(result.chain[0].issuer).toBe(alice.getDid())
        expect(result.chain[1].issuer).toBe(bob.getDid())
      }
    })

    it('should reject broken delegation chain (wrong signer)', async () => {
      await setup()

      const aliceToBob = await createCapability(
        {
          issuer: alice.getDid(),
          audience: bob.getDid(),
          resource: spaceResource,
          permissions: ['read', 'write', 'delegate'],
          expiration: futureDate(24),
        },
        signFn(alice),
      )

      // Carl signs instead of Bob — issuer will be bob.getDid() (from parent.audience)
      // but signature is Carl's key, which won't match bob's DID
      const fakeDelegate = await delegateCapability(
        aliceToBob,
        {
          audience: carl.getDid(),
          permissions: ['read'],
          expiration: futureDate(12),
        },
        signFn(carl), // Wrong! Should be Bob
      )

      const result = await verifyCapability(fakeDelegate)
      expect(result.valid).toBe(false)
      if (!result.valid) {
        expect(result.error).toContain('signature')
      }
    })
  })

  describe('extractCapability', () => {
    it('should extract capability from valid JWS', async () => {
      await setup()

      const jws = await createCapability(
        {
          issuer: alice.getDid(),
          audience: bob.getDid(),
          resource: spaceResource,
          permissions: ['read'],
          expiration: futureDate(24),
        },
        signFn(alice),
      )

      const cap = extractCapability(jws)
      expect(cap).not.toBeNull()
      expect(cap!.issuer).toBe(alice.getDid())
    })

    it('should return null for invalid input', () => {
      expect(extractCapability('not-a-jws')).toBeNull()
      expect(extractCapability('')).toBeNull()
    })
  })
})
