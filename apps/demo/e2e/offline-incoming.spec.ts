import { test, expect } from '@playwright/test'
import { createIdentity } from './helpers/identity'
import { createFreshContext, waitForRelayConnected, navigateTo } from './helpers/common'
import { performMutualVerification } from './helpers/verification'
import { goOffline, goOnline, waitForReconnect } from './helpers/offline'

test.describe('Offline Incoming Messages', () => {
  test('Alice offline, Bob sends attestation, Alice reconnects → attestation appears', async ({ browser }) => {
    const { context: aliceCtx, page: alicePage } = await createFreshContext(browser)
    const { context: bobCtx, page: bobPage } = await createFreshContext(browser)

    try {
      // Setup: create identities and verify
      await createIdentity(alicePage, { name: 'Alice', passphrase: 'alice123pw' })
      await createIdentity(bobPage, { name: 'Bob', passphrase: 'bob12345pw' })

      await waitForRelayConnected(alicePage)
      await waitForRelayConnected(bobPage)

      await performMutualVerification(alicePage, bobPage)

      // --- Alice goes offline ---
      await goOffline(aliceCtx)
      await alicePage.waitForTimeout(2_000)

      // Bob creates an attestation for Alice while she's offline
      await navigateTo(bobPage, '/attestations/new')
      await bobPage.locator('select').selectOption({ label: 'Alice' })
      await bobPage.locator('textarea').fill('Hilfsbereit und zuverlässig')
      await bobPage.getByRole('button', { name: 'Bestätigung erstellen' }).click()
      await bobPage.waitForURL('/attestations', { timeout: 10_000 })

      // Wait a bit — the relay queues the message since Alice is offline
      await bobPage.waitForTimeout(2_000)

      // --- Alice comes back online ---
      await goOnline(aliceCtx)
      await navigateTo(alicePage, '/')
      await waitForReconnect(alicePage)

      // Alice should receive the queued attestation
      await alicePage.getByText('Neue Bestätigung von').waitFor({ timeout: 30_000 })
      await expect(alicePage.getByText('Hilfsbereit und zuverlässig')).toBeVisible()

      // Alice publishes
      await alicePage.getByText('Veröffentlichen').click()

      // Verify it's in Alice's attestation list
      await navigateTo(alicePage, '/attestations')
      await expect(alicePage.getByText('Hilfsbereit und zuverlässig')).toBeVisible({ timeout: 10_000 })
    } finally {
      await aliceCtx.close()
      await bobCtx.close()
    }
  })
})
