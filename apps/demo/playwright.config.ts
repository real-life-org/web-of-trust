import { defineConfig, devices } from '@playwright/test'
import { fileURLToPath } from 'url'
import path from 'path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const RELAY_PORT = 9787
const PROFILES_PORT = 9788
const VAULT_PORT = 9789
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
      executablePath: '/usr/bin/chromium',
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
          executablePath: '/usr/bin/chromium',
        },
        locale: 'de-DE',
      },
    },
  ],

  webServer: {
    command: [
      `VITE_RELAY_URL=ws://localhost:${RELAY_PORT}`,
      `VITE_PROFILE_SERVICE_URL=http://localhost:${PROFILES_PORT}`,
      `VITE_VAULT_URL=http://localhost:${VAULT_PORT}`,
      `npx vite --port ${DEMO_PORT}`,
    ].join(' '),
    port: DEMO_PORT,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
    cwd: path.resolve(__dirname),
  },
})
