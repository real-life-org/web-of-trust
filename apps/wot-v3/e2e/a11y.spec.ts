// Accessibility (store launch v3, platform step B): axe over every catalog screen of the harness
// (identity, verify, report), the chat and contact screens of the scenarios and the live scanner of
// the two-phone page, light and dark, English and German. The bar: no axe violation of impact
// serious or critical (WCAG 2.0/2.1/2.2 A and AA plus best practice), and every page has an h1 (the
// page title in the header; moderate "page-has-heading-one" fails too). Other moderate and minor
// findings are listed, not failed. A second check measures touch targets: every visible button, link and
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
/** moderate rules that fail the bar as well */
const BLOCKING_RULES = new Set(['page-has-heading-one'])
const MIN_TARGET = 44

type Theme = 'light' | 'dark'
type Lang = 'en' | 'de'

interface Target {
  readonly group: string
  readonly id: string
  readonly params: Record<string, string>
  /** the screen lives in the phone frame of the two-phone page */
  readonly frame?: (page: Page) => Promise<void>
  /** desktop viewport (1280 × 800): the three frames (page with or without navigation, dialog, the
   *  app's columns or one column) */
  readonly desktop?: (page: Page) => Promise<void>
}

const DESKTOP = { width: 1280, height: 800 }

/** a page: its region or main named by its h1 */
const pageShown = async (page: Page) => {
  await expect(page.locator('[data-slot=page]')).toBeVisible({ timeout: 20_000 })
  await expect(page.locator('[data-slot=page] h1')).toBeAttached()
}
/** the shell with a flow opened from it: the page in the content column, the sidebar beside it */
const openFlow = (button: RegExp) => async (page: Page) => {
  await page.getByRole('main').locator('button').filter({ hasText: button }).first().click()
  await pageShown(page)
}
const dialogShown = async (page: Page) => {
  await expect(page.getByRole('dialog')).toBeVisible({ timeout: 20_000 })
}
const shellShown = async (page: Page) => {
  await expect(page.getByRole('navigation').first()).toBeVisible({ timeout: 20_000 })
}
const selectArea = (name: RegExp) => async (page: Page) => {
  await shellShown(page)
  await page.getByRole('navigation').first().getByRole('button', { name }).click()
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
  // desktop (canvas "WoT v3 Desktop-Layout"): pages with and without navigation, the dialog, one column
  ...['verify-ready', 'verify-scanning', 'verify-confirm', 'verify-success', 'report-info', 'report-selecting', 'onboarding-welcome', 'onboarding-showWords', 'unlock-passphrase'].map((id) => ({
    group: 'desktop',
    id,
    params: { catalog: id },
    desktop: pageShown,
  })),
  { group: 'desktop', id: 'verify-sheet-incoming', params: { catalog: 'verify-sheet-incoming' }, desktop: dialogShown },
  { group: 'desktop', id: 'shell-verify', params: { scenario: 'iiw', open: 'c:marcus' }, desktop: openFlow(/^(Verify in person|Persönlich verifizieren)$/) },
  { group: 'desktop', id: 'shell-empty', params: { scenario: 'empty' }, desktop: shellShown },
  { group: 'desktop', id: 'shell-groups', params: { scenario: 'iiw' }, desktop: selectArea(/^(Groups|Gruppen)/) },
  { group: 'desktop', id: 'shell-profile', params: { scenario: 'iiw' }, desktop: selectArea(/^(Profile|Profil)/) },
]

async function open(page: Page, t: Target, theme: Theme, lang: Lang) {
  await page.setViewportSize(t.frame ? { width: 900, height: 960 } : t.desktop ? DESKTOP : PHONE)
  await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' })
  await page.goto(`/?${new URLSearchParams({ ...t.params, theme, lang }).toString()}`)
  if (t.frame) await t.frame(page)
  else if (t.desktop) await t.desktop(page)
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
  // a framed screen: only the nodes inside Jonas's phone frame count, decided by the element the
  // frame part of axe's target selects, not by the selector's wording
  const frameSelectors = [...new Set(result.violations.flatMap((v) => v.nodes.map((n) => n.target as unknown[]).filter((tg) => tg.length > 1).map((tg) => String(tg[0]))))]
  const jonasFrames = new Set(
    t.frame
      ? await page.evaluate((sels) => {
          const jonas = document.querySelector('iframe[name=jonas]')
          return sels.filter((s) => document.querySelector(s) === jonas)
        }, frameSelectors)
      : [],
  )
  const inScope = (target: unknown[]) => (t.frame ? target.length > 1 && jonasFrames.has(String(target[0])) : true)
  return result.violations
    .map((v) => {
      const nodes = v.nodes.filter((n) => inScope(n.target as unknown[]))
      return { rule: v.id, impact: v.impact ?? 'unknown', help: v.help, nodes: nodes.length, targets: nodes.slice(0, 3).map((n) => JSON.stringify(n.target)), detail: nodes.slice(0, 3).map((n) => `${n.html.slice(0, 120)} :: ${n.failureSummary ?? ''}`).join(' | ') }
    })
    .filter((f) => f.nodes > 0)
}

