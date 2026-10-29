// Verify in person: every state of the verify machine from the screen catalog (light, dark, German
// for the main steps), and the harness scenario "two phones meet" clicked through on the real
// adapter and the real library (loopback): the network path over the VTI mediator double (the shown
// card takes the bundle that answers it, both roles see the success), the fallback through the list
// and the conversation, and the optical return path.
import { expect, test, type FrameLocator, type Page } from '@playwright/test'
import { VERIFY_CATALOG } from '../harness/catalog-verify'

const PHONE = { width: 390, height: 844 }
const GERMAN = [
  'verify-ready',
  'verify-ready-next',
  'verify-confirm',
  'verify-confirmIncoming',
  'verify-waiting-long',
  'verify-fallback',
  'verify-success',
  'verify-cameraDenied',
  'verify-cameraExplain',
  'verify-sheet-incoming-queue',
  'verify-sheet-met',
  'verify-sheet-mutual',
]

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
        await expect(page.locator('section, main').filter({ visible: true }).first()).toBeVisible({ timeout: 20_000 })
        await expect(page).toHaveScreenshot(`${entry.id}-phone-${theme}.png`)
      })
    }
  })
}

test.describe('verify catalog de', () => {
  for (const id of GERMAN) {
    test(id, async ({ page }) => {
      await open(page, { catalog: id, lang: 'de' }, 'light')
      await expect(page.locator('section, main').filter({ visible: true }).first()).toBeVisible({ timeout: 20_000 })
      await expect(page).toHaveScreenshot(`${id}-phone-de.png`)
    })
  }
})

// ── two phones meet (harness/pair.tsx) ─────────────────────────────────────────────────────────

