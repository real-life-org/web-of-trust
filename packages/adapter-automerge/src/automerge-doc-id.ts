/**
 * VE-9 (Slice A Phase 4) — canonical UUID-docId ⇄ native Automerge base58
 * documentId mapping.
 *
 * Sync 002 (Z.154) binds a Space to exactly ONE CRDT type and uses the Space's
 * canonical lowercase UUID v4 (= `spaceId`, also the Personal-Doc id) as the
 * docId on EVERY wire surface: present-capability, log-entry, sync-request. The
 * Yjs adapter already uses `documentId: spaceId` natively, so it has no base58
 * problem. Automerge is the problem case: automerge-repo's native `DocumentId`
 * is a bs58check string and would otherwise leak onto the wire — a Sync-002
 * violation that also breaks the `spaceId == docId` binding and the
 * capability kid match (`wot:space:<UUID>#cap-<gen>`).
 *
 * The mapping is a PURE, reversible function: a UUID v4 is exactly 16 bytes, and
 * automerge-repo derives its base58 documentId from a 16-byte id. So:
 *   - {@link spaceIdToDocumentId}: UUID → 16 bytes → base58 documentId
 *   - {@link documentIdToSpaceId}: base58 documentId → 16 bytes → UUID
 * This means the native base58 id is NOT a separately-persisted identity: it is
 * always re-derivable from the canonical UUID. Cold-start (no CompactStore) thus
 * re-maps deterministically — the UUID is the single persistent/wire identity,
 * the base58 id is session-/instance-local and re-computed each start.
 *
 * automerge-repo's `repo.import(binary, { docId })` accepts a docId, so a Space
 * doc can be created/imported UNDER the derived base58 documentId. The doc the
 * automerge-repo machinery knows is the base58 id; the wire + capability + seq
 * namespace use ONLY the UUID — satisfying both the engine and Sync 002.
 */
import {
  parseAutomergeUrl,
  stringifyAutomergeUrl,
  type DocumentId,
  type BinaryDocumentId,
} from '@automerge/automerge-repo'

/** A canonical lowercase UUID v4 string (32 hex chars, 4 dashes). */
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

/** True iff `value` is a canonical lowercase UUID v4 (the VE-9 wire docId form). */
export function isCanonicalUuidV4(value: string): boolean {
  return UUID_V4_RE.test(value)
}

/** Decode a UUID v4 string into its 16 raw bytes (no validation beyond hex length). */
function uuidToBytes(spaceId: string): Uint8Array {
  const hex = spaceId.replace(/-/g, '')
  if (hex.length !== 32) {
    throw new Error(`Invalid UUID docId (expected 32 hex chars): ${spaceId}`)
  }
  const bytes = new Uint8Array(16)
  for (let i = 0; i < 16; i++) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return bytes
}

/** Encode 16 raw bytes back into a lowercase UUID v4 string (hyphenated). */
function bytesToUuid(bytes: Uint8Array): string {
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-')
}

/**
 * VE-9: derive the native automerge-repo base58 `documentId` from the canonical
 * UUID spaceId. Deterministic + reversible ({@link documentIdToSpaceId}).
 */
export function spaceIdToDocumentId(spaceId: string): DocumentId {
  const url = stringifyAutomergeUrl(uuidToBytes(spaceId) as unknown as BinaryDocumentId)
  return parseAutomergeUrl(url).documentId
}

/**
 * VE-9 (cold-start re-map): recover the canonical UUID spaceId from a native
 * base58 documentId. Inverse of {@link spaceIdToDocumentId}.
 */
export function documentIdToSpaceId(documentId: DocumentId): string {
  const url = stringifyAutomergeUrl(documentId)
  const { binaryDocumentId } = parseAutomergeUrl(url)
  return bytesToUuid(binaryDocumentId as unknown as Uint8Array)
}
