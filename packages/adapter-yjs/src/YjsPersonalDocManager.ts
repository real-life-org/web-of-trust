/**
 * Yjs Personal Document Manager
 *
 * Drop-in alternative to the Automerge-based PersonalDocManager.
 * Uses Yjs (pure JavaScript CRDT) instead of Automerge (Rust→WASM).
 *
 * Key differences from the Automerge version:
 * - No WASM: ~69KB bundle instead of ~1.7MB
 * - No compaction needed: Yjs has built-in GC
 * - ~25-50x faster on mobile for 163KB docs
 * - Same persistence (CompactStore), same encryption (EncryptedSyncService)
 *
 * The mutation API uses Immer-style proxy objects that map to Y.Map operations,
 * keeping the same `changePersonalDoc(doc => { doc.field = value })` pattern
 * that the Automerge version uses.
 */
import * as Y from 'yjs'
import type { IdentitySession } from '@web_of_trust/core/types'
import type { MessagingAdapter } from '@web_of_trust/core/ports'
import {
  VaultPushScheduler,
  VaultClient,
  base64ToUint8,
  EncryptedSyncService,
} from '@web_of_trust/core/services'
import {
  CompactStorageManager,
  getMetrics,
  registerDebugApi,
} from '@web_of_trust/core/storage'
import { YjsPersonalSyncAdapter } from './YjsPersonalSyncAdapter'

import type {
  PersonalDoc,
  ProfileDoc,
} from './types'

// Re-export for convenience
export type { PersonalDoc as YjsPersonalDoc }

// --- Constants ---
const COMPACT_STORE_DB = 'wot-yjs-compact-store'
const PERSONAL_DOC_ID = 'personal-doc'
const VAULT_PERSONAL_DOC_ID = 'personal-doc'

// --- Module State ---
let ydoc: Y.Doc | null = null
let compactStore: CompactStorageManager | null = null
let compactScheduler: VaultPushScheduler | null = null
let vaultScheduler: VaultPushScheduler | null = null
let vaultClient: VaultClient | null = null
let vaultPersonalKey: Uint8Array | null = null
let vaultSeq = 0
let syncAdapter: YjsPersonalSyncAdapter | null = null
let changeListeners = new Set<() => void>()

// --- Y.Doc Structure ---
// Top-level Y.Maps that mirror the PersonalDoc interface

function getProfileMap(): Y.Map<any> {
  return ydoc!.getMap('profile')
}
function getContactsMap(): Y.Map<any> {
  return ydoc!.getMap('contacts')
}
function getVerificationsMap(): Y.Map<any> {
  return ydoc!.getMap('verifications')
}
function getAttestationsMap(): Y.Map<any> {
  return ydoc!.getMap('attestations')
}
function getAttestationMetadataMap(): Y.Map<any> {
  return ydoc!.getMap('attestationMetadata')
}
function getOutboxMap(): Y.Map<any> {
  return ydoc!.getMap('outbox')
}
function getSpacesMap(): Y.Map<any> {
  return ydoc!.getMap('spaces')
}
function getGroupKeysMap(): Y.Map<any> {
  return ydoc!.getMap('groupKeys')
}

// --- Snapshot: Y.Doc → PersonalDoc ---

function snapshotDoc(): PersonalDoc {
  if (!ydoc) throw new Error('Yjs personal doc not initialized')

  const profileMap = getProfileMap()
  const profile = profileMap.size > 0 ? ymapToPlain(profileMap) as ProfileDoc : null

  return {
    profile,
    contacts: ymapOfMapsToRecord(getContactsMap()),
    verifications: ymapOfMapsToRecord(getVerificationsMap()),
    attestations: ymapOfMapsToRecord(getAttestationsMap()),
    attestationMetadata: ymapOfMapsToRecord(getAttestationMetadataMap()),
    outbox: ymapOfMapsToRecord(getOutboxMap()),
    spaces: ymapOfMapsToRecord(getSpacesMap()),
    groupKeys: ymapOfMapsToRecord(getGroupKeysMap()),
  }
}

/** Convert a Y.Map to a plain object */
function ymapToPlain(ymap: Y.Map<any>): Record<string, any> {
  const obj: Record<string, any> = {}
  ymap.forEach((value, key) => {
    if (value instanceof Y.Map) {
      obj[key] = ymapToPlain(value)
    } else if (value instanceof Y.Array) {
      obj[key] = value.toArray()
    } else {
      obj[key] = value
    }
  })
  return obj
}

