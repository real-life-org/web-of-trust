// The own name from the profile tab: the row under who you are, the page with the field on the phone
// and as a page beside the sidebar on the desktop (handover desktop frames), light and dark.
import { expect, test, type Page } from '@playwright/test'

const PHONE = { width: 390, height: 844 }
const DESKTOP = { width: 1280, height: 800 }

async function open(page: Page, size: { width: number; height: number }, theme: 'light' | 'dark', lang: 'en' | 'de' = 'en') {
  await page.setViewportSize(size)
  await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' })
  await page.goto(`/?${new URLSearchParams({ scenario: 'iiw', theme, lang }).toString()}`)
  await page.evaluate(() => document.fonts.ready.then(() => undefined))
  await page.getByRole('navigation').first().getByRole('button', { name: /^Profile|^Profil/ }).click()
  await page.getByRole('button', { name: lang === 'de' ? 'Profil bearbeiten' : 'Edit profile' }).click()
  await expect(page.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue('Jonas Weber')
}

for (const theme of ['light', 'dark'] as const) {
  test(`phone ${theme}: the name page`, async ({ page }) => {
    await open(page, PHONE, theme)
    await expect(page.getByRole('button', { name: 'Save' })).toBeDisabled()
    await expect(page).toHaveScreenshot(`profile-name-phone-${theme}.png`)
  })
}

test('phone de', async ({ page }) => {
  await open(page, PHONE, 'light', 'de')
  await expect(page).toHaveScreenshot('profile-name-phone-de.png')
})

test('desktop: a page beside the sidebar, back to the profile', async ({ page }) => {
  await open(page, DESKTOP, 'light')
  await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeVisible()
  await expect(page).toHaveScreenshot('profile-name-desktop-light.png')
  await page.getByRole('button', { name: 'Back' }).click()
  await expect(page.getByRole('heading', { name: 'Profile' })).toBeVisible()
})
