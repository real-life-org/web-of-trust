import { receiveInboxMessage } from './inbox-reception-workflow'
import { InMemoryMessageIdHistory } from '../../adapters/message-id-history/InMemoryMessageIdHistory'
import type { MessagingAdapter, WireMessage } from '../../ports/MessagingAdapter'
import type { MessageIdHistoryPort } from '../../ports/MessageIdHistory'
import type { IdentitySession } from '../identity'
import {
  INBOX_MESSAGE_TYPE,
  assertAttestationDeliveryBody,
  assertProfileUpdateBody,
  isAttestationReceiptBody,
  isDidcommMessage,
  isProfileUpdateBody,
  type ProfileUpdateProfile,
} from '../../protocol/messaging/inbox-message'
import { createAckMessage } from '../../protocol/sync/ack-message'
import { createDidKeyResolver } from '../../protocol/identity/did-key'
import type { DidResolver } from '../../protocol/identity/did-document'
import { decodeBase64Url } from '../../protocol/crypto/encoding'
import { evaluateInboxAckDisposition, type InboxAckLocalOutcome } from '../../protocol/sync/inbox-ack-disposition'
import type { DidcommPlaintextMessage } from '../../protocol/sync/membership-messages'
import type { ProtocolCryptoAdapter } from '../../protocol/crypto/ports'

/**
 * Dekodierte Attestation-Zustellung (Body `{ vcJws }`). Die VC-JWS-Verifikation
 * (Trust 002) macht der Konsument — der Host authentifiziert nur den Umschlag.
 */
export interface IncomingAttestationDelivery {
  vcJws: string
  /** Signer des inneren JWS (Sync 003 Z.460-464), nie das Envelope-`from`. */
  senderDid: string
  /** Message-ID des äußeren Envelopes (= ack/1.0-thid). */
  outerId: string
}

/** Empfangs-Quittung einer Attestation (`{ kind:'attestation-receipt', jti, status }`). */
export interface IncomingAttestationReceipt {
  /** Attestation-ID (= VC-jti), die der Empfänger bestätigt. */
  jti: string
  /** Signer des inneren JWS (der Attestation-Empfänger). */
  senderDid: string
  outerId: string
}

/** Profiländerung eines Kontakts (`{ kind:'profile-update', profile }`, wot#386), Form geprüft. */
export interface IncomingProfileUpdate {
  profile: ProfileUpdateProfile
  /** Signer des inneren JWS — wessen Profil das ist. */
  senderDid: string
  outerId: string
}

export type AttestationDeliveryListener = (delivery: IncomingAttestationDelivery) => void | Promise<void>
export type AttestationReceiptListener = (receipt: IncomingAttestationReceipt) => void | Promise<void>
export type ProfileUpdateListener = (update: IncomingProfileUpdate) => void | Promise<void>

export type InboxReceptionChannel = 'attestation' | 'attestation-receipt' | 'profile-update'

/** Beobachtbare Ausgänge, die nicht zur Anwendung führen (für Trace/Logs der App). */
export type InboxReceptionDiagnostic =
  | { kind: 'rejected'; reason: string; detail?: string; messageId: string }
  | { kind: 'invalid-body'; channel: 'attestation' | 'profile-update'; error: string; outerId: string; senderDid: string }
  | { kind: 'apply-deferred'; channel: InboxReceptionChannel; error: string; outerId: string; senderDid: string }
  | { kind: 'ack-failed'; error: string; outerId: string }

export interface InboxReceptionHostOptions {
  messaging: MessagingAdapter
  identity: IdentitySession
  crypto: ProtocolCryptoAdapter
  didResolver?: DidResolver
  messageIdHistory?: MessageIdHistoryPort
  now?: () => Date
  maxAgeMs?: number
  /** Ohne Callback: Konsole (warn für Ablehnung/ungültig, debug für den Rest). */
  onDiagnostic?: (event: InboxReceptionDiagnostic) => void
}

type Concluder = (outerId: string, outcome: InboxAckLocalOutcome, recordProcessed: () => Promise<void>) => Promise<void>

/**
 * Ein Empfangskanal: Listener, Puffer und die eine Regel, die für jeden Kanal
 * gilt — zustellen oder puffern, nie ohne Anwendung quittieren. Ohne Listener
 * (auch wenn er sich mitten im Flush abmeldet) bleibt die Nachricht gepuffert:
 * kein record, kein ack; die Relay-Redelivery und der nächste Abonnent heilen.
 */
