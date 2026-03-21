// Base58 alphabet (Bitcoin style, no 0, O, I, l)
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

export function encodeBase58(bytes: Uint8Array): string {
  const digits = [0]
  for (const byte of bytes) {
    let carry = byte
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i] << 8
      digits[i] = carry % 58
      carry = (carry / 58) | 0
    }
    while (carry > 0) {
      digits.push(carry % 58)
      carry = (carry / 58) | 0
    }
  }
  // Handle leading zeros
  let output = ''
  for (const byte of bytes) {
    if (byte === 0) output += BASE58_ALPHABET[0]
    else break
  }
  // Convert digits to string (reverse order)
  for (let i = digits.length - 1; i >= 0; i--) {
    output += BASE58_ALPHABET[digits[i]]
  }
  return output
}

export function decodeBase58(str: string): Uint8Array {
  const bytes = [0]
  for (const char of str) {
    const value = BASE58_ALPHABET.indexOf(char)
    if (value < 0) throw new Error(`Invalid base58 character: ${char}`)
    let carry = value
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i] * 58
      bytes[i] = carry & 0xff
      carry >>= 8
    }
    while (carry > 0) {
      bytes.push(carry & 0xff)
      carry >>= 8
    }
  }
  // Handle leading '1's (zeros)
  for (const char of str) {
    if (char === BASE58_ALPHABET[0]) bytes.push(0)
    else break
  }
  return new Uint8Array(bytes.reverse())
}

export function encodeBase64Url(bytes: Uint8Array): string {
  // Build binary string in chunks to avoid stack overflow from spread operator
  // (Safari/WebKit has a low limit on Function.apply arguments)
  let binary = ''
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function decodeBase64Url(str: string): Uint8Array {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/')
  const padding = (4 - (padded.length % 4)) % 4
  const base64 = padded + '='.repeat(padding)
  const binary = atob(base64)
  return Uint8Array.from(binary, (c) => c.charCodeAt(0))
}

/** Convert Uint8Array to ArrayBuffer slice (workaround for TypeScript strict mode with Web Crypto). */
export function toBuffer(arr: Uint8Array): ArrayBuffer {
  return arr.buffer.slice(arr.byteOffset, arr.byteOffset + arr.byteLength) as ArrayBuffer
}
