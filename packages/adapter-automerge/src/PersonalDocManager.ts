/**
 * Personal Document Manager
 *
 * Manages a single Automerge document per user that stores all personal data.
 *
 * - Persisted locally in IndexedDB via automerge-repo (offline-first)
 * - Synced to other devices via PersonalNetworkAdapter -> wot-relay (E2E encrypted)
 * - Doc-ID derived deterministically from mnemonic (same on all devices)
 *
 * The Personal-Doc contains: profile, contacts, verifications, attestations,
 * attestation metadata, outbox, publish state, graph cache, and space metadata.
 */
import { Repo, stringifyAutomergeUrl, parseAutomergeUrl } from '@automerge/automerge-repo'
import type { DocHandle, DocumentId, AutomergeUrl, BinaryDocumentId } from '@automerge/automerge-repo'
import * as Automerge from '@automerge/automerge'
import type { WotIdentity } from '@web_of_trust/core'
import type { MessagingAdapter } from '@web_of_trust/core'
import { VaultClient, base64ToUint8 } from '@web_of_trust/core'
import { VaultPushScheduler } from '@web_of_trust/core'
import { EncryptedSyncService } from '@web_of_trust/core'
import { CompactStorageManager } from '@web_of_trust/core'
import { getMetrics, registerDebugApi } from '@web_of_trust/core'
import { PersonalNetworkAdapter } from './PersonalNetworkAdapter'
import { SyncOnlyStorageAdapter } from './SyncOnlyStorageAdapter'
import { CompactionService } from './CompactionService'

// --- Personal Document Schema ---

export interface OutboxEntryDoc {
  envelopeJson: string
  createdAt: string
  retryCount: number
}

export interface PublishStateDoc {
  profileDirty: boolean
  verificationsDirty: boolean
  attestationsDirty: boolean
}

export interface CachedGraphEntryDoc {
  did: string
  name: string | null
  bio: string | null
  avatar: string | null
  encryptionPublicKey: string | null
  verificationCount: number
  attestationCount: number
  verifierDidsJson: string | null  // JSON string[]
  fetchedAt: string
}

export interface CachedGraphVerificationDoc {
  subjectDid: string
  verificationId: string
  fromDid: string
  toDid: string
  timestamp: string
  proofJson: string
  locationJson: string | null
}

export interface CachedGraphAttestationDoc {
  subjectDid: string
  attestationId: string
  fromDid: string
  toDid: string
  claim: string
  tagsJson: string | null
  context: string | null
  attestationCreatedAt: string
  proofJson: string
}

export interface SpaceMetadataDoc {
  info: {
    id: string
    type: string
    name: string | null
    description: string | null
    appTag?: string
    members: string[]
    createdAt: string
  }
  documentId: string
  documentUrl: string
  /** memberEncryptionKeys stored as Record<did, number[]> for serialization */
  memberEncryptionKeys: Record<string, number[]>
}

export interface GroupKeyDoc {
  spaceId: string
  generation: number
  key: number[]
}

export interface ContactDoc {
  did: string
  publicKey: string
  name: string | null
  avatar: string | null
  bio: string | null
  status: string  // 'pending' | 'active'
  verifiedAt: string | null
  createdAt: string
  updatedAt: string
}

export interface VerificationDoc {
  id: string
  fromDid: string
  toDid: string
  timestamp: string
  proofJson: string
  locationJson: string | null
}

export interface AttestationDoc {
  id: string
  attestationId: string | null
  fromDid: string
  toDid: string
  claim: string
  tagsJson: string | null
  context: string | null
  createdAt: string
  proofJson: string
}

export interface AttestationMetadataDoc {
  attestationId: string
  accepted: boolean
  acceptedAt: string | null
  deliveryStatus: string | null
}

export interface ProfileDoc {
  did: string
  name: string | null
  bio: string | null
  avatar: string | null
  offersJson: string | null
  needsJson: string | null
  createdAt: string
  updatedAt: string
}

export interface PersonalDoc {
  profile: ProfileDoc | null
  contacts: Record<string, ContactDoc>
  verifications: Record<string, VerificationDoc>
  attestations: Record<string, AttestationDoc>
  attestationMetadata: Record<string, AttestationMetadataDoc>
  outbox: Record<string, OutboxEntryDoc>
  spaces: Record<string, SpaceMetadataDoc>
  groupKeys: Record<string, GroupKeyDoc>
}