class ReceptionChannel<T extends { outerId: string; senderDid: string }> {
  private listeners = new Set<(value: T) => void | Promise<void>>()
  private pending: Array<{ value: T; recordProcessed: () => Promise<void> }> = []

  constructor(
    private readonly name: InboxReceptionChannel,
    private readonly conclude: Concluder,
    private readonly diagnose: (event: InboxReceptionDiagnostic) => void,
  ) {}

  subscribe(listener: (value: T) => void | Promise<void>): () => void {
    this.listeners.add(listener)
    if (this.pending.length > 0) {
      const pending = this.pending.splice(0)
      void (async () => {
        for (const { value, recordProcessed } of pending) await this.deliver(value, recordProcessed)
      })()
    }
    return () => { this.listeners.delete(listener) }
  }

  async deliver(value: T, recordProcessed: () => Promise<void>): Promise<void> {
    if (this.listeners.size === 0) {
      // Puffer-Hygiene: eine Redelivery desselben Envelopes nicht doppelt halten.
      if (!this.pending.some((pending) => pending.value.outerId === value.outerId)) {
        this.pending.push({ value, recordProcessed })
      }
      return
    }
    let outcome: InboxAckLocalOutcome
    try {
      // Listener-Vertrag: resolve = angewendet bzw. deterministisch verworfen
      // (durabel beim Konsumenten); throw = unvollständig.
      for (const listener of [...this.listeners]) await listener(value)
      outcome = { kind: 'applied', durable: true }
    } catch (error) {
      this.diagnose({
        kind: 'apply-deferred', channel: this.name,
        error: error instanceof Error ? error.message : String(error),
        outerId: value.outerId, senderDid: value.senderDid,
      })
      outcome = { kind: 'processing-incomplete', waitingOn: 'durable-apply' }
    }
    await this.conclude(value.outerId, outcome, recordProcessed)
  }

  clear(): void {
    this.listeners.clear()
    this.pending = []
  }
}

/**
 * Inbox-Reception-Host an der Composition Root (VE-9), gemeinsam für alle Apps.
 *
 * Besitzt ausschließlich `inbox/1.0`: die Membership-Typen empfängt und ACKt der
 * Replication-Adapter selbst. K1 (Sync 003 Z.613-622): die ack/1.0-Ownership
 * liegt HIER — nach evaluierter Ack-Disposition, nie im Transport-Adapter.
 * Die Body-Formen unterscheiden sich am Feld `kind`: Quittung, Profiländerung,
 * sonst Attestation-Zustellung `{ vcJws }`. Ein Body, der keiner Form genügt,
 * ist deterministisch ungültig (record, kein ack) und wird nie als
 * Attestation gedeutet.
 */
export class InboxReceptionHost {
  private readonly messaging: MessagingAdapter
  private readonly identity: IdentitySession
  private readonly crypto: ProtocolCryptoAdapter
  private readonly didResolver: DidResolver
  private readonly messageIdHistory: MessageIdHistoryPort
  private readonly now: () => Date
  private readonly maxAgeMs: number | undefined
  private readonly diagnose: (event: InboxReceptionDiagnostic) => void
  private readonly attestations: ReceptionChannel<IncomingAttestationDelivery>
  private readonly receipts: ReceptionChannel<IncomingAttestationReceipt>
  private readonly profileUpdates: ReceptionChannel<IncomingProfileUpdate>
  private unsubscribe: (() => void) | null = null

  constructor(options: InboxReceptionHostOptions) {
    this.messaging = options.messaging
    this.identity = options.identity
    this.crypto = options.crypto
    this.didResolver = options.didResolver ?? createDidKeyResolver()
    this.messageIdHistory = options.messageIdHistory ?? new InMemoryMessageIdHistory()
    this.now = options.now ?? (() => new Date())
    this.maxAgeMs = options.maxAgeMs
    this.diagnose = options.onDiagnostic ?? defaultDiagnostic
    const conclude: Concluder = (outerId, outcome, recordProcessed) =>
      this.conclude(outerId, outcome, 'unique', recordProcessed)
    this.attestations = new ReceptionChannel('attestation', conclude, this.diagnose)
    this.receipts = new ReceptionChannel('attestation-receipt', conclude, this.diagnose)
    this.profileUpdates = new ReceptionChannel('profile-update', conclude, this.diagnose)
  }

