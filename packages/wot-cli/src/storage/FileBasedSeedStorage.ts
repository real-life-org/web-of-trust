/**
 * FileBasedSeedStorage — Encrypted mnemonic storage for Node.js
 *
 * Stores the BIP39 mnemonic (not the raw seed) encrypted with
 * PBKDF2 + AES-256-GCM in a JSON file. On load, returns the
 * mnemonic so WotIdentity.unlock() can be used directly.
 *
 * File format: { ciphertext, salt, iv } (all base64url)
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, chmodSync } from 'node:fs'
import { dirname } from 'node:path'

interface EncryptedData {
  ciphertext: string // base64url
  salt: string       // base64url (PBKDF2)
  iv: string         // base64url (AES-GCM)
}

export class FileBasedSeedStorage {
  private static readonly PBKDF2_ITERATIONS = 100_000

  constructor(private readonly filePath: string) {}

  async storeMnemonic(mnemonic: string, passphrase: string): Promise<void> {
    const salt = crypto.getRandomValues(new Uint8Array(16))
    const encryptionKey = await this.deriveKey(passphrase, salt)
    const iv = crypto.getRandomValues(new Uint8Array(12))

    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      encryptionKey,
      new TextEncoder().encode(mnemonic),
    )

    const encrypted: EncryptedData = {
      ciphertext: this.toBase64Url(new Uint8Array(ciphertext)),
      salt: this.toBase64Url(salt),
      iv: this.toBase64Url(iv),
    }

    const dir = dirname(this.filePath)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
    writeFileSync(this.filePath, JSON.stringify(encrypted, null, 2), { encoding: 'utf-8', mode: 0o600 })
    // Ensure permissions even if file existed before (umask might have been different)
    chmodSync(this.filePath, 0o600)
  }

  async loadMnemonic(passphrase: string): Promise<string> {
    if (!existsSync(this.filePath)) {
      throw new Error('No seed file found')
    }

    const encrypted: EncryptedData = JSON.parse(readFileSync(this.filePath, 'utf-8'))
    const salt = this.fromBase64Url(encrypted.salt)
    const iv = this.fromBase64Url(encrypted.iv)
    const ciphertext = this.fromBase64Url(encrypted.ciphertext)

    const encryptionKey = await this.deriveKey(passphrase, salt)

    try {
      const decrypted = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv },
        encryptionKey,
        ciphertext,
      )
      return new TextDecoder().decode(decrypted)
    } catch {
      throw new Error('Invalid passphrase')
    }
  }

  hasSeed(): boolean {
    return existsSync(this.filePath)
  }

  deleteSeed(): void {
    if (existsSync(this.filePath)) {
      unlinkSync(this.filePath)
    }
  }

  // --- Private ---

  private async deriveKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
    const keyMaterial = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(passphrase),
      'PBKDF2',
      false,
      ['deriveKey'],
    )

    return crypto.subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt,
        iterations: FileBasedSeedStorage.PBKDF2_ITERATIONS,
        hash: 'SHA-256',
      },
      keyMaterial,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    )
  }

  private toBase64Url(bytes: Uint8Array): string {
    const binary = String.fromCharCode(...bytes)
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
  }

  private fromBase64Url(b64: string): Uint8Array {
    const binary = atob(b64.replace(/-/g, '+').replace(/_/g, '/'))
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return bytes
  }
}
