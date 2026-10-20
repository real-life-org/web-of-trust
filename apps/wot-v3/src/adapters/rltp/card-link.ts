// The verification QR (architecture §5.3): `https://web-of-trust.de/c#<base64url(card JSON)>`. The
// fragment never travels in an HTTP request; the app strips it after taking it over.

export const CARD_LINK_PREFIX = 'https://web-of-trust.de/c#'

function b64url(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function unb64url(text: string): string {
  const pad = text.length % 4 === 0 ? '' : '='.repeat(4 - (text.length % 4))
  const bin = atob(text.replace(/-/g, '+').replace(/_/g, '/') + pad)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
}

export function encodeCardLink(card: unknown): string {
  return CARD_LINK_PREFIX + b64url(JSON.stringify(card))
}

/** The card object of a scanned or pasted link, or null when the text is no card link. */
export function decodeCardLink(raw: string): Record<string, unknown> | null {
  const text = raw.trim()
  if (!text.startsWith(CARD_LINK_PREFIX)) return null
  try {
    const v: unknown = JSON.parse(unb64url(text.slice(CARD_LINK_PREFIX.length)))
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}
