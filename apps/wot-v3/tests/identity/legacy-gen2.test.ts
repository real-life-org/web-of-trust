// Gen-2 names (architecture §4.2 "Gen-2-Reset"): the list comes from apps/demo durableStoreWipe.ts
// and localStorageSchemaMigration.ts, not copied blindly but checked against the legacy source, so a
// drift there makes this test fail. And the web implementation detects and wipes an old install.
// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { IDBFactory } from 'fake-indexeddb'
import { describe, expect, it } from 'vitest'
import {
  DURABLE_STORE_PREFIXES,
  LEGACY_ACTIVE_DID_KEY,
  LEGACY_DATA_DBS,
  LEGACY_DB_NAMES,
  LEGACY_DEVICE_ID_PREFIX,
  LEGACY_SEED_VAULT_DB_NAME,
  webDatabases,
  webLegacyGen2,
} from '../../src/platform/web'

const legacy = path.resolve(__dirname, '../../../demo/src/services')
const wipeSrc = readFileSync(path.join(legacy, 'durableStoreWipe.ts'), 'utf8')
const migrationSrc = readFileSync(path.join(legacy, 'localStorageSchemaMigration.ts'), 'utf8')

function stringArray(src: string, name: string): string[] {
  const m = new RegExp(`${name}\\s*=\\s*\\[([^\\]]*)\\]`).exec(src)
  if (!m?.[1]) throw new Error(`${name} not found in the legacy source`)
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1] ?? '')
}
function stringConst(src: string, name: string): string {
  const m = new RegExp(`${name}\\s*=\\s*'([^']+)'`).exec(src)
  if (!m?.[1]) throw new Error(`${name} not found in the legacy source`)
  return m[1]
}

describe('Gen-2 names match the legacy constants', () => {
  it('LEGACY_DB_NAMES, DURABLE_STORE_PREFIXES, seed vault, device id and active did', () => {
    expect([...LEGACY_DB_NAMES]).toEqual(stringArray(wipeSrc, 'LEGACY_DB_NAMES'))
    expect([...DURABLE_STORE_PREFIXES]).toEqual(stringArray(wipeSrc, 'DURABLE_STORE_PREFIXES'))
    expect(LEGACY_SEED_VAULT_DB_NAME).toBe(stringConst(wipeSrc, 'SEED_VAULT_DB_NAME'))
    expect(LEGACY_DEVICE_ID_PREFIX).toBe(stringConst(wipeSrc, 'DEVICE_ID_PREFIX'))
    expect(LEGACY_ACTIVE_DID_KEY).toBe(stringConst(wipeSrc, 'ACTIVE_DID_KEY'))
    expect([...LEGACY_DATA_DBS]).toEqual(stringArray(migrationSrc, 'WOT_DATA_DBS'))
  })
})

async function createDb(factory: IDBFactory, name: string) {
  await new Promise<void>((res, rej) => {
    const r = factory.open(name, 1)
    r.onupgradeneeded = () => r.result.createObjectStore('x')
    r.onsuccess = () => {
      r.result.close()
      res()
    }
    r.onerror = () => rej(r.error)
  })
}

describe('web Gen-2 port', () => {
  it('detects, wipes and verifies an old install; leaves v3 databases alone', async () => {
    const factory = new IDBFactory()
    for (const n of ['wot-identity', 'web-of-trust', 'wot-doc-log:did:key:z6MkOld', 'wot-v3-vault']) await createDb(factory, n)
    localStorage.setItem('wot-active-did', 'did:key:z6MkOld')
    localStorage.setItem('wot-device-id:did:key:z6MkOld', 'dev')
    localStorage.setItem('wot-v3:lang', 'de')
    const port = webLegacyGen2(webDatabases(factory))
    expect(await port.detect()).toBe(true)
    await port.wipe()
    expect(await port.survivors()).toEqual([])
    expect(await port.detect()).toBe(false)
    const left = (await factory.databases()).map((d) => d.name)
    expect(left).toEqual(['wot-v3-vault'])
    expect(localStorage.getItem('wot-v3:lang')).toBe('de')
  })

  it('a fresh origin is no old install', async () => {
    localStorage.clear()
    expect(await webLegacyGen2(webDatabases(new IDBFactory())).detect()).toBe(false)
  })
})
