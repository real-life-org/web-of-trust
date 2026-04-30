import { VerificationWorkflow, WebCryptoProtocolCryptoAdapter } from '@web_of_trust/core'

export const verificationWorkflow = new VerificationWorkflow({
  crypto: new WebCryptoProtocolCryptoAdapter(),
})