/** Visible controls whose hit area is below 44 × 44 CSS px: hit-tested on a 5 × 5 grid over the
 *  44 × 44 square around the control's center, corners included (so an enlarged hit area via
 *  hit-target counts, and a neighbour that covers part of it does not), each scrolled to the middle
 *  of its scroll container first. A grid point outside the viewport fails. Inline links inside
 *  running text are excepted. */
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
        if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) {
          covered = 'outside the viewport'
          return false
        }
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
      const steps = [-reach, -reach / 2, 0, reach / 2, reach]
      const ok = steps.flatMap((dy) => steps.map((dx) => hits(cx + dx, cy + dy)))
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
          expect(findings.filter((f) => BLOCKING.has(f.impact) || BLOCKING_RULES.has(f.rule)), 'axe serious/critical or blocking rule').toEqual([])
          expect(small, `touch targets below ${MIN_TARGET} px`).toEqual([])
        })
      }
    })
  }
}

/** the expected tab stops per flow, by accessible name (first 30 characters), in order; a disabled
 *  primary action is no stop */
const FOCUS_EXPECTED: Record<string, readonly string[]> = {
  'onboarding-welcome': ['Create identity', 'Import identity'],
  'onboarding-showWords': ['Back', 'Copy to clipboard', 'I have written down all 12 Mag', 'I have stored them in a safe p', 'I understand that nobody can r'],
  'onboarding-protectPassphrase': ['Back', 'Password', 'Confirm password', 'Show password', 'Show password', 'Also unlock with biometricsThe'],
  'recovery-enterWords-ok': ['Close', 'Magic Words', 'Next', 'Cancel'],
  'unlock-passphrase': ['Password', 'Show password', 'Restore with Magic Words'],
  'protection-newPassphrase': ['Close', 'Password', 'Confirm password', 'Show password', 'Show password'],
  'delete-confirm': ['Back', 'Confirmation'],
  'verify-confirm': ['Close', 'Confirm', 'Not now'],
  'verify-fallback': ['Close', 'Go to chat'],
  'report-selecting': ['Back', 'Noah Lindqvist \u00b7 12:55Great to', 'Me \u00b7 12:58Likewise.', 'Noah Lindqvist \u00b7 13:05Send me ', 'Noah Lindqvist \u00b7 13:06I know w', 'Continue'],
  'report-review': ['Back', 'Block and write the mail', 'Back'],
}

// Focus order per flow: Tab walks exactly the expected controls in reading order (top to bottom,
// left to right within a row), never into hidden content, and every stop is visible where the
// browser put it (no extra scrolling by the test). Positions are layout positions: viewport
// position plus the scroll offset of every ancestor, so a scrolled column does not reorder stops.
const FOCUS_FLOWS = FOCUS_EXPECTED

interface Stop {
  readonly name: string
  /** the element's part in the passphrase group (identity.tsx `data-passphrase`), if any */
  readonly passphrase?: string | null
  readonly x: number
  readonly y: number
  readonly h: number
  readonly visible: boolean
  readonly hidden: boolean
}

/** pairs of consecutive stops where focus moves against reading order */
function againstReadingOrder(stops: readonly Stop[]): string[] {
  const out: string[] = []
  for (let i = 1; i < stops.length; i++) {
    const a = stops[i - 1]!
    const b = stops[i]!
    // the eye toggles of the password fields follow after the fields on purpose (#482): the move up
    // to the first eye is not against the order
    if (b.passphrase === 'toggle') continue
    const sameRow = Math.abs(a.y - b.y) < Math.max(a.h, b.h) / 2
    if (sameRow ? b.x < a.x - 1 : b.y < a.y - 1) out.push(`${a.name} → ${b.name}`)
  }
  return out
}

