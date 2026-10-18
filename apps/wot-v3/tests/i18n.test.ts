// German is complete by type (Translations = DeepStringify<typeof en>); this checks that every
// translation keeps the placeholders of the English source.
import { describe, expect, it } from 'vitest'
import { de } from '../src/i18n/de'
import { en } from '../src/i18n/en'

function leaves(o: object, prefix = ''): [string, string][] {
  return Object.entries(o).flatMap(([k, v]) =>
    typeof v === 'string' ? [[`${prefix}${k}`, v] as [string, string]] : leaves(v as object, `${prefix}${k}.`),
  )
}
const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort()

describe('i18n', () => {
  it('de has the same keys and placeholders as en', () => {
    const deMap = new Map(leaves(de))
    for (const [key, value] of leaves(en)) {
      expect(deMap.has(key), key).toBe(true)
      expect(placeholders(deMap.get(key) ?? ''), key).toEqual(placeholders(value))
    }
    expect(deMap.size).toBe(leaves(en).length)
  })
})
