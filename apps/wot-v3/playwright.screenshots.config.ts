import { defineConfig } from '@playwright/test'

// Store screenshots only (e2e/store-screenshots.spec.ts, see store-assets/screenshots/README.md):
// the built harness on its own port, so it never collides with the screenshot tests on 5273.
// Phone frames of 360×780 CSS pixels at device scale factor 3 give 1080×2340 PNGs.
const executablePath = process.env.WOT_CHROME_PATH
const port = Number(process.env.WOT_SHOTS_PORT ?? 5291)

export default defineConfig({
  testDir: 'e2e',
  testMatch: 'store-screenshots.spec.ts',
  retries: 0,
  workers: 1,
  timeout: 180_000,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${port}`,
    locale: 'de-DE',
    timezoneId: 'Europe/Berlin',
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    colorScheme: 'light',
    contextOptions: { reducedMotion: 'reduce' },
    ...(executablePath ? { launchOptions: { executablePath } } : {}),
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  webServer: {
    command: `VITE_TARGET=harness vite build --outDir dist-harness --logLevel warn && VITE_TARGET=harness vite preview --outDir dist-harness --port ${port} --strictPort`,
    port,
    reuseExistingServer: false,
    timeout: 180_000,
  },
})
