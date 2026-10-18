// Recovery phrase format, taken over from apps/demo `src/lib/mnemonic-format.ts` (#279, 0b66b398,
// f39359a6): copy and paste share one convention so a round trip keeps the exact word order.
// Copy format: numbered lines `1. word` … `N. word`. The parser accepts more than the copy side
// produces (numbered lines, inline numbering, bare number tokens); safe because no BIP-39 word starts
// with a digit. Validation of words and checksum is the port's job (checkMnemonic), not this file's.

/** Copy format: numbered lines `1. word` … `N. word`. */
export function formatMnemonicForCopy(words: readonly string[] | string): string {
  const list = typeof words === 'string' ? words.trim().split(/\s+/) : words
  return list
    .filter((word) => word.length > 0)
    .map((word, i) => `${i + 1}. ${word}`)
    .join('\n')
}

/** Clean pasted words: numbering, line breaks and extra whitespace removed, lower case. */
export function cleanMnemonicInput(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .split(/[\n\r]+/)
    .map((line) => line.trim().replace(/^\d+[.):-]\s*/, ''))
    .filter((w) => w.length > 0)
    .join(' ')
    .replace(/\s+/g, ' ')
    .split(' ')
    .map((token) => token.replace(/^\d+[.):-]+/, ''))
    .filter((token) => token.length > 0 && !/^\d+$/.test(token))
    .join(' ')
}

/** Words of the cleaned input (numbering stripped), so pasted numbered text counts right. */
export function mnemonicWords(text: string): string[] {
  const cleaned = cleanMnemonicInput(text)
  return cleaned ? cleaned.split(' ') : []
}
