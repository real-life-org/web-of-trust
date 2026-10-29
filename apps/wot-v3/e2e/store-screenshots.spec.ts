// Play Store screenshots of Web of Trust (store-assets/screenshots/README.md): two phones over a live
// TSP 1.0 mediator in the harness page, German, light. Each phone frame is set to 360×780 CSS pixels;
// with device scale factor 3 (playwright.screenshots.config.ts) every PNG is 1080×2340. Runs only with
// RLTP_LIVE_MEDIATOR=1, MEDIATOR_DID and WOT_SHOTS_DIR (the output folder), so the default config and
// the live run of e2e/live-mediator.spec.ts never write screenshots.
import { expect, test, type Page } from '@playwright/test'

test.skip(process.env.RLTP_LIVE_MEDIATOR !== '1' || !process.env.WOT_SHOTS_DIR, 'store screenshots only with RLTP_LIVE_MEDIATOR=1 and WOT_SHOTS_DIR')

const OUT = process.env.WOT_SHOTS_DIR ?? ''
const FRAME = { width: 360, height: 780 }

/** the phone frames without the harness chrome: no border, no radius, no shadow, the store size; each
 *  column as wide as its frame, so every frame sits on whole CSS pixels */
async function frameAsPhone(page: Page) {
  await page.addStyleTag({
    content: `iframe { width: ${FRAME.width}px !important; height: ${FRAME.height}px !important; border: 0 !important; border-radius: 0 !important; box-shadow: none !important; } div:has(> iframe) { width: ${FRAME.width}px !important; }`,
  })
}

async function shot(page: Page, phone: 'jonas' | 'noah', file: string) {
  // the frame settles (fonts, the last render) before the shot
  await page.frameLocator(`iframe[name=${phone}]`).locator('body').evaluate(() => document.fonts.ready.then(() => undefined))
  await page.waitForTimeout(400)
  const box = await page.locator(`iframe[name=${phone}]`).boundingBox()
  if (!box) throw new Error(`store screenshots: no frame ${phone}`)
  const clip = { x: box.x, y: box.y, ...FRAME }
  await page.screenshot({ path: `${OUT}/${file}`, clip, animations: 'disabled', caret: 'hide' })
}

test('store screenshots: encounter, contacts, conversation, block (live mediator)', async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 1000 })
  const mediator = process.env.MEDIATOR_DID
  if (!mediator) throw new Error('live: MEDIATOR_DID names the TSP 1.0 mediator (0.45 or later)')
  const q = new URLSearchParams({ scenario: 'encounter', theme: 'light', lang: 'de', tz: 'Europe/Berlin', carrier: 'live', mediator })
  await page.goto(`/?${q.toString()}`)
  await frameAsPhone(page)
  const jonas = page.frameLocator('iframe[name=jonas]')
  const noah = page.frameLocator('iframe[name=noah]')
  await expect(jonas.getByRole('heading', { name: 'Kontakte' })).toBeVisible({ timeout: 30_000 })
  await expect(noah.getByRole('heading', { name: 'Kontakte' })).toBeVisible({ timeout: 30_000 })

  // 01: Noah shows his code
  await noah.getByRole('button', { name: 'Persönlich verifizieren' }).click()
  await expect(noah.getByRole('button', { name: 'Code scannen' })).toBeVisible()
  await shot(page, 'noah', '01-begegnung-code.png')

  // one scan: Jonas scans, Noah confirms
  await jonas.getByRole('button', { name: 'Persönlich verifizieren' }).click()
  await jonas.getByRole('button', { name: 'Code scannen' }).click()
  await jonas.getByRole('button', { name: 'Bestätigen', exact: true }).click()
  await noah.getByRole('button', { name: 'Bestätigen', exact: true }).click({ timeout: 30_000 })
  await expect(jonas.getByRole('heading', { name: 'Gegenseitig verifiziert' })).toBeVisible({ timeout: 30_000 })
  await noah.getByRole('button', { name: 'Gespräch öffnen' }).click()
  await jonas.getByRole('button', { name: 'Gespräch öffnen' }).click()

  // a short conversation, each message over the live mediator
  const lines: Array<['jonas' | 'noah', string]> = [
    ['jonas', 'Schön, dass wir uns heute auf dem Markt getroffen haben!'],
    ['noah', 'Fand ich auch. Hast du nächste Woche Zeit für einen Kaffee?'],
    ['jonas', 'Gern. Donnerstag um zehn im Café am Platz?'],
    ['noah', 'Passt, bis Donnerstag!'],
  ]
  for (const [who, text] of lines) {
    const f = who === 'jonas' ? jonas : noah
    await f.getByRole('textbox', { name: who === 'jonas' ? 'Nachricht an Noah' : 'Nachricht an Jonas' }).fill(text)
    await f.getByRole('button', { name: 'Senden' }).click()
    await expect(f.getByText(/Angekommen/).last()).toBeVisible({ timeout: 30_000 })
    const other = who === 'jonas' ? noah : jonas
    await expect(other.getByText(text).last()).toBeVisible({ timeout: 30_000 })
  }
  await shot(page, 'jonas', '03-gespraech.png')

  // 02: Jonas's contact list
  await jonas.getByRole('button', { name: 'Zurück' }).first().click()
  await expect(jonas.getByRole('heading', { name: 'Kontakte' })).toBeVisible()
  await shot(page, 'jonas', '02-kontakte.png')

  // 04: Noah, from the details of Jonas: report and block
  await noah.getByRole('button', { name: /^Jonas Weber.*, Details$/ }).click()
  await noah.getByRole('button', { name: 'Melden und blockieren' }).click()
  await expect(noah.getByRole('heading', { name: 'Jonas Weber melden' })).toBeVisible()
  await shot(page, 'noah', '04-melden-blockieren.png')
})

test('store screenshots: onboarding and Magic Words', async ({ page }) => {
  await page.setViewportSize(FRAME)
  await page.goto(`/?${new URLSearchParams({ scenario: 'fresh-install', theme: 'light', lang: 'de' }).toString()}`)
  await page.evaluate(() => document.fonts.ready.then(() => undefined))
  await expect(page.getByRole('button', { name: 'Identität erstellen' })).toBeVisible({ timeout: 30_000 })
  await page.waitForTimeout(400)
  await page.screenshot({ path: `${OUT}/06-onboarding.png`, animations: 'disabled', caret: 'hide' })
  await page.getByRole('button', { name: 'Identität erstellen' }).click()
  await expect(page.getByRole('list', { name: 'Deine 12 Magischen Wörter' })).toBeVisible()
  await page.waitForTimeout(400)
  await page.screenshot({ path: `${OUT}/05-magische-woerter.png`, animations: 'disabled', caret: 'hide' })
})
