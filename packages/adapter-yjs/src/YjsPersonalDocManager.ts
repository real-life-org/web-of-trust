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
 * - Same persistence (CompactStore), same encryption (encryptOneShot/decryptOneShot)
 *
 * The mutation API uses Immer-style proxy objects that map to Y.Map operations,
 * keeping the same `changePersonalDoc(doc => { doc.field = value })` pattern
 * that the Automerge version uses.
 */
import * as Y from 'yjs'
import type { IdentitySession } from '@web_of_trust/core/types'
import type { MessagingAdapter, DocLogStore } from '@web_of_trust/core/ports'
import type { ProtocolCryptoAdapter } from '@web_of_trust/core/protocol'
import { decryptOneShot, encryptOneShot, personalDocIdFromKey } from '@web_of_trust/core/protocol'
import { WebCryptoProtocolCryptoAdapter } from '@web_of_trust/core/protocol-adapters'
import {
  VaultPushScheduler,
  VaultClient,
  DualVaultClient,
  type VaultClientLike,
  base64ToUint8,
} from '@web_of_trust/core/adapters'
import {
  CompactStorageManager,
  getMetrics,
  registerDebugApi,
} from '@web_of_trust/core/storage'
// A2: the legacy YjsPersonalSyncAdapter (personal-sync broadcast) is UN-WIRED — replaced by the
// durable-log adapter. Its class file stays dormant (post-festival cleanup), no longer imported.
import { YjsPersonalLogSyncAdapter } from './YjsPersonalLogSyncAdapter'

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
let vaultClient: VaultClientLike | null = null
let vaultPersonalKey: Uint8Array | null = null
let vaultSeq = 0
// local-first (Blocker 2): when init is asked to skip the (network) vault restore,
// remember whether a background restore is still owed — set ONLY when the local
// CompactStore was empty (loadedFrom === 'new'), mirroring the original init
// condition. A doc that already loaded from CompactStore never owed a startup pull.
let deferredVaultRestore = false
// In-flight guard: restoreFromVault has TWO callers — the background startup pull
// and refreshYjsPersonalDocFromVault (the replication adapter's missing-key
// fallback). Without this a background restore + a concurrent refresh would run
// the same getChanges/applyUpdate path twice against the living doc.
let restoreInFlight: Promise<boolean> | null = null
// local-first (Blocker 2): local-write tracking for the render→background-restore
// window. setIsInitialized fires BEFORE the deferred vault restore, so the user can
// edit the living doc first. Yjs Map conflict resolution is by (clock, clientID) —
// NOT "later apply wins" — so a vault write from another device with a higher
// clientID would silently roll a fresh local edit back. We record which top-level
// entries the user edits (origin 'local'), and after the vault merge re-issue those
// edits as fresh 'local' writes (a causal successor deterministically wins).
const DIRTY_SEP = '\u0000' // NUL: never collides with Y.Map root/field names; escape (not raw byte) keeps the source ASCII-clean
let localDirtyKeys = new Set<string>()
let localWriteTracking: { doc: Y.Doc; handler: (tr: Y.Transaction) => void } | null = null
let logSyncAdapter: YjsPersonalLogSyncAdapter | null = null
let changeListeners = new Set<() => void>()
let protocolCrypto: ProtocolCryptoAdapter | null = null

/** Lazy protocol crypto singleton — OneShot encrypt/decrypt for vault snapshots. */
function getProtocolCrypto(): ProtocolCryptoAdapter {
  return (protocolCrypto ??= new WebCryptoProtocolCryptoAdapter())
}

// --- Y.Doc Structure ---
// Top-level Y.Maps that mirror the PersonalDoc interface

