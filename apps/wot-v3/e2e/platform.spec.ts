// Platform step (architecture §5) in the harness: the live verify flow on the fake camera (ready,
// denied, no camera), the background lock and its notice, the screenshot notice while words are
// typed, and the system back through flow and navigation. The device is driven over
// window.__wotDevice (harness/boot.ts). Native behaviour (FLAG_SECURE, the ZXing screen, the share
// sheet) is checked on the device at the cutover, not here.
import { expect, test, type Page } from '@playwright/test'

const PHONE = { width: 390, height: 844 }

/** window.__wotDevice of the harness (declared in harness/boot.ts, which this config does not compile) */
type Device = { background(): void; foreground(): void; back(): boolean; advance(ms: number): void; capture(): void; exits(): number }
declare global {
  interface Window {
    __wotDevice?: Device
  }
}

async function open(page: Page, params: Record<string, string>) {
  await page.setViewportSize(PHONE)
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
  await page.goto(`/?${new URLSearchParams({ ...params, theme: 'light' }).toString()}`)
  await page.evaluate(() => document.fonts.ready.then(() => undefined))
}

/** the two-phone page (loopback, real adapter); Jonas' phone frame */
async function jonas(page: Page, camera: string) {
  await page.setViewportSize({ width: 900, height: 960 })
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
  await page.goto(`/?${new URLSearchParams({ scenario: 'encounter', theme: 'light', camera }).toString()}`)
  const frame = page.frameLocator('iframe[name=jonas]')
  await expect(frame.getByRole('heading', { name: 'Contacts' })).toBeVisible({ timeout: 30_000 })
  return frame
}

for (const [camera, name, expectText] of [
  ['ok', 'ready', null],
  ['denied', 'denied', 'Camera not allowed'],
  ['unavailable', 'no-camera', 'No camera'],
] as const) {
  test(`scanner ${name}: the live verify flow on the fake camera`, async ({ page }) => {
    const phone = await jonas(page, camera)
    await phone.getByRole('button', { name: 'Verify in person' }).click()
    await phone.getByRole('button', { name: 'Scan code' }).click()
    if (camera === 'ok') await expect(phone.locator('[data-scan-viewport]')).toBeAttached()
    else await expect(phone.getByRole('button', { name: 'Enter code' })).toBeVisible()
    if (expectText) await expect(phone.getByText(expectText, { exact: true })).toBeVisible()
    await expect(page.locator('iframe[name=jonas]')).toHaveScreenshot(`platform-scanner-${name}.png`)
  })
}

test('background lock: after the delay the identity is locked and the unlock says why', async ({ page }) => {
  await open(page, { scenario: 'locked' })
  await page.locator('input[type=password]').fill('harness passphrase')
  await page.getByRole('button', { name: 'Unlock' }).click()
  // the biometric offer after a passphrase unlock (fake keystore has a fingerprint)
  await page.getByRole('button', { name: 'Not now' }).click()
  await expect(page.getByRole('heading', { name: 'Contacts' })).toBeVisible({ timeout: 20_000 })
  // shorter than the delay: still open
  await page.evaluate(() => {
    window.__wotDevice?.background()
    window.__wotDevice?.advance(4 * 60_000)
    window.__wotDevice?.foreground()
  })
  await expect(page.getByRole('heading', { name: 'Contacts' })).toBeVisible()
  // the full delay in the background: locked
  await page.evaluate(() => {
    window.__wotDevice?.background()
    window.__wotDevice?.advance(5 * 60_000)
    window.__wotDevice?.foreground()
  })
  await expect(page.getByText('Locked because the app was in the background.')).toBeVisible()
  await expect(page).toHaveScreenshot('platform-autolock-notice.png')
})

test('screenshot notice while the words are typed (iOS onCaptured)', async ({ page }) => {
  await open(page, { scenario: 'recovery' })
  await expect(page.getByRole('textbox')).toBeVisible({ timeout: 20_000 })
  await expect(page.getByRole('alert')).toHaveCount(0)
  await page.evaluate(() => window.__wotDevice?.capture())
  await expect(page.getByText('A screenshot was taken while your words were on screen.', { exact: false })).toBeVisible()
  await expect(page).toHaveScreenshot('platform-recovery-screenshot-notice.png')
})

test('system back: one step of the flow, then the navigation, the app is left only at its root', async ({ page }) => {
  const phone = await jonas(page, 'ok')
  const frame = page.frames().find((f) => f.name() === 'jonas')
  if (!frame) throw new Error('no phone frame')
  const back = () => frame.evaluate(() => window.__wotDevice?.back())
  await phone.getByRole('button', { name: 'Verify in person' }).click()
  await phone.getByRole('button', { name: 'Scan code' }).click()
  await expect(phone.locator('[data-scan-viewport]')).toBeAttached()
  // scanning → ready
  expect(await back()).toBe(true)
  await expect(phone.getByRole('button', { name: 'Scan code' })).toBeVisible()
  // ready → out of the flow, on the contacts
  expect(await back()).toBe(true)
  await expect(phone.getByRole('button', { name: 'Verify in person' })).toBeVisible()
  // the root: nobody takes it, the app is left
  expect(await back()).toBe(false)
  expect(await frame.evaluate(() => window.__wotDevice?.exits())).toBe(1)
})
