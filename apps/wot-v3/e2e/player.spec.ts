// Scenario player (architecture §7.3) in the browser: phones as iframes with their own app
// instance, shared transport, timeline, clock, fault switches, view switches. Functional checks,
// no baselines; WOT_PLAYER_SHOTS=<dir> writes screenshots of the player for review.
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'

const WIDE = { width: 1920, height: 1000 }
const shots = process.env.WOT_PLAYER_SHOTS

async function shot(page: Page, name: string) {
  if (shots) await page.screenshot({ path: path.join(shots, `player-${name}.png`) })
}

async function openPlayer(page: Page, scenario = 'iiw-duo') {
  await page.setViewportSize(WIDE)
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
  await page.goto(`/harness.html?scenario=${scenario}`)
  await expect(page.getByRole('heading', { name: 'Scenario player' })).toBeVisible()
}

const phone = (page: Page, n: number, label: string) => page.frameLocator(`iframe[title="Phone ${n}: ${label}"]`)
const steps = (page: Page) => page.getByRole('list', { name: 'Steps' }).getByRole('listitem')
const transportState = (page: Page) => page.getByLabel('Transport state')

test('two phones side by side, each with its own app instance', async ({ page }) => {
  await openPlayer(page)
  await expect(page.locator('iframe')).toHaveCount(2)
  await expect(phone(page, 1, 'Jonas').getByRole('heading', { name: 'Contacts' })).toBeVisible({ timeout: 20_000 })
  await expect(phone(page, 1, 'Jonas').getByText('Priya Raman')).toBeVisible()
  await expect(phone(page, 2, 'Priya').getByText('Jonas Weber')).toBeVisible({ timeout: 20_000 })
  await expect(page.getByLabel('Player time')).toHaveText('15 Oct 2026, 13:30:00')
  await expect(steps(page)).toHaveCount(6)
  await shot(page, 'two-phones')
})

test('step plays the next timeline entry; a message crosses the shared transport', async ({ page }) => {
  await openPlayer(page)
  const jonas = phone(page, 1, 'Jonas')
  await expect(jonas.getByRole('heading', { name: 'Contacts' })).toBeVisible({ timeout: 20_000 })
  await expect(phone(page, 2, 'Priya').getByText('Jonas Weber')).toBeVisible({ timeout: 20_000 })
  await expect(steps(page).nth(0)).toHaveAttribute('aria-current', 'step')
  await page.getByRole('button', { name: 'Step', exact: true }).click()
  await expect(steps(page).nth(0)).toHaveAttribute('data-status', 'done')
  await expect(steps(page).nth(1)).toHaveAttribute('aria-current', 'step')
  await expect(jonas.getByText('Are you at the Key Recovery session?')).toBeVisible()
  await expect(page.getByLabel('Player time')).toHaveText('15 Oct 2026, 13:30:10')
  await expect(transportState(page)).toHaveText('up · queued 0 · delivered 1')
})

test('transport gone queues the message; back up delivers it', async ({ page }) => {
  await openPlayer(page)
  const jonas = phone(page, 1, 'Jonas')
  await expect(jonas.getByRole('heading', { name: 'Contacts' })).toBeVisible({ timeout: 20_000 })
  await expect(phone(page, 2, 'Priya').getByText('Jonas Weber')).toBeVisible({ timeout: 20_000 })
  await page.getByRole('switch', { name: 'Transport gone' }).click()
  await expect(transportState(page)).toHaveText(/^down/)
  await page.getByRole('button', { name: 'Step', exact: true }).click()
  await expect(transportState(page)).toHaveText('down · queued 1 · delivered 0')
  await expect(jonas.getByText('Are you at the Key Recovery session?')).toHaveCount(0)
  await expect(page.getByLabel('Inspector')).toContainText('"carrier": "unreachable"')
  await shot(page, 'transport-down')
  await page.getByRole('switch', { name: 'Transport gone' }).click()
  await expect(transportState(page)).toHaveText('up · queued 0 · delivered 1')
  await expect(jonas.getByText('Are you at the Key Recovery session?')).toBeVisible()
})

