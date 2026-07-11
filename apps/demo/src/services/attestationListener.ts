import type { Attestation, IdentitySession } from '@web_of_trust/core/types'
import type {
  AttestationVcPayload,
  VerificationAttestationAcceptanceDecision,
} from '@web_of_trust/core/protocol'
import { isVerificationAttestation } from '@web_of_trust/core/protocol'
import type { CounterVerificationAcceptanceDecision } from '@web_of_trust/core/application'
import { DuplicateAttestationError } from './AttestationService'
import type { AttestationDeliveryListener } from './InboxReceptionHost'

export interface IncomingAttestationDialogInfo {
  attestationId: string
  senderName: string
  senderDid: string
  claim: string
}

export interface AttestationListenerDeps {
  attestationService: {
    decodeIncomingAttestation(vcJws: string): Promise<{
      attestation: Attestation
      payload: AttestationVcPayload
    }>
    saveIncomingAttestation(attestation: Attestation): Promise<Attestation>
    /**
     * Auto-Publish (Legacy-Parität): eine frisch gespeicherte Verifikations-
     * Attestation auf `accepted:true` heben, damit der debounced Re-Upload in
     * useProfileSync sie ohne manuellen Consent-Toggle auf den Profilserver (/v)
     * legt. Für normale Attestations bleibt `accepted:false` (Consent-Toggle).
     */
    setAttestationAccepted(attestationId: string, accepted: boolean): Promise<void>
    /**
     * Variante A (zweites Häkchen): App-Level Empfangs-Ack an die `iss`-DID des
     * Ausstellers, NACH erfolgreichem Verify+Store. Best-effort — Fehler dürfen
     * die bereits gespeicherte Attestation nicht zurückrollen.
     */
    sendReceiptAck(issuerDid: string, jti: string): Promise<void>
  }
  verificationWorkflow: {
    acceptVerifiedVerificationAttestation(
      identity: IdentitySession,
      payload: AttestationVcPayload,
    ): VerificationAttestationAcceptanceDecision | Promise<VerificationAttestationAcceptanceDecision>
    acceptVerifiedCounterVerification(
      identity: IdentitySession,
      payload: AttestationVcPayload,
    ): CounterVerificationAcceptanceDecision | Promise<CounterVerificationAcceptanceDecision>
  }
  getLocalDid(): string | null
  getLocalIdentity(): IdentitySession | null
  findContactName(did: string): string | undefined
  setChallengeNonce(nonce: string | null): void
  setPendingIncoming(pending: { attestation: Attestation; fromDid: string } | null): void
  triggerAttestationDialog(info: IncomingAttestationDialogInfo): void
}

/**
 * Produktiver inbox/1.0-Attestation-Listener (VE-9), aus App.tsx extrahiert,
 * damit Tests den echten Code treffen statt einer Reimplementierung.
 *
 * Der Inbox-Reception-Host authentifiziert den Umschlag (Inner-JWS) und
 * liefert {vcJws, senderDid} — die VC-Verifikation (Trust 002) passiert hier.
 * Lokale Attestation-Felder werden aus dem VC-Payload abgeleitet (K2), nie aus
 * Wire-Feldern.
 *
 * Fehlerdisziplin (M-A, Sync 003 Z.466 + Z.620-622):
 * - Deterministische Ausgänge (ungültiger VC, verletzte Bindung, Duplikat,
 *   nicht akzeptierte Verification) enden normal — der Host wertet das als
 *   konklusiv (record + ack, Queue-Hygiene).
 * - Transiente Fehler (Storage offline, Workflow-State nicht erreichbar)
 *   werden DURCHGEWORFEN — der Host klassifiziert processing-incomplete,
 *   ackt NICHT, und die Relay-Redelivery ist der Recovery-Pfad.
 */
