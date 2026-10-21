// Error filter audit (store launch v3, platform step B): a secret never reaches an error text, a log
// line or a diagnostic entry. Negative tests over the redaction (Secret, bytes, BIP-39 runs, URL
// fragments, DIDs, anchors, key-like strings), the closed catalog of the port's new failure codes
// (they pass unchanged and carry no content), the ErrorBoundary, the global handlers and the
// adapter's diagnostic store.
import { generateMnemonic } from '@scure/bip39'
import { wordlist } from '@scure/bip39/wordlists/english.js'
import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ErrorBoundary } from '../src/app/ErrorBoundary'
import { diagnosticLog } from '../src/adapters/rltp/diagnostics'
import { LanguageProvider } from '../src/i18n'
import { installGlobalErrorHandlers, isForeignError, MIN_WORD_RUN, redact, redactText } from '../src/lib/error-filter'
import { secret } from '../src/port'
import type { ScannerFailure } from '../src/platform/ports'

const PHRASE = 'before slab path face tennis argue various cotton profit marble educate learn'
const ANCHOR = 'u' + 'Q2xhdWRlIHJlZGFjdGlvbiB0ZXN0IGFuY2hvciB4eXo'.padEnd(43, 'A')
const DID = 'did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK'
const HEX = 'a3f1c09be47d26580b1e9f3c7d2a4b6e8f0a1c3e5d7b9f1a2c4e6d8f0b1a3c5e'

/** no run of MIN_WORD_RUN phrase words survives (words may stand alone in ordinary text) */
function leaksRun(out: string, words: readonly string[]): boolean {
  const toks = out.toLowerCase().match(/[a-z]+/g) ?? []
  for (let i = 0; i + MIN_WORD_RUN <= toks.length; i++) {
    if (toks.slice(i, i + MIN_WORD_RUN).every((t) => words.includes(t))) return true
  }
  return false
}

afterEach(() => vi.restoreAllMocks())

describe('redactText', () => {
  it('removes a full phrase in any common shape', () => {
    const w = PHRASE.split(' ')
    expect(leaksRun(PHRASE, w), 'the check itself sees a phrase').toBe(true)
    for (const s of [
      `restore failed for ${PHRASE}`,
      `words: ${JSON.stringify(w)}`,
      w.map((x, i) => `${i + 1}. ${x}`).join('\n'),
      w.join(', '),
      PHRASE.toUpperCase(),
    ]) {
      const out = redactText(s)
      expect(leaksRun(out, w), out).toBe(false)
    }
  })

  it('never leaks a run of a generated phrase (500 phrases, 12 and 24 words)', () => {
    for (let i = 0; i < 500; i++) {
      const p = generateMnemonic(wordlist, i % 2 ? 256 : 128)
      const out = redactText(`Error: seed check failed: "${p}" at step ${i}`)
      expect(leaksRun(out, p.split(' ')), out).toBe(false)
    }
  })

  it('removes fragments, DIDs, anchors, hex and base64 keys', () => {
    const out = redactText(
      `open https://web-of-trust.de/v#c=AbCdEf012345xyz and ${DID} anchor ${ANCHOR} mac ${HEX} key ${btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, i) => i * 7)))}`,
    )
    expect(out).not.toContain('AbCdEf012345xyz')
    expect(out).not.toContain('z6Mk')
    expect(out).not.toContain(ANCHOR)
    expect(out).not.toContain(HEX)
    expect(out).toContain('#[fragment]')
    expect(out).toContain('[did]')
  })

  it('keeps codes and ordinary messages readable', () => {
    for (const s of [
      'holder-close-timeout',
      'contact-order-invalid-journal',
      'share-dir:unverifiable',
      'core refused with log-diverged',
      'opening wot-v3-holder-n3f9c is blocked',
      'Cannot read properties of undefined (reading foo)',
      'LIFECYCLE.md',
      'CONTACT-ORDER.md',
    ]) {
      expect(redactText(s)).toBe(s)
    }
  })
})

