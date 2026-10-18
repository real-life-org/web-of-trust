// Taken over from apps/demo src/lib/mnemonic-format.test.ts (#279): the four paste formats and the
// copy → paste round trip. The format check moved to the port (checkMnemonic, all BIP-39 lengths).
import { describe, expect, it } from 'vitest'
import { cleanMnemonicInput, formatMnemonicForCopy, mnemonicWords } from '../src/lib/mnemonic-format'

const PHRASE = 'ability able about above absent absorb abstract absurd abuse access accident account'
const WORDS = PHRASE.split(' ')

describe('formatMnemonicForCopy', () => {
  it('produces numbered lines `1. word` … `12. word`', () => {
    const lines = formatMnemonicForCopy(WORDS).split('\n')
    expect(lines).toHaveLength(12)
    lines.forEach((line, i) => expect(line).toBe(`${i + 1}. ${WORDS[i]}`))
  })

  it('collapses extra whitespace', () => {
    expect(formatMnemonicForCopy('  ability   able  ')).toBe('1. ability\n2. able')
  })
})

describe('cleanMnemonicInput: paste formats', () => {
  const variants: Record<string, string> = {
    plain: PHRASE,
    'numbered lines (the copy format)': formatMnemonicForCopy(PHRASE),
    'inline numbered with dot and space': WORDS.map((w, i) => `${i + 1}. ${w}`).join(' '),
    'inline numbered with dot, no space': WORDS.map((w, i) => `${i + 1}.${w}`).join(' '),
    'bare number tokens': WORDS.map((w, i) => `${i + 1} ${w}`).join(' '),
  }
  for (const [label, input] of Object.entries(variants)) {
    it(`parses ${label} without loss and counts 12 words`, () => {
      expect(cleanMnemonicInput(input)).toBe(PHRASE)
      expect(mnemonicWords(input)).toHaveLength(12)
    })
  }

  it('round trip copy → paste keeps the order, case normalized', () => {
    expect(cleanMnemonicInput(formatMnemonicForCopy(PHRASE.toUpperCase()))).toBe(PHRASE)
  })

  it('counts 24 pasted numbered words as 24, not 48', () => {
    const twentyFour = [...WORDS, ...WORDS]
    expect(mnemonicWords(formatMnemonicForCopy(twentyFour))).toHaveLength(24)
  })
})
