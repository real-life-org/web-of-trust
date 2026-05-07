import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { WotIdentity } from '@web_of_trust/core/application'
import {
  initYjsPersonalDoc,
  getYjsPersonalDoc,
  changeYjsPersonalDoc,
  flushYjsPersonalDoc,
  resetYjsPersonalDoc,
} from '../src/YjsPersonalDocManager'

/**
 * In-memory mock vault (same pattern as VaultIntegration.test.ts).
 */
class MockVault {
  private docs = new Map<string, {
    changes: { seq: number; data: string; authorDid: string; createdAt: string }[]
    snapshot: { data: string; upToSeq: number } | null
  }>()

  handleRequest(url: string, init?: RequestInit): Response | null {
    const parsed = new URL(url)
    const path = parsed.pathname

    if (path === '/health') {
      return this.json(200, { status: 'ok' })
    }

    const changesMatch = path.match(/^\/docs\/([^/]+)\/changes$/)
    if (changesMatch) {
      const docId = decodeURIComponent(changesMatch[1])
      if (init?.method === 'POST') return this.postChange(docId, init.body)
      const since = parseInt(parsed.searchParams.get('since') ?? '0', 10)
      return this.getChanges(docId, since)
    }

    const snapMatch = path.match(/^\/docs\/([^/]+)\/snapshot$/)
    if (snapMatch && init?.method === 'PUT') {
      return this.putSnapshot(decodeURIComponent(snapMatch[1]), init.body)
    }

    const infoMatch = path.match(/^\/docs\/([^/]+)\/info$/)
    if (infoMatch) {
      return this.getInfo(decodeURIComponent(infoMatch[1]))
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
    let data: string
    if (body instanceof Uint8Array || body instanceof ArrayBuffer) {
      const bytes = body instanceof ArrayBuffer ? new Uint8Array(body) : body
      data = Buffer.from(bytes).toString('base64')
    } else {
      data = String(body)
    }
    doc.changes.push({ seq, data, authorDid: 'test', createdAt: new Date().toISOString() })
    return this.json(201, { docId, seq })
  }

  private getChanges(docId: string, since: number): Response {
    const doc = this.docs.get(docId)
    if (!doc) return this.json(200, { docId, snapshot: null, changes: [] })
    const changes = doc.changes.filter(c => c.seq > since)
    return this.json(200, { docId, snapshot: since === 0 ? doc.snapshot : null, changes })
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
    doc.changes = doc.changes.filter(c => c.seq > parsed.upToSeq)
    return this.json(200, { docId, upToSeq: parsed.upToSeq })
  }

  private getInfo(docId: string): Response {
    const doc = this.docs.get(docId)
    if (!doc) return this.json(404, { error: 'Document not found' })
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

  hasData(docId: string): boolean {
    const doc = this.docs.get(docId)
    if (!doc) return false
    return doc.snapshot !== null || doc.changes.length > 0
  }
}

describe('Yjs Vault Integration', () => {
  let identity: WotIdentity
  let mockVault: MockVault
  let originalFetch: typeof globalThis.fetch

  beforeEach(async () => {
    identity = new WotIdentity()
    await identity.create('yjs-vault-test', false)

    mockVault = new MockVault()
    originalFetch = globalThis.fetch

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
    await resetYjsPersonalDoc()
    try { await identity.deleteStoredIdentity() } catch {}
    // Clean up IDB
    try {
      const dbs = await indexedDB.databases()
      for (const db of dbs) {
        if (db.name?.startsWith('wot-yjs')) {
          indexedDB.deleteDatabase(db.name)
        }
      }
    } catch {}
  })

  it('should push data to vault on flush', async () => {
    await initYjsPersonalDoc(identity, undefined, 'https://test-vault.local')

    changeYjsPersonalDoc(doc => {
      doc.profile = {
        did: identity.getDid(),
        name: 'Vault Test',
        bio: 'Testing vault push',
        avatar: '',
        offersJson: '[]',
        needsJson: '[]',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }
    })

    await flushYjsPersonalDoc()

    // Vault should have received data
    expect(mockVault.hasData('personal-doc')).toBe(true)
  })

  it('should restore from vault when CompactStore is empty', async () => {
    // First session: create data and push to vault
    await initYjsPersonalDoc(identity, undefined, 'https://test-vault.local')

    changeYjsPersonalDoc(doc => {
      doc.profile = {
        did: identity.getDid(),
        name: 'Vault Restore Test',
        bio: 'Should survive restart',
        avatar: '',
        offersJson: '[]',
        needsJson: '[]',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }
      doc.contacts['did:key:alice'] = {
        did: 'did:key:alice',
        publicKey: 'key123',
        name: 'Alice',
        avatar: '',
        bio: '',
        status: 'active',
        verifiedAt: '',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }
    })

    await flushYjsPersonalDoc()
    expect(mockVault.hasData('personal-doc')).toBe(true)

    // Reset everything (simulates new device — no CompactStore)
    await resetYjsPersonalDoc()
    // Delete CompactStore IDB to simulate fresh device
    try {
      const dbs = await indexedDB.databases()
      for (const db of dbs) {
        if (db.name?.startsWith('wot-yjs')) {
          indexedDB.deleteDatabase(db.name)
        }
      }
    } catch {}

    // Second session: should restore from vault
    const restored = await initYjsPersonalDoc(identity, undefined, 'https://test-vault.local')

    expect(restored.profile?.name).toBe('Vault Restore Test')
    expect(restored.profile?.bio).toBe('Should survive restart')
    expect(restored.contacts['did:key:alice']?.name).toBe('Alice')
  })

  it('should fall back to empty doc when vault is also empty', async () => {
    const doc = await initYjsPersonalDoc(identity, undefined, 'https://test-vault.local')

    expect(doc.profile).toBeNull()
    expect(Object.keys(doc.contacts)).toHaveLength(0)
  })

  it('should prefer CompactStore over Vault', async () => {
    // First: create data and push to both CompactStore and Vault
    await initYjsPersonalDoc(identity, undefined, 'https://test-vault.local')

    changeYjsPersonalDoc(doc => {
      doc.profile = {
        did: identity.getDid(),
        name: 'CompactStore Version',
        bio: '',
        avatar: '',
        offersJson: '[]',
        needsJson: '[]',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }
    })

    await flushYjsPersonalDoc()
    await resetYjsPersonalDoc()

    // Don't delete CompactStore — it should be preferred over Vault
    const restored = await initYjsPersonalDoc(identity, undefined, 'https://test-vault.local')
    expect(restored.profile?.name).toBe('CompactStore Version')
  })
})
