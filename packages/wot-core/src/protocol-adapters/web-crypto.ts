import type { ProtocolCryptoAdapter } from '../protocol/crypto/ports'

function toBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

function wrapX25519PrivateKey(rawKey: Uint8Array): Uint8Array {
  const prefix = new Uint8Array([
    0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x04, 0x22, 0x04, 0x20,
  ])
  const pkcs8 = new Uint8Array(prefix.length + rawKey.length)
  pkcs8.set(prefix)
  pkcs8.set(rawKey, prefix.length)
  return pkcs8
}

export class WebCryptoProtocolCryptoAdapter implements ProtocolCryptoAdapter {
  async verifyEd25519(input: Uint8Array, signature: Uint8Array, publicKey: Uint8Array): Promise<boolean> {
    const key = await crypto.subtle.importKey('raw', toBuffer(publicKey), { name: 'Ed25519' }, false, ['verify'])
    return crypto.subtle.verify('Ed25519', key, toBuffer(signature), toBuffer(input))
  }

  async sha256(input: Uint8Array): Promise<Uint8Array> {
    return new Uint8Array(await crypto.subtle.digest('SHA-256', toBuffer(input)))
  }

  async hkdfSha256(input: Uint8Array, info: string, length: number): Promise<Uint8Array> {
    const key = await crypto.subtle.importKey('raw', toBuffer(input), 'HKDF', false, ['deriveBits'])
    const bits = await crypto.subtle.deriveBits(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: new Uint8Array(32),
        info: new TextEncoder().encode(info),
      },
      key,
      length * 8,
    )
    return new Uint8Array(bits)
  }

  async x25519PublicFromSeed(seed: Uint8Array): Promise<Uint8Array> {
    const privateKey = await crypto.subtle.importKey('pkcs8', toBuffer(wrapX25519PrivateKey(seed)), { name: 'X25519' }, true, ['deriveBits'])
    const jwk = await crypto.subtle.exportKey('jwk', privateKey)
    if (!jwk.x) throw new Error('X25519 public key export failed')
    const binary = atob(jwk.x.replace(/-/g, '+').replace(/_/g, '/'))
    return Uint8Array.from(binary, (char) => char.charCodeAt(0))
  }

  async x25519SharedSecret(privateSeed: Uint8Array, publicKey: Uint8Array): Promise<Uint8Array> {
    const privateKey = await crypto.subtle.importKey(
      'pkcs8',
      toBuffer(wrapX25519PrivateKey(privateSeed)),
      { name: 'X25519' },
      false,
      ['deriveBits'],
    )
    const peerPublicKey = await crypto.subtle.importKey('raw', toBuffer(publicKey), { name: 'X25519' }, false, [])
    const sharedSecret = await crypto.subtle.deriveBits({ name: 'X25519', public: peerPublicKey }, privateKey, 256)
    return new Uint8Array(sharedSecret)
  }

  async aes256GcmEncrypt(key: Uint8Array, nonce: Uint8Array, plaintext: Uint8Array): Promise<Uint8Array> {
    const cryptoKey = await crypto.subtle.importKey('raw', toBuffer(key), { name: 'AES-GCM' }, false, ['encrypt'])
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: toBuffer(nonce), tagLength: 128 }, cryptoKey, toBuffer(plaintext))
    return new Uint8Array(ciphertext)
  }

  async aes256GcmDecrypt(key: Uint8Array, nonce: Uint8Array, ciphertext: Uint8Array): Promise<Uint8Array> {
    const cryptoKey = await crypto.subtle.importKey('raw', toBuffer(key), { name: 'AES-GCM' }, false, ['decrypt'])
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: toBuffer(nonce), tagLength: 128 }, cryptoKey, toBuffer(ciphertext))
    return new Uint8Array(plaintext)
  }
}
