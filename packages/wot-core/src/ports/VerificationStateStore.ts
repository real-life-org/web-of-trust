export interface PendingCounterVerificationRecord {
  counterpartyDid: string
  /** The `jti` of the original in-person Verification-Attestation this counter-verification answers. */
  originalVerificationId: string
  createdAt: string
  expiresAt: string
}

/**
 * Persistent state boundary for Trust 002 verification replay and counter-verification checks.
 *
 * Implementations may be durable. Active QR challenge state is intentionally not part of this port.
 */
export interface VerificationStateStore {
  /** Record a consumed QR challenge nonce. Idempotent by normalized nonce. */
  recordConsumedNonce(nonce: string, consumedAt: string): Promise<void>

  /** Check whether a QR challenge nonce is still retained as consumed. */
  hasConsumedNonce(nonce: string): Promise<boolean>

  /** Remove consumed nonces older than the supplied retention cutoff. */
  pruneConsumedNonces(olderThan: string): Promise<void>

  /** Record or replace pending counter-verification state by originalVerificationId. */
  recordPendingCounterVerification(pending: PendingCounterVerificationRecord): Promise<void>

  /** Load pending counter-verification state by originalVerificationId. */
  getPendingCounterVerification(originalVerificationId: string): Promise<PendingCounterVerificationRecord | null>

  /** Load all pending counter-verification records. */
  getPendingCounterVerifications(): Promise<PendingCounterVerificationRecord[]>

  /** Delete pending counter-verification state by originalVerificationId. */
  deletePendingCounterVerification(originalVerificationId: string): Promise<void>

  /** Remove pending counter-verification records whose expiresAt is not after now. */
  prunePendingCounterVerifications(now: string): Promise<void>
}
