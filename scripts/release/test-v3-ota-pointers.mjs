#!/usr/bin/env node
// Cases of the v3 live-update pointers (scripts/release/v3-ota-pointers.sh), run against a stubbed gh
// and a throw-away OTA key.
//
// WHY: the Pages deploy serves what this script picks and verifies. It must pick the highest ota-v3
// sequence across every page of the release list, not the newest by date on the first page: more than
// 100 newer other releases, or an older OTA tag published late, must neither drop the pointers nor move
// them back (#528). And it must stop on a manifest the phones would refuse: a tampered envelope, or a
// valid envelope served with another zip (#526).
//
// The stub applies the script's real --jq filter (jq) to each page and returns only the first page
// without --paginate.
//
// Run: node scripts/release/test-v3-ota-pointers.mjs   (needs openssl and jq)
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash, createSign } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCRIPT = join(HERE, 'v3-ota-pointers.sh')
const REPO = 'real-life-org/web-of-trust'
const APP = 'org.reallife.weboftrust'
const CHANNELS = ['v3-android', 'v3-ios']

let failed = 0
const check = (cond, msg, detail = '') => {
  if (cond) console.log(`  ok   ${msg}`)
  else { console.log(`  FAIL ${msg}${detail ? ` — ${detail}` : ''}`); failed++ }
}

const dir = mkdtempSync(join(tmpdir(), 'v3-ota-pointers-'))
const key = join(dir, 'key.pem')
const pub = join(dir, 'public.pem')
execFileSync('openssl', ['genpkey', '-algorithm', 'RSA', '-pkeyopt', 'rsa_keygen_bits:2048', '-out', key], { stdio: 'ignore' })
execFileSync('openssl', ['rsa', '-in', key, '-pubout', '-out', pub], { stdio: 'ignore' })
const privateKey = readFileSync(key, 'utf8')
const sign = (text) => createSign('RSA-SHA256').update(text).sign(privateKey, 'base64')

// a release ota-v3-<n> as the signing service publishes it: per channel a zip and its manifest
function release(tag, edit = () => {}) {
  const seq = Number(tag.slice('ota-v3-'.length))
  const files = {}
  for (const channel of CHANNELS) {
    const zip = Buffer.from(`zip of ${channel} in ${tag}`)
    const checksum = createHash('sha256').update(zip).digest('hex')
    const envelope = JSON.stringify({ app: APP, channel, bundleId: tag, seq, checksum, minNative: '3.2.0' })
    files[`${channel}.zip`] = zip
    files[`latest-${channel}.json`] = { envelope, envelopeSignature: sign(envelope), url: `https://github.com/${REPO}/releases/download/${tag}/${channel}.zip` }
  }
  edit(files)
  const at = join(dir, 'releases', tag)
  mkdirSync(at, { recursive: true })
  for (const [name, body] of Object.entries(files)) writeFileSync(join(at, name), Buffer.isBuffer(body) ? body : JSON.stringify(body))
}

// the stub: `gh api [--paginate] <path> --jq <filter>` answers from pages/*.json, `gh release download`
// copies from releases/<tag>/
const bin = join(dir, 'bin')
mkdirSync(bin)
writeFileSync(join(bin, 'gh'), `#!/usr/bin/env bash
set -euo pipefail
D=${JSON.stringify(dir)}
if [ "$1" = api ]; then
  [ -f "$D/api-fails" ] && { echo "HTTP 502" >&2; exit 1; }
  paginate=0; jq_filter=""
  while [ $# -gt 0 ]; do case "$1" in --paginate) paginate=1 ;; --jq) jq_filter="$2"; shift ;; esac; shift; done
  for page in "$D"/pages/*.json; do
    jq -r "$jq_filter" "$page"
    [ "$paginate" = 1 ] || break
  done
  exit 0
fi
if [ "$1" = release ] && [ "$2" = download ]; then
  tag="$3"; while [ $# -gt 0 ]; do [ "$1" = --dir ] && out="$2"; shift; done
  cp "$D/releases/$tag"/* "$out"/
  exit 0
fi
echo "unexpected gh $*" >&2; exit 1
`)
chmodSync(join(bin, 'gh'), 0o755)

