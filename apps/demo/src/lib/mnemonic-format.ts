/**
 * Recovery-Phrase-Format: die Copy-Seite (Onboarding) und die Parse-Seite
 * (Recovery) teilen sich EINE Konvention, damit ein Roundtrip — kopieren im
 * Onboarding, einfügen in der Recovery — die exakte 12-Wort-Reihenfolge erhält.
 *
 * Copy-Format: nummerierte Zeilen `1. wort` … `12. wort`. Die Reihenfolge
 * bleibt beim Übertragen/Abschreiben prüfbar erhalten.
 *
 * Der Parser akzeptiert bewusst MEHR, als die Copy-Seite erzeugt (defensiv fürs
 * Clipboard): nummerierte Zeilen, Inline-Nummerierung (`1. wort 2. wort` in
 * EINER Zeile, z.B. wenn eine Notiz-App Umbrüche verschluckt) und nackte
 * Zahlen-Tokens. Safe, weil kein BIP39-Wort (EN wie DE) mit einer Ziffer
 * beginnt.
 */

/** Copy-Format: nummerierte Zeilen `1. wort` … `N. wort`. */
export function formatMnemonicForCopy(mnemonic: string): string {
  return mnemonic
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 0)
    .map((word, i) => `${i + 1}. ${word}`)
    .join('\n')
}

/** Clean pasted mnemonic: remove numbering (1.word, 2.word), line breaks, extra whitespace */
export function cleanMnemonicInput(text: string): string {
  return (
    text
      .trim()
      .toLowerCase()
      .split(/[\n\r]+/)
      .map((line) => line.trim().replace(/^\d+[.):-]\s*/, ''))
      .filter((w) => w.length > 0)
      .join(' ')
      .replace(/\s+/g, ' ')
      // Inline-Nummerierung („1. wort 2. wort" in EINER Zeile, z.B. wenn eine
      // Notiz-App Zeilenumbrüche verschluckt): Nummern-Tokens vor Wörtern
      // strippen. Safe, weil kein BIP39-Wort mit einer Ziffer beginnt.
      .split(' ')
      .map((token) => token.replace(/^\d+[.):-]+/, ''))
      .filter((token) => token.length > 0 && !/^\d+$/.test(token))
      .join(' ')
  )
}

/** Anzahl der Wörter im BEREINIGTEN Input (Nummerierung gestrippt). */
export function mnemonicWordCount(text: string): number {
  const cleaned = cleanMnemonicInput(text)
  return cleaned ? cleaned.split(' ').length : 0
}

/** 12 Wörter, jedes nur aus Buchstaben (a-z + Umlaute für Legacy-DE-Phrasen). */
export function isValidMnemonicFormat(cleanedText: string): boolean {
  const words = cleanedText.trim().split(/\s+/)
  return words.length === 12 && words.every((word) => /^[a-zäöü]+$/.test(word))
}