// --- IndexedDB health check ---

const MAX_IDB_CHUNKS = 20 // Above this, Automerge WASM OOM-crashes on loadIncremental

/**
 * Count the number of entries in an IndexedDB store.
 * If too many chunks exist, loading will crash WASM — skip IDB and use vault instead.
 */
async function checkIdbHealth(dbName: string, storeName: string): Promise<boolean> {
  try {
    const count = await new Promise<number>((resolve) => {
      const req = indexedDB.open(dbName, 1)
      req.onerror = () => resolve(0)
      req.onupgradeneeded = (event) => {
        // DB doesn't exist yet — healthy (empty)
        const db = (event.target as IDBOpenDBRequest).result
        if (!db.objectStoreNames.contains(storeName)) {
          db.createObjectStore(storeName)
        }
      }
      req.onsuccess = () => {
        const db = req.result
        try {
          const tx = db.transaction(storeName, 'readonly')
          const store = tx.objectStore(storeName)
          const countReq = store.count()
          countReq.onsuccess = () => {
            db.close()
            resolve(countReq.result)
          }
          countReq.onerror = () => { db.close(); resolve(0) }
        } catch {
          db.close()
          resolve(0)
        }
      }
    })
    const metrics = getMetrics()
    metrics.setIdbChunkCount(count)
    console.log(`[personal-doc] IndexedDB chunk count: ${count}`)
    const healthy = count <= MAX_IDB_CHUNKS
    metrics.setHealthCheckResult(healthy)
    return healthy
  } catch {
    return true // If check fails, try loading anyway
  }
}

/**
 * Check if an IndexedDB database exists and has entries.
 * Returns false if the DB doesn't exist (onupgradeneeded fires = first open).
 */
async function idbHasData(dbName: string, storeName: string): Promise<boolean> {
  return new Promise((resolve) => {
    const req = indexedDB.open(dbName, 1)
    let isNew = false
    req.onupgradeneeded = () => {
      // DB didn't exist before — mark as new
      isNew = true
      const db = req.result
      if (!db.objectStoreNames.contains(storeName)) {
        db.createObjectStore(storeName)
      }
    }
    req.onsuccess = () => {
      const db = req.result
      if (isNew) {
        // DB was just created — no data. Delete it and return false.
        db.close()
        indexedDB.deleteDatabase(dbName)
        resolve(false)
        return
      }
      try {
        const tx = db.transaction(storeName, 'readonly')
        const store = tx.objectStore(storeName)
        const countReq = store.count()
        countReq.onsuccess = () => { db.close(); resolve(countReq.result > 0) }
        countReq.onerror = () => { db.close(); resolve(false) }
      } catch {
        db.close()
        resolve(false)
      }
    }
    req.onerror = () => resolve(false)
  })
}

// --- Old IndexedDB (for migration) ---

const OLD_IDB_NAME = 'wot-personal-doc'
const OLD_IDB_STORE = 'doc'
const OLD_IDB_KEY = 'personal'

async function loadFromOldIDB(): Promise<PersonalDoc | null> {
  return new Promise((resolve) => {
    const req = indexedDB.open(OLD_IDB_NAME, 1)
    req.onupgradeneeded = () => {
      // DB didn't exist before — no migration data
      req.result.close()
      resolve(null)
    }
    req.onsuccess = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(OLD_IDB_STORE)) {
        db.close()
        resolve(null)
        return
      }
      const tx = db.transaction(OLD_IDB_STORE, 'readonly')
      const store = tx.objectStore(OLD_IDB_STORE)
      const getReq = store.get(OLD_IDB_KEY)
      getReq.onsuccess = () => { db.close(); resolve(getReq.result ?? null) }
      getReq.onerror = () => { db.close(); resolve(null) }
    }
    req.onerror = () => resolve(null)
  })
}

async function deleteOldIDB(): Promise<void> {
  return new Promise((resolve) => {
    const req = indexedDB.deleteDatabase(OLD_IDB_NAME)
    req.onsuccess = () => resolve()
    req.onerror = () => resolve() // best effort
  })
}

// --- Singleton ---

