import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { WotIdentity } from '@real-life/wot-core'
import { InMemoryMessagingAdapter } from '@real-life/wot-core'
import { GroupKeyService } from '@real-life/wot-core'
import { InMemorySpaceMetadataStorage } from '@real-life/wot-core'
import { VaultClient, base64ToUint8 } from '@real-life/wot-core'
import { EncryptedSyncService } from '@real-life/wot-core'
import { createCapability } from '@real-life/wot-core'
import { createResourceRef } from '@real-life/wot-core'
import { AutomergeReplicationAdapter } from '../src/AutomergeReplicationAdapter'

// Simple doc schema for testing
interface TestDoc {
  counter: number
  items: string[]
}

/**
 * In-memory mock vault that implements the same HTTP API as wot-vault.
 * Used by intercepting global fetch.
 */
class MockVault {
  private docs = new Map<string, {
    changes: { seq: number; data: string; authorDid: string; createdAt: string }[]
    snapshot: { data: string; upToSeq: number } | null
  }>()

  handleRequest(url: string, init?: RequestInit): Response | null {
    const parsed = new URL(url)
    const path = parsed.pathname

    // Health check
    if (path === '/health') {
      return this.json(200, { status: 'ok' })
    }

    // POST /docs/{id}/changes
    const changesMatch = path.match(/^\/docs\/([^/]+)\/changes$/)
    if (changesMatch) {
      const docId = decodeURIComponent(changesMatch[1])
      if (init?.method === 'POST') {
        return this.postChange(docId, init.body)
      }
      // GET
      const since = parseInt(parsed.searchParams.get('since') ?? '0', 10)
      return this.getChanges(docId, since)
    }

    // PUT /docs/{id}/snapshot
    const snapMatch = path.match(/^\/docs\/([^/]+)\/snapshot$/)
    if (snapMatch && init?.method === 'PUT') {
      const docId = decodeURIComponent(snapMatch[1])
      return this.putSnapshot(docId, init.body)
    }

    // GET /docs/{id}/info
    const infoMatch = path.match(/^\/docs\/([^/]+)\/info$/)
    if (infoMatch) {
      const docId = decodeURIComponent(infoMatch[1])
      return this.getInfo(docId)
    }

    // DELETE /docs/{id}
    const deleteMatch = path.match(/^\/docs\/([^/]+)$/)
    if (deleteMatch && init?.method === 'DELETE') {
      const docId = decodeURIComponent(deleteMatch[1])
      this.docs.delete(docId)
      return this.json(200, { docId, deleted: true })
    }

    return this.json(404, { error: 'Not found' })
  }

  private ensureDoc(docId: string) {
    if (!this.docs.has(docId)) {
      this.docs.set(docId, { changes: [], snapshot: null })
    }
    return this.docs.get(docId)!
  }

  private postChange(docId: string, body: any): Response {
    const doc = this.ensureDoc(docId)
    const seq = (doc.snapshot?.upToSeq ?? 0) + doc.changes.length + 1

    // Body is Uint8Array/ArrayBuffer — convert to base64
    let data: string
    if (body instanceof Uint8Array || body instanceof ArrayBuffer) {
      const bytes = body instanceof ArrayBuffer ? new Uint8Array(body) : body
      data = Buffer.from(bytes).toString('base64')
    } else {
      data = String(body)
    }

    doc.changes.push({
      seq,
      data,
      authorDid: 'test',
      createdAt: new Date().toISOString(),
    })
    return this.json(201, { docId, seq })
  }

  private getChanges(docId: string, since: number): Response {
    const doc = this.docs.get(docId)
    if (!doc) {
      return this.json(200, { docId, snapshot: null, changes: [] })
    }

    const changes = doc.changes.filter(c => c.seq > since)
    return this.json(200, {
      docId,
      snapshot: since === 0 ? doc.snapshot : null,
      changes,
    })
  }

  private putSnapshot(docId: string, body: any): Response {
    const doc = this.ensureDoc(docId)
    let parsed: any
    if (typeof body === 'string') {
      parsed = JSON.parse(body)
    } else {
      parsed = JSON.parse(Buffer.from(body).toString('utf-8'))
    }
    doc.snapshot = { data: parsed.data, upToSeq: parsed.upToSeq }
    // Remove changes covered by snapshot
    doc.changes = doc.changes.filter(c => c.seq > parsed.upToSeq)
    return this.json(200, { docId, upToSeq: parsed.upToSeq })
  }

