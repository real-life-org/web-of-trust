import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { VaultServer } from '../src/server'
import { WotIdentity } from '@web.of.trust/core'
import {
  createCapability,
  createResourceRef,
} from '@web.of.trust/core'

const PORT = 18789 // Test port

describe('VaultServer', () => {
  let server: VaultServer
  let alice: WotIdentity
  let bob: WotIdentity
  let aliceToken: string
  let bobToken: string
  let aliceCapability: string
  let bobCapability: string
  const docId = 'test-doc-123'
  const resource = createResourceRef('space', docId)

  beforeAll(async () => {
    server = new VaultServer({ port: PORT, dbPath: ':memory:' })
    await server.start()

    // Create identities
    alice = new WotIdentity()
    await alice.create('alice-pass', false)
    bob = new WotIdentity()
    await bob.create('bob-pass', false)

    // Create auth tokens
    aliceToken = await alice.signJws({
      did: alice.getDid(),
      iat: Math.floor(Date.now() / 1000),
    })
    bobToken = await bob.signJws({
      did: bob.getDid(),
      iat: Math.floor(Date.now() / 1000),
    })

    // Alice creates capabilities (she's the space creator)
    const signFn = (payload: unknown) => alice.signJws(payload)
    const expiration = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()

    aliceCapability = await createCapability(
      {
        issuer: alice.getDid(),
        audience: alice.getDid(),
        resource,
        permissions: ['read', 'write', 'delete', 'delegate'],
        expiration,
      },
      signFn,
    )

    bobCapability = await createCapability(
      {
        issuer: alice.getDid(),
        audience: bob.getDid(),
        resource,
        permissions: ['read', 'write'],
        expiration,
      },
      signFn,
    )
  })

  afterAll(async () => {
    await server.stop()
  })

  const baseUrl = `http://localhost:${PORT}`

  describe('Health check', () => {
    it('should return 200', async () => {
      const res = await fetch(`${baseUrl}/health`)
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.status).toBe('ok')
    })
  })

  describe('POST /docs/{docId}/changes', () => {
    it('should reject without auth', async () => {
      const res = await fetch(`${baseUrl}/docs/${docId}/changes`, {
        method: 'POST',
        body: 'encrypted-data',
      })
      expect(res.status).toBe(401)
    })

    it('should reject without capability', async () => {
      const res = await fetch(`${baseUrl}/docs/${docId}/changes`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${aliceToken}` },
        body: 'encrypted-data',
      })
      expect(res.status).toBe(403)
    })

    it('should append a change with valid auth', async () => {
      const res = await fetch(`${baseUrl}/docs/${docId}/changes`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${aliceToken}`,
          'X-Capability': aliceCapability,
        },
        body: 'encrypted-change-1',
      })
      expect(res.status).toBe(201)
      const body = await res.json()
      expect(body.seq).toBe(1)
      expect(body.docId).toBe(docId)
    })

    it('should allow Bob with his capability', async () => {
      const res = await fetch(`${baseUrl}/docs/${docId}/changes`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${bobToken}`,
          'X-Capability': bobCapability,
        },
        body: 'encrypted-change-2',
      })
      expect(res.status).toBe(201)
      const body = await res.json()
      expect(body.seq).toBe(2)
    })

    it('should reject Bob using Alice\'s capability', async () => {
      const res = await fetch(`${baseUrl}/docs/${docId}/changes`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${bobToken}`,
          'X-Capability': aliceCapability, // Wrong! Alice's cap for Alice
        },
        body: 'encrypted-change',
      })
      expect(res.status).toBe(403)
    })
  })

  describe('GET /docs/{docId}/changes', () => {
    it('should return all changes', async () => {
      const res = await fetch(`${baseUrl}/docs/${docId}/changes`, {
        headers: {
          Authorization: `Bearer ${aliceToken}`,
          'X-Capability': aliceCapability,
        },
      })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.changes.length).toBeGreaterThanOrEqual(2)
      expect(body.snapshot).toBeNull()
    })

    it('should support since parameter', async () => {
      const res = await fetch(`${baseUrl}/docs/${docId}/changes?since=1`, {
        headers: {
          Authorization: `Bearer ${aliceToken}`,
          'X-Capability': aliceCapability,
        },
      })
      expect(res.status).toBe(200)
      const body = await res.json()
      // Should only have changes after seq 1
      for (const change of body.changes) {
        expect(change.seq).toBeGreaterThan(1)
      }
    })
  })

  describe('GET /docs/{docId}/info', () => {
    it('should return document info', async () => {
      const res = await fetch(`${baseUrl}/docs/${docId}/info`, {
        headers: {
          Authorization: `Bearer ${aliceToken}`,
          'X-Capability': aliceCapability,
        },
      })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.docId).toBe(docId)
      expect(body.latestSeq).toBeGreaterThanOrEqual(2)
      expect(body.snapshotSeq).toBeNull()
    })

    it('should return 404 for unknown doc', async () => {
      // Create a capability for unknown doc
      const unknownResource = createResourceRef('space', 'unknown-doc')
      const cap = await createCapability(
        {
          issuer: alice.getDid(),
          audience: alice.getDid(),
          resource: unknownResource,
          permissions: ['read'],
          expiration: new Date(Date.now() + 86400000).toISOString(),
        },
        (p) => alice.signJws(p),
      )

      const res = await fetch(`${baseUrl}/docs/unknown-doc/info`, {
        headers: {
          Authorization: `Bearer ${aliceToken}`,
          'X-Capability': cap,
        },
      })
      expect(res.status).toBe(404)
    })
  })

  describe('PUT /docs/{docId}/snapshot', () => {
    it('should store snapshot and compact changes', async () => {
      const res = await fetch(`${baseUrl}/docs/${docId}/snapshot`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${aliceToken}`,
          'X-Capability': aliceCapability,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          data: Buffer.from('compacted-snapshot').toString('base64'),
          upToSeq: 2,
        }),
      })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.upToSeq).toBe(2)

      // Verify changes were compacted
      const changesRes = await fetch(`${baseUrl}/docs/${docId}/changes`, {
        headers: {
          Authorization: `Bearer ${aliceToken}`,
          'X-Capability': aliceCapability,
        },
      })
      const changesBody = await changesRes.json()
      expect(changesBody.snapshot).not.toBeNull()
      expect(changesBody.snapshot.upToSeq).toBe(2)
    })
  })

  describe('DELETE /docs/{docId}', () => {
    it('should reject without delete permission', async () => {
      const res = await fetch(`${baseUrl}/docs/${docId}`, {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${bobToken}`,
          'X-Capability': bobCapability, // Bob has read+write, not delete
        },
      })
      expect(res.status).toBe(403)
    })

    it('should delete with proper permission', async () => {
      const res = await fetch(`${baseUrl}/docs/${docId}`, {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${aliceToken}`,
          'X-Capability': aliceCapability, // Alice has delete
        },
      })
      expect(res.status).toBe(200)

      // Verify deleted
      const infoRes = await fetch(`${baseUrl}/docs/${docId}/info`, {
        headers: {
          Authorization: `Bearer ${aliceToken}`,
          'X-Capability': aliceCapability,
        },
      })
      expect(infoRes.status).toBe(404)
    })
  })
})
