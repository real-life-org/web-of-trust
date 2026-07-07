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

  async tryConsumeNonce(nonce: string, consumedAt: string): Promise<boolean> {
    const normalizedNonce = nonce.toLowerCase()
    if (this.consumedNonces.has(normalizedNonce)) return false
    this.consumedNonces.set(normalizedNonce, consumedAt)
    return true
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

  async consumePendingCounterVerification(
    originalVerificationId: string,
    counterpartyDid: string,
    now: string,
  ): Promise<'consumed' | 'missing' | 'expired' | 'wrong-counterparty'> {
    const pending = this.pendingCounterVerifications.get(originalVerificationId)
    if (pending === undefined) return 'missing'
    if (Date.parse(pending.expiresAt) <= Date.parse(now)) {
      this.pendingCounterVerifications.delete(originalVerificationId)
      return 'expired'
    }
    if (pending.counterpartyDid !== counterpartyDid) return 'wrong-counterparty'
    this.pendingCounterVerifications.delete(originalVerificationId)
    return 'consumed'
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
