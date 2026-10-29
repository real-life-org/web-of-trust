// Flows on the desktop (handshake UX round 2.3, E5 Anton 29.10.): verify, report and the identity
// flows appear as a centered sheet in phone width; verify and report over the dimmed, inert shell,
// the identity flows on a calm background without columns. Baselines at 1280 × 800, light and dark:
// the catalog states (calm background) and the real shell on the two-phone page with desktop-sized
// frames. Behaviour: focus stays in the sheet, a click beside does nothing, Escape and × take the
// flow's back, focus returns to the opener. The phone baselines of every flow stay as they are
// (verify.spec, report.spec, identity.spec).
import { expect, test, type FrameLocator, type Page } from '@playwright/test'

const DESKTOP = { width: 1280, height: 800 }
const CATALOG = ['verify-ready', 'verify-scanning', 'verify-confirm', 'report-info', 'onboarding-welcome', 'onboarding-showWords', 'unlock-passphrase'] as const

async function open(page: Page, params: Record<string, string>, theme: 'light' | 'dark') {
  await page.setViewportSize(DESKTOP)
  await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' })
  await page.goto(`/?${new URLSearchParams({ ...params, theme }).toString()}`)
  await page.evaluate(() => document.fonts.ready.then(() => undefined))
}

for (const theme of ['light', 'dark'] as const) {
  test.describe(`desktop catalog ${theme}`, () => {
    for (const id of CATALOG) {
      test(id, async ({ page }) => {
        await open(page, { catalog: id }, theme)
        await expect(page.getByRole('dialog')).toBeVisible({ timeout: 20_000 })
        await expect(page).toHaveScreenshot(`desktop-${id}-${theme}.png`)
      })
    }
  })
}

// ── the real shell: two phones with desktop-sized frames ─────────────────────────────────────────

async function pair(page: Page, scenario: 'encounter' | 'conversation', theme: 'light' | 'dark') {
  await page.setViewportSize({ width: 2700, height: 1000 })
  await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' })
  await page.goto(`/?${new URLSearchParams({ scenario, theme }).toString()}`)
  const jonas = page.frameLocator('iframe[name=jonas]')
  const noah = page.frameLocator('iframe[name=noah]')
  await expect(jonas.getByRole('heading', { name: 'Contacts' })).toBeVisible({ timeout: 30_000 })
  await expect(noah.getByRole('heading', { name: 'Contacts' })).toBeVisible({ timeout: 30_000 })
  // each frame is its own viewport: from 48rem on, the shell has its columns and flows are sheets
  await page.evaluate(({ width, height }) => document.querySelectorAll('iframe').forEach((f) => Object.assign(f, { width: String(width), height: String(height) })), DESKTOP)
  await expect(noah.getByRole('navigation').first()).toBeVisible()
  return { jonas, noah }
}

/** a desktop frame as a screenshot; the QR codes carry fresh challenges and are masked */
async function shot(page: Page, phone: 'jonas' | 'noah', name: string, frame: FrameLocator) {
  await expect(page.locator(`iframe[name=${phone}]`)).toHaveScreenshot(name, { mask: [frame.locator('svg[role=img]')] })
}

for (const theme of ['light', 'dark'] as const) {
  test(`desktop ${theme}: Noah shows his code in a sheet over the shell, Jonas scans and confirms in one`, async ({ page }) => {
    const { jonas, noah } = await pair(page, 'encounter', theme)
    await noah.getByRole('button', { name: 'Verify in person' }).click()
    const sheet = noah.getByRole('dialog', { name: 'Verify in person' })
    await expect(sheet.getByRole('img', { name: 'Your verification code' })).toBeVisible()
    await shot(page, 'noah', `desktop-noah-ready-${theme}.png`, noah)
    await jonas.getByRole('button', { name: 'Verify in person' }).click()
    await jonas.getByRole('dialog').getByRole('button', { name: 'Scan code' }).click()
    await expect(jonas.getByRole('dialog').getByRole('heading', { name: 'Is Noah Lindqvist standing in front of you?' })).toBeVisible()
    await shot(page, 'jonas', `desktop-jonas-confirm-${theme}.png`, jonas)
  })

  test(`desktop ${theme}: report opens as a sheet over the contact, which stays in the detail column`, async ({ page }) => {
    const { noah } = await pair(page, 'conversation', theme)
    await noah.getByRole('button', { name: /Jonas Weber/ }).first().click()
    await noah.getByRole('button', { name: /^Jonas Weber.*, Details$/ }).click()
    await expect(noah.getByRole('heading', { name: 'Jonas Weber', level: 1 })).toBeVisible()
    await noah.getByRole('button', { name: 'Report and block' }).click()
    await expect(noah.getByRole('dialog').getByRole('heading', { name: 'Report Jonas Weber' })).toBeVisible()
    await shot(page, 'noah', `desktop-noah-report-info-${theme}.png`, noah)
    // Escape is the flow's back: the report ends, the contact is still there
    await noah.getByRole('dialog').press('Escape')
    await expect(noah.getByRole('dialog')).toHaveCount(0)
    await expect(noah.getByRole('heading', { name: 'Jonas Weber', level: 1 })).toBeVisible()
  })
}

