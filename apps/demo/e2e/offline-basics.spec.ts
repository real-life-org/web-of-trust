import { test, expect } from '@playwright/test'
import { createIdentity } from './helpers/identity'
import { createFreshContext, waitForRelayConnected, navigateTo } from './helpers/common'
import { performMutualVerification } from './helpers/verification'
import { goOffline, goOnline, waitForReconnect } from './helpers/offline'

test.describe('Offline Basics', () => {
  test('offline edit profile, create attestation offline → outbox → reconnect → delivered', async ({ browser }) => {
    const { context: aliceCtx, page: alicePage } = await createFreshContext(browser)
    const { context: bobCtx, page: bobPage } = await createFreshContext(browser)

    try {
      // Setup: create identities, verify each other
      await createIdentity(alicePage, { name: 'Alice', passphrase: 'alice123pw' })
      await createIdentity(bobPage, { name: 'Bob', passphrase: 'bob12345pw' })

      await waitForRelayConnected(alicePage)
      await waitForRelayConnected(bobPage)

      await performMutualVerification(alicePage, bobPage)

      // --- Alice goes offline ---
      await goOffline(aliceCtx)
      await alicePage.waitForTimeout(2_000) // let WebSocket disconnect

      // 1. Offline: Edit profile
      await navigateTo(alicePage, '/identity')
      await alicePage.getByText('Profil bearbeiten').click()
      await alicePage.getByPlaceholder('Ein kurzer Satz über dich').fill('Offline-Bio')
      await alicePage.getByText('Speichern').click()
      await alicePage.waitForTimeout(1_000)

      // Verify bio was saved locally
      await navigateTo(alicePage, '/identity')
      await expect(alicePage.getByText('Offline-Bio')).toBeVisible({ timeout: 5_000 })

      // 2. Offline: Create attestation for Bob → goes into outbox
      await navigateTo(alicePage, '/attestations/new')
      await alicePage.locator('select').selectOption({ label: 'Bob' })
      await alicePage.locator('textarea').fill('Offline-Attestation für Bob')
      await alicePage.getByRole('button', { name: 'Bestätigung erstellen' }).click()
      await alicePage.waitForURL('/attestations', { timeout: 10_000 })

      // Attestation should be visible locally
      await expect(alicePage.getByText('Offline-Attestation für Bob')).toBeVisible({ timeout: 5_000 })

      // 3. Go back online, reload, verify offline changes persisted
      await goOnline(aliceCtx)
      await alicePage.reload()

      // After reload, unlock screen should appear
      await alicePage.getByPlaceholder('Dein Passwort').fill('alice123pw')
      await alicePage.getByText('Entsperren', { exact: true }).click()

      // Navigate to home
      await navigateTo(alicePage, '/')
      await expect(alicePage.getByText('Hallo, Alice')).toBeVisible({ timeout: 10_000 })
      await waitForReconnect(alicePage)

      // Check bio persisted through offline edit + reload
      await navigateTo(alicePage, '/identity')
      await expect(alicePage.getByText('Offline-Bio')).toBeVisible({ timeout: 5_000 })

      // Check attestation persisted
      await navigateTo(alicePage, '/attestations')
      await expect(alicePage.getByText('Offline-Attestation für Bob')).toBeVisible({ timeout: 5_000 })

      // 4. Bob should receive the attestation (outbox drained on reconnect)
      // Dialog is global (z-50 overlay), should appear on any page
      await bobPage.getByText('Neue Bestätigung von').waitFor({ timeout: 60_000 })
      await expect(bobPage.getByText('Offline-Attestation für Bob')).toBeVisible()
    } finally {
      await aliceCtx.close()
      await bobCtx.close()
    }
  })
})
