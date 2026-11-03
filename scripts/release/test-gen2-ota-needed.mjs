#!/usr/bin/env node
// Cases of the Gen-2 OTA decision (scripts/release/gen2-ota-needed.sh) and the Pages contract of
// .github/workflows/deploy.yml for the v3 web app.
//
// WHY: deploy.yml builds the whole GitHub Pages site (landing, Gen-2 demo, benchmark, and now the v3
// web app at /app/) and, on every run, rebuilt and published the Gen-2 OTA bundles. Once the v3 app
// triggers the deploy too, every v3 merge would hand Gen-2 F-Droid users an update without content.
// The decision runs against a throw-away git repository here, so each case is checked before it
// happens on main.
//
// Run: node scripts/release/test-gen2-ota-needed.mjs
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCRIPT = join(HERE, 'gen2-ota-needed.sh')
const DEPLOY = readFileSync(join(HERE, '..', '..', '.github', 'workflows', 'deploy.yml'), 'utf8')

let failed = 0
const ok = (msg) => console.log(`  ok   ${msg}`)
const fail = (msg, detail = '') => { console.log(`  FAIL ${msg}${detail ? ` — ${detail}` : ''}`); failed++ }
const check = (cond, msg, detail) => (cond ? ok(msg) : fail(msg, detail))

// ---- the decision ----------------------------------------------------------------------------------
const repo = mkdtempSync(join(tmpdir(), 'gen2-ota-'))
const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const commit = (file, text) => {
  mkdirSync(join(repo, dirname(file)), { recursive: true })
  writeFileSync(join(repo, file), text)
  git('add', '-A')
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', file)
  return git('rev-parse', 'HEAD')
}
function run(event, before, after) {
  try {
    const out = execFileSync('bash', [SCRIPT, event, before, after], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    return { code: 0, out }
  } catch (err) {
    return { code: err.status ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` }
  }
}
const needed = (r) => /^needed=(true|false)$/m.exec(r.out)?.[1]

try {
  git('init', '-q')
  const base = commit('README.md', 'x')
  const v3 = commit('apps/wot-v3/src/a.ts', '1')
  const landing = commit('apps/landing/src/b.jsx', '1')
  const demo = commit('apps/demo/src/c.ts', '1')
  const core = commit('packages/wot-core/src/d.ts', '1')
  const yjs = commit('packages/adapter-yjs/src/e.ts', '1')
  const am = commit('packages/adapter-automerge/src/f.ts', '1')
  const v3again = commit('apps/wot-v3/src/a.ts', '2')

  check(needed(run('push', base, v3)) === 'false', 'a v3-only push publishes no Gen-2 OTA')
  check(needed(run('push', v3, landing)) === 'false', 'a landing-only push publishes no Gen-2 OTA')
  check(needed(run('push', landing, demo)) === 'true', 'a change under apps/demo publishes the Gen-2 OTA')
  check(needed(run('push', demo, core)) === 'true', 'a change in wot-core publishes the Gen-2 OTA')
  check(needed(run('push', core, yjs)) === 'true', 'a change in adapter-yjs publishes the Gen-2 OTA')
  check(needed(run('push', yjs, am)) === 'true', 'a change in adapter-automerge publishes the Gen-2 OTA')
  check(needed(run('push', base, v3again)) === 'true', 'a push of several commits, one of them in apps/demo, publishes it')
  check(needed(run('push', am, v3again)) === 'false', 'the v3 commit after them alone does not')
  check(needed(run('workflow_dispatch', am, v3again)) === 'true', 'a dispatch (rollback, manual deploy) always publishes')
  check(needed(run('push', '0000000000000000000000000000000000000000', v3)) === 'true', 'no previous commit (new branch): publish, the safe side')
  check(needed(run('push', '', v3)) === 'true', 'an empty previous commit: publish')
  check(needed(run('push', 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', v3)) === 'true', 'a previous commit not in the clone (shallow): publish')
  const usage = run('', '', '')
  check(usage.code !== 0 && /usage/.test(usage.out), 'no event: usage error')
} finally {
  rmSync(repo, { recursive: true, force: true })
}

// ---- the deploy contract ---------------------------------------------------------------------------
check(/paths:\n(?:\s+- '.*'\n)*?\s+- 'apps\/wot-v3\/\*\*'/.test(DEPLOY), 'deploy.yml runs on changes of apps/wot-v3')
check(/fetch-depth: 0/.test(DEPLOY), 'the checkout has the history the decision diffs against')
check(DEPLOY.includes('scripts/release/gen2-ota-needed.sh "${{ github.event_name }}" "${{ github.event.before }}" "${{ github.sha }}"'), 'deploy.yml asks gen2-ota-needed.sh')
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
check(/VITE_BASE_PATH: \/app\/\n\s+VITE_MEDIATOR_DID: \$\{\{ vars\.VITE_MEDIATOR_DID \}\}\n\s+run: pnpm --filter wot-v3 build:web/.test(DEPLOY) || /run: pnpm --filter wot-v3 build:web\n\s+env:\n\s+VITE_BASE_PATH: \/app\/\n\s+VITE_MEDIATOR_DID: \$\{\{ vars\.VITE_MEDIATOR_DID \}\}/.test(DEPLOY), 'the v3 web app is built for /app/ with the mediator of the store builds')
check(/cp -r apps\/wot-v3\/dist\/\. combined\/app\//.test(DEPLOY), 'it lands at combined/app/')
check(/startsWith\("\/app"\)\?"\/app\/"/.test(DEPLOY), 'the 404 fallback sends /app/… back to /app/')

console.log(failed ? `\n${failed} FAILED` : '\nall cases passed')
process.exit(failed ? 1 : 0)