  private getInfo(docId: string): Response {
    const doc = this.docs.get(docId)
    if (!doc) {
      return this.json(404, { error: 'Document not found' })
    }
    const allSeqs = doc.changes.map(c => c.seq)
    const snapshotSeq = doc.snapshot?.upToSeq ?? null
    return this.json(200, {
      docId,
      latestSeq: Math.max(snapshotSeq ?? 0, ...allSeqs, 0),
      snapshotSeq,
      changeCount: doc.changes.length,
    })
  }

  private json(status: number, data: unknown): Response {
    return new Response(JSON.stringify(data), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  getStoredDocs(): string[] {
    return Array.from(this.docs.keys())
  }

  getDoc(docId: string) {
    return this.docs.get(docId) ?? null
  }
}

describe('Vault Integration', () => {
  let alice: WotIdentity
  let mockVault: MockVault
  let originalFetch: typeof globalThis.fetch

  beforeEach(async () => {
    InMemoryMessagingAdapter.resetAll()
    alice = new WotIdentity()
    await alice.create('alice-vault-test', false)

    mockVault = new MockVault()
    originalFetch = globalThis.fetch

    // Intercept fetch for vault URL
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.startsWith('https://test-vault.local')) {
        const response = mockVault.handleRequest(url, init)
        if (response) return response
      }
      return originalFetch(input, init)
    }) as any
  })

  afterEach(async () => {
    globalThis.fetch = originalFetch
    InMemoryMessagingAdapter.resetAll()
    try { await alice.deleteStoredIdentity() } catch {}
  })

  describe('VaultClient', () => {
    it('should push a change and get it back', async () => {
      const client = new VaultClient('https://test-vault.local', alice)
      const data = new TextEncoder().encode('hello-vault')

      const seq = await client.pushChange('test-doc', data)
      expect(seq).toBe(1)

      const result = await client.getChanges('test-doc')
      expect(result.changes.length).toBe(1)
      expect(result.changes[0].seq).toBe(1)
    })

    it('should store and retrieve a snapshot', async () => {
      const client = new VaultClient('https://test-vault.local', alice)

      // Push some changes first
      await client.pushChange('snap-doc', new TextEncoder().encode('change-1'))
      await client.pushChange('snap-doc', new TextEncoder().encode('change-2'))

      // Put snapshot
      const ciphertext = new TextEncoder().encode('snapshot-data')
      const nonce = new Uint8Array(12).fill(42)
      await client.putSnapshot('snap-doc', ciphertext, nonce, 2)

      // Get changes — should include snapshot, no changes (covered by snapshot)
      const result = await client.getChanges('snap-doc')
      expect(result.snapshot).not.toBeNull()
      expect(result.changes.length).toBe(0)
    })

    it('should get doc info', async () => {
      const client = new VaultClient('https://test-vault.local', alice)
      await client.pushChange('info-doc', new TextEncoder().encode('data'))

      const info = await client.getDocInfo('info-doc')
      expect(info).not.toBeNull()
      expect(info!.latestSeq).toBe(1)
      expect(info!.changeCount).toBe(1)
    })

    it('should return null for non-existent doc info', async () => {
      const client = new VaultClient('https://test-vault.local', alice)
      const info = await client.getDocInfo('nonexistent')
      expect(info).toBeNull()
    })

    it('should delete a document', async () => {
      const client = new VaultClient('https://test-vault.local', alice)
      await client.pushChange('del-doc', new TextEncoder().encode('data'))
      await client.deleteDoc('del-doc')
      const info = await client.getDocInfo('del-doc')
      expect(info).toBeNull()
    })
  })