let docHandle: DocHandle<PersonalDoc> | null = null
let personalRepo: Repo | null = null
let networkAdapter: PersonalNetworkAdapter | null = null
let changeListeners = new Set<() => void>()
/** Flag to suppress handle.on('change') during local changePersonalDoc() calls */
let localChangeInProgress = false
/** Vault client for persistent encrypted storage of personal doc */
let vaultClient: VaultClient | null = null
let vaultPersonalKey: Uint8Array | null = null
let vaultSeq = 0
let vaultScheduler: VaultPushScheduler | null = null
/** CompactStore for local doc persistence (replaces automerge-repo's chunked IDB) */
let compactStore: CompactStorageManager | null = null
let compactScheduler: VaultPushScheduler | null = null
const VAULT_PERSONAL_DOC_ID = '__personal__'
const COMPACT_STORE_DB = 'wot-compact-store'
const SYNC_STATE_DB = 'wot-personal-sync-states'

function emptyPersonalDoc(): PersonalDoc {
  return {
    profile: null,
    contacts: {},
    verifications: {},
    attestations: {},
    attestationMetadata: {},
    outbox: {},
    spaces: {},
    groupKeys: {},
  }
}

function notifyListeners(): void {
  for (const listener of changeListeners) {
    try { listener() } catch { /* ignore */ }
  }
}

/**
 * Derive a deterministic DocumentId from the identity's master key.
 * Same mnemonic -> same doc ID -> same document on all devices.
 */
async function derivePersonalDocId(identity: WotIdentity): Promise<{ documentId: DocumentId; documentUrl: AutomergeUrl; personalKey: Uint8Array }> {
  const personalKey = await identity.deriveFrameworkKey('personal-doc-v1')

  // Use first 16 bytes as deterministic doc ID (Automerge uses 16-byte UUIDs internally)
  // stringifyAutomergeUrl accepts Uint8Array and encodes with bs58check internally
  const docIdBytes = personalKey.slice(0, 16) as unknown as BinaryDocumentId
  const documentUrl = stringifyAutomergeUrl(docIdBytes)
  const { documentId } = parseAutomergeUrl(documentUrl)

  return { documentId, documentUrl, personalKey }
}

/**
 * Try to restore the personal doc from the vault (encrypted snapshot).
 * Returns the decrypted binary or null if vault has no data.
 */
async function restoreFromVault(vault: VaultClient, key: Uint8Array): Promise<Uint8Array | null> {
  try {
    const vaultData = await vault.getChanges(VAULT_PERSONAL_DOC_ID)

    if (vaultData.snapshot?.data) {
      const packed = base64ToUint8(vaultData.snapshot.data)
      const nonceLen = packed[0]
      const nonce = packed.slice(1, 1 + nonceLen)
      const ciphertext = packed.slice(1 + nonceLen)

      const docBinary = await EncryptedSyncService.decryptChange(
        { ciphertext, nonce, spaceId: VAULT_PERSONAL_DOC_ID, generation: 0, fromDid: '' },
        key,
      )
      // Seed local seq counter from vault data
      vaultSeq = vaultData.snapshot?.upToSeq ?? 0
      return docBinary
    }
  } catch (err) {
    // AES-GCM OperationError = corrupt ciphertext (truncated upload, bit flip, etc.)
    // Since the key is deterministic (HKDF from mnemonic), no device can ever decrypt
    // a corrupt snapshot. It's irrecoverable data — safe to delete.
    // The next local change will push a fresh snapshot via debouncedVaultPush().
    // If another device has newer data, Automerge sync via relay will merge it first.
    console.warn('[personal-doc] Vault snapshot decrypt failed — deleting and falling back to wot-profiles restore')
    getMetrics().logError('load:vault:decrypt-failed', err)
    try {
      await vault.deleteDoc(VAULT_PERSONAL_DOC_ID)
      console.debug('[personal-doc] Deleted undecryptable vault snapshot — fresh snapshot will be pushed after restore')
    } catch (delErr) {
      getMetrics().logError('delete:vault:cleanup', delErr)
    }
  }
  return null
}

/**
 * Push the current personal doc snapshot to the CompactStore (local IDB).
 * Called by compactScheduler — dirty check is done by the scheduler.
 *
 * Two-phase save:
 * 1. Save with history immediately (fast, ~4ms) — crash-safe baseline
 * 2. Compact in Web Worker (slow, ~5-7s on mobile) — overwrites with smaller snapshot
 */
