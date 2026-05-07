import type { Contact, Verification, Attestation } from '@web_of_trust/core/types'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function rowToContact(row: any): Contact {
  return {
    did: row.did,
    publicKey: row.publicKey,
    ...(row.name != null ? { name: row.name } : {}),
    ...(row.avatar != null ? { avatar: row.avatar } : {}),
    ...(row.bio != null ? { bio: row.bio } : {}),
    status: row.status,
    ...(row.verifiedAt != null ? { verifiedAt: row.verifiedAt } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function rowToVerification(row: any): Verification {
  return {
    id: row.id,
    from: row.fromDid,
    to: row.toDid,
    timestamp: row.timestamp,
    proof: JSON.parse(row.proofJson),
    ...(row.locationJson != null ? { location: JSON.parse(row.locationJson) } : {}),
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function rowToAttestation(row: any): Attestation {
  return {
    id: row.attestationId ?? row.id,
    from: row.fromDid,
    to: row.toDid,
    claim: row.claim,
    ...(row.tagsJson != null ? { tags: JSON.parse(row.tagsJson) } : {}),
    ...(row.context != null ? { context: row.context } : {}),
    createdAt: row.createdAt,
    vcJws: row.vcJws,
  }
}
