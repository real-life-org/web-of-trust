#!/usr/bin/env node
// Cases of the Gen-2 OTA decision (scripts/release/gen2-ota-needed.sh), the Pages 404 fallback
// (scripts/release/pages-404.html) and the Pages contract of .github/workflows/deploy.yml.
//
// WHY: deploy.yml builds the whole GitHub Pages site (landing, Gen-2 demo, benchmark, the v3 web app at
// /app/) and published new Gen-2 OTA bundles on every run, so a landing or v3 merge handed the Gen-2
// apps an update without content. The decision compares against the commit of the OTA bundle that is
// live (its bundleId in the live latest.json), not against the previous push: a cancelled or failed
// deploy leaves the live pointer where it was, and the next deploy still sees every change since
// (review of #499). Each case runs here against a throw-away git repository and local pointer files.
//
// Run: node scripts/release/test-gen2-ota-needed.mjs
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCRIPT = join(HERE, 'gen2-ota-needed.sh')
const DEPLOY = readFileSync(join(HERE, '..', '..', '.github', 'workflows', 'deploy.yml'), 'utf8')
const CHANNELS = ['ios', 'android', 'android-foss', 'android-box']

let failed = 0
const ok = (msg) => console.log(`  ok   ${msg}`)
const fail = (msg, detail = '') => { console.log(`  FAIL ${msg}${detail ? ` — ${detail}` : ''}`); failed++ }
const check = (cond, msg, detail) => (cond ? ok(msg) : fail(msg, detail))