async function pushToCompactStore(): Promise<void> {
  if (!compactStore || !docHandle) return

  try {
    const doc = docHandle.doc()
    if (!doc) return

    // Phase 1: Save with history (fast, no main-thread block)
    const t0save = Date.now()
    const withHistory = Automerge.save(doc)
    const saveMs = Date.now() - t0save
    if (!withHistory || withHistory.length === 0) return

    const t0 = Date.now()
    await compactStore.save(VAULT_PERSONAL_DOC_ID, withHistory)
    getMetrics().logSave('compact-store', Date.now() - t0, withHistory.length, saveMs)

    // Phase 2: Compact in Web Worker (strips history, reduces size)
    const compactionService = CompactionService.getInstance()
    const compacted = await compactionService.compact(withHistory)
    if (compacted && compacted.length > 0) {
      await compactStore.save(VAULT_PERSONAL_DOC_ID, compacted)
      console.debug(`[personal-doc] Compacted: ${withHistory.length}B → ${compacted.length}B (worker=${compactionService.isUsingWorker})`)
    }
  } catch (err) {
    getMetrics().logError('save:compact-store', err)
  }
}

/**
 * Push the current personal doc snapshot to the vault (encrypted).
 * Called by VaultPushScheduler — dirty check is done by the scheduler.
 *
 * Uses CompactionService to strip history in Web Worker before pushing.
 * Vault always receives compacted snapshots (smaller, no history).
 */
async function pushToVault(): Promise<void> {
  if (!vaultClient || !vaultPersonalKey || !personalRepo || !docHandle) return

  try {
    // Don't push if local doc has no meaningful data
    const doc = docHandle.doc()
    if (!doc) return
    const hasData = doc.profile || Object.keys(doc.contacts).length > 0 || Object.keys(doc.spaces).length > 0
    if (!hasData) {
      console.debug('[personal-doc] Skip vault push — no meaningful data yet')
      return
    }

    // Save with history (fast), then compact in Worker (strips history)
    const withHistory = Automerge.save(doc)
    if (!withHistory || withHistory.length === 0) return

    const compactionService = CompactionService.getInstance()
    const docBinary = await compactionService.compact(withHistory)
    if (!docBinary || docBinary.length === 0) return

    const encrypted = await EncryptedSyncService.encryptChange(
      docBinary,
      vaultPersonalKey,
      VAULT_PERSONAL_DOC_ID,
      0,
      '',
    )

    vaultSeq++
    const t0 = Date.now()
    await vaultClient.putSnapshot(VAULT_PERSONAL_DOC_ID, encrypted.ciphertext, encrypted.nonce, vaultSeq)
    getMetrics().logSave('vault', Date.now() - t0, docBinary.length)
  } catch (err) {
    getMetrics().logError('save:vault', err)
  }
}

// --- Public API ---

/**
 * Initialize the personal document as an Automerge doc with multi-device sync.
 *
 * - Derives deterministic doc ID from mnemonic
 * - Creates Automerge Repo with IndexedDB persistence + PersonalNetworkAdapter
 * - Migrates data from old plain-object IndexedDB if present
 * - Starts encrypted sync to other devices via wot-relay
 */
