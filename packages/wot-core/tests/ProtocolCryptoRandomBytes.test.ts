import { describe, expect, it } from 'vitest'
import { WebCryptoProtocolCryptoAdapter } from '../src/protocol-adapters'

// Sync 001 Z.103-105: OneShot payloads MUSS use a cryptographically random
// 12-byte nonce. The nonce source belongs to the crypto adapter so a caller
// can never substitute a deterministic value by mistake. These tests pin the
// contract of ProtocolCryptoAdapter.randomBytes.

const crypto = new WebCryptoProtocolCryptoAdapter()

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

describe('WebCryptoProtocolCryptoAdapter.randomBytes', () => {
  it('returns a Uint8Array of the requested length', async () => {
    const bytes = await crypto.randomBytes(12)
    expect(bytes).toBeInstanceOf(Uint8Array)
    expect(bytes.length).toBe(12)
  })

  it('produces distinct output across two calls', async () => {
    const a = await crypto.randomBytes(12)
    const b = await crypto.randomBytes(12)
    // A collision of two independent 12-byte draws is cryptographically negligible.
    expect(bytesToHex(a)).not.toBe(bytesToHex(b))
  })

  it('produces distinct output across many calls (not a fixed value)', async () => {
    const seen = new Set<string>()
    for (let i = 0; i < 32; i++) seen.add(bytesToHex(await crypto.randomBytes(12)))
    expect(seen.size).toBe(32)
  })

  it('rejects a non-positive length', async () => {
    await expect(crypto.randomBytes(0)).rejects.toThrow()
    await expect(crypto.randomBytes(-1)).rejects.toThrow()
  })

  it('rejects a non-safe-integer length', async () => {
    await expect(crypto.randomBytes(Number.NaN)).rejects.toThrow()
    await expect(crypto.randomBytes(1.5)).rejects.toThrow()
    await expect(crypto.randomBytes(Number.POSITIVE_INFINITY)).rejects.toThrow()
  })
})
