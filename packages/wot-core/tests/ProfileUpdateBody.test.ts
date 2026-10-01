import { describe, it, expect } from 'vitest'
import {
  PROFILE_UPDATE_BODY_KIND,
  ATTESTATION_RECEIPT_BODY_KIND,
  assertProfileUpdateBody,
  createProfileUpdateBody,
  isAttestationReceiptBody,
  isProfileUpdateBody,
  PROFILE_UPDATE_AVATAR_MAX_LENGTH,
} from '../src/protocol'

const UPDATED_AT = '2026-10-01T12:00:00.000Z'

function validBody(profile: Record<string, unknown> = {}) {
  return { kind: PROFILE_UPDATE_BODY_KIND, profile: { name: 'Anna', updatedAt: UPDATED_AT, ...profile } }
}

describe('profile-update inbox body (wot#386)', () => {
  it('builds a body from a profile without the did (the sender is the inner-JWS signer)', () => {
    const body = createProfileUpdateBody({
      did: 'did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK',
      name: 'Anna',
      bio: 'Gärtnerin',
      avatar: 'data:image/jpeg;base64,AAAA',
      offers: ['Werkzeug'],
      needs: ['Saatgut'],
      updatedAt: UPDATED_AT,
    })

    expect(body).toEqual({
      kind: 'profile-update',
      profile: {
        name: 'Anna',
        bio: 'Gärtnerin',
        avatar: 'data:image/jpeg;base64,AAAA',
        offers: ['Werkzeug'],
        needs: ['Saatgut'],
        updatedAt: UPDATED_AT,
      },
    })
  })

  it('omits empty optional fields', () => {
    const body = createProfileUpdateBody({ did: 'did:key:z6Mk', name: 'Anna', bio: '', offers: [], updatedAt: UPDATED_AT })
    expect(body.profile).toEqual({ name: 'Anna', updatedAt: UPDATED_AT })
  })

  it('discriminates on kind, and never mistakes an attestation or receipt body for it', () => {
    expect(isProfileUpdateBody(validBody())).toBe(true)
    expect(isProfileUpdateBody({ vcJws: 'a.b.c' })).toBe(false)
    expect(isProfileUpdateBody({ kind: ATTESTATION_RECEIPT_BODY_KIND, jti: 'x', status: 'received' })).toBe(false)
    expect(isProfileUpdateBody(null)).toBe(false)
    expect(isAttestationReceiptBody(validBody())).toBe(false)
  })

  it('accepts a valid body', () => {
    expect(() => assertProfileUpdateBody(validBody({ bio: 'x', offers: ['a'], needs: ['b'], avatar: 'data:image/png;base64,AA' }))).not.toThrow()
  })

  it.each([
    ['an extra top-level key', { ...validBody(), vcJws: 'a.b.c' }],
    ['an unknown profile key', validBody({ did: 'did:key:z6Mk' })],
    ['a missing name', { kind: PROFILE_UPDATE_BODY_KIND, profile: { updatedAt: UPDATED_AT } }],
    ['a blank name', validBody({ name: '   ' })],
    ['a missing updatedAt', { kind: PROFILE_UPDATE_BODY_KIND, profile: { name: 'Anna' } }],
    ['an unparseable updatedAt', validBody({ updatedAt: 'gestern' })],
    ['a non-image avatar', validBody({ avatar: 'https://tracker.example/pixel.gif' })],
    ['an oversized avatar', validBody({ avatar: `data:image/jpeg;base64,${'A'.repeat(PROFILE_UPDATE_AVATAR_MAX_LENGTH)}` })],
    ['a non-string offer', validBody({ offers: ['a', 3] })],
    ['a non-array needs', validBody({ needs: 'Saatgut' })],
  ])('rejects %s', (_label, body) => {
    expect(() => assertProfileUpdateBody(body)).toThrow()
  })
})
