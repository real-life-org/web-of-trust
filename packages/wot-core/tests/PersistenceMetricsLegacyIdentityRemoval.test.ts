import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { PersistenceMetrics, getMetrics } from '../src/storage/PersistenceMetrics'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const metricsPath = resolve(__dirname, '../src/storage/PersistenceMetrics.ts')

describe('PersistenceMetrics LegacyIdentityRemoval', () => {
  it('does not expose legacy as a normal persistence implementation tag', () => {
    const source = readFileSync(metricsPath, 'utf8')
    const exposesLegacyNormalImpl = /new PersistenceMetrics\('legacy'\)|impl=legacy|ImplTag = 'legacy'/.test(source)

    expect(exposesLegacyNormalImpl).toBe(false)
    expect(getMetrics().getSnapshot().impl).not.toBe('legacy')
  })

  it('does not include legacy-only fields on the normal debug snapshot', () => {
    const snapshot = new PersistenceMetrics('compact-store').getSnapshot()

    expect(snapshot).not.toHaveProperty('legacy')
    expect(snapshot.persistence).not.toHaveProperty('legacy')
  })
})
