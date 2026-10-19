// Words ↔ root IKM, architecture §5.1 after Identity §4 (normative): English BIP-39 list, never
// localized; generation produces twelve words (128 bits); import accepts 12, 15, 18, 21 and 24; the
// root IKM is the 64-byte BIP-39 seed with an empty passphrase. Until the library offers
// `rootIkmFromMnemonic` (TODO.md), this module does it over @scure/bip39.

import { entropyToMnemonic, mnemonicToSeedSync, validateMnemonic } from '@scure/bip39'
import { wordlist } from '@scure/bip39/wordlists/english.js'
import type { EntropyPort } from '../../platform/ports'

export const VALID_LENGTHS: readonly number[] = [12, 15, 18, 21, 24]
const WORDS = new Set(wordlist)

export type WordCheck = { ok: true; length: number } | { ok: false; code: 'mnemonic-invalid' | 'mnemonic-checksum' }

/** Length and words first (mnemonic-invalid), then the checksum (mnemonic-checksum). */
export function checkWords(words: readonly string[]): WordCheck {
  if (!VALID_LENGTHS.includes(words.length)) return { ok: false, code: 'mnemonic-invalid' }
  if (!words.every((w) => WORDS.has(w))) return { ok: false, code: 'mnemonic-invalid' }
  if (!validateMnemonic(words.join(' '), wordlist)) return { ok: false, code: 'mnemonic-checksum' }
  return { ok: true, length: words.length }
}

/** Twelve words from 16 bytes of the entropy port (deterministic in tests and the harness). */
export function generateWords(entropy: EntropyPort): string[] {
  const bytes = entropy.bytes(16)
  try {
    return entropyToMnemonic(bytes, wordlist).split(' ')
  } finally {
    bytes.fill(0)
  }
}

/** The root IKM (64 bytes). Throws on a list that checkWords rejects: nothing is derived from it. */
export function rootIkmFromWords(words: readonly string[]): Uint8Array {
  const check = checkWords(words)
  if (!check.ok) throw new RangeError(check.code)
  // @scure/bip39 normalizes NFKD and uses salt "mnemonic" || passphrase, 2048 rounds of PBKDF2-HMAC-SHA512
  return mnemonicToSeedSync(words.join(' '), '')
}