  start(): void {
    if (this.unsubscribe) return
    this.unsubscribe = this.messaging.onMessage(async (message: WireMessage) => {
      if (!isDidcommMessage(message) || message.type !== INBOX_MESSAGE_TYPE) return
      await this.handle(message)
    })
  }

  stop(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
    this.attestations.clear()
    this.receipts.clear()
    this.profileUpdates.clear()
  }

  onAttestation(listener: AttestationDeliveryListener): () => void {
    return this.attestations.subscribe(listener)
  }

  /** Empfangs-Quittungen; ein Quittungs-Listener löst nie selbst eine Quittung aus. */
  onAttestationReceipt(listener: AttestationReceiptListener): () => void {
    return this.receipts.subscribe(listener)
  }

  /** Profiländerungen der Kontakte (wot#386). */
  onProfileUpdate(listener: ProfileUpdateListener): () => void {
    return this.profileUpdates.subscribe(listener)
  }

  private async handle(message: DidcommPlaintextMessage<object>): Promise<void> {
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
      // Sync 003 Z.420-426: der Host besitzt ausschließlich inbox/1.0.
      expectedTypes: [INBOX_MESSAGE_TYPE],
      ...(this.maxAgeMs !== undefined ? { maxAgeMs: this.maxAgeMs } : {}),
    })

    if (result.decision === 'reject') {
      if (result.reason === 'replay') {
        // Sync 003 Z.619: als Duplikat sicher erkannt → ack, sonst staut die Redelivery.
        await this.conclude(message.id, { kind: 'duplicate', source: 'replay-history' }, 'duplicate-known')
        return
      }
      // K1: fehlgeschlagene Verarbeitung → KEIN ack; die Redelivery bleibt.
      this.diagnose({ kind: 'rejected', reason: result.reason, detail: result.detail, messageId: message.id })
      return
    }

    const invalid = async (channel: 'attestation' | 'profile-update', error: unknown): Promise<void> => {
      this.diagnose({
        kind: 'invalid-body', channel,
        error: error instanceof Error ? error.message : String(error),
        outerId: result.outerId, senderDid: result.senderDid,
      })
      // Deterministisch ungültig = konklusiv (Sync 003 Z.466 + Z.620-622): record, kein ack.
      await this.conclude(
        result.outerId,
        { kind: 'invalid-rejected', rejection: 'malformed', authoritativeStateChanged: false },
        'unique',
        result.recordProcessed,
      )
    }

    if (isAttestationReceiptBody(result.body)) {
      await this.receipts.deliver(
        { jti: result.body.jti, senderDid: result.senderDid, outerId: result.outerId },
        result.recordProcessed,
      )
      return
    }

    if (isProfileUpdateBody(result.body)) {
      try {
        assertProfileUpdateBody(result.body)
      } catch (error) {
        await invalid('profile-update', error)
        return
      }
      await this.profileUpdates.deliver(
        { profile: result.body.profile, senderDid: result.senderDid, outerId: result.outerId },
        result.recordProcessed,
      )
      return
    }

    try {
      assertAttestationDeliveryBody(result.body)
    } catch (error) {
      await invalid('attestation', error)
      return
    }
    await this.attestations.deliver(
      { vcJws: result.body.vcJws, senderDid: result.senderDid, outerId: result.outerId },
      result.recordProcessed,
    )
  }

  /**
   * Konklusiver Dispositions-Punkt (Sync 003 Z.466 + Z.620-622): jeder Ausgang
   * außer do-not-ack gilt als verarbeitet → Message-ID recorden; ack/1.0 nur bei
   * send-ack. do-not-ack lässt History und Relay-Queue unangetastet.
   */
  private async conclude(
    outerId: string,
    outcome: InboxAckLocalOutcome,
    replayCheck: 'unique' | 'duplicate-known',
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
    const ack = createAckMessage({
      id: crypto.randomUUID(),
      from: this.identity.getDid(),
      createdTime: Math.floor(this.now().getTime() / 1000),
      thid: outerId,
      body: { messageId: outerId },
    })
    try {
      await this.messaging.send(ack)
    } catch (error) {
      this.diagnose({ kind: 'ack-failed', error: error instanceof Error ? error.message : String(error), outerId })
    }
  }
}

function defaultDiagnostic(event: InboxReceptionDiagnostic): void {
  if (event.kind === 'rejected' || event.kind === 'invalid-body') {
    console.warn('[InboxReception]', event)
  } else {
    console.debug('[InboxReception]', event)
  }
}