function getProfileMap(): Y.Map<any> {
  return ydoc!.getMap('profile')
}
function getContactsMap(): Y.Map<any> {
  return ydoc!.getMap('contacts')
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
function getCapabilitySigningSeedsMap(): Y.Map<any> {
  return ydoc!.getMap('capabilitySigningSeeds')
}
function getDismissedNotificationsMap(): Y.Map<any> {
  return ydoc!.getMap('dismissedNotifications')
}

function getExistingRootMap(doc: Y.Doc, name: string): Y.Map<any> | null {
  return doc.share.has(name) ? doc.getMap(name) : null
}

function rebuildPersonalDocWithoutLegacyMaps(oldDoc: Y.Doc): Y.Doc {
  // dismissedNotifications MUSS hier drinstehen: der Legacy-Rebuild kopiert NUR
  // die gelisteten Root-Maps in das frische Y.Doc — ein fehlender Eintrag würde
  // die synced Resolve-Marker beim Migrations-Rebuild still wegwerfen (Re-Show).
  const mapsToKeep = ['profile', 'contacts', 'attestations', 'attestationMetadata', 'spaces', 'groupKeys', 'capabilitySigningSeeds', 'dismissedNotifications']
  const snapshots = new Map<string, Record<string, any>>()
  for (const mapName of mapsToKeep) {
    const src = oldDoc.getMap(mapName)
    if (src.size > 0) {
      snapshots.set(mapName, src.toJSON())
    }
  }

  const freshDoc = new Y.Doc()
  freshDoc.transact(() => {
    for (const [mapName, data] of snapshots) {
      const dst = freshDoc.getMap(mapName)
      if (mapName === 'profile') {
        applyPlainToYmap(dst, data)
      } else {
        for (const [k, v] of Object.entries(data)) {
          const child = new Y.Map()
          dst.set(k, child)
          applyPlainToYmap(child, v as Record<string, any>)
        }
      }
    }
  }, 'local')

  return freshDoc
}

// --- Snapshot: Y.Doc → PersonalDoc ---

function snapshotDoc(): PersonalDoc {
  if (!ydoc) throw new Error('Yjs personal doc not initialized')

  const profileMap = getProfileMap()
  const profile = profileMap.size > 0 ? ymapToPlain(profileMap) as ProfileDoc : null

  return {
    profile,
    contacts: ymapOfMapsToRecord(getContactsMap()),
    attestations: ymapOfMapsToRecord(getAttestationsMap()),
    attestationMetadata: ymapOfMapsToRecord(getAttestationMetadataMap()),
    outbox: ymapOfMapsToRecord(getOutboxMap()),
    spaces: ymapOfMapsToRecord(getSpacesMap()),
    groupKeys: ymapOfMapsToRecord(getGroupKeysMap()),
    capabilitySigningSeeds: ymapOfMapsToRecord(getCapabilitySigningSeedsMap()),
    dismissedNotifications: ymapOfMapsToRecord(getDismissedNotificationsMap()),
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
    get capabilitySigningSeeds() { return createRecordProxy(getCapabilitySigningSeedsMap()) },
    set capabilitySigningSeeds(_v) { /* handled by proxy */ },
    get dismissedNotifications() { return createRecordProxy(getDismissedNotificationsMap()) },
    set dismissedNotifications(_v) { /* handled by proxy */ },
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

    const encrypted = await encryptOneShot({
      crypto: getProtocolCrypto(),
      spaceContentKey: vaultPersonalKey,
      plaintext: docBinary,
    })

    vaultSeq++
    await vaultClient.putSnapshot(VAULT_PERSONAL_DOC_ID, encrypted.ciphertextTag, encrypted.nonce, vaultSeq)
    console.debug(`[yjs-personal-doc] Vault push: ${docBinary.length}B`)
  } catch (err) {
    console.error('[yjs-personal-doc] Vault push failed:', err)
  }
}

// --- local-first (Blocker 2): local-write tracking + local-wins re-assert ---

/** The root-map name for a top-level Y.AbstractType (else null). */
function rootNameOfType(doc: Y.Doc, type: unknown): string | null {
  for (const [name, t] of doc.share) if (t === type) return name
  return null
}

/**
 * Resolve a changed AbstractType (from Y.Transaction.changed) to the
 * `${rootMapName}${SEP}${topLevelKey}` identities it affects. A direct change to a
 * root map yields one entry per changed key; a nested change (e.g. contacts[did].x)
 * walks up to the entry directly under the root (contacts::did).
 */
function collectDirtyTopKeys(doc: Y.Doc, type: any, keys: Set<string | null>): void {
  if (type?._item == null) {
    const root = rootNameOfType(doc, type)
    if (!root) return
    for (const k of keys) if (k != null) localDirtyKeys.add(`${root}${DIRTY_SEP}${k}`)
    return
  }
  let t: any = type
  let topKey: string | null = null
  while (t?._item) { topKey = t._item.parentSub; t = t._item.parent }
  const root = rootNameOfType(doc, t)
  if (root && topKey != null) localDirtyKeys.add(`${root}${DIRTY_SEP}${topKey}`)
}

/** Start recording the user's post-load local edits (origin 'local') on `doc`. */
function startLocalWriteTracking(doc: Y.Doc): void {
  if (localWriteTracking) return
  const handler = (tr: Y.Transaction) => {
    if (tr.origin !== 'local') return
    for (const [type, keys] of tr.changed) collectDirtyTopKeys(doc, type, keys as Set<string | null>)
  }
  doc.on('afterTransaction', handler)
  localWriteTracking = { doc, handler }
}

/** Stop tracking and drop the recorded local-edit set (the window is over). */
function stopLocalWriteTracking(): void {
  if (localWriteTracking) {
    localWriteTracking.doc.off('afterTransaction', localWriteTracking.handler)
    localWriteTracking = null
  }
  localDirtyKeys = new Set()
}

/** Current plain value of a top-level entry (nested Y.Map/Y.Array flattened). */
function getPlainTopValue(doc: Y.Doc, rootName: string, topKey: string): unknown {
  const v = doc.getMap(rootName).get(topKey)
  if (v instanceof Y.Map) return ymapToPlain(v)
  if (v instanceof Y.Array) return v.toArray()
  return v
}

/** Re-set a top-level entry to a captured plain value with a fresh (local) write. */
function reSetTopValue(rootMap: Y.Map<any>, topKey: string, value: unknown): void {
  if (value === undefined) { rootMap.delete(topKey); return }
  if (Array.isArray(value)) {
    const arr = new Y.Array()
    arr.push(value)
    rootMap.set(topKey, arr)
    return
  }
  if (value && typeof value === 'object') {
    let child = rootMap.get(topKey) as Y.Map<any> | undefined
    if (!(child instanceof Y.Map)) { child = new Y.Map(); rootMap.set(topKey, child) }
    applyPlainToYmap(child, value as Record<string, any>)
    return
  }
  rootMap.set(topKey, value)
}

/**
 * Restore the personal doc from the vault, merging into the LIVING ydoc.
 *
 * In-flight-guarded: concurrent callers (background startup pull +
 * refreshYjsPersonalDocFromVault) share the one in-progress promise instead of
 * running the getChanges/applyUpdate path twice.
 */
async function restoreFromVault(): Promise<boolean> {
  if (restoreInFlight) return restoreInFlight
  restoreInFlight = doRestoreFromVault()
  try {
    return await restoreInFlight
  } finally {
    restoreInFlight = null
  }
}

async function doRestoreFromVault(): Promise<boolean> {
  if (!vaultClient || !vaultPersonalKey || !ydoc) return false

  // Capture the doc we started against. The Legacy-migration / remote-rebuild
  // paths (rebuildPersonalDocWithoutLegacyMaps) REPLACE the module `ydoc` with a
  // fresh doc that has the legacy maps stripped. A background restore that awaited
  // across such a rebuild must NOT applyUpdate the OLD-format vault snapshot onto
  // the freshly-rebuilt doc — that would re-introduce the very legacy maps the
  // rebuild removed. If a rebuild happened mid-flight, bail; the rebuild itself
  // re-presents + the log-sync coordinator catches up.
  const targetDoc = ydoc
  const key = vaultPersonalKey

  // Snapshot the local-winning values for entries the user edited AFTER load, BEFORE
  // merging the vault. Re-issued as fresh 'local' writes after the merge so a
  // higher-clientID vault write cannot roll a fresh local edit back (Blocker 2).
  const reassert = new Map<string, unknown>()
  if (localWriteTracking?.doc === targetDoc && localDirtyKeys.size > 0) {
    for (const dirty of localDirtyKeys) {
      const sep = dirty.indexOf(DIRTY_SEP)
      reassert.set(dirty, getPlainTopValue(targetDoc, dirty.slice(0, sep), dirty.slice(sep + 1)))
    }
  }

  try {
    const response = await vaultClient.getChanges(VAULT_PERSONAL_DOC_ID, 0)
    if (!response) return false
    if (ydoc !== targetDoc) return false // a rebuild replaced the doc while we fetched

    // Restore snapshot if available
    if (response.snapshot?.data) {
      // Vault stores packed format: [nonceLen(1 byte)][nonce][ciphertext]
      const packed = base64ToUint8(response.snapshot.data)
      const nonceLen = packed[0]
      const nonce = packed.slice(1, 1 + nonceLen)
      const ciphertext = packed.slice(1 + nonceLen)

      const blob = new Uint8Array(nonce.length + ciphertext.length)
      blob.set(nonce, 0)
      blob.set(ciphertext, nonce.length)
      const decrypted = await decryptOneShot({ crypto: getProtocolCrypto(), spaceContentKey: key, blob })
      if (ydoc !== targetDoc) return false
      Y.applyUpdate(targetDoc, decrypted, 'remote')
      vaultSeq = response.snapshot.upToSeq
      console.debug('[yjs-personal-doc] Restored from vault snapshot')
    }

    // Apply incremental changes (same packed format)
    for (const change of response.changes) {
      const packed = base64ToUint8(change.data)
      const nonceLen = packed[0]
      const nonce = packed.slice(1, 1 + nonceLen)
      const ciphertext = packed.slice(1 + nonceLen)

      const blob = new Uint8Array(nonce.length + ciphertext.length)
      blob.set(nonce, 0)
      blob.set(ciphertext, nonce.length)
      const decrypted = await decryptOneShot({ crypto: getProtocolCrypto(), spaceContentKey: key, blob })
      if (ydoc !== targetDoc) return false
      Y.applyUpdate(targetDoc, decrypted, 'remote')
      vaultSeq = Math.max(vaultSeq, change.seq)
    }

    // Local-wins re-assert: re-issue the captured local edits as fresh 'local' writes
    // ON TOP of the merged vault state (causal successor → deterministically wins).
    // A 'local' transaction does NOT fire the remote-update listener, so notify +
    // schedule persistence explicitly (mirrors changeYjsPersonalDoc's background path).
    if (reassert.size > 0 && ydoc === targetDoc) {
      targetDoc.transact(() => {
        for (const [dirty, value] of reassert) {
          const sep = dirty.indexOf(DIRTY_SEP)
          reSetTopValue(targetDoc.getMap(dirty.slice(0, sep)), dirty.slice(sep + 1), value)
        }
      }, 'local')
      notifyListeners()
      compactScheduler?.pushDebounced()
      vaultScheduler?.pushDebounced()
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
export async function initYjsPersonalDoc(identity: IdentitySession, messaging?: MessagingAdapter, vaultUrl?: string | string[], externalCompactStore?: { open(): Promise<void>; save(id: string, data: Uint8Array): Promise<void>; load(id: string): Promise<Uint8Array | null>; delete(id: string): Promise<void>; list(): Promise<string[]>; close(): void }, logSync?: { docLogStore: DocLogStore; deviceId: string }, options?: { skipVaultRestore?: boolean }): Promise<PersonalDoc> {
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
      const seedsMap = ydoc.getMap('capabilitySigningSeeds')
      const before = spacesMap.size
      ydoc.transact(() => {
        spacesMap.delete(spaceId)
        for (const key of Array.from(groupKeysMap.keys())) {
          if (key.startsWith(spaceId + ':')) {
            groupKeysMap.delete(key)
            console.log(`Deleted group key ${key}`)
          }
        }
        for (const key of Array.from(seedsMap.keys())) {
          if (key.startsWith(spaceId + ':')) seedsMap.delete(key)
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
      const maps = ['profile', 'contacts', 'attestations', 'attestationMetadata', 'spaces', 'groupKeys', 'capabilitySigningSeeds', 'outbox', 'dismissedNotifications']
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
    // Stage A (I-VAULT-SURVIVES): multiple vault URLs → dual-write/merge-read client.
    // An EMPTY array behaves like "no vault" (review: [] is truthy and would
    // otherwise construct VaultClient(undefined, …)).
    const vaultUrls = (Array.isArray(vaultUrl) ? vaultUrl : [vaultUrl]).filter(Boolean)
    vaultClient = vaultUrls.length > 1
      ? new DualVaultClient(vaultUrls.map((u) => new VaultClient(u, identity)))
      : vaultUrls.length === 1
        ? new VaultClient(vaultUrls[0], identity)
        : null

    // If CompactStore was empty, try vault.
    // local-first (Blocker 2): when the caller opts into skipVaultRestore, the
    // vault restore is a NETWORK op and MUST NOT block init/first-render. Defer it
    // to a background pull (pullPersonalDocFromVaultOnceAtStartup) that merges
    // reactively into the living doc. `loadedFrom` stays 'new' so the migration /
    // scheduler logic below behaves exactly as it did before any vault data — the
    // background merge then persists via the update listener.
    if (loadedFrom === 'new') {
      if (options?.skipVaultRestore) {
        deferredVaultRestore = true
      } else {
        const t0v = Date.now()
        const restored = await restoreFromVault()
        if (restored) {
          loadedFrom = 'vault'
          const stateSize = Y.encodeStateAsUpdate(ydoc).length
          metrics.logLoad('vault', Date.now() - t0v, stateSize)
        }
      }
    }
  }

  // Migration: rebuild doc without legacy top-level maps
  // (outbox moved to LocalOutboxStore / IndexedDB; verification records moved
  // to Trust 002 attestation storage)
  // Yjs keeps tombstones for deleted entries, so simply deleting keys
  // doesn't reduce binary size. We must rebuild the doc from scratch.
  const legacyOutbox = ydoc.getMap('outbox')
  const legacyVerifications = getExistingRootMap(ydoc, 'verifications')
  if (legacyOutbox.size > 0 || legacyVerifications !== null) {
    const oldDoc = ydoc
    const oldSize = Y.encodeStateAsUpdate(oldDoc).byteLength
    const freshDoc = rebuildPersonalDocWithoutLegacyMaps(oldDoc)
    oldDoc.destroy()
    ydoc = freshDoc
    const newSize = Y.encodeStateAsUpdate(ydoc).byteLength
    console.debug(`[yjs-personal-doc] Migration: rebuilt doc without legacy maps (${(oldSize/1024).toFixed(0)}KB -> ${(newSize/1024).toFixed(0)}KB)`)
    // Persist immediately so the smaller doc replaces the bloated one
    const migratedUpdate = Y.encodeStateAsUpdate(ydoc)
    await compactStore!.save(PERSONAL_DOC_ID, migratedUpdate)
    // Also push to vault immediately so remote doesn't merge old bloated state back
    if (vaultClient && vaultPersonalKey) {
      try {
        const encrypted = await encryptOneShot({
          crypto: getProtocolCrypto(),
          spaceContentKey: vaultPersonalKey,
          plaintext: migratedUpdate,
        })
        vaultSeq++
        await vaultClient.putSnapshot(VAULT_PERSONAL_DOC_ID, encrypted.ciphertextTag, encrypted.nonce, vaultSeq)
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

  // A2 TC-A1/A3: the durable-log personal-sync adapter (replaces the legacy broadcast). Reuses
  // the SAME LogSyncCoordinator as Spaces over the OutboxMessagingAdapter, keyed by the canonical
  // UUID personalDocIdFromKey(personalKey), with the shared per-DID docLogStore + the
  // composition-root-resolved deviceId (nonce-safe, TC-A2). Started only with the log-sync wiring
  // (multi-device); the single-device path keeps a purely local doc.
  const startPersonalLogSyncAdapter = async () => {
    if (!messaging || !logSync || logSyncAdapter) return
    vaultPersonalKey ??= await identity.deriveFrameworkKey('personal-doc-v1')
    logSyncAdapter = new YjsPersonalLogSyncAdapter({
      doc: ydoc!,
      messaging,
      identity,
      personalKey: vaultPersonalKey,
      docId: personalDocIdFromKey(vaultPersonalKey),
      docLogStore: logSync.docLogStore,
      deviceId: logSync.deviceId,
    })
    logSyncAdapter.start()
  }

  const attachRemoteLegacyCleanupListener = () => {
    ydoc!.on('update', (_update: Uint8Array, origin: any) => {
      if (origin !== 'local') {
        // Prevent legacy top-level maps from being re-synced from remote devices
        const outboxMap = ydoc!.getMap('outbox')
        const verificationsMap = getExistingRootMap(ydoc!, 'verifications')
        if (verificationsMap !== null) {
          const oldDoc = ydoc!
          logSyncAdapter?.destroy()
          logSyncAdapter = null
          ydoc = rebuildPersonalDocWithoutLegacyMaps(oldDoc)
          oldDoc.destroy()
          attachRemoteLegacyCleanupListener()
          // Re-bind the log adapter to the freshly rebuilt doc (fire-and-forget — the rebuild
          // path is a legacy-map migration trigger; the new adapter re-presents + catches up).
          void startPersonalLogSyncAdapter()
        } else if (outboxMap.size > 0) {
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
  }

  // Listen for remote changes (from multi-device sync)
  attachRemoteLegacyCleanupListener()

  // Multi-device sync via relay (A2: durable-log path).
  if (messaging && logSync) {
    await startPersonalLogSyncAdapter()
  }

  if (loadedFrom === 'new') {
    metrics.logLoad('new', 0, 0)
  }

  // local-first (Blocker 2): when the vault restore is deferred to the background,
  // start recording the user's post-render local edits so they can win the merge
  // against a higher-clientID vault write. Only meaningful in the deferred case; the
  // startup pull stops the tracking once it consumes the restore.
  if (deferredVaultRestore && ydoc) {
    startLocalWriteTracking(ydoc)
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
 * local-first startup background job: run the vault restore that init deferred
 * (skipVaultRestore). Runs at most once — and only when the local CompactStore was
 * empty, matching the original init condition (a doc loaded from CompactStore never
 * owed a startup pull). The merge flows reactively into the living doc via the
 * update listener (notifyListeners + CompactStore persist). Safe no-op if nothing
 * was deferred or a refresh already consumed the restore.
 */
export async function pullPersonalDocFromVaultOnceAtStartup(): Promise<boolean> {
  if (!deferredVaultRestore) {
    // Nothing was deferred (already consumed, or non-deferred init) — make sure any
    // dangling local-write tracking is torn down so a later refresh does normal CRDT
    // merge (local-wins is scoped to the startup edit window only).
    stopLocalWriteTracking()
    return false
  }
  deferredVaultRestore = false
  try {
    const restored = await restoreFromVault()
    if (restored) {
      // The vault merge + any local-wins re-assert already notified subscribers and
      // scheduled the CompactStore persist; nothing else to do.
      getMetrics().logLoad('vault', 0, 0)
    }
    return restored
  } finally {
    // The startup edit window is over: stop tracking + drop the recorded edits so
    // subsequent refreshes (missing-key fallback) do ordinary CRDT merge.
    stopLocalWriteTracking()
  }
}

/**
 * Reset — shut down and clear all state.
 */
export async function resetYjsPersonalDoc(): Promise<void> {
  stopLocalWriteTracking()
  if (logSyncAdapter) { logSyncAdapter.destroy(); logSyncAdapter = null }
  ydoc?.destroy()
  ydoc = null
  if (compactScheduler) { compactScheduler.destroy(); compactScheduler = null }
  if (vaultScheduler) { vaultScheduler.destroy(); vaultScheduler = null }
  if (compactStore) { compactStore.close(); compactStore = null }
  vaultClient = null
  vaultPersonalKey = null
  vaultSeq = 0
  deferredVaultRestore = false
  restoreInFlight = null
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
