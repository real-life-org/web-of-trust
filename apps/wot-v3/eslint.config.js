// ESLint: fast editor feedback for the layer rules (architecture §1.2); dependency-cruiser is the
// CI gate. Globs start with `**/src/` so the negative fixtures in tests/boundaries/fixtures/src/
// are judged like the real tree (scripts/check-boundaries-negative.mjs lints them with --no-ignore).
import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import i18next from 'eslint-plugin-i18next'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

const LIB = {
  group: ['@real-life/trust-protocol', '@real-life/trust-protocol/*'],
  message: 'Only src/adapters/rltp may import the core library (architecture §0.1).',
}
const CAPACITOR = {
  group: ['@capacitor/*', '@capacitor-community/*', '@capawesome/*', '@real-life-org/capacitor-*', 'capacitor-*', 'capacitor-*/*'],
  message: 'Only src/platform/capacitor may import Capacitor and native plugins (architecture §1.1).',
}
const HTML5_QRCODE = {
  group: ['html5-qrcode', 'html5-qrcode/*'],
  message: 'Only src/platform/web may import html5-qrcode (architecture §5 table).',
}
const REACT = {
  group: ['react', 'react/*', 'react-dom', 'react-dom/*'],
  message: 'React begins at hooks/ (architecture §1.1).',
}
const restrict = (...patterns) => ({ 'no-restricted-imports': ['error', { patterns }] })

export default defineConfig([
  globalIgnores([
    'dist',
    'dist-harness',
    'dist-fdroid',
    'dist-play',
    'dist-appstore',
    'build-meta',
    'test-results',
    'playwright-report',
    'tests/boundaries/fixtures',
    'tests/build-fixtures',
  ]),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [js.configs.recommended, tseslint.configs.recommended, reactHooks.configs.flat.recommended],
    languageOptions: { ecmaVersion: 2022, globals: globals.browser },
    rules: {
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      // No tool can resolve the target of a template-literal import with variables (architecture §1.2).
      'no-restricted-syntax': [
        'error',
        {
          selector: 'ImportExpression > TemplateLiteral[expressions.length>0]',
          message: 'Dynamic imports with variables are banned in src/: their target cannot be checked.',
        },
        {
          // a name, a concatenation or a call as the target: as unresolvable as a template (review 432 R1-9)
          selector: "ImportExpression[source.type!='Literal'][source.type!='TemplateLiteral']",
          message: 'Dynamic imports take a string literal: their target must be checkable.',
        },
        {
          selector: "CallExpression[callee.name='require'][arguments.0.type!='Literal']",
          message: 'require() takes a string literal: its target must be checkable.',
        },
        {
          // Vite turns a glob into imports dependency-cruiser never sees (review 432 R2-5)
          selector: "MemberExpression[object.type='MetaProperty'][property.name=/^glob/]",
          message: 'import.meta.glob is banned in src/: its targets cannot be checked.',
        },
      ],
      ...restrict(LIB, CAPACITOR, HTML5_QRCODE),
    },
  },
  { files: ['**/src/port/**', '**/src/flows/**', '**/src/adapters/sim/**', '**/src/adapters/identity/**'], rules: restrict(LIB, CAPACITOR, HTML5_QRCODE, REACT) },
  { files: ['**/src/adapters/rltp/**'], rules: restrict(CAPACITOR, HTML5_QRCODE, REACT) },
  {
    // the wire tests and the mediator matrix drive the library's VTI mediator adapter itself: the
    // wire's contract is with it
    files: ['tests/rltp/wire-*.test.ts', 'tests/crash/transport-mediator.*'],
    rules: {
      'no-restricted-imports': [
        'error',
        { paths: ['@real-life/trust-protocol', '@real-life/trust-protocol/testing', '@real-life/trust-protocol/internal'].map((name) => ({ name, message: LIB.message })), patterns: [CAPACITOR, HTML5_QRCODE] },
      ],
    },
  },
  { files: ['**/src/platform/**'], ignores: ['**/src/platform/capacitor/**', '**/src/platform/web/**'], rules: restrict(LIB, CAPACITOR, HTML5_QRCODE, REACT) },
  { files: ['**/src/platform/web/**'], rules: restrict(LIB, CAPACITOR, REACT) },
  { files: ['**/src/platform/capacitor/**'], rules: restrict(LIB, HTML5_QRCODE, REACT) },
  {
    // Visible text comes from i18n in screens and components (architecture §1.2).
    files: ['**/src/screens/**/*.tsx', '**/src/ui/components/**/*.tsx'],
    plugins: { i18next },
    rules: { 'i18next/no-literal-string': ['error', { mode: 'jsx-text-only' }] },
  },
  {
    files: ['e2e/**', 'playwright.config.ts', 'vite.config.ts', 'scripts/**'],
    languageOptions: { globals: globals.node },
  },
])
