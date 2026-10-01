import type { IdentitySession } from '../identity'
import type { Attestation } from '../../types/attestation'
import type { VerificationStateStore } from '../../ports/VerificationStateStore'
import type {
  AttestationVcPayload,
  QrChallenge,
  VerificationAttestationAcceptanceDecision,
} from '../../protocol'
import {
  createAttestationVcJwsWithSigner,
  decodeBase64Url,
  decideVerificationAttestationAcceptance,
  ed25519MultibaseToPublicKeyBytes,
  encodeBase64Url,
  isVerificationAttestation,
  parseVerificationJtiNonce,
  parseQrChallenge,
  wholeSecondRfc3339,
} from '../../protocol'

const CONSUMED_NONCE_RETENTION_MS = 24 * 60 * 60 * 1000
const PENDING_COUNTER_VERIFICATION_MAX_AGE_MS = 24 * 60 * 60 * 1000
const VERIFICATION_ATTESTATION_CLAIM = 'in-person verifiziert'

export interface VerificationWorkflowOptions {
  randomId?: () => string
  now?: () => Date
  stateStore?: VerificationStateStore
}

export interface CreateOnlineQrChallengeOptions {
  broker?: string
}

export interface CreateOnlineQrChallengeResult {
  challenge: QrChallenge
  rawJson: string
}

export interface CreateVerificationAttestationInput {
  issuer: IdentitySession
  subjectDid: string
  challengeNonce: string
}

export interface CreateCounterVerificationAttestationInput {
  issuer: IdentitySession
  subjectDid: string
  /** The `jti` of the original nonce-bound Verification-Attestation this response answers. */
  inResponseTo: string
}

export interface PendingCounterVerification {
  counterpartyDid: string
  /** The `jti` of the original in-person Verification-Attestation this counter-verification answers. */
  originalVerificationId: string
  createdAt: string
  expiresAt: string
}

export interface RecordPendingCounterVerificationOptions {
  counterpartyDid: string
  /** The `jti` of the original in-person Verification-Attestation this counter-verification answers. */
  originalVerificationId: string
}

export type CounterVerificationAcceptanceDecision =
  | { decision: 'accept-mutual-in-person'; originalVerificationId: string }
  | { decision: 'remote-unbound'; reason: 'missing-in-response-to' | 'no-pending-counter-verification' | 'pending-counter-expired' }
  | { decision: 'reject'; reason: 'wrong-subject' | 'wrong-issuer' | 'not-verification-attestation' }

export class VerificationWorkflow {
  private readonly randomId: () => string
  private readonly now: () => Date
  private readonly stateStore: VerificationStateStore | undefined
  private activeQrChallenge: QrChallenge | null = null
  /**
   * Serialisiert record/clear der persistierten Challenge (Review #339):
   * Instanz-lokal garantiert die Kette die Reihenfolge (reset → create beim
   * Auto-Regenerate); Cross-Instanz schützt zusätzlich das compare-and-delete
   * per Nonce im Port. Fehler laufen zum jeweiligen Awaiter durch (create
   * meldet Persist-Fehler), vergiften aber nie die Kette.
   */
  private challengeStoreQueue: Promise<void> = Promise.resolve()
  /**
   * Monotone Mutations-Epoche der aktiven QR-Challenge (Review #339,
   * struktureller Umbau): create und reset erhöhen sie; jede asynchrone
   * Fortsetzung (Create-Rollback, Accept-Null, Restore-Commit) erfasst ihre
   * Epoche vor dem await und committet über commitChallengeState NUR, wenn
   * sie noch aktuell ist. Das löst alle Instanz-internen Interleavings
   * einheitlich statt per Einzelfall-Guard; Cross-Instanz schützt weiterhin
   * das compare-and-delete per Nonce im Store.
   */
  private challengeEpoch = 0
  private readonly consumedNonces = new Map<string, number>()
  private readonly pendingCounterVerifications = new Map<string, PendingCounterVerification>()

  constructor(options: VerificationWorkflowOptions = {}) {
    this.randomId = options.randomId ?? (() => crypto.randomUUID())
    this.now = options.now ?? (() => new Date())
    this.stateStore = options.stateStore
  }

