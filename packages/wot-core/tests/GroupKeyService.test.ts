import { describe, it, expect, beforeEach } from 'vitest'
import { GroupKeyService } from '../src/services/GroupKeyService'

describe('GroupKeyService', () => {
  let keyService: GroupKeyService

  beforeEach(() => {
    keyService = new GroupKeyService()
  })

  it('should create a new group key for a space', async () => {
    const key = await keyService.createKey('space-1')
    expect(key).toBeInstanceOf(Uint8Array)
    expect(key.length).toBe(32)
  })

  it('should track key generations', async () => {
    await keyService.createKey('space-1')
    const gen = keyService.getCurrentGeneration('space-1')
    expect(gen).toBe(0)
  })

  it('should retrieve current key for space', async () => {
    const created = await keyService.createKey('space-1')
    const retrieved = keyService.getCurrentKey('space-1')
    expect(retrieved).toEqual(created)
  })

  it('should retrieve key by generation (for old messages)', async () => {
    const key0 = await keyService.createKey('space-1')
    await keyService.rotateKey('space-1')

    const retrieved = keyService.getKeyByGeneration('space-1', 0)
    expect(retrieved).toEqual(key0)
  })

  it('should rotate key and increment generation', async () => {
    await keyService.createKey('space-1')
    const newKey = await keyService.rotateKey('space-1')

    expect(newKey.length).toBe(32)
    expect(keyService.getCurrentGeneration('space-1')).toBe(1)

    const current = keyService.getCurrentKey('space-1')
    expect(current).toEqual(newKey)
  })

  it('should keep old keys accessible after rotation', async () => {
    const key0 = await keyService.createKey('space-1')
    const key1 = await keyService.rotateKey('space-1')
    const key2 = await keyService.rotateKey('space-1')

    expect(keyService.getKeyByGeneration('space-1', 0)).toEqual(key0)
    expect(keyService.getKeyByGeneration('space-1', 1)).toEqual(key1)
    expect(keyService.getKeyByGeneration('space-1', 2)).toEqual(key2)
    expect(keyService.getCurrentGeneration('space-1')).toBe(2)
  })

  it('should return null for unknown space', () => {
    expect(keyService.getCurrentKey('unknown')).toBeNull()
    expect(keyService.getCurrentGeneration('unknown')).toBe(-1)
    expect(keyService.getKeyByGeneration('unknown', 0)).toBeNull()
  })

  it('should throw when rotating key for unknown space', async () => {
    await expect(keyService.rotateKey('unknown')).rejects.toThrow()
  })

  it('should manage multiple spaces independently', async () => {
    const keyA = await keyService.createKey('space-a')
    const keyB = await keyService.createKey('space-b')

    expect(keyA).not.toEqual(keyB)

    await keyService.rotateKey('space-a')
    expect(keyService.getCurrentGeneration('space-a')).toBe(1)
    expect(keyService.getCurrentGeneration('space-b')).toBe(0)
  })

  it('applies only the next key rotation generation', async () => {
    const key0 = await keyService.createKey('space-1')
    const key1 = new Uint8Array(32).fill(1)
    const key3 = new Uint8Array(32).fill(3)

    expect(keyService.importRotationKey('space-1', key3, 3)).toBe('future')
    expect(keyService.getCurrentGeneration('space-1')).toBe(0)
    expect(keyService.getCurrentKey('space-1')).toEqual(key0)
    expect(keyService.importRotationKey('space-1', key1, 1)).toBe('applied')
    expect(keyService.getCurrentGeneration('space-1')).toBe(1)
    expect(keyService.getCurrentKey('space-1')).toEqual(key1)
    expect(keyService.importRotationKey('space-1', key0, 1)).toBe('stale')
    expect(keyService.getCurrentKey('space-1')).toEqual(key1)
  })

  it('should generate different keys on each creation', async () => {
    const key1 = await keyService.createKey('space-1')
    const ks2 = new GroupKeyService()
    const key2 = await ks2.createKey('space-1')
    expect(key1).not.toEqual(key2)
  })
})