// ---- the decision ----------------------------------------------------------------------------------
const repo = mkdtempSync(join(tmpdir(), 'gen2-ota-'))
const pointers = mkdtempSync(join(tmpdir(), 'gen2-ota-pointers-'))
const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const commit = (file, text) => {
  mkdirSync(join(repo, dirname(file)), { recursive: true })
  writeFileSync(join(repo, file), text)
  git('add', '-A')
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', file)
  return git('rev-parse', 'HEAD')
}
/** the live pointers: every channel names `ids[channel]` (or one id for all); null = no file */
function live(ids) {
  rmSync(pointers, { recursive: true, force: true })
  for (const ch of CHANNELS) {
    const id = typeof ids === 'object' && ids !== null ? ids[ch] : ids
    if (id === null || id === undefined) continue
    mkdirSync(join(pointers, ch), { recursive: true })
    writeFileSync(join(pointers, ch, 'latest.json'), JSON.stringify({ bundleId: id, url: `https://example.org/bundle-${ch}-${id}.zip` }))
  }
}
const short = (sha) => sha.slice(0, 7)
function run(event, head) {
  try {
    const out = execFileSync('bash', [SCRIPT, event, head], { cwd: repo, encoding: 'utf8', env: { ...process.env, OTA_POINTER_BASE: `file://${pointers}` }, stdio: ['ignore', 'pipe', 'pipe'] })
    return { code: 0, out }
  } catch (err) {
    return { code: err.status ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` }
  }
}
const needed = (r) => /^needed=(true|false)$/m.exec(r.out)?.[1]

try {
  git('init', '-q')
  const delivered = commit('README.md', 'x')
  const v3 = commit('apps/wot-v3/src/a.ts', '1')
  const landing = commit('apps/landing/src/b.jsx', '1')

  live(short(delivered))
  check(needed(run('push', landing)) === 'false', 'only v3 and landing changes since the live bundle: no Gen-2 OTA')

  const demo = commit('apps/demo/src/c.ts', '1')
  const v3after = commit('apps/wot-v3/src/a.ts', '2')
  // the deploy of `demo` was cancelled: the live pointer still names `delivered`
  check(needed(run('push', v3after)) === 'true', 'a demo change whose deploy was cancelled is published by the next v3 push')
  live(short(demo))
  check(needed(run('push', v3after)) === 'false', 'once the demo change is live, the v3 push after it publishes nothing')

  for (const [file, what] of [['packages/wot-core/src/d.ts', 'wot-core'], ['packages/adapter-yjs/src/e.ts', 'adapter-yjs'], ['packages/adapter-automerge/src/f.ts', 'adapter-automerge'], ['pnpm-lock.yaml', 'the lockfile'], ['package.json', 'the root package.json'], ['pnpm-workspace.yaml', 'the workspace file']]) {
    const before = git('rev-parse', 'HEAD')
    live(short(before))
    const head = commit(file, `${what} ${Date.now()}`)
    check(needed(run('push', head)) === 'true', `a change in ${what} since the live bundle publishes the Gen-2 OTA`)
  }

  const head = git('rev-parse', 'HEAD')
  live(short(head))
  check(needed(run('push', head)) === 'false', 'nothing since the live bundle: no Gen-2 OTA')
  check(needed(run('workflow_dispatch', head)) === 'true', 'a dispatch (rollback, manual deploy) always publishes')
  live({ ios: short(head), android: short(head), 'android-foss': short(delivered), 'android-box': short(head) })
  check(needed(run('push', head)) === 'true', 'channels that name different bundles: publish')
  live({ ios: short(head), android: short(head), 'android-foss': short(head), 'android-box': null })
  check(needed(run('push', head)) === 'true', 'a channel without a live pointer: publish')
  live('deadbee')
  check(needed(run('push', head)) === 'true', 'a live bundle whose commit is not in the clone: publish')
  live('not-a-sha')
  check(needed(run('push', head)) === 'true', 'a live bundleId that is no commit id: publish')
  const usage = run('', '')
  check(usage.code !== 0 && /usage/.test(usage.out), 'no event: usage error')
} finally {
  rmSync(repo, { recursive: true, force: true })
  rmSync(pointers, { recursive: true, force: true })
}

// ---- the 404 fallback ------------------------------------------------------------------------------
const page = readFileSync(join(HERE, 'pages-404.html'), 'utf8')
const code = /<script>([\s\S]*?)<\/script>/.exec(page)?.[1] ?? ''
/** what the fallback does for a URL: where it goes, what it leaves in sessionStorage */
function fallback(url) {
  const u = new URL(url)
  const stored = {}
  let target = null
  vm.runInNewContext(code, {
    location: { pathname: u.pathname, search: u.search, hash: u.hash, replace: (t) => { target = t } },
    sessionStorage: { setItem: (k, v) => { stored[k] = v } },
  })
  return { target, stored }
}
{
  const a = fallback('https://web-of-trust.de/app/some/path?x=1#frag')
  check(a.target === '/app/?x=1#frag', 'a path under /app/ goes to /app/ with its query and fragment', JSON.stringify(a))
  check(Object.keys(a.stored).length === 0, 'and leaves nothing in sessionStorage (the v3 app never reads it)', JSON.stringify(a.stored))
  const b = fallback('https://web-of-trust.de/app?x=1')
  check(b.target === '/app/?x=1' && Object.keys(b.stored).length === 0, '/app without the slash goes to /app/ with its query', JSON.stringify(b))
  const c = fallback('https://web-of-trust.de/application')
  check(c.target === '/', '/application is not the app (the landing takes it)', JSON.stringify(c))
  const d = fallback('https://web-of-trust.de/demo/contacts?y=2#z')
  check(d.target === '/demo/' && d.stored['spa-redirect'] === '/demo/contacts?y=2#z', 'the Gen-2 demo keeps its redirect through sessionStorage', JSON.stringify(d))
  const e = fallback('https://web-of-trust.de/blog/post-1')
  check(e.target === '/' && e.stored['spa-redirect'] === '/blog/post-1', 'the landing keeps its redirect through sessionStorage', JSON.stringify(e))
}

// ---- the deploy contract ---------------------------------------------------------------------------
check(/paths:\n(?:\s+- '.*'\n)*?\s+- 'apps\/wot-v3\/\*\*'/.test(DEPLOY), 'deploy.yml runs on changes of apps/wot-v3')
check(/paths:\n(?:\s+- '.*'\n)*?\s+- 'pnpm-lock\.yaml'/.test(DEPLOY), 'and on lockfile changes (a dependency of the Gen-2 demo can change there alone)')
check(/fetch-depth: 0/.test(DEPLOY), 'the checkout has the history the decision diffs against')
check(DEPLOY.includes('scripts/release/gen2-ota-needed.sh "${{ github.event_name }}" "${{ github.sha }}"'), 'deploy.yml asks gen2-ota-needed.sh with the commit it builds')
for (const step of ['Build OTA bundle (ios)', 'Build OTA bundle (android)', 'Build OTA bundle (android-foss)', 'Build OTA bundle (android-box)', 'Create GitHub Release with OTA bundles', 'Generate latest.json (normal deploy)']) {
  const at = DEPLOY.indexOf(`- name: ${step}\n`)
  const block = at < 0 ? '' : DEPLOY.slice(at, DEPLOY.indexOf('\n      - name:', at + 1))
  check(/if: .*steps\.ota\.outputs\.needed == 'true'/.test(block), `"${step}" runs only when the Gen-2 OTA is needed`)
}
{
  const at = DEPLOY.indexOf('- name: Keep the live OTA pointers')
  const block = at < 0 ? '' : DEPLOY.slice(at, DEPLOY.indexOf('\n      - name:', at + 1))
  check(/steps\.ota\.outputs\.needed == 'false'/.test(block) && /curl -fsS/.test(block) && /web-of-trust\.de\/updates\/\$\{channel\}\/latest\.json/.test(block), 'without a new OTA the live latest.json files are carried over (curl -f: a missing one stops the deploy)')
}
check(/run: pnpm --filter wot-v3 build:web\n\s+env:\n\s+VITE_BASE_PATH: \/app\/\n\s+VITE_MEDIATOR_DID: \$\{\{ vars\.VITE_MEDIATOR_DID \}\}/.test(DEPLOY), 'the v3 web app is built for /app/ with the mediator of the store builds')
check(/cp -r apps\/wot-v3\/dist\/\. combined\/app\//.test(DEPLOY), 'it lands at combined/app/')
check(/cp scripts\/release\/pages-404\.html combined\/404\.html/.test(DEPLOY) && /cp scripts\/release\/pages-404\.html combined\/app\/404\.html/.test(DEPLOY) && !/printf '<!DOCTYPE html>/.test(DEPLOY), 'the 404 fallback is the tested file, at the root, under /demo/ and under /app/')

console.log(failed ? `\n${failed} FAILED` : '\nall cases passed')
process.exit(failed ? 1 : 0)
