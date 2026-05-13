import type { PendingCounterVerificationRecord, VerificationStateStore } from '../../ports/VerificationStateStore'

/**
 * Volatile Trust 002 verification state store for tests and reference composition.
 */
export class InMemoryVerificationStateStore implements VerificationStateStore {
  private readonly consumedNonces = new Map<string, string>()
  private readonly pendingCounterVerifications = new Map<string, PendingCounterVerificationRecord>()

  async recordConsumedNonce(nonce: string, consumedAt: string): Promise<void> {
    this.consumedNonces.set(nonce.toLowerCase(), consumedAt)
  }

  async hasConsumedNonce(nonce: string): Promise<boolean> {
    return this.consumedNonces.has(nonce.toLowerCase())
  }

  async pruneConsumedNonces(olderThan: string): Promise<void> {
    const cutoff = Date.parse(olderThan)
    for (const [nonce, consumedAt] of this.consumedNonces) {
      if (Date.parse(consumedAt) < cutoff) this.consumedNonces.delete(nonce)
    }
  }

  async recordPendingCounterVerification(pending: PendingCounterVerificationRecord): Promise<void> {
    this.pendingCounterVerifications.set(pending.originalVerificationId, { ...pending })
  }

  async getPendingCounterVerification(originalVerificationId: string): Promise<PendingCounterVerificationRecord | null> {
    const pending = this.pendingCounterVerifications.get(originalVerificationId)
    return pending === undefined ? null : { ...pending }
  }

  async getPendingCounterVerifications(): Promise<PendingCounterVerificationRecord[]> {
    return Array.from(this.pendingCounterVerifications.values(), (pending) => ({ ...pending }))
  }

  async deletePendingCounterVerification(originalVerificationId: string): Promise<void> {
    this.pendingCounterVerifications.delete(originalVerificationId)
  }

  async prunePendingCounterVerifications(now: string): Promise<void> {
    const nowMs = Date.parse(now)
    for (const [originalVerificationId, pending] of this.pendingCounterVerifications) {
      if (Date.parse(pending.expiresAt) <= nowMs) this.pendingCounterVerifications.delete(originalVerificationId)
    }
  }

  async clear(): Promise<void> {
    this.consumedNonces.clear()
    this.pendingCounterVerifications.clear()
  }
}
