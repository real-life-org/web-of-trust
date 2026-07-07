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
        await saveUnlessDuplicate(deps, attestation)
        deps.setChallengeNonce(null)
        deps.setPendingIncoming({ attestation, fromDid: attestation.from })
      } else if (decision.decision === 'accept-mutual-in-person') {
        // Duplikat-Counter-Verifications (z.B. Redelivery) sind konklusiv egal.
        await saveUnlessDuplicate(deps, attestation)
      }
      return
    }

    // Save idempotent; Trigger immer — der generische OPEN-Gate (¬resolved)
    // entscheidet, ob der Dialog erscheint (siehe accept-in-person oben).
    await saveUnlessDuplicate(deps, attestation)
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

function isVerificationAttestationPayload(payload: AttestationVcPayload): boolean {
  // VE-7: discriminate on the central WotVerification `type` marker.
  return isVerificationAttestation(payload)
}
