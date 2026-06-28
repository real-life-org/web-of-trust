/**
 * Slice A Phase 4 — framing for Automerge change arrays carried in ONE log-entry
 * payload (VE-2/VE-3).
 *
 * The LogSyncCoordinator's log payload is a single opaque Uint8Array; a local
 * Automerge edit produces an array of changes (one for a steady-state edit, many
 * for a full-state restore-clone re-write). These helpers frame the array into a
 * single blob and restore it for `Automerge.applyChanges`, so a single log-entry
 * converges the receiver in ONE apply (one change event, LOOP-GUARDed).
 *
 * Layout (big-endian):
 *   [u32 count] ( [u32 len] [len bytes] )*
 *
 * Fixed-width length prefixes — NO raw NUL-byte separators (the composite-key NUL
 * rule applies to STRING keys; this payload is purely binary). {@link unframeChanges}
 * throws on a malformed / engine-foreign blob (e.g. Yjs bytes) so the
 * coordinator's applyRemoteUpdate try/catch treats it as an engine-foreign skip
 * (VE-3) rather than crashing or looping.
 */

export function frameChanges(changes: readonly Uint8Array[]): Uint8Array {
  let total = 4
  for (const change of changes) total += 4 + change.length
  const out = new Uint8Array(total)
  const view = new DataView(out.buffer)
  view.setUint32(0, changes.length, false)
  let offset = 4
  for (const change of changes) {
    view.setUint32(offset, change.length, false)
    offset += 4
    out.set(change, offset)
    offset += change.length
  }
  return out
}

export function unframeChanges(blob: Uint8Array): Uint8Array[] {
  if (blob.length < 4) throw new Error('log payload too short to be framed Automerge changes')
  const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength)
  const count = view.getUint32(0, false)
  // Guard against absurd counts from foreign bytes before allocating.
  if (count > 1_000_000) throw new Error('framed-change count out of range (engine-foreign payload)')
  const changes: Uint8Array[] = []
  let offset = 4
  for (let i = 0; i < count; i++) {
    if (offset + 4 > blob.length) throw new Error('truncated framed Automerge change header')
    const len = view.getUint32(offset, false)
    offset += 4
    if (offset + len > blob.length) throw new Error('truncated framed Automerge change body')
    changes.push(blob.slice(offset, offset + len))
    offset += len
  }
  if (offset !== blob.length) throw new Error('trailing bytes after framed Automerge changes')
  return changes
}
