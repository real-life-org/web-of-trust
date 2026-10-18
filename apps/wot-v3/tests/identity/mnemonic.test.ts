// Words → root IKM (architecture §5.1, Identity §4). The spec vectors are read from a checked-in copy
// of trust-protocol `vectors/identity-derivation.json`, verified against its recorded checksum; the
// lengths 15 to 24 use vectors computed independently (Python hashlib, own BIP-39 encoder over the
// English list), so every accepted length is derived once.
// @vitest-environment node
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { keysFromRootIkm } from '../../src/adapters/rltp/keys'
import { checkWords, generateWords, rootIkmFromWords } from '../../src/adapters/identity/mnemonic'
import { fakeEntropy } from '../../src/platform/fake'

const dir = path.resolve(__dirname, '../vectors')
const raw = readFileSync(path.join(dir, 'identity-derivation.json'))
const source = JSON.parse(readFileSync(path.join(dir, 'identity-derivation.source.json'), 'utf8')) as { sha256: string }
const vectors = JSON.parse(raw.toString('utf8')) as {
  mnemonic: string
  passphrase: string
  rootIkm: string
  rootIkmLength: number
  badMnemonic: { mnemonic: string }
  vectors: { label: string; edInfo?: string; anchor: string; keyAgreement: string }[]
}
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex')

describe('identity-derivation vectors', () => {
  it('the checked-in copy matches its recorded checksum', () => {
    expect(createHash('sha256').update(raw).digest('hex')).toBe(source.sha256)
  })

  it('derives the 64-byte root IKM of the spec mnemonic with an empty passphrase', () => {
    expect(vectors.passphrase).toBe('')
    const ikm = rootIkmFromWords(vectors.mnemonic.split(' '))
    expect(ikm.length).toBe(vectors.rootIkmLength)
    expect(hex(ikm)).toBe(vectors.rootIkm)
  })

  it('the root IKM goes unchanged into the library (adapters/rltp) and yields the spec anchors', async () => {
    const keys = keysFromRootIkm(rootIkmFromWords(vectors.mnemonic.split(' ')))
    const group = vectors.vectors.find((v) => v.label.startsWith('group/') && !v.label.slice(6).includes('/'))
    expect(group).toBeDefined()
    if (!group) return
    expect(await keys.anchorOf(group.label)).toEqual({ anchor: group.anchor, keyAgreement: group.keyAgreement })
  })

  it('rejects the bad-checksum mnemonic before any derivation', () => {
    expect(checkWords(vectors.badMnemonic.mnemonic.split(' '))).toEqual({ ok: false, code: 'mnemonic-checksum' })
    expect(() => rootIkmFromWords(vectors.badMnemonic.mnemonic.split(' '))).toThrow()
  })
})

// Independently computed (Python): entropy → words with the SHA-256 checksum, seed = PBKDF2-HMAC-SHA512(NFKD(words), "mnemonic", 2048).
const LENGTHS: [number, string, string][] = [
  [
    12,
    'awake print paper end page another thumb raccoon pond guide easily isolate',
    'e64168d9d329d5bb8605ed55822a60f884adc24ac47ef5a2d455947e087ddf5b33ce16fbe2fb9c3d3966c1b8ec68301f5a972521a0c0f467c752a54359ca475c',
  ],
  [
    15,
    'before slab path face tennis argue various cotton profit marble educate learn embrace student excess',
    '5336d8e4fad740ca993648166ac9ec4d39c3949f8ef4eeb0809e516ec052f60db650669fc406b2727804abcc191629d7fa5f2d794283f6bd39fb8548c55b4433',
  ],
  [
    18,
    'blouse twelve peanut fluid buyer asset account rally quit pond elegant man match sunny garment loud edit front',
    'e2c4deb0735b9ed2a5101e96d43b3d2f0a9f0d372c60883fb1dd239ef94e0d75592d497c55aff2ff231336506cc46eec8258bee17c2c07aefd016d9934950062',
  ],
  [
    21,
    'brisk arctic pepper giant garden autumn balance crack record side embrace mom simple swarm hire again engine lake common rose crawl',
    'f82d5993f241b1a678649e7a4dce81560369e61995e9384aa3758a820a06922fa87d31c9c86006ca2a2878f39b6bdbc8f7a2837a74e372e330079ab8522a16cf',
  ],
  [
    24,
    'cake clip physical have paper balance canvas rather result theme end notice announce talent lab lunch example orphan control series index chunk surprise high',
    'd750fbdc57f5096606d39e0cc00b297c3f3341133ed6cf676b0140720f94463060e237a101ed77624574c6bac495cbc779863303ceeb71824931ef349026bbc2',
  ],
]

describe('every valid BIP-39 length (Identity §4: import accepts 12, 15, 18, 21, 24)', () => {
  it.each(LENGTHS)('%i words', (n, words, seed) => {
    const list = words.split(' ')
    expect(checkWords(list)).toEqual({ ok: true, length: n })
    expect(hex(rootIkmFromWords(list))).toBe(seed)
  })

  it('rejects other lengths, unknown words and non-English lists', () => {
    expect(checkWords(LENGTHS[0]?.[1].split(' ').slice(0, 11) ?? [])).toEqual({ ok: false, code: 'mnemonic-invalid' })
    expect(checkWords([...(LENGTHS[0]?.[1].split(' ').slice(0, 11) ?? []), 'notaword'])).toEqual({ ok: false, code: 'mnemonic-invalid' })
    // German BIP-39 words are not accepted: one list, never localized
    expect(checkWords('abend abend abend abend abend abend abend abend abend abend abend abend'.split(' '))).toEqual({
      ok: false,
      code: 'mnemonic-invalid',
    })
  })
})

describe('generation', () => {
  it('produces twelve valid English words from the entropy port', () => {
    const words = generateWords(fakeEntropy(42))
    expect(words).toHaveLength(12)
    expect(checkWords(words)).toEqual({ ok: true, length: 12 })
    expect(generateWords(fakeEntropy(42))).toEqual(words)
    expect(generateWords(fakeEntropy(43))).not.toEqual(words)
  })
})
