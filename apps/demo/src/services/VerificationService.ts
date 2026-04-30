import type { StorageAdapter, Verification, VerificationChallenge, VerificationResponse } from '@web_of_trust/core'

/**
 * VerificationService - Thin wrapper around wot-core verification
 *
 * Provides storage persistence for verification records.
 * Core protocol logic lives in the wot-core verification application workflow.
 */
export class VerificationService {
  constructor(private storage: StorageAdapter) {}

  async saveVerification(verification: Verification): Promise<void> {
    await this.storage.saveVerification(verification)
  }

  async getReceivedVerifications(): Promise<Verification[]> {
    return this.storage.getReceivedVerifications()
  }

  async getVerification(id: string): Promise<Verification | null> {
    return this.storage.getVerification(id)
  }

  // Encoding/decoding helpers for QR codes and manual input
  encodeChallenge(challenge: VerificationChallenge): string {
    return btoa(JSON.stringify(challenge))
  }

  decodeChallenge(encoded: string): VerificationChallenge {
    return JSON.parse(atob(encoded))
  }

  encodeResponse(response: VerificationResponse): string {
    return btoa(JSON.stringify(response))
  }

  decodeResponse(encoded: string): VerificationResponse {
    return JSON.parse(atob(encoded))
  }
}
