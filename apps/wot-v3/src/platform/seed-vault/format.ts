// Vault format, architecture §5.2. Pure functions over WebCrypto; no storage.
//
// Two derivations that share nothing: BIP-39 (words → root IKM, PBKDF2-HMAC-SHA-512, 2048 rounds, in
// adapters/identity/mnemonic.ts) and this one (password → AES-256-GCM key, PBKDF2-HMAC-SHA-256,
// 600 000 rounds in format version 1, 16-byte salt per write). The head is unencrypted but bound as
// AAD in its JCS form: changing `protection` or `kdf` makes opening impossible, so lowering the
// rounds cannot slip through silently.

import type { ProtectionMode, VaultHead } from '../ports'

export const VAULT_FORMAT = 'wot-v3-vault'
export const VAULT_VERSION = 1
/** Target rounds of format version 1 (architecture §5.2; measured on the slowest test device before release). */
export const TARGET_ITERATIONS = 600_000
export const ROOT_IKM_BYTES = 64
export const DEK_BYTES = 32

export interface VaultRecord {
  readonly head: VaultHead
  /** base64url, 12 bytes, new per write */
  readonly iv: string
  /** AES-256-GCM(payload) with the 16-byte tag appended, base64url */
  readonly ct: string
}

export interface VaultPayload {
  readonly rootIkm: Uint8Array
  readonly dek: Uint8Array
}

// ── encoding ────────────────────────────────────────────────────────────────

export function b64url(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function fromB64url(text: string): Uint8Array {
  const pad = text.length % 4 === 0 ? '' : '='.repeat(4 - (text.length % 4))
  const bin = atob(text.replace(/-/g, '+').replace(/_/g, '/') + pad)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** JSON Canonicalization Scheme (RFC 8785) for the value shapes used here: objects, arrays,
 *  strings, safe integers, booleans, null. Anything else is a programming error. */
export function jcs(value: unknown): string {
  if (value === null || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new TypeError('jcs: only safe integers')
    return JSON.stringify(value)
  }
  if (typeof value === 'string') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(jcs).join(',')}]`
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${jcs(v)}`).join(',')}}`
  }
  throw new TypeError(`jcs: unsupported ${typeof value}`)
}

const utf8 = new TextEncoder()

/** Copy into a fresh ArrayBuffer-backed view (WebCrypto rejects SharedArrayBuffer views). */
function bytes(view: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(view.byteLength)
  out.set(view)
  return out
}

// ── classification ──────────────────────────────────────────────────────────

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** 'v3' for a record this version can open; 'unsupported' for a foreign or newer format
 *  (legacy `wot.identity.seed` included). */
export function classify(record: unknown): 'v3' | 'unsupported' {
  if (!isObject(record) || !isObject(record.head)) return 'unsupported'
  const h = record.head
  if (h.format !== VAULT_FORMAT || h.v !== VAULT_VERSION) return 'unsupported'
  if (h.aead !== 'AES-256-GCM' || !isObject(h.kdf) || h.kdf.alg !== 'PBKDF2-SHA-256') return 'unsupported'
  if (typeof record.iv !== 'string' || typeof record.ct !== 'string') return 'unsupported'
  return 'v3'
}

// ── seal and open ───────────────────────────────────────────────────────────

async function deriveKey(subtle: SubtleCrypto, password: Uint8Array, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const base = await subtle.importKey('raw', bytes(password), 'PBKDF2', false, ['deriveKey'])
  return subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: bytes(salt), iterations },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

export interface SealInput {
  readonly ns: string
  readonly protection: ProtectionMode
  readonly iterations: number
  readonly createdAt: number
  readonly updatedAt: number
  /** 16 random bytes, new per write */
  readonly salt: Uint8Array
  /** 12 random bytes, new per write */
  readonly iv: Uint8Array
  readonly password: Uint8Array
  readonly payload: VaultPayload
}

export async function seal(subtle: SubtleCrypto, input: SealInput): Promise<VaultRecord> {
  if (input.payload.rootIkm.length !== ROOT_IKM_BYTES || input.payload.dek.length !== DEK_BYTES) {
    throw new RangeError('vault payload: root IKM must be 64 bytes, DEK 32 bytes')
  }
  if (input.salt.length !== 16 || input.iv.length !== 12) throw new RangeError('vault: salt 16 bytes, IV 12 bytes')
  const head: VaultHead = {
    format: VAULT_FORMAT,
    v: VAULT_VERSION,
    ns: input.ns,
    protection: input.protection,
    kdf: { alg: 'PBKDF2-SHA-256', iterations: input.iterations, salt: b64url(input.salt) },
    aead: 'AES-256-GCM',
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
  }
  const key = await deriveKey(subtle, input.password, input.salt, input.iterations)
  const plain = utf8.encode(
    jcs({ rootIkm: b64url(input.payload.rootIkm), dek: b64url(input.payload.dek), seedFormat: 'bip39-64-byte' }),
  )
  try {
    const ct = await subtle.encrypt(
      { name: 'AES-GCM', iv: bytes(input.iv), additionalData: utf8.encode(jcs(head)), tagLength: 128 },
      key,
      plain,
    )
    return { head, iv: b64url(input.iv), ct: b64url(new Uint8Array(ct)) }
  } finally {
    plain.fill(0)
  }
}

/** null = wrong password, tampered head or record, or a payload of the wrong shape. */
export async function open(subtle: SubtleCrypto, record: VaultRecord, password: Uint8Array): Promise<VaultPayload | null> {
  if (classify(record) !== 'v3') return null
  const { head } = record
  let plain: Uint8Array
  try {
    const key = await deriveKey(subtle, password, fromB64url(head.kdf.salt), head.kdf.iterations)
    plain = new Uint8Array(
      await subtle.decrypt(
        { name: 'AES-GCM', iv: bytes(fromB64url(record.iv)), additionalData: utf8.encode(jcs(head)), tagLength: 128 },
        key,
        bytes(fromB64url(record.ct)),
      ),
    )
  } catch {
    return null
  }
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(plain))
    if (!isObject(parsed) || parsed.seedFormat !== 'bip39-64-byte') return null
    if (typeof parsed.rootIkm !== 'string' || typeof parsed.dek !== 'string') return null
    const rootIkm = fromB64url(parsed.rootIkm)
    const dek = fromB64url(parsed.dek)
    if (rootIkm.length !== ROOT_IKM_BYTES || dek.length !== DEK_BYTES) return null
    return { rootIkm, dek }
  } catch {
    return null
  } finally {
    plain.fill(0)
  }
}
