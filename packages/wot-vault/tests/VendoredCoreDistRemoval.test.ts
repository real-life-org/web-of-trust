import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const vaultDir = resolve(here, '..')
const vendoredDistDir = resolve(vaultDir, 'wot-core-dist')
const dockerfilePath = resolve(vaultDir, 'Dockerfile')
const dockerBuildScriptPath = resolve(vaultDir, 'docker-build.sh')

describe('Vault vendored wot-core dist removal', () => {
  it('does not keep packages/wot-vault/wot-core-dist/ in the worktree', () => {
    expect(existsSync(vendoredDistDir)).toBe(false)
  })

  it('Dockerfile does not reference the vendored wot-core-dist bundle', () => {
    const src = readFileSync(dockerfilePath, 'utf8')
    expect(src).not.toMatch(/wot-core-dist/)
  })

  it('docker-build.sh does not reference the vendored wot-core-dist bundle', () => {
    const src = readFileSync(dockerBuildScriptPath, 'utf8')
    expect(src).not.toMatch(/wot-core-dist/)
  })
})
