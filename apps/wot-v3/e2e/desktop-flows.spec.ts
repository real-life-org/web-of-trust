// The three frames of the desktop (canvas "WoT v3 Desktop-Layout", Anton 29.10.) at 1280 × 800, light
// and dark. App: the sidebar always, two columns only where there is content (the list with its
// conversation); an empty list, the groups placeholder and the profile are one column. Page: verify
// and report in the content column with the sidebar (“‹ Contacts”, ×); unlock, setup and restore a
// whole page without navigation under the app's header. Dialog: only for one question
// (counter-verification, success). Pages and dialog share one content width, 440 px (max-w-narrow,
// canvas artboard "Dialog"; Anton 29.10.).
// Baselines: the catalog states and the real shell on the two-phone page with desktop-sized frames.
// Behaviour (E5): the page takes the focus, a click beside does nothing, Escape and × take the flow's
// back, focus returns to the opener, nothing remounts across the breakpoint. The phone baselines of
// every flow stay as they are (verify.spec, report.spec, identity.spec).
import { expect, test, type FrameLocator, type Page } from '@playwright/test'

const DESKTOP = { width: 1280, height: 800 }
/** pages in the app, pages without navigation, and the question over a page */
const CATALOG = [
  'verify-ready',
  'verify-scanning',
  'verify-confirm',
  'verify-success',
  'report-info',
  'onboarding-welcome',
  'onboarding-showWords',
  'unlock-passphrase',
  'verify-sheet-incoming',
] as const

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
        await expect(page.locator('[data-slot=page]')).toBeVisible({ timeout: 20_000 })
        if (id === 'verify-sheet-incoming') await expect(page.getByRole('dialog')).toBeVisible()
        else await expect(page.getByRole('dialog')).toHaveCount(0)
        await expect(page).toHaveScreenshot(`desktop-${id}-${theme}.png`)
      })
    }
  })

  test.describe(`desktop app ${theme}`, () => {
    test('an empty list is one column with its empty state', async ({ page }) => {
      await open(page, { scenario: 'empty' }, theme)
      await expect(page.getByText('No contacts yet')).toBeVisible({ timeout: 20_000 })
      await expect(page.getByText('Pick a conversation on the left.')).toHaveCount(0)
      await expect(page).toHaveScreenshot(`desktop-empty-${theme}.png`)
    })

    test('the groups placeholder is one column', async ({ page }) => {
      await open(page, { scenario: 'iiw' }, theme)
      await page.getByRole('navigation').first().getByRole('button', { name: /^Groups/ }).click()
      await expect(page.getByText('This area follows in a later step.')).toBeVisible()
      await expect(page.getByText('Pick a conversation on the left.')).toHaveCount(0)
      await expect(page).toHaveScreenshot(`desktop-groups-${theme}.png`)
    })

    test('the profile is one centered column', async ({ page }) => {
      await open(page, { scenario: 'iiw' }, theme)
      await page.getByRole('navigation').first().getByRole('button', { name: /^Profile/ }).click()
      await expect(page.getByRole('heading', { name: 'Profile' })).toBeVisible()
      const box = await page.getByRole('heading', { name: 'Profile' }).locator('xpath=..').boundingBox()
      expect(box?.width).toBe(720)
      await expect(page).toHaveScreenshot(`desktop-profile-${theme}.png`)
    })

    test('a question is a dialog over the columns', async ({ page }) => {
      await open(page, { scenario: 'iiw', open: 'c:marcus' }, theme)
      await page.getByRole('button', { name: 'Respond' }).click()
      await expect(page.getByRole('dialog')).toHaveAttribute('aria-modal', 'true')
      await expect(page).toHaveScreenshot(`desktop-question-${theme}.png`)
    })
  })
}

// ── the real shell: two phones with desktop-sized frames ─────────────────────────────────────────

async function pair(page: Page, scenario: 'encounter' | 'conversation', theme: 'light' | 'dark') {
  await page.setViewportSize({ width: 2700, height: 1000 })
  await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' })
  await page.goto(`/?${new URLSearchParams({ scenario, theme, ...(scenario === 'encounter' ? { carrier: 'mediator' } : {}) }).toString()}`)
  const jonas = page.frameLocator('iframe[name=jonas]')
  const noah = page.frameLocator('iframe[name=noah]')
  await expect(jonas.getByRole('heading', { name: 'Contacts' })).toBeVisible({ timeout: 30_000 })
  await expect(noah.getByRole('heading', { name: 'Contacts' })).toBeVisible({ timeout: 30_000 })
  // each frame is its own viewport: from 48rem on, the shell has its sidebar and flows are pages
  await resize(page, DESKTOP)
  await expect(noah.getByRole('navigation').first()).toBeVisible()
  return { jonas, noah }
}