/** Convert Y.Map<Y.Map> to Record<string, T> */
function ymapOfMapsToRecord<T>(ymap: Y.Map<any>): Record<string, T> {
  const record: Record<string, T> = {}
  ymap.forEach((value, key) => {
    if (value instanceof Y.Map) {
      record[key] = ymapToPlain(value) as T
    }
  })
  return record
}

// --- Apply: PersonalDoc mutations → Y.Doc ---

/**
 * Create a proxy that intercepts property access and mutations,
 * mapping them to Y.Map operations. This allows the same
 * `changePersonalDoc(doc => { doc.contacts[did] = {...} })` pattern.
 */
function createDocProxy(): PersonalDoc {
  return {
    get profile(): ProfileDoc | null {
      const profileMap = getProfileMap()
      if (profileMap.size === 0) return null
      // Return a nested proxy so field-level mutations work (doc.profile.bio = 'x')
      return createNestedProxy(profileMap) as ProfileDoc
    },
    set profile(value: ProfileDoc | null) {
      const profileMap = getProfileMap()
      if (value === null) {
        for (const key of Array.from(profileMap.keys())) {
          profileMap.delete(key)
        }
      } else {
        // Clear old keys not in the new value, then apply new values
        for (const key of Array.from(profileMap.keys())) {
          if (!(key in value)) profileMap.delete(key)
        }
        applyPlainToYmap(profileMap, value)
      }
    },
    get contacts() { return createRecordProxy(getContactsMap()) },
    set contacts(_v) { /* handled by proxy */ },
    get verifications() { return createRecordProxy(getVerificationsMap()) },
    set verifications(_v) { /* handled by proxy */ },
    get attestations() { return createRecordProxy(getAttestationsMap()) },
    set attestations(_v) { /* handled by proxy */ },
    get attestationMetadata() { return createRecordProxy(getAttestationMetadataMap()) },
    set attestationMetadata(_v) { /* handled by proxy */ },
    get outbox() { return createRecordProxy(getOutboxMap()) },
    set outbox(_v) { /* handled by proxy */ },
    get spaces() { return createRecordProxy(getSpacesMap()) },
    set spaces(_v) { /* handled by proxy */ },
    get groupKeys() { return createRecordProxy(getGroupKeysMap()) },
    set groupKeys(_v) { /* handled by proxy */ },
  } as PersonalDoc
}

/**
 * Create a Proxy for Record<string, T> that maps to Y.Map operations.
 * Supports: proxy[key] = value, delete proxy[key], Object.keys(proxy), etc.
 */
function createRecordProxy<T>(ymap: Y.Map<any>): Record<string, T> {
  return new Proxy({} as Record<string, T>, {
    get(_target, prop: string) {
      if (prop === Symbol.iterator as any || prop === 'toJSON') return undefined
      const value = ymap.get(prop)
      if (value instanceof Y.Map) {
        // Return a nested proxy for field-level mutations like doc.contacts[did].name = 'x'
        return createNestedProxy(value)
      }
      return value
    },
    set(_target, prop: string, value: any) {
      if (value && typeof value === 'object' && !(value instanceof Y.Map)) {
        // Set a plain object → create/update Y.Map
        let childMap = ymap.get(prop) as Y.Map<any> | undefined
        if (!(childMap instanceof Y.Map)) {
          childMap = new Y.Map()
          ymap.set(prop, childMap)
        }
        applyPlainToYmap(childMap, value)
      } else {
        ymap.set(prop, value)
      }
      return true
    },
    deleteProperty(_target, prop: string) {
      ymap.delete(prop)
      return true
    },
    has(_target, prop: string) {
      return ymap.has(prop)
    },
    ownKeys() {
      return Array.from(ymap.keys())
    },
    getOwnPropertyDescriptor(_target, prop: string) {
      if (ymap.has(prop)) {
        return { configurable: true, enumerable: true, writable: true, value: ymap.get(prop) }
      }
      return undefined
    },
  })
}

/**
 * Create a proxy for a nested Y.Map that allows field-level mutations.
 * e.g., doc.contacts[did].name = 'New Name'
 */
