/**
 * Verification-Delivery-Workflow — framework-free application use-case for
 * relaying Trust 002 verification-attestations to a peer.
 *
 * Clarification #170 (docs/migration/PHASE-1-WOT-CORE-DEMO.md §1.B.2):
 * "framework-freier Verification-Delivery-Workflow plus React-Hook über
 * Application-Use-Case. Relay-Envelope-Konstruktion + Contact/Profile-
 * Side-Effects wandern hinter den Workflow. Voraussetzung 1.B.2-ack ✅.
 * Kein Spec-Gate."
 *
 * This module owns the DRY delivery core that confirmAndRespond /
 * confirmIncoming / counterVerify (React hook) and respondToChallenge /
 * maybeSendCounterVerification (CLI) previously duplicated inline: build the
 * relay MessageEnvelope, sign it, fire it (fire-and-forget), plus the
 * surrounding contact / profile-sync / persistence side-effects.
 *
 * The attestation itself is produced by VerificationWorkflow / AttestationWorkflow
 * upstream and passed in as a finished artifact — this workflow only delivers it.
 *
 * transitional — modernized to DIDComm in 1.B.3 (Sync 003); the MessageEnvelope
 * format and the (bound) signEnvelope port are legacy envelope-auth per
 * real-life-org/wot-spec#96 and die with the Phase 2+ Automerge-adapter-stack
 * refactor. This workflow deliberately preserves them byte-for-byte (pure
 * extraction, no format change). To keep the deprecated signEnvelope import out
 * of this layer, signing is injected as an already-bound port; the consumer
 * imports the deprecated helper, not this module.
 */

import type { Attestation } from '../../types/attestation'
import type { MessageEnvelope, DeliveryReceipt } from '../../types/messaging'
import { createResourceRef } from '../../types/resource-ref'

const VERIFICATION_ATTESTATION_CLAIM = 'in-person verifiziert'

/** Optional contact side-effect run before the attestation is delivered. */
export interface DeliveryContact {
  did: string
  publicKey: string
  name?: string
  status: 'active'
}

export interface DeliverAttestationInput {
  /** A finished attestation produced upstream (VerificationWorkflow / AttestationWorkflow). */
  attestation: Attestation
  /** envelope.fromDid — the local DID. */
  fromDid: string
  /** envelope.toDid — the attestation recipient. */
  toDid: string
  /** Optional pre-delivery side-effect: addContact then fire-and-forget syncContactProfile. */
  contact?: DeliveryContact
  /** Default true: persist via saveAttestation. Pass false when the caller already saved. */
  persist?: boolean
  /**
   * Optional envelope.createdAt override. Defaults to now().toISOString().
   * The CLI passes attestation.createdAt to stay byte-for-byte identical.
   */
  createdAt?: string
}

export interface DeliverAttestationResult {
  /** The signed envelope that was handed to send(). */
  envelope: MessageEnvelope
  /** Receipt from send(), or null when delivery failed (fire-and-forget contract). */
  receipt: DeliveryReceipt | null
}

export interface VerificationDeliveryPorts {
  /** Send the envelope. Signature mirrors MessagingAdapter['send']. */
  send: (envelope: MessageEnvelope) => Promise<DeliveryReceipt>
  /**
   * Sign the envelope in place (sets envelope.signature). The caller binds the
   * deprecated signEnvelope(env, sign) helper so this layer never imports it.
   */
  signEnvelope: (envelope: MessageEnvelope) => Promise<void>
  saveAttestation: (attestation: Attestation) => Promise<void>
  addContact: (
    did: string,
    publicKey: string,
    name: string | undefined,
    status: 'active',
  ) => Promise<void>
  /** Fire-and-forget: called WITHOUT await. */
  syncContactProfile: (did: string) => void | Promise<void>
  /** Deterministic clock for envelope.createdAt. Default: () => new Date(). */
  now?: () => Date
}

export interface VerificationDeliveryWorkflow {
  deliverAttestation(input: DeliverAttestationInput): Promise<DeliverAttestationResult>
}

export function createVerificationDeliveryWorkflow(
  ports: VerificationDeliveryPorts,
): VerificationDeliveryWorkflow {
  const now = ports.now ?? (() => new Date())

  return {
    async deliverAttestation(input: DeliverAttestationInput): Promise<DeliverAttestationResult> {
      const { attestation, fromDid, toDid, contact, persist, createdAt } = input

      // 1. Optional contact side-effect: add the contact first (syncContactProfile
      //    reads/updates the just-created contact), then sync fire-and-forget.
      if (contact) {
        await ports.addContact(contact.did, contact.publicKey, contact.name, contact.status)
        // fire-and-forget — intentionally not awaited (mirrors hook's syncContactProfile(did))
        void ports.syncContactProfile(contact.did)
      }

      // 2. Persist (unless the caller already stored the attestation).
      if (persist !== false) {
        await ports.saveAttestation(attestation)
      }

      // 3. Build the relay envelope — transitional legacy envelope-auth
      //    (wot-spec#96; modernized to DIDComm in 1.B.3 / Sync 003).
      const envelope: MessageEnvelope = {
        v: 1,
        id: attestation.id,
        type: 'attestation',
        fromDid,
        toDid,
        createdAt: createdAt ?? now().toISOString(),
        encoding: 'json',
        payload: JSON.stringify(attestation),
        signature: '',
        ref: createResourceRef('attestation', attestation.id),
      }

      // 4. Sign in place via the injected (bound) signEnvelope port.
      await ports.signEnvelope(envelope)

      // 5. Fire-and-forget delivery: swallow send failures into receipt:null
      //    (preserves the old `send(envelope).catch(() => {})` contract).
      let receipt: DeliveryReceipt | null = null
      try {
        receipt = await ports.send(envelope)
      } catch {
        receipt = null
      }

      return { envelope, receipt }
    },
  }
}

export interface FindOriginalVerificationAttestationCriteria {
  targetDid: string
  localDid: string
  /** Claim used to identify in-person verification-attestations. Defaults to the Trust 002 claim. */
  claim?: string
}

/**
 * Pure helper for the deferred counter-verification path: from a list of
 * received attestations, pick the newest incoming nonce-bound (original, i.e.
 * !inResponseTo) verification-attestation issued by `targetDid` to `localDid`.
 *
 * Only the counterVerify call-site needs this; it is therefore a standalone pure
 * function rather than a port on the delivery core.
 */
export function findOriginalVerificationAttestation(
  received: readonly Attestation[],
  criteria: FindOriginalVerificationAttestationCriteria,
): Attestation | null {
  const claim = criteria.claim ?? VERIFICATION_ATTESTATION_CLAIM
  return (
    received
      .filter(
        (attestation) =>
          attestation.from === criteria.targetDid &&
          attestation.to === criteria.localDid &&
          attestation.claim === claim &&
          !attestation.inResponseTo,
      )
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0] ?? null
  )
}
