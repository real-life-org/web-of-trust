import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { PublicIdentitySession } from '../../wot-core/src/application/identity'
import { createTestIdentity } from '../../wot-core/tests/helpers/identity-session'
import {
  initYjsPersonalDoc,
  getYjsPersonalDoc,
  changeYjsPersonalDoc,
  onYjsPersonalDocChange,
  flushYjsPersonalDoc,
  refreshYjsPersonalDocFromVault,
  pullPersonalDocFromVaultOnceAtStartup,
  resetYjsPersonalDoc,
} from '../src/YjsPersonalDocManager'

// local-first (spec-startup-local-first, TEIL B): the spinner must wait on LOCAL
// ops only. initYjsPersonalDoc({ skipVaultRestore }) keeps init to the CompactStore
// load; the (network) vault restore is deferred to
// pullPersonalDocFromVaultOnceAtStartup(), which merges into the LIVING doc so the
// data appears reactively after first render. These tests use a *gated* vault whose
// getChanges hangs until explicitly released — the strongest proof that init does
// not wait on the network.

const VAULT_URL = 'https://gated-vault.local'
const PERSONAL_DOC = 'personal-doc'

/** In-memory vault (same shape as YjsVaultIntegration.test.ts). */
class MockVault {
  private docs = new Map<string, {
    changes: { seq: number; data: string; authorDid: string; createdAt: string }[]
    snapshot: { data: string; upToSeq: number } | null
  }>()

  handleRequest(url: string, init?: RequestInit): Response | null {
    const parsed = new URL(url)
    const path = parsed.pathname
    const changesMatch = path.match(/^\/docs\/([^/]+)\/changes$/)
    if (changesMatch) {
      const docId = decodeURIComponent(changesMatch[1])
      if (init?.method === 'POST') return this.postChange(docId, init.body)
      const since = parseInt(parsed.searchParams.get('since') ?? '0', 10)
      return this.getChanges(docId, since)
    }
    const snapMatch = path.match(/^\/docs\/([^/]+)\/snapshot$/)
    if (snapMatch && init?.method === 'PUT') return this.putSnapshot(decodeURIComponent(snapMatch[1]), init.body)
    const infoMatch = path.match(/^\/docs\/([^/]+)\/info$/)
    if (infoMatch) return this.getInfo(decodeURIComponent(infoMatch[1]))
    return this.json(404, { error: 'Not found' })
  }

  private ensureDoc(docId: string) {
    if (!this.docs.has(docId)) this.docs.set(docId, { changes: [], snapshot: null })
    return this.docs.get(docId)!
  }
  private postChange(docId: string, body: any): Response {
    const doc = this.ensureDoc(docId)
    const seq = (doc.snapshot?.upToSeq ?? 0) + doc.changes.length + 1
    const bytes = body instanceof ArrayBuffer ? new Uint8Array(body) : body
    const data = bytes instanceof Uint8Array ? Buffer.from(bytes).toString('base64') : String(body)
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
    const parsed = typeof body === 'string' ? JSON.parse(body) : JSON.parse(Buffer.from(body).toString('utf-8'))
    doc.snapshot = { data: parsed.data, upToSeq: parsed.upToSeq }
    doc.changes = doc.changes.filter(c => c.seq > parsed.upToSeq)
    return this.json(200, { docId, upToSeq: parsed.upToSeq })
  }
  private getInfo(docId: string): Response {
    const doc = this.docs.get(docId)
    if (!doc) return this.json(404, { error: 'Document not found' })
    const snapshotSeq = doc.snapshot?.upToSeq ?? null
    return this.json(200, { docId, latestSeq: Math.max(snapshotSeq ?? 0, 0), snapshotSeq, changeCount: doc.changes.length })
  }
  private json(status: number, data: unknown): Response {
    return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
  }
  hasData(docId: string): boolean {
    const doc = this.docs.get(docId)
    return !!doc && (doc.snapshot !== null || doc.changes.length > 0)
  }
}

async function deleteYjsIndexedDBs(): Promise<void> {
  try {
    const dbs = await indexedDB.databases()
    for (const db of dbs) if (db.name?.startsWith('wot-yjs')) indexedDB.deleteDatabase(db.name)
  } catch { /* ignore */ }
}

