import { test, expect } from '@playwright/test'
import { createIdentity } from './helpers/identity'
import { createFreshContext, waitForRelayConnected, navigateTo } from './helpers/common'
import { getVerificationCode, submitVerificationCode, confirmVerificationInFlow, confirmIncomingVerification, dismissMutualDialog } from './helpers/verification'
import { goOffline, goOnline, waitForReconnect } from './helpers/offline'

test.describe('Offline Verification', () => {
  test('cave scenario: both offline, QR scan, online → mutually connected', async ({ browser }) => {
    const { context: aliceCtx, page: alicePage } = await createFreshContext(browser)
    const { context: bobCtx, page: bobPage } = await createFreshContext(browser)

    try {
      // Setup: create identities online
      await createIdentity(alicePage, { name: 'Alice', passphrase: 'alice123pw' })
      await createIdentity(bobPage, { name: 'Bob', passphrase: 'bob12345pw' })

      // Wait for relay on both
      await waitForRelayConnected(alicePage)
      await waitForRelayConnected(bobPage)

      // --- Both go offline (simulating cave/blackout) ---
      await goOffline(aliceCtx)
      await goOffline(bobCtx)
      await alicePage.waitForTimeout(2_000)

      // Alice generates verification code (QR code content)
      // The code is generated locally — no network needed
      const code = await getVerificationCode(alicePage)
      expect(code).toBeTruthy()

      // Bob enters the code manually (simulates QR scan)
      await submitVerificationCode(bobPage, code)

      // Bob confirms "Stehst du vor dieser Person?"
      await confirmVerificationInFlow(bobPage)

      // Bob sees success locally
      await bobPage.getByText('Verbindung erfolgreich!').waitFor({ timeout: 10_000 })

      // Alice does NOT get the incoming verification dialog yet
      // (because both are offline — the relay message can't arrive)

      // --- Both come back online ---
      await goOnline(aliceCtx)
      await goOnline(bobCtx)

      // Wait for relay reconnection
      await navigateTo(alicePage, '/')
      await waitForReconnect(alicePage)
      await navigateTo(bobPage, '/')
      await waitForReconnect(bobPage)

      // Now Alice should receive the queued verification via relay
      await confirmIncomingVerification(alicePage)

      // Both dismiss the mutual dialog
      await dismissMutualDialog(alicePage)
      await dismissMutualDialog(bobPage)

      // --- Verify both are mutually connected ---
      await navigateTo(alicePage, '/contacts')
      await expect(alicePage.getByText('Bob')).toBeVisible({ timeout: 10_000 })
      await expect(alicePage.getByText('Gegenseitig verbunden').first()).toBeVisible({ timeout: 5_000 })

      await navigateTo(bobPage, '/contacts')
      await expect(bobPage.getByText('Alice')).toBeVisible({ timeout: 10_000 })
      await expect(bobPage.getByText('Gegenseitig verbunden').first()).toBeVisible({ timeout: 5_000 })
    } finally {
      await aliceCtx.close()
      await bobCtx.close()
    }
  })
})
