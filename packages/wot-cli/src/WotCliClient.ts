/**
 * WotCliClient — Headless WoT client for Node.js.
 *
 * Same adapter stack as the Demo App's AdapterContext,
 * but without React, without IndexedDB, without browser APIs.
 *
 * Uses: SQLite for persistence, WebSocket for relay, HTTP for discovery.
 */

import {
  IdentityWorkflow,
  VerificationWorkflow,
  AttestationWorkflow,
  type PublicIdentitySession,
} from '@web_of_trust/core/application'
import {
  OfflineFirstDiscoveryAdapter,
  OutboxMessagingAdapter,
  PersonalDocSpaceMetadataStorage,
  InMemoryPublishStateStore,
  InMemoryGraphCacheStore,
  InMemoryKeyManagementAdapter,
  InMemoryMessageIdHistory,
} from '@web_of_trust/core/adapters'
import { WebSocketMessagingAdapter } from '@web_of_trust/core/adapters/messaging/websocket'
import { HttpDiscoveryAdapter } from '@web_of_trust/core/adapters/discovery/http'
import { WebCryptoProtocolCryptoAdapter } from '@web_of_trust/core/protocol-adapters'
import { signEnvelope } from '@web_of_trust/core/crypto'
import {
  INBOX_MESSAGE_TYPE,
  assertAttestationDeliveryBody,
  createAckMessage,
  createDidKeyResolver,
  decodeBase64Url,
  encryptionKeyMultibaseFromDidDocument,
  evaluateInboxAckDisposition,
  isDidcommMessage,
  parseQrChallenge,
  x25519MultibaseToPublicKeyBytes,
} from '@web_of_trust/core/protocol'
import type { DidcommPlaintextMessage, InboxAckLocalOutcome } from '@web_of_trust/core/protocol'
import { deliverInboxMessage, receiveInboxMessage } from '@web_of_trust/core/application'
import type { StorageAdapter, ReactiveStorageAdapter } from '@web_of_trust/core/ports'
import type { SpaceInfo, Contact, Attestation, MessageEnvelope, MessageType } from '@web_of_trust/core/types'
import {
  YjsReplicationAdapter,
  initYjsPersonalDoc,
  getYjsPersonalDoc,
  changeYjsPersonalDoc,
  YjsStorageAdapter,
  flushYjsPersonalDoc,
  refreshYjsPersonalDocFromVault,
} from '@web_of_trust/adapter-yjs'
import { FileBasedSeedStorage } from './storage/FileBasedSeedStorage.js'
import { SqliteCompactStore } from './storage/SqliteCompactStore.js'
import { SqliteOutboxStore } from './storage/SqliteOutboxStore.js'

export interface WotCliClientOptions {
  /** Path to encrypted seed file */
  seedPath: string
  /** Path to SQLite database for CRDT snapshots + spaces */
  dbPath?: string
  /** WebSocket relay URL */
  relayUrl?: string
  /** Profile discovery server URL */
  profileServiceUrl?: string
  /** Vault URL for encrypted backups */
  vaultUrl?: string
}

export class WotCliClient {
  private identity: PublicIdentitySession | null = null
  private identityWorkflow: IdentityWorkflow
  private wsAdapter: WebSocketMessagingAdapter | null = null
  private outboxAdapter: OutboxMessagingAdapter | null = null
  private replication: YjsReplicationAdapter | null = null
  private storage: (StorageAdapter & ReactiveStorageAdapter) | null = null
  private discovery: OfflineFirstDiscoveryAdapter | null = null
  private compactStore: SqliteCompactStore | null = null
  private outboxStore: SqliteOutboxStore | null = null
  private protocolCrypto = new WebCryptoProtocolCryptoAdapter()
  private verificationWorkflow = new VerificationWorkflow({ crypto: this.protocolCrypto })
  // Inbox-Empfang (Sync 003 Z.460-466): Inner-JWS-Verify + Message-ID-History.
  private didResolver = createDidKeyResolver()
  private messageIdHistory = new InMemoryMessageIdHistory()
  private options: Required<WotCliClientOptions>

