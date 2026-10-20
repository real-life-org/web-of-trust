// Verify in person: every state of the verify machine from the screen catalog (light, dark, German
// for the main steps), and the harness scenario "two phones meet" clicked through on the real
// adapter and the real library (loopback): network path and optical return path.
import { expect, test, type FrameLocator, type Page } from '@playwright/test'
import { VERIFY_CATALOG } from '../harness/catalog-verify'

const PHONE = { width: 390, height: 844 }
const GERMAN = ['verify-ready', 'verify-confirm', 'verify-waiting-long', 'verify-fallback', 'verify-success', 'verify-cameraDenied']

async function open(page: Page, params: Record<string, string>, theme: 'light' | 'dark') {
  await page.setViewportSize(PHONE)
  await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' })
  await page.goto(`/?${new URLSearchParams({ ...params, theme }).toString()}`)
  await page.evaluate(() => document.fonts.ready.then(() => undefined))
}

for (const theme of ['light', 'dark'] as const) {
  test.describe(`verify catalog ${theme}`, () => {
    for (const entry of VERIFY_CATALOG) {
      test(entry.id, async ({ page }) => {
        await open(page, { catalog: entry.id }, theme)
        await expect(page.locator('section').first()).toBeVisible({ timeout: 20_000 })
        await expect(page).toHaveScreenshot(`${entry.id}-phone-${theme}.png`)
      })
    }
  })
}

test.describe('verify catalog de', () => {
  for (const id of GERMAN) {
    test(id, async ({ page }) => {
      await open(page, { catalog: id, lang: 'de' }, 'light')
      await expect(page.locator('section').first()).toBeVisible({ timeout: 20_000 })
      await expect(page).toHaveScreenshot(`${id}-phone-de.png`)
    })
  }
})

// ── two phones meet (harness/pair.tsx) ─────────────────────────────────────────────────────────

async function pair(page: Page, theme: 'light' | 'dark' = 'light', lang: 'en' | 'de' = 'en') {
  await page.setViewportSize({ width: 900, height: 960 })
  await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' })
  await page.goto(`/?${new URLSearchParams({ scenario: 'encounter', theme, lang }).toString()}`)
  const jonas = page.frameLocator('iframe[name=jonas]')
  const noah = page.frameLocator('iframe[name=noah]')
  const contacts = lang === 'de' ? 'Kontakte' : 'Contacts'
  await expect(jonas.getByRole('heading', { name: contacts })).toBeVisible({ timeout: 30_000 })
  await expect(noah.getByRole('heading', { name: contacts })).toBeVisible({ timeout: 30_000 })
  return { jonas, noah }
}

/** a phone frame as a screenshot; the QR codes carry fresh challenges and are masked */
async function shot(page: Page, phone: 'jonas' | 'noah', name: string, frame: FrameLocator) {
  await expect(page.locator(`iframe[name=${phone}]`)).toHaveScreenshot(name, { mask: [frame.locator('svg[role=img]')] })
}

