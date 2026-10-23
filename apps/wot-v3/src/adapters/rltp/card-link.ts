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
// fflate is imported here and nowhere else (boundary rule card-link-only-fflate): the web's
// DecompressionStream has no preset dictionary.
import { deflateSync, inflateSync } from 'fflate'
import { CARD_LINK_DICTIONARIES, CARD_LINK_DICTIONARY_VERSION } from './card-link-dictionary'

export const CARD_LINK_PREFIX = 'https://web-of-trust.de/c#'

// The largest card the lib signs (eight hints of 512 characters, a long name) compresses to a few
// kilobytes; a payload beyond this is no card, and the bound keeps inflate from expanding a pasted
// text without end (deflate expands at most about 1:1032).
const MAX_PAYLOAD = 16_384
const MAX_CARD_BYTES = 65_536

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
  return deflated ? inflateSync(deflated, { dictionary }) : null
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
