// The verification QR (architecture §5.3). The link the app writes:
//
//   https://web-of-trust.de/c#<v>:<BASE32(deflate-raw(card JSON, dictionary v))>
//
// `v` is the version of the preset dictionary (card-link-dictionary.ts), BASE32 is RFC 4648 in upper
// case without padding. Everything after `#` lies in the QR alphanumeric set, so the QR library puts
// the prefix into one byte segment and the payload into an alphanumeric one (5.5 bits a character
// instead of 8). The card itself is unchanged: the link is transport, the decoder hands back the same
// object, and its proof is checked as before. Links of the first form, `#<base64url(card JSON)>`, are
// still read; base64url never contains `:`, so both forms are told apart by the fragment alone.
// The fragment never travels in an HTTP request; the app strips it after taking it over.
//
// fflate is imported here and nowhere else (boundary rule fflate-only-in-card-link): the web's
// DecompressionStream has no preset dictionary.
import { deflateSync, inflateSync } from 'fflate'
import { CARD_LINK_DICTIONARIES, CARD_LINK_DICTIONARY_VERSION } from './card-link-dictionary'

export const CARD_LINK_PREFIX = 'https://web-of-trust.de/c#'

/** The largest card JSON the lib accepts (Encounter RLTP-ENC-6090, contact-card schema, card wire 0.25):
 *  every field is bounded, the schema states the maximum as 26 683 bytes. It is reached with the free
 *  text at its escaping maximum: name 200 and eight hints of 512 code points, each a C0 control character
 *  written as `\u00XX` (6 bytes; a 4-byte UTF-8 character or an escaped lone surrogate costs no more),
 *  plus the fixed fields at their maxima (anchor and sentTo 56, keyAgreement 48, challenge and boundTo
 *  88, two timestamps of 24, verificationMethod 105, proofValue 89, the constants and the punctuation).
 *  JSON.stringify writes the same escapes as JCS, so the link's JSON has the same maximum. A test builds
 *  this card and checks the number. Inflate writes into MAX_CARD_BYTES + 1 bytes and stops there. */
export const MAX_CARD_BYTES = 26_683

/** The longest deflate stream the encoder can write for a card of MAX_CARD_BYTES. fflate takes the
 *  cheaper of the fixed and the dynamic Huffman code for each block (and a stored block where it may), so
 *  a block costs at most its fixed-code length: 9 bits for a literal (8 or 9 in the fixed code), a match
 *  at most 25 bits for 3 bytes and 31 bits for 4 or more (under 9 bits a byte), 3 bits of header and 7
 *  of end-of-block. fflate closes a block only after more than 7000 literals or 24 576 symbols, so there
 *  are at most ceil(N / 7000) + 1 blocks:
 *  ceil((9 N + 10 (ceil(N / 7000) + 1)) / 8) = ceil((240 147 + 50) / 8) = 30 025 bytes. */
const MAX_DEFLATED_BYTES = Math.ceil((9 * MAX_CARD_BYTES + 10 * (Math.ceil(MAX_CARD_BYTES / 7000) + 1)) / 8)

/** The longest payload the decoder takes: base32 of MAX_DEFLATED_BYTES (8 bits in 5-bit characters),
 *  48 040 characters. Every link the encoder writes for a card the lib accepts is at most this long; a
 *  longer text is no card link and is refused before inflate. */
export const MAX_PAYLOAD = Math.ceil((MAX_DEFLATED_BYTES * 8) / 5)

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
const COMPACT = /^(0|[1-9][0-9]*):([A-Z2-7]*)$/

const utf8 = new TextEncoder()
const dictionaries = new Map(Object.entries(CARD_LINK_DICTIONARIES).map(([v, text]) => [v, utf8.encode(text)]))

function base32(bytes: Uint8Array): string {
  let out = ''
  let acc = 0
  let bits = 0
  for (const b of bytes) {
    acc = ((acc << 8) | b) & 0xffff
    bits += 8
    while (bits >= 5) {
      out += BASE32[(acc >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  return bits > 0 ? out + BASE32[(acc << (5 - bits)) & 31] : out
}

/** The bytes of canonical unpadded base32, or null (a length no byte count gives, or set pad bits). */
function unbase32(text: string): Uint8Array | null {
  if ([1, 3, 6].includes(text.length % 8)) return null
  const out = new Uint8Array(Math.floor((text.length * 5) / 8))
  let acc = 0
  let bits = 0
  let i = 0
  for (const ch of text) {
    acc = ((acc << 5) | BASE32.indexOf(ch)) & 0xffff
    bits += 5
    if (bits >= 8) {
      out[i++] = (acc >>> (bits - 8)) & 0xff
      bits -= 8
    }
  }
  return (acc & ((1 << bits) - 1)) === 0 ? out : null
}

function unb64url(text: string): Uint8Array {
  const pad = text.length % 4 === 0 ? '' : '='.repeat(4 - (text.length % 4))
  const bin = atob(text.replace(/-/g, '+').replace(/_/g, '/') + pad)
  return Uint8Array.from(bin, (c) => c.charCodeAt(0))
}

/** The card JSON of the fragment, or null when the fragment is neither form. Throws on broken data. */
function cardBytes(fragment: string): Uint8Array | null {
  const compact = COMPACT.exec(fragment)
  if (!compact) return /^[A-Za-z0-9_-]+$/.test(fragment) ? unb64url(fragment) : null
  const dictionary = dictionaries.get(compact[1]!)
  const payload = compact[2]!
  if (!dictionary || payload.length === 0 || payload.length > MAX_PAYLOAD) return null
  const deflated = unbase32(payload)
  // inflate into a fixed buffer one byte larger than a card may be: fflate stops there, so a payload
  // that expands further allocates no more and is refused by the length check of decodeCardLink
  return deflated ? inflateSync(deflated, { dictionary, out: new Uint8Array(MAX_CARD_BYTES + 1) }) : null
}

export function encodeCardLink(card: unknown): string {
  const deflated = deflateSync(utf8.encode(JSON.stringify(card)), { level: 9, dictionary: dictionaries.get(CARD_LINK_DICTIONARY_VERSION)! })
  return `${CARD_LINK_PREFIX}${CARD_LINK_DICTIONARY_VERSION}:${base32(deflated)}`
}

/** The card object of a scanned or pasted link, or null when the text is no card link. */
export function decodeCardLink(raw: string): Record<string, unknown> | null {
  const text = raw.trim()
  if (!text.startsWith(CARD_LINK_PREFIX)) return null
  try {
    const bytes = cardBytes(text.slice(CARD_LINK_PREFIX.length))
    if (!bytes || bytes.length > MAX_CARD_BYTES) return null
    const v: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}