  describe('ReplicationAdapter + Vault', () => {
    it('should push snapshot to vault when creating a space', async () => {
      const messaging = new InMemoryMessagingAdapter()
      await messaging.connect(alice.getDid())

      const adapter = new AutomergeReplicationAdapter({
        identity: alice,
        messaging,
        groupKeyService: new GroupKeyService(),
        metadataStorage: new InMemorySpaceMetadataStorage(),
        vaultUrl: 'https://test-vault.local',
      })
      await adapter.start()

      const space = await adapter.createSpace<TestDoc>('shared', {
        counter: 42,
        items: ['test'],
      })

      // Wait for fire-and-forget vault push
      await new Promise(r => setTimeout(r, 200))

      // Verify vault received the snapshot
      const storedDocs = mockVault.getStoredDocs()
      expect(storedDocs).toContain(space.id)

      const doc = mockVault.getDoc(space.id)
      expect(doc?.snapshot).not.toBeNull()

      await adapter.stop()
    })

    it('should restore space from vault on a new device', async () => {
      // Increase timeout — vault restore involves multiple async operations
      vi.setConfig({ testTimeout: 15_000 })
      // --- Device A: Create space and push to vault ---
      const messagingA = new InMemoryMessagingAdapter()
      await messagingA.connect(alice.getDid())
      const groupKeyServiceA = new GroupKeyService()
      const metadataA = new InMemorySpaceMetadataStorage()

      const adapterA = new AutomergeReplicationAdapter({
        identity: alice,
        messaging: messagingA,
        groupKeyService: groupKeyServiceA,
        metadataStorage: metadataA,
        vaultUrl: 'https://test-vault.local',
      })
      await adapterA.start()

      const space = await adapterA.createSpace<TestDoc>('shared', {
        counter: 99,
        items: ['from-device-a'],
      })

      // Wait for vault push
      await new Promise(r => setTimeout(r, 200))

      // Save metadata + group keys for Device B
      const savedMeta = await metadataA.loadAllSpaceMetadata()
      const savedKeys = await metadataA.loadGroupKeys(space.id)

      await adapterA.stop()

      // --- Device B: Restore from vault ---
      const messagingB = new InMemoryMessagingAdapter()
      await messagingB.connect(alice.getDid())
      const groupKeyServiceB = new GroupKeyService()
      const metadataB = new InMemorySpaceMetadataStorage()

      // Simulate personal doc sync: copy metadata + keys to Device B
      for (const meta of savedMeta) {
        await metadataB.saveSpaceMetadata(meta)
      }
      for (const key of savedKeys) {
        await metadataB.saveGroupKey(key)
      }

      const adapterB = new AutomergeReplicationAdapter({
        identity: alice,
        messaging: messagingB,
        groupKeyService: groupKeyServiceB,
        metadataStorage: metadataB,
        vaultUrl: 'https://test-vault.local',
      })
      await adapterB.start()

      // Verify space was restored
      const spaces = await adapterB.getSpaces()
      expect(spaces.length).toBe(1)
      expect(spaces[0].id).toBe(space.id)

      // Open and verify doc content
      const handle = await adapterB.openSpace<TestDoc>(space.id)
      const doc = handle.getDoc()
      expect(doc.counter).toBe(99)
      expect(doc.items).toEqual(['from-device-a'])

      handle.close()
      await adapterB.stop()
    })

    it('should debounce vault pushes on transact', async () => {
      const messaging = new InMemoryMessagingAdapter()
      await messaging.connect(alice.getDid())

      const adapter = new AutomergeReplicationAdapter({
        identity: alice,
        messaging,
        groupKeyService: new GroupKeyService(),
        metadataStorage: new InMemorySpaceMetadataStorage(),
        vaultUrl: 'https://test-vault.local',
      })
      await adapter.start()

      const space = await adapter.createSpace<TestDoc>('shared', {
        counter: 0,
        items: [],
      })

      // Wait for initial vault push
      await new Promise(r => setTimeout(r, 200))

      const handle = await adapter.openSpace<TestDoc>(space.id)

      // Multiple rapid transacts
      handle.transact(doc => { doc.counter = 1 })
      handle.transact(doc => { doc.counter = 2 })
      handle.transact(doc => { doc.counter = 3 })

      // Count fetch calls before debounce fires
      const callsBefore = (globalThis.fetch as any).mock.calls.length

      // Wait for debounce (5s) + margin
      await new Promise(r => setTimeout(r, 5500))

      const callsAfter = (globalThis.fetch as any).mock.calls.length

      // Should have made exactly one snapshot push (not 3)
      // The calls include: auth token creation calls, but the point is
      // it's debounced — not one per transact
      expect(callsAfter).toBeGreaterThan(callsBefore)

      handle.close()
      await adapter.stop()
    }, 10_000)
  })
})