function createNestedProxy(ymap: Y.Map<any>): any {
  return new Proxy({}, {
    get(_target, prop: string) {
      const value = ymap.get(prop)
      if (value instanceof Y.Map) {
        return createNestedProxy(value)
      } else if (value instanceof Y.Array) {
        return value.toArray()
      }
      return value
    },
    set(_target, prop: string, value: any) {
      if (Array.isArray(value)) {
        // Store arrays as Y.Array for CRDT mergeability
        const yarray = new Y.Array()
        yarray.push(value)
        ymap.set(prop, yarray)
      } else if (value && typeof value === 'object') {
        let childMap = ymap.get(prop) as Y.Map<any> | undefined
        if (!(childMap instanceof Y.Map)) {
          childMap = new Y.Map()
          ymap.set(prop, childMap)
        }
        applyPlainToYmap(childMap, value)
      } else {
        ymap.set(prop, value)
      }
      return true
    },
    deleteProperty(_target, prop: string) {
      ymap.delete(prop)
      return true
    },
    has(_target, prop: string) {
      return ymap.has(prop)
    },
    ownKeys() {
      return Array.from(ymap.keys())
    },
    getOwnPropertyDescriptor(_target, prop: string) {
      if (ymap.has(prop)) {
        return { configurable: true, enumerable: true, writable: true, value: ymap.get(prop) }
      }
      return undefined
    },
  })
}

/** Apply a plain object's fields onto a Y.Map */
function applyPlainToYmap(ymap: Y.Map<any>, plain: Record<string, any>): void {
  for (const [key, value] of Object.entries(plain)) {
    if (Array.isArray(value)) {
      const yarray = new Y.Array()
      yarray.push(value)
      ymap.set(key, yarray)
    } else if (value && typeof value === 'object') {
      let childMap = ymap.get(key) as Y.Map<any> | undefined
      if (!(childMap instanceof Y.Map)) {
        childMap = new Y.Map()
        ymap.set(key, childMap)
      }
      applyPlainToYmap(childMap, value)
    } else {
      ymap.set(key, value)
    }
  }
}

// --- Persistence ---

async function pushToCompactStore(): Promise<void> {
  if (!compactStore || !ydoc) return
  try {
    const update = Y.encodeStateAsUpdate(ydoc)
    await compactStore.save(PERSONAL_DOC_ID, update)
  } catch (err) {
    console.error('[yjs-personal-doc] CompactStore save failed:', err)
  }
}

async function pushToVault(): Promise<void> {
  if (!vaultClient || !vaultPersonalKey || !ydoc) return

  try {
    // Don't push if local doc has no meaningful data
    const doc = snapshotDoc()
    const hasData = doc.profile || Object.keys(doc.contacts).length > 0 || Object.keys(doc.spaces).length > 0
    if (!hasData) {
      console.debug('[yjs-personal-doc] Skip vault push — no meaningful data yet')
      return
    }

    // Yjs: no compaction needed, Y.encodeStateAsUpdate is already compact
    const docBinary = Y.encodeStateAsUpdate(ydoc)
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
    console.debug(`[yjs-personal-doc] Vault push: ${docBinary.length}B`)
  } catch (err) {
    console.error('[yjs-personal-doc] Vault push failed:', err)
  }
}

async function restoreFromVault(): Promise<boolean> {
  if (!vaultClient || !vaultPersonalKey || !ydoc) return false

  try {
    const response = await vaultClient.getChanges(VAULT_PERSONAL_DOC_ID, 0)
    if (!response) return false

    // Restore snapshot if available
    if (response.snapshot?.data) {
      // Vault stores packed format: [nonceLen(1 byte)][nonce][ciphertext]
      const packed = base64ToUint8(response.snapshot.data)
      const nonceLen = packed[0]
      const nonce = packed.slice(1, 1 + nonceLen)
      const ciphertext = packed.slice(1 + nonceLen)

      const decrypted = await EncryptedSyncService.decryptChange(
        { ciphertext, nonce, spaceId: VAULT_PERSONAL_DOC_ID, generation: 0, fromDid: '' },
        vaultPersonalKey,
      )
      Y.applyUpdate(ydoc, decrypted)
      vaultSeq = response.snapshot.upToSeq
      console.debug('[yjs-personal-doc] Restored from vault snapshot')
    }

    // Apply incremental changes (same packed format)
    for (const change of response.changes) {
      const packed = base64ToUint8(change.data)
      const nonceLen = packed[0]
      const nonce = packed.slice(1, 1 + nonceLen)
      const ciphertext = packed.slice(1 + nonceLen)

      const decrypted = await EncryptedSyncService.decryptChange(
        { ciphertext, nonce, spaceId: VAULT_PERSONAL_DOC_ID, generation: 0, fromDid: '' },
        vaultPersonalKey,
      )
      Y.applyUpdate(ydoc, decrypted)
      vaultSeq = Math.max(vaultSeq, change.seq)
    }

    return response.snapshot !== null || response.changes.length > 0
  } catch (err) {
    console.debug('[yjs-personal-doc] Vault restore failed:', err)
    return false
  }
}

