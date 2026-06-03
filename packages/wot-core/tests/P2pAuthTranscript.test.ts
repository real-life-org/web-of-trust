import * as ed25519 from '@noble/ed25519'
import { describe, expect, it } from 'vitest'
import {
  buildP2pAuthTranscript,
  createP2pAuthTranscriptBytes,
  createP2pAuthTranscriptSigningBytes,
  verifyP2pAuthTranscriptSignature,
} from '../src/protocol/sync/p2p-auth-transcript'
import type { ProtocolCryptoAdapter } from '../src/protocol'

const INITIATOR_DID = 'did:key:z6Mkinitiator'
const RESPONDER_DID = 'did:key:z6Mkresponder'
const INITIATOR_DEVICE_ID = '550e8400-e29b-41d4-a716-446655440000'
const RESPONDER_DEVICE_ID = '123e4567-e89b-42d3-a456-426614174000'
const INITIATOR_NONCE = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8'
const RESPONDER_NONCE = 'AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA'
const SHORT_NONCE = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwd'

const cryptoAdapter: Pick<ProtocolCryptoAdapter, 'verifyEd25519'> = {
  verifyEd25519(input, signature, publicKey) {
    return ed25519.verifyAsync(signature, input, publicKey)
  },
}

const initiatorSeed = new Uint8Array(32).fill(1)
const responderSeed = new Uint8Array(32).fill(2)

describe('Sync 003 P2P auth transcript', () => {
  it('creates a JCS-canonical mutual transcript and verifies role-bound Ed25519 signatures', async () => {
    const transcriptFromInitiator = buildP2pAuthTranscript({
      initiatorDid: INITIATOR_DID,
      initiatorDeviceId: INITIATOR_DEVICE_ID,
      initiatorNonce: INITIATOR_NONCE,
      responderDid: RESPONDER_DID,
      responderDeviceId: RESPONDER_DEVICE_ID,
      responderNonce: RESPONDER_NONCE,
    })
    const transcriptFromResponder = buildP2pAuthTranscript({
      responderNonce: RESPONDER_NONCE,
      responderDeviceId: RESPONDER_DEVICE_ID,
      responderDid: RESPONDER_DID,
      initiatorNonce: INITIATOR_NONCE,
      initiatorDeviceId: INITIATOR_DEVICE_ID,
      initiatorDid: INITIATOR_DID,
    })

    const transcriptBytes = createP2pAuthTranscriptBytes(transcriptFromInitiator)
    const canonicalTranscript = new TextDecoder().decode(transcriptBytes)

    expect(transcriptFromInitiator).toEqual(transcriptFromResponder)
    expect(createP2pAuthTranscriptBytes(transcriptFromInitiator)).toEqual(
      createP2pAuthTranscriptBytes(transcriptFromResponder),
    )
    expect(canonicalTranscript).toBe(
      '{"initiatorDeviceId":"550e8400-e29b-41d4-a716-446655440000","initiatorDid":"did:key:z6Mkinitiator","initiatorNonce":"AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8","protocol":"wot/p2p-auth/v1","responderDeviceId":"123e4567-e89b-42d3-a456-426614174000","responderDid":"did:key:z6Mkresponder","responderNonce":"AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA"}',
    )

    const initiatorSigningBytes = createP2pAuthTranscriptSigningBytes(transcriptFromInitiator, 'initiator')
    const responderSigningBytes = createP2pAuthTranscriptSigningBytes(transcriptFromResponder, 'responder')

    expect(new TextDecoder().decode(initiatorSigningBytes)).toContain('role:initiator')
    expect(new TextDecoder().decode(responderSigningBytes)).toContain('role:responder')

    const initiatorSignature = await ed25519.signAsync(initiatorSigningBytes, initiatorSeed)
    const responderSignature = await ed25519.signAsync(responderSigningBytes, responderSeed)
    const initiatorPublicKey = await ed25519.getPublicKeyAsync(initiatorSeed)
    const responderPublicKey = await ed25519.getPublicKeyAsync(responderSeed)

    await expect(verifyP2pAuthTranscriptSignature({
      transcript: transcriptFromResponder,
      role: 'initiator',
      signature: initiatorSignature,
      publicKey: initiatorPublicKey,
      crypto: cryptoAdapter,
    })).resolves.toBe(true)
    await expect(verifyP2pAuthTranscriptSignature({
      transcript: transcriptFromInitiator,
      role: 'responder',
      signature: responderSignature,
      publicKey: responderPublicKey,
      crypto: cryptoAdapter,
    })).resolves.toBe(true)

    await expect(verifyP2pAuthTranscriptSignature({
      transcript: transcriptFromResponder,
      role: 'responder',
      signature: initiatorSignature,
      publicKey: initiatorPublicKey,
      crypto: cryptoAdapter,
    })).resolves.toBe(false)

    const tamperedTranscript = buildP2pAuthTranscript({
      initiatorDid: INITIATOR_DID,
      initiatorDeviceId: INITIATOR_DEVICE_ID,
      initiatorNonce: INITIATOR_NONCE,
      responderDid: 'did:key:z6Mktampered',
      responderDeviceId: RESPONDER_DEVICE_ID,
      responderNonce: RESPONDER_NONCE,
    })

    await expect(verifyP2pAuthTranscriptSignature({
      transcript: tamperedTranscript,
      role: 'initiator',
      signature: initiatorSignature,
      publicKey: initiatorPublicKey,
      crypto: cryptoAdapter,
    })).resolves.toBe(false)
  })

  it('rejects nonces shorter than 32 bytes', () => {
    expect(() => buildP2pAuthTranscript({
      initiatorDid: INITIATOR_DID,
      initiatorDeviceId: INITIATOR_DEVICE_ID,
      initiatorNonce: SHORT_NONCE,
      responderDid: RESPONDER_DID,
      responderDeviceId: RESPONDER_DEVICE_ID,
      responderNonce: RESPONDER_NONCE,
    })).toThrow('Invalid p2p auth initiatorNonce length')

    expect(() => buildP2pAuthTranscript({
      initiatorDid: INITIATOR_DID,
      initiatorDeviceId: INITIATOR_DEVICE_ID,
      initiatorNonce: INITIATOR_NONCE,
      responderDid: RESPONDER_DID,
      responderDeviceId: RESPONDER_DEVICE_ID,
      responderNonce: SHORT_NONCE,
    })).toThrow('Invalid p2p auth responderNonce length')
  })
})
