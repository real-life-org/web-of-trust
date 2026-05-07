import {
  AttestationWorkflow,
  IdentityWorkflow,
  VerificationWorkflow,
} from '@web_of_trust/core/application'
import { HttpDiscoveryAdapter, SeedStorageIdentityVault } from '@web_of_trust/core/adapters'
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
    vault: new SeedStorageIdentityVault(),
  })
}

export function createAttestationWorkflow(): AttestationWorkflow {
  return new AttestationWorkflow({ crypto: protocolCrypto })
}

export function createHttpDiscoveryAdapter(): HttpDiscoveryAdapter {
  return new HttpDiscoveryAdapter(appRuntimeConfig.profileServiceUrl)
}
