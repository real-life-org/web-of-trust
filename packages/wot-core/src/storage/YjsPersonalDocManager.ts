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
import type { WotIdentity } from '../identity'
import { CompactStorageManager } from './CompactStorageManager'
import { VaultPushScheduler } from '../services/VaultPushScheduler'

// Re-use the same type definitions from the Automerge PersonalDocManager
import type {
  PersonalDoc,
  ProfileDoc,
  ContactDoc,
  VerificationDoc,
  AttestationDoc,
  AttestationMetadataDoc,
  OutboxEntryDoc,
  SpaceMetadataDoc,
  GroupKeyDoc,
} from './PersonalDocManager'

// Re-export for convenience
export type { PersonalDoc as YjsPersonalDoc }

// --- Constants ---
const COMPACT_STORE_DB = 'wot-yjs-compact-store'
const PERSONAL_DOC_ID = 'personal-doc'

// --- Module State ---
let ydoc: Y.Doc | null = null
let compactStore: CompactStorageManager | null = null
let compactScheduler: VaultPushScheduler | null = null
let changeListeners = new Set<() => void>()
let localChangeInProgress = false

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

function getStateVectorString(): string | null {
  if (!ydoc) return null
  // Use base64-encoded state vector as dirty-check key
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
 * Restores from CompactStore if available.
 */
export async function initYjsPersonalDoc(identity: WotIdentity): Promise<PersonalDoc> {
  // Idempotent
  if (ydoc) return snapshotDoc()

  ydoc = new Y.Doc()

  // Open CompactStore
  compactStore = new CompactStorageManager(COMPACT_STORE_DB)
  await compactStore.open()

  // Try to restore from CompactStore
  const snapshot = await compactStore.load(PERSONAL_DOC_ID)
  if (snapshot) {
    Y.applyUpdate(ydoc, snapshot)
    console.debug('[yjs-personal-doc] Restored from CompactStore')
  }

  // Create CompactStore scheduler (2s debounce)
  compactScheduler = new VaultPushScheduler({
    pushFn: pushToCompactStore,
    getHeadsFn: getStateVectorString,
    debounceMs: 2000,
  })

  if (snapshot) {
    compactScheduler.setLastPushedHeads(getStateVectorString()!)
  }

  // Listen for remote changes (from multi-device sync)
  ydoc.on('update', (_update: Uint8Array, origin: any) => {
    if (origin !== 'local') {
      notifyListeners()
      compactScheduler?.pushDebounced()
    }
  })

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

  localChangeInProgress = true
  try {
    ydoc.transact(() => {
      const proxy = createDocProxy()
      fn(proxy)
    }, 'local')
  } finally {
    localChangeInProgress = false
  }

  notifyListeners()

  if (options?.background) {
    compactScheduler?.pushDebounced()
  } else {
    compactScheduler?.pushImmediate()
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
 * Force-flush to CompactStore immediately.
 */
export async function flushYjsPersonalDoc(): Promise<void> {
  await compactScheduler?.flush()
}

/**
 * Reset — shut down and clear all state.
 */
export async function resetYjsPersonalDoc(): Promise<void> {
  ydoc?.destroy()
  ydoc = null
  if (compactScheduler) { compactScheduler.destroy(); compactScheduler = null }
  if (compactStore) { compactStore.close(); compactStore = null }
  changeListeners.clear()
  localChangeInProgress = false
}
