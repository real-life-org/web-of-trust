import type {
  MessagingAdapter,
  OutboxStore,
  Subscribable,
} from '@web_of_trust/core/ports'
import type {
  Attestation,
  IdentitySession,
} from '@web_of_trust/core/types'
import type { AttestationVcPayload, AttestationReceiptBody } from '@web_of_trust/core/protocol'
import {
  ATTESTATION_RECEIPT_BODY_KIND,
  INBOX_MESSAGE_TYPE,
  isDidcommMessage,
  isVerificationAttestation,
} from '@web_of_trust/core/protocol'
import { deliverInboxMessage } from '@web_of_trust/core/application'
import { createAttestationWorkflow, protocolCrypto } from '../runtime/appRuntime'

/**
 * Zustellstatus einer Attestation (persistent, "Häkchen"-Modell):
 * - `sending`/`queued` → in der Outbox, noch nicht am Server
 * - `delivered` → Häkchen 1: der Server hat sie (Transport-Receipt)
 * - `acknowledged` → Häkchen 2: die Empfänger-App hat verifiziert+gespeichert
 *   und einen App-Level Empfangs-Ack zurückgeschickt (Variante A, E2EE)
 * - `failed` → Transport-Hardfail
 */
export type DeliveryStatus = 'sending' | 'queued' | 'delivered' | 'acknowledged' | 'failed'

/**
 * Persistierbare Status-Strings (Restore-Whitelist). `acknowledged` ist bewusst
 * enthalten — das zweite Häkchen überlebt Reload/Gerätewechsel (CRDT-synced).
 */
const PERSISTABLE_DELIVERY_STATUSES: readonly DeliveryStatus[] = [
  'sending',
  'queued',
  'delivered',
  'acknowledged',
  'failed',
]

/**
 * Monotonie-Rang der positiven Zustell-Stufen. Zentral in `setStatus`
 * ausgewertet, damit ALLE Caller (Receipts, Outbox-Init, Retry, Create, Send,
 * Empfangs-Ack) dieselbe Regel teilen: kein Downgrade, `acknowledged` ist
 * terminal-positiv (ein spätes `delivered` darf es nicht überschreiben),
 * `failed` nur aus einem nicht-acknowledged Zustand.
 */
const DELIVERY_STATUS_RANK: Record<Exclude<DeliveryStatus, 'failed'>, number> = {
  sending: 0,
  queued: 1,
  delivered: 2,
  acknowledged: 3,
}

/**
 * Erlaubte Zustands-Übergänge (Monotonie):
 * - unbekannt → alles (Erstsetzung)
 * - gleicher Status → No-op (spart redundantes persist/notify)
 * - `→ failed`: nur wenn aktuell NICHT `acknowledged` (terminal-positiv)
 * - `failed → *`: erlaubt (Retry re-entert die positive Kette)
 * - `acknowledged → *`: gesperrt (terminal-positiv, kein Downgrade)
 * - sonst (beide positiv): nur vorwärts (höherer Rang)
 */
function isAllowedStatusTransition(
  current: DeliveryStatus | undefined,
  next: DeliveryStatus,
): boolean {
  if (current === undefined) return true
  if (current === next) return false
  if (next === 'failed') return current !== 'acknowledged'
  if (current === 'failed') return true
  if (current === 'acknowledged') return false
  return DELIVERY_STATUS_RANK[next] > DELIVERY_STATUS_RANK[current]
}

/**
 * Deterministische, wire-konforme (UUID v4) Message-ID für den Empfangs-Ack:
 * abgeleitet aus der jti, damit ein erneut gesendeter Ack (Duplikat-Empfang)
 * beim Sender per Message-ID-History dedupliziert (RX-Dedup) — das Spec-Ziel
 * "ID-stabil" innerhalb der Wire-Vorgabe "id MUSS UUID v4 sein"
 * (assertPlaintextMessage). SHA-256 über die jti, erste 16 Bytes als v4.
 */
async function deriveReceiptMessageId(jti: string): Promise<string> {
  const digest = await protocolCrypto.sha256(new TextEncoder().encode(`attestation-receipt:${jti}`))
  return uuidV4FromBytes(digest)
}

