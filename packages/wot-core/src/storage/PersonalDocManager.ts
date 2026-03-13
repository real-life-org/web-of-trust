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
import type { WotIdentity } from '../identity'
import type { MessagingAdapter } from '../adapters/interfaces/MessagingAdapter'
import { VaultClient, base64ToUint8 } from '../services/VaultClient'
import { EncryptedSyncService } from '../services/EncryptedSyncService'
import { PersonalNetworkAdapter } from '../adapters/replication/PersonalNetworkAdapter'

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
  publishState: Record<string, PublishStateDoc>
  cachedGraph: {
    entries: Record<string, CachedGraphEntryDoc>
    verifications: Record<string, CachedGraphVerificationDoc>
    attestations: Record<string, CachedGraphAttestationDoc>
  }
  outbox: Record<string, OutboxEntryDoc>
  spaces: Record<string, SpaceMetadataDoc>
  groupKeys: Record<string, GroupKeyDoc>
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
let vaultPushTimer: ReturnType<typeof setTimeout> | null = null
let vaultSeq = 0
const VAULT_PERSONAL_DOC_ID = '__personal__'

function emptyPersonalDoc(): PersonalDoc {
  return {
    profile: null,
    contacts: {},
    verifications: {},
    attestations: {},
    attestationMetadata: {},
    publishState: {},
    cachedGraph: {
      entries: {},
      verifications: {},
      attestations: {},
    },
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
    console.error('[personal-doc] Vault snapshot corrupt, deleting:', err)
    try {
      await vault.deleteDoc(VAULT_PERSONAL_DOC_ID)
      console.log('[personal-doc] Deleted corrupt vault snapshot')
    } catch (delErr) {
      console.debug('[personal-doc] Could not delete corrupt vault doc:', delErr)
    }
  }
  return null
}

/**
 * Push the current personal doc snapshot to the vault (encrypted).
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

    // Use Automerge.save() — compact compressed binary of current state
    const docBinary = Automerge.save(doc)
    if (!docBinary || docBinary.length === 0) return

    const encrypted = await EncryptedSyncService.encryptChange(
      docBinary,
      vaultPersonalKey,
      VAULT_PERSONAL_DOC_ID,
      0,
      '',
    )

    vaultSeq++
    await vaultClient.putSnapshot(VAULT_PERSONAL_DOC_ID, encrypted.ciphertext, encrypted.nonce, vaultSeq)
  } catch (err) {
    console.debug('[personal-doc] Vault push failed:', err)
  }
}

/**
 * Schedule a debounced vault push (5s after last change).
 */
