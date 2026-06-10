import { describe, expect, it } from 'vitest'
import {
  createDidKeyResolver,
  createInboxInnerJws,
  decodeBase64Url,
  encodeBase64Url,
  resolveDidKey,
  verifyInboxInnerJws,
  type DidResolver,
  type InboxInnerJwsPayload,
} from '../src/protocol'
import { INBOX_MESSAGE_TYPE, SPACE_INVITE_MESSAGE_TYPE } from '../src/protocol'
import { createTestIdentity, testCryptoAdapter } from './helpers/identity-session'

// Sync 003 Z.458-466: Inner-JWS Pflichtfelder {from,to,type,id,created_time}
// + die vier puren Empfänger-MUSS-Prüfungen (Signatur, to===ownDid,
// from===Signer, created_time-Fenster). Prüfung 5 (Message-ID-History) liegt
// beim Aufrufer (MessageIdHistoryPort), nicht in diesem Verifier.

const OUTER_ID = '550e8400-e29b-41d4-a716-446655440000'
const NOW = new Date('2026-06-10T12:00:00Z')
const NOW_SECONDS = Math.floor(NOW.getTime() / 1000)

async function signedPayload(overrides: Partial<InboxInnerJwsPayload> = {}) {
  const sender = (await createTestIdentity()).identity
  const recipient = (await createTestIdentity()).identity
  const payload: InboxInnerJwsPayload = {
    from: sender.did,
    to: recipient.did,
    type: INBOX_MESSAGE_TYPE,
    id: OUTER_ID,
    created_time: NOW_SECONDS,
    body: { vcJws: 'a.b.c' },
    ...overrides,
  }
  const jws = await createInboxInnerJws({
    payload,
    sign: (input) => sender.signEd25519(input),
    kid: sender.kid,
  })
  return { sender, recipient, payload, jws }
}

function verifyOptions(recipientDid: string, overrides: Record<string, unknown> = {}) {
  return {
    crypto: testCryptoAdapter,
    didResolver: createDidKeyResolver(),
    ownDid: recipientDid,
    expectedOuterType: INBOX_MESSAGE_TYPE,
    expectedOuterId: OUTER_ID,
    now: () => NOW,
    ...overrides,
  }
}