  constructor(options: WotCliClientOptions) {
    this.identityWorkflow = new IdentityWorkflow({ crypto: this.protocolCrypto })
    this.options = {
      seedPath: options.seedPath,
      dbPath: options.dbPath ?? './data/wot-cli.db',
      relayUrl: options.relayUrl ?? 'wss://relay.utopia-lab.org',
      profileServiceUrl: options.profileServiceUrl ?? 'https://profiles.utopia-lab.org',
      vaultUrl: options.vaultUrl ?? 'https://vault.utopia-lab.org',
    }
  }

  /**
   * Initialize: load seed, unlock identity, set up adapters.
   */
  async init(passphrase: string): Promise<void> {
    // 1. Load mnemonic and unlock identity
    const seedStorage = new FileBasedSeedStorage(this.options.seedPath)
    const mnemonic = await seedStorage.loadMnemonic(passphrase)

    const { identity } = await this.identityWorkflow.recoverIdentity({ mnemonic, passphrase, storeSeed: false })
    this.identity = identity

    const did = identity.getDid()
    console.log(`[wot-cli] Identity unlocked: ${did.slice(0, 30)}...`)

    // 2. WebSocket relay
    this.wsAdapter = new WebSocketMessagingAdapter(this.options.relayUrl)

    // 3. SQLite stores
    this.compactStore = new SqliteCompactStore(this.options.dbPath)
    this.outboxStore = new SqliteOutboxStore(this.options.dbPath.replace('.db', '-outbox.db'))

    // 4. Outbox messaging (queues messages when offline)
    this.outboxAdapter = new OutboxMessagingAdapter(this.wsAdapter, this.outboxStore, {
      skipTypes: ['content', 'profile-update', 'personal-sync'] as MessageType[],
      sendTimeoutMs: 15_000,
    })

    // 5. Personal doc (Yjs) — use SQLite CompactStore instead of IndexedDB
    const personalCompactStore = new SqliteCompactStore(this.options.dbPath.replace('.db', '-personal.db'))
    await initYjsPersonalDoc(identity, this.wsAdapter, this.options.vaultUrl, personalCompactStore)
    this.storage = new YjsStorageAdapter(did)

    // 6. Discovery
    const httpDiscovery = new HttpDiscoveryAdapter(this.options.profileServiceUrl)
    const publishStateStore = new InMemoryPublishStateStore()
    const graphCacheStore = new InMemoryGraphCacheStore()
    this.discovery = new OfflineFirstDiscoveryAdapter(httpDiscovery, publishStateStore, graphCacheStore)

    // 7. Replication (Yjs spaces)
    const keyManagement = new InMemoryKeyManagementAdapter()
    const spaceMetadataStorage = new PersonalDocSpaceMetadataStorage({
      getPersonalDoc: getYjsPersonalDoc,
      changePersonalDoc: changeYjsPersonalDoc,
    })

    this.replication = new YjsReplicationAdapter({
      identity,
      messaging: this.outboxAdapter,
      keyManagement,
      metadataStorage: spaceMetadataStorage,
      compactStore: this.compactStore,
      vaultUrl: this.options.vaultUrl,
      brokerUrls: [this.options.relayUrl ?? 'wss://relay.utopia-lab.org'],
      flushPersonalDoc: flushYjsPersonalDoc,
      refreshPersonalDocFromVault: refreshYjsPersonalDocFromVault,
    })

    // 8. Ensure identity in personal doc
    const existing = await this.storage.getIdentity()
    if (!existing) {
      await this.storage.createIdentity(did, { name: 'Eli', bio: 'WoT AI Teammate' })
    }

    console.log('[wot-cli] Adapters initialized')
  }

