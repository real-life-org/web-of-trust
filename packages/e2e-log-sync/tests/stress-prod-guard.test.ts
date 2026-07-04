import { describe, it, expect } from 'vitest'
import { assertNotProdRelay, ProdGuardError } from '../stress/prod-guard'

// The Festival-Scale-Stress runner drives DESTRUCTIVE traffic; the PROD-GUARD must
// refuse any production relay host across ws/wss/http/https, and is fail-closed
// (anything not explicitly allowlisted is refused). No override.

describe('Festival-Scale-Stress PROD-GUARD', () => {
  const prodHosts = ['relay.web-of-trust.de', 'relay.utopia-lab.org']
  const schemes = ['ws://', 'wss://', 'http://', 'https://']

  it('REFUSES every scheme variant of a production relay host', () => {
    for (const host of prodHosts) {
      for (const scheme of schemes) {
        expect(() => assertNotProdRelay(`${scheme}${host}`)).toThrow(ProdGuardError)
        expect(() => assertNotProdRelay(`${scheme}${host}:443/path`)).toThrow(/PRODUCTION/)
      }
    }
  })

  it('ALLOWS localhost / 127.0.0.1 / ::1 / staging', () => {
    expect(() => assertNotProdRelay('ws://localhost:18787')).not.toThrow()
    expect(() => assertNotProdRelay('ws://127.0.0.1:18787')).not.toThrow()
    expect(() => assertNotProdRelay('http://[::1]:18787/dashboard')).not.toThrow()
    expect(() => assertNotProdRelay('wss://relay-staging.web-of-trust.de')).not.toThrow()
  })

  it('is FAIL-CLOSED: refuses a host that is neither prod nor allowlisted', () => {
    expect(() => assertNotProdRelay('wss://relay.example.com')).toThrow(/fail-closed/)
    expect(() => assertNotProdRelay('wss://relay.web-of-trust.de.evil.com')).toThrow(/fail-closed/)
  })

  it('refuses an unparseable URL rather than passing it through', () => {
    expect(() => assertNotProdRelay('not a url')).toThrow(ProdGuardError)
  })
})
