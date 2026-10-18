// Vault format and SeedVaultPort, architecture §5.2 "Tests": format vector, manipulation of every
// head field, migration to the target rounds, legacy record → unsupported, setProtection with a
// wrong passphrase, the hint field never lowers the protection; the same suite over IndexedDB.
// @vitest-environment node
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { describe, expect, it } from 'vitest'
import {
  b64url,
  createSeedVault,
  fromB64url,
  idbVaultBackend,
  jcs,
  memoryVaultBackend,
  open,
  seal,
  type VaultBackend,
  type VaultRecord,
} from '../../src/platform/seed-vault'
import { fakeEntropy, virtualClock } from '../../src/platform/fake'
import type { ResumeMarker } from '../../src/platform/ports'

const subtle = globalThis.crypto.subtle
const enc = new TextEncoder()
const hex = (s: string) => Uint8Array.from(s.match(/../g)?.map((h) => parseInt(h, 16)) ?? [])

const ROOT_IKM = hex(
  '5eb00bbddcf069084889a8ab9155568165f5c453ccb85e70811aaed6f6da5fc19a5ac40b389cd370d086206dec8aa6c43daea6690f20ad3d8d48b2d2ce9e38e4',
)
const DEK = Uint8Array.from({ length: 32 }, (_, i) => i)

// Format vector (version 1): fixed password, salt, IV and payload → this exact record. The ciphertext
// was computed independently (Python hashlib.pbkdf2_hmac + cryptography AESGCM) and matched.
const VECTOR = {
  password: 'correct horse battery staple',
  salt: Uint8Array.from({ length: 16 }, (_, i) => 0xa0 + i),
  iv: Uint8Array.from({ length: 12 }, (_, i) => 0x10 + i),
  createdAt: 1_760_000_000_000,
  ns: 'ns-vector',
  record: {
    head: {
      format: 'wot-v3-vault',
      v: 1,
      ns: 'ns-vector',
      protection: 'passphrase',
      kdf: { alg: 'PBKDF2-SHA-256', iterations: 600000, salt: 'oKGio6SlpqeoqaqrrK2urw' },
      aead: 'AES-256-GCM',
      createdAt: 1760000000000,
      updatedAt: 1760000000000,
    },
    iv: 'EBESExQVFhcYGRob',
    ct: 'USiLve18Ibura5mCgdj1IxloEHMZWKTfbCpcPI1mu71DnEVWLQVG0FzQjcpLzGyjHUwNmFX_1VFu5EXfNXxUipurBgOsJmuSK77BznyQDP2b2Ljkzh1c6UI_O4GntOFgv14VUP6dwdhYuwUiG7_egFqdetAEXfp6f8wHxigM8k_IJj6WvF4DqKJxELKDsu_rxbsKNA4Fm7_dcaS5ghcn2w0OTcwA-vLWpUc269kFR9_m0CkOLVh1SuMq5uJezWGG76dic74',
  },
}

