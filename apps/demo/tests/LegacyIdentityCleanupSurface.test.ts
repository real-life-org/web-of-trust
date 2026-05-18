import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const demoRoot = resolve(__dirname, '..')

// Keep split so the demo-wide grep guard catches real cleanup-page references.
const removedCleanupPage = `cleanup-old-${'identity'}.html`

describe('legacy identity cleanup surfaces', () => {
  it('does not expose the removed static cleanup page', () => {
    expect(existsSync(resolve(demoRoot, 'public', removedCleanupPage))).toBe(false)
  })

  it('does not expose legacy IndexedDB identity internals in DebugPanel', () => {
    const debugPanel = readFileSync(resolve(demoRoot, 'src/components/debug/DebugPanel.tsx'), 'utf8')

    expect(debugPanel).not.toMatch(/Legacy \(IDB\)|snapshot\.impl === 'legacy'|snapshot\.legacy/)
  })
})
