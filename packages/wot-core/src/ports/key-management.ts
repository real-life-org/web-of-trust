/**
 * KeyManagementPort — storage of symmetric Space Content Keys, versioned by
 * generation (Sync 001 Z.187). One key per (spaceId, generation); each Space
 * Content Key belongs to exactly one docId (Sync 001 Z.96).
 *
 * All methods are async so a follow-up sub-slice can back this with durable,
 * crash-safe storage (Sync 002 Z.171) without an API break. The application-layer
 * group-key workflow orchestrates against this port; the protocol-layer
 * `evaluateKeyRotationDisposition` classifier decides apply/ignore/future.
 */
export interface KeyManagementPort {
  /** Store `key` for (spaceId, generation). */
  saveKey(spaceId: string, generation: number, key: Uint8Array): Promise<void>
  /** Latest key for the space, or null if the space is unknown / has no key. */
  getCurrentKey(spaceId: string): Promise<Uint8Array | null>
  /** Latest generation for the space, or -1 if the space is unknown. */
  getCurrentGeneration(spaceId: string): Promise<number>
  /** Key at a specific generation, or null if unknown / a generation gap. */
  getKeyByGeneration(spaceId: string, generation: number): Promise<Uint8Array | null>
}