test('play runs the timeline to its end; pause in between', async ({ page }) => {
  await openPlayer(page)
  await expect(phone(page, 1, 'Jonas').getByRole('heading', { name: 'Contacts' })).toBeVisible({ timeout: 20_000 })
  await expect(phone(page, 2, 'Priya').getByText('Jonas Weber')).toBeVisible({ timeout: 20_000 })
  await page.getByRole('button', { name: 'Play' }).click()
  await expect(page.getByRole('button', { name: 'Pause' })).toBeVisible()
  await page.getByRole('button', { name: 'Pause' }).click()
  await expect(page.getByRole('button', { name: 'Play' })).toBeVisible()
  await page.getByRole('button', { name: 'Play' }).click()
  await expect(steps(page).nth(5)).toHaveAttribute('data-status', 'done', { timeout: 15_000 })
  await expect(page.getByRole('button', { name: 'Play' })).toBeDisabled()
  // Marcus (phone 3) is not shown: his message still reaches Jonas
  await expect(page.getByLabel('Player log')).toContainText('phone 3 not shown')
  await expect(phone(page, 1, 'Jonas').getByText('Marcus Chen')).toBeVisible()
  await shot(page, 'timeline-done')
})

test('clock: forward, set back, jump', async ({ page }) => {
  await openPlayer(page)
  await expect(phone(page, 1, 'Jonas').getByRole('heading', { name: 'Contacts' })).toBeVisible({ timeout: 20_000 })
  await expect(page.getByLabel('Player time')).toHaveText('15 Oct 2026, 13:30:00')
  await page.getByRole('button', { name: '+1 h' }).click()
  await expect(page.getByLabel('Player time')).toHaveText('15 Oct 2026, 14:30:00')
  await page.getByRole('button', { name: '+1 day' }).click()
  await expect(page.getByLabel('Player time')).toHaveText('16 Oct 2026, 14:30:00')
  await page.getByRole('button', { name: '−1 h' }).click()
  await expect(page.getByLabel('Player time')).toHaveText('16 Oct 2026, 13:30:00set back')
  await expect(page.getByLabel('Inspector')).toContainText('"clock": "behind"')
  await page.getByLabel('Jump to').fill('2026-10-17T09:00')
  await page.getByRole('button', { name: 'Jump' }).click()
  await expect(page.getByLabel('Player time')).toHaveText('17 Oct 2026, 09:00:00')
  await expect(page.getByLabel('Inspector')).toContainText('"now": "2026-10-17T16:00:00.000Z"')
  // across the end of summer time: the wall time is read with the offset of the target date
  await page.getByLabel('Jump to').fill('2026-11-02T09:00')
  await page.getByRole('button', { name: 'Jump' }).click()
  await expect(page.getByLabel('Player time')).toHaveText('2 Nov 2026, 09:00:00')
})

