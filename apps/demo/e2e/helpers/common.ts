import type { Browser, BrowserContext, Page } from '@playwright/test'

/**
 * Navigate within the SPA without a full page reload.
 * Uses pushState + popstate to trigger React Router navigation.
 */
export async function navigateTo(page: Page, path: string): Promise<void> {
  await page.evaluate((p) => {
    window.history.pushState(null, '', p)
    window.dispatchEvent(new PopStateEvent('popstate'))
  }, path)
  // Small wait for React to re-render
  await page.waitForTimeout(500)
}

/**
 * Create a fresh, isolated browser context with clipboard permissions.
 * Each context has its own IndexedDB, cookies, and WebSocket connections.
 */
export async function createFreshContext(browser: Browser): Promise<{
  context: BrowserContext
  page: Page
}> {
  const context = await browser.newContext({
    permissions: ['clipboard-read', 'clipboard-write'],
    locale: 'de-DE',
  })
  const page = await context.newPage()
  return { context, page }
}

/**
 * Wait for the relay connection indicator on the home page.
 * Navigates to home if not already there.
 */
export async function waitForRelayConnected(
  page: Page,
  timeout = 20_000,
): Promise<void> {
  // Make sure we're on home page
  if (!page.url().endsWith('/') && !page.url().endsWith(':5173')) {
    await navigateTo(page, '/')
  }
  await page.getByText('Relay verbunden').waitFor({ timeout })
}
