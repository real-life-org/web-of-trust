// Error filter (architecture §2.4, §2.6, §5 "redaction"; legacy apps/demo/src/error-filter.ts).
//
// Two jobs:
// 1. Redaction. Whatever leaves the app as text, in an error log, a diagnostic entry or the crash
//    path, goes through redact()/redactText() first: Secret boxes and the text of every live string
//    Secret (also after reveal()), byte arrays, BIP-39 word runs (English list, any separator that is
//    not a letter, also as array elements), URL fragments, DIDs, anchors and other long key-like
//    strings (base64url, base64, hex) never appear in clear. Redaction over-approximates on purpose:
//    a long random-looking token in a stack path is lost before a key could pass. Single list words
//    and pairs stay (MIN_WORD_RUN): ordinary English is full of them.
// 2. Foreign errors (legacy isForeignError): browser-injected scripts on iOS and detail-free
//    cross-origin "Script error." are not the app failing; they are logged under their own context.
//    The browser's raw report is suppressed for every error, foreign or not, since a substring
//    cannot prove where an error came from.
//
// Pure apart from logError/installGlobalErrorHandlers, which write to the console.
import { wordlist } from '@scure/bip39/wordlists/english.js'
import { isSecret, liveSecretTexts } from '../port/secret'

export const REDACTED = '[redacted]'

const BIP39 = new Set(wordlist)
/** a run of this many list words in a row counts as part of a phrase */
export const MIN_WORD_RUN = 3

/** separators allowed between the words of a run: anything that is not a letter */
const RUN_GAP = /^[^A-Za-z]+$/
/** a revealed string Secret shorter than this is not searched for (it would hit ordinary words) */
const MIN_SECRET_TEXT = 6

function redactWordRuns(s: string): string {
  const tokens = [...s.matchAll(/[A-Za-z]+/g)]
  const spans: [number, number][] = []
  let start = -1
  let count = 0
  let end = 0
  const close = () => {
    if (count >= MIN_WORD_RUN) spans.push([start, end])
    start = -1
    count = 0
  }
  for (const m of tokens) {
    const word = m[0].toLowerCase()
    const at = m.index
    if (!BIP39.has(word)) {
      close()
      continue
    }
    if (count > 0 && !RUN_GAP.test(s.slice(end, at))) close()
    if (count === 0) start = at
    count++
    end = at + m[0].length
  }
  close()
  let out = s
  for (const [a, b] of spans.reverse()) out = `${out.slice(0, a)}[words]${out.slice(b)}`
  return out
}

/** A token of at least 32 base64/base64url/hex characters is a key unless it is lowercase words
 *  joined by '-', '_' or '/' (a code or a path); hex is always a key, also without digits. */
function keyLike(t: string): boolean {
  if (/^[0-9a-fA-F]+$/.test(t)) return true
  return !/^\/?[a-z]+(?:[-_/][a-z]+)*\/?$/.test(t)
}

function redactLiveSecrets(s: string): string {
  let out = s
  for (const v of liveSecretTexts()) if (v.length >= MIN_SECRET_TEXT && out.includes(v)) out = out.split(v).join(REDACTED)
  return out
}

