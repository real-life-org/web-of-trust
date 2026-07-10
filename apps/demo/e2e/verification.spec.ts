import { test, expect } from '@playwright/test'
import { createIdentity } from './helpers/identity'
import { createFreshContext, waitForRelayConnected, navigateTo } from './helpers/common'
import {
  getVerificationCode,
  submitVerificationCode,
  confirmVerificationInFlow,
  confirmIncomingVerification,
} from './helpers/verification'

test.describe('QR Verification', () => {
  test('Alice and Bob verify each other', async ({ browser }) => {
    // Create two isolated browser contexts
    const { context: aliceCtx, page: alicePage } = await createFreshContext(browser)
    const { context: bobCtx, page: bobPage } = await createFreshContext(browser)

    try {
      // Onboard both users (capture Bob's DID for the exact profile-URL assert below)
      await createIdentity(alicePage, { name: 'Alice', passphrase: 'alice123pw' })
      const { did: bobDid } = await createIdentity(bobPage, { name: 'Bob', passphrase: 'bob12345pw' })

      // Wait for relay connection on both
      await waitForRelayConnected(alicePage)
      await waitForRelayConnected(bobPage)

      // Alice shows her challenge code
      const challengeCode = await getVerificationCode(alicePage)
      expect(challengeCode.length).toBeGreaterThan(10)

      // Bob enters the code manually
      await submitVerificationCode(bobPage, challengeCode)

      // Bob sees "Stehst du vor dieser Person?" with Alice's name
      await bobPage.getByText('Stehst du vor dieser Person?').waitFor({ timeout: 10_000 })
      await expect(bobPage.getByText('Alice')).toBeVisible()

      // Bob confirms
      await confirmVerificationInFlow(bobPage)

      // Bob sees success
      await expect(bobPage.getByText('Verbindung erfolgreich!')).toBeVisible({ timeout: 10_000 })

      // Alice receives the incoming verification dialog
      await confirmIncomingVerification(alicePage)

      // Both should see the mutual friends dialog.
      // Alice takes the primary path "Profil ansehen": the success moment ends on
      // the fresh contact's profile (/p/<did>), not in a form (U1 fix).
      // Assert the EXACT peer DID (Bob's) — a loose /p/did… match would also pass
      // if the wrong profile (e.g. Alice's own) were opened.
      await alicePage.getByText('seid verbunden!').waitFor({ timeout: 20_000 })
      await alicePage.getByRole('button', { name: 'Profil ansehen' }).click()
      await expect(alicePage).toHaveURL(`/p/${encodeURIComponent(bobDid)}`)
      await expect(alicePage.getByText('seid verbunden!')).toBeHidden()

      // Bob takes the secondary path "Schließen": dialog closes, NO navigation.
      // (exact: true — the X button's accessible name "Dialog schließen" would
      // otherwise also match by substring.)
      await bobPage.getByText('seid verbunden!').waitFor({ timeout: 20_000 })
      const bobUrlBefore = bobPage.url()
      await bobPage.getByRole('button', { name: 'Schließen', exact: true }).click()
      await expect(bobPage.getByText('seid verbunden!')).toBeHidden()
      expect(bobPage.url()).toBe(bobUrlBefore)

      // Verify contacts appear in the contact list
      await navigateTo(alicePage, '/contacts')
      await navigateTo(bobPage, '/contacts')

      await expect(alicePage.getByText('Bob')).toBeVisible({ timeout: 10_000 })
      await expect(bobPage.getByText('Alice')).toBeVisible({ timeout: 10_000 })
    } finally {
      await aliceCtx.close()
      await bobCtx.close()
    }
  })
})
