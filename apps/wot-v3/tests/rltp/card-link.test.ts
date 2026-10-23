// The compact card link (architecture §5.3, decision 23.10.2026 variant iii-D32): raw deflate with a
// fixed, versioned preset dictionary, then RFC 4648 base32, so that the QR carries the payload in
// alphanumeric mode. The card object stays the same; old `#<base64url(JSON)>` links still decode.
import { describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { deflateRawSync } from 'node:zlib'
import { CARD_LINK_PREFIX, decodeCardLink, encodeCardLink } from '../../src/adapters/rltp/card-link'
import { CARD_LINK_DICTIONARIES, CARD_LINK_DICTIONARY_VERSION } from '../../src/adapters/rltp/card-link-dictionary'
import { qrPath } from '../../src/ui/components/QrCode'

/** the lib functions this test needs to make real cards; loaded like the fault-injection tests load the real lib */
type Card = Record<string, unknown>
type Events = { ok: boolean; events: readonly { type: string; card?: Card }[] }
interface LibHolder {
  show(opts: { when: number; actId: string; name: string; carrier?: unknown }): Promise<Events>
  scan(card: Card, opts: { when: number; actId: string; name: string; carrier?: unknown }): Promise<Events>
}
const { createHolder, seedKeys } = await vi.importActual<{ createHolder(ports: { store: unknown; keys: unknown }): Promise<LibHolder>; seedKeys(seed: Uint8Array): unknown }>('@real-life/trust-protocol')
const { InMemoryStore } = await vi.importActual<{ InMemoryStore: new () => unknown }>('@real-life/trust-protocol/testing')
const { deliveryHint } = await vi.importActual<{ deliveryHint(rootIkm: Uint8Array, carrier: string, nonce: Uint8Array): Promise<string> }>('@real-life/trust-protocol/adapters/vti-mediator')

const MEDIATOR = 'did:webvh:QmR5xGk8pkd3ymu7xpfkjr7XZmwDALA5ZJmgG7qcrD2mKA:webvh.storm.ws:mediator'
const WHEN = Date.parse('2026-10-23T12:54:25Z')

/** A seedable PRNG (mulberry32): the same seed gives the same cards and the same fuzz cases. */
function prng(seed: number) {
  let a = seed >>> 0
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const bytes = (n: number) => Uint8Array.from({ length: n }, () => Math.floor(next() * 256))
  const int = (n: number) => Math.floor(next() * n)
  return { next, bytes, int }
}

type Rng = ReturnType<typeof prng>

const holder = (rng: Rng) => createHolder({ store: new InMemoryStore(), keys: seedKeys(rng.bytes(32)) })
const offer = async (rng: Rng) => {
  const nonce = rng.bytes(32)
  return { nonce, deliveryHints: [await deliveryHint(rng.bytes(64), MEDIATOR, nonce)] }
}

/** Real cards of the lib: the displayed card without and with a delivery hint, and the sent card
 *  (with hint) of the scanner. Names of 12 characters, as in the measurement of 23.10. */
async function cards(seed: number) {
  const rng = prng(seed)
  const A = await holder(rng), B = await holder(rng), P = await holder(rng)
  const act = (name: string) => ({ when: WHEN, actId: `act-${seed}-${rng.int(1e9)}`, name })
  const card = (r: Events, type: string): Card => {
    const c = r.ok ? r.events.find((e) => e.type === type)?.card : undefined
    if (!c) throw new Error(type)
    return c
  }
  const plain = card(await P.show(act('Anton Tranel')), 'encounter.shown')
  const displayed = card(await A.show({ ...act('Anton Tranel'), carrier: await offer(rng) }), 'encounter.shown')
  const sent = card(await B.scan(displayed, { ...act('Bettina Kral'), carrier: await offer(rng) }), 'encounter.scanned')
  return { plain, displayed, sent }
}

const base64url = (text: string) => Buffer.from(text, 'utf8').toString('base64url')
const RFC4648 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
const base32 = (bytes: Uint8Array) => {
  let bits = 0, acc = 0, out = ''
  for (const b of bytes) {
    acc = ((acc << 8) | b) & 0xffff
    bits += 8
    while (bits >= 5) { out += RFC4648[(acc >>> (bits - 5)) & 31]; bits -= 5 }
  }
  return bits ? out + RFC4648[(acc << (5 - bits)) & 31] : out
}

describe('card link: compact form', () => {
  it('writes `https://web-of-trust.de/c#<version>:<BASE32>` and reads the same card back', async () => {
    const { plain, displayed, sent } = await cards(1)
    for (const card of [plain, displayed, sent]) {
      const link = encodeCardLink(card)
      expect(link).toMatch(new RegExp(`^https://web-of-trust\\.de/c#${CARD_LINK_DICTIONARY_VERSION}:[A-Z2-7]+$`))
      expect(decodeCardLink(link)).toEqual(card)
      // the card text is unchanged: the same JSON text before and after (transport, not content)
      expect(JSON.stringify(decodeCardLink(link))).toBe(JSON.stringify(card))
    }
  })

  it('carries the payload in alphanumeric mode: only the prefix up to `#` is a byte segment', async () => {
    const { displayed } = await cards(2)
    const link = encodeCardLink(displayed)
    expect(link.slice(CARD_LINK_PREFIX.length)).toMatch(/^[0-9A-Z$%*+\-./: ]+$/)
  })

  it('round trip: names of 0, 12 and 200 characters, eight hints of 512 characters, unicode', async () => {
    const { displayed, sent } = await cards(3)
    const rng = prng(33)
    const b58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
    const text = (n: number) => Array.from({ length: n }, () => b58[rng.int(b58.length)]).join('')
    const variants = [
      { ...displayed, name: '' },
      { ...displayed, name: 'Anton Tranel' },
      { ...displayed, name: 'Ä'.repeat(100) + text(100) },
      { ...sent, name: text(200) },
      { ...displayed, deliveryHints: Array.from({ length: 8 }, () => text(512)) },
      { ...sent, name: 'Zoë 🌱 Øre', deliveryHints: Array.from({ length: 8 }, () => text(512)) },
    ]
    for (const card of variants) expect(decodeCardLink(encodeCardLink(card))).toEqual(card)
  })

  it('still reads the old link `#<base64url(JSON)>`', async () => {
    const { displayed } = await cards(4)
    expect(decodeCardLink(CARD_LINK_PREFIX + base64url(JSON.stringify(displayed)))).toEqual(displayed)
  })

  it('an unknown dictionary version or a payload of another dictionary is no card', async () => {
    const { displayed } = await cards(5)
    const payload = encodeCardLink(displayed).slice(CARD_LINK_PREFIX.length + `${CARD_LINK_DICTIONARY_VERSION}:`.length)
    for (const v of ['0', '2', '9', '10', '01', '']) expect(decodeCardLink(`${CARD_LINK_PREFIX}${v}:${payload}`)).toBeNull()
    const other = deflateRawSync(Buffer.from(JSON.stringify(displayed)), { level: 9, dictionary: Buffer.from('{"version":"rltp-card/0.24","anchor":"did:key:z6Mk"}') })
    expect(decodeCardLink(`${CARD_LINK_PREFIX}${CARD_LINK_DICTIONARY_VERSION}:${base32(other)}`)).toBeNull()
  })

  it('refuses what is not a card: non-objects, bad base32, lower case, padding, other hosts', async () => {
    const { displayed } = await cards(6)
    const link = encodeCardLink(displayed)
    const v = `${CARD_LINK_PREFIX}${CARD_LINK_DICTIONARY_VERSION}:`
    const deflated = (text: string) => base32(deflateRawSync(Buffer.from(text), { level: 9, dictionary: Buffer.from(CARD_LINK_DICTIONARIES[CARD_LINK_DICTIONARY_VERSION]!) }))
    for (const raw of [
      v,
      v + deflated('[1,2]'),
      v + deflated('null'),
      v + deflated('"card"'),
      v + deflated('{"a":'),
      link.toLowerCase(),
      link + '=',
      link + '1',
      link.replace('https://web-of-trust.de/c#', 'https://example.org/c#'),
      link.slice(0, -3),
    ]) expect(decodeCardLink(raw)).toBeNull()
  })

  it('fuzz (seeded): the decoder never throws; it answers null or a card object', async () => {
    const { displayed, sent } = await cards(7)
    const rng = prng(7007)
    const links = [encodeCardLink(displayed), encodeCardLink(sent), CARD_LINK_PREFIX + base64url(JSON.stringify(displayed))]
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567abcxyz0189:=#-_ %/+.$*'
    let cardsSeen = 0
    for (let i = 0; i < 3000; i++) {
      const base = links[rng.int(links.length)]!
      const chars = [...base]
      const edits = 1 + rng.int(6)
      for (let e = 0; e < edits; e++) {
        const at = CARD_LINK_PREFIX.length + rng.int(chars.length - CARD_LINK_PREFIX.length)
        const op = rng.int(3)
        if (op === 0) chars[at] = alphabet[rng.int(alphabet.length)]!
        else if (op === 1) chars.splice(at, 1)
        else chars.splice(at, 0, alphabet[rng.int(alphabet.length)]!)
      }
      const raw = rng.int(10) === 0 ? `${CARD_LINK_PREFIX}${CARD_LINK_DICTIONARY_VERSION}:${base32(rng.bytes(rng.int(400)))}` : chars.join('')
      let out: unknown
      expect(() => (out = decodeCardLink(raw))).not.toThrow()
      expect(out === null || (typeof out === 'object' && !Array.isArray(out))).toBe(true)
      if (out !== null) cardsSeen++
    }
    expect(cardsSeen).toBeLessThan(3000)
  })

  it('the dictionary of a published version never changes (a change is a new version)', () => {
    const digest = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex')
    expect(Object.keys(CARD_LINK_DICTIONARIES)).toContain(CARD_LINK_DICTIONARY_VERSION)
    expect(digest(CARD_LINK_DICTIONARIES['1']!)).toBe(DICTIONARY_1_SHA256)
  })
})

describe('card link: QR size (architecture §5.3: version ≤ 15 at level M)', () => {
  // Measured over 200 seeded cards (names of 12 characters): without hint always 13, with hint always
  // 15 (deflate 319-327 bytes, version 15 holds 348), the sent card 16 in 180 and 17 in 20 cases
  // (375-387 bytes, version 16 holds 382). The bounds below are the maxima; the old link was 24 / 30 / 31.
  it('without hint at most version 13, with hint at most 15, the sent card at most 17 (old link: 24 / 30 / 31)', async () => {
    const max = { plain: 0, displayed: 0, sent: 0 }
    const before = { plain: 0, displayed: 0, sent: 0 }
    for (let seed = 11; seed < 23; seed++) {
      const c = await cards(seed)
      for (const k of ['plain', 'displayed', 'sent'] as const) {
        max[k] = Math.max(max[k], qrPath(encodeCardLink(c[k])).version)
        before[k] = Math.max(before[k], qrPath(CARD_LINK_PREFIX + base64url(JSON.stringify(c[k]))).version)
      }
    }
    expect(before).toEqual({ plain: 24, displayed: 30, sent: 31 })
    expect(max.plain).toBeLessThanOrEqual(13)
    expect(max.displayed).toBeLessThanOrEqual(15)
    expect(max.sent).toBeLessThanOrEqual(17)
  })
})

const DICTIONARY_1_SHA256 = 'facacef9c54a564c8569da0c19a9f6a945ea63a3f3a58ec69b46a60b572e14d3'
