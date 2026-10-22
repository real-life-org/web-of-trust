// harness.html?measure=kdf (architecture §5.2): the page runs the unlock measurement and shows a
// result (median, min, max), and copies it as text.
import { expect, test } from '@playwright/test'

test('the unlock measurement page shows a result and copies it', async ({ page, context }) => {
  test.setTimeout(120_000)
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.goto('/harness.html?measure=kdf')
  await expect(page.getByRole('heading', { name: 'Unlock measurement', level: 1 })).toBeVisible()
  const result = page.locator('[data-kdf-result]')
  await expect(result).toBeVisible({ timeout: 100_000 })
  await expect(result).toContainText(/\d+ ms/)
  await expect(result).toContainText('median')
  await page.getByRole('button', { name: 'Copy result' }).click()
  await expect(page.getByText('Copied.')).toBeVisible()
  const text = await page.evaluate(() => navigator.clipboard.readText())
  expect(text).toMatch(/^WoT v3 unlock measurement/)
  expect(text).toMatch(/PBKDF2-HMAC-SHA-256 600000 iterations \+ AES-256-GCM, 10 runs/)
  expect(text).toMatch(/median \d+ ms, min \d+ ms, max \d+ ms/)
  expect(text).toMatch(/cores \(hardwareConcurrency\): \d+/)
})
