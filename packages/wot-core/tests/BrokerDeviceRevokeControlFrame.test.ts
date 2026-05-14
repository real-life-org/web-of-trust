import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  assertBrokerDeviceRevokeControlFrame,
  canonicalizeToBytes,
  createBrokerDeviceRevokeControlFrame,
  createJcsEd25519Jws,
  decodeBase64Url,
  didKeyToPublicKeyBytes,
  encodeBase64Url,
  parseBrokerDeviceRevokeControlFrame,
  verifyBrokerDeviceRevokeControlFrame,
} from '../src/protocol'
import { WebCryptoProtocolCryptoAdapter } from '../src/protocol-adapters'

const phase1 = loadSpecVector('./fixtures/wot-spec/phase-1-interop.json')
const vector = phase1.broker_device_revoke_control_frame
const DID = phase1.identity.did
const KID = phase1.identity.kid
const DEVICE_ID = vector.device_id
const REVOKED_AT = vector.revoked_at
const cryptoAdapter = new WebCryptoProtocolCryptoAdapter()

function loadSpecVector(relativePath: string): any {
  return JSON.parse(readFileSync(new URL(relativePath, import.meta.url), 'utf8'))
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error('Invalid hex string')
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i++) bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return bytes
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function bytesToText(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes)
}

function validFrame(overrides: Record<string, unknown> = {}) {
  return {
    type: 'device-revoke',
    revocationJws: vector.revocation_jws,
    ...overrides,
  }
}

async function signedRevocation(payload: Record<string, unknown>, header: Record<string, unknown> = vector.header) {
  return createJcsEd25519Jws(
    header as any,
    payload as any,
    hexToBytes(phase1.identity.ed25519_seed_hex),
  )
}

function replaceJwsHeader(jws: string, header: Record<string, unknown>): string {
  const [, payload, signature] = jws.split('.')
  return `${encodeBase64Url(canonicalizeToBytes(header as any))}.${payload}.${signature}`
}