  /**
   * Connect to relay and start sync.
   */
  async connect(): Promise<void> {
    if (!this.wsAdapter || !this.replication) {
      throw new Error('Call init() first')
    }

    const did = this.requireIdentity().getDid()

    try {
      await Promise.race([
        this.wsAdapter.connect(did),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000)),
      ])
      console.log('[wot-cli] Connected to relay')
    } catch {
      console.warn('[wot-cli] Relay not available, running offline')
    }

    // Register message handlers — der CLI-Client ist der Reception-Host für
    // inbox/1.0 (VE-9 analog Demo); die Membership-Typen empfängt und ACKt
    // der Replication-Adapter selbst.
    this.wsAdapter.onMessage(async (message) => {
      if (!isDidcommMessage(message) || message.type !== INBOX_MESSAGE_TYPE) return
      await this.handleInboxMessage(message)
    })

    // Start replication (restores spaces, listens for messages)
    await this.replication.start()
    console.log('[wot-cli] Replication started')
  }

  /**
   * Disconnect and clean up.
   */
  async disconnect(): Promise<void> {
    if (this.replication) await this.replication.stop()
    if (this.wsAdapter) this.wsAdapter.disconnect()
    if (this.compactStore) this.compactStore.close()
    if (this.outboxStore) this.outboxStore.close()
    console.log('[wot-cli] Disconnected')
  }

  // --- Identity ---

  private requireIdentity(): PublicIdentitySession {
    if (!this.identity) throw new Error('Not initialized; call init() first')
    return this.identity
  }

  getDid(): string {
    return this.requireIdentity().getDid()
  }

  async getProfile() {
    if (!this.storage) throw new Error('Not initialized')
    return this.storage.getIdentity()
  }

  // --- Contacts ---

  async getContacts(): Promise<Contact[]> {
    if (!this.storage) throw new Error('Not initialized')
    return this.storage.getContacts()
  }

  // --- Spaces ---

  getSpaces(): SpaceInfo[] {
    if (!this.replication) throw new Error('Not initialized')
    const sub = this.replication.watchSpaces()
    return sub.getValue() ?? []
  }

  async getSpaceItems(spaceId: string): Promise<Record<string, unknown>> {
    if (!this.replication) throw new Error('Not initialized')
    const space = await this.replication.getSpace(spaceId)
    if (!space) return {}
    // getSpace returns SpaceInfo, we need the SpaceHandle from openSpace
    const handle = await this.replication.openSpace(spaceId)
    if (!handle) return {}
    const doc = handle.getDoc()
    return JSON.parse(JSON.stringify(doc))
  }

  async createSpaceItem(spaceId: string, itemId: string, data: Record<string, unknown>): Promise<void> {
    if (!this.replication) throw new Error('Not initialized')
    const handle = await this.replication.openSpace(spaceId)
    if (!handle) throw new Error(`Space ${spaceId} not found`)
    handle.transact((doc: any) => {
      doc[itemId] = data
    })
  }

  async updateSpaceItem(spaceId: string, itemId: string, updates: Record<string, unknown>): Promise<void> {
    if (!this.replication) throw new Error('Not initialized')
    const handle = await this.replication.openSpace(spaceId)
    if (!handle) throw new Error(`Space ${spaceId} not found`)
    handle.transact((doc: any) => {
      if (!doc[itemId]) doc[itemId] = {}
      Object.assign(doc[itemId] as Record<string, unknown>, updates)
    })
  }

  // --- Messaging ---

  /**
   * Generischer Old-World-Versand (CRDT-Sync-/Demo-Kanal: content,
   * profile-update, personal-sync). Die Inbox-Familie (Sync 003) reist NICHT
   * über diesen Pfad — Attestations gehen via createAttestation/
   * respondToChallenge (inbox/1.0 mit Inner-JWS + ECIES).
   */
  async sendMessage(toDid: string, type: MessageType, payload: unknown): Promise<void> {
    if (!this.outboxAdapter) throw new Error('Not initialized')
    const inboxFamily: MessageType[] = ['attestation', 'space-invite', 'key-rotation', 'member-update']
    if (inboxFamily.includes(type)) {
      throw new Error(`Message type ${type} is an inbox message (Sync 003) — use the dedicated flows instead of sendMessage`)
    }
    const envelope: MessageEnvelope = {
      v: 1,
      id: crypto.randomUUID(),
      type,
      fromDid: this.requireIdentity().getDid(),
      toDid,
      createdAt: new Date().toISOString(),
      encoding: 'json',
      payload: JSON.stringify(payload),
      signature: '',
    }
    // Sign before sending — all messages leaving the device must be signed
    await signEnvelope(envelope, (data) => this.requireIdentity().sign(data))
    await this.outboxAdapter.send(envelope)
  }

  /**
   * K2-Versand (Sync 003 Z.446-456): Klartext-Body {vcJws} → Inner-JWS
   * (Identity-Key) → ECIES für den Empfänger → DIDComm inbox/1.0. Lokale
   * Attestation-Felder reisen nicht im Wire-Body.
   */
  private async deliverAttestation(attestation: Attestation, toDid: string): Promise<void> {
    if (!this.outboxAdapter) throw new Error('Not initialized')
    const recipientKey = await this.resolveRecipientEncryptionKey(toDid)
    if (!recipientKey) {
      // Kein Klartext-Fallback: ohne keyAgreement-Key (Sync 004) keine
      // spec-konforme Zustellung.
      throw new Error(`No encryption key published for ${toDid} — cannot deliver attestation`)
    }
    const envelope = await deliverInboxMessage({
      type: INBOX_MESSAGE_TYPE,
      body: { vcJws: attestation.vcJws },
      from: this.requireIdentity().getDid(),
      to: toDid,
      recipientEncryptionPublicKey: recipientKey,
      sign: (input) => this.requireIdentity().signEd25519(input),
      crypto: this.protocolCrypto,
    })
    await this.outboxAdapter.send(envelope)
  }

  /** X25519-Empfänger-Key aus dem keyAgreement des DID-Dokuments (Sync 004). */
  private async resolveRecipientEncryptionKey(did: string): Promise<Uint8Array | null> {
    if (!this.discovery) return null
    try {
      const result = await this.discovery.resolveProfile(did)
      const enc = encryptionKeyMultibaseFromDidDocument(result.didDocument)
      return enc ? x25519MultibaseToPublicKeyBytes(enc) : null
    } catch {
      return null
    }
  }

  // --- Verification ---

  /**
   * Create a verification challenge code.
   * Share this with the person who should verify you.
   */
  async createChallenge(): Promise<{ code: string; nonce: string }> {
    const ident = await this.storage!.getIdentity()
    const name = ident?.profile.name ?? 'Eli'
    const { rawJson: code, challenge } = await this.verificationWorkflow.createOnlineQrChallenge(this.requireIdentity(), name)
    console.log(`[wot-cli] Challenge created (nonce: ${challenge.nonce.slice(0, 8)}...)`)
    return { code, nonce: challenge.nonce }
  }

  /**
   * Respond to someone else's challenge code.
   * This creates a verification, adds them as contact, and sends via relay.
   */
  async respondToChallenge(challengeCode: string): Promise<{ peerDid: string; peerName: string }> {
    if (!this.storage || !this.outboxAdapter) throw new Error('Not initialized')

    const decoded = parseQrChallenge(challengeCode)
    const peerDid = decoded.did
    const peerName = decoded.name || 'Unknown'
    const peerPublicKey = this.verificationWorkflow.publicKeyFromDid(peerDid)

    // Add as contact
    const now = new Date().toISOString()
    const contact: Contact = {
      did: peerDid,
      publicKey: peerPublicKey,
      name: peerName,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    }
    await this.storage.addContact(contact)
    console.log(`[wot-cli] Added contact: ${peerName} (${peerDid.slice(0, 25)}...)`)

    // Sync profile from discovery
    if (this.discovery) {
      try {
        const result = await this.discovery.resolveProfile(peerDid)
        if (result.profile?.name) {
          await this.storage.updateContact({ ...contact, name: result.profile.name })
        }
      } catch { /* profile not published yet */ }
    }

    const attestation = await this.verificationWorkflow.createVerificationAttestation({
      issuer: this.requireIdentity(),
      subjectDid: peerDid,
      challengeNonce: decoded.nonce,
    })
    await this.storage.saveAttestation(attestation)

    // Send via relay (inbox/1.0, Sync 003)
    await this.deliverAttestation(attestation, peerDid)

    console.log(`[wot-cli] Verification attestation sent to ${peerName}`)
    return { peerDid, peerName }
  }

  /**
   * Empfangspfad inbox/1.0: receiveInboxMessage (ECIES-Decrypt + Inner-JWS-
   * Prüfungen + Message-ID-History) → Anwendung → ack/1.0 nach Ack-Disposition
   * (K1: ACK-Ownership liegt hier, nicht im Transport-Adapter).
   */
  private async handleInboxMessage(message: DidcommPlaintextMessage<object>): Promise<void> {
    const result = await receiveInboxMessage({
      message,
      ownDid: this.requireIdentity().getDid(),
      decryptEcies: (ecies) => this.requireIdentity().decryptForMe({
        ephemeralPublicKey: decodeBase64Url(ecies.epk),
        nonce: decodeBase64Url(ecies.nonce),
        ciphertext: decodeBase64Url(ecies.ciphertext),
      }),
      crypto: this.protocolCrypto,
      didResolver: this.didResolver,
      messageIdHistory: this.messageIdHistory,
      // Sync 003 Z.420-426: die CLI besitzt ausschließlich inbox/1.0 —
      // engere Teilmenge der normativen Inbox-Typen.
      expectedTypes: [INBOX_MESSAGE_TYPE],
    })

    if (result.decision === 'reject') {
      if (result.reason === 'replay') {
        // Sync 003 Z.619: Duplikat sicher erkannt → ack, sonst staut die
        // Relay-Redelivery die Queue.
        await this.concludeByDisposition(message.id, { kind: 'duplicate', source: 'replay-history' }, 'duplicate-known')
        return
      }
      // K1: fehlgeschlagene Verarbeitung → KEIN ack/1.0 (Redelivery-Pfad).
      console.warn('[wot-cli] Rejected inbox/1.0 message:', result.reason)
      return
    }

    let outcome: InboxAckLocalOutcome
    try {
      assertAttestationDeliveryBody(result.body)
      outcome = await this.applyIncomingAttestationDelivery(result.body.vcJws, result.senderDid)
    } catch (err) {
      // Body verletzt den K2-Vertrag — deterministisch ungültig und damit
      // konklusiv (Sync 003 Z.466 + Z.620-622): Message-ID recorden, kein ack
      // ('may-ack-invalid-and-drop' wird bewusst nicht genutzt) — die
      // Redelivery endet über die Replay-Disposition.
      console.warn('[wot-cli] Invalid attestation delivery body:', err)
      outcome = { kind: 'invalid-rejected', rejection: 'malformed', authoritativeStateChanged: false }
    }
    await this.concludeByDisposition(result.outerId, outcome, 'unique', result.recordProcessed)
  }

  /**
   * K2-Empfang: VC-JWS verifizieren und die lokale Attestation-View aus dem
   * VC-Payload ableiten (importAttestation: jti/iss/sub/claim/validFrom) —
   * danach speichern, Kontakt sicherstellen, ggf. counter-verifizieren.
   */
  private async applyIncomingAttestationDelivery(vcJws: string, senderDid: string): Promise<InboxAckLocalOutcome> {
    if (!this.storage || !this.outboxAdapter) {
      return { kind: 'processing-incomplete', waitingOn: 'durable-apply' }
    }

    let attestation: Attestation
    try {
      const workflow = new AttestationWorkflow({ crypto: this.protocolCrypto })
      attestation = await workflow.importAttestation(vcJws)
    } catch (err) {
      console.warn('[wot-cli] Invalid attestation VC-JWS:', err)
      return { kind: 'invalid-rejected', rejection: 'malformed', authoritativeStateChanged: false }
    }

    // M-C (Sync 003 Z.460-464; normative Klärung angefragt in
    // real-life-org/wot-spec#98): der VC-Issuer MUSS der per Inner-JWS
    // authentifizierte Inbox-Sender sein und der VC-Subject die eigene DID —
    // sonst legt die CLI für einen öffentlich abrufbaren Dritt-VC den
    // VC-Issuer als aktiven Kontakt an, obwohl der nie etwas gesendet hat.
    // Verstoß ist deterministisch → konklusiv (record, Redelivery endet über
    // die Replay-Disposition), KEINE Endlos-Redelivery.
    if (attestation.from !== senderDid || attestation.to !== this.requireIdentity().getDid()) {
      console.warn('[wot-cli] Rejected attestation delivery: VC issuer/subject does not match inbox sender/own DID')
      return { kind: 'invalid-rejected', rejection: 'inner-verification-failed', authoritativeStateChanged: false }
    }

    try {
      await this.storage.saveAttestation(attestation)
    } catch (err) {
      console.error('[wot-cli] Failed to persist attestation:', err)
      return { kind: 'processing-incomplete', waitingOn: 'durable-apply' }
    }
    console.log(`[wot-cli] Received attestation from ${attestation.from.slice(0, 25)}...: "${attestation.claim}"`)

    // Folgeaktionen sind best effort — sie ändern die ack-Disposition der
    // bereits durabel angewendeten Inbox-Nachricht nicht mehr.
    try {
      await this.ensureContactForAttestationIssuer(attestation)
      await this.maybeSendCounterVerification(attestation)
    } catch (err) {
      console.error('[wot-cli] Attestation follow-up failed:', err)
    }
    return { kind: 'applied', durable: true }
  }

  /**
   * Konklusiver Dispositions-Punkt (Sync 003 Z.466 + Z.620-622): jeder Ausgang
   * außer do-not-ack gilt als "verarbeitet" → Message-ID recorden; ack/1.0
   * (Sync 003 Z.594-609: thid = body.messageId = Original-id) nur bei send-ack.
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
    if (disposition.action !== 'send-ack' || !this.outboxAdapter) return
    try {
      const ack = createAckMessage({
        id: crypto.randomUUID(),
        from: this.requireIdentity().getDid(),
        createdTime: Math.floor(Date.now() / 1000),
        thid: outerId,
        body: { messageId: outerId },
      })
      await this.outboxAdapter.send(ack)
    } catch (err) {
      console.warn('[wot-cli] Failed to send ack/1.0 for', outerId, err)
    }
  }

  private async ensureContactForAttestationIssuer(attestation: Attestation): Promise<void> {
    if (!this.storage) return

    const contacts = await this.storage.getContacts()
    const exists = contacts.some(c => c.did === attestation.from)
    if (exists) return

    const publicKey = this.verificationWorkflow.publicKeyFromDid(attestation.from)
    const now = new Date().toISOString()
    const newContact: Contact = {
      did: attestation.from,
      publicKey,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    }

    if (this.discovery) {
      try {
        const result = await this.discovery.resolveProfile(attestation.from)
        if (result.profile?.name) {
          newContact.name = result.profile.name
          console.log(`[wot-cli] Contact name resolved: ${result.profile.name}`)
        }
      } catch { /* ok */ }
    }

    await this.storage.addContact(newContact)
  }

  private async maybeSendCounterVerification(attestation: Attestation): Promise<void> {
    if (!this.storage || !this.outboxAdapter) return

    const workflow = new AttestationWorkflow({ crypto: this.protocolCrypto })
    const payload = await workflow.verifyAttestationVcJws(attestation.vcJws)
    const inPersonDecision = await this.verificationWorkflow.acceptVerifiedVerificationAttestation(
      this.requireIdentity(),
      payload,
    )
    if (inPersonDecision.decision !== 'accept-in-person') return

    const counter = await this.verificationWorkflow.createCounterVerificationAttestation({
      issuer: this.requireIdentity(),
      subjectDid: attestation.from,
      inResponseTo: attestation.id,
    })
    await this.storage.saveAttestation(counter)

    await this.deliverAttestation(counter, attestation.from)
    console.log(`[wot-cli] Counter-verification attestation sent to ${attestation.from.slice(0, 25)}...`)
  }

  /**
   * Get all received attestations.
   */
  async getAttestations(): Promise<Attestation[]> {
    if (!this.storage) throw new Error('Not initialized')
    return this.storage.getReceivedAttestations()
  }

  /**
   * Create and send an attestation to someone.
   */
  async createAttestation(toDid: string, claim: string, tags?: string[]): Promise<Attestation> {
    if (!this.storage || !this.outboxAdapter) throw new Error('Not initialized')

    const identity = this.requireIdentity()
    const workflow = new AttestationWorkflow({ crypto: this.protocolCrypto })
    const attestation = await workflow.createAttestation({
      issuer: identity,
      subjectDid: toDid,
      claim,
      ...(tags ? { tags } : {}),
    })

    // Save locally
    await this.storage.saveAttestation(attestation)

    // Send via relay (inbox/1.0, Sync 003)
    await this.deliverAttestation(attestation, toDid)

    console.log(`[wot-cli] Attestation sent to ${toDid.slice(0, 25)}...: "${claim}"`)
    return attestation
  }

  // --- Discovery ---

  async publishProfile(): Promise<void> {
    if (!this.discovery || !this.storage) throw new Error('Not initialized')
    const ident = await this.storage.getIdentity()
    if (!ident) throw new Error('No identity')

    const profile = {
      did: this.requireIdentity().getDid(),
      name: ident.profile.name ?? 'Eli',
      bio: ident.profile.bio,
      updatedAt: new Date().toISOString(),
    }

    await this.discovery.publishProfile(profile, this.requireIdentity())
    console.log('[wot-cli] Profile published')
  }
}