  async createOnlineQrChallenge(
    identity: IdentitySession,
    name: string,
    options: CreateOnlineQrChallengeOptions = {},
  ): Promise<CreateOnlineQrChallengeResult> {
    const challenge: QrChallenge = {
      did: identity.getDid(),
      name,
      enc: encodeBase64Url(await identity.getEncryptionPublicKeyBytes()),
      nonce: this.randomId(),
      ts: this.now().toISOString(),
    }
    if (options.broker !== undefined) challenge.broker = options.broker

    const parsedChallenge = parseQrChallenge(JSON.stringify(challenge))
    // Store and return the normalized Trust 002 JSON form that passed protocol validation.
    const rawJson = JSON.stringify(parsedChallenge)
    const epoch = ++this.challengeEpoch
    const previousChallenge = this.activeQrChallenge
    this.activeQrChallenge = { ...parsedChallenge }
    // Entscheidung 2026-08-04 (1c): Challenge überlebt Reload/Re-Login der
    // Owner-Session, wenn der Store die Capability anbietet. Die TTL-Prüfung
    // bleibt vollständig bei decideVerificationAttestationAcceptance.
    // Ein Persist-Fehler darf NICHT als Erfolg durchgehen — der Rollback
    // committet epochen-geprüft (ein neueres create/reset bleibt unberührt).
    try {
      await this.enqueueChallengeStoreOp(() => this.stateStore?.recordActiveQrChallenge?.({ ...parsedChallenge }))
    } catch (error) {
      this.commitChallengeState(epoch, previousChallenge)
      throw error
    }
    return { challenge: { ...parsedChallenge }, rawJson }
  }

  /**
   * Reihenfolge-treue Kette für Challenge-Store-Operationen: der Fehler einer
   * Operation erreicht ihren Awaiter, die Kette selbst läuft immer weiter.
   */
  private enqueueChallengeStoreOp(op: () => Promise<void> | undefined): Promise<void> {
    const run = this.challengeStoreQueue.then(async () => {
      await op()
    })
    this.challengeStoreQueue = run.then(() => undefined, () => undefined)
    return run
  }

  /**
   * Einziger Commit-Pfad für den RAM-Zustand nach einem await: schreibt nur,
   * wenn die erfasste Epoche noch aktuell ist (siehe challengeEpoch).
   */
  private commitChallengeState(epoch: number, next: QrChallenge | null): boolean {
    if (epoch !== this.challengeEpoch) return false
    this.activeQrChallenge = next
    return true
  }

  /**
   * Wie commitChallengeState, rückt bei Erfolg zusätzlich die Epoche vor —
   * für Mutationen, die ältere Flights invalidieren MÜSSEN (erfolgreicher
   * Accept: die Challenge ist konsumiert, ein hängender Restore darf sie
   * nicht wiederbeleben). Reject-Pfade rufen das bewusst NICHT auf: sie
   * verändern den aktiven Zustand nicht.
   */
  private commitAndAdvanceChallengeState(epoch: number, next: QrChallenge | null): boolean {
    if (!this.commitChallengeState(epoch, next)) return false
    this.challengeEpoch++
    return true
  }

  getActiveQrChallenge(): QrChallenge | null {
    return this.activeQrChallenge === null ? null : { ...this.activeQrChallenge }
  }

  /**
   * Hydriert die aktive QR-Challenge aus dem StateStore (Dialog-Restore nach
   * Reload). Gibt die dann aktive Challenge zurück — die Frische prüft weiter
   * ausschließlich der Accept-Pfad; für die UI-Anzeige steht
   * isActiveQrChallengeValid im Protocol-Layer bereit.
   */
  async restoreActiveQrChallenge(): Promise<QrChallenge | null> {
    if (this.activeQrChallenge !== null) return { ...this.activeQrChallenge }
    const epoch = this.challengeEpoch
    try {
      // Erst ausstehende record/clear-Operationen abwarten, sonst liest der
      // Restore einen Zwischenstand derselben Instanz. Ein Lesefehler oder ein
      // korruptes Blob degradiert auf "keine Challenge" — der Restore ist eine
      // Komfort-Capability und darf den Accept-Pfad nie abbrechen; die
      // Wire-Re-Validierung via parseQrChallenge bleibt.
      await this.challengeStoreQueue
      const stored = await this.stateStore?.getActiveQrChallenge?.()
      if (!stored) return null
      const parsed = parseQrChallenge(JSON.stringify(stored))
      // Epochen-Commit: hat ein paralleles create/reset inzwischen mutiert,
      // gewinnt der jüngere Zustand — der verspätete Restore meldet ihn nur.
      if (!this.commitChallengeState(epoch, { ...parsed })) return this.getActiveQrChallenge()
      return { ...parsed }
    } catch {
      return null
    }
  }