describe('Sync 003 broker device-revoke control frame', () => {
  it('exposes pure create, parse, assert, and verify helpers for the signed control-frame shape', () => {
    expect(typeof createBrokerDeviceRevokeControlFrame).toBe('function')
    expect(typeof parseBrokerDeviceRevokeControlFrame).toBe('function')
    expect(typeof assertBrokerDeviceRevokeControlFrame).toBe('function')
    expect(typeof verifyBrokerDeviceRevokeControlFrame).toBe('function')
  })

  it('constructs and parses only the closed outer { type, revocationJws } frame shape', () => {
    const frame = createBrokerDeviceRevokeControlFrame({
      revocationJws: vector.revocation_jws,
    })

    expect(frame).toEqual(vector.frame)
    expect(parseBrokerDeviceRevokeControlFrame(frame)).toEqual({
      type: 'device-revoke',
      revocationJws: vector.revocation_jws,
      header: vector.header,
      payload: vector.payload,
      signingBytes: new TextEncoder().encode(vector.signing_input),
      signatureBytes: decodeBase64Url(vector.signature_b64),
    })
    expect(() => assertBrokerDeviceRevokeControlFrame(frame)).not.toThrow()
  })

  it('matches the upstream vector for frame roundtrip, decoded JWS, payload hash, signing input, and signature bytes', async () => {
    const parsed = parseBrokerDeviceRevokeControlFrame(vector.frame)
    const payloadHash = await cryptoAdapter.sha256(canonicalizeToBytes(parsed.payload))

    expect(parsed.type).toBe('device-revoke')
    expect(parsed.revocationJws).toBe(vector.revocation_jws)
    expect(parsed.header).toEqual(vector.header)
    expect(parsed.payload).toEqual(vector.payload)
    expect(bytesToText(canonicalizeToBytes(parsed.payload))).toBe(vector.payload_jcs_canonical_string)
    expect(bytesToHex(payloadHash)).toBe(vector.payload_jcs_sha256)
    expect(bytesToText(parsed.signingBytes)).toBe(vector.signing_input)
    expect(encodeBase64Url(parsed.signatureBytes)).toBe(vector.signature_b64)
  })

  it('rejects malformed outer control-frame shapes before JWS verification', async () => {
    const inheritedRevocationJws = Object.create({ revocationJws: vector.revocation_jws })
    inheritedRevocationJws.type = 'device-revoke'

    const nonEnumerableOuter = validFrame()
    Object.defineProperty(nonEnumerableOuter, 'trace', {
      value: 'not allowed',
      enumerable: false,
    })

    const symbolOuter = validFrame()
    Object.defineProperty(symbolOuter, Symbol('trace'), {
      value: 'not allowed',
      enumerable: true,
    })

    const malformedFrames = [
      ['non-object', null],
      ['missing type', { revocationJws: vector.revocation_jws }],
      ['wrong type', validFrame({ type: 'device-revoked' })],
      ['missing revocationJws', { type: 'device-revoke' }],
      ['empty revocationJws', validFrame({ revocationJws: '' })],
      ['non-string revocationJws', validFrame({ revocationJws: vector.payload })],
      ['non-compact revocationJws', validFrame({ revocationJws: 'not-a-jws' })],
      ['with thid', vector.malformed_frames.with_thid],
      ['with body', validFrame({ body: vector.payload })],
      ['unknown top-level field', vector.malformed_frames.unknown_top_level_field],
      ['inline decoded payload fields', vector.malformed_frames.inline_payload_without_jws],
      ['transport id', validFrame({ id: DEVICE_ID })],
      ['transport typ', validFrame({ typ: 'application/didcomm-plain+json' })],
      ['transport from', validFrame({ from: DID })],
      ['transport to', validFrame({ to: [DID] })],
      ['transport created_time', validFrame({ created_time: 1776864000 })],
      ['inherited revocationJws', inheritedRevocationJws],
      ['non-enumerable extra field', nonEnumerableOuter],
      ['symbol extra field', symbolOuter],
    ] as const

    for (const [name, frame] of malformedFrames) {
      expect(() => parseBrokerDeviceRevokeControlFrame(frame), name).toThrow()
      await expect(verifyBrokerDeviceRevokeControlFrame({
        frame,
        publicKey: didKeyToPublicKeyBytes(DID),
        crypto: cryptoAdapter,
      }), name).resolves.toEqual({
        disposition: 'rejected',
        errorCode: 'MALFORMED_MESSAGE',
      })
    }
  })

  it('maps exact inner payload-shape violations to MALFORMED_MESSAGE after JWS decoding', async () => {
    const malformedPayloadJws = await signedRevocation({
      ...vector.payload,
      trace: 'not allowed',
    })

    await expect(verifyBrokerDeviceRevokeControlFrame({
      frame: validFrame({ revocationJws: malformedPayloadJws }),
      publicKey: didKeyToPublicKeyBytes(DID),
      crypto: cryptoAdapter,
    })).resolves.toEqual({
      disposition: 'rejected',
      errorCode: 'MALFORMED_MESSAGE',
    })
  })

  it('accepts the real Ed25519 revocation signature against the payload DID identity key without mutating broker state', async () => {
    const result = await verifyBrokerDeviceRevokeControlFrame({
      frame: vector.frame,
      publicKey: didKeyToPublicKeyBytes(vector.payload.did),
      crypto: cryptoAdapter,
    })

    expect(result).toEqual({
      disposition: 'accepted',
      frame: vector.frame,
      header: vector.header,
      payload: vector.payload,
      signingBytes: new TextEncoder().encode(vector.signing_input),
      signatureBytes: decodeBase64Url(vector.signature_b64),
    })
  })

  it('rejects invalid signatures, unsupported alg, missing kid, foreign kid, and did/signer mismatch as AUTH_INVALID', async () => {
    const invalidSignatureBytes = new Uint8Array(decodeBase64Url(vector.signature_b64))
    invalidSignatureBytes[0] ^= 0xff
    const invalidSignature = `${vector.signing_input}.${encodeBase64Url(invalidSignatureBytes)}`
    const unsupportedAlg = replaceJwsHeader(vector.revocation_jws, { ...vector.header, alg: 'HS256' })
    const missingKid = replaceJwsHeader(vector.revocation_jws, { alg: 'EdDSA', typ: 'JWT' })
    const foreignKid = await signedRevocation(vector.payload, {
      ...vector.header,
      kid: 'did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH#sig-0',
    })
    const didSignerMismatch = await signedRevocation({
      ...vector.payload,
      did: 'did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH',
    }, {
      ...vector.header,
      kid: KID,
    })

    for (const [name, revocationJws] of [
      ['invalid signature', invalidSignature],
      ['unsupported alg', unsupportedAlg],
      ['missing kid', missingKid],
      ['foreign kid', foreignKid],
      ['did/signer mismatch', didSignerMismatch],
    ] as const) {
      await expect(verifyBrokerDeviceRevokeControlFrame({
        frame: validFrame({ revocationJws }),
        publicKey: didKeyToPublicKeyBytes(DID),
        crypto: cryptoAdapter,
      }), name).resolves.toEqual({
        disposition: 'rejected',
        errorCode: 'AUTH_INVALID',
      })
    }
  })
})
