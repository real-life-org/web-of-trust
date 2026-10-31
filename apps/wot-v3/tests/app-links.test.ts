// @vitest-environment node
// Verified App Links (#489): the manifest's intent filter, the landing's assetlinks.json and the
// card-link test agree on host, path and package, so Android opens https://web-of-trust.de/c#… in the
// app. The fingerprint's equality with what Play reports is a manual check (the PR documents it).
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isCardLink } from '../src/platform/web'

const here = (...p: string[]) => resolve(__dirname, '..', ...p)
const manifest = readFileSync(here('android/app/src/main/AndroidManifest.xml'), 'utf8')
const gradle = readFileSync(here('android/app/build.gradle'), 'utf8')
const links = JSON.parse(readFileSync(here('../landing/public/.well-known/assetlinks.json'), 'utf8')) as {
  relation: string[]
  target: { namespace: string; package_name: string; sha256_cert_fingerprints: string[] }
}[]
const deploy = readFileSync(here('../../.github/workflows/deploy.yml'), 'utf8')

describe('verified App Links (#489)', () => {
  it('the intent filter verifies https://web-of-trust.de/c and /c/', () => {
    const filter = manifest.slice(manifest.indexOf('android:autoVerify="true"'), manifest.indexOf('</intent-filter>', manifest.indexOf('android:autoVerify="true"')))
    expect(filter).toContain('android:scheme="https"')
    expect(filter).toContain('android:host="web-of-trust.de"')
    expect(filter).toContain('android:path="/c"')
    expect(filter).toContain('android:path="/c/"')
    expect(isCardLink('https://web-of-trust.de/c#1:ABC')).toBe(true)
    expect(isCardLink('https://web-of-trust.de/c/#1:ABC')).toBe(true)
  })

  it('assetlinks.json names the app the manifest builds, with well-formed fingerprints', () => {
    const applicationId = /applicationId\s+"([^"]+)"/.exec(gradle)?.[1]
    expect(applicationId).toBe('org.reallife.weboftrust')
    expect(links).toHaveLength(1)
    const [entry] = links
    expect(entry!.relation).toEqual(['delegate_permission/common.handle_all_urls'])
    expect(entry!.target.namespace).toBe('android_app')
    expect(entry!.target.package_name).toBe(applicationId)
    expect(entry!.target.sha256_cert_fingerprints.length).toBeGreaterThan(0)
    for (const f of entry!.target.sha256_cert_fingerprints) expect(f).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/)
  })

  it('the Pages deploy copies the landing with its dot-directories (.well-known)', () => {
    expect(deploy).toContain('cp -r apps/landing/dist/. combined/')
    expect(deploy).not.toContain('cp -r apps/landing/dist/* combined/')
  })
})