test('focus order check: negative controls', () => {
  const s = (name: string, x: number, y: number): Stop => ({ name, x, y, h: 44, visible: true, hidden: false })
  expect(againstReadingOrder([s('a', 0, 0), s('b', 100, 0), s('c', 0, 100)])).toEqual([])
  expect(againstReadingOrder([s('a', 0, 100), s('b', 0, 0)])).toEqual(['a → b'])
  expect(againstReadingOrder([s('a', 100, 0), s('b', 0, 0)])).toEqual(['a → b'])
})

for (const [id, expected] of Object.entries(FOCUS_FLOWS)) {
  test(`focus order ${id}`, async ({ page }) => {
    await open(page, { group: 'focus', id, params: { catalog: id } }, 'light', 'en')
    // start at the top of the document, not at an autofocused field
    await page.evaluate(() => {
      document.body.tabIndex = -1
      document.body.focus()
    })
    const stops: Stop[] = []
    for (let i = 0; i < 40; i++) {
      await page.keyboard.press('Tab')
      const s = await page.evaluate((n) => {
        const el = document.activeElement as HTMLElement | null
        if (!el || el === document.body) return null
        // the element's identity: a stop seen before ends the walk (focus wrapped)
        if (el.dataset.focusStop !== undefined) return 'again' as const
        el.dataset.focusStop = String(n)
        const r = el.getBoundingClientRect()
        let y = r.top
        let x = r.left
        for (let p = el.parentElement; p; p = p.parentElement) {
          y += p.scrollTop
          x += p.scrollLeft
        }
        const cx = Math.min(Math.max(r.left + r.width / 2, 0), innerWidth - 1)
        const cy = Math.min(Math.max(r.top + r.height / 2, 0), innerHeight - 1)
        const hit = document.elementFromPoint(cx, cy)
        const labels = Array.from((el as HTMLInputElement).labels ?? [])
        const inView = r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth
        const visible = r.width > 0 && r.height > 0 && inView && hit !== null && (el.contains(hit) || labels.some((l) => l.contains(hit)))
        const name = (el.getAttribute('aria-label') || labels[0]?.textContent || el.textContent || el.tagName).trim().slice(0, 30)
        return { name, x, y, h: r.height, visible, hidden: el.closest('[aria-hidden="true"]') !== null, passphrase: el.dataset.passphrase ?? null }
      }, i)
      if (s === null || s === 'again') break
      stops.push(s)
    }
    expect(stops.map((s) => s.name), 'focus stops').toEqual(expected)
    expect(stops.filter((s) => s.hidden || !s.visible).map((s) => s.name), 'hidden or invisible stops').toEqual([])
    expect(againstReadingOrder(stops), 'focus moves against reading order').toEqual([])
  })
}

// The eye toggles of the password fields follow after the fields in the tab order (Anton 29.10., #482:
// Tab goes to the next field, not to "show"; the eyes come after the last field): the keyboard reaches
// the eye, Space shows the password, aria-pressed carries the state, the label stays.
test('password eye toggle: after the fields in the tab order, Space shows the password', async ({ page }) => {
  await open(page, { group: 'focus', id: 'unlock-passphrase', params: { catalog: 'unlock-passphrase' } }, 'light', 'en')
  const field = page.locator('input[autocomplete=current-password]')
  await field.fill('canary')
  await field.focus()
  await page.keyboard.press('Tab')
  const eye = page.getByRole('button', { name: 'Show password' })
  await expect(eye).toBeFocused()
  await expect(eye).toHaveAttribute('aria-pressed', 'false')
  await expect(field).toHaveAttribute('type', 'password')
  await page.keyboard.press('Space')
  await expect(eye).toHaveAttribute('aria-pressed', 'true')
  await expect(field).toHaveAttribute('type', 'text')
  await page.keyboard.press('Tab')
  await expect(page.getByRole('button', { name: 'Restore with Magic Words' })).toBeFocused()
  await page.keyboard.press('Shift+Tab')
  await expect(eye).toBeFocused()
  await page.keyboard.press('Shift+Tab')
  await expect(field).toBeFocused()
})

// Two fields (setting the password): field, field, eye, eye; the first Tab never lands on an eye.
test('password eye toggles: two fields first, then their eyes', async ({ page }) => {
  await open(page, { group: 'focus', id: 'onboarding-protectPassphrase', params: { catalog: 'onboarding-protectPassphrase' } }, 'light', 'en')
  const fields = page.locator('input[autocomplete=new-password]')
  await expect(fields).toHaveCount(2)
  const eyes = page.getByRole('button', { name: 'Show password' })
  await fields.nth(0).focus()
  await page.keyboard.press('Tab')
  await expect(fields.nth(1)).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(eyes.nth(0)).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(eyes.nth(1)).toBeFocused()
})

