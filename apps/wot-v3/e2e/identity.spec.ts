// Identity screens (architecture §7.4 "Darstellung"): every catalog entry light and dark on a
// phone, German for the main steps; plus click-through paths over the simulation (reachability in
// the browser, real IndexedDB not involved: fake device in the harness).
import { expect, test, type Page } from '@playwright/test'
import { CATALOG } from '../harness/catalog'

// The dev server serves every module as its own request; on a host whose network interface changes,
// Chromium aborts some of them (net::ERR_NETWORK_CHANGED) and the page stays blank. Retries keep the
// visual check about the screens, not the host.
test.describe.configure({ retries: 2 })

const PHONE = { width: 390, height: 844 }
const GERMAN = ['onboarding-welcome', 'onboarding-showWords', 'onboarding-protect', 'recovery-enterWords-ok', 'unlock-passphrase-bioUnusable', 'delete-confirm', 'legacy-notice']

async function open(page: Page, params: Record<string, string>, theme: 'light' | 'dark') {
  await page.setViewportSize(PHONE)
  await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' })
  await page.goto(`/?${new URLSearchParams({ ...params, theme }).toString()}`)
  await page.evaluate(() => document.fonts.ready.then(() => undefined))
}

for (const theme of ['light', 'dark'] as const) {
  test.describe(`identity catalog ${theme}`, () => {
    for (const entry of CATALOG) {
      test(entry.id, async ({ page }) => {
        await open(page, { catalog: entry.id }, theme)
        await expect(page.locator('section, [role="dialog"]').first()).toBeVisible({ timeout: 20_000 })
        // a running spinner is still under reduced motion; the screenshot masks nothing
        await expect(page).toHaveScreenshot(`identity/${entry.id}-phone-${theme}.png`)
      })
    }
  })
}

test.describe('identity catalog de', () => {
  for (const id of GERMAN) {
    test(id, async ({ page }) => {
      await open(page, { catalog: id, lang: 'de' }, 'light')
      await expect(page.locator('section').first()).toBeVisible({ timeout: 20_000 })
      await expect(page).toHaveScreenshot(`identity/${id}-phone-de.png`)
    })
  }
})

test.describe('identity flows in the browser', () => {
  test('locked: unlock with the harness passphrase opens the app', async ({ page }) => {
    await open(page, { scenario: 'locked' }, 'light')
    await page.getByLabel('Password', { exact: true }).fill('harness passphrase')
    await page.getByRole('button', { name: 'Unlock' }).click()
    await page.getByRole('button', { name: 'Not now' }).click()
    await expect(page.getByRole('heading', { name: 'Contacts' })).toBeVisible()
  })

  test('Gen-2 upgrade: notice, then welcome', async ({ page }) => {
    await open(page, { scenario: 'gen2-upgrade' }, 'light')
    await page.getByRole('button', { name: 'Got it' }).click()
    await expect(page.getByRole('button', { name: 'Create identity' })).toBeVisible()
  })

  test('fresh install: browser back goes one step back inside the flow', async ({ page }) => {
    await open(page, { scenario: 'fresh-install' }, 'light')
    await page.getByRole('button', { name: 'Create identity' }).click()
    await expect(page.getByRole('list', { name: 'Your 12 Magic Words' })).toBeVisible()
    await page.goBack()
    await expect(page.getByRole('button', { name: 'Create identity' })).toBeVisible()
  })
})
