import { describe, it, expect } from 'vitest'
import {
  formatMnemonicForCopy,
  cleanMnemonicInput,
  mnemonicWordCount,
  isValidMnemonicFormat,
} from './mnemonic-format'

/**
 * #279 — Recovery-Phrase Copy/Paste-Formate absichern.
 *
 * Onboarding kopiert die Phrase als nummerierte Zeilen (`1. wort`). Die Recovery
 * muss dieses Format UND die realistischen Clipboard-Varianten (Inline-
 * Nummerierung, nackte Zahlen, plain) verlustfrei zurück in die 12-Wort-
 * Reihenfolge parsen — sonst sperrt das Word-Count-Gate den Nutzer aus oder,
 * schlimmer, eine verstümmelte Phrase leitet eine falsche Identität ab.
 */

const PHRASE =
  'ability able about above absent absorb abstract absurd abuse access accident account'
const WORDS = PHRASE.split(' ')

describe('formatMnemonicForCopy', () => {
  it('erzeugt 12 nummerierte Zeilen `1. wort` … `12. wort`', () => {
    const copied = formatMnemonicForCopy(PHRASE)
    const lines = copied.split('\n')
    expect(lines).toHaveLength(12)
    expect(lines[0]).toBe('1. ability')
    expect(lines[11]).toBe('12. account')
    lines.forEach((line, i) => {
      expect(line).toBe(`${i + 1}. ${WORDS[i]}`)
    })
  })

  it('kollabiert Mehrfach-Whitespace zwischen Wörtern', () => {
    expect(formatMnemonicForCopy('  ability   able  ')).toBe('1. ability\n2. able')
  })
})

describe('cleanMnemonicInput — vier Einfügeformate', () => {
  // Jede Variante MUSS exakt auf die kanonische Phrase zurückfallen.
  const variants: Record<string, string> = {
    'plain (unnummerierter Wortstring)': PHRASE,
    'nummerierte Zeilen (das Copy-Format)': formatMnemonicForCopy(PHRASE),
    'inline nummeriert mit Punkt + Leerzeichen':
      WORDS.map((w, i) => `${i + 1}. ${w}`).join(' '),
    'inline nummeriert mit Punkt ohne Leerzeichen':
      WORDS.map((w, i) => `${i + 1}.${w}`).join(' '),
    'nackte Zahlen-Tokens (Nummer ohne Punkt, z.B. inline ohne Trenner)':
      WORDS.map((w, i) => `${i + 1} ${w}`).join(' '),
  }

  for (const [label, input] of Object.entries(variants)) {
    it(`parst „${label}" verlustfrei`, () => {
      expect(cleanMnemonicInput(input)).toBe(PHRASE)
    })

    it(`zählt „${label}" als exakt 12 Wörter (Word-Count-Gate)`, () => {
      expect(mnemonicWordCount(input)).toBe(12)
    })

    it(`akzeptiert „${label}" als gültiges Format (Recovery-Validierung)`, () => {
      expect(isValidMnemonicFormat(cleanMnemonicInput(input))).toBe(true)
    })
  }
})

describe('Roundtrip Onboarding → Recovery', () => {
  it('cleanMnemonicInput(formatMnemonicForCopy(x)) === x', () => {
    expect(cleanMnemonicInput(formatMnemonicForCopy(PHRASE))).toBe(PHRASE)
  })

  it('erhält Groß-/Kleinschreibung normalisiert (Clipboard könnte Case ändern)', () => {
    const upper = PHRASE.toUpperCase()
    expect(cleanMnemonicInput(formatMnemonicForCopy(upper))).toBe(PHRASE)
  })

  it('trägt Legacy-Umlaut-Phrasen (DE) durch Roundtrip + Validierung', () => {
    const de = 'änderung übung öffnung apfel birne blume dorf esel feder gabel haus insel'
    expect(cleanMnemonicInput(formatMnemonicForCopy(de))).toBe(de)
    expect(isValidMnemonicFormat(cleanMnemonicInput(formatMnemonicForCopy(de)))).toBe(true)
  })
})

describe('Word-Count-Gate — Regression #278', () => {
  it('das eigene Copy-Format zählt 12, NICHT 24 (Nummern-Tokens gestrippt)', () => {
    // Ohne den Fix zählte der rohe nummerierte Text 24 „Wörter" und das
    // Next-Gate sperrte fälschlich.
    expect(mnemonicWordCount(formatMnemonicForCopy(PHRASE))).toBe(12)
  })

  it('leerer / whitespace-only Input zählt 0', () => {
    expect(mnemonicWordCount('')).toBe(0)
    expect(mnemonicWordCount('   \n  ')).toBe(0)
  })

  it('unvollständige Phrasen zählen ihre echte Wortzahl', () => {
    expect(mnemonicWordCount('ability able about')).toBe(3)
    expect(isValidMnemonicFormat('ability able about')).toBe(false)
  })
})

describe('isValidMnemonicFormat — Format-Härte', () => {
  it('lehnt Wörter mit Ziffern/Sonderzeichen ab', () => {
    const withDigit = WORDS.slice(0, 11).join(' ') + ' acc0unt'
    expect(isValidMnemonicFormat(withDigit)).toBe(false)
  })

  it('lehnt != 12 Wörter ab', () => {
    expect(isValidMnemonicFormat(WORDS.slice(0, 11).join(' '))).toBe(false)
    expect(isValidMnemonicFormat(PHRASE + ' extra')).toBe(false)
  })
})
