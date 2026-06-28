import { existsSync, readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import { rowToAttestation } from './rowMappers'

describe('rowMappers source guard', () => {
  const sourcePath = existsSync('src/adapters/rowMappers.ts')
    ? 'src/adapters/rowMappers.ts'
    : 'apps/demo/src/adapters/rowMappers.ts'
  const source = readFileSync(sourcePath, 'utf8')

  it('does not export the legacy verification row mapper', () => {
    expect(source).not.toContain('rowToVerification')
    expect(source).not.toMatch(/import type \{[^}]*Verification/)
  })

  it('keeps active contact and attestation row mappers', () => {
    expect(source).toContain('rowToContact')
    expect(source).toContain('rowToAttestation')
  })
})

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