  resetActiveQrChallenge(): void {
    this.challengeEpoch++
    const nonce = this.activeQrChallenge?.nonce
    this.activeQrChallenge = null
    // Best-effort über die Kette; das Clear ist per Nonce an die EIGENE
    // Challenge gebunden — die einer parallelen Instanz bleibt stehen.
    // Ein blinder Reset (keine eigene Challenge) besitzt nichts im Store und
    // löscht deshalb GAR nichts; den vollständigen Abraum übernimmt der
    // Identity-Wipe. Die Epoche steigt trotzdem: sie invalidiert auch einen
    // gerade laufenden Restore (restore/reset-Race).
    if (nonce === undefined) return
    void this.enqueueChallengeStoreOp(() => this.stateStore?.clearActiveQrChallenge?.(nonce)).catch(() => {})
  }

  async createVerificationAttestation(input: CreateVerificationAttestationInput): Promise<Attestation> {
    const subjectDid = input.subjectDid.trim()
    const challengeNonce = input.challengeNonce.trim()
    if (subjectDid.length === 0) throw new Error('Missing subject DID')
    if (challengeNonce.length === 0) throw new Error('Missing challenge nonce')
    const attestation = await this.createSignedVerificationAttestation({
      issuer: input.issuer,
      subjectDid,
      id: `urn:uuid:${challengeNonce.toLowerCase()}`,
    })
    await this.recordPendingCounterVerification({
      counterpartyDid: subjectDid,
      originalVerificationId: attestation.id,
    })
    return attestation
  }

  async createCounterVerificationAttestation(input: CreateCounterVerificationAttestationInput): Promise<Attestation> {
    const subjectDid = input.subjectDid.trim()
    const inResponseTo = input.inResponseTo.trim()
    if (subjectDid.length === 0) throw new Error('Missing subject DID')
    if (inResponseTo.length === 0) throw new Error('Missing inResponseTo')
    return this.createSignedVerificationAttestation({
      issuer: input.issuer,
      subjectDid,
      id: `urn:uuid:ver-${this.randomId()}`,
      inResponseTo,
    })
  }

  acceptVerifiedVerificationAttestation(
    identity: IdentitySession,
    payload: AttestationVcPayload,
  ): VerificationAttestationAcceptanceDecision | Promise<VerificationAttestationAcceptanceDecision> {
    if (this.stateStore) return this.acceptVerifiedVerificationAttestationWithStore(identity, payload)

    const now = this.now()
    this.pruneConsumedNonces(now)

    const decision = decideVerificationAttestationAcceptance({
      payload,
      localDid: identity.getDid(),
      activeChallenge: this.activeQrChallenge ?? undefined,
      now,
      consumedNonces: new Set(this.consumedNonces.keys()),
    })
    const consumedNonce = this.findConsumedNonce(payload.jti)
    // Preserve primary protocol rejections to avoid leaking nonce-history membership.
    // Only a remote/unbound result can be upgraded into the local replay classification.
    if (decision.decision === 'remote-unbound' && consumedNonce) {
      return { decision: 'reject', reason: 'nonce-consumed' }
    }
    if (decision.decision === 'accept-in-person') {
      this.consumedNonces.set(decision.nonce.toLowerCase(), now.getTime())
      this.activeQrChallenge = null
      // accept-in-person guarantees jti exists; missing jti would have produced missing-jti-nonce.
      this.recordPendingCounterVerification({
        counterpartyDid: payload.iss,
        originalVerificationId: payload.jti!,
      })
    }
    return decision
  }

