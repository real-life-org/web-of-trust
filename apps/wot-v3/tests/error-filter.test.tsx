// Error filter audit (store launch v3, platform step B): a secret never reaches an error text, a log
// line or a diagnostic entry. Negative tests over the redaction (Secret, bytes, BIP-39 runs, URL
// fragments, DIDs, anchors, key-like strings), the closed catalog of the port's new failure codes
// (they pass unchanged and carry no content), the ErrorBoundary, the global handlers and the
// adapter's diagnostic store.
import { generateMnemonic } from '@scure/bip39'
import { wordlist } from '@scure/bip39/wordlists/english.js'
import { act, within } from '@testing-library/react'
import { createRoot } from 'react-dom/client'
import { ROOT_OPTIONS } from '../src/app/root-options'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ErrorBoundary } from '../src/app/ErrorBoundary'
import { diagnosticLog } from '../src/adapters/rltp/diagnostics'
import { LanguageProvider } from '../src/i18n'
import { installGlobalErrorHandlers, isForeignError, MIN_WORD_RUN, redact, redactedStack, redactText, UNPRINTABLE } from '../src/lib/error-filter'
import { shareTransport, type TransportHandlers } from '../src/adapters/rltp/transport'
import { writableStore } from '../src/port'
import { virtualClock } from '../src/platform/fake'
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

  it('a phrase with any non-letter separator, in a message, a stack line and a diagnostic entry (review 434 S2)', () => {
    const w = PHRASE.split(' ')
    for (const sep of ['/', '|', '_', '+', '\\', '~', '*', '&', '=', '>', ' / ', '__', '%20']) {
      const joined = w.join(sep)
      expect(leaksRun(redactText(`restore failed: ${joined}`), w), sep).toBe(false)
      const e = new Error('x')
      e.stack = `Error: x\n    at restore (http://localhost/${joined}/app.js:1:2)\n    at ${joined}@http://localhost/app.js:3:4`
      expect(leaksRun(redactedStack(e) ?? '', w), sep).toBe(false)
      const log = diagnosticLog(() => 'd')
      log.record({ at: 1, code: 'holder-close-timeout', detail: joined, ref: joined })
      expect(leaksRun(JSON.stringify(log.list()), w), sep).toBe(false)
    }
  })

  it('hex without digits, base64 of equal bytes and short fragments (review 434 S5)', () => {
    const hexLetters = 'ab'.repeat(32)
    const b64Equal = btoa(String.fromCharCode(...new Array(32).fill(0)))
    const b64uEqual = b64Equal.replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')
    const out = redactText(`mac ${hexLetters} key ${b64Equal} raw ${b64uEqual} link https://x.de/v#abc`)
    expect(out).not.toContain(hexLetters)
    expect(out).not.toContain(b64Equal.slice(0, 32))
    expect(out).not.toContain('#abc')
    // a run of one lowercase letter decodes to 32 bytes as well (review 434 S15)
    expect(redactText(`k ${'g'.repeat(43)}`)).not.toContain('g'.repeat(32))
  })

  it('a shortened did:key (four characters, an ellipsis, four characters) stays readable; any longer cut is redacted (diagnostics of the displayed card, VTI 0.26 §1c)', () => {
    expect(redactText('sender did:key:z6Mk…2doK')).toBe('sender did:key:z6Mk…2doK')
    expect(redactText(`sender ${DID}`)).toBe('sender [did]')
    expect(redactText('sender did:key:z6MkhaXg…2doK')).not.toContain('z6MkhaXg')
    expect(redactText(`sender did:key:z6Mk…${DID.slice(-40)}`)).not.toContain(DID.slice(-40))
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

  it('revealed values: a passphrase in an error message, a word list as an array (review 434 S1)', () => {
    const pass = secret('canary-passphrase-8f3e2c1a')
    const words = secret(PHRASE.split(' '))
    expect(redact(new Error(`wrong password ${pass.reveal()}`))).not.toContain('canary-passphrase')
    expect(redactText(`typed ${pass.reveal()}!`)).not.toContain('8f3e2c1a')
    expect(leaksRun(redact(words.reveal()), PHRASE.split(' '))).toBe(false)
    expect(leaksRun(redact({ list: words.reveal().map((x) => ` ${x.toUpperCase()} `) }), PHRASE.split(' '))).toBe(false)
    expect(leaksRun(redact(new Error('bad', { cause: words.reveal() })), PHRASE.split(' '))).toBe(false)
    // a shorter live secret that is a prefix of a longer one does not cut it (review 434 S12)
    const short = secret('myprivate')
    const long = secret('myprivate-password-value')
    const out = redactText(`typed ${long.reveal()} after ${short.reveal()}`)
    expect(out).not.toContain('password-value')
    expect(out).not.toContain('myprivate')
    // words split over nested arrays or numbered fields (review 434 S13)
    const w = PHRASE.split(' ')
    const pairs = [0, 2, 4, 6, 8, 10].map((i) => [w[i], w[i + 1]])
    expect(leaksRun(redact(pairs), w)).toBe(false)
    expect(leaksRun(redact(Object.fromEntries(w.map((x, i) => [i + 1, x]))), w)).toBe(false)
    expect(leaksRun(redact({ a: [w[0], w[1]], b: [w[2]], c: { d: [w[3], w[4]] } }), w)).toBe(false)
    // arrays of ordinary values and word pairs stay readable (three list words in a row do not)
    expect(redact(['open', 'close', 42, 'xyz'])).toBe('[open, close, 42, xyz]')
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
  it('keeps a catalog code, stores anything else as unknown-code (review 434 S14)', () => {
    const log = diagnosticLog(() => 'd1')
    log.record({ at: 1, code: 'contact-order-invalid-journal' })
    for (const code of ['key-target-open', PHRASE.split(' ').join('-'), 'ab'.repeat(32), `failed ${PHRASE}`]) log.record({ at: 2, code: code as never })
    const [a, ...rest] = log.list()
    expect(a?.code).toBe('contact-order-invalid-journal')
    expect(log.read('d1' as never)?.code).toBe('contact-order-invalid-journal')
    expect(rest.map((e) => e.code)).toEqual(['unknown-code', 'unknown-code', 'unknown-code', 'unknown-code'])
  })

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

/** every console call with its arguments as they were passed, as text (an error with its stack) */
function captureConsole(): string[] {
  const raw: string[] = []
  const text = (x: unknown): string => {
    if (x instanceof Error) return `${x.message}\n${x.stack ?? ''}${x.cause !== undefined ? `\n${text(x.cause)}` : ''}`
    if (typeof x === 'string') return x
    try {
      return JSON.stringify(x) ?? String(x)
    } catch {
      return String(x)
    }
  }
  for (const m of ['error', 'warn', 'log', 'info', 'debug'] as const) {
    vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void raw.push(a.map(text).join(' ')))
  }
  return raw
}

describe('ErrorBoundary', () => {
  it('through the entry\'s root options: crash screen, and no console call carries the secret', async () => {
    const raw = captureConsole()
    function Boom(): never {
      throw new Error(`render failed with ${PHRASE} and ${DID}`)
    }
    const el = document.createElement('div')
    document.body.append(el)
    const root = createRoot(el, ROOT_OPTIONS)
    await act(async () => {
      root.render(
        <LanguageProvider lang="en">
          <ErrorBoundary>
            <Boom />
          </ErrorBoundary>
        </LanguageProvider>,
      )
    })
    expect(within(el).getByRole('alert')).toBeTruthy()
    expect(raw.filter((l) => l.startsWith('[wot] render'))).toHaveLength(1)
    for (const l of raw) {
      expect(leaksRun(l, PHRASE.split(' ')), l).toBe(false)
      expect(l).not.toContain('z6Mk')
    }
    act(() => root.unmount())
    el.remove()
  })
})

describe('global handlers', () => {
  it('log every error redacted and suppress the raw report; foreign ones under their own context', () => {
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
    expect(foreign.defaultPrevented).toBe(true)
    expect(logs[1]).toMatch(/^\[wot\] foreign: /)

    const rej = new Event('unhandledrejection', { cancelable: true }) as Event & { reason: unknown }
    Object.defineProperty(rej, 'reason', { value: new Error(`rejected ${HEX}`) })
    target.dispatchEvent(rej)
    expect(rej.defaultPrevented).toBe(true)
    expect(logs[2]).not.toContain(HEX)

    // a marker substring cannot let an own error with a secret pass in clear
    const marked = new ErrorEvent('error', { cancelable: true, message: 'x', error: new Error(`__brave ${PHRASE}`) })
    target.dispatchEvent(marked)
    expect(marked.defaultPrevented).toBe(true)
    expect(leaksRun(logs[3]!, PHRASE.split(' '))).toBe(false)

    // a rejection with a non-Error reason keeps its message for the foreign check
    const objRej = new Event('unhandledrejection', { cancelable: true }) as Event & { reason: unknown }
    Object.defineProperty(objRej, 'reason', { value: { message: '__firefox__ is not defined' } })
    target.dispatchEvent(objRej)
    expect(objRej.defaultPrevented).toBe(true)
    expect(logs[4]).toMatch(/^\[wot\] foreign rejection: /)

    // a throwing message getter does not leave the raw report standing (review 434 S16)
    const trapRej = new Event('unhandledrejection', { cancelable: true }) as Event & { reason: unknown }
    const trap = Object.defineProperty({}, 'message', {
      enumerable: true,
      get() {
        throw new Error('trap')
      },
    })
    Object.defineProperty(trapRej, 'reason', { value: trap })
    expect(() => target.dispatchEvent(trapRej)).not.toThrow()
    expect(trapRej.defaultPrevented).toBe(true)

    // proxies whose traps throw, and a revoked proxy: suppressed, logged as a fixed text (review 434 S17)
    const trapping = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error(`proxy-trap ${PHRASE}`)
        },
        ownKeys() {
          throw new Error(`proxy-trap ${PHRASE}`)
        },
      },
    )
    const { proxy: revoked, revoke } = Proxy.revocable({}, {})
    revoke()
    for (const reason of [trapping, revoked]) {
      const ev = new Event('unhandledrejection', { cancelable: true }) as Event & { reason: unknown }
      Object.defineProperty(ev, 'reason', { value: reason })
      const before = logs.length
      expect(() => target.dispatchEvent(ev)).not.toThrow()
      expect(ev.defaultPrevented).toBe(true)
      expect(logs.length).toBe(before + 1)
      expect(logs.at(-1)).toBe(`[wot] unhandled rejection: ${UNPRINTABLE}`)
    }
    off()
  })

  it('isForeignError keeps the legacy cases', () => {
    expect(isForeignError("Can't find variable: __firefox__", true)).toBe(true)
    expect(isForeignError('Script error.', false)).toBe(true)
    expect(isForeignError('Script error.', true)).toBe(false)
    expect(isForeignError('Cannot read properties of undefined', true)).toBe(false)
  })
})

describe('other diagnostic paths (review 434 S3)', () => {
  it('the shared transport keeps a carrier throw only redacted in faults()', () => {
    const shared = shareTransport(
      {
        status: writableStore({ network: 'online' as const, carrier: 'connected' as const }),
        start() {
          throw new Error(`carrier refused ${PHRASE} for ${DID}`)
        },
        stop() {},
        submit() {},
        withdraw() {},
      },
      virtualClock(0, 'UTC'),
    )
    const handlers: TransportHandlers = { envelope: async () => 'taken', report() {} }
    const lease = shared.lease()
    lease.start(handlers)
    lease.activate()
    const faults = JSON.stringify(shared.faults())
    expect(shared.faults().length).toBeGreaterThan(0)
    expect(leaksRun(faults, PHRASE.split(' '))).toBe(false)
    expect(faults).not.toContain('z6Mk')
  })
})
