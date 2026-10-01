
/**
 * Old-World space CRDT-sync request (#236). No sender exists any more (#387);
 * the constant stays so the outbox NEVER_QUEUE set can still drain stale
 * entries of this type left over from older app versions.
 */
export const SPACE_SYNC_REQUEST_MESSAGE_TYPE = 'space-sync-request' as const

/**
 * Multi-stage delivery receipts:
 * - accepted: Relay has accepted the message
 * - delivered: Recipient device has received it
 * - failed: Delivery failed (reason in reason field)
 */
export interface DeliveryReceipt {
  messageId: string
  status: 'accepted' | 'delivered' | 'failed'
  timestamp: string
  reason?: string
}

export type MessagingState = 'disconnected' | 'connecting' | 'connected' | 'error'
