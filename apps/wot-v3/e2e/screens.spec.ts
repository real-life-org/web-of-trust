// Visual check of the two scaffold screens against the design, light and dark, phone and desktop.
// Data: harness scenarios (simulation adapter, virtual clock fixed at the scenario start).
import { expect, test, type Page } from '@playwright/test'

const PHONE = { width: 390, height: 844 }
const DESKTOP = { width: 1280, height: 800 }

async function open(page: Page, params: Record<string, string>, theme: 'light' | 'dark') {
  await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' })
  const q = new URLSearchParams({ ...params, theme })
  await page.goto(`/?${q.toString()}`)
  await page.evaluate(() => document.fonts.ready.then(() => undefined))
}

for (const theme of ['light', 'dark'] as const) {
  test.describe(`${theme}`, () => {
    test('contact list, phone', async ({ page }) => {
      await page.setViewportSize(PHONE)
      await open(page, { scenario: 'iiw' }, theme)
      await expect(page.getByRole('heading', { name: 'Contacts' })).toBeVisible()
      await expect(page.getByText('Priya Raman')).toBeVisible()
      await expect(page).toHaveScreenshot(`contacts-phone-${theme}.png`)
    })

    test('contact list empty, phone', async ({ page }) => {
      await page.setViewportSize(PHONE)
      await open(page, { scenario: 'empty' }, theme)
      await expect(page.getByText('No contacts yet')).toBeVisible()
      await expect(page).toHaveScreenshot(`contacts-empty-phone-${theme}.png`)
    })

    test('conversation, phone', async ({ page }) => {
      await page.setViewportSize(PHONE)
      await open(page, { scenario: 'iiw', open: 'c:priya' }, theme)
      await expect(page.getByText('Want in?')).toBeVisible()
      await expect(page).toHaveScreenshot(`conversation-phone-${theme}.png`)
    })

    // the decision card with "Decline" and its sentence (handshake UX A2)
    test('conversation with a confirmation to answer, phone', async ({ page }) => {
      await page.setViewportSize(PHONE)
      await open(page, { scenario: 'iiw', open: 'c:marcus' }, theme)
      await expect(page.getByRole('button', { name: 'Decline' })).toBeVisible()
      await expect(page).toHaveScreenshot(`conversation-confirm-phone-${theme}.png`)
    })

    test('list and conversation, desktop', async ({ page }) => {
      await page.setViewportSize(DESKTOP)
      await open(page, { scenario: 'iiw', open: 'c:marcus' }, theme)
      await expect(page.getByText('Marcus Chen verified you', { exact: true })).toBeVisible()
      await expect(page).toHaveScreenshot(`desktop-${theme}.png`)
    })
  })
}

test('conversation with a confirmation to answer, phone, German', async ({ page }) => {
  await page.setViewportSize(PHONE)
  await open(page, { scenario: 'iiw', open: 'c:marcus', lang: 'de' }, 'light')
  await expect(page.getByRole('button', { name: 'Ablehnen' })).toBeVisible()
  await expect(page.getByText('Wenn du ablehnst, erfährt Marcus davon nichts.', { exact: true })).toBeVisible()
  await expect(page).toHaveScreenshot('conversation-confirm-phone-de.png')
})

test('tapping a row opens the conversation and back returns (phone)', async ({ page }) => {
  await page.setViewportSize(PHONE)
  await open(page, { scenario: 'iiw' }, 'light')
  await page.getByRole('button', { name: /^Marcus Chen/ }).click()
  await expect(page.getByText('Marcus Chen verified you', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Back' }).click()
  await expect(page.getByRole('heading', { name: 'Contacts' })).toBeVisible()
})
