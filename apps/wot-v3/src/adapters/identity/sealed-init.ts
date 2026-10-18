// Initialization inputs (architecture §4.2, N7): what an interrupted setup needs to continue but is
// not a secret (name, image, terms version, the actIds of setProfile and acceptTerms). AES-256-GCM
// under the DEK with AAD = ns; readable only after unlocking. The words never go in here.

import type { EntropyPort, SealedInit } from '../../platform/ports'

export interface InitInputs {
  readonly flow: 'setup' | 'restore'
  readonly profile: { readonly name: string; readonly image?: string } | null
  readonly termsVersion: string | null
  readonly actIds: { readonly setProfile: string; readonly acceptTerms: string }
}

const enc = new TextEncoder()

function b64(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}

function unb64(text: string): Uint8Array<ArrayBuffer> {
  const bin = atob(text)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

function copy(view: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(view.byteLength)
  out.set(view)
  return out
}

async function key(subtle: SubtleCrypto, dek: Uint8Array, usage: KeyUsage): Promise<CryptoKey> {
  return subtle.importKey('raw', copy(dek), 'AES-GCM', false, [usage])
}

export async function sealInit(
  subtle: SubtleCrypto,
  entropy: EntropyPort,
  dek: Uint8Array,
  ns: string,
  inputs: InitInputs,
): Promise<SealedInit> {
  const iv = entropy.bytes(12)
  const ct = await subtle.encrypt(
    { name: 'AES-GCM', iv: copy(iv), additionalData: enc.encode(ns) },
    await key(subtle, dek, 'encrypt'),
    enc.encode(JSON.stringify(inputs)),
  )
  return { iv: b64(iv), ct: b64(new Uint8Array(ct)) }
}

/** null when the record does not open under this DEK and ns. */
export async function openInit(subtle: SubtleCrypto, dek: Uint8Array, ns: string, sealed: SealedInit): Promise<InitInputs | null> {
  try {
    const plain = await subtle.decrypt(
      { name: 'AES-GCM', iv: unb64(sealed.iv), additionalData: enc.encode(ns) },
      await key(subtle, dek, 'decrypt'),
      unb64(sealed.ct),
    )
    return JSON.parse(new TextDecoder().decode(plain)) as InitInputs
  } catch {
    return null
  }
}
