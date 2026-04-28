import type { IdentitySession } from '../identity'
import type { Attestation } from '../../types/attestation'
import type { Proof } from '../../types/proof'
import type { AttestationVcPayload, ProtocolCryptoAdapter } from '../../protocol'
import {
  createAttestationVcJwsWithSigner,
  decodeBase64Url,
  didKeyToPublicKeyBytes,
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
    const createdAt = this.now().toISOString()
    const from = input.issuer.getDid()
    const to = input.subjectDid
    const proof: Proof = {
      type: 'Ed25519Signature2020',
      verificationMethod: `${from}#key-1`,
      created: createdAt,
      proofPurpose: 'assertionMethod',
      proofValue: await input.issuer.sign(this.legacySigningData({ id, from, to, claim: input.claim, tags: input.tags, createdAt })),
    }
    const vcJws = await createAttestationVcJwsWithSigner({
      kid: `${from}#sig-0`,
      payload: this.createVcPayload({ from, to, claim: input.claim, tags: input.tags, createdAt }),
      sign: async (signingInput) => decodeBase64Url(await input.issuer.sign(new TextDecoder().decode(signingInput))),
    })

    return {
      id,
      from,
      to,
      claim: input.claim,
      ...(input.tags ? { tags: input.tags } : {}),
      createdAt,
      proof,
      vcJws,
    }
  }

  async verifyAttestation(attestation: Attestation): Promise<boolean> {
    try {
      this.assertComplete(attestation)
      const legacyValid = await this.crypto.verifyEd25519(
        new TextEncoder().encode(this.legacySigningData(attestation)),
        decodeBase64Url(attestation.proof.proofValue),
        didKeyToPublicKeyBytes(attestation.from),
      )
      if (!legacyValid) return false
      if (!attestation.vcJws) return true

      const payload = await this.verifyAttestationVcJws(attestation.vcJws)
      return payload.issuer === attestation.from &&
        payload.sub === attestation.to &&
        payload.credentialSubject.id === attestation.to &&
        payload.credentialSubject.claim === attestation.claim
    } catch {
      return false
    }
  }

  verifyAttestationVcJws(jws: string): Promise<AttestationVcPayload> {
    return verifyAttestationVcJws(jws, { crypto: this.crypto })
  }

  exportAttestation(attestation: Attestation): string {
    return encodeJson(attestation)
  }

  async importAttestation(encoded: string): Promise<Attestation> {
    let attestation: Attestation
    try {
      attestation = decodeJson<Attestation>(encoded.trim())
    } catch {
      throw new Error('Invalid attestation format')
    }
    this.assertComplete(attestation)
    if (!(await this.verifyAttestation(attestation))) throw new Error('Invalid attestation signature')
    return attestation
  }

  private createVcPayload(input: {
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
      type: ['VerifiableCredential', 'WotAttestation'],
      issuer: input.from,
      credentialSubject,
      validFrom: input.createdAt,
      iss: input.from,
      sub: input.to,
      nbf: Math.floor(new Date(input.createdAt).getTime() / 1000),
      iat: Math.floor(new Date(input.createdAt).getTime() / 1000),
    }
  }

  private legacySigningData(attestation: Pick<Attestation, 'id' | 'from' | 'to' | 'claim' | 'tags' | 'createdAt'>): string {
    return JSON.stringify({
      id: attestation.id,
      from: attestation.from,
      to: attestation.to,
      claim: attestation.claim,
      ...(attestation.tags != null ? { tags: attestation.tags } : {}),
      createdAt: attestation.createdAt,
    })
  }

  private assertComplete(attestation: Attestation): void {
    if (!attestation.id || !attestation.from || !attestation.to || !attestation.claim || !attestation.createdAt || !attestation.proof) {
      throw new Error('Incomplete attestation')
    }
  }
}

function encodeJson(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value))
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function decodeJson<T>(encoded: string): T {
  const binary = atob(encoded)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return JSON.parse(new TextDecoder().decode(bytes)) as T
}
