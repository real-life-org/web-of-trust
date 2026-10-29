// The two phones against a TSP 1.0 mediator (live, real network) in the harness page
// (`?carrier=live`). Runs only with RLTP_LIVE_MEDIATOR=1 and MEDIATOR_DID, the DID of a 1.0 instance
// (mediator 0.45 or later; there is no default: the storm.ws dev instance runs 0.44, Rev 3);
// MEDIATOR_ALLOW_INSECURE=1 admits a local instance on plaintext loopback endpoints. Optional beside
// e2e/mediator.spec.ts, which runs the same flow against the mediator double.
import { expect, test } from '@playwright/test'

test.skip(process.env.RLTP_LIVE_MEDIATOR !== '1', 'live only with RLTP_LIVE_MEDIATOR=1')

test('two phones over the live mediator: one scan, both see the success, a message each way', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 960 })
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
  const mediator = process.env.MEDIATOR_DID
  if (!mediator) throw new Error('live: MEDIATOR_DID names the TSP 1.0 mediator (0.45 or later)')
  const q = new URLSearchParams({ scenario: 'encounter', theme: 'light', carrier: 'live', mediator, ...(process.env.MEDIATOR_ALLOW_INSECURE === '1' ? { insecure: '1' } : {}) })
  await page.goto(`/?${q.toString()}`)
  const jonas = page.frameLocator('iframe[name=jonas]')
  const noah = page.frameLocator('iframe[name=noah]')
  await expect(jonas.getByRole('heading', { name: 'Contacts' })).toBeVisible({ timeout: 30_000 })
  await noah.getByRole('button', { name: 'Verify in person' }).click()
  await jonas.getByRole('button', { name: 'Verify in person' }).click()
  await jonas.getByRole('button', { name: 'Scan code' }).click()
  await jonas.getByRole('button', { name: 'Confirm', exact: true }).click()
  // one scan: Jonas's bundle reaches the instance of Noah's displayed card over the live mediator, and
  // Noah's code screen asks for Jonas by itself (E9)
  await expect(noah.getByRole('heading', { name: 'Is this the person in front of you?' })).toBeVisible({ timeout: 30_000 })
  await noah.getByRole('button', { name: 'Confirm', exact: true }).click()
  // both roles see the success
  await expect(noah.getByRole('heading', { name: /^You and \S+ are now connected\.$/ })).toBeVisible({ timeout: 30_000 })
  await expect(jonas.getByRole('heading', { name: /^You and \S+ are now connected\.$/ })).toBeVisible({ timeout: 30_000 })
  await noah.getByRole('button', { name: 'Open chat' }).click()
  await jonas.getByRole('button', { name: 'Open chat' }).click()
  await jonas.getByRole('textbox', { name: 'Message Noah' }).fill('Live over the mediator.')
  await jonas.getByRole('button', { name: 'Send' }).click()
  await expect(jonas.getByText(/Delivered/).last()).toBeVisible({ timeout: 30_000 })
  await noah.getByRole('textbox', { name: 'Message Jonas' }).fill('And back, live.')
  await noah.getByRole('button', { name: 'Send' }).click()
  await expect(noah.getByText(/Delivered/).last()).toBeVisible({ timeout: 30_000 })
})
