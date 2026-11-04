// The workbench (architecture §7.4): the real app in floating windows on the graph, the wire below.
// Three people, Jonas met Noah and Noah met Lea before the page opened: God's eye shows three
// people and two meetings; as Jonas, Lea does not exist; the wire lists the encounter's documents;
// a phone taken offline says so.
import { expect, test, type Page } from '@playwright/test'

async function bench(page: Page) {
  await page.setViewportSize({ width: 1400, height: 900 })
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
  await page.goto(`/?${new URLSearchParams({ scenario: 'workbench', theme: 'light' }).toString()}`)
  await expect(page.getByRole('heading', { name: /Workbench/ })).toBeVisible({ timeout: 60_000 })
  const jonas = page.frameLocator('iframe[name=jonas]')
  await expect(jonas.getByRole('heading', { name: 'Contacts' })).toBeVisible({ timeout: 30_000 })
  return { jonas }
}

test('God’s eye: three people, two meetings; the wire carries the encounter documents', async ({ page }) => {
  await bench(page)
  await expect(page.locator('[data-node]')).toHaveCount(3)
  await expect(page.locator('[data-edge^="e:"]')).toHaveCount(2)
  await expect(page.locator('[data-note]')).toContainText('No device holds this view')
  // the two meetings left documents on the wire, every one taken by its recipient
  await expect(page.locator('[data-wire]').first()).toBeVisible()
  const dispositions = await page.locator('[data-wire] td:nth-child(4)').allTextContents()
  expect(dispositions.length).toBeGreaterThanOrEqual(4)
  expect(dispositions.every((d) => d === 'taken')).toBe(true)
})

test('as Jonas: only Noah exists; the Noah–Lea meeting is not his to see', async ({ page }) => {
  await bench(page)
  await page.getByRole('group', { name: 'Camera' }).getByRole('button', { name: 'Jonas' }).click()
  await expect(page.locator('[data-node]')).toHaveCount(2)
  await expect(page.locator('[data-edge^="e:"]')).toHaveCount(1)
  await expect(page.locator('[data-note]')).toContainText('Jonas Weber')
  await expect(page).toHaveScreenshot('workbench-as-jonas.png', { mask: [page.locator('iframe')] })
})

test('a phone taken offline says so; the window can be docked and opened again from the node', async ({ page }) => {
  await bench(page)
  const noah = page.locator('[data-window=noah]')
  await noah.getByRole('button', { name: 'online', exact: true }).click()
  await expect(noah.getByRole('button', { name: 'offline', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await noah.getByRole('button', { name: 'collapse Noah Lindqvist' }).click()
  await expect(page.locator('[data-window=noah]')).toHaveCount(0)
  await page.locator('.wb-dock').getByRole('button', { name: 'Noah' }).click()
  await expect(page.locator('[data-window=noah]')).toHaveCount(1)
})

test('two berths: opening Lea from her node closes the phone longest untouched, and Lea takes its place', async ({ page }) => {
  await bench(page)
  const jonasAt = await page.locator('[data-window=jonas]').boundingBox()
  await page.locator('[data-window=noah]').click()
  await page.locator('[data-node=lea]').click()
  await expect(page.locator('[data-window=jonas]')).toHaveCount(0)
  await expect(page.locator('[data-window=lea]')).toHaveCount(1)
  const leaAt = await page.locator('[data-window=lea]').boundingBox()
  expect(leaAt?.x).toBe(jonasAt?.x)
  expect(leaAt?.y).toBe(jonasAt?.y)
  // four at once: the gear
  await page.getByRole('button', { name: 'settings' }).click()
  await page.getByRole('group', { name: 'Devices open at once' }).getByRole('button', { name: '4' }).click()
  await page.locator('[data-node=jonas]').click()
  await expect(page.locator('[data-window]')).toHaveCount(3)
})

test('the ceremony: Noah shows his code, Jonas scans it; while the camera is open the stage says so, then the question, the confirmation, the edge', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 })
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
  await page.goto(`/?${new URLSearchParams({ scenario: 'workbench', theme: 'light', met: 'none' }).toString()}`)
  const jonas = page.frameLocator('iframe[name=jonas]')
  const noah = page.frameLocator('iframe[name=noah]')
  await expect(jonas.getByRole('heading', { name: 'Contacts' })).toBeVisible({ timeout: 60_000 })
  await expect(noah.getByRole('heading', { name: 'Contacts' })).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('[data-edge^="e:"]')).toHaveCount(0)
  await noah.getByRole('button', { name: 'Verify in person' }).click()
  await expect(noah.getByRole('img', { name: 'Your verification code' })).toBeVisible()
  await jonas.getByRole('button', { name: 'Verify in person' }).click()
  await jonas.getByRole('button', { name: 'Scan code' }).click()
  // the camera is open: the stage names the scanner and the code it is pointed at
  await expect(page.locator('[data-ceremony="jonas>noah"]')).toHaveCount(1)
  await expect(jonas.getByRole('heading', { name: 'Is this the person in front of you?' })).toBeVisible({ timeout: 10_000 })
  await expect(page.locator('[data-ceremony]')).toHaveCount(0)
  await jonas.getByRole('button', { name: 'Confirm', exact: true }).click()
  await expect(jonas.getByRole('heading', { name: 'Noah Lindqvist verified' })).toBeVisible()
  await expect(page.locator('[data-edge^="e:"]')).toHaveCount(1)
  // over the mediator Noah's code screen asks for Jonas by itself (E9); Noah confirms there
  await expect(noah.getByRole('button', { name: 'Confirm', exact: true })).toBeVisible({ timeout: 15_000 })
  await noah.getByRole('button', { name: 'Confirm', exact: true }).click()
  await expect(noah.getByRole('heading', { name: /^You and Jonas are now connected\.$/ })).toBeVisible({ timeout: 15_000 })
  await expect(page.locator('.wb-edge.one')).toHaveCount(0)
})

test('a second meeting of Noah and Lea: one entry again on both phones, by itself as the clock runs', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 })
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
  await page.goto(`/?${new URLSearchParams({ scenario: 'workbench', theme: 'light', people: 'jonas,noah,lea', met: 'noah-lea' }).toString()}`)
  const noah = page.frameLocator('iframe[name=noah]')
  await expect(noah.getByRole('heading', { name: 'Contacts' })).toBeVisible({ timeout: 60_000 })
  await page.locator('[data-node=lea]').click()
  const lea = page.frameLocator('iframe[name=lea]')
  await expect(lea.getByRole('heading', { name: 'Contacts' })).toBeVisible({ timeout: 30_000 })
  await noah.getByRole('button', { name: 'Verify in person' }).click()
  await lea.getByRole('button', { name: 'Verify in person' }).click()
  await lea.getByRole('button', { name: 'Scan code' }).click()
  await lea.getByRole('button', { name: 'Confirm', exact: true }).click()
  await noah.getByRole('button', { name: 'Confirm', exact: true }).click({ timeout: 15_000 })
  const count = (at: string) => page.evaluate(async (id) => {
    const w = await (window as unknown as { __wotWorkbench: Promise<{ devices: Map<string, { port: { stores: { contacts: { get(): { status: string; value?: unknown[] } } } } }> }> }).__wotWorkbench
    const v = w.devices.get(id)!.port.stores.contacts.get()
    return v.status === 'ready' ? (v.value ?? []).length : -1
  }, at)
  await expect.poll(() => count('lea'), { timeout: 20_000 }).toBe(1)
  await expect.poll(() => count('noah'), { timeout: 20_000 }).toBe(1)
})
