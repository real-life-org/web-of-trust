// Accessibility (store launch v3, platform step B): axe over every catalog screen of the harness
// (identity, verify, report), the chat and contact screens of the scenarios and the live scanner of
// the two-phone page, light and dark, English and German. The bar: no axe violation of impact
// serious or critical (WCAG 2.0/2.1/2.2 A and AA plus best practice). Moderate and minor findings
// are listed, not failed. A second check measures touch targets: every visible button, link and
// form control of the app is at least 44 × 44 CSS px (inline text links excepted), see
// src/ui/primitives.
//
// A11Y_REPORT=<file> appends one JSON line per page (all findings, any impact) for the audit table.
import { appendFileSync } from 'node:fs'
import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import { CATALOG } from '../harness/catalog'
import { VERIFY_CATALOG } from '../harness/catalog-verify'
import { REPORT_CATALOG } from '../harness/catalog-report'

const PHONE = { width: 390, height: 844 }
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice']
const BLOCKING = new Set(['serious', 'critical'])
const MIN_TARGET = 44

type Theme = 'light' | 'dark'
type Lang = 'en' | 'de'

interface Target {
  readonly group: string
  readonly id: string
  readonly params: Record<string, string>
  /** the screen lives in the phone frame of the two-phone page */
  readonly frame?: (page: Page) => Promise<void>
}

const scanner = (camera: string) => async (page: Page) => {
  const phone = page.frameLocator('iframe[name=jonas]')
  await expect(phone.getByRole('heading', { level: 1 }).first()).toBeVisible({ timeout: 30_000 })
  await phone.locator('[data-nav-verify], button').filter({ hasText: /Verify in person|Persönlich verifizieren/ }).first().click()
  await phone.locator('button').filter({ hasText: /^(Scan code|Code scannen)$/ }).first().click()
  if (camera === 'ok') await expect(phone.locator('[data-scan-viewport]')).toBeAttached()
}

const TARGETS: readonly Target[] = [
  ...CATALOG.map((e) => ({ group: 'identity', id: e.id, params: { catalog: e.id } })),
  ...VERIFY_CATALOG.map((e) => ({ group: 'verify', id: e.id, params: { catalog: e.id } })),
  ...REPORT_CATALOG.map((e) => ({ group: 'report', id: e.id, params: { catalog: e.id } })),
  { group: 'contacts', id: 'contacts', params: { scenario: 'iiw' } },
  { group: 'contacts', id: 'contacts-empty', params: { scenario: 'empty' } },
  { group: 'chat', id: 'conversation', params: { scenario: 'iiw', open: 'c:priya' } },
  { group: 'chat', id: 'conversation-verified', params: { scenario: 'iiw', open: 'c:marcus' } },
  { group: 'chat', id: 'group', params: { scenario: 'iiw', open: 'g:circle' } },
  { group: 'chat', id: 'message-states', params: { scenario: 'message-states', open: 'c:noah' } },
  ...(['ok', 'denied', 'unavailable'] as const).map((camera) => ({
    group: 'platform',
    id: `scanner-${camera}`,
    params: { scenario: 'encounter', camera },
    frame: scanner(camera),
  })),
]

async function open(page: Page, t: Target, theme: Theme, lang: Lang) {
  await page.setViewportSize(t.frame ? { width: 900, height: 960 } : PHONE)
  await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' })
  await page.goto(`/?${new URLSearchParams({ ...t.params, theme, lang }).toString()}`)
  if (t.frame) await t.frame(page)
  else await expect(page.locator('section, [role="dialog"], main').filter({ visible: true }).first()).toBeVisible({ timeout: 20_000 })
  await page.evaluate(() => document.fonts.ready.then(() => undefined))
}

interface Finding {
  readonly rule: string
  readonly impact: string
  readonly help: string
  readonly nodes: number
  readonly targets: string[]
  readonly detail?: string
}

async function audit(page: Page, t: Target): Promise<Finding[]> {
  const result = await new AxeBuilder({ page }).withTags(TAGS).analyze()
  const inScope = (target: unknown[]) => (t.frame ? String(target[0]).includes('jonas') : true)
  return result.violations
    .map((v) => {
      const nodes = v.nodes.filter((n) => inScope(n.target as unknown[]))
      return { rule: v.id, impact: v.impact ?? 'unknown', help: v.help, nodes: nodes.length, targets: nodes.slice(0, 3).map((n) => JSON.stringify(n.target)), detail: nodes.slice(0, 3).map((n) => `${n.html.slice(0, 120)} :: ${n.failureSummary ?? ''}`).join(' | ') }
    })
    .filter((f) => f.nodes > 0)
}

/** Visible controls whose hit area is below 44 × 44 CSS px: hit-tested 22 px from the control's
 *  center in four directions (so an enlarged hit area via hit-target counts, and a neighbour that
 *  covers part of it does not), each scrolled to the middle of its scroll container first. Inline
 *  links inside running text are excepted. */
