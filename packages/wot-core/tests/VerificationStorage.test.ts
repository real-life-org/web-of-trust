import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

describe('Trust 002 verification storage port source guard', () => {
  const testDir = path.dirname(fileURLToPath(import.meta.url))
  const repoRoot = path.resolve(testDir, '..', '..', '..')

  const read = (file: string): string => {
    const fullPath = path.join(repoRoot, file)
    if (!fs.existsSync(fullPath)) {
      throw new Error(`source guard cannot locate ${file}`)
    }
    return fs.readFileSync(fullPath, 'utf8')
  }

  it('removes legacy Trust-001 verification storage APIs from core ports and LocalStorageAdapter', () => {
    const files = [
      'packages/wot-core/src/ports/StorageAdapter.ts',
      'packages/wot-core/src/ports/ReactiveStorageAdapter.ts',
      'packages/wot-core/src/adapters/storage/LocalStorageAdapter.ts',
      'packages/wot-core/README.md',
    ] as const

    const legacyNeedles = [
      'saveVerification',
      'getReceivedVerifications',
      'getAllVerifications',
      'getVerification(',
      'watchReceivedVerifications',
      'watchAllVerifications',
      'verifications:',
      "createObjectStore('verifications')",
      "db.clear('verifications')",
    ] as const

    const hits: string[] = []

    for (const file of files) {
      const text = read(file)
      for (const needle of legacyNeedles) {
        if (text.includes(needle)) {
          hits.push(`${file}: still contains ${needle}`)
        }
      }
    }

    expect(hits).toEqual([])
  })

  it('upgrades old LocalStorageAdapter databases by deleting the legacy verification object store', () => {
    const text = read('packages/wot-core/src/adapters/storage/LocalStorageAdapter.ts')

    expect(text).toContain('const DB_VERSION = 3')
    expect(text).toContain("db.objectStoreNames.contains('verifications')")
    expect(text).toContain("db.deleteObjectStore('verifications')")
  })
})