function getStateVectorString(): string | null {
  if (!ydoc) return null
  const sv = Y.encodeStateVector(ydoc)
  return Array.from(sv).join(',')
}

// --- Notification ---

function notifyListeners(): void {
  for (const cb of changeListeners) {
    try { cb() } catch (err) { console.error('[yjs-personal-doc] Listener error:', err) }
  }
}

// --- Public API ---

/**
 * Initialize the personal document as a Yjs Y.Doc.
 *
 * Load order: CompactStore → Vault → Empty
 *
 * @param identity - identity session for key derivation
 * @param messaging - Optional MessagingAdapter for multi-device sync via relay
 * @param vaultUrl - Optional vault URL for encrypted backup
 */
export async function initYjsPersonalDoc(identity: IdentitySession, messaging?: MessagingAdapter, vaultUrl?: string, externalCompactStore?: { open(): Promise<void>; save(id: string, data: Uint8Array): Promise<void>; load(id: string): Promise<Uint8Array | null>; delete(id: string): Promise<void>; list(): Promise<string[]>; close(): void }): Promise<PersonalDoc> {
  // Idempotent
  if (ydoc) return snapshotDoc()

  const tInit = Date.now()
  const metrics = getMetrics()
  metrics.setImpl('yjs')
  registerDebugApi(metrics)

  // Debug: expose PersonalDoc size breakdown on window
  if (typeof window !== 'undefined') {
    ;(window as any).wotDeleteSpace = async (spaceId: string) => {
      if (!ydoc) return console.warn('PersonalDoc not loaded')
      const spacesMap = ydoc.getMap('spaces')
      const groupKeysMap = ydoc.getMap('groupKeys')
      const before = spacesMap.size
      ydoc.transact(() => {
        spacesMap.delete(spaceId)
        for (const key of Array.from(groupKeysMap.keys())) {
          if (key.startsWith(spaceId + ':')) {
            groupKeysMap.delete(key)
            console.log(`Deleted group key ${key}`)
          }
        }
      }, 'local')
      const after = spacesMap.size
      console.log(`Deleted space ${spaceId} (spaces: ${before} → ${after})`)
      // Persist immediately
      await pushToCompactStore()
      await pushToVault()
      console.log('Persisted to CompactStore + Vault')
    }
    ;(window as any).wotDocSizes = () => {
      if (!ydoc) return console.warn('PersonalDoc not loaded')
      const maps = ['profile', 'contacts', 'verifications', 'attestations', 'attestationMetadata', 'spaces', 'groupKeys', 'outbox']
      const results: Record<string, any>[] = []
      for (const name of maps) {
        const map = ydoc.getMap(name)
        let jsonSize = 0
        const bigEntries: { key: string; sizeKB: string }[] = []
        for (const [k, v] of map.entries()) {
          let entrySize = 0
          try { entrySize = JSON.stringify(v) ?.length ?? 0 } catch { entrySize = 100 }
          jsonSize += entrySize
          if (entrySize > 10240) bigEntries.push({ key: k, sizeKB: (entrySize / 1024).toFixed(1) })
        }
        results.push({ map: name, entries: map.size, jsonSizeKB: (jsonSize / 1024).toFixed(1) })
        if (bigEntries.length > 0) {
          console.log(`  ${name} large entries:`, bigEntries)
        }
      }
      const totalBinary = Y.encodeStateAsUpdate(ydoc).byteLength
      results.push({ map: 'TOTAL (binary)', entries: '-', jsonSizeKB: (totalBinary / 1024).toFixed(1) })
      console.table(results)
      return results
    }
  }

  ydoc = new Y.Doc()
  let loadedFrom: 'compact-store' | 'vault' | 'new' = 'new'

  // Open CompactStore (use external if provided, e.g. SQLite for Node.js)
  if (externalCompactStore) {
    compactStore = externalCompactStore as any
    await compactStore!.open()
  } else {
    compactStore = new CompactStorageManager(COMPACT_STORE_DB)
    await compactStore.open()
  }

  // Try to restore from CompactStore
  const t0 = Date.now()
  const snapshot = await compactStore!.load(PERSONAL_DOC_ID)
  if (snapshot) {
    Y.applyUpdate(ydoc, snapshot)
    loadedFrom = 'compact-store'
    metrics.logLoad('compact-store', Date.now() - t0, snapshot.length)
    console.debug('[yjs-personal-doc] Restored from CompactStore')
  }

  // Vault setup
  if (vaultUrl) {
    const personalKey = await identity.deriveFrameworkKey('personal-doc-v1')
    vaultPersonalKey = personalKey
    vaultClient = new VaultClient(vaultUrl, identity)

    // If CompactStore was empty, try vault
    if (loadedFrom === 'new') {
      const t0v = Date.now()
      const restored = await restoreFromVault()
      if (restored) {
        loadedFrom = 'vault'
        const stateSize = Y.encodeStateAsUpdate(ydoc).length
        metrics.logLoad('vault', Date.now() - t0v, stateSize)
      }
    }
  }

  // Migration: rebuild doc without legacy outbox entries
  // (outbox moved to LocalOutboxStore / IndexedDB)
  // Yjs keeps tombstones for deleted entries, so simply deleting keys
  // doesn't reduce binary size. We must rebuild the doc from scratch.
  const legacyOutbox = ydoc.getMap('outbox')
  if (legacyOutbox.size > 0) {
    const oldDoc = ydoc
    const oldSize = Y.encodeStateAsUpdate(oldDoc).byteLength
    // Snapshot all maps as plain JSON (Yjs objects can't be moved between docs)
    const mapsToKeep = ['profile', 'contacts', 'verifications', 'attestations', 'attestationMetadata', 'spaces', 'groupKeys']
    const snapshots = new Map<string, Record<string, any>>()
    for (const mapName of mapsToKeep) {
      const src = oldDoc.getMap(mapName)
      if (src.size > 0) {
        snapshots.set(mapName, src.toJSON())
      }
    }
    // Build fresh doc from plain data
    const freshDoc = new Y.Doc()
    freshDoc.transact(() => {
      for (const [mapName, data] of snapshots) {
        const dst = freshDoc.getMap(mapName)
        if (mapName === 'profile') {
          // profile is a flat map, not a map-of-maps
          applyPlainToYmap(dst, data)
        } else {
          // contacts, spaces, etc. are maps of maps
          // Must set child into parent BEFORE populating (Yjs requires integration)
          for (const [k, v] of Object.entries(data)) {
            const child = new Y.Map()
            dst.set(k, child)
            applyPlainToYmap(child, v as Record<string, any>)
          }
        }
      }
    }, 'local')
    oldDoc.destroy()
    ydoc = freshDoc
    const newSize = Y.encodeStateAsUpdate(ydoc).byteLength
    console.debug(`[yjs-personal-doc] Migration: rebuilt doc without outbox (${(oldSize/1024).toFixed(0)}KB → ${(newSize/1024).toFixed(0)}KB)`)
    // Persist immediately so the smaller doc replaces the bloated one
    const migratedUpdate = Y.encodeStateAsUpdate(ydoc)
    await compactStore!.save(PERSONAL_DOC_ID, migratedUpdate)
    // Also push to vault immediately so remote doesn't merge old bloated state back
    if (vaultClient && vaultPersonalKey) {
      try {
        const encrypted = await EncryptedSyncService.encryptChange(
          migratedUpdate, vaultPersonalKey, VAULT_PERSONAL_DOC_ID, 0, '',
        )
        vaultSeq++
        await vaultClient.putSnapshot(VAULT_PERSONAL_DOC_ID, encrypted.ciphertext, encrypted.nonce, vaultSeq)
        console.debug(`[yjs-personal-doc] Migration: vault updated (${(newSize/1024).toFixed(0)}KB)`)
      } catch (err) {
        console.warn('[yjs-personal-doc] Migration vault push failed:', err)
      }
    }
  }

  // Create CompactStore scheduler (2s debounce)
  compactScheduler = new VaultPushScheduler({
    pushFn: pushToCompactStore,
    getHeadsFn: getStateVectorString,
    debounceMs: 2000,
  })

  if (loadedFrom === 'compact-store') {
    compactScheduler.setLastPushedHeads(getStateVectorString()!)
  }

  // Create Vault scheduler (5s debounce)
  if (vaultClient) {
    vaultScheduler = new VaultPushScheduler({
      pushFn: pushToVault,
      getHeadsFn: getStateVectorString,
      debounceMs: 5000,
    })
    if (loadedFrom === 'vault') {
      vaultScheduler.setLastPushedHeads(getStateVectorString()!)
    }
    // If loaded from CompactStore, push to vault (may be newer)
    if (loadedFrom === 'compact-store') {
      vaultScheduler.pushDebounced()
    }
  }

  // Listen for remote changes (from multi-device sync)
  ydoc.on('update', (_update: Uint8Array, origin: any) => {
    if (origin !== 'local') {
      // Prevent legacy outbox from being re-synced from remote devices
      const outboxMap = ydoc!.getMap('outbox')
      if (outboxMap.size > 0) {
        ydoc!.transact(() => {
          for (const key of Array.from(outboxMap.keys())) {
            outboxMap.delete(key)
          }
        }, 'local')
      }
      notifyListeners()
      compactScheduler?.pushDebounced()
    }
  })

  // Multi-device sync via relay
  if (messaging && vaultPersonalKey) {
    const did = identity.getDid()
    syncAdapter = new YjsPersonalSyncAdapter(ydoc, messaging, vaultPersonalKey, did, (data: string) => identity.sign(data))
    syncAdapter.start()
  }

  if (loadedFrom === 'new') {
    metrics.logLoad('new', 0, 0)
  }

  console.debug(`[yjs-personal-doc] Initialized in ${Date.now() - tInit}ms (loaded from: ${loadedFrom})`)
  return snapshotDoc()
}

