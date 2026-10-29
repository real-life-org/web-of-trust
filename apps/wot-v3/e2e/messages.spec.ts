// Messages: every look of a message (simulation, light and dark, German), and the two phones on the
// real adapter and the real library: writing, receiving with unread count, offline catch-up, a
// message held until the relationship is ready.
import { expect, test, type FrameLocator, type Page } from '@playwright/test'

const PHONE = { width: 390, height: 844 }

async function open(page: Page, params: Record<string, string>, theme: 'light' | 'dark') {
  await page.setViewportSize(PHONE)
  await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' })
  await page.goto(`/?${new URLSearchParams({ ...params, theme }).toString()}`)
  await page.evaluate(() => document.fonts.ready.then(() => undefined))
}

for (const theme of ['light', 'dark'] as const) {
  test(`message states, ${theme}`, async ({ page }) => {
    await open(page, { scenario: 'message-states', open: 'c:noah' }, theme)
    await expect(page.getByText('And this one is on its way.').last()).toBeVisible()
    await expect(page).toHaveScreenshot(`message-states-phone-${theme}.png`)
  })
}

test('message states, German', async ({ page }) => {
  await open(page, { scenario: 'message-states', open: 'c:noah', lang: 'de' }, 'light')
  await expect(page.getByText(/Wartet auf Verbindung/)).toBeVisible()
  await expect(page).toHaveScreenshot('message-states-phone-de.png')
})

async function pair(page: Page, scenario: 'conversation' | 'encounter') {
  await page.setViewportSize({ width: 900, height: 960 })
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
  await page.goto(`/?${new URLSearchParams({ scenario, theme: 'light' }).toString()}`)
  const jonas = page.frameLocator('iframe[name=jonas]')
  const noah = page.frameLocator('iframe[name=noah]')
  await expect(jonas.getByRole('heading', { name: 'Contacts' })).toBeVisible({ timeout: 30_000 })
  await expect(noah.getByRole('heading', { name: 'Contacts' })).toBeVisible({ timeout: 30_000 })
  return { jonas, noah }
}

const shot = (page: Page, phone: 'jonas' | 'noah', name: string, frame: FrameLocator) =>
  expect(page.locator(`iframe[name=${phone}]`)).toHaveScreenshot(name, { mask: [frame.locator('svg[role=img]')] })

const composer = (f: FrameLocator, name: string) => f.getByRole('textbox', { name: `Message ${name}` })

test('two phones after meeting: the conversation, writing, the unread count, reading', async ({ page }) => {
  const { jonas, noah } = await pair(page, 'conversation')
  await expect(noah.getByRole('button', { name: /Jonas Weber/ })).toContainText('Yes, see you at the stall.')
  await shot(page, 'noah', 'pair-noah-list-unread.png', noah)
  await jonas.getByRole('button', { name: /Noah Lindqvist/ }).click()
  await expect(jonas.getByText('Yes, see you at the stall.', { exact: true }).last()).toBeVisible()
  await shot(page, 'jonas', 'pair-jonas-conversation.png', jonas)
  await composer(jonas, 'Noah').fill('I will bring the printed spec.')
  await jonas.getByRole('button', { name: 'Send' }).click()
  await expect(composer(jonas, 'Noah')).toHaveValue('')
  await expect(jonas.getByText(/Delivered/).last()).toBeVisible()
  await noah.getByRole('button', { name: /Jonas Weber/ }).click()
  await expect(noah.getByText('I will bring the printed spec.', { exact: true }).last()).toBeVisible()
  await shot(page, 'noah', 'pair-noah-conversation.png', noah)
  await noah.getByRole('button', { name: 'Back' }).click()
  await expect(noah.getByRole('button', { name: /Jonas Weber/ })).not.toContainText(/unread/)
})

test('two phones: Noah offline, Jonas writes; it waits at the carrier and arrives once Noah is online', async ({ page }) => {
  const { jonas, noah } = await pair(page, 'conversation')
  await page.getByLabel('Noah Lindqvist online').uncheck()
  await jonas.getByRole('button', { name: /Noah Lindqvist/ }).click()
  await composer(jonas, 'Noah').fill('Are you still at the stall?')
  await composer(jonas, 'Noah').press('Enter')
  await expect(jonas.getByText(/Sent ✓/).last()).toBeVisible()
  await shot(page, 'jonas', 'pair-jonas-sent-offline.png', jonas)
  await page.getByLabel('Noah Lindqvist online').check()
  await expect(jonas.getByText(/Delivered ✓✓/).last()).toBeVisible()
  await noah.getByRole('button', { name: /Jonas Weber/ }).click()
  await expect(noah.getByText('Are you still at the stall?', { exact: true }).last()).toBeVisible()
})

test('two phones: before anything of Noah arrived, the message waits for the connection and goes out by itself', async ({ page }) => {
  const { jonas, noah } = await pair(page, 'encounter')
  await page.getByLabel('Noah Lindqvist online').uncheck()
  await noah.getByRole('button', { name: 'Verify in person' }).click()
  await expect(noah.getByRole('img', { name: 'Your verification code' })).toBeVisible()
  await jonas.getByRole('button', { name: 'Verify in person' }).click()
  await jonas.getByRole('button', { name: 'Scan code' }).click()
  await jonas.getByRole('button', { name: 'Confirm', exact: true }).click()
  await jonas.getByRole('button', { name: 'Go to chat' }).click()
  await composer(jonas, 'Noah').fill('Hi Noah, this is Jonas.')
  await jonas.getByRole('button', { name: 'Send' }).click()
  await expect(jonas.getByText(/Waiting for connection/).last()).toBeVisible()
  await shot(page, 'jonas', 'pair-jonas-held.png', jonas)
  await page.getByLabel('Noah Lindqvist online').check()
  await expect(jonas.getByText(/Delivered ✓✓/).last()).toBeVisible()
  await noah.getByRole('button', { name: 'Close' }).click()
  await noah.getByRole('button', { name: /Jonas Weber/ }).click()
  await expect(noah.getByText('Hi Noah, this is Jonas.', { exact: true }).last()).toBeVisible()
})
