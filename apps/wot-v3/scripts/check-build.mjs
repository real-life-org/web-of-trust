#!/usr/bin/env node
// Store-build check (architecture §8.2), run after every store build (fdroid, play, appstore, web).
// Usage: node scripts/check-build.mjs <distDir> [<moduleGraphJson>]
//   default module graph: <distDir>/../build-meta/module-graph.json (written by vite.config.ts)
//
// 1. Resolved module graph: no simulation, fake platform, harness, tests, fixtures, scenarios,
//    library testing entry or fake-indexeddb in any output chunk (static or dynamic).
// 2. Every shipped file: no source maps, no sourceMappingURL, no paths from step 1, no simulation
//    marker, no scenario titles, no scenario-player page (harness.html).
// 3. Live update (OTA): only the F-Droid build without VITE_DISABLE_LIVE_UPDATE=true may contain the
//    live-update plugin or its client (graph flag `liveUpdate`, written by vite.config.ts); every other
//    build (play, appstore, web) is rejected when either is in the graph or the plugin's name is in a
//    shipped file. The OTA configuration of native artifacts (AAB/IPA) follows with the native shell
//    (cutover PR, architecture §8.3) and is reported as skipped.
// 4. Negative fixtures: tests/build-fixtures/* run through this script in Vitest
//    (tests/check-build.test.ts); each broken one must be rejected.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const STORE_TARGETS = new Set(['fdroid', 'play', 'appstore', 'web'])
const FORBIDDEN_MODULES = [
  /(^|\/)src\/adapters\/sim\//,
  /(^|\/)src\/platform\/fake\//,
  /(^|\/)harness\//,
  /(^|\/)tests\//,
  /(^|\/)e2e\//,
  /\.fixture\./,
  /\.scenario\./,
  /@real-life\/trust-protocol\/dist\/testing/,
  /(^|\/)fake-indexeddb\//,
]
const FORBIDDEN_TEXT = ['src/adapters/sim', 'src/platform/fake', 'harness/scenarios', '__WOT_SIM__', 'sourceMappingURL=']
const LIVE_UPDATE_MODULES = [/@capawesome\/capacitor-live-update/, /(^|\/)src\/platform\/capacitor\/live-update\./]
/** the plugin's registered name and its package, as they survive minification */
const LIVE_UPDATE_TEXT = ['@capawesome/capacitor-live-update', '"LiveUpdate"', "'LiveUpdate'"]
const TEXT_EXT = new Set(['.js', '.mjs', '.css', '.html', '.json', '.svg', '.txt', '.webmanifest', '.map'])

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** Scenario titles from harness/scenarios/*.ts, matched as literal strings in shipped files. */
function scenarioTitles() {
  const dir = path.join(appRoot, 'harness', 'scenarios')
  if (!existsSync(dir)) return []
  const titles = []
  for (const f of readdirSync(dir)) {
    const src = readFileSync(path.join(dir, f), 'utf8')
    for (const m of src.matchAll(/title:\s*'([^']{6,})'/g)) titles.push(m[1])
  }
  return titles
}

function walk(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name)
    if (statSync(p).isDirectory()) out.push(...walk(p))
    else out.push(p)
  }
  return out
}

export function checkBuild(distDir, graphFile = path.join(distDir, '..', 'build-meta', 'module-graph.json')) {
  const errors = []
  const notes = []
  if (!existsSync(distDir)) return { errors: [`no build output at ${distDir}`], notes }
  if (!existsSync(graphFile)) return { errors: [`no module graph at ${graphFile}`], notes }

  // 1. module graph
  const graph = JSON.parse(readFileSync(graphFile, 'utf8'))
  if (!STORE_TARGETS.has(graph.target)) errors.push(`target ${JSON.stringify(graph.target)} is not a store target`)
  const ota = graph.liveUpdate === true && graph.target === 'fdroid'
  for (const id of graph.modules ?? []) {
    const hit = FORBIDDEN_MODULES.find((re) => re.test(id))
    if (hit) errors.push(`forbidden module in the graph: ${id} (${hit})`)
    const otaHit = !ota && LIVE_UPDATE_MODULES.find((re) => re.test(id))
    if (otaHit) errors.push(`live-update module in a ${graph.target} build without OTA: ${id}`)
  }

  // 2. shipped files
  const forbiddenText = [...FORBIDDEN_TEXT, ...scenarioTitles(), ...(ota ? [] : LIVE_UPDATE_TEXT)]
  for (const file of walk(distDir)) {
    const rel = path.relative(distDir, file)
    if (path.basename(file) === 'harness.html') {
      errors.push(`harness.html shipped: ${rel} (scenario player, harness target only)`)
      continue
    }
    if (file.endsWith('.map')) {
      errors.push(`source map shipped: ${rel}`)
      continue
    }
    if (!TEXT_EXT.has(path.extname(file))) continue
    const text = readFileSync(file, 'utf8')
    for (const needle of forbiddenText) if (text.includes(needle)) errors.push(`${rel} contains ${JSON.stringify(needle)}`)
  }

  // 3. OTA configuration on native artifacts
  notes.push(ota ? 'live update allowed (fdroid)' : `no live-update code (${graph.target})`)
  notes.push('OTA artifact check skipped: no native shell in apps/wot-v3 yet (cutover PR, architecture §8.3)')
  return { errors, notes, target: graph.target, liveUpdate: ota, modules: (graph.modules ?? []).length }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dist = path.resolve(process.argv[2] ?? path.join(appRoot, 'dist'))
  const graph = process.argv[3] ? path.resolve(process.argv[3]) : undefined
  const res = graph ? checkBuild(dist, graph) : checkBuild(dist)
  for (const n of res.notes) console.log(`- ${n}`)
  if (res.errors.length) {
    for (const e of res.errors) console.error(`✗ ${e}`)
    console.error(`\nStore-build check failed (${res.errors.length} problems).`)
    process.exit(1)
  }
  console.log(`✓ store-build check passed: target ${res.target}, ${res.modules} modules, no simulation, no source maps`)
}