  /**
   * Public for composition code that imports an already accepted in-person Verification-Attestation.
   */
  recordPendingCounterVerification(
    options: RecordPendingCounterVerificationOptions,
  ): PendingCounterVerification | Promise<PendingCounterVerification> {
    const now = this.now()
    const pending: PendingCounterVerification = {
      counterpartyDid: options.counterpartyDid,
      originalVerificationId: options.originalVerificationId,
      createdAt: wholeSecondRfc3339(now),
      expiresAt: wholeSecondRfc3339(new Date(now.getTime() + PENDING_COUNTER_VERIFICATION_MAX_AGE_MS)),
    }
    if (this.stateStore) return this.recordPendingCounterVerificationWithStore(pending)

    this.pendingCounterVerifications.set(pending.originalVerificationId, pending)
    return { ...pending }
  }

  getPendingCounterVerification(originalVerificationId: string): PendingCounterVerification | null | Promise<PendingCounterVerification | null> {
    if (this.stateStore) return this.getPendingCounterVerificationWithStore(originalVerificationId)

    this.prunePendingCounterVerifications(this.now())
    const pending = this.pendingCounterVerifications.get(originalVerificationId)
    return pending === undefined ? null : { ...pending }
  }

  getPendingCounterVerifications(): PendingCounterVerification[] | Promise<PendingCounterVerification[]> {
    if (this.stateStore) return this.getPendingCounterVerificationsWithStore()

    this.prunePendingCounterVerifications(this.now())
    return Array.from(this.pendingCounterVerifications.values(), (pending) => ({ ...pending }))
  }

  acceptVerifiedCounterVerification(
    identity: IdentitySession,
    payload: AttestationVcPayload,
  ): CounterVerificationAcceptanceDecision | Promise<CounterVerificationAcceptanceDecision> {
    if (this.stateStore) return this.acceptVerifiedCounterVerificationWithStore(identity, payload)

    const now = this.now()
    const localDid = identity.getDid()
    if (payload.sub !== localDid || payload.credentialSubject?.id !== localDid) {
      return { decision: 'reject', reason: 'wrong-subject' }
    }
    if (!isVerificationAttestationPayload(payload)) {
      return { decision: 'reject', reason: 'not-verification-attestation' }
    }
    const inResponseTo = typeof payload.inResponseTo === 'string' && payload.inResponseTo.length > 0
      ? payload.inResponseTo
      : null
    if (!inResponseTo) return { decision: 'remote-unbound', reason: 'missing-in-response-to' }

    const pending = this.pendingCounterVerifications.get(inResponseTo)
    if (!pending) return { decision: 'remote-unbound', reason: 'no-pending-counter-verification' }
    if (Date.parse(pending.expiresAt) <= now.getTime()) {
      this.pendingCounterVerifications.delete(inResponseTo)
      return { decision: 'remote-unbound', reason: 'pending-counter-expired' }
    }
    if (payload.iss !== pending.counterpartyDid || payload.issuer !== pending.counterpartyDid) {
      return { decision: 'reject', reason: 'wrong-issuer' }
    }

    this.pendingCounterVerifications.delete(inResponseTo)
    return { decision: 'accept-mutual-in-person', originalVerificationId: inResponseTo }
  }

  publicKeyFromDid(did: string): string {
    if (!did.startsWith('did:key:')) throw new Error('Invalid did:key format')
    return did.slice(8)
  }

  multibaseToBytes(multibase: string): Uint8Array {
    return ed25519MultibaseToPublicKeyBytes(multibase)
  }

  base64UrlToBytes(base64url: string): Uint8Array {
    return decodeBase64Url(base64url)
  }