export async function initPersonalDoc(identity: WotIdentity, messaging?: MessagingAdapter, vaultUrl?: string): Promise<PersonalDoc> {
  // Idempotent — if already initialized with this identity, return existing doc
  if (docHandle && personalRepo) {
    const doc = docHandle.doc()
    if (doc) return doc
  }

  const tInit = Date.now()
  const { documentId, documentUrl, personalKey } = await derivePersonalDocId(identity)
  const did = identity.getDid()

  // Set up vault client for persistent encrypted storage
  if (vaultUrl) {
    vaultClient = new VaultClient(vaultUrl, identity)
    vaultPersonalKey = personalKey
  }

  // Open CompactStore for local doc persistence
  compactStore = new CompactStorageManager(COMPACT_STORE_DB)
  await compactStore.open()

  // Create repo with SyncOnlyStorageAdapter (only sync-state, no doc chunks)
  const syncStorage = new SyncOnlyStorageAdapter(SYNC_STATE_DB)
  personalRepo = new Repo({
    peerId: `${did}-personal` as any,
    network: [],
    storage: syncStorage,
    sharePolicy: async () => true,
  })

  const metrics = getMetrics()
  metrics.setImpl('compact-store')
  registerDebugApi(metrics)
  let handle!: DocHandle<PersonalDoc>
  let loadedFrom = ''

  // 1) Try CompactStore (fastest path — single snapshot from own IDB)
  try {
    const t0 = Date.now()
    const snapshot = await compactStore.load(VAULT_PERSONAL_DOC_ID)
    const t1 = Date.now()
    if (snapshot && snapshot.length > 0) {
      handle = personalRepo.import<PersonalDoc>(snapshot, { docId: documentId })
      const t2 = Date.now()
      if (!handle.isReady()) handle.doneLoading()
      const doc = handle.doc()
      const t3 = Date.now()
      console.debug(`[personal-doc] CompactStore load breakdown: idb=${t1-t0}ms import=${t2-t1}ms doc=${t3-t2}ms size=${snapshot.length}B`)
      if (doc && typeof doc === 'object') {
        loadedFrom = 'compact-store'
        const timeMs = Date.now() - t0
        metrics.logLoad('compact-store', timeMs, snapshot.length, {
          contacts: Object.keys(doc.contacts ?? {}).length,
          attestations: Object.keys(doc.attestations ?? {}).length,
          spaces: Object.keys(doc.spaces ?? {}).length,
        })
        metrics.setDocStats(
          snapshot.length,
          Object.keys(doc.contacts ?? {}).length,
          Object.keys(doc.attestations ?? {}).length,
          Object.keys(doc.spaces ?? {}).length,
        )
      }
    }
  } catch (err) {
    metrics.logError('load:compact-store', err)
  }

  // 2) Migration: old automerge-personal IDB → CompactStore (one-time)
  if (!loadedFrom) {
    try {
      const tMig = Date.now()
      // Only attempt migration if the old IDB actually exists (has data)
      const oldIdbExists = await idbHasData('automerge-personal', 'documents')
      console.debug(`[personal-doc] Migration check: exists=${oldIdbExists} took=${Date.now()-tMig}ms`)
      if (oldIdbExists) {
        const idbHealthy = await checkIdbHealth('automerge-personal', 'documents')
        if (idbHealthy) {
          // Create temporary repo just to read from old IDB
          const { IndexedDBStorageAdapter } = await import('@automerge/automerge-repo-storage-indexeddb')
          const tempRepo = new Repo({
            peerId: `${did}-migration` as any,
            network: [],
            storage: new IndexedDBStorageAdapter('automerge-personal'),
            sharePolicy: async () => true,
          })
          try {
            const t0 = Date.now()
            const tempHandle = await Promise.race([
              tempRepo.find<PersonalDoc>(documentUrl),
              new Promise<never>((_, reject) => setTimeout(() => reject(new Error('migration find timeout')), 8000)),
            ])
            const doc = tempHandle.doc()
            if (doc && typeof doc === 'object') {
              // Save to CompactStore
              const docBinary = Automerge.save(doc)
              await compactStore.save(VAULT_PERSONAL_DOC_ID, docBinary)

              // Import into main repo
              handle = personalRepo.import<PersonalDoc>(docBinary, { docId: documentId })
              if (!handle.isReady()) handle.doneLoading()

              loadedFrom = 'migration'
              const timeMs = Date.now() - t0
              const fromChunks = metrics['_idbChunkCount'] ?? 0
              metrics.logMigration(typeof fromChunks === 'number' ? fromChunks : 0, docBinary.length)
              metrics.logLoad('migration', timeMs, docBinary.length, {
                contacts: Object.keys(doc.contacts ?? {}).length,
                attestations: Object.keys(doc.attestations ?? {}).length,
                spaces: Object.keys(doc.spaces ?? {}).length,
                source: 'automerge-personal',
              })
              metrics.setDocStats(
                docBinary.length,
                Object.keys(doc.contacts ?? {}).length,
                Object.keys(doc.attestations ?? {}).length,
                Object.keys(doc.spaces ?? {}).length,
              )
            }
          } finally {
            try { tempRepo.shutdown() } catch { /* best effort */ }
          }
        }
        // Delete old IDB after migration (or if unhealthy — vault is the fallback)
        await new Promise<void>((resolve) => {
          const req = indexedDB.deleteDatabase('automerge-personal')
          req.onsuccess = () => resolve()
          req.onerror = () => resolve()
          req.onblocked = () => resolve()
        }).catch(() => {})
        console.debug('[personal-doc] Cleaned up old automerge-personal IDB')
      }
    } catch (err) {
      metrics.logError('load:migration', err)
    }
  }

  // 3) Fallback: try vault (compact snapshot over HTTP)
  if (!loadedFrom && vaultClient && vaultPersonalKey) {
    const t0 = Date.now()
    const vaultBinary = await restoreFromVault(vaultClient, vaultPersonalKey)
    if (vaultBinary && vaultBinary.length > 0) {
      handle = personalRepo.import<PersonalDoc>(vaultBinary, { docId: documentId })
      if (!handle.isReady()) handle.doneLoading()

      const doc = handle.doc()
      if (doc && typeof doc === 'object') {
        loadedFrom = 'vault'
        const timeMs = Date.now() - t0
        metrics.logLoad('vault', timeMs, vaultBinary.length, {
          contacts: Object.keys(doc.contacts ?? {}).length,
          attestations: Object.keys(doc.attestations ?? {}).length,
          spaces: Object.keys(doc.spaces ?? {}).length,
        })
        metrics.setDocStats(
          vaultBinary.length,
          Object.keys(doc.contacts ?? {}).length,
          Object.keys(doc.attestations ?? {}).length,
          Object.keys(doc.spaces ?? {}).length,
        )
        // Save to CompactStore for fast next load
        await compactStore.save(VAULT_PERSONAL_DOC_ID, vaultBinary)
      }
    } else {
      console.debug('[personal-doc] Vault has no data')
    }
  }

  // 4) Fallback: old wot-personal-doc IDB migration or create empty
  if (!loadedFrom) {
    const oldData = await loadFromOldIDB()
    if (oldData) {
      const migratedDoc = { ...emptyPersonalDoc(), ...oldData }
      handle = personalRepo.import<PersonalDoc>(new Uint8Array(0), { docId: documentId })
      if (!handle.isReady()) handle.doneLoading()
      handle.change(doc => { Object.assign(doc, migratedDoc) })
      loadedFrom = 'migration'
      metrics.logLoad('migration', 0, 0, { source: 'old-idb' })
      await deleteOldIDB()
    } else {
      handle = personalRepo.import<PersonalDoc>(new Uint8Array(0), { docId: documentId })
      if (!handle.isReady()) handle.doneLoading()
      handle.change(doc => { Object.assign(doc, emptyPersonalDoc()) })
      loadedFrom = 'new'
      metrics.logLoad('new', 0, 0)
    }
  }

  // Create CompactStore scheduler (2s debounce for local persistence)
  compactScheduler = new VaultPushScheduler({
    pushFn: pushToCompactStore,
    getHeadsFn: () => {
      const d = handle.doc()
      return d ? Automerge.getHeads(d).join(',') : null
    },
    debounceMs: 2000,
  })
  // Mark initial heads as saved if loaded from CompactStore
  if (loadedFrom === 'compact-store') {
    const initialDoc = handle.doc()
    if (initialDoc) compactScheduler.setLastPushedHeads(Automerge.getHeads(initialDoc).join(','))
  }

  // Create VaultPushScheduler
  if (vaultClient) {
    vaultScheduler = new VaultPushScheduler({
      pushFn: pushToVault,
      getHeadsFn: () => {
        const d = handle.doc()
        return d ? Automerge.getHeads(d).join(',') : null
      },
      debounceMs: 5000,
    })

    // If loaded from vault, vault already has this state — mark as saved
    const initialDoc = handle.doc()
    if (initialDoc && loadedFrom === 'vault') {
      vaultScheduler.setLastPushedHeads(Automerge.getHeads(initialDoc).join(','))
    }

    // Push to vault when it's empty or was just cleaned up
    if (loadedFrom !== 'vault' && loadedFrom !== 'new') {
      vaultScheduler.pushDebounced()
    }
  }

  docHandle = handle

  // Add network adapter AFTER doc is loaded from local storage —
  // adding it before find() causes Automerge to wait for peer sync (~20s)
  if (messaging) {
    networkAdapter = new PersonalNetworkAdapter(messaging, personalKey, did)
    networkAdapter.setDocumentId(documentId)
    networkAdapter.setDocHandle(handle)
    personalRepo.networkSubsystem.addNetworkAdapter(networkAdapter)
    networkAdapter.setDocReady()
  }

  // Listen for all changes — notify on remote changes only
  // (local changes are handled in changePersonalDoc which sets localChangeInProgress)
  handle.on('change', () => {
    if (!localChangeInProgress) {
      console.debug('[personal-doc] Remote change detected, notifying listeners')
      notifyListeners()
      // No vault push here — the sender already pushed to vault.
      // But persist locally via CompactStore (debounced) for offline-first.
      compactScheduler?.pushDebounced()
    }
  })

  // Emit peer-candidate for self (other devices use the same DID)
  if (networkAdapter) {
    // Tell the repo about our "peer" (our other devices)
    networkAdapter.emit('peer-candidate', {
      peerId: did as any,
      peerMetadata: { isEphemeral: true },
    })
  }

  const doc = handle.doc()
  if (!doc) throw new Error('Failed to initialize personal doc')
  console.debug(`[personal-doc] initPersonalDoc total: ${Date.now() - tInit}ms (loaded from: ${loadedFrom})`)
  return doc
}

