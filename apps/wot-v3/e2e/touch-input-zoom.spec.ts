// iOS zooms into a focused text field whose font is under 16 px and keeps the zoom after the
// keyboard closes (WebKit; Tillmann's device test of #494). Contract: on a touch device every text
// field of the app is at least 16 px; with a fine pointer (desktop) the design sizes stay. Checked on
// every screen of the three catalogs, plus probes with the smallest size classes the app uses, so a
// field added later is covered without being listed here.
import { expect, test, type Page } from '@playwright/test'
import { CATALOG } from '../harness/catalog'
import { REPORT_CATALOG } from '../harness/catalog-report'
import { VERIFY_CATALOG } from '../harness/catalog-verify'

const PHONE = { width: 390, height: 844 }
const ENTRIES = [...CATALOG, ...VERIFY_CATALOG, ...REPORT_CATALOG].map((e) => e.id)
const TEXT_FIELDS = 'input:not([type="checkbox"]):not([type="radio"]):not([type="file"]):not([type="hidden"]), textarea, select'

async function open(page: Page, id: string) {
  await page.setViewportSize(PHONE)
  await page.goto(`/?${new URLSearchParams({ catalog: id, theme: 'light' }).toString()}`)
  await expect(page.locator('section, main, [role="dialog"]').filter({ visible: true }).first()).toBeVisible({ timeout: 20_000 })
}

/** font sizes in px of every text field on the page, with a label for the message */
const fieldSizes = (page: Page) =>
  page.locator(TEXT_FIELDS).evaluateAll((els) =>
    els.map((el) => ({ field: `${el.tagName.toLowerCase()} ${el.getAttribute('class') ?? ''}`.slice(0, 120), px: parseFloat(getComputedStyle(el).fontSize) })),
  )

/** fields with the smallest size classes of the app, outside any screen */
async function probes(page: Page) {
  return page.evaluate(() => {
    const out: number[] = []
    for (const [tag, cls] of [['input', 'text-xs'], ['input', 'text-sm'], ['textarea', 'font-mono text-xs'], ['input', 'text-[15px]']] as const) {
      const el = document.createElement(tag)
      el.className = cls
      document.body.append(el)
      out.push(parseFloat(getComputedStyle(el).fontSize))
      el.remove()
    }
    return out
  })
}

test.describe('touch device: no field under 16 px', () => {
  test.use({ hasTouch: true, isMobile: true })

  for (const id of ENTRIES) {
    test(id, async ({ page }) => {
      await open(page, id)
      expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true)
      for (const f of await fieldSizes(page)) expect(f.px, f.field).toBeGreaterThanOrEqual(16)
    })
  }

  test('fields with the smallest size classes are raised too', async ({ page }) => {
    await open(page, ENTRIES[0]!)
    for (const px of await probes(page)) expect(px).toBeGreaterThanOrEqual(16)
  })
})

test.describe('fine pointer: the design sizes stay', () => {
  test('text-sm and text-xs keep 14 and 12 px', async ({ page }) => {
    await open(page, ENTRIES[0]!)
    expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(false)
    const [xs, sm, monoXs, px15] = await probes(page)
    expect([xs, sm, monoXs, px15]).toEqual([12, 14, 12, 15])
  })
})