test('two phones: Noah shows, Jonas scans, Noah confirms in the conversation; both mutual', async ({ page }) => {
  const { jonas, noah } = await pair(page)
  await noah.getByRole('button', { name: 'Verify in person' }).click()
  await expect(noah.getByRole('img', { name: 'Your verification code' })).toBeVisible()
  await shot(page, 'noah', 'pair/noah-ready.png', noah)
  await jonas.getByRole('button', { name: 'Verify in person' }).click()
  await jonas.getByRole('button', { name: 'Scan code' }).click()
  await expect(jonas.getByRole('heading', { name: 'Is Noah Lindqvist standing in front of you?' })).toBeVisible()
  await shot(page, 'jonas', 'pair/jonas-confirm.png', jonas)
  await jonas.getByRole('button', { name: 'Yes, verify Noah' }).click()
  await expect(jonas.getByRole('heading', { name: 'Noah Lindqvist verified' })).toBeVisible()
  await shot(page, 'jonas', 'pair/jonas-waiting.png', jonas)

  // Noah: the code was used, a new one is shown; back to the list, the incoming contact with its card
  await noah.getByRole('button', { name: 'Close' }).click()
  await expect(noah.getByRole('button', { name: /Jonas Weber/ })).toBeVisible()
  await shot(page, 'noah', 'pair/noah-list-incoming.png', noah)
  await noah.getByRole('button', { name: /Jonas Weber/ }).click()
  await expect(noah.getByText('Jonas Weber verified you', { exact: true })).toBeVisible()
  await shot(page, 'noah', 'pair/noah-conversation-decision.png', noah)
  await noah.getByRole('button', { name: 'Respond' }).click()
  await expect(noah.getByRole('dialog')).toBeVisible()
  await shot(page, 'noah', 'pair/noah-counter-sheet.png', noah)
  await noah.getByRole('button', { name: 'Yes, confirm' }).click()
  await expect(noah.getByRole('dialog')).toBeHidden()
  await expect(noah.getByText('Now mutually verified', { exact: true })).toBeVisible()

  await expect(jonas.getByRole('heading', { name: 'Mutually verified' })).toBeVisible()
  await shot(page, 'jonas', 'pair/jonas-success.png', jonas)
  await jonas.getByRole('button', { name: 'Open chat' }).click()
  await expect(jonas.getByText('Now mutually verified', { exact: true })).toBeVisible()
  await shot(page, 'jonas', 'pair/jonas-conversation.png', jonas)
  await jonas.getByRole('button', { name: /Noah Lindqvist, Details/ }).click()
  await expect(jonas.getByRole('heading', { name: 'Noah Lindqvist', level: 1 })).toBeVisible()
  await shot(page, 'jonas', 'pair/jonas-contact-detail.png', jonas)
  await noah.getByRole('button', { name: /Jonas Weber, Details/ }).click()
  await expect(noah.getByText(/You confirmed each other on/)).toBeVisible()
})

test('two phones: Jonas offline, the optical return path; mutual once Jonas is back online', async ({ page }) => {
  const { jonas, noah } = await pair(page)
  await page.getByLabel('Jonas Weber online').uncheck()
  await noah.getByRole('button', { name: 'Verify in person' }).click()
  await expect(noah.getByRole('img', { name: 'Your verification code' })).toBeVisible()
  await jonas.getByRole('button', { name: 'Verify in person' }).click()
  await jonas.getByRole('button', { name: 'Scan code' }).click()
  await jonas.getByRole('button', { name: 'Yes, verify Noah' }).click()
  await expect(jonas.getByRole('heading', { name: 'Noah Lindqvist verified' })).toBeVisible()
  // the "no answer yet" note after 2.2 s of the virtual clock
  await page.getByRole('button', { name: '+1 min' }).click()
  await jonas.getByRole('button', { name: 'Show code' }).click()
  await expect(jonas.getByRole('heading', { name: 'Same encounter, optically' })).toBeVisible()
  await shot(page, 'jonas', 'pair/jonas-fallback.png', jonas)
  await noah.getByRole('button', { name: 'Scan code' }).click()
  await expect(noah.getByRole('heading', { name: 'Is Jonas Weber standing in front of you?' })).toBeVisible()
  await noah.getByRole('button', { name: 'Yes, verify Jonas' }).click()
  await expect(noah.getByRole('heading', { name: 'Confirm Jonas Weber?' })).toBeVisible()
  await shot(page, 'noah', 'pair/noah-confirmation-required.png', noah)
  await noah.getByRole('button', { name: 'Yes, confirm' }).click()
  await expect(noah.getByRole('heading', { name: 'Your confirmation is out' })).toBeVisible()
  await shot(page, 'noah', 'pair/noah-counter-pending.png', noah)
  await page.getByLabel('Jonas Weber online').check()
  await expect(noah.getByRole('heading', { name: 'Mutually verified' })).toBeVisible()
  await expect(jonas.getByRole('heading', { name: 'Mutually verified' })).toBeVisible()
})

test('two phones in German', async ({ page }) => {
  const { jonas, noah } = await pair(page, 'light', 'de')
  await noah.getByRole('button', { name: 'Persönlich verifizieren' }).click()
  await jonas.getByRole('button', { name: 'Persönlich verifizieren' }).click()
  await jonas.getByRole('button', { name: 'Code scannen' }).click()
  await expect(jonas.getByRole('heading', { name: 'Steht Noah Lindqvist vor dir?' })).toBeVisible()
  await jonas.getByRole('button', { name: 'Ja, Noah verifizieren' }).click()
  await expect(jonas.getByRole('heading', { name: 'Noah Lindqvist verifiziert' })).toBeVisible()
  await shot(page, 'jonas', 'pair/jonas-waiting-de.png', jonas)
})
