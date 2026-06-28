/**
 * Benchmarks for encryptOneShot/decryptOneShot — AES-256-GCM encrypt/decrypt performance.
 *
 * Measures throughput at various payload sizes to understand the crypto cost
 * in our sync pipeline. Inspired by secsync benchmarks (secsync.com/docs/benchmarks).
 */
import { bench, describe, beforeAll } from 'vitest'
import { encryptOneShot, decryptOneShot } from '../src/protocol'
import { WebCryptoProtocolCryptoAdapter } from '../src/adapters/protocol-crypto'

const cryptoAdapter = new WebCryptoProtocolCryptoAdapter()
let groupKey: Uint8Array

/** Fill a Uint8Array with pseudo-random data (avoids crypto.getRandomValues 64KB limit) */
function fillRandom(size: number): Uint8Array {
  const buf = new Uint8Array(size)
  const chunk = 65_536
  for (let offset = 0; offset < size; offset += chunk) {
    const len = Math.min(chunk, size - offset)
    crypto.getRandomValues(buf.subarray(offset, offset + len))
  }
  return buf
}

// Payloads of different sizes (simulating CRDT updates of varying doc complexity)
const payloads: Record<string, Uint8Array> = {}
const sizes = {
  '1 KB': 1_024,
  '10 KB': 10_240,
  '100 KB': 102_400,
  '1 MB': 1_048_576,
  '5 MB': 5_242_880,
}

beforeAll(() => {
  groupKey = crypto.getRandomValues(new Uint8Array(32))
  for (const [label, size] of Object.entries(sizes)) {
    payloads[label] = fillRandom(size)
  }
})

describe('encryptOneShot', () => {
  for (const [label] of Object.entries(sizes)) {
    bench(`encrypt ${label}`, async () => {
      await encryptOneShot({ crypto: cryptoAdapter, spaceContentKey: groupKey, plaintext: payloads[label] })
    })
  }
})

describe('decryptOneShot', () => {
  const encrypted: Record<string, Awaited<ReturnType<typeof encryptOneShot>>> = {}

  beforeAll(async () => {
    for (const [label] of Object.entries(sizes)) {
      encrypted[label] = await encryptOneShot({ crypto: cryptoAdapter, spaceContentKey: groupKey, plaintext: payloads[label] })
    }
  })

  for (const [label] of Object.entries(sizes)) {
    bench(`decrypt ${label}`, async () => {
      await decryptOneShot({ crypto: cryptoAdapter, spaceContentKey: groupKey, blob: encrypted[label].blob })
    })
  }
})

describe('OneShot roundtrip (encrypt + decrypt)', () => {
  for (const [label] of Object.entries(sizes)) {
    bench(`roundtrip ${label}`, async () => {
      const enc = await encryptOneShot({ crypto: cryptoAdapter, spaceContentKey: groupKey, plaintext: payloads[label] })
      await decryptOneShot({ crypto: cryptoAdapter, spaceContentKey: groupKey, blob: enc.blob })
    })
  }
})
