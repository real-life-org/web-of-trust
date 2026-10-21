// Report and block: every state of the report screens (light, dark, German), and on the two phones
// with the real library: block silently and unblock; report and block with the mail draft; without a
// mail app the address and text to copy; a blocked contact writes and nothing shows; a blocked contact is
// reported with the hidden messages in the selection only.
import { expect, test, type FrameLocator, type Page } from '@playwright/test'
import { REPORT_CATALOG } from '../harness/catalog-report'

const PHONE = { width: 390, height: 844 }
const GERMAN = ['report-info', 'report-selecting-blocked', 'report-review', 'report-handedOver', 'report-handedOver-shared', 'report-fallback']

async function open(page: Page, params: Record<string, string>, theme: 'light' | 'dark') {
  await page.setViewportSize(PHONE)
  await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' })
  await page.goto(`/?${new URLSearchParams({ ...params, theme }).toString()}`)
  await page.evaluate(() => document.fonts.ready.then(() => undefined))
}

for (const theme of ['light', 'dark'] as const) {
  test.describe(`report catalog ${theme}`, () => {
    for (const entry of REPORT_CATALOG) {
      test(entry.id, async ({ page }) => {
        await open(page, { catalog: entry.id }, theme)
        await expect(page.locator('section, main').filter({ visible: true }).first()).toBeVisible({ timeout: 20_000 })
        await expect(page).toHaveScreenshot(`${entry.id}-phone-${theme}.png`)
      })
    }
  })
}

test.describe('report catalog de', () => {
  for (const id of GERMAN) {
    test(id, async ({ page }) => {
      await open(page, { catalog: id, lang: 'de' }, 'light')
      await expect(page.locator('section, main').filter({ visible: true }).first()).toBeVisible({ timeout: 20_000 })
      await expect(page).toHaveScreenshot(`${id}-phone-de.png`)
    })
  }
})

async function pair(page: Page, scenario: 'conversation' | 'blocked') {
  await page.setViewportSize({ width: 900, height: 960 })
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
  await page.goto(`/?${new URLSearchParams({ scenario, theme: 'light' }).toString()}`)
  const jonas = page.frameLocator('iframe[name=jonas]')
  const noah = page.frameLocator('iframe[name=noah]')
  await expect(jonas.getByRole('heading', { name: 'Contacts' })).toBeVisible({ timeout: 30_000 })
  await expect(noah.getByRole('heading', { name: 'Contacts' })).toBeVisible({ timeout: 30_000 })
  return { jonas, noah }
}

const shot = (page: Page, phone: 'jonas' | 'noah', name: string) => expect(page.locator(`iframe[name=${phone}]`)).toHaveScreenshot(name)

async function details(f: FrameLocator, name: string) {
  await f.getByRole('button', { name: new RegExp(name) }).first().click()
  await f.getByRole('button', { name: new RegExp(`^${name}.*, Details$`) }).click()
  await expect(f.getByRole('heading', { name, level: 1 })).toBeVisible()
}

test('a blocked contact writes: the ack goes out, nothing shows; unblocking shows only what comes after', async ({ page }) => {
  const { jonas, noah } = await pair(page, 'blocked')
  await expect(noah.getByRole('button', { name: /Jonas Weber/ })).toContainText('blocked')
  await shot(page, 'noah', 'pair-noah-list-blocked.png')
  await jonas.getByRole('button', { name: /Noah Lindqvist/ }).click()
  await jonas.getByRole('textbox', { name: 'Message Noah' }).fill('Hello? Why no answer?')
  await jonas.getByRole('button', { name: 'Send' }).click()
  await expect(jonas.getByText(/Delivered ✓✓/).last()).toBeVisible()
  await noah.getByRole('button', { name: /Jonas Weber/ }).click()
  await expect(noah.getByText(/You blocked Jonas/)).toBeVisible()
  await expect(noah.getByText('Hello? Why no answer?')).toHaveCount(0)
  await shot(page, 'noah', 'pair-noah-conversation-blocked.png')
  await noah.getByRole('button', { name: /^Jonas Weber.*, Details$/ }).click()
  await expect(noah.getByRole('button', { name: 'Unblock' })).toBeVisible()
  await shot(page, 'noah', 'pair-noah-detail-blocked.png')
  await noah.getByRole('button', { name: 'Unblock' }).click()
  await expect(noah.getByRole('dialog')).toBeVisible()
  await shot(page, 'noah', 'pair-noah-unblock-sheet.png')
  await noah.getByRole('dialog').getByRole('button', { name: 'Unblock' }).click()
  await expect(noah.getByRole('button', { name: 'Block', exact: true })).toBeVisible()
  await jonas.getByRole('textbox', { name: 'Message Noah' }).fill('Now it works.')
  await jonas.getByRole('button', { name: 'Send' }).click()
  await noah.getByRole('button', { name: 'Open chat' }).click()
  await expect(noah.getByText('Now it works.', { exact: true }).last()).toBeVisible()
  await expect(noah.getByText('Hello? Why no answer?')).toHaveCount(0)
})

