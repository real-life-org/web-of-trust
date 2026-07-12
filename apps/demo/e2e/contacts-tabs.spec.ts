import { test, expect } from '@playwright/test'
import { createIdentity } from './helpers/identity'
import { createFreshContext, navigateTo } from './helpers/common'

// Schlanker Render-Smoke für das neue „Liste | Graph"-Segmented-Control auf
// /contacts (Feature F). Kein Relay/Backend nötig — eine frische Identität reicht.
test.describe('Contacts tabs', () => {
  test('segmented Liste|Graph switches panels (click + keyboard)', async ({ browser }) => {
    const { context, page } = await createFreshContext(browser)
    try {
      await createIdentity(page, { name: 'Tabby', passphrase: 'tabby123pw' })
      await navigateTo(page, '/contacts')

      const listTab = page.getByRole('tab', { name: 'Liste' })
      const graphTab = page.getByRole('tab', { name: 'Graph' })
      await expect(listTab).toBeVisible()
      await expect(graphTab).toBeVisible()

      // Default: Liste ausgewählt, Listen-Panel sichtbar.
      await expect(listTab).toHaveAttribute('aria-selected', 'true')
      await expect(page.locator('#contacts-panel-list')).toBeVisible()
      await expect(page.locator('#contacts-panel-graph')).toHaveCount(0)

      // Wechsel auf Graph: Graph-Panel gemountet, Listen-Panel entfernt.
      await graphTab.click()
      await expect(graphTab).toHaveAttribute('aria-selected', 'true')
      await expect(listTab).toHaveAttribute('aria-selected', 'false')
      await expect(page.locator('#contacts-panel-graph')).toBeVisible()
      await expect(page.locator('#contacts-panel-list')).toHaveCount(0)

      // Tastatur: ArrowLeft schaltet zurück auf Liste (WAI-ARIA Tabs-Pattern).
      await graphTab.focus()
      await page.keyboard.press('ArrowLeft')
      await expect(listTab).toHaveAttribute('aria-selected', 'true')
      await expect(page.locator('#contacts-panel-list')).toBeVisible()
    } finally {
      await context.close()
    }
  })
})