/**
 * Get the current personal document. Throws if not initialized.
 */
export function getPersonalDoc(): PersonalDoc {
  if (!docHandle) {
    throw new Error('Personal doc not initialized. Call initPersonalDoc() first.')
  }
  const doc = docHandle.doc()
  if (!doc) {
    throw new Error('Personal doc not ready.')
  }
  return doc
}

/**
 * Check if the personal doc is initialized.
 */
export function isPersonalDocInitialized(): boolean {
  return docHandle !== null && docHandle.doc() !== undefined
}

/**
 * Apply a change to the personal document.
 * Uses Automerge's change() for CRDT operations.
 * Notifies all listeners after the change.
 *
 * @param options.background - If true, debounce persistence instead of pushing immediately.
 *   Use for background updates (cache, contact sync) that don't need instant persistence.
 */
export function changePersonalDoc(fn: (doc: PersonalDoc) => void, options?: { background?: boolean }): PersonalDoc {
  if (!docHandle) {
    throw new Error('Personal doc not initialized. Call initPersonalDoc() first.')
  }
  localChangeInProgress = true
  try {
    docHandle.change(fn)
  } finally {
    localChangeInProgress = false
  }
  notifyListeners()
  if (options?.background) {
    compactScheduler?.pushDebounced()
    vaultScheduler?.pushDebounced()
  } else {
    compactScheduler?.pushImmediate()
    vaultScheduler?.pushImmediate()
  }
  const doc = docHandle.doc()
  if (!doc) throw new Error('Doc disappeared after change')
  return doc
}

