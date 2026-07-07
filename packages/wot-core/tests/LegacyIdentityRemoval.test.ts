import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

describe('legacy identity implementation removal', () => {
  it('does not keep the deprecated internal identity implementation', () => {
    const legacyFileName = `${'Wot'}${'Identity'}.ts`
    const testDir = dirname(fileURLToPath(import.meta.url))
    const legacyPath = resolve(testDir, '../src/identity', legacyFileName)

    expect(existsSync(legacyPath)).toBe(false)
  })
})
