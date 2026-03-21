import { test, expect } from '@playwright/test'
import { createIdentity } from './helpers/identity'
import { createFreshContext, waitForRelayConnected, navigateTo } from './helpers/common'
import { performMutualVerification } from './helpers/verification'

test.describe('Attestation Flow', () => {
  test('Alice attests Bob, Bob publishes, attestation visible on public profile', async ({ browser }) => {
    const { context: aliceCtx, page: alicePage } = await createFreshContext(browser)
    const { context: bobCtx, page: bobPage } = await createFreshContext(browser)

    try {
      // Setup: onboard both users
      await createIdentity(alicePage, { name: 'Alice', passphrase: 'alice123pw' })
      const { did: bobDid } = await createIdentity(bobPage, { name: 'Bob', passphrase: 'bob12345pw' })

      // Wait for relay
      await waitForRelayConnected(alicePage)
      await waitForRelayConnected(bobPage)

      // Mutual verification (prerequisite for attestations)
      await performMutualVerification(alicePage, bobPage)

      // Alice creates an attestation for Bob
      await navigateTo(alicePage, '/attestations/new')

      // Select Bob from dropdown
      await alicePage.locator('select').selectOption({ label: 'Bob' })

      // Type the claim
      await alicePage.locator('textarea').fill('Kann gut kochen')

      // Submit
      await alicePage.getByRole('button', { name: 'Bestätigung erstellen' }).click()

      // Wait for redirect to attestations list
      await alicePage.waitForURL('/attestations', { timeout: 10_000 })

      // Bob receives the incoming attestation dialog
      await bobPage.getByText('Neue Bestätigung von').waitFor({ timeout: 30_000 })
      await expect(bobPage.getByText('Kann gut kochen')).toBeVisible()

      // Bob publishes
      await bobPage.getByText('Veröffentlichen').click()

      // Verify it shows in Bob's attestation list
      await navigateTo(bobPage, '/attestations')
      await expect(bobPage.getByText('Kann gut kochen')).toBeVisible({ timeout: 10_000 })

      // Wait for profile sync to wot-profiles server
      await bobPage.waitForTimeout(3_000)

      // Check the public profile shows the attestation
      await navigateTo(alicePage, `/p/${bobDid}`)
      await expect(alicePage.getByText('Kann gut kochen')).toBeVisible({ timeout: 15_000 })
    } finally {
      await aliceCtx.close()
      await bobCtx.close()
    }
  })
})
