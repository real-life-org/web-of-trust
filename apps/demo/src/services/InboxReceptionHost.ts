import {
  INBOX_MESSAGE_TYPE,
  assertAttestationDeliveryBody,
  createAckMessage,
  createDidKeyResolver,
  decodeBase64Url,
  evaluateInboxAckDisposition,
  isDidcommMessage,
} from '@web_of_trust/core/protocol'
import type {
  DidResolver,
  DidcommPlaintextMessage,
  InboxAckLocalOutcome,
  ProtocolCryptoAdapter,
} from '@web_of_trust/core/protocol'
import { receiveInboxMessage } from '@web_of_trust/core/application'
import { InMemoryMessageIdHistory } from '@web_of_trust/core/adapters'
import type { MessagingAdapter, MessageIdHistoryPort, WireMessage } from '@web_of_trust/core/ports'
import type { IdentitySession } from '@web_of_trust/core/types'

/**
 * Dekodierte inbox/1.0-Attestation-Zustellung (K2-Wire-Vertrag: Body = {vcJws}).
 * Die VC-JWS-Verifikation (Trust 002) macht der Konsument — der Host
 * authentifiziert nur den Inbox-Umschlag (Inner-JWS, Sync 003 Z.460-466).
 */
export interface IncomingAttestationDelivery {
  vcJws: string
  /**
   * Sync 003 Z.460-464: senderDid aus dem verifizierten Inner-JWS, nicht aus
   * Envelope-Routing. Löst #189-SPEC-DEFERRED S1 auf.
   */
  senderDid: string
  /** Message-ID des äußeren Envelopes (= ack/1.0-thid-Referenz). */
  outerId: string
}

export type AttestationDeliveryListener = (
  delivery: IncomingAttestationDelivery,
) => void | Promise<void>

/**
 * Gepufferte Zustellung samt Record-Schritt: recordProcessed gehört zum
 * Workflow-Result und wird erst am konklusiven Dispositions-Punkt aufgerufen
 * (Sync 003 Z.466 + Z.620-622) — der Listener-Payload bleibt davon frei.
 */
interface PendingInboxDelivery {
  delivery: IncomingAttestationDelivery
  recordProcessed: () => Promise<void>
}

export interface InboxReceptionHostOptions {
  messaging: MessagingAdapter
  identity: IdentitySession
  crypto: ProtocolCryptoAdapter
  didResolver?: DidResolver
  messageIdHistory?: MessageIdHistoryPort
  now?: () => Date
  maxAgeMs?: number
}

/**
 * Inbox-Reception-Host an der Composition Root (VE-9).
 *
 * Besitzt ausschließlich den Typ `inbox/1.0`: die Membership-Typen
 * (space-invite/member-update/key-rotation) empfängt und ACKt der
 * Replication-Adapter selbst. K1 (Sync 003 Z.613-622): die ack/1.0-Ownership
 * für inbox/1.0 liegt HIER — nach evaluierter Ack-Disposition, nie im
 * Transport-Adapter. Muster analog `onSpaceInvite` (#189): Demo-Hooks
 * konsumieren ein typed Event statt Wire-Payloads zu parsen.
 */
export class InboxReceptionHost {
  private readonly messaging: MessagingAdapter
  private readonly identity: IdentitySession
  private readonly crypto: ProtocolCryptoAdapter
  private readonly didResolver: DidResolver
  private readonly messageIdHistory: MessageIdHistoryPort
  private readonly now: () => Date
  private readonly maxAgeMs: number | undefined

  private listeners = new Set<AttestationDeliveryListener>()
  /**
   * Accept-Ergebnisse ohne registrierten Listener: in-memory gepuffert = NICHT
   * durabel → KEIN ack, KEIN Record (Sync 003 Z.613-622). Erst der
   * Listener-Flush wendet an, recorded die Message-ID und löst die
   * Ack-Disposition aus — bis dahin bleibt die Relay-Redelivery der
   * Recovery-Pfad.
   */
  private pendingDeliveries: PendingInboxDelivery[] = []
  private unsubscribe: (() => void) | null = null

  constructor(options: InboxReceptionHostOptions) {
    this.messaging = options.messaging
    this.identity = options.identity
    this.crypto = options.crypto
    this.didResolver = options.didResolver ?? createDidKeyResolver()
    this.messageIdHistory = options.messageIdHistory ?? new InMemoryMessageIdHistory()
    this.now = options.now ?? (() => new Date())
    this.maxAgeMs = options.maxAgeMs
  }

  start(): void {
    if (this.unsubscribe) return
    this.unsubscribe = this.messaging.onMessage(async (message: WireMessage) => {
      // VE-9: nur inbox/1.0 — alles andere gehört anderen Konsumenten
      // (Replication-Adapter: Membership-Typen, CRDT-Sync: Old-World-Envelopes).
      if (!isDidcommMessage(message) || message.type !== INBOX_MESSAGE_TYPE) return
      await this.handleInboxMessage(message)
    })
  }

  stop(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
    this.listeners.clear()
    this.pendingDeliveries = []
  }

