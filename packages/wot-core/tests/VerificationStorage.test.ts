import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { LocalStorageAdapter } from '../src/adapters/storage/LocalStorageAdapter'
import { WotIdentity } from '../src/identity/WotIdentity'
import { VerificationWorkflow } from '../src/application'
import { WebCryptoProtocolCryptoAdapter } from '../src/protocol-adapters'

const verificationWorkflow = new VerificationWorkflow({ crypto: new WebCryptoProtocolCryptoAdapter() })

describe('Verification Storage', () => {
  let storage: LocalStorageAdapter
  let anna: WotIdentity
  let ben: WotIdentity
  let annaDid: string
  let benDid: string

  beforeEach(async () => {
    storage = new LocalStorageAdapter()
    await storage.init()

    anna = new WotIdentity()
    const annaResult = await anna.create('anna-passphrase', false)
    annaDid = annaResult.did

    ben = new WotIdentity()
    const benResult = await ben.create('ben-passphrase', false)
    benDid = benResult.did
  })

  afterEach(async () => {
    // Close DB and delete to isolate tests
    ;(storage as any).db?.close()
    indexedDB.deleteDatabase('web-of-trust')
  })

  describe('Verification Renewal (Overwrite)', () => {
    it('should overwrite existing verification from same from→to pair', async () => {
      // First verification: Ben → Anna
      const v1 = await verificationWorkflow.createVerificationFor(ben, annaDid, 'nonce-1')
      await storage.saveVerification(v1)

      let all = await storage.getAllVerifications()
      expect(all).toHaveLength(1)
      expect(all[0].id).toBe(v1.id)

      // Second verification: Ben → Anna (renewal)
      const v2 = await verificationWorkflow.createVerificationFor(ben, annaDid, 'nonce-2')
      await storage.saveVerification(v2)

      all = await storage.getAllVerifications()
      expect(all).toHaveLength(1)
      expect(all[0].id).toBe(v2.id)
    })

    it('should not overwrite verification from different pair', async () => {
      // Ben → Anna
      const v1 = await verificationWorkflow.createVerificationFor(ben, annaDid, 'nonce-1')
      await storage.saveVerification(v1)

      // Anna → Ben (different direction)
      const v2 = await verificationWorkflow.createVerificationFor(anna, benDid, 'nonce-2')
      await storage.saveVerification(v2)

      const all = await storage.getAllVerifications()
      expect(all).toHaveLength(2)
    })

    it('should keep the latest verification data after overwrite', async () => {
      const v1 = await verificationWorkflow.createVerificationFor(ben, annaDid, 'nonce-old')
      await storage.saveVerification(v1)

      const v2 = await verificationWorkflow.createVerificationFor(ben, annaDid, 'nonce-new')
      await storage.saveVerification(v2)

      const stored = await storage.getVerification(v2.id)
      expect(stored).not.toBeNull()
      expect(stored!.id).toBe(v2.id)

      // Old one should be gone
      const old = await storage.getVerification(v1.id)
      expect(old).toBeNull()
    })
  })

  describe('Unreciprocated Incoming Verifications', () => {
    it('should identify incoming verification without counter-verification', async () => {
      // Ben verifies Anna (from=Ben, to=Anna)
      const v = await verificationWorkflow.createVerificationFor(ben, annaDid, 'nonce-1')
      await storage.saveVerification(v)

      const all = await storage.getAllVerifications()

      // Filter: incoming to Anna, not counter-verified
      const unreciprocated = all.filter(ver => {
        if (ver.to !== annaDid) return false
        const hasCounter = all.some(c => c.from === annaDid && c.to === ver.from)
        return !hasCounter
      })

      expect(unreciprocated).toHaveLength(1)
      expect(unreciprocated[0].from).toBe(benDid)
      expect(unreciprocated[0].to).toBe(annaDid)
    })

    it('should not show as unreciprocated after counter-verification', async () => {
      // Ben verifies Anna
      const v1 = await verificationWorkflow.createVerificationFor(ben, annaDid, 'nonce-1')
      await storage.saveVerification(v1)

      // Anna counter-verifies Ben
      const v2 = await verificationWorkflow.createVerificationFor(anna, benDid, 'nonce-2')
      await storage.saveVerification(v2)

      const all = await storage.getAllVerifications()

      const unreciprocated = all.filter(ver => {
        if (ver.to !== annaDid) return false
        const hasCounter = all.some(c => c.from === annaDid && c.to === ver.from)
        return !hasCounter
      })

      expect(unreciprocated).toHaveLength(0)
    })

    it('should handle multiple unreciprocated verifications', async () => {
      const carol = new WotIdentity()
      await carol.create('carol-passphrase', false)
      const carolDid = carol.getDid()

      // Ben verifies Anna
      const v1 = await verificationWorkflow.createVerificationFor(ben, annaDid, 'nonce-1')
      await storage.saveVerification(v1)

      // Carol verifies Anna
      const v2 = await verificationWorkflow.createVerificationFor(carol, annaDid, 'nonce-2')
      await storage.saveVerification(v2)

      const all = await storage.getAllVerifications()

      const unreciprocated = all.filter(ver => {
        if (ver.to !== annaDid) return false
        const hasCounter = all.some(c => c.from === annaDid && c.to === ver.from)
        return !hasCounter
      })

      expect(unreciprocated).toHaveLength(2)
      const fromDids = unreciprocated.map(v => v.from).sort()
      expect(fromDids).toContain(benDid)
      expect(fromDids).toContain(carolDid)
    })
  })
})