function debouncedVaultPush(): void {
  if (!vaultClient) return
  if (vaultPushTimer) clearTimeout(vaultPushTimer)
  vaultPushTimer = setTimeout(() => {
    vaultPushTimer = null
    pushToVault()
  }, 5_000)
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

  const { documentId, documentUrl, personalKey } = await derivePersonalDocId(identity)
  const did = identity.getDid()

  // Set up vault client for persistent encrypted storage
  if (vaultUrl) {
    vaultClient = new VaultClient(vaultUrl, identity)
    vaultPersonalKey = personalKey
  }

  // Create IndexedDB storage for automerge-repo (separate from shared spaces)
  const { IndexedDBStorageAdapter } = await import('@automerge/automerge-repo-storage-indexeddb')
  const repoStorage = new IndexedDBStorageAdapter('automerge-personal')

  // Create repo WITHOUT network first — so find() only reads from local IndexedDB
  // (adding network adapters before find() causes Automerge to wait for peer sync)
  personalRepo = new Repo({
    peerId: `${did}-personal` as any,
    network: [],
    storage: repoStorage,
    sharePolicy: async () => true,
  })

  // Strategy: Try vault first (compact snapshot, fast), then IndexedDB (may have many incrementals)
  let handle!: DocHandle<PersonalDoc>
  let loadedFrom = ''

  // 1) Try vault restore first — single compact binary, much faster than 44+ IndexedDB incrementals
  if (vaultClient && vaultPersonalKey) {
    const vaultBinary = await restoreFromVault(vaultClient, vaultPersonalKey)
    if (vaultBinary && vaultBinary.length > 0) {
      // Vault snapshots are already compact (pushed via Automerge.save()),
      // so we can import directly without any compaction step
      handle = personalRepo.import<PersonalDoc>(vaultBinary, { docId: documentId })
      if (!handle.isReady()) handle.doneLoading()

      const doc = handle.doc()
      if (doc && typeof doc === 'object') {
        loadedFrom = 'vault'
        console.log(`[personal-doc] Restored from vault — contacts: ${Object.keys(doc.contacts ?? {}).length}, spaces: ${Object.keys(doc.spaces ?? {}).length}`)
      }
    } else {
      console.log('[personal-doc] Vault has no data')
    }
  }

  // 2) Fallback: load from local IndexedDB
  if (!loadedFrom) {
    try {
      handle = await Promise.race([
        personalRepo.find<PersonalDoc>(documentUrl),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('find timeout')), 5000)),
      ])
      const doc = handle.doc()
      if (doc && typeof doc === 'object') {
        loadedFrom = 'indexeddb'
      } else {
        throw new Error('Doc loaded but empty')
      }
    } catch (err) {
      console.warn('[personal-doc] IndexedDB load failed/timeout:', err)
    }
  }

  // 3) Fallback: old IDB migration or create empty
  if (!loadedFrom) {
    const oldData = await loadFromOldIDB()
    if (oldData) {
      const migratedDoc = { ...emptyPersonalDoc(), ...oldData }
      if (!migratedDoc.cachedGraph?.entries) migratedDoc.cachedGraph = emptyPersonalDoc().cachedGraph
      handle = personalRepo.import<PersonalDoc>(new Uint8Array(0), { docId: documentId })
      if (!handle.isReady()) handle.doneLoading()
      handle.change(doc => { Object.assign(doc, migratedDoc) })
      loadedFrom = 'migration'
      console.log('[personal-doc] Migrated from old IndexedDB format')
      await deleteOldIDB()
    } else {
      handle = personalRepo.import<PersonalDoc>(new Uint8Array(0), { docId: documentId })
      if (!handle.isReady()) handle.doneLoading()
      handle.change(doc => { Object.assign(doc, emptyPersonalDoc()) })
      loadedFrom = 'new'
      console.log('[personal-doc] Created new Automerge doc')
    }
    await personalRepo.flush([documentId])
  }

  // Compact IndexedDB in background (replaces many incrementals with 1 snapshot)
  if (loadedFrom === 'vault' || loadedFrom === 'indexeddb') {
    personalRepo.flush([documentId]).then(() => {
      console.log(`[personal-doc] IndexedDB compacted after ${loadedFrom} load`)
    }).catch(() => {})
  }

  // Push to vault when it's empty or was just cleaned up (corrupt snapshot deleted)
  // Also covers migration from old format
  if (loadedFrom !== 'vault' && loadedFrom !== 'new' && vaultClient) {
    debouncedVaultPush()
  }

  docHandle = handle

  // Add network adapter AFTER doc is loaded from local storage —
  // adding it before find() causes Automerge to wait for peer sync (~20s)
  if (messaging) {
    networkAdapter = new PersonalNetworkAdapter(messaging, personalKey, did)
    networkAdapter.setDocumentId(documentId)
    personalRepo.networkSubsystem.addNetworkAdapter(networkAdapter)
    networkAdapter.setDocReady()
  }

  // Listen for all changes — notify on remote changes only
  // (local changes are handled in changePersonalDoc which sets localChangeInProgress)
  handle.on('change', () => {
    if (!localChangeInProgress) {
      console.log('[personal-doc] Remote change detected, notifying listeners')
      notifyListeners()
    }
    // Push to vault on any change (debounced) — but only if doc has real data
    // (avoid overwriting vault with empty doc before restore completes)
    const doc = handle.doc()
    if (doc && (doc.profile || Object.keys(doc.contacts).length > 0 || Object.keys(doc.spaces).length > 0)) {
      debouncedVaultPush()
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
 */
export function changePersonalDoc(fn: (doc: PersonalDoc) => void): PersonalDoc {
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
  debouncedVaultPush()
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
 * Force-flush the Automerge doc to IndexedDB immediately.
 */
export async function flushPersonalDoc(): Promise<void> {
  if (personalRepo && docHandle) {
    await personalRepo.flush([docHandle.documentId])
  }
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
  if (vaultPushTimer) { clearTimeout(vaultPushTimer); vaultPushTimer = null }
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
  for (const dbName of [OLD_IDB_NAME, 'automerge-personal']) {
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
