import { describe, it, expect } from 'vitest'
import { rowToAttestation } from './rowMappers'

describe('rowToAttestation', () => {
  const baseRow = {
    id: 'evolu-hash-id',
    fromDid: 'did:key:sender',
    toDid: 'did:key:recipient',
    claim: 'Knows TypeScript',
    tagsJson: null,
    context: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    vcJws: 'header.payload.signature',
  }

  it('uses attestationId when present', () => {
    const row = { ...baseRow, attestationId: 'urn:uuid:original-id' }
    const result = rowToAttestation(row)
    expect(result.id).toBe('urn:uuid:original-id')
  })

  it('falls back to row.id for legacy rows without attestationId', () => {
    const row = { ...baseRow, attestationId: null }
    const result = rowToAttestation(row)
    expect(result.id).toBe('evolu-hash-id')
  })

  it('falls back to row.id when attestationId is undefined', () => {
    const row = { ...baseRow }
    const result = rowToAttestation(row)
    expect(result.id).toBe('evolu-hash-id')
  })
})
