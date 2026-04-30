import { IdentityWorkflow, SeedStorageIdentityVault, WebCryptoProtocolCryptoAdapter } from '@web_of_trust/core'

export function createIdentityWorkflow(): IdentityWorkflow {
  return new IdentityWorkflow({
    crypto: new WebCryptoProtocolCryptoAdapter(),
    vault: new SeedStorageIdentityVault(),
  })
}
