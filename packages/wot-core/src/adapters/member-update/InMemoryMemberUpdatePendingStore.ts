import type { MemberUpdatePendingStore } from '../../ports/MemberUpdatePendingStore'
import type { MemberUpdateSignal, SeenMemberUpdateSignal } from '../../protocol/sync/member-update-disposition'

function sameTuple(a: MemberUpdateSignal, b: MemberUpdateSignal): boolean {
  return a.spaceId === b.spaceId
    && a.action === b.action
    && a.memberDid === b.memberDid
    && a.effectiveKeyGeneration === b.effectiveKeyGeneration
}

/**
 * Reference-implementation default for MemberUpdatePendingStore — in-memory, with
 * defensive copies on save and read (analog to InMemoryKeyManagementAdapter).
 * A production app wires a durable KV-backed store (Adapter concern, 1.D Demo-Hooks).
 */
export class InMemoryMemberUpdatePendingStore implements MemberUpdatePendingStore {
  private readonly seen = new Map<string, SeenMemberUpdateSignal[]>()
  private readonly future = new Map<string, MemberUpdateSignal[]>()

  async savePending(signal: SeenMemberUpdateSignal): Promise<void> {
    const list = this.seen.get(signal.spaceId) ?? []
    // Sync 005 Z.179: exactly one pending record per tuple. A higher-authority signal
    // upgrades the existing record via upgradePending — never a second entry — so the
    // tuple match below stays unambiguous regardless of which signer arrives first.
    if (list.some((s) => sameTuple(s, signal))) return
    list.push({ ...signal })
    this.seen.set(signal.spaceId, list)
  }

  async upgradePending(signal: SeenMemberUpdateSignal): Promise<void> {
    const list = this.seen.get(signal.spaceId)
    const existing = list?.find((s) => sameTuple(s, signal))
    if (!existing) return
    // Upgrade only the authority/disposition; preserve the original signer provenance.
    existing.storedDisposition = signal.storedDisposition
  }

  async bufferFuture(signal: MemberUpdateSignal): Promise<void> {
    const list = this.future.get(signal.spaceId) ?? []
    const duplicate = list.some((s) => sameTuple(s, signal) && s.signerDid === signal.signerDid)
    if (duplicate) return
    list.push({ ...signal })
    this.future.set(signal.spaceId, list)
  }

  async listSeenForSpace(spaceId: string): Promise<readonly SeenMemberUpdateSignal[]> {
    return (this.seen.get(spaceId) ?? []).map((s) => ({ ...s }))
  }

  async listFutureForSpace(spaceId: string): Promise<readonly MemberUpdateSignal[]> {
    return (this.future.get(spaceId) ?? []).map((s) => ({ ...s }))
  }

  async resolvePending(spaceId: string, signal: MemberUpdateSignal): Promise<void> {
    const list = this.seen.get(spaceId)
    if (!list) return
    const next = list.filter((s) => !sameTuple(s, signal))
    if (next.length > 0) this.seen.set(spaceId, next)
    else this.seen.delete(spaceId)
  }

  async resolveFuture(spaceId: string, signal: MemberUpdateSignal): Promise<void> {
    const list = this.future.get(spaceId)
    if (!list) return
    const next = list.filter((s) => !sameTuple(s, signal))
    if (next.length > 0) this.future.set(spaceId, next)
    else this.future.delete(spaceId)
  }
}
