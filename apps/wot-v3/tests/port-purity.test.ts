// Port purity (architecture §1.2): src/port loads without DOM and without the core library, and
// exports at runtime only the store helpers and the Secret class.
// @vitest-environment node
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const portDir = path.resolve(__dirname, '../src/port')

describe('src/port', () => {
  it('imports nothing outside src/port', () => {
    for (const f of readdirSync(portDir)) {
      const src = readFileSync(path.join(portDir, f), 'utf8')
      const specifiers = [
        ...src.matchAll(/^(?:import|export)\b[^;]*?\bfrom\s*['"]([^'"]+)['"]/gm),
        ...src.matchAll(/\bimport\(\s*['"]([^'"]+)['"]/g),
        ...src.matchAll(/^import\s*['"]([^'"]+)['"]/gm),
      ]
      for (const m of specifiers) {
        expect(m[1], `${f} imports ${m[1]}`).toMatch(/^\.\/[\w-]+$/)
      }
    }
  })

  it('exports only types, store helpers and Secret at runtime', async () => {
    expect(typeof globalThis.document).toBe('undefined')
    const mod = await import('../src/port')
    expect(Object.keys(mod).sort()).toEqual(
      ['LOADING', 'SecretBox', 'deepFreeze', 'isSecret', 'ready', 'revision', 'secret', 'structuralShare', 'writableStore'].sort(),
    )
  })
})