async function pair(page: Page, theme: 'light' | 'dark' = 'light', lang: 'en' | 'de' = 'en', carrier: 'memory' | 'mediator' = 'mediator') {
  await page.setViewportSize({ width: 900, height: 960 })
  await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' })
  await page.goto(`/?${new URLSearchParams({ scenario: 'encounter', theme, lang, ...(carrier === 'mediator' ? { carrier } : {}) }).toString()}`)
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

const QUESTION = 'Is this the person in front of you?'
// the success moment's sentence (artboard 2b): "You and {first name} are now connected."
const SUCCESS = /^You and \S+ are now connected\.$/

/** Noah shows, Jonas scans and confirms: Jonas waits for Noah's confirmation */
async function scan(page: Page, jonas: FrameLocator, noah: FrameLocator, shots = false) {
  await noah.getByRole('button', { name: 'Verify in person' }).click()
  await expect(noah.getByRole('img', { name: 'Your verification code' })).toBeVisible()
  await expect(noah.getByText('Each code is for one person.', { exact: true })).toBeVisible()
  if (shots) await shot(page, 'noah', 'pair/noah-ready.png', noah)
  await jonas.getByRole('button', { name: 'Verify in person' }).click()
  await jonas.getByRole('button', { name: 'Scan code' }).click()
  await expect(jonas.getByRole('heading', { name: QUESTION })).toBeVisible()
  await expect(jonas.getByText('Noah Lindqvist', { exact: true }).filter({ visible: true })).toHaveCount(1)
  if (shots) await shot(page, 'jonas', 'pair/jonas-confirm.png', jonas)
  await jonas.getByRole('button', { name: 'Confirm', exact: true }).click()
  await expect(jonas.getByRole('heading', { name: 'Noah Lindqvist verified' })).toBeVisible()
  if (shots) await shot(page, 'jonas', 'pair/jonas-waiting.png', jonas)
}

test('two phones over the network: Noah’s code screen asks for Jonas by itself, Noah confirms there; both see the success; next person', async ({ page }) => {
  const { jonas, noah } = await pair(page)
  await scan(page, jonas, noah, true)
  // the bundle answers Noah's shown card: the same screen asks, the same question as Jonas's (E4, E9)
  await expect(noah.getByRole('heading', { name: QUESTION })).toBeVisible({ timeout: 20_000 })
  await expect(noah.getByText('Jonas Weber', { exact: true }).filter({ visible: true })).toHaveCount(1)
  await expect(noah.getByRole('button', { name: 'Not now' })).toBeVisible()
  await shot(page, 'noah', 'pair/noah-confirm-incoming.png', noah)
  await noah.getByRole('button', { name: 'Confirm', exact: true }).click()
  // the success on both phones, each once (the flow shows it, no sheet besides)
  await expect(noah.getByRole('heading', { name: SUCCESS })).toBeVisible()
  await expect(noah.getByText('You and Jonas are now connected.', { exact: true })).toBeVisible()
  await expect(jonas.getByRole('heading', { name: SUCCESS })).toBeVisible({ timeout: 20_000 })
  await expect(noah.getByRole('dialog')).toHaveCount(0)
  await expect(jonas.getByRole('dialog')).toHaveCount(0)
  await shot(page, 'noah', 'pair/noah-success.png', noah)
  await shot(page, 'jonas', 'pair/jonas-success.png', jonas)
  // the next person: a fresh code in the same flow
  await noah.getByRole('button', { name: 'Next person' }).click()
  await expect(noah.getByRole('img', { name: 'Your verification code' })).toBeVisible()
  await jonas.getByRole('button', { name: 'Open chat' }).click()
  await expect(jonas.getByText('Now mutually verified', { exact: true })).toBeVisible()
  await shot(page, 'jonas', 'pair/jonas-conversation.png', jonas)
  await jonas.getByRole('button', { name: /^Noah Lindqvist.*, Details$/ }).click()
  await expect(jonas.getByRole('heading', { name: 'Noah Lindqvist', level: 1 })).toBeVisible()
  await shot(page, 'jonas', 'pair/jonas-contact-detail.png', jonas)
})

test('two phones over the network: Jonas left the flow; Noah closed his code: the confirmation comes as a sheet, both see the success as a sheet', async ({ page }) => {
  const { jonas, noah } = await pair(page)
  await page.getByLabel('Jonas Weber online').uncheck()
  await scan(page, jonas, noah)
  await jonas.getByRole('button', { name: 'Go to chat' }).click()
  await noah.getByRole('button', { name: 'Close' }).click()
  await expect(noah.getByRole('heading', { name: 'Contacts' })).toBeVisible()
  await page.getByLabel('Jonas Weber online').check()
  // the card is still valid: the confirmation is asked wherever Noah is (E6)
  const sheet = noah.getByRole('dialog')
  await expect(sheet.getByRole('heading', { name: QUESTION })).toBeVisible({ timeout: 20_000 })
  await shot(page, 'noah', 'pair/noah-incoming-sheet.png', noah)
  await sheet.getByRole('button', { name: 'Confirm', exact: true }).click()
  // success on both, each as a sheet (E7); Jonas is in the conversation
  await expect(noah.getByRole('dialog').getByRole('heading', { name: SUCCESS })).toBeVisible()
  await expect(jonas.getByRole('dialog').getByRole('heading', { name: SUCCESS })).toBeVisible({ timeout: 20_000 })
  await shot(page, 'jonas', 'pair/jonas-success-sheet.png', jonas)
  await jonas.getByRole('dialog').getByRole('button', { name: 'Close' }).click()
  await expect(jonas.getByRole('dialog')).toHaveCount(0)
  await noah.getByRole('dialog').getByRole('button', { name: 'Open chat' }).click()
  await expect(noah.getByText('Now mutually verified', { exact: true })).toBeVisible()
  await noah.getByRole('button', { name: /^Jonas Weber.*, Details$/ }).click()
  await expect(noah.getByText(/You confirmed each other on/)).toBeVisible()
})

test('two phones without a mediator: the list and the conversation are the way back; "Did you meet Jonas Weber?"', async ({ page }) => {
  const { jonas, noah } = await pair(page, 'light', 'en', 'memory')
  await scan(page, jonas, noah)
  await noah.getByRole('button', { name: 'Close' }).click()
  await expect(noah.getByRole('button', { name: /Jonas Weber/ })).toBeVisible()
  await shot(page, 'noah', 'pair/noah-list-incoming.png', noah)
  await noah.getByRole('button', { name: /Jonas Weber/ }).click()
  await expect(noah.getByText('Jonas Weber verified you', { exact: true })).toBeVisible()
  await expect(noah.getByText('Did you meet Jonas Weber?', { exact: true })).toBeVisible()
  await shot(page, 'noah', 'pair/noah-conversation-decision.png', noah)
  await noah.getByRole('button', { name: 'Respond' }).click()
  await expect(noah.getByRole('dialog').getByRole('heading', { name: 'Did you meet Jonas Weber?' })).toBeVisible()
  await shot(page, 'noah', 'pair/noah-counter-sheet.png', noah)
  await noah.getByRole('button', { name: 'Confirm', exact: true }).click()
  await expect(noah.getByRole('dialog').getByRole('heading', { name: SUCCESS })).toBeVisible()
  await noah.getByRole('dialog').getByRole('button', { name: 'Close' }).click()
  await expect(noah.getByRole('dialog')).toHaveCount(0)
  await expect(noah.getByText('Now mutually verified', { exact: true })).toBeVisible()
  await expect(jonas.getByRole('heading', { name: SUCCESS })).toBeVisible()
})

test('two phones: Jonas offline, the optical return path; mutual once Jonas is back online', async ({ page }) => {
  const { jonas, noah } = await pair(page, 'light', 'en', 'memory')
  await page.getByLabel('Jonas Weber online').uncheck()
  await scan(page, jonas, noah)
  // the "no answer yet" note after 2.2 s of the virtual clock
  await page.getByRole('button', { name: '+1 min' }).click()
  await jonas.getByRole('button', { name: 'Show code' }).click()
  await expect(jonas.getByRole('heading', { name: 'Same encounter, optically' })).toBeVisible()
  await shot(page, 'jonas', 'pair/jonas-fallback.png', jonas)
  await noah.getByRole('button', { name: 'Scan code' }).click()
  await expect(noah.getByRole('heading', { name: QUESTION })).toBeVisible()
  await noah.getByRole('button', { name: 'Confirm', exact: true }).click()
  await expect(noah.getByRole('heading', { name: QUESTION })).toBeVisible()
  await expect(noah.getByRole('button', { name: 'Not now' })).toBeVisible()
  await shot(page, 'noah', 'pair/noah-confirmation-required.png', noah)
  await noah.getByRole('button', { name: 'Confirm', exact: true }).click()
  await expect(noah.getByRole('heading', { name: 'Your confirmation is out' })).toBeVisible()
  await shot(page, 'noah', 'pair/noah-counter-pending.png', noah)
  await page.getByLabel('Jonas Weber online').check()
  await expect(noah.getByRole('heading', { name: SUCCESS })).toBeVisible()
  await expect(jonas.getByRole('heading', { name: SUCCESS })).toBeVisible()
  await expect(noah.getByRole('dialog')).toHaveCount(0)
  await expect(jonas.getByRole('dialog')).toHaveCount(0)
})

test('two phones in German', async ({ page }) => {
  const { jonas, noah } = await pair(page, 'light', 'de')
  await noah.getByRole('button', { name: 'Persönlich verifizieren' }).click()
  await expect(noah.getByText('Jeder Code gilt für eine Person.', { exact: true })).toBeVisible()
  await jonas.getByRole('button', { name: 'Persönlich verifizieren' }).click()
  await jonas.getByRole('button', { name: 'Code scannen' }).click()
  await expect(jonas.getByRole('heading', { name: 'Ist das die Person vor dir?' })).toBeVisible()
  await jonas.getByRole('button', { name: 'Bestätigen', exact: true }).click()
  await expect(jonas.getByRole('heading', { name: 'Noah Lindqvist verifiziert' })).toBeVisible()
  await shot(page, 'jonas', 'pair/jonas-waiting-de.png', jonas)
  await expect(noah.getByRole('heading', { name: 'Ist das die Person vor dir?' })).toBeVisible({ timeout: 20_000 })
  await expect(noah.getByRole('button', { name: 'Nicht jetzt' })).toBeVisible()
  await noah.getByRole('button', { name: 'Bestätigen', exact: true }).click()
  await expect(noah.getByText('Du und Jonas seid jetzt verbunden.', { exact: true })).toBeVisible()
  await expect(noah.getByRole('button', { name: 'Nächste Person' })).toBeVisible()
  await expect(jonas.getByRole('heading', { name: /^Du und \S+ seid jetzt verbunden\.$/ })).toBeVisible({ timeout: 20_000 })
})
