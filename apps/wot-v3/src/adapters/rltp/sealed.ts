// AES-256-GCM sealing of JSON values under the DEK (architecture §3.1 "Speicher"): holder state and
// app-db records are stored only sealed. AAD binds a record to its database and key, so a sealed
// blob cannot be moved to another namespace or slot unnoticed.

export interface SealedBlob {
  readonly iv: Uint8Array<ArrayBuffer>
  readonly ct: Uint8Array<ArrayBuffer>
}

const enc = new TextEncoder()
const dec = new TextDecoder()

function copy(view: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(view.byteLength)
  out.set(view)
  return out
}

/** One DEK as a non-extractable AES-GCM key, imported once per session. */
export interface Sealer {
  seal(aad: string, value: unknown): Promise<SealedBlob>
  /** throws when the blob does not open under this key and AAD */
  open<T>(aad: string, blob: SealedBlob): Promise<T>
}

export async function createSealer(dek: Uint8Array, opts: { subtle?: SubtleCrypto; random?: (n: number) => Uint8Array } = {}): Promise<Sealer> {
  if (dek.length !== 32) throw new RangeError('DEK must be 32 bytes')
  const subtle = opts.subtle ?? globalThis.crypto.subtle
  const random = opts.random ?? ((n: number) => globalThis.crypto.getRandomValues(new Uint8Array(n)))
  const key = await subtle.importKey('raw', copy(dek), 'AES-GCM', false, ['encrypt', 'decrypt'])
  return {
    async seal(aad, value) {
      const iv = copy(random(12))
      const ct = await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(aad) }, key, enc.encode(JSON.stringify(value)))
      return { iv, ct: new Uint8Array(ct) }
    },
    async open<T>(aad: string, blob: SealedBlob): Promise<T> {
      const plain = await subtle.decrypt({ name: 'AES-GCM', iv: copy(blob.iv), additionalData: enc.encode(aad) }, key, copy(blob.ct))
      return JSON.parse(dec.decode(plain)) as T
    },
  }
}
