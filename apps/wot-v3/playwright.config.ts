import { defineConfig } from '@playwright/test'

// Screenshot tests run against the harness target (simulation, no server besides Vite).
// Port 5273 as in apps/demo. A local Chromium can be given via WOT_CHROME_PATH instead of
// `playwright install`. Baselines in e2e/__screenshots__ were taken with Chromium 1208 on Linux.
const executablePath = process.env.WOT_CHROME_PATH

export default defineConfig({
  testDir: 'e2e',
  snapshotPathTemplate: '{testDir}/__screenshots__/{testFileName}/{arg}{ext}',
  fullyParallel: true,
  reporter: [['list']],
  expect: { toHaveScreenshot: { maxDiffPixelRatio: 0.01 } },
  use: {
    baseURL: 'http://localhost:5273',
    contextOptions: { reducedMotion: 'reduce' },
    ...(executablePath ? { launchOptions: { executablePath } } : {}),
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  webServer: {
    command: 'VITE_TARGET=harness vite --port 5273 --strictPort',
    port: 5273,
    reuseExistingServer: true,
    timeout: 60_000,
  },
})
