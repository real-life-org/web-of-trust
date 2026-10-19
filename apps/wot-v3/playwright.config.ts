import { defineConfig } from '@playwright/test'

// Screenshot tests run against the harness target (simulation, no server besides Vite).
// Port 5273 as in apps/demo. A local Chromium can be given via WOT_CHROME_PATH instead of
// `playwright install`. Baselines in e2e/__screenshots__ were taken with Chromium 1208 on Linux.
const executablePath = process.env.WOT_CHROME_PATH

export default defineConfig({
  testDir: 'e2e',
  snapshotPathTemplate: '{testDir}/__screenshots__/{testFileName}/{arg}{ext}',
  fullyParallel: true,
  // No retries by default: a flaky screen is a finding. On a host whose Chromium aborts requests
  // under parallel load (net::ERR_INSUFFICIENT_RESOURCES / net::ERR_NETWORK_CHANGED, also without any
  // app code, see README), run with --workers=1; WOT_E2E_DIAG=<file> logs every failed request.
  retries: 0,
  reporter: [['list']],
  expect: { toHaveScreenshot: { maxDiffPixelRatio: 0.01 } },
  use: {
    baseURL: 'http://localhost:5273',
    contextOptions: { reducedMotion: 'reduce' },
    ...(executablePath ? { launchOptions: { executablePath } } : {}),
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  // The built harness, not the dev server: the dev server serves every module as its own request
  // (about 250 per page), and under load Chromium aborts some of them (net::ERR_INSUFFICIENT_RESOURCES,
  // net::ERR_NETWORK_CHANGED), which leaves a blank page. The build serves a handful of chunks.
  webServer: {
    command: 'VITE_TARGET=harness vite build --outDir dist-harness --logLevel warn && VITE_TARGET=harness vite preview --outDir dist-harness --port 5273 --strictPort',
    port: 5273,
    reuseExistingServer: false,
    timeout: 180_000,
  },
})