  private async createSignedVerificationAttestation(input: {
    issuer: IdentitySession
    subjectDid: string
    id: string
    inResponseTo?: string
  }): Promise<Attestation> {
    const createdAt = wholeSecondRfc3339(this.now())
    const from = input.issuer.getDid()
    const payload = createVerificationAttestationVcPayload({
      id: input.id,
      from,
      to: input.subjectDid,
      createdAt,
      inResponseTo: input.inResponseTo,
    })
    const vcJws = await createAttestationVcJwsWithSigner({
      kid: `${from}#sig-0`,
      payload,
      sign: async (signingInput) => decodeBase64Url(await input.issuer.sign(new TextDecoder().decode(signingInput))),
    })

    return {
      id: input.id,
      from,
      to: input.subjectDid,
      claim: VERIFICATION_ATTESTATION_CLAIM,
      ...(input.inResponseTo ? { inResponseTo: input.inResponseTo } : {}),
      createdAt,
      vcJws,
      // Type-borne marker (review MAJOR 2): by construction this VC's `type`
      // array carries WotVerification, so the derived form is a verification.
      isVerification: isVerificationAttestation(payload),
    }
  }

  private pruneConsumedNonces(now: Date): void {
    const nowMs = now.getTime()
    for (const [nonce, consumedAtMs] of this.consumedNonces) {
      if (nowMs - consumedAtMs > CONSUMED_NONCE_RETENTION_MS) this.consumedNonces.delete(nonce)
    }
  }

  private prunePendingCounterVerifications(now: Date): void {
    const nowMs = now.getTime()
    for (const [originalVerificationId, pending] of this.pendingCounterVerifications) {
      if (Date.parse(pending.expiresAt) <= nowMs) this.pendingCounterVerifications.delete(originalVerificationId)
    }
  }

  private findConsumedNonce(jti: string | undefined): string | null {
    if (!jti) return null
    const nonce = parseVerificationJtiNonce(jti)
    return nonce !== null && this.consumedNonces.has(nonce) ? nonce : null
  }

  private async acceptVerifiedVerificationAttestationWithStore(
    identity: IdentitySession,
    payload: AttestationVcPayload,
  ): Promise<VerificationAttestationAcceptanceDecision> {
    const store = this.stateStore!
    const now = this.now()
    await store.pruneConsumedNonces(wholeSecondRfc3339(new Date(now.getTime() - CONSUMED_NONCE_RETENTION_MS)))

    // Entscheidung 2026-08-04 (1c): nach Reload/Re-Login die persistierte
    // Challenge hydrieren, bevor entschieden wird — die Frische-/Nonce-Prüfung
    // bleibt komplett bei decideVerificationAttestationAcceptance (eine
    // abgelaufene Challenge wird dort challenge-expired, nie angenommen).
    if (this.activeQrChallenge === null) await this.restoreActiveQrChallenge()
    // Epoche NACH der Hydration erfassen: das spätere RAM-Null committet nur,
    // wenn während Consume/Persist kein create/reset dazwischenkam.
    const epoch = this.challengeEpoch

    const decision = decideVerificationAttestationAcceptance({
      payload,
      localDid: identity.getDid(),
      activeChallenge: this.activeQrChallenge ?? undefined,
      now,
      consumedNonces: new Set(),
    })
    const consumedNonce = await this.findConsumedNonceWithStore(payload.jti)
    if (decision.decision === 'remote-unbound' && consumedNonce) {
      return { decision: 'reject', reason: 'nonce-consumed' }
    }
    if (decision.decision === 'accept-in-person') {
      const consumed = await store.tryConsumeNonce(decision.nonce.toLowerCase(), wholeSecondRfc3339(now))
      if (!consumed) {
        return { decision: 'reject', reason: 'nonce-consumed' }
      }
      // Epochen-Commit MIT Vorrücken: der erfolgreiche Accept ist selbst eine
      // Mutation — er invalidiert ältere Restore-Flights, die die konsumierte
      // Challenge sonst wiederbeleben könnten. Nur nullen+vorrücken, wenn
      // seit der Entscheidung kein create/reset mutiert hat (Store-Seite
      // schützt compare-and-delete).
      this.commitAndAdvanceChallengeState(epoch, null)
      // Reihenfolge (Review #339): Die Nonce ist ab hier durabel konsumiert —
      // zuerst den pending counter sichern, dann das Challenge-Clear als
      // best-effort, per Nonce an die soeben akzeptierte Challenge gebunden
      // (eine inzwischen neu erzeugte bleibt stehen). Ein Clear-Fehler darf
      // den Accept nie abbrechen, sonst dauerhaft nonce-consumed ohne Mutual.
      await this.recordPendingCounterVerification({
        counterpartyDid: payload.iss,
        originalVerificationId: payload.jti!,
      })
      await this.enqueueChallengeStoreOp(() => store.clearActiveQrChallenge?.(decision.nonce)).catch(() => {})
    }
    return decision
  }

