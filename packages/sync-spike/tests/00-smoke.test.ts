import { describe, it, expect } from 'vitest'
import {
  createLogEntryJws,
  verifyLogEntryJws,
  encryptLogPayload,
  decryptLogPayload,
  decodeBase64Url,
  type LogEntryPayload,
} from '@web_of_trust/core/protocol'
import { crypto, deriveSpaceContentKey, makeAuthorFromLabel, newUuid, utf8 } from '../src/identity.js'

describe('smoke: log-entry roundtrip', () => {
  it('encrypt -> sign -> verify -> decrypt round-trips the opaque update', async () => {
    const author = await makeAuthorFromLabel('smoke')
    const deviceId = newUuid()
    const docId = newUuid()
    const keyGeneration = 0
    const seq = 0
    const spaceContentKey = await deriveSpaceContentKey(docId, keyGeneration)
    const plaintext = utf8(JSON.stringify({ key: 'name', value: 'Alice', lamport: 1 }))

    const enc = await encryptLogPayload({ crypto, spaceContentKey, deviceId, seq, plaintext })
    expect(decodeBase64Url(enc.blobBase64Url).length).toBeGreaterThan(28)

    const payload: LogEntryPayload = {
      seq,
      deviceId,
      docId,
      authorKid: author.authorKid,
      keyGeneration,
      data: enc.blobBase64Url,
      timestamp: '2026-06-22T10:00:00Z',
    }
    const jws = await createLogEntryJws({ payload, signingSeed: author.seed })
    const verified = await verifyLogEntryJws(jws, { crypto })
    expect(verified.deviceId).toBe(deviceId)
    expect(verified.authorKid).toBe(author.authorKid)

    const blob = decodeBase64Url(verified.data)
    const decrypted = await decryptLogPayload({ crypto, spaceContentKey, blob })
    expect(new TextDecoder().decode(decrypted)).toBe(new TextDecoder().decode(plaintext))
  })

  it('deterministic nonce: same (deviceId,seq) under same key reuses the nonce', async () => {
    const deviceId = newUuid()
    const docId = newUuid()
    const spaceContentKey = await deriveSpaceContentKey(docId, 0)
    const a = await encryptLogPayload({ crypto, spaceContentKey, deviceId, seq: 5, plaintext: utf8('x-payload') })
    const b = await encryptLogPayload({ crypto, spaceContentKey, deviceId, seq: 5, plaintext: utf8('y-payload') })
    // Same nonce (the hazard) but different ciphertext — exactly the reuse risk.
    expect(Array.from(a.nonce)).toEqual(Array.from(b.nonce))
  })
})