async function resize(page: Page, size: { width: number; height: number }) {
  await page.evaluate(({ width, height }) => document.querySelectorAll('iframe').forEach((f) => Object.assign(f, { width: String(width), height: String(height) })), size)
}

const QUESTION = 'Is this the person in front of you?'
const SUCCESS = /^You and \S+ are now connected\.$/

/** a desktop frame as a screenshot; the QR codes carry fresh challenges and are masked */
async function shot(page: Page, phone: 'jonas' | 'noah', name: string, frame: FrameLocator) {
  await expect(page.locator(`iframe[name=${phone}]`)).toHaveScreenshot(name, { mask: [frame.locator('svg[role=img]')] })
}

for (const theme of ['light', 'dark'] as const) {
  test(`desktop ${theme}: verify is a page beside the sidebar: Noah shows, Jonas scans and confirms, Noah's page asks, both see the success`, async ({ page }) => {
    const { jonas, noah } = await pair(page, 'encounter', theme)
    await noah.getByRole('button', { name: 'Verify in person' }).click()
    const noahPage = noah.getByRole('region', { name: 'Verify in person' })
    await expect(noahPage.getByRole('img', { name: 'Your verification code' })).toBeVisible()
    await expect(noah.getByRole('dialog')).toHaveCount(0)
    await expect(noah.getByRole('navigation').first()).toBeVisible()
    await shot(page, 'noah', `desktop-noah-ready-${theme}.png`, noah)
    await jonas.getByRole('button', { name: 'Verify in person' }).click()
    await jonas.getByRole('region', { name: 'Verify in person' }).getByRole('button', { name: 'Scan code' }).click()
    await expect(jonas.getByRole('heading', { name: QUESTION })).toBeVisible()
    await shot(page, 'jonas', `desktop-jonas-confirm-${theme}.png`, jonas)
    await jonas.getByRole('button', { name: 'Confirm', exact: true }).click()
    // Noah's code page asks by itself, inside the same page
    await expect(noahPage.getByRole('heading', { name: QUESTION })).toBeVisible({ timeout: 20_000 })
    await shot(page, 'noah', `desktop-noah-confirm-incoming-${theme}.png`, noah)
    await noahPage.getByRole('button', { name: 'Confirm', exact: true }).click()
    await expect(noahPage.getByRole('heading', { name: SUCCESS })).toBeVisible()
    await expect(jonas.getByRole('heading', { name: SUCCESS })).toBeVisible({ timeout: 20_000 })
    // the flow shows the success itself: no dialog on top
    await expect(noah.getByRole('dialog')).toHaveCount(0)
    await expect(jonas.getByRole('dialog')).toHaveCount(0)
    await shot(page, 'noah', `desktop-noah-success-${theme}.png`, noah)
    await shot(page, 'jonas', `desktop-jonas-success-${theme}.png`, jonas)
  })

  test(`desktop ${theme}: report is a page beside the sidebar; Escape is back to the contact`, async ({ page }) => {
    const { noah } = await pair(page, 'conversation', theme)
    await noah.getByRole('button', { name: /Jonas Weber/ }).first().click()
    await noah.getByRole('button', { name: /^Jonas Weber.*, Details$/ }).click()
    await expect(noah.getByRole('heading', { name: 'Jonas Weber', level: 1 })).toBeVisible()
    await noah.getByRole('button', { name: 'Report and block' }).click()
    await expect(noah.getByRole('heading', { name: 'Report Jonas Weber' })).toBeVisible()
    await expect(noah.getByRole('dialog')).toHaveCount(0)
    await shot(page, 'noah', `desktop-noah-report-info-${theme}.png`, noah)
    await noah.getByRole('heading', { name: 'Report Jonas Weber' }).press('Escape')
    await expect(noah.getByRole('heading', { name: 'Report Jonas Weber' })).toHaveCount(0)
    await expect(noah.getByRole('heading', { name: 'Jonas Weber', level: 1 })).toBeVisible()
  })
}