/**
 * Get the current personal document snapshot.
 */
export function getYjsPersonalDoc(): PersonalDoc {
  if (!ydoc) throw new Error('Yjs personal doc not initialized. Call initYjsPersonalDoc() first.')
  return snapshotDoc()
}

/**
 * Apply a change to the personal document.
 * Uses a Proxy that maps property assignments to Y.Map operations.
 */
export function changeYjsPersonalDoc(fn: (doc: PersonalDoc) => void, options?: { background?: boolean }): PersonalDoc {
  if (!ydoc) throw new Error('Yjs personal doc not initialized. Call initYjsPersonalDoc() first.')

  ydoc.transact(() => {
    const proxy = createDocProxy()
    fn(proxy)
  }, 'local')

  notifyListeners()

  if (options?.background) {
    compactScheduler?.pushDebounced()
    vaultScheduler?.pushDebounced()
  } else {
    compactScheduler?.pushImmediate()
    vaultScheduler?.pushImmediate()
  }

  return snapshotDoc()
}

/**
 * Subscribe to changes on the personal document.
 */
export function onYjsPersonalDocChange(callback: () => void): () => void {
  changeListeners.add(callback)
  return () => { changeListeners.delete(callback) }
}

/**
 * Force-flush to CompactStore and Vault immediately.
 * Waits for any in-progress pushes to complete, then does a final push.
 */
