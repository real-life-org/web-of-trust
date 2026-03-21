import type { BrowserContext, Page } from '@playwright/test'

/**
 * Simulate going offline by blocking all network requests.
 * Uses Playwright's context.setOffline() which disconnects WebSocket too.
 */
export async function goOffline(context: BrowserContext): Promise<void> {
  await context.setOffline(true)
}

/**
 * Simulate coming back online.
 */
export async function goOnline(context: BrowserContext): Promise<void> {
  await context.setOffline(false)
}

/**
 * Wait for the offline banner to appear in the app.
 */
export async function waitForOfflineBanner(page: Page, timeout = 10_000): Promise<void> {
  await page.getByText('Offline').first().waitFor({ timeout })
}

/**
 * Wait for the app to reconnect after going online.
 * Checks that the relay is connected again.
 */
export async function waitForReconnect(page: Page, timeout = 20_000): Promise<void> {
  await page.getByText('Relay verbunden').waitFor({ timeout })
}