async function smallTargets(page: Page, t: Target): Promise<string[]> {
  const scope = t.frame ? page.frame({ name: 'jonas' }) : page.mainFrame()
  if (!scope) return []
  return scope.evaluate((min) => {
    const out: string[] = []
    // 1 px inside the edge: hit testing rounds to whole pixels
    const reach = min / 2 - 1
    const sel = 'button, a[href], input:not([type=hidden]), select, textarea, [role=button], [role=switch], [role=tab], [role=checkbox]'
    for (const el of Array.from(document.querySelectorAll<HTMLElement>(sel))) {
      if (el.closest('[aria-hidden="true"], [inert]')) continue
      if ((el as HTMLButtonElement).disabled) continue
      // a control behind a sticky footer is reached by scrolling: measure it where the user sees it
      el.scrollIntoView({ block: 'center', inline: 'center' })
      const r = el.getBoundingClientRect()
      if (r.width === 0 || r.height === 0) continue
      const style = getComputedStyle(el)
      if (style.visibility === 'hidden' || style.display === 'none') continue
      if (el.tagName === 'A' && style.display === 'inline') continue
      const labels = Array.from((el as HTMLInputElement).labels ?? [])
      let covered = ''
      const hits = (x: number, y: number) => {
        if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) return true
        const h = document.elementFromPoint(x, y)
        const ok = h !== null && (el.contains(h) || labels.some((l) => l.contains(h)))
        if (!ok) covered = h ? `${h.tagName.toLowerCase()}.${String(h.className).split(' ').slice(0, 3).join('.')}` : 'nothing'
        return ok
      }
      // a control inside its label: the label is the target, measured around its own center
      const label = labels.find((l) => l.contains(el))
      const box = label ? label.getBoundingClientRect() : r
      const cx = box.left + box.width / 2
      const cy = box.top + box.height / 2
      const ok = [hits(cx - reach, cy), hits(cx + reach, cy), hits(cx, cy - reach), hits(cx, cy + reach)]
      if (ok.includes(false)) {
        const name = (el.getAttribute('aria-label') ?? el.textContent ?? el.tagName).trim().slice(0, 30)
        out.push(`${el.tagName.toLowerCase()} "${name}" ${Math.round(box.width)}×${Math.round(box.height)} [${ok.map((v) => (v ? 1 : 0)).join('')}] under ${covered}`)
      }
    }
    return out
  }, MIN_TARGET)
}

const REPORT = process.env.A11Y_REPORT
const AUDIT_ONLY = process.env.A11Y_AUDIT === '1'

for (const theme of ['light', 'dark'] as const) {
  for (const lang of ['en', 'de'] as const) {
    test.describe(`a11y ${theme} ${lang}`, () => {
      for (const t of TARGETS) {
        test(`${t.group}/${t.id}`, async ({ page }) => {
          await open(page, t, theme, lang)
          const findings = await audit(page, t)
          const small = await smallTargets(page, t)
          if (REPORT) appendFileSync(REPORT, `${JSON.stringify({ group: t.group, id: t.id, theme, lang, findings, small })}\n`)
          if (AUDIT_ONLY) return
          expect(findings.filter((f) => BLOCKING.has(f.impact)), 'axe serious/critical').toEqual([])
          expect(small, `touch targets below ${MIN_TARGET} px`).toEqual([])
        })
      }
    })
  }
}

// Focus order per flow: Tab walks the controls in reading order (top to bottom, left to right
// within a row), never into hidden content, and every stop is visible on screen.
const FOCUS_FLOWS = [
  'onboarding-welcome',
  'onboarding-showWords',
  'onboarding-protectPassphrase',
  'recovery-enterWords-ok',
  'unlock-passphrase',
  'protection-newPassphrase',
  'delete-confirm',
  'verify-confirm',
  'verify-fallback',
  'report-selecting',
  'report-review',
]

for (const id of FOCUS_FLOWS) {
  test(`focus order ${id}`, async ({ page }) => {
    await open(page, { group: 'focus', id, params: { catalog: id } }, 'light', 'en')
    // start at the top of the document, not at an autofocused field
    await page.evaluate(() => {
      document.body.tabIndex = -1
      document.body.focus()
    })
    const stops: { name: string; x: number; y: number; h: number; visible: boolean; hidden: boolean }[] = []
    for (let i = 0; i < 30; i++) {
      await page.keyboard.press('Tab')
      const s = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null
        if (!el || el === document.body) return null
        el.scrollIntoView({ block: 'nearest' })
        const r = el.getBoundingClientRect()
        const name = (el.getAttribute('aria-label') ?? el.textContent ?? el.tagName).trim().slice(0, 30)
        return { name, x: r.left, y: r.top, h: r.height, visible: r.width > 0 && r.height > 0, hidden: el.closest('[aria-hidden="true"]') !== null }
      })
      if (s === null || (stops.length > 0 && s.name === stops[0]!.name && s.y === stops[0]!.y)) break
      stops.push(s)
    }
    expect(stops.length, 'at least one focus stop').toBeGreaterThan(0)
    expect(stops.filter((s) => s.hidden || !s.visible).map((s) => s.name), 'hidden or invisible stops').toEqual([])
    // reading order of the document: page y = viewport y plus the scroll offset is not tracked here, so
    // compare in order of appearance with the element brought into view: a later stop is not above an
    // earlier one by more than a row unless the column scrolled
    const out: string[] = []
    for (let i = 1; i < stops.length; i++) {
      const a = stops[i - 1]!
      const b = stops[i]!
      const sameRow = Math.abs(a.y - b.y) < Math.max(a.h, b.h) / 2
      if (sameRow ? b.x < a.x - 1 : b.y < a.y - 1) out.push(`${a.name} → ${b.name}`)
    }
    expect(out, 'focus moves against reading order').toEqual([])
  })
}