// Negative control of the scanner scope: a serious violation planted in Jonas's frame is found.
test('scanner scope: a planted nameless button in the phone frame fails the bar', async ({ page }) => {
  const t = TARGETS.find((x) => x.id === 'scanner-ok')!
  await open(page, t, 'light', 'en')
  await page.frame({ name: 'jonas' })!.evaluate(() => {
    const b = document.createElement('button')
    b.style.cssText = 'position:fixed;top:0;left:0;width:48px;height:48px'
    document.body.append(b)
  })
  const findings = await audit(page, t)
  expect(findings.some((f) => f.rule === 'button-name' && BLOCKING.has(f.impact))).toBe(true)
})

test('the transport line reads out only the queue, never a change of the connection', async ({ page }) => {
  await page.setViewportSize(PHONE)
  await page.goto(`/?${new URLSearchParams({ scenario: 'iiw' }).toString()}`)
  await expect(page.getByText('Online · Mediator connected', { exact: true })).toBeVisible()
  // the connection text is in no live region; the queue is one (empty while nothing waits)
  await expect(page.locator('[role=status], [aria-live]').filter({ hasText: 'Mediator connected' })).toHaveCount(0)
  await expect(page.getByRole('status', { name: 'Queue' })).toHaveText('')
})

// "Decline" on the decision card (handshake UX A2): a real button in the tab order right after
// "Respond", its name the action, its description the sentence that the other person is not told
// (read out with it), in both languages; axe and the touch-target bar cover it in conversation-verified.
for (const [lang, respond, decline, note] of [
  ['en', 'Respond', 'Decline', 'If you decline, Marcus won’t be told.'],
  ['de', 'Antworten', 'Ablehnen', 'Wenn du ablehnst, erfährt Marcus davon nichts.'],
] as const) {
  test(`decline on the decision card by keyboard (${lang})`, async ({ page }) => {
    await open(page, { group: 'chat', id: 'conversation-verified', params: { scenario: 'iiw', open: 'c:marcus' } }, 'light', lang)
    const first = page.getByRole('button', { name: respond, exact: true })
    const quiet = page.getByRole('button', { name: decline, exact: true })
    await expect(quiet).toHaveAccessibleDescription(note)
    await first.focus()
    await page.keyboard.press('Tab')
    await expect(quiet).toBeFocused()
  })
}

// The landmarks of the desktop frames: a page in the app is a region of the shell's main, named by its
// h1, with its way back (“‹ Contacts” and ×) and the sidebar beside it; a page without navigation is
// the main itself under the banner; a dialog is aria-modal and named.
test.describe('desktop frames: landmarks', () => {
  const at = async (page: Page, params: Record<string, string>) => {
    await page.setViewportSize(DESKTOP)
    await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
    await page.goto(`/?${new URLSearchParams({ ...params, theme: 'light', lang: 'en' }).toString()}`)
  }

  test('a page in the app: a named region with the way back (‹ beside the title), the sidebar beside it', async ({ page }) => {
    await at(page, { catalog: 'verify-ready' })
    const region = page.getByRole('main').getByRole('region', { name: 'Verify in person' })
    await expect(region).toBeVisible({ timeout: 20_000 })
    await expect(region.getByRole('heading', { level: 1, name: 'Verify in person' })).toBeVisible()
    await expect(region.getByRole('button', { name: 'Close' })).toBeVisible()
    await expect(region.getByRole('button', { name: 'Contacts' })).toHaveCount(0)
    await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeVisible()
    await expect(page.getByRole('main')).toHaveCount(1)
  })

  test('a page without navigation: the main named by its h1, no header bar (Anton 29.10.)', async ({ page }) => {
    await at(page, { catalog: 'unlock-passphrase' })
    await expect(page.getByRole('main', { name: 'Web of Trust' })).toBeVisible({ timeout: 20_000 })
    await expect(page.getByRole('main').getByRole('heading', { level: 1 })).toBeAttached()
    await expect(page.getByRole('banner')).toHaveCount(0)
    await expect(page.getByRole('navigation')).toHaveCount(0)
  })

  test('a dialog: aria-modal and named, over the page', async ({ page }) => {
    await at(page, { catalog: 'verify-sheet-incoming' })
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible({ timeout: 20_000 })
    await expect(dialog).toHaveAttribute('aria-modal', 'true')
    await expect(dialog).toHaveAccessibleName(/.+/)
    const box = await dialog.boundingBox()
    // the one narrow content width (max-w-narrow), shared with the pages of the flows
    expect(box?.width).toBe(480)
  })
})
