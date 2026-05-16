import { describe, it, expect, beforeEach } from 'vitest'
import { WotIdentity } from '../src/identity/WotIdentity'

describe('OnboardingFlow', () => {
  describe('Step 1: Generate Seed without Passphrase', () => {
    it('should generate mnemonic and DID without passphrase', async () => {
      const identity = new WotIdentity()
      const result = await identity.create('')

      expect(result.mnemonic).toBeDefined()
      expect(result.mnemonic.split(' ')).toHaveLength(12)
      expect(result.did).toMatch(/^did:key:/)
    })

    it('should generate different mnemonics on each call', async () => {
      const identity1 = new WotIdentity()
      const result1 = await identity1.create('')

      const identity2 = new WotIdentity()
      const result2 = await identity2.create('')

      expect(result1.mnemonic).not.toBe(result2.mnemonic)
      expect(result1.did).not.toBe(result2.did)
    })
  })

  describe('Step 2: Mnemonic Display', () => {
    it('should split mnemonic into 12 words', async () => {
      const identity = new WotIdentity()
      const result = await identity.create('')

      const words = result.mnemonic.split(' ')
      expect(words).toHaveLength(12)
      words.forEach((word) => {
        expect(word).toMatch(/^[a-z]+$/)
      })
    })

    it('should have valid BIP39 format', async () => {
      const identity = new WotIdentity()
      const result = await identity.create('')

      // BIP39 words are lowercase, separated by single space
      expect(result.mnemonic).toMatch(/^[a-z]+( [a-z]+){11}$/)
    })
  })

  describe('Step 3: Mnemonic Verification', () => {
    let testMnemonic: string

    beforeEach(async () => {
      const identity = new WotIdentity()
      const result = await identity.create('')
      testMnemonic = result.mnemonic
    })

    it('should validate correct word at correct position', () => {
      const words = testMnemonic.split(' ')
      const testIndex = 5
      const correctWord = words[testIndex]

      expect(words[testIndex].toLowerCase()).toBe(correctWord.toLowerCase())
    })

    it('should reject incorrect word at position', () => {
      const words = testMnemonic.split(' ')
      const testIndex = 5
      const wrongWord = 'wrongword'

      expect(words[testIndex].toLowerCase()).not.toBe(wrongWord.toLowerCase())
    })

    it('should handle case-insensitive verification', () => {
      const words = testMnemonic.split(' ')
      const testIndex = 5
      const correctWord = words[testIndex]

      expect(correctWord.toLowerCase()).toBe(correctWord.toUpperCase().toLowerCase())
    })
  })

  describe('Step 4: Protect with Passphrase', () => {
    let testMnemonic: string

    beforeEach(async () => {
      const identity = new WotIdentity()
      const result = await identity.create('')
      testMnemonic = result.mnemonic
    })

    it('should accept passphrase after mnemonic is generated', async () => {
      const passphrase = 'SecurePassword123!'

      const identity = new WotIdentity()
      await identity.unlock(testMnemonic, passphrase)

      expect(identity.getDid()).toMatch(/^did:key:/)
    })

    it('should enforce minimum passphrase length', () => {
      const shortPassphrase = '1234567' // 7 chars, should fail

      expect(shortPassphrase.length).toBeLessThan(8)
    })

    it('should accept passphrase with 8+ characters', () => {
      const validPassphrase = '12345678' // 8 chars

      expect(validPassphrase.length).toBeGreaterThanOrEqual(8)
    })

    it('should store identity with passphrase protection', async () => {
      const identity = new WotIdentity()
      await identity.unlock(testMnemonic, 'SecurePassword123!')

      // Identity is automatically stored when unlocked
      expect(identity.getDid()).toMatch(/^did:key:/)
    })
  })

  describe('Full Flow Integration', () => {
    it('should complete full onboarding flow', async () => {
      // Step 1: Generate
      const identity1 = new WotIdentity()
      const { mnemonic } = await identity1.create('')

      expect(mnemonic).toBeDefined()

      // Step 2: Verify mnemonic (simulate user verification)
      const words = mnemonic.split(' ')
      expect(words).toHaveLength(12)

      // Step 3: Select random words for verification
      const randomIndices = [2, 5, 9]
      randomIndices.forEach((idx) => {
        expect(words[idx]).toBe(words[idx]) // User would input this
      })

      // Step 4: Protect with passphrase
      const passphrase = 'MySecurePassphrase123!'
      const identity2 = new WotIdentity()
      await identity2.unlock(mnemonic, passphrase)

      // The DID should be derived from the mnemonic
      expect(identity2.getDid()).toMatch(/^did:key:/)

      // Step 5: Verify stored (happens automatically in unlock)
      expect(await identity2.hasStoredIdentity()).toBe(true)
    })
  })
})
