#!/usr/bin/env node
// Negative boundary check (architecture §1.2): every fixture in tests/boundaries/fixtures/src/
// breaks one layer rule on purpose; the tree mirrors src/ so the same rules apply. Each fixture
// must be reported by dependency-cruiser and/or ESLint with the expected rule. A fixture that
// passes means the rule is broken: exit 1.
//
// Files that appear in no case below are mirror targets for relative imports.

import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const FIX = 'tests/boundaries/fixtures/src'

/** fixture → expected dependency-cruiser rules and ESLint rules (each list must be fully reported) */
const CASES = [
  { file: 'screens/lib-direct.ts', depcruise: ['lib-only-in-rltp-adapter'], eslint: ['no-restricted-imports'] },
  { file: 'screens/lib-dynamic.ts', depcruise: ['lib-only-in-rltp-adapter'] },
  { file: 'screens/lib-require.ts', depcruise: ['lib-only-in-rltp-adapter'] },
  { file: 'screens/template-import.ts', eslint: ['no-restricted-syntax'] },
  { file: 'screens/relative-adapter.ts', depcruise: ['screens-no-adapters-or-flows', 'no-static-simulation-in-app'] },
  { file: 'screens/alias-adapter.ts', depcruise: ['screens-no-adapters-or-flows', 'no-static-simulation-in-app'] },
  { file: 'screens/capacitor.ts', depcruise: ['capacitor-only-in-platform-capacitor'], eslint: ['no-restricted-imports'] },
  { file: 'screens/diagnostics.ts', depcruise: ['diagnostics-restricted'] },
  { file: 'ui/components/adapter-import.ts', depcruise: ['ui-components-no-logic'] },
  { file: 'ui/primitives/i18n-import.ts', depcruise: ['ui-primitives-are-neutral'] },
  { file: 'flows/react-import.ts', depcruise: ['flows-are-pure'], eslint: ['no-restricted-imports'] },
  { file: 'flows/value-import.ts', depcruise: ['flows-port-type-only'] },
  { file: 'port/index.ts', depcruise: ['lib-only-in-rltp-adapter', 'port-is-pure'], eslint: ['no-restricted-imports'] },
  { file: 'hooks/reexport-type.ts', depcruise: ['lib-only-in-rltp-adapter'], eslint: ['no-restricted-imports'] },
  { file: 'app/static-sim.ts', depcruise: ['no-static-simulation-in-app'] },
  { file: 'adapters/rltp/fake-idb.ts', depcruise: ['no-test-doubles-in-src'] },
  { file: 'adapters/rltp/lib-testing.ts', depcruise: ['no-test-doubles-in-src'] },
  { file: 'screens/harness-dynamic.ts', depcruise: ['app-never-imports-harness'] },
  { file: 'adapters/sim/harness-import.ts', depcruise: ['app-never-imports-harness'] },
  { file: 'screens/html5-qrcode.ts', depcruise: ['html5-qrcode-only-in-platform-web'], eslint: ['no-restricted-imports'] },
  { file: 'screens/email-composer.ts', depcruise: ['capacitor-only-in-platform-capacitor'], eslint: ['no-restricted-imports'] },
  { file: 'hooks/live-update.ts', depcruise: ['capacitor-only-in-platform-capacitor'], eslint: ['no-restricted-imports'] },
  { file: 'platform/capacitor/html5-qrcode.ts', depcruise: ['html5-qrcode-only-in-platform-web'], eslint: ['no-restricted-imports'] },
  { file: 'screens/import-variable.ts', eslint: ['no-restricted-syntax'] },
  { file: 'screens/meta-glob.ts', eslint: ['no-restricted-syntax'] },
  { file: 'hooks/use-native.ts', depcruise: ['hooks-no-adapters-or-ui'] },
  { file: 'screens/vti.ts', depcruise: ['vti-only-in-rltp-wire'] },
  { file: 'adapters/rltp/vti-outside-wire.ts', depcruise: ['vti-only-in-rltp-wire'] },
  { file: 'screens/fflate.ts', depcruise: ['fflate-only-in-card-link'] },
  { file: 'adapters/rltp/fflate-outside-card-link.ts', depcruise: ['fflate-only-in-card-link'] },
  { file: 'platform/web/capacitor.ts', depcruise: ['capacitor-only-in-platform-capacitor'], eslint: ['no-restricted-imports'] },
]

function run(cmd, args) {
  try {
    return execFileSync(cmd, args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (e) {
    // both tools exit non-zero when they find violations; that is the expected case here
    if (e.stdout) return e.stdout
    throw e
  }
}

const bin = (name) => path.join(root, 'node_modules', '.bin', name)

// dependency-cruiser over the whole fixture tree, once
const dc = JSON.parse(run(bin('depcruise'), [`${FIX}`, '--config', '.dependency-cruiser.cjs', '--output-type', 'json']))
const dcFound = new Map()
for (const v of dc.summary.violations) {
  const from = v.from.replace(/\\/g, '/')
  if (!dcFound.has(from)) dcFound.set(from, new Set())
  dcFound.get(from).add(v.rule.name)
}

// ESLint over the fixtures, ignores disabled
const files = CASES.filter((c) => c.eslint).map((c) => `${FIX}/${c.file}`)
const es = JSON.parse(run(bin('eslint'), ['--no-ignore', '-f', 'json', ...files]))
const esFound = new Map()
for (const f of es) {
  const rel = path.relative(root, f.filePath).replace(/\\/g, '/')
  esFound.set(rel, new Set(f.messages.map((m) => m.ruleId)))
}

let failed = 0
for (const c of CASES) {
  const rel = `${FIX}/${c.file}`
  const problems = []
  for (const rule of c.depcruise ?? []) if (!dcFound.get(rel)?.has(rule)) problems.push(`dependency-cruiser did not report ${rule}`)
  for (const rule of c.eslint ?? []) if (!esFound.get(rel)?.has(rule)) problems.push(`ESLint did not report ${rule}`)
  if (problems.length) {
    failed++
    console.error(`✗ ${rel}\n  ${problems.join('\n  ')}`)
  } else {
    const got = [...(c.depcruise ?? []).map((r) => `dc:${r}`), ...(c.eslint ?? []).map((r) => `eslint:${r}`)]
    console.log(`✓ ${rel} rejected (${got.join(', ')})`)
  }
}

if (failed) {
  console.error(`\n${failed} of ${CASES.length} fixtures were not rejected: a boundary rule is broken.`)
  process.exit(1)
}
console.log(`\nAll ${CASES.length} negative fixtures rejected.`)
