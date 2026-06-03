import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  assertLogEntryPayload,
  classifyLogEntryKeyDisposition,
  createJcsEd25519Jws,
  createLogEntryJws,
  encodeBase64Url,
  type JsonValue,
  verifyLogEntryJws,
} from '../src/protocol'
import { WebCryptoProtocolCryptoAdapter } from '../src/protocol-adapters'

const cryptoAdapter = new WebCryptoProtocolCryptoAdapter()
const phase1 = loadSpecVector('./fixtures/wot-spec/phase-1-interop.json')

function loadSpecVector(relativePath: string): any {
  return JSON.parse(readFileSync(new URL(relativePath, import.meta.url), 'utf8'))
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error('Invalid hex length')
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i++) bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return bytes
}

async function verifyThenClassifyWithNoKeys(jws: string): Promise<string> {
  const payload = await verifyLogEntryJws(jws, { crypto: cryptoAdapter })
  return classifyLogEntryKeyDisposition({
    keyGeneration: payload.keyGeneration,
    availableKeyGenerations: [],
  })
}

describe('log-entry validation', () => {
  it('rejects nonce plus tag-only data structurally and accepts data with ciphertext bytes', async () => {
    const signingSeed = hexToBytes(phase1.identity.ed25519_seed_hex)
    const validPayload = phase1.log_entry_jws.payload
    const ciphertextPayload = {
      ...validPayload,
      data: encodeBase64Url(new Uint8Array(29)),
    }

    for (const length of [27, 28]) {
      const tagOnlyPayload = {
        ...validPayload,
        data: encodeBase64Url(new Uint8Array(length)),
      }

      expect(() => assertLogEntryPayload(tagOnlyPayload)).toThrow('Invalid log entry data')

      const tagOnlyJws = await createJcsEd25519Jws(
        { alg: 'EdDSA', kid: tagOnlyPayload.authorKid },
        tagOnlyPayload as unknown as JsonValue,
        signingSeed,
      )
      await expect(verifyLogEntryJws(tagOnlyJws, { crypto: cryptoAdapter })).rejects.toThrow('Invalid log entry data')
      await expect(verifyThenClassifyWithNoKeys(tagOnlyJws)).rejects.toThrow('Invalid log entry data')
    }

    expect(() => assertLogEntryPayload(ciphertextPayload)).not.toThrow()
    const ciphertextJws = await createLogEntryJws({ payload: ciphertextPayload, signingSeed })
    await expect(verifyThenClassifyWithNoKeys(ciphertextJws)).resolves.toBe('blocked-by-key')
  })
})