describe('redact (values)', () => {
  it('a Secret, bytes and their nesting never show content', () => {
    const words = secret(PHRASE.split(' '))
    const pass = secret('canary-passphrase-8f3e2c1a')
    const ikm = new Uint8Array(64).fill(0xab)
    const v = { words, pass, ikm, buf: ikm.buffer, list: [words, ikm], nested: { deeper: { pass } } }
    const out = redact(v)
    expect(out).not.toContain('canary-passphrase')
    expect(out).not.toMatch(/\b171\b|ab,ab|abab/)
    expect(leaksRun(out, PHRASE.split(' '))).toBe(false)
    expect(out).toContain('[bytes:64]')
  })

  it('an error, its cause chain and a throwing getter', () => {
    const cause = new Error(`vault open failed for ${DID}`, { cause: new Uint8Array(32) })
    const e = new Error(`restore with ${PHRASE}`, { cause })
    const out = redact(e)
    expect(leaksRun(out, PHRASE.split(' '))).toBe(false)
    expect(out).not.toContain('z6Mk')
    expect(out).toContain('[bytes:32]')
    const trap = Object.defineProperty({}, 'x', {
      enumerable: true,
      get() {
        throw new Error(PHRASE)
      },
    })
    expect(redact(trap)).toBe('[redacted]')
  })

  it('cycles end', () => {
    const a: Record<string, unknown> = {}
    a.self = a
    expect(redact(a)).toContain('[cycle]')
  })
})

describe('port failure codes (closed catalog)', () => {
  // every new failure code of the platform step: the filter keeps it, and it is a code, not a text
  const SCANNER: Record<ScannerFailure, true> = {
    'camera-unavailable': true,
    'camera-busy': true,
    'camera-failed': true,
    'scanner-no-target': true,
    'scanner-load-failed': true,
  }
  const DIAGNOSTIC = ['holder-close-timeout', 'contact-order-invalid-journal']
  const SURVIVOR = ['share-dir:unverifiable']
  it.each([...Object.keys(SCANNER), ...DIAGNOSTIC, ...SURVIVOR])('%s is a bare code and passes unchanged', (code) => {
    expect(code).toMatch(/^[a-z]+(-[a-z]+)*(:[a-z]+)?$/)
    expect(redactText(code)).toBe(code)
  })
})

describe('diagnostic store', () => {
  it('stores code, ref and detail redacted', () => {
    const log = diagnosticLog(() => 'd1')
    log.record({ at: 1, code: 'holder-close-timeout', ref: 'LIFECYCLE.md', detail: `anchor ${ANCHOR} words ${PHRASE}` })
    const [e] = log.list()
    expect(e?.code).toBe('holder-close-timeout')
    expect(e?.ref).toBe('LIFECYCLE.md')
    expect(e?.detail).not.toContain(ANCHOR)
    expect(leaksRun(e?.detail ?? '', PHRASE.split(' '))).toBe(false)
  })
})

describe('ErrorBoundary', () => {
  it('shows the crash screen and logs only the redacted error', () => {
    const logs: string[] = []
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
      logs.push(a.map((x) => (typeof x === 'string' ? x : redact(x))).join(' '))
    })
    function Boom(): never {
      throw new Error(`render failed with ${PHRASE} and ${DID}`)
    }
    render(
      <LanguageProvider lang="en">
        <ErrorBoundary>
          <Boom />
        </ErrorBoundary>
      </LanguageProvider>,
    )
    expect(screen.getByRole('alert')).toBeTruthy()
    const ours = logs.filter((l) => l.startsWith('[wot] render'))
    expect(ours).toHaveLength(1)
    expect(leaksRun(ours[0]!, PHRASE.split(' '))).toBe(false)
    expect(ours[0]).not.toContain('z6Mk')
  })
})

describe('global handlers', () => {
  it('log the app\'s own errors redacted and suppress the raw report; foreign ones untouched', () => {
    const target = new EventTarget()
    const logs: string[] = []
    vi.spyOn(console, 'error').mockImplementation((s: unknown) => void logs.push(String(s)))
    const off = installGlobalErrorHandlers(target as unknown as Window)
    const own = new ErrorEvent('error', { cancelable: true, message: 'x', error: new Error(`failed: ${PHRASE}`) })
    target.dispatchEvent(own)
    expect(own.defaultPrevented).toBe(true)
    expect(logs).toHaveLength(1)
    expect(leaksRun(logs[0]!, PHRASE.split(' '))).toBe(false)

    const foreign = new ErrorEvent('error', { cancelable: true, message: "Can't find variable: __firefox__" })
    target.dispatchEvent(foreign)
    expect(foreign.defaultPrevented).toBe(false)

    const rej = new Event('unhandledrejection', { cancelable: true }) as Event & { reason: unknown }
    Object.defineProperty(rej, 'reason', { value: new Error(`rejected ${HEX}`) })
    target.dispatchEvent(rej)
    expect(rej.defaultPrevented).toBe(true)
    expect(logs[1]).not.toContain(HEX)
    off()
  })

  it('isForeignError keeps the legacy cases', () => {
    expect(isForeignError("Can't find variable: __firefox__", true)).toBe(true)
    expect(isForeignError('Script error.', false)).toBe(true)
    expect(isForeignError('Script error.', true)).toBe(false)
    expect(isForeignError('Cannot read properties of undefined', true)).toBe(false)
  })
})
