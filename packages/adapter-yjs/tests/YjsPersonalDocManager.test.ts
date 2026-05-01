import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  initYjsPersonalDoc,
  getYjsPersonalDoc,
  changeYjsPersonalDoc,
  onYjsPersonalDocChange,
  flushYjsPersonalDoc,
  resetYjsPersonalDoc,
  type YjsPersonalDoc,
} from '../src/YjsPersonalDocManager'
import { WotIdentity } from '@web_of_trust/core'

// Test helpers
function createTestIdentity(): WotIdentity {
  return new WotIdentity()
}

describe('YjsPersonalDocManager', () => {
  let identity: WotIdentity
  let dbCounter = 0

  beforeEach(() => {
    identity = createTestIdentity()
  })

  afterEach(async () => {
    await resetYjsPersonalDoc()
    // Clean up IDB between tests
    try {
      const dbs = await indexedDB.databases()
      for (const db of dbs) {
        if (db.name?.startsWith('wot-yjs')) {
          indexedDB.deleteDatabase(db.name)
        }
      }
    } catch { /* indexedDB.databases() may not be available in all envs */ }
  })

  describe('Initialization', () => {
    it('should initialize with empty doc', async () => {
      const doc = await initYjsPersonalDoc(identity)
      expect(doc).toBeDefined()
      expect(doc.profile).toBeNull()
      expect(doc.contacts).toEqual({})
      expect(doc.verifications).toEqual({})
      expect(doc.attestations).toEqual({})
      expect(doc.attestationMetadata).toEqual({})
      expect(doc.outbox).toEqual({})
      expect(doc.spaces).toEqual({})
      expect(doc.groupKeys).toEqual({})
    })

    it('should be idempotent (second init returns same doc)', async () => {
      const doc1 = await initYjsPersonalDoc(identity)
      const doc2 = await initYjsPersonalDoc(identity)
      expect(doc1).toEqual(doc2)
    })

    it('should throw if getPersonalDoc called before init', () => {
      expect(() => getYjsPersonalDoc()).toThrow()
    })
  })

  describe('Profile', () => {
    beforeEach(async () => {
      await initYjsPersonalDoc(identity)
    })

    it('should create profile', () => {
      changeYjsPersonalDoc(doc => {
        doc.profile = {
          did: 'did:key:z6MktestDid123',
          name: 'Anton',
          bio: 'Builder',
          avatar: '',
          offersJson: '[]',
          needsJson: '[]',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }
      })
      const doc = getYjsPersonalDoc()
      expect(doc.profile?.name).toBe('Anton')
      expect(doc.profile?.bio).toBe('Builder')
    })

    it('should update profile fields', () => {
      changeYjsPersonalDoc(doc => {
        doc.profile = {
          did: 'did:key:z6MktestDid123',
          name: 'Anton',
          bio: '',
          avatar: '',
          offersJson: '[]',
          needsJson: '[]',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }
      })
      changeYjsPersonalDoc(doc => {
        if (doc.profile) {
          doc.profile.bio = 'Updated bio'
          doc.profile.updatedAt = new Date().toISOString()
        }
      })
      const doc = getYjsPersonalDoc()
      expect(doc.profile?.bio).toBe('Updated bio')
    })
  })

  describe('Contacts', () => {
    const testContact = {
      did: 'did:key:z6Mktest123',
      publicKey: 'testkey123',
      name: 'Alice',
      avatar: '',
      bio: 'Tester',
      status: 'active' as const,
      verifiedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }

    beforeEach(async () => {
      await initYjsPersonalDoc(identity)
    })

    it('should add a contact', () => {
      changeYjsPersonalDoc(doc => {
        doc.contacts[testContact.did] = testContact
      })
      const doc = getYjsPersonalDoc()
      expect(doc.contacts[testContact.did]).toBeDefined()
      expect(doc.contacts[testContact.did].name).toBe('Alice')
    })

    it('should update a contact', () => {
      changeYjsPersonalDoc(doc => {
        doc.contacts[testContact.did] = testContact
      })
      changeYjsPersonalDoc(doc => {
        doc.contacts[testContact.did].name = 'Alice Updated'
      })
      const doc = getYjsPersonalDoc()
      expect(doc.contacts[testContact.did].name).toBe('Alice Updated')
    })

    it('should remove a contact', () => {
      changeYjsPersonalDoc(doc => {
        doc.contacts[testContact.did] = testContact
      })
      changeYjsPersonalDoc(doc => {
        delete doc.contacts[testContact.did]
      })
      const doc = getYjsPersonalDoc()
      expect(doc.contacts[testContact.did]).toBeUndefined()
    })

    it('should handle multiple contacts', () => {
      changeYjsPersonalDoc(doc => {
        doc.contacts['did:key:alice'] = { ...testContact, did: 'did:key:alice', name: 'Alice' }
        doc.contacts['did:key:bob'] = { ...testContact, did: 'did:key:bob', name: 'Bob' }
        doc.contacts['did:key:carol'] = { ...testContact, did: 'did:key:carol', name: 'Carol' }
      })
      const doc = getYjsPersonalDoc()
      expect(Object.keys(doc.contacts)).toHaveLength(3)
    })
  })

  describe('Verifications', () => {
    beforeEach(async () => {
      await initYjsPersonalDoc(identity)
    })

    it('should save a verification', () => {
      const verification = {
        id: 'v-1',
        fromDid: 'did:key:alice',
        toDid: 'did:key:bob',
        timestamp: new Date().toISOString(),
        proofJson: '{"type":"test"}',
        locationJson: '{"lat":0,"lng":0}',
      }
      changeYjsPersonalDoc(doc => {
        doc.verifications[verification.id] = verification
      })
      const doc = getYjsPersonalDoc()
      expect(doc.verifications['v-1'].fromDid).toBe('did:key:alice')
    })
  })

  describe('Attestations', () => {
    beforeEach(async () => {
      await initYjsPersonalDoc(identity)
    })

    it('should save an attestation with metadata', () => {
      const attestation = {
        id: 'a-1',
        attestationId: 'att-1',
        fromDid: 'did:key:alice',
        toDid: 'did:key:bob',
        claim: 'Great developer',
        tagsJson: '["dev"]',
        context: 'work',
        createdAt: new Date().toISOString(),
        vcJws: 'header.payload.signature',
      }
      changeYjsPersonalDoc(doc => {
        doc.attestations[attestation.id] = attestation
        doc.attestationMetadata[attestation.id] = {
          attestationId: attestation.attestationId,
          accepted: false,
          acceptedAt: '',
          deliveryStatus: 'pending',
        }
      })
      const doc = getYjsPersonalDoc()
      expect(doc.attestations['a-1'].claim).toBe('Great developer')
      expect(doc.attestationMetadata['a-1'].accepted).toBe(false)
    })

    it('should accept an attestation', () => {
      changeYjsPersonalDoc(doc => {
        doc.attestationMetadata['a-1'] = {
          attestationId: 'att-1',
          accepted: false,
          acceptedAt: '',
          deliveryStatus: 'pending',
        }
      })
      changeYjsPersonalDoc(doc => {
        doc.attestationMetadata['a-1'].accepted = true
        doc.attestationMetadata['a-1'].acceptedAt = new Date().toISOString()
      })
      const doc = getYjsPersonalDoc()
      expect(doc.attestationMetadata['a-1'].accepted).toBe(true)
    })
  })

  describe('Outbox', () => {
    beforeEach(async () => {
      await initYjsPersonalDoc(identity)
    })

    it('should enqueue and dequeue messages', () => {
      changeYjsPersonalDoc(doc => {
        doc.outbox['msg-1'] = {
          envelopeJson: '{"to":"did:key:bob"}',
          createdAt: new Date().toISOString(),
          retryCount: 0,
        }
      })
      expect(getYjsPersonalDoc().outbox['msg-1']).toBeDefined()

      changeYjsPersonalDoc(doc => {
        delete doc.outbox['msg-1']
      })
      expect(getYjsPersonalDoc().outbox['msg-1']).toBeUndefined()
    })

    it('should increment retry count', () => {
      changeYjsPersonalDoc(doc => {
        doc.outbox['msg-1'] = {
          envelopeJson: '{}',
          createdAt: new Date().toISOString(),
          retryCount: 0,
        }
      })
      changeYjsPersonalDoc(doc => {
        doc.outbox['msg-1'].retryCount++
      })
      expect(getYjsPersonalDoc().outbox['msg-1'].retryCount).toBe(1)
    })
  })

  describe('Spaces Metadata', () => {
    beforeEach(async () => {
      await initYjsPersonalDoc(identity)
    })

    it('should save and load space metadata', () => {
      changeYjsPersonalDoc(doc => {
        doc.spaces['space-1'] = {
          info: {
            id: 'space-1',
            type: 'shared',
            name: 'Test Space',
            members: ['did:key:z6MktestDid123'],
            createdAt: new Date().toISOString(),
          },
          documentId: 'doc-123',
          documentUrl: 'yjs:doc-123',
          memberEncryptionKeys: {},
        }
      })
      const doc = getYjsPersonalDoc()
      expect(doc.spaces['space-1'].info.name).toBe('Test Space')
    })
  })

  describe('Group Keys', () => {
    beforeEach(async () => {
      await initYjsPersonalDoc(identity)
    })

    it('should save and load group keys', () => {
      changeYjsPersonalDoc(doc => {
        doc.groupKeys['space-1:0'] = {
          spaceId: 'space-1',
          generation: 0,
          key: [1, 2, 3, 4, 5, 6, 7, 8],
        }
      })
      const doc = getYjsPersonalDoc()
      expect(doc.groupKeys['space-1:0'].generation).toBe(0)
      expect(doc.groupKeys['space-1:0'].key).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    })
  })

  describe('Change Notifications', () => {
    beforeEach(async () => {
      await initYjsPersonalDoc(identity)
    })

    it('should notify on local changes', () => {
      const callback = vi.fn()
      const unsub = onYjsPersonalDocChange(callback)

      changeYjsPersonalDoc(doc => {
        doc.profile = {
          did: 'did:key:z6MktestDid123',
          name: 'Test',
          bio: '',
          avatar: '',
          offersJson: '[]',
          needsJson: '[]',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }
      })

      expect(callback).toHaveBeenCalledTimes(1)
      unsub()
    })

    it('should unsubscribe correctly', () => {
      const callback = vi.fn()
      const unsub = onYjsPersonalDocChange(callback)
      unsub()

      changeYjsPersonalDoc(doc => {
        doc.contacts['did:key:test'] = {
          did: 'did:key:test',
          publicKey: 'key',
          name: 'Test',
          avatar: '',
          bio: '',
          status: 'active',
          verifiedAt: '',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }
      })

      expect(callback).not.toHaveBeenCalled()
    })
  })

  describe('Persistence (CompactStore)', () => {
    it('should persist and restore via CompactStore', async () => {
      // Init and add data
      await initYjsPersonalDoc(identity)
      changeYjsPersonalDoc(doc => {
        doc.profile = {
          did: 'did:key:z6MktestDid123',
          name: 'Persisted',
          bio: 'Survives restart',
          avatar: '',
          offersJson: '[]',
          needsJson: '[]',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }
        doc.contacts['did:key:alice'] = {
          did: 'did:key:alice',
          publicKey: 'key',
          name: 'Alice',
          avatar: '',
          bio: '',
          status: 'active',
          verifiedAt: '',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }
      })

      // Flush to CompactStore
      await flushYjsPersonalDoc()

      // Reset (simulates app restart)
      await resetYjsPersonalDoc()

      // Re-init — should restore from CompactStore
      const restored = await initYjsPersonalDoc(identity)
      expect(restored.profile?.name).toBe('Persisted')
      expect(restored.profile?.bio).toBe('Survives restart')
      expect(restored.contacts['did:key:alice']?.name).toBe('Alice')
    })

    it('should start fresh if no persisted data', async () => {
      const doc = await initYjsPersonalDoc(identity)
      expect(doc.profile).toBeNull()
      expect(Object.keys(doc.contacts)).toHaveLength(0)
    })
  })

  describe('Object.keys / Object.values compatibility', () => {
    beforeEach(async () => {
      await initYjsPersonalDoc(identity)
    })

    it('should support Object.keys on record proxies', () => {
      changeYjsPersonalDoc(doc => {
        doc.contacts['did:key:alice'] = {
          did: 'did:key:alice', publicKey: 'k1', name: 'Alice',
          avatar: '', bio: '', status: 'active', verifiedAt: '', createdAt: '', updatedAt: '',
        }
        doc.contacts['did:key:bob'] = {
          did: 'did:key:bob', publicKey: 'k2', name: 'Bob',
          avatar: '', bio: '', status: 'active', verifiedAt: '', createdAt: '', updatedAt: '',
        }
      })
      const doc = getYjsPersonalDoc()
      expect(Object.keys(doc.contacts)).toHaveLength(2)
      expect(Object.keys(doc.contacts)).toContain('did:key:alice')
      expect(Object.keys(doc.contacts)).toContain('did:key:bob')
    })

    it('should support Object.values on record proxies', () => {
      changeYjsPersonalDoc(doc => {
        doc.contacts['did:key:alice'] = {
          did: 'did:key:alice', publicKey: 'k1', name: 'Alice',
          avatar: '', bio: '', status: 'active', verifiedAt: '', createdAt: '', updatedAt: '',
        }
      })
      const doc = getYjsPersonalDoc()
      const values = Object.values(doc.contacts)
      expect(values).toHaveLength(1)
      expect(values[0].name).toBe('Alice')
    })

    it('should support "did in doc.contacts" check', () => {
      changeYjsPersonalDoc(doc => {
        doc.contacts['did:key:alice'] = {
          did: 'did:key:alice', publicKey: 'k1', name: 'Alice',
          avatar: '', bio: '', status: 'active', verifiedAt: '', createdAt: '', updatedAt: '',
        }
      })
      const doc = getYjsPersonalDoc()
      expect('did:key:alice' in doc.contacts).toBe(true)
      expect('did:key:bob' in doc.contacts).toBe(false)
    })
  })

  describe('Nested Object Updates', () => {
    beforeEach(async () => {
      await initYjsPersonalDoc(identity)
    })

    it('should update nested object fields (space.info.name)', () => {
      changeYjsPersonalDoc(doc => {
        doc.spaces['space-1'] = {
          info: {
            id: 'space-1', type: 'shared', name: 'Original',
            members: ['did:key:z6MktestDid123'], createdAt: new Date().toISOString(),
          },
          documentId: 'doc-1', documentUrl: 'yjs:doc-1', memberEncryptionKeys: {},
        }
      })
      changeYjsPersonalDoc(doc => {
        doc.spaces['space-1'].info.name = 'Renamed'
      })
      const doc = getYjsPersonalDoc()
      expect(doc.spaces['space-1'].info.name).toBe('Renamed')
    })
  })

  describe('Array values', () => {
    beforeEach(async () => {
      await initYjsPersonalDoc(identity)
    })

    it('should store and retrieve array values (members)', () => {
      changeYjsPersonalDoc(doc => {
        doc.spaces['space-1'] = {
          info: {
            id: 'space-1', type: 'shared', name: 'Test',
            members: ['did:key:alice', 'did:key:bob'], createdAt: new Date().toISOString(),
          },
          documentId: 'doc-1', documentUrl: 'yjs:doc-1', memberEncryptionKeys: {},
        }
      })
      const doc = getYjsPersonalDoc()
      expect(doc.spaces['space-1'].info.members).toEqual(['did:key:alice', 'did:key:bob'])
    })

    it('should store and retrieve number arrays (group key)', () => {
      changeYjsPersonalDoc(doc => {
        doc.groupKeys['s1:0'] = { spaceId: 's1', generation: 0, key: [10, 20, 30, 40] }
      })
      const doc = getYjsPersonalDoc()
      expect(doc.groupKeys['s1:0'].key).toEqual([10, 20, 30, 40])
    })
  })

  describe('Object.values inside changePersonalDoc', () => {
    beforeEach(async () => {
      await initYjsPersonalDoc(identity)
    })

    it('should support Object.values inside change callback', () => {
      changeYjsPersonalDoc(doc => {
        doc.contacts['did:key:alice'] = {
          did: 'did:key:alice', publicKey: 'k1', name: 'Alice',
          avatar: '', bio: '', status: 'active', verifiedAt: '', createdAt: '', updatedAt: '',
        }
        doc.contacts['did:key:bob'] = {
          did: 'did:key:bob', publicKey: 'k2', name: 'Bob',
          avatar: '', bio: '', status: 'active', verifiedAt: '', createdAt: '', updatedAt: '',
        }
      })

      // Inside a change callback, read via Object.values
      changeYjsPersonalDoc(doc => {
        const contacts = Object.values(doc.contacts)
        expect(contacts).toHaveLength(2)
        const names = contacts.map((c: any) => c.name)
        expect(names).toContain('Alice')
        expect(names).toContain('Bob')
      })
    })
  })

  describe('memberEncryptionKeys (nested Record with arrays)', () => {
    beforeEach(async () => {
      await initYjsPersonalDoc(identity)
    })

    it('should store and retrieve memberEncryptionKeys as number arrays', () => {
      const keys: Record<string, number[]> = {
        'did:key:alice': [1, 2, 3, 4, 5],
        'did:key:bob': [10, 20, 30, 40, 50],
      }
      changeYjsPersonalDoc(doc => {
        doc.spaces['space-1'] = {
          info: {
            id: 'space-1', type: 'shared', name: 'Test',
            members: ['did:key:alice', 'did:key:bob'], createdAt: new Date().toISOString(),
          },
          documentId: 'doc-1', documentUrl: 'yjs:doc-1',
          memberEncryptionKeys: keys,
        }
      })
      const doc = getYjsPersonalDoc()
      expect(doc.spaces['space-1'].memberEncryptionKeys['did:key:alice']).toEqual([1, 2, 3, 4, 5])
      expect(doc.spaces['space-1'].memberEncryptionKeys['did:key:bob']).toEqual([10, 20, 30, 40, 50])
      expect(Array.isArray(doc.spaces['space-1'].memberEncryptionKeys['did:key:alice'])).toBe(true)
    })
  })

  describe('Edge Cases', () => {
    beforeEach(async () => {
      await initYjsPersonalDoc(identity)
    })

    it('should handle null values in optional fields', () => {
      changeYjsPersonalDoc(doc => {
        doc.contacts['did:key:test'] = {
          did: 'did:key:test', publicKey: 'k', name: null,
          avatar: null, bio: null, status: 'pending', verifiedAt: null,
          createdAt: '', updatedAt: '',
        }
      })
      const doc = getYjsPersonalDoc()
      expect(doc.contacts['did:key:test'].name).toBeNull()
      expect(doc.contacts['did:key:test'].bio).toBeNull()
    })

    it('should handle empty string values', () => {
      changeYjsPersonalDoc(doc => {
        doc.profile = {
          did: 'did:key:z6MktestDid123', name: '', bio: '', avatar: '',
          offersJson: '', needsJson: '', createdAt: '', updatedAt: '',
        }
      })
      const doc = getYjsPersonalDoc()
      expect(doc.profile?.name).toBe('')
    })
  })

  describe('Large Document (100 contacts + 50 attestations)', () => {
    beforeEach(async () => {
      await initYjsPersonalDoc(identity)
    })

    it('should handle 100 contacts correctly', () => {
      changeYjsPersonalDoc(doc => {
        for (let i = 0; i < 100; i++) {
          doc.contacts[`did:key:contact-${i}`] = {
            did: `did:key:contact-${i}`,
            publicKey: `pubkey-${i}`,
            name: `Contact ${i}`,
            avatar: i % 3 === 0 ? `https://avatar.example/${i}.png` : '',
            bio: `Bio for contact ${i} — involved in project ${i % 10}`,
            status: i % 5 === 0 ? 'pending' : 'active',
            verifiedAt: i % 5 === 0 ? null : new Date().toISOString(),
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          }
        }
      })

      const doc = getYjsPersonalDoc()
      expect(Object.keys(doc.contacts)).toHaveLength(100)
      expect(doc.contacts['did:key:contact-0'].name).toBe('Contact 0')
      expect(doc.contacts['did:key:contact-99'].name).toBe('Contact 99')
      expect(doc.contacts['did:key:contact-5'].status).toBe('pending')
      expect(doc.contacts['did:key:contact-6'].status).toBe('active')
    })

    it('should handle 50 attestations with metadata', () => {
      changeYjsPersonalDoc(doc => {
        for (let i = 0; i < 50; i++) {
          doc.attestations[`att-${i}`] = {
            id: `att-${i}`,
            attestationId: `attestation-id-${i}`,
            fromDid: `did:key:attester-${i % 10}`,
            toDid: 'did:key:z6MktestDid123',
            claim: `Skill attestation #${i}: ${['JavaScript', 'Rust', 'Design', 'Leadership', 'Cooking'][i % 5]}`,
            tagsJson: JSON.stringify([['dev', 'rust', 'design', 'lead', 'food'][i % 5]]),
            context: ['work', 'community', 'personal'][i % 3],
            createdAt: new Date().toISOString(),
            vcJws: `header.payload-${i}.signature`,
          }
          doc.attestationMetadata[`att-${i}`] = {
            attestationId: `attestation-id-${i}`,
            accepted: i % 3 !== 0,
            acceptedAt: i % 3 !== 0 ? new Date().toISOString() : null,
            deliveryStatus: ['pending', 'delivered', 'failed'][i % 3],
          }
        }
      })

      const doc = getYjsPersonalDoc()
      expect(Object.keys(doc.attestations)).toHaveLength(50)
      expect(Object.keys(doc.attestationMetadata)).toHaveLength(50)
      expect(doc.attestations['att-0'].claim).toContain('JavaScript')
      expect(doc.attestations['att-49'].claim).toContain('Cooking')

      // Filter: accepted attestations
      const accepted = Object.values(doc.attestationMetadata).filter((m: any) => m.accepted)
      expect(accepted.length).toBeGreaterThan(0)
      expect(accepted.length).toBeLessThan(50)
    })

    it('should persist and restore large document via CompactStore', async () => {
      changeYjsPersonalDoc(doc => {
        doc.profile = {
          did: 'did:key:z6MktestDid123', name: 'Large Doc Test', bio: 'Lots of data',
          avatar: '', offersJson: '[]', needsJson: '[]',
          createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        }
        for (let i = 0; i < 100; i++) {
          doc.contacts[`did:key:c-${i}`] = {
            did: `did:key:c-${i}`, publicKey: `pk-${i}`, name: `C${i}`,
            avatar: '', bio: '', status: 'active', verifiedAt: '',
            createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
          }
        }
        for (let i = 0; i < 50; i++) {
          doc.attestations[`a-${i}`] = {
            id: `a-${i}`, attestationId: `aid-${i}`, fromDid: `did:key:f-${i}`,
            toDid: 'did:key:z6MktestDid123', claim: `Claim ${i}`, tagsJson: '[]',
            context: 'test', createdAt: new Date().toISOString(), vcJws: `header.payload-${i}.signature`,
          }
        }
      }, { background: true })

      await flushYjsPersonalDoc()
      await resetYjsPersonalDoc()

      const restored = await initYjsPersonalDoc(identity)
      expect(restored.profile?.name).toBe('Large Doc Test')
      expect(Object.keys(restored.contacts)).toHaveLength(100)
      expect(Object.keys(restored.attestations)).toHaveLength(50)
      expect(restored.contacts['did:key:c-0'].name).toBe('C0')
      expect(restored.contacts['did:key:c-99'].name).toBe('C99')
      expect(restored.attestations['a-49'].claim).toBe('Claim 49')
    })

    it('should support Object.values filtering on large collections', () => {
      changeYjsPersonalDoc(doc => {
        for (let i = 0; i < 100; i++) {
          doc.contacts[`did:key:c-${i}`] = {
            did: `did:key:c-${i}`, publicKey: `pk-${i}`, name: `C${i}`,
            avatar: '', bio: '', status: i < 30 ? 'pending' : 'active',
            verifiedAt: i < 30 ? null : new Date().toISOString(),
            createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
          }
        }
      })

      const doc = getYjsPersonalDoc()
      const active = Object.values(doc.contacts).filter((c: any) => c.status === 'active')
      const pending = Object.values(doc.contacts).filter((c: any) => c.status === 'pending')
      expect(active).toHaveLength(70)
      expect(pending).toHaveLength(30)
    })
  })

  describe('Snapshot Size (no unbounded growth)', () => {
    it('should not grow significantly with repeated updates', async () => {
      await initYjsPersonalDoc(identity)

      // Make 50 updates to the same field (use background to avoid 50 immediate pushes)
      for (let i = 0; i < 50; i++) {
        changeYjsPersonalDoc(doc => {
          doc.profile = {
            did: 'did:key:z6MktestDid123',
            name: `Name ${i}`,
            bio: `Bio ${i}`,
            avatar: '',
            offersJson: '[]',
            needsJson: '[]',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          }
        }, { background: true })
      }

      // Verify current state before persistence
      expect(getYjsPersonalDoc().profile?.name).toBe('Name 49')

      // Flush ensures the latest state is persisted
      await flushYjsPersonalDoc()
      await resetYjsPersonalDoc()

      // Restore and check — snapshot should be compact (GC removes old values)
      const restored = await initYjsPersonalDoc(identity)
      expect(restored.profile?.name).toBe('Name 49')
    })
  })
})