// ── behaviour ────────────────────────────────────────────────────────────────────────────────

test('desktop: focus stays in the sheet, a click beside does nothing, Escape closes and focus returns', async ({ page }) => {
  await open(page, { scenario: 'iiw', open: 'c:marcus' }, 'light')
  const opener = page.getByRole('button', { name: 'Verify in person' }).first()
  await opener.click()
  const sheet = page.getByRole('dialog', { name: 'Verify in person' })
  await expect(sheet).toBeVisible()
  await expect(sheet).toHaveAttribute('aria-modal', 'true')
  // the shell behind is inert: no focus, no pointer
  expect(await page.evaluate(() => document.querySelector('[inert]')?.contains(document.querySelector('nav')) ?? false)).toBe(true)
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press('Tab')
    expect(await sheet.evaluate((el) => el.contains(document.activeElement))).toBe(true)
  }
  // beside the sheet: the list column and the conversation
  await page.mouse.click(120, 400)
  await page.mouse.click(1100, 400)
  await expect(sheet).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(opener).toBeFocused()
  // the conversation stayed in the detail column throughout
  await expect(page.getByText('Marcus Chen verified you', { exact: true })).toBeVisible()
})

test('desktop: the × of the sheet ends the flow like Escape', async ({ page }) => {
  await open(page, { scenario: 'iiw' }, 'light')
  await page.getByRole('button', { name: 'Verify in person' }).click()
  const sheet = page.getByRole('dialog', { name: 'Verify in person' })
  await sheet.getByRole('button', { name: 'Close' }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.getByText('Pick a conversation on the left.')).toBeVisible()
})

test('desktop: the sheet scrolls its content between a fixed header and footer', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 560 })
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
  await page.goto('/?catalog=onboarding-showWords')
  const sheet = page.getByRole('dialog')
  await expect(sheet).toBeVisible({ timeout: 20_000 })
  const box = await sheet.boundingBox()
  expect(box?.height).toBeLessThanOrEqual(560 - 64 + 1)
  const scroller = sheet.locator('.overflow-auto').first()
  const { scrollHeight, clientHeight } = await scroller.evaluate((el) => ({ scrollHeight: el.scrollHeight, clientHeight: el.clientHeight }))
  expect(scrollHeight).toBeGreaterThan(clientHeight)
  await expect(sheet.getByRole('heading', { level: 1 })).toBeInViewport()
})

test('phone: the flow is the full screen as before, no dialog', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
  await page.goto('/?scenario=iiw&theme=light')
  await page.getByRole('button', { name: 'Verify in person' }).click()
  await expect(page.getByRole('heading', { name: 'Verify in person' })).toBeVisible()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  expect(await page.evaluate(() => document.querySelector('[inert]'))).toBeNull()
})

// ── focus at the first step (review 473 F1): autoFocus of the first field takes, phone and desktop ──

for (const vp of [{ name: 'phone', size: { width: 390, height: 844 } }, { name: 'desktop', size: DESKTOP }] as const) {
  test(`${vp.name}: unlock focuses the password field`, async ({ page }) => {
    await page.setViewportSize(vp.size)
    await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
    await page.goto('/?scenario=locked&theme=light')
    await expect(page.getByLabel('Password', { exact: true })).toBeFocused({ timeout: 20_000 })
  })

  test(`${vp.name}: the unlock catalog state focuses the password field`, async ({ page }) => {
    await page.setViewportSize(vp.size)
    await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
    await page.goto('/?catalog=unlock-passphrase&theme=light')
    await expect(page.getByLabel('Password', { exact: true })).toBeFocused({ timeout: 20_000 })
  })
}