// the release list, newest first by publication, 100 per page
function list(entries) {
  rmSync(join(dir, 'pages'), { recursive: true, force: true })
  mkdirSync(join(dir, 'pages'))
  for (let i = 0; i * 100 < entries.length; i++) {
    writeFileSync(join(dir, 'pages', `${String(i).padStart(3, '0')}.json`), JSON.stringify(entries.slice(i * 100, i * 100 + 100)))
  }
}
const rel = (tag_name, draft = false) => ({ tag_name, draft })
const others = (n) => Array.from({ length: n }, (_, i) => rel(`app-v3.${i}.0`))

function run() {
  const out = join(dir, 'out')
  rmSync(out, { recursive: true, force: true })
  const r = spawnSync('bash', [SCRIPT, out], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, GITHUB_REPOSITORY: REPO, OTA_PUBLIC_KEY_FILE: pub } })
  const served = Object.fromEntries(CHANNELS.map((c) => [c, existsSync(join(out, c, 'latest.json')) ? JSON.parse(readFileSync(join(out, c, 'latest.json'), 'utf8')) : null]))
  return { status: r.status, out: `${r.stdout}${r.stderr}`, served }
}
const bundleOf = (m) => (m ? JSON.parse(m.envelope).bundleId : null)

try {
  // ---- which release ------------------------------------------------------------------------------
  release('ota-v3-2')
  list([...others(150), rel('ota-v3-2')])
  let r = run()
  check(r.status === 0 && bundleOf(r.served['v3-android']) === 'ota-v3-2' && bundleOf(r.served['v3-ios']) === 'ota-v3-2', 'finds the OTA release behind more than 100 newer other releases', r.out)

  release('ota-v3-9'); release('ota-v3-10'); release('ota-v3-3')
  list([rel('ota-v3-3'), rel('ota-v3-10'), rel('ota-v3-9'), rel('ota-v3-2')])
  r = run()
  check(r.status === 0 && bundleOf(r.served['v3-android']) === 'ota-v3-10', 'takes the highest sequence, numerically (10 over 9), not a lower tag published later (3)', r.out)

  list([rel('ota-v3-11', true), rel('ota-v3-10')])
  r = run()
  check(r.status === 0 && bundleOf(r.served['v3-android']) === 'ota-v3-10', 'skips a draft', r.out)

  list([...others(3), rel('ota-v3-x'), rel('ota-gen2')])
  r = run()
  check(r.status === 0 && r.served['v3-android'] === null && /no ota-v3 release yet/.test(r.out), 'no ota-v3 release: no pointer, the deploy goes on', r.out)

  writeFileSync(join(dir, 'api-fails'), '')
  r = run()
  rmSync(join(dir, 'api-fails'))
  check(r.status !== 0 && r.served['v3-android'] === null, 'a release list that cannot be read stops the deploy (never reads as "no release")', r.out)

  // ---- what it verifies -------------------------------------------------------------------------------
  const refused = (name, edit, pattern) => {
    release('ota-v3-20', edit)
    list([rel('ota-v3-20')])
    const res = run()
    check(res.status !== 0 && res.served['v3-android'] === null && pattern.test(res.out), name, res.out)
  }
  const tamper = (from, to) => (f) => { f['latest-v3-android.json'].envelope = f['latest-v3-android.json'].envelope.replace(from, to) }
  refused('refuses a lowered minNative (envelope changed after signing)', tamper('"3.2.0"', '"3.1.0"'), /envelope signature does not verify/)
  refused('refuses a swapped channel (envelope changed after signing)', tamper('"v3-android"', '"v3-ios"'), /envelope signature does not verify/)
  refused('refuses a relabelled bundle id (envelope changed after signing)', tamper('ota-v3-20', 'ota-v3-21'), /envelope signature does not verify/)
  refused('refuses a valid Android envelope served with the iOS zip', (f) => { f['v3-android.zip'] = f['v3-ios.zip'] }, /checksum/)
  refused('refuses the iOS manifest served as the Android one', (f) => { f['latest-v3-android.json'] = f['latest-v3-ios.json'] }, /channel/)
  refused('refuses a manifest without an envelope signature', (f) => { delete f['latest-v3-android.json'].envelopeSignature }, /no signed envelope/)
  refused('refuses a manifest whose url points elsewhere', (f) => { f['latest-v3-android.json'].url = 'https://example.org/v3-android.zip' }, /url/)
} finally {
  rmSync(dir, { recursive: true, force: true })
}

console.log(failed ? `\n${failed} FAILED` : '\nall cases passed')
process.exit(failed ? 1 : 0)
