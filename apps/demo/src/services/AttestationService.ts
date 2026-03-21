import type {
  StorageAdapter,
  CryptoAdapter,
  MessagingAdapter,
  Attestation,
  Proof,
  MessageEnvelope,
  OutboxStore,
  Subscribable,
} from '@real-life/wot-core'
import { createResourceRef } from '@real-life/wot-core'

export type DeliveryStatus = 'sending' | 'queued' | 'delivered' | 'acknowledged' | 'failed'

export class AttestationService {
  private messaging: MessagingAdapter | null = null
  private deliveryStatus = new Map<string, DeliveryStatus>()
  private statusSubscribers = new Set<(map: Map<string, DeliveryStatus>) => void>()
  private receiptUnsubscribe: (() => void) | null = null
  private messageUnsubscribe: (() => void) | null = null
  private persistFn: ((attestationId: string, status: string) => Promise<void>) | null = null

  constructor(
    private storage: StorageAdapter,
    private crypto: CryptoAdapter
  ) {}

  /** Set a persistence callback for delivery status (called on every status change) */
  setPersistDeliveryStatus(fn: (attestationId: string, status: string) => Promise<void>): void {
    this.persistFn = fn
  }

  /** Restore delivery statuses from persistent storage (call on app startup) */
  restoreDeliveryStatuses(statuses: Map<string, string>): void {
    for (const [id, status] of statuses) {
      if (['sending', 'queued', 'delivered', 'acknowledged', 'failed'].includes(status)) {
        this.deliveryStatus.set(id, status as DeliveryStatus)
      }
    }
    this.notifySubscribers()
  }

  setMessaging(messaging: MessagingAdapter): void {
    this.messaging = messaging
  }

  // --- Delivery Status Tracking ---

  getDeliveryStatus(attestationId: string): DeliveryStatus | undefined {
    return this.deliveryStatus.get(attestationId)
  }

  watchDeliveryStatus(): Subscribable<Map<string, DeliveryStatus>> {
    const self = this
    return {
      getValue: () => self.deliveryStatus,
      subscribe: (callback: (map: Map<string, DeliveryStatus>) => void) => {
        self.statusSubscribers.add(callback)
        return () => { self.statusSubscribers.delete(callback) }
      },
    }
  }

  private setStatus(attestationId: string, status: DeliveryStatus): void {
    this.deliveryStatus = new Map(this.deliveryStatus)
    this.deliveryStatus.set(attestationId, status)
    this.notifySubscribers()
    this.persistFn?.(attestationId, status).catch(() => {})
  }

  private notifySubscribers(): void {
    for (const cb of this.statusSubscribers) {
      cb(this.deliveryStatus)
    }
  }

  /**
   * Listen for delivery receipts and attestation-ack messages.
   * Call once after setMessaging().
   */
  listenForReceipts(messaging: MessagingAdapter): void {
    // Clean up previous listeners
    this.receiptUnsubscribe?.()
    this.messageUnsubscribe?.()

    // Listen for relay delivery receipts
    this.receiptUnsubscribe = messaging.onReceipt((receipt) => {
      if (!this.deliveryStatus.has(receipt.messageId)) return
      if (receipt.status === 'delivered') {
        this.setStatus(receipt.messageId, 'delivered')
      } else if (receipt.status === 'failed') {
        this.setStatus(receipt.messageId, 'failed')
      }
    })

    // Listen for attestation-ack messages from recipients
    this.messageUnsubscribe = messaging.onMessage((envelope) => {
      if (envelope.type !== 'attestation-ack') return
      try {
        const { attestationId } = JSON.parse(envelope.payload)
        if (attestationId && this.deliveryStatus.has(attestationId)) {
          this.setStatus(attestationId, 'acknowledged')
        }
      } catch {
        // Invalid payload — ignore
      }
    })
  }

  /**
   * Bootstrap delivery status from outbox (on app startup).
   * Marks pending attestation envelopes as 'queued'.
   * Marks stale 'sending' statuses (not in outbox) as 'failed'.
   */
  async initFromOutbox(outboxStore: OutboxStore): Promise<void> {
    const pending = await outboxStore.getPending()
    const outboxIds = new Set<string>()
    for (const entry of pending) {
      if (entry.envelope.type === 'attestation') {
        outboxIds.add(entry.envelope.id)
        this.setStatus(entry.envelope.id, 'queued')
      }
    }
    // Any 'sending' status not in the outbox means the send was interrupted — mark as failed
    for (const [id, status] of this.deliveryStatus) {
      if (status === 'sending' && !outboxIds.has(id)) {
        this.setStatus(id, 'failed')
      }
    }
  }