test('slow phone start: steps wait for the phones, a theme chosen meanwhile sticks', async ({ page }) => {
  await page.route(/harness\.html\?phone=/, async (route) => {
    await new Promise((r) => setTimeout(r, 1_500))
    await route.continue()
  })
  await page.setViewportSize(WIDE)
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
  await page.goto('/harness.html?scenario=iiw-duo')
  await expect(page.getByRole('button', { name: 'Step', exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Play' })).toBeDisabled()
  await expect(page.getByText('Waiting for the phones to start…')).toBeVisible()
  await page.getByRole('tablist', { name: 'Theme' }).getByRole('tab', { name: 'Dark' }).click()
  await expect(phone(page, 2, 'Priya').getByText('Jonas Weber')).toBeVisible({ timeout: 20_000 })
  await expect(page.getByRole('button', { name: 'Step', exact: true })).toBeEnabled()
  await expect(phone(page, 1, 'Jonas').locator('html')).toHaveAttribute('data-theme', 'dark')
  await expect(phone(page, 2, 'Priya').locator('html')).toHaveAttribute('data-theme', 'dark')
  await page.getByRole('button', { name: 'Step', exact: true }).click()
  await expect(page.getByLabel('Player time')).toHaveText('15 Oct 2026, 13:30:10')
  await expect(phone(page, 2, 'Priya').getByText('You: Are you at the Key Recovery session?')).toBeVisible()
  await expect(phone(page, 1, 'Jonas').getByText('Are you at the Key Recovery session?')).toBeVisible()
})

test('fault switches reach every phone', async ({ page }) => {
  await openPlayer(page)
  await expect(phone(page, 2, 'Priya').getByText('Jonas Weber')).toBeVisible({ timeout: 20_000 })
  for (const name of ['Vault write fails', 'Biometrics unavailable', 'Host close fails']) await page.getByRole('switch', { name }).click()
  const inspector = page.getByLabel('Inspector')
  await expect(inspector.getByText('"vault": "fails"')).toHaveCount(2)
  await expect(inspector.getByText('"biometric": "unavailable"')).toHaveCount(2)
  await expect(inspector.getByText('"hostClose": "fails"')).toHaveCount(2)
  await shot(page, 'faults')
})

test('phones 1 to 3, language, theme', async ({ page }) => {
  await openPlayer(page)
  const phones = page.getByRole('tablist', { name: 'Phones' })
  await phones.getByRole('tab', { name: '3' }).click()
  await expect(page.locator('iframe')).toHaveCount(3)
  await expect(phone(page, 3, 'Marcus').getByText('Jonas Weber')).toBeVisible({ timeout: 20_000 })
  await phones.getByRole('tab', { name: '1' }).click()
  await expect(page.locator('iframe')).toHaveCount(1)
  const jonas = phone(page, 1, 'Jonas')
  await expect(jonas.getByRole('heading', { name: 'Contacts' })).toBeVisible({ timeout: 20_000 })
  await page.getByRole('tablist', { name: 'Language' }).getByRole('tab', { name: 'DE' }).click()
  await expect(jonas.getByRole('heading', { name: 'Kontakte' })).toBeVisible()
  await page.getByRole('tablist', { name: 'Theme' }).getByRole('tab', { name: 'Dark' }).click()
  await expect(jonas.locator('html')).toHaveAttribute('data-theme', 'dark')
  await phones.getByRole('tab', { name: '3' }).click()
  await expect(phone(page, 3, 'Marcus').getByRole('heading', { name: 'Kontakte' })).toBeVisible({ timeout: 20_000 })
  await expect(phone(page, 3, 'Marcus').locator('html')).toHaveAttribute('data-theme', 'dark')
  await expect(page.getByLabel('Inspector').locator('pre')).toHaveCount(3)
  await shot(page, 'three-phones-de-dark')
})

test('screen catalog on phone 1 and back to live', async ({ page }) => {
  await openPlayer(page)
  await page.getByLabel('Screen catalog (phone 1)').selectOption('unlock-passphrase')
  const first = phone(page, 1, 'Jonas')
  await expect(first.getByLabel('Password', { exact: true })).toBeVisible({ timeout: 20_000 })
  await shot(page, 'catalog')
  await page.getByLabel('Screen catalog (phone 1)').selectOption('')
  await expect(phone(page, 1, 'Jonas').getByRole('heading', { name: 'Contacts' })).toBeVisible({ timeout: 20_000 })
})

test('switching the scenario: an identity scenario, unlocked in the phone', async ({ page }) => {
  await openPlayer(page)
  await page.getByRole('combobox', { name: 'Scenario' }).selectOption('locked')
  await expect(page.locator('iframe')).toHaveCount(1)
  await expect(page.getByText('This scenario has no timeline.')).toBeVisible()
  const p = phone(page, 1, 'Device 1')
  await p.getByLabel('Password', { exact: true }).fill('harness passphrase')
  await p.getByRole('button', { name: 'Unlock' }).click()
  await p.getByRole('button', { name: 'Not now' }).click()
  await expect(p.getByRole('heading', { name: 'Contacts' })).toBeVisible()
  await expect(page.getByLabel('Inspector')).toContainText('"identity": "unlocked"')
})