  private async recordPendingCounterVerificationWithStore(
    pending: PendingCounterVerification,
  ): Promise<PendingCounterVerification> {
    await this.stateStore!.recordPendingCounterVerification(pending)
    return { ...pending }
  }

  private async getPendingCounterVerificationWithStore(
    originalVerificationId: string,
  ): Promise<PendingCounterVerification | null> {
    const now = this.now()
    await this.stateStore!.prunePendingCounterVerifications(wholeSecondRfc3339(now))
    const pending = await this.stateStore!.getPendingCounterVerification(originalVerificationId)
    return pending === null ? null : { ...pending }
  }

  private async getPendingCounterVerificationsWithStore(): Promise<PendingCounterVerification[]> {
    await this.stateStore!.prunePendingCounterVerifications(wholeSecondRfc3339(this.now()))
    return (await this.stateStore!.getPendingCounterVerifications()).map((pending) => ({ ...pending }))
  }

  private async acceptVerifiedCounterVerificationWithStore(
    identity: IdentitySession,
    payload: AttestationVcPayload,
  ): Promise<CounterVerificationAcceptanceDecision> {
    const store = this.stateStore!
    const now = this.now()
    const localDid = identity.getDid()
    if (payload.sub !== localDid || payload.credentialSubject?.id !== localDid) {
      return { decision: 'reject', reason: 'wrong-subject' }
    }
    if (!isVerificationAttestationPayload(payload)) {
      return { decision: 'reject', reason: 'not-verification-attestation' }
    }
    const inResponseTo = typeof payload.inResponseTo === 'string' && payload.inResponseTo.length > 0
      ? payload.inResponseTo
      : null
    if (!inResponseTo) return { decision: 'remote-unbound', reason: 'missing-in-response-to' }

    if (payload.iss !== payload.issuer) {
      return { decision: 'reject', reason: 'wrong-issuer' }
    }
    const result = await store.consumePendingCounterVerification(inResponseTo, payload.iss, wholeSecondRfc3339(now))
    if (result === 'missing') return { decision: 'remote-unbound', reason: 'no-pending-counter-verification' }
    if (result === 'expired') return { decision: 'remote-unbound', reason: 'pending-counter-expired' }
    if (result === 'wrong-counterparty') return { decision: 'reject', reason: 'wrong-issuer' }
    return { decision: 'accept-mutual-in-person', originalVerificationId: inResponseTo }
  }

  private async findConsumedNonceWithStore(jti: string | undefined): Promise<string | null> {
    if (!jti) return null
    const nonce = parseVerificationJtiNonce(jti)
    if (nonce === null) return null
    return await this.stateStore!.hasConsumedNonce(nonce) ? nonce : null
  }
}

function createVerificationAttestationVcPayload(input: {
  id: string
  from: string
  to: string
  createdAt: string
  inResponseTo?: string
}): AttestationVcPayload {
  const timestampSeconds = Math.floor(new Date(input.createdAt).getTime() / 1000)
  return {
    '@context': ['https://www.w3.org/ns/credentials/v2', 'https://web-of-trust.de/vocab/v1'],
    id: input.id,
    type: ['VerifiableCredential', 'WotAttestation', 'WotVerification'],
    issuer: input.from,
    credentialSubject: {
      id: input.to,
      claim: VERIFICATION_ATTESTATION_CLAIM,
    },
    validFrom: input.createdAt,
    iss: input.from,
    sub: input.to,
    nbf: timestampSeconds,
    jti: input.id,
    ...(input.inResponseTo ? { inResponseTo: input.inResponseTo } : {}),
    iat: timestampSeconds,
  }
}

function isVerificationAttestationPayload(payload: AttestationVcPayload): boolean {
  // VE-7: discriminate on the central WotVerification `type` marker, not the
  // display-only claim label.
  return isVerificationAttestation(payload)
}
