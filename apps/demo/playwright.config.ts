import { defineConfig, devices } from '@playwright/test'
import { fileURLToPath } from 'url'
import path from 'path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const RELAY_PORT = 9787
const PROFILES_PORT = 9788
const VAULT_PORT = 9789

// External-backend mode: set E2E_RELAY_URL + E2E_PROFILES_URL + E2E_VAULT_URL to
// run the suite against an EXTERNAL backend — e.g. the festival offline box
// (wss://relay.box.web-of-trust.de) — instead of the localhost servers that
// global-setup spawns. global-setup/-teardown skip the server lifecycle when set.
// ALL-OR-NONE (review should-fix): a partial set would silently mix an external
// relay with localhost profiles/vault that nobody started — late, confusing spec
// failures instead of one clear config error.
const EXTERNAL_URL_VARS = ['E2E_RELAY_URL', 'E2E_PROFILES_URL', 'E2E_VAULT_URL'] as const
const setVars = EXTERNAL_URL_VARS.filter((name) => !!process.env[name])
if (setVars.length > 0 && setVars.length < EXTERNAL_URL_VARS.length) {
  const missing = EXTERNAL_URL_VARS.filter((name) => !process.env[name])
  throw new Error(
    `External-backend mode: set ALL of ${EXTERNAL_URL_VARS.join(', ')} together — ` +
      `got ${setVars.join(', ')} but missing ${missing.join(', ')}. ` +
      'A partial set mixes the external backend with unspawned localhost servers.',
  )
}
const RELAY_URL = process.env.E2E_RELAY_URL ?? `ws://localhost:${RELAY_PORT}`
const PROFILES_URL = process.env.E2E_PROFILES_URL ?? `http://localhost:${PROFILES_PORT}`
const VAULT_URL = process.env.E2E_VAULT_URL ?? `http://localhost:${VAULT_PORT}`
// Dedicated E2E port — deliberately NOT vite's default 5173. With
// `reuseExistingServer` Playwright silently REUSES whatever already listens on
// the port; on 5173 that is typically a normal `pnpm dev` session of some OTHER
// app, so the whole suite then tests the WRONG app and every spec times out.
const DEMO_PORT = 5273

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 15_000 },

  globalSetup: './e2e/global-setup.ts',
  globalTeardown: './e2e/global-teardown.ts',

  reporter: process.env.CI ? 'github' : 'list',
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,

  use: {
    baseURL: `http://localhost:${DEMO_PORT}`,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    launchOptions: {
      executablePath: process.env.E2E_CHROME_PATH ?? '/usr/bin/chromium',
    },
    permissions: ['clipboard-read', 'clipboard-write'],
    locale: 'de-DE',
  },

  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: {
          executablePath: process.env.E2E_CHROME_PATH ?? '/usr/bin/chromium',
        },
        locale: 'de-DE',
      },
    },
  ],

  webServer: {
    command: [
      `VITE_RELAY_URL=${RELAY_URL}`,
      `VITE_PROFILE_SERVICE_URL=${PROFILES_URL}`,
      `VITE_VAULT_URL=${VAULT_URL}`,
      `npx vite --port ${DEMO_PORT}`,
    ].join(' '),
    port: DEMO_PORT,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
    cwd: path.resolve(__dirname),
  },
})
