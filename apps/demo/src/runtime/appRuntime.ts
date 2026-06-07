import {
  AttestationWorkflow,
  IdentityWorkflow,
  VerificationWorkflow,
  createVerificationDeliveryWorkflow,
  type VerificationDeliveryWorkflow,
} from '@web_of_trust/core/application'
import type { Attestation, MessageEnvelope, DeliveryReceipt } from '@web_of_trust/core/types'
import { HttpDiscoveryAdapter } from '@web_of_trust/core/adapters/discovery/http'
import { IndexedDbIdentitySeedVault } from '@web_of_trust/core/adapters/storage/indexeddb'
import { WebCryptoProtocolCryptoAdapter } from '@web_of_trust/core/protocol-adapters'
import { signEnvelope } from '@web_of_trust/core/crypto'

export const appRuntimeConfig = {
  relayUrl: import.meta.env.VITE_RELAY_URL ?? 'wss://relay.utopia-lab.org',
  profileServiceUrl: import.meta.env.VITE_PROFILE_SERVICE_URL ?? 'http://localhost:8788',
  vaultUrl: import.meta.env.VITE_VAULT_URL ?? 'https://vault.utopia-lab.org',
}

const protocolCrypto = new WebCryptoProtocolCryptoAdapter()

export const verificationWorkflow = new VerificationWorkflow({
  crypto: protocolCrypto,
})

/**
 * Demo-side bindings the verification-delivery-workflow needs from the React hook
 * layer. The hook supplies its messaging/contact/profile/storage/identity ports;
 * this factory binds the deprecated legacy-envelope-auth signEnvelope helper
 * (wot-spec#96) so the deprecated import stays out of useVerification.ts and the
 * Trust 002 source-guard ("hook imports no signEnvelope") holds.
 * transitional — modernized to DIDComm in 1.B.3 (Sync 003).
 */
export interface VerificationDeliveryBindings {
  send: (envelope: MessageEnvelope) => Promise<DeliveryReceipt>
  saveAttestation: (attestation: Attestation) => Promise<void>
  addContact: (
    did: string,
    publicKey: string,
    name: string | undefined,
    status: 'active',
  ) => Promise<void>
  /** Fire-and-forget — called WITHOUT await inside the workflow. */
  syncContactProfile: (did: string) => void | Promise<void>
  /** Signs `data` for the bound envelope-auth helper. */
  sign: (data: string) => Promise<string>
}

/**
 * Wire the framework-free verification-delivery-workflow to the demo's React
 * ports. signEnvelope is bound here (not in the hook) so the deprecated
 * envelope-auth import never reaches the hook layer.
 */
export function bindVerificationDelivery(
  bindings: VerificationDeliveryBindings,
): VerificationDeliveryWorkflow {
  return createVerificationDeliveryWorkflow({
    send: bindings.send,
    signEnvelope: (envelope) => signEnvelope(envelope, (data) => bindings.sign(data)).then(() => undefined),
    saveAttestation: bindings.saveAttestation,
    addContact: bindings.addContact,
    syncContactProfile: bindings.syncContactProfile,
  })
}

export function createIdentityWorkflow(): IdentityWorkflow {
  return new IdentityWorkflow({
    crypto: protocolCrypto,
    vault: new IndexedDbIdentitySeedVault(),
  })
}

export function createAttestationWorkflow(): AttestationWorkflow {
  return new AttestationWorkflow({ crypto: protocolCrypto })
}

export function createHttpDiscoveryAdapter(): HttpDiscoveryAdapter {
  return new HttpDiscoveryAdapter(appRuntimeConfig.profileServiceUrl)
}

// Browser-local stable deviceId source for Sync 003 broker auth. Scoped per
// DID so two identities on the same browser register as distinct devices.
// `crypto.randomUUID()` emits canonical lowercase UUID-v4. This source defines
// no protocol semantics — it only persists the value the broker accepts.
const DEVICE_ID_STORAGE_PREFIX = 'wot-device-id:'

export function getOrCreateBrowserDeviceId(did: string): string {
  const key = `${DEVICE_ID_STORAGE_PREFIX}${did}`
  const existing = localStorage.getItem(key)
  if (existing && isCanonicalLowercaseUuidV4(existing)) return existing
  const id = crypto.randomUUID()
  localStorage.setItem(key, id)
  return id
}

function isCanonicalLowercaseUuidV4(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)
}