  /**
   * Retry sending a failed/queued attestation.
   */
  async retryAttestation(attestationId: string): Promise<void> {
    if (!this.messaging) return
    const attestation = await this.storage.getAttestation(attestationId)
    if (!attestation) return

    const envelope: MessageEnvelope = {
      v: 1,
      id: attestation.id,
      type: 'attestation',
      fromDid: attestation.from,
      toDid: attestation.to,
      createdAt: attestation.createdAt,
      encoding: 'json',
      payload: JSON.stringify(attestation),
      signature: attestation.proof.proofValue,
      ref: createResourceRef('attestation', attestation.id),
    }

    this.setStatus(attestationId, 'sending')
    try {
      const receipt = await this.messaging.send(envelope)
      if (receipt.reason === 'queued-in-outbox') {
        this.setStatus(attestationId, 'queued')
      } else if (receipt.status === 'delivered' || receipt.status === 'accepted') {
        this.setStatus(attestationId, 'delivered')
      }
    } catch {
      this.setStatus(attestationId, 'failed')
    }
  }

  // --- Attestation CRUD ---

  /**
   * Create an attestation (as the sender/from)
   */
  async createAttestation(
    fromDid: string,
    toDid: string,
    claim: string,
    signFn: (data: string) => Promise<string>,
    tags?: string[]
  ): Promise<Attestation> {
    const id = `urn:uuid:${this.crypto.generateNonce().slice(0, 8)}-${Date.now()}`
    const createdAt = new Date().toISOString()

    // Create data to sign (without proof)
    const dataToSign = JSON.stringify({
      id,
      from: fromDid,
      to: toDid,
      claim,
      tags,
      createdAt,
    })

    const signature = await signFn(dataToSign)

    const proof: Proof = {
      type: 'Ed25519Signature2020',
      verificationMethod: `${fromDid}#key-1`,
      created: createdAt,
      proofPurpose: 'assertionMethod',
      proofValue: signature,
    }

    const attestation: Attestation = {
      id,
      from: fromDid,
      to: toDid,
      claim,
      ...(tags != null ? { tags } : {}),
      createdAt,
      proof,
    }

    // Store locally (sender keeps a copy)
    await this.storage.saveAttestation(attestation)

    // Send to recipient via relay (Empfänger-Prinzip)
    if (this.messaging) {
      const envelope: MessageEnvelope = {
        v: 1,
        id: attestation.id,
        type: 'attestation',
        fromDid: fromDid,
        toDid: toDid,
        createdAt: attestation.createdAt,
        encoding: 'json',
        payload: JSON.stringify(attestation),
        signature: attestation.proof.proofValue,
        ref: createResourceRef('attestation', attestation.id),
      }
      this.setStatus(attestation.id, 'sending')
      this.messaging.send(envelope).then((receipt) => {
        if (receipt.reason === 'queued-in-outbox') {
          this.setStatus(attestation.id, 'queued')
        } else if (receipt.status === 'delivered' || receipt.status === 'accepted') {
          this.setStatus(attestation.id, 'delivered')
        }
      }).catch(() => {
        this.setStatus(attestation.id, 'failed')
      })
    }

    return attestation
  }

  async verifyAttestation(attestation: Attestation): Promise<boolean> {
    const dataToVerify = JSON.stringify({
      id: attestation.id,
      from: attestation.from,
      to: attestation.to,
      claim: attestation.claim,
      tags: attestation.tags,
      createdAt: attestation.createdAt,
    })

    const fromPublicKey = await this.crypto.didToPublicKey(attestation.from)

    return this.crypto.verifyString(dataToVerify, attestation.proof.proofValue, fromPublicKey)
  }

  /**
   * Get all attestations I've received (stored locally)
   */
  async getReceivedAttestations(): Promise<Attestation[]> {
    return this.storage.getReceivedAttestations()
  }

  async getAttestation(id: string): Promise<Attestation | null> {
    return this.storage.getAttestation(id)
  }

  /**
   * Accept or reject an attestation
   */
  async setAttestationAccepted(attestationId: string, accepted: boolean): Promise<void> {
    await this.storage.setAttestationAccepted(attestationId, accepted)
  }

  /**
   * Validate, verify, and save an incoming attestation (e.g. from relay).
   * Throws on invalid/duplicate attestations.
   */
  async saveIncomingAttestation(attestation: Attestation): Promise<Attestation> {
    if (!attestation.id || !attestation.from || !attestation.to ||
        !attestation.claim || !attestation.proof || !attestation.createdAt) {
      throw new Error('Unvollständige Attestation. Erforderliche Felder fehlen.')
    }

    const existing = await this.storage.getAttestation(attestation.id)
    if (existing) {
      throw new Error('Diese Attestation existiert bereits.')
    }

    const isValid = await this.verifyAttestation(attestation)
    if (!isValid) {
      throw new Error('Ungültige Signatur. Die Attestation konnte nicht verifiziert werden.')
    }

    await this.storage.saveAttestation(attestation)
    return attestation
  }

  async importAttestation(encoded: string): Promise<Attestation> {
    let attestation: Attestation
    try {
      const decoded = atob(encoded.trim())
      attestation = JSON.parse(decoded)
    } catch {
      throw new Error('Ungültiges Format. Bitte einen gültigen Attestation-Code einfügen.')
    }

    return this.saveIncomingAttestation(attestation)
  }
}
