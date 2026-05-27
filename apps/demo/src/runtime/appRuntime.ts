import {
  AttestationWorkflow,
  IdentityWorkflow,
  VerificationWorkflow,
} from '@web_of_trust/core/application'
import { HttpDiscoveryAdapter, IndexedDbIdentitySeedVault } from '@web_of_trust/core/adapters'
import { WebCryptoProtocolCryptoAdapter } from '@web_of_trust/core/protocol-adapters'

export const appRuntimeConfig = {
  relayUrl: import.meta.env.VITE_RELAY_URL ?? 'wss://relay.utopia-lab.org',
  profileServiceUrl: import.meta.env.VITE_PROFILE_SERVICE_URL ?? 'http://localhost:8788',
  vaultUrl: import.meta.env.VITE_VAULT_URL ?? 'https://vault.utopia-lab.org',
}

const protocolCrypto = new WebCryptoProtocolCryptoAdapter()

export const verificationWorkflow = new VerificationWorkflow({
  crypto: protocolCrypto,
})

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