/**
 * Subscribe to changes on the personal document.
 * Returns an unsubscribe function.
 * Fires on both local changes and remote sync updates.
 */
export function onPersonalDocChange(callback: () => void): () => void {
  changeListeners.add(callback)
  return () => { changeListeners.delete(callback) }
}

/**
 * Force-flush the personal doc to CompactStore and Vault immediately.
 */
export async function flushPersonalDoc(): Promise<void> {
  await compactScheduler?.flush()
  await vaultScheduler?.flush()
}

/**
 * Reset the personal document — shut down repo and clear data.
 */
export async function resetPersonalDoc(): Promise<void> {
  const repo = personalRepo
  const adapter = networkAdapter
  docHandle = null
  personalRepo = null
  networkAdapter = null
  vaultClient = null
  vaultPersonalKey = null
  vaultSeq = 0
  if (compactScheduler) { compactScheduler.destroy(); compactScheduler = null }
  if (vaultScheduler) { vaultScheduler.destroy(); vaultScheduler = null }
  if (compactStore) { compactStore.close(); compactStore = null }
  changeListeners.clear()
  // Shutdown after clearing refs (so nothing retries during shutdown)
  try {
    adapter?.disconnect()
    repo?.shutdown()
  } catch { /* best effort */ }
}

/**
 * Delete the personal doc database entirely.
 * Used on identity switch (stronger than resetPersonalDoc).
 */
export async function deletePersonalDocDB(): Promise<void> {
  await resetPersonalDoc()
  // Delete both old and new IndexedDB databases
  // Use timeout to avoid Firefox blocking indefinitely on open connections
  for (const dbName of [OLD_IDB_NAME, 'automerge-personal', COMPACT_STORE_DB, SYNC_STATE_DB]) {
    await Promise.race([
      new Promise<void>((resolve) => {
        const req = indexedDB.deleteDatabase(dbName)
        req.onsuccess = () => resolve()
        req.onblocked = () => { console.warn(`[personal-doc] deleteDatabase(${dbName}) blocked`); resolve() }
        req.onerror = () => resolve()
      }),
      new Promise<void>((resolve) => setTimeout(resolve, 2000)), // timeout fallback
    ])
  }
}
