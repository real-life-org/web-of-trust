import { bytesToHex } from '@web_of_trust/core/protocol'
import { crypto, utf8 } from './identity.js'

/**
 * A deterministic, convergent, CRDT-agnostic stub over OPAQUE Uint8Array updates.
 *
 * Model: a last-writer-wins replicated map. Each register is keyed by `key` and
 * carries a Lamport-style timestamp plus the writing deviceId for tie-breaking.
 * Merge is commutative, associative and idempotent => deterministic convergence
 * regardless of apply order. We start with this (NOT Yjs/Automerge) so the spike
 * tests the SYNC design, not a third-party CRDT library.
 *
 * One update = ONE op {key,value,lamport,deviceId} serialized to JSON->UTF-8.
 * The harness treats these bytes as opaque: encrypt/decrypt/transport never look
 * inside; only this stub interprets them.
 */

export interface Register {
  value: string
  lamport: number
  deviceId: string
}

export interface CrdtDoc {
  /** key -> winning register */
  state: Map<string, Register>
  /** local Lamport clock: max(seen)+1 on every local write */
  clock: number
}

interface Op {
  key: string
  value: string
  lamport: number
  deviceId: string
}

export function newDoc(): CrdtDoc {
  return { state: new Map(), clock: 0 }
}

/** Strictly-greater comparison: (lamport, then deviceId) decides the winner. */
function dominates(incoming: Register, existing: Register): boolean {
  if (incoming.lamport !== existing.lamport) return incoming.lamport > existing.lamport
  if (incoming.deviceId !== existing.deviceId) return incoming.deviceId > existing.deviceId
  // Same lamport + same deviceId: identical write, keep existing (idempotent).
  return false
}

/** Produce an opaque update for a local write; bumps the local Lamport clock. */
export function localWrite(
  doc: CrdtDoc,
  key: string,
  value: string,
  deviceId: string,
): { updateBytes: Uint8Array; lamport: number } {
  const lamport = doc.clock + 1
  doc.clock = lamport
  const op: Op = { key, value, lamport, deviceId }
  applyOp(doc, op)
  return { updateBytes: utf8(JSON.stringify(op)), lamport }
}

/** Apply a (possibly remote) opaque update. Idempotent and order-independent. */
export function applyUpdate(doc: CrdtDoc, updateBytes: Uint8Array): void {
  const op = JSON.parse(new TextDecoder().decode(updateBytes)) as Op
  applyOp(doc, op)
}

function applyOp(doc: CrdtDoc, op: Op): void {
  // Advance the local clock past anything we have observed (Lamport rule).
  if (op.lamport > doc.clock) doc.clock = op.lamport
  const incoming: Register = { value: op.value, lamport: op.lamport, deviceId: op.deviceId }
  const existing = doc.state.get(op.key)
  if (existing === undefined || dominates(incoming, existing)) {
    doc.state.set(op.key, incoming)
  }
}

/** One register with its key + full causal metadata (for snapshot compaction). */
export interface RegisterEntry {
  key: string
  value: string
  lamport: number
  deviceId: string
}

/**
 * Export the FULL register set (value + causal metadata), key-sorted. This is what
 * a faithful CRDT snapshot persists (cf. Yjs `encodeStateAsUpdate`): it carries the
 * winning (lamport, deviceId) per key, so replaying it reconstructs byte-identical
 * registers and merges with later log entries under the same LWW rule. Storing only
 * visible values would lose the causal metadata and could never deep-converge across
 * a snapshot boundary.
 */
export function exportRegisters(doc: CrdtDoc): RegisterEntry[] {
  return [...doc.state.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([key, reg]) => ({ key, value: reg.value, lamport: reg.lamport, deviceId: reg.deviceId }))
}

/** Plain, order-stable snapshot of the user-visible key/value map. */
export function stateSnapshot(doc: CrdtDoc): Record<string, string> {
  const out: Record<string, string> = {}
  for (const key of [...doc.state.keys()].sort()) {
    out[key] = doc.state.get(key)!.value
  }
  return out
}

/**
 * Deep convergence hash: includes value + lamport + deviceId per key so that
 * "same visible value via different causal history" still hashes identically
 * only when the registers are truly equal.
 */
export async function stateHash(doc: CrdtDoc): Promise<string> {
  const entries = [...doc.state.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([key, reg]) => [key, reg.value, reg.lamport, reg.deviceId])
  return bytesToHex(await crypto.sha256(utf8(JSON.stringify(entries))))
}
