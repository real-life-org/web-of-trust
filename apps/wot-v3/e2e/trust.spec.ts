// Trust on the two phones over the mediator double, with the real library: Noah switches trust on in
// Jonas's details and confirms the question; nothing on the wire says "trust" — Noah's anchor travels,
// and Jonas's details say "Noah trusts you" because Jonas now holds the verified anchor. Noah's own
// name reaches Jonas with it (the profile class follows the trust, Trust 2760).
import { expect, test, type FrameLocator, type Page } from '@playwright/test'

async function pair(page: Page) {
  await page.setViewportSize({ width: 900, height: 960 })
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
  await page.goto(`/?${new URLSearchParams({ scenario: 'conversation', theme: 'light' }).toString()}`)
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

test('Noah trusts Jonas from the details: the question, the switch on, "trusts you" on Jonas’s side; off asks again and sends nothing', async ({ page }) => {
  const { jonas, noah } = await pair(page)
  await details(noah, 'Jonas Weber')
  const sw = noah.getByRole('switch', { name: 'Give trust' })
  await expect(sw).toHaveAttribute('aria-checked', 'false')
  await expect(noah.getByText('No trust in either direction yet.')).toBeVisible()
  await sw.click()
  const dialog = noah.getByRole('dialog', { name: 'Trust Jonas Weber?' })
  await expect(dialog).toBeVisible()
  await shot(page, 'noah', 'pair-noah-trust-sheet.png')
  await dialog.getByRole('button', { name: 'Trust' }).click()
  await expect(dialog).toHaveCount(0)
  await expect(sw).toHaveAttribute('aria-checked', 'true')
  await expect(noah.getByText('You trust Jonas Weber. Jonas Weber has not disclosed anything yet.')).toBeVisible()
  await shot(page, 'noah', 'pair-noah-detail-trusted.png')

  // the library issues the anchor mapping on the holder's next resume, due now: the harness's virtual
  // clock stands still between button presses, a minute forward runs it (as device time would)
  await page.getByRole('button', { name: '+1 min' }).click()

  // Jonas: the anchor arrived, the details derive "trusts you" from it
  await details(jonas, 'Noah Lindqvist')
  await expect(jonas.getByText('Noah Lindqvist trusts you.')).toBeVisible({ timeout: 30_000 })
  await expect(jonas.getByRole('switch', { name: 'Give trust' })).toHaveAttribute('aria-checked', 'false')
  await shot(page, 'jonas', 'pair-jonas-detail-trusts-you.png')

  // Noah withdraws: asked again; Jonas keeps what it holds
  await sw.click()
  const off = noah.getByRole('dialog', { name: 'Withdraw trust?' })
  await expect(off).toContainText('You share nothing new with Jonas Weber any more')
  await off.getByRole('button', { name: 'Withdraw' }).click()
  await expect(sw).toHaveAttribute('aria-checked', 'false')
  await expect(noah.getByText('No trust in either direction yet.')).toBeVisible()
  await page.getByRole('button', { name: '+1 min' }).click()
  await expect(jonas.getByText('Noah Lindqvist trusts you.')).toBeVisible()
})