/** Redacts secrets-shaped content from a text. Codes like `holder-close-timeout` pass unchanged. */
export function redactText(s: string): string {
  return redactWordRuns(
    redactLiveSecrets(s)
      // URL fragments carry codes and invitations (§5.3): everything after '#' up to a delimiter
      .replace(/#[^\s"'<>)\]}]+/g, '#[fragment]')
      .replace(/\bdid:[a-z0-9]+:[A-Za-z0-9._%:-]+/g, '[did]')
      .replace(/[A-Za-z0-9+/_=-]{32,}/g, (t) => (keyLike(t) ? '[key]' : t)),
  )
}

/** one array element that is a single list word, the shape of a revealed word list */
function isListWord(v: unknown): boolean {
  return typeof v === 'string' && BIP39.has(v.trim().toLowerCase())
}

/** Array elements as redacted text, with runs of MIN_WORD_RUN or more single list words as one
 *  '[words]' (each element alone is below the word-run threshold); at most MAX_ITEMS of them, and
 *  whether more were left out. */
function redactItems(items: readonly unknown[], depth: number, seen: WeakSet<object>): { out: string[]; more: boolean } {
  const out: string[] = []
  let i = 0
  while (i < items.length && out.length < MAX_ITEMS) {
    let j = i
    while (j < items.length && isListWord(items[j])) j++
    if (j - i >= MIN_WORD_RUN) {
      out.push('[words]')
      i = j
    } else {
      out.push(redactValue(items[i], depth + 1, seen))
      i++
    }
  }
  return { out, more: i < items.length }
}

const MAX_DEPTH = 4
const MAX_ITEMS = 20

/** Any value as redacted text: never the content of a Secret or of bytes. */
export function redact(value: unknown): string {
  return redactValue(value, 0, new WeakSet())
}

function redactValue(v: unknown, depth: number, seen: WeakSet<object>): string {
  if (isSecret(v)) return REDACTED
  if (typeof v === 'string') return redactText(v)
  if (v === null || v === undefined || typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v)
  if (typeof v === 'symbol') return redactText(v.toString())
  if (typeof v === 'function') return '[function]'
  if (ArrayBuffer.isView(v)) return `[bytes:${v.byteLength}]`
  if (v instanceof ArrayBuffer) return `[bytes:${v.byteLength}]`
  if (typeof v !== 'object') return REDACTED
  if (seen.has(v)) return '[cycle]'
  if (depth >= MAX_DEPTH) return '[…]'
  seen.add(v)
  try {
    if (v instanceof Error) {
      const head = `${redactText(v.name)}: ${redactText(v.message)}`
      return 'cause' in v && v.cause !== undefined ? `${head} (cause: ${redactValue(v.cause, depth + 1, seen)})` : head
    }
    if (Array.isArray(v)) {
      const { out, more } = redactItems(v, depth, seen)
      return `[${out.join(', ')}${more ? ', …' : ''}]`
    }
    const entries = Object.keys(v)
      .slice(0, MAX_ITEMS)
      .map((k) => `${redactText(k)}: ${redactValue((v as Record<string, unknown>)[k], depth + 1, seen)}`)
    return `{${entries.join(', ')}}`
  } catch {
    // a throwing getter or proxy: nothing of it is shown
    return REDACTED
  }
}

/** The stack of an error, redacted line by line, without its message line (that is in redact()). */
export function redactedStack(e: unknown): string | null {
  if (!(e instanceof Error) || typeof e.stack !== 'string') return null
  return e.stack
    .split('\n')
    .filter((l) => /^\s+at |@/.test(l))
    .map(redactText)
    .join('\n')
}

/** The one way the app writes an error to the console. */
export function logError(context: string, e: unknown): void {
  const stack = redactedStack(e)
  console.error(`[wot] ${context}: ${redact(e)}${stack ? `\n${stack}` : ''}`)
}

const INJECTED_GLOBAL_MARKERS = /__firefox__|__gCrWeb|__brave|webkit\.messageHandlers/

/** Legacy guard: errors of browser-injected scripts and detail-free cross-origin errors. */
export function isForeignError(message: string | undefined, hasErrorObject: boolean): boolean {
  const msg = message ?? ''
  if (!hasErrorObject && (msg === '' || msg === 'Script error.')) return true
  return INJECTED_GLOBAL_MARKERS.test(msg)
}

/** the message of a rejection reason: an Error's, a string, or a string `message` field */
function reasonMessage(reason: unknown): string {
  if (reason instanceof Error) return reason.message
  if (reason == null) return ''
  if (typeof reason === 'string') return reason
  if (typeof reason === 'object' && 'message' in reason && typeof reason.message === 'string') return reason.message
  return 'non-error rejection'
}

/** Uncaught errors and rejections are logged redacted instead of the browser's raw report
 *  (preventDefault suppresses it); foreign ones under their own context, not as the app's failure.
 *  Returns the uninstaller. */
export function installGlobalErrorHandlers(target: Pick<Window, 'addEventListener' | 'removeEventListener'>): () => void {
  const onError = (e: ErrorEvent) => {
    const foreign = isForeignError(e.message, e.error != null)
    e.preventDefault()
    logError(foreign ? 'foreign' : 'uncaught', e.error ?? e.message)
  }
  const onRejection = (e: PromiseRejectionEvent) => {
    const reason: unknown = e.reason
    const foreign = isForeignError(reasonMessage(reason), reason instanceof Error)
    e.preventDefault()
    logError(foreign ? 'foreign rejection' : 'unhandled rejection', reason)
  }
  target.addEventListener('error', onError)
  target.addEventListener('unhandledrejection', onRejection)
  return () => {
    target.removeEventListener('error', onError)
    target.removeEventListener('unhandledrejection', onRejection)
  }
}