test('desktop: the verify page keeps what was typed when its window crosses the breakpoint and back', async ({ page }) => {
  const { noah } = await pair(page, 'encounter', 'light')
  await noah.getByRole('button', { name: 'Verify in person' }).click()
  await noah.getByRole('button', { name: 'Enter code' }).click()
  const field = noah.getByRole('textbox')
  await field.fill('wot:typed')
  await resize(page, { width: 390, height: 800 })
  await expect(noah.getByRole('navigation').first()).toBeHidden()
  await expect(noah.getByRole('textbox')).toHaveValue('wot:typed')
  await resize(page, DESKTOP)
  await expect(noah.getByRole('navigation').first()).toBeVisible()
  await expect(noah.getByRole('textbox')).toHaveValue('wot:typed')
})

// ── behaviour ────────────────────────────────────────────────────────────────────────────────

test('desktop: the page takes the focus, a click beside does nothing, Escape closes and focus returns', async ({ page }) => {
  await open(page, { scenario: 'iiw', open: 'c:marcus' }, 'light')
  const opener = page.getByRole('button', { name: 'Verify in person' }).first()
  await opener.click()
  const region = page.getByRole('region', { name: 'Verify in person' })
  await expect(region).toBeVisible()
  await expect(region.getByRole('heading', { level: 1 })).toBeFocused()
  // the column has the one narrow content width, as the dialog
  expect((await region.locator('.max-w-narrow').first().boundingBox())?.width).toBe(440)
  // no columns while the ceremony runs, the sidebar stays and is not inert
  await expect(page.getByText('Marcus Chen verified you', { exact: true })).toHaveCount(0)
  await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeVisible()
  expect(await page.evaluate(() => document.querySelector('[inert]'))).toBeNull()
  // beside the column: empty page space left and right
  await page.mouse.click(300, 400)
  await page.mouse.click(1200, 400)
  await expect(region).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(region).toHaveCount(0)
  await expect(opener).toBeFocused()
  await expect(page.getByText('Marcus Chen verified you', { exact: true })).toBeVisible()
})

test('desktop: “‹ Contacts” and × of the page end the flow like Escape', async ({ page }) => {
  await open(page, { scenario: 'iiw' }, 'light')
  await page.getByRole('button', { name: 'Verify in person' }).click()
  const region = page.getByRole('region', { name: 'Verify in person' })
  await region.getByRole('button', { name: 'Close' }).click()
  await expect(region).toHaveCount(0)
  await expect(page.getByText('Pick a conversation on the left.')).toBeVisible()
  await page.getByRole('button', { name: 'Verify in person' }).click()
  await region.getByRole('button', { name: 'Contacts' }).click()
  await expect(region).toHaveCount(0)
  await expect(page.getByText('Pick a conversation on the left.')).toBeVisible()
})

test('desktop: another area in the sidebar ends the page', async ({ page }) => {
  await open(page, { scenario: 'iiw' }, 'light')
  await page.getByRole('button', { name: 'Verify in person' }).click()
  await page.getByRole('navigation').first().getByRole('button', { name: /^Profile/ }).click()
  await expect(page.getByRole('region', { name: 'Verify in person' })).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'Profile' })).toBeVisible()
})

test('desktop: a page without navigation scrolls its content under a fixed header', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 560 })
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
  await page.goto('/?catalog=onboarding-showWords')
  const main = page.getByRole('main')
  await expect(main).toBeVisible({ timeout: 20_000 })
  await expect(page.getByRole('navigation')).toHaveCount(0)
  const scroller = main.locator('.overflow-auto').first()
  const { scrollHeight, clientHeight } = await scroller.evaluate((el) => ({ scrollHeight: el.scrollHeight, clientHeight: el.clientHeight }))
  expect(scrollHeight).toBeGreaterThan(clientHeight)
  await scroller.evaluate((el) => el.scrollTo(0, el.scrollHeight))
  await expect(page.getByRole('banner')).toBeInViewport()
  const column = await main.getByRole('list', { name: 'Your 12 Magic Words' }).locator('xpath=ancestor::div[contains(@class,"max-w-")][1]').boundingBox()
  expect(column?.width).toBe(440)
})

test('phone: the flow is the full screen as before, no dialog, no area link', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
  await page.goto('/?scenario=iiw&theme=light')
  await page.getByRole('button', { name: 'Verify in person' }).click()
  await expect(page.getByRole('heading', { name: 'Verify in person' })).toBeVisible()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Contacts', exact: true })).toHaveCount(0)
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
