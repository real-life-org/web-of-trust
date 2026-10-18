// Layer rules of architecture §1.1, enforced in CI (`pnpm check:boundaries`).
// Paths match with an optional prefix so that the negative fixtures under
// tests/boundaries/fixtures/src/... are judged by the same rules (`pnpm check:boundaries:negative`).
//
// "Only import type" rows use dependencyTypesNot: ['type-only'] (tsconfig has verbatimModuleSyntax,
// so type-only imports are explicit). Dynamic imports, require() and re-exports are dependencies
// like any other; template-literal imports with variables are banned by ESLint (no tool can
// resolve their target).

const P = '(^|/)src/' // the app source, or the mirrored source of a fixture
const LIB = '(^|/)@real-life/trust-protocol(/|$)'
const CAPACITOR = '(^|/)(@capacitor/|@capawesome/|@real-life-org/capacitor-)'
const REACT = '(^|/)(react|react-dom)(/|$)'
const NPM = '(^|/)node_modules/'
const IMPLS = `${P}platform/(capacitor|web|fake|seed-vault)/`

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'lib-only-in-rltp-adapter',
      comment: 'Only src/adapters/rltp may import @real-life/trust-protocol (architecture §0, §1.1).',
      severity: 'error',
      from: { pathNot: `${P}adapters/rltp/` },
      to: { path: LIB },
    },
    {
      name: 'capacitor-only-in-platform-capacitor',
      comment: 'Only src/platform/capacitor may import Capacitor and native plugins.',
      severity: 'error',
      from: { pathNot: `${P}platform/capacitor/` },
      to: { path: CAPACITOR },
    },
    {
      name: 'port-is-pure',
      comment: 'src/port imports only src/port: no React, no core library, no platform.',
      severity: 'error',
      from: { path: `${P}port/` },
      to: { pathNot: `${P}port/` },
    },
    {
      name: 'platform-ports-import-nothing',
      comment: 'src/platform/ports.ts holds pure interfaces and imports nothing.',
      severity: 'error',
      from: { path: `${P}platform/ports\\.ts$` },
      to: {},
    },
    {
      name: 'platform-impls-stay-below',
      comment: 'Platform implementations import platform/ports.ts and their own SDKs, never the app port, React or other layers.',
      severity: 'error',
      from: { path: IMPLS },
      to: { path: [`${P}(port|adapters|flows|hooks|ui|screens|app|i18n)/`, REACT] },
    },
    {
      name: 'rltp-adapter-stays-below',
      comment: 'adapters/rltp: no React, hooks, flows, UI, screens, app, platform implementations or the simulation.',
      severity: 'error',
      from: { path: `${P}adapters/rltp/` },
      to: { path: [`${P}(hooks|flows|ui|screens|app|i18n)/`, IMPLS, `${P}adapters/sim/`, REACT] },
    },
    {
      name: 'identity-runtime-stays-below',
      comment:
        'adapters/identity (identity runtime under the port, shared by both adapters): port, platform/ports.ts, @scure/bip39; no core library, React, platform implementations or the adapters themselves.',
      severity: 'error',
      from: { path: `${P}adapters/identity/` },
      to: { path: [`${P}(hooks|flows|ui|screens|app|i18n)/`, IMPLS, `${P}adapters/(rltp|sim)/`, REACT, LIB] },
    },
    {
      name: 'sim-adapter-stays-below',
      comment: 'adapters/sim: port and platform/ports.ts only; no core library, React or platform implementations.',
      severity: 'error',
      from: { path: `${P}adapters/sim/` },
      to: { path: [`${P}(hooks|flows|ui|screens|app|i18n)/`, IMPLS, `${P}adapters/rltp/`, REACT] },
    },
    {
      name: 'flows-are-pure',
      comment: 'flows/: no React, no adapters, no UI.',
      severity: 'error',
      from: { path: `${P}flows/` },
      to: { path: [`${P}(adapters|hooks|ui|screens|app)/`, IMPLS, REACT] },
    },
    {
      name: 'flows-port-type-only',
      comment: 'flows/ may import port/ and platform/ports.ts only with `import type`.',
      severity: 'error',
      from: { path: `${P}flows/` },
      to: { path: [`${P}port/`, `${P}platform/ports\\.ts$`], dependencyTypesNot: ['type-only'] },
    },
    {
      name: 'hooks-no-adapters-or-ui',
      comment: 'hooks/: no adapters, no platform implementations, no UI, no screens.',
      severity: 'error',
      from: { path: `${P}hooks/` },
      to: { path: [`${P}(adapters|ui|screens)/`, IMPLS] },
    },
    {
      name: 'ui-primitives-are-neutral',
      comment: 'ui/primitives: Radix, cva, clsx, tailwind-merge only; labels come as props (no i18n, hooks, port).',
      severity: 'error',
      from: { path: `${P}ui/primitives/` },
      to: { path: [`${P}(i18n|hooks|port|adapters|flows|screens|app|platform)/`, `${P}ui/components/`] },
    },
    {
      name: 'ui-components-no-logic',
      comment: 'ui/components: primitives, i18n, port types; no hooks, adapters, flows, screens, app, platform.',
      severity: 'error',
      from: { path: `${P}ui/components/` },
      to: { path: [`${P}(hooks|adapters|flows|screens|app|platform)/`] },
    },
    {
      name: 'ui-components-port-type-only',
      comment: 'ui/components may import port/ only with `import type`.',
      severity: 'error',
      from: { path: `${P}ui/components/` },
      to: { path: `${P}port/`, dependencyTypesNot: ['type-only'] },
    },
    {
      name: 'screens-no-adapters-or-flows',
      comment: 'screens/: hooks, ui, i18n, port types; no adapters, flows, app, platform implementations.',
      severity: 'error',
      from: { path: `${P}screens/` },
      to: { path: [`${P}(adapters|flows|app)/`, IMPLS] },
    },
    {
      name: 'screens-port-type-only',
      comment: 'screens/ may import port/ only with `import type`.',
      severity: 'error',
      from: { path: `${P}screens/` },
      to: { path: `${P}port/`, dependencyTypesNot: ['type-only'] },
    },
    {
      name: 'diagnostics-restricted',
      comment: 'port/diagnostics.ts: adapters write, harness/ and app/error-report read; nobody else (architecture §2.6).',
      severity: 'error',
      from: { pathNot: [`${P}port/`, `${P}adapters/`, '(^|/)harness/', `${P}app/error-report`] },
      to: { path: `${P}port/diagnostics\\.ts$` },
    },
    {
      name: 'no-static-simulation-in-app',
      comment:
        'Outside the simulation itself, src/ reaches the simulation, the fake platform and harness/ only through a dynamic import (app/compose.ts). The build check verifies the result (§8.2).',
      severity: 'error',
      from: { path: P, pathNot: `${P}(adapters/sim|platform/fake)/` },
      to: { path: [`${P}adapters/sim/`, `${P}platform/fake/`, '(^|/)harness/'], dependencyTypesNot: ['dynamic-import'] },
    },
    {
      name: 'no-unresolvable',
      comment: 'Every import must resolve; an unresolved path could hide a boundary crossing.',
      severity: 'error',
      from: {},
      to: { couldNotResolve: true },
    },
    {
      name: 'no-circular',
      comment: 'Cycles through type-only imports (port/models ↔ port/commands, compose ↔ harness/boot) are harmless.',
      severity: 'warn',
      from: {},
      to: { circular: true, viaOnly: { dependencyTypesNot: ['type-only'] } },
    },
  ],
  options: {
    doNotFollow: { path: NPM },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      extensions: ['.ts', '.tsx', '.js', '.mjs', '.cjs', '.d.ts'],
    },
    reporterOptions: { text: { highlightFocused: true } },
  },
}