export function createAttestationListener(deps: AttestationListenerDeps): AttestationDeliveryListener {
  return async (delivery) => {
    let decoded: { attestation: Attestation; payload: AttestationVcPayload }
    try {
      decoded = await deps.attestationService.decodeIncomingAttestation(delivery.vcJws)
    } catch (error) {
      // VC-Verifikation ist pure → deterministisch ungültig, konklusiv.
      console.debug('Incoming attestation rejected (invalid VC-JWS):', error)
      return
    }
    const { attestation, payload } = decoded

    const localDid = deps.getLocalDid()
    const localIdentity = deps.getLocalIdentity()
    if (!localDid || !localIdentity) {
      // Ohne entsperrte Identity nicht verarbeitbar → transient (Redelivery).
      throw new Error('No unlocked identity for incoming attestation')
    }

    // M-C (Sync 003 Z.460-464; normative Klärung angefragt in
    // real-life-org/wot-spec#98): der VC-Issuer MUSS der per Inner-JWS
    // authentifizierte Inbox-Sender sein und das abgeleitete `to`
    // (credentialSubject.id) die eigene DID — sonst könnte jeder einen
    // öffentlich abrufbaren Dritt-VC mit eigenem gültigem Inner-JWS einliefern
    // und den Dialog dem VC-Issuer unterschieben. Verstoß ist deterministisch
    // → konklusiv (record + ack), keine Endlos-Redelivery.
    if (payload.iss !== delivery.senderDid) {
      console.debug('Incoming attestation rejected: VC issuer does not match authenticated inbox sender')
      return
    }
    if (attestation.to !== localDid) {
      console.debug('Incoming attestation rejected: VC subject is not the local DID')
      return
    }

    if (isVerificationAttestationPayload(payload)) {
      if (payload.sub !== localDid || payload.credentialSubject.id !== localDid) return

      const decision = payload.inResponseTo
        ? await deps.verificationWorkflow.acceptVerifiedCounterVerification(localIdentity, payload)
        : await deps.verificationWorkflow.acceptVerifiedVerificationAttestation(localIdentity, payload)

      if (decision.decision === 'accept-in-person') {
        // Save idempotent; der Dialog-Trigger hängt NICHT mehr an isNew: ein
        // Sibling-Device kann die Attestation via Personal-Doc-Sync schon
        // gespeichert haben, BEVOR die eigene Inbox-Delivery ankommt — das
        // isNew-Gate hat den Dialog dann still verschluckt. Aufgelöstes
        // unterdrückt der generische OPEN-Gate (¬resolved) im Provider.
        const savedFresh = await saveUnlessDuplicate(deps, attestation)
        // Auto-Publish (Legacy-Parität): NUR bei frischem Save publiziert die
        // Verifikation automatisch. Eine Redelivery/Duplikat (savedFresh=false)
        // darf ein bewusstes Depublish (User-Toggle off) NICHT überschreiben.
        if (savedFresh) await autoPublishVerification(deps, attestation)
        // Zweites Häkchen: verifiziert+gespeichert → Empfangs-Ack (Variante A).
        await ackReceipt(deps, attestation)
        deps.setChallengeNonce(null)
        deps.setPendingIncoming({ attestation, fromDid: attestation.from })
      } else if (decision.decision === 'accept-mutual-in-person') {
        // Duplikat-Counter-Verifications (z.B. Redelivery) sind konklusiv egal.
        const savedFresh = await saveUnlessDuplicate(deps, attestation)
        if (savedFresh) await autoPublishVerification(deps, attestation)
        await ackReceipt(deps, attestation)
      }
      // Alle anderen Verification-Decisions kehren OHNE Speicherung zurück →
      // KEIN Ack (ehrliche Semantik: Reject-Pfad, z.B. Clock-Skew).
      return
    }

    // Save idempotent; Trigger immer — der generische OPEN-Gate (¬resolved)
    // entscheidet, ob der Dialog erscheint (siehe accept-in-person oben).
    await saveUnlessDuplicate(deps, attestation)
    // Zweites Häkchen: verifiziert+gespeichert → Empfangs-Ack (Variante A).
    await ackReceipt(deps, attestation)
    const name = deps.findContactName(attestation.from) || 'Kontakt'
    deps.triggerAttestationDialog({
      attestationId: attestation.id,
      senderName: name,
      senderDid: attestation.from,
      claim: attestation.claim,
    })
  }
}

/**
 * M-A: Duplikate deterministisch erkennen (eigener Fehlertyp) statt catch-all.
 * Alles andere ist ein transienter Persist-Fehler und wird durchgeworfen,
 * damit der Host processing-incomplete klassifiziert (kein ack, kein record).
 */
async function saveUnlessDuplicate(
  deps: Pick<AttestationListenerDeps, 'attestationService'>,
  attestation: Attestation,
): Promise<boolean> {
  try {
    await deps.attestationService.saveIncomingAttestation(attestation)
    return true
  } catch (error) {
    if (error instanceof DuplicateAttestationError) return false
    throw error
  }
}

/**
 * Auto-Publish (Legacy-Parität, Produktentscheidung): eine frisch gespeicherte
 * Verifikations-Attestation auf `accepted:true` heben. Der debounced Re-Upload
 * in useProfileSync liest `meta.accepted` und publiziert die Verifikation dann
 * ohne manuellen Consent-Toggle auf `/v` (Sync 004).
 *
 * Best-effort: schlägt der Flip transient fehl, bleibt die Attestation gespeichert
 * und der Aussteller-Ack unberührt — die Verifikation wird erst beim nächsten
 * manuellen Toggle publiziert. Ein Rethrow würde eine Relay-Redelivery auslösen,
 * die den Save als Duplikat erkennt (savedFresh=false) und den Flip GAR NICHT
 * mehr nachholt; darum wird der Fehler bewusst verschluckt statt den Host
 * processing-incomplete klassifizieren zu lassen. Der Aufrufer ruft dies NUR bei
 * frischem Save (savedFresh=true), damit eine Redelivery ein bewusstes Depublish
 * nicht wieder auf accepted:true kippt.
 */
async function autoPublishVerification(
  deps: Pick<AttestationListenerDeps, 'attestationService'>,
  attestation: Attestation,
): Promise<void> {
  try {
    await deps.attestationService.setAttestationAccepted(attestation.id, true)
  } catch (error) {
    console.debug('[attestationListener] Auto-publish of verification failed (best-effort):', error)
  }
}

/**
 * Variante A (zweites Häkchen): Empfangs-Ack an den Aussteller senden, NACH
 * erfolgreichem Verify+Store. Best-effort — jeder Fehler (kein keyAgreement-Key
 * des Ausstellers, Transport-Fehler) wird verschluckt: die bereits gespeicherte
 * Attestation bleibt, der Transport-Ack der Original-Nachricht ist unberührt,
 * das zweite Häkchen bleibt beim Sender einfach aus. Wird auch bei
 * DuplicateAttestationError erneut gesendet (der Aussteller hat evtl. den ersten
 * Ack verpasst); die stabile Ack-ID sorgt für RX-Dedup beim Sender.
 */
async function ackReceipt(
  deps: Pick<AttestationListenerDeps, 'attestationService'>,
  attestation: Attestation,
): Promise<void> {
  try {
    await deps.attestationService.sendReceiptAck(attestation.from, attestation.id)
  } catch (error) {
    console.debug('[attestationListener] Receipt-ack send failed (best-effort):', error)
  }
}

function isVerificationAttestationPayload(payload: AttestationVcPayload): boolean {
  // VE-7: discriminate on the central WotVerification `type` marker.
  return isVerificationAttestation(payload)
}