describe('vault format', () => {
  it('matches the version-1 format vector', async () => {
    const record = await seal(subtle, {
      ns: VECTOR.ns,
      protection: 'passphrase',
      iterations: 600_000,
      createdAt: VECTOR.createdAt,
      updatedAt: VECTOR.createdAt,
      salt: VECTOR.salt,
      iv: VECTOR.iv,
      password: enc.encode(VECTOR.password),
      payload: { rootIkm: ROOT_IKM, dek: DEK },
    })
    expect(record).toEqual(VECTOR.record)
    const payload = await open(subtle, VECTOR.record as VaultRecord, enc.encode(VECTOR.password))
    expect(payload && b64url(payload.rootIkm)).toBe(b64url(ROOT_IKM))
    expect(payload && b64url(payload.dek)).toBe(b64url(DEK))
  })

  it('binds the head as AAD: changing any field makes opening fail', async () => {
    const base = await seal(subtle, {
      ns: 'n',
      protection: 'passphrase+biometric',
      iterations: 1000,
      createdAt: 1,
      updatedAt: 2,
      salt: new Uint8Array(16).fill(1),
      iv: new Uint8Array(12).fill(2),
      password: enc.encode('pw-12345678'),
      payload: { rootIkm: ROOT_IKM, dek: DEK },
    })
    const pw = enc.encode('pw-12345678')
    expect(await open(subtle, base, pw)).not.toBeNull()
    const variants: Array<[string, VaultRecord]> = [
      ['ns', { ...base, head: { ...base.head, ns: 'other' } }],
      ['protection', { ...base, head: { ...base.head, protection: 'passphrase' } }],
      ['iterations (lowered)', { ...base, head: { ...base.head, kdf: { ...base.head.kdf, iterations: 999 } } }],
      ['salt', { ...base, head: { ...base.head, kdf: { ...base.head.kdf, salt: b64url(new Uint8Array(16).fill(9)) } } }],
      ['createdAt', { ...base, head: { ...base.head, createdAt: 5 } }],
      ['updatedAt', { ...base, head: { ...base.head, updatedAt: 5 } }],
      ['iv', { ...base, iv: b64url(new Uint8Array(12).fill(3)) }],
      ['ct', { ...base, ct: b64url(fromB64url(base.ct).map((b, i) => (i === 0 ? b ^ 1 : b))) }],
    ]
    for (const [field, record] of variants) {
      expect(await open(subtle, record, pw), field).toBeNull()
    }
    expect(await open(subtle, base, enc.encode('wrong-password'))).toBeNull()
  })

  it('canonicalizes with JCS (sorted keys, no whitespace)', () => {
    expect(jcs({ b: 1, a: { d: 'x', c: [1, 2] } })).toBe('{"a":{"c":[1,2],"d":"x"},"b":1}')
  })
})

const marker = (ns: string): ResumeMarker => ({ flow: 'setup', step: 'holder', ns, startedAt: 0 })

