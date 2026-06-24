/**
 * Composite-key derivation for pending member-removals (Slice SR / VE-S0),
 * shared by the in-memory and IndexedDB {@link DocLogStore} adapters so both
 * derive byte-for-byte identical keys.
 *
 * JSON-array encoding is used because it is unambiguously INJECTIVE: two
 * distinct (spaceId, removedDid) pairs can never map to the same key, even when
 * a component contains delimiter-like characters (a DID-agnostic removedDid may
 * carry arbitrary bytes). A naive "escape + single-separator join" scheme is
 * NOT injective — doubling the separator in both components collides
 * [a + SEP, b] with [a, SEP + b] — so it is deliberately avoided here.
 */

/** Injective composite key for a pending removal keyed by (spaceId, removedDid). */
export function pendingRemovalKey(spaceId: string, removedDid: string): string {
  return JSON.stringify([spaceId, removedDid])
}