test('report after a silent block: the hidden messages appear only in the selection', async ({ page }) => {
  const { noah } = await pair(page, 'blocked')
  await noah.getByRole('button', { name: /Jonas Weber/ }).click()
  await expect(noah.getByText(/You blocked Jonas/)).toBeVisible()
  await expect(noah.getByText('Yes, see you at the stall.')).toHaveCount(0)
  await noah.getByRole('button', { name: /^Jonas Weber.*, Details$/ }).click()
  await noah.getByRole('button', { name: 'Report', exact: true }).click()
  await expect(noah.getByText(/is already blocked on this device/)).toBeVisible()
  await noah.getByRole('button', { name: 'Continue' }).click()
  await expect(noah.getByText(/This list also shows the messages hidden in the conversation/)).toBeVisible()
  await expect(noah.getByText('Yes, see you at the stall.')).toBeVisible()
  await shot(page, 'noah', 'pair-noah-report-select-blocked.png')
  await noah.getByRole('button', { name: 'Continue' }).click()
  await expect(noah.getByRole('button', { name: 'Write the mail' })).toBeVisible()
  await shot(page, 'noah', 'pair-noah-report-review-blocked.png')
})

test('block silently from the details', async ({ page }) => {
  const { noah } = await pair(page, 'conversation')
  await details(noah, 'Jonas Weber')
  await noah.getByRole('button', { name: 'Block', exact: true }).click()
  await expect(noah.getByRole('dialog')).toBeVisible()
  await shot(page, 'noah', 'pair-noah-block-sheet.png')
  await noah.getByRole('dialog').getByRole('button', { name: 'Block' }).click()
  await expect(noah.getByRole('button', { name: 'Unblock' })).toBeVisible()
})

test('report and block: notice, messages, mail; then the contact is blocked', async ({ page }) => {
  const { noah } = await pair(page, 'conversation')
  await details(noah, 'Jonas Weber')
  await noah.getByRole('button', { name: 'Report and block' }).click()
  await expect(noah.getByRole('heading', { name: 'Report Jonas Weber' })).toBeVisible()
  await shot(page, 'noah', 'pair-noah-report-info.png')
  await noah.getByRole('button', { name: 'Continue' }).click()
  await expect(noah.getByText(/of 20 selected/)).toBeVisible()
  await shot(page, 'noah', 'pair-noah-report-select.png')
  await noah.getByRole('button', { name: 'Continue' }).click()
  await expect(noah.getByText('report@real-life.org')).toBeVisible()
  await shot(page, 'noah', 'pair-noah-report-review.png')
  await noah.getByRole('button', { name: 'Block and write the mail' }).click()
  await expect(noah.getByRole('heading', { name: 'The mail is ready in your mail app' })).toBeVisible()
  await shot(page, 'noah', 'pair-noah-report-handed-over.png')
  await noah.getByRole('button', { name: 'Done' }).click()
  await expect(noah.getByText(/You blocked Jonas/)).toBeVisible()
})

test('report without a mail app: address and text to copy', async ({ page }) => {
  const { noah } = await pair(page, 'conversation')
  await page.getByLabel('Noah Lindqvist has a mail app').uncheck()
  await details(noah, 'Jonas Weber')
  await noah.getByRole('button', { name: 'Report and block' }).click()
  await noah.getByRole('button', { name: 'Continue' }).click()
  await noah.getByRole('button', { name: 'Continue' }).click()
  await noah.getByRole('button', { name: 'Block and write the mail' }).click()
  await expect(noah.getByRole('heading', { name: 'Send this text to report@real-life.org' })).toBeVisible()
  await noah.getByRole('button', { name: 'Copy text' }).click()
  await expect(noah.getByText('Copied', { exact: true })).toBeVisible()
  await shot(page, 'noah', 'pair-noah-report-fallback.png')
})
