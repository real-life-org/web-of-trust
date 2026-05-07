import type { IdentitySession } from '../identity'
import type { Attestation } from '../../types/attestation'
import type { AttestationVcPayload, ProtocolCryptoAdapter } from '../../protocol'
import {
  createAttestationVcJwsWithSigner,
  decodeBase64Url,
  verifyAttestationVcJws,
} from '../../protocol'

export interface AttestationWorkflowOptions {
  crypto: ProtocolCryptoAdapter
  randomId?: () => string
  now?: () => Date
}

export interface CreateAttestationInput {
  issuer: IdentitySession
  subjectDid: string
  claim: string
  tags?: string[]
}

export class AttestationWorkflow {
  private readonly crypto: ProtocolCryptoAdapter
  private readonly randomId: () => string
  private readonly now: () => Date

  constructor(options: AttestationWorkflowOptions) {
    this.crypto = options.crypto
    this.randomId = options.randomId ?? (() => crypto.randomUUID())
    this.now = options.now ?? (() => new Date())
  }

  async createAttestation(input: CreateAttestationInput): Promise<Attestation> {
    const id = `urn:uuid:${this.randomId()}`
    const createdAt = new Date(Math.floor(this.now().getTime() / 1000) * 1000).toISOString()
    const from = input.issuer.getDid()
    const to = input.subjectDid
    const vcJws = await createAttestationVcJwsWithSigner({
      kid: `${from}#sig-0`,
      payload: this.createVcPayload({ id, from, to, claim: input.claim, tags: input.tags, createdAt }),
      sign: async (signingInput) => decodeBase64Url(await input.issuer.sign(new TextDecoder().decode(signingInput))),
    })

    return {
      id,
      from,
      to,
      claim: input.claim,
      ...(input.tags ? { tags: input.tags } : {}),
      createdAt,
      vcJws,
    }
  }

  async verifyAttestation(attestation: Attestation): Promise<boolean> {
    try {
      this.assertComplete(attestation)
      const payload = await this.verifyAttestationVcJws(attestation.vcJws)
      return this.payloadMatchesAttestation(payload, attestation)
    } catch {
      return false
    }
  }

  verifyAttestationVcJws(jws: string): Promise<AttestationVcPayload> {
    return verifyAttestationVcJws(jws, { crypto: this.crypto })
  }

  exportAttestation(attestation: Attestation): string {
    this.assertComplete(attestation)
    return attestation.vcJws
  }

  async importAttestation(encoded: string): Promise<Attestation> {
    const trimmed = encoded.trim()
    if (!isJwsCompact(trimmed)) throw new Error('Invalid attestation format')

    try {
      const payload = await this.verifyAttestationVcJws(trimmed)
      return this.attestationFromVcPayload(payload, trimmed)
    } catch {
      throw new Error('Invalid attestation signature')
    }
  }

  private createVcPayload(input: {
    id: string
    from: string
    to: string
    claim: string
    tags?: string[]
    createdAt: string
  }): AttestationVcPayload {
    const credentialSubject: AttestationVcPayload['credentialSubject'] = {
      id: input.to,
      claim: input.claim,
      ...(input.tags ? { tags: input.tags } : {}),
    }
    return {
      '@context': ['https://www.w3.org/ns/credentials/v2', 'https://web-of-trust.de/vocab/v1'],
      id: input.id,
      type: ['VerifiableCredential', 'WotAttestation'],
      issuer: input.from,
      credentialSubject,
      validFrom: input.createdAt,
      iss: input.from,
      sub: input.to,
      nbf: Math.floor(new Date(input.createdAt).getTime() / 1000),
      jti: input.id,
      iat: Math.floor(new Date(input.createdAt).getTime() / 1000),
    }
  }

  private attestationFromVcPayload(payload: AttestationVcPayload, vcJws: string): Attestation {
    const tags = payload.credentialSubject.tags
    const context = payload.credentialSubject.context
    const id = typeof payload.jti === 'string'
      ? payload.jti
      : typeof payload.id === 'string'
        ? payload.id
        : `wot:attestation:${payload.iss}:${payload.sub}:${payload.nbf}`

    return {
      id,
      from: payload.issuer,
      to: payload.credentialSubject.id,
      claim: payload.credentialSubject.claim,
      ...(Array.isArray(tags) && tags.every(tag => typeof tag === 'string') ? { tags } : {}),
      ...(typeof context === 'string' ? { context } : {}),
      createdAt: payload.validFrom,
      vcJws,
    }
  }

  private payloadMatchesAttestation(payload: AttestationVcPayload, attestation: Attestation): boolean {
    return payload.issuer === attestation.from &&
      payload.iss === attestation.from &&
      payload.sub === attestation.to &&
      payload.credentialSubject.id === attestation.to &&
      payload.credentialSubject.claim === attestation.claim &&
      payload.validFrom === attestation.createdAt &&
      (payload.jti == null || payload.jti === attestation.id) &&
      (payload.id == null || payload.id === attestation.id)
  }

  private assertComplete(attestation: Attestation): void {
    if (!attestation.id || !attestation.from || !attestation.to || !attestation.claim || !attestation.createdAt || !attestation.vcJws) {
      throw new Error('Incomplete attestation')
    }
  }
}

function isJwsCompact(value: string): boolean {
  return /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value)
}