function uuidV4FromBytes(bytes: Uint8Array): string {
  const b = bytes.slice(0, 16)
  b[6] = (b[6] & 0x0f) | 0x40 // Version 4
  b[8] = (b[8] & 0x3f) | 0x80 // Variant 10
  const hex = Array.from(b, (byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

/** Löst den X25519-Encryption-Key eines Empfängers auf (Sync 004 keyAgreement im DID-Dokument). */
export type RecipientEncryptionKeyResolver = (did: string) => Promise<Uint8Array | null>

export interface AttestationDeliveryConfig {
  /** Unlocked Identity — signiert den Inner-JWS (Sync 003 Z.446-456). */
  identity: IdentitySession
  resolveRecipientEncryptionKey: RecipientEncryptionKeyResolver
}

const URN_UUID_PREFIX = 'urn:uuid:'
const CANONICAL_UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

/**
 * Deterministisches Duplikat: die Attestation-ID ist bereits gespeichert.
 * Eigener Fehlertyp (M-A), damit der Inbox-Listener Duplikate konklusiv von
 * transienten Persist-Fehlern unterscheiden kann — nur Letztere dürfen als
 * processing-incomplete in die Relay-Redelivery laufen.
 */
export class DuplicateAttestationError extends Error {
  constructor(attestationId: string) {
    super('Diese Attestation existiert bereits.')
    this.name = 'DuplicateAttestationError'
    this.attestationId = attestationId
  }

  readonly attestationId: string
}

/**
 * Demo-local storage port for attestation persistence.
 * Keeps AttestationService independent from the broad core storage surface.
 */
export interface AttestationStoragePort {
  /** Persist or replace an attestation. */
  saveAttestation(attestation: Attestation): Promise<void>

  /** Return attestations received by the current identity. */
  getReceivedAttestations(): Promise<Attestation[]>

  /** Return a stored attestation by id, or null when it is unknown. */
  getAttestation(id: string): Promise<Attestation | null>

  /** Update the accepted flag for a stored attestation. */
  setAttestationAccepted(attestationId: string, accepted: boolean): Promise<void>
}

export class AttestationService {
  private messaging: MessagingAdapter | null = null
  private deliveryStatus = new Map<string, DeliveryStatus>()
  private statusSubscribers = new Set<(map: Map<string, DeliveryStatus>) => void>()
  private receiptUnsubscribe: (() => void) | null = null
  private persistFn: ((attestationId: string, status: string) => Promise<void>) | null = null
  private workflow = createAttestationWorkflow()
  private deliveryConfig: AttestationDeliveryConfig | null = null
  /** Wire-Message-ID → Attestation-ID (Receipt-Zuordnung innerhalb der Session). */
  private deliveryMessageIds = new Map<string, string>()

  constructor(private storage: AttestationStoragePort) {}

  /**
   * K2-Wire-Vertrag (Sync 003): Attestations reisen als inbox/1.0 mit Body
   * {vcJws} — Inner-JWS + ECIES für den Empfänger. Ohne Konfiguration werden
   * Attestations nur lokal gespeichert, nicht zugestellt.
   */
  configureDelivery(config: AttestationDeliveryConfig): void {
    this.deliveryConfig = config
  }

  /** Set a persistence callback for delivery status (called on every status change) */
  setPersistDeliveryStatus(fn: (attestationId: string, status: string) => Promise<void>): void {
    this.persistFn = fn
  }

  /** Restore delivery statuses from persistent storage (call on app startup) */
  restoreDeliveryStatuses(statuses: Map<string, string>): void {
    for (const [id, status] of statuses) {
      if ((PERSISTABLE_DELIVERY_STATUSES as readonly string[]).includes(status)) {
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
    // Zentraler Monotonie-Guard (greift für ALLE Caller): kein Downgrade,
    // `acknowledged` ist terminal-positiv, `failed` nicht aus `acknowledged`.
    const current = this.deliveryStatus.get(attestationId)
    if (!isAllowedStatusTransition(current, status)) return
    this.deliveryStatus = new Map(this.deliveryStatus)
    this.deliveryStatus.set(attestationId, status)
    this.notifySubscribers()
    this.persistFn?.(attestationId, status).catch(() => {})
  }

  /**
   * Häkchen 2: der Aussteller hat einen App-Level Empfangs-Ack (Variante A)
   * erhalten. Setzt `acknowledged` NUR wenn
   * 1. der Sender diese Attestation kennt (`deliveryStatus.has(jti)`), UND
   * 2. der Receipt-Sender (aus dem verifizierten Inner-JWS) der ursprüngliche
   *    Empfänger der Attestation ist (`attestation.to === receiptSenderDid`).
   *
   * (2) ist die AUTHENTIZITÄTS-Prüfung: der Inbox-Empfang authentifiziert nur,
   * DASS ein Absender die ECIES-Nachricht signiert hat — NICHT dass er der
   * legitime Empfänger der Attestation war. Ohne diese Bindung könnte jeder,
   * der dem Aussteller eine Inbox-Nachricht schicken kann und die jti kennt,
   * das zweite Häkchen fälschen. Bei Fehlschlag: No-op + generischer Debug-Log
   * (leakt weder jti noch DID). Der Monotonie-Guard in `setStatus` schützt
   * zusätzlich gegen ein späteres Downgrade.
   */
  async markAcknowledged(jti: string, receiptSenderDid: string): Promise<void> {
    if (!this.deliveryStatus.has(jti)) return
    const attestation = await this.storage.getAttestation(jti)
    if (!attestation || attestation.to !== receiptSenderDid) {
      console.debug('[AttestationService] Receipt from unexpected sender, ignored')
      return
    }
    this.setStatus(jti, 'acknowledged')
  }

  private notifySubscribers(): void {
    for (const cb of this.statusSubscribers) {
      cb(this.deliveryStatus)
    }
  }

  /**
   * Listen for relay delivery receipts.
   * Call once after setMessaging().
   */
  listenForReceipts(messaging: MessagingAdapter): void {
    // Clean up previous listener
    this.receiptUnsubscribe?.()

    // Listen for relay delivery receipts
    this.receiptUnsubscribe = messaging.onReceipt((receipt) => {
      const attestationId = this.attestationIdForMessageId(receipt.messageId)
      if (!attestationId || !this.deliveryStatus.has(attestationId)) return
      if (receipt.status === 'delivered') {
        this.setStatus(attestationId, 'delivered')
      } else if (receipt.status === 'failed') {
        this.setStatus(attestationId, 'failed')
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
    const attestationIds = new Set<string>()
    for (const entry of pending) {
      // In der Demo-Outbox sind inbox/1.0-Envelopes ausschließlich
      // Attestation-Zustellungen (Membership-Typen haben eigene Type-URIs).
      if (!isDidcommMessage(entry.envelope) || entry.envelope.type !== INBOX_MESSAGE_TYPE) continue
      const attestationId = `${URN_UUID_PREFIX}${entry.envelope.id}`
      this.deliveryMessageIds.set(entry.envelope.id, attestationId)
      attestationIds.add(attestationId)
      this.setStatus(attestationId, 'queued')
    }
    // Any 'sending' status not in the outbox means the send was interrupted — mark as failed
    for (const [id, status] of this.deliveryStatus) {
      if (status === 'sending' && !attestationIds.has(id)) {
        this.setStatus(id, 'failed')
      }
    }
  }

  /**
   * Retry sending a failed/queued attestation.
   * Benötigt configureDelivery() — der Inner-JWS wird mit der Identity neu signiert.
   */
  async retryAttestation(attestationId: string): Promise<void> {
    if (!this.messaging || !this.deliveryConfig) return
    const attestation = await this.storage.getAttestation(attestationId)
    if (!attestation) return

    this.setStatus(attestationId, 'sending')
    try {
      const receipt = await this.sendDelivery(this.deliveryConfig.identity, attestation)
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
    issuer: IdentitySession,
    toDid: string,
    claim: string,
    tags?: string[]
  ): Promise<Attestation> {
    const attestation = await this.workflow.createAttestation({
      issuer,
      subjectDid: toDid,
      claim,
      ...(tags ? { tags } : {}),
    })

    // Store locally (sender keeps a copy)
    await this.storage.saveAttestation(attestation)

    // Send to recipient via relay (Empfänger-Prinzip)
    if (this.messaging) {
      this.setStatus(attestation.id, 'sending')
      this.sendDelivery(issuer, attestation).then((receipt) => {
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

  /**
   * K2-Versand (Sync 003 Z.446-456): Klartext-Body {vcJws} → Inner-JWS
   * (Identity-Key) → ECIES für den Empfänger → DIDComm inbox/1.0.
   * Lokale Attestation-Felder reisen NICHT im Wire-Body — der Empfänger
   * leitet sie nach VC-Verifikation aus dem VC-Payload ab.
   *
   * M-B: kein Silent-Drop mehr — der Versand trackt den Delivery-Status
   * (sending/queued/delivered/failed); Fehler markieren die Attestation als
   * 'failed' (Retry über retryAttestation in der UI) und werden geworfen.
   * Optional kann der Empfänger-Key direkt mitgegeben werden (z.B. aus dem
   * QR-Challenge-Payload, Trust 002 `enc`) — dann entfällt der
   * Discovery-Roundtrip und der Versand funktioniert offline (Outbox).
   */
  async sendAttestation(
    issuer: IdentitySession,
    attestation: Attestation,
    options: { recipientEncryptionKey?: Uint8Array } = {},
  ): Promise<void> {
    if (!this.messaging) throw new Error('Messaging not configured')
    this.setStatus(attestation.id, 'sending')
    try {
      const receipt = await this.sendDelivery(issuer, attestation, options.recipientEncryptionKey)
      if (receipt.reason === 'queued-in-outbox') {
        this.setStatus(attestation.id, 'queued')
      } else if (receipt.status === 'delivered' || receipt.status === 'accepted') {
        this.setStatus(attestation.id, 'delivered')
      }
    } catch (error) {
      this.setStatus(attestation.id, 'failed')
      throw error
    }
  }

  private async sendDelivery(
    issuer: IdentitySession,
    attestation: Attestation,
    recipientEncryptionKey?: Uint8Array,
  ) {
    if (!this.messaging) throw new Error('Messaging not configured')

    let recipientKey = recipientEncryptionKey ?? null
    if (!recipientKey) {
      const resolver = this.deliveryConfig?.resolveRecipientEncryptionKey
      if (!resolver) throw new Error('Attestation delivery not configured (configureDelivery)')
      recipientKey = await resolver(attestation.to)
    }
    if (!recipientKey) {
      // Kein Klartext-Fallback: ohne keyAgreement-Key des Empfängers ist keine
      // spec-konforme Zustellung möglich (Sync 003 Z.446-456 / Sync 004).
      throw new Error(`No encryption key published for ${attestation.to}`)
    }

    const messageId = this.messageIdForAttestation(attestation.id)
    const envelope = await deliverInboxMessage({
      type: INBOX_MESSAGE_TYPE,
      body: { vcJws: attestation.vcJws },
      from: issuer.getDid(),
      to: attestation.to,
      recipientEncryptionPublicKey: recipientKey,
      sign: (input) => issuer.signEd25519(input),
      crypto: protocolCrypto,
      randomId: () => messageId,
    })
    this.deliveryMessageIds.set(envelope.id, attestation.id)
    return this.messaging.send(envelope)
  }

  /**
   * Variante A (zweites Häkchen): App-Level Empfangs-Ack. Der Empfänger einer
   * Attestation schickt nach erfolgreichem Verify+Store einen verschlüsselten
   * `inbox/1.0`-Body `{ kind:'attestation-receipt', jti, status:'received' }`
   * (ECIES an die `iss`-DID des Ausstellers) zurück — KEIN neuer äußerer
   * DIDComm-Typ, kein Relay-Change. Body-agnostischer Versand über denselben
   * Inner-JWS+ECIES-Weg wie die Attestation selbst.
   *
   * Best-effort: der Aufrufer (Listener) fängt Fehler ab und rollt die bereits
   * gespeicherte Attestation NICHT zurück (Häkchen 2 bleibt beim Sender aus).
   */
  async sendReceiptAck(issuerDid: string, jti: string): Promise<void> {
    if (!this.messaging) throw new Error('Messaging not configured')
    const identity = this.deliveryConfig?.identity
    const resolver = this.deliveryConfig?.resolveRecipientEncryptionKey
    if (!identity || !resolver) throw new Error('Attestation delivery not configured (configureDelivery)')

    const recipientKey = await resolver(issuerDid)
    if (!recipientKey) {
      // Kein keyAgreement-Key des Ausstellers (Sync 004) → kein spec-konformer
      // Ack möglich. Werfen: der Listener behandelt das best-effort.
      throw new Error(`No encryption key published for ${issuerDid}`)
    }

    const messageId = await deriveReceiptMessageId(jti)
    const body: AttestationReceiptBody = { kind: ATTESTATION_RECEIPT_BODY_KIND, jti, status: 'received' }
    const envelope = await deliverInboxMessage({
      type: INBOX_MESSAGE_TYPE,
      body,
      from: identity.getDid(),
      to: issuerDid,
      recipientEncryptionPublicKey: recipientKey,
      sign: (input) => identity.signEd25519(input),
      crypto: protocolCrypto,
      randomId: () => messageId,
    })
    await this.messaging.send(envelope)
  }

  /**
   * Wire-Message-ID für eine Attestation: die UUID aus `urn:uuid:<uuid>`
   * (deterministisch — Receipt- und Outbox-Zuordnung überleben einen Reload),
   * sonst eine frische UUID v4 (Sync 003: Message-ID MUSS UUID v4 sein).
   */
  private messageIdForAttestation(attestationId: string): string {
    if (attestationId.startsWith(URN_UUID_PREFIX)) {
      const bare = attestationId.slice(URN_UUID_PREFIX.length)
      if (CANONICAL_UUID_V4.test(bare)) return bare
    }
    return crypto.randomUUID()
  }

  private attestationIdForMessageId(messageId: string): string | null {
    const mapped = this.deliveryMessageIds.get(messageId)
    if (mapped) return mapped
    // Deterministische Ableitung (siehe messageIdForAttestation) für Receipts
    // nach einem Reload, wenn die Session-Map leer ist.
    const candidate = `${URN_UUID_PREFIX}${messageId}`
    return this.deliveryStatus.has(candidate) ? candidate : null
  }

  async verifyAttestation(attestation: Attestation): Promise<boolean> {
    return this.workflow.verifyAttestation(attestation)
  }

  async verifyAttestationVcJws(vcJws: string): Promise<AttestationVcPayload> {
    return this.workflow.verifyAttestationVcJws(vcJws)
  }

  /**
   * K2-Empfang: verifiziert den VC-JWS (Trust 002) und leitet die lokale
   * Attestation-View aus dem VC-Payload ab (jti/iss/sub/credentialSubject.claim/
   * validFrom≙nbf) — nie aus Wire-Feldern.
   */
  async decodeIncomingAttestation(vcJws: string): Promise<{
    attestation: Attestation
    payload: AttestationVcPayload
  }> {
    const payload = await this.verifyAttestationVcJws(vcJws)
    return { payload, attestation: attestationFromVcPayload(payload, vcJws) }
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
   * Wirft DuplicateAttestationError bei bekannter ID (deterministisch,
   * konklusiv) — alle anderen Fehler gelten als transient (M-A).
   */
  async saveIncomingAttestation(attestation: Attestation): Promise<Attestation> {
    return this.storeIncomingAttestation(attestation, false)
  }

  async importAttestation(encoded: string): Promise<Attestation> {
    try {
      const attestation = await this.workflow.importAttestation(encoded)
      return this.storeIncomingAttestation(attestation, true)
    } catch (error) {
      if (error instanceof Error && error.message !== 'Invalid attestation format') throw error
      throw new Error('Ungültiges Format. Bitte einen gültigen Attestation-Code einfügen.')
    }
  }

  private async storeIncomingAttestation(attestation: Attestation, preverified: boolean): Promise<Attestation> {
    if (!attestation.id || !attestation.from || !attestation.to ||
        !attestation.claim || !attestation.createdAt || !attestation.vcJws) {
      throw new Error('Unvollständige Attestation. Erforderliche Felder fehlen.')
    }

    const existing = await this.storage.getAttestation(attestation.id)
    if (existing) {
      throw new DuplicateAttestationError(attestation.id)
    }

    if (!preverified) {
      const isValid = await this.verifyAttestation(attestation)
      if (!isValid) {
        throw new Error('Ungültige Signatur. Die Attestation konnte nicht verifiziert werden.')
      }
    }

    await this.storage.saveAttestation(attestation)
    return attestation
  }
}

/**
 * Attestation-View aus einem VERIFIZIERTEN VC-Payload (K2): id ← jti (Fallback
 * payload.id), from ← issuer, to ← credentialSubject.id, claim ←
 * credentialSubject.claim, createdAt ← validFrom (≙ nbf, Konsistenz von
 * assertAttestationVcPayload erzwungen).
 */
function attestationFromVcPayload(payload: AttestationVcPayload, vcJws: string): Attestation {
  const tags = payload.credentialSubject.tags
  const context = payload.credentialSubject.context
  const id = typeof payload.jti === 'string'
    ? payload.jti
    : typeof payload.id === 'string'
      ? payload.id
      : `wot:attestation:${payload.iss}:${payload.sub}:${payload.nbf}`

  return {
    id,
    from: payload.issuer,
    to: payload.credentialSubject.id,
    claim: payload.credentialSubject.claim,
    ...(typeof payload.inResponseTo === 'string' ? { inResponseTo: payload.inResponseTo } : {}),
    ...(Array.isArray(tags) && tags.every(tag => typeof tag === 'string') ? { tags } : {}),
    ...(typeof context === 'string' ? { context } : {}),
    createdAt: payload.validFrom,
    vcJws,
    // Type-borne live-verification marker (review MAJOR 2): derived from the
    // verified VC `type` array, never from the claim label.
    isVerification: isVerificationAttestation(payload),
  }
}
