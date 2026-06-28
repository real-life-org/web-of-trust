// Smoke test: third-party consumer resolution of the layer-clean public surface.
//
// Phase 1.A stub. This script verifies at RUNTIME that an out-of-package
// consumer can import the two layer-clean entry points of @web_of_trust/core
// without pulling in browser-global adapters:
//   - @web_of_trust/core/protocol    (pure spec logic, no IO / browser globals)
//   - @web_of_trust/core/application  (workflows, no IO / browser globals)
//
// It only asserts that the subpaths RESOLVE and produce a non-empty module
// namespace. It deliberately does NOT type-check: the final `tsc --noEmit`
// form of this consumer smoke (a real .ts fixture compiled against the built
// .d.ts to prove the public types resolve cleanly) lands in Phase 1.C.
//
// Run after building the package:
//   pnpm --filter @web_of_trust/core build
//   node packages/wot-core/scripts/smoke-third-party-consumer.mjs

const checks = []

async function check(subpath) {
  const mod = await import(subpath)
  const exportNames = Object.keys(mod)
  if (exportNames.length === 0) {
    throw new Error(`${subpath} resolved but exposes zero exports`)
  }
  checks.push({ subpath, exportCount: exportNames.length })
}

async function main() {
  await check('@web_of_trust/core/protocol')
  await check('@web_of_trust/core/application')

  for (const { subpath, exportCount } of checks) {
    console.log(`OK  ${subpath} -> ${exportCount} exports`)
  }
  console.log('smoke-third-party-consumer: all public subpaths resolved')
}

main().catch((err) => {
  console.error('smoke-third-party-consumer FAILED:', err)
  process.exitCode = 1
})
