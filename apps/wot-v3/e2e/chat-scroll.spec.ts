// The scroll position of a conversation (Tillmann's device test of #494; Anton 03.11.): a thread opens
// at its first unread message, or at the bottom when everything is read; a new message moves the
// thread down when it is the person's own or when the thread was at the bottom; whoever reads further
// up is not pulled away; a smaller view (the keyboard opens) keeps the bottom in view.
import { expect, test, type Page } from '@playwright/test'

const PHONE = { width: 390, height: 844 }

async function open(page: Page, conversation: 'c:noah' | 'c:lena') {
  await page.setViewportSize(PHONE)
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
  await page.goto(`/?${new URLSearchParams({ scenario: 'long-chat', open: conversation, theme: 'light' }).toString()}`)
  await expect(scroller(page)).toBeVisible({ timeout: 20_000 })
  // the position is set after the first layout
  await page.waitForTimeout(300)
}

const scroller = (page: Page) => page.locator('[data-thread-scroller]')
/** scrollTop, the distance to the bottom, and the top of an element relative to the scroller */
const metrics = (page: Page, text?: string) =>
  scroller(page).evaluate((el, t) => {
    const s = el as HTMLElement
    const target = t ? Array.from(s.querySelectorAll('*')).find((n) => n.children.length === 0 && n.textContent?.startsWith(t)) : null
    return {
      top: s.scrollTop,
      fromBottom: s.scrollHeight - s.clientHeight - s.scrollTop,
      targetTop: target ? (target as HTMLElement).getBoundingClientRect().top - s.getBoundingClientRect().top : null,
    }
  }, text)
const receive = (page: Page, key: 'c:noah' | 'c:lena', from: string, text: string) => page.evaluate(([k, f, t]) => window.__wotDevice!.receive(k as `c:${string}`, f!, t!), [key, from, text])

test('a thread with unread messages opens at the first of them', async ({ page }) => {
  await open(page, 'c:noah')
  const m = await metrics(page, 'Noah unread 1:')
  expect(m.targetTop).not.toBeNull()
  // the first unread message stands near the top of the thread, not at the bottom
  expect(m.targetTop!).toBeGreaterThanOrEqual(0)
  expect(m.targetTop!).toBeLessThan(120)
  expect(m.fromBottom).toBeGreaterThan(0)
  await expect(scroller(page).getByText('Noah 1:', { exact: false }).first()).not.toBeInViewport()
})

test('a fully read thread opens at the bottom', async ({ page }) => {
  await open(page, 'c:lena')
  expect((await metrics(page)).fromBottom).toBeLessThan(2)
  await expect(scroller(page).getByText('Lena unread 15:', { exact: false })).toBeInViewport()
})

test('a new message at the bottom moves the thread down; read further up, it does not', async ({ page }) => {
  await open(page, 'c:lena')
  await receive(page, 'c:lena', 'lena', 'Lena new at the bottom')
  await expect(scroller(page).getByText('Lena new at the bottom')).toBeInViewport()
  expect((await metrics(page)).fromBottom).toBeLessThan(2)

  await scroller(page).evaluate((el) => (el.scrollTop = 0))
  await page.waitForTimeout(100)
  await receive(page, 'c:lena', 'lena', 'Lena new while reading above')
  await page.waitForTimeout(300)
  expect((await metrics(page)).top).toBe(0)
  await expect(scroller(page).getByText('Lena new while reading above')).not.toBeInViewport()
})

test('an own message always moves the thread down', async ({ page }) => {
  await open(page, 'c:lena')
  await scroller(page).evaluate((el) => (el.scrollTop = 0))
  await page.waitForTimeout(100)
  // the simulation has no send; the harness adds the own message the way the scenario player does
  await receive(page, 'c:lena', 'me', 'My own line')
  await expect(scroller(page).getByText('My own line', { exact: true })).toBeInViewport()
  expect((await metrics(page)).fromBottom).toBeLessThan(2)
})

test('a smaller view (the keyboard opens) keeps the bottom in view', async ({ page }) => {
  await open(page, 'c:lena')
  await page.setViewportSize({ width: 390, height: 500 })
  await page.waitForTimeout(300)
  expect((await metrics(page)).fromBottom).toBeLessThan(2)
  await expect(scroller(page).getByText('Lena unread 15:', { exact: false })).toBeInViewport()
})