function vaultSuite(name: string, makeBackend: () => VaultBackend) {
  describe(`SeedVaultPort over ${name}`, () => {
    const make = (iterations = 1000, backend = makeBackend()) => ({
      backend,
      vault: createSeedVault(backend, {
        clock: virtualClock(1_000, 'UTC'),
        entropy: fakeEntropy(7),
        iterations,
      }),
    })
    const pw = enc.encode('passphrase-1')

    it('creates record, init and marker in one transaction and opens with the password', async () => {
      const { vault } = make()
      await vault.create('a', { rootIkm: ROOT_IKM, dek: DEK }, pw, 'passphrase', { iv: 'i', ct: 'c' }, marker('a'))
      expect(await vault.exists('a')).toBe('v3')
      expect(await vault.init('a')).toEqual({ iv: 'i', ct: 'c' })
      expect(await vault.resume()).toEqual(marker('a'))
      expect((await vault.head('a'))?.protection).toBe('passphrase')
      expect(await vault.open('a', enc.encode('nope'))).toBeNull()
      expect(b64url((await vault.open('a', pw))?.rootIkm ?? new Uint8Array())).toBe(b64url(ROOT_IKM))
    })

    it('writes a new salt and IV on every write', async () => {
      const { vault } = make()
      await vault.create('a', { rootIkm: ROOT_IKM, dek: DEK }, pw, 'passphrase', { iv: 'i', ct: 'c' }, marker('a'))
      const h1 = await vault.head('a')
      expect(await vault.setProtection('a', 'passphrase+biometric', pw)).toBe(true)
      const h2 = await vault.head('a')
      expect(h2?.protection).toBe('passphrase+biometric')
      expect(h2?.kdf.salt).not.toBe(h1?.kdf.salt)
    })

    it('setProtection with a wrong password returns false and leaves the record unchanged', async () => {
      const { vault } = make()
      await vault.create('a', { rootIkm: ROOT_IKM, dek: DEK }, pw, 'passphrase', { iv: 'i', ct: 'c' }, marker('a'))
      const before = await vault.head('a')
      expect(await vault.setProtection('a', 'passphrase+biometric', enc.encode('wrong'))).toBe(false)
      expect(await vault.head('a')).toEqual(before)
    })

    it('rewraps under a new password', async () => {
      const { vault } = make()
      const random = new Uint8Array(32).fill(4)
      await vault.create('a', { rootIkm: ROOT_IKM, dek: DEK }, random, 'biometric-only', { iv: 'i', ct: 'c' }, marker('a'))
      expect(await vault.rewrap('a', random, pw, 'passphrase+biometric')).toBe(true)
      expect(await vault.open('a', random)).toBeNull()
      expect(await vault.open('a', pw)).not.toBeNull()
      expect((await vault.head('a'))?.protection).toBe('passphrase+biometric')
    })

    it('migrates a record with fewer rounds to the target after a successful open', async () => {
      const low = make(1000)
      await low.vault.create('a', { rootIkm: ROOT_IKM, dek: DEK }, pw, 'passphrase', { iv: 'i', ct: 'c' }, marker('a'))
      const high = make(2000, low.backend)
      expect(await high.vault.open('a', pw)).not.toBeNull()
      expect((await high.vault.head('a'))?.kdf.iterations).toBe(2000)
      expect(await high.vault.open('a', pw)).not.toBeNull()
    })

    it('reports a legacy wot.identity.seed record as unsupported', async () => {
      const { vault, backend } = make()
      await backend.write(async (tx) => {
        tx.put('vaults', 'legacy', { type: 'wot.identity.seed', v: 1, salt: 'x', iv: 'y', ciphertext: 'z' })
      })
      expect(await vault.exists('legacy')).toBe('unsupported')
      expect(await vault.head('legacy')).toBeNull()
    })

    it('the bioUnusable hint never changes the head', async () => {
      const { vault } = make()
      await vault.create('a', { rootIkm: ROOT_IKM, dek: DEK }, pw, 'passphrase+biometric', { iv: 'i', ct: 'c' }, marker('a'))
      const before = await vault.head('a')
      await vault.setBioUnusable('a', true)
      expect(await vault.bioUnusable('a')).toBe(true)
      expect(await vault.head('a')).toEqual(before)
    })

    it('activates atomically: active, init deleted, marker set or deleted', async () => {
      const { vault } = make()
      await vault.create('a', { rootIkm: ROOT_IKM, dek: DEK }, pw, 'passphrase', { iv: 'i', ct: 'c' }, marker('a'))
      await vault.activate('a', null)
      expect(await vault.active()).toBe('a')
      expect(await vault.init('a')).toBeNull()
      expect(await vault.resume()).toBeNull()
    })

    it('wipe(ns) removes only ns and the active pointer only when it still points at ns (N6)', async () => {
      const { vault } = make()
      await vault.create('old', { rootIkm: ROOT_IKM, dek: DEK }, pw, 'passphrase', { iv: 'i', ct: 'c' }, marker('old'))
      await vault.activate('old', null)
      await vault.create('new', { rootIkm: ROOT_IKM, dek: DEK }, pw, 'passphrase', { iv: 'i', ct: 'c' }, marker('new'))
      await vault.activate('new', { flow: 'restore', step: 'switched', ns: 'new', nsOld: 'old', startedAt: 0 })
      await vault.setBioUnusable('old', true)
      await vault.wipe('old')
      expect(await vault.verifyWiped('old')).toBe(true)
      expect(await vault.active()).toBe('new')
      expect(await vault.exists('new')).toBe('v3')
      expect(await vault.resume()).not.toBeNull()
      await vault.wipe('new')
      expect(await vault.active()).toBeNull()
      expect(await vault.namespaces()).toEqual([])
    })
  })
}

vaultSuite('memory', () => memoryVaultBackend())
vaultSuite('IndexedDB (fake-indexeddb)', () => idbVaultBackend(new IDBFactory(), 'wot-v3-vault'))