describe('createInboxInnerJws / verifyInboxInnerJws', () => {
  it('roundtrips: builder output verifies and returns the payload with authenticated from', async () => {
    const { sender, recipient, jws } = await signedPayload()
    const result = await verifyInboxInnerJws(jws, verifyOptions(recipient.did))
    expect(result.from).toBe(sender.did)
    expect(result.to).toBe(recipient.did)
    expect(result.type).toBe(INBOX_MESSAGE_TYPE)
    expect(result.id).toBe(OUTER_ID)
    expect(result.body).toEqual({ vcJws: 'a.b.c' })
  })

  it('builder rejects a kid whose DID does not match payload.from', async () => {
    const sender = (await createTestIdentity()).identity
    const other = (await createTestIdentity()).identity
    await expect(
      createInboxInnerJws({
        payload: {
          from: other.did,
          to: sender.did,
          type: INBOX_MESSAGE_TYPE,
          id: OUTER_ID,
          created_time: NOW_SECONDS,
          body: {},
        },
        sign: (input) => sender.signEd25519(input),
        kid: sender.kid,
      }),
    ).rejects.toThrow('kid DID does not match payload from')
  })

  it('rejects a tampered signature (Pflichtprüfung 1)', async () => {
    const { recipient, jws } = await signedPayload()
    const [header, payload, signature] = jws.split('.')
    const signatureBytes = decodeBase64Url(signature)
    signatureBytes[0] ^= 0xff
    const tampered = [header, payload, encodeBase64Url(signatureBytes)].join('.')
    await expect(verifyInboxInnerJws(tampered, verifyOptions(recipient.did))).rejects.toThrow(
      'Invalid JWS signature',
    )
  })

  it('rejects to !== ownDid — Misdirection (Pflichtprüfung 2)', async () => {
    const { jws } = await signedPayload()
    const stranger = (await createTestIdentity()).identity
    await expect(verifyInboxInnerJws(jws, verifyOptions(stranger.did))).rejects.toThrow(
      'Inner JWS to does not match own DID',
    )
  })

  it('rejects from !== JWS-Signer — Sender-Spoofing (Pflichtprüfung 3)', async () => {
    // Hand-gebauter JWS: kid + Signatur von sender, payload.from = fremde DID.
    const sender = (await createTestIdentity()).identity
    const recipient = (await createTestIdentity()).identity
    const spoofedFrom = (await createTestIdentity()).identity
    const enc = new TextEncoder()
    const header = encodeBase64Url(enc.encode(JSON.stringify({ alg: 'EdDSA', kid: sender.kid })))
    const payload = encodeBase64Url(
      enc.encode(
        JSON.stringify({
          from: spoofedFrom.did,
          to: recipient.did,
          type: INBOX_MESSAGE_TYPE,
          id: OUTER_ID,
          created_time: NOW_SECONDS,
          body: {},
        }),
      ),
    )
    const signature = await sender.signEd25519(enc.encode(`${header}.${payload}`))
    const jws = [header, payload, encodeBase64Url(signature)].join('.')
    await expect(verifyInboxInnerJws(jws, verifyOptions(recipient.did))).rejects.toThrow(
      'Inner JWS from does not match signer',
    )
  })

  it('rejects created_time older than maxAgeMs (Pflichtprüfung 4, Default 24h)', async () => {
    const { recipient, jws } = await signedPayload({
      created_time: NOW_SECONDS - 25 * 60 * 60,
    })
    await expect(verifyInboxInnerJws(jws, verifyOptions(recipient.did))).rejects.toThrow(
      'Inner JWS created_time too old',
    )
  })

  it('accepts created_time inside a custom maxAgeMs window', async () => {
    const { recipient, jws } = await signedPayload({ created_time: NOW_SECONDS - 60 })
    const result = await verifyInboxInnerJws(
      jws,
      verifyOptions(recipient.did, { maxAgeMs: 5 * 60 * 1000 }),
    )
    expect(result.created_time).toBe(NOW_SECONDS - 60)
  })

  it('rejects created_time in the far future (Pflichtprüfung 4, Clock-Skew-Obergrenze)', async () => {
    // Replay-Lücke ohne Obergrenze: ein zukunftsdatiertes created_time bestünde
    // die Untergrenze unbegrenzt, während die Message-ID-History nur
    // retention-lang ab Erstsicht hält — nach dem Prune wäre dieselbe
    // Nachricht erneut zustellbar.
    const { recipient, jws } = await signedPayload({
      created_time: NOW_SECONDS + 25 * 60 * 60,
    })
    await expect(verifyInboxInnerJws(jws, verifyOptions(recipient.did))).rejects.toThrow(
      'Inner JWS created_time too far in the future',
    )
  })

  it('accepts created_time within the default clock skew (5 min)', async () => {
    const { recipient, jws } = await signedPayload({ created_time: NOW_SECONDS + 60 })
    const result = await verifyInboxInnerJws(jws, verifyOptions(recipient.did))
    expect(result.created_time).toBe(NOW_SECONDS + 60)
  })

  it('accepts created_time inside a custom maxClockSkewMs window', async () => {
    const { recipient, jws } = await signedPayload({ created_time: NOW_SECONDS + 10 * 60 })
    const result = await verifyInboxInnerJws(
      jws,
      verifyOptions(recipient.did, { maxClockSkewMs: 15 * 60 * 1000 }),
    )
    expect(result.created_time).toBe(NOW_SECONDS + 10 * 60)
  })

  it('rejects an outer-type binding mismatch', async () => {
    const { recipient, jws } = await signedPayload()
    await expect(
      verifyInboxInnerJws(jws, verifyOptions(recipient.did, { expectedOuterType: SPACE_INVITE_MESSAGE_TYPE })),
    ).rejects.toThrow('Inner JWS type does not match envelope type')
  })

  it('rejects an outer-id binding mismatch', async () => {
    const { recipient, jws } = await signedPayload()
    await expect(
      verifyInboxInnerJws(
        jws,
        verifyOptions(recipient.did, { expectedOuterId: '7a1c2f80-aabb-4cdd-9eef-112233445566' }),
      ),
    ).rejects.toThrow('Inner JWS id does not match envelope id')
  })

  it('rejects a resolved DID document whose id does not match the kid DID (VE-4-Muster)', async () => {
    const { sender, recipient, jws } = await signedPayload()
    const foreignDoc = { ...resolveDidKey(sender.did), id: recipient.did }
    const badResolver: DidResolver = { resolve: async () => foreignDoc }
    await expect(
      verifyInboxInnerJws(jws, verifyOptions(recipient.did, { didResolver: badResolver })),
    ).rejects.toThrow('Resolved DID document does not match DID')
  })

  it('rejects a non-EdDSA alg', async () => {
    const { recipient, jws } = await signedPayload()
    const enc = new TextEncoder()
    const [, payload, signature] = jws.split('.')
    const recipientKid = `${recipient.did}#sig-0`
    const badHeader = encodeBase64Url(enc.encode(JSON.stringify({ alg: 'HS256', kid: recipientKid })))
    await expect(
      verifyInboxInnerJws([badHeader, payload, signature].join('.'), verifyOptions(recipient.did)),
    ).rejects.toThrow('Unsupported JWS alg')
  })

  it('rejects a payload missing a Pflichtfeld (Sync 003 Z.460)', async () => {
    const sender = (await createTestIdentity()).identity
    const recipient = (await createTestIdentity()).identity
    const enc = new TextEncoder()
    const header = encodeBase64Url(enc.encode(JSON.stringify({ alg: 'EdDSA', kid: sender.kid })))
    const payload = encodeBase64Url(
      enc.encode(
        JSON.stringify({
          from: sender.did,
          to: recipient.did,
          type: INBOX_MESSAGE_TYPE,
          // id fehlt
          created_time: NOW_SECONDS,
          body: {},
        }),
      ),
    )
    const signature = await sender.signEd25519(enc.encode(`${header}.${payload}`))
    const jws = [header, payload, encodeBase64Url(signature)].join('.')
    await expect(verifyInboxInnerJws(jws, verifyOptions(recipient.did))).rejects.toThrow(
      'Invalid inner JWS payload id',
    )
  })
})