describe('Yjs Personal Doc — local-first startup (TEIL B)', () => {
  let identity: PublicIdentitySession
  let mockVault: MockVault
  let originalFetch: typeof globalThis.fetch
  // Gate that stalls the vault RESTORE read (getChanges GET) until released.
  let restoreGate: Promise<void> | null
  let releaseRestoreGate: (() => void) | null
  let restoreReadCount: number

  beforeEach(async () => {
    identity = (await createTestIdentity('yjs-local-first')).identity
    mockVault = new MockVault()
    restoreGate = null
    releaseRestoreGate = null
    restoreReadCount = 0
    originalFetch = globalThis.fetch

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.startsWith(VAULT_URL)) {
        const parsed = new URL(url)
        const isRestoreRead = /^\/docs\/[^/]+\/changes$/.test(parsed.pathname) && (init?.method ?? 'GET').toUpperCase() === 'GET'
        if (isRestoreRead) {
          restoreReadCount++
          if (restoreGate) await restoreGate // hang until the test releases the box
        }
        const response = mockVault.handleRequest(url, init)
        if (response) return response
      }
      return originalFetch(input, init)
    }) as unknown as typeof globalThis.fetch
  })

  afterEach(async () => {
    globalThis.fetch = originalFetch
    await resetYjsPersonalDoc()
    try { await identity.deleteStoredIdentity() } catch { /* ignore */ }
    await deleteYjsIndexedDBs()
    vi.restoreAllMocks()
  })

  function closeGate(): void {
    restoreGate = new Promise<void>((resolve) => { releaseRestoreGate = resolve })
  }

  /** Seed the vault with a real encrypted personal-doc snapshot, then wipe local state. */
  async function seedVaultAndWipeLocal(name: string): Promise<void> {
    await initYjsPersonalDoc(identity, undefined, VAULT_URL)
    changeYjsPersonalDoc(doc => {
      doc.profile = {
        did: identity.getDid(), name, bio: 'seeded', avatar: '',
        offersJson: '[]', needsJson: '[]',
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      }
      doc.contacts['did:key:alice'] = {
        did: 'did:key:alice', publicKey: 'k', name: 'Alice', avatar: '', bio: '',
        status: 'active', verifiedAt: '', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      }
    })
    await flushYjsPersonalDoc()
    expect(mockVault.hasData(PERSONAL_DOC)).toBe(true)
    await resetYjsPersonalDoc()
    await deleteYjsIndexedDBs()
    // Session 1's own (default) init issued a restore read against the then-empty
    // vault; ignore it so tests measure only reads that happen AFTER seeding.
    restoreReadCount = 0
  }

  it('init does NOT block on a hanging vault; the late restore merges reactively', async () => {
    await seedVaultAndWipeLocal('Vault Restore Test')

    // The box is up but not answering the restore read.
    closeGate()

    // init MUST reach ready without waiting on the network (skipVaultRestore).
    const raced = await Promise.race([
      initYjsPersonalDoc(identity, undefined, VAULT_URL, undefined, undefined, { skipVaultRestore: true })
        .then((doc) => ({ tag: 'init' as const, doc })),
      new Promise<{ tag: 'timeout' }>((res) => setTimeout(() => res({ tag: 'timeout' }), 1500)),
    ])
    expect(raced.tag).toBe('init')
    // Nothing restored yet, and init never issued the vault restore read.
    if (raced.tag === 'init') expect(raced.doc.profile).toBeNull()
    expect(restoreReadCount).toBe(0)

    // Now render is done. Subscribe, then run the deferred background restore.
    let reactiveUpdates = 0
    const unsub = onYjsPersonalDocChange(() => { reactiveUpdates++ })

    const pullP = pullPersonalDocFromVaultOnceAtStartup()
    // Let it reach the (gated) restore read.
    await new Promise((r) => setTimeout(r, 20))
    expect(restoreReadCount).toBe(1)
    expect(getYjsPersonalDoc().profile).toBeNull() // still nothing — the box is stalled

    // Release the box → the snapshot merges into the LIVING doc.
    releaseRestoreGate!()
    const restored = await pullP

    expect(restored).toBe(true)
    expect(getYjsPersonalDoc().profile?.name).toBe('Vault Restore Test')
    expect(getYjsPersonalDoc().contacts['did:key:alice']?.name).toBe('Alice')
    expect(reactiveUpdates).toBeGreaterThan(0) // the UI was notified reactively
    unsub()
  })

  it('fresh install renders an empty, valid doc without the network', async () => {
    // No vault data, box stalled — a fresh identity must still render immediately.
    closeGate()
    const raced = await Promise.race([
      initYjsPersonalDoc(identity, undefined, VAULT_URL, undefined, undefined, { skipVaultRestore: true })
        .then((doc) => ({ tag: 'init' as const, doc })),
      new Promise<{ tag: 'timeout' }>((res) => setTimeout(() => res({ tag: 'timeout' }), 1500)),
    ])
    expect(raced.tag).toBe('init')
    if (raced.tag === 'init') {
      expect(raced.doc.profile).toBeNull()
      expect(Object.keys(raced.doc.contacts)).toHaveLength(0)
    }
    expect(restoreReadCount).toBe(0)
  })

  it('in-flight guard: concurrent restores share ONE vault read', async () => {
    await seedVaultAndWipeLocal('Guarded Restore')
    await initYjsPersonalDoc(identity, undefined, VAULT_URL, undefined, undefined, { skipVaultRestore: true })

    // Two callers race the same path (startup pull path + missing-key refresh).
    closeGate()
    const p1 = refreshYjsPersonalDocFromVault()
    const p2 = refreshYjsPersonalDocFromVault()
    await new Promise((r) => setTimeout(r, 20))
    releaseRestoreGate!()
    const [r1, r2] = await Promise.all([p1, p2])

    expect(r1).toBe(true)
    expect(r2).toBe(true)
    // The in-flight guard collapsed the two calls into a single getChanges read.
    expect(restoreReadCount).toBe(1)
    expect(getYjsPersonalDoc().profile?.name).toBe('Guarded Restore')
  })

  it('pullPersonalDocFromVaultOnceAtStartup is a no-op when nothing was deferred', async () => {
    // Local doc already present (no skipVaultRestore path taken) → nothing owed.
    await seedVaultAndWipeLocal('Present Locally')
    await initYjsPersonalDoc(identity, undefined, VAULT_URL) // default: restores synchronously
    restoreReadCount = 0 // ignore the synchronous restore read
    const restored = await pullPersonalDocFromVaultOnceAtStartup()
    expect(restored).toBe(false)
    expect(restoreReadCount).toBe(0)
  })
})
