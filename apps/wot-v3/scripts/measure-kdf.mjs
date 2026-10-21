#!/usr/bin/env node
// Unlock cost of the vault (architecture §5.2 "Laufzeit"): PBKDF2-HMAC-SHA-256 with the target
// rounds, then AES-256-GCM decrypt of a payload of the vault's size, the same WebCrypto calls as
// open() in src/platform/seed-vault/format.ts.
//
// Usage: node scripts/measure-kdf.mjs [--runs 7] [--iterations 600000] [--json]
//   env WOT_CHROME_PATH=<chromium binary> for the browser rows (otherwise Playwright's own Chromium)
//
// Rows:
//   node            Node's WebCrypto (BoringSSL/OpenSSL, native code)
//   chromium 1x     Chromium on this machine, no throttling
//   chromium 4x/6x  Chromium with CDP CPU throttling (Emulation.setCPUThrottlingRate) as the stand-in
//                   for slow phones the brief asks for. A control loop in plain JavaScript on the main
//                   thread shows whether the throttling took effect at all: WebCrypto runs in native
//                   code off the main thread, so the throttling may not reach it (see the output).
//   node, no SHA ext.  Node with the x86 SHA extensions masked (OPENSSL_ia32cap): software SHA-256,
//                   the closer stand-in for a CPU without SHA instructions (x86 only)
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { arch } from 'node:os'
import { fileURLToPath } from 'node:url'
import { webcrypto } from 'node:crypto'
import { chromium } from '@playwright/test'

const args = process.argv.slice(2)
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? Number(args[i + 1]) : fallback
}
const RUNS = arg('runs', 7)
const ITERATIONS = arg('iterations', 600_000)
const JSON_OUT = args.includes('--json')

/** one unlock: import, derive, decrypt; returns ms. Serialised into the page as source. */
async function unlockOnce(subtle, iterations) {
  const enc = new TextEncoder()
  const password = enc.encode('correct horse battery staple')
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const aad = enc.encode('{"aead":"AES-256-GCM","format":"wot-v3-vault"}')
  const payload = crypto.getRandomValues(new Uint8Array(150))
  // the record is sealed with a cheap key derivation outside the measurement
  const sealBase = await subtle.importKey('raw', password, 'PBKDF2', false, ['deriveKey'])
  const sealKey = await subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, sealBase, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 }, sealKey, payload)
  const t0 = performance.now()
  const base = await subtle.importKey('raw', password, 'PBKDF2', false, ['deriveKey'])
  const key = await subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base, { name: 'AES-GCM', length: 256 }, false, ['decrypt'])
  await subtle.decrypt({ name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 }, key, ct)
  return performance.now() - t0
}

/** plain-JS control on the main thread: ~ fixed amount of work, returns ms */
function controlOnce() {
  const t0 = performance.now()
  let h = 0x811c9dc5
  for (let i = 0; i < 20_000_000; i++) h = Math.imul(h ^ i, 0x01000193)
  if (h === 42) console.log('')
  return performance.now() - t0
}

const stats = (xs) => {
  const s = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  // an even count: the mean of the two middle samples
  const median = s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2
  return { median, min: s[0], max: s[s.length - 1] }
}

async function measureNode() {
  globalThis.crypto ??= webcrypto
  const runs = []
  await unlockOnce(webcrypto.subtle, ITERATIONS) // warm-up
  for (let i = 0; i < RUNS; i++) runs.push(await unlockOnce(webcrypto.subtle, ITERATIONS))
  return { unlock: stats(runs), control: stats([controlOnce(), controlOnce(), controlOnce()]) }
}

async function measureBrowser(page, cdp, rate) {
  await cdp.send('Emulation.setCPUThrottlingRate', { rate })
  const unlockSrc = unlockOnce.toString()
  const controlSrc = controlOnce.toString()
  return page.evaluate(
    async ({ unlockSrc, controlSrc, runs, iterations }) => {
      const unlock = new Function(`return (${unlockSrc})`)()
      const control = new Function(`return (${controlSrc})`)()
      await unlock(crypto.subtle, iterations)
      const u = []
      for (let i = 0; i < runs; i++) u.push(await unlock(crypto.subtle, iterations))
      const c = [control(), control(), control()]
      return { u, c }
    },
    { unlockSrc, controlSrc, runs: RUNS, iterations: ITERATIONS },
  )
}

if (args.includes('--node-only')) {
  console.log(JSON.stringify(await measureNode()))
  process.exit(0)
}

const server = createServer((_, res) => {
  res.writeHead(200, { 'content-type': 'text/html' })
  res.end('<!doctype html><title>kdf</title>')
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const url = `http://localhost:${server.address().port}/`

const rows = []
const node = await measureNode()
rows.push({ env: `node ${process.version}`, rate: 1, ...node })
if (arch() === 'x64') {
  // bit 29 of the second capability word: SHA extensions (CPUID leaf 7, EBX)
  const out = execFileSync(process.execPath, [fileURLToPath(import.meta.url), '--node-only', '--runs', String(RUNS), '--iterations', String(ITERATIONS)], {
    env: { ...process.env, OPENSSL_ia32cap: ':~0x20000000' },
    encoding: 'utf8',
  })
  rows.push({ env: 'node, no SHA ext.', rate: 1, ...JSON.parse(out) })
}

const executablePath = process.env.WOT_CHROME_PATH
const browser = await chromium.launch(executablePath ? { executablePath } : {})
try {
  const page = await browser.newPage()
  await page.goto(url)
  const cdp = await page.context().newCDPSession(page)
  for (const rate of [1, 4, 6]) {
    const r = await measureBrowser(page, cdp, rate)
    rows.push({ env: `chromium ${browser.version()}`, rate, unlock: stats(r.u), control: stats(r.c) })
  }
} finally {
  await browser.close()
  server.close()
}

const base = rows.find((r) => r.env.startsWith('chromium') && r.rate === 1)
if (JSON_OUT) {
  console.log(JSON.stringify({ iterations: ITERATIONS, runs: RUNS, rows }, null, 2))
} else {
  const f = (n) => n.toFixed(0).padStart(6)
  console.log(`PBKDF2-HMAC-SHA-256 ${ITERATIONS} rounds + AES-256-GCM decrypt, ${RUNS} runs each (ms)`)
  console.log('env                         rate  unlock median   min    max | JS control median  ×base')
  for (const r of rows) {
    const factor = base && r.env.startsWith('chromium') ? (r.control.median / base.control.median).toFixed(1) : '  -'
    console.log(`${r.env.padEnd(27)} ${String(r.rate).padStart(3)}x ${f(r.unlock.median)} ${f(r.unlock.min)} ${f(r.unlock.max)} | ${f(r.control.median)}        ${factor}`)
  }
}
