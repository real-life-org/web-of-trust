// The two phones against the VTI dev instance (live, real network) in the harness page
// (`?carrier=live`). Runs only with RLTP_LIVE_MEDIATOR=1; MEDIATOR_DID names another instance.
// Optional beside e2e/mediator.spec.ts, which runs the same flow against the mediator double.
import { expect, test } from '@playwright/test'

test.skip(process.env.RLTP_LIVE_MEDIATOR !== '1', 'live only with RLTP_LIVE_MEDIATOR=1')

test('two phones over the live mediator: encounter with hints, a message each way', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 960 })
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
  const q = new URLSearchParams({ scenario: 'encounter', theme: 'light', carrier: 'live', ...(process.env.MEDIATOR_DID ? { mediator: process.env.MEDIATOR_DID } : {}) })
  await page.goto(`/?${q.toString()}`)
  const jonas = page.frameLocator('iframe[name=jonas]')
  const noah = page.frameLocator('iframe[name=noah]')
  await expect(jonas.getByRole('heading', { name: 'Contacts' })).toBeVisible({ timeout: 30_000 })
  await noah.getByRole('button', { name: 'Verify in person' }).click()
  await jonas.getByRole('button', { name: 'Verify in person' }).click()
  await jonas.getByRole('button', { name: 'Scan code' }).click()
  await jonas.getByRole('button', { name: 'Yes, verify Noah' }).click()
  await page.getByRole('button', { name: '+1 min' }).click()
  await jonas.getByRole('button', { name: 'Show code' }).click()
  await noah.getByRole('button', { name: 'Scan code' }).click()
  await noah.getByRole('button', { name: 'Yes, verify Jonas' }).click()
  await noah.getByRole('button', { name: 'Yes, confirm' }).click()
  await expect(jonas.getByRole('heading', { name: 'Mutually verified' })).toBeVisible({ timeout: 30_000 })
  await jonas.getByRole('button', { name: 'Open chat' }).click()
  await jonas.getByRole('textbox', { name: 'Message Noah' }).fill('Live over the mediator.')
  await jonas.getByRole('button', { name: 'Send' }).click()
  await expect(jonas.getByText(/Delivered/).last()).toBeVisible({ timeout: 30_000 })
  await noah.getByRole('button', { name: 'Open chat' }).click()
  await noah.getByRole('textbox', { name: 'Message Jonas' }).fill('And back, live.')
  await noah.getByRole('button', { name: 'Send' }).click()
  await expect(noah.getByText(/Delivered/).last()).toBeVisible({ timeout: 30_000 })
})
