import { test, expect } from '@playwright/test'
import { createIdentity } from './helpers/identity'
import { createFreshContext, waitForRelayConnected, navigateTo } from './helpers/common'
import { performMutualVerification } from './helpers/verification'
import { goOffline, goOnline, waitForReconnect } from './helpers/offline'

test.describe('Offline Spaces', () => {
  test('create space offline → visible locally, invite while offline → appears on reconnect', async ({ browser }) => {
    const { context: aliceCtx, page: alicePage } = await createFreshContext(browser)
    const { context: bobCtx, page: bobPage } = await createFreshContext(browser)

    try {
      // Setup: create identities, verify each other
      await createIdentity(alicePage, { name: 'Alice', passphrase: 'alice123pw' })
      await createIdentity(bobPage, { name: 'Bob', passphrase: 'bob12345pw' })

      await waitForRelayConnected(alicePage)
      await waitForRelayConnected(bobPage)

      await performMutualVerification(alicePage, bobPage)

      // --- Part 1: Alice creates a space while offline ---
      await goOffline(aliceCtx)
      await alicePage.waitForTimeout(2_000)

      await navigateTo(alicePage, '/spaces')
      await alicePage.getByText('Erstellen', { exact: true }).click()
      await alicePage.getByPlaceholder('z.B. Gartengruppe, Familie...').fill('Offline-Space')
      await alicePage.locator('form button[type="submit"], form button:has-text("Erstellen")').last().click()

      // Space should be visible locally
      await expect(alicePage.getByText('Offline-Space').first()).toBeVisible({ timeout: 10_000 })

      // Go back online
      await goOnline(aliceCtx)
      await navigateTo(alicePage, '/')
      await waitForReconnect(alicePage)

      // Space should still be visible after reconnect
      await navigateTo(alicePage, '/spaces')
      await expect(alicePage.getByText('Offline-Space').first()).toBeVisible({ timeout: 10_000 })

      // --- Part 2: Bob goes offline, Alice invites Bob ---
      await goOffline(bobCtx)
      await bobPage.waitForTimeout(2_000)

      // Alice opens the space and invites Bob
      await alicePage.getByText('Offline-Space').first().click()
      await expect(alicePage.getByText('Mitglieder (1)')).toBeVisible({ timeout: 10_000 })
      await alicePage.getByText('Einladen').click()
      await alicePage.getByText('Bob').click()
      await alicePage.getByText('1 einladen').click()

      // Wait for invite to be sent (relay queues it since Bob is offline)
      await expect(alicePage.getByText('Mitglieder (2)')).toBeVisible({ timeout: 10_000 })

      // --- Bob comes back online → Space invite should appear ---
      await goOnline(bobCtx)
      await navigateTo(bobPage, '/')
      await waitForReconnect(bobPage)

      // Bob should receive the space invite
      await bobPage.getByText('Einladung zu Space').waitFor({ timeout: 30_000 })
      await bobPage.getByText('Space öffnen').click()

      // Bob should see the space
      await navigateTo(bobPage, '/spaces')
      await expect(bobPage.getByText('Offline-Space').first()).toBeVisible({ timeout: 10_000 })
    } finally {
      await aliceCtx.close()
      await bobCtx.close()
    }
  })
})