  /** Typed Attestation-Event (VE-9) — Muster `onSpaceInvite` aus #189. */
  onAttestation(listener: AttestationDeliveryListener): () => void {
    this.listeners.add(listener)
    if (this.pendingDeliveries.length > 0) {
      const pending = this.pendingDeliveries.splice(0)
      void (async () => {
        for (const { delivery, recordProcessed } of pending) {
          const outcome = await this.dispatch(delivery)
          await this.concludeByDisposition(delivery.outerId, outcome, 'unique', recordProcessed)
        }
      })()
    }
    return () => {
      this.listeners.delete(listener)
    }
  }

  private async handleInboxMessage(message: DidcommPlaintextMessage<object>): Promise<void> {
    const result = await receiveInboxMessage({
      message,
      ownDid: this.identity.getDid(),
      decryptEcies: (ecies) => this.identity.decryptForMe({
        ephemeralPublicKey: decodeBase64Url(ecies.epk),
        nonce: decodeBase64Url(ecies.nonce),
        ciphertext: decodeBase64Url(ecies.ciphertext),
      }),
      crypto: this.crypto,
      didResolver: this.didResolver,
      messageIdHistory: this.messageIdHistory,
      now: this.now,
      ...(this.maxAgeMs !== undefined ? { maxAgeMs: this.maxAgeMs } : {}),
    })

    if (result.decision === 'reject') {
      if (result.reason === 'replay') {
        // Sync 003 Z.619: "als Duplikat sicher erkannt" erfüllt die
        // ACK-Vorbedingung — ohne ack staut die Relay-Redelivery die Queue.
        await this.concludeByDisposition(message.id, { kind: 'duplicate', source: 'replay-history' }, 'duplicate-known')
        return
      }
      // K1-Pflicht: fehlgeschlagene Verarbeitung → KEIN ack/1.0 — die Nachricht
      // bleibt in der Relay-Queue (Redelivery-Pfad).
      console.warn('[InboxReception] Rejected inbox/1.0 message:', result.reason)
      return
    }

    let delivery: IncomingAttestationDelivery
    try {
      assertAttestationDeliveryBody(result.body)
      delivery = {
        vcJws: result.body.vcJws,
        senderDid: result.senderDid,
        outerId: result.outerId,
      }
    } catch (err) {
      // Body verletzt den K2-Vertrag ({vcJws}) — deterministisch ungültig und
      // damit konklusiv (Sync 003 Z.466 + Z.620-622): Message-ID recorden, aber
      // kein ack ('may-ack-invalid-and-drop' wird bewusst nicht genutzt) — die
      // Redelivery endet über die Replay-Disposition (duplicate-known-ack).
      console.warn('[InboxReception] Invalid attestation delivery body:', err)
      await this.concludeByDisposition(
        result.outerId,
        { kind: 'invalid-rejected', rejection: 'malformed', authoritativeStateChanged: false },
        'unique',
        result.recordProcessed,
      )
      return
    }

    if (this.listeners.size === 0) {
      // Redelivery eines bereits gepufferten Envelopes nicht doppelt puffern —
      // reine Puffer-Hygiene; der Replay-Schutz lebt in der Message-ID-History.
      if (!this.pendingDeliveries.some((pending) => pending.delivery.outerId === delivery.outerId)) {
        this.pendingDeliveries.push({ delivery, recordProcessed: result.recordProcessed })
      }
      return
    }

    const outcome = await this.dispatch(delivery)
    await this.concludeByDisposition(delivery.outerId, outcome, 'unique', result.recordProcessed)
  }

  private async dispatch(delivery: IncomingAttestationDelivery): Promise<InboxAckLocalOutcome> {
    try {
      for (const listener of [...this.listeners]) {
        await listener(delivery)
      }
      // Listener-Vertrag: resolve = angewendet bzw. deterministisch verworfen
      // (durabel via Storage des Konsumenten); throw = unvollständig.
      return { kind: 'applied', durable: true }
    } catch (err) {
      console.debug('[InboxReception] Attestation listener failed:', err)
      return { kind: 'processing-incomplete', waitingOn: 'durable-apply' }
    }
  }

  /**
   * Konklusiver Dispositions-Punkt (Sync 003 Z.466 + Z.620-622): jeder Ausgang
   * außer do-not-ack gilt als "verarbeitet" → Message-ID recorden; ack/1.0 nur
   * bei send-ack ('may-ack-invalid-and-drop' wird bewusst nicht genutzt).
   * do-not-ack lässt History und Relay-Queue unangetastet — die Redelivery ist
   * der Recovery-Pfad.
   */
  private async concludeByDisposition(
    outerId: string,
    outcome: InboxAckLocalOutcome,
    replayCheck: 'unique' | 'duplicate-known' = 'unique',
    recordProcessed?: () => Promise<void>,
  ): Promise<void> {
    const disposition = evaluateInboxAckDisposition({
      messageKind: 'inbox',
      decryption: 'complete',
      innerVerification: 'complete',
      replayCheck,
      localOutcome: outcome,
    })
    if (disposition.action === 'do-not-ack') return
    await recordProcessed?.()
    if (disposition.action !== 'send-ack') return
    try {
      // Sync 003 Z.594-609: thid = body.messageId = Original-id.
      const ack = createAckMessage({
        id: crypto.randomUUID(),
        from: this.identity.getDid(),
        createdTime: Math.floor(this.now().getTime() / 1000),
        thid: outerId,
        body: { messageId: outerId },
      })
      await this.messaging.send(ack)
    } catch (err) {
      console.warn('[InboxReception] Failed to send ack/1.0 for', outerId, err)
    }
  }
}
