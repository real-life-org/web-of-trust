// CodeRabbit on #421 (4330669216): the note "Not sent: …" beside the composer cuts the waiting text
// by code points, the unit of the message bound (Message Tasks 3.2), never inside a surrogate pair.
import { expect, it } from 'vitest'
import { clipText, codePoints } from '../src/hooks/messages'

it('the unsent preview is cut by code points, never inside an emoji', () => {
  const text = `${'a'.repeat(39)}😀😀 and more`
  const clipped = clipText(text, 40)
  expect(clipped).toBe(`${'a'.repeat(39)}😀…`)
  expect(clipped, 'no lone surrogate').not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/)
})

it('a text of 40 code points stays whole, though it has more UTF-16 units', () => {
  const text = '😀'.repeat(40)
  expect(codePoints(text)).toBe(40)
  expect(clipText(text, 40)).toBe(text)
})