export async function flushYjsPersonalDoc(): Promise<void> {
  // Direct push (bypasses scheduler) to ensure data is persisted
  await pushToCompactStore()
  await pushToVault()
}

/**
 * Pull the latest PersonalDoc from the Vault and merge into the local Y.Doc.
 * Used as a fallback when a Space Vault-Pull fails due to a missing key —
 * the Vault may have a newer PersonalDoc with the required key.
 */
export async function refreshYjsPersonalDocFromVault(): Promise<boolean> {
  return restoreFromVault()
}

/**
 * Reset — shut down and clear all state.
 */
export async function resetYjsPersonalDoc(): Promise<void> {
  if (syncAdapter) { syncAdapter.destroy(); syncAdapter = null }
  ydoc?.destroy()
  ydoc = null
  if (compactScheduler) { compactScheduler.destroy(); compactScheduler = null }
  if (vaultScheduler) { vaultScheduler.destroy(); vaultScheduler = null }
  if (compactStore) { compactStore.close(); compactStore = null }
  vaultClient = null
  vaultPersonalKey = null
  vaultSeq = 0
  changeListeners.clear()
}

/**
 * Delete — reset + delete IndexedDB databases.
 * Used on logout to fully clear persisted state.
 */
export async function deleteYjsPersonalDocDB(): Promise<void> {
  await resetYjsPersonalDoc()
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase(COMPACT_STORE_DB)
    req.onsuccess = () => resolve()
    req.onerror = () => resolve()
  })
}
