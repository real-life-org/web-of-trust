import { describe, it, expect, afterEach } from 'vitest'
import { FileBasedSeedStorage } from '../src/storage/FileBasedSeedStorage.js'
import { existsSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const TEST_PATH = join(tmpdir(), `wot-test-seed-${Date.now()}.enc`)
const PASSPHRASE = 'test-passphrase-2026'
const TEST_MNEMONIC = 'kennen kontakt bogen bewirken preis aussicht besen debatte hecht gier faktor stuck'

afterEach(() => {
  if (existsSync(TEST_PATH)) unlinkSync(TEST_PATH)
})

describe('FileBasedSeedStorage', () => {
  it('stores and loads a mnemonic', async () => {
    const storage = new FileBasedSeedStorage(TEST_PATH)

    await storage.storeMnemonic(TEST_MNEMONIC, PASSPHRASE)
    expect(storage.hasSeed()).toBe(true)

    const loaded = await storage.loadMnemonic(PASSPHRASE)
    expect(loaded).toBe(TEST_MNEMONIC)
  })

  it('rejects wrong passphrase', async () => {
    const storage = new FileBasedSeedStorage(TEST_PATH)
    await storage.storeMnemonic(TEST_MNEMONIC, PASSPHRASE)

    await expect(storage.loadMnemonic('wrong-password')).rejects.toThrow('Invalid passphrase')
  })

  it('throws when no seed file exists', async () => {
    const storage = new FileBasedSeedStorage('/tmp/nonexistent-seed.enc')
    await expect(storage.loadMnemonic(PASSPHRASE)).rejects.toThrow('No seed file found')
  })

  it('reports hasSeed correctly', () => {
    const storage = new FileBasedSeedStorage('/tmp/nonexistent-seed.enc')
    expect(storage.hasSeed()).toBe(false)
  })

  it('deletes seed file', async () => {
    const storage = new FileBasedSeedStorage(TEST_PATH)
    await storage.storeMnemonic(TEST_MNEMONIC, PASSPHRASE)
    expect(storage.hasSeed()).toBe(true)

    storage.deleteSeed()
    expect(storage.hasSeed()).toBe(false)
  })

  it('preserves exact mnemonic content (12 German words)', async () => {
    const storage = new FileBasedSeedStorage(TEST_PATH)
    const mnemonic = 'bewahren einkauf alter bescheid sonne alptraum gericht salbe farn stall defekt bringen'

    await storage.storeMnemonic(mnemonic, PASSPHRASE)
    const loaded = await storage.loadMnemonic(PASSPHRASE)

    expect(loaded).toBe(mnemonic)
    expect(loaded.split(' ')).toHaveLength(12)
  })
})
